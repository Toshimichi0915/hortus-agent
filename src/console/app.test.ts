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
import { type Browser, CHROMIUM, type Cdp, connect, launch, page } from "../browser/cdp.ts";
import { load } from "../config.ts";
import type { Ctx } from "../ctx.ts";
import { openDb } from "../db.ts";
import { logger } from "../log.ts";
import * as paths from "../paths.ts";
import { define } from "../rpc.ts";
import { tempDir } from "../test/until.ts";
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

test("cells carry their column name; the chat shows its stream's state", { skip }, async () => {
  await go("/");
  assert.equal(await ev(`document.querySelector('#list tbody td').dataset.label`), "Status");
  await go("/chat/t1");
  await until(`document.querySelector('#conn').textContent === ""`);
  await consoleModule.stop();
  await until(`document.querySelector('#conn').textContent === "reconnecting…"`);
});
