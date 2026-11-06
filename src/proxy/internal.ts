/**
 * `hortusd.internal`, served in-process. The caller comes from the link, never the request: client copies of
 * `X-Hortus-Role`/`X-Hortus-Task` are dropped and the link's values set. A new route is one row in `routes`.
 */
import { Readable } from "node:stream";
import { call, isStream } from "../rpc.ts";
import { RpcError } from "../types.ts";
import { type Client, turn } from "./links.ts";
import { type IncomingRequest, type Out, REQUEST_BUFFER, readUpTo, refuse } from "./pipeline.ts";

interface Route {
  method: string;
  prefix: string;
  run(client: Client, req: IncomingRequest, rest: string): Promise<Out>;
}

const STATUS: Record<RpcError["code"], number> = { not_found: 404, forbidden: 403, invalid: 400, failed: 500 };

async function rpc(client: Client, req: IncomingRequest, method: string): Promise<Out> {
  let input: unknown;
  if (req.body) {
    // the pipeline's own request bound: at 16 MB, a Worker's MAX_INFLIGHT RPCs buffered 4 GB.
    // and at most BODY_BUDGET (16 MB) of a client's bodies at once (server.ts › admit). A longer
    // declared body is uncharged there, because the pipeline streams it: here it must not start buffering
    if (Number(req.headers["content-length"] ?? 0) > REQUEST_BUFFER) {
      req.body.resume();
      return refuse(413, "rpc body over 1 MB");
    }
    const r = await readUpTo(req.body, REQUEST_BUFFER);
    if ("rest" in r) {
      r.rest.resume();
      return refuse(413, "rpc body over 1 MB");
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
  // one start per loop turn across clients (links.ts › turn): each method's synchronous part runs on hortusd's thread
  await turn(client);
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
  // a page in a session's Chromium shares its address, so its `fetch(…, { mode: "no-cors" })` is the Worker to everything
  // below: a schedule's script with no model in the loop. A browser says so (`Origin` on every POST, over http too, where
  // it sends no Sec-Fetch-*); nothing of ours sends either. The console's guard, in the same words (server.ts)
  const site = req.headers["sec-fetch-site"];
  if (req.headers.origin !== undefined || (site !== undefined && site !== "none")) {
    req.body?.resume();
    return refuse(403, "hortusd.internal is not for pages");
  }
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
