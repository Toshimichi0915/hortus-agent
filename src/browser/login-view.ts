/**
 * `browser.login` and the console's login view. A `login` entry's view is hortusd's own
 * headless Chromium, started when the owner opens the entry: in a cgroup `tasks/<task>-login` with a session address
 * (role `login`, the task's id) routed through the proxy, so what the site sets is captured like any browser's. The
 * page is streamed as `Page.startScreencast` JPEG frames over SSE; the owner's mouse and keys come back as
 * `login.input`. Done → the entry approved, `origin:<domain>` granted to the task, inbox `cookies`; Reject → rejected;
 * 15 min without input → the view closes and the entry stays pending (opening it again starts a new Chromium).
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { bus } from "../console/events.ts";
import type { Ctx, Module } from "../ctx.ts";
import { logger } from "../log.ts";
import * as paths from "../paths.ts";
import { links, listen, listenOpts, unlisten } from "../proxy/index.ts";
import { taskRow } from "../proxy/pipeline.ts";
import { define } from "../rpc.ts";
import * as cgroup from "../runtime/cgroup.ts";
import * as sessionNet from "../runtime/session-net.ts";
import { type Caller, RpcError } from "../types.ts";
import * as gate from "../vault/gate.ts";
import { type Browser, type Cdp, CHROMIUM, connect, launch, page } from "./cdp.ts";
import { origins as capturedOrigins, grantedOrigins, jar, loginCookies, registrable } from "./jar.ts";

const log = logger("login-view");

/** Tests shorten it. */
export const IDLE = { ms: 15 * 60_000 };

export interface Event {
  frame?: string;
  w?: number;
  h?: number;
  /** epoch ms at which the view closes unless the owner acts */
  until?: number;
  closed?: string;
  error?: string;
}

interface View {
  id: number;
  task: string;
  origin: string;
  browser: Browser;
  cdp: Cdp;
  session: string;
  last?: Event;
  until: number;
  timer?: NodeJS.Timeout;
  release(): Promise<void>;
}

let bound: Ctx | undefined;
const ctx = (): Ctx => {
  if (!bound) throw new RpcError("failed", "browser module not started");
  return bound;
};

const views = new Map<number, View>();
const opening = new Map<number, Promise<View>>();
const watchers = new Map<number, Set<(e: Event) => void>>();

const emit = (id: number, e: Event) => {
  for (const w of watchers.get(id) ?? []) w(e);
};

interface Entry {
  id: number;
  kind: string;
  task_id: string | null;
  status: string;
  summary: string;
}

function entry(id: number): Entry & { task: string; url: string; why: string; origin: string } {
  const r = ctx().db.prepare("SELECT id, kind, task_id, status, summary FROM approvals WHERE id = ?").get(id) as
    | Entry
    | undefined;
  if (r?.kind !== "login" || !r.task_id) throw new RpcError("not_found", `no login entry ${id}`);
  const s = JSON.parse(r.summary) as { url: string; why: string; origin: string };
  return { ...r, task: r.task_id, ...s };
}

// ---------------------------------------------------------------------------------------------------------------------
// the view's Chromium and network

/** A cgroup and a session address (role login, the task) on the host; a loopback alias with its own listeners under
 * HORTUS_NO_NET=1, where Chromium is pointed at it with `--host-resolver-rules` (no DNS or DNAT to do it). */
async function network(task: string): Promise<{ args: string[]; cmd?: string[]; release(): Promise<void> }> {
  const c = ctx();
  const key = `${task}-login`;
  if (process.env.HORTUS_NO_NET === "1") {
    const taken = new Set(
      (c.db.prepare("SELECT address FROM links").all() as { address: string }[]).map((r) => r.address),
    );
    let address: string | undefined;
    for (let n = 2; n <= 254 && !address; n++) if (!taken.has(`127.0.0.${n}`)) address = `127.0.0.${n}`;
    if (!address) throw new RpcError("failed", "no loopback alias free");
    const a = address;
    links.register(a, "login", task, "login");
    const p = await listen(a, { ...listenOpts(c), https: 0, http: 0, dns: 0 });
    return {
      args: [`--host-resolver-rules=MAP *:443 ${a}:${p.https}, MAP *:80 ${a}:${p.http}`],
      release: async () => {
        await unlisten(a);
        links.release(a);
      },
    };
  }
  const cg = await cgroup.create(key);
  let address: string | null;
  try {
    address = await sessionNet.open(key, "login", cg, c.config.chat.allow);
    // the rules and listeners are keyed by `key`; the proxy must see the task itself
    if (address) links.register(address, "login", task, "login");
  } catch (e) {
    await cgroup.kill(key);
    throw e;
  }
  return {
    args: [],
    // join the cgroup before exec, so every Chromium process is in it from the start
    cmd: ["/bin/sh", "-c", 'echo $$ > "$1/cgroup.procs" && shift && exec "$@"', "sh", cg, CHROMIUM],
    release: async () => {
      await cgroup.kill(key);
      await sessionNet.close(key);
    },
  };
}

