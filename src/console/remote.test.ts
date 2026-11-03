import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { TLSSocket } from "node:tls";
import { load } from "../config.ts";
import type { Ctx } from "../ctx.ts";
import { openDb } from "../db.ts";
import { logger } from "../log.ts";
import * as paths from "../paths.ts";
import { call } from "../rpc.ts";
import { remoteConsole } from "../runtime/net.ts";
import { tempDir } from "../test/until.ts";
import { SoftAuthenticator } from "../test/webauthn.ts";
import { caCert } from "../vault/ca.ts";
import { consoleModule, consoleUrl } from "./index.ts";
import { encode } from "./qr.ts";
import { hourly, parseListen, startRemote, stopRemote } from "./remote.ts";

process.env.HORTUS_HOME = tempDir("hortus-remote-");
process.env.HORTUS_CONSOLE_PORT = "0";
const HOST = "console.test";
const ctx: Ctx = {
  config: { ...load(), console: { listen: "127.0.0.1:0", host: HOST } },
  db: openDb(paths.db()),
  paths,
  log: logger,
  async reload() {},
};
let port = 0;
let origin = "";

before(async () => {
  await consoleModule.start(ctx);
  origin = consoleUrl();
  port = Number(new URL(origin).port);
});
after(() => consoleModule.stop());

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  cert?: ReturnType<TLSSocket["getPeerCertificate"]>;
}

function remote(
  path: string,
  opts: { method?: string; body?: unknown; cookie?: string; host?: string; ca?: string | Buffer } = {},
): Promise<Res> {
  const post = opts.method === "POST" || opts.body !== undefined;
  const headers: Record<string, string> = { host: opts.host ?? `${HOST}:${port}` };
  if (post) Object.assign(headers, { "x-hortus": "1", "content-type": "application/json" });
  if (opts.cookie) headers.cookie = `__Host-hortus=${opts.cookie}`;
  return new Promise((resolve, reject) => {
    const r = httpsRequest(
      {
        host: "127.0.0.1",
        port,
        servername: HOST,
        ca: opts.ca ?? readFileSync(caCert()),
        path,
        method: post ? "POST" : "GET",
        headers,
        agent: false,
      },
      (res) => {
        const cert = (res.socket as TLSSocket).getPeerCertificate();
        let b = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (b += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: b, cert }));
      },
    );
    r.on("error", reject);
    r.end(post ? JSON.stringify(opts.body ?? {}) : undefined);
  });
}

function loopback(path: string): Promise<Res> {
  const lp = consoleModule.port();
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port: lp, path, headers: { host: `127.0.0.1:${lp}` } }, (res) => {
      let b = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: b }));
    });
    r.on("error", reject);
    r.end();
  });
}

const json = (r: Res) => JSON.parse(r.body);
const token = (r: Res): string => {
  const c = [r.headers["set-cookie"] ?? []].flat()[0] ?? "";
  return /^__Host-hortus=([^;]+)/.exec(c)?.[1] ?? "";
};
const isLogin = (r: Res) => r.body.includes("Sign in with passkey") && !r.body.includes("<nav>");
const newCode = async () => (await call("enroll.code", {}, { role: "owner" })) as { code: string; url: string };

const auth = () => new SoftAuthenticator(origin);

async function enrol(a: SoftAuthenticator, device = "phone"): Promise<Res> {
  const { code } = await newCode();
  const o = json(await remote("/webauthn/register/options", { body: { code } }));
  return remote("/webauthn/register/verify", { body: { code, device, response: a.create(o) } });
}

async function signIn(a: SoftAuthenticator, rpId?: string): Promise<Res> {
  const o = json(await remote("/webauthn/login/options", { body: {} }));
  return remote("/webauthn/login/verify", { body: { response: a.get(o, { rpId }) } });
}

