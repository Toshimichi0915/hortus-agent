/**
 * Crash recovery: the real daemon (HORTUS_NO_NET=1) SIGKILLs itself at a named point (`HORTUS_TEST_CRASH_AT`,
 * src/crash.ts), then restarts without it; the state must come back without duplicates or stuck rows.
 */
import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, before, test } from "node:test";
import { openDb } from "../db.ts";
import * as paths from "../paths.ts";
import { rpcClient } from "../rpc.ts";
import { FakeSlack } from "../test/fakes/slack.ts";
import { stopped, tempDir, until } from "../test/until.ts";

const bin = (name: string) => new URL(`../bin/${name}.js`, import.meta.url).pathname;
const g = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=o", "-c", "user.email=o@x", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  }).trim();

let home: string;
let checkout: string;
let fake: FakeSlack;
let daemon: ChildProcess | undefined;

function start(crashAt?: string): ChildProcess {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HORTUS_HOME: home,
    HORTUS_CONSOLE_PORT: "0",
    HORTUS_NO_NET: "1",
    HORTUS_SCHEDULE_TICK_MS: "200",
  };
  if (crashAt) env.HORTUS_TEST_CRASH_AT = crashAt;
  else delete env.HORTUS_TEST_CRASH_AT;
  const d = spawn(process.execPath, ["--no-warnings", bin("hortusd")], { env, stdio: ["ignore", "ignore", "pipe"] });
  daemon = d;
  started = new Promise((resolve) => {
    let buf = "";
    d.stderr?.on("data", (b: Buffer) => {
      if (process.env.KEEP) process.stderr.write(b);
      buf += b;
      if (/"msg":"started"/.test(buf)) resolve();
    });
  });
  return d;
}
let started: Promise<void> = Promise.resolve();
const exited = (d: ChildProcess): Promise<NodeJS.Signals | null> =>
  d.exitCode !== null || d.signalCode !== null
    ? Promise.resolve(d.signalCode)
    : new Promise((r) => d.once("exit", (_c, s) => r(s)));
async function stop(): Promise<void> {
  if (!daemon || daemon.exitCode !== null || daemon.signalCode !== null) return;
  await stopped(daemon);
}
async function call<T>(method: string, params: unknown = {}): Promise<T> {
  const rpc = rpcClient(paths.socket());
  try {
    return (await rpc.call(method, params)) as T;
  } finally {
    rpc.close();
  }
}
/** every module started */
const up = () =>
  Promise.race([
    started,
    new Promise((_, reject) => setTimeout(() => reject(new Error("the daemon did not start")), 20_000)),
  ]);
const sql = <T>(q: string, ...a: (string | number | null)[]): T[] => {
  const db = openDb(paths.db());
  try {
    return db.prepare(q).all(...a) as T[];
  } finally {
    db.close();
  }
};
const run = (q: string, ...a: (string | number | null)[]): void => {
  const db = openDb(paths.db());
  try {
    db.prepare(q).run(...a);
  } finally {
    db.close();
  }
};
const commits = (dof: string) => Number(g(paths.dof(dof), "rev-list", "--count", "HEAD"));

before(async () => {
  home = tempDir("hortus-crash-");
  process.env.HORTUS_HOME = home;
  fake = await FakeSlack.start();
  fake.user("U1", "alice");
  fake.channel("C1", { name: "zebrachan", members: ["U1", fake.botUser] });
  checkout = join(home, "..", `${home.split("/").at(-1)}-g`);
  mkdirSync(checkout);
  g(checkout, "init", "-q", "-b", "main");
  writeFileSync(join(checkout, "README.md"), "hello\n");
  g(checkout, "add", "-A");
  g(checkout, "commit", "-q", "-m", "init");
  writeFileSync(
    join(home, "hortusd.json"),
    JSON.stringify({
      owner: { tz: "UTC" },
      worker: { provider: "fake", model: "m" },
      dofs: { slack: { type: "slack", owner: "U1" } },
      projects: { g: { path: checkout } },
      dev: { upstreams: { "slack.com": fake.url } },
      proxy: { https: 0, http: 0, dns: 0 },
    }),
  );
  writeFileSync(
    join(home, "vault.json"),
    JSON.stringify({ ...fake.vault("slack"), fake: { type: "token", value: "x", transform: "fake" } }),
    { mode: 0o600 },
  );
});

