/**
 * One listener set (TLS, plain HTTP, DNS) per address. On the shared proxy address clients are told apart by their
 * peer address (VM taps); on a session address by the address itself (host sessions).
 */
import type { Socket as UdpSocket } from "node:dgram";
import http from "node:http";
import https from "node:https";
import type { AddressInfo, Socket } from "node:net";
import { pipeline, Readable } from "node:stream";
import type { TLSSocket } from "node:tls";
import { logger } from "../log.ts";
import { sniCallback } from "../vault/ca.ts";
import { dnsServer } from "./dns.ts";
import { type Client, lookup, turn } from "./links.ts";
import { handle, type IncomingRequest, type Out, REQUEST_BUFFER } from "./pipeline.ts";
import { relay } from "./ws.ts";

const log = logger("proxy");

export interface Ports {
  https: number;
  http: number;
  dns: number;
}

export interface ListenOptions extends Partial<Ports> {
  /** the shared address whose clients are identified by peer address (default 10.77.0.1) */
  proxyAddress?: string;
}

interface Listener {
  servers: (http.Server | https.Server)[];
  dns: UdpSocket;
  ports: Ports;
}

const listeners = new Map<string, Listener>();

const norm = (a: string | undefined): string => (a?.startsWith("::ffff:") ? a.slice(7) : (a ?? ""));

function toIncoming(req: http.IncomingMessage, tls: boolean): IncomingRequest {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers))
    if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(", ") : v;
  const sni = tls ? (req.socket as TLSSocket).servername || undefined : undefined;
  return { method: req.method ?? "GET", path: req.url ?? "/", headers, body: req, tls, ...(sni ? { sni } : {}) };
}

export function writeOut(res: http.ServerResponse, out: Out): void {
  res.writeHead(out.status, out.headers);
  if (out.body instanceof Readable) pipeline(out.body, res, () => {});
  else res.end(out.body);
}

/** Requests and upgrades one client may have open at once: each holds two fds and up to 16 MB of buffer, so a Worker
 * opening thousands to a server that never answers ran hortusd out of both. One count per client, across listeners. */
export const MAX_INFLIGHT = 256;
const inflight = new Map<Client, number>();

/** Request-body bytes one client may have buffered in hortusd at once (review round 8: MAX_INFLIGHT bodies of just
 * under REQUEST_BUFFER, held open, were +239 MB for one Worker and +4.98 GB for 20). A request is charged its
 * `content-length` up to REQUEST_BUFFER (a longer one streams), a chunked one and a WebSocket upgrade (its client frame
 * bound) REQUEST_BUFFER, until it closes; over the budget it is a 429. ponytail: charged by the declared size, not the
 * bytes read; count them in readUpTo if a Worker's legitimate chunked bodies hit the budget. */
export const BODY_BUDGET = 16 * 1024 * 1024; // 16 × REQUEST_BUFFER, a literal: server.ts and pipeline.ts may meet in a cycle
const bodies = new Map<Client, number>();

const charge = (h: http.IncomingHttpHeaders, upgrade: boolean): number => {
  if (upgrade || h["transfer-encoding"] !== undefined) return REQUEST_BUFFER;
  const n = Number(h["content-length"] ?? 0);
  return n > REQUEST_BUFFER ? 0 : n;
};

/** Counts `n` of `max` for `client` in `counts` until `done` closes; false (and nothing counted) over `max`. */
function admit(
  client: Client,
  done: { once(ev: "close", f: () => void): unknown },
  counts = inflight,
  n = 1,
  max = MAX_INFLIGHT,
): boolean {
  if (!(n > 0)) return true;
  const had = counts.get(client) ?? 0;
  if (had + n > max) return false;
  counts.set(client, had + n);
  done.once("close", () => {
    const left = (counts.get(client) ?? n) - n;
    if (left > 0) counts.set(client, left);
    else counts.delete(client);
  });
  return true;
}

