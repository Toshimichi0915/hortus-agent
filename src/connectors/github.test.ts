/**
 * Step 6 against the fake GitHub, gateway level: the real gateway, webhook listener, mirror writer, vault and proxy
 * pipeline (HORTUS_NO_NET=1, ephemeral ports). Workers are loopback clients: 127.0.0.2 (curl-like requests) and the
 * session address 127.0.0.5 (git, reached through `http.curloptResolve`). The Planner-routed done-when is tested
 * after the planner lands.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type http from "node:http";
import https from "node:https";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { Config } from "../config.ts";
import type { Ctx } from "../ctx.ts";
import { openDb } from "../db.ts";
import { createGateway, type Gateway } from "../gateway/gateway.ts";
import { createWebhooks, type Webhooks } from "../gateway/webhooks.ts";
import { logger } from "../log.ts";
import { commit, mirrorModule, parse } from "../mirror/index.ts";
import * as paths from "../paths.ts";
import { fetchRepo, relay, repoDir } from "../projects/repos.ts";
import { coreFetch, links, listen, proxyModule } from "../proxy/index.ts";
import { sandboxEnv } from "../runtime/host.ts";
import { FakeGitHub } from "../test/fakes/github.ts";
import { memLog, tempDir, until } from "../test/until.ts";
import type { Forge, InboxMsg, TaskJson } from "../types.ts";
import { caCert } from "../vault/ca.ts";
import { gate, transforms, vaultModule } from "../vault/index.ts";
import { PERMISSIONS } from "../vault/ops.ts";
import { write as writeVault } from "../vault/vault.ts";
import { connectors } from "./index.ts";

process.env.HORTUS_HOME = tempDir("hortus-github-");
process.env.HORTUS_NO_NET = "1";
const run = promisify(execFile);

const fake = await FakeGitHub.start();
fake.associations.set("toshi", "OWNER");
fake.associations.set("carol", "COLLABORATOR");
await fake.repo("o/r", "the repo");
await fake.repo("o/other");
writeVault({ ...fake.vault("github"), ...fake.vault("ghe") });

const upstreams = { "api.github.com": fake.url, "github.com": fake.url, "ghe.test": fake.url };
const base = {
  dofs: { github: { type: "github", owner: "toshi" } },
  dev: { upstreams },
  proxy: { https: 0, http: 0, dns: 0 },
};
const ctx: Ctx = {
  config: Config.parse(base),
  db: openDb(paths.db()),
  paths,
  log: logger,
  reload: async () => {},
};
const db = ctx.db;
const log = memLog();
let wakes = 0;
let gw: Gateway;
let wh: Webhooks;
let ports: { https: number; http: number; dns: number };
let ports5: { https: number; http: number; dns: number };
const inbox: [string, Omit<InboxMsg, "seq" | "ts">][] = [];
/** approve every non-consequential pending entry as it is created (a stand-in for 3e's `auto`) */
let autoApprove = false;

before(async () => {
  await mirrorModule.start(ctx);
  await vaultModule.start(ctx);
  await proxyModule.start(ctx);
  ports = await listen("127.0.0.1", { https: 0, http: 0, dns: 0, proxyAddress: "127.0.0.1" });
  ports5 = await listen("127.0.0.5", { https: 0, http: 0, dns: 0, proxyAddress: "127.0.0.1" });
  db.prepare("INSERT INTO tasks(id, kind, status, scope, origins) VALUES ('W', 'unattended', 'running', ?, ?)").run(
    JSON.stringify({ credentials: ["github"], repos: ["github:o/r"] }),
    JSON.stringify("*"),
  );
  links.register("127.0.0.2", "worker", "W", "session");
  links.register("127.0.0.5", "worker", "W", "session");
  gate.deps.inboxWrite = (t, m) => inbox.push([t, m]);
  gate.deps.notify = (text) => {
    const id = Number(text.match(/approval (\d+)/)?.[1]);
    const row = db.prepare("SELECT payload FROM approvals WHERE id = ?").get(id) as { payload: string };
    if (autoApprove && !JSON.parse(row.payload).consequential) gate.decide(id, "approve", "owner");
  };
  gw = createGateway({
    db,
    config: () => ctx.config,
    log,
    connectors,
    fetch: () => coreFetch,
    commit: (dof, changes, msg) => commit(dof, changes, msg),
    wake: () => {
      wakes++;
    },
    hasRef: (ref) => db.prepare("SELECT 1 FROM task_refs WHERE ref = ?").get(ref) !== undefined,
  });
  gw.start();
  wh = createWebhooks({
    db,
    config: () => ctx.config,
    log,
    connector: (d) => gw.connector(d),
    fetchRepo: (dof, p, url) => fetchRepo(dof, p, url, coreFetch),
  });
  fake.hook = `http://127.0.0.1:${await wh.start(0)}/github/webhook`;
  await until(
    () => (db.prepare("SELECT count(*) AS n FROM syncs WHERE dof = 'github'").get() as { n: number }).n === 2,
    10_000,
    "backfill",
  );
});