afterEach(stop);

after(async () => {
  await stop();
  await fake.close();
  rmSync(checkout, { recursive: true, force: true });
});

test("mirror: SIGKILL between a commit and its indexing → restart indexes it, no second commit, one FTS row", async () => {
  // the first mirror commit of all: the transforms DOF's ship, before its bindings are written
  assert.equal(await exited(start("mirror.after-commit:transforms")), "SIGKILL");
  assert.equal(commits("transforms"), 2); // init + ship
  assert.equal(sql("SELECT 1 FROM transforms").length, 0);
  // the first reconcile's channel.md: committed, not indexed, the cursor not saved
  assert.equal(await exited(start("mirror.after-commit:slack")), "SIGKILL");
  assert.equal(commits("transforms"), 2, "the re-ship of identical files is not a commit");
  assert.ok(sql("SELECT 1 FROM transforms").length > 0, "the bindings were written on the second start");
  assert.equal(commits("slack"), 2);
  assert.equal(sql("SELECT 1 FROM search_meta WHERE dof = 'slack'").length, 0);

  start();
  await up();
  const hits = await until(
    async () => (await call<{ path: string }[]>("dof.search", { q: "zebrachan", in: "slack" })).length > 0,
    10_000,
    "channel.md in the index",
  );
  assert.ok(hits);
  // the reconcile after restart re-fetched the same content: no new commit, still one row
  await until(() => sql("SELECT 1 FROM syncs WHERE dof = 'slack'").length > 0, 10_000, "the slack cursor");
  // other scopes (the DM) may commit now; channel.md itself was committed once
  assert.equal(g(paths.dof("slack"), "log", "--format=%H", "--", "C1/channel.md").split("\n").length, 1);
  assert.equal(sql("SELECT 1 FROM search_meta WHERE dof = 'slack' AND path = 'C1/channel.md'").length, 1);
  assert.equal(sql("SELECT 1 FROM search WHERE dof = 'slack' AND path = 'C1/channel.md'").length, 1);
  await stop();
});

/** A pending merge entry for `hortus/<task>`: the branch fetched straight into the origin (no Worker needed). */
async function mergeEntry(task: string, file: string): Promise<{ id: number; sha: string; main: string }> {
  await call("project.sync", { name: "g" });
  const origin = paths.project("g");
  const work = join(home, `w-${task}`);
  g(home, "clone", "-q", origin, work);
  writeFileSync(join(work, file), `${task}\n`);
  g(work, "add", "-A");
  g(work, "commit", "-q", "-m", task);
  g(home, "--git-dir", origin, "fetch", "-q", work, `HEAD:refs/heads/hortus/${task}`);
  const sha = g(work, "rev-parse", "HEAD");
  const main = g(home, "--git-dir", origin, "rev-parse", "main");
  const t = new Date().toISOString();
  run(
    `INSERT INTO tasks(id, kind, title, brief, status, scope, project, created, updated)
     VALUES (?, 'unattended', 't', 'b', 'waiting', ?, 'g', ?, ?)`,
    task,
    JSON.stringify({ credentials: [], repos: [], project: "g" }),
    t,
    t,
  );
  const summary = { project: "g", branch: `hortus/${task}`, main_sha: main, sha, stat: "", files: 1, added: 1 };
  run(
    "INSERT INTO approvals(kind, category, hash, task_id, summary, status, requested_at) VALUES ('request', 'merge', ?, ?, ?, 'pending', ?)",
    `h-${task}`,
    task,
    JSON.stringify(summary),
    t,
  );
  const [row] = sql<{ id: number }>("SELECT id FROM approvals WHERE task_id = ? AND category = 'merge'", task);
  return { id: row?.id ?? 0, sha, main };
}

