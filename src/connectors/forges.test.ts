/**
 * The step-6 forge flow, parameterized by forge (18-gitlab-bitbucket.md › Functional tests), against the fake GitHub,
 * GitLab and Bitbucket at once: one gateway, one webhook listener, the real mirror writer, vault and proxy pipeline
 * (HORTUS_NO_NET=1, ephemeral ports). Workers are loopback clients: 127.0.0.2 (REST) and 127.0.0.5 (git, reached
 * through `http.curloptResolve`). GitHub-only behaviour (installation tokens, the delivery log) is in github.test.ts.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type http from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import https from "node:https";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { prompt } from "../agent/prompt.ts";
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
import { type TaskRow, taskJson } from "../runtime/tasks.ts";
import { FakeBitbucket } from "../test/fakes/bitbucket.ts";
import { FakeGitHub } from "../test/fakes/github.ts";
import { FakeGitLab } from "../test/fakes/gitlab.ts";
import { memLog, tempDir, until } from "../test/until.ts";
import type { Forge, TaskJson } from "../types.ts";
import { caCert } from "../vault/ca.ts";
import { gate, transforms, vaultModule } from "../vault/index.ts";
import { write as writeVault } from "../vault/vault.ts";
import { dirOf, gitOf, mergeTarget, rest } from "./forge.ts";
import { patchOf } from "./gitlab.ts";
import { connectors } from "./index.ts";

process.env.HORTUS_HOME = tempDir("hortus-forges-");
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
  "uploads.github.com": gh.url,
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
/** The count once the last test's deliveries have all landed (under load a merge's later hooks trail its first wake). */
async function quiet(): Promise<number> {
  for (let n = -1; ; await sleep(300)) {
    if (n === wakes) return n;
    n = wakes;
  }
}
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
  /** every REST door to a ref, as the service documents it: "the merge button is the approval" (v6) */
  writes: [string, string][];
  /** the other doors to the same calls (GraphQL, numeric ids): no scope pattern, so refused, not asked */
  reachless: string[];
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
  /** a commit on the PR's branch, with the forge's event for it */
  pushPR(n: number, file: string, diff: string): Promise<Sent & { sha: string }>;
  /** a CI result on `sha`, in the shape that names the PR outright (GitLab: an MR pipeline, not a branch one) */
  result(sha: string, s: "failure" | "success"): Promise<unknown>;
  /** the Worker's merge call pinned to `sha` where the forge can; `pinned`: it can */
  mergeCall(n: number, sha: string): { method: string; path: string; body: string };
  pinned: boolean;
  /** the same payload again under a new delivery id (a late redelivery) */
  again(guid: string): Promise<Sent>;
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
    writes: [
      ["PUT", "/repos/o/r/pulls/1/merge"],
      ["PUT", "/repos/o/r/pulls/1/update-branch"],
      ["POST", "/repos/o/r/merges"],
      ["POST", "/repos/o/r/merge-upstream"],
      ["PUT", "/repos/o/r/contents/src/a.ts"],
      ["POST", "/repos/o/r/git/refs"],
      ["PATCH", "/repos/o/r/git/refs/heads/main"],
      // a created repository, and what a ref can be reached or moved by besides
      ["POST", "/repos/o/r/forks"],
      ["POST", "/repos/o/r/generate"],
      ["POST", "/repos/o/r/transfer"],
      ["PATCH", "/repos/o/r"],
      ["POST", "/repos/o/r/branches/feat/x/rename"],
      ["POST", "/repos/o/r/releases"],
      // round 13, from the published OpenAPI: a temporary private fork is a repository; an import fills one
      ["POST", "/repos/o/r/security-advisories/GHSA-1/forks"],
      ["PUT", "/repos/o/r/import"],
      ["PATCH", "/repos/o/r/import"],
      // round 14: anything on GraphQL but a read the transform vouches for (src/proxy/gh.test.ts); publishing a draft
      ["POST", "/graphql"],
      ["PATCH", "/repos/o/r/releases/1"],
    ],
    reachless: ["/repositories/1/pulls/1/merge", "/user/codespaces/c/publish"],
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
    pushPR: (n, file, diff) => gh.pushPR("o/r", n, { user: "hortus[bot]", file, diff }),
    result: (sha, s) => gh.checkSuite("o/r", sha, { conclusion: s }),
    mergeCall: (n, sha) => ({ method: "PUT", path: `/repos/o/r/pulls/${n}/merge`, body: JSON.stringify({ sha }) }),
    pinned: true,
    again: (guid) => gh.deliver(ghPayload(guid).event, ghPayload(guid).request.payload),
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
    writes: [
      ["GET", "/api/v4/projects/g%2Fsub%2Fp/variables/DEPLOY_KEY"],
      ["GET", "/api/v4/projects/g%2Fsub%2Fp/pipelines/1/variables"],
      ["GET", "/api/v4/projects/g%2Fsub%2Fp/secure_files/1/download"],
      ["PUT", "/api/v4/projects/g%2Fsub%2Fp/merge_requests/1/merge"],
      ["PUT", "/api/v4/projects/g%2Fsub%2Fp/merge_requests/1/rebase"],
      ["POST", "/api/v4/projects/g%2Fsub%2Fp/merge_trains/merge_requests/1"],
      ["POST", "/api/v4/projects/g%2Fsub%2Fp/repository/commits"],
      ["POST", "/api/v4/projects/g%2Fsub%2Fp/repository/branches"],
      ["PUT", "/api/v4/projects/g%2Fsub%2Fp/repository/files/src%2Fa.ts"],
      ["POST", "/api/v4/projects/g%2Fsub%2Fp/releases"],
      // Grape's `format :json` routes a `.json` suffix to the same endpoint
      ["PUT", "/api/v4/projects/g%2Fsub%2Fp/merge_requests/1/merge.json"],
      ["PUT", "/api/v4/projects/123/merge_requests/1/merge"],
      // round 13, from the published OpenAPI: an import into a project, deletes that are a POST
      ["POST", "/api/v4/projects/g%2Fsub%2Fp/import/git"],
      ["POST", "/api/v4/projects/g%2Fsub%2Fp/jobs/1/erase"],
      ["POST", "/api/v4/projects/g%2Fsub%2Fp/housekeeping"],
      ["POST", "/api/v4/projects/g%2Fsub%2Fp/ml/mlflow/api/2.0/mlflow/runs/delete"],
      ["POST", "/api/v4/projects/g%2Fsub%2Fp/ml/mlflow/api/2.0/mlflow/experiments/delete"],
    ],
    // the creating routes with no project in them: the scope refuses them, stronger than asking
    reachless: [
      "/api/graphql",
      "/api/v4/projects/123/issues",
      "/api/v4/projects/user/5",
      "/api/v4/projects/import",
      "/api/v4/projects/remote-import",
      "/api/v4/import/github",
      "/api/v4/bulk_imports",
      "/api/v4/groups/1/projects/2",
    ],
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
    pushPR: (n, file, diff) => gl.pushMR("g/sub/p", n, { user: gl.self, file, diff }),
    result: (sha, s) => gl.pipeline("g/sub/p", sha, s === "failure" ? "failed" : "success"),
    mergeCall: (n, sha) => ({
      method: "PUT",
      path: `/api/v4/projects/g%2Fsub%2Fp/merge_requests/${n}/merge`,
      body: JSON.stringify({ sha }),
    }),
    pinned: true,
    again: (guid) => gl.deliver(own(gl.deliveries, guid).event, own(gl.deliveries, guid).payload),
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
    writes: [
      ["POST", "/2.0/repositories/w/r/pullrequests/1/merge"],
      ["POST", "/2.0/repositories/w/r/src"],
      ["POST", "/2.0/repositories/w/r/refs/branches"],
      ["POST", "/2.0/repositories/w/r/refs/tags"],
      ["POST", "/2.0/repositories/w/r/pullrequests/1/merge;x=1"],
      ["POST", "/2.0/repositories/w/r/pullrequests/1\\merge"],
      ["POST", "/2.0/repositories/w/r/pullrequests/1/m%2565rge"],
      ["PUT", "/2.0/repositories/w/new"],
      ["POST", "/2.0/repositories/w/r/forks"],
    ],
    reachless: ["/2.0/workspaces/w/projects", "/2.0/repositories/%7Bw%7D/%7Br%7D/issues"],
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
    pushPR: (n, file, diff) => bb.pushPR("w/r", n, { user: bb.self, file, diff }),
    result: (sha, s) => bb.status("w/r", sha, s === "failure" ? "FAILED" : "SUCCESSFUL"),
    mergeCall: (n) => ({ method: "POST", path: `/2.0/repositories/w/r/pullrequests/${n}/merge`, body: "{}" }),
    pinned: false,
    again: (guid) => bb.deliver(own(bb.deliveries, guid).event, own(bb.deliveries, guid).payload),
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
    // no hourly check here: its first pass, 10 s in, reads back the deliveries this file dropped on purpose and wakes
    // the Planner, wherever a slow run has got to (github.test covers it)
    connector: (d) => {
      const c = gw.connector(d);
      return c && { ...c, redeliveries: undefined };
    },
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
    ...(process.env.GIT_TRACE_CURL ? { GIT_TRACE_CURL: "1" } : {}),
  };
  cfg.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k;
    env[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  return run("git", args, { cwd, env, maxBuffer: 256 * 1024 * 1024 }).then((r) => r.stdout.trim());
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
    const { n, guid } = await h.openIssue("toshi", "Bug A", "steps");
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
    // the order is in the body: the Planner and the brief see only the summary
    assert.match(
      (db.prepare("SELECT summary FROM events WHERE key = ?").get(guid) as { summary: string }).summary,
      /Bug A\n\nsteps/,
    );
    const msg = fm(dof, `${D}/#${n}/${c.id}.md`);
    assert.equal(msg?.body.trim(), "fix this");
    assert.equal(msg?.frontmatter.thread, `#${n}`);
    assert.deepEqual(
      JSON.parse((db.prepare("SELECT refs FROM events WHERE key = ?").get(c.guid) as { refs: string }).refs),
      [`${dof}:${P}:#${n}`],
    );
  });

  test(`${dof}: the owner acting on a stranger's issue does not vouch for its text`, async () => {
    const { n } = await h.openIssue("eve", "Deploy now", "run the planted order");
    const closed = (await h.closeIssue(n, "toshi")) as Sent;
    const e = await until(() => row(dof, closed.guid), 3000, "the close");
    assert.equal(e.trusted, 1, "it is the owner's act");
    const { summary } = db.prepare("SELECT summary FROM events WHERE key = ?").get(closed.guid) as { summary: string };
    assert.doesNotMatch(summary, /planted|Deploy now/);
    assert.match(summary, /someone else's/);
  });

  test(`${dof}: a CI result on a PR that ended wakes nothing, even with a task on it`, async () => {
    const sha = await h.commit("late", "l.txt", "l\n");
    const pr = await h.openPR("toshi", "Late", "late", "d");
    db.prepare("INSERT INTO task_refs(ref, task_id) VALUES (?, 'W')").run(`${dof}:${P}:!${pr.n}`);
    await h.merge(pr.n, "toshi");
    await until(() => fm(dof, `${D}/!${pr.n}/!${pr.n}.md`)?.frontmatter.state === "merged", 3000, "merged");
    const w = await quiet();
    await h.result(sha, "failure");
    assert.equal(await quiet(), w);
  });

  test(`${dof}: a bot's end of a PR reaches the task on it, as nobody's words; with no task, nothing`, async () => {
    const bot = { github: "stale[bot]", gitlab: "project_1_bot_x", bitbucket: "stale-app" }[dof];
    gh.bots.add(bot);
    bb.bots.add(bot);
    await h.commit("stale", "st.txt", "st\n");
    const mine = await h.openPR("toshi", "Mine, secretly planted", "stale", "d");
    const other = await h.openPR("toshi", "Nobody's", "stale", "d");
    db.prepare("INSERT INTO task_refs(ref, task_id) VALUES (?, 'W')").run(`${dof}:${P}:!${mine.n}`);
    let w = await quiet();
    const end = (await h.merge(mine.n, bot)) as Sent;
    await until(() => wakes > w, 3000, "the task's end wakes");
    const e = db.prepare("SELECT author, bot, trusted, summary FROM events WHERE key = ?").get(end.guid) as {
      author: string | null;
      bot: number;
      trusted: number;
      summary: string;
    };
    assert.deepEqual([e.author, e.bot, e.trusted], [null, 0, 0]);
    assert.doesNotMatch(e.summary, /planted/);
    assert.match(e.summary, /someone else's/);
    w = await quiet();
    await h.merge(other.n, bot);
    await until(() => fm(dof, `${D}/!${other.n}/!${other.n}.md`)?.frontmatter.state === "merged", 3000, "merged");
    assert.equal(await quiet(), w, "no task on it: no wake");
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
    // a member closing a stranger's issue does not vouch for the stranger's text
    const closed = (await h.closeIssue(n, "carol")) as Sent;
    assert.equal(row(dof, closed.guid)?.member, 0);
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

    w = await quiet();
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

  test(`${dof}: a second push moves the PR; a result for the old commit moves nothing; the merge lands what was approved`, async () => {
    const diff = (f: string) => `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@ -0,0 +1 @@\n+${f}\n`;
    const A = await h.commit("second", "s1.txt", "1\n");
    const pr = await h.openPR("toshi", "Second", "second", diff("s1.txt"));
    const t = `!${pr.n}`;
    const top = () => fm(dof, `${D}/${t}/${t}.md`)?.frontmatter ?? {};
    const patch = join(paths.dof(dof), `${D}/${t}/files/diff.patch`);
    const onHead = (sha: string) => sha.startsWith(String(top().head_sha)) && !!top().head_sha;
    await until(() => onHead(A) && existsSync(patch), 3000, "the PR");
    db.prepare("INSERT INTO task_refs(ref, task_id) VALUES (?, 'W')").run(`${dof}:${P}:${t}`);
    await h.ci(A, "pending");
    await until(() => top().checks === "pending", 3000, "checks: pending");
    /** the newest event of this forge, once the gateway has decided about it */
    const settled = (like: string) =>
      until(
        () => {
          const q = db.prepare("SELECT summary, consumed FROM events WHERE dof = ? ORDER BY id DESC LIMIT 1");
          const e = q.get(dof) as { summary: string; consumed: number };
          return e.summary.includes(like) && e.consumed !== -2 ? e : undefined;
        },
        3000,
        like,
      );

    // the push: head_sha, diff.patch; A's pending is not the new head's
    const B = await h.pushPR(pr.n, "s2.txt", diff("s2.txt"));
    await until(() => onHead(B.sha), 3000, "head_sha moved");
    assert.equal(readFileSync(patch, "utf8"), diff("s2.txt"));
    assert.ok(!top().checks, `no CI on the new head yet: ${top().checks}`);

    // a failure for the superseded commit: no checks, no wake, whichever way the forge attaches it
    let w = await quiet();
    await h.result(A, "failure");
    assert.equal((await settled(` on ${A.slice(0, 7)}`)).consumed, -1, "not Planner input");
    await sleep(50);
    assert.equal(wakes, w);
    assert.ok(!top().checks, `an old failure on the PR: ${top().checks}`);

    // a result on the head: checks, wake, and the text says what and where
    await h.result(B.sha, "failure");
    await until(() => top().checks === "failure", 3000, "checks: failure");
    await until(() => wakes === w + 1, 3000, "the head's result wakes");
    assert.match((await settled(` on ${B.sha.slice(0, 7)}`)).summary, /(failure|failed|FAILED) on [0-9a-f]{7}$/);

    // the old commit's late success does not clear it
    w = wakes;
    await h.result(A, "success");
    await settled(` on ${A.slice(0, 7)}`);
    await sleep(50);
    assert.equal(top().checks, "failure");
    assert.equal(wakes, w);

    // a late delivery of the second push does not move the head back
    const C = await h.pushPR(pr.n, "s3.txt", diff("s3.txt"));
    await until(() => onHead(C.sha), 3000, "head_sha moved again");
    await h.again(B.guid);
    await settled(dof === "bitbucket" ? "pullrequest:updated" : "someone else's");
    await sleep(50);
    assert.ok(onHead(C.sha), `head_sha went back to ${top().head_sha}`);
    assert.equal(readFileSync(patch, "utf8"), diff("s3.txt"));

    // the merge: consequential whatever the policy; the head it was approved at, or nothing
    const call = h.mergeCall(pr.n, C.sha);
    const headers = { ...h.rest, "content-type": "application/json" };
    const merge = () => send({ host: h.apiHost, ...call, headers });
    const asked = await merge();
    assert.ok(isApproval(asked), asked.body);
    const entry = pending(true).at(-1);
    assert.ok(entry);
    const rendered = String(JSON.parse(entry.summary).rendered);
    assert.ok(rendered.includes(h.pinned ? C.sha.slice(0, 7) : "cannot pin"), rendered);
    gate.decide(entry.id, "approve", "owner");
    const D2 = await h.pushPR(pr.n, "s4.txt", diff("s4.txt"));
    await until(() => onHead(D2.sha), 3000, "a push after the approval");
    const landed = await merge();
    if (!h.pinned) {
      // the recorded ceiling (v7 › Review round 10 — flows): the owner was told
      assert.equal(landed.status, 200);
      return;
    }
    assert.equal(landed.status, 409, landed.body);
    await sleep(50);
    assert.equal(top().state, "open");
    const fresh = h.mergeCall(pr.n, D2.sha);
    const again = await send({ host: h.apiHost, ...fresh, headers });
    assert.ok(isApproval(again), "a new head is a new approval");
    const next = pending(true).at(-1);
    assert.ok(next);
    gate.decide(next.id, "approve", "owner");
    const ok = await send({ host: h.apiHost, ...fresh, headers });
    assert.equal(ok.status, 200, ok.body);
  });

  test(`${dof}: a Worker following the prompt literally clones through the proxy`, async () => {
    const row = { id: "W", kind: "unattended", title: "t", brief: "b", scope: JSON.stringify(SCOPE) } as TaskRow;
    const cfg = Config.parse({ ...base, worker: { provider: "fake", model: "m" } });
    const text = prompt(taskJson(cfg, row));
    const m = text.match(new RegExp(`^- ${dof}:${P}: (\\S+) \\(read cache (\\S+)\\)$`, "m"));
    assert.ok(m, text);
    assert.equal(m[1], `https://${h.gitHost}/${P}.git`);
    assert.equal(m[2], repoDir(dof, P));
    assert.match(text, /git clone --reference-if-able <read cache> <url> /);
    assert.match(text, /git push origin HEAD:hortus\/W/);
    assert.match(text, /The requested URL returned error: 403/);
    assert.match(text, /Never merge/);
    const work = tempDir(`hortus-${dof}-prompt-`);
    await gitUntil(h, work, ["clone", "-q", "--reference-if-able", m[2] ?? "", m[1] ?? "", "r"]);
    assert.ok(existsSync(join(work, "r", ".git")));
    assert.ok(existsSync(join(work, "r", "README.md")));
    // a task with a project works in its clone of the local origin: no forge section
    const project = { ...row, scope: JSON.stringify({ ...SCOPE, project: "p" }) } as TaskRow;
    assert.doesNotMatch(prompt(taskJson(cfg, project)), /# Forge repositories/);
  });

  test(`${dof}: push → the repo mirror fetches the commit, no wake`, async () => {
    const b = await h.sha("main");
    const a = await h.commit("main", "b.txt", "b\n");
    const w = await quiet();
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
    for (const dots of ["..", "%2e%2e", "%2E.", "..;x", "%252e%252e"]) {
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
    for (const [method, path] of h.writes) {
      const r = await send({ host: h.apiHost, path, method, headers: h.rest, ...(method === "GET" ? {} : { body: "{}" }) });
      assert.ok(isApproval(r), `${method} ${path}: ${r.body}`);
      const wid = JSON.parse(r.body).approval as number;
      assert.ok(
        pending(true).some((p) => p.id === wid),
        `${method} ${path} is consequential`,
      );
      gate.decide(wid, "reject", "owner");
    }
    for (const path of h.reachless) {
      const r = await send({ host: h.apiHost, path, method: "POST", headers: h.rest, body: "{}" });
      assert.equal(r.status, 403, path);
      assert.match(r.body, /project scope/, path);
    }
    // a method the router takes from the request, not the request line: Rack::MethodOverride, in GitLab's stack
    const inScope = h.inScope;
    const form = { ...h.rest, "content-type": "application/x-www-form-urlencoded" };
    for (const s of [
      { path: inScope, headers: { ...h.rest, "x-http-method-override": "PUT" } },
      { path: inScope, headers: form, body: "a=1&_method=PUT" },
      { path: inScope, headers: form, body: "%5Fm%65thod=PUT" },
      { path: inScope, headers: h.rest, body: "_method=PUT" },
      { path: inScope, headers: form, body: "a=1; _method=PUT" },
      {
        path: inScope,
        headers: { ...h.rest, "content-type": "multipart/form-data; boundary=b" },
        body: '--b\r\nContent-Disposition: form-data; name="_method"\r\n\r\nPUT\r\n--b--\r\n',
      },
      {
        // a decoy boundary hid the second part
        path: inScope,
        headers: { ...h.rest, "content-type": 'multipart/form-data; x="boundary=z"; boundary=b' },
        body: '--b\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n--b\r\nContent-Disposition: form-data; name="_method"\r\n\r\nPUT\r\n--b--\r\n',
      },
      { path: `${inScope}?_method=PUT`, headers: h.rest },
      { path: `${inScope}?a=1&%5Fmethod=PUT`, headers: h.rest },
    ]) {
      const r = await send({ host: h.apiHost, method: "POST", body: "", ...s });
      assert.equal(r.status, 403, JSON.stringify(s));
      assert.match(r.body, /override its method/);
    }
    // git's content types pass unhashed on git's paths only: elsewhere the body would be outside the owner's view
    const xgit = await send({
      host: h.apiHost,
      path: inScope,
      method: "POST",
      headers: { ...h.rest, "content-type": "application/x-git-upload-pack-request" },
      body: "any text at all",
    });
    assert.ok(isApproval(xgit), xgit.body);
    const xid = JSON.parse(xgit.body).approval as number;
    assert.ok(
      pending(true).some((p) => p.id === xid),
      "a body nobody sees is consequential",
    );
    gate.decide(xid, "reject", "owner");
    // receive-pack's type shows only the commands, so off git's path the rest would go unseen; on it a bare flush passes
    // (git's probe) only as all there is: anything after it is a body
    for (const [path, body] of [
      [inScope, `0000{"title":"unseen"}`],
      [inScope, "0000"],
      [`/${P}.git/git-receive-pack`, "0000 and more"],
    ] as const) {
      const r = await send({
        host: path === inScope ? h.apiHost : h.gitHost,
        path,
        method: "POST",
        headers: { ...h.rest, "content-type": "application/x-git-receive-pack-request" },
        body,
      });
      assert.ok(isApproval(r), r.body);
      const id = JSON.parse(r.body).approval as number;
      assert.ok(
        pending(true).some((p) => p.id === id),
        `${path}: ${body} is consequential`,
      );
      gate.decide(id, "reject", "owner");
    }
    // a push whose commands the owner could not be shown
    const hidden = await send({
      host: h.gitHost,
      path: `/${P}.git/git-receive-pack`,
      method: "POST",
      headers: { ...h.rest, "content-type": "application/x-git-receive-pack-request", "content-encoding": "gzip" },
      body: "\x1f\x8b not pkt-lines",
    });
    assert.equal(hidden.status, 403, hidden.body);
    assert.match(hidden.body, /ref commands/);
    // `gh release upload` of a text file: the manifest names this host, so the scope must too
    if (dof === "github") {
      const up = await send({
        host: "uploads.github.com",
        path: "/repos/o/r/releases/1/assets?name=notes.txt",
        method: "POST",
        headers: { ...h.rest, "content-type": "text/plain" },
        body: "notes",
      });
      assert.ok(isApproval(up), up.body);
      gate.decide(JSON.parse(up.body).approval, "reject", "owner");
    }
    // the word as someone's text, in every body and query it can ride in, is only that: it asks like any other POST
    const text = 'use _method=PUT or X-HTTP-Method-Override; name="_method"';
    const words: { path?: string; headers: Record<string, string>; body?: string }[] = [
      { headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "name=_method&_method=PUT" }) },
      { headers: { "content-type": "application/json" }, body: JSON.stringify({ body: text }) },
      { headers: { "content-type": "application/x-www-form-urlencoded" }, body: `body=${encodeURIComponent(text)}` },
      { headers: { "content-type": "application/x-www-form-urlencoded" }, body: "body=a%3B_method%3DPUT" },
      { headers: { "content-type": "text/plain" }, body: "_method=PUT is how Rails spells it" },
      {
        headers: { "content-type": "multipart/form-data; boundary=b" },
        body: `--b\r\nContent-Disposition: form-data; name="body"\r\n\r\nname="_method"\r\nContent-Disposition: form-data; name="_method"\r\n--b--\r\n`,
      },
      { path: `${inScope}?search=${encodeURIComponent(text)}`, headers: {} },
      { path: `${inScope}?search=a%3B_method%3DPUT`, headers: {} },
      { path: `${inScope}?search=a%3B_method=PUT`, headers: {} },
    ];
    for (const s of words) {
      const said = await send({
        host: h.apiHost,
        path: inScope,
        method: "POST",
        body: "",
        ...s,
        headers: { ...h.rest, ...s.headers },
      });
      assert.ok(isApproval(said), `${JSON.stringify(s)}: ${said.body}`);
      gate.decide(JSON.parse(said.body).approval, "reject", "owner");
    }
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
      assert.ok(
        pending(true).some((p) => p.id === aid),
        "consequential",
      );
      gate.decide(aid, "reject", "owner");
    }
  });

  test(`${dof}: insteadOf clone carries the token to the fake's git server; push asks with old new refname`, async () => {
    const work = tempDir(`hortus-${dof}-work-`);
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

  test(`${dof}: real git through the proxy: one approval per push whatever its size, refs or chunking`, async () => {
    const work = tempDir(`hortus-${dof}-big-`);
    await gitUntil(h, work, ["clone", "-q", `https://${h.gitHost}/${P}.git`, "r"]);
    const cwd = join(work, "r");
    /** The Worker's git and the owner's approvals, as many as it takes; the consequential ones as they were shown. */
    const until = async (dir: string, ...args: string[]) => {
      const shown: string[] = [];
      for (let i = 0; i < 12; i++) {
        const failure = await git(h, dir, ...args).then(
          () => undefined,
          (e: Error) => e.message,
        );
        if (failure === undefined) return shown;
        const reads = pending(false);
        const asked = pending(true);
        assert.ok(reads.length + asked.length, `git ${args.join(" ")} failed with nothing to approve: ${failure}`);
        for (const p of reads) gate.decide(p.id, "approve", "owner");
        for (const p of asked) {
          shown.push(String(JSON.parse(p.summary).rendered));
          gate.decide(p.id, "approve", "owner");
        }
      }
      throw new Error(`git ${args.join(" ")} never went through: ${shown.join(" | ")}`);
    };
    await git(h, cwd, "checkout", "-q", "-b", "hortus/big");
    // 5 MB of incompressible data: over http.postBuffer, so git probes with `0000` and then sends it chunked
    writeFileSync(join(cwd, "big.bin"), randomBytes(5 * 1024 * 1024));
    await git(h, cwd, "add", "big.bin");
    await git(h, cwd, "commit", "-q", "-m", "big");
    const big = await until(cwd, "push", "-q", "origin", "hortus/big");
    assert.equal(big.length, 1, big.join(" | "));
    assert.match(big[0] ?? "", /refs\/heads\/hortus\/big/);
    assert.equal(await h.sha("hortus/big"), await git(h, cwd, "rev-parse", "HEAD"));
    // a small http.postBuffer forces the same path on a small push
    await run("sh", ["-c", "echo small > small.txt"], { cwd });
    await git(h, cwd, "add", "small.txt");
    await git(h, cwd, "commit", "-q", "-m", "small");
    assert.equal((await until(cwd, "-c", "http.postBuffer=1024", "push", "-q", "origin", "hortus/big")).length, 1);
    // 1,200 tags are 90 KB of ref commands: one approval for the lot
    const head = await git(h, cwd, "rev-parse", "HEAD");
    const tags = Array.from({ length: 1200 }, (_, i) => `create refs/tags/r13-${String(i).padStart(4, "0")} ${head}`);
    writeFileSync(join(work, "tags"), `${tags.join("\n")}\n`);
    await run("sh", ["-c", `git update-ref --stdin < ${join(work, "tags")}`], { cwd });
    assert.equal((await until(cwd, "push", "-q", "origin", "--tags")).length, 1);
    // reads: a shallow fetch, ls-remote, a mirror clone of all of it, none of them consequential
    const url = `https://${h.gitHost}/${P}.git`;
    assert.deepEqual(await until(work, "clone", "-q", "--depth", "1", "--branch", "hortus/big", url, "s"), []);
    assert.deepEqual(await until(join(work, "s"), "fetch", "-q", "--deepen", "1"), []);
    assert.deepEqual(await until(work, "ls-remote", url), []);
    assert.deepEqual(await until(work, "clone", "-q", "--mirror", url, "m.git"), []);
    // --mirror sends every difference: one tag gone, one added
    const m = join(work, "m.git");
    await git(h, m, "tag", "-d", "r13-0000");
    await git(h, m, "tag", "r13-new", await git(h, m, "rev-parse", "refs/heads/hortus/big"));
    const mirrored = await until(m, "push", "-q", "--mirror");
    assert.equal(mirrored.length, 1, mirrored.join(" | "));
    // past the cap the push is refused, and the prompt's trace line is how the Worker tells that from a wait
    const long = "x".repeat(200);
    const many = Array.from({ length: 6000 }, (_, i) => `create refs/tags/${long}-${i} ${head}`);
    writeFileSync(join(work, "many"), `${many.join("\n")}\n`);
    await run("sh", ["-c", `git update-ref --stdin < ${join(work, "many")}`], { cwd });
    process.env.GIT_TRACE_CURL = "1";
    let trace = "";
    for (let i = 0; i < 6 && !trace.includes("hortus: a push"); i++) {
      trace = await git(h, cwd, "push", "-q", "origin", "--tags").then(
        () => "",
        (e: Error) => e.message,
      );
      for (const p of pending(false)) gate.decide(p.id, "approve", "owner"); // the info/refs read before it
    }
    delete process.env.GIT_TRACE_CURL;
    assert.match(trace, /hortus: a push whose ref commands cannot be read/);
    assert.equal(pending(true).length, 0, "a refusal leaves nothing to approve");
  });
}

// ---- forge specifics ---------------------------------------------------------------------------------------------

test("gitlab: a project called g/services is one project: a POST to it is no write to the services of a project g", async () => {
  const set = (repos: string[]) =>
    db.prepare("UPDATE tasks SET scope = ? WHERE id = 'W'").run(JSON.stringify({ ...SCOPE, repos }));
  set([...SCOPE.repos, "gitlab:g/services"]);
  try {
    const ask = (path: string) =>
      send({
        host: "gitlab.com",
        path,
        method: "POST",
        headers: { "private-token": "hortus-secret-gitlab", "content-type": "application/json" },
        body: "{}",
      });
    const r = await ask("/api/v4/projects/g%2Fservices/issues");
    assert.ok(isApproval(r), r.body);
    const id = JSON.parse(r.body).approval as number;
    assert.ok(
      pending(false).some((p) => p.id === id),
      "an issue on it is an ordinary POST",
    );
    gate.decide(id, "reject", "owner");
    // and its own hooks, or the same words on a project outside the scope, still are what they say
    for (const path of ["/api/v4/projects/g%2Fservices/hooks", "/api/v4/projects/g%2Fhooks/issues"]) {
      const c = await ask(path);
      assert.ok(isApproval(c), c.body);
      const cid = JSON.parse(c.body).approval as number;
      assert.ok(
        pending(true).some((p) => p.id === cid),
        `${path} is consequential`,
      );
      gate.decide(cid, "reject", "owner");
    }
  } finally {
    set(SCOPE.repos);
  }
});

test("names that hold a dot, `;`, %2f or end in .json are in scope and ordinary; git-lfs's batch is too", async () => {
  const gh_ = { authorization: "Bearer hortus-secret-github" };
  const gl_ = { "private-token": "hortus-secret-gitlab" };
  const bb_ = { authorization: "Bearer hortus-secret-bitbucket" };
  const basic = (u: string, d: string) => ({
    authorization: `Basic ${Buffer.from(`${u}:hortus-secret-${d}`).toString("base64")}`,
    "content-type": "application/vnd.git-lfs+json",
  });
  const repos = [...SCOPE.repos, "gitlab:g/my.proj"];
  db.prepare("UPDATE tasks SET scope = ? WHERE id = 'W'").run(JSON.stringify({ ...SCOPE, repos }));
  try {
    for (const [method, host, path, headers] of [
      ["GET", "api.github.com", "/repos/o/r/contents/package.json", gh_],
      ["GET", "api.github.com", "/repos/o/r/contents/.github/workflows/a;b.yml?ref=feat/x", gh_],
      ["GET", "api.github.com", "/repos/o/r/branches/feat%2Fx.y", gh_],
      ["GET", "gitlab.com", "/api/v4/projects/g%2Fmy.proj/issues", gl_],
      ["GET", "gitlab.com", "/api/v4/projects/g%2Fmy.proj/repository/files/.gitlab-ci.yml/raw?ref=main", gl_],
      ["GET", "gitlab.com", "/api/v4/projects/g%2Fsub%2Fp/repository/files/src%2Fa.json", gl_],
      ["GET", "gitlab.com", "/g/my.proj.git/info/refs?service=git-upload-pack", gl_],
      ["GET", "api.bitbucket.org", "/2.0/repositories/w/r/src/main/package.json", bb_],
      ["POST", "github.com", "/o/r.git/info/lfs/objects/batch", basic("x-access-token", "github")],
      ["POST", "gitlab.com", "/g/sub/p.git/info/lfs/objects/batch", basic("oauth2", "gitlab")],
      ["POST", "bitbucket.org", "/w/r.git/info/lfs/objects/batch", basic("x-token-auth", "bitbucket")],
    ] as const) {
      const r = await send({ host, path, method, headers, ...(method === "POST" ? { body: "{}" } : {}) });
      assert.ok(isApproval(r), `${path}: ${r.status} ${r.body}`);
      const id = JSON.parse(r.body).approval as number;
      assert.ok(
        pending(false).some((p) => p.id === id),
        `${path} is an ordinary request`,
      );
      gate.decide(id, "reject", "owner");
    }
  } finally {
    db.prepare("UPDATE tasks SET scope = ? WHERE id = 'W'").run(JSON.stringify(SCOPE));
  }
});

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

test("gitlab: one user's approval and its removal; a distinct key per event, whatever the event UUID says", async () => {
  const { n } = await gl.openMR("g/p", { user: "toshi", title: "Rules", head: "main", diff: "" });
  const file = `g__p/!${n}/review-${gl.user("carol").id}.md`;
  const review = () => fm("gitlab", file)?.frontmatter.review;
  await gl.approve("g/p", n, "carol");
  await until(() => review() === "approved", 3000, "approval");
  await gl.unapprove("g/p", n, "carol");
  await until(() => review() === undefined, 3000, "unapproval");
  await gl.approve("g/p", n, "carol", undefined, "approved");
  await until(() => review() === "approved", 3000, "approved");
  await gl.unapprove("g/p", n, "carol", undefined, "unapproved");
  await until(() => review() === undefined, 3000, "unapproved");

  const a = await gl.mrComment("g/p", n, { user: "toshi", body: "one" }, { eventUuid: "chain" });
  const b = await gl.mrComment("g/p", n, { user: "toshi", body: "two" }, { eventUuid: "chain" });
  assert.ok(row("gitlab", a.guid) && row("gitlab", b.guid), "a recursive chain shares the event UUID, not the key");
});

test("bitbucket: a status finds its PR from the published `links.commit.href` and from `commit.hash`", async () => {
  const { n, sha } = await bb.openPR("w/r", { user: "toshi", title: "CI shapes", head: "main", diff: "" });
  const checks = () => fm("bitbucket", `w__r/!${n}/!${n}.md`)?.frontmatter.checks;
  await bb.status("w/r", sha, "FAILED", { drop: true });
  const commit_status = { key: "ci", state: "FAILED", commit: { hash: sha }, updated_on: new Date().toISOString() };
  await bb.deliver("repo:commit_status_updated", { repository: { full_name: "w/r" }, commit_status });
  await until(() => checks() === "failure", 3000, "commit.hash");
  await bb.status("w/r", sha, "SUCCESSFUL");
  await until(() => checks() === "success", 3000, "links.commit.href");
});

test("bitbucket: history survives the removed issue tracker", async () => {
  const conn = (await connectors.bitbucket?.({
    name: "bitbucket",
    config: dofs.bitbucket,
    log,
    fetch: coreFetch,
    hasRef: () => false,
  })) as Forge;
  bb.issuesGone = true;
  try {
    for await (const b of conn.history?.("w/r", "2026-01-01T00:00:00Z") ?? []) assert.ok(b.changes.length);
  } finally {
    bb.issuesGone = false;
  }
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
    // protected branches change by PATCH; invitations and remote mirrors hand the project to someone else
    for (const c of [
      "PATCH {h}/api/v4/projects/*/**",
      "POST {h}/api/v4/projects/*/invitations**",
      "POST {h}/api/v4/projects/*/remote_mirrors**",
    ])
      assert.ok(m.consequential?.includes(c.replace("{h}", "gitlab.example.com")), c);
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
    assert.ok(r.length >= 4, name);
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

test("gitlab: a merged-results pipeline (its own merge commit) is the head's: checks and a wake", async () => {
  const sha = await gl.commit("g/sub/p", "results", "m.txt", "m\n");
  const pr = await gl.openMR("g/sub/p", { user: "toshi", title: "Results", head: "results", diff: "" });
  const top = () => fm("gitlab", `g__sub__p/!${pr.n}/!${pr.n}.md`)?.frontmatter ?? {};
  await until(() => top().head_sha === sha, 3000, "the MR");
  db.prepare("INSERT INTO task_refs(ref, task_id) VALUES (?, 'W')").run(`gitlab:g/sub/p:!${pr.n}`);
  const w = await quiet();
  await gl.pipeline("g/sub/p", sha, "failed", { result: "f".repeat(40) });
  await until(() => top().checks === "failure", 3000, "checks: failure");
  await until(() => wakes === w + 1, 3000, "the wake");
});

test("the image's insteadOf entries are gitOf's, for every forge", async () => {
  const sh = readFileSync(new URL("../../scripts/build-image.sh", import.meta.url), "utf8");
  const js = sh.match(/node -e '([\s\S]*?)' "\$home\/hortusd\.json" >>"\$root\/etc\/gitconfig"/)?.[1];
  assert.ok(js);
  const d = {
    github: { type: "github" },
    ghe: { type: "github", host: "ghe.example.com" },
    gle: { type: "gitlab", host: "gitlab.example.com" },
    gitlab: { type: "gitlab" },
    bitbucket: { type: "bitbucket", host: "ignored" },
    slack: { type: "slack" },
  };
  const file = join(tempDir("hortus-image-"), "hortusd.json");
  writeFileSync(file, JSON.stringify({ dofs: d }));
  const { stdout } = await run(process.execPath, ["-e", js, file]);
  const want = Object.entries(d).flatMap(([n, c]) => {
    const g = gitOf(c);
    return g ? [`[url "https://${g.user}:hortus-secret-${n}@${g.host}/"]`, `\tinsteadOf = https://${g.host}/`] : [];
  });
  assert.deepEqual(stdout.trim().split("\n"), want);
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

test("mergeTarget: a merge by each forge's REST path; nothing else names one", () => {
  assert.equal(mergeTarget("/repos/o/r/pulls/12/merge"), "o/r:!12");
  assert.equal(mergeTarget("/api/v3/repos/o/r/pulls/12/merge?x=1"), "o/r:!12");
  assert.equal(mergeTarget("/api/v4/projects/g%2fsub%2Fr/merge_requests/3/merge"), "g/sub/r:!3");
  assert.equal(mergeTarget("/2.0/repositories/w/r/pullrequests/3/merge"), "w/r:!3");
  for (const p of [
    "/repos/o/r/issues/12/comments",
    "/repos/o/r/pulls/12",
    "/api/v4/projects/g%2Fr/merge_requests/3/notes",
    "/api/v4/projects/g%2Fr/merge_requests/3/merge_ref",
    "/graphql",
    "/o/r.git/git-receive-pack",
  ])
    assert.equal(mergeTarget(p), undefined, p);
});

test("a text whose writer is not known to be the actor stays out: a null user, a delivery with no sender", async () => {
  const sum = (guid: string) =>
    until(
      () => db.prepare("SELECT summary FROM events WHERE key = ?").get(guid) as { summary: string } | undefined,
      3000,
      guid,
    );
  const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
  // GitHub: `user` is nullable in the schema (a deleted account), `sender` is the owner
  const g = await gh.openIssue("o/r", { user: "eve", title: "planted", body: "planted" });
  const gp = copy(ghPayload(g.guid).request.payload) as { issue: { user: unknown }; sender?: unknown };
  gp.issue.user = null;
  gp.sender = { login: "toshi", type: "User" };
  assert.doesNotMatch((await sum((await gh.deliver("issues", gp)).guid)).summary, /planted/);
  delete gp.sender;
  assert.doesNotMatch((await sum((await gh.deliver("issues", gp)).guid)).summary, /planted/);
  // GitLab: no `user`, so no author: such an event taints nothing, so it must hold nobody's words
  const l = await gl.openIssue("g/sub/p", { user: "eve", title: "planted", body: "planted" });
  const lp = copy(own(gl.deliveries, l.guid).payload);
  delete lp.user;
  assert.doesNotMatch((await sum((await gl.deliver("issue", lp)).guid)).summary, /planted/);
  // Bitbucket: an anonymous reporter is null; the owner's update carried the anonymous text as their own
  const b = await bb.openIssue("w/r", { user: "eve", title: "planted", body: "planted" });
  const bp = copy(own(bb.deliveries, b.guid).payload) as { issue: { reporter: unknown }; actor?: unknown };
  bp.issue.reporter = null;
  bp.actor = bb.user("toshi");
  assert.doesNotMatch((await sum((await bb.deliver("issue:updated", bp)).guid)).summary, /planted/);
  delete bp.actor;
  assert.doesNotMatch((await sum((await bb.deliver("issue:updated", bp)).guid)).summary, /planted/);
});

test("github: a PR's two ends read apart; the owner's merge says merged", async () => {
  await gh.commit("o/r", "ends", "e.txt", "e\n");
  const a = await gh.openPR("o/r", { user: "toshi", title: "A", head: "ends", diff: "d" });
  const b = await gh.openPR("o/r", { user: "toshi", title: "B", head: "ends", diff: "d" });
  const sum = (guid: string) =>
    until(
      () => db.prepare("SELECT summary FROM events WHERE key = ?").get(guid) as { summary: string } | undefined,
      3000,
      guid,
    );
  assert.match(
    (await sum((await gh.closeThread("o/r", a.n, "toshi", { merged: true })).guid)).summary,
    /^pull_request\.merged /,
  );
  assert.match((await sum((await gh.closeThread("o/r", b.n, "toshi")).guid)).summary, /^pull_request\.closed /);
});

test("a forge's failed GET carries the body: Sources shows why, not only the status", async () => {
  const fetch = async () => new Response("hortus: installation token: minting failed: HTTP 401\n", { status: 502 });
  await assert.rejects(
    rest({ name: "gl", fetch }, "http://x", {}).get("/y"),
    /gl GET \/y: HTTP 502 hortus: installation token/,
  );
});