after(async () => {
  await wh.stop();
  await gw.stop();
  await proxyModule.stop();
  await vaultModule.stop();
  await fake.close();
});

// ---- helpers ---------------------------------------------------------------------------------------------------

const file = (p: string) => join(paths.dof("github"), p);
const fm = (p: string) => (existsSync(file(p)) ? parse(readFileSync(file(p), "utf8")) : undefined);
const rows = () => (db.prepare("SELECT count(*) AS n FROM events WHERE dof = 'github'").get() as { n: number }).n;
const row = (key: string) =>
  db.prepare("SELECT trusted, member, author, bot FROM events WHERE key = ?").get(key) as
    | { trusted: number; member: number; author: string; bot: number }
    | undefined;
const pending = (consequential: boolean) =>
  (
    db.prepare("SELECT id, summary, payload FROM approvals WHERE status = 'pending' ORDER BY id").all() as {
      id: number;
      summary: string;
      payload: string;
    }[]
  ).filter((r) => JSON.parse(r.payload).consequential === consequential);

interface R {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}
function send(o: { host: string; path: string; method?: string; headers?: Record<string, string>; body?: string }) {
  const ca = readFileSync(caCert());
  return new Promise<R>((resolve, reject) => {
    const r = https.request(
      {
        host: "127.0.0.1",
        port: ports.https,
        method: o.method ?? "GET",
        path: o.path,
        headers: { host: o.host, ...o.headers },
        localAddress: "127.0.0.2",
        agent: false,
        servername: o.host,
        ca,
      },
      (res) => {
        const c: Buffer[] = [];
        res.on("data", (x: Buffer) => c.push(x));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(c).toString() }),
        );
      },
    );
    r.on("error", reject);
    r.end(o.body);
  });
}
/** one pkt-line command and the flush */
const pkt = (cmd: string) => `${(cmd.length + 4).toString(16).padStart(4, "0")}${cmd}0000`;
const isApproval = (r: R) => r.status === 403 && r.body.startsWith("{");
/** retry through auto-approved (non-consequential) gate entries */
async function approved(f: () => Promise<R>): Promise<R> {
  autoApprove = true;
  try {
    for (let i = 0; i < 5; i++) {
      const r = await f();
      if (!isApproval(r) || JSON.parse(r.body).approval === undefined) return r;
      await sleep(10);
    }
    return f();
  } finally {
    autoApprove = false;
  }
}
const bearer = { authorization: "Bearer hortus-secret-github" };

/** git as the Worker on 127.0.0.5: plain https://github.com/ URLs, the placeholder added by insteadOf */
function git(cwd: string, ...args: string[]) {
  const cfg: [string, string][] = [
    ["http.sslCAInfo", caCert()],
    ["http.curloptResolve", `github.com:${ports5.https}:127.0.0.5`],
    [`url.https://x-access-token:hortus-secret-github@github.com:${ports5.https}/.insteadOf`, "https://github.com/"],
    ["credential.helper", ""],
    ["user.name", "w"],
    ["user.email", "w@x"],
  ];
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HORTUS_HOME ?? "/tmp",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: String(cfg.length),
  };
  cfg.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k;
    env[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  return run("git", args, { cwd, env }).then((r) => r.stdout.trim());
}
/** retry a git command through auto-approved reads until it succeeds or `stop()` */
async function gitUntil(cwd: string, args: string[], stop: () => boolean = () => false): Promise<boolean> {
  autoApprove = true;
  try {
    for (let i = 0; i < 12; i++) {
      try {
        await git(cwd, ...args);
        return true;
      } catch {
        if (stop()) return false;
        await sleep(20);
      }
    }
    throw new Error(`git ${args.join(" ")} kept failing`);
  } finally {
    autoApprove = false;
  }
}

