import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";

process.env.HORTUS_HOME = mkdtempSync(join(tmpdir(), "hortus-mirror-"));

const { Config } = await import("../config.ts");
const { openDb } = await import("../db.ts");
const { logger } = await import("../log.ts");
const paths = await import("../paths.ts");
const { serveSocket } = await import("../rpc.ts");
const { commit, mirrorModule, parse, publishLog, render, search } = await import("./index.ts");
const { unsafe } = await import("./repo.ts");

const db = openDb(paths.db());
await mirrorModule.start({
  config: Config.parse({ dofs: { slack: { type: "slack" }, gh: { type: "github" } } }),
  db,
  paths,
  log: logger,
  reload: async () => {},
});
const server = await serveSocket(paths.socket());
after(() => server.close());

const git = (dof: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd: paths.dof(dof),
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
  });
const msg = (path: string, body: string, fm: Record<string, unknown> = {}) => ({
  op: "put" as const,
  path,
  frontmatter: { id: "1", ts: "2026-10-27T03:33:20Z", user: "U0123 (alice)", ...fm },
  body,
});

const SLACK = `---
id: "1730000000.123456"
thread: "1730000000.123456"
ts: 2026-10-27T03:33:20Z
user: U0123 (alice)
edited: 2026-10-27T03:35:00Z
files: [files/F0123-error.png]
reactions: { "+1": [alice], eyes: [hortus] }
---
Body in the service's own markup.
`;
// v6's forge example without its explanatory `# …` comments (annotations of the doc, not file content)
const FORGE = `---
id: "!42"
thread: "!42"
ts: 2026-10-30T12:00:00Z
user: alice
title: Fix crash on start
state: open
labels: [bug]
assignees: [alice]
head: hortus/42
base: main
head_sha: 0a1b2c
checks: failure
---
Body in the forge's Markdown.
`;

test("render/parse round-trip v6's examples byte for byte", () => {
  for (const text of [SLACK, FORGE]) {
    const { frontmatter, body } = parse(text);
    assert.equal(render(frontmatter, body), text);
  }
  const fm = parse(SLACK).frontmatter;
  assert.equal(fm.id, "1730000000.123456");
  assert.deepEqual(fm.reactions, { "+1": ["alice"], eyes: ["hortus"] });
  const odd = { a: "1e5", b: "true", c: "x: y", d: "", e: 3, f: null, g: ["a,b", "[c]"], h: "line\nbreak", i: "-" };
  assert.deepEqual(parse(render(odd, "b")).frontmatter, odd);
});

test("commit: A, no-op, M keeps history, D prunes the thread directory", async () => {
  const a = await commit("slack", [msg("C1/T1/M1.md", "first body")], "sync(slack): +1");
  assert.ok(a);
  assert.deepEqual(a.diff, [{ status: "A", path: "C1/T1/M1.md" }]);
  assert.match(readFileSync(join(paths.dof("slack"), "C1/T1/M1.md"), "utf8"), /first body/);
  assert.equal(await commit("slack", [msg("C1/T1/M1.md", "first body")], "again"), null);
  const m = await commit("slack", [msg("C1/T1/M1.md", "edited body")], "edit");
  assert.deepEqual(m?.diff, [{ status: "M", path: "C1/T1/M1.md" }]);
  assert.match(git("slack", "log", "-p", "main"), /-first body/);
  const d = await commit("slack", [{ op: "delete", path: "C1/T1/M1.md" }], "delete");
  assert.deepEqual(d?.diff, [{ status: "D", path: "C1/T1/M1.md" }]);
  assert.equal(existsSync(join(paths.dof("slack"), "C1/T1")), false);
  assert.equal(git("slack", "config", "user.name").trim(), "hortus");
  assert.equal(git("slack", "rev-parse", "--abbrev-ref", "HEAD").trim(), "main");
});

