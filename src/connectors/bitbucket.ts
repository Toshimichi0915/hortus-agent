/**
 * Bitbucket Cloud: repository webhooks through the tunnel (`X-Hub-Signature` verified with
 * `hmac-verify` against `<name>-webhook`), REST 2.0 history. A static repository access token: every request carries
 * the placeholder `hortus-secret-<name>` as the bearer through `deps.fetch` (the pipeline as role core).
 *
 * Authors are `account_id`s (nicknames are not unique, so trust never keys on them); the mirror shows nicknames.
 */
import type { Change, ConnectorDeps, ConnectorStatus, Event, Forge, Heard, Mirrored } from "../types.ts";
import { hmacVerify } from "../vault/ops.ts";
import { cached, ciHeard, ciOf, dirOf, eventQueue, HttpError, iso, matches, NOT_THEIRS, rest, worst } from "./forge.ts";

const MAX_DIFF = 20 * 1024 * 1024;
const HOUR = 3600_000;
const KIND = /^(issue:|pullrequest:|repo:push$|repo:commit_status_)/;

interface User {
  account_id?: string;
  uuid?: string;
  nickname?: string;
  display_name?: string;
  type?: string;
}
interface Repo {
  full_name: string;
  mainbranch?: { name: string } | null;
  description?: string | null;
}
interface Issue {
  id: number;
  title: string;
  content?: { raw?: string | null };
  state: string;
  kind?: string;
  reporter?: User | null;
  assignee?: User | null;
  created_on: string;
  updated_on: string;
}
interface Pull {
  id: number;
  title: string;
  description?: string | null;
  state: string;
  author?: User | null;
  closed_by?: User | null;
  source: { branch: { name: string }; commit?: { hash: string } | null };
  destination: { branch: { name: string } };
  participants?: { user: User; approved?: boolean; state?: string | null; participated_on?: string | null }[];
  created_on: string;
  updated_on: string;
}
interface Comment {
  id: number;
  content?: { raw?: string | null };
  user?: User | null;
  deleted?: boolean;
  inline?: { path: string; to?: number | null } | null;
  created_on: string;
  updated_on?: string | null;
}
interface Payload {
  actor?: User;
  repository?: Repo;
  issue?: Issue;
  pullrequest?: Pull;
  comment?: Comment;
  approval?: { date: string; user: User };
  changes_request?: { date: string; user: User };
  /** the published sample carries only `links.commit.href`; `commit.hash` is kept for what real deliveries may add */
  commit_status?: {
    state: string;
    commit?: { hash: string };
    links?: { commit?: { href?: string } };
    updated_on?: string;
  };
}
/** events.payload: the event key and body, plus the PRs a commit status belongs to (looked up at receipt) */
interface Wrapped {
  type: string;
  body: Payload;
  prs?: number[];
}

const shaOf = (b: Payload) => b.commit_status?.commit?.hash ?? b.commit_status?.links?.commit?.href?.split("/").pop();
const idOf = (u: User | null | undefined) => u?.account_id ?? u?.uuid ?? "";
const nick = (u: User | null | undefined) => u?.nickname ?? u?.display_name ?? idOf(u);
/** a file-name-safe id (`557058:abc…`, `{uuid}`) */
const safe = (s: string) => s.replace(/[^\w-]/g, "_");
/** commit status states as `worst` reads check suites */
const suite = (s: string) =>
  s === "INPROGRESS"
    ? { status: "in_progress", conclusion: null }
    : { status: "completed", conclusion: s === "SUCCESSFUL" ? "success" : "failure" };

