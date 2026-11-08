/**
 * The pipeline on loopback: the proxy on 127.0.0.1 (as the shared proxy address), clients bound to 127.0.0.2 (worker,
 * task T), 127.0.0.3 (unregistered), 127.0.0.4 (worker, task T2 with an origins list); one fake upstream reached
 * through dev.upstreams.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import dnsPromises from "node:dns/promises";
import { EventEmitter, once } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { type AddressInfo, connect } from "node:net";
import { join } from "node:path";
import { after, before, mock, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { Config } from "../config.ts";
import { bus } from "../console/events.ts";
import type { Ctx } from "../ctx.ts";
import { openDb } from "../db.ts";
import { logger } from "../log.ts";
import * as paths from "../paths.ts";
import { call, define } from "../rpc.ts";
import { tempDir, until } from "../test/until.ts";
import type { InboxMsg } from "../types.ts";
import { caCert } from "../vault/ca.ts";
import { gate, transforms, vaultModule } from "../vault/index.ts";
import { installationToken } from "../vault/ops.ts";
import { mint, minted, read as readVault, scrubber, write as writeVault } from "../vault/vault.ts";
import { coreFetch, links, listen, proxyModule, unlisten } from "./index.ts";
import { egress, hashTemplate } from "./pipeline.ts";
import { CLIENT_IDLE } from "./server.ts";

process.env.HORTUS_HOME = tempDir("hortus-proxy-");
const run = promisify(execFile);
const owner = { role: "owner" as const };

// ---------------------------------------------------------------------------------------------------------------------
// fake upstream

const seen: { auth?: string; path?: string; body?: string; xSeen?: string }[] = [];
const sseSent: number[] = [];
const gitProgress = new EventEmitter();

const fake = http.createServer((req, res) => {
  if (req.url === "/api/hang") return; // a long poll that has nothing yet
  const chunks: Buffer[] = [];
  let n = 0;
  req.on("data", (c: Buffer) => {
    n += c.length;
    if (req.url?.includes("git-receive-pack")) gitProgress.emit("bytes", n);
    else chunks.push(c);
  });
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString();
    seen.push({ auth: req.headers.authorization, path: req.url, body, xSeen: String(req.headers["x-seen"] ?? "") });
    const json = (v: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(v));
    };
    if (req.url === "/api/auth.test") return json({ ok: true, echo: req.headers.authorization });
    if (req.url === "/api/chat.postMessage") return json({ ok: true, channel: "C1", ts: "111.222" });
    if (req.url === "/zod") return json({ name: "zod", leaked: "xoxb-real" });
    if (req.url === "/gz") {
      res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
      return res.end(gzipSync(JSON.stringify({ leaked: "xoxb-real" })));
    }
    if (req.url?.includes("git-receive-pack")) {
      res.writeHead(200, { "content-type": "application/x-git-receive-pack-result" });
      return res.end(`n=${n}`);
    }
    if (req.url?.startsWith("/model/")) {
      const kind = req.url.slice(7);
      if (kind === "json") return json({ usage: { prompt_tokens: 100, completion_tokens: 20 } });
      if (kind === "none") return json({ error: "nothing counted" });
      if (kind === "other") return json({ model: "other", usage: { prompt_tokens: 100, completion_tokens: 20 } });
      if (kind === "limited") {
        res.writeHead(429, { "content-type": "application/json" });
        return res.end('{"error":"rate limited"}');
      }
      if (kind === "ndjson") {
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        return res.end(
          `${'{"message":{"content":"x"}}\n'.repeat(200)}{"done":true,"prompt_eval_count":900,"eval_count":200}\n`,
        );
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      // 3 fresh + 1 read + 2 written, then 5 out: in the two events Anthropic sends them in, the model in the first
      if (kind === "priced")
        res.write(
          'data: {"message":{"model":"m-2026-01-01","usage":{"input_tokens":3,"cache_read_input_tokens":10,"cache_creation_input_tokens":2,"output_tokens":1}}}\n\ndata: {"usage":{"output_tokens":5}}\n\n',
        );
      if (kind === "openai")
        res.write(
          'data: {"choices":[]}\n\ndata: {"usage":{"prompt_tokens":70,"completion_tokens":7,"prompt_tokens_details":{"cached_tokens":60}}}\n\ndata: [DONE]\n\n',
        );
      if (kind === "anthropic")
        res.write(
          'data: {"message":{"usage":{"input_tokens":5,"cache_read_input_tokens":50,"output_tokens":1}}}\n\ndata: {"usage":{"output_tokens":9}}\n\n',
        );
      if (kind === "cut")
        res.write(
          `data: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":1}}}\n\n${'data: {"type":"content_block_delta","delta":{"text":"word"}}\n\n'.repeat(30)}`,
        );
      if (kind === "silent") res.write(`data: ${"x".repeat(4000)}\n\n`);
      return res.end();
    }
    if (req.url === "/sse") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const parts: [number, string][] = [
        [0, "data: e1\n\n"],
        [500, "data: e2 xoxb-"],
        [550, "real\n\n"],
        [1050, "data: e3\n\n"],
      ];
      const t0 = Date.now();
      for (const [at, s] of parts)
        setTimeout(() => {
          res.write(s);
          if (s.endsWith("\n\n")) sseSent.push(Date.now() - t0);
          if (at === 1050) res.end();
        }, at);
      return;
    }
    json({ ok: true });
  });
});
const wss = new WebSocketServer({ server: fake });
wss.on("connection", (ws) => ws.on("message", (m, isBinary) => ws.send(m, { binary: isBinary })));

// ---------------------------------------------------------------------------------------------------------------------
// fixture transforms

const fixtures = tempDir("hortus-proxy-tf-");
function fixture(name: string, hosts: string[], code: string, locations = ["header:Authorization"]) {
  mkdirSync(join(fixtures, name), { recursive: true });
  const manifest = { name, credentials: { [name]: { type: "token", hosts, locations } } };
  writeFileSync(join(fixtures, name, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(fixtures, name, "transform.js"), code);
}
const bearer = `export function request(req) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) headers[k] = k === "authorization" ? v.replace(/^Bearer hortus-secret-([a-z0-9_-]+)$/, "Bearer {secret:$1}") : v;
  return { ...req, headers };
}
export function response(res) { return { res }; }`;
fixture(
  "ghfake",
  ["api.gh.test"],
  `${bearer}\nexport function render(t) { return "render: " + t.method + " " + t.url; }`,
);
fixture(
  "gitfake",
  ["git.test"],
  `export function request(req) {
  return { ...req, headers: { ...req.headers, "x-seen": JSON.stringify([req.body, req.stream]) } };
}`,
);
fixture("lh", ["localhost"], bearer);
fixture("loop", ["loop.test"], "export function request() { for (;;) {} }");
fixture("oom", ["oom.test"], "export function request() { return { s: 'x'.repeat(100 * 1024 * 1024) }; }");
fixture("str", ["str.test"], "export function request() { return 'x'; }");
fixture(
  "badres",
  ["badres.test", "badhdr.test"],
  `export function request(req) { return req; }
export function response(res, req) {
  return req.url.includes("badres") ? { res: { ...res, status: 0 } } : { res: { ...res, headers: { "a b": "x" } } };
}`,
);

// ---------------------------------------------------------------------------------------------------------------------
// setup

const HOSTS = [
  "slack.com",
  "registry.npmjs.org",
  "example.com",
  "api.gh.test",
  "sse.test",
  "git.test",
  "ws.test",
  "loop.test",
  "oom.test",
  "str.test",
  "badres.test",
  "badhdr.test",
  "models.test",
];
let ports: { https: number; http: number; dns: number };
let ca: Buffer;
let ctx: Ctx;
const inbox: [string, Omit<InboxMsg, "seq" | "ts">][] = [];

define("t.whoami", { roles: ["worker", "core"], input: z.unknown(), run: (_i, caller) => caller });

before(async () => {
  process.env.HORTUS_NO_NET = "1"; // proxyModule.start listens on 127.0.0.1 (ephemeral ports), as below
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  const fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  ctx = {
    config: Config.parse({
      dev: { upstreams: Object.fromEntries(HOSTS.map((h) => [h, fakeUrl])) },
      proxy: { https: 0, http: 0, dns: 0 },
      // refs are kept only for a configured DOF of the transform's type
      dofs: { slack: { type: "slack", owner: "U1" } },
    }),
    db: openDb(paths.db()),
    paths,
    log: logger,
    reload: async () => {},
  };
  writeVault({
    slack: { type: "token", value: "xoxb-real", transform: "slack" },
    gh: { type: "token", value: "ghp-fake-0123", transform: "ghfake" },
  });
  const task = ctx.db.prepare(
    "INSERT INTO tasks(id, kind, status, scope, origins) VALUES (?, 'chat', 'running', ?, ?)",
  );
  task.run("T", JSON.stringify({ credentials: ["slack", "gh"], repos: [] }), JSON.stringify("*"));
  task.run("T2", JSON.stringify({ credentials: ["slack"], repos: [] }), JSON.stringify(["registry.npmjs.org"]));
  await vaultModule.start(ctx);
  await proxyModule.start(ctx);
  await transforms.load([transforms.shippedDir(), fixtures]);
  gate.deps.inboxWrite = (t, m) => inbox.push([t, m]);
  links.register("127.0.0.2", "worker", "T", "session");
  links.register("127.0.0.4", "worker", "T2", "session");
  ports = await listen("127.0.0.1", { https: 0, http: 0, dns: 0, proxyAddress: "127.0.0.1" });
  ca = readFileSync(caCert());
});

after(async () => {
  await proxyModule.stop();
  await vaultModule.stop();
  wss.close();
  fake.close();
  fake.closeAllConnections();
});

interface R {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function send(o: {
  host: string;
  path?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  from?: string;
  tls?: boolean;
}): Promise<R> {
  const tls = o.tls ?? true;
  const mod = tls ? https : http;
  return new Promise((resolve, reject) => {
    const r = mod.request(
      {
        host: "127.0.0.1",
        port: tls ? ports.https : ports.http,
        method: o.method ?? "GET",
        path: o.path ?? "/",
        headers: { host: o.host, ...o.headers },
        localAddress: o.from ?? "127.0.0.2",
        agent: false,
        ...(tls ? { servername: o.host, ca } : {}),
      },
      (res) => {
        const c: Buffer[] = [];
        res.on("data", (x: Buffer) => c.push(x));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(c).toString() }),
        );
      },
    );
    r.on("error", reject);
    r.end(o.body);
  });
}

const approvals = () => (ctx.db.prepare("SELECT count(*) AS n FROM approvals").get() as { n: number }).n;
const slackAuth = { authorization: "Bearer hortus-secret-slack" };

// ---------------------------------------------------------------------------------------------------------------------

test("approval round trip with curl: pending, approve, pass with the real token, single use", async () => {
  const curl = () =>
    run("curl", [
      ...["-s", "--interface", "127.0.0.2", "--cacert", caCert()],
      ...["--resolve", `slack.com:${ports.https}:127.0.0.1`, "-H", "Authorization: Bearer hortus-secret-slack"],
      ...["-w", "\n%{http_code}", `https://slack.com:${ports.https}/api/auth.test`],
    ]).then((r) => {
      const i = r.stdout.lastIndexOf("\n");
      return { status: Number(r.stdout.slice(i + 1)), body: r.stdout.slice(0, i) };
    });
  const first = await curl();
  assert.equal(first.status, 403);
  const pending = JSON.parse(first.body);
  assert.equal(pending.category, "credential:slack");
  assert.equal(typeof pending.approval, "number");
  assert.equal(pending.url, `http://127.0.0.1:7700/approvals/${pending.approval}`);
  const entry = (await call("approval.get", { id: pending.approval }, owner)) as { summary: Record<string, unknown> };
  assert.equal((entry.summary.headers as Record<string, string>).authorization, "Bearer {secret:slack}");
  assert.equal(entry.summary.host, "slack.com");
  assert.equal(entry.summary.path, "/api/auth.test");
  // the retry before a decision is the same pending entry
  assert.equal(JSON.parse((await curl()).body).approval, pending.approval);

  await call("approval.decide", { id: pending.approval, decision: "approve" }, owner);
  assert.deepEqual(inbox.at(-1)?.[0], "T");
  assert.equal(inbox.at(-1)?.[1].from, "approval");
  await assert.rejects(
    call("approval.decide", { id: pending.approval, decision: "approve" }, owner),
    /already decided/,
  );

  const second = await curl();
  assert.equal(second.status, 200);
  assert.equal(seen.at(-1)?.auth, "Bearer xoxb-real");
  // the echoed real token is scrubbed back to its placeholder
  assert.equal(JSON.parse(second.body).echo, "Bearer hortus-secret-slack");

  const third = await curl();
  assert.equal(third.status, 403);
  assert.notEqual(JSON.parse(third.body).approval, pending.approval);
});

test("an unregistered client address is refused", async () => {
  const r = await send({ host: "slack.com", path: "/api/auth.test", headers: slackAuth, from: "127.0.0.3" });
  assert.equal(r.status, 403);
  assert.match(r.body, /unknown client/);
});

test("raw credential in a header or the body → 403", async () => {
  const h = await send({ host: "slack.com", path: "/api/auth.test", headers: { authorization: "Bearer xoxb-real" } });
  assert.equal(h.status, 403);
  assert.match(h.body, /raw credential/);
  const b = await send({ host: "example.com", method: "POST", path: "/", body: '{"t":"xoxb-real"}' });
  assert.equal(b.status, 403);
  assert.match(b.body, /raw credential/);
  const basic = Buffer.from("u:xoxb-real").toString("base64");
  const c = await send({ host: "example.com", headers: { authorization: `Basic ${basic}` } });
  assert.match(c.body, /raw credential/);
  // a token the vault does not know, in slack's declared location: the owner's own token on disk
  const own = await send({
    host: "slack.com",
    path: "/api/auth.test",
    headers: { authorization: "Bearer xoxp-owner" },
  });
  assert.equal(own.status, 403);
  assert.match(own.body, /header:authorization holds no placeholder/);
});

test("a placeholder outside a declared location → 403 unmapped placeholder", async () => {
  const body = JSON.stringify({ channel: "C1", text: "hortus-secret-slack" });
  const s = await send({ host: "slack.com", method: "POST", path: "/api/chat.postMessage", headers: slackAuth, body });
  assert.equal(s.status, 403);
  assert.match(s.body, /unmapped placeholder/);
  const e = await send({ host: "example.com", headers: slackAuth });
  assert.equal(e.status, 403);
  assert.match(e.body, /unmapped placeholder/);
});

test("destination: a slack handle to api.gh.test → 403", async () => {
  const r = await send({ host: "api.gh.test", path: "/user", headers: slackAuth });
  assert.equal(r.status, 403);
  assert.match(r.body, /destination/);
});

test("a credential name missing from vault.json → 403 even when a transform maps it", async () => {
  const r = await send({
    host: "slack.com",
    path: "/api/auth.test",
    headers: { authorization: "Bearer hortus-secret-nope" },
  });
  assert.equal(r.status, 403);
  assert.match(r.body, /unknown credential nope/);
  // an Object.prototype name is no entry either
  const proto = await send({
    host: "slack.com",
    path: "/api/auth.test",
    headers: { authorization: "Bearer hortus-secret-constructor" },
  });
  assert.equal(proto.status, 403);
  assert.match(proto.body, /unknown credential constructor/);
});

test("no placeholder: proxied without approval, response scrubbed", async () => {
  const n = approvals();
  const r = await send({ host: "registry.npmjs.org", path: "/zod" });
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).leaked, "hortus-secret-slack");
  assert.equal(approvals(), n);
});

test("origins: a list refuses other hosts; '*' refuses private addresses unless chat.allow lists them", async () => {
  const other = await send({ host: "example.com", from: "127.0.0.4" });
  assert.equal(other.status, 403);
  assert.match(other.body, /host not in origins/);
  assert.equal((await send({ host: "registry.npmjs.org", path: "/zod", from: "127.0.0.4" })).status, 200);

  const priv = await send({ host: "10.0.0.1", tls: false });
  assert.equal(priv.status, 403);
  assert.match(priv.body, /private address/);
  const local = await send({ host: "localhost", tls: false });
  assert.equal(local.status, 403);

  const prev = ctx.config;
  ctx.config = Config.parse({ ...prev, chat: { allow: ["127.0.0.0/8", "::1", "10.0.0.1/32"] } });
  try {
    // past the egress check: whatever localhost:80 answers (or 502 when nothing listens), not the 403 refusal
    assert.notEqual((await send({ host: "localhost", tls: false })).status, 403);
    const t = await egress({ role: "worker", task: "T" }, "10.0.0.1", false, undefined);
    assert.ok(!("status" in t));
    assert.equal(t.address, "10.0.0.1");
  } finally {
    ctx.config = prev;
  }
});

test("SSE: events arrive unbuffered and a token straddling chunks is scrubbed", async () => {
  const arrivals: number[] = [];
  let text = "";
  const t0 = Date.now();
  await new Promise<void>((resolve, reject) => {
    const r = https.request(
      {
        host: "127.0.0.1",
        port: ports.https,
        path: "/sse",
        headers: { host: "sse.test" },
        servername: "sse.test",
        ca,
        localAddress: "127.0.0.2",
        agent: false,
      },
      (res) => {
        res.on("data", (c: Buffer) => {
          text += c.toString();
          const events = text.split("\n\n").length - 1;
          while (arrivals.length < events) arrivals.push(Date.now() - t0);
        });
        res.on("end", resolve);
      },
    );
    r.on("error", reject);
    r.end();
  });
  assert.equal(text, "data: e1\n\ndata: e2 hortus-secret-slack\n\ndata: e3\n\n");
  assert.equal(arrivals.length, 3);
  // the clocks start apart by the TLS handshake (≈150 ms under a loaded suite): compare gaps from the first event
  const gap = (a: number[], i: number) => (a[i] ?? 0) - (a[0] ?? 0);
  for (let i = 1; i < 3; i++)
    assert.ok(Math.abs(gap(arrivals, i) - gap(sseSent, i)) < 150, `${arrivals} vs ${sseSent}`);
  assert.ok(gap(arrivals, 1) < gap(sseSent, 2), "event 2 arrived before event 3 was sent (not held back)");
});

test("uploads: no 5-minute cap on receiving a request (a pack to a slow upstream outlives Node's default)", async () => {
  const servers = [mock.method(http, "createServer"), mock.method(https, "createServer")];
  await listen("127.0.0.9", { https: 0, http: 0, dns: 0 });
  await unlisten("127.0.0.9");
  for (const m of servers) {
    assert.equal((m.mock.calls[0]?.result as http.Server | undefined)?.requestTimeout, 0);
    m.mock.restore();
  }
});

test("a client that stops sending is cut after CLIENT_IDLE; a slow upload is not, nor an idle WebSocket", async () => {
  const was = CLIENT_IDLE.ms;
  CLIENT_IDLE.ms = 300;
  links.register("127.0.0.8", "worker", "T", "session");
  const p = await listen("127.0.0.8", { https: 0, http: 0, dns: 0 });
  CLIENT_IDLE.ms = was;
  const post = (n: number) =>
    `POST /rpc/nope HTTP/1.1\r\nhost: hortusd.internal\r\ncontent-length: ${n}\r\nconnection: close\r\n\r\n`;
  const open = (head: string) => {
    const s = connect(p.http, "127.0.0.8", () => s.write(head));
    s.on("error", () => {});
    return s;
  };
  try {
    const stalled = open(`${post(100)}ab`);
    const closed = once(stalled, "close");
    await Promise.race([closed, sleep(3000).then(() => assert.fail("a stalled body held its socket"))]);

    const slow = open(post(8));
    let got = "";
    slow.on("data", (c) => {
      got += c;
    });
    for (let i = 0; i < 8; i++) {
      await sleep(100); // 800 ms in all, past the idle bound
      slow.write("x");
    }
    await once(slow, "close");
    assert.match(got, /^HTTP\/1\.1 400/); // read to its end: the RPC found it is not JSON

    const ws = new WebSocket(`ws://127.0.0.8:${p.http}/socket`, { headers: { host: "ws.test" } });
    await once(ws, "open");
    await sleep(800);
    const echo = once(ws, "message");
    ws.send("still here");
    assert.equal(String((await echo)[0]), "still here");
    ws.terminate();
  } finally {
    await unlisten("127.0.0.8");
    links.release("127.0.0.8");
  }
});

test("rpc: a declared body over 1 MB is refused at once (uncharged by the byte budget, it must not buffer)", async () => {
  const status = new Promise<number>((resolve, reject) => {
    const r = http.request(
      {
        host: "127.0.0.1",
        port: ports.http,
        method: "POST",
        path: "/rpc/t.whoami",
        headers: { host: "hortusd.internal", "content-length": 2_000_000 },
        localAddress: "127.0.0.2",
        agent: false,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
        r.destroy();
      },
    );
    r.on("error", () => {});
    r.write(Buffer.alloc(1000)); // and holds the rest: it would sit in readUpTo, up to 1 MB of it, for free
    setTimeout(() => {
      reject(new Error("still buffering"));
      r.destroy();
    }, 1000).unref();
  });
  assert.equal(await status, 413);
});

test("x-git-receive-pack: a 5 MB body streams; the transform sees body null, stream true", async () => {
  const MB = 1024 * 1024;
  const got = new Promise<R>((resolve, reject) => {
    const r = https.request(
      {
        host: "127.0.0.1",
        port: ports.https,
        method: "POST",
        path: "/repo/git-receive-pack",
        headers: { host: "git.test", "content-type": "application/x-git-receive-pack-request" },
        servername: "git.test",
        ca,
        localAddress: "127.0.0.2",
        agent: false,
      },
      (res) => {
        const c: Buffer[] = [];
        res.on("data", (x: Buffer) => c.push(x));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(c).toString() }),
        );
      },
    );
    r.on("error", reject);
    // the first MB reaches the fake before the rest is even written: nothing buffers the body
    r.write(Buffer.alloc(MB, 1));
    const half = new Promise<void>((ok) => {
      const f = (n: number) => {
        if (n < MB / 2) return;
        gitProgress.off("bytes", f);
        ok();
      };
      gitProgress.on("bytes", f);
    });
    half.then(() => {
      for (let i = 0; i < 4; i++) r.write(Buffer.alloc(MB, 2));
      r.end();
    });
  });
  const r = await got;
  assert.equal(r.status, 200);
  assert.equal(r.body, `n=${5 * MB}`);
  assert.equal(seen.at(-1)?.xSeen, "[null,true]");
});

test("coreFetch honours init.signal: a stop does not wait out a long poll (Telegram's held every stop for 50 s)", async () => {
  const ac = new AbortController();
  const held = coreFetch("https://slack.com/api/hang", { headers: slackAuth, signal: ac.signal });
  await sleep(100);
  ac.abort();
  const r = await Promise.race([held, sleep(3000).then(() => "held")]);
  assert.ok(r instanceof Response, "the request outlived its signal");
  assert.equal(r.status, 502);
});

test("transform failures → 502: infinite loop (interrupted fast), 100 MB, non-object; then a healthy one works", async () => {
  const t0 = Date.now();
  const loop = await send({ host: "loop.test" });
  assert.equal(loop.status, 502);
  assert.ok(Date.now() - t0 < 1000, `loop took ${Date.now() - t0} ms`);
  assert.equal((await send({ host: "oom.test" })).status, 502);
  assert.equal((await send({ host: "str.test" })).status, 502);
  // a response() hortusd cannot write (status 0, a header name with a space) is a 502, not an unhandled rejection
  assert.equal((await send({ host: "badres.test" })).status, 502);
  assert.equal((await send({ host: "badhdr.test" })).status, 502);
  assert.equal((await send({ host: "registry.npmjs.org", path: "/zod" })).status, 200);
  assert.equal((await coreFetch("https://slack.com/api/auth.test", { headers: slackAuth })).status, 200);
});

test("render() output appears in the approval summary", async () => {
  const r = await send({
    host: "api.gh.test",
    path: "/user",
    headers: { authorization: "Bearer hortus-secret-gh" },
  });
  assert.equal(r.status, 403);
  const { approval } = JSON.parse(r.body);
  const e = (await call("approval.get", { id: approval }, owner)) as { summary: { rendered?: string } };
  assert.equal(e.summary.rendered, "render: GET https://api.gh.test/user");
});

test("refs from slack's response() on chat.postMessage land in task_refs for the task", async () => {
  const post = () =>
    send({
      host: "slack.com",
      method: "POST",
      path: "/api/chat.postMessage",
      headers: { ...slackAuth, "content-type": "application/json" },
      body: JSON.stringify({ channel: "C1", text: "hi" }),
    });
  const p = await post();
  assert.equal(p.status, 403);
  await call("approval.decide", { id: JSON.parse(p.body).approval, decision: "approve" }, owner);
  assert.equal((await post()).status, 200);
  const row = ctx.db.prepare("SELECT task_id FROM task_refs WHERE ref = ?").get("slack:C1:111.222") as {
    task_id: string;
  };
  assert.equal(row.task_id, "T");
});

test("a ref a closed task left goes to the task working there now; a live task's stays", async () => {
  const ref = "slack:C1:111.222";
  const owner_ = () =>
    (ctx.db.prepare("SELECT task_id FROM task_refs WHERE ref = ?").get(ref) as { task_id: string }).task_id;
  const post = () =>
    send({
      host: "slack.com",
      method: "POST",
      path: "/api/chat.postMessage",
      headers: { ...slackAuth, "content-type": "application/json" },
      body: JSON.stringify({ channel: "C1", text: "second visit" }),
    });
  const posted = async () => {
    await call("approval.decide", { id: JSON.parse((await post()).body).approval, decision: "approve" }, owner);
    assert.equal((await post()).status, 200);
  };
  ctx.db.prepare("INSERT INTO tasks(id, kind, status) VALUES ('Tgone', 'unattended', 'running')").run();
  ctx.db.prepare("UPDATE task_refs SET task_id = 'Tgone' WHERE ref = ?").run(ref);
  await posted();
  assert.equal(owner_(), "Tgone", "live: it keeps its ref");
  ctx.db.prepare("UPDATE tasks SET status = 'done' WHERE id = 'Tgone'").run();
  await posted();
  assert.equal(owner_(), "T");
});

test("hash: body whitespace matters, header order does not", () => {
  const t = (headers: Record<string, string>, body: string) =>
    hashTemplate({ method: "POST", url: "https://slack.com/api/x", headers, body, stream: false });
  assert.notEqual(t({ a: "1" }, '{"a":1}'), t({ a: "1" }, '{"a": 1}'));
  assert.equal(
    t({ authorization: "Bearer {secret:slack}", "content-type": "application/json" }, "{}"),
    t({ "content-type": "application/json", Authorization: "Bearer {secret:slack}" }, "{}"),
  );
});

test("role core passes without an approval row", async () => {
  const n = approvals();
  const r = await coreFetch("https://slack.com/api/auth.test", { method: "POST", headers: slackAuth, body: "{}" });
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as { echo: string }).echo, "Bearer hortus-secret-slack");
  assert.equal(seen.at(-1)?.auth, "Bearer xoxb-real");
  assert.equal(approvals(), n);
});

test("expire(): a 73-hour-old pending entry expires and a retry makes a fresh one", async () => {
  const req = () => send({ host: "slack.com", path: "/api/auth.test?x=expire", headers: slackAuth });
  const id = JSON.parse((await req()).body).approval as number;
  const old = new Date(Date.now() - 73 * 3600_000).toISOString();
  ctx.db.prepare("UPDATE approvals SET requested_at = ? WHERE id = ?").run(old, id);
  assert.ok(gate.expire() >= 1);
  const row = ctx.db.prepare("SELECT status FROM approvals WHERE id = ?").get(id) as { status: string };
  assert.equal(row.status, "expired");
  const again = JSON.parse((await req()).body).approval as number;
  assert.notEqual(again, id);
});

test("hortusd.internal: /rpc/<method> with the caller from the link, client X-Hortus-* dropped", async () => {
  const r = await send({
    host: "hortusd.internal",
    method: "POST",
    path: "/rpc/t.whoami",
    headers: { "x-hortus-role": "owner", "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body), { result: { role: "worker", task: "T" } });
  const denied = await send({ host: "hortusd.internal", method: "POST", path: "/rpc/approval.decide", body: "{}" });
  assert.equal(denied.status, 403);
  assert.equal(JSON.parse(denied.body).error.code, "forbidden");
  // the pipeline's request bound (1 MB), not 16 MB: MAX_INFLIGHT of those were 4 GB of one Worker's buffers
  const big = await send({
    host: "hortusd.internal",
    method: "POST",
    path: "/rpc/t.whoami",
    body: `{"x":"${"a".repeat(1024 * 1024)}"}`,
  });
  assert.equal(big.status, 413);
});

test("a live frame relay learns a value rotated after its handshake", { timeout: 20_000 }, async () => {
  links.register("127.0.0.9", "core", null, "test");
  const ws = new WebSocket(`wss://127.0.0.1:${ports.https}/socket`, {
    servername: "api.gh.test",
    headers: { host: "api.gh.test", authorization: "Bearer hortus-secret-gh" },
    ca,
    localAddress: "127.0.0.9",
  } as WebSocket.ClientOptions);
  await once(ws, "open");
  const before = readVault();
  try {
    writeVault({ ...before, gh: { type: "token", value: "ghp-rotated-4567", transform: "ghfake" } });
    const heard = once(ws, "message");
    for (const c of wss.clients) c.send("invalid token ghp-rotated-4567");
    assert.equal(String((await heard)[0]), "invalid token hortus-secret-gh");
    const closed = once(ws, "close");
    ws.send("ghp-rotated-4567");
    assert.equal((await closed)[0], 1008, "a raw value of the new key is refused as the old one was");
  } finally {
    writeVault(before);
    ws.close();
    links.release("127.0.0.9");
  }
});

test("WebSocket: bytes relay both ways and closing one side closes the other", async () => {
  const ws = new WebSocket(`wss://127.0.0.1:${ports.https}/socket`, {
    servername: "ws.test",
    headers: { host: "ws.test" },
    ca,
    localAddress: "127.0.0.2",
  } as WebSocket.ClientOptions);
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const echo = new Promise<string>((resolve) => ws.once("message", (m) => resolve(String(m))));
  ws.send("hello");
  assert.equal(await echo, "hello");
  const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
  for (const c of wss.clients) c.terminate();
  await Promise.race([closed, sleep(2000).then(() => assert.fail("client not closed"))]);
});

test("transforms.list: names, hashes and hosts, no value; approvals carry their task's title", async () => {
  const list = (await call("transforms.list", {}, owner)) as { name: string; hash: string; hosts: string[] }[];
  const slack = list.find((t) => t.name === "slack");
  assert.ok(slack?.hosts.includes("slack.com"));
  assert.match(slack?.hash ?? "", /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(list).includes("xoxb-real"));
  await assert.rejects(call("transforms.list", {}, { role: "worker", task: "t" }), /not allowed/);

  const db = ctx.db;
  db.prepare(
    "INSERT INTO tasks(id, title, status) VALUES ('titled', 'A title', 'waiting'), ('untitled', NULL, 'waiting')",
  ).run();
  const row = db.prepare(
    "INSERT INTO approvals(kind, category, task_id, summary, status) VALUES ('request', 'c', ?, '{}', 'zz')",
  );
  const id = (t: string | null) => Number(row.run(t).lastInsertRowid);
  const title = (rows: { id: number; task_title?: string }[], n: number) => rows.find((r) => r.id === n)?.task_title;
  const [a, b, c] = [id("titled"), id("untitled"), id(null)];
  const rows = (await call("approval.list", { status: "zz" }, owner)) as { id: number; task_title?: string }[];
  assert.equal(title(rows, a), "A title");
  assert.equal(title(rows, b), "untitled");
  assert.equal(title(rows, c), undefined);
  assert.equal(((await call("approval.get", { id: a }, owner)) as { task_title: string }).task_title, "A title");
});

test("credential.list: the durable grant, never a value; its writes say so on the bus; credential.set validates hosts", async () => {
  const db = ctx.db;
  const grant = db
    .prepare(
      "INSERT INTO approvals(kind, category, task_id, summary, status) VALUES ('grant', 'credential:slack', ?, '{}', 'approved')",
    )
    .run(null);
  let list = (await call("credential.list", {}, owner)) as Record<string, unknown>[];
  assert.ok(list.some((c) => c.name === "slack" && c.type === "token" && c.transform === "slack"));
  assert.equal(list.find((c) => c.name === "slack")?.enabled, true);
  assert.equal(list.find((c) => c.name !== "slack")?.enabled, false);
  assert.ok(!JSON.stringify(list).includes("xoxb-real"));
  db.prepare("DELETE FROM approvals WHERE id = ?").run(grant.lastInsertRowid);
  list = (await call("credential.list", {}, owner)) as Record<string, unknown>[];
  assert.equal(list.find((c) => c.name === "slack")?.enabled, false);
  let saved = 0;
  const count = () => saved++;
  bus.on("settings", count);
  await call("credential.set", { name: "gone", type: "token", value: "v" }, owner);
  await call("credential.delete", { name: "gone" }, owner);
  bus.off("settings", count);
  assert.equal(saved, 2);
  await assert.rejects(
    call("credential.set", { name: "x", type: "token", value: "v", hosts: ["bad host"] }, owner),
    /invalid|hostname/i,
  );
  await call(
    "credential.set",
    { name: "ollama-cloud", type: "token", value: "ol-secret-1", transform: "openai", hosts: ["ollama.com"] },
    owner,
  );
  assert.equal(transforms.byHost("ollama.com")?.credential, "ollama-cloud");
});

test("credential.set: a rotation keeps what the form left empty; a new value replaces the old in the scrubber", async () => {
  await call("credential.set", { name: "ollama-cloud", type: "token", value: "ol-secret-2" }, owner);
  assert.deepEqual(readVault()["ollama-cloud"], {
    transform: "openai",
    hosts: ["ollama.com"],
    type: "token",
    value: "ol-secret-2",
  });
  assert.equal(transforms.byHost("ollama.com")?.credential, "ollama-cloud");
  assert.equal(scrubber().text("x ol-secret-2 y"), "x hortus-secret-ollama-cloud y");
  assert.equal(scrubber().text("x ol-secret-1 y"), "x ol-secret-1 y");
  await call("credential.set", { name: "ollama-cloud", type: "token", value: "ol-secret-2", hosts: ["a.test"] }, owner);
  assert.deepEqual(readVault()["ollama-cloud"]?.hosts, ["a.test"], "what the form does send replaces");
});

test("a minted token is not reused past a new key or a delete, stays scrubbed, and leaves the set once dead", async () => {
  mint("ollama-cloud#k", "minted-token-0001", 60_000);
  await call("credential.set", { name: "ollama-cloud", type: "token", value: "ol-secret-3" }, owner);
  assert.ok((minted.get("ollama-cloud#k")?.expires ?? Infinity) <= Date.now());
  assert.equal(scrubber().find("minted-token-0001"), "hortus-secret-ollama-cloud");
  mint("ollama-cloud#dead", "minted-token-0002", -2000);
  mint("ollama-cloud#live", "minted-token-0003", 1000);
  assert.equal(minted.has("ollama-cloud#dead"), false);
  assert.equal(scrubber().find("minted-token-0002"), undefined);
  assert.equal(scrubber().find("minted-token-0003"), "hortus-secret-ollama-cloud");
  await call("credential.delete", { name: "ollama-cloud" }, owner);
  assert.ok((minted.get("ollama-cloud#live")?.expires ?? Infinity) <= Date.now());
});

test("a one-off token keeps its place in the scrub set when an older one leaves it", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  await call(
    "credential.set",
    { name: "app", type: "github-app", appId: 1, installationId: 2, privateKey: pem },
    owner,
  );
  let n = 0;
  const f = mock.method(
    globalThis,
    "fetch",
    async () => new Response(JSON.stringify({ token: `one-off-token-${++n}` })),
  );
  try {
    mint("app#dead", "dead-token-0001", -60 * 60_000);
    await installationToken("app", ["r"], {});
    await installationToken("app", ["r"], {});
  } finally {
    f.mock.restore();
  }
  assert.equal(scrubber().find("one-off-token-1"), "hortus-secret-app");
  assert.equal(scrubber().find("one-off-token-2"), "hortus-secret-app");
  await call("credential.delete", { name: "app" }, owner);
});

test("a credential deleted and added again asks for its grant again; an unrelated grant stays", async () => {
  const grant = ctx.db.prepare(
    "INSERT INTO approvals(kind, category, hash, status) VALUES ('grant', ?, ?, 'approved') RETURNING id",
  );
  await call("credential.set", { name: "again", type: "token", value: "first-key-0001" }, owner);
  grant.get("credential:again", "grant:again");
  grant.get("credential:other", "grant:other");
  assert.equal(gate.granted("credential:again", null), true);
  await call("credential.delete", { name: "again" }, owner);
  assert.equal(gate.granted("credential:again", null), false);
  assert.equal(gate.granted("credential:other", null), true);
});

test("the session's own model credential: no gate, placeholders in its body (the conversation) pass", async () => {
  const prev = ctx.config.worker.provider;
  ctx.config.worker.provider = "gh";
  try {
    const n = approvals();
    const body = JSON.stringify({
      messages: [{ role: "user", content: "curl -H 'Bearer hortus-secret-slack' → Bearer {secret:slack}" }],
    });
    const r = await send({
      host: "api.gh.test",
      method: "POST",
      path: "/llm",
      headers: { authorization: "Bearer hortus-secret-gh" },
      body,
    });
    assert.equal(r.status, 200, r.body);
    assert.equal(seen.at(-1)?.auth, "Bearer ghp-fake-0123");
    assert.equal(seen.at(-1)?.body, body, "sent as is");
    assert.equal(approvals(), n);
    // a body the proxy streams is no act of the session's either: an odd type, a 2 MB context, a word that looks like a
    // method override in it
    for (const [type, text] of [
      ["application/octet-stream", "_method=PUT"],
      ["application/x-ndjson", "x".repeat(2 * 1024 * 1024)],
      ["text/plain", "_method=PUT"],
    ] as const) {
      const r = await send({
        host: "api.gh.test",
        method: "POST",
        path: "/llm",
        headers: { authorization: "Bearer hortus-secret-gh", "content-type": type, "content-length": `${text.length}` },
        body: text,
      });
      assert.equal(r.status, 200, `${type}: ${r.body}`);
      assert.equal(seen.at(-1)?.body, text);
    }
    assert.equal(approvals(), n);
    // any other credential still passes the gate
    const s = await send({
      host: "slack.com",
      method: "POST",
      path: "/api/chat.postMessage",
      headers: slackAuth,
      body: "{}",
    });
    assert.equal(s.status, 403);
    assert.match(s.body, /approval/);
  } finally {
    ctx.config.worker.provider = prev;
  }
});

test("a task's model calls are counted at the proxy, streamed or not, and end at its budget plus one context", async () => {
  const prev = ctx.config.worker.provider;
  ctx.config.worker.provider = "gh";
  const row = () => ctx.db.prepare("SELECT metered FROM tasks WHERE id = 'T'").get() as { metered: number };
  const model = (kind: string) =>
    send({
      host: "api.gh.test",
      method: "POST",
      path: `/model/${kind}`,
      headers: { authorization: "Bearer hortus-secret-gh" },
      body: "{}",
    });
  const charged = async (kind: string) => {
    const before = row().metered;
    assert.equal((await model(kind)).status, 200);
    await until(() => row().metered !== before, 2000, kind);
    await sleep(20);
    return row().metered - before;
  };
  try {
    assert.equal(await charged("json"), 120, "as core adds them: input + output");
    assert.equal(await charged("openai"), 10 + 6 + 7, "cache reads count at CACHED_WEIGHT");
    assert.equal(
      await charged("anthropic"),
      5 + 5 + 9,
      "cache reads at CACHED_WEIGHT; output is the last, cumulative figure",
    );
    assert.equal(await charged("cut"), 35, "a stream cut before its last usage: a token a delta at least");
    assert.equal(await charged("none"), Math.ceil((2 + 29) / 4), "no usage in a body: its bytes, request and response");
    assert.ok((await charged("ndjson")) >= 1300, "Ollama's native stream on the same key is counted too");
    // a refusal generated nothing: its prompt is not charged (at each retry of a rate limit)
    const r0 = row().metered;
    const limited = await send({
      host: "api.gh.test",
      method: "POST",
      path: "/model/limited",
      headers: { authorization: "Bearer hortus-secret-gh" },
      body: "x".repeat(40_000),
    });
    assert.equal(limited.status, 429);
    await sleep(50);
    assert.ok(row().metered - r0 <= 10, `a 429 charged ${row().metered - r0}`);
    assert.ok((await charged("silent")) >= 1000, "a stream that reports nothing is counted by its bytes");
    // another credential, or an uncredentialed call to the same host, is nobody's model spend
    const n = row().metered;
    await send({ host: "api.gh.test", path: "/model/json" });
    assert.equal(row().metered, n);
    // live 2026-11-06: core's contextWindow lists the models at every session's start, ~5.4k "tokens" by its bytes, so
    // a quiet schedule run that called no model was charged that each firing and never deleted
    const auth = { authorization: "Bearer hortus-secret-gh" };
    const list = await send({ host: "api.gh.test", path: "/model/none", headers: auth });
    assert.equal(list.status, 200);
    await sleep(20);
    assert.equal(row().metered, n, "a GET generates nothing");
    // but it fetches what a background call generated (OpenAI's `GET /v1/responses/<id>`): its usage counts
    assert.equal((await send({ host: "api.gh.test", path: "/model/json", headers: auth })).status, 200);
    await until(() => row().metered !== n, 2000, "a GET's usage");
    assert.equal(row().metered - n, 120);
    ctx.db.prepare("UPDATE tasks SET metered = ? WHERE id = 'T'").run(n);
    const budget = ctx.db.prepare("SELECT budget FROM tasks WHERE id = 'T'").get() as { budget: string | null };
    // T is a chat, which has no token limit: as an unattended task first
    ctx.db
      .prepare("UPDATE tasks SET budget = ?, kind = 'unattended' WHERE id = 'T'")
      .run(JSON.stringify({ tokens: 10, hours: 1 }));
    ctx.db.prepare("UPDATE tasks SET metered = ? WHERE id = 'T'").run(10 + ctx.config.worker.context_window - 1);
    assert.equal((await model("none")).status, 200, "the agent's summary call, past its own stop");
    ctx.db.prepare("UPDATE tasks SET metered = metered + 1 WHERE id = 'T'").run();
    const over = await model("json");
    assert.equal(over.status, 403);
    assert.match(over.body, /budget exceeded/);
    ctx.db.prepare("UPDATE tasks SET kind = 'chat' WHERE id = 'T'").run();
    assert.equal((await model("json")).status, 200, "a chat has no token limit");
    ctx.db.prepare("UPDATE tasks SET kind = 'unattended' WHERE id = 'T'").run();
    // what its schedules' runs spent is its own: a session after them gets what is left, not the budget again
    const cw = ctx.config.worker.context_window;
    ctx.db
      .prepare("UPDATE tasks SET metered = 0, usage = ? WHERE id = 'T'")
      .run(JSON.stringify({ tokens: 10 + cw, runs: 10 + cw }));
    assert.equal((await model("json")).status, 403, "its runs' tokens count");
    ctx.db.prepare("UPDATE tasks SET usage = NULL WHERE id = 'T'").run();
    ctx.db.prepare("UPDATE tasks SET budget = ?, metered = 0, kind = 'chat' WHERE id = 'T'").run(budget.budget);
  } finally {
    ctx.config.worker.provider = prev;
  }
});

test("a Worker's dollars: each token type at its model's rate, the budget's line, and no line for a model with no price", async () => {
  const { prices } = ctx.config;
  const { provider, model: workerModel } = ctx.config.worker;
  ctx.config.worker.provider = "gh";
  ctx.config.worker.model = "m";
  const spent = () => (ctx.db.prepare("SELECT metered_usd AS n FROM tasks WHERE id = 'T'").get() as { n: number }).n;
  const call = (kind: string) =>
    send({
      host: "api.gh.test",
      method: "POST",
      path: `/model/${kind}`,
      headers: { authorization: "Bearer hortus-secret-gh" },
      body: "{}",
    });
  const charged = async (kind: string) => {
    const before = spent();
    assert.equal((await call(kind)).status, 200);
    await until(() => spent() !== before, 2000, kind);
    await sleep(20);
    return spent() - before;
  };
  const close = (a: number, b: number, why: string) => assert.ok(Math.abs(a - b) < 1e-9, `${why}: ${a}, not ${b}`);
  const budget = ctx.db.prepare("SELECT budget FROM tasks WHERE id = 'T'").get() as { budget: string | null };
  const before = spent();
  try {
    // a million tokens at these rates cost this many dollars
    ctx.config.prices = {
      gh: {
        m: { input: 1e6, cached: 1e5, cache_write: 2e6, output: 1e7 },
        other: { input: 1, cached: 1, output: 1 },
      },
      // one model at another host, and rates far above: neither is what this provider's calls cost
      elsewhere: { other: { input: 9e9, cached: 9e9, output: 9e9 }, dear: { input: 9e9, cached: 9e9, output: 9e9 } },
    };
    close(await charged("priced"), 3 + 1 + 2 * 2 + 5 * 10 + 7 * 0, "a stream of model m");
    close(await charged("other"), (100 + 20) / 1e6, "a response of a model with its own rates");
    close(await charged("json"), 100 + 20 * 10, "no model named: the highest rates listed");
    close(await charged("none"), Math.ceil((2 + 29) / 4), "no usage at all: its bytes as input, at the highest");

    ctx.db
      .prepare("UPDATE tasks SET budget = ?, kind = 'unattended', metered_usd = ? WHERE id = 'T'")
      .run(JSON.stringify({ usd: 10, hours: 1 }), 10 + ctx.config.worker.context_window - 1);
    assert.equal((await call("none")).status, 200, "the agent's summary call, past its own stop");
    ctx.db.prepare("UPDATE tasks SET metered_usd = metered_usd + 1000 WHERE id = 'T'").run();
    const over = await call("json");
    assert.equal(over.status, 403);
    assert.match(over.body, /budget exceeded: \$\d+\.\d\d\/\$10 through the proxy/);

    // the owner took the price away: whatever the row says, nothing stops it but its hours, and nothing is counted
    ctx.config.prices = {
      gh: { other: { input: 1, cached: 1, output: 1 } },
      elsewhere: { m: { input: 1, cached: 1, output: 1 } },
    };
    const held = spent();
    assert.equal((await call("json")).status, 200, "no line for a model with no price");
    await sleep(50);
    assert.equal(spent(), held);
  } finally {
    ctx.db
      .prepare("UPDATE tasks SET budget = ?, metered_usd = ?, kind = 'chat' WHERE id = 'T'")
      .run(budget.budget, before);
    ctx.config.prices = prices;
    ctx.config.worker.provider = provider;
    ctx.config.worker.model = workerModel;
  }
});

test("a model credential's manifest `consequential` is gated: fine-tuning, deleting, the admin API are no thinking", async () => {
  const prev = ctx.config;
  const vault = readVault();
  writeVault({ ...vault, llm: { type: "token", value: "sk-model", transform: "openai", hosts: ["models.test"] } });
  ctx.config = Config.parse({ ...prev, worker: { provider: "llm", model: "m" } });
  try {
    const call = (method: string, path: string) =>
      send({
        host: "models.test",
        method,
        path,
        headers: { authorization: "Bearer hortus-secret-llm", "content-length": "2" },
        body: "{}",
      });
    const n = approvals();
    assert.equal((await call("POST", "/v1/chat/completions")).status, 200);
    assert.equal(approvals(), n);
    for (const [m, p] of [
      ["POST", "/v1/fine_tuning/jobs"],
      ["DELETE", "/v1/files/f1"],
      ["POST", "/v1/organization/admin_api_keys"],
      // the same key on Ollama's or OpenRouter's own API: a model published to the owner's account, a key, a purchase
      ["POST", "/api/push"],
      ["POST", "/api/create"],
      ["POST", "/api/v1/keys"],
    ] as const) {
      const r = await call(m, p);
      assert.equal(r.status, 403, `${m} ${p}`);
      assert.match(r.body, /approval/);
    }
    assert.equal(approvals(), n + 6);
  } finally {
    ctx.config = prev;
    writeVault(vault);
  }
});

test("a credential without a transform follows only a manifest naming it, never another's same-type entry", async () => {
  const prev = ctx.config.worker.provider;
  writeVault({
    slack: { type: "token", value: "xoxb-real", transform: "slack" },
    gh: { type: "token", value: "ghp-fake-0123", transform: "ghfake" },
    anth: { type: "token", value: "sk-anth-real-1" },
  });
  ctx.config.worker.provider = "anth"; // the model-call bypass must not carry it to another API either
  try {
    const r = await send({
      host: "api.gh.test",
      path: "/user",
      headers: { authorization: "Bearer hortus-secret-anth" },
    });
    assert.equal(r.status, 403);
    assert.match(r.body, /destination/);
  } finally {
    ctx.config.worker.provider = prev;
    writeVault({
      slack: { type: "token", value: "xoxb-real", transform: "slack" },
      gh: { type: "token", value: "ghp-fake-0123", transform: "ghfake" },
    });
  }
});

test("a lookup answered by a session's own DNS is asked again, not refused", async (t) => {
  const answers = [[{ address: "10.77.1.7", family: 4 }], [{ address: "93.184.216.34", family: 4 }]];
  t.mock.method(dnsPromises, "lookup", async () => answers.shift());
  syncBuiltinESMExports();
  try {
    const r = await egress({ role: "worker", task: "T" }, "model.example", true, undefined);
    assert.equal((r as { address: string }).address, "93.184.216.34");
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("'*' egress: IPv4-mapped IPv6 spellings of private addresses are private too", async () => {
  for (const host of ["::ffff:7f00:1", "::ffff:a00:1", "::ffff:127.0.0.1", "64:ff9b::a00:1"]) {
    const t = await egress({ role: "worker", task: "T" }, host, false, undefined);
    assert.ok("status" in t && t.status === 403, host);
  }
  // IPv6 forms that carry or reach a private address, and numeric IPv4 spellings getaddrinfo accepts
  for (const host of [
    "::",
    "::1",
    "::127.0.0.1",
    "fd00::1",
    "fe80::1",
    "ff02::1",
    "::ffff:0:7f00:1",
    "2002:7f00:1::1",
    "2001:0:7f00:1::1",
    "64:ff9b:1::a00:1",
    "2130706433",
    "0x7f.1",
    "017700000001",
    "0177.0.0.1",
    "169.254.169.254",
  ]) {
    const t = await egress({ role: "worker", task: "T" }, host, false, undefined);
    assert.ok("status" in t && t.status === 403, host);
  }
  // and a public address stays public (no IPv4 caught by an IPv6 range)
  for (const host of ["93.184.216.34", "::ffff:5db8:d822", "2606:4700::1111"]) {
    const t = await egress({ role: "worker", task: "T" }, host, false, undefined);
    assert.ok(!("status" in t), host);
  }
});

test("origins: a list never cuts a session off its own model; a stranger's host, or another role, stays refused", async () => {
  const prev = ctx.config;
  const vault = readVault();
  writeVault({ ...vault, llm: { type: "token", value: "sk-x", transform: "openai", hosts: ["models.test"] } });
  ctx.config = Config.parse({ ...prev, worker: { provider: "llm", model: "m" }, origins: ["registry.npmjs.org"] });
  try {
    const task = { scope: null, origins: null, budget: null, metered: 0, spent: 0 };
    const worker = await egress({ role: "worker", task: "T" }, "models.test", true, task);
    assert.equal("status" in worker && worker.status === 403, false);
    const other = await egress({ role: "worker", task: "T" }, "example.com", true, task);
    assert.ok("status" in other && other.status === 403);
    const login = await egress({ role: "login", task: "T" }, "models.test", true, task);
    assert.ok("status" in login && login.status === 403);
  } finally {
    ctx.config = prev;
    writeVault(vault);
  }
});

test("listed origins: a listed name that resolves private is refused too (rebinding); chat.allow admits it", async () => {
  const prev = ctx.config;
  ctx.config = Config.parse({ ...prev, origins: ["localhost", "registry.npmjs.org"] });
  try {
    const t = await egress({ role: "worker", task: "T" }, "localhost", false, undefined);
    assert.ok("status" in t && t.status === 403 && /private address/.test(String(t.body)), JSON.stringify(t));
    ctx.config = Config.parse({ ...ctx.config, chat: { allow: ["127.0.0.0/8", "::1"] } });
    const ok = await egress({ role: "worker", task: "T" }, "localhost", false, undefined);
    assert.ok(!("status" in ok) && ["127.0.0.1", "::1"].includes(ok.address), JSON.stringify(ok));
    // role core (hortusd's own connectors) is the owner: not held to it
    ctx.config = Config.parse({ ...prev, origins: ["localhost"] });
    assert.ok(!("status" in (await egress({ role: "core" }, "localhost", false, undefined))));
  } finally {
    ctx.config = prev;
  }
});

test("handle syntax written by a client is refused: handles come from transforms only", async () => {
  const r = await send({
    host: "api.gh.test",
    path: "/repos/o/r/collaborators/evil",
    method: "PUT",
    headers: { authorization: 'Bearer {sign:installation-token({"name":"gh","admin":true})}' },
  });
  assert.equal(r.status, 403);
  assert.match(r.body, /handle syntax/);
  const b = await send({ host: "slack.com", path: "/api/chat.postMessage", method: "POST", body: "{secret:slack}" });
  assert.equal(b.status, 403);
  assert.match(b.body, /handle syntax/);
});

test("a compressed response (sent despite accept-encoding: identity) is decoded, then scrubbed", async () => {
  const r = await send({ host: "registry.npmjs.org", path: "/gz" });
  assert.equal(r.status, 200);
  assert.equal(r.headers["content-encoding"], undefined);
  assert.equal(JSON.parse(r.body).leaked, "hortus-secret-slack");
});

test("a credential never goes over plain http (outside dev.upstreams)", async () => {
  const prev = ctx.config;
  ctx.config = Config.parse({ ...prev, chat: { allow: ["127.0.0.0/8", "::1"] } });
  writeVault({
    slack: { type: "token", value: "xoxb-real", transform: "slack" },
    gh: { type: "token", value: "ghp-fake-0123", transform: "ghfake" },
    lh: { type: "token", value: "lh-real-value", transform: "lh" },
  });
  try {
    const r = await send({ host: "localhost", tls: false, headers: { authorization: "Bearer hortus-secret-lh" } });
    assert.equal(r.status, 403);
    assert.match(r.body, /plain http/);
  } finally {
    ctx.config = prev;
    writeVault({
      slack: { type: "token", value: "xoxb-real", transform: "slack" },
      gh: { type: "token", value: "ghp-fake-0123", transform: "ghfake" },
    });
  }
});

test("credential.delete refuses a name the config still uses", async () => {
  const prev = ctx.config.worker.provider;
  ctx.config.worker.provider = "gh";
  try {
    await assert.rejects(call("credential.delete", { name: "gh" }, owner), /in use by worker\.provider/);
    assert.ok(readVault().gh);
  } finally {
    ctx.config.worker.provider = prev;
  }
});
