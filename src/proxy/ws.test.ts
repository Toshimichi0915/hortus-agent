/**
 * Discord and Telegram through the real pipeline (4b): the `ws:text` frame relay against the fake Discord gateway,
 * and `path:/bot{}/` as Telegram's only location. Clients: 127.0.0.5 is registered as role core (hortusd's own
 * connectors), 127.0.0.6 as a worker of task T.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { WebSocket } from "ws";
import { Config } from "../config.ts";
import { create as discord } from "../connectors/discord.ts";
import { create as telegram, timing as tgTiming } from "../connectors/telegram.ts";
import type { Ctx } from "../ctx.ts";
import { openDb } from "../db.ts";
import { logger } from "../log.ts";
import * as paths from "../paths.ts";
import { FakeDiscord } from "../test/fakes/discord.ts";
import { FakeTelegram } from "../test/fakes/telegram.ts";
import { memLog, tempDir, until } from "../test/until.ts";
import type { Connector, Incoming } from "../types.ts";
import { caCert } from "../vault/ca.ts";
import { transforms, vaultModule } from "../vault/index.ts";
import { write as writeVault } from "../vault/vault.ts";
import { coreFetch, coreSocket, links, listen, proxyModule } from "./index.ts";

process.env.HORTUS_HOME = tempDir("hortus-ws-");
process.env.HORTUS_NO_NET = "1";
tgTiming.pollS = 1;

let dc: FakeDiscord;
let tg: FakeTelegram;
let ports: { https: number };
let ca: Buffer;
let ctx: Ctx;
/** answers every request, upgrades included, with an endless body */
let flood: Server;
const CORE = "127.0.0.5";
const WORKER = "127.0.0.6";

/** A WebSocket to `url` through the proxy, from `from`. */
function socket(url: string, from = CORE): WebSocket {
  const u = new URL(url);
  return new WebSocket(`wss://127.0.0.1:${ports.https}${u.pathname}${u.search}`, {
    servername: u.hostname,
    headers: { host: u.hostname },
    ca,
    localAddress: from,
  } as WebSocket.ClientOptions);
}

/** Open, send `frame` after HELLO, resolve with the close code and reason. */
function closeOf(frame: string, from = CORE): Promise<{ code: number; reason: string }> {
  const ws = socket("wss://gateway.discord.gg/?v=10&encoding=json", from);
  ws.on("message", (m) => {
    if ((JSON.parse(String(m)) as { op: number }).op === 10) ws.send(frame);
  });
  return new Promise((resolve) => ws.on("close", (code, reason) => resolve({ code, reason: String(reason) })));
}

before(async () => {
  dc = await FakeDiscord.start();
  tg = await FakeTelegram.start();
  dc.gatewayUrl = "wss://gateway.discord.gg";
  flood = createServer((_req, res) => {
    res.writeHead(400);
    const chunk = Buffer.alloc(64 * 1024, 120);
    const more = () => {
      while (res.write(chunk));
    };
    res.on("drain", more);
    more();
  }).on("upgrade", (_req, s) => {
    s.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    const chunk = Buffer.alloc(64 * 1024, 120);
    const more = () => {
      while (!s.destroyed && s.write(chunk));
    };
    s.on("drain", more);
    s.on("error", () => {});
    more();
  });
  await new Promise<void>((r) => flood.listen(0, "127.0.0.1", r));
  ctx = {
    config: Config.parse({
      proxy: { https: 0, http: 0, dns: 0 },
      dev: {
        upstreams: {
          "discord.com": dc.url,
          "gateway.discord.gg": dc.url,
          "api.telegram.org": tg.url,
          "flood.example": `http://127.0.0.1:${(flood.address() as AddressInfo).port}`,
        },
      },
    }),
    db: openDb(paths.db()),
    paths,
    log: logger,
    reload: async () => {},
  };
  writeVault({ ...dc.vault("discord"), ...tg.vault("telegram") });
  ctx.db
    .prepare("INSERT INTO tasks(id, kind, status, scope, origins) VALUES ('T', 'chat', 'running', ?, ?)")
    .run(JSON.stringify({ credentials: ["discord"], repos: [] }), JSON.stringify("*"));
  await vaultModule.start(ctx);
  await proxyModule.start(ctx);
  await transforms.load();
  links.register(CORE, "core", null, "test");
  links.register(WORKER, "worker", "T", "session");
  ports = await listen("127.0.0.1", { https: 0, http: 0, dns: 0, proxyAddress: "127.0.0.1" });
  ca = readFileSync(caCert());
  dc.user("200", "owner");
  dc.channel("300", { name: "general" });
  tg.user(500, "owner");
  tg.chat(500);
});

after(async () => {
  await proxyModule.stop();
  await vaultModule.stop();
  await dc.close();
  await tg.close();
  flood.closeAllConnections();
  flood.close();
});

async function first(conn: Connector, ac: AbortController): Promise<Incoming> {
  const it = conn.events(ac.signal)[Symbol.asyncIterator]();
  const r = await Promise.race([
    it.next(),
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error("no event within 5 s")), 5000)),
  ]);
  ac.abort();
  void it.return?.();
  assert.ok(!r.done);
  return r.value;
}

