import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import type { Server } from "node:net";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { load } from "../config.ts";
import type { Ctx } from "../ctx.ts";
import { openDb } from "../db.ts";
import { logger } from "../log.ts";
import * as paths from "../paths.ts";
import { define, serveSocket } from "../rpc.ts";
import { tempDir } from "../test/until.ts";
import { RpcError } from "../types.ts";
import { consoleModule } from "./index.ts";

const bin = fileURLToPath(new URL("../bin/hortus.js", import.meta.url));
const home = tempDir("hortus-cli-");
process.env.HORTUS_HOME = home;
process.env.HORTUS_CONSOLE_PORT = "0";

const calls: [string, unknown][] = [];
const record = (name: string, result: (input: unknown) => unknown = () => ({ ok: true })) =>
  define(name, {
    roles: ["owner"],
    input: z.unknown(),
    run(input) {
      calls.push([name, input]);
      return result(input);
    },
  });
record("task.open", () => ({ id: "t1" }));
record("task.send");
record("project.sync");
record("task.stop");
record("task.close");
define("task.stream", {
  roles: ["owner"],
  input: z.unknown(),
  run: () =>
    (async function* () {
      yield { type: "text", text: "hello from worker" };
      yield { type: "tool_call", id: "1", name: "bash", input: { command: "ls -la" } };
      yield { type: "status", text: "idle" };
      yield { type: "status", text: "idle" };
      await new Promise(() => {});
    })(),
});
define("approval.decide", {
  roles: ["owner"],
  input: z.object({ id: z.number(), decision: z.enum(["approve", "reject"]) }),
  run({ id }) {
    if (id === 1) throw new RpcError("invalid", "already decided");
    if (id === 2) return { ok: true, message: "approved, not landed: checkout is not clean" };
    throw new RpcError("not_found", `approval ${id} not found`);
  },
});

define("approval.list", {
  roles: ["owner"],
  input: z.unknown(),
  run: () => [
    {
      id: 3,
      status: "pending",
      category: "credential:gl",
      task_id: "t1",
      summary: { method: "POST", host: "h", path: "/n", rendered: "comment on g/p#1" },
      payload: { untrusted: ["read a web page: evil.example"] },
      grantable: true,
    },
    {
      id: 2,
      status: "pending",
      category: "merge",
      task_id: "t1",
      summary: { project: "web", branch: "hortus/t1", added: 3, removed: 1 },
      payload: null,
      grantable: false,
    },
    {
      id: 1,
      status: "approved",
      category: "merge",
      task_id: "t1",
      reason: "checkout is not clean",
      summary: { project: "web", branch: "hortus/t2", added: 1, removed: 0 },
    },
  ],
});

let sock: Server;
before(async () => {
  const ctx: Ctx = { config: load(), db: openDb(paths.db()), paths, log: logger, reload: async () => {} };
  await consoleModule.start(ctx);
  sock = await serveSocket(paths.socket());
});
after(async () => {
  sock.close();
  await consoleModule.stop();
});

function start(args: string[], env: Record<string, string> = {}): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ["--no-warnings", bin, ...args], {
    env: { ...process.env, ...env },
    cwd: home,
  });
}

function run(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number | null; out: string; err: string }> {
  const p = start(args, env);
  let out = "";
  let err = "";
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (err += d));
  p.stdin.end();
  return new Promise((r) => p.on("exit", (code) => r({ code, out, err })));
}

async function waitFor(get: () => string, re: RegExp): Promise<void> {
  for (let i = 0; i < 200 && !re.test(get()); i++) await sleep(25);
  assert.match(get(), re);
}

test("hortus ping without a daemon: one line, exit 1", async () => {
  const r = await run(["ping"], { HORTUS_HOME: tempDir("hortus-none-") });
  assert.equal(r.code, 1);
  assert.match(r.err, /^hortusd is not running \(socket \\0hortus-[0-9a-f]+\): sudo systemctl start hortusd\n$/);
});

test("hortus tasks on an empty DB", async () => {
  const r = await run(["tasks"]);
  assert.equal(r.err, "");
  assert.equal(r.out, "no tasks\n");
  assert.equal(r.code, 0);
});

test("hortus approvals approve: not found and already decided exit 1", async () => {
  const nf = await run(["approvals", "approve", "99"]);
  assert.equal(nf.code, 1);
  assert.equal(nf.err, "approval 99 not found\n");
  const done = await run(["approvals", "reject", "1"]);
  assert.equal(done.code, 1);
  assert.equal(done.err, "already decided\n");
  assert.equal((await run(["approvals", "maybe", "1"])).code, 64);
  assert.equal((await run(["image"])).code, 64);
});

