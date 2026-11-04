/**
 * 3b at the module level (08-projects.md › Functional tests): the origin's hook through `hortusd.internal/git/<name>`
 * (the in-process router behind a test listener whose client is set by the test, as a link would), sync, shadow
 * snapshots and restores, `merge` → approve → land, and the refusals. Real git in temp dirs; no daemon.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Config, load } from "../config.ts";
import type { Ctx } from "../ctx.ts";
import { openDb } from "../db.ts";
import { logger } from "../log.ts";
import * as paths from "../paths.ts";
import type { Client } from "../proxy/index.ts";
import { internal } from "../proxy/internal.ts";
import { writeOut } from "../proxy/server.ts";
import { call } from "../rpc.ts";
import { type TaskRow, taskJson } from "../runtime/tasks.ts";
import { tempDir } from "../test/until.ts";
import type { InboxMsg } from "../types.ts";
import { gate } from "../vault/index.ts";
import { bind } from "../vault/vault.ts";
import { prepareClone, startSync, sync } from "./origin.ts";

const root = tempDir("hortus-projects-");
process.env.HORTUS_HOME = join(root, "home");
// the owner's ~/.gitconfig (signing, url rewrites) stays out of every git here, hortusd's included
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
const owner = { role: "owner" as const };
const g = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=o", "-c", "user.email=o@x", ...args], { cwd, encoding: "utf8" }).trim();
/** git that may fail: {status, out} with stderr folded in */
const gTry = (cwd: string, ...args: string[]): Promise<{ status: number | null; out: string }> =>
  // async: the router answering it runs on this event loop
  new Promise((resolve) => {
    const c = spawn("git", ["-c", "user.name=w", "-c", "user.email=w@x", ...args], { cwd });
    let out = "";
    c.stdout.on("data", (d: Buffer) => {
      out += d;
    });
    c.stderr.on("data", (d: Buffer) => {
      out += d;
    });
    c.on("close", (status) => resolve({ status, out }));
  });

let client: Client = { role: "core" };
let url = "";
const server = http.createServer((req, res) => {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k] = v;
  internal(client, { method: req.method ?? "GET", path: req.url ?? "/", headers, body: req, tls: false }).then(
    (out) => writeOut(res, out),
    (e) => {
      res.writeHead(500).end(String(e));
    },
  );
});
const inbox: [string, Omit<InboxMsg, "seq" | "ts">][] = [];
const inboxOf = (t: string) => inbox.filter(([id]) => id === t).map(([, m]) => m);

let ctx: Ctx;
const checkout = join(root, "g");
const plain = join(root, "plain");

function task(id: string, kind: string, project?: string): void {
  ctx.db
    .prepare(
      "INSERT INTO tasks(id, kind, title, brief, status, scope, project) VALUES (?, ?, 't', 'b', 'waiting', ?, ?)",
    )
    .run(id, kind, JSON.stringify({ credentials: [], repos: [], ...(project ? { project } : {}) }), project ?? null);
}

