/**
 * app.js in a headless Chromium (06-console.md › UI/UX, keyboard and feedback): an action is busy while in flight (a
 * second click sends nothing), Esc disarms a confirm, a re-render keeps keyboard focus, phone-width cells carry their
 * column name, the chat shows its stream's connection state. Skipped without Chromium.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { type Browser, type Cdp, CHROMIUM, connect, launch, page } from "../browser/cdp.ts";
import { load } from "../config.ts";
import type { Ctx } from "../ctx.ts";
import { openDb } from "../db.ts";
import { logger } from "../log.ts";
import * as paths from "../paths.ts";
import { define } from "../rpc.ts";
import { tempDir } from "../test/until.ts";
import { RpcError } from "../types.ts";
import { bus } from "./events.ts";
import { consoleModule } from "./index.ts";
import { approvalEntry } from "./pages/approvals.ts";

const skip = !existsSync(CHROMIUM) && `no ${CHROMIUM}`;
const home = tempDir("hortus-app-");
process.env.HORTUS_HOME = home;
process.env.HORTUS_CONSOLE_PORT = "0";
const ctx: Ctx = { config: load(), db: openDb(paths.db()), paths, log: logger, async reload() {} };
const closes: string[] = [];
define("task.close", {
  roles: ["owner"],
  input: z.object({ id: z.string(), outcome: z.string() }),
  async run({ id }) {
    closes.push(id);
    await sleep(400);
    return { ok: true };
  },
});

let browser: Browser;
let cdp: Cdp;
let session: string;
let base = "";
const ev = async <T>(expression: string): Promise<T> => {
  const r = await cdp.send<{ result: { value: T }; exceptionDetails?: unknown }>(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    session,
  );
  assert.equal(r.exceptionDetails, undefined, expression);
  return r.result.value;
};
const until = async (expression: string, ms = 5000) => {
  for (let t = 0; t < ms; t += 50) {
    if (await ev(expression)) return;
    await sleep(50);
  }
  assert.fail(`timed out: ${expression}`);
};
const go = async (path: string) => {
  await cdp.send("Page.navigate", { url: base + path }, session);
  await until("document.readyState === 'complete' && !!document.querySelector('#msg')");
};
const key = async (key: string, code: number) => {
  await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, windowsVirtualKeyCode: code }, session);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, windowsVirtualKeyCode: code }, session);
};

before(async () => {
  if (skip) return;
  const now = new Date().toISOString();
  ctx.db
    .prepare(
      "INSERT INTO tasks(id, kind, title, status, created, updated) VALUES ('t1', 'chat', 'one', 'waiting', ?, ?)",
    )
    .run(now, now);
  await consoleModule.start(ctx);
  base = `http://127.0.0.1:${consoleModule.port()}`;
  browser = await launch({ userDataDir: join(home, "chromium") });
  cdp = await connect(browser);
  session = await page(cdp);
  await cdp.send("Page.enable", {}, session);
});
after(async () => {
  if (skip) return;
  cdp.close();
  await browser.close();
  await consoleModule.stop();
});

test("an action is busy while in flight; Esc disarms a confirm; focus survives the re-render", { skip }, async () => {
  await go("/");
  const close = `document.querySelector('button[data-call="task.close"]')`;
  // Esc cancels the armed confirm
  await ev(`${close}.focus(), ${close}.click()`);
  assert.equal(await ev(`${close}.textContent`), "Confirm: Close");
  await key("Escape", 27);
  assert.equal(await ev(`${close}.textContent`), "Close");
  // armed, confirmed, then clicked again while in flight: one call
  await ev(`${close}.click(), ${close}.click()`);
  assert.equal(await ev(`${close}.getAttribute("aria-disabled")`), "true");
  await ev(`${close}.click(), ${close}.click()`);
  await until(`document.querySelector('#msg').textContent === "done"`);
  assert.deepEqual(closes, ["t1"]);
  // the list was re-rendered (a new button): focus is on its twin, not lost to <body>
  await sleep(200);
  assert.equal(await ev(`document.activeElement.dataset.call`), "task.close");
  assert.equal(await ev(`${close}.hasAttribute("aria-disabled")`), false);
});

// decided elsewhere (another tab, the CLI, the phone) while this page's stream was down
define("approval.decide", {
  roles: ["owner"],
  input: z.object({ id: z.number() }),
  run({ id }) {
    ctx.db.prepare("UPDATE approvals SET status = 'approved', decided_by = 'owner' WHERE id = ?").run(id);
    throw new RpcError("invalid", "already decided");
  },
});

test("a stale page: Approve on an entry decided elsewhere says so and shows the decision", { skip }, async () => {
  const r = ctx.db
    .prepare(
      "INSERT INTO approvals(kind, category, hash, task_id, summary, status, requested_at, payload) VALUES ('request', 'credential:x', 'stale', 't1', '{}', 'pending', ?, '{}')",
    )
    .run(new Date().toISOString());
  await go(`/approvals/${r.lastInsertRowid}`);
  await ev(`document.querySelector('button[data-call="approval.decide"]').click()`);
  await until(`document.querySelector('#msg').textContent === "already decided"`);
  await until(`document.querySelector('#list .decided')?.textContent.startsWith("approved by owner")`);
  assert.equal(await ev(`document.querySelectorAll('#list button[data-call="approval.decide"]').length`), 0);
});

test("a decided merge entry folds its patch excerpt; a pending one shows it", () => {
  const row = (status: string) => ({
    id: 1,
    kind: "merge",
    category: "merge",
    task_id: "t1",
    summary: JSON.stringify({ project: "p", patch: "+x", files: 1 }),
    status,
    requested_at: null,
    decided_at: null,
    decided_by: null,
    reason: null,
  });
  assert.match(approvalEntry(row("replaced")).html, /<details><summary>the change<\/summary><p class="req">/);
  assert.doesNotMatch(approvalEntry(row("pending")).html, /the change/);
});

test("200 approvals in a burst: the open Approvals page re-renders a few times, not 200", { skip }, async () => {
  await go("/approvals");
  await sleep(300); // the stream is open
  const fetches = `performance.getEntriesByType("resource").filter((e) => new URL(e.name).pathname === "/approvals").length`;
  const before = await ev<number>(fetches);
  const ins = ctx.db.prepare(
    "INSERT INTO approvals(kind, category, hash, task_id, summary, status, requested_at, payload) VALUES ('request', 'credential:x', ?, 't1', ?, 'pending', ?, '{}')",
  );
  for (let i = 0; i < 200; i++) {
    const r = ins.run(
      `h${i}`,
      JSON.stringify({ method: "POST", host: "api.example", path: `/p/${i}` }),
      new Date().toISOString(),
    );
    bus.emit("approvals", { id: Number(r.lastInsertRowid), task: "t1" }); // as gate.check does
  }
  // the page shows the newest 50 and says how many there are
  await until(`document.querySelector('#list .more')?.textContent.includes("of 200 pending")`, 15_000);
  assert.equal(await ev(`document.querySelectorAll('[data-call="approval.decide"]').length`), 100);
  await sleep(500);
  const n = (await ev<number>(fetches)) - before;
  const t0 = performance.now();
  const page = await (await fetch(`${base}/approvals`)).text();
  const ms = performance.now() - t0;
  console.log(
    `# load approvals: 200 pending, page ${(page.length / 1024).toFixed(0)} KB in ${ms.toFixed(0)} ms; ${n} re-fetches`,
  );
  assert.ok(n <= 3, `${n} page re-fetches for one burst`);
  assert.ok(ms < 500, `${ms} ms`);
});

test("a schedule's next fire stays relative (09-schedules.md › UI/UX); a date never wraps at 390 px", {
  skip,
}, async () => {
  const now = Date.now();
  ctx.db
    .prepare(
      "INSERT INTO schedules(task_id, fire_at, every_sec, text, last_run, created) VALUES ('t1', ?, 3600, 'x', ?, ?)",
    )
    .run(new Date(now + 3600e3).toISOString(), new Date(now).toISOString(), new Date(now).toISOString());
  await cdp.send(
    "Emulation.setDeviceMetricsOverride",
    { width: 390, height: 800, deviceScaleFactor: 1, mobile: true },
    session,
  );
  try {
    await go("/schedules");
    assert.match(await ev<string>(`document.querySelector('time[data-rel]').textContent`), /^in (59|60) min$/);
    assert.equal(
      await ev(`[...document.querySelectorAll('time')].every((t) => t.getClientRects().length === 1)`),
      true,
    );
  } finally {
    await cdp.send("Emulation.clearDeviceMetricsOverride", {}, session);
  }
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
  const inTab = async <T>(tab: string, expression: string) =>
    (
      await cdp.send<{ result: { value: T } }>(
        "Runtime.evaluate",
        { expression, awaitPromise: true, returnByValue: true },
        tab,
      )
    ).result.value;
  const answers = `Promise.race([fetch("/static/app.css").then((r) => r.ok), new Promise((r) => setTimeout(() => r(false), 3000))])`;
  const hide = (hidden: boolean) =>
    `Object.defineProperty(document, "hidden", { configurable: true, value: ${hidden} }); document.dispatchEvent(new Event("visibilitychange")); 1`;
  try {
    await go("/chat/t1");
    const second = await open("/chat/t1");
    await open("/tasks/t1");
    await sleep(500);
    assert.equal(await ev(answers), true, "two chats and a task card: a page's fetch still answers");
    // more tabs than connections: the hidden ones hold none, and one coming back catches up from its cursor
    for (const p of ["/approvals", "/", "/tasks/t1", "/approvals", "/"]) {
      const t = await open(p);
      await sleep(100);
      await inTab(t, hide(true));
    }
    await inTab(second, hide(true));
    await sleep(500);
    assert.equal(await ev(answers), true, "eight tabs, six of them hidden");
    const seq = (ctx.db.prepare("SELECT COUNT(*) AS n FROM replies WHERE task_id = 't1'").get() as { n: number }).n + 1;
    ctx.db
      .prepare("INSERT INTO replies(task_id, seq, body, created) VALUES ('t1', ?, ?, '')")
      .run(seq, JSON.stringify({ type: "text", text: "while hidden" }));
    await inTab(second, hide(false));
    for (
      let i = 0;
      i < 100 && !(await inTab(second, `document.querySelector("#stream").textContent.includes("while hidden")`));
      i++
    )
      await sleep(50);
    assert.equal(await inTab(second, `document.querySelector("#stream").textContent.includes("while hidden")`), true);
  } finally {
    for (const t of tabs) await cdp.send("Target.closeTarget", { targetId: t.targetId });
  }
});

test("a stream the server ended for good (a remote session's 401) reloads the page", { skip }, async () => {
  await go("/chat/t1");
  await until(`document.querySelector('#conn').textContent === ""`);
  await ev(`window.stale = 1; es.close(); es.dispatchEvent(new Event("error")); 1`);
  await until(`document.readyState === "complete" && window.stale === undefined`);
});

test("cells carry their column name; the chat shows its stream's state", { skip }, async () => {
  await go("/");
  assert.equal(await ev(`document.querySelector('#list tbody td').dataset.label`), "Status");
  await go("/chat/t1");
  await until(`document.querySelector('#conn').textContent === ""`);
  await consoleModule.stop();
  await until(`document.querySelector('#conn').textContent === "reconnecting…"`);
});
