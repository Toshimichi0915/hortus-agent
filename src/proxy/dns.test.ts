import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { dnsServer } from "./dns.ts";

function query(name: string, type: number, id = 0x1234): Buffer {
  const head = Buffer.from([id >> 8, id & 0xff, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]);
  const labels = name.split(".").map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)]));
  return Buffer.concat([head, ...labels, Buffer.from([0, type >> 8, type & 0xff, 0, 1])]);
}

const server = await dnsServer("127.0.0.1", 0);
const port = (server.address() as AddressInfo).port;
after(() => server.close());

function ask(msg: Buffer, ms = 300): Promise<Buffer | undefined> {
  const c = createSocket("udp4");
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      c.close();
      resolve(undefined);
    }, ms);
    c.on("message", (m) => {
      clearTimeout(t);
      c.close();
      resolve(m);
    });
    c.send(msg, port, "127.0.0.1");
  });
}

test("A → the listener's address, TTL 5, id and RD echoed", async () => {
  const r = await ask(query("slack.com", 1));
  assert.ok(r);
  assert.equal(r.readUInt16BE(0), 0x1234);
  const flags = r.readUInt16BE(2);
  assert.ok(flags & 0x8000 && flags & 0x0100);
  assert.equal(flags & 0xf, 0);
  assert.equal(r.readUInt16BE(6), 1);
  assert.deepEqual([...r.subarray(r.length - 4)], [127, 0, 0, 1]);
  assert.equal(r.readUInt32BE(r.length - 10), 5);
});

test("AAAA → NOERROR with no answer", async () => {
  const r = await ask(query("slack.com", 28));
  assert.ok(r);
  assert.equal(r.readUInt16BE(2) & 0xf, 0);
  assert.equal(r.readUInt16BE(6), 0);
});

test("a malformed packet is ignored", async () => {
  assert.equal(await ask(Buffer.from([1, 2, 3])), undefined);
  const truncated = query("slack.com", 1).subarray(0, 16);
  assert.equal(await ask(truncated), undefined);
  // and the server still answers afterwards
  assert.ok(await ask(query("x.test", 1)));
});
