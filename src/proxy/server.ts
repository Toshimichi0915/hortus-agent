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
import { type Client, lookup } from "./links.ts";
import { handle, type IncomingRequest, type Out } from "./pipeline.ts";
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

/** Counts one open request of `client` until `done` closes; false (and nothing counted) over MAX_INFLIGHT. */
function admit(client: Client, done: { once(ev: "close", f: () => void): unknown }): boolean {
  const n = inflight.get(client) ?? 0;
  if (n >= MAX_INFLIGHT) return false;
  inflight.set(client, n + 1);
  done.once("close", () => {
    const left = (inflight.get(client) ?? 1) - 1;
    if (left > 0) inflight.set(client, left);
    else inflight.delete(client);
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
    // the client hanging up ends the upstream request (else it held its socket until the upstream gave up)
    const ac = new AbortController();
    res.once("close", () => {
      if (!res.writableFinished) ac.abort();
    });
    // a writeOut that throws (a transform's status 0 or header name with a space) lands in catch, not unhandled
    handle(client, toIncoming(req, tls), ac.signal)
      .then((out) => writeOut(res, out))
      .catch((e) => {
        log.error("pipeline failed", e);
        if (!res.headersSent) writeOut(res, { status: 502, headers: {}, body: "hortus: proxy error\n" });
        else res.destroy();
      });
  };
  const onUpgrade = (req: http.IncomingMessage, socket: Socket, head: Buffer) => {
    const client = clientOf(socket);
    if (!client) return socket.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
    if (!admit(client, socket))
      return socket.end("HTTP/1.1 429 Too Many Requests\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
    relay(client, toIncoming(req, tls), socket, head).catch((e) => {
      log.error("upgrade failed", e);
      socket.destroy();
    });
  };
  const server = tls
    ? https.createServer({ SNICallback: sniCallback, ALPNProtocols: ["http/1.1"] }, onRequest)
    : http.createServer(onRequest);
  server.on("upgrade", onUpgrade);
  server.on("clientError", (_e, s) => s.destroy());
  server.on("tlsClientError", () => {});
  return server;
}

const bindTcp = (s: http.Server, address: string, port: number) =>
  new Promise<number>((resolve, reject) => {
    s.once("error", reject);
    s.listen(port, address, () => {
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
