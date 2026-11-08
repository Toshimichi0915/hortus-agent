/**
 * Projects: the real daemon (HORTUS_NO_NET=1, delegated user scope as
 * in host-runtime.test.ts) runs an unattended host Worker under Landlock on a non-git project. The fake provider plays the
 * model from directive lines (`!bash <cmd>`, `!merge`, `!done`): the Worker commits CHANGELOG.md in its pre-clone,
 * pushes `hortus/<id>` through hortusd.internal (the session's loopback alias), and calls `merge()`.
 * An owner edit before approval sends it back to rebase; the second request lands in the directory.
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
let site: string;
let port: number;
let daemon: ChildProcess | undefined;
let unit = "";

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
const reqs = (id: string): { messages: { role: string; content?: string }[]; tools: string[] }[] => {
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
const status = async (id: string) => (await api<{ task: { status: string } }>("task.get", { id })).task.status;
const waitStatus = (id: string, s: string) => until(async () => (await status(id)) === s, 30_000, `${id} ${s}`);
interface Approval {
  id: number;
  status: string;
  reason: string | null;
  summary: { patch: string; files: number; sha: string; stat: string };
}
const merges = async (task: string) =>
  (await api<(Approval & { task_id: string; category: string })[]>("approval.list", { limit: 500 })).filter(
    (a) => a.task_id === task && a.category === "merge",
  );
const pendingMerge = (task: string, not?: number) =>
  until(async () => (await merges(task)).find((a) => a.status === "pending" && a.id !== not), 30_000, "a merge entry");

before(async () => {
  if (!hasScope) return;
  home = tempDir("hortus-3b-");
  fake = tempDir("hortus-3bfake-");
  mkdirSync(join(fake, "plugins", "fake"), { recursive: true });
  writeFileSync(
    join(fake, "plugins", "fake", "hortus.json"),
    JSON.stringify({ name: "fake", version: "1.0.0", entrypoint: "fake.mjs" }),
  );
  writeFileSync(join(fake, "plugins", "fake", "fake.mjs"), FAKE(fake));
  site = join(fake, "site");
  mkdirSync(site);
  writeFileSync(join(site, "index.html"), "<h1>hi</h1>\n");
  writeFileSync(join(site, "notes.txt"), "owner notes\n");
  port = await freePort();
  writeFileSync(
    join(home, "hortusd.json"),
    JSON.stringify({
      // the fake provider records its requests here, from inside the sandbox
      policy: { "*": "human", cache: [fake] },
      owner: { tz: "UTC" },
      worker: { provider: "fake", model: "m", plugins: [join(fake, "plugins", "fake")] },
      projects: { site: { path: site } },
      proxy: { https: await freePort(), http: await freePort(), dns: 0 },
    }),
  );
  writeFileSync(join(home, "vault.json"), JSON.stringify({ fake: { type: "token", value: "x", transform: "fake" } }), {
    mode: 0o600,
  });
  unit = `hortusd-3b-${process.pid}`;
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
  if (!process.env.KEEP) rmSync(home, { recursive: true, force: true });
  if (!process.env.KEEP) rmSync(fake, { recursive: true, force: true });
});

const PUSH = "git push -q -f origin HEAD 2>&1 && echo pushed";
/** the `n`th successful push is in the Worker's context and its turn is over */
const pushed = async (id: string, n: number) => {
  await until(
    () => (JSON.stringify(reqs(id).at(-1)?.messages ?? "").match(/"output":"pushed/g) ?? []).length >= n,
    30_000,
    `push ${n}`,
  );
  await waitStatus(id, "waiting");
};

test("a host Worker on a non-git project delivers hortus/<id>; an owner edit → rebase → lands", {
  skip,
}, async () => {
  process.env.HORTUS_HOME = home;
  const id = `p${Date.now().toString(36)}`;
  const brief = [
    "add CHANGELOG.md with one line",
    `!bash echo '- one line' > CHANGELOG.md && git add -A && git commit -qm changelog && ${PUSH}`,
  ].join("\n");
  const db = openDb(paths.db());
  const t = new Date().toISOString();
  db.prepare(
    `INSERT INTO tasks(id, kind, title, brief, status, scope, budget, usage, project, runtime, event_keys, created, updated, hours)
     VALUES (?, 'unattended', 'changelog', ?, 'queued', ?, ?, '{"tokens":0}', 'site', 'host', '[]', ?, ?, 0)`,
  ).run(
    id,
    brief,
    JSON.stringify({ credentials: [], repos: [], project: "site" }),
    JSON.stringify({ usd: 1000, hours: 1 }),
    t,
    t,
  );
  db.close();

  // tools of one turn run concurrently, so merge() gets a turn of its own after the push
  await pushed(id, 1);
  assert.ok(reqs(id)[0]?.tools.includes("merge"));
  await api("task.send", { id, text: "!merge" });
  const first = await pendingMerge(id);
  assert.equal(first.summary.files, 1);
  assert.match(first.summary.patch, /\+\+\+ b\/CHANGELOG\.md/);
  assert.match(first.summary.stat, /CHANGELOG\.md/);
  // what the entry's page shows: `hortus/<task>` → main, "+1 −0 in 1 file"
  const entry = await api<{ summary: { branch: string; added: number; removed: number } }>("approval.get", {
    id: first.id,
  });
  assert.match(entry.summary.branch, /^hortus\/p[0-9a-z]+$/);
  assert.deepEqual([entry.summary.added, entry.summary.removed], [1, 0]);
  await waitStatus(id, "waiting");

  // the owner edits another file before approving: main moves at approval, the entry is replaced, rebase notice
  writeFileSync(join(site, "notes.txt"), "owner notes, edited\n");
  await api("approval.decide", { id: first.id, decision: "approve" });
  assert.equal((await merges(id)).find((a) => a.id === first.id)?.status, "replaced");
  assert.ok(!existsSync(join(site, "CHANGELOG.md")));
  await until(() => JSON.stringify(reqs(id).at(-1)?.messages ?? "").includes("from=rebase"), 30_000, "the rebase");
  await waitStatus(id, "waiting");

  await api("task.send", {
    id,
    text: `!bash git fetch -q origin 2>&1 && git rebase -q origin/HEAD 2>&1 && ${PUSH}`,
  });
  await pushed(id, 2);
  await api("task.send", { id, text: "!merge" });
  const second = await pendingMerge(id, first.id);
  assert.equal(second.summary.files, 1);
  assert.doesNotMatch(second.summary.patch, /notes\.txt/);
  await api("approval.decide", { id: second.id, decision: "approve" });
  assert.equal((await merges(id)).find((a) => a.id === second.id)?.status, "landed");
  assert.equal(readFileSync(join(site, "CHANGELOG.md"), "utf8"), "- one line\n");
  assert.equal(readFileSync(join(site, "notes.txt"), "utf8"), "owner notes, edited\n");
  // "Merged as <sha>"
  const landed = await api<{ status: string; summary: { sha: string } }>("approval.get", { id: second.id });
  assert.deepEqual([landed.status, landed.summary.sha], ["landed", second.summary.sha]);
  await until(() => JSON.stringify(reqs(id).at(-1)?.messages ?? "").includes("merged "), 30_000, "merged notice");

  // a chat session has no merge tool
  const { id: chat } = await api<{ id: string }>("task.open", { text: "hello", cwd: site });
  await until(() => reqs(chat).length > 0, 30_000, "the chat's model call");
  assert.ok(!reqs(chat)[0]?.tools.includes("merge"));
});

test("a 50 MB pack (chunked: over git's http.postBuffer) goes through the proxy to the origin", { skip }, async () => {
  process.env.HORTUS_HOME = home;
  const id = `p${Date.now().toString(36)}b`;
  const brief = `!bash head -c 50000000 /dev/urandom > big.bin && git add -A && git commit -qm big && ${PUSH}`;
  const db = openDb(paths.db());
  const t = new Date().toISOString();
  db.prepare(
    `INSERT INTO tasks(id, kind, title, brief, status, scope, budget, usage, project, runtime, event_keys, created, updated, hours)
     VALUES (?, 'unattended', 'big', ?, 'queued', ?, ?, '{"tokens":0}', 'site', 'host', '[]', ?, ?, 0)`,
  ).run(
    id,
    brief,
    JSON.stringify({ credentials: [], repos: [], project: "site" }),
    JSON.stringify({ usd: 1000, hours: 1 }),
    t,
    t,
  );
  db.close();
  await pushed(id, 1);
  const size = spawnSync("git", ["--git-dir", paths.project("site"), "cat-file", "-s", `hortus/${id}:big.bin`]);
  assert.equal(size.stdout.toString().trim(), "50000000", size.stderr.toString());
});
