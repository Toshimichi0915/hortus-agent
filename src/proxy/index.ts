/** The proxy module: the client registry, the listeners, and `coreFetch` for hortusd's own upstream calls. */
import { Readable } from "node:stream";
import type { Ctx, Module } from "../ctx.ts";
import { bind } from "../vault/vault.ts";
import * as links from "./links.ts";
import { handle } from "./pipeline.ts";
import { listen, listening, unlisten } from "./server.ts";

export { routes as internalRoutes } from "./internal.ts";
export type { Client } from "./links.ts";
export type { IncomingRequest, Out } from "./pipeline.ts";
export type { ListenOptions, Ports } from "./server.ts";
export { hooks as wsHooks } from "./ws.ts";
export { links, listen, unlisten };

export const proxyModule: Module = {
  name: "proxy",
  async start(c: Ctx) {
    bind(c);
    links.load();
  },
  async stop() {
    await Promise.all(listening().map(unlisten));
  },
};

const NO_BODY = new Set([101, 204, 205, 304]);

/**
 * `fetch`-shaped, in-process, role core: the same pipeline as every other client, so placeholders in `init` are
 * resolved by transforms and hortusd never handles a raw secret itself. `init.signal` is not honoured.
 */
export async function coreFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const r = new Request(input, { ...init, ...(init.body ? { duplex: "half" } : {}) } as RequestInit);
  const u = new URL(r.url);
  const headers: Record<string, string> = {};
  r.headers.forEach((v, k) => {
    headers[k] = v;
  });
  headers.host = u.host;
  const body = r.body ? Readable.fromWeb(r.body as import("node:stream/web").ReadableStream) : null;
  const tls = u.protocol === "https:";
  const out = await handle(links.CORE, {
    method: r.method,
    path: u.pathname + u.search,
    headers,
    body,
    tls,
    ...(tls ? { sni: u.hostname } : {}),
  });
  const h = new Headers();
  for (const [k, v] of Object.entries(out.headers)) for (const x of [v].flat()) h.append(k, x);
  if (NO_BODY.has(out.status)) {
    if (out.body instanceof Readable) out.body.resume();
    return new Response(null, { status: out.status, headers: h });
  }
  const b: BodyInit =
    out.body instanceof Readable
      ? (Readable.toWeb(out.body) as ReadableStream)
      : typeof out.body === "string"
        ? out.body
        : new Uint8Array(out.body);
  return new Response(b, { status: out.status, headers: h });
}
