/**
 * Schedules without a Worker (09-schedules.md › Functional tests): validation, DST, expiry, overlap, budget, run
 * accounting, unschedule rights, recovery and PAUSED, against the real tables with a fake clock and `tick()` called
 * directly. The Worker-driven cases (the v6 done-when, scripts, `/schedule` persistence) are in e2e/step3c.test.ts.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { Config } from "../config.ts";
import type { Ctx } from "../ctx.ts";
import { openDb, taint, taintOf } from "../db.ts";
import { mirrorModule } from "../mirror/index.ts";
import * as paths from "../paths.ts";
import { call } from "../rpc.ts";
import { recover } from "../runtime/recovery.ts";
import * as tasks from "../runtime/tasks.ts";
import { memLog, tempDir, until } from "../test/until.ts";
import type { Caller, OutboxMsg } from "../types.ts";
import { jar } from "../browser/jar.ts";
import { check, granted } from "../vault/gate.ts";
import { bind as bindVault } from "../vault/vault.ts";
import * as runs from "./runs.ts";
import { clock, schedulesModule, tick } from "./schedules.ts";

process.env.HORTUS_HOME = tempDir("hortus-sched-");
process.env.HORTUS_NO_NET = "1";

const project = tempDir("hortus-sched-proj-");
const log = memLog();
const ctx: Ctx = {
  config: Config.parse({
    owner: { tz: "UTC" },
    worker: { provider: "fake", model: "m" },
    projects: { foo: { path: project } },
  }),
  db: openDb(paths.db()),
  paths,
  log: () => log,
  reload: async () => {},
};

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
let T = Date.parse("2026-06-01T00:00:00Z");

before(async () => {
  tasks.bind(ctx);
  bindVault(ctx);
  await mirrorModule.start(ctx);
  await schedulesModule.start(ctx);
  clock.now = () => T;
});
after(async () => {
  assert.deepEqual(log.errors, []);
  await schedulesModule.stop();
  rmSync(process.env.HORTUS_HOME as string, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});
beforeEach(() => {
  T = Date.now();
  ctx.db.exec("DELETE FROM schedules");
});

const parent = (budget = { tokens: 1e6, hours: 10 }, kind: "unattended" | "chat" = "unattended", proj?: string) => {
  const t = tasks.create({ kind, title: "watch", brief: "b", scope: { credentials: [] }, budget, project: proj });
  tasks.setStatus(t.id, "waiting");
  return tasks.get(t.id);
};
const worker = (task: string): Caller => ({ role: "worker", task });
const set = (task: string, input: Record<string, unknown>) =>
  call("schedule.set", { text: "check", ...input }, worker(task)) as Promise<{ id: number; fire_at: string }>;
const row = (id: number) =>
  ctx.db.prepare("SELECT * FROM schedules WHERE id = ?").get(id) as runs.ScheduleRow | undefined;
const runsOf = (p: string) =>
  ctx.db.prepare("SELECT * FROM tasks WHERE parent = ? ORDER BY created").all(p) as unknown as tasks.TaskRow[];

test("validation: exactly one trigger, minimum interval, tz, script size, at in the future", async () => {
  const p = parent();
  await assert.rejects(set(p.id, { every: 60 }), /minimum interval is 5 minutes/);
  await assert.rejects(set(p.id, { cron: "* * * * *" }), /minimum interval is 5 minutes/);
  await assert.rejects(set(p.id, { cron: "0,1 9 * * *" }), /minimum interval is 5 minutes/);
  const ok = await set(p.id, { cron: "*/5 * * * *" });
  assert.equal(row(ok.id)?.task_id, p.id);
  assert.equal(row(ok.id)?.tz, "UTC");
  assert.equal(row(ok.id)?.expires_at, null);
  await set(p.id, { every: 300 });
  await assert.rejects(set(p.id, {}), /exactly one of at, every, cron/);
  await assert.rejects(set(p.id, { every: 300, cron: "0 9 * * *" }), /exactly one/);
  await assert.rejects(set(p.id, { cron: "0 9 * * * *" }), /cron: .*5 parts/);
  await assert.rejects(set(p.id, { every: 300, tz: "Mars/Olympus" }), /unknown timezone Mars\/Olympus/);
  await assert.rejects(set(p.id, { every: 300, script: "x".repeat(16 * 1024 + 1) }), /limit is 16 KB/);
  await assert.rejects(set(p.id, { at: new Date(T - MIN).toISOString() }), /not in the future/);
  await assert.rejects(
    set(p.id, { at: new Date(T + 8 * DAY).toISOString() }),
    /expire \(.*7 days after the last message\)/,
  );
  await assert.rejects(call("schedule.set", { text: "x", every: 300 }, { role: "planner", task: p.id }), /not allowed/);
  // a task last spoken to over 7 days ago: an `every` row would be deleted at the next tick, so it is refused now
  const old = parent();
  ctx.db.prepare("UPDATE tasks SET created = ? WHERE id = ?").run(new Date(T - 8 * DAY).toISOString(), old.id);
  await assert.rejects(set(old.id, { every: 300 }), /timers expired at .*use cron/);
  assert.ok(await set(old.id, { cron: "0 9 * * *" }));
});

