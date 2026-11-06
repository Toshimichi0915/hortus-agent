/** The dispatcher's VM routing without an image: a task without a project is a VM task; `vm.fallback_host: false`
 * keeps it queued with the image error on the card (the fallback-to-host path needs Landlock and a provider). */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Config } from "../config.ts";
import type { Ctx } from "../ctx.ts";
import { openDb } from "../db.ts";
import { logger } from "../log.ts";
import { mirrorModule } from "../mirror/index.ts";
import * as paths from "../paths.ts";
import { fakeVm, hasScope, inScope } from "../test/fakes/vm.ts";
import { tempDir, until } from "../test/until.ts";
import { plannerModule, renderBatch } from "../planner/planner.ts";
import "../planner/tools.ts";
import { proxyModule } from "../proxy/index.ts";
import { call } from "../rpc.ts";
import { dispatcherModule, HOST_GRACE, readOutbox, runPlanner } from "./dispatcher.ts";
import { shim } from "./landlock.ts";
import * as tasks from "./tasks.ts";

process.env.HORTUS_HOME = tempDir("hortus-dispatch-");
process.env.HORTUS_NO_NET = "1";

test("a VM task with the image missing and vm.fallback_host false stays queued with the reason", async () => {
  const ctx: Ctx = {
    config: Config.parse({ vm: { fallback_host: false }, worker: { provider: "fake", model: "m" } }),
    db: openDb(paths.db()),
    paths,
    log: logger,
    reload: async () => {},
  };
  await dispatcherModule.start(ctx);
  try {
    const t = tasks.create({ kind: "unattended", title: "t", brief: "b", scope: { credentials: [] } });
    assert.equal(tasks.get(t.id).runtime, "vm");
    const row = await until(() => tasks.get(t.id).error, 3000, "error on the card");
    assert.match(row, /agent\.ext4 missing: run `hortus image build`/);
    assert.equal(tasks.get(t.id).status, "queued");
  } finally {
    await dispatcherModule.stop();
  }
});

test("readOutbox: new seqs only, never through a linked outbox (another task's results)", () => {
  const box = (id: string) => join(paths.out(id), "outbox");
  const msg = (seq: number) => JSON.stringify({ seq, type: "reply", text: `m${seq}`, ts: "t" });
  mkdirSync(box("a"), { recursive: true });
  for (const s of [1, 2, 3]) writeFileSync(join(box("a"), `00000${s}.json`), msg(s));
  writeFileSync(join(box("a"), "000004.json"), msg(5));
  assert.deepEqual(
    readOutbox("a", 1).map((m) => m.text),
    ["m2", "m3"],
    "a seq that is not its name is dropped",
  );
  mkdirSync(paths.out("b"), { recursive: true });
  symlinkSync(box("a"), box("b"));
  assert.deepEqual(readOutbox("b", 0), []);
});

test("inbox seq: a file left by a crash before its row is never reused", () => {
  const ctx: Ctx = {
    config: Config.parse({ worker: { provider: "fake", model: "m" } }),
    db: openDb(paths.db()),
    paths,
    log: logger,
    reload: async () => {},
  };
  tasks.bind(ctx);
  const t = tasks.create({ kind: "unattended", title: "t", brief: "b", scope: { credentials: [] } });
  writeFileSync(join(paths.ctl(t.id), "inbox", "000001.json"), "{}"); // renamed, then the daemon died
  assert.equal(tasks.inboxWrite(t.id, { from: "owner", trusted: true, text: "x" }), 2);
});