// ---- webhooks --------------------------------------------------------------------------------------------------

test("webhook: valid → 200 and one row; bad signature → 401, no row; replay → 200, no new row; 30 MB → 413", async () => {
  const n0 = rows();
  const first = await fake.openIssue("o/r", { user: "toshi", title: "Crash on start", body: "it crashes" });
  assert.equal(first.status, 200);
  assert.equal(rows(), n0 + 1);
  const payload = fake.deliveries.find((d) => d.guid === first.guid)?.request.payload ?? {};
  const bad = await fake.deliver("issues", payload, { signature: `sha256=${"0".repeat(64)}` });
  assert.equal(bad.status, 401);
  assert.equal(row(bad.guid), undefined);
  const replay = await fake.deliver("issues", payload, { guid: first.guid });
  assert.equal(replay.status, 200);
  assert.equal(rows(), n0 + 1);
  const big = await fetch(fake.hook ?? "", { method: "POST", body: Buffer.alloc(30 * 1024 * 1024) });
  assert.equal(big.status, 413);
  const unknown = await fetch((fake.hook ?? "").replace("/github/", "/nope/"), { method: "POST", body: "{}" });
  assert.equal(unknown.status, 404);
});

test("backfill: channel.md per project in owner__repo with the real name", () => {
  assert.equal(fm("o__r/channel.md")?.frontmatter.name, "o/r");
  assert.equal(fm("o__r/channel.md")?.frontmatter.default_branch, "main");
  assert.ok(fm("o__other/channel.md"));
});

test("mirror: an issue opened, commented, labelled, closed", async () => {
  const { n } = await fake.openIssue("o/r", { user: "toshi", title: "Bug A", body: "steps" });
  const c = await fake.comment("o/r", n, { user: "toshi", body: "fix this" });
  await fake.label("o/r", n, "bug", "toshi");
  await fake.closeThread("o/r", n, "toshi");
  const top = await until(() =>
    fm(`o__r/#${n}/#${n}.md`)?.frontmatter.state === "closed" ? fm(`o__r/#${n}/#${n}.md`) : null,
  );
  assert.deepEqual(top.frontmatter.labels, ["bug"]);
  assert.equal(top.frontmatter.title, "Bug A");
  assert.equal(top.frontmatter.user, "toshi");
  assert.equal(top.body.trim(), "steps");
  const msg = fm(`o__r/#${n}/${c.id}.md`);
  assert.equal(msg?.body.trim(), "fix this");
  assert.equal(msg?.frontmatter.thread, `#${n}`);
});

test("mirror: a PR with its diff, a review, a review comment, check suites; CI wakes only with a ref", async () => {
  const sha = await fake.commit("o/r", "feature", "a.txt", "a\n");
  const diff = "diff --git a/a.txt b/a.txt\n+a\n";
  const pr = await fake.openPR("o/r", { user: "toshi", title: "Feature", head: "feature", diff });
  const t = `!${pr.n}`;
  await until(() => existsSync(file(`o__r/${t}/files/diff.patch`)), 3000, "diff.patch");
  assert.equal(readFileSync(file(`o__r/${t}/files/diff.patch`), "utf8"), diff);
  const top = fm(`o__r/${t}/${t}.md`)?.frontmatter ?? {};
  assert.equal(top.state, "open");
  assert.equal(top.head, "feature");
  assert.equal(top.base, "main");
  assert.equal(top.head_sha, sha);

  await fake.review("o/r", pr.n, { user: "carol", state: "APPROVED", body: "lgtm" });
  const rv = await until(() => fm(`o__r/${t}/review-${fake.reviewsOf("o/r").at(-1)?.id}.md`));
  assert.equal(rv.frontmatter.review, "approved");
  await fake.reviewComment("o/r", pr.n, { user: "carol", body: "nit", path: "a.txt", line: 1 });
  const rc = await until(() => fm(`o__r/${t}/rc-${fake.reviewCommentsOf("o/r").at(-1)?.id}.md`));
  assert.equal(rc.frontmatter.path, "a.txt");
  assert.equal(rc.frontmatter.line, 1);

  for (let w = -1; w !== wakes; await sleep(300)) w = wakes; // the review comment's wake can land after its file
  const w0 = wakes;
  await fake.checkSuite("o/r", sha, { conclusion: "failure" });
  await until(() => fm(`o__r/${t}/${t}.md`)?.frontmatter.checks === "failure", 3000, "checks patch");
  await sleep(100);
  assert.equal(wakes, w0, "not in task_refs: no wake");
  db.prepare("INSERT INTO task_refs(ref, task_id) VALUES (?, 'W')").run(`github:o/r:${t}`);
  await fake.checkSuite("o/r", sha, { status: "in_progress", conclusion: null });
  await until(() => fm(`o__r/${t}/${t}.md`)?.frontmatter.checks === "pending", 3000, "pending");
  await until(() => wakes === w0 + 1, 3000, "CI wake");
});

