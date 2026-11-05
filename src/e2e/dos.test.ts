/**
 * Event-loop denial of service (review round 5): a Worker and a hostile upstream attack hortusd's proxy, RPC and
 * search while the console is probed. The daemon's modules (vault, proxy, mirror, console) run in this process; the
 * hostile upstream and the attacking Worker run in a forked child (src/test/fakes/hostile.ts), so their work is not on
 * the loop measured. Per attack: the loop's longest hold (monitorEventLoopDelay max), `POST /api/task.list` p95, and
 * the peak RSS over the baseline, printed as `# dos …` lines. Each must stay under a second (RSS under 1 GB), every
 * Worker request must end (a status, an error or the client's own cut), and no upstream socket may outlive the
 * attack.
 */
import assert from "node:assert/strict";
import { type ChildProcess, fork } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Config } from "../config.ts";
import { consoleModule } from "../console/index.ts";
import type { Ctx } from "../ctx.ts";
import { openDb } from "../db.ts";
import { logger } from "../log.ts";
import { upsert } from "../mirror/fts.ts";
import { mirrorModule } from "../mirror/index.ts";
import * as paths from "../paths.ts";
import { links, listen, proxyModule } from "../proxy/index.ts";
import { BODY_BUDGET, MAX_INFLIGHT } from "../proxy/server.ts";
import { tempDir, until } from "../test/until.ts";
import { transforms, vaultModule } from "../vault/index.ts";
import { write as writeVault } from "../vault/vault.ts";

process.env.HORTUS_HOME = tempDir("hortus-dos-");
process.env.HORTUS_NO_NET = "1";
process.env.HORTUS_CONSOLE_PORT = "0";

let child: ChildProcess;
let proxyPort = 0;
let consolePort = 0;
const ask = <T>(m: object): Promise<T> =>
  new Promise((resolve, reject) => {
    child.once("message", (r: { result?: T; open?: T; error?: string }) =>
      r.error ? reject(new Error(r.error)) : resolve((r.result ?? r.open) as T),
    );
    child.send(m);
  });

before(async () => {
  child = fork(fileURLToPath(new URL("../test/fakes/hostile.js", import.meta.url)), { stdio: "inherit" });
  const { ports } = await new Promise<{ ports: { http: number; tls: number } }>((r) => child.once("message", r));
  const up = `http://127.0.0.1:${ports.http}`;
  const hosts = ["slow.test", "never.test", "endless.test", "huge.test", "headers.test", "bomb.test", "ws.test"];
  // a transform on the bodies' hosts: only those are buffered (a host with none streams from the first byte)
  const fixtures = join(paths.home(), "fixtures");
  mkdirSync(join(fixtures, "dosws"), { recursive: true });
  writeFileSync(
    join(fixtures, "dosws", "manifest.json"),
    JSON.stringify({
      name: "dosws",
      credentials: {
        dosws: { type: "token", hosts: ["ws.test", "endless.test", "huge.test", "bomb.test"], locations: ["ws:text"] },
      },
    }),
  );
  writeFileSync(join(fixtures, "dosws", "transform.js"), "export function request(req) { return req; }");
  const ctx: Ctx = {
    config: Config.parse({
      dev: {
        upstreams: { ...Object.fromEntries(hosts.map((h) => [h, up])), "tls.test": `https://127.0.0.1:${ports.tls}` },
      },
      proxy: { https: 0, http: 0, dns: 0 },
    }),
    db: openDb(paths.db()),
    paths,
    log: logger,
    reload: async () => {},
  };
  writeVault({});
  ctx.db
    .prepare("INSERT INTO tasks(id, kind, status, scope, origins) VALUES ('T', 'chat', 'running', ?, ?)")
    .run(JSON.stringify({ credentials: [], repos: [] }), JSON.stringify("*"));
  // 40 one-MB session logs, each hit 25,000 times by "the"
  const body = "the model said something about deploy; ".repeat(25_000);
  for (let i = 0; i < 40; i++)
    upsert(ctx.db, { dof: "logs", path: `L${i}/session.md`, author: "", ts: String(i), title: "log", body });
  await vaultModule.start(ctx);
  await proxyModule.start(ctx);
  await mirrorModule.start(ctx);
  await consoleModule.start(ctx);
  consolePort = consoleModule.port();
  await transforms.load([transforms.shippedDir(), fixtures]);
  for (let i = 0; i < 20; i++) links.register(`127.0.0.${2 + i}`, "worker", "T", "session");
  proxyPort = (await listen("127.0.0.1", { https: 0, http: 0, dns: 0, proxyAddress: "127.0.0.1" })).http;
});

after(async () => {
  child.kill();
  await consoleModule.stop();
  await proxyModule.stop();
  await vaultModule.stop();
});