test("vm.max_concurrent counts the Planner's VM: a Worker VM waits for the batch's slot (the batch never waits)", {
  skip: !hasScope && "no systemd --user scope",
}, async () => {
  // startVm's cgroup.create needs a delegated cgroup: this test re-runs alone in a user scope
  if (process.env.INNER !== "1")
    return assert.match(inScope(fileURLToPath(import.meta.url), "vm.max_concurrent"), /# pass 1/);
  fakeVm(paths.home(), `hortus-slot-${process.pid}`, "exec sleep 2");
  writeFileSync(paths.vault(), JSON.stringify({ fake: { type: "token", value: "x" } }), { mode: 0o600 });
  const ctx: Ctx = {
    config: Config.parse({ vm: { max_concurrent: 1 }, worker: { provider: "fake", model: "m" } }),
    db: openDb(paths.db()),
    paths,
    log: logger,
    reload: async () => {},
  };
  await dispatcherModule.start(ctx);
  try {
    const t = new Date().toISOString();
    ctx.db
      .prepare(
        `INSERT INTO tasks(id, kind, title, brief, status, scope, budget, usage, runtime, event_keys, created, updated,
          started, hours) VALUES ('planner-1', 'planner', 'p', 'b', 'running', ?, ?, '{"tokens":0}', 'vm', '[]', ?, ?, ?, 0)`,
      )
      .run(JSON.stringify({ credentials: [], repos: [] }), JSON.stringify({ tokens: 1, hours: 0.5 }), t, t, t);
    const p = tasks.get("planner-1");
    const batch = runPlanner(p, tasks.taskJson(ctx.config, p), "vm");
    const w = tasks.create({ kind: "unattended", title: "w", brief: "b", scope: { credentials: [] } });
    assert.equal(w.runtime, "vm");
    await new Promise((r) => setTimeout(r, 1500)); // more than one tick with the batch's VM up
    assert.equal(tasks.get(w.id).status, "queued", "the Worker VM waits for the Planner's slot");
    await batch;
    await until(() => tasks.get(w.id).status !== "queued", 5000, "the Worker VM started after the batch");
  } finally {
    await dispatcherModule.stop();
  }
});

test("a stop while a VM is starting ends it: no child yet to kill, and none left running", {
  skip: !hasScope && "no systemd --user scope",
}, async () => {
  if (process.env.INNER !== "1")
    return assert.match(inScope(fileURLToPath(import.meta.url), "a stop while a VM"), /# pass 1/);
  const tag = `hortus-mid-${process.pid}`;
  fakeVm(paths.home(), tag);
  writeFileSync(paths.vault(), JSON.stringify({ fake: { type: "token", value: "x" } }), { mode: 0o600 });
  const ctx: Ctx = {
    config: Config.parse({ worker: { provider: "fake", model: "m" } }),
    db: openDb(paths.db()),
    paths,
    log: logger,
    reload: async () => {},
  };
  await dispatcherModule.start(ctx);
  const { id } = tasks.create({ kind: "unattended", title: "t", brief: "b", scope: { credentials: [] } });
  await new Promise(setImmediate);
  await new Promise(setImmediate); // the tick ran: `running`, inside startVm's first await
  assert.equal(tasks.get(id).status, "running");
  const stopped = await Promise.race([
    dispatcherModule.stop().then(() => true),
    new Promise<boolean>((r) => setTimeout(() => r(false), 5000).unref()),
  ]);
  assert.ok(stopped, "the stop returned");
  assert.notEqual(spawnSync("pgrep", ["-f", tag]).status, 0, "no QEMU or virtiofsd left");
});

test("a stop while a host session is starting ends it: a shim not yet in its cgroup too", {
  skip: !hasScope && "no systemd --user scope",
}, async () => {
  if (process.env.INNER !== "1")
    return assert.match(inScope(fileURLToPath(import.meta.url), "a stop while a host"), /# pass 1/);
  const tag = `hortus-mid-${process.pid}`;
  // never joins the cgroup, as the real shim has not in its first instant
  shim.path = join(paths.home(), "fake-shim");
  writeFileSync(shim.path, `#!/bin/bash\n[ "$1" = --abi ] && { echo 9; exit 0; }\nexec -a ${tag} sleep 600\n`, {
    mode: 0o755,
  });
  writeFileSync(paths.vault(), JSON.stringify({ fake: { type: "token", value: "x" } }), { mode: 0o600 });
  const ctx: Ctx = {
    config: Config.parse({ worker: { provider: "fake", model: "m" }, proxy: { https: 0, http: 0, dns: 0 } }),
    db: openDb(paths.db()),
    paths,
    log: logger,
    reload: async () => {},
  };
  await mirrorModule.start(ctx);
  await proxyModule.start(ctx);
  await dispatcherModule.start(ctx);
  const { id } = tasks.create({ kind: "chat", title: "t", brief: "b", scope: { credentials: [] } });
  await new Promise(setImmediate);
  await new Promise(setImmediate); // the tick ran: `running`, before the spawn
  assert.equal(tasks.get(id).status, "running");
  const stopped = await Promise.race([
    dispatcherModule.stop().then(() => true),
    new Promise<boolean>((r) => setTimeout(() => r(false), 5000).unref()),
  ]);
  await proxyModule.stop();
  assert.ok(stopped, "the stop returned");
  assert.notEqual(spawnSync("pgrep", ["-f", tag]).status, 0, "no session left");
});

test("a host session past its hours is killed: a tool that never returns reaches no check of the agent's own", {
  skip: !hasScope && "no systemd --user scope",
}, async () => {
  if (process.env.INNER !== "1")
    return assert.match(inScope(fileURLToPath(import.meta.url), "a host session past its hours"), /# pass 1/);
  shim.path = join(paths.home(), "fake-shim");
  writeFileSync(shim.path, `#!/bin/bash\n[ "$1" = --abi ] && { echo 9; exit 0; }\nexec sleep 600\n`, { mode: 0o755 });
  writeFileSync(paths.vault(), JSON.stringify({ fake: { type: "token", value: "x" } }), { mode: 0o600 });
  const ctx: Ctx = {
    config: Config.parse({ worker: { provider: "fake", model: "m" }, proxy: { https: 0, http: 0, dns: 0 } }),
    db: openDb(paths.db()),
    paths,
    log: logger,
    reload: async () => {},
  };
  HOST_GRACE.ms = 0;
  await mirrorModule.start(ctx);
  await proxyModule.start(ctx);
  await dispatcherModule.start(ctx);
  const { id } = tasks.create({
    kind: "chat",
    title: "t",
    brief: "b",
    scope: { credentials: [] },
    budget: { tokens: 1000, hours: 0.0002 },
  });
  await until(() => tasks.get(id).status === "waiting", 10_000);
  assert.match(tasks.get(id).error ?? "", /^budget_exceeded: the session was stopped/);
  // the owner's raise of its hours is what it waited for: it goes on, as after a token stop
  await call("task.budget", { id, hours: 1 }, { role: "owner" });
  const said = ctx.db.prepare("SELECT body FROM inbox WHERE task_id = ?").all(id) as { body: string }[];
  assert.ok(
    said.some((r) => r.body.includes("raised the budget")),
    "told to go on",
  );
  // live 2026-11-06: the Planner closed a stopped task as failed seconds before the owner's raise from the open card;
  // the raise said ok and wiped the reason, leaving "failed" with no error on the card
  await tasks.close(id, "failed");
  const why = "budget_exceeded: the session was stopped after 0.01 h (budget hours)";
  ctx.db.prepare("UPDATE tasks SET error = ? WHERE id = ?").run(why, id);
  await assert.rejects(call("task.budget", { id, hours: 2 }, { role: "owner" }), /is failed/);
  assert.equal(tasks.get(id).error, why);
  await dispatcherModule.stop();
  await proxyModule.stop();
});

test("VM failures: a boot timeout, the hours deadline, a Worker dead in the guest; a clean exit is none", {
  skip: !hasScope && "no systemd --user scope",
}, async () => {
  if (process.env.INNER !== "1")
    return assert.match(inScope(fileURLToPath(import.meta.url), "VM failures"), /# pass 1/);
  writeFileSync(paths.vault(), JSON.stringify({ fake: { type: "token", value: "x" } }), { mode: 0o600 });
  const ctx: Ctx = {
    config: Config.parse({ vm: { boot_timeout_s: 1 }, worker: { provider: "fake", model: "m" } }),
    db: openDb(paths.db()),
    paths,
    log: logger,
    reload: async () => {},
  };
  const told: string[] = [];
  tasks.hooks.failed = (t) => void told.push(t);
  const outbox = (id: string) =>
    (ctx.db.prepare("SELECT seq, body FROM outbox WHERE task_id = ? ORDER BY seq").all(id) as { body: string }[]).map(
      (r) => JSON.parse(r.body) as { seq: number; type: string; text: string },
    );
  const run = async (guest: string, budget = { tokens: 1000, hours: 1 }) => {
    fakeVm(paths.home(), `hortus-fail-${process.pid}`, guest);
    const { id } = tasks.create({ kind: "unattended", title: "t", brief: "b", scope: { credentials: [] }, budget });
    await until(() => tasks.get(id).status === "waiting", 10_000, "the session's end");
    return id;
  };
  const OUT = 'out=$(ls -dt "$HORTUS_HOME"/tasks/*/out | head -1); touch "$out/booted"';
  await mirrorModule.start(ctx);
  await dispatcherModule.start(ctx);
  try {
    let id = await run("exec sleep 600");
    assert.match(tasks.get(id).error ?? "", /^boot timeout: /);
    assert.deepEqual(told, [`task ${id} failed; what you last sent it may be unanswered`]);
    assert.deepEqual(
      outbox(id).map((m) => [m.seq, m.type]),
      [[-1, "result"]],
    );
    assert.match(outbox(id)[0]?.text ?? "", /^failed: boot timeout: /);

    // a session's end that cannot be recorded keeps its reason: the failure path's own error is added, not put in its place
    const failed = tasks.hooks.failed;
    let thrown = false;
    tasks.hooks.failed = (t) => {
      if (thrown) return failed(t);
      thrown = true;
      throw new Error("recording broke");
    };
    id = await run("exec sleep 600");
    assert.match(tasks.get(id).error ?? "", /^boot timeout: .*recording broke/s);
    tasks.hooks.failed = failed;

    told.length = 0;
    id = await run(`${OUT}; exec sleep 600`, { tokens: 1000, hours: 0.0005 });
    assert.match(tasks.get(id).error ?? "", /^budget_exceeded: the session was stopped/);
    assert.deepEqual(told, [`task ${id} is over budget`]);
    assert.deepEqual(
      outbox(id).map((m) => [m.seq, m.type]),
      [[-1, "budget_exceeded"]],
    );

    // a QEMU gone before startVm listens: ESRCH or a dead guest, not a task `running` for good
    told.length = 0;
    id = await run("exit 0");
    assert.deepEqual(told, [`task ${id} failed; what you last sent it may be unanswered`]);

    // QEMU exits 0 however the guest's Worker ended
    told.length = 0;
    id = await run(`${OUT}; sleep 0.3`);
    assert.match(tasks.get(id).error ?? "", /^guest died: /);
    assert.deepEqual(told, [`task ${id} failed; what you last sent it may be unanswered`]);

    // the owner starts it again: the Worker's seq 1 is read past the row hortusd wrote, and the exit is clean
    told.length = 0;
    fakeVm(
      paths.home(),
      `hortus-fail-${process.pid}`,
      `${OUT}; mkdir -p "$out/outbox"; echo '{"seq":1,"type":"result","text":"fine","ts":"t"}' > "$out/outbox/000001.json"; echo 0 > "$out/ended"; sleep 0.3`,
    );
    tasks.inboxWrite(id, { from: "owner", trusted: true, text: "again" });
    await until(() => outbox(id).length === 2, 10_000, "the Worker's result");
    assert.deepEqual(
      outbox(id).map((m) => [m.seq, m.text.slice(0, 11)]),
      [
        [-1, "failed: gue"],
        [1, "fine"],
      ],
    );
    assert.equal(tasks.get(id).error, null);
    assert.deepEqual(told, []);

    // a hostile Worker: a new `failed:` result and a clean out/ended each boot, its inbox never drained. One session
    // per message, not one per boot until `hours`; a message that lands during a session still gets its next one
    const FLAP = (pause: number) =>
      `${OUT}; mkdir -p "$out/outbox"; k=$(($(ls "$out/outbox" | wc -l) + 1)); echo '{"seq":'$k',"type":"result","text":"failed: again","ts":"t"}' > "$out/outbox/$(printf %06d $k).json"; echo 0 > "$out/ended"; sleep ${pause}`;
    const sessions = () => outbox(id).filter((m) => m.seq > 0).length;
    fakeVm(paths.home(), `hortus-fail-${process.pid}`, FLAP(0.1));
    await until(() => tasks.get(id).status === "waiting", 10_000, "the last session's end");
    let before = sessions();
    tasks.inboxWrite(id, { from: "owner", trusted: true, text: "again" });
    await until(() => sessions() > before, 10_000, "the session");
    await sleep(1500);
    assert.equal(sessions(), before + 1, "no boot loop");
    assert.equal(tasks.get(id).status, "waiting");
    before = sessions();
    fakeVm(paths.home(), `hortus-fail-${process.pid}`, FLAP(1));
    tasks.inboxWrite(id, { from: "owner", trusted: true, text: "again" });
    await until(() => tasks.get(id).status === "running", 10_000, "running");
    await sleep(300);
    tasks.inboxWrite(id, { from: "owner", trusted: true, text: "and this" });
    await until(() => sessions() === before + 2, 10_000, "a second session for the second message");
  } finally {
    await dispatcherModule.stop();
  }
});

test("a failed task: the owner's acts and its one-shot timer start it again, whatever only passes by waits", async () => {
  const ctx: Ctx = {
    config: Config.parse({ dofs: { slack: { type: "slack", owner: "U1" } }, worker: { provider: "fake", model: "m" } }),
    db: openDb(paths.db()),
    paths,
    log: logger,
    reload: async () => {},
  };
  tasks.bind(ctx); // no dispatcher: `queued` stays queued
  await plannerModule.start(ctx);
  const failed = () => {
    const { id } = tasks.create({ kind: "unattended", title: "t", brief: "b", runtime: "host" });
    tasks.setStatus(id, "waiting", { error: "boom\nthe last line" });
    return id;
  };
  let key = 0;
  const event = (author: string, trusted: number) =>
    `e${
      ctx.db
        .prepare("INSERT INTO events(dof, key, author, trusted, consumed) VALUES ('slack', ?, ?, ?, 1)")
        .run(`k${++key}`, author, trusted).lastInsertRowid
    }`;
  const planner = { role: "planner" as const, task: "planner-1" };
  const attach = (id: string, author: string, trusted: number) =>
    call("task_attach", { task_id: id, event_ids: [event(author, trusted)] }, planner);
  const msg = (id: string, from: string, data?: unknown) =>
    tasks.inboxWrite(id, { from, trusted: from !== "planner", text: "x", ...(data ? { data } : {}) });
  try {
    // the owner's DM on the thread comes through the Planner: `from` is the thread's ref, not "owner"
    let id = failed();
    await attach(id, "U2", 0);
    await attach(id, "U2", 1);
    assert.equal(tasks.get(id).status, "waiting", "someone else's message");
    await attach(id, "U1", 1);
    assert.equal(tasks.get(id).status, "queued", "the owner's message through the Planner");

    id = failed();
    msg(id, "approval", { decision: "rejected" });
    msg(id, "approval", { decision: "expired" });
    msg(id, "planner");
    msg(id, "rebase");
    msg(id, "cookies");
    assert.equal(tasks.get(id).status, "waiting");
    msg(id, "approval", { decision: "approved" });
    assert.equal(tasks.get(id).status, "queued", "the owner approved: the card told it to retry");

    id = failed();
    msg(id, "schedule:7");
    assert.equal(tasks.get(id).status, "queued", "a one-shot timer fires once, and nothing else would run it");

    // the Planner sees why a note will not start it
    id = failed();
    const open = renderBatch(ctx, [], []);
    assert.match(open, new RegExp(`- ${id} .*waiting.* — failed, only the owner starts it again: "the last line"`));
  } finally {
    await plannerModule.stop();
  }
});

test("a task that cannot start fails once: approvals and notes from others wait in its inbox, the owner restarts it", async () => {
  // review round 8: worker.provider names no vault credential; every approval decided re-ran the failed start
  writeFileSync(paths.vault(), "{}", { mode: 0o600 });
  const ctx: Ctx = {
    config: Config.parse({ worker: { provider: "ghost", model: "m" } }),
    db: openDb(paths.db()),
    paths,
    log: logger,
    reload: async () => {},
  };
  await dispatcherModule.start(ctx);
  try {
    const t = tasks.create({ kind: "chat", title: "c", brief: "b", scope: { credentials: [] } });
    const errors = () =>
      (ctx.db.prepare("SELECT body FROM replies WHERE task_id = ?").all(t.id) as { body: string }[]).filter((r) =>
        r.body.includes('"error"'),
      ).length;
    await until(() => tasks.get(t.id).status === "waiting" && errors() === 1, 3000, "the failed start");
    assert.match(tasks.get(t.id).error ?? "", /worker\.provider ghost is not a credential in vault\.json/);
    for (const from of ["approval", "planner", "merge", "rebase"])
      tasks.inboxWrite(t.id, { from, trusted: from !== "planner", text: "x" });
    await new Promise((r) => setTimeout(r, 1500)); // more than one tick
    assert.equal(tasks.get(t.id).status, "waiting");
    assert.equal(errors(), 1, "no restart");
    tasks.inboxWrite(t.id, { from: "owner", trusted: true, text: "try again" });
    await until(() => errors() === 2, 3000, "the owner's message starts it again");
    await until(() => tasks.get(t.id).status === "waiting", 3000, "waiting again");

    // unattended, the same start fails loud; closed while it fails, or a chat as above, it does not
    const told: string[] = [];
    tasks.hooks.failed = (x) => void told.push(x);
    const u = tasks.create({ kind: "unattended", title: "u", brief: "b", runtime: "host", scope: { credentials: [] } });
    await until(() => tasks.get(u.id).status === "waiting", 3000, "the failed start");
    assert.deepEqual(told, [`task ${u.id} failed; what you last sent it may be unanswered`]);
    const row = ctx.db.prepare("SELECT seq, body FROM outbox WHERE task_id = ?").all(u.id) as {
      seq: number;
      body: string;
    }[];
    assert.equal(row.length, 1);
    assert.equal(row[0]?.seq, -1);
    assert.match(row[0]?.body ?? "", /"type":"result","text":"failed: worker\.provider ghost/);
  } finally {
    tasks.hooks.failed = () => {};
    await dispatcherModule.stop();
  }
});
