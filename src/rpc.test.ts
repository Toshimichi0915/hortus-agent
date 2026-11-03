import assert from "node:assert/strict";
import { connect } from "node:net";
import { after, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { call, define, rpcClient, serveSocket } from "./rpc.ts";
import { tempDir } from "./test/until.ts";
import { RpcError } from "./types.ts";

process.env.HORTUS_HOME = tempDir("hortus-rpc-");

let ran = 0;
define("t.echo", { roles: ["owner"], input: z.object({ n: z.number() }), run: async ({ n }) => ({ n }) });
define("t.guarded", {
  roles: ["owner"],
  input: z.object({ n: z.number() }),
  run: async () => {
    ran++;
    return 1;
  },
});
define("t.boom", {
  roles: ["owner"],
  input: z.unknown(),
  run: async () => {
    throw new Error("kaboom");
  },
});
define("t.sleep", {
  roles: ["owner"],
  input: z.object({ ms: z.number() }),
  run: async ({ ms }) => {
    await sleep(ms);
    return ms;
  },
});
define("t.stream", {
  roles: ["owner"],
  input: z.object({ n: z.number() }),
  run: async function* ({ n }) {
    for (let i = 0; i < n; i++) yield i;
  },
});

const rejects = (p: Promise<unknown>, code: string) =>
  assert.rejects(p, (e: unknown) => e instanceof RpcError && e.code === code);

test("define twice throws", () => {
  assert.throws(() => define("t.echo", { roles: [], input: z.unknown(), run: async () => 0 }));
});

test("call: not_found, forbidden before validation, invalid with issues, failed without stack", async () => {
  await rejects(call("t.nope", {}, { role: "owner" }), "not_found");
  await assert.rejects(call("t.guarded", { n: "bad" }, { role: "worker", task: "x" }), (e: RpcError) => {
    assert.equal(e.code, "forbidden");
    assert.equal(e.data, undefined);
    return true;
  });
  await assert.rejects(call("t.guarded", { n: "bad" }, { role: "owner" }), (e: RpcError) => {
    assert.equal(e.code, "invalid");
    assert.equal((e.data as { path: string[] }[])[0]?.path[0], "n");
    return true;
  });
  assert.equal(ran, 0);

  const write = process.stderr.write;
  let logged = "";
  process.stderr.write = ((s: string) => {
    logged += s;
    return true;
  }) as typeof write;
  try {
    await assert.rejects(call("t.boom", {}, { role: "owner" }), (e: RpcError) => {
      assert.equal(e.code, "failed");
      assert.equal(e.message, "kaboom");
      assert.equal(e.data, undefined);
      return true;
    });
  } finally {
    process.stderr.write = write;
  }
  assert.match(logged, /kaboom/);
  assert.match(logged, /rpc\.test/);
});

const sock = `\0hortus-test-${process.pid}`;
const server = await serveSocket(sock);
after(() => server.close());

interface Frame {
  id: unknown;
  result?: unknown;
  error?: { code: string; message: string };
}

/** A raw connection: write lines, read frames. */
function raw() {
  const s = connect(sock);
  s.setEncoding("utf8");
  const frames: Frame[] = [];
  let buf = "";
  let closed = false;
  s.on("data", (c: string) => {
    buf += c;
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      frames.push(JSON.parse(buf.slice(0, nl)));
      buf = buf.slice(nl + 1);
    }
  });
  s.on("close", () => {
    closed = true;
  });
  s.on("error", () => {});
  const until = async (n: number) => {
    for (let i = 0; i < 500 && frames.length < n && !closed; i++) await sleep(10);
    return frames;
  };
  return { s, frames, until, isClosed: () => closed };
}

test("socket answers out-of-order calls by id", async () => {
  const c = rpcClient(sock);
  const order: number[] = [];
  await Promise.all([
    c.call("t.sleep", { ms: 100 }).then((v) => order.push(v as number)),
    c.call("t.sleep", { ms: 1 }).then((v) => order.push(v as number)),
  ]);
  assert.deepEqual(order, [1, 100]);
  assert.deepEqual(await c.call("t.echo", { n: 3 }), { n: 3 });
  await rejects(c.call("t.echo", { n: "x" }), "invalid");
  c.close();
});

test("socket streams events then done", async () => {
  const c = rpcClient(sock);
  const got: unknown[] = [];
  for await (const e of c.stream("t.stream", { n: 3 })) got.push(e);
  assert.deepEqual(got, [0, 1, 2]);
  c.close();
});

test("socket survives a malformed line", async () => {
  const r = raw();
  r.s.write("{nope\n");
  r.s.write(`${JSON.stringify({ id: 7 })}\n`);
  r.s.write(`${JSON.stringify({ id: 8, method: "t.echo", input: { n: 1 } })}\n`);
  const f = await r.until(3);
  assert.deepEqual(f[0], { id: null, error: { code: "invalid", message: f[0]?.error?.message } });
  assert.equal(f[1]?.id, 7);
  assert.equal(f[1]?.error?.code, "invalid");
  assert.deepEqual(f[2], { id: 8, result: { n: 1 } });
  r.s.destroy();
});

test("socket rejects a frame over 16 MB", async () => {
  const r = raw();
  r.s.write(`{"id":1,"method":"t.echo","input":"${"x".repeat(17 * 1024 * 1024)}`);
  const f = await r.until(1);
  assert.equal(f[0]?.error?.code, "invalid");
  for (let i = 0; i < 200 && !r.isClosed(); i++) await sleep(10);
  assert.ok(r.isClosed());
});

test("client: no daemon → ECONNREFUSED", async () => {
  const c = rpcClient(`\0hortus-test-absent-${process.pid}`);
  await assert.rejects(c.call("ping"), (e: NodeJS.ErrnoException) => e.code === "ECONNREFUSED");
});
