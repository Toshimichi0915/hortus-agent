/**
 * Real clients through the real proxy: curl's multipart uploads, the messengers' upload flows, and
 * package-manager fetches, on a session address with a fake upstream behind dev.upstreams.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import nodeHttps from "node:https";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { createGzip } from "node:zlib";
import { jar } from "../browser/jar.ts";
import { Config } from "../config.ts";
import type { Ctx } from "../ctx.ts";
import { openDb, taintOf } from "../db.ts";
import { logger } from "../log.ts";
import * as paths from "../paths.ts";
import { tempDir } from "../test/until.ts";
import { caCert } from "../vault/ca.ts";
import { gate, transforms, vaultModule } from "../vault/index.ts";
import { write as writeVault } from "../vault/vault.ts";
import { links, listen, proxyModule } from "./index.ts";
import { hashTemplate } from "./pipeline.ts";

process.env.HORTUS_HOME = tempDir("hortus-clients-");
const run = promisify(execFile);
const ADDR = "127.0.0.6";
const HOSTS = ["api.telegram.org", "discord.com", "slack.com", "files.slack.com", "registry.test", "cdn.test"];

interface Seen {
  host: string;
  method: string;
  url: string;
  auth?: string;
  ct?: string;
  body: Buffer;
}
const seen: Seen[] = [];

const fake = http.createServer((req, res) => {
  const c: Buffer[] = [];
  req.on("data", (d: Buffer) => c.push(d));
  req.on("end", () => {
    const u = req.url ?? "/";
    seen.push({
      host: req.headers.host ?? "",
      method: req.method ?? "",
      url: u,
      auth: req.headers.authorization,
      ct: req.headers["content-type"],
      body: Buffer.concat(c),
    });
    const json = (v: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(v));
    };
    if (u.startsWith("/api/files.getUploadURLExternal"))
      return json({ ok: true, upload_url: "https://files.slack.com/upload/v1/opaque", file_id: "F1" });
    if (u.startsWith("/upload/v1/")) {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end(`OK - ${Buffer.concat(c).length}`);
    }
    // a slow mirror: the first bytes, then nothing yet
    if (u.startsWith("/held")) {
      res.writeHead(200, { "content-type": u.endsWith(".whl") ? "application/x-wheel" : "application/octet-stream" });
      return void res.write(Buffer.alloc(64 * 1024, "a"));
    }
    if (u === "/cookie" || u === "/cookie?rotate") {
      const v = u === "/cookie" ? "real-cookie-value" : "rotated-value";
      res.writeHead(200, { "content-type": "text/plain", "set-cookie": `sid=${v}; Path=/` });
      return res.end(v);
    }
    // a rolling session: every response sets the cookie again, and its hour starts over
    if (u === "/roll") {
      res.writeHead(200, { "content-type": "text/plain", "set-cookie": "roll=rolling-cookie-value; Max-Age=3600" });
      return res.end("ok");
    }
    // a login page: gzipped, the cookie echoed in the body and cut in two by a flush
    if (u === "/login") {
      res.writeHead(200, {
        "content-type": "text/html",
        "content-encoding": "gzip",
        "set-cookie": "sid=login-cookie-value; Path=/",
      });
      const z = createGzip();
      z.pipe(res);
      z.write("<p>login-coo");
      return void z.flush(() => setTimeout(() => z.end("kie-value</p>"), 50));
    }
    if (u === "/cut") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("the first half");
      return void setTimeout(() => res.destroy(), 50);
    }
    json({ ok: true, result: { message_id: 1, chat: { id: 5 } } });
  });
});

let https = 0;
let ctx: Ctx;
const dir = tempDir("hortus-clients-files-");

before(async () => {
  process.env.HORTUS_NO_NET = "1";
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  ctx = {
    config: Config.parse({
      dev: { upstreams: Object.fromEntries(HOSTS.map((h) => [h, url])) },
      proxy: { https: 0, http: 0, dns: 0 },
    }),
    db: openDb(paths.db()),
    paths,
    log: logger,
    reload: async () => {},
  };
  writeVault({
    telegram: { type: "token", value: "123:telegram-real", transform: "telegram" },
    discord: { type: "token", value: "discord-real-token", transform: "discord" },
    slack: { type: "token", value: "xoxb-slack-real", transform: "slack" },
  });
  ctx.db
    .prepare("INSERT INTO tasks(id, kind, status, scope, origins) VALUES ('T', 'chat', 'running', ?, ?)")
    .run(JSON.stringify({ credentials: ["telegram", "discord", "slack"], repos: [] }), JSON.stringify("*"));
  await vaultModule.start(ctx);
  await proxyModule.start(ctx);
  await transforms.load([transforms.shippedDir()]);
  links.register(ADDR, "worker", "T", "session");
  ({ https } = await listen(ADDR, { https: 0, http: 0, dns: 0 }));
});

after(async () => {
  await proxyModule.stop();
  await vaultModule.stop();
  fake.close();
  fake.closeAllConnections();
});

/** curl as the Worker: the host resolves to its session address. */
async function curl(host: string, path: string, ...args: string[]): Promise<{ status: number; body: string }> {
  const { stdout } = await run(
    "curl",
    [
      "-sS",
      "--max-time",
      "60",
      "--cacert",
      caCert(),
      "--resolve",
      `${host}:${https}:${ADDR}`,
      "-w",
      "\n%{http_code}",
      ...args,
      `https://${host}:${https}${path}`,
    ],
    { maxBuffer: 256 * 1024 * 1024 },
  );
  const i = stdout.lastIndexOf("\n");
  return { status: Number(stdout.slice(i + 1)), body: stdout.slice(0, i) };
}