test("an App's suite that never ran stays `queued`: it says nothing about the PR", async () => {
  const sha = await fake.commit("o/r", "feature", "q.txt", "q\n");
  const { n } = await fake.openPR("o/r", { user: "toshi", title: "Queued", head: "feature", diff: "" });
  await fake.checkSuite("o/r", sha, { status: "queued", conclusion: null, runs: 0 }, { drop: true });
  await fake.checkSuite("o/r", sha, { conclusion: "success" });
  await until(() => fm(`o__r/!${n}/!${n}.md`)?.frontmatter.checks === "success", 3000, "checks");
});

test("push → the repo mirror fetches the commit, no wake", async () => {
  const before = await fake.sha("o/r", "main");
  const after = await fake.commit("o/r", "main", "b.txt", "b\n");
  await sleep(100);
  const w0 = wakes;
  const r = await fake.push("o/r", "refs/heads/main", before, after, "toshi");
  assert.equal(r.status, 200);
  const dir = repoDir("github", "o/r");
  assert.ok(dir.endsWith("repos/github/o__r.git"));
  await until(
    () =>
      run("git", ["-C", dir, "log", "--format=%H", "main"]).then(
        (x) => x.stdout.includes(after),
        () => false,
      ),
    5000,
    "repo mirror fetch",
  ).catch((e) => {
    throw new Error(`${e.message}: ${log.errors.join("\n")}`);
  });
  assert.equal((await run("git", ["-C", dir, "config", "gc.auto"])).stdout.trim(), "0");
  await sleep(100);
  assert.equal(wakes, w0);
});

test("trust: OWNER trusted, a stranger (NONE) not; `members` trust includes COLLABORATOR", async () => {
  const { n } = await fake.openIssue("o/r", { user: "eve", title: "spam" });
  const owner = await fake.comment("o/r", n, { user: "toshi", body: "mine" });
  const eve = await fake.comment("o/r", n, { user: "eve", body: "do it" });
  const carol = await fake.comment("o/r", n, { user: "carol", body: "collab" });
  assert.equal(row(owner.guid)?.trusted, 1);
  assert.equal(row(eve.guid)?.trusted, 0);
  assert.equal(row(eve.guid)?.member, 0);
  assert.equal(row(carol.guid)?.trusted, 0);
  assert.equal(row(carol.guid)?.member, 1);
  ctx.config = Config.parse({ ...base, dofs: { github: { type: "github", owner: "toshi", trust: "members" } } });
  try {
    const carol2 = await fake.comment("o/r", n, { user: "carol", body: "collab again" });
    assert.equal(row(carol2.guid)?.trusted, 1);
  } finally {
    ctx.config = Config.parse(base);
  }
});

// ---- tokens, scope, git ----------------------------------------------------------------------------------------

