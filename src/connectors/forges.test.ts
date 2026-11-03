/**
 * The step-6 forge flow, parameterized by forge (18-gitlab-bitbucket.md › Functional tests), against the fake GitHub,
 * GitLab and Bitbucket at once: one gateway, one webhook listener, the real mirror writer, vault and proxy pipeline
 * (HORTUS_NO_NET=1, ephemeral ports). Workers are loopback clients: 127.0.0.2 (REST) and 127.0.0.5 (git, reached
 * through `http.curloptResolve`). GitHub-only behaviour (installation tokens, the delivery log) is in github.test.ts.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import type http from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import https from "node:https";
import { tmpdir } from "node:os";
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
import { fetchRepo, repoDir } from "../projects/repos.ts";
import { coreFetch, links, listen, proxyModule } from "../proxy/index.ts";
import { sandboxEnv } from "../runtime/host.ts";
import { FakeBitbucket } from "../test/fakes/bitbucket.ts";
import { FakeGitHub } from "../test/fakes/github.ts";
import { FakeGitLab } from "../test/fakes/gitlab.ts";
import { memLog, until } from "../test/until.ts";
import type { Forge, TaskJson } from "../types.ts";
import { caCert } from "../vault/ca.ts";
import { gate, transforms, vaultModule } from "../vault/index.ts";
import { write as writeVault } from "../vault/vault.ts";
import { dirOf } from "./forge.ts";
import { patchOf } from "./gitlab.ts";
import { connectors } from "./index.ts";

process.env.HORTUS_HOME = mkdtempSync(join(tmpdir(), "hortus-forges-"));
process.env.HORTUS_NO_NET = "1";
const run = promisify(execFile);

const gh = await FakeGitHub.start();
gh.associations.set("toshi", "OWNER");
gh.associations.set("carol", "COLLABORATOR");
await gh.repo("o/r", "the repo");
await gh.repo("o/other");
const gl = await FakeGitLab.start();
gl.members.set("toshi", 50);
gl.members.set("carol", 30);
await gl.repo("g/sub/p", "nested");
await gl.repo("g/p");
await gl.repo("g/other");
const bb = await FakeBitbucket.start();
bb.members.add("toshi");
bb.members.add("carol");
await bb.repo("w/r", "the repo");
await bb.repo("w/other");
writeVault({ ...gh.vault("github"), ...gl.vault("gitlab"), ...gl.vault("gle"), ...bb.vault("bitbucket") });

const upstreams = {
  "api.github.com": gh.url,
  "github.com": gh.url,
  "gitlab.com": gl.url,
  "gitlab.example.com": gl.url,
  "api.bitbucket.org": bb.url,
  "bitbucket.org": bb.url,
};
const dofs = {
  github: { type: "github", owner: "toshi" },
  gitlab: { type: "gitlab", owner: "toshi" },
  bitbucket: { type: "bitbucket", owner: "acc-toshi" },
};
const base = { dofs, dev: { upstreams }, proxy: { https: 0, http: 0, dns: 0 } };
const ctx: Ctx = { config: Config.parse(base), db: openDb(paths.db()), paths, log: logger, reload: async () => {} };
const db = ctx.db;
const log = memLog();
let wakes = 0;
let gw: Gateway;
let wh: Webhooks;
let ports: { https: number; http: number; dns: number };
let ports5: { https: number; http: number; dns: number };
let autoApprove = false;
const SCOPE = {
  credentials: ["github", "gitlab", "bitbucket"],
  repos: ["github:o/r", "gitlab:g/sub/p", "gitlab:g/p", "bitbucket:w/r"],
};

// ---- the per-forge harness ---------------------------------------------------------------------------------------

interface Sent {
  status: number;
  guid: string;
}
type CI = "failure" | "pending";
interface Harness {
  dof: keyof typeof dofs;
  /** the project the flow runs on, one outside the Worker's scope */
  P: string;
  fake: { url: string; hook?: string; gitAuths: string[]; calls: { url: string }[] };
  apiHost: string;
  gitHost: string;
  gitUser: string;
  rest: Record<string, string>;
  inScope: string;
  outScope: string;
  create: { path: string; body: string };
  /** an in-scope admin call (members, visibility): asks like a creation (static tokens are not narrowed upstream) */
  admin?: { method: string; path: string };
  closed: string;
  /** what the fake's git server must see from the Worker */
  token(): string | undefined;
  openIssue(user: string, title: string, body?: string, drop?: boolean): Promise<Sent & { n: number }>;
  comment(n: number, user: string, body: string): Promise<Sent & { id: number }>;
  closeIssue(n: number, user: string): Promise<unknown>;
  openPR(user: string, title: string, head: string, diff: string): Promise<Sent & { n: number; sha: string }>;
  /** approve as `user`; the review message's file id */
  approve(n: number, user: string): Promise<string>;
  ci(sha: string, s: CI): Promise<unknown>;
  merge(n: number, user: string): Promise<unknown>;
  push(ref: string, before: string, after: string, user: string): Promise<Sent>;
  /** re-post delivery `guid` as is, and with a bad signature */
  replay(guid: string): Promise<Sent>;
  forged(guid: string): Promise<Sent>;
  commit(branch: string, file: string, content: string): Promise<string>;
  sha(branch: string): Promise<string>;
  /** the cursor parameter of a history call */
  since: RegExp;
  /** `dofs.<name>.repos` → what `projects()` returns */
  globs: [string[], string[]][];
}

