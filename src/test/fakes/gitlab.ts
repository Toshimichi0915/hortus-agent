/**
 * Fake GitLab (18-gitlab-bitbucket.md › Fakes): the REST v4 subset the connector and Workers use behind a static
 * token (`PRIVATE-TOKEN` or bearer), projects addressed URL-encoded (`g%2Fsub%2Fp`), issues, MRs with `/changes`,
 * notes, approvals, pipelines, members; `X-Gitlab-Token` webhook deliveries to `hook`; git over HTTP (`git
 * http-backend`, Basic password = the token, any user). One port for API and git.
 *
 * `GitHost` (bare repos, commits, smart HTTP) is shared with the Bitbucket fake.
 */
import { execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { tempDir } from "../until.ts";

const run = promisify(execFile);
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

/** Bare repos under a temp root: one-file commits, branch shas, and smart HTTP through `git http-backend`. */
export class GitHost {
  root: string;
  constructor(prefix: string) {
    this.root = tempDir(prefix);
  }
  private dir = (full: string) => join(this.root, `${full}.git`);
  private git(full: string, ...args: string[]) {
    return run("git", ["--git-dir", this.dir(full), ...args], { env: gitEnv }).then((r) => r.stdout.trim());
  }
  /** a bare repo whose `main` has one commit */
  async init(full: string): Promise<string> {
    mkdirSync(this.dir(full), { recursive: true });
    await this.git(full, "init", "-q", "--bare", "-b", "main");
    return this.commit(full, "main", "README.md", `# ${full}\n`);
  }
  async commit(full: string, branch: string, file: string, content: string): Promise<string> {
    const D = this.dir(full);
    const blob = await run("sh", ["-c", `printf %s "$C" | git --git-dir "$D" hash-object -w --stdin`], {
      env: { ...gitEnv, C: content, D },
    }).then((r) => r.stdout.trim());
    const tree = await run("sh", ["-c", `printf '100644 blob %s\\t%s\\n' "$B" "$F" | git --git-dir "$D" mktree`], {
      env: { ...gitEnv, B: blob, F: file, D },
    }).then((r) => r.stdout.trim());
    const parent = await this.sha(full, branch).catch(() => this.sha(full, "main").catch(() => ""));
    const who = { GIT_AUTHOR_NAME: "f", GIT_AUTHOR_EMAIL: "f@x", GIT_COMMITTER_NAME: "f", GIT_COMMITTER_EMAIL: "f@x" };
    const sha = await run("git", ["--git-dir", D, "commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", file], {
      env: { ...gitEnv, ...who },
    }).then((r) => r.stdout.trim());
    await this.git(full, "update-ref", `refs/heads/${branch}`, sha);
    return sha;
  }
  sha(full: string, branch: string): Promise<string> {
    return this.git(full, "rev-parse", "--verify", `refs/heads/${branch}`);
  }
  /** `ok` false → 401 (no credential) or 403 */
  serve(req: IncomingMessage, res: ServerResponse, full: string, rest: string, query: string, ok: boolean): void {
    if (!ok) {
      req.resume();
      res.writeHead(401, { "www-authenticate": 'Basic realm="fake"', "content-type": "text/plain" });
      return void res.end("401\n");
    }
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
        REMOTE_USER: "token",
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

/** The Basic password of a request, if any. */
export function basicPassword(req: IncomingMessage): { user: string; password: string } | undefined {
  const b = req.headers.authorization?.match(/^Basic (\S+)$/i)?.[1];
  if (!b) return undefined;
  const s = Buffer.from(b, "base64").toString();
  const i = s.indexOf(":");
  return i < 0 ? undefined : { user: s.slice(0, i), password: s.slice(i + 1) };
}

/** the body of one request, parsed as JSON when there is one */
export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString();
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

export interface DeliverOpts {
  /** recorded, never posted (a delivery lost by the tunnel) */
  drop?: boolean;
  /** replay an earlier delivery's id */
  guid?: string;
  /** the token / signature header to send instead of the right one */
  signature?: string;
}

interface User {
  id: number;
  username: string;
  name: string;
}
interface Thing {
  iid: number;
  title: string;
  description: string;
  state: "opened" | "closed" | "merged";
  labels: string[];
  assignees: User[];
  author: User;
  created_at: string;
  updated_at: string;
  mr?: { source_branch: string; target_branch: string; sha: string; diff: string; approvals: User[] };
}
interface Note {
  id: number;
  iid: number;
  mr: boolean;
  body: string;
  author: User;
  created_at: string;
  updated_at: string;
}
interface Project {
  id: number;
  path: string;
  description: string;
  issues: Map<number, Thing>;
  mrs: Map<number, Thing>;
  notes: Note[];
  pipelines: { id: number; sha: string; ref: string; status: string }[];
}

/** unified diff → GitLab's `/changes` entries (header lines dropped, hunks kept) */
function changesOf(diff: string) {
  return diff
    .split(/^(?=diff --git )/m)
    .filter(Boolean)
    .map((part) => {
      const m = part.match(/^diff --git a\/(\S+) b\/(\S+)\n/);
      const i = part.indexOf("\n+++ ");
      const body = i < 0 ? "" : part.slice(part.indexOf("\n", i + 1) + 1);
      return {
        old_path: m?.[1] ?? "",
        new_path: m?.[2] ?? "",
        a_mode: "100644",
        b_mode: "100644",
        new_file: part.includes("\n--- /dev/null"),
        deleted_file: part.includes("\n+++ /dev/null"),
        renamed_file: false,
        diff: body,
      };
    });
}

export class FakeGitLab {
  token = `glpat-${randomBytes(10).toString("hex")}`;
  webhookSecret = "gl-hook-secret";
  /** where `deliver` posts (the listener's `/<dof>/webhook`) */
  hook?: string;
  projects = new Map<string, Project>();
  /** access level by username (absent: not a member) */
  members = new Map<string, number>();
  /** the token's own user (a project access token's bot) */
  self = "project_1_bot_hortus";
  /** newest first */
  deliveries: { guid: string; event: string; payload: Record<string, unknown> }[] = [];
  /** the token of every authenticated git request */
  gitAuths: string[] = [];
  /** every REST request: method, the raw path (encoded ids kept), the URL as sent */
  calls: { method: string; path: string; url: string }[] = [];
  git = new GitHost("hortus-fake-gitlab-");
  private users = new Map<string, User>();
  private ids = 100;
  private tick = 0;

  private constructor(
    private server: Server,
    public url: string,
  ) {}

  static async start(): Promise<FakeGitLab> {
    let self: FakeGitLab | undefined;
    const server = createServer((req, res) => {
      self?.handle(req, res).catch((e) => {
        if (!res.headersSent) res.writeHead(500).end(String(e));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    self = new FakeGitLab(server, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    return self;
  }

  /** vault.json entries for DOF `name` */
  vault(name = "gitlab") {
    return {
      [name]: { type: "token" as const, value: this.token, transform: "gitlab" },
      [`${name}-webhook`]: { type: "webhook-secret" as const, value: this.webhookSecret, transform: "gitlab" },
    };
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((r) => this.server.close(r));
  }

  // ---- state and events ----------------------------------------------------------------------------------------

  private ts(): string {
    return new Date(Date.now() + this.tick++ * 1000).toISOString();
  }
  user(username: string): User {
    const u = this.users.get(username) ?? { id: this.users.size + 1, username, name: username };
    this.users.set(username, u);
    return u;
  }
  private get(path: string): Project {
    const p = this.projects.get(path);
    if (!p) throw new Error(`fake: no project ${path}`);
    return p;
  }
  private thing(path: string, n: number, mr: boolean): Thing {
    const t = (mr ? this.get(path).mrs : this.get(path).issues).get(n);
    if (!t) throw new Error(`fake: no ${mr ? "!" : "#"}${n}`);
    return t;
  }

  async repo(path: string, description = ""): Promise<string> {
    this.projects.set(path, {
      id: this.projects.size + 1,
      path,
      description,
      issues: new Map(),
      mrs: new Map(),
      notes: [],
      pipelines: [],
    });
    return this.git.init(path);
  }
  commit = (path: string, branch: string, file: string, content: string) =>
    this.git.commit(path, branch, file, content);
  sha = (path: string, branch: string) => this.git.sha(path, branch);

  private projectJson(p: Project) {
    return {
      id: p.id,
      name: p.path.split("/").at(-1),
      path: p.path.split("/").at(-1),
      path_with_namespace: p.path,
      default_branch: "main",
      description: p.description,
      web_url: `https://gitlab.com/${p.path}`,
    };
  }
  private restJson(p: Project, t: Thing) {
    const { mr, ...rest } = t;
    const kind = mr ? "merge_requests" : "issues";
    return {
      id: t.iid + 1000,
      project_id: p.id,
      ...rest,
      ...(mr ? { source_branch: mr.source_branch, target_branch: mr.target_branch, sha: mr.sha } : {}),
      web_url: `https://gitlab.com/${p.path}/-/${kind}/${t.iid}`,
    };
  }
  private hookAttrs(t: Thing, action: string) {
    const { mr, author, assignees: _, labels: __, ...rest } = t;
    return {
      ...rest,
      id: t.iid + 1000,
      author_id: author.id,
      action,
      ...(mr ? { source_branch: mr.source_branch, target_branch: mr.target_branch, last_commit: { id: mr.sha } } : {}),
    };
  }
  private noteJson(n: Note) {
    const { iid, mr, ...rest } = n;
    return { ...rest, system: false, noteable_type: mr ? "MergeRequest" : "Issue", noteable_iid: iid };
  }

  private send(kind: string, p: Project, by: string, extra: Record<string, unknown>, d?: DeliverOpts) {
    const payload = {
      object_kind: kind,
      event_type: kind,
      user: this.user(by),
      project: this.projectJson(p),
      ...extra,
    };
    return this.deliver(kind, payload, d);
  }

  private newThing(p: Project, mr: boolean, o: { user: string; title: string; body?: string }): Thing {
    const map = mr ? p.mrs : p.issues;
    const now = this.ts();
    const t: Thing = {
      iid: map.size + 1,
      title: o.title,
      description: o.body ?? "",
      state: "opened",
      labels: [],
      assignees: [],
      author: this.user(o.user),
      created_at: now,
      updated_at: now,
    };
    map.set(t.iid, t);
    return t;
  }

  openIssue(path: string, o: { user: string; title: string; body?: string }, d?: DeliverOpts) {
    const p = this.get(path);
    const t = this.newThing(p, false, o);
    return this.send("issue", p, o.user, { object_attributes: this.hookAttrs(t, "open") }, d).then((x) => ({
      ...x,
      n: t.iid,
    }));
  }

  private note(path: string, n: number, mr: boolean, o: { user: string; body: string }, d?: DeliverOpts) {
    const p = this.get(path);
    const t = this.thing(path, n, mr);
    const now = this.ts();
    const note: Note = {
      id: this.ids++,
      iid: n,
      mr,
      body: o.body,
      author: this.user(o.user),
      created_at: now,
      updated_at: now,
    };
    p.notes.push(note);
    t.updated_at = now;
    const attrs = { ...this.noteJson(note), note: o.body, author_id: note.author.id };
    const target = mr ? { merge_request: this.hookAttrs(t, "") } : { issue: this.hookAttrs(t, "") };
    return this.send("note", p, o.user, { object_attributes: attrs, ...target }, d).then((x) => ({
      ...x,
      id: note.id,
    }));
  }
  comment = (path: string, n: number, o: { user: string; body: string }, d?: DeliverOpts) =>
    this.note(path, n, false, o, d);
  mrComment = (path: string, n: number, o: { user: string; body: string }, d?: DeliverOpts) =>
    this.note(path, n, true, o, d);

  closeIssue(path: string, n: number, by: string, d?: DeliverOpts) {
    const t = this.thing(path, n, false);
    t.state = "closed";
    t.updated_at = this.ts();
    return this.send("issue", this.get(path), by, { object_attributes: this.hookAttrs(t, "close") }, d);
  }

  async openMR(
    path: string,
    o: { user: string; title: string; head: string; base?: string; body?: string; diff?: string },
    d?: DeliverOpts,
  ) {
    const p = this.get(path);
    const sha = await this.sha(path, o.head).catch(() => "0".repeat(40));
    const t = this.newThing(p, true, o);
    t.mr = { source_branch: o.head, target_branch: o.base ?? "main", sha, diff: o.diff ?? "", approvals: [] };
    const x = await this.send("merge_request", p, o.user, { object_attributes: this.hookAttrs(t, "open") }, d);
    return { ...x, n: t.iid, sha };
  }

  approve(path: string, n: number, user: string, d?: DeliverOpts) {
    const t = this.thing(path, n, true);
    t.mr?.approvals.push(this.user(user));
    t.updated_at = this.ts();
    return this.send("merge_request", this.get(path), user, { object_attributes: this.hookAttrs(t, "approved") }, d);
  }

  mergeMR(path: string, n: number, by: string, d?: DeliverOpts) {
    const t = this.thing(path, n, true);
    t.state = "merged";
    t.updated_at = this.ts();
    return this.send("merge_request", this.get(path), by, { object_attributes: this.hookAttrs(t, "merge") }, d);
  }

  /** A pipeline on `sha`; `branch` sends it as a branch pipeline (no `merge_request`, the connector looks it up). */
  pipeline(path: string, sha: string, status: string, o: { branch?: boolean } = {}, d?: DeliverOpts) {
    const p = this.get(path);
    const mr = [...p.mrs.values()].find((t) => t.mr?.sha === sha && t.state === "opened");
    const pl = { id: this.ids++, sha, ref: mr?.mr?.source_branch ?? "main", status };
    p.pipelines.unshift(pl);
    const merge_request = mr && !o.branch ? { iid: mr.iid } : null;
    return this.send("pipeline", p, "ci", { object_attributes: { ...pl, source: "push" }, merge_request }, d);
  }

  push(path: string, ref: string, before: string, after: string, by: string, d?: DeliverOpts) {
    const p = this.get(path);
    const u = this.user(by);
    const payload = {
      object_kind: "push",
      event_name: "push",
      ref,
      before,
      after,
      user_id: u.id,
      user_username: u.username,
      project: this.projectJson(p),
      commits: [],
    };
    return this.deliver("push", payload, d);
  }

  async deliver(event: string, payload: Record<string, unknown>, o: DeliverOpts = {}) {
    const guid = o.guid ?? randomUUID();
    const body = JSON.stringify(payload);
    const headers = {
      "content-type": "application/json",
      "user-agent": "GitLab/fake",
      "x-gitlab-event": `${event.replace(/(^|_)(\w)/g, (_, s, c: string) => `${s ? " " : ""}${c.toUpperCase()}`)} Hook`,
      "x-gitlab-event-uuid": guid,
      "x-gitlab-webhook-uuid": "hook-1",
      "x-gitlab-token": o.signature ?? this.webhookSecret,
    };
    this.deliveries.unshift({ guid, event, payload });
    if (o.drop || !this.hook) return { status: 0, guid };
    const res = await fetch(this.hook, { method: "POST", headers, body });
    await res.text();
    return { status: res.status, guid };
  }

  // ---- HTTP ----------------------------------------------------------------------------------------------------

  private authed(req: IncomingMessage): boolean {
    const t = req.headers["private-token"] ?? req.headers.authorization?.match(/^Bearer (\S+)$/i)?.[1];
    return t === this.token;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const u = new URL(req.url ?? "/", "http://x");
    const raw = u.pathname;
    const git = raw.match(/^\/(.+?)\.git(\/.*)$/);
    if (git) {
      const full = git[1] ?? "";
      const pw = basicPassword(req)?.password;
      if (pw) this.gitAuths.push(pw);
      return this.git.serve(
        req,
        res,
        full,
        git[2] ?? "",
        u.search.slice(1),
        pw === this.token && this.projects.has(full),
      );
    }
    const M = req.method ?? "GET";
    this.calls.push({ method: M, path: raw, url: req.url ?? "" });
    const json = (status: number, v: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(v));
    };
    if (!raw.startsWith("/api/v4/")) return json(404, { message: "404 Not Found" });
    if (!this.authed(req)) return json(401, { message: "401 Unauthorized" });
    const body = await readJson(req);
    const path = raw.slice("/api/v4".length);
    const q = (k: string) => u.searchParams.get(k);
    const after = q("updated_after");
    const since = (t: { updated_at: string }) => !after || Date.parse(t.updated_at) >= Date.parse(after);

    if (path === "/user") return json(200, this.user(this.self));
    if (path === "/projects" && M === "GET")
      return json(
        200,
        [...this.projects.values()].map((p) => this.projectJson(p)),
      );
    if (path === "/projects" && M === "POST") {
      const full = `g/${body.path ?? body.name}`;
      await this.repo(full);
      return json(201, this.projectJson(this.get(full)));
    }
    const m = path.match(/^\/projects\/([^/]+)(\/.*)?$/);
    const p = m && this.projects.get(decodeURIComponent(m[1] ?? ""));
    if (!m || !p) return json(404, { message: "404 Project Not Found" });
    const rest = m[2] ?? "";
    let x: RegExpMatchArray | null;
    if (rest === "") return json(200, this.projectJson(p));
    x = rest.match(/^\/members\/all\/(\d+)$/);
    if (x) {
      const who = [...this.users.values()].find((v) => v.id === Number(x?.[1]));
      const level = who && this.members.get(who.username);
      return level === undefined ? json(404, { message: "404 Not found" }) : json(200, { ...who, access_level: level });
    }
    x = rest.match(/^\/(issues|merge_requests)$/);
    if (x) {
      const mr = x[1] === "merge_requests";
      if (M === "POST") {
        const t = this.newThing(p, mr, {
          user: this.self,
          title: String(body.title ?? ""),
          body: String(body.description ?? ""),
        });
        if (mr) {
          const head = String(body.source_branch);
          const sha = await this.sha(p.path, head).catch(() => "0".repeat(40));
          t.mr = {
            source_branch: head,
            target_branch: String(body.target_branch ?? "main"),
            sha,
            diff: "",
            approvals: [],
          };
        }
        return json(201, this.restJson(p, t));
      }
      const st = q("state");
      const branch = q("source_branch");
      const list = [...(mr ? p.mrs : p.issues).values()].filter(
        (t) => since(t) && (!st || st === "all" || t.state === st) && (!branch || t.mr?.source_branch === branch),
      );
      return json(
        200,
        list.map((t) => this.restJson(p, t)),
      );
    }
    x = rest.match(/^\/(issues|merge_requests)\/(\d+)(\/notes|\/changes|\/approvals)?$/);
    if (x) {
      const mr = x[1] === "merge_requests";
      const t = (mr ? p.mrs : p.issues).get(Number(x[2]));
      if (!t) return json(404, { message: "404 Not found" });
      if (!x[3]) return json(200, this.restJson(p, t));
      if (x[3] === "/changes") return json(200, { ...this.restJson(p, t), changes: changesOf(t.mr?.diff ?? "") });
      if (x[3] === "/approvals")
        return json(200, { approved_by: (t.mr?.approvals ?? []).map((user) => ({ user })), updated_at: t.updated_at });
      if (M === "POST") {
        const now = this.ts();
        const n: Note = {
          id: this.ids++,
          iid: t.iid,
          mr,
          body: String(body.body ?? ""),
          author: this.user(this.self),
          created_at: now,
          updated_at: now,
        };
        p.notes.push(n);
        return json(201, this.noteJson(n));
      }
      return json(
        200,
        p.notes.filter((n) => n.iid === t.iid && n.mr === mr).map((n) => this.noteJson(n)),
      );
    }
    if (rest === "/pipelines") {
      const sha = q("sha");
      return json(
        200,
        p.pipelines.filter((pl) => !sha || pl.sha === sha),
      );
    }
    return json(404, { message: "404 Not Found" });
  }
}
