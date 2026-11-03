/**
 * Step 3 done-when, live (HORTUS_TEST_NET=1 and HORTUS_TEST_LLM=1, passwordless sudo): the daemon as a transient
 * system unit with its capabilities (like step 2's variant), real host sessions on 10.77.1.n, the fake Slack behind
 * `dev.upstreams`, and a real model (`ollama-cloud` copied from the owner's ~/.hortus/secrets.json into the temp
 * vault, the only read of that file, test-only). HOME is a temp directory; the owner's real dotfiles are added to
 * `policy.deny` so the chat profile cannot reach them either. Prints a timeline of what the model did.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { openDb } from "../db.ts";
import * as paths from "../paths.ts";
import { FakeSlack } from "../test/fakes/slack.ts";
import { tempDir, until } from "../test/until.ts";

const LIVE = process.env.HORTUS_TEST_NET === "1" && process.env.HORTUS_TEST_LLM === "1";
const UNIT = "hortusd-step3test";
const bin = (name: string) => new URL(`../bin/${name}.js`, import.meta.url).pathname;
const realHome = homedir();

let home: string;
let project: string;
let fake: FakeSlack;
let thread = "";
const port = 7790 + (process.pid % 100);
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

interface Card {
  task: { status: string; title: string; summary: string | null; error: string | null };
  replies: { seq: number; body: Record<string, unknown> }[];
  approvals: { id: number; category: string }[];
}
const card = (id: string) => api<Card>("task.get", { id });
const idle = (id: string, ms = 300_000) =>
  until(
    async () => {
      const s = (await card(id)).task.status;
      return s === "waiting" || s === "done" || s === "failed";
    },
    ms,
    `${id} idle`,
  );
/** every replies row of a task (task.get returns only the last 1000, and text deltas are one row each) */
const rows = (id: string, after = 0): Record<string, unknown>[] => {
  const db = openDb(paths.db());
  try {
    return (
      db.prepare("SELECT body FROM replies WHERE task_id = ? AND seq > ? ORDER BY seq").all(id, after) as {
        body: string;
      }[]
    ).map((r) => JSON.parse(r.body));
  } finally {
    db.close();
  }
};
const lastSeq = (id: string) => {
  const db = openDb(paths.db());
  const { n } = db.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM replies WHERE task_id = ?").get(id) as { n: number };
  db.close();
  return n;
};
const commands = (id: string) =>
  rows(id)
    .filter((r) => r.type === "tool_call")
    .map((r) => JSON.stringify(r.input ?? {}));
/** what the model told the owner after `after`: streamed text plus send/done texts */
const said = (id: string, after = 0) =>
  rows(id, after)
    .map((r) => (r.type === "text" ? r.text : r.type === "tool_call" ? JSON.stringify(r.input) : ""))
    .join("");
const outputs = (id: string) =>
  rows(id)
    .filter((r) => r.type === "tool_result")
    .map((r) => String(r.output))
    .join("\n");

