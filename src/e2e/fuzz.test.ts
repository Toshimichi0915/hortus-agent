/**
 * Generator-based fuzzing of everything hortusd reads from a Worker, an upstream or a client (review round 4): outbox
 * files, stdout lines, session JSONL (renderer, token scan, inbox cursor), summary.md, forge webhook bodies, transform
 * `response()` results, WebSocket frames through the relay, DNS packets, TLS and HTTP bytes to the proxy, worker RPC
 * bodies through hortusd.internal, owner `POST /api/*` bodies to a real daemon, and CLI args. Deterministic: one seeded
 * PRNG (`HORTUS_FUZZ_SEED`, default below; a failure prints the case's seed). Asserts no crash (an uncaught throw ends
 * this process), no hang (every case is raced against a timeout), nothing read outside the task.
 *
 * What it found (all fixed; case seeds are `SEED * <section> + <case>` with the default SEED 4):
 * - sessions 12000+: a 6 KB tool input nested 3,000 deep pretty-printed to 18 MB in session.md (a session of them ran
 *   hortusd out of memory, at every exit and `task.log`); 12005: two `1e308` usages summed to `Infinity` tokens
 * - stdout: a chat line nested 10^6 deep threw out of JSON.stringify inside the stdout reader and the chat SSE writer
 *   (the `bus` emit), uncaught: hortusd exited
 * - ws 28000+: an upstream close reason (or ping) holding a short secret outgrew 123 (125) bytes once scrubbed; ws's
 *   Sender threw inside the Receiver's write, uncaught
 * - captures: a site's cookie valued `assistant-…` became a global secret: every session's model calls containing the
 *   text were refused as "raw credential", every reply scrubbed
 * - webhooks: unsigned 25 MB POSTs through the tunnel were each held before the signature check, with no cap in sum
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import { type AddressInfo, connect, createServer as netServer } from "node:net";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { connect as tlsConnect } from "node:tls";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { scan } from "../agent/loop.ts";
import { Config } from "../config.ts";
import { connectors } from "../connectors/index.ts";
import { bus } from "../console/events.ts";
import { consoleModule } from "../console/index.ts";
import { replyLine } from "../console/pages/chat.ts";
import type { Ctx } from "../ctx.ts";
import { openDb } from "../db.ts";
import { createWebhooks } from "../gateway/webhooks.ts";
import { lines, readCapped } from "../hostile.ts";
import { logger } from "../log.ts";
import { renderSession } from "../mirror/index.ts";
import { pretty, publishLog } from "../mirror/logs.ts";
import * as paths from "../paths.ts";
import { answer } from "../proxy/dns.ts";
import { links, listen, proxyModule } from "../proxy/index.ts";
import { call, rpcClient } from "../rpc.ts";
import { readOutbox } from "../runtime/dispatcher.ts";
import { tempDir } from "../test/until.ts";
import type { Forge } from "../types.ts";
import { transforms, vaultModule } from "../vault/index.ts";
import { read as readVault, write as writeVault } from "../vault/vault.ts";
// the worker-facing RPC methods, defined at import (as in hortusd)
import "../runtime/tasks.ts";
import "../planner/tools.ts";

const home = tempDir("hortus-fuzz-");
process.env.HORTUS_HOME = home;
process.env.HORTUS_NO_NET = "1";
const SEED = Number(process.env.HORTUS_FUZZ_SEED ?? 4);
// node:test keeps the process alive past an uncaught throw; hortusd has no such handler, so every one is a crash
const uncaught: unknown[] = [];
process.on("uncaughtException", (e) => uncaught.push(e));
process.on("unhandledRejection", (e) => uncaught.push(e));

// ---- the generator ---------------------------------------------------------------------------------------------------

/** mulberry32 */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Gen {
  r: () => number;
  constructor(readonly seed: number) {
    this.r = prng(seed);
  }
  int(n: number): number {
    return Math.floor(this.r() * n);
  }
  chance(p: number): boolean {
    return this.r() < p;
  }
  pick<T>(a: readonly T[]): T {
    return a[this.int(a.length)] as T;
  }
  bytes(n: number): Buffer {
    const b = Buffer.alloc(n);
    for (let i = 0; i < n; i++) b[i] = this.int(256);
    return b;
  }
  str(max = 40): string {
    const parts = [
      "a",
      "Z",
      " ",
      "\n",
      "\r",
      "\t",
      "\0",
      "é",
      "日本",
      "\ud800",
      "😀",
      "[inbox 999]",
      "hortus-secret-",
      "{secret:x}",
      "__proto__",
      ">>>",
      "../",
      "%2e",
      " ",
      '"',
      "\\",
      "`",
    ];
    let s = "";
    for (let n = this.int(max); n > 0; n--) s += this.pick(parts);
    return s;
  }
  /** a random JSON value: weird numbers, prototype keys, deep nests */
  json(depth = 4): unknown {
    const k = this.int(depth <= 0 ? 6 : 10);
    switch (k) {
      case 0:
        return null;
      case 1:
        return this.pick([0, -0, 1, -1, 1e308, -1e308, 2 ** 53 + 1, 0.5, -7, 999999]);
      case 2:
        return this.chance(0.5);
      case 3:
      case 4:
      case 5:
        return this.str();
      case 6:
        return Array.from({ length: this.int(5) }, () => this.json(depth - 1));
      case 7:
        return this.nest(this.pick([10, 1000, 5000]));
      default: {
        const o: Record<string, unknown> = {};
        for (let n = this.int(6); n > 0; n--)
          Object.defineProperty(
            o,
            this.pick(["__proto__", "constructor", "type", "role", "id", "text", this.str(8), "toString"]),
            { value: this.json(depth - 1), enumerable: true, writable: true, configurable: true },
          );
        return o;
      }
    }
  }
  nest(d: number): unknown {
    return JSON.parse("[".repeat(d) + "]".repeat(d));
  }
}

