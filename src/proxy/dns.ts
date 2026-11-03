/** DNS on the proxy address: `A` → the socket's own address, everything else an empty NOERROR; TTL 5. */
import { createSocket, type Socket } from "node:dgram";
import { isIPv4 } from "node:net";

const TTL = 5;

/** The reply to one query, or undefined for anything malformed (ignored, never answered). */
export function answer(msg: Buffer, address: string): Buffer | undefined {
  if (msg.length < 12) return undefined;
  const flags = msg.readUInt16BE(2);
  if (flags & 0x8000 || (flags >> 11) & 0xf || msg.readUInt16BE(4) !== 1) return undefined;
  let off = 12;
  for (let total = 0; ; ) {
    const len = msg[off];
    if (len === undefined || len & 0xc0) return undefined;
    off++;
    if (len === 0) break;
    total += len + 1;
    if (total > 255 || off + len > msg.length) return undefined;
    off += len;
  }
  if (off + 4 > msg.length) return undefined;
  const qtype = msg.readUInt16BE(off);
  const qclass = msg.readUInt16BE(off + 2);
  const question = msg.subarray(12, off + 4);
  const a = qtype === 1 && qclass === 1 && isIPv4(address);
  const head = Buffer.alloc(12);
  head.writeUInt16BE(msg.readUInt16BE(0), 0);
  head.writeUInt16BE(0x8000 | 0x0400 | (flags & 0x0100) | 0x0080, 2);
  head.writeUInt16BE(1, 4);
  head.writeUInt16BE(a ? 1 : 0, 6);
  if (!a) return Buffer.concat([head, question]);
  const rr = Buffer.alloc(16);
  rr.writeUInt16BE(0xc00c, 0);
  rr.writeUInt16BE(1, 2);
  rr.writeUInt16BE(1, 4);
  rr.writeUInt32BE(TTL, 6);
  rr.writeUInt16BE(4, 10);
  address.split(".").forEach((o, i) => {
    rr[12 + i] = Number(o);
  });
  return Buffer.concat([head, question, rr]);
}

export function dnsServer(address: string, port: number): Promise<Socket> {
  const sock = createSocket("udp4");
  sock.on("message", (msg, rinfo) => {
    const r = answer(msg, address);
    if (r) sock.send(r, rinfo.port, rinfo.address);
  });
  sock.on("error", () => {});
  return new Promise((resolve, reject) => {
    sock.once("error", reject);
    sock.bind(port, address, () => {
      sock.off("error", reject);
      resolve(sock);
    });
  });
}