test("hortus approvals: what the page warns of; a merge that did not land says so", async () => {
  const { out } = await run(["approvals"]);
  assert.match(out, /^#3\tpending\tcredential:gl\tt1\tPOST h \/n\n/);
  assert.match(out, /\n\tcomment on g\/p#1\n\ttainted: read a web page: evil\.example\n/);
  assert.match(out, /\n\tapprove --grant 3 also allows credential:gl for this task\n/);
  assert.match(out, /\n#2\tpending\tmerge\tt1\tweb hortus\/t1 \+3 −1\n/);
  assert.equal((await run(["approvals", "approve", "2"])).out, "approved, not landed: checkout is not clean\n");
});

test("hortus help: stdout, exit 0; unknown command: named, usage, exit 64; <cmd> --help: its usage; sync says so", async () => {
  for (const a of ["--help", "help"]) {
    const r = await run([a]);
    assert.equal(r.code, 0, a);
    assert.match(r.out, /^usage: hortus <command>\n/);
    assert.equal(r.err, "");
  }
  const bogus = await run(["bogus"]);
  assert.equal(bogus.code, 64);
  assert.match(bogus.err, /^unknown command bogus\nusage: hortus <command>/);
  const th = await run(["tasks", "--help"]);
  assert.equal(th.code, 0);
  assert.match(th.out, /^usage: hortus tasks \[--all \| <id>\]/);
  const sync = await run(["sync", "--force", "web"]);
  assert.equal(sync.code, 0);
  assert.equal(sync.out, "synced web\n");
  // the direction a sync goes, pausing said as on the console; stop and close say they did it
  const help = (await run(["help"])).out;
  assert.match(help, /sync \[--force\] <project> +update the project's origin from its checkout/);
  assert.match(help, /pause +queued tasks, schedules and the Planner wait; running tasks go on\./);
  assert.equal((await run(["stop", "t1"])).out, "stopping\n");
  assert.equal((await run(["close", "t1"])).out, "closed t1\n");
});

test("hortus chat: first line opens with the cwd, later lines send, stream printed, Ctrl-D exits 0", async () => {
  calls.length = 0;
  const p = start(["chat"]);
  let out = "";
  p.stdout.on("data", (d) => (out += d));
  p.stdin.write("first line\n");
  await waitFor(() => out, /hello from worker\n\$ ls -la\n/);
  p.stdin.write("second line\n");
  await waitFor(() => JSON.stringify(calls), /task.send/);
  const exited = new Promise((r) => p.on("exit", r));
  p.stdin.end();
  assert.equal(await exited, 0);
  assert.deepEqual(calls, [
    ["task.open", { text: "first line", cwd: home }],
    ["task.send", { id: "t1", text: "second line" }],
  ]);
});

test("hortus chat -r: Ctrl-C once stops the task, twice exits", async () => {
  calls.length = 0;
  // `chat -r t1` checks the task exists before it follows the stream
  openDb(paths.db()).prepare("INSERT INTO tasks(id, kind, status, title) VALUES ('t1', 'chat', 'waiting', 't')").run();
  const p = start(["chat", "-r", "t1"]);
  let out = "";
  p.stdout.on("data", (d) => (out += d));
  await waitFor(() => out, /hello from worker/);
  p.kill("SIGINT");
  await waitFor(() => JSON.stringify(calls), /task.stop/);
  const exited = new Promise((r) => p.on("exit", r));
  p.kill("SIGINT");
  assert.equal(await exited, 130);
  assert.deepEqual(calls, [["task.stop", { id: "t1" }]]);
});

test("hortus chat says, once, that an approval waits; a merge that did not land says why; close refuses a typo", async () => {
  const db = openDb(paths.db());
  db.prepare(
    "INSERT INTO approvals(id, kind, category, task_id, summary, status, requested_at) VALUES (9, 'request', 'credential:slack', 't1', '{}', 'pending', 'x')",
  ).run();
  const p = start(["chat", "-r", "t1"]);
  let err = "";
  p.stderr.on("data", (d) => (err += d));
  await waitFor(() => err, /approval #9 pending \(credential:slack\): hortus approvals\n/);
  await sleep(100);
  assert.equal(err.match(/approval #9/g)?.length, 1);
  p.stdin.end();
  assert.match((await run(["approvals"])).out, /#1\tapproved\tmerge[^\n]*\n\tnot landed: checkout is not clean/);
  calls.length = 0;
  const typo = await run(["close", "t1", "faild"]);
  assert.equal(typo.code, 64);
  assert.deepEqual(calls, []);
});

test("hortus chat -r <unknown>: one error line, exit 1", async () => {
  const p = start(["chat", "-r", "nope"]);
  let err = "";
  p.stderr.on("data", (d) => (err += d));
  const exited = new Promise((r) => p.on("exit", r));
  p.stdin.end();
  assert.equal(await exited, 1);
  assert.equal(err.trim().split("\n").length, 1, err);
  assert.match(err, /no task nope/);
});