const ghPayload = (guid: string) => {
  const d = gh.deliveries.find((x) => x.guid === guid);
  if (!d) throw new Error(`no delivery ${guid}`);
  return d;
};
const own = <T extends { guid: string }>(list: T[], guid: string): T => {
  const d = list.find((x) => x.guid === guid);
  if (!d) throw new Error(`no delivery ${guid}`);
  return d;
};

const H: Harness[] = [
  {
    dof: "github",
    P: "o/r",
    fake: gh,
    apiHost: "api.github.com",
    gitHost: "github.com",
    gitUser: "x-access-token",
    rest: { authorization: "Bearer hortus-secret-github" },
    inScope: "/repos/o/r/issues",
    outScope: "/repos/o/other/issues",
    create: { path: "/user/repos", body: JSON.stringify({ name: "newrepo" }) },
    closed: "closed",
    token: () => gh.mints.find((m) => m.repositories?.join() === "r")?.token,
    openIssue: (user, title, body, drop) => gh.openIssue("o/r", { user, title, body: body ?? "" }, { drop: !!drop }),
    comment: (n, user, body) => gh.comment("o/r", n, { user, body }),
    closeIssue: (n, user) => gh.closeThread("o/r", n, user),
    openPR: (user, title, head, diff) => gh.openPR("o/r", { user, title, head, diff }),
    approve: async (n, user) => {
      await gh.review("o/r", n, { user, state: "APPROVED", body: "lgtm" });
      return `review-${gh.reviewsOf("o/r").at(-1)?.id}`;
    },
    ci: (sha, s) =>
      gh.checkSuite(
        "o/r",
        sha,
        s === "failure" ? { conclusion: "failure" } : { status: "in_progress", conclusion: null },
      ),
    merge: (n, user) => gh.closeThread("o/r", n, user, { merged: true }),
    push: (ref, b, a, user) => gh.push("o/r", ref, b, a, user),
    replay: (guid) => gh.deliver(ghPayload(guid).event, ghPayload(guid).request.payload, { guid }),
    forged: (guid) =>
      gh.deliver(ghPayload(guid).event, ghPayload(guid).request.payload, { signature: `sha256=${"0".repeat(64)}` }),
    commit: (b, f, c) => gh.commit("o/r", b, f, c),
    sha: (b) => gh.sha("o/r", b),
    since: /[?&]since=/,
    globs: [
      [["o/r"], ["o/r"]],
      [["o/*"], ["o/other", "o/r"]],
    ],
  },
  {
    dof: "gitlab",
    P: "g/sub/p",
    fake: gl,
    apiHost: "gitlab.com",
    gitHost: "gitlab.com",
    gitUser: "oauth2",
    rest: { "private-token": "hortus-secret-gitlab" },
    inScope: "/api/v4/projects/g%2Fsub%2Fp/issues",
    outScope: "/api/v4/projects/g%2Fother/issues",
    create: { path: "/api/v4/projects", body: JSON.stringify({ name: "newp" }) },
    admin: { method: "POST", path: "/api/v4/projects/g%2Fp/members" },
    closed: "closed",
    token: () => gl.token,
    openIssue: (user, title, body, drop) =>
      gl.openIssue("g/sub/p", { user, title, body: body ?? "" }, { drop: !!drop }),
    comment: (n, user, body) => gl.comment("g/sub/p", n, { user, body }),
    closeIssue: (n, user) => gl.closeIssue("g/sub/p", n, user),
    openPR: (user, title, head, diff) => gl.openMR("g/sub/p", { user, title, head, diff }),
    approve: async (n, user) => {
      await gl.approve("g/sub/p", n, user);
      return `review-${gl.user(user).id}`;
    },
    // the failure as a branch pipeline (the connector finds the MR), the rerun as an MR pipeline
    ci: (sha, s) => gl.pipeline("g/sub/p", sha, s === "failure" ? "failed" : "running", { branch: s === "failure" }),
    merge: (n, user) => gl.mergeMR("g/sub/p", n, user),
    push: (ref, b, a, user) => gl.push("g/sub/p", ref, b, a, user),
    replay: (guid) => gl.deliver(own(gl.deliveries, guid).event, own(gl.deliveries, guid).payload, { guid }),
    forged: (guid) =>
      gl.deliver(own(gl.deliveries, guid).event, own(gl.deliveries, guid).payload, {
        signature: `${gl.webhookSecret}x`,
      }),
    commit: (b, f, c) => gl.commit("g/sub/p", b, f, c),
    sha: (b) => gl.sha("g/sub/p", b),
    since: /[?&]updated_after=/,
    globs: [
      [["g/sub/*"], ["g/sub/p"]],
      [["g/*"], ["g/other", "g/p"]],
      [["g/**"], ["g/other", "g/p", "g/sub/p"]],
    ],
  },
  {
    dof: "bitbucket",
    P: "w/r",
    fake: bb,
    apiHost: "api.bitbucket.org",
    gitHost: "bitbucket.org",
    gitUser: "x-token-auth",
    rest: { authorization: "Bearer hortus-secret-bitbucket" },
    inScope: "/2.0/repositories/w/r/issues",
    outScope: "/2.0/repositories/w/other/issues",
    create: { path: "/2.0/repositories/w/newrepo", body: JSON.stringify({ scm: "git", is_private: true }) },
    admin: { method: "PUT", path: "/2.0/repositories/w/r" },
    closed: "resolved",
    token: () => bb.token,
    openIssue: (user, title, body, drop) => bb.openIssue("w/r", { user, title, body: body ?? "" }, { drop: !!drop }),
    comment: (n, user, body) => bb.comment("w/r", n, { user, body }),
    closeIssue: (n, user) => bb.closeIssue("w/r", n, user),
    openPR: (user, title, head, diff) => bb.openPR("w/r", { user, title, head, diff }),
    approve: async (n, user) => {
      await bb.approve("w/r", n, user);
      return `review-acc-${user}`;
    },
    ci: (sha, s) => bb.status("w/r", sha, s === "failure" ? "FAILED" : "INPROGRESS"),
    merge: (n, user) => bb.mergePR("w/r", n, user),
    push: (ref, b, a, user) => bb.push("w/r", ref, b, a, user),
    replay: (guid) => bb.deliver(own(bb.deliveries, guid).event, own(bb.deliveries, guid).payload, { guid }),
    forged: (guid) =>
      bb.deliver(own(bb.deliveries, guid).event, own(bb.deliveries, guid).payload, {
        signature: `sha256=${"0".repeat(64)}`,
      }),
    commit: (b, f, c) => bb.commit("w/r", b, f, c),
    sha: (b) => bb.sha("w/r", b),
    since: /[?&]q=updated_on/,
    globs: [
      [["w/r"], ["w/r"]],
      [["w/*"], ["w/other", "w/r"]],
      [[], ["w/other", "w/r"]],
    ],
  },
];