/** Runs `f`, approves what it asks, runs it again; the client's own retry is a new curl, as a Worker's is. */
async function untilPassed(f: () => Promise<{ status: number; body: string }>) {
  let r = await f();
  for (let i = 0; i < 3 && r.status === 403 && r.body.startsWith("{"); i++) {
    gate.decide(JSON.parse(r.body).approval, "approve", "owner");
    r = await f();
  }
  return r;
}

const text = join(dir, "notes.txt");
const binary = join(dir, "photo.bin");
writeFileSync(text, "notes for the owner\n");
writeFileSync(binary, createHash("sha512").update("x").digest());

test("curl -F: an approved multipart upload passes on the retry, though curl draws a new boundary", async () => {
  for (const [file, name] of [
    [text, "text"],
    [binary, "binary"],
  ] as const) {
    const r = await untilPassed(() =>
      curl("api.telegram.org", "/bothortus-secret-telegram/sendDocument", "-F", "chat_id=5", "-F", `document=@${file}`),
    );
    assert.equal(r.status, 200, `${name}: ${r.body}`);
  }
});

test("a multipart hash: the same upload whatever the boundary, and not another upload or another framing", () => {
  const t = (b: string, body: string) => ({
    method: "POST",
    url: "https://x/y",
    headers: { "content-type": `multipart/form-data; boundary=${b}` },
    body,
    stream: false,
  });
  const form = (b: string, v: string) =>
    `--${b}\r\nContent-Disposition: form-data; name="a"\r\n\r\n${v}\r\n--${b}--\r\n`;
  assert.equal(hashTemplate(t("aaa", form("aaa", "1"))), hashTemplate(t("bbb", form("bbb", "1"))));
  assert.notEqual(hashTemplate(t("aaa", form("aaa", "1"))), hashTemplate(t("bbb", form("bbb", "2"))));
  // `--aaa` in the first is only text in the second: another parse, so another hash
  assert.notEqual(
    hashTemplate(t("aaa", "--aaa\r\n\r\n--bbb--aaa--\r\n")),
    hashTemplate(t("bbb", "--bbb\r\n\r\n--aaa--bbb--\r\n")),
  );
  // a delimiter is a part: the same bytes around it, with and without one, are two forms
  assert.notEqual(
    hashTemplate(t("aaa", "--aaa\r\n\r\nx\r\n--aaa\r\ny\r\n--aaa--\r\n")),
    hashTemplate(t("aaa", "--aaa\r\n\r\nx\r\ny\r\n--aaa--\r\n")),
  );
  // a boundary is framing on its own line, never text: approving "pay XX" with boundary=XX approves no "pay evil"
  const pay = (b: string, to: string) => `--${b}\r\n\r\npay ${to}\r\n--${b}--\r\n`;
  assert.notEqual(hashTemplate(t("XX", pay("XX", "XX"))), hashTemplate(t("evil", pay("evil", "evil"))));
  // a line that only starts like a delimiter is text to every parser: `--to=alice 100` under boundary=to=alice
  const line = (b: string, to: string) => `--${b}\r\n\r\nsend\r\n--to=${to} 100\r\n--${b}--\r\n`;
  const send = (to: string) => t(`to=${to}`, line(`to=${to}`, to));
  assert.notEqual(hashTemplate(send("alice")), hashTemplate(send("mallory")));
  const close = (b: string, to: string) => `--${b}\r\n\r\nsend\r\n--to=${to}--more\r\n--${b}--\r\n`;
  assert.notEqual(hashTemplate(t("to=a", close("to=a", "a"))), hashTemplate(t("to=m", close("to=m", "m"))));
  // a decoy names one boundary here and another to the upstream's parser: nothing is cut
  const decoy = (b: string, to: string) => ({
    ...t("real", `--real\r\n\r\nsend\r\n--${to}\r\n--real--\r\n`),
    headers: { "content-type": `multipart/form-data; ${b}; boundary=real` },
  });
  for (const d of [(x: string) => `x="boundary=${x}"`, (x: string) => `xboundary=${x}`, (x: string) => `boundary=${x}`])
    assert.notEqual(hashTemplate(decoy(d("alice"), "alice")), hashTemplate(decoy(d("mallory"), "mallory")));
  // padding, a preamble and an epilogue hash as they stand; so does each part's filename
  const pad = (b: string, tail: string) => `pre\r\n--${b} \r\n\r\n1\r\n--${b}--${tail}`;
  assert.equal(hashTemplate(t("aaa", pad("aaa", "\r\nend"))), hashTemplate(t("bbb", pad("bbb", "\r\nend"))));
  assert.notEqual(hashTemplate(t("aaa", pad("aaa", "\r\nend"))), hashTemplate(t("bbb", pad("bbb", "\r\nother"))));
  assert.notEqual(hashTemplate(t("aaa", `x${pad("aaa", "")}`)), hashTemplate(t("bbb", `y${pad("bbb", "")}`)));
  const file = (b: string, n: string) =>
    `--${b}\r\nContent-Disposition: form-data; filename="${n}"\r\n\r\n1\r\n--${b}--\r\n`;
  assert.notEqual(hashTemplate(t("aaa", file("aaa", "a.txt"))), hashTemplate(t("bbb", file("bbb", "b.txt"))));
  // quoted, or among other parameters, the upload is still one upload
  const typed = (ct: string, b: string) => ({ ...t(b, form(b, "1")), headers: { "content-type": ct } });
  for (const ct of [
    (b: string) => `multipart/form-data; boundary="${b}"`,
    (b: string) => `multipart/related; type="a/b"; boundary=${b}; charset=utf-8`,
  ])
    assert.equal(hashTemplate(typed(ct("aaa"), "aaa")), hashTemplate(typed(ct("bbb"), "bbb")));
});

