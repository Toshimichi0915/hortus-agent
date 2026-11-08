/**
 * The web UI (dist/web) in a headless Chromium against the console on a seeded database: every page renders with
 * hostile text in every field and nothing of it runs, no page falls to the page guard, the CSP refuses nothing, a
 * phone's width scrolls no page sideways; an approvals burst is a few fetches, not one each; a stale Approve says so;
 * a typed credential survives a refresh; open tabs never starve a fetch. Skipped without Chromium.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { type Browser, type Cdp, CHROMIUM, connect, launch, page } from "../browser/cdp.ts";
import { load } from "../config.ts";
import type { Ctx } from "../ctx.ts";
import { openDb } from "../db.ts";
import { logger } from "../log.ts";
import * as paths from "../paths.ts";
import { schedulesModule } from "../schedules/schedules.ts";
import { tempDir } from "../test/until.ts";
import "../vault/index.ts"; // approval.*, credential.list, transforms.list, merge.diff
import { bind } from "../vault/vault.ts";
import { bus } from "./events.ts";
import { consoleModule } from "./index.ts";

const skip = !existsSync(CHROMIUM) && `no ${CHROMIUM}`;
const home = tempDir("hortus-app-");
process.env.HORTUS_HOME = home;
process.env.HORTUS_CONSOLE_PORT = "0";
const ctx: Ctx = { config: load(), db: openDb(paths.db()), paths, log: logger, async reload() {} };

/** Each would set `window.pwned` if it ran as markup. */
const XSS = `<img src=x onerror="window.pwned=1"><script>window.pwned=1</script>"'&`;
const THREAD = "C1/1700000000.0001#t";

let browser: Browser;
let cdp: Cdp;
let session: string;
let base = "";
const problems: string[] = [];
const ids: Record<string, number> = {};

const ev = async <T>(expression: string, s = session): Promise<T> => {
  const r = await cdp.send<{ result: { value: T }; exceptionDetails?: unknown }>(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    s,
  );
  assert.equal(r.exceptionDetails, undefined, expression);
  return r.result.value;
};
const until = async (expression: string, ms = 5000) => {
  for (let t = 0; t < ms; t += 50) {
    if (await ev(expression).catch(() => false)) return;
    await sleep(50);
  }
  assert.fail(`timed out: ${expression}: ${await ev("document.body.innerText")}`);
};
const go = async (path: string) => {
  await cdp.send("Page.navigate", { url: base + path }, session);
  await until(`document.readyState === "complete" && !!document.querySelector("#main")`);
};
const button = (text: string) =>
  `[...document.querySelectorAll("button")].find((b) => b.textContent.includes(${JSON.stringify(text)}))`;