/** Rejects when `p` has not settled in `ms` (a hang). */
async function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, rej) => {
        t = setTimeout(() => rej(new Error(`hang: ${what}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(t);
  }
}

const mkfifo = (p: string) => spawnSync("mkfifo", [p]).status === 0;
const OUTSIDE = join(home, "outside-secret.txt");
writeFileSync(OUTSIDE, "OUTSIDE-THE-TASK\n");

// ---- Worker-written files --------------------------------------------------------------------------------------------

test("stdout lines: bounded, newline-exact, a throwing handler loses only its line", async () => {
  for (let c = 0; c < 200; c++) {
    const g = new Gen(SEED * 1000 + c);
    const max = 1 + g.int(64);
    const parts: Buffer[] = [];
    for (let n = g.int(20); n > 0; n--)
      parts.push(
        g.chance(0.3) ? Buffer.from("\n") : g.chance(0.1) ? Buffer.alloc(g.int(300), 120) : g.bytes(g.int(40)),
      );
    const all = Buffer.concat(parts);
    const want = (() => {
      const out: string[] = [];
      let i = 0;
      for (let nl = all.indexOf(10); nl >= 0; nl = all.indexOf(10, i)) {
        out.push(all.subarray(i, nl).subarray(0, max).toString("utf8"));
        i = nl + 1;
      }
      if (i < all.length) out.push(all.subarray(i).subarray(0, max).toString("utf8"));
      return out.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
    })();
    const got: string[] = [];
    const input = new PassThrough();
    lines(input, max, (l) => {
      got.push(l);
      if (g.chance(0.2)) throw new Error("handler choked");
    });
    // random re-chunking
    for (let i = 0; i < all.length; ) {
      const n = 1 + g.int(17);
      input.write(all.subarray(i, i + n));
      i += n;
    }
    input.end();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(got, want, `seed ${g.seed}`);
  }
});

test("outbox: only regular files of the task, schema-checked, no FIFO hang, nothing behind a link", () => {
  const id = "fuzzout";
  const dir = join(paths.out(id), "outbox");
  for (let c = 0; c < 30; c++) {
    const g = new Gen(SEED * 2000 + c);
    const d = join(dir, "..", `outbox-${c}`);
    mkdirSync(d, { recursive: true });
    for (let n = 0; n < 12; n++) {
      const seq = 1 + g.int(40);
      const name = g.chance(0.85) ? `${String(seq).padStart(6, "0")}.json` : g.pick(["x.json", "0000001.json", ".tmp"]);
      const p = join(d, name);
      const valid = { seq, type: g.pick(["reply", "result", "budget_exceeded"]), text: g.str(), ts: "t" };
      // a FIFO made earlier under this name would block the writer below
      if (lstatSync(p, { throwIfNoEntry: false })) continue;
      try {
        switch (g.int(8)) {
          case 0:
            symlinkSync(OUTSIDE, p);
            break;
          case 1:
            mkfifo(p);
            break;
          case 2:
            mkdirSync(p);
            break;
          case 3:
            writeFileSync(p, g.bytes(g.int(200)));
            break;
          case 4:
            writeFileSync(p, JSON.stringify({ ...valid, seq: seq + 1 }));
            break;
          case 5:
            writeFileSync(p, JSON.stringify(g.json()));
            break;
          case 6:
            writeFileSync(p, `${JSON.stringify(valid)}${" ".repeat(g.chance(0.3) ? 1024 * 1024 : 0)}`);
            break;
          default:
            writeFileSync(p, JSON.stringify(valid));
        }
      } catch {}
    }
    // the reader takes `out/outbox`: point it at this case's directory
    spawnSync("rm", ["-rf", dir]);
    spawnSync("mv", [d, dir]);
    // the reference: regular files named <6 digits>.json, ≤ 1 MB, valid, seq = name
    const want = new Set<number>();
    for (const name of readdirSync(dir)) {
      const st = lstatSync(join(dir, name));
      if (!/^\d{6}\.json$/.test(name) || !st.isFile() || st.size > 1024 * 1024) continue;
      try {
        const m = JSON.parse(readFileSync(join(dir, name), "utf8"));
        const ok = ["reply", "result", "budget_exceeded"].includes(m.type) && typeof m.text === "string";
        if (ok && typeof m.ts === "string" && m.seq === Number(name.slice(0, 6)) && m.seq > 0) want.add(m.seq);
      } catch {}
    }
    const t0 = Date.now();
    const got = readOutbox(id, 0);
    assert.ok(Date.now() - t0 < 1000, `seed ${g.seed}: slow`);
    for (const m of got) assert.ok(!m.text.includes("OUTSIDE-THE-TASK"), `seed ${g.seed}: read through a link`);
    assert.deepEqual(
      got.map((m) => m.seq),
      [...want].sort((a, b) => a - b),
      `seed ${g.seed}`,
    );
  }
});

test("a chat line nested a million deep: the reply row renders as text, a throwing bus listener stays contained", () => {
  const body = `{"type":"text","text":${"[".repeat(1e6)}${"]".repeat(1e6)}}`;
  const html = replyLine({ seq: 1, body, created: null }).html;
  assert.ok(html.startsWith('<div class="r text">'));
  let after = 0;
  bus.on("fuzz", () => {
    throw new RangeError("Maximum call stack size exceeded");
  });
  bus.on("fuzz", () => after++);
  bus.emit("fuzz");
  assert.equal(after, 1);
  bus.removeAllListeners("fuzz");
});

test("task.get: a reply row nested a million deep comes back as its text", async () => {
  const db = openDb(paths.db());
  process.env.HORTUS_CONSOLE_PORT = "0";
  await consoleModule.start({ config: Config.parse({}), db, paths, log: logger, reload: async () => {} });
  db.prepare(
    "INSERT INTO tasks(id, kind, status, title, brief, created, updated) VALUES ('deep', 'chat', 'waiting', 't', 'b', 'x', 'x')",
  ).run();
  const body = `{"type":"text","text":${"[".repeat(1e6)}${"]".repeat(1e6)}}`;
  db.prepare("INSERT INTO replies(task_id, seq, body, created) VALUES ('deep', 1, ?, 'x')").run(body);
  const r = (await call("task.get", { id: "deep" }, { role: "owner" })) as { replies: { body: unknown }[] };
  assert.equal(JSON.stringify(r).length > 0, true);
  assert.equal(r.replies[0]?.body, body);
  await consoleModule.stop();
});

/** core's session entry shape (`{v, type, id, parentId, message}`), sometimes broken */
function sessionLine(g: Gen, ids: string[]): string {
  const id = `e${ids.length}`;
  const parentId = g.chance(0.1) ? g.pick([id, ...ids, "nope", null]) : (ids.at(-1) ?? null);
  ids.push(id);
  const role = g.pick(["user", "assistant", "tool", "system", 5]);
  const message =
    role === "user"
      ? { role, content: g.chance(0.8) ? `u ${g.str()}` : g.json() }
      : role === "assistant"
        ? {
            role,
            text: g.chance(0.9) ? g.str() : g.json(),
            toolCalls: g.chance(0.8)
              ? [{ id: "c", name: g.str(5), input: g.chance(0.3) ? g.nest(g.pick([100, 3000])) : g.json() }]
              : g.json(),
            usage: g.chance(0.7) ? { input: g.json(0), output: g.pick([5, -5, "7", 1e308, Number.NaN]) } : g.json(),
          }
        : role === "tool"
          ? { role, results: g.chance(0.8) ? [{ id: "c", output: g.chance(0.9) ? g.str(200) : g.json() }] : g.json() }
          : g.json();
  const e = { v: g.chance(0.95) ? 1 : 2, type: g.chance(0.9) ? "message" : g.str(4), id, parentId, message };
  return g.pick([JSON.stringify(e), JSON.stringify(e), JSON.stringify(e), "null", "[]", "5", g.str(30), ""]);
}

test("sessions: render and scan any JSONL in bounded time and size; cursor ignores non-owner markers", async () => {
  const db = openDb(paths.db());
  for (let c = 0; c < 40; c++) {
    const g = new Gen(SEED * 3000 + c);
    const id = `fuzzsess${c}`;
    const dir = join(paths.out(id), "sessions");
    mkdirSync(dir, { recursive: true });
    let bytes = 0;
    for (let f = 0; f < 1 + g.int(3); f++) {
      const ids: string[] = [];
      const text = Array.from({ length: g.int(60) }, () => sessionLine(g, ids)).join("\n");
      bytes += text.length;
      writeFileSync(join(dir, `${1_700_000_000 + f}_${g.str(3).replace(/[/\0]/g, "")}.jsonl`), text);
    }
    if (g.chance(0.3)) symlinkSync(OUTSIDE, join(dir, "zz-link.jsonl"));
    if (g.chance(0.3)) mkfifo(join(dir, "zz-fifo.jsonl"));
    if (g.chance(0.3)) writeFileSync(join(paths.out(id), "summary.md"), g.str(200));
    else if (g.chance(0.5)) symlinkSync(OUTSIDE, join(paths.out(id), "summary.md"));
    const t0 = Date.now();
    const md = await within(renderSession(dir), 5000, `seed ${g.seed} render`);
    const { tokens, cursor } = scan(dir);
    await within(publishLog(db, id, g.str(10) || "t", "running"), 5000, `seed ${g.seed} publish`);
    const ms = Date.now() - t0;
    assert.ok(ms < 3000, `seed ${g.seed}: ${ms} ms`);
    assert.ok(md.length <= 2 * bytes + 64 * 1024, `seed ${g.seed}: rendered ${md.length} from ${bytes} bytes`);
    assert.ok(!md.includes("OUTSIDE-THE-TASK"), `seed ${g.seed}: rendered a linked file`);
    const summary = readFileSync(join(paths.logs(), id, "summary.md"), "utf8");
    assert.ok(!summary.includes("OUTSIDE-THE-TASK"), `seed ${g.seed}: published a linked summary`);
    assert.ok(Number.isFinite(tokens) && tokens >= 0, `seed ${g.seed}: tokens ${tokens}`);
    // markers in assistant text, tool output, or inside (not leading) user content never move the cursor
    assert.ok(cursor === 0, `seed ${g.seed}: cursor ${cursor}`);
  }
  db.close();
});

test("sessions: an owner-drained marker moves the cursor, a brief or model text claiming one does not", () => {
  const dir = join(paths.out("fuzzmark"), "sessions");
  mkdirSync(dir, { recursive: true });
  const m = (message: unknown, id: string, parentId: string | null) =>
    JSON.stringify({ v: 1, type: "message", id, parentId, message });
  writeFileSync(
    join(dir, "1700000000_a.jsonl"),
    [
      m({ role: "user", content: "[inbox 90] the brief" }, "1", null),
      m({ role: "assistant", text: "[inbox 80]", toolCalls: [] }, "2", "1"),
      m({ role: "tool", results: [{ id: "x", output: "[inbox 70]" }] }, "3", "2"),
      m({ role: "user", content: "[inbox 3] from=owner\nhi" }, "4", "3"),
      m({ role: "user", content: "[error] [inbox 60]" }, "5", "4"),
    ].join("\n"),
  );
  assert.equal(scan(dir).cursor, 3);
});

test("pretty: the 3,000-deep tool input that ran hortusd out of memory renders in bounded size", () => {
  const g = new Gen(SEED);
  const deep = g.nest(3000);
  const t0 = Date.now();
  const s = pretty({ name: "bash", input: deep });
  assert.ok(s.length < 5000 && Date.now() - t0 < 100, `${s.length} chars`);
  assert.equal(pretty({ a: [1, { b: "c" }], d: {} }), JSON.stringify({ a: [1, { b: "c" }], d: {} }, null, 2));
  assert.equal(readCapped(OUTSIDE, 4)?.text, "OUTS");
});

// ---- DNS -------------------------------------------------------------------------------------------------------------

test("dns: any packet is answered within bounds or ignored", () => {
  const q = Buffer.from("abcd01000001000000000000076578616d706c6503636f6d0000010001", "hex");
  for (let c = 0; c < 3000; c++) {
    const g = new Gen(SEED * 4000 + c);
    const msg = g.chance(0.5) ? g.bytes(g.int(80)) : Buffer.from(q);
    if (msg === q || g.chance(0.5)) for (let n = g.int(4); n >= 0; n--) msg[g.int(msg.length)] = g.int(256);
    const r = answer(msg, g.pick(["10.77.1.2", "127.0.0.1", "::1"]));
    if (r) {
      assert.ok(r.length <= msg.length + 28, `seed ${g.seed}`);
      assert.equal(r.readUInt16BE(0), msg.readUInt16BE(0));
    }
  }
});

// ---- forge webhooks --------------------------------------------------------------------------------------------------

test("webhooks: correctly signed random bodies never hang or throw out of webhook() and mirror()", async () => {
  writeVault({
    ...readVault(),
    "github-webhook": { type: "webhook-secret", value: "whsec-fuzz-1" },
    "gitlab-webhook": { type: "webhook-secret", value: "whsec-fuzz-2" },
    "bitbucket-webhook": { type: "webhook-secret", value: "whsec-fuzz-3" },
  });
  const g0 = new Gen(SEED * 5000);
  const fetch = async (): Promise<Response> => {
    if (g0.chance(0.3)) throw new Error("offline");
    return new Response(JSON.stringify(g0.json()), { status: g0.pick([200, 200, 404, 500]) });
  };
  const forges: Record<string, Forge> = {};
  for (const type of ["github", "gitlab", "bitbucket"])
    forges[type] = (await connectors[type]?.({
      name: type,
      config: { type, owner: "o", ...(g0.chance(0.5) ? { repos: ["o/*"] } : {}) },
      log: { info() {}, error() {} },
      fetch,
      hasRef: () => false,
    })) as Forge;
  const hmac = (k: string, b: Buffer) => `sha256=${createHmac("sha256", k).update(b).digest("hex")}`;
  const types: Record<string, string[]> = {
    github: ["issues", "issue_comment", "pull_request", "pull_request_review", "push", "check_suite", "repository"],
    gitlab: ["issue", "note", "merge_request", "push", "pipeline"],
    bitbucket: ["issue:created", "pullrequest:created", "pullrequest:approved", "repo:push", "repo:commit_status_x"],
  };
  for (let c = 0; c < 300; c++) {
    const g = new Gen(SEED * 5000 + c);
    const type = g.pick(["github", "gitlab", "bitbucket"]);
    const kind = g.pick(types[type] ?? []);
    const payload = g.json(5) as Record<string, unknown>;
    if (g.chance(0.7) && payload && typeof payload === "object" && !Array.isArray(payload)) {
      payload.object_kind = kind;
      payload.repository = g.chance(0.5) ? { full_name: g.pick(["o/r", "x/y", 5]) } : g.json(2);
      payload.project = { path_with_namespace: g.pick(["o/r", "x/y"]), id: 1 };
      payload.object_attributes = g.json(3);
      payload.issue = g.chance(0.5)
        ? { number: g.pick([1, -1, "1", 1e308]), title: g.str(), user: g.json(1) }
        : g.json();
    }
    const body = g.chance(0.9) ? Buffer.from(JSON.stringify(payload)) : g.bytes(g.int(100));
    const headers: Record<string, string> = {
      "x-github-event": kind,
      "x-github-delivery": g.str(6) || "d",
      "x-hub-signature-256": hmac("whsec-fuzz-1", body),
      "x-gitlab-token": "whsec-fuzz-2",
      "x-gitlab-event-uuid": g.str(6) || "u",
      "x-event-key": kind,
      "x-request-uuid": g.str(6) || "r",
      "x-hub-signature": hmac("whsec-fuzz-3", body),
    };
    const forge = forges[type] as Forge;
    const r = await within(
      forge.webhook({ headers, body }).catch(() => ({ ok: false })),
      2000,
      `seed ${g.seed} webhook`,
    );
    const event = (r as { event?: Parameters<Forge["mirror"]>[0] }).event;
    if (event)
      await within(
        forge.mirror(event).catch(() => undefined),
        2000,
        `seed ${g.seed} mirror`,
      );
  }
});

test("webhook listener: unsigned bodies in flight are capped in sum, not only one by one", async () => {
  const forge = { webhook: async () => ({ ok: false }), enqueue: async () => {} } as unknown as Forge;
  const wh = createWebhooks({
    db: openDb(paths.db()),
    config: () => Config.parse({ dofs: { gh: { type: "github", owner: "o" } } }),
    log: { info() {}, error() {} },
    connector: () => forge,
    fetchRepo: async () => {},
  });
  const port = await wh.start(0);
  const chunk = Buffer.alloc(1024 * 1024, 120);
  // five 25 MB deliveries: 24 MB of each written before any ends, so 120 MB are held unsigned at once (cap: 100 MB)
  let written = 0;
  let release: () => void = () => {};
  const all = new Promise<void>((r) => {
    release = r;
  });
  const post = () =>
    new Promise<number>((resolve) => {
      const r = http.request({ host: "127.0.0.1", port, method: "POST", path: "/gh/webhook" }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      let counted = false;
      const count = () => {
        if (counted) return;
        counted = true;
        if (++written === 5) release();
      };
      r.on("error", () => {
        count();
        resolve(-1);
      });
      let i = 0;
      const pump = () => {
        for (; i < 24; i++)
          if (!r.write(chunk)) {
            i++;
            return void r.once("drain", pump);
          }
        count();
        void all.then(() => r.end(chunk));
      };
      pump();
    });
  const codes = await within(Promise.all(Array.from({ length: 5 }, post)), 20_000, "deliveries");
  await wh.stop();
  assert.ok(
    codes.some((c) => c === 503 || c === -1),
    String(codes),
  );
  assert.ok(
    codes.some((c) => c === 401),
    String(codes),
  );
});

// ---- the proxy: transforms, frames, raw bytes, worker RPC ------------------------------------------------------------

let ctx: Ctx;
let ports: { https: number; http: number; dns: number };
const upstream = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    res.writeHead(200, { "content-type": "text/plain", "set-cookie": String(req.headers["x-set-cookie"] ?? "a=b") });
    res.end(`hello ${req.headers["x-echo"] ?? ""}`);
  });
});
const wss = new WebSocketServer({ server: upstream });
wss.on("connection", (ws) =>
  ws.on("message", (m) => {
    const s = String(m);
    // the upstream echoes the secret itself (a client sending it raw is refused): `close:<n>` closes with a reason of
    // n copies, `ping:<n>` pings with them
    const n = Number(s.slice(5).replace(":", ""));
    if (s.startsWith("close:")) ws.close(4000, SHORT.repeat(n).slice(0, 123));
    else if (s.startsWith("ping:")) ws.ping(SHORT.repeat(n).slice(0, 125));
    else ws.send(s);
  }),
);
const fixtures = tempDir("hortus-fuzz-tf-");
const SHORT = "s3cr3t-9"; // 8 chars: scrubbed, and shorter than its placeholder

before(async () => {
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  const fixture = (name: string, host: string, locations: string[], code: string) => {
    mkdirSync(join(fixtures, name), { recursive: true });
    const manifest = { name, credentials: { [name]: { type: "token", hosts: [host], locations } } };
    writeFileSync(join(fixtures, name, "manifest.json"), JSON.stringify(manifest));
    writeFileSync(join(fixtures, name, "transform.js"), code);
  };
  // response() returns whatever the request's x-case header says (headers/body/capture/refs/repos of any type)
  fixture(
    "fz",
    "fz.test",
    ["header:authorization"],
    `export function request(req) { return req; }
export function response(res, req) { const c = req.headers["x-case"]; return c ? JSON.parse(c) : { res }; }`,
  );
  fixture("fzws", "ws.fz.test", ["ws:text"], "export function request(req) { return req; }");
  ctx = {
    config: Config.parse({
      dev: { upstreams: { "fz.test": url, "ws.fz.test": url, "plain.test": url, "other.test": url } },
      proxy: { https: 0, http: 0, dns: 0 },
      dofs: { fz: { type: "fz", owner: "U1" } },
    }),
    db: openDb(paths.db()),
    paths,
    log: logger,
    reload: async () => {},
  };
  writeVault({ fzws: { type: "token", value: SHORT, transform: "fzws" } });
  ctx.db
    .prepare("INSERT INTO tasks(id, kind, status, scope, origins) VALUES ('T', 'chat', 'running', ?, ?)")
    .run(JSON.stringify({ credentials: [], repos: [] }), JSON.stringify("*"));
  await vaultModule.start(ctx);
  await proxyModule.start(ctx);
  await transforms.load([transforms.shippedDir(), fixtures]);
  links.register("127.0.0.2", "worker", "T", "session");
  ports = await listen("127.0.0.1", { https: 0, http: 0, dns: 0, proxyAddress: "127.0.0.1" });
});

after(async () => {
  await proxyModule.stop();
  await vaultModule.stop();
  wss.close();
  upstream.closeAllConnections();
  upstream.close();
});

function get(
  host: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: "127.0.0.1", port: ports.http, method: body ? "POST" : "GET", path: "/x", localAddress: "127.0.0.2" },
      (res) => {
        const c: Buffer[] = [];
        res.on("data", (x: Buffer) => c.push(x));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(c).toString() }));
        res.on("error", reject);
      },
    );
    r.setHeader("host", host);
    for (const [k, v] of Object.entries(headers)) r.setHeader(k, v);
    r.on("error", reject);
    r.end(body);
  });
}

test("transform response(): any shape of headers/body/status/capture/refs/repos is a response or a 502", async () => {
  for (let c = 0; c < 150; c++) {
    const g = new Gen(SEED * 6000 + c);
    const res = {
      status: g.pick([200, 0, 99, 1000, "200", -1, 404, null, 1e308]),
      headers: g.chance(0.5) ? { [g.pick(["x-a", "a b", "content-length", "set-cookie", ""])]: g.json(1) } : g.json(2),
      body: g.chance(0.5) ? g.str() : g.json(2),
    };
    const out = {
      ...(g.chance(0.9) ? { res } : {}),
      ...(g.chance(0.3)
        ? { capture: g.chance(0.5) ? [{ origin: "fz.test", value: g.json(0), name: g.str(4) }] : g.json() }
        : {}),
      ...(g.chance(0.3) ? { refs: g.chance(0.5) ? ["fz:x", g.json(0)] : g.json() } : {}),
      ...(g.chance(0.3) ? { repos: g.json() } : {}),
    };
    let header: string;
    try {
      header = JSON.stringify(out);
    } catch {
      continue;
    }
    if (/[^\x20-\x7e]/.test(header) || header.length > 8000)
      header = JSON.stringify({ res: { status: 200, headers: {}, body: "ok" } });
    const r = await within(get("fz.test", { "x-case": header }), 3000, `seed ${g.seed}`);
    assert.ok(r.status >= 100 && r.status < 600, `seed ${g.seed}: ${r.status}`);
  }
  assert.equal((await get("plain.test")).status, 200);
});

test("captures: a site's cookie is a secret only toward its own origin (no global refusal)", async () => {
  // plain.test sets a cookie whose value is common text; the cookie layer captures it for plain.test
  const common = "assistant-common-text";
  await get("plain.test", { "x-set-cookie": `sid=${common}; Path=/` });
  const n = ctx.db.prepare("SELECT count(*) AS n FROM captured WHERE value = ?").get(common) as { n: number };
  assert.equal(n.n, 1);
  // another host: the text is neither refused in a request nor scrubbed from the response
  const other = await get("other.test", { "x-echo": common });
  assert.equal(other.status, 200, other.body);
  assert.equal(other.body, `hello ${common}`);
  // its own origin still is: refused raw in a request, scrubbed in a response
  assert.equal((await get("plain.test", { "x-echo": common })).status, 403);
});

test("ws relay: random frames, oversize scrubbed close reasons and pings end a relay, never hortusd", async () => {
  const open = () =>
    new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${ports.http}/s`, {
        headers: { host: "ws.fz.test" },
        localAddress: "127.0.0.2",
      } as WebSocket.ClientOptions);
      ws.once("open", () => resolve(ws));
      ws.once("error", reject);
    });
  for (let c = 0; c < 25; c++) {
    const g = new Gen(SEED * 7000 + c);
    const ws = await within(open(), 3000, `seed ${g.seed} open`);
    ws.on("error", () => {});
    const closed = new Promise<void>((r) => ws.once("close", () => r()));
    for (let n = g.int(6); n > 0; n--) {
      const k = g.int(5);
      if (k === 0) ws.send(g.bytes(g.int(300)));
      else if (k === 1) ws.ping(g.bytes(g.int(125)));
      else if (k === 2) ws.send(`ping:${1 + g.int(16)}`);
      else ws.send(g.str(50));
    }
    ws.send(`close:${1 + g.int(16)}`);
    await within(Promise.race([closed, sleep(1500).then(() => ws.terminate())]), 3000, `seed ${g.seed} close`);
  }
  const ws = await open();
  const echo = new Promise<string>((r) => ws.once("message", (m) => r(String(m))));
  ws.send("still here");
  assert.equal(await within(echo, 2000, "echo"), "still here");
  ws.close();
});

