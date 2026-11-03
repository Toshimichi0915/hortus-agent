/**
 * WebSocket upgrades: the handshake goes through the pipeline (steps 1–9, so placeholders, the gate and origins apply),
 * then the two sockets are relayed byte for byte. Hosts whose manifest declares `ws:text` get the frame relay (4b):
 * client text frames are a body at location `ws:text` (raw secret → close 1008; placeholders mapped by the transform,
 * called with method `WS`, then checked like step 8 and gated per frame that carries a credential), upstream text
 * frames are scrubbed, binary and control frames pass. Frames are re-framed (re-masked toward upstream) with `ws`'s
 * Receiver/Sender.
 */
import { randomUUID } from "node:crypto";
import { STATUS_CODES } from "node:http";
import type { Duplex } from "node:stream";
import * as wsLib from "ws";
import { logger } from "../log.ts";
import type { Template } from "../types.ts";
import * as gate from "../vault/gate.ts";
import { HANDLE, handles, resolvable, resolveHandle } from "../vault/ops.ts";
import * as transforms from "../vault/transforms.ts";
import { effectiveHosts, manifestEntry, PREFIX, read as readVault, touch } from "../vault/vault.ts";
import type { Client } from "./links.ts";
import { hashTemplate, type IncomingRequest, type Out, type Prepared, prepare, refuse, upstream } from "./pipeline.ts";

const log = logger("ws");

// @types/ws does not declare these two; shapes per ws/lib/{receiver,sender}.js
interface Receiver extends NodeJS.WritableStream {
  on(ev: "message", f: (data: Buffer, binary: boolean) => void): this;
  on(ev: "ping" | "pong", f: (data: Buffer) => void): this;
  on(ev: "conclude", f: (code: number, reason: Buffer) => void): this;
  on(ev: "error", f: (e: Error) => void): this;
}
interface Sender {
  send(data: Buffer | string, o: { binary: boolean; fin: boolean; mask: boolean; compress: boolean }): void;
  ping(data: Buffer, mask: boolean): void;
  pong(data: Buffer, mask: boolean): void;
  close(code: number | undefined, reason: Buffer | string, mask: boolean, cb?: () => void): void;
}
const { Receiver: ReceiverCtor, Sender: SenderCtor } = wsLib as unknown as {
  Receiver: new (o: { isServer: boolean; maxPayload: number }) => Receiver;
  Sender: new (socket: Duplex) => Sender;
};

const MAX_FRAME = 16 * 1024 * 1024;
/** the body of an upgrade the upstream answered without upgrading */
const MAX_REFUSAL = 1024 * 1024;

/** A client text frame → the text to send upstream, or why it is refused. */
export function frameOut(p: Prepared, text: string): { text: string } | { refuse: string } {
  if (p.scrub.find(text)) return { refuse: "raw credential" };
  if (text.search(HANDLE) !== -1) return { refuse: "handle syntax: use hortus-secret-<name> placeholders" };
  let body = text;
  if (text.includes(PREFIX) && p.tf) {
    const req = { method: "WS", url: p.template.url, headers: {}, body: text, stream: false };
    try {
      body = transforms.request(p.tf.name, req, { now: Date.now(), nonce: randomUUID() }).body ?? "";
    } catch (e) {
      log.error("transform failed", e, { transform: p.tf.name, host: p.host });
      return { refuse: "transform failed" };
    }
  }
  if (body.includes(PREFIX)) return { refuse: "unmapped placeholder" };
  let found: ReturnType<typeof handles>;
  try {
    found = handles(body);
  } catch (e) {
    return { refuse: `bad handle: ${(e as Error).message}` };
  }
  if (!found.length) return { text: body };
  const vault = readVault();
  const { client, host } = p;
  const template: Template = { method: "WS", url: p.template.url, headers: {}, body, stream: false };
  const hash = hashTemplate(template);
  for (const h of found) {
    const entry = Object.hasOwn(vault, h.name) ? vault[h.name] : undefined;
    // ponytail: captured (`c-`) credentials never ride in frames; a cookie-session WebSocket service would add them
    if (!entry) return { refuse: `unknown credential ${h.name}` };
    const manifest = transforms.credentialManifest(h.name, entry, p.tf?.manifest);
    if (!effectiveHosts(h.name, entry, manifest).includes(host)) return { refuse: `destination: ${h.name}` };
    if (!manifestEntry(h.name, entry, manifest)?.locations.includes("ws:text"))
      return { refuse: `location: ${h.name} may not ride in ws:text` };
    const why = resolvable(h, { entry });
    if (why) return { refuse: why };
    const g = gate.check({
      caller: client,
      category: `credential:${h.name}`,
      hash,
      consequential: false,
      summary: { method: "WS", host, path: new URL(p.template.url).pathname, bodyPreview: text.slice(0, 2048) },
    });
    if (g !== "pass") return { refuse: `approval ${g.pending}` };
  }
  // every handle checked before any value is produced
  for (const h of found) {
    const entry = vault[h.name];
    if (!entry) continue;
    body = body.split(h.text).join(resolveHandle(h, { entry }));
    touch(h.name);
  }
  return { text: body };
}