before(async () => {
  if (skip) return;
  const db = ctx.db;
  const now = new Date().toISOString();
  const task = db.prepare(
    `INSERT INTO tasks(id, kind, title, status, project, budget, usage, summary, brief, error, created, updated)
     VALUES (?, ?, ?, ?, 'p', '{"usd":1000,"hours":4}', '{"tokens":1200000}', ?, ?, ?, ?, ?)`,
  );
  task.run("t1", "chat", XSS, "waiting", XSS, XSS, null, now, now);
  task.run("t2", "unattended", XSS, "waiting", XSS, XSS, `boot timeout: ${XSS}\n${XSS}`, now, now);
  task.run("t3", "unattended", XSS, "done", XSS, XSS, null, now, now);
  const reply = db.prepare("INSERT INTO replies(task_id, seq, body, created) VALUES ('t1', ?, ?, ?)");
  for (const [i, b] of [
    { type: "owner", text: XSS },
    { type: "text", text: `# ${XSS}\n\n[link](javascript:window.pwned=1) ${XSS}` },
    { type: "thinking", text: XSS },
    { type: "tool_call", id: "c1", name: "bash", input: { command: XSS } },
    { type: "tool_result", id: "c1", output: XSS, isError: true },
    { type: "error", message: XSS },
    { type: "status", text: XSS },
  ].entries())
    reply.run(i + 1, JSON.stringify(b), now);
  reply.run(8, "not json <b>", now);
  for (const box of ["inbox", "outbox"])
    db.prepare(`INSERT INTO ${box}(task_id, seq, body, created) VALUES ('t2', 1, ?, ?)`).run(
      JSON.stringify({ from: "owner", type: "reply", text: XSS }),
      now,
    );
  db.prepare(
    "INSERT INTO events(dof, key, author, trusted, task_id, refs, summary) VALUES ('slack', 'k', ?, 0, 't2', ?, ?)",
  ).run(XSS, JSON.stringify([`slack:${XSS}:1`]), XSS);
  const sid = Number(
    db
      .prepare(
        "INSERT INTO schedules(task_id, fire_at, every_sec, text, last_run, created) VALUES ('t2', ?, 3600, ?, ?, ?)",
      )
      .run(new Date(Date.now() + 3600e3).toISOString(), XSS, now, now).lastInsertRowid,
  );
  mkdirSync(paths.schedule(sid), { recursive: true });
  writeFileSync(join(paths.schedule(sid), "last-summary.md"), `## ${XSS}\n${XSS}`);
  const ap = db.prepare(
    "INSERT INTO approvals(kind, category, hash, task_id, summary, status, requested_at, payload, decided_by, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const add = (name: string, ...v: unknown[]) => {
    ids[name] = Number(ap.run(...(v as string[])).lastInsertRowid);
  };
  const req = { method: "POST", host: XSS, path: `/${XSS}`, headers: { [XSS]: XSS }, bodyPreview: XSS };
  add(
    "request",
    "request",
    `credential:${XSS}`,
    "h1",
    "t2",
    JSON.stringify(req),
    "pending",
    now,
    JSON.stringify({ judge: XSS, untrusted: [XSS] }),
    null,
    null,
  );
  const patch = Array.from({ length: 60 }, (_, i) => `+${XSS} ${i}`).join("\n");
  add(
    "merge",
    "request",
    "merge",
    "h2",
    "t2",
    JSON.stringify({
      project: XSS,
      branch: XSS,
      main_sha: XSS,
      sha: XSS,
      patch,
      files: 1,
      added: 60,
      removed: 0,
      stat: XSS,
      truncated: true,
    }),
    "pending",
    now,
    null,
    null,
    null,
  );
  add(
    "transforms",
    "request",
    "transforms",
    "h3",
    null,
    JSON.stringify({ name: "n", new: true, manifest: XSS, missing: [{ name: "n", type: "token" }] }),
    "pending",
    now,
    null,
    null,
    null,
  );
  add(
    "login",
    "login",
    "login",
    "h4",
    "t2",
    JSON.stringify({ origin: XSS, url: XSS, why: XSS }),
    "rejected",
    now,
    null,
    "owner",
    XSS,
  );
  add("judged", "request", "credential:x", "h5", "t2", JSON.stringify(req), "allowed", now, null, "judge", XSS);
  const thread = join(paths.dof("slack"), THREAD);
  mkdirSync(thread, { recursive: true });
  writeFileSync(join(thread, "a.md"), `---\nauthor: ${XSS}\n---\n${XSS}\n`);
  writeFileSync(join(thread, `${XSS.replace(/[/\\]/g, "")}.md`), XSS);

  bind(ctx);
  await schedulesModule.start(ctx);
  await consoleModule.start(ctx);
  base = `http://127.0.0.1:${consoleModule.port()}`;
  browser = await launch({ userDataDir: join(home, "chromium") });
  cdp = await connect(browser);
  session = await page(cdp);
  for (const m of ["Page.enable", "Runtime.enable", "Log.enable"]) await cdp.send(m, {}, session);
  // a page that broke: an uncaught error, a console.error, the CSP refusing something (a failed RPC is the network's)
  cdp.on("Runtime.exceptionThrown", (p) => problems.push(JSON.stringify(p.exceptionDetails)));
  cdp.on("Runtime.consoleAPICalled", (p) => {
    if (p.type === "error") problems.push(JSON.stringify(p.args));
  });
  cdp.on("Log.entryAdded", (p) => {
    const e = p.entry as { level: string; source: string; text: string };
    if (e.level === "error" && e.source !== "network") problems.push(`${e.source}: ${e.text}`);
  });
});
after(async () => {
  if (skip) return;
  cdp.close();
  await browser.close();
  await consoleModule.stop();
  await schedulesModule.stop();
});

const ROUTES = () => [
  "/",
  "/chat/t1",
  "/chat/none",
  "/approvals",
  `/approvals/${ids.request}`,
  `/approvals/${ids.merge}`,
  `/approvals/${ids.transforms}`,
  `/approvals/${ids.judged}`,
  `/approvals/${ids.login}/login`,
  "/approvals/9999",
  "/tasks",
  "/tasks/t1",
  "/tasks/t2",
  "/tasks/t3",
  "/tasks/none",
  "/schedules",
  "/search",
  `/search?q=${encodeURIComponent(XSS)}`,
  `/dof/slack/C1/${encodeURIComponent("1700000000.0001#t")}/a.md`,
  "/dof/slack/..%2F..%2Fhortusd.json",
  ...[
    "general",
    "planner",
    "workers",
    "approvals",
    "sources",
    "projects",
    "credentials",
    "sandbox",
    "network",
    "vms",
    "remote",
    "advanced",
  ].map((s) => `/settings/${s}`),
  // the old console's addresses, moved
  "/chat",
  "/settings",
  "/credentials",
  "/nowhere",
];