for (const point of ["merge.after-ff", "merge.after-update-ref"]) {
  test(`merge: SIGKILL at ${point} → restart shows Retry; retry lands once, no rebase notice`, async () => {
    const task = point.endsWith("ff") ? "tff" : "tref";
    start();
    await up();
    const { id, sha, main } = await mergeEntry(task, `${task}.txt`);
    await stop();
    const d = start(point);
    await up();
    await call("approval.decide", { id, decision: "approve" }).catch(() => {});
    assert.equal(await exited(d), "SIGKILL");
    assert.equal(g(checkout, "rev-parse", "HEAD"), sha, "the checkout fast-forwarded before the kill");
    const originMain = () => g(home, "--git-dir", paths.project("g"), "rev-parse", "main");
    assert.equal(originMain(), point.endsWith("ff") ? main : sha);

    start();
    await up();
    const [e] = sql<{ status: string; reason: string | null }>("SELECT status, reason FROM approvals WHERE id = ?", id);
    assert.equal(e?.status, "approved");
    assert.match(e?.reason ?? "", /interrupted by a restart/);
    assert.deepEqual(await call("merge.retry", { id }), { landed: true, reason: null });
    const [l] = sql<{ status: string; reason: string | null }>("SELECT status, reason FROM approvals WHERE id = ?", id);
    assert.deepEqual({ ...l }, { status: "landed", reason: null });
    assert.equal(originMain(), sha);
    assert.equal(g(checkout, "rev-parse", "HEAD"), sha);
    const inbox = sql<{ body: string }>("SELECT body FROM inbox WHERE task_id = ?", task).map(
      (r) => JSON.parse(r.body) as { from: string; text: string },
    );
    assert.equal(
      inbox.filter((m) => m.from === "merge" && m.text === `merged ${sha}`).length,
      1,
      JSON.stringify(inbox),
    );
    assert.equal(inbox.filter((m) => m.from === "rebase").length, 0, JSON.stringify(inbox));
    // a second retry changes nothing
    await assert.rejects(call("merge.retry", { id }), /landed, not approved/);
    await stop();
  });
}

test("projects: SIGKILL between a task's clone and its branch → the restart's clone is on hortus/<id>", async () => {
  start();
  await up();
  await stop();
  const t = new Date().toISOString();
  run(
    `INSERT INTO tasks(id, kind, title, brief, status, scope, project, budget, usage, runtime, event_keys, created, updated,
       hours) VALUES ('pc', 'unattended', 't', 'b', 'queued', ?, 'g', '{"tokens":1000000,"hours":1}', '{"tokens":0}',
       'host', '[]', ?, ?, 0)`,
    JSON.stringify({ credentials: [], repos: [], project: "g" }),
    t,
    t,
  );
  assert.equal(await exited(start("origin.after-clone")), "SIGKILL");
  assert.ok(existsSync(`${paths.clone("pc")}.new`), "cloned before the kill");
  start();
  await up();
  // the start after the restart gets past prepareClone (the session itself may fail here: no Worker plugin)
  await until(
    () => sql<{ status: string }>("SELECT status FROM tasks WHERE id = 'pc'")[0]?.status !== "queued",
    20_000,
  );
  await until(
    () => {
      try {
        return g(paths.clone("pc"), "symbolic-ref", "--short", "HEAD") === "hortus/pc";
      } catch {
        return false;
      }
    },
    10_000,
    `the clone's branch (${(() => {
      try {
        return g(paths.clone("pc"), "symbolic-ref", "--short", "HEAD");
      } catch (e) {
        return String(e);
      }
    })()})`,
  ).catch((e) => {
    throw new Error(`${e.message}; HEAD ${g(paths.clone("pc"), "symbolic-ref", "--short", "HEAD")}`);
  });
  await stop();
  run("UPDATE tasks SET status = 'done' WHERE id = 'pc'");
});

