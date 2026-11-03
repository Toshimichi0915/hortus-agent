/**
 * Step 3 (07-step3-runtime.md › Functional tests, the parts that need no network): the real daemon (HORTUS_NO_NET=1)
 * in a delegated user scope (`systemd-run --user --scope -p Delegate=yes`, so sessions get cgroups), real sandboxed
 * Workers (Landlock) and a fake provider plugin shipped through `worker.plugins`. The fake "model" acts on directive
 * lines in the last user message (`!bash <cmd>`, `!done <summary>`, `!send <text>`, `!fail`), answers a tool result
 * with `tool said: …`, and anything else with `echo: <last line>`; it records every request to `<fake>/<task>.jsonl`.
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { openDb } from "../db.ts";
import * as paths from "../paths.ts";
import { rpcClient } from "../rpc.ts";
import { tempDir, until } from "../test/until.ts";

const hasScope = spawnSync("systemd-run", ["--user", "--scope", "-q", "--", "true"]).status === 0;
const bin = (name: string) => new URL(`../bin/${name}.js`, import.meta.url).pathname;
const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

const FAKE = (dir: string) => `
import { appendFileSync } from "node:fs";
const DIR = ${JSON.stringify(dir)};
const complete = async (req, onText) => {
  const id = (process.env.HORTUS_TASK ?? "").split("/").at(-3);
  appendFileSync(DIR + "/" + id + ".jsonl", JSON.stringify({ messages: req.messages, tools: req.tools.map((t) => t.name) }) + "\\n");
  if (!req.tools.length) return { role: "assistant", text: "notes from fake", toolCalls: [] };
  const usage = { input: 10, output: 5, cached: 0 };
  const last = req.messages.at(-1);
  if (last.role === "tool") {
    const text = "tool said: " + last.results.map((r) => r.output).join("\\n").slice(0, 2000);
    onText(text);
    return { role: "assistant", text, toolCalls: [], usage };
  }
  const content = last.content ?? "";
  if (content.includes("!fail")) throw new Error("fake failure");
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
let project: string;
let port: number;
let daemon: ChildProcess | undefined;
let unit = "";
let n = 0;

function startDaemon(): void {
  unit = `hortusd-step3-${process.pid}-${++n}`;
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
      env: { ...process.env, HORTUS_HOME: home, HORTUS_CONSOLE_PORT: String(port), HORTUS_NO_NET: "1" },
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
  task: { status: string; project: string | null; error: string | null; summary: string | null; usage: unknown };
  replies: { seq: number; body: Record<string, unknown> }[];
}
const card = (id: string) => api<Card>("task.get", { id });
const status = async (id: string) => (await card(id)).task.status;
const waitStatus = (id: string, s: string, ms = 15_000) =>
  until(async () => (await status(id)) === s, ms, `${id} ${s}`);
/** recorded model requests (with tools) of a task */
const reqs = (id: string): { messages: { role: string; content?: string; text?: string }[] }[] => {
  const p = join(fake, `${id}.jsonl`);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => r.tools.length);
};
const texts = (c: Card) => c.replies.map((r) => r.body.text ?? r.body.message ?? "").join("\n");
/** one turn: send, then wait for running → waiting */
const turn = async (id: string, text: string) => {
  const before = reqs(id).length;
  await api("task.send", { id, text });
  await until(() => reqs(id).length > before, 15_000, "a model call");
  await waitStatus(id, "waiting");
};

before(async () => {
  if (!hasScope) return;
  home = tempDir("hortus-step3-");
  fake = tempDir("hortus-step3fake-");
  process.env.HORTUS_HOME = home;
  mkdirSync(join(fake, "plugins", "fake"), { recursive: true });
  writeFileSync(
    join(fake, "plugins", "fake", "hortus.json"),
    JSON.stringify({ name: "fake", version: "1.0.0", entrypoint: "fake.mjs" }),
  );
  writeFileSync(join(fake, "plugins", "fake", "fake.mjs"), FAKE(fake));
  // the project is configured through a symlink: task.open matches by realpath
  project = join(fake, "foo");
  mkdirSync(join(project, "sub"), { recursive: true });
  symlinkSync(project, join(fake, "foolink"));
  port = await freePort();
  writeFileSync(
    join(home, "hortusd.json"),
    JSON.stringify({
      owner: { tz: "UTC" },
      worker: { provider: "fake", model: "m", plugins: [join(fake, "plugins", "fake")] },
      projects: { foo: { path: join(fake, "foolink") } },
      proxy: { https: await freePort(), http: await freePort(), dns: 0 },
    }),
  );
  writeFileSync(
    join(home, "vault.json"),
    JSON.stringify({
      fake: { type: "token", value: "x", transform: "fake" },
      broken: { type: "token", value: "x", transform: "nope" },
    }),
    { mode: 0o600 },
  );
  startDaemon();
  await up();
});

