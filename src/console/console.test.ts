import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { load } from "../config.ts";
import type { Ctx } from "../ctx.ts";
import { openDb, taintOf } from "../db.ts";
import { logger } from "../log.ts";
import * as paths from "../paths.ts";
import { call, define } from "../rpc.ts";
import { tempDir } from "../test/until.ts";
import { bus, consoleModule } from "./index.ts";
import { hit } from "./pages/search.ts";
import { sse } from "./server.ts";

process.env.HORTUS_HOME = tempDir("hortus-console-");
process.env.HORTUS_CONSOLE_PORT = "0";
let reloads = 0;
const ctx: Ctx = {
  config: load(),
  db: openDb(paths.db()),
  paths,
  log: logger,
  async reload() {
    reloads++;
    ctx.config = load();
  },
};
let port = 0;

define("ping", { roles: ["owner"], input: z.unknown(), run: () => ({ pong: true }) });
define("task.open", {
  roles: ["owner"],
  input: z.object({ text: z.string(), cwd: z.string().optional() }),
  run({ text }) {
    if (text === "boom") throw new Error("boom");
    return { id: "t1" };
  },
});
define("task.stream", {
  roles: ["owner"],
  input: z.unknown(),
  async run() {
    return (async function* () {
      yield 1;
    })();
  },
});

before(async () => {
  sse.keepaliveMs = 50;
  await consoleModule.start(ctx);
  port = consoleModule.port();
});
after(() => consoleModule.stop());

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function get(path: string, headers: Record<string, string> = {}, method = "GET", body?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = request(
      { host: "127.0.0.1", port, path, method, headers: { host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        let b = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (b += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: b }));
      },
    );
    r.on("error", reject);
    r.end(body);
  });
}

const JSONH = { "x-hortus": "1", "content-type": "application/json", "sec-fetch-site": "same-origin" };
const post = (method: string, input: unknown, headers: Record<string, string> = JSONH) =>
  get(`/api/${method}`, headers, "POST", JSON.stringify(input));

test("guards: host, sec-fetch-site, X-Hortus, body cap, headers", async () => {
  assert.equal((await get("/", { host: "evil.example" })).status, 421);
  assert.equal((await get("/", { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await post("ping", {}, { "content-type": "application/json" })).status, 403);
  assert.equal((await post("ping", {}, { "x-hortus": "1", "content-type": "text/plain" })).status, 403);
  assert.equal((await post("ping", {})).status, 200);
  const page = await get("/");
  assert.equal(page.status, 200);
  assert.match(String(page.headers["content-security-policy"]), /script-src 'self';/);
  assert.equal(page.headers["cache-control"], "no-store");
  assert.equal(page.headers["x-frame-options"], "DENY");
  assert.equal((await get("/", { host: `localhost:${port}`, "sec-fetch-site": "none" })).status, 200);
  const big = await post("ping", { x: "a".repeat(2 * 1024 * 1024) });
  assert.equal(big.status, 413);
});

test("api: invalid → 400 with the zod path, unknown → 404, handler error → 500 without a stack", async () => {
  const bad = await post("task.open", { text: 3 });
  assert.equal(bad.status, 400);
  assert.deepEqual(JSON.parse(bad.body).error.data[0].path, ["text"]);
  assert.equal((await post("nope.nope", {})).status, 404);
  const boom = await post("task.open", { text: "boom" });
  assert.equal(boom.status, 500);
  assert.equal(JSON.parse(boom.body).error.message, "boom");
  assert.doesNotMatch(boom.body, /at .*\.js/);
  assert.equal((await post("task.stream", {})).status, 400);
  assert.equal((await get("/api/ping", {}, "POST", "{nope")).status, 403);
  assert.equal((await get("/api/ping", JSONH, "POST", "{nope")).status, 400);
});

/** Reads an SSE response until `until(text)` holds, then closes it. */
function stream(path: string, headers: Record<string, string>, until: (t: string) => boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let b = "";
      res.setEncoding("utf8");
      res.on("data", (c) => {
        b += c;
        if (until(b)) {
          r.destroy();
          resolve(b);
        }
      });
    });
    r.on("error", (e) => (e.message === "socket hang up" ? undefined : reject(e)));
    r.end();
  });
}