test("schedules: SIGKILL right after a firing started its run → restart fires nothing twice", async () => {
  start();
  await up();
  await stop();
  const t = new Date().toISOString();
  run(
    `INSERT INTO tasks(id, kind, title, brief, status, scope, budget, usage, runtime, event_keys, created, updated, hours)
     VALUES ('ts', 'unattended', 'timer', 'b', 'waiting', '{"credentials":[],"repos":[]}', '{"tokens":1000000,"hours":1}',
       '{"tokens":0}', 'host', '[]', ?, ?, 0)`,
    t,
    t,
  );
  const future = new Date(Date.now() + 86_400_000).toISOString();
  run(
    "INSERT INTO schedules(task_id, fire_at, every_sec, tz, text, expires_at, created) VALUES ('ts', ?, 300, 'UTC', 'tick', ?, ?)",
    new Date(Date.now() - 1000).toISOString(),
    future,
    t,
  );
  const d = start("schedules.after-fire");
  assert.equal(await exited(d), "SIGKILL");
  const runs = () => sql<{ id: string; status: string }>("SELECT id, status FROM tasks WHERE parent = 'ts'");
  assert.equal(runs().length, 1);
  const [row] = sql<{ fire_at: string }>("SELECT fire_at FROM schedules WHERE task_id = 'ts'");
  assert.ok((row?.fire_at ?? "") > t, "advanced before it fired");

  start();
  await up();
  // a few ticks
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(runs().length, 1, JSON.stringify(runs()));
  await stop();
});

// round 8: the gate's decisions, expiries and closes around a SIGKILL (dispatcher PAUSED: no Worker runs)
const task = (id: string, status = "waiting"): void => {
  const t = new Date().toISOString();
  run(
    `INSERT INTO tasks(id, kind, title, brief, status, scope, budget, usage, runtime, event_keys, created, updated, hours)
     VALUES (?, 'unattended', 't', 'b', ?, '{"credentials":[],"repos":[],"dofs":[]}', '{"tokens":1000000,"hours":1}',
       '{"tokens":0}', 'host', '[]', ?, ?, 0)`,
    id,
    status,
    t,
    t,
  );
  mkdirSync(join(paths.ctl(id), "inbox"), { recursive: true });
};
const entry = (kind: string, taskId: string | null, payload: unknown, at = new Date().toISOString()): number => {
  run(
    "INSERT INTO approvals(kind, category, hash, task_id, summary, status, requested_at, payload) VALUES (?, 'credential:gh', ?, ?, '{}', 'pending', ?, ?)",
    kind,
    `h${Math.random()}`,
    taskId,
    at,
    JSON.stringify(payload),
  );
  return sql<{ id: number }>("SELECT max(id) AS id FROM approvals")[0]?.id ?? 0;
};
const told = (taskId: string, id: number): string[] =>
  sql<{ body: string }>("SELECT body FROM inbox WHERE task_id = ?", taskId)
    .map((r) => (JSON.parse(r.body) as { text: string }).text)
    .filter((t) => t.startsWith(`approval ${id} `));
const status = (id: number): string | undefined =>
  sql<{ status: string }>("SELECT status FROM approvals WHERE id = ?", id)[0]?.status;
const cardPending = async (taskId: string): Promise<number[]> =>
  (await call<{ approvals: { id: number }[] }>("task.get", { id: taskId })).approvals.map((a) => a.id);

