/**
 * A Settings save and a stop with everything live (review round 11): one real daemon with Slack, Discord and Telegram connected,
 * an SSE client, a running session, a login view stalled in its navigation, a pending approval, and a client that
 * connected to each TLS port and said nothing. The save and the stop each take seconds, the stop exits 0 (not by
 * STOP_MS), and nothing of the daemon's is left.
 */
import assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { CHROMIUM } from "../browser/cdp.ts";
import { FakeDiscord } from "../test/fakes/discord.ts";
import { FakeSlack } from "../test/fakes/slack.ts";
import { FakeTelegram } from "../test/fakes/telegram.ts";
import { freePort, stopped, tempDir, until } from "../test/until.ts";

const hasScope = spawnSync("systemd-run", ["--user", "--scope", "-q", "--", "true"]).status === 0;
const bin = new URL("../bin/hortusd.js", import.meta.url).pathname;
const CLIENT = "127.0.0.3";
/** the bar is "a few seconds"; loose for a suite running beside a full CPU */
const BOUND_MS = 15_000;

const FAKE = `
const complete = async (req, onText) => {
  const content = String(req.messages.at(-1).content ?? "");
  if (content.includes("!hang")) { onText("hanging"); await new Promise(() => {}); }
  return { role: "assistant", text: "ok", usage: { input: 1, output: 1, cached: 0 }, toolCalls: [] };
};
export default { providers: { fake: { create: () => ({ complete, listModels: async () => ["m"] }) } } };
`;

let home: string;
let port: number;
let https: number;
let http: number;
let remote: number;
let slack: FakeSlack;
let tg: FakeTelegram;
let dc: FakeDiscord;
const stall = createServer(() => {}); // takes every request and never answers
const unit = `hortusd-stop-${process.pid}`;
let daemon: ChildProcess | undefined;
const held: Socket[] = [];

