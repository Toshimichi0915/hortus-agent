/**
 * Step 3c with real Workers (09-schedules.md › Functional tests): the daemon (HORTUS_NO_NET=1) in a delegated user
 * scope as in step3.test.ts, its schedule tick every 300 ms (HORTUS_SCHEDULE_TICK_MS), and the clock advanced by
 * moving a row's `fire_at` into the past. The fake provider acts on directive lines in the last user message:
 * `!call <tool> <json input>`, `!done <summary>`; it records every request to `<fake>/<task>.jsonl`.
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { openDb } from "../db.ts";
import * as paths from "../paths.ts";
import { freePort, stopped, tempDir, until } from "../test/until.ts";

const hasScope = spawnSync("systemd-run", ["--user", "--scope", "-q", "--", "true"]).status === 0;
const bin = (name: string) => new URL(`../bin/${name}.js`, import.meta.url).pathname;

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
  const calls = [];
  for (const line of content.split("\\n")) {
    const c = /^!call (\\w+) (.*)$/.exec(line.trim());
    if (c) calls.push({ id: "c" + Date.now() + "_" + calls.length, name: c[1], input: JSON.parse(c[2]) });
    const d = /^!done ?(.*)$/.exec(line.trim());
    if (d) calls.push({ id: "c" + Date.now() + "_" + calls.length, name: "done", input: { summary: d[1] } });
  }
  const text = "echo: " + content.split("\\n").at(-1);
  onText(text);
  return { role: "assistant", text, toolCalls: calls, usage };
};
export default { providers: { fake: { create: () => ({ complete, listModels: async () => ["m"] }) } } };
`;

let home: string;
let fake: string;
let port: number;
let daemon: ChildProcess | undefined;
const unit = `hortusd-step3c-${process.pid}`;

before(async () => {
  if (!hasScope) return;
  home = tempDir("hortus-step3c-");
  fake = tempDir("hortus-step3cfake-");
  process.env.HORTUS_HOME = home;
  mkdirSync(join(fake, "plugins", "fake"), { recursive: true });
  writeFileSync(
    join(fake, "plugins", "fake", "hortus.json"),
    JSON.stringify({ name: "fake", version: "1.0.0", entrypoint: "fake.mjs" }),
  );
  writeFileSync(join(fake, "plugins", "fake", "fake.mjs"), FAKE(fake));
  port = await freePort();
  writeFileSync(
    join(home, "hortusd.json"),
    JSON.stringify({
      // the fake provider records its requests here, from inside the sandbox
      policy: { "*": "human", cache: [fake] },
      owner: { tz: "UTC" },
      worker: { provider: "fake", model: "m", plugins: [join(fake, "plugins", "fake")] },
      proxy: { https: await freePort(), http: await freePort(), dns: 0 },
    }),
  );
  writeFileSync(join(home, "vault.json"), JSON.stringify({ fake: { type: "token", value: "x", transform: "fake" } }), {
    mode: 0o600,
  });
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
        HORTUS_SCHEDULE_TICK_MS: "300",
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  daemon.stderr?.pipe(createWriteStream(join(fake, "hortusd.log"), { flags: "a" }));
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
  rmSync(home, { recursive: true, force: true });
  if (!process.env.KEEP) rmSync(fake, { recursive: true, force: true });
});

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
const status = async (id: string) => (await api<{ task: { status: string } }>("task.get", { id })).task.status;
const waitStatus = (id: string, s: string, ms = 15_000) =>
  until(async () => (await status(id)) === s, ms, `${id} ${s}`);
const reqs = (id: string): { messages: { role: string; content?: string }[] }[] => {
  const p = join(fake, `${id}.jsonl`);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((l) => {
      // the fake appends while the test reads: a line still being written is skipped
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    })
    .filter((r) => r.tools.length);
};
/** a read-write handle on the daemon's DB (WAL): the test's clock is a row's fire_at */
const sql = <T>(q: string, ...args: (string | number)[]): T[] => {
  const db = openDb(paths.db());
  try {
    return db.prepare(q).all(...args) as T[];
  } finally {
    db.close();
  }
};
const schedules = (task: string) =>
  sql<{ id: number; fire_at: string; last_run: string | null }>("SELECT * FROM schedules WHERE task_id = ?", task);
const fireNow = (id: number) =>
  sql("UPDATE schedules SET fire_at = ? WHERE id = ? RETURNING id", new Date(Date.now() - 1000).toISOString(), id);
const runsOf = (p: string) =>
  sql<{ id: string; status: string; title: string }>("SELECT * FROM tasks WHERE parent = ? ORDER BY created", p);

const skip = !hasScope && "no systemd-run --user (delegated cgroups)";

