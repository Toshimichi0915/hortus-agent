/**
 * The console listener: guards, then `POST /api/<method>` (the RPC router, role owner), SSE under `/events/<name>`, two
 * plain-text views (a session log, a whole diff), and the web UI (dist/web) for any other GET. A method that streams
 * (task.stream) answers 400 here: the web UI reads the same rows over SSE (`/events/chat`), the CLI over the socket.
 */
import { readdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname } from "node:path";
import type { Ctx } from "../ctx.ts";
import { logger } from "../log.ts";
import { call, isStream } from "../rpc.ts";
import { type Caller, RpcError } from "../types.ts";
import { watch as watchLogin } from "../browser/login-view.ts";
import { bus } from "./events.ts";
import { gate } from "./remote.ts";
import { lastReplies, line, type ReplyRow, repliesAfter } from "./rows.ts";

const log = logger("console");
export const MAX_BODY = 1024 * 1024;
/** Tests shorten it. */
export const sse = { keepaliveMs: 15_000 };

export const HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self' 'unsafe-inline'",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

const STATUS: Record<RpcError["code"], number> = { invalid: 400, forbidden: 403, not_found: 404, failed: 500 };

const webDir = new URL("../web/", import.meta.url);
const ASSET_TYPES: Record<string, string> = { ".js": "text/javascript", ".css": "text/css" };

export interface WebApp {
  index: string;
  assets: Map<string, Buffer>;
}

/** dist/web, read once here. A request only looks its path up in this list, so none reaches the disk. */
function webApp(): WebApp {
  const dir = new URL("assets/", webDir);
  const files = readdirSync(dir).map((f): [string, Buffer] => [`/assets/${f}`, readFileSync(new URL(f, dir))]);
  return { index: readFileSync(new URL("index.html", webDir), "utf8"), assets: new Map(files) };
}

export function send(res: ServerResponse, status: number, type: string, body: string | Buffer): void {
  res.writeHead(status, { ...HEADERS, "Content-Type": `${type}; charset=utf-8` }).end(body);
}

export const json = (res: ServerResponse, status: number, v: unknown) =>
  send(res, status, "application/json", JSON.stringify(v));