export async function create(deps: ConnectorDeps): Promise<Forge> {
  const { name, config: cfg } = deps;
  const api = (cfg.api ?? "https://api.bitbucket.org/2.0").replace(/\/$/, "");
  const globs = cfg.repos as string[] | undefined;
  const st: ConnectorStatus = { connected: false };
  const queue = eventQueue();
  let projectCount = 0;
  const { get, json, all } = rest(deps, api, {
    authorization: `Bearer hortus-secret-${name}`,
    accept: "application/json",
    "user-agent": "hortus",
  });
  const R = (p: string) => `/repositories/${p}`;

  let self: Promise<User | undefined> | undefined;
  /** the token's own account (a repository access token acts as its bot); retried after a failure */
  const me = () =>
    (self ??= json<User>("/user").catch((e) => {
      deps.log.error(`${name}: GET /user failed`, e);
      self = undefined;
      return undefined;
    }));
  const memberOf = cached(HOUR, async (key: string) => {
    const [w = "", uid = ""] = key.split("\0");
    try {
      await json(`/workspaces/${w}/members/${encodeURIComponent(uid)}`);
      return true;
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return false;
      throw e;
    }
  });
  async function member(p: string, u: User | null | undefined): Promise<boolean> {
    if (!idOf(u)) return false;
    try {
      return await memberOf(`${p.split("/")[0]}\0${idOf(u)}`);
    } catch (e) {
      deps.log.error(`${name}: member check failed`, e);
      return false;
    }
  }

  const ref = (p: string, thread: string) => `${name}:${p}:${thread}`;
  const at = (p: string, thread: string, file = thread) => `${dirOf(p)}/${thread}/${file}.md`;

  function threadOf(type: string, b: Payload): string | null {
    if (type.startsWith("issue:") && b.issue) return `#${b.issue.id}`;
    if (type.startsWith("pullrequest:") && b.pullrequest) return `!${b.pullrequest.id}`;
    return null;
  }

  async function toEvent(type: string, key: string, b: Payload): Promise<Event> {
    const p = b.repository?.full_name ?? "";
    const thread = threadOf(type, b);
    const ci = type.startsWith("repo:commit_status_");
    let prs: number[] = [];
    const hash = shaOf(b);
    if (ci && hash) {
      try {
        const open = await all<Pull>(`${R(p)}/pullrequests?state=OPEN&pagelen=50`, "values");
        // PR payloads carry the 12-character short hash
        prs = open.filter((x) => x.source.commit?.hash && hash.startsWith(x.source.commit.hash)).map((x) => x.id);
      } catch (e) {
        deps.log.error(`${name}: PRs of ${p}@${hash} failed`, e);
      }
    }
    const u = b.actor;
    const own = !!u && !!idOf(u) && idOf(await me()) === idOf(u);
    const obj = b.comment ?? b.pullrequest ?? b.issue;
    const result = b.commit_status && `${b.commit_status.state} on ${hash?.slice(0, 7)}`;
    const opened = [(b.pullrequest ?? b.issue)?.title, b.pullrequest?.description ?? b.issue?.content?.raw]
      .filter(Boolean)
      .join("\n\n");
    const writer = b.comment?.user ?? b.pullrequest?.author ?? b.issue?.reporter;
    const written = b.comment?.content?.raw ?? (opened || (result ?? ""));
    // only a writer known to be the actor: an anonymous reporter is null, and a delivery may have no actor
    const text = obj && (!idOf(u) || idOf(writer) !== idOf(u)) ? NOT_THEIRS : written;
    // another bot's end of a PR reaches its task as a status does, no author (github.ts)
    const robot = !ci && !!u && (own || u.type === "app_user");
    const ender = robot && !own && /^pullrequest:(fulfilled|rejected)$/.test(type) && idOf(writer) !== idOf(u);
    return {
      dof: name,
      key,
      ts: iso(
        b.approval?.date ??
          b.changes_request?.date ??
          b.comment?.updated_on ??
          b.comment?.created_on ??
          b.commit_status?.updated_on ??
          (obj as { updated_on?: string } | undefined)?.updated_on,
      ),
      payload: { type, body: b, ...(ci ? { prs } : {}) } satisfies Wrapped,
      // CI results carry no author (they never start work) and are not bot traffic: they must reach their task
      // trust follows who wrote the text the event carries (as GitHub's `author_association`), not who touched it
      author:
        u && !ci && !ender
          ? {
              user: idOf(u),
              member: await member(p, b.comment?.user ?? b.pullrequest?.author ?? b.issue?.reporter ?? u),
            }
          : null,
      bot: robot && !ender,
      summary: `${type} ${p}${thread ?? ""} by ${nick(u)}: ${text}`,
      refs: thread ? [ref(p, thread)] : prs.map((n) => ref(p, `!${n}`)),
    };
  }

  /** The live rules (`toEvent`) for what a reconcile finds, from the object where no event came: a missed message or end. */
  async function heard(
    p: string,
    thread: string,
    type: string,
    u: User | null | undefined,
    writer: User | null | undefined,
    text: string,
    ts: string,
    end?: string,
  ): Promise<Heard> {
    const own = !!idOf(u) && idOf(await me()) === idOf(u);
    const robot = !!u && (own || u.type === "app_user");
    const ender = robot && !own && !!end && idOf(writer) !== idOf(u);
    return {
      author: u && !ender ? { user: idOf(u), member: await member(p, writer ?? u) } : null,
      bot: robot && !ender,
      summary: `${type} ${p}${thread} by ${nick(u)}: ${idOf(u) && idOf(writer) === idOf(u) ? text : NOT_THEIRS}`,
      refs: [ref(p, thread)],
      ts: iso(ts),
      ...(end ? { state: end } : {}),
    };
  }

  function issueTop(p: string, i: Issue): Change {
    const t = `#${i.id}`;
    const fm = { id: t, thread: t, ts: iso(i.created_on), user: nick(i.reporter), title: i.title, state: i.state };
    return {
      op: "put",
      path: at(p, t),
      frontmatter: { ...fm, kind: i.kind ?? "", assignees: i.assignee ? [nick(i.assignee)] : [] },
      body: i.content?.raw ?? "",
    };
  }

  async function checksOf(p: string, sha: string | undefined): Promise<{ checks: string | null; at?: string }> {
    if (!sha) return { checks: null };
    try {
      const sts = await all<{ state: string; updated_on?: string }>(
        `${R(p)}/commit/${sha}/statuses?pagelen=100`,
        "values",
      );
      const at = sts
        .map((s) => s.updated_on ?? "")
        .sort()
        .at(-1);
      return { checks: worst(sts.map((s) => suite(s.state))), ...(at ? { at } : {}) };
    } catch (e) {
      deps.log.error(`${name}: statuses of ${p}@${sha} failed`, e);
      return { checks: null };
    }
  }

  async function diffOf(p: string, n: number): Promise<Change[]> {
    try {
      const bytes = Buffer.from(await (await get(`${R(p)}/pullrequests/${n}/diff`)).arrayBuffer());
      if (bytes.length > MAX_DIFF) return [];
      return [{ op: "put", path: `${dirOf(p)}/!${n}/files/diff.patch`, bytes }];
    } catch (e) {
      deps.log.error(`${name}: diff of ${p}!${n} failed`, e);
      return [];
    }
  }

  /** `heard`: a reconcile's, past the first sync, of an open PR */
  async function prTop(p: string, pr: Pull, diff: boolean, heard = false): Promise<Change[]> {
    const t = `!${pr.id}`;
    const sha = pr.source.commit?.hash;
    const { checks, at: when } = await checksOf(p, sha);
    const files = diff ? await diffOf(p, pr.id) : [];
    const fm: Record<string, unknown> = {
      id: t,
      thread: t,
      ts: iso(pr.created_on),
      user: nick(pr.author),
      title: pr.title,
      state: pr.state.toLowerCase(),
      head: pr.source.branch.name,
      base: pr.destination.branch.name,
      head_sha: sha ?? "",
    };
    if (checks) fm.checks = checks;
    if (files.length) fm.files = ["files/diff.patch"];
    const top: Change = { op: "put", path: at(p, t), frontmatter: fm, body: pr.description ?? "" };
    // a run is the statuses' newest time: a re-run moves it
    const result = heard && sha && deps.hasRef(ref(p, t)) ? ciOf(sha, checks, when) : undefined;
    const type = "repo:commit_status_updated";
    const routed = ciHeard({
      path: at(p, t),
      ref: ref(p, t),
      type,
      where: `${p}${t}`,
      sha: sha ?? "",
      ci: result,
      at: when,
    });
    return [top, ...files, ...routed];
  }

  function commentChange(p: string, thread: string, c: Comment): Change {
    const id = String(c.id);
    const fm: Record<string, unknown> = { id, thread, ts: iso(c.created_on), user: nick(c.user) };
    if (c.updated_on && iso(c.updated_on) !== iso(c.created_on)) fm.edited = iso(c.updated_on);
    if (c.inline) Object.assign(fm, { path: c.inline.path, line: c.inline.to ?? null });
    return { op: "put", path: at(p, thread, id), frontmatter: fm, body: c.content?.raw ?? "" };
  }

  function reviewChange(p: string, thread: string, u: User, ts: string, review: string): Change {
    const id = `review-${safe(idOf(u))}`;
    const fm = { id, thread, ts: iso(ts), user: nick(u), review };
    return { op: "put", path: at(p, thread, id), frontmatter: fm, body: "" };
  }

  function channelChange(r: Repo): Change {
    const fm = {
      id: r.full_name,
      name: r.full_name,
      default_branch: r.mainbranch?.name ?? "",
      topic: r.description ?? "",
    };
    return { op: "put", path: `${dirOf(r.full_name)}/channel.md`, frontmatter: fm, body: "" };
  }

  async function projects(): Promise<string[]> {
    try {
      // exact names need no listing, the one form a repository access token surely serves (it sees a single repository
      // and no `account` scope); globs list the workspaces they name; none (or a glob workspace) → `/user/workspaces`,
      // which takes `account`, so a workspace token only (`/user/permissions/repositories` died with the cross-workspace
      // APIs, 2026-04-14)
      const named = globs?.length && globs.every((g) => !g.includes("*")) ? globs : undefined;
      const repo = (p: string) =>
        json<Repo>(R(p)).catch((e) => {
          if (e instanceof HttpError && e.status === 404) return undefined;
          throw e;
        });
      let ws = [...new Set((globs ?? []).map((g) => g.split("/")[0] ?? ""))];
      if (!ws.length || !ws.every((w) => w && !w.includes("*")))
        ws = (await all<{ workspace: { slug: string } }>("/user/workspaces?pagelen=100", "values")).map(
          (x) => x.workspace.slug,
        );
      const listed = named
        ? (await Promise.all(named.map(repo))).filter((r) => r !== undefined)
        : (await Promise.all(ws.map((w) => all<Repo>(`/repositories/${w}?role=member&pagelen=100`, "values")))).flat();
      const out = listed.map((r) => r.full_name).filter((p) => matches(p, globs));
      projectCount = out.length;
      st.connected = true;
      st.error = undefined;
      return out;
    } catch (e) {
      st.connected = false;
      st.error = e instanceof Error ? e.message : String(e);
      throw e;
    }
  }

  return {
    events: (signal) => queue.events(signal),

    enqueue(e) {
      st.lastEvent = e.ts;
      return queue.push(e);
    },

    async webhook(req) {
      const h = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v]));
      if (!hmacVerify(`${name}-webhook`, req.body, h["x-hub-signature"])) return { ok: false };
      const type = h["x-event-key"];
      const key = h["x-request-uuid"];
      if (!type || !key) return { ok: false };
      let b: Payload;
      try {
        b = JSON.parse(req.body.toString("utf8")) as Payload;
      } catch {
        return { ok: false };
      }
      // a group/workspace/org hook also delivers projects outside `repos`: acknowledged, never mirrored
      const project = b.repository?.full_name;
      if (project && !matches(project, globs)) return { ok: true };
      return KIND.test(type) ? { ok: true, event: await toEvent(type, key, b) } : { ok: true };
    },

    async mirror(e): Promise<Mirrored> {
      const { type, body: b, prs } = e.payload as Wrapped;
      const p = b.repository?.full_name ?? "";
      const thread = threadOf(type, b);
      const none = { changes: [], wake: false };
      if (!thread) {
        if (!type.startsWith("repo:commit_status_") || !prs?.length) return none; // a push: the repo mirror's business
        const sha = shaOf(b) ?? "";
        const { checks, at: when } = await checksOf(p, sha);
        // the key a reconcile would route this result under (prs are those it is the head of): the second wakes nothing
        const ci = ciOf(sha, checks, when);
        const changes: Change[] = prs.map((n) => ({
          op: "patch",
          path: at(p, `!${n}`),
          frontmatter: { checks },
          ...(ci && { ci }),
        }));
        return { changes, wake: e.refs.some((r) => deps.hasRef(r)) };
      }
      const action = type.slice(type.indexOf(":") + 1);
      if (action.startsWith("comment_") && b.comment) {
        if (action === "comment_deleted" || b.comment.deleted)
          return { changes: [{ op: "delete", path: at(p, thread, String(b.comment.id)) }], wake: false };
        return { changes: [commentChange(p, thread, b.comment)], wake: action === "comment_created" };
      }
      if (b.issue) return { changes: [issueTop(p, b.issue)], wake: true };
      if (!b.pullrequest) return none;
      const r = b.approval ?? b.changes_request;
      if (action === "approved" || action === "changes_request_created") {
        if (!r) return none;
        const review = action === "approved" ? "approved" : "changes_requested";
        return { changes: [reviewChange(p, thread, r.user, r.date, review)], wake: true };
      }
      if ((action === "unapproved" || action === "changes_request_removed") && r)
        return { changes: [{ op: "delete", path: at(p, thread, `review-${safe(idOf(r.user))}`) }], wake: false };
      // the PR as it is now: a delivery can be late or out of order, and must not move head_sha back
      const pr = await json<Pull>(`${R(p)}/pullrequests/${b.pullrequest.id}`);
      return {
        changes: await prTop(p, pr, action === "created" || action === "updated"),
        wake:
          ["created", "fulfilled", "rejected"].includes(action) && (!!e.author || e.refs.some((r) => deps.hasRef(r))),
      };
    },

    scopes: projects,
    projects,

    async *history(project, cursor) {
      // null is the first sync (history, not news); "" a later pass on a project that had nothing at its first
      const later = cursor !== null;
      // BBQL datetimes are unquoted (a quoted value is a string); no `Z` in its grammar, and no offset means UTC
      const q = cursor ? `&q=${encodeURIComponent(`updated_on > ${cursor.replace(/Z$/, "")}`)}` : "";
      const changes: Change[] = [channelChange(await json<Repo>(R(project)))];
      let max = cursor ?? "";
      const seen = (ts: string) => {
        const t = iso(ts);
        if (t > max) max = t;
      };
      const comments = async (kind: string, id: number, thread: string) => {
        for (const c of await all<Comment>(`${R(project)}/${kind}/${id}/comments?pagelen=100`, "values")) {
          if (c.deleted) continue;
          const x = commentChange(project, thread, c);
          const type = kind === "issues" ? "issue:comment_created" : "pullrequest:comment_created";
          if (later) x.heard = await heard(project, thread, type, c.user, c.user, c.content?.raw ?? "", c.created_on);
          changes.push(x);
        }
      };
      const prHeard = async (pr: Pull): Promise<Change[]> => {
        const open = pr.state === "OPEN";
        const out = await prTop(project, pr, open, later && open);
        const top = out[0];
        const s = pr.state.toLowerCase();
        const type = s === "open" ? "created" : s === "merged" ? "fulfilled" : "rejected";
        const said = [pr.title, pr.description].filter(Boolean).join("\n\n");
        const by = s === "open" ? pr.author : (pr.closed_by ?? pr.author);
        if (later && top)
          top.heard = await heard(project, `!${pr.id}`, `pullrequest:${type}`, by, pr.author, said, pr.updated_on, s);
        return out;
      };
      let issues: Issue[] = [];
      try {
        issues = await all<Issue>(`${R(project)}/issues?pagelen=50${q}`, "values");
      } catch (e) {
        // the issue tracker API was removed (changelog, 2026-08-20); status unpublished, a sunset answers 404 or 410
        if (!(e instanceof HttpError && (e.status === 404 || e.status === 410))) throw e;
      }
      for (const i of issues) {
        seen(i.updated_on);
        const top = issueTop(project, i);
        const said = [i.title, i.content?.raw].filter(Boolean).join("\n\n");
        if (later)
          top.heard = await heard(project, `#${i.id}`, "issue:created", i.reporter, i.reporter, said, i.created_on);
        changes.push(top);
        await comments("issues", i.id, `#${i.id}`);
      }
      const done = "state=MERGED&state=DECLINED&state=SUPERSEDED";
      for (const pr of await all<Pull>(`${R(project)}/pullrequests?${done}&pagelen=50${q}`, "values")) {
        seen(pr.updated_on);
        changes.push(...(await prHeard(pr)));
        await comments("pullrequests", pr.id, `!${pr.id}`);
      }
      // open PRs whole: state, statuses, diff, comments and approvals (a status moves without touching updated_on)
      for (const listed of await all<Pull>(`${R(project)}/pullrequests?state=OPEN&pagelen=50`, "values")) {
        seen(listed.updated_on);
        const pr = await json<Pull>(`${R(project)}/pullrequests/${listed.id}`);
        changes.push(...(await prHeard(pr)));
        await comments("pullrequests", pr.id, `!${pr.id}`);
        for (const x of pr.participants ?? []) {
          if (!x.approved && x.state !== "changes_requested") continue;
          const ts = x.participated_on ?? pr.updated_on;
          const c = reviewChange(project, `!${pr.id}`, x.user, ts, x.approved ? "approved" : "changes_requested");
          const type = x.approved ? "pullrequest:approved" : "pullrequest:changes_request_created";
          if (later) c.heard = await heard(project, `!${pr.id}`, type, x.user, undefined, "", ts);
          changes.push(c);
        }
      }
      yield { changes, cursor: max };
    },

    clone: (project) => `https://bitbucket.org/${project}.git`,

    pushed(e) {
      const w = e.payload as Wrapped;
      return w.type === "repo:push" ? (w.body.repository?.full_name ?? null) : null;
    },

    status: () => ({ ...st, notes: [`projects mirrored: ${projectCount}`] }),
  };
}