test("Discord: a message with an attachment, multipart with payload_json; the token only in the header", async () => {
  seen.length = 0;
  const r = await untilPassed(() =>
    curl(
      "discord.com",
      "/api/v10/channels/9/messages",
      "-H",
      "Authorization: Bot hortus-secret-discord",
      "-F",
      'payload_json={"content":"here"}',
      "-F",
      `files[0]=@${binary}`,
    ),
  );
  assert.equal(r.status, 200, r.body);
  const s = seen.at(-1);
  assert.equal(s?.auth, "Bot discord-real-token");
  assert.ok(s?.body.includes(readFileSync(binary)), "the file arrives whole");
});

test("Slack: getUploadURLExternal, the upload with no credential, completeUploadExternal", async () => {
  seen.length = 0;
  const bearer = ["-H", "Authorization: Bearer hortus-secret-slack"];
  const u = await untilPassed(() =>
    curl("slack.com", "/api/files.getUploadURLExternal?filename=a.bin&length=64", ...bearer),
  );
  assert.equal(u.status, 200, u.body);
  const { upload_url, file_id } = JSON.parse(u.body);
  const path = new URL(upload_url).pathname;
  const up = await curl("files.slack.com", path, "-F", `filename=@${binary}`);
  assert.equal(up.status, 200, up.body);
  const raw = await curl(
    "files.slack.com",
    path,
    "--data-binary",
    `@${binary}`,
    "-H",
    "content-type: application/octet-stream",
  );
  assert.equal(raw.status, 200, raw.body);
  const done = await untilPassed(() =>
    curl(
      "slack.com",
      "/api/files.completeUploadExternal",
      ...bearer,
      "-H",
      "content-type: application/json",
      "-d",
      JSON.stringify({ files: [{ id: file_id }], channel_id: "C1" }),
    ),
  );
  assert.equal(done.status, 200, done.body);
  const uploads = seen.filter((s) => s.url.startsWith("/upload/"));
  assert.equal(uploads.length, 2);
  assert.ok(
    uploads.every((s) => s.auth === undefined),
    "the signed URL needs no token, and none rides",
  );
});