function touch(v: View): void {
  v.until = Date.now() + IDLE.ms;
  clearTimeout(v.timer);
  v.timer = setTimeout(() => void close(v.id, "idle").catch((e) => log.error("idle close failed", e)), IDLE.ms);
  v.timer.unref();
}

async function start(id: number): Promise<View> {
  const e = entry(id);
  if (e.status !== "pending") throw new RpcError("invalid", `login entry ${id} is ${e.status}`);
  // under the task's directory but outside out/: the Worker must not be able to plant a profile (extensions, prefs)
  const dir = join(paths.task(e.task), "login-chrome");
  rmSync(dir, { recursive: true, force: true });
  const net = await network(e.task);
  let browser: Browser | undefined;
  try {
    browser = await launch({
      userDataDir: dir,
      caCert: join(paths.ca(), "ca.crt"),
      args: net.args,
      ...(net.cmd ? { cmd: net.cmd } : {}),
    });
    const cdp = await connect(browser);
    const session = await page(cdp);
    const b = browser;
    const v: View = {
      id,
      task: e.task,
      origin: e.origin,
      browser: b,
      cdp,
      session,
      until: 0,
      release: async () => {
        cdp.close();
        await b.close();
        await net.release();
        rmSync(dir, { recursive: true, force: true });
      },
    };
    cdp.on("Page.screencastFrame", (p, sid) => {
      if (sid !== session) return;
      cdp.send("Page.screencastFrameAck", { sessionId: p.sessionId }, session).catch(() => {});
      const m = p.metadata as { deviceWidth: number; deviceHeight: number };
      v.last = { frame: String(p.data), w: Math.round(m.deviceWidth), h: Math.round(m.deviceHeight) };
      emit(id, { ...v.last, until: v.until });
    });
    // open before the first frame: the owner can click on what they see while a slow page is still navigating
    views.set(id, v);
    touch(v);
    // Chromium gone (crashed, OOM-killed): else a dead view stayed open, and each click kept it so
    void cdp.closed.then(() => (views.get(id) === v ? close(id, "the browser exited") : undefined));
    await cdp.send("Page.enable", {}, session);
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, everyNthFrame: 1 }, session);
    // not awaited: a stalled page held the start, so every close (Reject, a stop) with it, until the upstream's 10 min
    cdp.send("Page.navigate", { url: e.url }, session).catch(() => {});
    log.info("login view open", { id, task: e.task, origin: e.origin });
    return v;
  } catch (err) {
    clearTimeout(views.get(id)?.timer);
    views.delete(id);
    await browser?.close();
    await net.release().catch(() => {});
    throw err;
  }
}

/** The running view, starting it when there is none (two concurrent opens share one start). */
export async function open(id: number): Promise<View> {
  // starting first: a view is registered before its screencast and may yet fail, and a second tab must hear that
  let p = opening.get(id);
  if (p) return p;
  const v = views.get(id);
  if (v) return v;
  p = start(id).finally(() => opening.delete(id));
  opening.set(id, p);
  return p;
}

export async function close(id: number, reason: string): Promise<void> {
  const pending = opening.get(id);
  if (pending) await pending.catch(() => {});
  const v = views.get(id);
  if (!v) return;
  views.delete(id);
  clearTimeout(v.timer);
  await v.release().catch((e) => log.error("login view release failed", e, { id }));
  emit(id, { closed: reason });
  log.info("login view closed", { id, reason });
}