// ---- setup -------------------------------------------------------------------------------------------------------

before(async () => {
  await mirrorModule.start(ctx);
  await vaultModule.start(ctx);
  await proxyModule.start(ctx);
  ports = await listen("127.0.0.1", { https: 0, http: 0, dns: 0, proxyAddress: "127.0.0.1" });
  ports5 = await listen("127.0.0.5", { https: 0, http: 0, dns: 0, proxyAddress: "127.0.0.1" });
  db.prepare("INSERT INTO tasks(id, kind, status, scope, origins) VALUES ('W', 'unattended', 'running', ?, ?)").run(
    JSON.stringify(SCOPE),
    JSON.stringify("*"),
  );
  links.register("127.0.0.2", "worker", "W", "session");
  links.register("127.0.0.5", "worker", "W", "session");
  gate.deps.inboxWrite = () => {};
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
  const port = await wh.start(0);
  for (const h of H) h.fake.hook = `http://127.0.0.1:${port}/${h.dof}/webhook`;
  await until(
    () => (db.prepare("SELECT count(*) AS n FROM syncs").get() as { n: number }).n === 7,
    15_000,
    "backfill",
  ).catch((e) => {
    throw new Error(`${e.message}: ${log.errors.join("\n")}`);
  });
});

after(async () => {
  await wh.stop();
  await gw.stop();
  await proxyModule.stop();
  await vaultModule.stop();
  await Promise.all([gh.close(), gl.close(), bb.close()]);
});

