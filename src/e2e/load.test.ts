/**
 * Load (round 4): the real daemon (HORTUS_NO_NET=1, delegated user scope, fake provider as in step3.test.ts) runs
 * rounds of 20 simultaneous chats. Each reply echoes its own task's word (no cross-talk), the console answers while
 * they run, every chat closes, no task cgroup is left, and hortusd's fds and RSS stay flat from round to round.
 * Numbers are printed as `# load …` lines.
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { freePort, stopped, tempDir, until } from "../test/until.ts";

const hasScope = spawnSync("systemd-run", ["--user", "--scope", "-q", "--", "true"]).status === 0;
const bin = (name: string) => new URL(`../bin/${name}.js`, import.meta.url).pathname;

const FAKE = `
const complete = async (req, onText) => {
  if (!req.tools.length) return { role: "assistant", text: "notes", toolCalls: [] };
  const last = req.messages.at(-1);
  const text = "echo: " + String(last.content ?? "").split("\\n").at(-1);
  onText(text);
  return { role: "assistant", text, toolCalls: [], usage: { input: 10, output: 5, cached: 0 } };
};
export default { providers: { fake: { create: () => ({ complete, listModels: async () => ["m"] }) } } };
`;

const N = 20;
const ROUNDS = Number(process.env.LOAD_ROUNDS ?? 3);
let home: string;
let port: number;
let daemon: ChildProcess | undefined;
const unit = `hortusd-load-${process.pid}`;

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
interface Card {
  task: { status: string; error: string | null };
  replies: { body: { type?: string; text?: string } }[];
}

before(async () => {
  if (!hasScope) return;
  home = tempDir("hortus-load-");
  const plugin = join(home, "fake-plugin");
  mkdirSync(plugin);
  writeFileSync(
    join(plugin, "hortus.json"),
    JSON.stringify({ name: "fake", version: "1.0.0", entrypoint: "fake.mjs" }),
  );
  writeFileSync(join(plugin, "fake.mjs"), FAKE);
  port = await freePort();
  writeFileSync(
    join(home, "hortusd.json"),
    JSON.stringify({
      owner: { tz: "UTC" },
      worker: { provider: "fake", model: "m", plugins: [plugin] },
      proxy: { https: await freePort(), http: await freePort(), dns: 0 },
    }),
  );
  writeFileSync(join(home, "vault.json"), JSON.stringify({ fake: { type: "token", value: "x", transform: "fake" } }), {
    mode: 0o600,
  });
  daemon = spawn(
    "systemd-run",
    ["--user", "--scope", "-q", "--unit", unit, "-p", "Delegate=yes", "--", process.execPath, "--no-warnings"].concat(
      bin("hortusd"),
    ),
    {
      env: { ...process.env, HORTUS_HOME: home, HORTUS_CONSOLE_PORT: String(port), HORTUS_NO_NET: "1" },
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
  if (daemon && daemon.exitCode === null) {
    await stopped(daemon);
  }
  spawnSync("systemctl", ["--user", "stop", `${unit}.scope`], { stdio: "ignore" });
});

/** systemd-run --scope execs the command: the scope's pid is hortusd's */
/** hortusd's fds, less this test's own keep-alive connections to the console: 22 at rest, 36 after a burst, 5 s to idle */
const fds = () => {
  const ss = spawnSync("ss", ["-tnH", "state", "established", "sport", "=", `:${port}`], { encoding: "utf8" });
  return readdirSync(`/proc/${daemon?.pid}/fd`).length - ss.stdout.trim().split("\n").filter(Boolean).length;
};
const rssMb = () => Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${daemon?.pid}/status`, "utf8"))?.[1]) / 1024;
const cgroups = () => {
  const line =
    readFileSync(`/proc/${daemon?.pid}/cgroup`, "utf8")
      .split("\n")
      .find((l) => l.startsWith("0::")) ?? "";
  const dir = join("/sys/fs/cgroup", line.slice(3), "tasks");
  return existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).length : 0;
};
const pct = (xs: number[], p: number) =>
  [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))];

test(`${ROUNDS} rounds of ${N} simultaneous chats: own replies, responsive console, clean close, flat fds/RSS`, {
  skip: !hasScope && "no systemd-run --user (delegated cgroups)",
  timeout: 240_000,
}, async () => {
  const stats: { secs: number; fds: number; rss: number; p50: number; p95: number }[] = [];
  for (let round = 0; round < ROUNDS; round++) {
    const t0 = Date.now();
    const words = Array.from({ length: N }, (_, i) => `word${round}x${i}q`);
    const ids = (await Promise.all(words.map((text) => api<{ id: string }>("task.open", { text })))).map((r) => r.id);
    // the console's latency while they start and run
    const lat: number[] = [];
    let busy = true;
    const probe = (async () => {
      while (busy) {
        const s = performance.now();
        await api("task.list", {});
        lat.push(performance.now() - s);
        await new Promise((r) => setTimeout(r, 50));
      }
    })();
    const cards: Card[] = await Promise.all(
      ids.map((id) =>
        until(
          async () => {
            const c = await api<Card>("task.get", { id });
            return (c.task.status === "waiting" &&
              c.replies.some((r) => r.body.text?.startsWith("echo:")) &&
              c) as Card;
          },
          90_000,
          `${id} answered`,
        ),
      ),
    );
    busy = false;
    await probe;
    for (const [i, c] of cards.entries()) {
      const echoes = c.replies.filter((r) => r.body.text?.startsWith("echo:")).map((r) => r.body.text);
      assert.deepEqual(echoes, [`echo: ${words[i]}`], `${ids[i]}: ${JSON.stringify(c.replies)} ${c.task.error}`);
    }
    await Promise.all(ids.map((id) => api("task.close", { id, outcome: "done" })));
    await until(() => cgroups() === 0, 10_000, "no task cgroups");
    const secs = (Date.now() - t0) / 1000;
    // the low of a second: a sample on the turn sessions end counts pipes on their way out
    let open = fds();
    for (let i = 0; i < 10; i++, await sleep(100)) open = Math.min(open, fds());
    const s = { secs, fds: open, rss: rssMb(), p50: pct(lat, 0.5) ?? 0, p95: pct(lat, 0.95) ?? 0 };
    stats.push(s);
    console.log(
      `# load round ${round}: ${N} chats in ${secs.toFixed(1)} s; task.list p50 ${s.p50.toFixed(0)} ms p95 ${s.p95.toFixed(0)} ms; fds ${s.fds}; rss ${s.rss.toFixed(0)} MB`,
    );
  }
  const [first, , last] = stats;
  assert.ok(first && last);
  // alone: 17–21 ms since round 6 paced the sandbox spawns (was 125–156 ms); the median round, as a thread hortusd holds
  // shows in most rounds and a machine under 32 stressors and 64 test files in one (595 ms once, then 210, 156, 170)
  const p95 = stats.map((s) => s.p95);
  // (517, 535, 281 once in round 16, with no change of the median alone; a regression to a held thread is seconds)
  assert.ok((pct(p95, 0.5) ?? 0) < 1000, `console p95 ${p95} ms while ${N} chats ran`);
  // round 0 opens the 20 aliases' listener sets (kept for reuse, v7); later rounds must not add any
  assert.ok(last.fds <= (stats[1]?.fds ?? 0) + 5, `fds grew: ${stats.map((s) => s.fds)}`);
  assert.ok(last.rss < first.rss * 1.5 + 30, `rss grew: ${stats.map((s) => s.rss.toFixed(0))}`);
});
