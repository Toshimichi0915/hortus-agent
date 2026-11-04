/**
 * `hortusd.internal`, served in-process. The caller comes from the link, never the request: client copies of
 * `X-Hortus-Role`/`X-Hortus-Task` are dropped and the link's values set. A new route is one row in `routes`.
 */
import { Readable } from "node:stream";
import { call, isStream } from "../rpc.ts";
import { RpcError } from "../types.ts";
import type { Client } from "./links.ts";
import { type IncomingRequest, type Out, readUpTo, refuse } from "./pipeline.ts";

interface Route {
  method: string;
  prefix: string;
  run(client: Client, req: IncomingRequest, rest: string): Promise<Out>;
}

const STATUS: Record<RpcError["code"], number> = { not_found: 404, forbidden: 403, invalid: 400, failed: 500 };

/**
 * One RPC start per client per loop turn. Each method's synchronous part runs on hortusd's thread (a search over
 * megabyte logs ~12 ms); 64 arriving in one poll phase ran back to back and held the loop ~790 ms, the console's
 * requests behind them. Only the starts are queued: a slow RPC (a merge) does not hold the client's next one.
 */
const turns = new Map<Client, Promise<void>>();

async function rpc(client: Client, req: IncomingRequest, method: string): Promise<Out> {
  const turn = (turns.get(client) ?? Promise.resolve()).then(() => new Promise<void>((r) => setImmediate(r)));
  turns.set(client, turn);
  await turn;
  if (turns.get(client) === turn) turns.delete(client);
  return rpcNow(client, req, method);
}

async function rpcNow(client: Client, req: IncomingRequest, method: string): Promise<Out> {
  let input: unknown;
  if (req.body) {
    const r = await readUpTo(req.body, 16 * 1024 * 1024);
    if ("rest" in r) {
      r.rest.resume();
      return refuse(413, "rpc body over 16 MB");
    }
    const text = r.buf.toString("utf8").trim();
    try {
      input = text ? JSON.parse(text) : undefined;
    } catch {
      return refuse(400, "rpc body is not JSON");
    }
  }
  const json = (status: number, v: unknown): Out => ({
    status,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(v),
  });
  try {
    const result = await call(method, input, { role: client.role, ...(client.task ? { task: client.task } : {}) });
    if (!isStream(result)) return json(200, { result: result ?? null });
    // streams as NDJSON: one {event} per line, then {done: true}
    const lines = (async function* () {
      try {
        for await (const event of result) yield `${JSON.stringify({ event })}\n`;
        yield `${JSON.stringify({ done: true })}\n`;
      } catch (e) {
        const err = e instanceof RpcError ? e : new RpcError("failed", String(e));
        yield `${JSON.stringify({ error: { code: err.code, message: err.message } })}\n`;
      }
    })();
    return { status: 200, headers: { "content-type": "application/x-ndjson" }, body: Readable.from(lines) };
  } catch (e) {
    const err = e instanceof RpcError ? e : new RpcError("failed", String(e));
    return json(STATUS[err.code], { error: { code: err.code, message: err.message, data: err.data } });
  }
}

/** `/git/<name>` (3b, git http-backend) and `/transforms` (3f) are added here by their steps. */
export const routes: Route[] = [{ method: "POST", prefix: "/rpc/", run: rpc }];

export async function internal(client: Client, req: IncomingRequest): Promise<Out> {
  for (const k of Object.keys(req.headers)) if (k.startsWith("x-hortus-")) delete req.headers[k];
  req.headers["x-hortus-role"] = client.role;
  if (client.task) req.headers["x-hortus-task"] = client.task;
  const path = req.path.split("?")[0] ?? "/";
  for (const r of routes)
    if (req.method.toUpperCase() === r.method && path.startsWith(r.prefix))
      return r.run(client, req, decodeURIComponent(path.slice(r.prefix.length)));
  req.body?.resume();
  return refuse(404, `no route ${req.method} ${path}`);
}
