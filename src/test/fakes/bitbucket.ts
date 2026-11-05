/**
 * Fake Bitbucket Cloud (18-gitlab-bitbucket.md › Fakes): the REST 2.0 subset the connector and Workers use behind a
 * repository access token (bearer), issues, PRs with `/diff` (a redirect, as Bitbucket answers), comments, approvals,
 * commit statuses, workspace members; `X-Hub-Signature` webhook deliveries to `hook`; git over HTTP (Basic
 * `x-token-auth:<token>`). One port for `api.bitbucket.org` and `bitbucket.org`.
 */
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { basicPassword, type DeliverOpts, GitHost, readJson } from "./gitlab.ts";

export type { DeliverOpts } from "./gitlab.ts";

interface User {
  account_id: string;
  uuid: string;
  nickname: string;
  display_name: string;
  type: string;
}
interface Issue {
  id: number;
  title: string;
  content: { raw: string };
  state: string;
  kind: string;
  reporter: User;
  assignee: User | null;
  created_on: string;
  updated_on: string;
}
interface Pull {
  id: number;
  title: string;
  description: string;
  state: "OPEN" | "MERGED" | "DECLINED";
  author: User;
  head: string;
  base: string;
  sha: string;
  diff: string;
  approvals: Map<string, User>;
  /** the head it merged at */
  landed?: string;
  created_on: string;
  updated_on: string;
}
interface Comment {
  id: number;
  n: number;
  pr: boolean;
  raw: string;
  user: User;
  created_on: string;
  updated_on: string;
}
interface Repo {
  full: string;
  description: string;
  issues: Map<number, Issue>;
  prs: Map<number, Pull>;
  comments: Comment[];
  statuses: { key: string; state: string; sha: string; updated_on: string }[];
}

export class FakeBitbucket {
  token = `bbat-${randomBytes(10).toString("hex")}`;
  webhookSecret = "bb-hook-secret";
  hook?: string;
  repos = new Map<string, Repo>();
  /** workspace members by nickname */
  members = new Set<string>();
  /** the token's own account (a repository access token's bot) */
  self = "hortus-bot";
  deliveries: { guid: string; event: string; payload: Record<string, unknown> }[] = [];
  gitAuths: string[] = [];
  calls: { method: string; path: string; url: string }[] = [];
  git = new GitHost("hortus-fake-bitbucket-");
  private ids = 100;
  private tick = 0;

  private constructor(
    private server: Server,
    public url: string,
  ) {}

  /** the issue tracker API as it is since 2026-08-20: removed */
  issuesGone = false;