test("gate: SIGKILL inside a decision (a task grant, a shared grant entry) → still pending, then told once", async () => {
  start();
  await up();
  await stop();
  writeFileSync(paths.paused(), "");
  for (const t of ["ga", "gb", "gc"]) task(t);
  const tg = entry("request", "ga", { consequential: false, judge: "tainted: x", untrusted: ["x"] });
  const shared = entry("grant", null, { consequential: false, task: "gb", waiting: ["gc"] });
  const before = sql("SELECT 1 FROM approvals").length;
  for (const [id, grant] of [
    [tg, true],
    [shared, false],
  ] as const) {
    const d = start("gate.decide.before-inbox");
    await up();
    await call("approval.decide", { id, decision: "approve", grant }).catch(() => {});
    assert.equal(await exited(d), "SIGKILL");
    assert.equal(status(id), "pending", "rolled back, not decided without its task told");
  }
  assert.equal(sql("SELECT 1 FROM approvals WHERE kind = 'grant' AND task_id = 'ga'").length, 0, "no half a grant");
  start();
  await up();
  // the card shows what the page shows; the waiting list survived
  assert.deepEqual(await cardPending("gc"), [shared]);
  assert.deepEqual(await cardPending("ga"), [tg]);
  await call("approval.decide", { id: tg, decision: "approve", grant: true });
  await call("approval.decide", { id: shared, decision: "approve" });
  await assert.rejects(call("approval.decide", { id: shared, decision: "approve" }), /already decided/);
  assert.equal(told("ga", tg).length, 1);
  assert.equal(told("gb", shared).length, 1);
  assert.equal(told("gc", shared).length, 1);
  assert.equal(sql("SELECT 1 FROM approvals WHERE kind = 'grant' AND task_id = 'ga'").length, 1);
  assert.deepEqual(await cardPending("gc"), []);
  assert.equal(sql("SELECT 1 FROM approvals").length, before + 1, "only the task grant: no entry asked again");
  for (const t of ["ga", "gb", "gc"])
    assert.equal(sql<{ status: string }>("SELECT status FROM tasks WHERE id = ?", t)[0]?.status, "queued");
  await stop();
});

test("gate: SIGKILL while entries expire → restart expires them at start and tells each task once", async () => {
  writeFileSync(paths.paused(), "");
  for (const t of ["ea", "eb"]) task(t);
  const old = new Date(Date.now() - 73 * 3600_000).toISOString();
  const own = entry("request", "ea", { consequential: true }, old);
  const shared = entry("grant", null, { consequential: false, task: "ea", waiting: ["eb"] }, old);
  assert.equal(await exited(start("gate.expire.before-inbox")), "SIGKILL");
  assert.equal(status(own), "pending");
  start();
  await up();
  assert.equal(status(own), "expired");
  assert.equal(status(shared), "expired");
  assert.equal(told("ea", own).length, 1);
  assert.equal(told("ea", shared).length, 1);
  assert.equal(told("eb", shared).length, 1);
  assert.deepEqual(await cardPending("eb"), []);
  await stop();
});

test("tasks: SIGKILL inside a close → its requests already expired; restart publishes the log, removes tasks/<id>", async () => {
  writeFileSync(paths.paused(), "");
  task("ca");
  const id = entry("request", "ca", { consequential: true });
  const d = start("tasks.close.after-status");
  await up();
  await call("task.close", { id: "ca" }).catch(() => {});
  assert.equal(await exited(d), "SIGKILL");
  assert.equal(status(id), "expired", "in the same turn as the status");
  assert.ok(existsSync(paths.task("ca")));
  start();
  await up();
  assert.equal(existsSync(paths.task("ca")), false);
  assert.ok(existsSync(join(paths.logs(), "ca", "summary.md")));
  assert.deepEqual(await cardPending("ca"), []);
  await stop();
  rmSync(paths.paused(), { force: true });
});

test("tasks: SIGKILL while a close waits for its session to end → the restart finishes the close, starts nothing", async () => {
  // the wait is a session's teardown, or its whole start (a big clone, a VM's boot): a restart then ran it again
  writeFileSync(paths.paused(), "");
  task("ck");
  const d = start("tasks.close.after-kill");
  await up();
  await call("task.close", { id: "ck" }).catch(() => {});
  assert.equal(await exited(d), "SIGKILL");
  start();
  await up();
  await until(() => !existsSync(paths.task("ck")), 10_000, "the close finished").catch(() => {});
  assert.equal(sql<{ status: string }>("SELECT status FROM tasks WHERE id = 'ck'")[0]?.status, "done");
  assert.equal(existsSync(paths.task("ck")), false);
  await stop();
  rmSync(paths.paused(), { force: true });
});