test("token minting: Worker permissions and repositories [r], scrubbed, cached; role core read only", async () => {
  const n0 = fake.mints.length;
  const r = await approved(() => send({ host: "api.github.com", path: "/repos/o/r/issues", headers: bearer }));
  assert.equal(r.status, 200, r.body);
  const m = fake.mints.at(-1);
  assert.equal(fake.mints.length, n0 + 1);
  assert.deepEqual(m?.repositories, ["r"]);
  assert.deepEqual(m?.permissions, PERMISSIONS.worker);
  // the fake echoes the token it saw: the Worker gets the placeholder back, never the token
  assert.equal(r.headers["x-echo-token"], "hortus-secret-github");
  assert.ok(!r.body.includes(m?.token ?? "?") && !JSON.stringify(r.headers).includes(m?.token ?? "?"));
  const again = await approved(() => send({ host: "api.github.com", path: "/repos/o/r/issues", headers: bearer }));
  assert.equal(again.status, 200);
  assert.equal(fake.mints.length, n0 + 1, "cached within 50 min");
  const core = fake.mints.find((x) => !x.repositories);
  assert.deepEqual(core?.permissions, PERMISSIONS.core);
  assert.ok(Object.values(core?.permissions ?? {}).every((v) => v === "read"));
});

test("scope: in-scope passes, another repo 403; POST /user/repos → approval → repos extend the scope", async () => {
  const other = await send({ host: "api.github.com", path: "/repos/o/other/issues", headers: bearer });
  assert.equal(other.status, 403);
  assert.match(other.body, /project scope/);
  const basic = { authorization: `Basic ${Buffer.from("x-access-token:hortus-secret-github").toString("base64")}` };
  const refs = "/o/newrepo.git/info/refs?service=git-receive-pack";
  assert.match((await send({ host: "github.com", path: refs, headers: basic })).body, /project scope/);

  const create = () =>
    send({
      host: "api.github.com",
      path: "/user/repos",
      method: "POST",
      headers: { ...bearer, "content-type": "application/json" },
      body: JSON.stringify({ name: "newrepo" }),
    });
  const first = await create();
  assert.ok(isApproval(first), first.body);
  gate.decide(JSON.parse(first.body).approval, "approve", "owner");
  const done = await create();
  assert.equal(done.status, 201, done.body);
  assert.equal(fake.mints.at(-1)?.permissions.administration, "write");
  const scope = JSON.parse((db.prepare("SELECT scope FROM tasks WHERE id = 'W'").get() as { scope: string }).scope);
  assert.deepEqual(scope.repos, ["github:o/r", "github:o/newrepo"]);
  // the new repo is in scope now; a push stays consequential
  const after = await approved(() => send({ host: "github.com", path: refs, headers: basic }));
  assert.equal(after.status, 200, after.body);
  const pushReq = await send({
    host: "github.com",
    path: "/o/newrepo.git/git-receive-pack",
    method: "POST",
    headers: { ...basic, "content-type": "application/x-git-receive-pack-request" },
    body: pkt(`${"0".repeat(40)} ${"1".repeat(40)} refs/heads/main\n`),
  });
  assert.ok(isApproval(pushReq), pushReq.body);
  // reset for the git tests
  db.prepare("UPDATE tasks SET scope = ? WHERE id = 'W'").run(
    JSON.stringify({ credentials: ["github"], repos: ["github:o/r"] }),
  );
  gate.decide(JSON.parse(pushReq.body).approval, "reject", "owner");
});