/** SSE subscriber: the last frame at once, then every frame; starts the view. Returns the unsubscribe function. */
export function watch(id: number, send: (e: Event) => void): () => void {
  const set = watchers.get(id) ?? new Set();
  watchers.set(id, set);
  set.add(send);
  open(id).then(
    (v) => send(v.last ? { ...v.last, until: v.until } : { until: v.until }),
    (e) => send({ error: e instanceof Error ? e.message : String(e) }),
  );
  return () => {
    set.delete(send);
    if (!set.size) watchers.delete(id);
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// cookies to the task

/** The task's jar for `origin` as an inbox `cookies` message (the Worker injects it before its next browser action). */
export function sendCookies(task: string, origin: string): number {
  const cookies = jar(ctx().db, task, origin);
  gate.deps.inboxWrite(task, {
    from: "cookies",
    trusted: true,
    text: `${cookies.length} cookie(s) for ${origin} are in your browser now (placeholders); navigate again.`,
    data: cookies,
  });
  return cookies.length;
}

function grant(task: string, origin: string, summary: unknown): void {
  const db = ctx().db;
  const category = `origin:${origin}`;
  if (grantedOrigins(db, task).includes(origin)) return;
  const t = new Date().toISOString();
  db.prepare(
    "INSERT INTO approvals(kind, category, hash, task_id, summary, status, requested_at, decided_at, decided_by) VALUES ('grant', ?, ?, ?, ?, 'approved', ?, ?, 'owner')",
  ).run(category, `grant:${category}`, task, JSON.stringify(summary), t, t);
}

// ---------------------------------------------------------------------------------------------------------------------
// RPCs

const Url = z
  .string()
  .max(2048)
  .refine((u) => /^https?:\/\//i.test(u) && URL.canParse(u), "an http(s) URL");

define("browser.login", {
  roles: ["worker"],
  input: z.object({ url: Url, why: z.string().min(1).max(2000) }),
  run({ url, why }, caller: Caller) {
    const task = caller.task;
    if (!task) throw new RpcError("forbidden", "browser.login needs a task");
    if (!taskRow(task)) throw new RpcError("not_found", `no task ${task}`);
    const host = new URL(url).hostname.toLowerCase();
    const allowed = ctx().config.origins;
    if (allowed !== "*" && !allowed.includes(host))
      throw new RpcError("forbidden", `host not in origins: ${host} (final: tell the owner with send)`);
    const origin = registrable(host);
    const db = ctx().db;
    const granted = grantedOrigins(db, task).includes(origin);
    // asked again after its cookies went out: they did not hold (the site's session ended, which hortusd cannot see).
    // Answering "granted" for good left no way to the owner: only a new login helps
    const spent =
      granted &&
      db
        .prepare(
          "SELECT 1 FROM inbox WHERE task_id = ? AND json_extract(body, '$.from') = 'cookies' AND json_extract(body, '$.text') LIKE ?",
        )
        .get(task, `% for ${origin} are in %`) !== undefined;
    if (granted && !spent) return { status: "granted", cookies: sendCookies(task, origin) };
    const open = db
      .prepare(
        "SELECT id, kind FROM approvals WHERE status = 'pending' AND task_id = ? AND ((kind = 'login' AND hash = ?) OR (kind = 'grant' AND hash = ?))",
      )
      .get(task, `login:${origin}`, `grant:origin:${origin}`) as { id: number; kind: string } | undefined;
    if (open) return { status: "pending", approval: open.id, kind: open.kind, url: gate.approvalUrl(open.id) };
    const n = spent ? 0 : loginCookies(db, origin);
    if (n > 0) {
      const g = gate.check({
        caller,
        kind: "grant",
        category: `origin:${origin}`,
        hash: `grant:origin:${origin}`,
        consequential: false,
        summary: { grant: `origin:${origin}`, origin, url, why, cookies: n, task },
      });
      bus.emit("approvals", { task });
      if (g === "pass") return { status: "granted", cookies: sendCookies(task, origin) };
      return { status: "pending", approval: g.pending, kind: "grant", url: gate.approvalUrl(g.pending) };
    }
    const r = db
      .prepare(
        "INSERT INTO approvals(kind, category, hash, task_id, summary, status, requested_at) VALUES ('login', 'login', ?, ?, ?, 'pending', ?)",
      )
      .run(`login:${origin}`, task, JSON.stringify({ url, why, origin }), new Date().toISOString());
    const id = Number(r.lastInsertRowid);
    log.info("login pending", { id, task, origin });
    try {
      gate.deps.notify(`approval ${id} pending (login ${origin})`);
    } catch (e) {
      log.error("notify failed", e, { id });
    }
    bus.emit("approvals", { id });
    return { status: "pending", approval: id, kind: "login", url: gate.approvalUrl(id) };
  },
});

const Id = z.object({ id: z.number().int() });
const owner = ["owner"] as const;
const Buttons = z.enum(["none", "left", "middle", "right"]);

const Input = z.discriminatedUnion("type", [
  z.object({
    id: z.number().int(),
    type: z.literal("mouse"),
    event: z.enum(["mousePressed", "mouseReleased", "mouseMoved", "mouseWheel"]),
    x: z.number(),
    y: z.number(),
    button: Buttons.default("none"),
    clickCount: z.number().int().min(0).max(3).default(0),
    deltaX: z.number().default(0),
    deltaY: z.number().default(0),
  }),
  z.object({
    id: z.number().int(),
    type: z.literal("key"),
    event: z.enum(["keyDown", "keyUp"]),
    key: z.string().max(32),
    code: z.string().max(32).default(""),
    keyCode: z.number().int().default(0),
    modifiers: z.number().int().min(0).max(15).default(0),
  }),
  z.object({ id: z.number().int(), type: z.literal("text"), text: z.string().max(4096) }),
]);

define("login.open", {
  roles: [...owner],
  input: Id,
  async run({ id }) {
    const v = await open(id);
    return { until: v.until };
  },
});

define("login.input", {
  roles: [...owner],
  input: Input,
  async run(i) {
    const v = views.get(i.id);
    if (!v) throw new RpcError("invalid", "the login view is closed: open the entry again");
    touch(v);
    const send = (m: string, p: Record<string, unknown>) => v.cdp.send(m, p, v.session);
    if (i.type === "mouse") {
      const press = i.event === "mousePressed" || i.event === "mouseReleased";
      await send("Input.dispatchMouseEvent", {
        type: i.event,
        x: i.x,
        y: i.y,
        button: press && i.button === "none" ? "left" : i.button,
        clickCount: i.clickCount || (press ? 1 : 0),
        ...(i.event === "mouseWheel" ? { deltaX: i.deltaX, deltaY: i.deltaY } : {}),
      });
    } else if (i.type === "text") {
      await send("Input.insertText", { text: i.text });
    } else {
      // a printable key without Ctrl/Alt/Meta types its character; everything else is a raw key (Enter types "\r")
      const printable = i.key.length === 1 && (i.modifiers & 7) === 0;
      const text = printable ? i.key : i.key === "Enter" ? "\r" : undefined;
      await send("Input.dispatchKeyEvent", {
        type: i.event === "keyUp" ? "keyUp" : text ? "keyDown" : "rawKeyDown",
        key: i.key,
        code: i.code,
        windowsVirtualKeyCode: i.keyCode,
        modifiers: i.modifiers,
        ...(text && i.event === "keyDown" ? { text, unmodifiedText: text } : {}),
      });
    }
    return { until: v.until };
  },
});

define("login.done", {
  roles: [...owner],
  input: Id,
  async run({ id }) {
    const e = entry(id);
    await close(id, "done");
    gate.decide(id, "approve", "owner");
    grant(e.task, e.origin, { origin: e.origin, url: e.url, login: id });
    const n = sendCookies(e.task, e.origin);
    bus.emit("approvals", { id });
    return { id, cookies: n };
  },
});

define("login.reject", {
  roles: [...owner],
  input: Id,
  async run({ id }) {
    entry(id);
    await close(id, "rejected");
    gate.decide(id, "reject", "owner");
    bus.emit("approvals", { id });
    return { id };
  },
});

define("captured.list", {
  roles: [...owner],
  input: z.unknown(),
  run: () => capturedOrigins(ctx().db),
});

/**
 * Deletes every captured row of an origin: the placeholders in old jars then answer 403 (unknown credential). Its
 * grants go too: a task holding one heard "granted" with no cookies, and the next login reached every old holder.
 */
define("captured.forget", {
  roles: [...owner],
  input: z.object({ origin: z.string().min(1).max(253) }),
  run: ({ origin }) => ({ deleted: forget(origin) }),
});

/** Every site at once: Settings › Credentials › Website logins › Reset all. */
define("captured.reset", {
  roles: [...owner],
  input: z.unknown(),
  run: () => ({ deleted: forget() }),
});

function forget(origin?: string): number {
  const db = ctx().db;
  const r = origin
    ? db.prepare("DELETE FROM captured WHERE origin = ?").run(origin)
    : db.prepare("DELETE FROM captured").run();
  db.prepare(
    "UPDATE approvals SET status = 'expired', reason = 'the site was forgotten' WHERE kind = 'grant' AND category LIKE 'origin:%' AND (?1 IS NULL OR category = 'origin:' || ?1) AND status = 'approved'",
  ).run(origin ?? null);
  bus.emit("settings");
  return Number(r.changes);
}

// ---------------------------------------------------------------------------------------------------------------------

let inner: typeof gate.deps.inboxWrite | undefined;

export const browserModule: Module = {
  name: "browser",
  async start(c: Ctx) {
    bound = c;
    // views do not survive a restart (their entries do): addresses of a previous run's views go back
    for (const r of c.db.prepare("SELECT address FROM links WHERE kind = 'login'").all() as { address: string }[])
      links.release(r.address);
    // an approved `origin:*` grant entry (reuse a stored login) sends the jar like a login's Done does
    inner = gate.deps.inboxWrite;
    gate.deps.inboxWrite = (task, msg) => {
      inner?.(task, msg);
      const d = msg.data as { decision?: string; category?: string } | undefined;
      if (msg.from === "approval" && d?.decision === "approved" && d.category?.startsWith("origin:"))
        sendCookies(task, d.category.slice("origin:".length));
    };
  },
  async stop() {
    await Promise.all([...views.keys(), ...opening.keys()].map((id) => close(id, "hortusd stopped")));
    if (inner) gate.deps.inboxWrite = inner;
    inner = undefined;
  },
};
