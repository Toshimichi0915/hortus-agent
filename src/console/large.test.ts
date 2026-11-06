/**
 * A large database: every list the owner reads is capped at the SQL level, says what it cut and links
 * the next page (`?skip=`); merge diffs stay on the entry's own page; the nav badge is a count; the CLI says `--all`.
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

const page = async (path: string) => {
  const t = performance.now();
  const html = await (await fetch(base + path)).text();
  const ms = performance.now() - t;
  assert.ok(ms < 2000, `${path} took ${ms} ms`);
  return html;
};
const rows = (html: string, re: RegExp) => html.match(re)?.length ?? 0;

test("Tasks: 50 open and 50 closed, the cut said, older and newer links", async () => {
  const html = await page("/");
  assert.equal(rows(html, /href="\/tasks\/o\d+"/g), 50);
  assert.equal(rows(html, /href="\/tasks\/c\d+"/g), 50);
  assert.match(html, /showing 1–50 of 120 open tasks · <a href="\?skip=50">older<\/a>/);
  assert.match(html, /showing 1–50 of 620 closed tasks/);
  const last = await page("/?skip=100");
  assert.match(last, /showing 101–120 of 120 open tasks · <a href="\?skip=50">newer<\/a><\/p>/);
  assert.match(last, /href="\/tasks\/o0"/); // the oldest is reachable
});

test("Approvals: 50 pending without their full diffs; the entry's page has it", async () => {
  const html = await page("/approvals");
  assert.ok(html.length < 1024 * 1024, `${html.length} bytes`);
  assert.equal(rows(html, /<article class="approval pending/g), 50);
  assert.match(html, /showing 1–50 of 120 pending · <a href="\?skip=50">older<\/a>/);
  assert.match(html, /showing 1–50 of 80 decided/);
  assert.match(html, /<a href="\/approvals\/120">full diff \(1500 lines\)<\/a>/);
  assert.doesNotMatch(html, /line 1499 /);
  assert.match(await page("/approvals/120"), /line 1499 /);
  // ?judge=hide survives paging
  assert.match(await page("/approvals?judge=hide"), /href="\?judge=hide&amp;skip=50">older/);
});

test("Task card: the newest 50 messages, the rest a page back", async () => {
  const html = await page("/tasks/o1");
  assert.match(html, /showing 1–50 of 120 messages/);
  assert.match(html, /post 119/);
  assert.doesNotMatch(html, /post 69</);
  assert.match(await page("/tasks/o1?skip=100"), /post 0</);
});

test("RPCs: task.list and approval.list page; approval.count is the badge", async () => {
  const owner = { role: "owner" } as const;
  assert.equal(((await call("task.list", {}, owner)) as unknown[]).length, 100);
  assert.equal(((await call("task.list", { limit: 500, skip: 500 }, owner)) as unknown[]).length, 120);
  assert.equal(((await call("approval.list", {}, owner)) as unknown[]).length, 100);
  assert.equal(((await call("approval.list", { status: "pending", limit: 500 }, owner)) as unknown[]).length, 120);
  assert.equal(await call("approval.count", {}, owner), 120);
});

test("RPCs: task.get stays a page, a list's pending counts stay cheap", async () => {
  const owner = { role: "owner" } as const;
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
  assert.equal(card.task.pending, 120);
  assert.equal(card.schedules.length, 50);
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