test("raw bytes to the proxy: garbage, huge headers, bad chunking, invalid UTF-8, TLS without SNI", async () => {
  const send = (port: number, data: Buffer) =>
    new Promise<void>((resolve) => {
      const s = connect({ host: "127.0.0.1", port, localAddress: "127.0.0.2" }, () => s.end(data));
      s.on("data", () => {});
      s.on("error", () => resolve());
      s.on("close", () => resolve());
      setTimeout(() => s.destroy(), 1500).unref();
    });
  const reqs = (g: Gen): Buffer => {
    switch (g.int(6)) {
      case 0:
        return g.bytes(g.int(2000));
      case 1:
        return Buffer.from(`GET / HTTP/1.1\r\nhost: plain.test\r\nx-big: ${"a".repeat(100_000)}\r\n\r\n`);
      case 2:
        return Buffer.from(
          `POST / HTTP/1.1\r\nhost: plain.test\r\ntransfer-encoding: chunked\r\n\r\n${g.pick(["zz", "ffffffffffff", "-1", "5"])}\r\nab\r\n0\r\n\r\n`,
        );
      case 3:
        return Buffer.concat([
          Buffer.from("POST / HTTP/1.1\r\nhost: plain.test\r\ncontent-length: 40\r\n\r\n"),
          g.bytes(40),
        ]);
      case 4:
        return Buffer.from(`GET ${g.str(30).replace(/\s/g, "")} HTTP/1.1\r\nhost: ${g.str(10)}\r\n\r\n`, "latin1");
      default:
        return Buffer.from(`GET / HTTP/1.1\r\nhost: hortusd.internal\r\n\r\nPOST /rpc/ping HTTP/1.1\r\n\r\n`);
    }
  };
  for (let c = 0; c < 40; c++) {
    const g = new Gen(SEED * 8000 + c);
    await within(send(g.chance(0.8) ? ports.http : ports.https, reqs(g)), 3000, `seed ${g.seed}`);
  }
  // a ClientHello without SNI (an IP host sets none)
  await within(
    new Promise<void>((resolve) => {
      const socket = connect({ host: "127.0.0.1", port: ports.https, localAddress: "127.0.0.2" });
      const s = tlsConnect({ socket, rejectUnauthorized: false });
      s.on("error", () => resolve());
      s.on("close", () => resolve());
    }),
    3000,
    "tls without sni",
  );
  assert.equal((await get("plain.test")).status, 200);
});