test("insteadOf clone through the proxy carries the minted token; push asks once per ref update", async () => {
  const work = tempDir("hortus-gh-work-");
  await gitUntil(work, ["clone", "-q", "https://github.com/o/r.git", "r"]);
  const workerToken = fake.mints.find((m) => m.repositories?.join() === "r")?.token;
  assert.ok(workerToken && fake.gitAuths.includes(workerToken), "the fake's git server saw the Worker's token");
  const cwd = join(work, "r");
  await git(cwd, "checkout", "-q", "-b", "hortus/W");
  await run("sh", ["-c", "echo w > w.txt"], { cwd });
  await git(cwd, "add", "w.txt");
  await git(cwd, "commit", "-q", "-m", "w");
  const head = await git(cwd, "rev-parse", "HEAD");

  // first push: refused with an approval whose rendering is the ref update
  const n0 = pending(true).length;
  assert.equal(await gitUntil(cwd, ["push", "-q", "origin", "hortus/W"], () => pending(true).length > n0), false);
  const p = pending(true).at(-1);
  assert.ok(p);
  const summary = JSON.parse(p.summary) as { rendered?: string };
  assert.match(summary.rendered ?? "", new RegExp(`^push o/r: 0000000 → ${head.slice(0, 7)} refs/heads/hortus/W$`));
  // the same push again is the same entry
  await gitUntil(cwd, ["push", "-q", "origin", "hortus/W"], () => true);
  assert.equal(pending(true).length, n0 + 1);
  assert.equal(pending(true).at(-1)?.id, p.id);
  gate.decide(p.id, "approve", "owner");
  assert.equal(inbox.at(-1)?.[0], "W");
  assert.equal(inbox.at(-1)?.[1].from, "approval");
  assert.equal(await gitUntil(cwd, ["push", "-q", "origin", "hortus/W"]), true);
  assert.equal(await fake.sha("o/r", "hortus/W"), head);

  // a push to main is its own entry, which the owner rejects
  const mainBefore = await fake.sha("o/r", "main");
  await gitUntil(cwd, ["push", "-q", "origin", "HEAD:main"], () => pending(true).some((x) => x.id !== p.id));
  const q = pending(true).find((x) => x.id !== p.id);
  assert.ok(q);
  assert.match((JSON.parse(q.summary) as { rendered: string }).rendered, /refs\/heads\/main$/);
  gate.decide(q.id, "reject", "owner");
  assert.equal(await fake.sha("o/r", "main"), mainBefore);
});

test("redelivery: a delivery the tunnel dropped is picked up by the check and mirrored", async () => {
  const { n } = await fake.openIssue("o/r", { user: "toshi", title: "Later" });
  const lost = await fake.comment("o/r", n, { user: "toshi", body: "dropped" }, { drop: true });
  assert.equal(row(lost.guid), undefined);
  await wh.redeliver("github");
  assert.ok(row(lost.guid));
  assert.ok((wh.state.get("github")?.missed ?? 0) >= 1);
  assert.ok(wh.state.get("github")?.lastRedelivery);
  await until(() => fm(`o__r/#${n}/${lost.id}.md`), 3000, "redelivered comment");
  await wh.redeliver("github");
  assert.equal(wh.state.get("github")?.missed, 0);
});

test("redelivery: the log's deliveries outside `repos`, and one whose payload is gone, stay out", async () => {
  const { n } = await fake.openIssue("o/r", { user: "toshi", title: "Filtered" });
  const lost = await fake.comment("o/r", n, { user: "toshi", body: "not ours" }, { drop: true });
  const empty = await fake.comment("o/r", n, { user: "toshi", body: "no payload" }, { drop: true });
  const d = fake.deliveries.find((x) => x.guid === empty.guid);
  assert.ok(d);
  (d.request as { payload: unknown }).payload = null; // nullable in the OpenAPI description
  const conn = (await connectors.github?.({
    name: "github",
    config: { type: "github", repos: ["o/other"] },
    log,
    fetch: coreFetch,
    hasRef: () => false,
  })) as Forge;
  const got: string[] = [];
  for await (const r of conn.redeliveries?.("2000-01-01T00:00:00Z", () => false) ?? []) got.push(r.key);
  assert.ok(!got.includes(lost.guid) && !got.includes(empty.guid));
  await wh.redeliver("github"); // the real one takes the first; the empty one must not stop the check
  assert.ok(row(lost.guid));
  assert.equal(row(empty.guid), undefined);
});

