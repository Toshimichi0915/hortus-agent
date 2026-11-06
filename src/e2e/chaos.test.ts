/**
 * Chaos (review round 23, state and recovery): the step-4 daemon (HORTUS_NO_NET=1, a delegated user scope, the fake
 * Slack and the fake provider) SIGKILLed at random points while owner orders flow through Planner batches, Worker
 * sessions and closes. After the last restart every order must end routed, its task closed done, nothing stuck.
 * Opt-in (`HORTUS_TEST_CHAOS=1`): a minute of kills.
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";

import { join } from "node:path";
import { after, before, test } from "node:test";
import { openDb } from "../db.ts";
import * as paths from "../paths.ts";
import { FakeSlack } from "../test/fakes/slack.ts";
import { freePort, stopped, tempDir, until } from "../test/until.ts";

const hasScope = spawnSync("systemd-run", ["--user", "--scope", "-q", "--", "true"]).status === 0;
const bin = (name: string) => new URL(`../bin/${name}.js`, import.meta.url).pathname;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const FAKE = (dir: string) => `
import { appendFileSync, existsSync, readFileSync } from "node:fs";
const DIR = ${JSON.stringify(dir)};
const EVENT = /^- \\[(e\\d+)\\] (\\S+)[^(\\n]* \\(([^)]*)\\) at \\S+\\n(<<<quoted[^\\n]*\\n[\\s\\S]*?\\n>>>\\S*|[^\\n]*)/gm;
const complete = async (req, onText) => {
  const id = (process.env.HORTUS_TASK ?? "").split("/").at(-3);
  const file = DIR + "/" + id + ".jsonl";
  const n = existsSync(file) ? readFileSync(file, "utf8").split("\\n").filter(Boolean).length : 0;
  appendFileSync(file, JSON.stringify({ system: req.system, messages: req.messages, tools: req.tools.map((t) => t.name) }) + "\\n");
  if (!req.tools.length) return { role: "assistant", text: "notes from fake", toolCalls: [] };
  const usage = { input: 10, output: 5, cached: 0 };
  const last = req.messages.at(-1);
  if (id.startsWith("planner-")) {
    const batch = req.messages[0].content;
    const events = [...batch.matchAll(EVENT)].map((m) => ({ id: m[1], ref: m[2], tags: m[3], text: m[4] }));
    const script = (await import("file://" + DIR + "/planner.mjs?" + Date.now() + Math.random())).default;
    const t = (await script({ batch, events, n, last, results: last.role === "tool" ? last.results : [] })) ?? {};
    if (t.text) onText(t.text);
    return {
      role: "assistant",
      text: t.text ?? "",
      toolCalls: (t.calls ?? []).map((c, i) => ({ id: "p" + n + "_" + i, name: c.name, input: c.input })),
      usage: { ...usage, ...t.usage },
    };
  }
  if (last.role === "tool") {
    const text = "tool said: " + last.results.map((r) => r.output).join("\\n").slice(0, 2000);
    onText(text);
    return { role: "assistant", text, toolCalls: [], usage };
  }
  const content = last.content ?? "";
  if (content.includes("!crash")) process.exit(3);
  const calls = [];
  for (const line of content.split("\\n")) {
    const m = /^!(bash|done|send) ?(.*)$/.exec(line.trim());
    if (!m) continue;
    const input = m[1] === "bash" ? { command: m[2] } : m[1] === "done" ? { summary: m[2] } : { text: m[2] };
    calls.push({ id: "c" + Date.now() + "_" + calls.length, name: m[1], input });
  }
  const text = "echo: " + content.split("\\n").at(-1);
  onText(text);
  return { role: "assistant", text, toolCalls: calls, usage };
};
export default { providers: { fake: { create: () => ({ complete, listModels: async () => ["m"] }) } } };
`;

let home: string;
let fake: string;
let slack: FakeSlack;
let port: number;
let httpPort: number;
let daemon: ChildProcess | undefined;
let unit = "";
let n = 0;

function startDaemon(): void {
  unit = `hortusd-chaos-${process.pid}-${++n}`;
  daemon = spawn(
    "systemd-run",
    [
      "--user",
      "--scope",
      "-q",
      "--unit",
      unit,
      "-p",
      "Delegate=yes",
      "--",
      process.execPath,
      "--no-warnings",
      bin("hortusd"),
    ],
    {
      env: {
        ...process.env,
        HORTUS_HOME: home,
        HORTUS_CONSOLE_PORT: String(port),
        HORTUS_NO_NET: "1",
        HORTUS_PLANNER_RETRY_MS: "100",
        HORTUS_PLANNER_RECHECK_MS: "1000",
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  daemon.stderr?.pipe(createWriteStream(join(fake, "hortusd.log"), { flags: "a" }));
}

const up = () =>
  until(
    () =>
      fetch(`http://127.0.0.1:${port}/`).then(
        (r) => r.ok,
        () => false,
      ),
    15_000,
    "the console",
  );

const db = <T>(f: (d: ReturnType<typeof openDb>) => T): T => {
  const d = openDb(paths.db());
  try {
    return f(d);
  } finally {
    d.close();
  }
};

const PLANNER = `export default ({ n, events, batch }) => {
  if (n > 0) return { text: "ok" };
  const calls = [];
  for (const m of batch.matchAll(/^- \\[(\\S+)\\] result:/gm)) calls.push({ name: "task_close", input: { task_id: m[1], outcome: "done" } });
  for (const e of events) {
    const job = /job (\\d+)/.exec(e.text)?.[1];
    if (job) calls.push({ name: "task_create", input: { title: "job " + job, brief: "!bash sleep 1.5\\n!done finished " + job, event_ids: [e.id], scope: { project: "foo" } } });
    else calls.push({ name: "event_ignore", input: { event_ids: [e.id], reason: "t" } });
  }
  return { calls };
};`;

before(async () => {
  if (!hasScope || !process.env.HORTUS_TEST_CHAOS) return;
  home = tempDir("hortus-chaos-");
  fake = tempDir("hortus-chaosfake-");
  process.env.HORTUS_HOME = home;
  mkdirSync(join(fake, "plugins", "fake"), { recursive: true });
  writeFileSync(
    join(fake, "plugins", "fake", "hortus.json"),
    JSON.stringify({ name: "fake", version: "1.0.0", entrypoint: "fake.mjs" }),
  );
  writeFileSync(join(fake, "plugins", "fake", "fake.mjs"), FAKE(fake));
  mkdirSync(join(fake, "foo"));
  writeFileSync(join(fake, "foo", "README.md"), "# foo\n");
  writeFileSync(join(fake, "planner.mjs"), PLANNER);
  slack = await FakeSlack.start();
  slack.user("U1", "alice");
  slack.channel("C1", { name: "general", members: ["U1", slack.botUser] });
  slack.channel("D1", { is_im: true, user: "U1", members: [slack.botUser, "U1"], name: "" });
  port = await freePort();
  httpPort = await freePort();
  writeFileSync(
    join(home, "hortusd.json"),
    JSON.stringify({
      policy: { "*": "human", cache: [fake] },
      owner: { tz: "UTC", notify: "slack" },
      dofs: { slack: { type: "slack", owner: "U1" } },
      dev: { upstreams: { "slack.com": slack.url } },
      planner: { provider: "fake", model: "m" },
      worker: { provider: "fake", model: "m", plugins: [join(fake, "plugins", "fake")] },
      projects: { foo: { path: join(fake, "foo") } },
      proxy: { https: await freePort(), http: httpPort, dns: 0 },
    }),
  );
  writeFileSync(
    join(home, "vault.json"),
    JSON.stringify({ ...slack.vault("slack"), fake: { type: "token", value: "x", transform: "fake" } }),
    { mode: 0o600 },
  );
  startDaemon();
  await up();
  await until(() => existsSync(join(paths.dof("slack"), "C1", "channel.md")), 15_000, "the mirror");
});

after(async () => {
  if (!hasScope || !process.env.HORTUS_TEST_CHAOS) return;
  if (daemon && daemon.exitCode === null) await stopped(daemon);
  spawnSync("systemctl", ["--user", "stop", `${unit}.scope`], { stdio: "ignore" });
  await slack.close();
  if (!process.env.KEEP) {
    rmSync(home, { recursive: true, force: true });
    rmSync(fake, { recursive: true, force: true });
  }
});

test("orders survive SIGKILLs at random points: each routed once, its task closed done", {
  skip: (!hasScope && "no delegated scope") || (!process.env.HORTUS_TEST_CHAOS && "HORTUS_TEST_CHAOS unset"),
  timeout: 600_000,
}, async () => {
  const kills = Number(process.env.HORTUS_TEST_CHAOS_KILLS ?? 6);
  let job = 0;
  for (let k = 0; k < kills; k++) {
    for (let i = 0; i < 4; i++) slack.post(k % 2 ? "D1" : "C1", { user: "U1", text: `please do job ${++job}` });
    await sleep(500 + Math.random() * 6000);
    const exited = new Promise((r) => daemon?.once("exit", r));
    // every third a clean stop: a restart, not a crash; the others SIGKILL the whole scope, its children included
    spawnSync("systemctl", ["--user", "kill", "-s", k % 3 === 2 ? "TERM" : "KILL", `${unit}.scope`]);
    await exited;
    spawnSync("systemctl", ["--user", "stop", `${unit}.scope`], { stdio: "ignore" });
    startDaemon();
    await up();
  }
  const state = () =>
    db((d) => {
      const evs = d
        .prepare("SELECT id, summary, consumed, task_id, ignored FROM events WHERE summary LIKE '%please do job%'")
        .all() as { id: number; summary: string; consumed: number; task_id: string | null; ignored: string | null }[];
      const ts = d.prepare("SELECT id, title, status, error FROM tasks WHERE kind = 'unattended'").all() as {
        id: string;
        title: string;
        status: string;
        error: string | null;
      }[];
      return { evs, ts };
    });
  try {
    await until(
      () => {
        const { evs, ts } = state();
        const jobs = new Set(evs.map((e) => /job (\d+)/.exec(e.summary)?.[1]));
        return jobs.size === job && evs.every((e) => e.task_id) && ts.every((t) => t.status === "done");
      },
      180_000,
      "every order routed and its task done",
    );
  } catch (e) {
    const { evs, ts } = state();
    console.error(JSON.stringify({ evs, ts: ts.filter((t) => t.status !== "done") }, null, 1));
    throw e;
  }
  const { evs, ts } = state();
  const titles = ts.map((t) => t.title);
  assert.equal(new Set(titles).size, titles.length, `one task per order: ${titles.sort().join(", ")}`);
  assert.equal(evs.length, job, "one event per order");
});