test("without the cookie: the login page, 401 for the API and SSE", async () => {
  const home = await remote("/");
  assert.equal(home.status, 200);
  assert.ok(isLogin(home));
  assert.match(home.headers["content-security-policy"] as string, /script-src 'self'/);
  assert.ok(isLogin(await remote("/settings")));
  const api = await remote("/api/task.list", { body: {} });
  assert.equal(api.status, 401);
  assert.ok(isLogin(api));
  assert.equal((await remote("/events/chat?task=t1")).status, 401);
  assert.equal((await remote("/static/webauthn.js")).status, 200);
  assert.ok(isLogin(await remote("/static/app.js")));
  assert.ok(isLogin(await remote("/enroll?code=nope")));
  assert.equal((await remote("/", { cookie: "forged" })).body.includes("<nav>"), false);
});

test("guards: Host must be console.host with the port", async () => {
  assert.equal((await remote("/", { host: `127.0.0.1:${port}` })).status, 421);
  assert.equal((await remote("/", { host: HOST })).status, 421);
});

test("TLS: without console.tls the leaf is minted from the hortus CA for console.host", async () => {
  const r = await remote("/");
  assert.equal(r.cert?.subjectaltname, `DNS:${HOST}`);
  assert.equal(r.cert?.issuer.CN, "hortus CA");
});

test("enrolment: a live code, a passkey row, a session; the code is single use and expires", async () => {
  const { code, url } = await newCode();
  assert.equal(url, `${origin}/enroll?code=${code}`);
  const page = await remote(`/enroll?code=${code}`);
  assert.equal(page.status, 200);
  assert.match(page.body, /Create passkey/);

  const a = auth();
  const o = json(await remote("/webauthn/register/options", { body: { code } }));
  assert.equal(o.rp.id, HOST);
  assert.equal(o.attestation, "none");
  const r = await remote("/webauthn/register/verify", { body: { code, device: "phone", response: a.create(o) } });
  assert.equal(r.status, 200, r.body);
  const cookie = [r.headers["set-cookie"]].flat()[0] as string;
  assert.match(cookie, /^__Host-hortus=[\w-]{43}; /);
  for (const attr of ["Secure", "HttpOnly", "SameSite=Strict", "Path=/"]) assert.ok(cookie.includes(`; ${attr}`), attr);
  assert.doesNotMatch(cookie, /Domain=/);
  const row = ctx.db.prepare("SELECT * FROM passkeys").get() as { device: string; transports: string };
  assert.equal(row.device, "phone");
  assert.deepEqual(JSON.parse(row.transports), ["internal"]);
  const tasks = await remote("/", { cookie: token(r) });
  assert.match(tasks.body, /<nav>/);

  // used: the page is the login page, a second ceremony is refused
  assert.ok(isLogin(await remote(`/enroll?code=${code}`)));
  assert.equal((await remote("/webauthn/register/options", { body: { code } })).status, 400);
  assert.equal(
    (await remote("/webauthn/register/verify", { body: { code, device: "x", response: auth().create(o) } })).status,
    400,
  );

  // expired
  const late = await newCode();
  ctx.db.prepare("UPDATE enroll_codes SET expires_at = ?").run(new Date(Date.now() - 1000).toISOString());
  assert.ok(isLogin(await remote(`/enroll?code=${late.code}`)));
});

test("login: a correct assertion signs in; replay, stale counter, wrong RP ID or origin are refused", async () => {
  const a = auth();
  assert.equal((await enrol(a, "laptop")).status, 200);
  const r = await signIn(a);
  assert.equal(r.status, 200, r.body);
  assert.match((await remote("/", { cookie: token(r) })).body, /<nav>/);
  const used = ctx.db.prepare("SELECT counter FROM passkeys WHERE device = 'laptop'").get() as { counter: number };
  assert.equal(used.counter, 1);

  // the same assertion again: its challenge is spent
  const o = json(await remote("/webauthn/login/options", { body: {} }));
  const assertion = a.get(o);
  assert.equal((await remote("/webauthn/login/verify", { body: { response: assertion } })).status, 200);
  assert.equal((await remote("/webauthn/login/verify", { body: { response: assertion } })).status, 400);

  // a fresh challenge but a counter that did not increase
  a.counter -= 1;
  const stale = await signIn(a);
  assert.equal(stale.status, 400);
  assert.match(json(stale).error.message, /could not be verified/);
  a.counter += 5;

  assert.equal((await signIn(a, "evil.test")).status, 400);
  a.origin = "https://evil.test";
  assert.equal((await signIn(a)).status, 400);
  a.origin = origin;
  assert.equal((await signIn(a)).status, 200);
});

