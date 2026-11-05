/**
 * Second visits on a real daemon (HORTUS_NO_NET=1, user scope; v7 › Review round 17): what round 16 only read. A chat
 * reopened after a restart, also mid-turn; a project moved, renamed, removed and re-added with an open task; a transform
 * resubmitted while an older version is pending. The fake provider plays directive lines as in projects.test.ts.
 */
import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { openDb } from "../db.ts";
import * as paths from "../paths.ts";
import { freePort, stopped, tempDir, until } from "../test/until.ts";

const hasScope = spawnSync("systemd-run", ["--user", "--scope", "-q", "--", "true"]).status === 0;
const skip = !hasScope && "no systemd-run --user (delegated cgroups)";
const bin = (name: string) => new URL(`../bin/${name}.js`, import.meta.url).pathname;

const FAKE = (dir: string) => `
import { appendFileSync } from "node:fs";
const DIR = ${JSON.stringify(dir)};
const complete = async (req, onText) => {
  const id = (process.env.HORTUS_TASK ?? "").split("/").at(-3);
  appendFileSync(DIR + "/" + id + ".jsonl", JSON.stringify({ messages: req.messages, tools: req.tools.map((t) => t.name) }) + "\\n");
  if (!req.tools.length) return { role: "assistant", text: "notes", toolCalls: [] };
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
    const m = /^!(bash|done|merge) ?(.*)$/.exec(line.trim());
    if (!m) continue;
    const input = m[1] === "bash" ? { command: m[2] } : m[1] === "done" ? { summary: m[2] } : {};
    calls.push({ id: "c" + Date.now() + "_" + calls.length, name: m[1], input });
  }
  onText("ok");
  return { role: "assistant", text: "ok", toolCalls: calls, usage };
};
export default { providers: { fake: { create: () => ({ complete, listModels: async () => ["m"] }) } } };
`;

let home: string;
let fake: string;
let port: number;
let daemon: ChildProcess | undefined;
let unit = "";
let n = 0;

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

async function up(): Promise<void> {
  unit = `hortusd-visits-${process.pid}-${++n}`;
  daemon = spawn(
    "systemd-run",
    ["--user", "--scope", "-q", "--unit", unit, "-p", "Delegate=yes", "--", process.execPath, bin("hortusd")],
    {
      env: { ...process.env, HORTUS_HOME: home, HORTUS_CONSOLE_PORT: String(port), HORTUS_NO_NET: "1" },
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
    20_000,
    "the console",
  );
}
async function down(kill = false): Promise<void> {
  if (daemon) {
    if (kill) {
      const exit = new Promise((r) => daemon?.once("exit", r));
      daemon.kill("SIGKILL");
      await exit;
    } else await stopped(daemon);
  }
  spawnSync("systemctl", ["--user", "stop", `${unit}.scope`], { stdio: "ignore" });
}

const reqs = (id: string): { messages: { role: string; content?: string }[]; tools: string[] }[] => {
  const p = join(fake, `${id}.jsonl`);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    })
    .filter((r) => r.tools.length);
};
const context = (id: string) => JSON.stringify(reqs(id).at(-1)?.messages ?? "");
const seen = (id: string, text: string) => until(() => context(id).includes(text), 30_000, `${id} saw ${text}`);
const card = (id: string) => api<{ task: { status: string; error: string | null } }>("task.get", { id });
const status = async (id: string) => (await card(id)).task.status;
const waitStatus = (id: string, s: string) => until(async () => (await status(id)) === s, 30_000, `${id} ${s}`);
const g = (dir: string, ...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" }).trim();

/** a checkout with one commit */
function repo(name: string): string {
  const d = join(fake, name);
  mkdirSync(d);
  writeFileSync(join(d, "README.md"), `# ${name}\n`);
  execFileSync("git", ["init", "-q", "-b", "main", d]);
  g(d, "add", "-A");
  g(d, "-c", "user.name=o", "-c", "user.email=o@x", "commit", "-qm", "init");
  return d;
}

function task(id: string, project: string, brief: string): void {
  const scope = { credentials: [], repos: [], ...(project ? { project } : {}) };
  const db = openDb(paths.db());
  const t = new Date().toISOString();
  db.prepare(
    `INSERT INTO tasks(id, kind, title, brief, status, scope, budget, usage, project, runtime, event_keys, created, updated, hours)
     VALUES (?, 'unattended', ?, ?, 'queued', ?, ?, '{"tokens":0}', ?, 'host', '[]', ?, ?, 0)`,
  ).run(id, id, brief, JSON.stringify(scope), JSON.stringify({ tokens: 1e6, hours: 1 }), project || null, t, t);
  db.close();
}

const PUSH = "git push -q -f origin HEAD 2>&1 && echo pushed";
const commit = (f: string) => `!bash echo x > ${f} && git add -A && git commit -qm ${f} && ${PUSH}`;

interface Approval {
  id: number;
  status: string;
  reason: string | null;
  task_id: string;
  category: string;
}
const entries = async (task: string, category: string) =>
  (await api<Approval[]>("approval.list", { limit: 500 })).filter((a) => a.task_id === task && a.category === category);
const pending = (task: string, category: string) =>
  until(async () => (await entries(task, category)).find((a) => a.status === "pending"), 30_000, `${task} ${category}`);

before(async () => {
  if (!hasScope) return;
  home = tempDir("hortus-visits-");
  fake = tempDir("hortus-visitsfake-");
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
      policy: { "*": "human", cache: [fake] },
      owner: { tz: "UTC" },
      worker: { provider: "fake", model: "m", plugins: [join(fake, "plugins", "fake")] },
      proxy: { https: await freePort(), http: await freePort(), dns: 0 },
    }),
  );
  writeFileSync(join(home, "vault.json"), JSON.stringify({ fake: { type: "token", value: "x", transform: "fake" } }), {
    mode: 0o600,
  });
  await up();
});