test("worker RPC through hortusd.internal: random bodies to every method are answers, never hangs", async () => {
  const names = methodNames();
  const g = new Gen(SEED * 9000);
  for (let c = 0; c < 200; c++) {
    const m = g.pick(names);
    let body: string;
    try {
      body = g.chance(0.9) ? JSON.stringify(g.json(5)) : g.bytes(g.int(50)).toString("latin1");
    } catch {
      continue;
    }
    const r = await within(
      new Promise<number>((resolve, reject) => {
        const q = http.request(
          { host: "127.0.0.1", port: ports.http, method: "POST", path: `/rpc/${m}`, localAddress: "127.0.0.2" },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode ?? 0));
          },
        );
        q.setHeader("host", "hortusd.internal");
        q.on("error", reject);
        q.end(body);
      }),
      3000,
      `seed ${g.seed}#${c} ${m}`,
    );
    assert.ok(r >= 200 && r < 600);
  }
});

/** Every `define("<name>"` in the compiled sources. */
function methodNames(): string[] {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const out = new Set<string>();
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".js") && !e.name.endsWith(".test.js"))
        for (const m of readFileSync(p, "utf8").matchAll(/define\("([\w.]+)"/g)) out.add(m[1] as string);
    }
  };
  walk(root);
  return [...out].filter((n) => !n.startsWith("t."));
}

