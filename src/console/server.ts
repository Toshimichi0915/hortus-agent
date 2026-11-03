/**
 * The console listener: guards, then pages (GET), `POST /api/<method>` (the RPC router, role owner), SSE under
 * `/events/<name>`, and `/static/*`. A method that streams (task.stream) answers 400 here: the web UI reads the same
 * rows over SSE (`/events/chat`), the CLI over the socket.
 */
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Ctx } from "../ctx.ts";
import { logger } from "../log.ts";
import { call, isStream } from "../rpc.ts";
import { type Caller, RpcError } from "../types.ts";
import { bus } from "./events.ts";
import { h, layout, type Page, tryCall } from "./html.ts";
import { watch as watchLogin } from "../browser/login-view.ts";
import { approvals } from "./pages/approvals.ts";
import { chat, lastReplies, replyLine } from "./pages/chat.ts";
import { credentials } from "./pages/credentials.ts";
import { loginView } from "./pages/login-view.ts";
import { projects } from "./pages/projects.ts";
import { schedules } from "./pages/schedules.ts";
import { search } from "./pages/search.ts";
import { settings } from "./pages/settings.ts";
import { sources } from "./pages/sources.ts";
import { task } from "./pages/task.ts";
import { tasks } from "./pages/tasks.ts";
import { gate } from "./remote.ts";

const log = logger("console");
export const MAX_BODY = 1024 * 1024;
/** Tests shorten it. */
export const sse = { keepaliveMs: 15_000 };

export const routes: [RegExp, Page][] = [
  [/^\/$/, tasks],
  [/^\/tasks\/([^/]+)$/, task],
  [/^\/chat(?:\/([^/]+))?$/, chat],
  [/^\/approvals(?:\/(\d+))?$/, approvals],
  [/^\/approvals\/(\d+)\/login$/, loginView],
  [/^\/credentials$/, credentials],
  [/^\/projects$/, projects],
  [/^\/settings$/, settings],
  [/^\/sources$/, sources],
  [/^\/search$/, search],
  [/^\/schedules$/, schedules],
];

const HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self' 'unsafe-inline'",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

const STATUS: Record<RpcError["code"], number> = { invalid: 400, forbidden: 403, not_found: 404, failed: 500 };

const staticDir = new URL("./static/", import.meta.url);
const TYPES: Record<string, string> = {
  "app.js": "text/javascript",
  "app.css": "text/css",
  "webauthn.js": "text/javascript",
};

export function send(res: ServerResponse, status: number, type: string, body: string): void {
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

/** `chat` replays `replies` after `Last-Event-ID` (or `?after=`; default: the last 1000), then follows the bus. */
function events(ctx: Ctx, name: string, q: URLSearchParams, req: IncomingMessage, res: ServerResponse): void {
  if (name === "login") {
    loginEvents(Number(q.get("id")), res);
    return;
  }
  const taskId = q.get("task");
  if (!["approvals", "tasks", "chat"].includes(name) || (name === "chat" && !taskId)) {
    send(res, 404, "text/plain", "no such stream");
    return;
  }
  res.writeHead(200, { ...HEADERS, "Content-Type": "text/event-stream", Connection: "keep-alive" });
  res.write(": hello\n\n");
  const keepalive = setInterval(() => res.write(": keepalive\n\n"), sse.keepaliveMs);
  let topic: string = name;
  let onEvent: (payload?: unknown) => void;
  if (name === "chat" && taskId) {
    topic = `chat:${taskId}`;
    const from = req.headers["last-event-id"] ?? q.get("after");
    let last = from === undefined || from === null || from === "" ? -1 : Number(from);
    const flush = () => {
      for (const r of lastReplies(ctx, taskId, last)) {
        res.write(`id: ${r.seq}\ndata: ${JSON.stringify({ seq: r.seq, html: replyLine(r).html })}\n\n`);
        last = r.seq;
      }
    };
    onEvent = flush;
    flush();
  } else onEvent = (payload) => res.write(`data: ${JSON.stringify(payload ?? null)}\n\n`);
  bus.on(topic, onEvent);
  res.on("close", () => {
    clearInterval(keepalive);
    bus.off(topic, onEvent);
  });
}

/** `/events/login?id=<entry>`: the login view's frames (and `until`, `closed`, `error`) as JSON; opening starts it. */
function loginEvents(id: number, res: ServerResponse): void {
  if (!Number.isInteger(id)) {
    send(res, 404, "text/plain", "no such stream");
    return;
  }
  res.writeHead(200, { ...HEADERS, "Content-Type": "text/event-stream", Connection: "keep-alive" });
  res.write(": hello\n\n");
  const keepalive = setInterval(() => res.write(": keepalive\n\n"), sse.keepaliveMs);
  const off = watchLogin(id, (e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
  res.on("close", () => {
    clearInterval(keepalive);
    off();
  });
}

async function handle(
  ctx: Ctx,
  port: () => number,
  remote: boolean,
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
  if (site !== undefined && site !== "same-origin" && site !== "none")
    return send(res, 403, "text/plain", "cross-site");
  const url = new URL(req.url ?? "/", "http://console");
  const path = url.pathname;

  if (req.method === "POST") {
    const type = req.headers["content-type"] ?? "";
    if (req.headers["x-hortus"] !== "1" || !/^application\/json\b/.test(type)) {
      req.resume();
      return send(res, 403, "text/plain", "missing X-Hortus or JSON");
    }
  }
  const caller: Caller = { role: "owner" };
  if (remote) {
    const session = await gate(ctx, req, res, url);
    if (session === undefined) return;
    Object.assign(caller, { remote: true, session });
  }
  if (req.method === "POST") {
    const m = /^\/api\/([\w.-]+)$/.exec(path);
    if (!m) return send(res, 404, "text/plain", "not found");
    return api(m[1] as string, req, res, caller);
  }
  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "text/plain", "method not allowed");

  const ev = /^\/events\/(\w+)$/.exec(path);
  if (ev) return events(ctx, ev[1] as string, url.searchParams, req, res);
  const st = /^\/static\/(app\.(?:js|css)|webauthn\.js)$/.exec(path);
  if (st) {
    const file = st[1] as string;
    return send(res, 200, TYPES[file] as string, readFileSync(new URL(file, staticDir), "utf8"));
  }
  const logm = /^\/tasks\/([^/]+)\/log$/.exec(path);
  if (logm) {
    const r = await tryCall<string | { text?: string }>("task.log", { id: logm[1] });
    if (!r.ok) return send(res, 404, "text/plain", r.error);
    return send(res, 200, "text/plain", typeof r.value === "string" ? r.value : (r.value?.text ?? ""));
  }
  for (const [re, page] of routes) {
    const m = re.exec(path);
    if (m) return send(res, 200, "text/html", await page(ctx, { m: [...m], q: url.searchParams, caller }));
  }
  send(res, 404, "text/html", layout(ctx, "", "Not found", h`<p>No page at <code>${path}</code>.</p>`));
}

export interface Console {
  server: Server;
  port: number;
  close(): Promise<void>;
}

/** The request listener of both listeners; `remote` adds the cookie gate (remote.ts) and `console.host` as Host. */
export function handler(ctx: Ctx, port: () => number, remote: boolean) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    handle(ctx, port, remote, req, res).catch((e) => {
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
