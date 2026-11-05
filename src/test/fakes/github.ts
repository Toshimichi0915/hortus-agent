/**
 * Fake GitHub (17-github.md › Fake GitHub): the REST subset the connector and Workers use (installation tokens minted
 * only for a JWT that verifies against the App's public key, repos, issues, comments, PRs with their diff, reviews,
 * check suites, the delivery log), HMAC-signed webhook deliveries to `hook`, and git over HTTP (`git http-backend`
 * over bare repos, Basic auth = a minted token). One port; the `/api/v3` prefix (Enterprise) is accepted everywhere.
 */
import { execFile, spawn } from "node:child_process";
import { createHmac, generateKeyPairSync, randomBytes, randomUUID, verify } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { tempDir } from "../until.ts";

const run = promisify(execFile);
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

interface Thing {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: { name: string }[];
  assignees: { login: string }[];
  user: { login: string; type: string };
  author_association: string;
  created_at: string;
  updated_at: string;
  pr?: {
    head: { ref: string; sha: string };
    base: { ref: string };
    merged: boolean;
    diff: string;
    /** every head it has had */
    shas: string[];
  };
}
interface FakeComment {
  id: number;
  n: number;
  body: string;
  user: { login: string; type: string };
  author_association: string;
  created_at: string;
  updated_at: string;
  path?: string;
  line?: number;
}
interface FakeReview {
  id: number;
  n: number;
  state: string;
  body: string;
  user: { login: string; type: string };
  author_association: string;
  submitted_at: string;
}
interface FakeSuite {
  id: number;
  head_sha: string;
  status: string;
  conclusion: string | null;
  latest_check_runs_count: number;
}
interface FakeRepo {
  full_name: string;
  description: string;
  things: Map<number, Thing>;
  comments: FakeComment[];
  reviews: FakeReview[];
  reviewComments: FakeComment[];
  suites: FakeSuite[];
  next: number;
}
export interface Delivery {
  id: number;
  guid: string;
  delivered_at: string;
  event: string;
  action: string | null;
  status_code: number;
  request: { headers: Record<string, string>; payload: Record<string, unknown> };
}
export interface DeliverOpts {
  /** recorded in the log, never posted (a delivery lost by the tunnel) */
  drop?: boolean;
  /** replay an earlier delivery's guid */
  guid?: string;
  signature?: string;
}
interface Token {
  token: string;
  repositories?: string[];
  permissions: Record<string, string>;
}

export class FakeGitHub {
  appId = 1;
  installationId = 2;
  webhookSecret = "whsec-fake";
  owner = "o";
  privateKey: string;
  publicKey: string;
  /** where `deliver` posts (the listener's `/<dof>/webhook`) */
  hook?: string;
  repos = new Map<string, FakeRepo>();
  /** associations by login (default NONE) */
  associations = new Map<string, string>();
  bots = new Set<string>(["hortus[bot]"]);
  tokens = new Map<string, Token>();
  /** every installation token minted, in order */
  mints: Token[] = [];
  /** newest first, as GitHub lists them */
  deliveries: Delivery[] = [];
  /** the token of every authenticated git request, in order */
  gitAuths: string[] = [];
  /** every REST request: method, path (without /api/v3), the URL as sent, token */
  calls: { method: string; path: string; url: string; token?: string }[] = [];
  /** every GraphQL document as it arrived, with its variables */
  graphqls: { query: string; variables: Record<string, unknown> }[] = [];
  /** release assets by release id: name → bytes received */
  assets = new Map<number, Map<string, number>>();
  root = tempDir("hortus-fake-github-");
  private ids = 100;
  private tick = 0;

  private constructor(
    private server: Server,
    public url: string,
  ) {
    const k = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    this.privateKey = k.privateKey;
    this.publicKey = k.publicKey;
  }