after(async () => {
  if (!hasScope) return;
  if (daemon && daemon.exitCode === null) {
    daemon.kill("SIGTERM");
    await new Promise((r) => daemon?.once("exit", r));
  }
  spawnSync("systemctl", ["--user", "stop", `${unit}.scope`], { stdio: "ignore" });
  rmSync(home, { recursive: true, force: true });
  if (!process.env.KEEP) rmSync(fake, { recursive: true, force: true });
});

const skip = !hasScope && "no systemd-run --user (delegated cgroups)";
let chatA = "";

test("chat: open → Worker → replies + SSE → waiting; resume keeps the context", { skip }, async () => {
  const { id } = await api<{ id: string }>("task.open", { text: "hello zebracorn", cwd: join(project, "sub") });
  chatA = id;
  await waitStatus(id, "waiting");
  const c = await card(id);
  assert.equal(c.task.project, "foo");
  // the owner's own words first (the chat shows both sides), then the Worker's
  assert.deepEqual(c.replies[0]?.body, { type: "owner", text: "hello zebracorn" });
  assert.equal(c.replies[1]?.body.text, "started");
  assert.match(texts(c), /echo: hello zebracorn/);
  const task = JSON.parse(readFileSync(join(paths.ctl(id), "task.json"), "utf8"));
  assert.equal(task.cwd, join(project, "sub"));
  assert.equal(task.projects.foo.path, join(fake, "foolink"));
  const secrets = JSON.parse(readFileSync(join(paths.ctl(id), "home", ".hortus", "secrets.json"), "utf8"));
  assert.deepEqual(secrets, { fake: { type: "fake", apiKey: "hortus-secret-fake" } });
  assert.ok(existsSync(join(paths.ctl(id), "home", ".hortus", "plugins", "fake", "fake.mjs")));

  // the chat SSE replays the rows
  const ac = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}/events/chat?task=${id}&after=-1`, { signal: ac.signal });
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  let sse = "";
  while (!sse.includes("echo: hello zebracorn")) sse += new TextDecoder().decode((await reader.read()).value);
  ac.abort();

  await turn(id, "and again");
  const last = reqs(id).at(-1);
  const contents = last?.messages.map((m) => m.content ?? m.text ?? "") ?? [];
  assert.ok(
    contents.some((t) => t.startsWith("[inbox 1] from=owner\nhello zebracorn")),
    String(contents),
  );
  assert.ok(contents.includes("echo: hello zebracorn"));
  assert.equal(contents.at(-1), "[inbox 2] from=owner\nand again");

  // F4: a chat session (rw everywhere else) cannot open the vault
  await turn(id, `!bash cat ${join(home, "vault.json")}`);
  assert.match(texts(await card(id)), /tool said: .*Permission denied/s);
});

test("stop: STOP after the running tool → waiting; the next message resumes it", { skip }, async () => {
  await api("task.send", { id: chatA, text: "!bash sleep 2; echo slept" });
  const inTool = async () =>
    (await card(chatA)).replies.some((r) => r.body.type === "tool_call" && JSON.stringify(r.body).includes("sleep 2"));
  await until(inTool, 15_000, "the tool call");
  await api("task.stop", { id: chatA });
  await waitStatus(chatA, "waiting");
  const before = reqs(chatA).length;
  await turn(chatA, "after the stop");
  const msgs = reqs(chatA).at(-1)?.messages ?? [];
  assert.ok(reqs(chatA).length > before);
  assert.ok(JSON.stringify(msgs).includes("slept"), "the tool result from before the stop is in the context");
});

test("PAUSED, owner messages while queued in the first drain, two sends get consecutive seqs, cwd outside projects", {
  skip,
}, async () => {
  await api("pause.set", { paused: true });
  const { id } = await api<{ id: string }>("task.open", { text: "paused one", cwd: tmpdir() });
  const seqs = await Promise.all([
    api<{ seq: number }>("task.send", { id, text: "x" }),
    api<{ seq: number }>("task.send", { id, text: "y" }),
  ]);
  assert.deepEqual(seqs.map((s) => s.seq).sort(), [2, 3]);
  await new Promise((r) => setTimeout(r, 2500));
  assert.equal(await status(id), "queued");
  const t0 = Date.now();
  await api("pause.set", { paused: false });
  await until(async () => (await status(id)) !== "queued", 3000, "started");
  assert.ok(Date.now() - t0 < 2500);
  await waitStatus(id, "waiting");
  const first = reqs(id)[0]?.messages.map((m) => m.content ?? "") ?? [];
  assert.deepEqual(
    first.filter((c) => c.startsWith("[inbox")).map((c) => c.split("\n")[0]),
    ["[inbox 1] from=owner", "[inbox 2] from=owner", "[inbox 3] from=owner"],
  );
  assert.equal((await card(id)).task.project, null);
});

test("hostile out/: symlink, 2 MB and unknown-type outbox files ignored; summary capped at 64 KB", {
  skip,
}, async () => {
  const { id } = await api<{ id: string }>("task.open", { text: "hostile" });
  await waitStatus(id, "waiting");
  const sh = [
    "mkdir -p ../outbox",
    "ln -s /etc/passwd ../outbox/000009.json",
    "head -c 2000000 /dev/zero | tr '\\0' a > ../outbox/000010.json",
    `echo '{"seq":11,"type":"evil","text":"x","ts":"t"}' > ../outbox/000011.json`,
    `echo '{"seq":12,"type":"reply","text":"good one","ts":"t"}' > ../outbox/000012.json`,
    "head -c 1000000 /dev/zero | tr '\\0' b > ../summary.md",
  ].join(" && ");
  await turn(id, `!bash ${sh}\n!done`);
  const db = openDb(paths.db());
  const rows = db.prepare("SELECT seq, body FROM outbox WHERE task_id = ? ORDER BY seq").all(id) as {
    seq: number;
    body: string;
  }[];
  const summary = (db.prepare("SELECT summary FROM tasks WHERE id = ?").get(id) as { summary: string }).summary;
  db.close();
  assert.deepEqual(
    rows.map((r) => r.seq),
    [12],
  );
  assert.equal(JSON.parse(rows[0]?.body ?? "{}").text, "good one");
  assert.equal(summary.length, 64 * 1024);
  assert.match(readFileSync(join(fake, "hortusd.log"), "utf8"), /outbox file ignored: not a regular file/);
});

test("over budget with an undrained message: waiting, no restart loop", { skip }, async () => {
  const { id } = await api<{ id: string }>("task.open", { text: "spend" });
  await waitStatus(id, "waiting");
  await api("task.budget", { id, tokens: 1 });
  await api("task.send", { id, text: "one more" });
  await until(async () => (await card(id)).replies.some((r) => r.body.text === "budget"), 15_000, "budget");
  await waitStatus(id, "waiting");
  await new Promise((r) => setTimeout(r, 2500));
  const c = await card(id);
  assert.equal(c.task.status, "waiting");
  assert.equal(c.replies.filter((r) => r.body.text === "started").length, 2, "one start per message, no loop");
});

test("hostile out/: a link planted at summary.md is never followed by hortusd", { skip }, async () => {
  const { id } = await api<{ id: string }>("task.open", { text: "links" });
  await waitStatus(id, "waiting");
  await turn(id, `!bash ln -sf ${join(home, "vault.json")} ../summary.md\n!done`); // done(""): no summary rewrite
  const published = readFileSync(join(home, "dof", "logs", id, "summary.md"), "utf8");
  assert.ok(!published.includes('"value"'), published);
});

test("a Worker that dies before any model call: waiting with the error on the card, no restart loop", {
  skip,
}, async () => {
  const { config } = await api<{ config: Record<string, Record<string, unknown>> }>("settings.get");
  await api("settings.set", { config: { ...config, worker: { ...config.worker, provider: "broken" } } });
  try {
    const { id } = await api<{ id: string }>("task.open", { text: "doomed" });
    await waitStatus(id, "waiting");
    const c = await card(id);
    assert.match(c.task.error ?? "", /Unknown provider type: nope/);
    await new Promise((r) => setTimeout(r, 2500));
    const again = await card(id);
    assert.equal(again.task.status, "waiting");
    assert.equal(again.replies.filter((r) => r.body.text === "started").length, 1);
    const page = await (await fetch(`http://127.0.0.1:${port}/tasks/${id}`)).text();
    assert.match(page, /Unknown provider type/);
  } finally {
    await api("settings.set", { config });
  }
});

