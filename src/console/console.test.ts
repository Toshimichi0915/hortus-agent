import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { load } from "../config.ts";
import type { Ctx } from "../ctx.ts";
import { openDb } from "../db.ts";
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

test("round 6 UI: a task's error on the list and card (a boot timeout's reason, not the serial tail), pause, sources", async () => {
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
  // round 7: a fresh install's Slack said only "auth.test: HTTP 403"; the page names the missing credentials
  ctx.config = { ...ctx.config, dofs: { chat: { type: "slack", owner: "U1" } } } as typeof ctx.config;
  try {
    assert.match((await get("/sources")).body, /no chat or chat-app credential \(Credentials\)/);
  } finally {
    ctx.config = load();
  }
});

test("round 6 UI: a search hit's [mark] is a <mark>, other brackets stay", () => {
  assert.equal(
    String(hit("[inbox 1] from=owner [Hello] there", "hello")),
    "[inbox 1] from=owner <mark>Hello</mark> there",
  );
  assert.equal(String(hit("no marker <b>", "x")), "no marker &lt;b&gt;");
});