test("discord through the proxy: REST and IDENTIFY get the real token; upstream frames are scrubbed", async () => {
  const conn = await discord({
    name: "discord",
    config: { type: "discord", owner: "200" },
    log: memLog(),
    fetch: coreFetch,
    ws: (url: string) => socket(url) as unknown as globalThis.WebSocket,
    hasRef: () => false,
  } as Parameters<typeof discord>[0]);
  dc.post("300", { user: "200", text: `leak ${dc.token} here` });
  const { event } = await first(conn, new AbortController());
  assert.deepEqual(dc.identifies, [{ op: 2, token: dc.token }]);
  const m = await conn.mirror(event);
  assert.equal(m.changes[0]?.body, "leak hortus-secret-discord here");
});

test("coreSocket (hortusd's wiring): the in-process route is role core and IDENTIFY gets the real token", async () => {
  const n = dc.identifies.length;
  const conn = await discord({
    name: "discord",
    config: { type: "discord", owner: "200" },
    log: memLog(),
    fetch: coreFetch,
    ws: coreSocket,
    hasRef: () => false,
  });
  const got = first(conn, new AbortController());
  await until(() => dc.identifies.length > n, 5000, "IDENTIFY");
  dc.post("300", { user: "200", text: "via coreSocket" });
  await got;
  assert.deepEqual(dc.identifies.slice(n), [{ op: 2, token: dc.token }]);
});

test("a client frame with the raw token is refused (1008) and never reaches the gateway", async () => {
  const n = dc.identifies.length;
  const r = await closeOf(JSON.stringify({ op: 2, d: { token: dc.token, intents: 1 } }));
  assert.equal(r.code, 1008);
  assert.match(r.reason, /raw credential/);
  assert.equal(dc.identifies.length, n);
});

test("a placeholder outside IDENTIFY's token is unmapped (1008); a worker's IDENTIFY waits for approval", async () => {
  const presence = { op: 3, d: { activities: [{ name: "hortus-secret-discord" }] } };
  const r = await closeOf(JSON.stringify(presence));
  assert.equal(r.code, 1008);
  assert.match(r.reason, /unmapped placeholder/);
  const w = await closeOf(JSON.stringify({ op: 2, d: { token: "hortus-secret-discord" } }), WORKER);
  assert.equal(w.code, 1008);
  assert.match(w.reason, /approval \d+/);
  const row = ctx.db.prepare("SELECT category, task_id FROM approvals ORDER BY id DESC").get();
  assert.deepEqual({ ...row }, { category: "credential:discord", task_id: "T" });
});

test("a client frame writing handle syntax itself is refused (1008)", async () => {
  const n = dc.identifies.length;
  const r = await closeOf(JSON.stringify({ op: 2, d: { token: "{secret:discord}" } }));
  assert.equal(r.code, 1008);
  assert.match(r.reason, /handle syntax/);
  assert.equal(dc.identifies.length, n);
});

test("an upgrade answered with an endless body is cut at 1 MB (502), not buffered", async () => {
  const ws = socket("wss://flood.example/", WORKER);
  const status = await new Promise<number>((resolve) => {
    ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    ws.on("error", () => resolve(-1));
  });
  assert.equal(status, 502);
});

test("binary frames and heartbeats pass through the relay", async () => {
  const ws = socket("wss://gateway.discord.gg/?v=10&encoding=json");
  const ack = new Promise<number>((resolve) =>
    ws.on("message", (m) => {
      const f = JSON.parse(String(m)) as { op: number };
      if (f.op === 10) {
        ws.send(Buffer.from([1, 2, 3]));
        ws.send(JSON.stringify({ op: 1, d: null }));
      }
      if (f.op === 11) resolve(f.op);
    }),
  );
  assert.equal(await ack, 11);
  assert.deepEqual(dc.binary.at(-1), Buffer.from([1, 2, 3]));
  ws.close();
});

test("telegram: the path token is swapped; a token in a header is refused", async () => {
  const ok = await coreFetch("https://api.telegram.org/bothortus-secret-telegram/getMe", { method: "POST" });
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as { ok: boolean }).ok, true);
  const placeholder = await coreFetch("https://api.telegram.org/bothortus-secret-telegram/getMe", {
    method: "POST",
    headers: { authorization: "hortus-secret-telegram" },
  });
  assert.equal(placeholder.status, 403);
  assert.match(await placeholder.text(), /unmapped placeholder/);
  const handle = await coreFetch("https://api.telegram.org/bot/getMe", {
    method: "POST",
    headers: { "x-token": "{secret:telegram}" },
  });
  assert.equal(handle.status, 403);
  assert.match(await handle.text(), /handle syntax in the request/); // handles come from transforms only
  assert.ok(tg.calls.every((c) => !c.authorization?.includes(tg.token)));
});

test("telegram connector through the proxy: getUpdates and the owner's message", async () => {
  const conn = await telegram({
    name: "telegram",
    config: { type: "telegram", owner: "500" },
    log: memLog(),
    fetch: coreFetch,
    hasRef: () => false,
  });
  tg.post(500, { user: 500, text: "hi bot" });
  const { event } = await first(conn, new AbortController());
  assert.deepEqual(event.author, { user: "500", member: true });
  assert.equal((await conn.mirror(event)).changes[0]?.body, "hi bot");
});
