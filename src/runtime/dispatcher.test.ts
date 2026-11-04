/** The dispatcher's VM routing without an image: a task without a project is a VM task; `vm.fallback_host: false`
 * keeps it queued with the image error on the card (the fallback-to-host path needs Landlock and a provider). */
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Config } from "../config.ts";
import type { Ctx } from "../ctx.ts";
import { openDb } from "../db.ts";
import { logger } from "../log.ts";
import * as paths from "../paths.ts";
import { fakeVm, hasScope, inScope } from "../test/fakes/vm.ts";
import { tempDir, until } from "../test/until.ts";
import { plannerModule, renderBatch } from "../planner/planner.ts";
import "../planner/tools.ts";
import { call } from "../rpc.ts";
import { dispatcherModule, readOutbox, runPlanner } from "./dispatcher.ts";
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
  } finally {
    await dispatcherModule.stop();
  }
});