test("close: dirs gone, logs DOF entry; another chat's Worker finds it with dof search --in logs", {
  skip,
}, async () => {
  await api("task.close", { id: chatA, outcome: "done" });
  assert.equal(await status(chatA), "done");
  assert.ok(!existsSync(paths.task(chatA)));
  assert.ok(existsSync(join(paths.logs(), chatA, "session.md")));
  const rpc = rpcClient(paths.socket());
  const hits = (await rpc.call("dof.search", { q: "zebracorn", in: "logs" })) as { path: string }[];
  rpc.close();
  assert.ok(
    hits.some((h) => h.path.startsWith(`${chatA}/`)),
    JSON.stringify(hits),
  );
  const log = await (await fetch(`http://127.0.0.1:${port}/tasks/${chatA}/log`)).text();
  assert.match(log, /hello zebracorn/);

  const { id } = await api<{ id: string }>("task.open", { text: "!bash dof search --in logs zebracorn" });
  await waitStatus(id, "waiting");
  assert.match(texts(await card(id)), new RegExp(`tool said: logs/${chatA}/`));
});

/** An unattended task straight into the queue (no Planner in this test), its brief one model directive. */
function enqueue(brief: string): string {
  const id = `u${Date.now().toString(36)}`;
  const db = openDb(paths.db());
  const t = new Date().toISOString();
  db.prepare(
    `INSERT INTO tasks(id, kind, title, brief, status, scope, budget, usage, runtime, event_keys, created, updated, hours)
     VALUES (?, 'unattended', 't', ?, 'queued', ?, ?, '{"tokens":0}', 'host', '[]', ?, ?, 0)`,
  ).run(id, brief, JSON.stringify({ credentials: [], repos: [] }), JSON.stringify({ tokens: 1e6, hours: 1 }), t, t);
  db.close();
  return id;
}

