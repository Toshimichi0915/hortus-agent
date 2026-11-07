/**
 * A large database: every list the owner reads is capped at the SQL level and pages by `skip`; a list's merge diffs
 * are excerpts, the entry's own answer has the patch; the nav badge is a count; the CLI says `--all`.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import type { Server } from "node:net";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { load } from "../config.ts";
import type { Ctx } from "../ctx.ts";
import { openDb } from "../db.ts";
import { logger } from "../log.ts";
import * as paths from "../paths.ts";
import { call, serveSocket } from "../rpc.ts";
import { tempDir } from "../test/until.ts";
import "../vault/index.ts";
import { bind } from "../vault/vault.ts";
import { consoleModule } from "./index.ts";

const home = tempDir("hortus-large-");
process.env.HORTUS_HOME = home;
process.env.HORTUS_CONSOLE_PORT = "0";
const ctx: Ctx = { config: load(), db: openDb(paths.db()), paths, log: logger, async reload() {} };
const patch = Array.from({ length: 1500 }, (_, i) => `+line ${i} ${"x".repeat(36)}`).join("\n");
let sock: Server;
let base = "";

before(async () => {
  const db = ctx.db;
  const at = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString();
  db.exec("BEGIN");
  const t = db.prepare(
    "INSERT INTO tasks(id, kind, title, status, created, updated, closed) VALUES (?, 'task', ?, ?, ?, ?, ?)",
  );
  for (let i = 0; i < 120; i++) t.run(`o${i}`, `open ${i}`, "waiting", at(i), at(i), null);
  for (let i = 0; i < 620; i++) t.run(`c${i}`, `closed ${i}`, "done", at(i), at(i), at(i));
  const a = db.prepare(
    "INSERT INTO approvals(kind, category, task_id, summary, status, requested_at) VALUES ('merge', 'merge', 'o1', ?, ?, ?)",
  );
  const summary = JSON.stringify({ project: "p", branch: "hortus/o1", patch, files: 1 });
  for (let i = 0; i < 120; i++) a.run(summary, "pending", at(i));
  for (let i = 0; i < 80; i++) a.run(summary, "replaced", at(i));
  const o = db.prepare("INSERT INTO outbox(task_id, seq, body, created) VALUES ('o1', ?, ?, ?)");
  for (let i = 0; i < 120; i++) o.run(i, JSON.stringify({ type: "message", text: `post ${i}` }), at(i));
  db.exec("COMMIT");
  bind(ctx);
  await consoleModule.start(ctx);
  base = `http://127.0.0.1:${consoleModule.port()}`;
  sock = await serveSocket(paths.socket());
});
after(async () => {
  sock.close();
  await consoleModule.stop();
});

const owner = { role: "owner" } as const;

/** What the app's fetch gets: the response's size and time, as a page load would. */
const api = async (method: string, input: unknown) => {
  const t = performance.now();
  const text = await (
    await fetch(`${base}/api/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hortus": "1" },
      body: JSON.stringify(input),
    })
  ).text();
  const ms = performance.now() - t;
  assert.ok(ms < 2000, `${method} took ${ms} ms`);
  return { bytes: text.length, result: JSON.parse(text).result };
};

test("Tasks: 50 open and 50 closed a page; skip reaches the oldest", async () => {
  const { result } = await api("task.list", {});
  const ids = (result as { id: string }[]).map((t) => t.id);
  assert.equal(ids.filter((id) => id.startsWith("o")).length, 50);
  assert.equal(ids.filter((id) => id.startsWith("c")).length, 50);
  const last = (await api("task.list", { skip: 100 })).result as { id: string }[];
  assert.equal(last.filter((t) => t.id.startsWith("o")).length, 20);
  assert.ok(last.some((t) => t.id === "o0")); // the oldest is reachable
});

test("Approvals: 50 pending, each merge an excerpt; the entry's own answer has the whole patch", async () => {
  const { bytes, result } = await api("approval.list", {});
  assert.ok(bytes < 1024 * 1024, `${bytes} bytes`);
  const rows = result as { id: number; status: string; summary: { patch: string; cut?: number } }[];
  assert.equal(rows.filter((a) => a.status === "pending").length, 50);
  assert.equal(rows.filter((a) => a.status === "replaced").length, 50);
  const top = rows[0];
  assert.equal(top?.id, 120);
  assert.equal(top?.summary.cut, 1500); // "Show the whole diff (1500 lines)" goes to /approvals/120
  assert.equal(top?.summary.patch.split("\n").length, 40);
  assert.doesNotMatch(JSON.stringify(rows), /line 1499 /);
  const one = (await api("approval.get", { id: 120 })).result as { summary: { patch: string; cut?: number } };
  assert.match(one.summary.patch, /line 1499 /);
  assert.equal(one.summary.cut, undefined);
});

test("RPCs: task.list and approval.list page; approval.count is the badge", async () => {
  assert.equal(((await call("task.list", {}, owner)) as unknown[]).length, 100);
  assert.equal(((await call("task.list", { limit: 500, skip: 500 }, owner)) as unknown[]).length, 120);
  assert.equal(((await call("approval.list", {}, owner)) as unknown[]).length, 100);
  assert.equal(((await call("approval.list", { status: "pending", limit: 500 }, owner)) as unknown[]).length, 120);
  assert.equal(await call("approval.count", {}, owner), 120);
});

test("RPCs: task.get stays a page, a list's pending counts stay cheap", async () => {
  const db = ctx.db;
  const s = db.prepare("INSERT INTO schedules(task_id, every_sec, text) VALUES ('o1', 60, ?)");
  db.exec("BEGIN");
  for (let i = 0; i < 80; i++) s.run(`tick ${i}`);
  db.exec("COMMIT");
  const t = performance.now();
  const list = (await call("task.list", { limit: 500 }, owner)) as { id: string; pending: number }[];
  assert.ok(performance.now() - t < 2000);
  assert.equal(list.find((x) => x.id === "o1")?.pending, 120);
  const card = (await call("task.get", { id: "o1" }, owner)) as {
    task: { pending: number };
    outbox: { seq: number }[];
    approvals: unknown[];
    schedules: unknown[];
  };
  assert.equal(card.outbox.length, 50);
  assert.equal(card.outbox.at(-1)?.seq, 119);
  assert.equal(card.approvals.length, 50);
  assert.ok(JSON.stringify(card).length < 1024 * 1024, "the merges' excerpts, not their 64 KB");
  assert.equal(card.task.pending, 120);
  assert.equal(card.schedules.length, 50);
});

test("RPCs: task.messages pages a task's outbox back past task.get's newest 50", async () => {
  const seqs = async (input: object) =>
    ((await call("task.messages", { id: "o1", box: "outbox", ...input }, owner)) as { seq: number }[]).map(
      (m) => m.seq,
    );
  const first = await seqs({});
  assert.equal(first.length, 50);
  assert.deepEqual([first[0], first.at(-1)], [119, 70]);
  // the oldest is reachable
  assert.deepEqual(
    await seqs({ skip: 100 }),
    Array.from({ length: 20 }, (_, i) => 19 - i),
  );
  assert.deepEqual(await seqs({ box: "inbox" }), []);
  await assert.rejects(call("task.messages", { id: "o1", box: "outbox", limit: 501 }, owner));
  await assert.rejects(call("task.messages", { id: "o1", box: "replies" }, owner));
});

test("CLI: hortus tasks says what it cut; --all lists every one", async () => {
  const run = async (...args: string[]) =>
    (
      await promisify(execFile)(
        process.execPath,
        ["--no-warnings", fileURLToPath(new URL("../bin/hortus.js", import.meta.url)), ...args],
        {
          env: process.env,
          maxBuffer: 64 << 20,
        },
      )
    ).stdout
      .trim()
      .split("\n");
  const cut = await run("tasks");
  assert.equal(cut.length, 101);
  assert.match(cut.at(-1) ?? "", /newest 50 of each list; hortus tasks --all/);
  assert.equal((await run("tasks", "--all")).length, 740);
  assert.match((await run("approvals")).at(-1) ?? "", /hortus approvals --all/);
  assert.equal((await run("approvals", "--all")).length, 200);
});
