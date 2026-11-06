/**
 * The Planner, live (HORTUS_TEST_NET=1 and HORTUS_TEST_LLM=1, passwordless sudo), set up like host-runtime.live.test.ts:
 * the daemon as a transient system unit with its capabilities, the fake Slack behind `dev.upstreams`, and a real model
 * for both the Planner and the Worker (`ollama-cloud` copied from the owner's ~/.hortus/secrets.json into the temp
 * vault). The owner's DM → one batch → `task_create` on project foo → the Worker replies in the DM thread through
 * chat.postMessage (one approval, announced by an owner.notify DM) → a follow-up in that thread routes to the same task.
 * 3b (clones, merge) is not built yet, so the README edit lands in the task's scratch directory, not the project.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { openDb } from "../db.ts";
import * as paths from "../paths.ts";
import { FakeSlack } from "../test/fakes/slack.ts";
import { tempDir, until } from "../test/until.ts";

const LIVE = process.env.HORTUS_TEST_NET === "1" && process.env.HORTUS_TEST_LLM === "1";
const UNIT = "hortusd-planner-live-test";
const MODEL = "deepseek-v4.1-flash:1017";
const bin = (name: string) => new URL(`../bin/${name}.js`, import.meta.url).pathname;
const realHome = homedir();

let home: string;
let fake: FakeSlack;
const port = 7890 + (process.pid % 100);
const t0 = Date.now();
const mark = (what: string) => console.log(`# [${((Date.now() - t0) / 1000).toFixed(1)} s] ${what}`);

const cleanupNet = () => {
  spawnSync("sudo", ["systemctl", "stop", UNIT], { stdio: "ignore" });
  spawnSync("sudo", ["systemctl", "reset-failed", UNIT], { stdio: "ignore" });
  spawnSync("sudo", ["nft", "delete", "table", "inet", "hortus"], { stdio: "ignore" });
  spawnSync("sudo", ["ip", "link", "del", "hortus0"], { stdio: "ignore" });
};

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

const db = <T>(f: (d: ReturnType<typeof openDb>) => T): T => {
  const d = openDb(paths.db());
  try {
    return f(d);
  } finally {
    d.close();
  }
};
const eventTask = (text: string) =>
  db(
    (d) =>
      d.prepare("SELECT task_id, ignored FROM events WHERE summary LIKE ? ORDER BY id DESC").get(`%${text}%`) as
        | { task_id: string | null; ignored: string | null }
        | undefined,
  );

/** The transient unit; a second call is a restart's second half. */
async function startDaemon(): Promise<void> {
  const env = { HORTUS_HOME: paths.home(), HORTUS_CONSOLE_PORT: String(port), HOME: home, PATH: process.env.PATH };
  const r = spawnSync(
    "sudo",
    [
      "systemd-run",
      "--unit",
      UNIT,
      "--collect",
      "--uid",
      String(process.getuid?.()),
      "--gid",
      String(process.getgid?.()),
      "-p",
      "AmbientCapabilities=CAP_NET_ADMIN CAP_NET_BIND_SERVICE",
      "-p",
      "CapabilityBoundingSet=CAP_NET_ADMIN CAP_NET_BIND_SERVICE",
      "-p",
      "Delegate=yes",
      "-p",
      "KillMode=mixed",
      "-p",
      "RuntimeMaxSec=900",
      ...Object.entries(env).flatMap(([k, v]) => ["-E", `${k}=${v}`]),
      process.execPath,
      "--no-warnings",
      bin("hortusd"),
    ],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr);
  await until(
    () =>
      fetch(`http://127.0.0.1:${port}/`).then(
        (x) => x.ok,
        () => false,
      ),
    20_000,
    "the console",
  );
  await until(() => fake.calls.some((c) => c.method === "apps.connections.open"), 20_000, "the socket");
}