export function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    if (Number(req.headers["content-length"] ?? 0) > MAX_BODY) {
      req.resume();
      return resolve(null);
    }
    const chunks: Buffer[] = [];
    let n = 0;
    req.on("data", (c: Buffer) => {
      n += c.length;
      if (n > MAX_BODY) {
        chunks.length = 0;
        return resolve(null);
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function api(method: string, req: IncomingMessage, res: ServerResponse, caller: Caller): Promise<void> {
  const text = await readBody(req);
  if (text === null) return json(res, 413, { error: { code: "invalid", message: "body over 1 MB" } });
  let input: unknown;
  try {
    input = text ? JSON.parse(text) : {};
  } catch (e) {
    return json(res, 400, { error: { code: "invalid", message: `malformed JSON: ${(e as Error).message}` } });
  }
  try {
    const result = await call(method, input, caller);
    if (isStream(result)) {
      await result[Symbol.asyncIterator]().return?.();
      return json(res, 400, { error: { code: "invalid", message: `${method} streams: use /events or the socket` } });
    }
    json(res, 200, { result: result ?? null });
  } catch (e) {
    const err = e instanceof RpcError ? e : new RpcError("failed", String(e));
    json(res, STATUS[err.code] ?? 500, { error: { code: err.code, message: err.message, data: err.data } });
  }
}

/**
 * Opens an SSE response; returns what to run on close. A remote one (`session`, its row's hash) is cut once the row is
 * gone (revoked, idle-swept): checked on each keepalive and on the `sessions` bus event.
 */
function openStream(ctx: Ctx, res: ServerResponse, session: string | undefined): () => void {
  res.writeHead(200, { ...HEADERS, "Content-Type": "text/event-stream", Connection: "keep-alive" });
  res.write(": hello\n\n");
  const live = () =>
    !session || ctx.db.prepare("SELECT 1 FROM console_sessions WHERE hash = ?").get(session) !== undefined;
  const check = () => {
    if (!live()) res.destroy();
  };
  const keepalive = setInterval(() => (live() ? res.write(": keepalive\n\n") : res.destroy()), sse.keepaliveMs);
  bus.on("sessions", check);
  return () => {
    clearInterval(keepalive);
    bus.off("sessions", check);
  };
}

/**
 * A `chat` event: `{ seq, body, created }`. `body` nests one level deeper here than in `line`'s own check, so a row at
 * the very edge of the stack can still throw: then it goes as its text too.
 */
function chatEvent(r: ReplyRow): string {
  const row = { seq: r.seq, created: r.created };
  try {
    return JSON.stringify({ ...row, body: line(r.body) });
  } catch {
    return JSON.stringify({ ...row, body: r.body });
  }
}

/**
 * `/events/<names>`, comma-separated: a page's one stream (HTTP/1.1 gives an origin six connections, and an open SSE
 * holds one; three per chat page stalled every fetch with two chats open). `approvals`, `tasks` and `settings` are named
 * SSE events; `chat` is the unnamed one: it replays every `replies` row after `Last-Event-ID` (or `?after=`; default:
 * the last 1000), then follows the bus.
 */
function events(
  ctx: Ctx,
  name: string,
  q: URLSearchParams,
  req: IncomingMessage,
  res: ServerResponse,
  session?: string,
): void {
  if (name === "login") {
    loginEvents(ctx, Number(q.get("id")), res, session);
    return;
  }
  const taskId = q.get("task");
  const names = name.split(",");
  if (
    names.some((n) => !["approvals", "tasks", "settings", "chat"].includes(n)) ||
    (names.includes("chat") && !taskId)
  ) {
    send(res, 404, "text/plain", "no such stream");
    return;
  }
  const stop = openStream(ctx, res, session);
  const subs = names
    .filter((n) => n !== "chat")
    .map((n): [string, (payload?: unknown) => void] => [
      n,
      (payload) => res.write(`event: ${n}\ndata: ${JSON.stringify(payload ?? null)}\n\n`),
    ]);
  if (names.includes("chat") && taskId) {
    const from = req.headers["last-event-id"] ?? q.get("after");
    let last = from === undefined || from === null || from === "" ? -1 : Number(from);
    const flush = () => {
      // text deltas are a row each: a phone asleep for one long reply missed over 1000, so a cursor gets all of them
      const next = () => (last < 0 ? lastReplies(ctx, taskId) : repliesAfter(ctx, taskId, last));
      for (let rows = next(); rows.length; rows = next())
        for (const r of rows) {
          res.write(`id: ${r.seq}\ndata: ${chatEvent(r)}\n\n`);
          last = r.seq;
        }
    };
    subs.push([`chat:${taskId}`, flush]);
    flush();
  }
  for (const [topic, f] of subs) bus.on(topic, f);
  res.on("close", () => {
    stop();
    for (const [topic, f] of subs) bus.off(topic, f);
  });
}

/** `/events/login?id=<entry>`: the login view's frames (and `until`, `closed`, `error`) as JSON; opening starts it. */
function loginEvents(ctx: Ctx, id: number, res: ServerResponse, session?: string): void {
  if (!Number.isInteger(id)) {
    send(res, 404, "text/plain", "no such stream");
    return;
  }
  const stop = openStream(ctx, res, session);
  const off = watchLogin(id, (e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
  res.on("close", () => {
    stop();
    off();
  });
}

/** A plain-text view of an RPC's answer; its error as a 404. */
async function plain(
  res: ServerResponse,
  method: string,
  input: unknown,
  caller: Caller,
  text: (v: unknown) => string,
) {
  try {
    send(res, 200, "text/plain", text(await call(method, input, caller)));
  } catch (e) {
    send(res, 404, "text/plain", `${method}: ${e instanceof RpcError ? e.message : String(e)}`);
  }
}

const ENT: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ENT[c] as string);

async function handle(
  ctx: Ctx,
  port: () => number,
  remote: boolean,
  web: WebApp,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const host = req.headers.host ?? "";
  const ch = ctx.config.console?.host;
  const hosts = remote
    ? [`${ch}:${port()}`, port() === 443 ? ch : undefined]
    : [`127.0.0.1:${port()}`, `localhost:${port()}`, ch];
  if (!hosts.includes(host)) return send(res, 421, "text/plain", "misdirected request");
  const site = req.headers["sec-fetch-site"];
  const url = new URL(req.url ?? "/", "http://console");
  const path = url.pathname;
  if (site !== undefined && site !== "same-origin" && site !== "none") {
    // the DM's link clicked in a messenger's web app: nothing of the console crosses, but a bare 403 was the end of it,
    // and this one link, followed from here, is same-origin
    if (req.method === "GET" && req.headers["sec-fetch-mode"] === "navigate")
      return send(
        res,
        403,
        "text/html",
        `<!doctype html><title>hortus</title><p><a href="${esc(path + url.search)}">Open this page of the console</a></p>`,
      );
    return send(res, 403, "text/plain", "cross-site");
  }

  if (req.method === "POST") {
    const type = req.headers["content-type"] ?? "";
    if (req.headers["x-hortus"] !== "1" || !/^application\/json\b/.test(type)) {
      req.resume();
      return send(res, 403, "text/plain", "missing X-Hortus or JSON");
    }
  }
  const caller: Caller = { role: "owner" };
  if (remote) {
    const session = await gate(ctx, req, res, url, web);
    if (session === undefined) return;
    Object.assign(caller, { remote: true, session });
  }
  if (req.method === "POST") {
    const m = /^\/api\/([\w.-]+)$/.exec(path);
    if (!m) return send(res, 404, "text/plain", "not found");
    return api(m[1] as string, req, res, caller);
  }
  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "text/plain", "method not allowed");

  const ev = /^\/events\/([\w,]+)$/.exec(path);
  if (ev) return events(ctx, ev[1] as string, url.searchParams, req, res, caller.session);
  // the session log (the chat's older lines) and a diff past the 64 KB a merge entry carries
  const logm = /^\/tasks\/([^/]+)\/log$/.exec(path);
  if (logm)
    return plain(res, "task.log", { id: logm[1] }, caller, (v) =>
      typeof v === "string" ? v : ((v as { text?: string } | null)?.text ?? ""),
    );
  const diffm = /^\/approvals\/(\d+)\/diff$/.exec(path);
  if (diffm) return plain(res, "merge.diff", { id: Number(diffm[1]) }, caller, String);
  if (/^\/(?:api|events)(?:\/|$)/.test(path)) return send(res, 404, "text/plain", "not found");
  const asset = web.assets.get(path);
  if (!asset) return send(res, 200, "text/html", web.index);
  send(res, 200, ASSET_TYPES[extname(path)] ?? "application/octet-stream", asset);
}

export interface Console {
  server: Server;
  port: number;
  close(): Promise<void>;
}

/** The request listener of both listeners; `remote` adds the cookie gate (remote.ts) and `console.host` as Host. */
export function handler(ctx: Ctx, port: () => number, remote: boolean) {
  const web = webApp();
  return (req: IncomingMessage, res: ServerResponse): void => {
    handle(ctx, port, remote, web, req, res).catch((e) => {
      log.error("request failed", e, { url: req.url });
      if (!res.headersSent) send(res, 500, "text/plain", `error: ${e instanceof Error ? e.message : String(e)}`);
      else res.end();
    });
  };
}

export async function startServer(ctx: Ctx, port: number, address = "127.0.0.1"): Promise<Console> {
  const server: Server = createServer(handler(ctx, () => (server.address() as AddressInfo).port, false));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, address, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    server,
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