test("v6 done-when: schedule(at = now + 2 min), done → waiting; at the tick the task resumes with its context", {
  skip,
}, async () => {
  const at = new Date(Date.now() + 2 * 60_000).toISOString();
  const text = [
    `!call schedule {"text":"too often","every":60}`,
    `!call schedule {"text":"check the build again","at":"${at}"}`,
    "!done",
  ].join("\n");
  const { id } = await api<{ id: string }>("task.open", { text });
  await waitStatus(id, "waiting");
  const card = await api<{ replies: { body: { type?: string; output?: string } }[] }>("task.get", { id });
  const outputs = card.replies.filter((r) => r.body.type === "tool_result").map((r) => r.body.output ?? "");
  assert.ok(
    outputs.some((o) => /minimum interval is 5 minutes/.test(o)),
    JSON.stringify(outputs),
  );
  const [row] = schedules(id);
  assert.ok(row);
  assert.equal(row.fire_at, at);
  const before = reqs(id).length;
  fireNow(row.id);
  await until(() => reqs(id).length > before, 15_000, "the task woken");
  await waitStatus(id, "waiting");
  const msgs =
    reqs(id)
      .at(-1)
      ?.messages.map((m) => m.content ?? "") ?? [];
  assert.ok(
    msgs.some((c) => c.includes("check the build again") && c.startsWith("[inbox 1] from=owner")),
    "context kept",
  );
  assert.match(
    msgs.at(-1) ?? "",
    new RegExp(`^\\[inbox 2\\] from=schedule:${row.id} trusted=true\\n<<<quoted\\ncheck the build again`),
  );
  assert.equal(schedules(id).length, 0);
});

test("an hourly script row: quiet → the run is deleted without logs; output → a fresh run with text, output and the previous summary; /schedule persists, work/ does not", {
  skip,
}, async () => {
  const script = "n=$(cat count 2>/dev/null || echo 0); echo $((n+1)) > count; cat flag 2>/dev/null || true";
  const input = JSON.stringify({ text: "report what the script found", every: 3600, script });
  const { id } = await api<{ id: string }>("task.open", { text: `!call schedule ${input}\n!done` });
  await waitStatus(id, "waiting");
  const [row] = schedules(id);
  assert.ok(row);
  const dir = paths.schedule(row.id);

  // 1: the script prints nothing
  fireNow(row.id);
  await until(() => existsSync(join(dir, "count")), 15_000, "the script ran");
  await until(() => runsOf(id).length === 0 && existsSync(dir), 15_000, "the quiet run deleted");
  assert.ok(schedules(id)[0]?.last_run, "last_run updated");
  assert.ok(Date.parse(schedules(id)[0]?.fire_at ?? "") > Date.now() + 50 * 60_000, "advanced by an hour");
  // every logs entry belongs to a task that still exists
  assert.deepEqual(
    sql(
      "SELECT path FROM search_meta WHERE dof = 'logs' AND substr(path, 1, instr(path, '/') - 1) NOT IN (SELECT id FROM tasks)",
    ),
    [],
  );

  // 2: it prints `found 1` (and a directive the fake acts on)
  writeFileSync(join(dir, "flag"), "found 1\n!done found one thing");
  fireNow(row.id);
  const first = await until(() => runsOf(id)[0], 15_000, "a run");
  await waitStatus(first.id, "waiting");
  assert.match(first.title, /^.* @ \d{4}-\d\d-\d\d \d\d:\d\d$/);
  const m1 = reqs(first.id)[0]?.messages ?? [];
  assert.equal(m1.length, 1, "a fresh session");
  assert.match(
    m1[0]?.content ?? "",
    /^report what the script found\n\n\[script\] exit 0\nstdout \(first 16 KB\):\n<<<quoted\nfound 1/,
  );
  assert.doesNotMatch(m1[0]?.content ?? "", /previous run's summary/);
  await until(() => existsSync(join(dir, "last-summary.md")), 5000, "last-summary.md");
  await api("task.close", { id: first.id });
  assert.ok(!existsSync(join(paths.out(first.id), "work")), "a run's work/ is deleted at close");

  // 3: the second firing with output sees the previous run's summary; /schedule kept the counter
  fireNow(row.id);
  const second = await until(() => runsOf(id).find((r) => r.id !== first.id), 15_000, "a second run");
  await waitStatus(second.id, "waiting");
  const m2 = reqs(second.id)[0]?.messages[0]?.content ?? "";
  assert.match(
    m2,
    /^report what the script found\n\n\[previous run's summary\]\n<<<quoted\nnotes from fake\n>>>\n\n\[script\] exit 0/,
  );
  assert.equal(readFileSync(join(dir, "count"), "utf8").trim(), "3");
  const usage = (await api<{ task: { usage: { tokens: number; runs?: number } } }>("task.get", { id })).task.usage;
  assert.ok((usage.runs ?? 0) > 0, `runs charged to the parent: ${JSON.stringify(usage)}`);
});