test("patch merges frontmatter, null removes, missing file is skipped", async () => {
  await commit("slack", [msg("C2/T/M.md", "keep me", { reactions: { eyes: ["a"] } })], "put");
  const r = await commit(
    "slack",
    [
      { op: "patch", path: "C2/T/M.md", frontmatter: { reactions: null, edited: "2026-10-28T00:00:00Z" } },
      { op: "patch", path: "C2/T/missing.md", frontmatter: { x: 1 } },
    ],
    "patch",
  );
  assert.deepEqual(r?.diff, [{ status: "M", path: "C2/T/M.md" }]);
  const { frontmatter, body } = parse(readFileSync(join(paths.dof("slack"), "C2/T/M.md"), "utf8"));
  assert.equal(body, "keep me");
  assert.equal(frontmatter.reactions, undefined);
  assert.equal(frontmatter.edited, "2026-10-28T00:00:00Z");
  assert.equal(existsSync(join(paths.dof("slack"), "C2/T/missing.md")), false);
});

test("path safety drops bad changes, keeps the rest", async () => {
  for (const p of ["../x.md", "/etc/x", "a/b\0c", "C1/../../m.md", "C1/a/b/m.md", ".git/config"]) {
    assert.ok(unsafe(p), p);
  }
  const r = await commit(
    "slack",
    [
      msg("../x.md", "bad"),
      { op: "put", path: "/etc/x", body: "bad" },
      { op: "put", path: "a/b\0c", body: "bad" },
      msg("C1/../../m.md", "bad"),
      msg("C3/T/ok.md", "good"),
      { op: "put", path: "C3/T/files/F1-a.png", bytes: Buffer.from([0, 1, 2, 255]) },
    ],
    "mixed",
  );
  assert.deepEqual(r?.diff.map((e) => e.path).sort(), ["C3/T/files/F1-a.png", "C3/T/ok.md"]);
  assert.equal(existsSync(join(paths.home(), "dof", "x.md")), false);
  assert.deepEqual(readFileSync(join(paths.dof("slack"), "C3/T/files/F1-a.png")), Buffer.from([0, 1, 2, 255]));
});

test("50 concurrent commits on one DOF, two DOFs in parallel", async () => {
  const before = Number(git("slack", "rev-list", "--count", "main"));
  const jobs = Array.from({ length: 50 }, (_, i) => commit("slack", [msg(`C4/T/m${i}.md`, `n ${i}`)], `c${i}`));
  jobs.push(commit("gh", [msg("P/!1/c1.md", "forge body", { title: "Fix crash" })], "gh"));
  const results = await Promise.all(jobs);
  assert.ok(results.every((r) => r !== null));
  assert.equal(Number(git("slack", "rev-list", "--count", "main")), before + 50);
  assert.equal(Number(git("gh", "rev-list", "--count", "main")), 2);
});

test("index follows A/M/D; files/ and binaries make no row", async () => {
  await commit("slack", [msg("C5/T/a.md", "zebra crossing alpha")], "a");
  assert.equal(search({ q: "zebra crossing" }).length, 1);
  await commit("slack", [msg("C5/T/a.md", "yak shaving beta")], "m");
  assert.equal(search({ q: "zebra" }).length, 0);
  assert.equal(search({ q: "yak shaving" })[0]?.path, "C5/T/a.md");
  await commit("slack", [{ op: "delete", path: "C5/T/a.md" }], "d");
  assert.equal(search({ q: "yak shaving" }).length, 0);
  await commit(
    "slack",
    [
      { op: "put", path: "C5/T/files/F9-notes.md", body: "attachment marmot" },
      { op: "put", path: "C5/T/files/F9-x.bin", bytes: Buffer.from("marmot") },
    ],
    "files",
  );
  assert.equal(search({ q: "marmot" }).length, 0);
  await commit(
    "slack",
    [{ op: "put", path: "C5/channel.md", frontmatter: { name: "general", topic: "llamas" } }],
    "ch",
  );
  assert.equal(search({ q: "llamas" })[0]?.title, "general");
});