test("DST in America/New_York: the skipped 2:30 is dropped, the repeated 1:30 fires once", async () => {
  const p = parent();
  T = Date.parse("2026-03-08T05:00:00Z"); // midnight EST, the spring-forward day
  const spring = await set(p.id, { cron: "30 2 * * *", tz: "America/New_York" });
  assert.equal(spring.fire_at, "2026-03-09T06:30:00.000Z"); // 2:30 EDT the next day
  T = Date.parse("2026-11-01T04:00:00Z"); // midnight EDT, the fall-back day
  const fall = await set(p.id, { cron: "30 1 * * *", tz: "America/New_York" });
  assert.equal(fall.fire_at, "2026-11-01T05:30:00.000Z"); // 1:30 EDT
  ctx.db.prepare("DELETE FROM schedules WHERE id = ?").run(spring.id);
  T = Date.parse("2026-11-01T05:31:00Z");
  tick();
  assert.equal(row(fall.id)?.fire_at, "2026-11-02T06:30:00.000Z"); // not 1:30 EST (06:30Z) on the same day
  assert.equal(runsOf(p.id).length, 1);
  T = Date.parse("2026-11-01T06:31:00Z");
  tick();
  assert.equal(runsOf(p.id).length, 1);
});

test("one-shot without script: advanced (deleted) before acting, inbox schedule:<id>, the task re-queued", async () => {
  const p = parent();
  const { id } = await set(p.id, { at: new Date(T + 2 * MIN).toISOString(), text: "look again" });
  tick();
  assert.ok(row(id), "not due yet");
  T += 2 * MIN;
  tick();
  assert.equal(row(id), undefined);
  const msg = ctx.db.prepare("SELECT body FROM inbox WHERE task_id = ? ORDER BY seq DESC").get(p.id) as {
    body: string;
  };
  const body = JSON.parse(msg.body);
  assert.equal(body.from, `schedule:${id}`);
  // v6 › Expiry: the message itself carries it, so the Worker can ask for more in time
  assert.match(body.text, /^look again\n\nThis task's timers expire at \d{4}-/);
  assert.ok(body.data.expires_at);
  assert.equal(tasks.get(p.id).status, "queued");
  tick();
  assert.equal((ctx.db.prepare("SELECT count(*) n FROM inbox WHERE task_id = ?").get(p.id) as { n: number }).n, 1);
});

test("expiry: 8 days after the last non-schedule message the row is deleted; an owner reply extends it; cron survives", async () => {
  const p = parent();
  tasks.inboxWrite(p.id, { from: "owner", trusted: true, text: "watch it" });
  T = Date.now();
  const every = await set(p.id, { every: 3600 });
  const cron = await set(p.id, { cron: "0 9 * * *" });
  const exp = Date.parse(row(every.id)?.expires_at as string);
  assert.ok(Math.abs(exp - (T + 7 * DAY)) < 5000, String(row(every.id)?.expires_at));
  // a schedule's own message does not extend; the owner's does
  await new Promise((r) => setTimeout(r, 5));
  tasks.inboxWrite(p.id, { from: `schedule:${every.id}`, trusted: true, text: "x" });
  assert.equal(Date.parse(row(every.id)?.expires_at as string), exp);
  tasks.inboxWrite(p.id, { from: "owner", trusted: true, text: "keep going" });
  assert.ok(Date.parse(row(every.id)?.expires_at as string) > exp);
  // a message to a run extends its parent's rows
  const before = row(every.id)?.expires_at as string;
  const r = runs.start(row(every.id) as runs.ScheduleRow, new Date(T));
  await new Promise((r) => setTimeout(r, 5));
  tasks.inboxWrite(r.id, { from: "slack:C1:1", author: "U1", trusted: false, text: "reply to the run" });
  assert.ok((row(every.id)?.expires_at as string) > before);
  T += 8 * DAY;
  tick();
  assert.equal(row(every.id), undefined);
  assert.ok(row(cron.id), "cron rows never expire");
});

test("overlap: a firing while a run of the row is active is skipped (logged); the next one starts after it ended", async () => {
  const p = parent();
  const { id } = await set(p.id, { every: 300 });
  T += 5 * MIN;
  tick();
  const [first] = runsOf(p.id);
  assert.ok(first);
  assert.equal(first.kind, "run");
  assert.deepEqual(JSON.parse(first.event_keys ?? "[]"), [`schedule:${id}`]);
  assert.equal(row(id)?.last_run, new Date(T).toISOString());
  tasks.setStatus(first.id, "running");
  T += 5 * MIN;
  tick();
  assert.equal(runsOf(p.id).length, 1);
  assert.ok(log.infos.includes("skipped: a run of this schedule is still active"));
  assert.equal(row(id)?.last_run, new Date(T).toISOString());
  tasks.setStatus(first.id, "waiting");
  T += 5 * MIN;
  tick();
  assert.equal(runsOf(p.id).length, 2);
});

test("a run: title, brief, budget = what the parent has left, its script and /schedule in task.json", async () => {
  const p = parent({ tokens: 1000, hours: 2 });
  ctx.db.prepare(`UPDATE tasks SET usage = '{"tokens":400}', hours = 0.5 WHERE id = ?`).run(p.id);
  T = Date.parse("2026-06-01T09:00:00Z");
  const { id } = await set(p.id, { every: 3600, text: "is it there?", script: "echo hi", tz: "Asia/Tokyo" });
  T += 60 * MIN;
  tick();
  const [r] = runsOf(p.id);
  assert.ok(r);
  assert.equal(r.title, "watch @ 2026-06-01 19:00");
  // non-owner text (v6 › Runs), and it says when the timer ends
  assert.match(r.brief, /<<<quoted\nis it there\?\n>>>/);
  assert.match(r.brief, /timers expire at \d{4}-/);
  assert.deepEqual(JSON.parse(r.budget ?? ""), { tokens: 600, hours: 1.5 });
  const tj = tasks.taskJson(ctx.config, r);
  assert.equal(tj.paths.schedule, paths.schedule(id));
  assert.ok(existsSync(paths.schedule(id)));
  assert.equal(tj.script, "echo hi");
  assert.ok(tj.features.includes("schedule"));
});

test("project origins: a chat holds every project's list, its run too; a list extended in the config reaches an open task", async () => {
  const prev = ctx.config;
  const row = (id: string) => JSON.parse(tasks.get(id).origins ?? "null");
  const chat = parent(undefined, "chat");
  const plain = parent();
  assert.equal(row(chat.id), null);
  ctx.config = Config.parse({
    ...prev,
    projects: { ...prev.projects, strict: { path: project, origins: ["a.test"] } },
  });
  try {
    const strict = parent(undefined, "unattended", "strict");
    assert.deepEqual(row(strict.id), ["a.test"]);
    assert.deepEqual(row(parent(undefined, "chat").id), ["a.test"]);
    assert.equal(row(parent(undefined, "unattended", "foo").id), null);
    const run = tasks.create({ kind: "run", parent: parent(undefined, "chat").id, title: "r", brief: "b" });
    assert.deepEqual(row(run.id), ["a.test"]);
    // the owner extends the list on the Projects page: tasks that were refused reach it at their next request
    ctx.config = Config.parse({
      ...prev,
      projects: { ...prev.projects, strict: { path: project, origins: ["a.test", "b.test"] } },
    });
    tasks.refreshOrigins(ctx);
    assert.deepEqual(row(strict.id), ["a.test", "b.test"]);
    assert.deepEqual(row(chat.id), ["a.test", "b.test"]);
    assert.equal(row(plain.id), null);
  } finally {
    ctx.config = prev;
  }
});

test("the parent's grants cover a run, and a run's cover the next; a durable grant is no scope grant", async () => {
  const p = parent();
  const stranger = parent();
  await set(p.id, { every: 300 });
  T += 6 * MIN;
  tick();
  const [r] = runsOf(p.id);
  assert.ok(r);
  const grant = (task: string | null, category: string) =>
    ctx.db
      .prepare(
        "INSERT INTO approvals(kind, category, hash, task_id, summary, status, requested_at) VALUES ('grant', ?, ?, ?, '{}', 'approved', 't')",
      )
      .run(category, `grant:${category}`, task);
  const cookie = (task: string, name: string, via?: string) =>
    ctx.db
      .prepare("INSERT INTO captured(name, value, origin, kind, created, meta) VALUES (?, 'v', ?, 'cookie', 't', ?)")
      .run(`c-${task}-${name}`, `${name}.test`, JSON.stringify({ cookieName: name, task, via }));
  grant(p.id, "origin:site.test");
  assert.ok(granted("origin:site.test", r.id));
  assert.ok(!granted("origin:site.test", stranger.id));
  // the jar: the parent's own captures and a login of a granted origin
  cookie(p.id, "own");
  cookie(stranger.id, "site", "login");
  cookie(stranger.id, "other");
  assert.deepEqual(
    jar(ctx.db, r.id)
      .map((c) => c.name)
      .sort(),
    ["own", "site"],
  );
  const pass = (task: string, category: string) =>
    check({
      caller: worker(task),
      category,
      hash: `grant:${category}`,
      kind: "grant",
      consequential: false,
      summary: {},
    });
  assert.equal(pass(r.id, "origin:site.test"), "pass");
  // credential:x enabled durably (the `auto` gate's click) does not put it in a task's scope
  grant(null, "credential:x");
  assert.notEqual(pass(r.id, "credential:x"), "pass");
});

test("a run inherits its parent's taint, and an earlier run's; the parent none of theirs", async () => {
  const p = parent();
  await set(p.id, { every: 300 });
  T += 6 * MIN;
  tick();
  const [r] = runsOf(p.id);
  assert.ok(r);
  assert.deepEqual(taintOf(ctx.db, r.id, ctx.config), []);
  taint(ctx.db, p.id, "read a page");
  assert.deepEqual(taintOf(ctx.db, r.id, ctx.config), ["read a page"]);
  const next = tasks.create({ kind: "run", parent: p.id, title: "r2", brief: "b" });
  taint(ctx.db, r.id, "read a stranger");
  assert.deepEqual(taintOf(ctx.db, next.id, ctx.config), ["read a page", "read a stranger"]);
  assert.deepEqual(taintOf(ctx.db, p.id, ctx.config), ["read a page"]);
  // a stranger's reply routed to a run: the next one reads what that run left, so it is not clean either
  ctx.db
    .prepare(
      "INSERT INTO events(dof, key, ts, author, trusted, bot, created, task_id) VALUES ('s', 'k', 't', 'U9', 0, 0, 't', ?)",
    )
    .run(r.id);
  assert.ok(taintOf(ctx.db, next.id, ctx.config).includes("read untrusted messages (s:U9)"));
  assert.deepEqual(taintOf(ctx.db, p.id, ctx.config), ["read a page"]);
});

test("scope: a chat parent's run on a project is an unattended host task (never in place); without one, a VM task", async () => {
  const chat = parent(undefined, "chat", "foo");
  const { id } = await set(chat.id, { every: 600 });
  runs.start(row(id) as runs.ScheduleRow, new Date(T));
  const [r] = runsOf(chat.id);
  assert.ok(r);
  assert.equal(r.runtime, "host");
  assert.equal(r.project, "foo");
  const tj = tasks.taskJson(ctx.config, r);
  assert.equal(tj.kind, "run");
  assert.equal(tj.cwd, undefined);
  assert.equal(tj.projects, undefined);
  assert.equal(tj.paths.work, join(paths.out(r.id), "work"));
  const plain = parent(undefined, "chat");
  const s2 = await set(plain.id, { every: 600 });
  assert.equal(runs.start(row(s2.id) as runs.ScheduleRow, new Date(T)).runtime, "vm");
});

test("run exit: usage charged to the parent, summary kept as last-summary.md; over budget → no more firings", async () => {
  const told: string[] = [];
  tasks.hooks.failed = (t) => void told.push(t);
  const p = parent({ tokens: 100, hours: 10 });
  const { id } = await set(p.id, { every: 300 });
  T += 5 * MIN;
  tick();
  const [r] = runsOf(p.id);
  assert.ok(r);
  ctx.db
    .prepare(`UPDATE tasks SET usage = '{"tokens":150}', summary = 'found one', status = 'waiting' WHERE id = ?`)
    .run(r.id);
  const msg: OutboxMsg = { seq: 1, type: "result", text: "found one", ts: "" };
  runs.onExit(tasks.get(r.id), [msg]);
  runs.onExit(tasks.get(r.id), []); // a second exit of the same run is not charged twice
  assert.deepEqual(JSON.parse(tasks.get(p.id).usage ?? ""), { tokens: 150, runs: 150 });
  // the parent's own next session gets what its runs left, not its whole budget again
  assert.equal(tasks.taskJson(ctx.config, tasks.get(p.id)).budget.tokens, 0, "100 less 150");
  assert.match(tasks.get(p.id).error ?? "", /^budget_exceeded: .*150\/100 tokens/);
  assert.deepEqual(told, [`task ${p.id} is over budget`], "once");
  const rows = () =>
    ctx.db.prepare("SELECT seq, body FROM outbox WHERE task_id = ? ORDER BY seq DESC").all(p.id) as {
      seq: number;
      body: string;
    }[];
  assert.equal(rows().length, 1, "the Planner gets budget_exceeded for the parent");
  assert.match(rows()[0]?.body ?? "", /"type":"budget_exceeded","text":"budget_exceeded: runs of its schedules/);
  assert.equal(readFileSync(join(paths.schedule(id), "last-summary.md"), "utf8"), "found one");
  T += 5 * MIN;
  tick();
  assert.equal(runsOf(p.id).length, 1);
  assert.ok(row(id)?.fire_at && Date.parse(row(id)?.fire_at as string) <= T, "stays due");
  tasks.budget(p.id, { tokens: 1000 });
  assert.equal(tasks.get(p.id).error, null, "the raise answers it");
  tick();
  assert.equal(runsOf(p.id).length, 2);

  // the next overrun is a new failure; a run that hit the limit itself has told the owner, the parent's row still comes
  const r2 = runsOf(p.id).find((x) => x.id !== r.id);
  assert.ok(r2);
  ctx.db.prepare(`UPDATE tasks SET usage = '{"tokens":2000}', status = 'waiting' WHERE id = ?`).run(r2.id);
  runs.onExit(tasks.get(r2.id), [{ seq: 1, type: "budget_exceeded", text: "budget exceeded", ts: "" }]);
  assert.equal(rows().length, 2);
  assert.equal(told.length, 1);
  tasks.hooks.failed = () => {};
});

test("an empty result: the run is closed at once and leaves no logs entry; one that never called the model is deleted", async () => {
  const p = parent();
  const { id } = await set(p.id, { every: 300 });
  const quiet = runs.start(row(id) as runs.ScheduleRow, new Date(T));
  tasks.setStatus(quiet.id, "waiting");
  runs.onExit(tasks.get(quiet.id), [{ seq: 1, type: "result", text: "", ts: "" }]);
  await until(() => !ctx.db.prepare("SELECT 1 FROM tasks WHERE id = ?").get(quiet.id), 3000, "the run deleted");
  assert.ok(!existsSync(paths.task(quiet.id)));
  assert.ok(!existsSync(join(paths.logs(), quiet.id)));
  const hits = ctx.db.prepare("SELECT count(*) n FROM search_meta WHERE path LIKE ?").get(`${quiet.id}/%`) as {
    n: number;
  };
  assert.equal(hits.n, 0);
  assert.ok(existsSync(paths.schedule(id)), "the row and its directory stay");

  const spent = runs.start(row(id) as runs.ScheduleRow, new Date(T));
  ctx.db.prepare(`UPDATE tasks SET usage = '{"tokens":30}', status = 'waiting' WHERE id = ?`).run(spent.id);
  runs.onExit(tasks.get(spent.id), [{ seq: 1, type: "result", text: "", ts: "" }]);
  await until(() => tasks.get(spent.id).status === "done", 3000, "the run closed");
  assert.ok(!existsSync(join(paths.logs(), spent.id)));
  assert.equal(JSON.parse(tasks.get(p.id).usage ?? "").runs, 30);
});

test("unschedule: a run acts on its parent's rows; another task's row is forbidden; the owner may remove any", async () => {
  const p = parent();
  const other = parent();
  const { id } = await set(p.id, { every: 300 });
  const r = runs.start(row(id) as runs.ScheduleRow, new Date(T));
  const fromRun = await set(r.id, { every: 600 });
  assert.equal(row(fromRun.id)?.task_id, p.id, "a run's rows belong to its parent");
  const theirs = await set(other.id, { every: 300 });
  await assert.rejects(call("schedule.unset", { id: theirs.id }, worker(r.id)), /belongs to another task/);
  await call("schedule.unset", { id }, worker(r.id));
  assert.equal(row(id), undefined);
  assert.ok(!existsSync(paths.schedule(id)));
  await call("schedule.unset", { id: theirs.id }, { role: "owner" });
  assert.equal(row(theirs.id), undefined);
  const list = (await call("schedule.list", {}, { role: "owner" })) as { id: number; title: string }[];
  assert.deepEqual(
    list.map((l) => [l.id, l.title]),
    [[fromRun.id, "watch"]],
  );
});

test("recovery: a run killed before its first model call is closed failed (not re-fired); one killed after resumes", async () => {
  const p = parent();
  const { id } = await set(p.id, { every: 300 });
  const early = runs.start(row(id) as runs.ScheduleRow, new Date(T));
  const late = runs.start(row(id) as runs.ScheduleRow, new Date(T));
  for (const r of [early, late]) tasks.setStatus(r.id, "running");
  const sessions = join(paths.out(late.id), "sessions");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(
    join(sessions, "s.jsonl"),
    `${JSON.stringify({ type: "message", message: { role: "assistant", text: "", toolCalls: [], usage: { input: 10, output: 5 } } })}\n`,
  );
  const fire = row(id)?.fire_at;
  // a crashed session's and VM's links go (their address and tap are gone); a login view's is the browser's own
  const link = ctx.db.prepare("INSERT INTO links(address, role, task_id, kind) VALUES (?, 'worker', ?, ?)");
  link.run("10.77.1.9", late.id, "session");
  link.run("10.77.2.9", late.id, "vm");
  link.run("10.77.3.9", null, "login");
  await recover(ctx);
  assert.equal(tasks.get(early.id).status, "failed");
  assert.equal(tasks.get(late.id).status, "queued");
  assert.equal(row(id)?.fire_at, fire);
  assert.deepEqual(
    ctx.db
      .prepare("SELECT kind FROM links")
      .all()
      .map((r) => r.kind),
    ["login"],
  );
  ctx.db.exec("DELETE FROM links");
});

test("PAUSED skips ticks; un-pausing fires each overdue row once and every advances past now", async () => {
  const p = parent();
  const { id } = await set(p.id, { every: 300 });
  const once = await set(p.id, { at: new Date(T + MIN).toISOString() });
  writeFileSync(paths.paused(), "");
  T += 31 * MIN;
  tick();
  assert.equal(runsOf(p.id).length, 0);
  assert.ok(row(once.id));
  rmSync(paths.paused());
  tick();
  assert.equal(runsOf(p.id).length, 1);
  assert.equal(row(once.id), undefined);
  assert.ok(Date.parse(row(id)?.fire_at as string) > T);
  assert.ok(Date.parse(row(id)?.fire_at as string) <= T + 5 * MIN);
  tick();
  assert.equal(runsOf(p.id).length, 1);
});

test("missed while hortusd was down (3 days, across the fall-back): one run at the first tick, then 9:00 local again", async () => {
  const p = parent();
  T = Date.parse("2026-10-30T12:00:00Z");
  const { id, fire_at } = await set(p.id, { cron: "0 9 * * *", tz: "America/New_York" });
  assert.equal(fire_at, "2026-10-30T13:00:00.000Z"); // 9:00 EDT
  T = Date.parse("2026-11-02T20:00:00Z"); // down from before the 30th's firing until the 2nd, 15:00 EST
  tick();
  assert.equal(runsOf(p.id).length, 1, "the four missed firings run once, not four times");
  assert.equal(row(id)?.fire_at, "2026-11-03T14:00:00.000Z"); // 9:00 EST
  tick();
  assert.equal(runsOf(p.id).length, 1);
});

test("a run left after its parent closed cannot set a timer: nothing would ever delete it", async () => {
  const p = parent();
  const { id } = await set(p.id, { every: 300 });
  T += 6 * MIN;
  tick();
  const run = ctx.db.prepare("SELECT id FROM tasks WHERE parent = ?").get(p.id) as { id: string };
  await tasks.close(p.id, "done");
  // a run still queued or at work when its task ends (a merged PR) ends with it: it would act, and ask, for a closed task
  assert.equal(tasks.get(run.id).status, "done");
  assert.equal(ctx.db.prepare("SELECT 1 FROM schedules WHERE id = ?").get(id), undefined);
  await assert.rejects(set(run.id, { every: 300 }), /is closed/);
  assert.equal((ctx.db.prepare("SELECT count(*) AS n FROM schedules").get() as { n: number }).n, 0);
});