test("the failure DM's link is a page; a paused task says so; past the first page no list says it is empty", async () => {
  assert.equal((await get("/tasks")).status, 200); // hortusd.ts › dm("/tasks")
  const t = new Date().toISOString();
  ctx.db
    .prepare("INSERT INTO tasks(id, kind, title, status, created, updated) VALUES ('p1', 'chat', 'p', 'queued', ?, ?)")
    .run(t, t);
  assert.doesNotMatch((await get("/chat/p1")).body, /Paused:/);
  writeFileSync(paths.paused(), "");
  try {
    for (const p of ["/chat/p1", "/tasks/p1", "/"]) assert.match((await get(p)).body, /Paused: queued tasks/, p);
  } finally {
    rmSync(paths.paused());
  }
  const ins = ctx.db.prepare(
    "INSERT INTO approvals(kind, category, status, requested_at) VALUES ('request', 'c', ?, ?)",
  );
  ins.run("pending", t);
  for (let i = 0; i < 60; i++) ins.run("used", t);
  const second = (await get("/approvals?skip=50")).body;
  assert.match(second, /showing none of 1 pending/);
  assert.doesNotMatch(second, /nothing pending/);
  assert.doesNotMatch((await get("/?skip=50")).body, /no open tasks/);
  ctx.db.exec("DELETE FROM tasks WHERE id = 'p1'; DELETE FROM approvals");
  assert.match((await get("/approvals")).body, /nothing pending/);
});

test("a chat past the replay's 1,000 lines says what it cut and where the rest is", async () => {
  const t = new Date().toISOString();
  ctx.db
    .prepare(
      "INSERT INTO tasks(id, kind, title, status, created, updated) VALUES ('long', 'chat', 'l', 'waiting', ?, ?)",
    )
    .run(t, t);
  const ins = ctx.db.prepare("INSERT INTO replies(task_id, seq, body, created) VALUES ('long', ?, ?, ?)");
  ins.run(1, JSON.stringify({ type: "owner", text: "the first question" }), t);
  assert.doesNotMatch((await get("/chat/long")).body, /not shown/);
  for (let i = 2; i <= 1500; i++) ins.run(i, JSON.stringify({ type: "text", text: `delta ${i} ` }), t);
  const { body: page } = await get("/chat/long");
  assert.doesNotMatch(page, /the first question/);
  assert.match(page, /500 earlier lines not shown .*<a href="\/tasks\/long\/log"/);
  assert.match((await get("/tasks/long")).body, /1,300 earlier lines not shown/);
  ctx.db.exec("DELETE FROM tasks WHERE id = 'long'; DELETE FROM replies WHERE task_id = 'long'");
});

test("sse: a chat row is { seq, html, body, created }; a row that cannot be re-serialized goes as its text", async () => {
  const ins = ctx.db.prepare("INSERT INTO replies(task_id, seq, body, created) VALUES ('rows', ?, ?, '2026-01-01')");
  const nest = (n: number) => `{"type":"text","text":${"[".repeat(n)}${"]".repeat(n)}}`;
  ins.run(1, JSON.stringify({ type: "text", text: "plain <b>" }));
  ins.run(2, "not json at all");
  ins.run(3, nest(1e6));
  // every depth around where JSON.stringify gives out, whatever the stack holds when the row is written
  let edge = 1000;
  try {
    for (; edge < 1e6; edge += 100) JSON.stringify(JSON.parse(nest(edge)));
  } catch {}
  let seq = 3;
  for (let d = edge - 500; d < edge + 100; d += 5) ins.run(++seq, nest(d));
  ins.run(++seq, JSON.stringify({ type: "status", text: "after them" }));
  const text = await stream("/events/chat?task=rows", {}, (t) => t.includes(`id: ${seq}\n`));
  const rows = [...text.matchAll(/^data: (.*)$/gm)].map((m) => JSON.parse(m[1] as string));
  assert.deepEqual(
    rows.map((r) => r.seq),
    Array.from({ length: seq }, (_, i) => i + 1),
  );
  assert.deepEqual(rows[0], {
    seq: 1,
    html: '<div class="r text">plain &lt;b&gt;</div>',
    created: "2026-01-01",
    body: { type: "text", text: "plain <b>" },
  });
  assert.equal(rows[1].body, "not json at all");
  assert.equal(rows[2].body, nest(1e6));
  assert.deepEqual(rows.at(-1).body, { type: "status", text: "after them" });
  ctx.db.exec("DELETE FROM replies WHERE task_id = 'rows'");
});