test("unattended tool homes: npm, npx, pnpm, venv/pip, git work offline under the profile", { skip }, async () => {
  // each step's output is checked for a sandbox refusal; tools missing here are skipped
  const script = join(fake, "tools.sh");
  writeFileSync(
    script,
    `r() { if "$@" > log 2>&1; then echo "ok: $*"; else echo "FAIL: $*"; tail -5 log; fi
  if grep -E 'EACCES|EPERM|EROFS|Permission denied|Read-only file system|Unknown env config' log; then echo "SANDBOX: $*"; fi; }
has() { command -v "$1" > /dev/null; }
mkdir b && cd b && mkdir lp
echo '{"name":"lp","version":"1.0.0","bin":{"lp":"x.js"}}' > lp/package.json
printf '#!/usr/bin/env node\\nconsole.log("lp ran")\\n' > lp/x.js
if has npm; then r npx --offline --yes ./lp; r npm init -y; r npm i --offline ./lp; fi
if has pnpm; then mkdir pn && cd pn && r pnpm init && r pnpm add --offline ../lp && r pnpm store path; cd ..; fi
if has gh; then r gh config get git_protocol; fi
if python3 -c 'import ensurepip' 2> /dev/null; then r python3 -m venv .venv && r .venv/bin/pip --version; fi
r git init -q g && r git -C g config user.name x && r mkdir "$HOME/.cache/hortus-step3-$$" && rmdir "$HOME/.cache/hortus-step3-$$"
echo end
`,
  );
  const id = enqueue(`!bash bash ${script}`);
  await waitStatus(id, "waiting", 60_000);
  const out = JSON.stringify(reqs(id).at(-1)?.messages.at(-1));
  assert.match(out, /ok: git -C g config/, out);
  assert.match(out, /end/, out);
  assert.doesNotMatch(out, /FAIL|SANDBOX/, out);
});

test("recovery after SIGKILL: running chat → waiting, unattended → queued and resumes with its context", {
  skip,
}, async () => {
  const { id: chat } = await api<{ id: string }>("task.open", { text: "!bash sleep 30" });
  const un = enqueue("!bash sleep 30");
  // in their tool = the assistant message with the call is in the session file (a fixed delay after the model request
  // raced that write under load, and the resumed context then had no call to interrupt)
  const inTool = (id: string) => {
    const dir = join(paths.out(id), "sessions");
    return (
      existsSync(dir) &&
      readdirSync(dir).some((f) => readFileSync(join(dir, f), "utf8").includes('"command":"sleep 30"'))
    );
  };
  await until(() => inTool(chat) && inTool(un), 15_000, "both sessions in their tool");
  const exited = new Promise((r) => daemon?.once("exit", r));
  spawnSync("systemctl", ["--user", "kill", "-s", "KILL", `${unit}.scope`]);
  await exited;
  spawnSync("systemctl", ["--user", "stop", `${unit}.scope`], { stdio: "ignore" });
  startDaemon();
  await up();
  assert.equal(await status(chat), "waiting");
  await until(() => reqs(un).length > 1, 15_000, "the unattended task resumed");
  await waitStatus(un, "waiting");
  const resumed = reqs(un).at(-1)?.messages ?? [];
  assert.equal(resumed[0]?.content, "!bash sleep 30");
  assert.match(JSON.stringify(resumed), /interrupted by restart/);
});