test("enroll.code is loopback only; session.revoke makes the revoked session's next request 401", async () => {
  const one = token(await enrol(auth(), "one"));
  const two = token(await enrol(auth(), "two"));
  const forbidden = await remote("/api/enroll.code", { body: {}, cookie: one });
  assert.equal(forbidden.status, 403);

  const list = json(await remote("/api/session.list", { body: {}, cookie: one })).result as {
    id: string;
    device: string;
    current: boolean;
    address: string;
  }[];
  const mine = list.find((s) => s.current);
  assert.equal(mine?.device, "one");
  assert.equal(mine?.address, "127.0.0.1");
  const other = list.find((s) => s.device === "two");
  assert.ok(other);
  assert.equal((await remote("/api/session.list", { body: {}, cookie: two })).status, 200);
  assert.equal((await remote("/api/session.revoke", { body: { id: other.id }, cookie: one })).status, 200);
  assert.equal((await remote("/api/session.list", { body: {}, cookie: two })).status, 401);

  // the remote Settings page: sessions, no enrolment code
  const settings = await remote("/settings", { cookie: one });
  assert.match(settings.body, /this one/);
  assert.match(settings.body, /made at the machine/);
});

test("idle sessions: last_seen is touched at most once a minute; 31 days idle → deleted by the hourly sweep", async () => {
  const t = token(await enrol(auth(), "idle"));
  const seen = () =>
    (ctx.db.prepare("SELECT last_seen FROM console_sessions WHERE device = 'idle'").get() as { last_seen: string })
      ?.last_seen;
  const old = new Date(Date.now() - 5 * 60_000).toISOString();
  ctx.db.prepare("UPDATE console_sessions SET last_seen = ? WHERE device = 'idle'").run(old);
  await remote("/", { cookie: t });
  const touched = seen() as string;
  assert.notEqual(touched, old);
  await remote("/", { cookie: t });
  assert.equal(seen(), touched);

  ctx.db
    .prepare("UPDATE console_sessions SET last_seen = ? WHERE device = 'idle'")
    .run(new Date(Date.now() - 31 * 86400e3).toISOString());
  hourly();
  assert.equal(seen(), undefined);
  assert.ok(isLogin(await remote("/", { cookie: t })));
});

test("loopback: no cookie needed; Settings shows the code, its URL and the QR", async () => {
  const { url } = await newCode();
  const r = await loopback("/settings");
  assert.equal(r.status, 200);
  assert.ok(r.body.includes(url));
  assert.match(r.body, /<svg [^>]*aria-label="QR code"/);
  assert.match(r.body, /data-expires=/);
});

test("console.tls: the configured chain is served, a world-readable key warns, a changed file is re-read", async () => {
  const dir = tempDir("hortus-tls-");
  const mint = (name: string) => {
    execFileSync(
      "openssl",
      [
        ...["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-days", "2"],
        ...["-subj", `/CN=${name}`, "-addext", `subjectAltName=DNS:${HOST}`],
        ...["-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")],
      ],
      { stdio: "ignore" },
    );
    chmodSync(join(dir, "key.pem"), 0o644);
    return readFileSync(join(dir, "cert.pem"));
  };
  const first = mint("first");
  await stopRemote();
  const lines: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((s: string) => lines.push(String(s)) > 0) as typeof process.stderr.write;
  try {
    ctx.config = {
      ...ctx.config,
      console: {
        listen: `127.0.0.1:${port}`,
        host: HOST,
        tls: { cert: join(dir, "cert.pem"), key: join(dir, "key.pem") },
      },
    };
    await startRemote(ctx);
  } finally {
    process.stderr.write = write;
  }
  assert.ok(lines.some((l) => l.includes("world-readable")));
  assert.equal(remoteConsole.port, port);
  assert.equal((await remote("/", { ca: first })).cert?.subject.CN, "first");

  await new Promise((r) => setTimeout(r, 20));
  const second = mint("second");
  hourly();
  assert.equal((await remote("/", { ca: second })).cert?.subject.CN, "second");
});