  static async start(): Promise<FakeGitHub> {
    let self: FakeGitHub | undefined;
    const server = createServer((req, res) => {
      self?.handle(req, res).catch((e) => {
        if (!res.headersSent) res.writeHead(500).end(String(e));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    self = new FakeGitHub(server, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    return self;
  }

  /** vault.json entries for DOF `name` */
  vault(name = "github") {
    return {
      [name]: {
        type: "github-app" as const,
        appId: this.appId,
        installationId: this.installationId,
        privateKey: this.privateKey,
        transform: "github",
      },
      [`${name}-webhook`]: { type: "webhook-secret" as const, value: this.webhookSecret, transform: "github" },
    };
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((r) => this.server.close(r));
    rmSync(this.root, { recursive: true, force: true }); // its repos: else every run left one in /tmp
  }

  // ---- state and events ----------------------------------------------------------------------------------------

  private ts(): string {
    return new Date(Date.now() + this.tick++ * 1000).toISOString().replace(/\.\d+Z$/, "Z");
  }
  private who(login: string) {
    return { login, type: this.bots.has(login) ? "Bot" : "User" };
  }
  private assoc(login: string): string {
    return this.associations.get(login) ?? "NONE";
  }
  private get(full: string): FakeRepo {
    const r = this.repos.get(full);
    if (!r) throw new Error(`fake: no repo ${full}`);
    return r;
  }
  private git(full: string, ...args: string[]) {
    return run("git", ["--git-dir", join(this.root, `${full}.git`), ...args], { env: gitEnv }).then((r) =>
      r.stdout.trim(),
    );
  }

  /** A repo with a bare git repo whose `main` has one commit. */
  async repo(full: string, description = ""): Promise<string> {
    this.repos.set(full, {
      full_name: full,
      description,
      things: new Map(),
      comments: [],
      reviews: [],
      reviewComments: [],
      suites: [],
      next: 1,
    });
    mkdirSync(join(this.root, `${full}.git`), { recursive: true });
    await this.git(full, "init", "-q", "--bare", "-b", "main");
    return this.commit(full, "main", "README.md", `# ${full}\n`);
  }

  /** A commit with one file on `branch` (created from main when missing); returns its sha. */
  async commit(full: string, branch: string, file: string, content: string): Promise<string> {
    const blob = await run("sh", ["-c", `printf %s "$C" | git --git-dir "$D" hash-object -w --stdin`], {
      env: { ...gitEnv, C: content, D: join(this.root, `${full}.git`) },
    }).then((r) => r.stdout.trim());
    const tree = await run("sh", ["-c", `printf '100644 blob %s\\t%s\\n' "$B" "$F" | git --git-dir "$D" mktree`], {
      env: { ...gitEnv, B: blob, F: file, D: join(this.root, `${full}.git`) },
    }).then((r) => r.stdout.trim());
    const parent = await this.sha(full, branch).catch(() => this.sha(full, "main").catch(() => ""));
    const env = {
      GIT_AUTHOR_NAME: "fake",
      GIT_AUTHOR_EMAIL: "f@x",
      GIT_COMMITTER_NAME: "fake",
      GIT_COMMITTER_EMAIL: "f@x",
    };
    const sha = await run(
      "git",
      ["--git-dir", join(this.root, `${full}.git`), "commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", file],
      { env: { ...gitEnv, ...env } },
    ).then((r) => r.stdout.trim());
    await this.git(full, "update-ref", `refs/heads/${branch}`, sha);
    return sha;
  }

  reviewsOf(full: string): FakeReview[] {
    return this.get(full).reviews;
  }
  reviewCommentsOf(full: string): FakeComment[] {
    return this.get(full).reviewComments;
  }

  sha(full: string, branch: string): Promise<string> {
    return this.git(full, "rev-parse", "--verify", `refs/heads/${branch}`);
  }

  private repoJson(r: FakeRepo) {
    return {
      id: r.full_name.length,
      full_name: r.full_name,
      name: r.full_name.split("/")[1],
      default_branch: "main",
      description: r.description,
      private: true,
      html_url: `https://github.com/${r.full_name}`,
    };
  }
  private issueJson(r: FakeRepo, t: Thing) {
    const { pr, ...rest } = t;
    const kind = pr ? "pull" : "issues";
    return {
      ...rest,
      html_url: `https://github.com/${r.full_name}/${kind}/${t.number}`,
      ...(pr ? { pull_request: { url: `/repos/${r.full_name}/pulls/${t.number}` } } : {}),
    };
  }
  private pullJson(r: FakeRepo, t: Thing) {
    const { pr, ...rest } = t;
    const html_url = `https://github.com/${r.full_name}/pull/${t.number}`;
    return { ...rest, ...pr, diff: undefined, shas: undefined, html_url };
  }
  private commentJson(r: FakeRepo, c: FakeComment, review = false) {
    const t = r.things.get(c.n);
    const { n: _, ...rest } = c;
    return {
      ...rest,
      html_url: `https://github.com/${r.full_name}/${t?.pr ? "pull" : "issues"}/${c.n}#${review ? "discussion_r" : "issuecomment-"}${c.id}`,
      issue_url: `https://api.github.com/repos/${r.full_name}/issues/${c.n}`,
    };
  }

  private base(r: FakeRepo, sender: string) {
    return { repository: this.repoJson(r), sender: this.who(sender) };
  }

  openIssue(full: string, o: { user: string; title: string; body?: string }, d?: DeliverOpts) {
    const r = this.get(full);
    const now = this.ts();
    const t: Thing = {
      number: r.next++,
      title: o.title,
      body: o.body ?? "",
      state: "open",
      labels: [],
      assignees: [],
      user: this.who(o.user),
      author_association: this.assoc(o.user),
      created_at: now,
      updated_at: now,
    };
    r.things.set(t.number, t);
    return this.deliver("issues", { action: "opened", issue: this.issueJson(r, t), ...this.base(r, o.user) }, d).then(
      (x) => ({ ...x, n: t.number }),
    );
  }

  comment(full: string, n: number, o: { user: string; body: string }, d?: DeliverOpts) {
    const r = this.get(full);
    const t = r.things.get(n);
    if (!t) throw new Error(`fake: no #${n}`);
    const now = this.ts();
    const c: FakeComment = {
      id: this.ids++,
      n,
      body: o.body,
      user: this.who(o.user),
      author_association: this.assoc(o.user),
      created_at: now,
      updated_at: now,
    };
    r.comments.push(c);
    t.updated_at = now;
    const payload = { action: "created", issue: this.issueJson(r, t), comment: this.commentJson(r, c) };
    return this.deliver("issue_comment", { ...payload, ...this.base(r, o.user) }, d).then((x) => ({ ...x, id: c.id }));
  }

  label(full: string, n: number, name: string, by: string, d?: DeliverOpts) {
    const r = this.get(full);
    const t = r.things.get(n);
    if (!t) throw new Error(`fake: no #${n}`);
    t.labels.push({ name });
    t.updated_at = this.ts();
    const ev = t.pr ? "pull_request" : "issues";
    const obj = t.pr ? { pull_request: this.pullJson(r, t), number: n } : { issue: this.issueJson(r, t) };
    return this.deliver(ev, { action: "labeled", label: { name }, ...obj, ...this.base(r, by) }, d);
  }

  closeThread(full: string, n: number, by: string, o: { merged?: boolean } = {}, d?: DeliverOpts) {
    const r = this.get(full);
    const t = r.things.get(n);
    if (!t) throw new Error(`fake: no #${n}`);
    t.state = "closed";
    t.updated_at = this.ts();
    if (t.pr) {
      t.pr.merged = !!o.merged;
      return this.deliver(
        "pull_request",
        { action: "closed", number: n, pull_request: this.pullJson(r, t), ...this.base(r, by) },
        d,
      );
    }
    return this.deliver("issues", { action: "closed", issue: this.issueJson(r, t), ...this.base(r, by) }, d);
  }

  async openPR(
    full: string,
    o: { user: string; title: string; head: string; base?: string; body?: string; diff?: string },
    d?: DeliverOpts,
  ) {
    const r = this.get(full);
    const sha = await this.sha(full, o.head).catch(() => "0".repeat(40));
    const now = this.ts();
    const t: Thing = {
      number: r.next++,
      title: o.title,
      body: o.body ?? "",
      state: "open",
      labels: [],
      assignees: [],
      user: this.who(o.user),
      author_association: this.assoc(o.user),
      created_at: now,
      updated_at: now,
      pr: {
        head: { ref: o.head, sha },
        base: { ref: o.base ?? "main" },
        merged: false,
        diff: o.diff ?? "",
        shas: [sha],
      },
    };
    r.things.set(t.number, t);
    const payload = { action: "opened", number: t.number, pull_request: this.pullJson(r, t) };
    const x = await this.deliver("pull_request", { ...payload, ...this.base(r, o.user) }, d);
    return { ...x, n: t.number, sha };
  }

  /** A commit on the PR's branch: the head moves, `synchronize` fires with `before` and `after`. */
  async pushPR(full: string, n: number, o: { user: string; file: string; diff: string }, d?: DeliverOpts) {
    const r = this.get(full);
    const t = r.things.get(n);
    if (!t?.pr) throw new Error(`fake: no PR !${n}`);
    const before = t.pr.head.sha;
    const sha = await this.commit(full, t.pr.head.ref, o.file, `${o.file}\n`);
    Object.assign(t.pr, { head: { ...t.pr.head, sha }, diff: o.diff });
    t.pr.shas.push(sha);
    t.updated_at = this.ts();
    const payload = { action: "synchronize", number: n, before, after: sha, pull_request: this.pullJson(r, t) };
    const x = await this.deliver("pull_request", { ...payload, ...this.base(r, o.user) }, d);
    return { ...x, sha };
  }

  review(
    full: string,
    n: number,
    o: { user: string; state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED"; body?: string },
    d?: DeliverOpts,
  ) {
    const r = this.get(full);
    const t = r.things.get(n);
    if (!t?.pr) throw new Error(`fake: no PR !${n}`);
    const rv: FakeReview = {
      id: this.ids++,
      n,
      state: o.state,
      body: o.body ?? "",
      user: this.who(o.user),
      author_association: this.assoc(o.user),
      submitted_at: this.ts(),
    };
    r.reviews.push(rv);
    const { n: _, ...review } = rv;
    const payload = { action: "submitted", review, pull_request: this.pullJson(r, t) };
    return this.deliver("pull_request_review", { ...payload, ...this.base(r, o.user) }, d);
  }

  reviewComment(
    full: string,
    n: number,
    o: { user: string; body: string; path: string; line: number },
    d?: DeliverOpts,
  ) {
    const r = this.get(full);
    const t = r.things.get(n);
    if (!t?.pr) throw new Error(`fake: no PR !${n}`);
    const now = this.ts();
    const c: FakeComment = {
      id: this.ids++,
      n,
      body: o.body,
      path: o.path,
      line: o.line,
      user: this.who(o.user),
      author_association: this.assoc(o.user),
      created_at: now,
      updated_at: now,
    };
    r.reviewComments.push(c);
    const payload = { action: "created", comment: this.commentJson(r, c, true), pull_request: this.pullJson(r, t) };
    return this.deliver("pull_request_review_comment", { ...payload, ...this.base(r, o.user) }, d);
  }

  /** A completed (or running) suite on `sha`; its `pull_requests` are the open PRs that had `sha` as a head (the
   * payload's list is the suite's, so a suite finishing after a push still names the PR). */
  checkSuite(
    full: string,
    sha: string,
    o: { status?: string; conclusion: string | null; runs?: number },
    d?: DeliverOpts,
  ) {
    const r = this.get(full);
    const s: FakeSuite = {
      id: this.ids++,
      head_sha: sha,
      status: o.status ?? "completed",
      conclusion: o.conclusion,
      latest_check_runs_count: o.runs ?? 1,
    };
    r.suites.push(s);
    const prs = [...r.things.values()].filter((t) => t.pr && t.state === "open" && t.pr.shas.includes(sha));
    const check_suite = { ...s, pull_requests: prs.map((t) => ({ number: t.number })) };
    return this.deliver("check_suite", { action: "completed", check_suite, ...this.base(r, "github-actions[bot]") }, d);
  }

  push(full: string, ref: string, before: string, after: string, by: string, d?: DeliverOpts) {
    const r = this.get(full);
    return this.deliver("push", { ref, before, after, commits: [], ...this.base(r, by) }, d);
  }

  /** Sign and post one delivery to `hook`, recording it in the delivery log first. */
  async deliver(event: string, payload: Record<string, unknown>, o: DeliverOpts = {}) {
    const guid = o.guid ?? randomUUID();
    const body = JSON.stringify(payload);
    const headers = {
      "content-type": "application/json",
      "user-agent": "GitHub-Hookshot/fake",
      "x-github-event": event,
      "x-github-delivery": guid,
      "x-hub-signature-256":
        o.signature ?? `sha256=${createHmac("sha256", this.webhookSecret).update(body).digest("hex")}`,
    };
    const d: Delivery = {
      id: this.ids++,
      guid,
      delivered_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      event,
      action: (payload.action as string | undefined) ?? null,
      status_code: 0,
      request: { headers, payload },
    };
    this.deliveries.unshift(d);
    if (o.drop || !this.hook) return { status: 0, guid };
    const res = await fetch(this.hook, { method: "POST", headers, body });
    await res.text();
    d.status_code = res.status;
    return { status: res.status, guid };
  }

  // ---- HTTP ----------------------------------------------------------------------------------------------------

  private jwtOk(auth: string | undefined): boolean {
    const m = auth?.match(/^Bearer ([\w-]+)\.([\w-]+)\.([\w-]+)$/);
    if (!m) return false;
    const [, h = "", p = "", s = ""] = m;
    if (!verify("RSA-SHA256", Buffer.from(`${h}.${p}`), this.publicKey, Buffer.from(s, "base64url"))) return false;
    const claims = JSON.parse(Buffer.from(p, "base64url").toString()) as { iss: string; exp: number };
    return claims.iss === String(this.appId) && claims.exp > Date.now() / 1000;
  }

  private tokenOf(req: IncomingMessage): Token | undefined {
    const a = req.headers.authorization ?? "";
    const bearer = a.match(/^(?:Bearer|token) (\S+)$/i)?.[1];
    const basic = a.match(/^Basic (\S+)$/i)?.[1];
    const t = bearer ?? (basic ? Buffer.from(basic, "base64").toString().split(":").slice(1).join(":") : undefined);
    return t ? this.tokens.get(t) : undefined;
  }

  private visible(tok: Token, full: string): boolean {
    return !tok.repositories || tok.repositories.includes(full.split("/")[1] ?? "");
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const u = new URL(req.url ?? "/", "http://x");
    const path = u.pathname.replace(/^\/api\/v3(?=\/)/, "");
    const chunks: Buffer[] = [];
    const git = path.match(/^\/([^/]+\/[^/]+)\.git(\/.*)$/);
    if (git) return this.gitHttp(req, res, git[1] ?? "", git[2] ?? "", u.search.slice(1));
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString();
    const upload = path.match(/^\/repos\/[^/]+\/[^/]+\/releases\/(\d+)\/assets$/);
    const body = raw && !upload ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const json = (status: number, v: unknown, extra: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...extra });
      res.end(JSON.stringify(v));
    };
    const M = req.method ?? "GET";

    // App (JWT) endpoints
    const mint = path.match(/^\/app\/installations\/(\d+)\/access_tokens$/);
    if (mint || path.startsWith("/app/")) {
      this.calls.push({ method: M, path, url: req.url ?? "" });
      if (!this.jwtOk(req.headers.authorization))
        return json(401, { message: "A JSON web token could not be decoded" });
      if (mint && M === "POST") {
        if (Number(mint[1]) !== this.installationId) return json(404, { message: "Not Found" });
        const t: Token = {
          token: `ghs_${randomBytes(12).toString("hex")}`,
          permissions: (body.permissions as Record<string, string>) ?? {},
          ...(Array.isArray(body.repositories) ? { repositories: body.repositories as string[] } : {}),
        };
        this.tokens.set(t.token, t);
        this.mints.push(t);
        return json(201, {
          token: t.token,
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
          permissions: t.permissions,
        });
      }
      if (path === "/app/hook/deliveries" && M === "GET")
        return json(
          200,
          this.deliveries.map(({ request: _, ...d }) => d),
        );
      const one = path.match(/^\/app\/hook\/deliveries\/(\d+)$/);
      const d = one && this.deliveries.find((x) => x.id === Number(one[1]));
      if (d) return json(200, d);
      return json(404, { message: "Not Found" });
    }

    const tok = this.tokenOf(req);
    this.calls.push({ method: M, path, url: req.url ?? "", ...(tok ? { token: tok.token } : {}) });
    if (!tok) return json(401, { message: "Bad credentials" });
    const echo = { "x-echo-token": tok.token };
    const ok = (v: unknown, status = 200) => json(status, v, echo);
    const since = u.searchParams.get("since") ?? "";

    if (path === "/installation/repositories")
      return ok({
        total_count: this.repos.size,
        repositories: [...this.repos.values()]
          .filter((r) => this.visible(tok, r.full_name))
          .map((r) => this.repoJson(r)),
      });
    if (path === "/user/repos" && M === "POST") {
      if (tok.permissions.administration !== "write")
        return json(403, { message: "Resource not accessible by integration" });
      const full = `${this.owner}/${body.name}`;
      await this.repo(full);
      return ok(this.repoJson(this.get(full)), 201);
    }
    if (path === "/graphql" && M === "POST") return ok(this.graphql(tok, body));
    const m = path.match(/^\/repos\/([^/]+\/[^/]+)(\/.*)?$/);
    const r = m && this.repos.get(m[1] ?? "");
    if (!m || !r || !this.visible(tok, r.full_name)) return json(404, { message: "Not Found" });
    const rest = m[2] ?? "";
    const things = [...r.things.values()];
    const at = (re: RegExp) => rest.match(re);
    let x: RegExpMatchArray | null;
    if (rest === "") return ok(this.repoJson(r));
    if (rest === "/issues" && M === "GET")
      return ok(things.filter((t) => t.updated_at >= since).map((t) => this.issueJson(r, t)));
    if (rest === "/issues" && M === "POST") {
      const now = this.ts();
      const t: Thing = {
        number: r.next++,
        title: String(body.title ?? ""),
        body: String(body.body ?? ""),
        state: "open",
        labels: [],
        assignees: [],
        user: this.who("hortus[bot]"),
        author_association: "NONE",
        created_at: now,
        updated_at: now,
      };
      r.things.set(t.number, t);
      return ok(this.issueJson(r, t), 201);
    }
    if (rest === "/issues/comments" && M === "GET")
      return ok(r.comments.filter((c) => c.updated_at >= since).map((c) => this.commentJson(r, c)));
    x = at(/^\/issues\/(\d+)\/comments$/);
    if (x && M === "POST") {
      const now = this.ts();
      const c: FakeComment = {
        id: this.ids++,
        n: Number(x[1]),
        body: String(body.body ?? ""),
        user: this.who("hortus[bot]"),
        author_association: "NONE",
        created_at: now,
        updated_at: now,
      };
      r.comments.push(c);
      return ok(this.commentJson(r, c), 201);
    }
    if (rest === "/pulls" && M === "GET")
      return ok(
        things
          .filter((t) => t.pr && (u.searchParams.get("state") !== "open" || t.state === "open"))
          .map((t) => this.pullJson(r, t)),
      );
    if (rest === "/pulls" && M === "POST") {
      const pr = await this.openPR(
        r.full_name,
        {
          user: "hortus[bot]",
          title: String(body.title),
          head: String(body.head),
          base: String(body.base ?? "main"),
          body: String(body.body ?? ""),
        },
        { drop: true },
      );
      return ok(this.pullJson(r, r.things.get(pr.n) as Thing), 201);
    }
    x = at(/^\/pulls\/(\d+)$/);
    if (x) {
      const t = r.things.get(Number(x[1]));
      if (!t?.pr) return json(404, { message: "Not Found" });
      if (req.headers.accept === "application/vnd.github.diff") {
        res.writeHead(200, { "content-type": "text/x-diff; charset=utf-8", ...echo });
        return void res.end(t.pr.diff);
      }
      return ok(this.pullJson(r, t));
    }
    x = at(/^\/pulls\/(\d+)\/merge$/);
    if (x && M === "PUT") {
      const t = r.things.get(Number(x[1]));
      if (!t?.pr) return json(404, { message: "Not Found" });
      if (body.sha && body.sha !== t.pr.head.sha)
        return json(409, { message: "Head branch was modified. Review and try the merge again." });
      await this.closeThread(r.full_name, t.number, "hortus[bot]", { merged: true }, { drop: true });
      return ok({ merged: true, sha: t.pr.head.sha });
    }
    x = at(/^\/pulls\/(\d+)\/reviews$/);
    if (x) {
      const n = Number(x[1]);
      return ok(r.reviews.filter((v) => v.n === n).map(({ n: _, ...v }) => v));
    }
    x = at(/^\/pulls\/(\d+)\/comments$/);
    if (x) {
      const n = Number(x[1]);
      return ok(r.reviewComments.filter((c) => c.n === n).map((c) => this.commentJson(r, c, true)));
    }
    // releases: what `gh release upload` walks (by tag, then the upload host)
    x = at(/^\/releases\/tags\/(.+)$/);
    if (x)
      return ok({
        id: 1,
        tag_name: x[1],
        upload_url: `https://uploads.github.com/repos/${r.full_name}/releases/1/assets{?name,label}`,
        assets: [],
      });
    x = at(/^\/releases\/(\d+)\/assets$/);
    if (x && M === "POST") {
      const id = Number(x[1]);
      const a = this.assets.get(id) ?? new Map<string, number>();
      a.set(
        u.searchParams.get("name") ?? "",
        chunks.reduce((n, c) => n + c.length, 0),
      );
      this.assets.set(id, a);
      return ok({ id: this.ids++, name: u.searchParams.get("name") }, 201);
    }
    x = at(/^\/commits\/([0-9a-f]+)\/check-suites$/);
    if (x) {
      const suites = r.suites.filter((s) => s.head_sha === x?.[1]);
      return ok({ total_count: suites.length, check_suites: suites });
    }
    return json(404, { message: "Not Found" });
  }

  /** The GraphQL `gh` sends, by the fields it names: no parser, a canned object per document. A repository outside the
   * token's list reads as null, as on GitHub. */
  private graphql(tok: Token, body: Record<string, unknown>) {
    const query = String(body.query ?? "");
    const v = (body.variables ?? {}) as Record<string, unknown>;
    this.graphqls.push({ query, variables: v });
    const input = (v.input ?? {}) as Record<string, unknown>;
    const full = `${v.owner}/${v.name ?? v.repo}`;
    const r = this.repos.get(full);
    const thing = r?.things.get(Number(v.pr_number ?? v.number));
    const repoNode = {
      id: `R_${full}`,
      databaseId: 1,
      name: full.split("/")[1],
      owner: { login: full.split("/")[0] },
      sshUrl: `git@github.com:${full}.git`,
      url: `https://github.com/${full}`,
      hasIssuesEnabled: true,
      hasWikiEnabled: false,
      viewerPermission: "WRITE",
      description: r?.description ?? "",
      defaultBranchRef: { name: "main" },
      parent: null,
      mergeCommitAllowed: true,
      rebaseMergeAllowed: true,
      squashMergeAllowed: true,
      isFork: false,
      visibility: "PRIVATE",
    };
    const prNode = (repo: FakeRepo, t: Thing) => ({
      id: `PR_${repo.full_name}#${t.number}`,
      number: t.number,
      title: t.title,
      body: t.body,
      state: t.pr?.merged ? "MERGED" : t.state.toUpperCase(),
      url: `https://github.com/${repo.full_name}/pull/${t.number}`,
      headRefName: t.pr?.head.ref,
      headRefOid: t.pr?.head.sha,
      baseRefName: t.pr?.base.ref,
      isDraft: false,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      author: { login: t.user.login },
      headRepository: { id: `R_${repo.full_name}`, name: repo.full_name.split("/")[1] },
      headRepositoryOwner: { login: repo.full_name.split("/")[0] },
      isCrossRepository: false,
      additions: 1,
      deletions: 0,
      changedFiles: 1,
      comments: { nodes: [], totalCount: 0 },
      reviews: { nodes: [], totalCount: 0 },
      assignees: { nodes: [], totalCount: 0 },
      labels: { nodes: [], totalCount: 0 },
      projectCards: { nodes: [], totalCount: 0 },
      projectItems: { nodes: [], totalCount: 0 },
      reviewRequests: { nodes: [], totalCount: 0 },
      statusCheckRollup: { nodes: [] },
      latestReviews: { nodes: [] },
      commits: { nodes: [], totalCount: 0 },
      milestone: null,
    });
    const issueNode = (repo: FakeRepo, t: Thing) => ({
      ...prNode(repo, t),
      id: `I_${repo.full_name}#${t.number}`,
      __typename: t.pr ? "PullRequest" : "Issue",
      url: `https://github.com/${repo.full_name}/issues/${t.number}`,
    });
    const nodeOf = (id: unknown) => {
      const [, name, n] = String(id).match(/^[A-Z]+_(.+)#(\d+)$/) ?? [];
      const repo = this.repos.get(name ?? "");
      return { repo, t: repo?.things.get(Number(n)) };
    };
    if (/\bmutation\b/.test(query)) {
      if (query.includes("mergePullRequest")) {
        const { t } = nodeOf(input.pullRequestId);
        if (t?.pr) {
          t.state = "closed";
          t.pr.merged = true;
        }
        return { data: { mergePullRequest: { clientMutationId: "" } } };
      }
      if (query.includes("deleteRepository")) return { data: { deleteRepository: { clientMutationId: "" } } };
      if (query.includes("addComment")) {
        const { repo, t } = nodeOf(input.subjectId);
        if (repo && t) {
          const now = this.ts();
          const c = { id: this.ids++, n: t.number, body: String(input.body), user: this.who("hortus[bot]") };
          repo.comments.push({ ...c, author_association: "NONE", created_at: now, updated_at: now });
          const url = `https://github.com/${repo.full_name}/issues/${t.number}#issuecomment-${c.id}`;
          return { data: { addComment: { commentEdge: { node: { url } } } } };
        }
      }
      if (query.includes("createPullRequest")) {
        const repo = [...this.repos.values()].find((x) => `R_${x.full_name}` === input.repositoryId);
        if (repo) {
          const now = this.ts();
          const t: Thing = {
            number: repo.next++,
            title: String(input.title),
            body: String(input.body ?? ""),
            state: "open",
            labels: [],
            assignees: [],
            user: this.who("hortus[bot]"),
            author_association: "NONE",
            created_at: now,
            updated_at: now,
            pr: {
              head: { ref: String(input.headRefName), sha: "0".repeat(40) },
              base: { ref: String(input.baseRefName) },
              merged: false,
              diff: "",
              shas: [],
            },
          };
          repo.things.set(t.number, t);
          return { data: { createPullRequest: { pullRequest: prNode(repo, t) } } };
        }
      }
      return { errors: [{ message: "fake: unknown mutation" }] };
    }
    if (query.includes("__type("))
      return {
        data: query.includes("WorkflowRun")
          ? { WorkflowRun: { fields: [] } }
          : {
              PullRequest: { fields: [{ name: "isInMergeQueue" }, { name: "isMergeQueueEnabled" }] },
              StatusCheckRollupContextConnection: { fields: [] },
            },
      };
    if (/\bviewer\s*\{/.test(query)) return { data: { viewer: { login: "hortus[bot]" } } };
    if (!r || !this.visible(tok, r.full_name))
      return { data: { repository: null }, errors: [{ type: "NOT_FOUND", message: `no repository ${full}` }] };
    if (query.includes("query PullRequestProjectItems"))
      return { data: { repository: { pullRequest: { projectItems: { totalCount: 0, nodes: [], pageInfo: {} } } } } };
    if (query.includes("pullRequest(number") && !thing?.pr)
      return { data: { repository: { pullRequest: null } }, errors: [{ type: "NOT_FOUND", message: "no PR" }] };
    if (query.includes("pullRequest(number"))
      return { data: { repository: { ...repoNode, pullRequest: prNode(r, thing as Thing) } } };
    if (query.includes("issueOrPullRequest") || query.includes("issue(number"))
      return {
        data: {
          repository: {
            ...repoNode,
            ...(thing ? { issueOrPullRequest: issueNode(r, thing), issue: issueNode(r, thing) } : {}),
          },
        },
      };
    if (query.includes("pullRequests(")) {
      const nodes = [...r.things.values()].filter((t) => t.pr && t.state === "open").map((t) => prNode(r, t));
      return {
        data: {
          repository: {
            ...repoNode,
            pullRequests: { nodes, totalCount: nodes.length, pageInfo: { hasNextPage: false } },
          },
        },
      };
    }
    return { data: { repository: repoNode } };
  }

  /** Smart HTTP through `git http-backend` (CGI); Basic auth with a minted token, `contents: write` to push. */
  private gitHttp(req: IncomingMessage, res: ServerResponse, full: string, rest: string, query: string): void {
    const tok = this.tokenOf(req);
    const push = rest.endsWith("git-receive-pack") || query.includes("git-receive-pack");
    if (!tok || !this.repos.has(full) || !this.visible(tok, full) || (push && tok.permissions.contents !== "write")) {
      req.resume();
      if (tok) this.gitAuths.push(tok.token);
      const status = tok ? 403 : 401;
      res.writeHead(status, { "www-authenticate": 'Basic realm="fake"', "content-type": "text/plain" });
      return void res.end(`${status}\n`);
    }
    this.gitAuths.push(tok.token);
    const cl = req.headers["content-length"];
    const child = spawn("git", ["http-backend"], {
      env: {
        ...gitEnv,
        GIT_PROJECT_ROOT: this.root,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: `/${full}.git${rest}`,
        QUERY_STRING: query,
        REQUEST_METHOD: req.method ?? "GET",
        CONTENT_TYPE: req.headers["content-type"] ?? "",
        ...(cl ? { CONTENT_LENGTH: cl } : {}),
        REMOTE_USER: "x-access-token",
        REMOTE_ADDR: "127.0.0.1",
        GIT_PROTOCOL: String(req.headers["git-protocol"] ?? ""),
        ...(req.headers["content-encoding"] ? { HTTP_CONTENT_ENCODING: String(req.headers["content-encoding"]) } : {}),
      },
      stdio: ["pipe", "pipe", "inherit"],
    });
    req.pipe(child.stdin);
    let head = Buffer.alloc(0);
    let started = false;
    child.stdout.on("data", (c: Buffer) => {
      if (started) return void res.write(c);
      head = Buffer.concat([head, c]);
      const i = head.indexOf("\r\n\r\n");
      if (i < 0) return;
      started = true;
      let status = 200;
      const headers: Record<string, string> = {};
      for (const l of head.subarray(0, i).toString().split("\r\n")) {
        const [k = "", ...v] = l.split(":");
        if (k.toLowerCase() === "status") status = Number.parseInt(v.join(":").trim(), 10);
        else headers[k] = v.join(":").trim();
      }
      res.writeHead(status, headers);
      res.write(head.subarray(i + 4));
    });
    child.stdout.on("end", () => res.end());
  }
}