test("sse: chat honours Last-Event-ID and follows the bus; keepalives; no listener leak", async () => {
  const ins = ctx.db.prepare("INSERT INTO replies(task_id, seq, body, created) VALUES ('x', ?, ?, '2026-01-01')");
  for (let i = 1; i <= 10; i++) ins.run(i, JSON.stringify({ type: "text", text: `line ${i}` }));
  const got = stream("/events/chat?task=x", { "last-event-id": "7" }, (t) => t.includes("id: 11"));
  await sleep(50);
  ins.run(11, JSON.stringify({ type: "text", text: "line 11" }));
  bus.emit("chat:x");
  const text = await got;
  assert.deepEqual(
    [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1])),
    [8, 9, 10, 11],
  );
  assert.match(text, /line 11/);

  // a phone back from sleep: more rows missed than one replay's 1000, every one of them in order
  for (let i = 12; i <= 2600; i++) ins.run(i, JSON.stringify({ type: "text", text: `line ${i}` }));
  const woke = await stream("/events/chat?task=x", { "last-event-id": "11" }, (t) => t.includes("id: 2600\n"));
  assert.deepEqual(
    [...woke.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1])),
    Array.from({ length: 2589 }, (_, i) => i + 12),
  );

  // a page's one stream: its channels as named events, the chat's rows unnamed; unknown ones refused
  const page = stream("/events/approvals,tasks,chat?task=x&after=2599", {}, (t) => t.includes("event: tasks"));
  await sleep(30);
  bus.emit("approvals", { id: 2 });
  bus.emit("tasks", { id: "t" });
  const all = await page;
  assert.match(all, /id: 2600\ndata: \{"seq":2600/);
  assert.match(all, /event: approvals\ndata: \{"id":2\}/);
  assert.match(all, /event: tasks\ndata: \{"id":"t"\}/);
  assert.equal((await get("/events/approvals,nope")).status, 404);

  const ka = await stream("/events/tasks", {}, (t) => t.includes(": keepalive"));
  assert.match(ka, /: keepalive/);
  const ev = stream("/events/approvals", {}, (t) => t.includes("data: "));
  await sleep(30);
  bus.emit("approvals", { id: 1 });
  assert.match(await ev, /data: \{"id":1\}/);

  for (let i = 0; i < 100; i++) await stream("/events/approvals", {}, (t) => t.includes(": hello"));
  await sleep(100);
  assert.equal(bus.listenerCount("approvals"), 0);
  assert.equal(bus.listenerCount("chat:x"), 0);
  assert.equal(bus.listenerCount("tasks"), 0);
});

const ROUTES = [
  "/",
  "/tasks/none",
  "/chat",
  "/chat/none",
  "/approvals",
  "/approvals/1",
  "/credentials",
  "/projects",
  "/settings",
  "/sources",
  "/search",
  "/search?q=x",
  "/schedules",
];

function clean(path: string, html: string): void {
  for (const bad of ["undefined", "[object Object]", "NaN"]) assert.ok(!html.includes(bad), `${path} contains ${bad}`);
  assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)[^>]*>/, `${path} has an inline script`);
  assert.match(html, /<script src="\/static\/app\.js" defer><\/script>/);
}