test("search: CJK, LIKE fallback, filters, ordering, quoting, limit", async () => {
  await commit(
    "slack",
    [
      msg("C6/T/1.md", "日本語の検索テスト", { ts: "2026-10-01T00:00:00Z", user: "U1 (bob)" }),
      msg("C6/T/2.md", "ok go lark", { ts: "2026-10-02T00:00:00Z", user: "U2 (carol)" }),
      msg("C6/T/3.md", "ok go lark again", { ts: "2026-10-03T12:00:00Z", user: "U1 (bob)" }),
      msg("C6/T/4.md", 'quote " star * lark', { ts: "2026-10-04T00:00:00Z", user: "U3" }),
    ],
    "s",
  );
  assert.equal(search({ q: "検索テ" })[0]?.path, "C6/T/1.md");
  assert.match(search({ q: "検索テ" })[0]?.snippet ?? "", /\[検索テ\]/);
  const short = search({ q: "ok", in: "slack" });
  assert.deepEqual(
    short.map((h) => h.path),
    ["C6/T/3.md", "C6/T/2.md"],
  );
  assert.equal(search({ q: "ok go lark", author: "U1" }).length, 1);
  assert.equal(search({ q: "ok go lark", author: "bob" }).length, 0);
  assert.deepEqual(
    search({ q: "lark", since: "2026-10-02T00:00:00Z", until: "2026-10-03" })
      .map((h) => h.path)
      .sort(),
    ["C6/T/2.md", "C6/T/3.md"],
  );
  assert.equal(search({ q: "lark", in: "gh" }).length, 0);
  assert.equal(search({ q: 'e " st' }).length, 1);
  assert.equal(search({ q: "star *" }).length, 1);
  assert.equal(search({ q: '"' }).length, 1);
  assert.equal(search({ q: "%" }).length, 0);
  assert.equal(search({ q: "lark", limit: 2 }).length, 2);
  assert.throws(() => search({ q: "lark", in: "nope" }), /no DOF named nope/);
});

const sessions = (id: string) => join(paths.out(id), "sessions");
const line = (id: string, parentId: string | null, message: unknown) =>
  `${JSON.stringify({ v: 1, id, parentId, type: "message", message })}\n`;