before(async () => {
  if (!LIVE) return;
  const owner = JSON.parse(readFileSync(join(realHome, ".hortus", "secrets.json"), "utf8")) as Record<
    string,
    { apiKey: string }
  >;
  const key = owner["ollama-cloud"]?.apiKey;
  assert.ok(key, "~/.hortus/secrets.json has no ollama-cloud entry");
  home = tempDir("hortus-planner-live-");
  process.env.HORTUS_HOME = join(home, ".hortus");
  mkdirSync(paths.home(), { recursive: true, mode: 0o700 });
  const project = join(home, "foo");
  mkdirSync(project);
  writeFileSync(join(project, "README.md"), "# foo\n\nA test project.\n");
  const git = (...a: string[]) => execFileSync("git", ["-C", project, ...a], { stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("add", "README.md");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "readme");

  fake = await FakeSlack.start();
  fake.user("U1", "alice");
  fake.channel("D1", { is_im: true, user: "U1", members: [fake.botUser, "U1"], name: "" });
  const deny = [".hortus", ".ssh", ".gnupg", ".aws", ".config", ".netrc", ".password-store", ".kube", ".docker"];
  writeFileSync(
    join(paths.home(), "hortusd.json"),
    JSON.stringify({
      owner: { tz: "UTC", notify: "slack" },
      dofs: { slack: { type: "slack", owner: "U1" } },
      dev: { upstreams: { "slack.com": fake.url } },
      planner: { provider: "ollama-cloud", model: MODEL, runtime: "host" },
      worker: { provider: "ollama-cloud", model: MODEL, budget: { tokens: 3e6, hours: 1 } },
      projects: { foo: { path: project } },
      policy: { "*": "human", deny: deny.map((d) => join(realHome, d)) },
    }),
  );
  writeFileSync(
    paths.vault(),
    JSON.stringify({ ...fake.vault("slack"), "ollama-cloud": { type: "token", value: key, transform: "ollama" } }),
    { mode: 0o600 },
  );
  cleanupNet();
  await startDaemon();
  mark("daemon up");
});

after(async () => {
  if (!LIVE) return;
  if (process.env.KEEP !== "1") cleanupNet();
  await fake.close();
  if (process.env.KEEP !== "1") rmSync(home, { recursive: true, force: true });
});

const skip = !LIVE && "needs HORTUS_TEST_NET=1 and HORTUS_TEST_LLM=1";

test("the owner's DM → Planner task on foo → reply in the DM thread (notified approval) → follow-up routed", {
  skip,
  timeout: 900_000,
}, async () => {
  await new Promise((r) => setTimeout(r, 1500)); // the socket's hello
  const dm = fake.post("D1", { user: "U1", text: "in project foo, add a line to README and tell me here" });
  mark("owner DM posted");
  const id = await until(() => eventTask("add a line to README")?.task_id, 300_000, "the Planner's task");
  const card = await api<{ task: { project: string | null; runtime: string; title: string; brief: string } }>(
    "task.get",
    { id },
  );
  mark(`task ${id} "${card.task.title}" project=${card.task.project} runtime=${card.task.runtime}`);
  mark(`brief: ${card.task.brief.replace(/\s+/g, " ").slice(0, 400)}`);
  assert.equal(card.task.project, "foo");

  const notify = await until(
    () => fake.calls.find((c) => c.method === "chat.postMessage" && /^approval \d+ pending/.test(c.params.text ?? "")),
    300_000,
    "the owner.notify DM",
  );
  mark(`owner.notify: ${notify.params.text}`);
  assert.match(
    notify.params.text ?? "",
    new RegExp(`^approval \\d+ pending \\([^)]+\\) http://127\\.0\\.0\\.1:${port}/approvals$`),
  );
  const isReply = (c: { method: string; params: Record<string, string> }) =>
    c.method === "chat.postMessage" && c.params.thread_ts === dm.ts;
  const reply = await until(
    async () => {
      for (const a of (await api<{ approvals: { id: number; category: string }[] }>("task.get", { id })).approvals) {
        await api("approval.decide", { id: a.id, decision: "approve" });
        mark(`approved #${a.id} ${a.category}`);
      }
      return fake.calls.find(isReply);
    },
    400_000,
    "the reply in the DM thread",
  );
  mark(`reply in the thread: ${String(reply.params.text).slice(0, 200)}`);
  assert.equal(reply.params.channel, "D1");
  assert.ok(fake.auths.includes(`Bearer ${fake.botToken}`));
  assert.ok(!fake.auths.some((a) => a.includes("hortus-secret")));

  const batchesBefore = db((d) => (d.prepare("SELECT MAX(consumed) AS n FROM events").get() as { n: number }).n);
  fake.post("D1", { user: "U1", text: "thanks! please also mention the date in that line", thread_ts: dm.ts });
  mark("follow-up posted in the thread");
  const routed = await until(
    () => {
      const e = eventTask("also mention the date");
      return e && (e.task_id || e.ignored) ? e : undefined;
    },
    300_000,
    "the follow-up routed",
  );
  mark(`follow-up: task_id=${routed.task_id} ignored=${routed.ignored}`);
  assert.equal(routed.task_id, id);
  const batches = db((d) => (d.prepare("SELECT MAX(consumed) AS n FROM events").get() as { n: number }).n);
  mark(`batches so far: ${batches} (follow-up in #${batches > batchesBefore ? batches : "?"})`);
  const usage = db((d) => d.prepare("SELECT day, tokens FROM planner_usage").all());
  mark(`planner_usage: ${JSON.stringify(usage)}`);
});

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Approve what is pending on a task until `done` holds: the walk is about routing and counting, not the gate. */
async function approving<T>(id: string, done: () => T | undefined, ms: number, what: string): Promise<T> {
  return until(
    async () => {
      for (const a of (await api<{ approvals: { id: number; category: string }[] }>("task.get", { id })).approvals)
        await api("approval.decide", { id: a.id, decision: "approve" });
      return done();
    },
    ms,
    what,
  );
}

test("a message posted while hortusd is down reaches the Planner at the reconcile, and is answered once", {
  skip,
  timeout: 600_000,
}, async () => {
  // what the first sync of a scope reads is history: it has to have run
  await until(
    () => db((d) => d.prepare("SELECT 1 FROM syncs WHERE scope = 'D1' AND first IS NOT NULL").get()),
    20_000,
    "D1's first sync",
  );
  spawnSync("sudo", ["systemctl", "stop", UNIT], { stdio: "ignore" });
  fake.epoch = Math.floor(Date.now() / 1000); // a message older than the scope's first sync is history, not news
  const asked = fake.post("D1", { user: "U1", text: "Reply to this DM with the word heron", quiet: true });
  mark("owner's DM posted with hortusd down");
  await tick(500);
  fake.calls.length = 0;
  await startDaemon();
  const id = await until(() => eventTask("the word heron")?.task_id, 300_000, "the Planner's task");
  mark(`routed to ${id}`);
  const row = db((d) => d.prepare("SELECT key, trusted FROM events WHERE summary LIKE '%the word heron%'").all()) as {
    key: string;
    trusted: number;
  }[];
  assert.equal(row.length, 1, "one event, whatever redelivers");
  assert.match(row[0]?.key ?? "", /^history:/);
  assert.equal(row[0]?.trusted, 1);
  const reply = await approving(
    id,
    () => fake.calls.find((c) => c.method === "chat.postMessage" && /heron/i.test(c.params.text ?? "")),
    300_000,
    "the reply",
  );
  mark(`answered: ${String(reply.params.text).slice(0, 120)} (thread ${reply.params.thread_ts} of ${asked.ts})`);
});

test("a Worker's own curl to its model is counted, streamed or not, and past the budget its model calls end", {
  skip,
  timeout: 600_000,
}, async () => {
  const curl = (body: string) =>
    `curl -s https://ollama.com/v1/chat/completions -H 'Authorization: Bearer hortus-secret-ollama-cloud' -H 'Content-Type: application/json' -d '{"model":"${MODEL}","messages":[{"role":"user","content":"Say hi"}]${body}}' | tail -c 200`;
  const text = `Run these three commands with bash, once each, then call done with a one-line summary.\n${curl("")}\n${curl(',"stream":true')}\n${curl(',"stream":true,"stream_options":{"include_usage":true}')}`;
  const { id } = await api<{ id: string }>("task.open", { text });
  const row = () =>
    db((d) => d.prepare("SELECT status, metered, usage, error FROM tasks WHERE id = ?").get(id)) as {
      status: string;
      metered: number;
      usage: string | null;
      error: string | null;
    };
  await approving(id, () => (row().status === "waiting" ? true : undefined), 300_000, "the turn's end");
  const r = row();
  const sessions = (JSON.parse(r.usage ?? "{}") as { tokens?: number }).tokens ?? 0;
  mark(`metered ${r.metered}, usage ${sessions}, error ${r.error}`);
  assert.ok(r.metered > 0);
  assert.equal(sessions, r.metered, "the proxy saw every call, so its count is the task's, not a sum");

  db((d) =>
    d.prepare("UPDATE tasks SET budget = ?, metered = ? WHERE id = ?").run('{"tokens":1,"hours":1}', 200_000, id),
  );
  await api("task.send", { id, text: "Say hi again." });
  await until(
    () => (/^budget_exceeded: .*through the proxy/.test(row().error ?? "") ? true : undefined),
    120_000,
    "the stop",
  );
  mark(`stopped: ${row().error}`);
  assert.equal(row().status, "waiting");
});