test("host config: {api}/{host} expand from the DOF config; the connector talks to /api/v3", async () => {
  ctx.config = Config.parse({ ...base, dofs: { ...base.dofs, ghe: { type: "github", host: "ghe.test" } } });
  try {
    await transforms.load();
    const m = transforms.get("github")?.manifest;
    assert.ok(m);
    assert.ok(m.credentials.github?.hosts.includes("ghe.test"));
    assert.ok(m.credentials.github?.hosts.includes("api.github.com"));
    assert.ok(m.scope?.includes("ghe.test/api/v3/repos/{project}/**"));
    assert.ok(m.scope?.includes("api.github.com/repos/{project}/**"));
    assert.ok(m.consequential?.includes("POST ghe.test/**/git-receive-pack"));
    const ghe = ctx.config.dofs.ghe ?? { type: "github" };
    const conn = (await connectors.github?.({
      name: "ghe",
      config: ghe,
      log,
      fetch: coreFetch,
      hasRef: () => false,
    })) as Forge;
    assert.deepEqual((await conn.projects()).sort(), ["o/newrepo", "o/other", "o/r"]);
    assert.ok(fake.calls.some((c) => c.url.startsWith("/api/v3/installation/repositories")));
    assert.ok(fake.calls.some((c) => c.url.startsWith("/api/v3/app/installations/2/access_tokens")));
    assert.equal(conn.clone("o/r"), "https://ghe.test/o/r.git");
  } finally {
    ctx.config = Config.parse(base);
    await transforms.load();
  }
});

test("the shipped transform passes its tests and renders pushes, PRs and DELETEs", () => {
  const r = transforms.runTests("github");
  assert.equal(r.length, 4);
  for (const x of r) assert.ok(x.ok, `${x.file}: ${x.diff}`);
  const body = pkt(`${"0".repeat(40)} 3f2a1c9${"0".repeat(33)} refs/heads/hortus/t1\0 report-status`);
  const t = { headers: {}, stream: true };
  const push = { ...t, method: "POST", url: "https://github.com/o/r.git/git-receive-pack", body };
  assert.equal(transforms.render("github", push), "push o/r: 0000000 → 3f2a1c9 refs/heads/hortus/t1");
  const prBody = JSON.stringify({ title: "Fix", head: "hortus/t1", base: "main" });
  const pr = { ...t, stream: false, method: "POST", url: "https://api.github.com/repos/o/r/pulls", body: prBody };
  assert.equal(transforms.render("github", pr), 'open PR o/r: "Fix" hortus/t1 → main');
  const del = {
    ...t,
    stream: false,
    method: "DELETE",
    url: "https://api.github.com/repos/o/r/issues/comments/1",
    body: null,
  };
  assert.equal(transforms.render("github", del), "DELETE /repos/o/r/issues/comments/1");
});

test("sandboxEnv: one insteadOf entry per github DOF", () => {
  const cfg = Config.parse({ dofs: { github: { type: "github" }, ghe: { type: "github", host: "ghe.test" } } });
  const env = sandboxEnv({ id: "x", scope: { credentials: [], repos: [] } } as unknown as TaskJson, cfg);
  const pairs = Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => [
    env[`GIT_CONFIG_KEY_${i}`],
    env[`GIT_CONFIG_VALUE_${i}`],
  ]);
  assert.deepEqual(
    pairs.filter(([k]) => k?.endsWith(".insteadOf")),
    [
      ["url.https://x-access-token:hortus-secret-github@github.com/.insteadOf", "https://github.com/"],
      ["url.https://x-access-token:hortus-secret-ghe@ghe.test/.insteadOf", "https://ghe.test/"],
    ],
  );
});

test("repo relay: only its token and the project's upload-pack paths reach core", async () => {
  const seen: string[] = [];
  const r = await relay(new URL("https://github.com/o/r.git"), async (url, init) => {
    seen.push(`${init?.method} ${url}`);
    return new Response("ok");
  });
  const at = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${r.port}${path}`, init);
  try {
    const good = { "X-Hortus-Relay": r.token };
    assert.equal((await at("/o/r.git/info/refs?service=git-upload-pack")).status, 404);
    assert.equal(
      (await at("/o/r.git/info/refs?service=git-upload-pack", { headers: { "X-Hortus-Relay": "x" } })).status,
      404,
    );
    assert.equal((await at("/o/r.git/info/refs?service=git-receive-pack", { headers: good })).status, 404);
    assert.equal((await at("/o/r.git/git-receive-pack", { method: "POST", headers: good, body: "x" })).status, 404);
    assert.equal((await at("/o/other.git/info/refs?service=git-upload-pack", { headers: good })).status, 404);
    assert.equal((await at("/o/r.git/info/refs?service=git-upload-pack", { headers: good })).status, 200);
    assert.deepEqual(seen, ["GET https://github.com/o/r.git/info/refs?service=git-upload-pack"]);
  } finally {
    r.server.close();
  }
});