// ---- helpers -----------------------------------------------------------------------------------------------------

const fm = (dof: string, p: string) => {
  const f = join(paths.dof(dof), p);
  return existsSync(f) ? parse(readFileSync(f, "utf8")) : undefined;
};
const rows = (dof: string) =>
  (db.prepare("SELECT count(*) AS n FROM events WHERE dof = ?").get(dof) as { n: number }).n;
const row = (dof: string, key: string) =>
  db.prepare("SELECT trusted, member, author, bot FROM events WHERE dof = ? AND key = ?").get(dof, key) as
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
const isApproval = (r: R) => r.status === 403 && r.body.startsWith("{");
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

/** git as the Worker on 127.0.0.5: plain `https://<host>/` URLs, the placeholder added by insteadOf as in sandboxEnv */
function git(h: Harness, cwd: string, ...args: string[]) {
  const cfg: [string, string][] = [
    ["http.sslCAInfo", caCert()],
    ["http.curloptResolve", `${h.gitHost}:${ports5.https}:127.0.0.5`],
    [
      `url.https://${h.gitUser}:hortus-secret-${h.dof}@${h.gitHost}:${ports5.https}/.insteadOf`,
      `https://${h.gitHost}/`,
    ],
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
async function gitUntil(h: Harness, cwd: string, args: string[], stop: () => boolean = () => false) {
  autoApprove = true;
  try {
    for (let i = 0; i < 12; i++) {
      try {
        await git(h, cwd, ...args);
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

// ---- the parameterized suite -------------------------------------------------------------------------------------

for (const h of H) {
  const { dof, P } = h;
  const D = dirOf(P);

  test(`${dof}: webhook valid → 200, one row; bad signature → 401, no row; replay → 200, no new row`, async () => {
    const n0 = rows(dof);
    const first = await h.openIssue("toshi", "Crash on start", "it crashes");
    assert.equal(first.status, 200);
    assert.equal(rows(dof), n0 + 1);
    const bad = await h.forged(first.guid);
    assert.equal(bad.status, 401);
    assert.equal(row(dof, bad.guid), undefined);
    const replay = await h.replay(first.guid);
    assert.equal(replay.status, 200);
    assert.equal(rows(dof), n0 + 1);
  });

  test(`${dof}: a group/workspace hook's delivery for a project outside repos → acknowledged, no event`, async () => {
    const conn = (await connectors[dof]?.({
      name: dof,
      config: { ...dofs[dof], repos: ["nobody/*"] },
      log,
      fetch: coreFetch,
      hasRef: () => false,
    })) as Forge;
    let got: { ok: boolean; event?: unknown } | undefined;
    const srv = createServer((req, res) => {
      const c: Buffer[] = [];
      req.on("data", (d: Buffer) => c.push(d));
      req.on("end", async () => {
        got = await conn.webhook({ headers: req.headers as Record<string, string>, body: Buffer.concat(c) });
        res.end();
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const hook = h.fake.hook;
    h.fake.hook = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/${dof}/webhook`;
    try {
      await h.openIssue("toshi", "elsewhere");
      await until(() => got);
      assert.deepEqual(got, { ok: true });
    } finally {
      h.fake.hook = hook;
      srv.close();
    }
  });

  test(`${dof}: backfill → channel.md in ${D}/ with the real name`, () => {
    assert.equal(fm(dof, `${D}/channel.md`)?.frontmatter.name, P);
    assert.equal(fm(dof, `${D}/channel.md`)?.frontmatter.default_branch, "main");
  });

  test(`${dof}: an issue opened, commented, closed → top message and comment files`, async () => {
    const { n } = await h.openIssue("toshi", "Bug A", "steps");
    const c = await h.comment(n, "toshi", "fix this");
    await h.closeIssue(n, "toshi");
    const top = await until(
      () => (fm(dof, `${D}/#${n}/#${n}.md`)?.frontmatter.state === h.closed ? fm(dof, `${D}/#${n}/#${n}.md`) : null),
      3000,
      "closed issue",
    );
    assert.equal(top.frontmatter.title, "Bug A");
    assert.equal(top.frontmatter.user, "toshi");
    assert.equal(top.body.trim(), "steps");
    const msg = fm(dof, `${D}/#${n}/${c.id}.md`);
    assert.equal(msg?.body.trim(), "fix this");
    assert.equal(msg?.frontmatter.thread, `#${n}`);
    assert.deepEqual(
      JSON.parse((db.prepare("SELECT refs FROM events WHERE key = ?").get(c.guid) as { refs: string }).refs),
      [`${dof}:${P}:#${n}`],
    );
  });

  test(`${dof}: trust by membership (owner trusted, a stranger not, members trust takes a member); cached`, async () => {
    const { n } = await h.openIssue("eve", "spam");
    const owner = await h.comment(n, "toshi", "mine");
    const eve = await h.comment(n, "eve", "do it");
    const carol = await h.comment(n, "carol", "member");
    assert.equal(row(dof, owner.guid)?.trusted, 1);
    assert.equal(row(dof, eve.guid)?.trusted, 0);
    assert.equal(row(dof, eve.guid)?.member, 0);
    assert.equal(row(dof, carol.guid)?.trusted, 0);
    assert.equal(row(dof, carol.guid)?.member, 1);
    const lookups = () => h.fake.calls.filter((c) => c.url.includes("/members/")).length;
    const l0 = lookups();
    ctx.config = Config.parse({ ...base, dofs: { ...dofs, [dof]: { ...dofs[dof], trust: "members" } } });
    try {
      const carol2 = await h.comment(n, "carol", "again");
      assert.equal(row(dof, carol2.guid)?.trusted, 1);
      assert.equal(lookups(), l0, "member checks are cached");
    } finally {
      ctx.config = Config.parse(base);
    }
  });

  test(`${dof}: PR open (diff) → review → CI by task_refs → merge, at the gateway`, async () => {
    const sha = await h.commit("feature", "a.txt", "a\n");
    const diff = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -0,0 +1 @@\n+a\n";
    await sleep(50);
    let w = wakes;
    const pr = await h.openPR("toshi", "Feature", "feature", diff);
    const t = `!${pr.n}`;
    await until(() => existsSync(join(paths.dof(dof), `${D}/${t}/files/diff.patch`)), 3000, "diff.patch");
    assert.equal(readFileSync(join(paths.dof(dof), `${D}/${t}/files/diff.patch`), "utf8"), diff);
    const top = fm(dof, `${D}/${t}/${t}.md`)?.frontmatter ?? {};
    assert.equal(top.state, "open");
    assert.equal(top.head, "feature");
    assert.equal(top.base, "main");
    assert.ok(sha.startsWith(String(top.head_sha)) && String(top.head_sha).length >= 12, String(top.head_sha));
    await until(() => wakes > w, 3000, "open wakes");

    w = wakes;
    const id = await h.approve(pr.n, "carol");
    const rv = await until(() => fm(dof, `${D}/${t}/${id}.md`), 3000, "review");
    assert.equal(rv.frontmatter.review, "approved");
    await until(() => wakes > w, 3000, "review wakes");

    await sleep(100);
    w = wakes;
    await h.ci(sha, "failure");
    await until(() => fm(dof, `${D}/${t}/${t}.md`)?.frontmatter.checks === "failure", 3000, "checks: failure");
    await sleep(100);
    assert.equal(wakes, w, "not in task_refs: no wake");
    db.prepare("INSERT INTO task_refs(ref, task_id) VALUES (?, 'W')").run(`${dof}:${P}:${t}`);
    await h.ci(sha, "pending");
    await until(() => fm(dof, `${D}/${t}/${t}.md`)?.frontmatter.checks === "pending", 3000, "checks: pending");
    await until(() => wakes === w + 1, 3000, "CI wake");

    w = wakes;
    await h.merge(pr.n, "toshi");
    await until(() => fm(dof, `${D}/${t}/${t}.md`)?.frontmatter.state === "merged", 3000, "merged");
    await until(() => wakes > w, 3000, "merge wakes");
  });

  test(`${dof}: push → the repo mirror fetches the commit, no wake`, async () => {
    const b = await h.sha("main");
    const a = await h.commit("main", "b.txt", "b\n");
    await sleep(100);
    const w = wakes;
    assert.equal((await h.push("refs/heads/main", b, a, "toshi")).status, 200);
    const dir = repoDir(dof, P);
    assert.ok(dir.endsWith(`repos/${dof}/${D}.git`));
    await until(
      () =>
        run("git", ["-C", dir, "log", "--format=%H", "main"]).then(
          (x) => x.stdout.includes(a),
          () => false,
        ),
      5000,
      "repo mirror fetch",
    ).catch((e) => {
      throw new Error(`${e.message}: ${log.errors.join("\n")}`);
    });
    await sleep(100);
    assert.equal(wakes, w);
  });

  test(`${dof}: history cursor → a delivery the tunnel dropped is read back since the cursor`, async () => {
    await gw.reconcile(dof, P); // the backfill ran on empty projects: its cursor is ""
    const c0 = (db.prepare("SELECT cursor FROM syncs WHERE dof = ? AND scope = ?").get(dof, P) as { cursor: string })
      .cursor;
    assert.match(c0, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    const lost = await h.openIssue("toshi", "Dropped", "lost", true);
    assert.equal(row(dof, lost.guid), undefined);
    const calls0 = h.fake.calls.length;
    await gw.reconcile(dof, P);
    assert.ok(fm(dof, `${D}/#${lost.n}/#${lost.n}.md`), "read back by history");
    assert.ok(
      h.fake.calls.slice(calls0).some((c) => h.since.test(c.url)),
      "history asked since the cursor",
    );
    const c1 = (db.prepare("SELECT cursor FROM syncs WHERE dof = ? AND scope = ?").get(dof, P) as { cursor: string })
      .cursor;
    assert.ok(c1 >= c0);
  });

  test(`${dof}: projects() filtered by repos`, async () => {
    for (const [globs, want] of h.globs) {
      const conn = (await connectors[dof]?.({
        name: dof,
        config: { ...dofs[dof], ...(globs.length ? { repos: globs } : {}) },
        log,
        fetch: coreFetch,
        hasRef: () => false,
      })) as Forge;
      assert.deepEqual((await conn.projects()).sort(), want, globs.join());
    }
  });

  test(`${dof}: scope: in-scope passes, another project 403, the create endpoint asks (consequential)`, async () => {
    const ok = await approved(() => send({ host: h.apiHost, path: h.inScope, headers: h.rest }));
    assert.equal(ok.status, 200, ok.body);
    const other = await send({ host: h.apiHost, path: h.outScope, headers: h.rest });
    assert.equal(other.status, 403);
    assert.match(other.body, /project scope/);
    // dot segments an upstream (or its edge) resolves: never past the scope, plain or encoded
    const other1 = h.outScope.split("/").slice(-2, -1)[0];
    for (const dots of ["..", "%2e%2e", "%2E."]) {
      const sneak = `${h.inScope.replace(/\/issues$/, "")}/${dots}/${other1}/issues`;
      const r = await send({ host: h.apiHost, path: sneak, headers: h.rest });
      assert.equal(r.status, 403, sneak);
      assert.match(r.body, /dot segment/);
    }
    const create = await send({
      host: h.apiHost,
      path: h.create.path,
      method: "POST",
      headers: { ...h.rest, "content-type": "application/json" },
      body: h.create.body,
    });
    assert.ok(isApproval(create), create.body);
    const id = JSON.parse(create.body).approval as number;
    assert.ok(pending(true).some((p) => p.id === id));
    gate.decide(id, "reject", "owner");
    if (h.admin) {
      const a = await send({
        host: h.apiHost,
        path: h.admin.path,
        method: h.admin.method,
        headers: { ...h.rest, "content-type": "application/json" },
        body: JSON.stringify({ visibility: "public", is_private: false, user_id: 9, access_level: 50 }),
      });
      assert.ok(isApproval(a), a.body);
      const aid = JSON.parse(a.body).approval as number;
      assert.ok(pending(true).some((p) => p.id === aid), "consequential");
      gate.decide(aid, "reject", "owner");
    }
  });

  test(`${dof}: insteadOf clone carries the token to the fake's git server; push asks with old new refname`, async () => {
    const work = mkdtempSync(join(tmpdir(), `hortus-${dof}-work-`));
    await gitUntil(h, work, ["clone", "-q", `https://${h.gitHost}/${P}.git`, "r"]);
    const token = h.token();
    assert.ok(token && h.fake.gitAuths.includes(token), "the fake's git server saw the token");
    const cwd = join(work, "r");
    await git(h, cwd, "checkout", "-q", "-b", "hortus/W");
    await run("sh", ["-c", "echo w > w.txt"], { cwd });
    await git(h, cwd, "add", "w.txt");
    await git(h, cwd, "commit", "-q", "-m", "w");
    const head = await git(h, cwd, "rev-parse", "HEAD");
    const mine = () => pending(true).filter((p) => (JSON.parse(p.summary).rendered ?? "").startsWith(`push ${P}: `));
    assert.equal(await gitUntil(h, cwd, ["push", "-q", "origin", "hortus/W"], () => mine().length > 0), false);
    const p = mine().at(-1);
    assert.ok(p);
    assert.equal(JSON.parse(p.summary).rendered, `push ${P}: 0000000 → ${head.slice(0, 7)} refs/heads/hortus/W`);
    gate.decide(p.id, "approve", "owner");
    assert.equal(await gitUntil(h, cwd, ["push", "-q", "origin", "hortus/W"]), true);
    assert.equal(await h.sha("hortus/W"), head);
  });
}

// ---- forge specifics ---------------------------------------------------------------------------------------------

test("gitlab: g/sub/p is g%2Fsub%2Fp in API paths and g__sub__p on disk, apart from g/p", () => {
  assert.equal(dirOf("g/sub/p"), "g__sub__p");
  assert.ok(gl.calls.some((c) => c.url.startsWith("/api/v4/projects/g%2Fsub%2Fp/issues")));
  assert.ok(!gl.calls.some((c) => c.url.startsWith("/api/v4/projects/g/")));
  assert.equal(fm("gitlab", "g__sub__p/channel.md")?.frontmatter.name, "g/sub/p");
  assert.equal(fm("gitlab", "g__p/channel.md")?.frontmatter.name, "g/p");
  assert.ok(existsSync(join(paths.dof("gitlab"), "g__sub__p/#1/#1.md")), "the nested project's webhook landed there");
  assert.ok(!existsSync(join(paths.dof("gitlab"), "g__p/#1")));
});

test("gitlab: /changes assembled as a unified diff (new, deleted, renamed files)", () => {
  const p = patchOf([
    { old_path: "n", new_path: "n", new_file: true, b_mode: "100755", diff: "@@ -0,0 +1 @@\n+x\n" },
    { old_path: "d", new_path: "d", deleted_file: true, diff: "@@ -1 +0,0 @@\n-y" },
    { old_path: "a", new_path: "b", renamed_file: true, diff: "" },
  ]);
  assert.equal(
    p,
    [
      "diff --git a/n b/n\nnew file mode 100755\n--- /dev/null\n+++ b/n\n@@ -0,0 +1 @@\n+x\n",
      "diff --git a/d b/d\ndeleted file mode 100644\n--- a/d\n+++ /dev/null\n@@ -1 +0,0 @@\n-y\n",
      "diff --git a/a b/b\nrename from a\nrename to b\n",
    ].join(""),
  );
});

test("gitlab host: gitlab.example.com expands hosts and scope patterns; the connector's api follows", async () => {
  ctx.config = Config.parse({ ...base, dofs: { ...dofs, gle: { type: "gitlab", host: "gitlab.example.com" } } });
  try {
    await transforms.load();
    const m = transforms.get("gitlab")?.manifest;
    assert.ok(m);
    assert.deepEqual(m.credentials.gitlab?.hosts.sort(), ["gitlab.com", "gitlab.example.com"]);
    assert.ok(m.scope?.includes("gitlab.example.com/api/v4/projects/{project}/**"));
    assert.ok(m.scope?.includes("gitlab.example.com/{project}.git/**"));
    assert.ok(m.scope?.includes("gitlab.com/api/v4/projects/{project}/**"));
    assert.ok(m.consequential?.includes("POST gitlab.example.com/api/v4/projects"));
    assert.ok(m.consequential?.includes("DELETE gitlab.example.com/api/v4/**"));
    const gle = ctx.config.dofs.gle ?? { type: "gitlab" };
    const conn = (await connectors.gitlab?.({
      name: "gle",
      config: gle,
      log,
      fetch: coreFetch,
      hasRef: () => false,
    })) as Forge;
    const n0 = gl.calls.length;
    assert.deepEqual((await conn.projects()).sort(), ["g/other", "g/p", "g/sub/p"]);
    assert.ok(gl.calls.slice(n0).some((c) => c.url.startsWith("/api/v4/projects?membership=true")));
    assert.equal(conn.clone("g/sub/p"), "https://gitlab.example.com/g/sub/p.git");
    // the self-hosted host is a credentialed destination now: a Worker's scope pattern holds there too
    const out = await send({
      host: "gitlab.example.com",
      path: "/api/v4/projects/g%2Fother/issues",
      headers: { "private-token": "hortus-secret-gle" },
    });
    assert.equal(out.status, 403);
  } finally {
    ctx.config = Config.parse(base);
    await transforms.load();
  }
});

test("the shipped gitlab and bitbucket transforms pass their tests and render pushes, MRs/PRs and DELETEs", () => {
  for (const name of ["gitlab", "bitbucket"]) {
    const r = transforms.runTests(name);
    assert.equal(r.length, 4, name);
    for (const x of r) assert.ok(x.ok, `${name}/${x.file}: ${x.diff}`);
  }
  const cmd = `${"0".repeat(40)} 3f2a1c9${"0".repeat(33)} refs/heads/hortus/t1\0 report-status`;
  const body = `${(cmd.length + 4).toString(16).padStart(4, "0")}${cmd}0000`;
  const t = { headers: {}, stream: true, method: "POST", body };
  assert.equal(
    transforms.render("gitlab", { ...t, url: "https://gitlab.com/g/sub/p.git/git-receive-pack" }),
    "push g/sub/p: 0000000 → 3f2a1c9 refs/heads/hortus/t1",
  );
  assert.equal(
    transforms.render("bitbucket", { ...t, url: "https://bitbucket.org/w/r.git/git-receive-pack" }),
    "push w/r: 0000000 → 3f2a1c9 refs/heads/hortus/t1",
  );
  const mr = JSON.stringify({ title: "Fix", source_branch: "hortus/t1", target_branch: "main" });
  const u = { headers: {}, stream: false };
  assert.equal(
    transforms.render("gitlab", {
      ...u,
      method: "POST",
      url: "https://gitlab.com/api/v4/projects/g%2Fsub%2Fp/merge_requests",
      body: mr,
    }),
    'open MR g/sub/p: "Fix" hortus/t1 → main',
  );
  const pr = JSON.stringify({
    title: "Fix",
    source: { branch: { name: "hortus/t1" } },
    destination: { branch: { name: "main" } },
  });
  assert.equal(
    transforms.render("bitbucket", {
      ...u,
      method: "POST",
      url: "https://api.bitbucket.org/2.0/repositories/w/r/pullrequests",
      body: pr,
    }),
    'open PR w/r: "Fix" hortus/t1 → main',
  );
  assert.equal(
    transforms.render("gitlab", {
      ...u,
      method: "DELETE",
      url: "https://gitlab.com/api/v4/projects/g%2Fp/issues/1",
      body: null,
    }),
    "DELETE /api/v4/projects/g/p/issues/1",
  );
  assert.equal(
    transforms.render("bitbucket", {
      ...u,
      method: "DELETE",
      url: "https://api.bitbucket.org/2.0/repositories/w/r",
      body: null,
    }),
    "DELETE /2.0/repositories/w/r",
  );
});

test("sandboxEnv: insteadOf entries for gitlab (oauth2, its host) and bitbucket (x-token-auth) DOFs", () => {
  const cfg = Config.parse({
    dofs: {
      gitlab: { type: "gitlab" },
      gle: { type: "gitlab", host: "gitlab.example.com" },
      bitbucket: { type: "bitbucket" },
    },
  });
  const env = sandboxEnv({ id: "x", scope: { credentials: [], repos: [] } } as unknown as TaskJson, cfg);
  const pairs = Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => [
    env[`GIT_CONFIG_KEY_${i}`],
    env[`GIT_CONFIG_VALUE_${i}`],
  ]);
  assert.deepEqual(
    pairs.filter(([k]) => k?.endsWith(".insteadOf")),
    [
      ["url.https://oauth2:hortus-secret-gitlab@gitlab.com/.insteadOf", "https://gitlab.com/"],
      ["url.https://oauth2:hortus-secret-gle@gitlab.example.com/.insteadOf", "https://gitlab.example.com/"],
      ["url.https://x-token-auth:hortus-secret-bitbucket@bitbucket.org/.insteadOf", "https://bitbucket.org/"],
    ],
  );
  // HORTUS_NO_NET=1: every forge's git goes to the session alias's listener, as GitHub's does
  const lo = sandboxEnv({ id: "x", scope: { credentials: [], repos: [] } } as unknown as TaskJson, cfg, {
    address: "127.0.0.9",
    https: 4443,
  });
  const vals = Object.entries(lo)
    .filter(([k]) => k.startsWith("GIT_CONFIG_"))
    .map(([, v]) => v);
  assert.ok(vals.includes("url.https://oauth2:hortus-secret-gle@gitlab.example.com:4443/.insteadOf"));
  assert.ok(vals.includes("bitbucket.org:4443:127.0.0.9"));
});