test("Schedules: a row shows its last run's summary; a merge cut at 64 KB links the whole diff", async () => {
  ctx.db.prepare("INSERT INTO tasks(id, kind, title, status) VALUES ('sw', 'unattended', 'watch', 'waiting')").run();
  const { lastInsertRowid: id } = ctx.db
    .prepare(
      "INSERT INTO schedules(task_id, fire_at, every_sec, text) VALUES ('sw', '2030-01-01T00:00:00Z', 3600, 'x')",
    )
    .run();
  mkdirSync(paths.schedule(Number(id)), { recursive: true });
  writeFileSync(join(paths.schedule(Number(id)), "last-summary.md"), "## Goal\nnothing moved today\n");
  assert.match((await get("/schedules")).body, /## Goal\s+nothing moved today/);
  const { lastInsertRowid: a } = ctx.db
    .prepare(
      "INSERT INTO approvals(kind, category, hash, status, requested_at, summary) VALUES ('request', 'merge', 'h', 'pending', 't', ?)",
    )
    .run(JSON.stringify({ project: "p", branch: "b", main_sha: "m", sha: "s", patch: "x", truncated: true, files: 1 }));
  assert.match((await get(`/approvals/${a}`)).body, new RegExp(`href="/approvals/${a}/diff"`));
  ctx.db.prepare("DELETE FROM approvals WHERE id = ?").run(a);
  ctx.db.prepare("DELETE FROM tasks WHERE id = 'sw'").run();
  assert.equal((await get(`/approvals/${a}/diff`)).status, 404);
});

test("a link from another site (owner.notify's, in a messenger's web app) gets a link on, and nothing of the console", async () => {
  const r = await get("/approvals?x=1", { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" });
  assert.equal(r.status, 403);
  assert.match(r.body, /<a href="\/approvals\?x=1">/);
  assert.doesNotMatch(r.body, /<nav|pending/);
});

test("every route renders on an empty DB, missing RPCs become an error line", async () => {
  for (const path of ROUTES) {
    const r = await get(path);
    assert.equal(r.status, 200, path);
    clean(path, r.body);
  }
  assert.match((await get("/credentials")).body, /class="error">credential.list: no method credential.list/);
  assert.match((await get("/search?q=x")).body, /class="error">dof.search/);
  const nf = await get("/nowhere");
  assert.equal(nf.status, 404);
  clean("/nowhere", nf.body);
  assert.equal((await get("/static/app.js")).status, 200);
  assert.equal((await get("/static/app.css")).headers["content-type"], "text/css; charset=utf-8");
  assert.equal((await get("/tasks/none/log")).status, 404);
});

test("Schedules shows the last run's summary; Credentials suggests the shipped transforms", async () => {
  const now = new Date().toISOString();
  ctx.db
    .prepare(
      "INSERT INTO tasks(id, kind, title, status, created, updated) VALUES ('sum1', 'chat', 'watch', 'waiting', ?, ?)",
    )
    .run(now, now);
  const id = Number(
    ctx.db
      .prepare(
        "INSERT INTO schedules(task_id, fire_at, every_sec, text) VALUES ('sum1', '2030-01-01T00:00:00Z', 3600, 'w')",
      )
      .run().lastInsertRowid,
  );
  mkdirSync(paths.schedule(id), { recursive: true });
  writeFileSync(join(paths.schedule(id), "last-summary.md"), "found <b>two</b> builds");
  for (const page of ["/schedules", "/tasks/sum1"])
    assert.match((await get(page)).body, /<summary>summary<\/summary><pre>found &lt;b&gt;two&lt;\/b&gt; builds/, page);
  ctx.db.prepare("DELETE FROM schedules WHERE id = ?").run(id);
  ctx.db.prepare("DELETE FROM tasks WHERE id = 'sum1'").run();
  assert.match((await get("/credentials")).body, /<datalist id="transforms">.*<option value="openai">/s);
});

test("500 tasks render under 200 ms, hostile titles and replies are escaped everywhere", async () => {
  const XSS = "<script>alert(1)</script>";
  const ins = ctx.db.prepare(
    `INSERT INTO tasks(id, kind, title, status, budget, usage, hours, project, created, updated, closed, summary)
     VALUES (?, 'chat', ?, ?, '{"tokens":2000000,"hours":4}', '{"tokens":1200000}', 0.5, 'p', ?, ?, ?, ?)`,
  );
  for (let i = 0; i < 500; i++) {
    const st = i % 5 === 0 ? "done" : "waiting";
    ins.run(
      `t${i}`,
      XSS,
      st,
      "2026-01-01T00:00:00Z",
      `2026-01-01T00:${String(i % 60).padStart(2, "0")}:00Z`,
      st === "done" ? "2026-01-02T00:00:00Z" : null,
      XSS,
    );
  }
  ctx.db
    .prepare("INSERT INTO replies(task_id, seq, body) VALUES ('t1', 1, ?)")
    .run(JSON.stringify({ type: "text", text: "</textarea><b>x</b>" }));
  ctx.db
    .prepare("INSERT INTO replies(task_id, seq, body) VALUES ('t1', 2, ?)")
    .run(JSON.stringify({ type: "tool_call", id: "c", name: "bash", input: { command: "ls" } }));
  ctx.db
    .prepare("INSERT INTO inbox(task_id, seq, body) VALUES ('t1', 1, ?)")
    .run(JSON.stringify({ from: "owner", text: XSS }));
  ctx.db.prepare("INSERT INTO schedules(task_id, fire_at, text) VALUES ('t1', '2026-02-01T00:00:00Z', ?)").run(XSS);
  ctx.db
    .prepare(
      "INSERT INTO approvals(kind, category, task_id, summary, status, requested_at) VALUES ('request', 'credential:slack', 't1', ?, 'pending', '2026-01-01')",
    )
    .run(
      JSON.stringify({
        method: "POST",
        host: "slack.com",
        path: "/api/chat.postMessage",
        headers: { authorization: "Bearer {secret:slack}" },
        bodyPreview: XSS,
      }),
    );
  ctx.db
    .prepare(
      "INSERT INTO approvals(kind, category, summary, status, decided_by, decided_at, reason) VALUES ('merge', 'merge', '{}', 'approved', 'judge', '2026-01-01', 'fine')",
    )
    .run();

  await get("/");
  const t0 = performance.now();
  const page = await get("/");
  assert.ok(performance.now() - t0 < 200, "tasks page under 200 ms");
  assert.match(page.body, /1\.2M \/ 2\.0M tokens, 0\.5 \/ 4 h/);
  // live: usage is written when a session ends, so a running one showed 0 (or its last session's) while the proxy had
  // counted 500k; the proxy's count is what it has spent so far
  ctx.db.prepare("UPDATE tasks SET metered = 1500000 WHERE id = 't1'").run();
  assert.match((await get("/tasks/t1")).body, /1\.5M \/ 2\.0M tokens/);
  ctx.db.prepare("UPDATE tasks SET metered = 0 WHERE id = 't1'").run();
  // live: a stop at its hours went on at the raise alone, while the card asked for a raise and then a message too
  const stop = "budget_exceeded: the session was stopped after 1.00 h";
  ctx.db.prepare("UPDATE tasks SET error = ? WHERE id = 't1'").run(stop);
  assert.match((await get("/tasks/t1")).body, /waiting: raise its budget and it goes on/);
  ctx.db.prepare("UPDATE tasks SET error = NULL WHERE id = 't1'").run();
  for (const path of [...ROUTES, "/tasks/t1", "/chat/t1"]) {
    const r = await get(path);
    clean(path, r.body);
    assert.ok(!r.body.includes(XSS), `${path} leaks the raw title`);
  }
  const chat = (await get("/chat/t1")).body;
  assert.equal(chat.split("</textarea>").length - 1, 1, "only the composer closes a textarea");
  assert.match(chat, /&lt;\/textarea&gt;/);
  assert.match(chat, /\$ ls/);
  assert.match(chat, /data-call="approval.decide"/);
  const ap = (await get("/approvals")).body;
  assert.match(ap, /Bearer \{secret:slack\}/);
  assert.match(ap, /allowed by judge/);
  assert.match(ap, /<span class="badge">1<\/span>/);
  assert.match((await get("/tasks/t1")).body, /aria-current="page">Tasks/);
});

test("settings.set: invalid → names the key, nothing written; valid → saved and reload()", async () => {
  const bad = await post("settings.set", { config: { vm: { cpus: "x" } } });
  assert.equal(bad.status, 400);
  assert.match(JSON.parse(bad.body).error.message, /vm\.cpus/);
  assert.equal(existsSync(paths.config()), false);
  assert.equal(reloads, 0);
  const ok = await post("settings.set", { config: { ...ctx.config, owner: { tz: "UTC" } } });
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(readFileSync(paths.config(), "utf8")).owner.tz, "UTC");
  assert.equal(reloads, 1);
  assert.equal(ctx.config.owner.tz, "UTC");
  assert.equal(JSON.parse(ok.body).result.message, undefined);
  // a typo'd key is kept, as a newer version's would be, and the save says it does nothing
  const typo = await post("settings.set", { config: { ...ctx.config, polcy: { "*": "auto" } } });
  assert.match(JSON.parse(typo.body).result.message, /not settings hortusd knows: polcy/);
  await post("settings.set", { config: { ...ctx.config, polcy: undefined } });
  reloads = 1;
  assert.equal((await post("pause.set", { paused: true })).status, 200);
  assert.ok(existsSync(paths.paused()));
  assert.match((await get("/settings")).body, /Paused\./);
  await call("pause.set", { paused: false }, { role: "owner" });
  assert.ok(!existsSync(paths.paused()));
});

test("task.list and task.get read the DB", async () => {
  const list = (await call("task.list", undefined, { role: "owner" })) as { id: string; budget: { tokens: number } }[];
  assert.equal(list.length, 50 + 50); // the newest 50 of each list
  assert.equal(((await call("task.list", { limit: 500 }, { role: "owner" })) as unknown[]).length, 400 + 100);
  assert.equal(list[0]?.budget.tokens, 2e6);
  const card = (await call("task.get", { id: "t1" }, { role: "owner" })) as {
    replies: { body: { type: string } }[];
    approvals: { summary: { host: string } }[];
    inbox: unknown[];
  };
  assert.equal(card.replies[0]?.body.type, "text");
  assert.equal(card.approvals[0]?.summary.host, "slack.com");
  assert.equal(card.inbox.length, 1);
  await assert.rejects(call("task.get", { id: "nope" }, { role: "owner" }), /no task nope/);
});

const worker = { role: "worker", task: "t1" } as const;

test("pause.get says what the PAUSED file says, to the owner alone", async () => {
  assert.deepEqual(await call("pause.get", {}, { role: "owner" }), { paused: false });
  writeFileSync(paths.paused(), "");
  assert.deepEqual(await call("pause.get", {}, { role: "owner" }), { paused: true });
  rmSync(paths.paused());
  await assert.rejects(call("pause.get", {}, worker), /not allowed/);
});

test("task.list and task.get: what waits on a task, what it sent, where it came from, what tainted it", async () => {
  const owner = { role: "owner" } as const;
  const db = ctx.db;
  const at = "2099-01-01T00:00:00.000Z"; // ahead of the other tests' tasks: the first of task.list
  const task = db.prepare(
    "INSERT INTO tasks(id, kind, title, status, budget, created, updated, parent) VALUES (?, ?, ?, 'waiting', '{}', ?, ?, NULL)",
  );
  task.run("card", "unattended", "the card", at, at);
  task.run("other", "unattended", "other", at, at);
  const appr = db.prepare(
    "INSERT INTO approvals(kind, category, task_id, summary, status, requested_at, payload) VALUES (?, 'c', ?, '{}', ?, ?, ?)",
  );
  appr.run("request", "card", "pending", at, JSON.stringify({ judge: "tainted: a stranger" }));
  appr.run("request", "card", "approved", at, null);
  appr.run("login", null, "pending", at, JSON.stringify({ waiting: ["card", "other"] })); // a shared login waits for both
  const pending = (id: string, list: { id: string; pending?: number }[]) => list.find((t) => t.id === id)?.pending;
  const list = (await call("task.list", {}, owner)) as { id: string; pending: number }[];
  assert.equal(pending("card", list), 2);
  assert.equal(pending("other", list), 1);

  const out = db.prepare("INSERT INTO outbox(task_id, seq, body, created) VALUES ('card', ?, ?, ?)");
  out.run(1, JSON.stringify({ seq: 1, type: "reply", text: "sent", ts: at }), at);
  // parses, and throws in the response's JSON.stringify: the card must stay readable
  out.run(2, `${"[".repeat(200_000)}${"]".repeat(200_000)}`, at);
  db.prepare(
    "INSERT INTO events(dof, key, author, trusted, task_id, refs, summary) VALUES ('slack', 'k1', 'U9', 0, 'card', ?, 'hi')",
  ).run(JSON.stringify(["slack:C7:1.2"]));
  const sched = db.prepare("INSERT INTO schedules(task_id, every_sec, text, script) VALUES ('card', 60, 'tick', 'x')");
  const { lastInsertRowid: sid } = sched.run();
  mkdirSync(paths.schedule(Number(sid)), { recursive: true });
  writeFileSync(join(paths.schedule(Number(sid)), "last-summary.md"), "ran fine");
  mkdirSync(paths.out("card"), { recursive: true });
  writeFileSync(join(paths.out("card"), "console.log"), `head${"x".repeat(70 * 1024)}tail`);

  interface Card {
    task: { pending: number };
    approvals: { kind: string; payload: { judge?: string } | null; grantable: boolean; task_title?: string }[];
    outbox: { seq: number; body: unknown }[];
    schedules: { title: string; summary: string; text: string }[];
    origin?: { dof: string; channel: string; author: string | null; summary: string };
    tainted: string[];
    console_log?: string;
  }
  const c = (await call("task.get", { id: "card" }, owner)) as Card;
  assert.ok(JSON.stringify(c));
  assert.equal(c.task.pending, 2);
  assert.deepEqual(
    c.outbox.map((m) => m.seq),
    [1, 2],
  );
  assert.deepEqual(c.outbox[0]?.body, { seq: 1, type: "reply", text: "sent", ts: at });
  assert.equal(typeof c.outbox[1]?.body, "string");
  // as the Approvals page gets them: a tainted request's card names it, and offers the grant
  assert.deepEqual(c.approvals[0]?.payload, { judge: "tainted: a stranger" });
  assert.equal(c.approvals[0]?.grantable, true);
  assert.equal(c.approvals[0]?.task_title, "the card");
  assert.equal(c.schedules[0]?.title, "the card");
  assert.equal(c.schedules[0]?.summary, "ran fine");
  assert.deepEqual(c.origin, { dof: "slack", channel: "C7", author: "U9", summary: "hi" });
  assert.deepEqual(c.tainted, taintOf(db, "card", ctx.config));
  assert.match(c.tainted[0] ?? "", /read untrusted messages \(slack:U9\)/);
  assert.equal(c.console_log?.length, 64 * 1024); // the tail
  assert.ok(c.console_log?.endsWith("tail"));

  // a Worker's link at console.log is not followed; no event, no origin; a chat has no console
  writeFileSync(join(paths.home(), "outside.log"), "SECRET");
  rmSync(join(paths.out("card"), "console.log"));
  symlinkSync(join(paths.home(), "outside.log"), join(paths.out("card"), "console.log"));
  const linked = (await call("task.get", { id: "card" }, owner)) as Card;
  assert.equal(linked.console_log, undefined);
  assert.equal(((await call("task.get", { id: "other" }, owner)) as Card).origin, undefined);
  assert.equal(((await call("task.get", { id: "other" }, owner)) as Card).tainted.length, 0);
  await assert.rejects(call("task.get", { id: "card" }, worker), /not allowed/);
});

test("dof.file: the page's checks; a link, .., an escape, a bare repo all refused; for the owner alone", async () => {
  const owner = { role: "owner" } as const;
  const dir = "C2/1700000000.0002#t";
  const thread = join(paths.dof("slack"), dir);
  mkdirSync(thread, { recursive: true });
  writeFileSync(join(thread, "a.md"), "first");
  writeFileSync(join(thread, "b.md"), "second");
  const secret = join(paths.home(), "outside.md");
  writeFileSync(secret, "SECRET");
  symlinkSync(secret, join(thread, "link.md"));
  symlinkSync(join(thread, "a.md"), join(thread, "inner.md"));
  symlinkSync(paths.home(), join(paths.dof("slack"), "up")); // a directory link out of the root
  assert.deepEqual(await call("dof.file", { dof: "slack", path: `${dir}/a.md` }, owner), {
    text: "first",
    size: 5,
    siblings: ["a.md", "b.md"],
  });
  mkdirSync(paths.dofRepo("planted2"), { recursive: true });
  writeFileSync(join(paths.dofRepo("planted2"), "config"), "[core]");
  for (const [dof, path, why] of [
    ["slack", `${dir}/link.md`, /not a regular file|outside the DOF/],
    ["slack", `${dir}/inner.md`, /not a regular file/],
    ["slack", "../../outside.md", /bad path/],
    ["slack", `${dir}/../../../outside.md`, /bad path/],
    ["slack", "up/outside.md", /outside the DOF/],
    ["slack", "", /bad path/],
    ["slack", `${dir}/nul\0.md`, /bad path/],
    ["..", "outside.md", /bad path/],
    ["../..", "outside.md", /bad path/],
    [".", "outside.md", /bad path/],
    ["planted2.git", "config", /no DOF/],
    ["slack", dir, /not a regular file/],
    ["slack", `${dir}/nope.md`, /no file/],
  ] as [string, string, RegExp][])
    await assert.rejects(call("dof.file", { dof, path }, owner), why, `${dof} ${path}`);
  await assert.rejects(call("dof.file", { dof: "slack", path: `${dir}/a.md` }, worker), /not allowed/);
  assert.equal((await post("dof.file", { dof: "slack", path: "../x" })).status, 404);

  // a file over the cap comes cut; a thread of thousands lists the first of them
  writeFileSync(join(thread, "big.md"), "x".repeat(2 * 1024 * 1024));
  const big = (await call("dof.file", { dof: "slack", path: `${dir}/big.md` }, owner)) as {
    text: string;
    size: number;
  };
  assert.equal(big.text.length, 1024 * 1024);
  assert.equal(big.size, 2 * 1024 * 1024);
  const crowd = join(paths.dof("slack"), "crowd");
  mkdirSync(crowd);
  for (let i = 0; i < 1100; i++) writeFileSync(join(crowd, `${i}.md`), "");
  const many = (await call("dof.file", { dof: "slack", path: "crowd/0.md" }, owner)) as { siblings: string[] };
  assert.equal(many.siblings.length, 1000);
});

test("/events/settings: named like the others, alone or on a page's one stream; settings.set emits it", async () => {
  const alone = stream("/events/settings", {}, (t) => t.includes("event: settings"));
  const page = stream("/events/tasks,approvals,settings,chat?task=x", {}, (t) => t.includes("event: settings"));
  await sleep(30);
  await post("settings.set", { config: ctx.config });
  assert.match(await alone, /event: settings\ndata: null/);
  assert.match(await page, /event: settings\ndata: null/);
  await sleep(50);
  assert.equal(bus.listenerCount("settings"), 0);
  assert.equal((await get("/events/settings,nope")).status, 404);
});

test("/dof/<dof>/<path>: a mirror file escaped with its thread; refuses .., links and leaving the root", async () => {
  const thread = join(paths.dof("slack"), "C1", "1700000000.0001#t");
  mkdirSync(thread, { recursive: true });
  writeFileSync(join(thread, "a.md"), "---\nauthor: u1\n---\n<script>alert(1)</script>\n");
  writeFileSync(join(thread, "b.md"), "second");
  writeFileSync(join(paths.home(), "outside.md"), "SECRET");
  symlinkSync(join(paths.home(), "outside.md"), join(thread, "link.md"));
  symlinkSync(join(thread, "a.md"), join(thread, "inner.md"));
  const base = `/dof/slack/C1/${encodeURIComponent("1700000000.0001#t")}`;
  const r = await get(`${base}/a.md`);
  assert.equal(r.status, 200);
  clean(base, r.body);
  assert.match(r.body, /author: u1\n---\n&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(r.body, /href="\/dof\/slack\/C1\/1700000000\.0001%23t\/b\.md">b\.md</);
  for (const bad of [
    `${base}/link.md`,
    `${base}/inner.md`,
    "/dof/slack/..%2F..%2Foutside.md",
    "/dof/..%2Foutside.md/x",
  ]) {
    const b = await get(bad);
    assert.ok(!b.body.includes("SECRET") && !b.body.includes("alert(1)"), bad);
    assert.match(b.body, /<h1>Not found<\/h1>/, bad);
  }
  // the bare repo next to the worktree is no DOF; an attachment is named, not dumped
  mkdirSync(paths.dofRepo("planted"), { recursive: true });
  writeFileSync(join(paths.dofRepo("planted"), "config"), "[core]");
  assert.match((await get("/dof/planted.git/config")).body, /<h1>Not found<\/h1>/);
  writeFileSync(join(thread, "f.png"), Buffer.from([0x89, 0x50, 0, 1, 2]));
  assert.match((await get(`${base}/f.png`)).body, /binary file, 5 bytes/);
});

test("UI: a task's error on the list and card (a boot timeout's reason, not the serial tail), pause, sources", async () => {
  const now = new Date().toISOString();
  const boot = "boot timeout: no contact from the guest within 120 s (console.log below)\n[ 1.2] virtiofs: mounting";
  const ins = ctx.db.prepare(
    "INSERT INTO tasks(id, kind, title, status, error, created, updated) VALUES (?, 'task', ?, 'waiting', ?, ?, ?)",
  );
  ins.run("r6boot", "r6 boot", boot, now, now);
  ins.run("r6crash", "r6 crash", "line one\nexit 1: the last words", now, now);
  const list = (await get("/")).body;
  assert.match(list, /r6 boot<\/a><br><span class="error">boot timeout: no contact/);
  assert.match(list, /r6 crash<\/a><br><span class="error">exit 1: the last words</);
  assert.match((await get("/tasks/r6boot")).body, /<div class="r error">boot timeout: no contact[^<]*<details>/);
  writeFileSync(paths.paused(), "");
  assert.match((await get("/")).body, /Paused: queued tasks, schedules and the Planner wait; running tasks go on\./);
  rmSync(paths.paused());
  assert.match((await get("/settings")).body, /While paused, queued tasks, schedules and the Planner wait/);
  assert.match((await get("/sources")).body, /no sources: add a messenger or forge under <code>dofs<\/code>/);
  // a fresh install's Slack said only "auth.test: HTTP 403"; the page names the missing credentials
  ctx.config = { ...ctx.config, dofs: { chat: { type: "slack", owner: "U1" } } } as typeof ctx.config;
  try {
    assert.match((await get("/sources")).body, /no chat or chat-app credential \(Credentials\)/);
  } finally {
    ctx.config = load();
  }
});

test("UI: a search hit's [mark] is a <mark>, other brackets stay", () => {
  assert.equal(
    String(hit("[inbox 1] from=owner [Hello] there", "hello")),
    "[inbox 1] from=owner <mark>Hello</mark> there",
  );
  assert.equal(String(hit("no marker <b>", "x")), "no marker &lt;b&gt;");
});