const api = async <T = Record<string, unknown>>(method: string, body: unknown = {}): Promise<T> => {
  const r = await fetch(`http://127.0.0.1:${port}/api/${method}`, {
    method: "POST",
    headers: { "X-Hortus": "1", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = (await r.json()) as { result?: T; error?: { message: string } };
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result as T;
};

before(async () => {
  if (!hasScope) return;
  home = tempDir("hortus-stop-");
  const plugin = join(home, "fake-plugin");
  mkdirSync(plugin);
  writeFileSync(
    join(plugin, "hortus.json"),
    JSON.stringify({ name: "fake", version: "1.0.0", entrypoint: "fake.mjs" }),
  );
  writeFileSync(join(plugin, "fake.mjs"), FAKE);
  slack = await FakeSlack.start();
  slack.user("U1", "owner");
  slack.channel("C1", { name: "general", members: ["U1", slack.botUser] });
  tg = await FakeTelegram.start();
  dc = await FakeDiscord.start();
  dc.gatewayUrl = "wss://gateway.discord.gg";
  dc.channel("3000", { name: "general" });
  await new Promise<void>((r) => stall.listen(0, "127.0.0.1", r));
  const { port: stallPort } = stall.address() as { port: number };
  [port, https, http, remote] = await Promise.all([freePort(), freePort(), freePort(), freePort()]);
  writeFileSync(
    join(home, "hortusd.json"),
    JSON.stringify({
      owner: { tz: "UTC" },
      console: { listen: `127.0.0.1:${remote}`, host: "console.test" },
      origins: "*",
      worker: { provider: "fake", model: "m", plugins: [plugin] },
      planner: { provider: "fake", model: "m" },
      dofs: {
        slack: { type: "slack", owner: "U1" },
        tg: { type: "telegram", owner: "1" },
        discord: { type: "discord", owner: "200" },
      },
      dev: {
        upstreams: {
          "slack.com": slack.url,
          "api.telegram.org": tg.url,
          "discord.com": dc.url,
          "gateway.discord.gg": dc.url,
          "stall.test": `http://127.0.0.1:${stallPort}`,
        },
      },
      proxy: { https, http, dns: 0 },
    }),
  );
  writeFileSync(
    join(home, "vault.json"),
    JSON.stringify({
      ...slack.vault("slack"),
      ...tg.vault("tg"),
      ...dc.vault("discord"),
      fake: { type: "token", value: "x", transform: "fake" },
    }),
    { mode: 0o600 },
  );
  daemon = spawn(
    "systemd-run",
    ["--user", "--scope", "-q", "--unit", unit, "-p", "Delegate=yes", "--", process.execPath, "--no-warnings", bin],
    {
      env: {
        ...process.env,
        HORTUS_HOME: home,
        HORTUS_CONSOLE_PORT: String(port),
        HORTUS_WEBHOOK_PORT: "0",
        HORTUS_NO_NET: "1",
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  daemon.stderr?.pipe(createWriteStream(join(home, "hortusd.log"), { flags: "a" }));
  await until(
    () =>
      fetch(`http://127.0.0.1:${port}/`).then(
        (r) => r.ok,
        () => false,
      ),
    15_000,
    "the console",
  );
});

after(async () => {
  if (!hasScope) return;
  for (const s of held) s.destroy();
  if (daemon) await stopped(daemon);
  spawnSync("systemctl", ["--user", "stop", `${unit}.scope`], { stdio: "ignore" });
  stall.closeAllConnections();
  await Promise.all([slack.close(), tg.close(), dc.close(), new Promise((r) => stall.close(r))]);
  if (process.env.KEEP === "1") console.log(`# kept ${home}`);
});

/** `POST /rpc/<method>` from the dev-linked client, as its task's Worker. */
const asWorker = (method: string, body: unknown) =>
  new Promise<{ result: { approval: number } }>((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: http,
        localAddress: CLIENT,
        method: "POST",
        path: `/rpc/${method}`,
        headers: { host: "hortusd.internal", "content-type": "application/json" },
      },
      (res) => {
        let s = "";
        res.on("data", (c) => {
          s += c;
        });
        res.on("end", () => resolve(JSON.parse(s)));
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });

/** A gated request from the Worker: its 403 leaves the pending entry. */
const gated = (): Promise<string> =>
  new Promise((resolve, reject) =>
    execFile(
      "curl",
      // biome-ignore format: one argument list
      ["-sS", "--max-time", "10", "--interface", CLIENT, "--resolve", `slack.com:${https}:127.0.0.1`, "--cacert",
        join(home, "ca", "ca.crt"), "-H", "Authorization: Bearer hortus-secret-slack",
        `https://slack.com:${https}/api/auth.test`],
      { encoding: "utf8" },
      (e, out, err) => (e ? reject(new Error(err || e.message)) : resolve(out)),
    ),
  );

const polls = () => tg.calls.filter((c) => c.method === "getUpdates").length;

const silent = (at: number) =>
  new Promise<void>((resolve, reject) => {
    const s = connect(at, "127.0.0.1", () => resolve()).on("error", reject);
    held.push(s);
  });

test("a Settings save and a stop with everything live each take seconds; the stop is clean and leaves nothing", {
  skip: !hasScope && "no systemd-run --user (delegated cgroups)",
  timeout: 120_000,
}, async () => {
  await until(() => slack.connects > 0 && dc.connects > 0 && polls() > 0, 15_000, "the connectors live");

  const chat = (await api<{ id: string }>("task.open", { text: "!hang" })).id;
  await until(
    async () => (await api<{ task: { status: string } }>("task.get", { id: chat })).task.status === "running",
    15_000,
    "a running session",
  );
  await api("dev.link", { address: CLIENT, role: "worker", task: chat });
  assert.match(await gated(), /approval/);

  const sse = new AbortController();
  const stream = await fetch(`http://127.0.0.1:${port}/events/approvals,tasks`, { signal: sse.signal });
  await stream.body?.getReader().read();

  const login = await asWorker("browser.login", { url: "http://stall.test/never", why: "stop test" });
  let frames: Promise<unknown> = Promise.resolve();
  if (existsSync(CHROMIUM)) {
    const view = await fetch(`http://127.0.0.1:${port}/events/login?id=${login.result.approval}`, {
      signal: sse.signal,
    });
    const reader = view.body?.getReader();
    const dec = new TextDecoder();
    for (let seen = ""; !seen.includes('"frame"'); ) {
      const { value, done } = (await reader?.read()) ?? { done: true };
      assert.ok(!done, "the login view's stream ended before a frame");
      seen += dec.decode(value);
    }
    frames = (async () => {
      while (!(await reader?.read())?.done);
    })().catch(() => {});
  }
  for (const at of [https, http, remote, port]) await silent(at);

  // a Settings save changing every connector: they stop and come back
  const { config } = await api<{ config: { dofs: Record<string, Record<string, unknown>> } }>("settings.get");
  const save = async (trust: string) => {
    for (const d of Object.values(config.dofs)) d.trust = trust;
    const was = [slack.connects, dc.connects, polls()] as const;
    const t = Date.now();
    await api("settings.set", { config });
    const took = Date.now() - t;
    console.log(`# settings save ${took} ms`);
    assert.ok(took < BOUND_MS, `the save took ${took} ms`);
    await until(
      () => slack.connects > was[0] && dc.connects > was[1] && polls() > was[2],
      15_000,
      "the connectors back",
    );
  };
  const lists = () => slack.calls.filter((c) => c.method === "conversations.list").length;
  const listed = lists();
  slack.stalled.add("conversations.list");
  await save("members"); // the runner that comes back stalls in its first reconcile, and the next save cuts it
  await until(() => lists() > listed, 5000, "the stalled reconcile");
  slack.stalled.clear();
  await save("anyone");

  // a session opened at the signal, wherever its start has got to (dispatcher.test pins the window)
  await api("task.open", { text: "!hang" });
  const d = daemon as ChildProcess;
  const exited = new Promise<number | null>((r) => d.once("exit", (code) => r(code)));
  const t0 = Date.now();
  d.kill("SIGTERM");
  const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r("late"), 70_000))]);
  const took = Date.now() - t0;
  console.log(`# stop ${took} ms, exit ${code}`);
  sse.abort();
  await frames;
  const log = readFileSync(join(home, "hortusd.log"), "utf8");
  assert.equal(code, 0, log.slice(-1000));
  assert.ok(took < BOUND_MS, `the stop took ${took} ms`);
  assert.doesNotMatch(log, /stop timed out|stop failed/);
  await until(() => spawnSync("pgrep", ["-f", home]).status !== 0, 5000, "nothing of the daemon's left");
});