test("every page, hostile text everywhere: it renders, nothing runs, no guard, no CSP error, no sideways scroll at 390 px", {
  skip,
}, async () => {
  for (const width of [1280, 390]) {
    await cdp.send(
      "Emulation.setDeviceMetricsOverride",
      { width, height: 844, deviceScaleFactor: 1, mobile: width < 500 },
      session,
    );
    for (const path of ROUTES()) {
      problems.length = 0;
      await go(path);
      await sleep(400); // its calls answered and rendered
      const [guard, pwned, imgs, wide, inner] = await ev<[boolean, string, number, number, number]>(
        `[document.body.innerText.includes("This page could not be shown"), typeof window.pwned, document.querySelectorAll('img[src="x"], script:not([src])').length, document.documentElement.scrollWidth, innerWidth]`,
      );
      assert.deepEqual([path, width, guard, pwned, imgs, problems], [path, width, false, "undefined", 0, []]);
      assert.ok(wide <= inner, `${path} at ${width}: ${wide} px wide`);
    }
  }
  await cdp.send("Emulation.clearDeviceMetricsOverride", {}, session);
  // and the text shows as text
  await go("/chat/t1");
  await until(`document.body.innerText.includes('onerror="window.pwned=1"')`);
  await go(`/approvals/${ids.request}`);
  await until(`document.body.innerText.includes('onerror="window.pwned=1"')`);
});

test("a typed credential and the page around it survive a refresh of its list", { skip }, async () => {
  await go("/approvals");
  const field = `document.querySelector('[aria-labelledby="ap${ids.transforms}"] input[type=password]')`;
  await until(`!!${field}`);
  await ev(`${field}.focus()`);
  await cdp.send("Input.insertText", { text: "sk-typed" }, session);
  await ev(`${field}.dataset.mark = "1"`);
  bus.emit("approvals", {});
  await sleep(500);
  assert.equal(await ev(`${field}.value`), "sk-typed");
  assert.equal(await ev(`${field}.dataset.mark`), "1", "the same element: React kept it");
});

test("a stale page: Approve on an entry decided elsewhere says so and shows the decision", { skip }, async () => {
  const id = ids.request as number;
  await go(`/approvals/${id}`);
  await until(`!!${button("Approve")}`);
  // decided in another tab, the CLI, the phone, while this page's stream was down: no event
  ctx.db.prepare("UPDATE approvals SET status = 'approved', decided_by = 'owner' WHERE id = ?").run(id);
  await ev(`${button("Approve")}.click()`);
  await until(`document.body.innerText.includes("This was already decided")`);
  await until(`document.body.innerText.includes("Approved by you")`);
  assert.equal(await ev(`!!${button("Approve")}`), false);
});

test("200 approvals in a burst: the open Approvals page fetches a few times, not 200", { skip }, async () => {
  await go("/approvals");
  await sleep(500); // its stream is open
  const fetches = `performance.getEntriesByType("resource").filter((e) => new URL(e.name).pathname === "/api/approval.list").length`;
  const before = await ev<number>(fetches);
  const ins = ctx.db.prepare(
    "INSERT INTO approvals(kind, category, hash, task_id, summary, status, requested_at, payload) VALUES ('request', 'credential:x', ?, 't1', ?, 'pending', ?, '{}')",
  );
  for (let i = 0; i < 200; i++) {
    const r = ins.run(
      `b${i}`,
      JSON.stringify({ method: "POST", host: "api.example", path: `/p/${i}` }),
      new Date().toISOString(),
    );
    bus.emit("approvals", { id: Number(r.lastInsertRowid), task: "t1" }); // as gate.check does
  }
  await sleep(1500);
  const n = (await ev<number>(fetches)) - before;
  console.log(`# approvals burst: 200 events, ${n} approval.list fetches`);
  assert.ok(n >= 1 && n <= 3, `${n} fetches for one burst`);
});

