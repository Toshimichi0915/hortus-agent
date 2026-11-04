/** The proxy module: the client registry, the listeners, and `coreFetch` for hortusd's own upstream calls. */
import { createServer } from "node:http";
import { duplexPair, Readable } from "node:stream";
import { WebSocket } from "ws";
import type { Ctx, Module } from "../ctx.ts";
import { bind } from "../vault/vault.ts";
import * as links from "./links.ts";
import { handle } from "./pipeline.ts";
import { type ListenOptions, listen, listening, unlisten } from "./server.ts";
import { relay } from "./ws.ts";

export { routes as internalRoutes } from "./internal.ts";
export type { Client } from "./links.ts";
export type { IncomingRequest, Out } from "./pipeline.ts";
export type { ListenOptions, Ports } from "./server.ts";
export { hooks as wsHooks } from "./ws.ts";
export { links, listen, unlisten };

/** The shared address: 10.77.0.1 on hortus0, or 127.0.0.1 under HORTUS_NO_NET=1 (no capabilities: clients are
 * loopback aliases told apart by peer address, as VMs on the shared address are). */
export const proxyAddress = (): string => (process.env.HORTUS_NO_NET === "1" ? "127.0.0.1" : "10.77.0.1");

/** The ports from config `proxy` and the shared address, for every `listen` (shared and per session). */
export const listenOpts = (c: Ctx): ListenOptions => ({ ...c.config.proxy, proxyAddress: proxyAddress() });

export const proxyModule: Module = {
  name: "proxy",
  async start(c: Ctx) {
    bind(c);
    links.load();
    if (process.env.HORTUS_NO_NET !== "1") return void (await listen(proxyAddress(), listenOpts(c)));
    // ponytail: without capabilities a busy loopback port is logged, not fatal (parallel test daemons on defaults)
    await listen(proxyAddress(), listenOpts(c)).catch((e) => c.log("proxy").error("loopback listen failed", e));
  },
  async stop() {
    await Promise.all(listening().map(unlisten));
  },
};

const NO_BODY = new Set([101, 204, 205, 304]);

/**
 * `fetch`-shaped, in-process, role core: the same pipeline as every other client, so placeholders in `init` are
 * resolved by transforms and hortusd never handles a raw secret itself. `init.signal` ends the upstream request.
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
  const out = await handle(
    links.CORE,
    {
      method: r.method,
      path: u.pathname + u.search,
      headers,
      body,
      tls,
      ...(tls ? { sni: u.hostname } : {}),
    },
    init.signal ?? undefined,
  );
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

/** Parses the in-process upgrade requests of `coreSocket` and hands them to the relay as role core over TLS. */
const coreUpgrades = createServer().on("upgrade", (req, socket, head) => {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers[k] = [v].flat().join(", ");
  const sni = (headers.host ?? "").replace(/:\d+$/, "");
  relay(links.CORE, { method: "GET", path: req.url ?? "/", headers, body: null, tls: true, sni }, socket, head).catch(
    () => socket.destroy(),
  );
});

/**
 * `coreFetch` for WebSockets: a `wss://` client whose connection is an in-process stream pair into the relay (no
 * address, so no other local process can pose as core). The relay applies the transform (`ws:text` frames too).
 */
export function coreSocket(url: string): globalThis.WebSocket {
  const u = new URL(url);
  return new WebSocket(`ws://${u.host}${u.pathname}${u.search}`, {
    createConnection: () => {
      const [mine, theirs] = duplexPair();
      // a pair does not pass on a destroy: `ws` sat out its 30 s close timeout on every close, and a dropped upstream
      // (no close frame) was seen only by the heartbeat
      theirs.once("close", () => mine.destroy());
      mine.once("close", () => theirs.destroy());
      coreUpgrades.emit("connection", theirs);
      // ws calls these on its socket after the handshake; a stream pair has no Nagle or idle timer
      return Object.assign(mine, { setNoDelay: () => mine, setTimeout: () => mine, setKeepAlive: () => mine });
    },
  } as unknown as WebSocket.ClientOptions) as unknown as globalThis.WebSocket;
}