test("an upload over 1 MB (Expect: 100-continue, streamed): waits for the owner, then passes whole", async () => {
  const big = join(dir, "big.bin");
  writeFileSync(big, randomBytes(5 * 1024 * 1024));
  seen.length = 0;
  const r = await untilPassed(() =>
    curl("api.telegram.org", "/bothortus-secret-telegram/sendDocument", "-F", "chat_id=5", "-F", `document=@${big}`),
  );
  assert.equal(r.status, 200, r.body);
  assert.ok(seen.at(-1)?.body.includes(readFileSync(big)), "the file arrives whole");
});

/** The response head and first bytes of a body the upstream has not finished; rejects if they do not come in time. */
function firstBytes(host: string, path: string): Promise<{ headers: http.IncomingHttpHeaders; bytes: number }> {
  return new Promise((resolve, reject) => {
    const req = nodeHttps.get(
      { host: ADDR, port: https, path, servername: host, headers: { host }, ca: readFileSync(caCert()), agent: false },
      (res) => res.once("data", (c: Buffer) => resolve({ headers: res.headers, bytes: c.length })),
    );
    req.on("error", reject);
    req.setTimeout(20_000, () => reject(new Error(`${path}: no byte in 20 s`)));
    open.push(req);
  });
}
const open: http.ClientRequest[] = [];

test("a download reaches the client as it arrives: no transform, or octet-stream (pip reads with a 15 s timeout)", async () => {
  for (const [host, path] of [
    ["cdn.test", "/held/a.whl"],
    ["slack.com", "/held/a.bin"],
  ] as const)
    assert.ok((await firstBytes(host, path)).bytes > 0, host);
  for (const r of open) r.destroy();
});

test("a host with no transform still has its Set-Cookie captured, though its body is not buffered", async () => {
  const { headers } = await firstBytes("cdn.test", "/cookie");
  assert.match(String(headers["set-cookie"]), /hortus-secret-c-\d+/);
  assert.doesNotMatch(String(headers["set-cookie"]), /real-cookie-value/);
});

test("a text body keeps its bytes: curl --data-binary of a file with a BOM", async () => {
  const bom = join(dir, "windows.csv");
  writeFileSync(bom, "\ufeffa,b\r\n");
  seen.length = 0;
  const r = await curl("files.slack.com", "/upload/v1/x", "--data-binary", `@${bom}`, "-H", "content-type: text/csv");
  assert.equal(r.status, 200, r.body);
  assert.deepEqual(seen.at(-1)?.body, readFileSync(bom));
});

test("no transform, streamed: an upstream that dies mid-body fails the client's read, never a clean short file", async () => {
  await assert.rejects(curl("cdn.test", "/cut"), /curl: \((18|56|92)\)/);
});

test("a cookie the site sets again counts its Max-Age from then: the jar keeps a rolling session", async () => {
  const held = () => jar(ctx.db, "T").find((c) => c.name === "roll");
  await curl("cdn.test", "/roll");
  const first = held()?.expires as number;
  assert.ok(first);
  ctx.db
    .prepare("UPDATE captured SET created = ? WHERE json_extract(meta, '$.cookieName') = 'roll'")
    .run(new Date(Date.now() - 2 * 3600_000).toISOString());
  assert.equal(held(), undefined, "two hours old and unset since: gone");
  await curl("cdn.test", "/roll");
  assert.ok((held()?.expires ?? 0) >= first);
});

// last: it taints the task
test("a cookie the site sets again is scrubbed too: same name, a new value, still the newest row", async () => {
  await curl("cdn.test", "/cookie");
  const r = await curl("cdn.test", "/cookie?rotate", "-i");
  assert.match(r.body, /set-cookie: sid=hortus-secret-c-\d+/i);
  assert.doesNotMatch(r.body, /rotated-value/);
  assert.match(r.body, /hortus-secret-c-\d+$/);
});

test("no transform, streamed: gzip, a captured cookie echoed across chunks, and a page taints", async () => {
  const r = await curl("cdn.test", "/login", "-i");
  assert.equal(r.status, 200, r.body);
  assert.doesNotMatch(r.body, /login-coo|kie-value/);
  const placeholder = /set-cookie: sid=(hortus-secret-c-\d+)/i.exec(r.body)?.[1];
  assert.ok(placeholder, r.body);
  assert.ok(r.body.endsWith(`<p>${placeholder}</p>`), r.body);
  assert.doesNotMatch(r.body, /content-encoding/i);
  assert.deepEqual(taintOf(ctx.db, "T", ctx.config), ["read a web page: cdn.test"]);
});