test("open tabs never starve a fetch: one stream a page, none while hidden (HTTP/1.1: 6 connections an origin)", {
  skip,
}, async () => {
  const tabs: { targetId: string; session: string }[] = [];
  const open = async (path: string) => {
    const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: base + path });
    const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    tabs.push({ targetId, session: sessionId });
    return sessionId;
  };
  const answers = `Promise.race([fetch("/api/pause.get", { method: "POST", headers: { "content-type": "application/json", "x-hortus": "1" }, body: "{}" }).then((r) => r.ok), new Promise((r) => setTimeout(() => r(false), 3000))])`;
  const hide = (hidden: boolean) =>
    `Object.defineProperty(document, "hidden", { configurable: true, value: ${hidden} }); Object.defineProperty(document, "visibilityState", { configurable: true, value: ${JSON.stringify(hidden ? "hidden" : "visible")} }); document.dispatchEvent(new Event("visibilitychange")); 1`;
  try {
    await go("/chat/t1");
    const second = await open("/chat/t1");
    await open("/tasks/t1");
    await sleep(800);
    assert.equal(await ev(answers), true, "two chats and a task page: a page's fetch still answers");
    // more tabs than connections: the hidden ones hold none, and one coming back catches up from its cursor
    for (const p of ["/approvals", "/", "/tasks/t2", "/approvals", "/"]) {
      const t = await open(p);
      await sleep(300);
      await ev(hide(true), t);
    }
    await ev(hide(true), second);
    await sleep(800);
    assert.equal(await ev(answers), true, "eight tabs, six of them hidden");
    const seq = (ctx.db.prepare("SELECT max(seq) AS n FROM replies WHERE task_id = 't1'").get() as { n: number }).n + 1;
    ctx.db
      .prepare("INSERT INTO replies(task_id, seq, body, created) VALUES ('t1', ?, ?, ?)")
      .run(seq, JSON.stringify({ type: "text", text: "while hidden" }), new Date().toISOString());
    bus.emit("chat:t1");
    await ev(hide(false), second);
    for (let i = 0; i < 100 && !(await ev(`document.body.innerText.includes("while hidden")`, second)); i++)
      await sleep(50);
    assert.equal(await ev(`document.body.innerText.includes("while hidden")`, second), true);
  } finally {
    for (const t of tabs) await cdp.send("Target.closeTarget", { targetId: t.targetId });
  }
});

test("a chat past 1,000 rows: scrolling up loads the older ones and what the owner reads stays put", {
  skip,
}, async () => {
  const now = new Date().toISOString();
  ctx.db
    .prepare(
      `INSERT INTO tasks(id, kind, title, status, budget, created, updated) VALUES ('long', 'chat', 'l', 'waiting', '{"usd":1,"hours":1}', ?, ?)`,
    )
    .run(now, now);
  const ins = ctx.db.prepare("INSERT INTO replies(task_id, seq, body, created) VALUES ('long', ?, ?, ?)");
  const q = (seq: number) => `question ${String(seq).padStart(5, "0")}`;
  for (let seq = 1; seq <= 2500; seq++)
    ins.run(
      seq,
      JSON.stringify(seq % 50 === 1 ? { type: "owner", text: q(seq) } : { type: "text", text: `w${seq} ` }),
      now,
    );
  const has = (seq: number) => `document.body.innerText.includes(${JSON.stringify(q(seq))})`;
  const box = `document.querySelector('[aria-live="off"]').parentElement`;
  const top = (seq: number) =>
    `[...document.querySelectorAll("article")].find((a) => a.innerText.includes(${JSON.stringify(q(seq))})).getBoundingClientRect().top`;
  await go("/chat/long");
  await until(has(2451));
  await until(`${box}.scrollHeight - ${box}.scrollTop - ${box}.clientHeight < 80`);
  // opened at the newest: nothing older is fetched until the owner scrolls up
  await sleep(300);
  assert.equal(await ev(has(1451)), false);
  assert.equal(await ev(has(1501)), true);

  const before = await ev<number>(`(${box}.scrollTop = 0, ${top(1501)})`);
  await until(has(1451));
  assert.ok(Math.abs((await ev<number>(top(1501))) - before) < 2, "the page landed without moving what was on screen");
  assert.equal(await ev(has(1)), false);

  await ev(`${box}.scrollTop = 0`);
  await until(has(1));
  await until(`!document.body.innerText.includes("Loading earlier lines")`);
  assert.ok(await ev<boolean>(`${box}.scrollTop > 0`), "the second page kept the place too");
  ctx.db.exec("DELETE FROM tasks WHERE id = 'long'; DELETE FROM replies WHERE task_id = 'long'");
});