after(async () => {
  if (hasScope) await down();
});

test("a chat reopened after a restart continues with what it knew", { skip }, async () => {
  const { id } = await api<{ id: string }>("task.open", { text: "hello\n!bash echo first-answer" });
  await seen(id, "first-answer");
  await waitStatus(id, "waiting");
  await down();
  await up();
  assert.equal(await status(id), "waiting");
  await api("task.send", { id, text: "again\n!bash echo second-answer" });
  await seen(id, "second-answer");
  await waitStatus(id, "waiting");
  assert.ok(context(id).includes("first-answer"), "the earlier turn is in the context");
  const page = await (await fetch(`http://127.0.0.1:${port}/chat/${id}`)).text();
  assert.match(page, /again/);
});

for (const kill of [false, true])
  test(`a chat mid-turn at a ${kill ? "crash" : "stop"}: the owner's unread message is answered`, {
    skip,
  }, async () => {
    const { id } = await api<{ id: string }>("task.open", { text: "hello\n!bash sleep 120; echo late" });
    await until(async () => (await status(id)) === "running" && reqs(id).length > 0, 30_000, "the turn");
    await new Promise((r) => setTimeout(r, 500)); // the tool is running
    await api("task.send", { id, text: "are you there\n!bash echo unread-answer" });
    await down(kill);
    await up();
    await seen(id, "unread-answer");
    await waitStatus(id, "waiting");
    assert.doesNotMatch(context(id), /"output":"late/, "the killed tool did not finish");
  });

test("a chat mid-turn at a stop, nothing unread: waiting, and the next message goes on", { skip }, async () => {
  const { id } = await api<{ id: string }>("task.open", { text: "hello\n!bash sleep 120" });
  await until(async () => (await status(id)) === "running" && reqs(id).length > 0, 30_000, "the turn");
  await new Promise((r) => setTimeout(r, 500));
  await down();
  await up();
  await waitStatus(id, "waiting");
  // the turn died with the owner's line in it: the page says so
  const db = openDb(paths.db());
  const said = db.prepare("SELECT 1 FROM replies WHERE task_id = ? AND body LIKE '%did not finish%'").get(id);
  db.close();
  assert.ok(said);
  await api("task.send", { id, text: "next\n!bash echo next-answer" });
  await seen(id, "next-answer");
  await waitStatus(id, "waiting");
});

test("a project whose path moved: the open task goes on and its merge lands in the new place", { skip }, async () => {
  const d = repo("moved");
  await api("project.set", { name: "moved", path: d });
  const id = "vmoved";
  task(id, "moved", `start\n${commit("one.txt")}`);
  await seen(id, "pushed");
  await waitStatus(id, "waiting");
  const to = join(fake, "moved-new");
  renameSync(d, to);
  await api("project.set", { name: "moved", path: to });
  await api("task.send", { id, text: `go on\n${commit("two.txt")}` });
  await until(() => (context(id).match(/"output":"pushed/g) ?? []).length >= 2, 30_000, "the second push");
  await waitStatus(id, "waiting");
  await api("task.send", { id, text: "!merge" });
  const m = await pending(id, "merge");
  await waitStatus(id, "waiting");
  await api("approval.decide", { id: m.id, decision: "approve" });
  assert.ok(existsSync(join(to, "two.txt")), "the merge landed in the moved checkout");
});

test("a project's directory gone: the owner is told, nothing replaces main", { skip }, async () => {
  const d = repo("gone");
  await api("project.set", { name: "gone", path: d });
  const main = g(d, "rev-parse", "HEAD");
  const away = join(fake, "gone-away");
  renameSync(d, away);
  await assert.rejects(api("project.sync", { name: "gone", force: true }));
  assert.equal(g(paths.project("gone"), "rev-parse", "main"), main);
  renameSync(away, d);
  await api("project.sync", { name: "gone" });
  assert.equal(g(paths.project("gone"), "rev-parse", "main"), main);
});

test("a project renamed with an open task: the task says why, its work is not lost", { skip }, async () => {
  const d = repo("oldname");
  await api("project.set", { name: "oldname", path: d });
  const id = "vrenamed";
  task(id, "oldname", `start\n${commit("work.txt")}`);
  await seen(id, "pushed");
  await waitStatus(id, "waiting");
  await api("project.set", { name: "newname", path: d });
  await api("project.delete", { name: "oldname" });
  await api("task.send", { id, text: "go on\n!bash git log --oneline | wc -l; echo after-rename" });
  await until(
    async () => (await card(id)).task.error || context(id).includes("after-rename"),
    30_000,
    "the task's answer",
  );
  assert.match((await card(id)).task.error ?? "", /no project oldname/);
  assert.ok(existsSync(join(paths.clone(id), "work.txt")));
  // the name back: the task goes on from its clone, as after a removal
  await api("project.set", { name: "oldname", path: d });
  await api("task.send", { id, text: "again\n!bash echo name-is-back" });
  await seen(id, "name-is-back");
});

test("a project removed and re-added with an open task and a pending merge", { skip }, async () => {
  const d = repo("back");
  await api("project.set", { name: "back", path: d });
  const id = "vback";
  task(id, "back", `start\n${commit("work.txt")}`);
  await seen(id, "pushed");
  await waitStatus(id, "waiting");
  await api("task.send", { id, text: "!merge" });
  const m = await pending(id, "merge");
  await waitStatus(id, "waiting");
  await api("project.delete", { name: "back" });
  await api("project.set", { name: "back", path: d });
  const old = (await entries(id, "merge")).find((a) => a.id === m.id);
  assert.equal(old?.status, "replaced");
  assert.match(old?.reason ?? "", /removed/);
  await assert.rejects(api("approval.decide", { id: m.id, decision: "approve" }));
  await api("task.send", { id, text: `go on\n!bash git status --short; ${PUSH}` });
  await until(() => (context(id).match(/"output":"[^"]*pushed/g) ?? []).length >= 2, 30_000, "the second push");
  await waitStatus(id, "waiting");
  assert.ok(context(id).includes("was removed"), "the task was told");
  await api("task.send", { id, text: "!merge" });
  const m2 = await pending(id, "merge");
  await waitStatus(id, "waiting");
  await api("approval.decide", { id: m2.id, decision: "approve" });
  assert.ok(existsSync(join(d, "work.txt")), "the second request lands");
});

test("a transform resubmitted while an older version is pending", { skip }, async () => {
  const dir = join(fake, "tx", "thing");
  mkdirSync(join(dir, "tests"), { recursive: true });
  const req = { method: "GET", url: "https://api.thing.test/x", headers: {}, body: null, stream: false };
  const version = (host: string) => {
    const manifest = {
      name: "thing",
      credentials: { thing: { type: "token", hosts: [host], locations: ["header:Authorization"] } },
    };
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
    writeFileSync(
      join(dir, "transform.js"),
      "export function request(req) { return req; }\nexport function response(res) { return { res }; }\n",
    );
    writeFileSync(join(dir, "tests", "a.json"), JSON.stringify({ request: req, template: req }));
  };
  const submit = `!bash ${process.execPath} ${bin("dof")} transform submit ${dir} 2>&1`;
  version("api.thing.test");
  task("vtxa", "", `first\n${submit}`);
  const one = await pending("vtxa", "transforms");
  await waitStatus("vtxa", "waiting");
  version("api2.thing.test");
  task("vtxb", "", `second\n${submit}`);
  const two = await pending("vtxb", "transforms");
  await waitStatus("vtxb", "waiting");
  const first = (await entries("vtxa", "transforms")).find((a) => a.id === one.id);
  assert.equal(first?.status, "replaced");
  await seen("vtxa", "yours will not be installed");
  const value = { credentials: { thing: { value: "v" } } };
  await assert.rejects(api("approval.decide", { id: one.id, decision: "approve", ...value }));
  // back to the first version: a fresh entry, not the replaced one, and the second is replaced in turn
  version("api.thing.test");
  await api("task.send", { id: "vtxa", text: submit });
  const three = await pending("vtxa", "transforms");
  await waitStatus("vtxa", "waiting");
  assert.notEqual(three.id, one.id);
  assert.equal((await entries("vtxb", "transforms")).find((a) => a.id === two.id)?.status, "replaced");
  // a restart keeps the one open entry, and it installs
  await down();
  await up();
  await api("approval.decide", { id: three.id, decision: "approve", ...value });
  await until(
    () => readFileSync(join(paths.dof("transforms"), "thing", "manifest.json"), "utf8").includes('"api.thing.test"'),
    10_000,
    "the newer version installed",
  );
  const open = (await api<Approval[]>("approval.list", { limit: 500 })).filter(
    (a) => a.category === "transforms" && a.status === "pending",
  );
  assert.deepEqual(open, []);
});
