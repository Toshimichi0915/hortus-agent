import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";
import { tempDir } from "../test/until.ts";

process.env.HORTUS_HOME = tempDir("hortus-mirror-");

const { Config } = await import("../config.ts");
const { openDb, taint, taintOf } = await import("../db.ts");
const { logger } = await import("../log.ts");
const paths = await import("../paths.ts");
const { call, serveSocket } = await import("../rpc.ts");
const { commit, mirrorModule, parse, publishLog, render, search, writeLog } = await import("./index.ts");
const { gcAuto, unsafe } = await import("./repo.ts");

const db = openDb(paths.db());
const config = Config.parse({ dofs: { slack: { type: "slack" }, gh: { type: "github" } } });
await mirrorModule.start({
  config,
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
  // an emoji named __proto__ (Slack and Discord allow it) stays a key through a patch's parse + render
  const proto = Object.fromEntries([["reactions", Object.fromEntries([["__proto__", ["mallory"]]])]]);
  const back = parse(render(proto, "")).frontmatter;
  assert.deepEqual(Object.keys(back.reactions as object), ["__proto__"]);
  assert.equal(Object.getPrototypeOf(back.reactions), Object.prototype);
  assert.equal(render(back, ""), render(proto, ""));
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

test("a name the filesystem refuses drops that change, not the batch", async () => {
  const long = `C9/T/files/F1-${"x".repeat(300)}`;
  const r = await commit(
    "slack",
    [{ op: "put", path: long, bytes: Buffer.from("a") }, msg("C9/T/M.md", "kept")],
    "long name",
  );
  assert.deepEqual(r?.diff, [{ status: "A", path: "C9/T/M.md" }]);
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

test("recover: a stale index.lock is dropped; commits made without indexing (a crash) are indexed once", async () => {
  await commit("rec", [msg("C1/T1/M1.md", "kept body"), msg("C1/T1/M2.md", "doomed body")], "indexed");
  // as after a crash: two commits whose diffs never reached the index, then a git killed mid-commit
  const repo = await import("./repo.ts");
  const fts = await import("./fts.ts");
  await repo.commit(null, "rec", [msg("C1/T1/M3.md", "orphanbody")], "not indexed");
  await repo.commit(null, "rec", [{ op: "delete", path: "C1/T1/M2.md" }, msg("C1/T1/M1.md", "kept edit")], "x");
  const lock = join(paths.dofRepo("rec"), "worktrees", "rec", "index.lock");
  writeFileSync(lock, "");
  await repo.recover(db, "rec");
  assert.equal(existsSync(lock), false);
  assert.deepEqual(
    fts.search(db, { q: "body", in: "rec" }).map((h) => h.path),
    ["C1/T1/M3.md"],
  );
  assert.deepEqual(
    fts.search(db, { q: "kept edit", in: "rec" }).map((h) => h.path),
    ["C1/T1/M1.md"],
  );
  await repo.recover(db, "rec"); // idempotent
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM search_meta WHERE dof = 'rec'").get() as { n: number }).n, 2);
  assert.ok(await commit("rec", [msg("C1/T1/M4.md", "after")], "the lock is gone"));
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

test("loose objects are packed past gc.auto (repos say gc.auto 0), history and the index ref kept", async () => {
  // git samples objects/17/: past `gc.auto / 256` loose objects there it packs (round 7 soak: they were never packed)
  gcAuto.loose = 1;
  try {
    const before = Number(git("gh", "rev-list", "--count", "main"));
    let n = 0;
    const packs = () => Number(/^packs: (\d+)/m.exec(git("gh", "count-objects", "-v"))?.[1]);
    while (packs() === 0 && n < 2000) await commit("gh", [msg(`P/!9/c${n}.md`, `gc ${n++}`)], `gc${n}`);
    assert.ok(packs() > 0, `no pack after ${n} commits`);
    assert.ok(Number(/^count: (\d+)/m.exec(git("gh", "count-objects", "-v"))?.[1]) < 10, "loose objects left");
    assert.equal(Number(git("gh", "rev-list", "--count", "main")), before + n);
    git("gh", "fsck", "--no-progress", "--connectivity-only");
    git("gh", "rev-parse", "--verify", "refs/hortus/indexed");
  } finally {
    gcAuto.loose = 1000;
  }
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
  // the snippet window is in trigrams: wide enough for the whole hit and some words around it
  assert.match(search({ q: "ok go lark again" })[0]?.snippet ?? "", /\[ok go lark again\]/);
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

test("logs: a planted name without a time renders `?`, a linked sessions dir renders nothing", async () => {
  const dir = sessions("t2");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "zzz.jsonl"), line("1", null, { role: "user", content: "planted" }));
  await publishLog("t2", "Planted", "done");
  assert.match(readFileSync(join(paths.logs(), "t2", "session.md"), "utf8"), /^## 1 user \?\n\nplanted/);

  const elsewhere = tempDir("hortus-elsewhere-");
  writeFileSync(join(elsewhere, "1730000000_a.jsonl"), line("1", null, { role: "user", content: "host secret" }));
  mkdirSync(paths.out("t3"), { recursive: true });
  symlinkSync(elsewhere, sessions("t3"));
  await publishLog("t3", "Linked", "done");
  assert.equal(readFileSync(join(paths.logs(), "t3", "session.md"), "utf8"), "");
});

test("logs: a parentId cycle, a self-parent and wrong shapes neither hang nor lose the log", async () => {
  const dir = sessions("t4");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "1730000000_a.jsonl"),
    `null\n5\n"x"\n${line("a", "b", { role: "user", content: "one" })}${line("b", "a", { role: "user", content: "two" })}`,
  );
  writeFileSync(join(dir, "1730000001_b.jsonl"), line("s", "s", { role: "assistant", text: "self", toolCalls: 7 }));
  writeFileSync(join(dir, "1730000002_c.jsonl"), line("m", null, null));
  await publishLog("t4", "Cycle", "done");
  const md = readFileSync(join(paths.logs(), "t4", "session.md"), "utf8");
  assert.match(md, /## 1 user .*\n\none\n\n## 2 user .*\n\ntwo/);
  assert.match(md, /## 3 assistant .*\n\n\(not a message\)/);
  assert.match(md, /## 4 undefined .*\n\n\(not a message\)/);
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

test("search: a common trigram over megabyte session logs answers in bounded time (the snippet is linear)", async () => {
  const { upsert } = await import("./fts.ts");
  const body = "the model said something about deploy; ".repeat(25_000);
  for (let i = 0; i < 3; i++)
    upsert(db, { dof: "logs", path: `big${i}/session.md`, author: "", ts: `2026-11-0${i + 1}`, title: "big", body });
  const t = performance.now();
  const hits = search({ q: "the", in: "logs", limit: 200 });
  const ms = performance.now() - t;
  // FTS5's snippet() took seconds per row here (quadratic in the row's 25,000 hits)
  assert.ok(ms < 500, `${ms} ms`);
  const big = hits.find((h) => h.path === "big0/session.md");
  assert.ok(big?.snippet.startsWith("[the] model"), JSON.stringify(big));
  assert.ok((big?.snippet.length ?? 0) < 200);
});

test("publishLog: a Worker's 48 MB of user turns renders and indexes capped, in bounded time", async () => {
  const { MAX_RENDER } = await import("./logs.ts");
  const dir = join(paths.out("huge"), "sessions");
  mkdirSync(dir, { recursive: true });
  const content = "lorem ipsum dolor sit amet ".repeat(40);
  for (let f = 0; f < 3; f++) {
    const lines: string[] = [];
    for (let i = 0; i < 15_000; i++)
      lines.push(
        JSON.stringify({
          v: 1,
          type: "message",
          id: `${f}-${i}`,
          parentId: i ? `${f}-${i - 1}` : null,
          message: { role: "user", content },
        }),
      );
    writeFileSync(join(dir, `${1730000000 + f}_s.jsonl`), lines.join("\n"));
  }
  const t = performance.now();
  await publishLog("huge", "Huge", "done");
  const ms = performance.now() - t;
  const md = readFileSync(join(paths.logs(), "huge", "session.md"), "utf8");
  assert.ok(md.length < MAX_RENDER + 4096, String(md.length));
  assert.match(md, /… \(session log cut at 16 MB\)\n$/);
  const row = db.prepare("SELECT length(body) AS n FROM search WHERE path = 'huge/session.md'").get() as { n: number };
  assert.ok(row.n <= 4 * 1024 * 1024, String(row.n));
  // uncapped: ~1.5 s here and ~4.5 s at the 256 MB read budget
  assert.ok(ms < 1000, `${ms} ms`);
});

test("dof.search taints a Worker's task with each untrusted hit it is shown; owner hits, owner callers do not", async () => {
  const add = db.prepare("INSERT INTO tasks(id, kind, title, status) VALUES (?, 'unattended', ?, 'running')");
  for (const id of ["W1", "W2", "W3"]) add.run(id, id);
  await commit("slack", [msg("C9/T/1.md", "taintprobe from the owner", { user: "UOWN (me)" })], "owner");
  await commit("slack", [msg("C9/T/2.md", "taintprobe from a stranger", { user: "U999 (eve)" })], "stranger");
  const slack = config.dofs.slack as { owner?: string };
  slack.owner = "UOWN";
  try {
    await call("dof.search", { q: "taintprobe", author: "UOWN" }, { role: "worker", task: "W1" });
    assert.deepEqual(taintOf(db, "W1"), [], "the owner's own message");
    await call("dof.search", { q: "taintprobe" }, { role: "owner" });
    await call("dof.search", { q: "taintprobe" }, { role: "worker", task: "W2" });
    assert.deepEqual(taintOf(db, "W2"), ["searched the mirror: slack:U999 (untrusted)"]);
    // a tainted task's session log is untrusted to the next reader; an untainted one's is not
    writeLog("W2", { "session.md": "taintprobe in a log" }, "w2");
    writeLog("W1", { "session.md": "taintprobe in a log" }, "w1");
    await call("dof.search", { q: "taintprobe", in: "logs" }, { role: "worker", task: "W3" });
    assert.deepEqual(taintOf(db, "W3"), ["searched the mirror: logs:W2 (tainted)"]);
    for (let i = 0; i < 9; i++) taint(db, "W3", `r${i}`);
    assert.equal(taintOf(db, "W3").length, 5, "at most five reasons are kept");
  } finally {
    slack.owner = undefined;
  }
});
