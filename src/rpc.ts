/**
 * One handler table, three transports: the abstract socket (here, role owner), `POST /api/<m>` (console, F6) and
 * `https://hortusd.internal/rpc/<m>` (proxy, F3). A new method is one `define()` in its module.
 *
 * A method may resolve to an AsyncIterable: the socket then sends `{id, event}` frames and ends with `{id, done: true}`
 * (or `{id, error}`). Events must not be null. Other transports decide how they carry it (the console as SSE).
 */
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { connect, createServer, type Server, type Socket } from "node:net";
import { Readable } from "node:stream";
import { z } from "zod";
import { logger } from "./log.ts";
import * as paths from "./paths.ts";
import { type Caller, type Role, RpcError, type TaskJson } from "./types.ts";

export interface Method<I, O> {
  roles: Role[];
  input: z.ZodType<I>;
  run(input: I, caller: Caller): Promise<O> | O;
}

// biome-ignore lint/suspicious/noExplicitAny: the table holds every method's own I/O types
export const methods = new Map<string, Method<any, any>>();

const log = logger("rpc");
export const MAX_FRAME = 16 * 1024 * 1024;

export function define<I, O>(name: string, m: Method<I, O>): void {
  if (methods.has(name)) throw new Error(`rpc method ${name} defined twice`);
  methods.set(name, m);
}

/** Any thrown value as an RpcError; a non-RpcError becomes `failed` with its message, the stack goes to the log only. */
export function toRpcError(e: unknown, name: string): RpcError {
  if (e instanceof RpcError) return e;
  log.error(`${name} failed`, e);
  return new RpcError("failed", e instanceof Error ? e.message : String(e));
}

/** Role check first: a caller who may not call learns nothing about the input schema. */
export async function call(name: string, input: unknown, caller: Caller): Promise<unknown> {
  const m = methods.get(name);
  if (!m) throw new RpcError("not_found", `no method ${name}`);
  if (!m.roles.includes(caller.role)) throw new RpcError("forbidden", `${name} is not allowed for ${caller.role}`);
  const parsed = m.input.safeParse(input);
  if (!parsed.success) throw new RpcError("invalid", z.prettifyError(parsed.error), parsed.error.issues);
  try {
    return await m.run(parsed.data, caller);
  } catch (e) {
    throw toRpcError(e, name);
  }
}

export const isStream = (v: unknown): v is AsyncIterable<unknown> =>
  typeof v === "object" && v !== null && Symbol.asyncIterator in v;

const Frame = z.object({ id: z.unknown(), method: z.string(), input: z.unknown() });
const errorFrame = (id: unknown, e: RpcError) => ({ id, error: { code: e.code, message: e.message, data: e.data } });