test("parseListen", () => {
  assert.deepEqual(parseListen("0.0.0.0:7443"), { address: "0.0.0.0", port: 7443 });
  assert.deepEqual(parseListen("[::]:7443"), { address: "::", port: 7443 });
  assert.deepEqual(parseListen(":7443"), { port: 7443 });
  assert.throws(() => parseListen("host:x"));
});

// vectors from qrencode 4.1.1 (`qrencode -8 -l M -m 0 -t ASCII`): [text, its mask, sha256 of the rows as 0/1 lines]
const VECTORS: [string, number, string][] = [
  ["hello", 7, "683921f56b2988dd454e5f08cc85d949682bd846d510fe13aa028a95d1427918"],
  [
    "https://console.example:7443/enroll?code=abcdefghij",
    2,
    "50bcc9179ce421ca264f992e79e5a9ea43eb923504e22dc9bffaa497e003cdf7",
  ],
  [
    "https://hortus.home.arpa:7443/enroll?code=Zq3vX9_kLmN0pQrStUvWxYz012345678",
    3,
    "0e0678243cc69fc87fa795e7a983df62ac54bb437d032fd1cf45ae1f6efad84c",
  ],
  ["A".repeat(100), 1, "d4240e8b8f4b89cc46c078c7de2b8c386c48f2bab9b853c555c17f97a0e0ef69"],
  ["b".repeat(150), 2, "e6ad2dbcbdf15b1e31307d8a976520e9df6989b9176e5be5db8488fd6130ed1a"],
  ["€".repeat(70), 0, "29785eb8e7992af507e79b7ea2edcaee9a5d2857ccfebc13252a68dff76481e9"],
  ["z".repeat(213), 1, "f6862dc828d614e511c1aea5f5a112d3daed5599ae635fd3e675eb5a0f04fc3a"],
];

const rows = (m: boolean[][]) => m.map((r) => r.map((b) => (b ? "1" : "0")).join("")).join("\n");

test("QR: byte mode, level M, versions 1–10 against qrencode", async () => {
  const { createHash } = await import("node:crypto");
  const hello = [
    "111111100110001111111",
    "100000100110001000001",
    "101110100100101011101",
    "101110100011001011101",
    "101110100110101011101",
    "100000101001101000001",
    "111111101010101111111",
    "000000000001100000000",
    "100101101100010100000",
    "001011000010001000011",
    "000110111100110001101",
    "111011001001000001011",
    "011010110010101010000",
    "000000001101000110101",
    "111111100010010101110",
    "100000101011110110000",
    "101110100001001110001",
    "101110101101000101111",
    "101110100110100010101",
    "100000100110011000000",
    "111111101111100101010",
  ];
  assert.equal(rows(encode("hello", 7)), hello.join("\n"));
  for (const [text, mask, hash] of VECTORS)
    assert.equal(
      createHash("sha256")
        .update(rows(encode(text, mask)))
        .digest("hex"),
      hash,
      text.slice(0, 20),
    );
  // the penalty picks the same mask as qrencode for most inputs (it may differ: both are valid codes)
  assert.equal(
    createHash("sha256")
      .update(rows(encode(VECTORS[1]?.[0] as string)))
      .digest("hex"),
    VECTORS[1]?.[2],
  );
  assert.equal(encode("x".repeat(213)).length, 57);
  assert.throws(() => encode("x".repeat(214)));
});