  static async start(): Promise<FakeBitbucket> {
    let self: FakeBitbucket | undefined;
    const server = createServer((req, res) => {
      self?.handle(req, res).catch((e) => {
        if (!res.headersSent) res.writeHead(500).end(String(e));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    self = new FakeBitbucket(server, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    return self;
  }

  vault(name = "bitbucket") {
    return {
      [name]: { type: "token" as const, value: this.token, transform: "bitbucket" },
      [`${name}-webhook`]: { type: "webhook-secret" as const, value: this.webhookSecret, transform: "bitbucket" },
    };
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((r) => this.server.close(r));
  }

  // ---- state and events ----------------------------------------------------------------------------------------

  /** Bitbucket's `2026-11-04T10:00:00.000000+00:00` */
  private ts(): string {
    return new Date(Date.now() + this.tick++ * 1000).toISOString().replace("Z", "000+00:00");
  }
  user(nickname: string): User {
    return {
      account_id: `acc-${nickname}`,
      uuid: `{${nickname}}`,
      nickname,
      display_name: nickname,
      type: nickname === this.self ? "app_user" : "user",
    };
  }
  private get(full: string): Repo {
    const r = this.repos.get(full);
    if (!r) throw new Error(`fake: no repo ${full}`);
    return r;
  }
  private pr(full: string, n: number): Pull {
    const p = this.get(full).prs.get(n);
    if (!p) throw new Error(`fake: no !${n}`);
    return p;
  }

  async repo(full: string, description = ""): Promise<string> {
    this.repos.set(full, { full, description, issues: new Map(), prs: new Map(), comments: [], statuses: [] });
    return this.git.init(full);
  }
  commit = (full: string, branch: string, file: string, content: string) =>
    this.git.commit(full, branch, file, content);
  sha = (full: string, branch: string) => this.git.sha(full, branch);

  private repoJson(r: Repo) {
    return {
      type: "repository",
      full_name: r.full,
      name: r.full.split("/")[1],
      slug: r.full.split("/")[1],
      uuid: `{repo-${r.full}}`,
      description: r.description,
      is_private: true,
      mainbranch: { name: "main", type: "branch" },
      links: { html: { href: `https://bitbucket.org/${r.full}` } },
    };
  }
  private issueJson(r: Repo, i: Issue) {
    return { type: "issue", ...i, links: { html: { href: `https://bitbucket.org/${r.full}/issues/${i.id}` } } };
  }
  private prJson(r: Repo, p: Pull) {
    return {
      type: "pullrequest",
      id: p.id,
      title: p.title,
      description: p.description,
      state: p.state,
      author: p.author,
      source: { branch: { name: p.head }, commit: { hash: p.sha.slice(0, 12) } },
      destination: { branch: { name: p.base } },
      participants: [...p.approvals.values()].map((user) => ({ user, role: "REVIEWER", approved: true })),
      created_on: p.created_on,
      updated_on: p.updated_on,
      links: { html: { href: `https://bitbucket.org/${r.full}/pull-requests/${p.id}` } },
    };
  }
  private commentJson(c: Comment) {
    return {
      type: c.pr ? "pullrequest_comment" : "issue_comment",
      id: c.id,
      content: { raw: c.raw },
      user: c.user,
      created_on: c.created_on,
      updated_on: c.updated_on,
      deleted: false,
    };
  }

  private send(event: string, r: Repo, by: string, extra: Record<string, unknown>, d?: DeliverOpts) {
    return this.deliver(event, { actor: this.user(by), repository: this.repoJson(r), ...extra }, d);
  }

  openIssue(full: string, o: { user: string; title: string; body?: string }, d?: DeliverOpts) {
    const r = this.get(full);
    const now = this.ts();
    const i: Issue = {
      id: r.issues.size + 1,
      title: o.title,
      content: { raw: o.body ?? "" },
      state: "new",
      kind: "bug",
      reporter: this.user(o.user),
      assignee: null,
      created_on: now,
      updated_on: now,
    };
    r.issues.set(i.id, i);
    return this.send("issue:created", r, o.user, { issue: this.issueJson(r, i) }, d).then((x) => ({ ...x, n: i.id }));
  }

  private addComment(full: string, n: number, pr: boolean, o: { user: string; body: string }) {
    const r = this.get(full);
    const now = this.ts();
    const c: Comment = {
      id: this.ids++,
      n,
      pr,
      raw: o.body,
      user: this.user(o.user),
      created_on: now,
      updated_on: now,
    };
    r.comments.push(c);
    return c;
  }

  comment(full: string, n: number, o: { user: string; body: string }, d?: DeliverOpts) {
    const r = this.get(full);
    const i = r.issues.get(n);
    if (!i) throw new Error(`fake: no #${n}`);
    const c = this.addComment(full, n, false, o);
    i.updated_on = c.created_on;
    const extra = { issue: this.issueJson(r, i), comment: this.commentJson(c) };
    return this.send("issue:comment_created", r, o.user, extra, d).then((x) => ({ ...x, id: c.id }));
  }

  prComment(full: string, n: number, o: { user: string; body: string }, d?: DeliverOpts) {
    const r = this.get(full);
    const p = this.pr(full, n);
    const c = this.addComment(full, n, true, o);
    const extra = { pullrequest: this.prJson(r, p), comment: this.commentJson(c) };
    return this.send("pullrequest:comment_created", r, o.user, extra, d).then((x) => ({ ...x, id: c.id }));
  }

  closeIssue(full: string, n: number, by: string, d?: DeliverOpts) {
    const r = this.get(full);
    const i = r.issues.get(n);
    if (!i) throw new Error(`fake: no #${n}`);
    i.state = "resolved";
    i.updated_on = this.ts();
    return this.send(
      "issue:updated",
      r,
      by,
      { issue: this.issueJson(r, i), changes: { status: { new: "resolved" } } },
      d,
    );
  }

  async openPR(
    full: string,
    o: { user: string; title: string; head: string; base?: string; body?: string; diff?: string },
    d?: DeliverOpts,
  ) {
    const r = this.get(full);
    const sha = await this.sha(full, o.head).catch(() => "0".repeat(40));
    const base = o.base ?? "main";
    const diff = o.diff ?? (await this.git.diff(full, base, o.head).catch(() => ""));
    const now = this.ts();
    const p: Pull = {
      id: r.prs.size + 1,
      title: o.title,
      description: o.body ?? "",
      state: "OPEN",
      author: this.user(o.user),
      head: o.head,
      base,
      sha,
      diff,
      approvals: new Map(),
      created_on: now,
      updated_on: now,
    };
    r.prs.set(p.id, p);
    const x = await this.send("pullrequest:created", r, o.user, { pullrequest: this.prJson(r, p) }, d);
    return { ...x, n: p.id, sha };
  }

  /** A commit on the PR's branch: the head moves, `pullrequest:updated` fires. */
  async pushPR(full: string, n: number, o: { user: string; file: string; diff: string }, d?: DeliverOpts) {
    const r = this.get(full);
    const p = this.pr(full, n);
    p.sha = await this.commit(full, p.head, o.file, `${o.file}\n`);
    p.diff = o.diff;
    p.updated_on = this.ts();
    const x = await this.send("pullrequest:updated", r, o.user, { pullrequest: this.prJson(r, p) }, d);
    return { ...x, sha: p.sha };
  }

  approve(full: string, n: number, user: string, d?: DeliverOpts) {
    const r = this.get(full);
    const p = this.pr(full, n);
    const u = this.user(user);
    p.approvals.set(user, u);
    const extra = { pullrequest: this.prJson(r, p), approval: { date: this.ts(), user: u } };
    return this.send("pullrequest:approved", r, user, extra, d);
  }

  requestChanges(full: string, n: number, user: string, d?: DeliverOpts) {
    const r = this.get(full);
    const u = this.user(user);
    const extra = { pullrequest: this.prJson(r, this.pr(full, n)), changes_request: { date: this.ts(), user: u } };
    return this.send("pullrequest:changes_request_created", r, user, extra, d);
  }

  mergePR(full: string, n: number, by: string, d?: DeliverOpts) {
    const r = this.get(full);
    const p = this.pr(full, n);
    p.state = "MERGED";
    p.landed = p.sha;
    p.updated_on = this.ts();
    return this.send("pullrequest:fulfilled", r, by, { pullrequest: this.prJson(r, p) }, d);
  }

  /** A build status on `sha` (`SUCCESSFUL`, `FAILED`, `INPROGRESS`, `STOPPED`), keyed `ci`. */
  status(full: string, sha: string, state: string, d?: DeliverOpts) {
    const r = this.get(full);
    const now = this.ts();
    r.statuses = r.statuses.filter((s) => !(s.sha === sha && s.key === "ci"));
    r.statuses.push({ key: "ci", state, sha, updated_on: now });
    // the event-payloads page's shape: the commit only as a link (http, as published)
    const commit = `http://api.bitbucket.org/2.0/repositories/${full}/commit/${sha}`;
    const links = { commit: { href: commit }, self: { href: `${commit}/statuses/build/ci` } };
    const commit_status = { key: "ci", state, name: "ci", type: "build", links, created_on: now, updated_on: now };
    return this.send(
      `repo:commit_status_${r.statuses.length > 1 ? "updated" : "created"}`,
      r,
      "ci-bot",
      { commit_status },
      d,
    );
  }

  push(full: string, ref: string, before: string, after: string, by: string, d?: DeliverOpts) {
    const name = ref.replace(/^refs\/heads\//, "");
    const side = (hash: string) => (/^0+$/.test(hash) ? null : { name, type: "branch", target: { hash } });
    const push = { changes: [{ old: side(before), new: side(after), created: /^0+$/.test(before) }] };
    return this.send("repo:push", this.get(full), by, { push }, d);
  }

  async deliver(event: string, payload: Record<string, unknown>, o: DeliverOpts = {}) {
    const guid = o.guid ?? randomUUID();
    const body = JSON.stringify(payload);
    const headers = {
      "content-type": "application/json",
      "user-agent": "Bitbucket-Webhooks/2.0",
      "x-event-key": event,
      "x-request-uuid": guid,
      "x-hook-uuid": "{hook-1}",
      "x-hub-signature": o.signature ?? `sha256=${createHmac("sha256", this.webhookSecret).update(body).digest("hex")}`,
    };
    this.deliveries.unshift({ guid, event, payload });
    if (o.drop || !this.hook) return { status: 0, guid };
    const res = await fetch(this.hook, { method: "POST", headers, body });
    await res.text();
    return { status: res.status, guid };
  }

  // ---- HTTP ----------------------------------------------------------------------------------------------------

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const u = new URL(req.url ?? "/", "http://x");
    const path = u.pathname;
    const git = path.match(/^\/([^/]+\/[^/]+)\.git(\/.*)$/);
    if (git) {
      const full = git[1] ?? "";
      const b = basicPassword(req);
      if (b) this.gitAuths.push(b.password);
      const ok = b?.user === "x-token-auth" && b.password === this.token && this.repos.has(full);
      return this.git.serve(req, res, full, git[2] ?? "", u.search.slice(1), ok);
    }
    const M = req.method ?? "GET";
    this.calls.push({ method: M, path, url: req.url ?? "" });
    const json = (status: number, v: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(v));
    };
    const page = (values: unknown[]) => json(200, { pagelen: values.length, size: values.length, page: 1, values });
    if (!path.startsWith("/2.0/")) return json(404, { type: "error", error: { message: "Not found" } });
    if (req.headers.authorization !== `Bearer ${this.token}`)
      return json(401, { type: "error", error: { message: "Unauthorized" } });
    const body = await readJson(req);
    const api = path.slice("/2.0".length);
    // BBQL: an unquoted ISO-8601 datetime, UTC without an offset; a quoted value is a string
    const q = u.searchParams.get("q");
    if (q && !/^updated_on > \d{4}-\d\d-\d\dT[\d:.]+$/.test(q))
      return json(400, { type: "error", error: { message: `Invalid filter: ${q}` } });
    const after = q && `${q.slice("updated_on > ".length)}Z`;
    const since = (t: { updated_on: string }) => !after || Date.parse(t.updated_on) > Date.parse(after);
    let x: RegExpMatchArray | null;

    if (api === "/user") return json(200, this.user(this.self));
    if (api === "/user/workspaces") {
      const slugs = new Set([...this.repos.keys()].map((f) => f.split("/")[0]));
      return page([...slugs].map((slug) => ({ type: "workspace_access", administrator: false, workspace: { slug } })));
    }
    x = api.match(/^\/workspaces\/([^/]+)\/members\/([^/]+)$/);
    if (x) {
      const id = decodeURIComponent(x[2] ?? "");
      const nick = [...this.members].find((m) => this.user(m).account_id === id || this.user(m).uuid === id);
      return nick
        ? json(200, { type: "workspace_membership", user: this.user(nick), workspace: { slug: x[1] } })
        : json(404, { type: "error", error: { message: "not a member" } });
    }
    x = api.match(/^\/repositories\/([^/]+)\/?$/);
    if (x)
      return page([...this.repos.values()].filter((r) => r.full.startsWith(`${x?.[1]}/`)).map((r) => this.repoJson(r)));
    x = api.match(/^\/repositories\/([^/]+\/[^/]+)(\/.*)?$/);
    const full = x?.[1] ?? "";
    if (x && !x[2] && M === "POST") {
      await this.repo(full);
      return json(200, this.repoJson(this.get(full)));
    }
    const r = this.repos.get(full);
    if (!x || !r) return json(404, { type: "error", error: { message: "Repository not found" } });
    const rest = x[2] ?? "";
    if (rest === "") return json(200, this.repoJson(r));
    if (rest.startsWith("/issues") && this.issuesGone)
      return json(410, { type: "error", error: { message: "Resource removed" } });
    if (rest === "/issues" && M === "GET")
      return page([...r.issues.values()].filter(since).map((i) => this.issueJson(r, i)));
    if (rest === "/pullrequests" && M === "GET") {
      const states = u.searchParams.getAll("state");
      const want = states.length ? states : ["OPEN"];
      return page([...r.prs.values()].filter((p) => want.includes(p.state) && since(p)).map((p) => this.prJson(r, p)));
    }
    if (rest === "/pullrequests" && M === "POST") {
      const src = body.source as { branch?: { name?: string } } | undefined;
      const dst = body.destination as { branch?: { name?: string } } | undefined;
      // as Bitbucket: the API's own writes fire the hooks too
      const pr = await this.openPR(full, {
        user: this.self,
        title: String(body.title ?? ""),
        body: String(body.description ?? ""),
        head: String(src?.branch?.name),
        base: dst?.branch?.name ?? "main",
      });
      return json(201, this.prJson(r, this.pr(full, pr.n)));
    }
    x = rest.match(/^\/pullrequests\/(\d+)\/merge$/);
    if (x && M === "POST") {
      const n = Number(x[1]);
      await this.mergePR(full, n, this.self, { drop: true });
      return json(200, this.prJson(r, this.pr(full, n)));
    }
    x = rest.match(/^\/(issues|pullrequests)\/(\d+)(\/comments|\/diff)?$/);
    if (x) {
      const pr = x[1] === "pullrequests";
      const n = Number(x[2]);
      const t = pr ? r.prs.get(n) : r.issues.get(n);
      if (!t) return json(404, { type: "error", error: { message: "not found" } });
      if (x[3] === "/diff" && pr) {
        const p = t as Pull;
        res.writeHead(302, {
          location: `/2.0/repositories/${full}/diff/${full}:${p.sha.slice(0, 12)}%0D${p.base}?from_pullrequest_id=${n}`,
        });
        return void res.end();
      }
      if (x[3] === "/comments" && M === "POST") {
        const o = { user: this.self, body: String((body.content as { raw?: string })?.raw ?? "") };
        const { id } = await (pr ? this.prComment(full, n, o) : this.comment(full, n, o));
        return json(201, this.commentJson(r.comments.find((c) => c.id === id) as Comment));
      }
      if (x[3] === "/comments")
        return page(r.comments.filter((c) => c.n === n && c.pr === pr).map((c) => this.commentJson(c)));
      return json(200, pr ? this.prJson(r, t as Pull) : this.issueJson(r, t as Issue));
    }
    x = rest.match(/^\/diff\/.*$/);
    const from = Number(u.searchParams.get("from_pullrequest_id"));
    if (x && r.prs.get(from)) {
      res.writeHead(200, { "content-type": "text/plain" });
      return void res.end(r.prs.get(from)?.diff);
    }
    x = rest.match(/^\/commit\/([0-9a-f]+)\/statuses$/);
    if (x) return page(r.statuses.filter((s) => s.sha.startsWith(x?.[1] ?? "-")));
    return json(404, { type: "error", error: { message: "not found" } });
  }
}