const rssMb = () => process.memoryUsage().rss / 1024 / 1024;
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) * p)] ?? 0;
const taskList = async () => {
  const r = await fetch(`http://127.0.0.1:${consolePort}/api/task.list`, {
    method: "POST",
    headers: { "X-Hortus": "1", "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(r.status, 200);
  await r.json();
};

/** Runs the attack while probing the console; prints and bounds hold, p95 and RSS; returns the attack's tally. */
async function measure(
  attack: string,
  n: number,
  ms: number,
  rssMax = 1024,
  clients?: number,
): Promise<Record<string, number>> {
  global.gc?.();
  const base = rssMb();
  let peak = base;
  const h = monitorEventLoopDelay({ resolution: 10 });
  h.enable();
  const lat: number[] = [];
  let busy = true;
  const probe = (async () => {
    while (busy) {
      const s = performance.now();
      await taskList();
      lat.push(performance.now() - s);
      peak = Math.max(peak, rssMb());
      await sleep(50);
    }
  })();
  const result = await ask<Record<string, number>>({ attack, proxy: proxyPort, n, ms, clients });
  busy = false;
  await probe;
  h.disable();
  const hold = h.max / 1e6;
  const p95 = pct(lat, 0.95);
  console.log(
    `# dos ${attack} ×${n}: hold ${hold.toFixed(0)} ms; task.list p95 ${p95.toFixed(0)} ms (${lat.length} probes); rss +${(peak - base).toFixed(0)} MB; ${JSON.stringify(result)}`,
  );
  assert.ok(hold < 1000, `${attack}: the loop held ${hold} ms`);
  assert.ok(p95 < 1000, `${attack}: task.list p95 ${p95} ms`);
  assert.ok(peak - base < rssMax, `${attack}: rss +${peak - base} MB`);
  // the client hung up or the upstream ended: hortusd let go of every upstream socket
  await until(async () => (await ask<number>({ open: true })) === 0, 10_000, `${attack}: upstream sockets closed`);
  return result;
}

const opts = { timeout: 120_000 };

test("slow-loris and never-answering upstreams: the client hanging up frees the upstream socket", opts, async () => {
  assert.deepEqual(await measure("slow", 50, 3000), { "gave up": 50 });
  const never = await measure("never", MAX_INFLIGHT + 44, 3000);
  assert.deepEqual(never, { "gave up": MAX_INFLIGHT, 429: 44 });
});

test("an upstream that never completes TLS: the client hanging up frees it", opts, async () => {
  assert.deepEqual(await measure("tls", 50, 3000), { "gave up": 50 });
});

test("endless, 1 GB and gzip-bomb bodies to a buffering host: streamed past 16 MB, bounded memory", opts, async () => {
  for (const a of ["endless", "huge", "bomb"]) {
    // 4 buffered at a time per client (BUFFERING). Measured: +180, +22, +0 MB; with no bound +275, +154, +131 MB
    // (at MAX_INFLIGHT it would be gigabytes; too heavy a neighbour for the default suite)
    const r = await measure(a, 24, 60_000, 300);
    assert.deepEqual(r, { "200 read 24 MB": 24 }, a);
  }
});

test("100 MB of response headers: a 502, quickly", opts, async () => {
  assert.deepEqual(await measure("headers", 20, 10_000), { 502: 20 });
});

test("WebSocket frame and fragment floods at a client that never reads: bounded memory", opts, async () => {
  const flood = await measure("flood", 10, 5000);
  assert.deepEqual(flood, { open: 10 });
  const frags = await measure("fragments", 10, 5000);
  // past ws's 16 MB message cap the relay ends; a client that is not reading may not see the close
  assert.equal(
    Object.values(frags).reduce((a, b) => a + b, 0),
    10,
  );
});

test(
  "256 simultaneous dof.search RPCs over megabyte logs: one start per loop turn, the console in between",
  opts,
  async () => {
    // run back to back they held the loop ~3 s (~12 ms each)
    assert.deepEqual(await measure("search", 256, 60_000), { 200: 256 });
  },
);

test("20 Workers at once, each flooding RPCs and proxy requests: the console stays responsive", opts, async () => {
  // before round 6's turns and global buffering bound: hold 1.3 s, task.list p95 550 ms, rss +1.4 GB
  const r = await measure("swarm", 64, 60_000, 700, 20);
  assert.deepEqual(r, { "search 200": 20 * 64, "never gave up": 20 * 64, "endless 200 read 24 MB": 20 * 4 });
});

test("20 Workers each holding 64 request bodies open: a byte budget per client", opts, async () => {
  // half RPCs, half pipeline requests, just under 1 MB each, written and never ended. Before the budget (16 MB a
  // client): rss +239 MB for one Worker, +4.98 GB for 20; with it +48 and +293 MB
  // 64 each in the suite (over the budget 4×; MAX_INFLIGHT each held the loop ~650 ms with 4,800 refusals at once)
  const r = await measure("bodies", 64, 15_000, 600, 20);
  const each = BODY_BUDGET / (1024 * 1024);
  assert.deepEqual(r, { "gave up": 20 * each, 429: 20 * (64 - each) });
});