before(async () => {
  if (!LIVE) return;
  const owner = JSON.parse(readFileSync(join(realHome, ".hortus", "secrets.json"), "utf8")) as Record<
    string,
    { apiKey: string }
  >;
  const key = owner["ollama-cloud"]?.apiKey;
  assert.ok(key, "~/.hortus/secrets.json has no ollama-cloud entry");
  home = tempDir("hortus-step3live-");
  process.env.HORTUS_HOME = join(home, ".hortus");
  mkdirSync(paths.home(), { recursive: true, mode: 0o700 });
  project = join(home, "foo");
  mkdirSync(project);
  writeFileSync(join(project, "README.md"), "# foo\n\nA test project.\n");
  const git = (...a: string[]) => execFileSync("git", ["-C", project, ...a], { stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  git("add", "README.md");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "readme");

  fake = await FakeSlack.start();
  fake.user("U1", "alice");
  fake.channel("C1", { name: "general", members: ["U1", fake.botUser] });
  thread = fake.post("C1", { user: "U1", text: "When do we deploy the new billing service?" }).ts;
  fake.post("C1", {
    user: "U1",
    text: "The deploy is planned for Friday 18:00 after the freeze ends.",
    thread_ts: thread,
  });

  const deny = [".hortus", ".ssh", ".gnupg", ".aws", ".config", ".netrc", ".password-store", ".kube", ".docker"];
  writeFileSync(
    join(paths.home(), "hortusd.json"),
    JSON.stringify({
      owner: { tz: "UTC" },
      dofs: { slack: { type: "slack", owner: "U1" } },
      dev: { upstreams: { "slack.com": fake.url } },
      worker: { provider: "ollama-cloud", model: "deepseek-v4.1-flash:1017", budget: { tokens: 3e6, hours: 1 } },
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
  await until(() => existsSync(join(paths.dof("slack"), "C1", thread, `${thread}.md`)), 30_000, "the mirrored thread");
  mark("daemon up, thread mirrored");
});

after(async () => {
  if (!LIVE) return;
  if (process.env.KEEP !== "1") cleanupNet();
  await fake.close();
  if (process.env.KEEP !== "1") rmSync(home, { recursive: true, force: true });
});

const skip = !LIVE && "needs HORTUS_TEST_NET=1 and HORTUS_TEST_LLM=1";
let slackTask = "";

test("chat from the web UI: dof search → curl chat.postMessage → 403 approval → approve → posted with the real token", {
  skip,
  timeout: 600_000,
}, async () => {
  const { id } = await api<{ id: string }>("task.open", {
    text: "Search the slack DOF for `deploy` and post a one-line summary as a reply in that thread via the Slack API.",
  });
  slackTask = id;
  mark(`task.open ${id}`);
  const approval = await until(async () => (await card(id)).approvals[0], 300_000, "a pending approval");
  mark(`approval #${approval.id} ${approval.category} pending`);
  const page = await (await fetch(`http://127.0.0.1:${port}/approvals`)).text();
  assert.match(page, new RegExp(`id="a${approval.id}"`));
  assert.match(page, /slack\.com/);
  // the model may probe (auth.test) before it posts: approve whatever this task asks for until the post lands
  const post = await until(
    async () => {
      for (const a of (await card(id)).approvals) {
        await api("approval.decide", { id: a.id, decision: "approve" });
        mark(`approved #${a.id}`);
      }
      return fake.calls.find((x) => x.method === "chat.postMessage");
    },
    300_000,
    "chat.postMessage at the fake",
  );
  assert.ok(
    commands(id).some((x) => x.includes("dof search")),
    commands(id).join("\n"),
  );
  assert.ok(commands(id).some((x) => x.includes("chat.postMessage") && x.includes("hortus-secret-slack")));
  mark(`fake Slack got chat.postMessage: ${JSON.stringify(post.params).slice(0, 200)}`);
  assert.equal(post.params.thread_ts, thread);
  assert.ok(fake.auths.includes(`Bearer ${fake.botToken}`));
  assert.ok(!fake.auths.some((a) => a.includes("hortus-secret")));
  await until(() => readdirSync(join(paths.dof("slack"), "C1", thread)).length > 2, 30_000, "the reply in the mirror");
  mark("reply mirrored");
  await idle(id);
});

let editTask = "";
test("edit README.md of project foo in place; reopen the chat: context kept; hortus tasks shows it", {
  skip,
  timeout: 600_000,
}, async () => {
  const { id } = await api<{ id: string }>("task.open", {
    text: "Add the line `Maintained by hortus.` at the end of README.md of this project.",
    cwd: project,
  });
  editTask = id;
  mark(`task.open ${id} (cwd foo)`);
  await idle(id);
  await until(() => readFileSync(join(project, "README.md"), "utf8").includes("Maintained by hortus."), 60_000, "edit");
  // in place: uncommitted in the owner's checkout, or committed there by the model
  const st = execFileSync("git", ["-C", project, "status", "--porcelain"], { encoding: "utf8" });
  const commits = execFileSync("git", ["-C", project, "rev-list", "--count", "HEAD"], { encoding: "utf8" });
  assert.ok(/README\.md/.test(st) || Number(commits) > 2, `${st} ${commits}`);
  mark("README.md edited in place");

  const page = await (await fetch(`http://127.0.0.1:${port}/chat/${id}`)).text();
  assert.match(page, /README/);
  const before = lastSeq(id);
  await api("task.send", { id, text: "Which exact line did you just add, and to which file? Answer in one sentence." });
  await until(() => lastSeq(id) > before + 2, 60_000, "the turn started");
  await idle(id);
  const answer = said(id, before);
  mark(`context answer: ${answer.replace(/\s+/g, " ").slice(-200)}`);
  assert.match(answer, /Maintained by hortus/);
  const cli = execFileSync(process.execPath, [bin("hortus"), "tasks"], {
    env: { ...process.env, HORTUS_HOME: paths.home() },
    encoding: "utf8",
  });
  assert.match(cli, new RegExp(id));
});

test("a second chat finds the first through dof search --in logs; vault.json is denied", {
  skip,
  timeout: 600_000,
}, async () => {
  const title = (await card(slackTask)).task.title;
  await api("task.close", { id: slackTask, outcome: "done" });
  mark("closed the slack task");
  const { id } = await api<{ id: string }>("task.open", {
    text: `What did the earlier task "${title}" conclude? Look it up with dof search --in logs. Then run cat ~/.hortus/vault.json and tell me what happened.`,
  });
  await idle(id);
  mark(`second chat: ${commands(id).join(" | ").slice(0, 600)}`);
  assert.ok(
    commands(id).some((x) => x.includes("dof search") && x.includes("logs")),
    commands(id).join("\n"),
  );
  assert.match(outputs(id), new RegExp(`logs/${slackTask}/`));
  assert.match(outputs(id), /Permission denied/);
  await api("task.close", { id: editTask, outcome: "done" });
  await api("task.close", { id, outcome: "done" });
});