// ---- a real daemon: owner API bodies, CLI args -----------------------------------------------------------------------

const bin = (name: string) => fileURLToPath(new URL(`../bin/${name}.js`, import.meta.url));

test("owner API and CLI against a real hortusd: random bodies and args never crash or hang it", async () => {
  const dhome = tempDir("hortus-fuzzd-");
  const port = await new Promise<number>((resolve) => {
    const s = netServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });
  const env = { ...process.env, HORTUS_HOME: dhome, HORTUS_CONSOLE_PORT: String(port), HORTUS_WEBHOOK_PORT: "0" };
  let log = "";
  const d: ChildProcess = spawn(process.execPath, ["--no-warnings", bin("hortusd")], {
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  d.stderr?.on("data", (b) => (log += b));
  const exited = new Promise<number | null>((r) => d.once("exit", (code) => r(code)));
  const prevHome = process.env.HORTUS_HOME;
  const ping = async () => {
    process.env.HORTUS_HOME = dhome;
    const c = rpcClient(paths.socket());
    process.env.HORTUS_HOME = prevHome;
    try {
      return await within(c.call("ping", {}), 3000, "ping");
    } finally {
      c.close();
    }
  };
  try {
    for (let i = 0; ; i++) {
      try {
        await ping();
        await fetch(`http://127.0.0.1:${port}/`);
        break;
      } catch (e) {
        if (i > 100) throw e;
        await sleep(100);
      }
    }
    // these end or reconfigure the daemon by design
    const skip = new Set(["settings.set", "pause.set", "dev.link"]);
    const names = methodNames().filter((n) => !skip.has(n));
    for (let c = 0; c < 250; c++) {
      const g = new Gen(SEED * 10_000 + c);
      const m = g.pick(names);
      let body: string;
      try {
        body = g.chance(0.85) ? JSON.stringify(g.json(5)) : g.pick(["", "{", "[]", "null", '{"__proto__":{"x":1}}']);
      } catch {
        continue;
      }
      const r = await within(
        fetch(`http://127.0.0.1:${port}/api/${m}`, {
          method: "POST",
          headers: { "X-Hortus": "1", "Content-Type": "application/json" },
          body,
        }).then(async (r) => [r.status, await r.text()] as const),
        5000,
        `seed ${g.seed} ${m}`,
      );
      assert.ok(r[0] >= 200 && r[0] < 600, `seed ${g.seed}`);
      if (c % 50 === 49) await ping();
    }
    const words = ["tasks", "chat", "approvals", "approve", "reject", "ping", "search", "image", "-n", "--", "-r", "x"];
    for (let c = 0; c < 20; c++) {
      const g = new Gen(SEED * 11_000 + c);
      const args = Array.from({ length: g.int(4) }, () =>
        g.chance(0.7) ? g.pick(words) : g.str(6).replace(/\0/g, ""),
      );
      if (args[0] === "chat" || args.includes("-r")) continue; // interactive
      const p = spawn(process.execPath, ["--no-warnings", bin(g.chance(0.8) ? "hortus" : "dof"), ...args], {
        env,
        stdio: ["ignore", "ignore", "pipe"],
      });
      let err = "";
      p.stderr.on("data", (b) => (err += b));
      const code = await within(
        new Promise<number | null>((r) => p.on("exit", (code) => r(code))),
        10_000,
        `seed ${g.seed} ${JSON.stringify(args)}`,
      ).finally(() => p.kill("SIGKILL"));
      assert.ok(code !== null && !/\n\s+at .*\.js:\d+/.test(err), `seed ${g.seed} ${JSON.stringify(args)}: ${err}`);
    }
    await ping();
  } finally {
    d.kill("SIGTERM");
    await within(exited, 10_000, "daemon exit").catch(() => d.kill("SIGKILL"));
  }
  assert.ok(!/uncaught|unhandled/i.test(log), log.slice(-4000));
});

test("no uncaught exception or unhandled rejection anywhere above (each would end hortusd)", () => {
  assert.deepEqual(uncaught.map(String), []);
});
