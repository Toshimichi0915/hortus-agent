/**
 * WebSocket upgrades: the handshake goes through the pipeline (steps 1–9, so placeholders, the gate and origins apply),
 * then the two sockets are relayed byte for byte. Hosts whose manifest declares `ws:text` get a frame relay (4b) via
 * `frameRelay`; until it exists they are byte-relayed and logged.
 */
import { STATUS_CODES } from "node:http";
import type { Duplex } from "node:stream";
import { logger } from "../log.ts";
import type { Client } from "./links.ts";
import { type IncomingRequest, type Out, type Prepared, prepare, refuse, upstream } from "./pipeline.ts";

const log = logger("ws");

/** 4b: frame-by-frame relay for `ws:text` locations (placeholders in text frames). */
export const hooks: { frameRelay?: (p: Prepared, client: Duplex, upstream: Duplex) => void } = {};

function writeOut(socket: Duplex, o: Out): void {
  const body = typeof o.body === "string" || Buffer.isBuffer(o.body) ? Buffer.from(o.body) : Buffer.alloc(0);
  const head = [`HTTP/1.1 ${o.status} ${STATUS_CODES[o.status] ?? ""}`];
  for (const [k, v] of Object.entries(o.headers)) for (const x of [v].flat()) head.push(`${k}: ${x}`);
  head.push(`content-length: ${body.length}`, "connection: close");
  socket.end(Buffer.concat([Buffer.from(`${head.join("\r\n")}\r\n\r\n`), body]));
}

export async function relay(client: Client, req: IncomingRequest, socket: Duplex, head: Buffer): Promise<void> {
  socket.on("error", () => {});
  let p: Prepared | Out;
  try {
    p = await prepare(client, { ...req, body: null });
  } catch (e) {
    return writeOut(socket, refuse(502, `upgrade failed: ${(e as Error).message}`));
  }
  if ("status" in p) return writeOut(socket, p);
  const prepared = p;
  let up: ReturnType<typeof upstream>;
  try {
    up = upstream(prepared, { connection: "Upgrade", upgrade: req.headers.upgrade ?? "websocket" });
  } catch (e) {
    return writeOut(socket, refuse(403, (e as Error).message));
  }
  up.req.on("upgrade", (res, upSock, upHead) => {
    const lines = [`HTTP/1.1 101 ${res.statusMessage ?? "Switching Protocols"}`];
    for (let i = 0; i + 1 < res.rawHeaders.length; i += 2)
      lines.push(`${res.rawHeaders[i]}: ${prepared.scrub.text(res.rawHeaders[i + 1] ?? "")}`);
    socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (upHead.length) socket.write(upHead);
    if (head.length) upSock.write(head);
    const close = () => {
      socket.destroy();
      upSock.destroy();
    };
    upSock.on("error", close);
    socket.on("error", close);
    upSock.on("close", close);
    socket.on("close", close);
    const wsText = [prepared.tf?.manifest]
      .flatMap((m) => Object.values(m?.credentials ?? {}))
      .some((c) => c.locations.includes("ws:text"));
    if (wsText && hooks.frameRelay) return hooks.frameRelay(prepared, socket, upSock);
    if (wsText) log.info("ws:text declared but no frame relay yet: relaying bytes", { host: prepared.host });
    upSock.pipe(socket);
    socket.pipe(upSock);
  });
  up.req.on("response", (res) => {
    // not upgraded: answer like a normal request (bounded, scrubbed) and close
    const chunks: Buffer[] = [];
    res.on("data", (c: Buffer) => chunks.push(c));
    res.on("end", () => {
      const headers: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(prepared.scrub.headers(res.headers)))
        if (v !== undefined && !["content-length", "transfer-encoding", "connection"].includes(k)) headers[k] = v;
      writeOut(socket, { status: res.statusCode ?? 502, headers, body: prepared.scrub.bytes(Buffer.concat(chunks)) });
    });
  });
  up.req.on("error", (e) => writeOut(socket, refuse(502, `upstream: ${e.message}`)));
  up.req.end();
}