before(async () => {
  mkdirSync(paths.home(), { recursive: true });
  mkdirSync(checkout);
  g(checkout, "init", "-q", "-b", "main");
  writeFileSync(join(checkout, "README.md"), "hello\n");
  g(checkout, "add", "-A");
  g(checkout, "commit", "-q", "-m", "init");
  mkdirSync(join(plain, "sub"), { recursive: true });
  writeFileSync(join(plain, "notes.txt"), "one\n");
  writeFileSync(join(plain, "sub", "x.txt"), "x\n");
  writeFileSync(join(plain, "secret.env"), "TOKEN=1\n");
  writeFileSync(
    paths.config(),
    JSON.stringify({
      worker: { provider: "fake", model: "m" },
      projects: { g: { path: checkout }, plain: { path: plain, exclude: ["*.env"] }, other: { path: checkout } },
    }),
  );
  ctx = {
    config: load(),
    db: openDb(paths.db()),
    paths,
    log: logger,
    async reload() {
      ctx.config = load();
    },
  };
  bind(ctx);
  gate.deps.inboxWrite = (t, m) => void inbox.push([t, m]);
  for (const [id, kind, p] of [
    ["ta", "unattended", "g"],
    ["tb", "unattended", "g"],
    ["tc", "chat", undefined],
    ["tp", "unattended", "plain"],
    ["to", "unattended", "other"],
  ] as const)
    task(id, kind, p);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/git`;
});

after(() => {
  server.close();
  server.closeAllConnections();
  rmSync(root, { recursive: true, force: true });
});

const as = (task: string): Client => ({ role: "worker", task });
const work = (name: string) => join(root, `w-${name}-${Date.now()}`);

test("origin: a worker pushes only hortus/<its task>, force included; tags, main, deletes, others refused", async () => {
  await sync("g");
  client = as("ta");
  const w = work("a");
  assert.equal((await gTry(root, "clone", "-q", `${url}/g`, w)).status, 0);
  g(w, "checkout", "-q", "-b", "hortus/ta");
  writeFileSync(join(w, "a.txt"), "a\n");
  g(w, "add", "-A");
  g(w, "commit", "-q", "-m", "a");
  assert.equal((await gTry(w, "push", "-q", "origin", "hortus/ta")).status, 0);
  // force: an amended commit
  g(w, "commit", "-q", "--amend", "-m", "a2");
  assert.equal((await gTry(w, "push", "-q", "-f", "origin", "hortus/ta")).status, 0);
  let r = await gTry(w, "push", "origin", "hortus/ta:hortus/tb");
  assert.notEqual(r.status, 0);
  assert.match(r.out, /refused: refs\/heads\/hortus\/tb/);
  // the task comes from the link: a client header naming another task changes nothing
  r = await gTry(w, "-c", "http.extraHeader=X-Hortus-Task: tb", "push", "origin", "hortus/ta:hortus/tb");
  assert.match(r.out, /refused: refs\/heads\/hortus\/tb/);
  r = await gTry(w, "push", "origin", "hortus/ta:main");
  assert.match(r.out, /refused: refs\/heads\/main/);
  g(w, "tag", "v1");
  r = await gTry(w, "push", "origin", "v1");
  assert.match(r.out, /refused: refs\/tags\/v1/);
  r = await gTry(w, "push", "origin", "--delete", "hortus/ta");
  assert.notEqual(r.status, 0);
  assert.match(r.out, /deletion prohibited|denyDeletes|refused/);
  assert.ok(g(paths.project("g"), "rev-parse", "refs/heads/hortus/ta"));

  // a client without a role at the hook (a local push straight into the bare origin) is refused
  r = await gTry(w, "push", paths.project("g"), "hortus/ta:hortus/x");
  assert.match(r.out, /refused: role/);
  // core may push anything
  client = { role: "core" };
  assert.equal((await gTry(w, "push", "-q", `${url}/g`, "hortus/ta:refs/heads/core-made")).status, 0);
});

test("origin: 403 before CGI for a project outside the task's scope; chat may read any project", async () => {
  await sync("other");
  client = as("ta");
  let r = await gTry(root, "ls-remote", `${url}/other`);
  assert.notEqual(r.status, 0);
  assert.match(r.out, /403/);
  client = as("tc");
  r = await gTry(root, "ls-remote", `${url}/other`);
  assert.equal(r.status, 0, r.out);
  client = { role: "planner", task: "ta" };
  assert.match((await gTry(root, "ls-remote", `${url}/g`)).out, /403/);
  client = as("ta");
  assert.match((await gTry(root, "ls-remote", `${url}/nope`)).out, /404|not found/);
});

test("sync: owner commits fast-forward; a rewritten main is refused until force; uncommitted changes stay out", async () => {
  const origin = paths.project("g");
  writeFileSync(join(checkout, "README.md"), "hello\nmore\n");
  g(checkout, "commit", "-q", "-am", "more");
  const tip = g(checkout, "rev-parse", "HEAD");
  assert.deepEqual(await sync("g"), { main: tip, moved: true });
  g(checkout, "reset", "-q", "--hard", "HEAD~1");
  await assert.rejects(sync("g"), /rewritten/);
  assert.equal(g(origin, "rev-parse", "main"), tip);
  const r = (await call("project.sync", { name: "g", force: true }, owner)) as { main: string };
  assert.equal(r.main, g(checkout, "rev-parse", "HEAD"));
  writeFileSync(join(checkout, "README.md"), "uncommitted\n");
  await sync("g");
  assert.equal(g(origin, "show", "main:README.md"), "hello");
  g(checkout, "checkout", "--", "README.md");
});

test("a sync that fails at a task's start: the card says so; with nothing to clone the task does not start", async () => {
  const { main } = await sync("plain");
  const origin = paths.project("plain");
  const shadow = paths.shadow("plain");
  renameSync(shadow, `${shadow}.away`);
  writeFileSync(shadow, ""); // the snapshot has nowhere to go
  try {
    const notes: string[] = [];
    await startSync("plain", (t) => notes.push(t));
    assert.match(notes[0] ?? "", /working from the last synced main/);
    g(origin, "update-ref", "-d", "refs/heads/main");
    await assert.rejects(startSync("plain", () => {}));
  } finally {
    rmSync(shadow);
    renameSync(`${shadow}.away`, shadow);
    g(origin, "update-ref", "refs/heads/main", main);
  }
});

test("non-git: snapshots skip excluded paths; the clone never sees them; restore deletes files added since", async () => {
  const { main } = await sync("plain");
  const origin = paths.project("plain");
  assert.deepEqual(g(origin, "ls-tree", "-r", "--name-only", "main").split("\n").sort(), ["notes.txt", "sub/x.txt"]);
  // a pre-clone (what the dispatcher does at start) has no excluded file and sits on hortus/<id>
  const row = ctx.db.prepare("SELECT * FROM tasks WHERE id = 'tp'").get() as unknown as TaskRow;
  const tj = taskJson(ctx.config, row);
  assert.ok(tj.features.includes("merge"));
  await prepareClone(tj);
  const dir = tj.paths.clone ?? "";
  assert.ok(existsSync(join(dir, "notes.txt")));
  assert.ok(!existsSync(join(dir, "secret.env")));
  assert.equal(g(dir, "branch", "--show-current"), "hortus/tp");
  assert.equal(g(dir, "remote", "get-url", "origin"), "https://hortusd.internal/git/plain");
  rmSync(dir, { recursive: true, force: true });

  writeFileSync(join(plain, "added.txt"), "new\n");
  writeFileSync(join(plain, "notes.txt"), "two\n");
  const later = await sync("plain");
  assert.notEqual(later.main, main);
  const restored = (await call("project.restore", { name: "plain", sha: main }, owner)) as { sha: string };
  assert.ok(!existsSync(join(plain, "added.txt")));
  assert.equal(readFileSync(join(plain, "notes.txt"), "utf8"), "one\n");
  assert.ok(existsSync(join(plain, "secret.env")), "excluded files are not touched");
  assert.equal(g(origin, "rev-parse", "main"), restored.sha);
  const snaps = (await call("project.snapshots", { name: "plain" }, owner)) as { sha: string; message: string }[];
  assert.equal(snaps[0]?.sha, restored.sha);
  assert.match(snaps[0]?.message ?? "", /^restore /);
  assert.ok(snaps.length >= 3);
});

/** A Worker's clone of `project` on hortus/<task> with one commit writing `file`, pushed through the route. */
async function deliver(taskId: string, project: string, file: string, text: string, base?: string): Promise<string> {
  client = as(taskId);
  const w = base ?? work(taskId);
  if (!base) {
    assert.equal((await gTry(root, "clone", "-q", `${url}/${project}`, w)).status, 0);
    g(w, "checkout", "-q", "-b", `hortus/${taskId}`);
  }
  writeFileSync(join(w, file), text);
  g(w, "add", "-A");
  g(w, "commit", "-q", "-m", `${file}`);
  const r = await gTry(w, "push", "-q", "-f", "origin", `hortus/${taskId}`);
  assert.equal(r.status, 0, r.out);
  return w;
}
const mergeAs = (t: string) => call("merge", {}, { role: "worker", task: t }) as Promise<{ approval: number }>;
const entry = (id: number) =>
  ctx.db.prepare("SELECT status, reason, summary FROM approvals WHERE id = ?").get(id) as {
    status: string;
    reason: string | null;
    summary: string;
  };
const approve = (id: number) => call("approval.decide", { id, decision: "approve" }, owner);

test("merge (git): entry with stat and patch → approve → the checkout has it; dirty checkout → reason, retry lands", async () => {
  await sync("g");
  inbox.length = 0;
  const w = await deliver("ta", "g", "CHANGELOG.md", "- first\n");
  const { approval } = await mergeAs("ta");
  const e = entry(approval);
  assert.equal(e.status, "pending");
  const s = JSON.parse(e.summary);
  assert.equal(s.project, "g");
  assert.equal(s.branch, "hortus/ta");
  assert.equal(s.files, 1);
  assert.match(s.stat, /CHANGELOG\.md/);
  assert.match(s.patch, /\+- first/);
  // asking again for the same tip is the same entry
  assert.equal((await mergeAs("ta")).approval, approval);
  await approve(approval);
  assert.equal(entry(approval).status, "landed");
  assert.equal(readFileSync(join(checkout, "CHANGELOG.md"), "utf8"), "- first\n");
  assert.equal(g(paths.project("g"), "rev-parse", "main"), s.sha);
  assert.ok(inboxOf("ta").some((m) => m.from === "merge" && m.text === `merged ${s.sha}`));

  // dirty checkout: nothing moves, the reason is on the entry and in the inbox; retry after cleaning lands
  assert.equal((await gTry(w, "fetch", "-q", "origin")).status, 0);
  g(w, "rebase", "-q", "origin/main");
  await deliver("ta", "g", "CHANGELOG.md", "- first\n- second\n", w);
  const second = (await mergeAs("ta")).approval;
  writeFileSync(join(checkout, "README.md"), "dirty\n");
  writeFileSync(join(checkout, "untracked.log"), "the owner's own file\n"); // untracked: not a reason to refuse
  await approve(second);
  assert.equal(entry(second).status, "approved");
  assert.equal(entry(second).reason, "checkout is not clean");
  assert.ok(inboxOf("ta").some((m) => m.from === "merge" && /did not land: checkout is not clean/.test(m.text)));
  assert.equal(readFileSync(join(checkout, "CHANGELOG.md"), "utf8"), "- first\n");
  g(checkout, "checkout", "--", "README.md");
  assert.deepEqual(await call("merge.retry", { id: second }, owner), { landed: true, reason: null });
  rmSync(join(checkout, "untracked.log"));
  assert.equal(readFileSync(join(checkout, "CHANGELOG.md"), "utf8"), "- first\n- second\n");
});

test("merge: two tasks on one project → one lands, the other is replaced and told to rebase, then lands", async () => {
  await sync("g");
  inbox.length = 0;
  const wa = await deliver("ta", "g", "fa.txt", "a\n");
  const wb = await deliver("tb", "g", "fb.txt", "b\n");
  const a = (await mergeAs("ta")).approval;
  const b = (await mergeAs("tb")).approval;
  await approve(a);
  assert.equal(entry(a).status, "landed");
  assert.equal(entry(b).status, "replaced");
  const notice = inboxOf("tb").find((m) => m.from === "rebase");
  assert.match(notice?.text ?? "", /^main moved to [0-9a-f]{40}; rebase hortus\/tb/);
  // approving the replaced entry is refused; asking without a rebase is refused
  await assert.rejects(approve(b), /already decided/);
  await assert.rejects(mergeAs("tb"), /not based on main/);
  client = as("tb");
  assert.equal((await gTry(wb, "fetch", "-q", "origin")).status, 0);
  g(wb, "rebase", "-q", "origin/main");
  assert.equal((await gTry(wb, "push", "-q", "-f", "origin", "hortus/tb")).status, 0);
  const b2 = (await mergeAs("tb")).approval;
  assert.notEqual(b2, b);
  await approve(b2);
  assert.equal(entry(b2).status, "landed");
  assert.ok(existsSync(join(checkout, "fa.txt")) && existsSync(join(checkout, "fb.txt")));
  assert.ok(wa);
});

test("v6 done-when (RPC level, non-git): an owner edit between request and approval → replaced + rebase → lands", async () => {
  await sync("plain");
  inbox.length = 0;
  const w = await deliver("tp", "plain", "CHANGELOG.md", "- one line\n");
  const first = (await mergeAs("tp")).approval;
  assert.match(JSON.parse(entry(first).summary).patch, /CHANGELOG\.md/);
  writeFileSync(join(plain, "notes.txt"), "owner edit\n");
  await approve(first);
  assert.equal(entry(first).status, "replaced");
  assert.ok(!existsSync(join(plain, "CHANGELOG.md")));
  assert.ok(inboxOf("tp").some((m) => m.from === "rebase"));
  client = as("tp");
  assert.equal((await gTry(w, "fetch", "-q", "origin")).status, 0);
  g(w, "rebase", "-q", "origin/main");
  assert.equal((await gTry(w, "push", "-q", "-f", "origin", "hortus/tp")).status, 0);
  const second = (await mergeAs("tp")).approval;
  const s = JSON.parse(entry(second).summary);
  assert.equal(s.files, 1);
  assert.doesNotMatch(s.patch, /notes\.txt|secret\.env/);
  await approve(second);
  assert.equal(entry(second).status, "landed");
  assert.equal(readFileSync(join(plain, "CHANGELOG.md"), "utf8"), "- one line\n");
  assert.equal(readFileSync(join(plain, "notes.txt"), "utf8"), "owner edit\n");
  assert.equal(readFileSync(join(plain, "secret.env"), "utf8"), "TOKEN=1\n");
});

test("chat sessions never merge: no merge feature, the RPC refuses; a project task without a pushed branch too", async () => {
  const row = ctx.db.prepare("SELECT * FROM tasks WHERE id = 'tc'").get() as unknown as TaskRow;
  assert.ok(!taskJson(ctx.config, row).features.includes("merge"));
  await assert.rejects(mergeAs("tc"), /unattended task with a project/);
  await assert.rejects(mergeAs("to"), /not in the origin: push it first/);
  await assert.rejects(call("merge", {}, owner), /not allowed for owner/);
});

test("project.set refuses bad names and paths; delete keeps the origin renamed", async () => {
  for (const name of ["a/b", "..", "a..b", "../x", ""])
    await assert.rejects(call("project.set", { name, path: plain }, owner), /invalid|name/i, name);
  await assert.rejects(call("project.set", { name: "rel", path: "relative/dir" }, owner), /absolute/);
  const extra = join(root, "extra");
  mkdirSync(extra);
  writeFileSync(join(extra, "f"), "f\n");
  await call("project.set", { name: "extra", path: extra, exclude: [] }, owner);
  assert.equal(Config.parse(JSON.parse(readFileSync(paths.config(), "utf8"))).projects.extra?.path, extra);
  assert.ok(existsSync(paths.project("extra")));
  await call("project.delete", { name: "extra" }, owner);
  assert.equal(ctx.config.projects.extra, undefined);
  assert.ok(!existsSync(paths.project("extra")));
  assert.ok(readdirSync(join(paths.home(), "projects")).some((f) => f.startsWith("extra.git.removed-")));
});