function serve(tls: boolean, proxyAddress: string) {
  const clientOf = (s: Socket): Client | undefined => {
    const local = norm(s.localAddress);
    return lookup(local === proxyAddress ? norm(s.remoteAddress) : local);
  };
  const onRequest = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const client = clientOf(req.socket);
    if (!client) {
      req.resume();
      return writeOut(res, {
        status: 403,
        headers: { "content-type": "text/plain" },
        body: "hortus: unknown client\n",
      });
    }
    if (!admit(client, res)) {
      req.resume();
      log.info("refused", { status: 429, msg: "too many requests in flight", task: client.task });
      return writeOut(res, {
        status: 429,
        headers: { "content-type": "text/plain", "retry-after": "1" },
        body: `hortus: over ${MAX_INFLIGHT} requests in flight\n`,
      });
    }
    if (!admit(client, res, bodies, charge(req.headers, false), BODY_BUDGET)) {
      req.resume();
      log.info("refused", { status: 429, msg: "too many request bodies in flight", task: client.task });
      return writeOut(res, {
        status: 429,
        headers: { "content-type": "text/plain", "retry-after": "1" },
        body: `hortus: over ${BODY_BUDGET / REQUEST_BUFFER} MB of request bodies in flight\n`,
      });
    }
    // the client hanging up ends the upstream request (else it held its socket until the upstream gave up)
    const ac = new AbortController();
    res.once("close", () => {
      if (!res.writableFinished) ac.abort();
    });
    // a writeOut that throws (a transform's status 0 or header name with a space) lands in catch, not unhandled
    turn(client)
      .then(() => (ac.signal.aborted ? undefined : handle(client, toIncoming(req, tls), ac.signal)))
      .then((out) => out && writeOut(res, out))
      .catch((e) => {
        log.error("pipeline failed", e);
        if (!res.headersSent) writeOut(res, { status: 502, headers: {}, body: "hortus: proxy error\n" });
        else res.destroy();
      });
  };
  const onUpgrade = (req: http.IncomingMessage, socket: Socket, head: Buffer) => {
    const client = clientOf(socket);
    if (!client) return socket.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
    if (!admit(client, socket) || !admit(client, socket, bodies, charge(req.headers, true), BODY_BUDGET))
      return socket.end("HTTP/1.1 429 Too Many Requests\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
    turn(client)
      .then(() => (socket.destroyed ? undefined : relay(client, toIncoming(req, tls), socket, head)))
      .catch((e) => {
        log.error("upgrade failed", e);
        socket.destroy();
      });
  };
  const server = tls
    ? https.createServer({ SNICallback: sniCallback, ALPNProtocols: ["http/1.1"] }, onRequest)
    : http.createServer(onRequest);
  // Node cuts a request not fully received in 5 minutes: a 50 MB pack to an upstream under 1.4 Mbit/s, or any long
  // upload. What a held request costs is bounded by MAX_INFLIGHT and BODY_BUDGET, and it ends with its session
  server.requestTimeout = 0;
  server.on("upgrade", onUpgrade);
  server.on("clientError", (_e, s) => s.destroy());
  server.on("tlsClientError", () => {});
  return server;
}

const bindTcp = (s: http.Server, address: string, port: number) =>
  new Promise<number>((resolve, reject) => {
    s.once("error", reject);
    // Node's default backlog (511) dropped SYNs when 20 Workers opened 2,600 connections at once (connects timed out
    // after a minute); the kernel caps it at net.core.somaxconn
    s.listen({ port, host: address, backlog: 4096 }, () => {
      s.off("error", reject);
      resolve((s.address() as AddressInfo).port);
    });
  });

/** Binds `:443`, `:80`, `:53` (or the given ports, 0 = ephemeral) on one address; returns the bound ports. */
export async function listen(address: string, opts: ListenOptions = {}): Promise<Ports> {
  const existing = listeners.get(address);
  if (existing) return existing.ports;
  const proxyAddress = opts.proxyAddress ?? "10.77.0.1";
  const tlsServer = serve(true, proxyAddress);
  const plain = serve(false, proxyAddress);
  const opened: (http.Server | UdpSocket)[] = [];
  try {
    const httpsPort = await bindTcp(tlsServer, address, opts.https ?? 443);
    opened.push(tlsServer);
    const httpPort = await bindTcp(plain, address, opts.http ?? 80);
    opened.push(plain);
    const dns = await dnsServer(address, opts.dns ?? 53);
    const ports = { https: httpsPort, http: httpPort, dns: (dns.address() as AddressInfo).port };
    listeners.set(address, { servers: [tlsServer, plain], dns, ports });
    log.info("listening", { address, ...ports });
    return ports;
  } catch (e) {
    for (const o of opened) o.close();
    throw e;
  }
}

export async function unlisten(address: string): Promise<void> {
  const l = listeners.get(address);
  if (!l) return;
  listeners.delete(address);
  l.dns.close();
  await Promise.all(
    l.servers.map(
      (s) =>
        new Promise<void>((r) => {
          s.close(() => r());
          s.closeAllConnections();
        }),
    ),
  );
}

export const listening = (): string[] => [...listeners.keys()];