test("logs: excerpt, [image], no summary, crash-cut line, republish keeps one row per path", async () => {
  const dir = sessions("t1");
  mkdirSync(dir, { recursive: true });
  const big = "x".repeat(100 * 1024);
  writeFileSync(
    join(dir, "1730000000_a.jsonl"),
    line("1", null, { role: "user", content: "find the walrus" }) +
      line("2", "1", {
        role: "assistant",
        text: "looking",
        toolCalls: [{ id: "c", name: "bash", input: { cmd: "ls" } }],
      }) +
      line("3", "2", {
        role: "tool",
        results: [
          { id: "c", output: big },
          { id: "d", output: "", image: { type: "image", mediaType: "image/png", data: "AA" } },
        ],
      }) +
      '{"v":1,"id":"4","parentId":"3","type":"mess',
  );
  writeFileSync(join(dir, "1730000100_b.jsonl"), line("5", null, { role: "user", content: "handoff note" }));
  await publishLog("t1", "Walrus hunt", "done", ["slack:C1:T1"]);
  const md = readFileSync(join(paths.logs(), "t1", "session.md"), "utf8");
  assert.match(md, /^## 1 user 2024-10-27T03:33:20\.000Z\n\nfind the walrus/);
  assert.match(md, /## 3 tool .*\n\n```\nx{4096}\n… \(102400 bytes\)\n```/);
  assert.ok(md.length < 10_000);
  assert.match(md, /\[image\]/);
  assert.match(md, /```json\n\{\n {2}"name": "bash"/);
  assert.match(md, /## 4 user 2024-10-27T03:35:00\.000Z\n\nhandoff note/);
  const summary = parse(readFileSync(join(paths.logs(), "t1", "summary.md"), "utf8"));
  assert.equal(summary.body, "No summary.\n");
  assert.equal(summary.frontmatter.status, "done");

  writeFileSync(join(paths.out("t1"), "summary.md"), "Found the walrus.\n");
  await publishLog("t1", "Walrus hunt", "done");
  assert.match(readFileSync(join(paths.logs(), "t1", "summary.md"), "utf8"), /Found the walrus/);
  const hits = search({ q: "walrus", in: "logs" });
  assert.deepEqual(hits.map((h) => h.path).sort(), ["t1/session.md", "t1/summary.md"]);
  assert.ok(hits.every((h) => h.title === "Walrus hunt"));
  const rows = db.prepare("SELECT count(*) AS n FROM search_meta WHERE dof = 'logs'").get() as { n: number };
  assert.equal(rows.n, 2);
});

test("a reader polling during 100 commits never sees an empty or truncated file", async () => {
  const bodies = Array.from({ length: 100 }, (_, i) => `${String(i).padStart(3, "0")}${"y".repeat(200_000)}`);
  await commit("slack", [msg("C7/T/m.md", "start")], "start");
  const file = join(paths.dof("slack"), "C7/T/m.md");
  const stop = new Int32Array(new SharedArrayBuffer(4));
  const reader = new Worker(
    `const { readFileSync } = require("node:fs"); const { workerData: { file, stop, full } } = require("node:worker_threads");
     let reads = 0, bad = 0;
     while (Atomics.load(stop, 0) === 0) { const t = readFileSync(file, "utf8"); reads++;
       if (!t.endsWith("start") && t.length !== full) bad++; }
     require("node:worker_threads").parentPort.postMessage({ reads, bad });`,
    {
      eval: true,
      workerData: { file, stop, full: render(msg("", bodies[0] ?? "").frontmatter, bodies[0] ?? "").length },
    },
  );
  const done = new Promise<{ reads: number; bad: number }>((r) => reader.once("message", r));
  for (const b of bodies) await commit("slack", [msg("C7/T/m.md", b)], "w");
  Atomics.store(stop, 0, 1);
  const { reads, bad } = await done;
  assert.ok(reads > 100, `reads ${reads}`);
  assert.equal(bad, 0);
});

const dofBin = fileURLToPath(new URL("../bin/dof.js", import.meta.url));
const runDof = promisify(execFile);
const dofCli = (args: string[], env: Record<string, string> = {}) =>
  runDof(dofBin, args, { env: { ...process.env, ...env } }).then(
    (r) => ({ code: 0, ...r }),
    (e: { code: number; stdout: string; stderr: string }) => e,
  );

test("dof CLI over the socket: tab lines newest first, unknown --in, no hits", async () => {
  const r = await dofCli(["search", "lark", "--in", "slack", "-n", "5"]);
  assert.equal(r.code, 0, r.stderr);
  const lines = r.stdout.trim().split("\n");
  assert.equal(lines.length, 3);
  assert.deepEqual(lines[0]?.split("\t"), ["slack/C6/T/4.md", "2026-10-04T00:00:00Z", "U3", 'quote " star * lark']);
  assert.match(lines[2] ?? "", /^slack\/C6\/T\/2\.md\t/);
  const bad = await dofCli(["search", "x", "--in", "nope"]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /no DOF named nope/);
  const none = await dofCli(["search", "nothing-matches-this"]);
  assert.deepEqual([none.code, none.stdout], [0, ""]);
});

test("dof CLI inside a task posts to <rpc>/rpc/dof.search", async () => {
  let seen: unknown;
  const http = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      seen = { url: req.url, auth: req.headers.authorization, body: JSON.parse(body) };
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          result: [{ dof: "logs", path: "t/summary.md", ts: "t", author: "", title: "T", snippet: "s" }],
        }),
      );
    });
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const port = (http.address() as { port: number }).port;
  const taskFile = join(paths.home(), "task.json");
  writeFileSync(taskFile, JSON.stringify({ rpc: `http://127.0.0.1:${port}` }));
  const r = await dofCli(["search", "two", "words", "--author", "U1"], { HORTUS_TASK: taskFile });
  http.close();
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, "logs/t/summary.md\tt\t\tT\n");
  assert.deepEqual(seen, { url: "/rpc/dof.search", auth: undefined, body: { q: "two words", author: "U1" } });
});
