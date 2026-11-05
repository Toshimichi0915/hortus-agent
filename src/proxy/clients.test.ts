/**
 * Real clients through the real proxy (review round 14): curl's multipart uploads, the messengers' upload flows, and
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
import { Config } from "../config.ts";
import type { Ctx } from "../ctx.ts";
import { openDb } from "../db.ts";
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
    if (u === "/cookie") {
      res.writeHead(200, { "content-type": "text/plain", "set-cookie": "sid=real-cookie-value; Path=/" });
      return res.end("ok");
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
  // a boundary is framing on its own line, never text: approving "pay XX" with boundary=XX approves no "pay evil"
  const pay = (b: string, to: string) => `--${b}\r\n\r\npay ${to}\r\n--${b}--\r\n`;
  assert.notEqual(hashTemplate(t("XX", pay("XX", "XX"))), hashTemplate(t("evil", pay("evil", "evil"))));
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