/** Newline-delimited JSON `{id, method, input}` → `{id, result}` | `{id, error}` | `{id, event}`… `{id, done}`. */
export function serveSocket(path: string): Promise<Server> {
  const caller: Caller = { role: "owner" };
  const server = createServer((sock) => {
    sock.setEncoding("utf8");
    let buf = "";
    const send = (frame: unknown) => {
      if (!sock.destroyed) sock.write(`${JSON.stringify(frame)}\n`);
    };
    const handle = async (line: string) => {
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch (e) {
        return send(errorFrame(null, new RpcError("invalid", `malformed frame: ${(e as Error).message}`)));
      }
      const frame = Frame.safeParse(raw);
      if (!frame.success) {
        const id = (raw as { id?: unknown } | null)?.id ?? null;
        return send(errorFrame(id, new RpcError("invalid", "a frame is {id, method, input}", frame.error.issues)));
      }
      const { id = null, method, input } = frame.data;
      try {
        const result = await call(method, input, caller);
        if (!isStream(result)) return send({ id, result });
        for await (const event of result) {
          if (sock.destroyed) break;
          send({ id, event });
        }
        send({ id, done: true });
      } catch (e) {
        send(errorFrame(id, toRpcError(e, method)));
      }
    };
    sock.on("data", (chunk: string) => {
      buf += chunk;
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) void handle(line);
        nl = buf.indexOf("\n");
      }
      // ponytail: counts UTF-16 units, not bytes; a multibyte frame may pass up to ~3x the limit in bytes
      if (buf.length > MAX_FRAME) {
        buf = "";
        const frame = JSON.stringify(errorFrame(null, new RpcError("invalid", "frame over 16 MB")));
        sock.removeAllListeners("data");
        sock.end(`${frame}\n`, () => sock.destroy());
      }
    });
    sock.on("error", () => {});
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

export interface RpcClient {
  call(method: string, input?: unknown): Promise<unknown>;
  stream(method: string, input?: unknown): AsyncIterable<unknown>;
  close(): void;
}

interface Pending {
  result(v: unknown): void;
  error(e: Error): void;
  event?(v: unknown): void;
}

/**
 * Socket client for the CLI. Connection errors (no daemon: ECONNREFUSED) reject with the socket error itself;
 * server errors reject with RpcError.
 */
export function rpcClient(path: string): RpcClient {
  let sock: Socket | undefined;
  let next = 1;
  const pending = new Map<number, Pending>();
  const fail = (e: Error) => {
    for (const p of pending.values()) p.error(e);
    pending.clear();
    sock = undefined;
  };
  const open = (): Socket => {
    if (sock) return sock;
    const s = connect(path);
    sock = s;
    s.setEncoding("utf8");
    let buf = "";
    s.on("data", (chunk: string) => {
      buf += chunk;
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const msg = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
        const p = pending.get(msg.id);
        if (!p) continue;
        if (msg.error) {
          pending.delete(msg.id);
          p.error(new RpcError(msg.error.code, msg.error.message, msg.error.data));
        } else if ("event" in msg) p.event?.(msg.event);
        else {
          pending.delete(msg.id);
          p.result(msg.result);
        }
      }
    });
    s.on("error", fail);
    s.on("close", () => fail(new Error("hortusd closed the connection")));
    return s;
  };
  const send = (method: string, input: unknown, p: Pending) => {
    const id = next++;
    pending.set(id, p);
    open().write(`${JSON.stringify({ id, method, input })}\n`);
  };
  return {
    call: (method, input) => new Promise((result, error) => send(method, input, { result, error })),
    stream(method, input) {
      const r = new Readable({ objectMode: true, read() {} });
      send(method, input, { event: (v) => r.push(v), result: () => r.push(null), error: (e) => r.destroy(e) });
      return r;
    },
    close() {
      sock?.destroy();
      sock = undefined;
    },
  };
}

/**
 * An RPC from wherever this runs: inside a task (`HORTUS_TASK` = ctl/task.json) through the proxy at `<task.rpc>/rpc`,
 * in the owner's shell over the abstract socket. `dof` and the Worker's RPC tools (`merge`) use it.
 */
export async function taskRpc<T>(method: string, input: unknown): Promise<T> {
  const taskFile = process.env.HORTUS_TASK;
  if (!taskFile) {
    const client = rpcClient(paths.socket());
    try {
      return (await client.call(method, input)) as T;
    } finally {
      client.close();
    }
  }
  const task = JSON.parse(readFileSync(taskFile, "utf8")) as TaskJson;
  const local = process.env.HORTUS_RPC_LOCAL;
  const res = local
    ? await loopback(`${process.env.HORTUS_RPC}/rpc/${method}`, local, JSON.stringify(input))
    : await fetch(`${task.rpc}/rpc/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  if (!res.ok) {
    const e = body as { error?: { message?: string }; message?: string } | undefined;
    throw new Error(e?.error?.message ?? e?.message ?? `${res.status} ${text}`);
  }
  // hortusd.internal wraps results as {result}; a bare value is taken as is
  return (body && typeof body === "object" && "result" in body ? body.result : body) as T;
}

/**
 * HORTUS_NO_NET=1 (tests): no DNS or DNAT for hortusd.internal, so the request goes to the proxy's plain listener on
 * 127.0.0.1 from the session's loopback alias, which is how the proxy knows the task (v7 › Security › HORTUS_NO_NET).
 */
function loopback(
  url: string,
  localAddress: string,
  body: string,
): Promise<{ ok: boolean; status: number; text(): Promise<string> }> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      { method: "POST", localAddress, headers: { host: "hortusd.internal", "content-type": "application/json" } },
      (res) => {
        let t = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          t += c;
        });
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          resolve({ ok: status >= 200 && status < 300, status, text: async () => t });
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}