/** Frame-by-frame relay for hosts whose manifest declares `ws:text`. */
function frameRelay(p: Prepared, client: Duplex, up: Duplex, head: Buffer, upHead: Buffer): void {
  const fromClient = new ReceiverCtor({ isServer: true, maxPayload: MAX_FRAME });
  const fromUp = new ReceiverCtor({ isServer: false, maxPayload: MAX_FRAME });
  const toClient = new SenderCtor(client);
  const toUp = new SenderCtor(up);
  const frame = { fin: true, compress: false };
  const kill = () => {
    client.destroy();
    up.destroy();
  };
  fromClient.on("message", (data, binary) => {
    if (binary) return toUp.send(data, { ...frame, binary, mask: true });
    const r = frameOut(p, data.toString("utf8"));
    if ("text" in r) return toUp.send(r.text, { ...frame, binary, mask: true });
    log.info("frame refused", { host: p.host, why: r.refuse });
    client.unpipe(fromClient);
    up.unpipe(fromUp);
    up.destroy();
    toClient.close(1008, `hortus: ${r.refuse}`.slice(0, 120), false, () => client.end());
  });
  fromUp.on("message", (data, binary) =>
    toClient.send(binary ? data : p.scrub.text(data.toString("utf8")), { ...frame, binary, mask: false }),
  );
  fromClient.on("ping", (d) => toUp.ping(d, true));
  fromClient.on("pong", (d) => toUp.pong(d, true));
  fromUp.on("ping", (d) => toClient.ping(p.scrub.bytes(d), false));
  fromUp.on("pong", (d) => toClient.pong(p.scrub.bytes(d), false));
  fromClient.on("conclude", (code, reason) => toUp.close(code === 1005 ? undefined : code, reason, true));
  fromUp.on("conclude", (code, reason) =>
    toClient.close(code === 1005 ? undefined : code, p.scrub.text(reason.toString("utf8")), false),
  );
  fromClient.on("error", kill);
  fromUp.on("error", kill);
  if (head.length) fromClient.write(head);
  if (upHead.length) fromUp.write(upHead);
  client.pipe(fromClient);
  up.pipe(fromUp);
}

/** index.ts re-exports this as `wsHooks`. */
export const hooks = { frameRelay };

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
  // frames are relayed one by one (swapped, scrubbed) on a `ws:text` host and on any credentialed handshake (whose
  // upstream may echo the credential); bytes pass through only on a connection that carries no secret
  const wsText =
    prepared.secrets.size > 0 ||
    Object.values(prepared.tf?.manifest.credentials ?? {}).some((c) => c.locations.includes("ws:text"));
  // the frame relay reads plain frames: no permessage-deflate there
  if (wsText) delete prepared.template.headers["sec-websocket-extensions"];
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
    const close = () => {
      socket.destroy();
      upSock.destroy();
    };
    upSock.on("error", close);
    socket.on("error", close);
    upSock.on("close", close);
    socket.on("close", close);
    if (wsText) return hooks.frameRelay(prepared, socket, upSock, head, upHead);
    if (upHead.length) socket.write(upHead);
    if (head.length) upSock.write(head);
    upSock.pipe(socket);
    socket.pipe(upSock);
  });
  up.req.on("response", (res) => {
    // not upgraded: answer like a normal request (bounded, scrubbed) and close
    const chunks: Buffer[] = [];
    let n = 0;
    res.on("data", (c: Buffer) => {
      if (res.destroyed) return;
      n += c.length;
      if (n <= MAX_REFUSAL) return void chunks.push(c);
      // an upstream answering the handshake with an endless body must not grow hortusd's memory
      res.destroy();
      writeOut(socket, refuse(502, "upstream: upgrade answered with a body over 1 MB"));
    });
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
