/**
 * GitHub (17-github.md): App webhooks through the tunnel (verified with `<name>-webhook`), REST history, the delivery
 * log. Every request carries the placeholder `hortus-secret-<name>` through `deps.fetch` (the pipeline as role core,
 * where the transform turns it into a read-only installation token); this module never sees a token.
 */
import type { Change, ConnectorDeps, ConnectorStatus, Event, Forge, Mirrored } from "../types.ts";
import { hmacVerify } from "../vault/ops.ts";
import { dirOf, eventQueue, matches, worst } from "./forge.ts";

const MAX_DIFF = 20 * 1024 * 1024;
const MEMBER = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const EVENTS = new Set([
  "issues",
  "issue_comment",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "push",
  "check_suite",
  "installation_repositories",
  "repository",
]);

interface User {
  login: string;
  type?: string;
}
interface Issue {
  number: number;
  title: string;
  body?: string | null;
  state: string;
  labels?: { name: string }[];
  assignees?: User[];
  user: User;
  created_at: string;
  updated_at: string;
  author_association?: string;
  pull_request?: unknown;
}
interface Pull extends Issue {
  merged?: boolean;
  head: { ref: string; sha: string };
  base: { ref: string };
}
interface Comment {
  id: number;
  body?: string | null;
  user: User;
  created_at: string;
  updated_at: string;
  author_association?: string;
  html_url?: string;
  issue_url?: string;
  path?: string;
  line?: number | null;
}
interface Review {
  id: number;
  body?: string | null;
  state: string;
  user: User;
  submitted_at: string;
  author_association?: string;
}
interface Suite {
  head_sha: string;
  status: string;
  conclusion: string | null;
  latest_check_runs_count?: number;
  pull_requests?: { number: number }[];
}
interface Repo {
  full_name: string;
  default_branch?: string;
  description?: string | null;
}
interface Payload {
  action?: string;
  issue?: Issue;
  comment?: Comment;
  pull_request?: Pull;
  review?: Review;
  check_suite?: Suite;
  repository?: Repo;
  repositories_added?: Repo[];
  sender?: User;
}
/** events.payload: the delivery's event name and body */
interface Wrapped {
  type: string;
  body: Payload;
}
interface Delivery {
  id: number;
  guid: string;
  delivered_at: string;
  event: string;
}

export async function create(deps: ConnectorDeps): Promise<Forge> {
  const { name, config: cfg } = deps;
  const host = cfg.host ?? "github.com";
  const api = (cfg.api ?? (cfg.host ? `https://${cfg.host}/api/v3` : "https://api.github.com")).replace(/\/$/, "");
  const globs = cfg.repos as string[] | undefined;
  const st: ConnectorStatus = { connected: false };
  const queue = eventQueue();
  let projectCount = 0;
  const headers = {
    authorization: `Bearer hortus-secret-${name}`,
    accept: "application/vnd.github+json",
    "user-agent": "hortus",
  };

  async function get(url: string, accept?: string): Promise<Response> {
    const res = await deps.fetch(url.startsWith("http") ? url : `${api}${url}`, {
      headers: accept ? { ...headers, accept } : headers,
    });
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`github GET ${url}: HTTP ${res.status}`);
    }
    return res;
  }
  const json = async <T>(url: string): Promise<T> => (await (await get(url)).json()) as T;
  /** Every page (`Link: rel="next"`); `key` picks the list out of an object body. */
  async function all<T>(url: string, key?: string): Promise<T[]> {
    const out: T[] = [];
    for (let next: string | undefined = url; next; ) {
      const res = await get(next);
      const b = (await res.json()) as Record<string, T[]> | T[];
      out.push(...((key ? (b as Record<string, T[]>)[key] : b) as T[]));
      next = res.headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
    }
    return out;
  }

  const ref = (repo: string, thread: string) => `${name}:${repo}:${thread}`;
  const at = (repo: string, thread: string, file = thread) => `${dirOf(repo)}/${thread}/${file}.md`;

  function threadOf(type: string, p: Payload): string | null {
    if (type === "issues" && p.issue) return `#${p.issue.number}`;
    if (type === "issue_comment" && p.issue) return `${p.issue.pull_request ? "!" : "#"}${p.issue.number}`;
    if (type.startsWith("pull_request") && p.pull_request) return `!${p.pull_request.number}`;
    return null;
  }

  function toEvent(type: string, key: string, p: Payload): Event {
    const repo = p.repository?.full_name ?? "";
    const thread = threadOf(type, p);
    const obj: { title?: string; body?: string | null; updated_at?: string; author_association?: string } | undefined =
      p.comment ?? p.review ?? p.pull_request ?? p.issue;
    const ci = type === "check_suite";
    const prs = ci ? (p.check_suite?.pull_requests ?? []).map((x) => ref(repo, `!${x.number}`)) : [];
    const s = p.check_suite;
    const result = s && `${s.conclusion ?? s.status} on ${s.head_sha.slice(0, 7)}`;
    // an issue's order is in its body: the title alone reached the brief, and the Planner filled in the rest (round 18)
    const opened = [obj?.title, obj?.body].filter(Boolean).join("\n\n");
    const text = p.comment?.body ?? p.review?.body ?? (opened || (result ?? (p as { ref?: string }).ref ?? ""));
    return {
      dof: name,
      key,
      ts: (p.comment?.updated_at ?? p.review?.submitted_at ?? obj?.updated_at ?? new Date().toISOString()).replace(
        /\.\d+Z$/,
        "Z",
      ),
      payload: { type, body: p } satisfies Wrapped,
      // CI results carry no author (they never start work) and are not bot traffic: they must reach their task
      author: p.sender && !ci ? { user: p.sender.login, member: MEMBER.has(obj?.author_association ?? "NONE") } : null,
      bot: !ci && p.sender?.type === "Bot",
      summary: `${type}${p.action ? `.${p.action}` : ""} ${repo}${thread ?? ""} by ${p.sender?.login ?? "?"}: ${text}`,
      refs: thread ? [ref(repo, thread)] : prs,
    };
  }

  const people = (us: User[] | undefined) => (us ?? []).map((u) => u.login);
  const labels = (i: Issue) => (i.labels ?? []).map((l) => l.name);

  function issueTop(repo: string, i: Issue): Change {
    const t = `#${i.number}`;
    const fm = { id: t, thread: t, ts: i.created_at, user: i.user.login, title: i.title, state: i.state };
    return {
      op: "put",
      path: at(repo, t),
      frontmatter: { ...fm, labels: labels(i), assignees: people(i.assignees) },
      body: i.body ?? "",
    };
  }

  async function checksOf(repo: string, sha: string, fallback: Suite[] = []): Promise<string | null> {
    try {
      const { check_suites } = await json<{ check_suites: Suite[] }>(`/repos/${repo}/commits/${sha}/check-suites`);
      // GitHub opens a suite per checks-writing App on every push: one that never ran stays `queued`, for ever
      return worst(check_suites.filter((s) => s.latest_check_runs_count !== 0));
    } catch (e) {
      deps.log.error(`${name}: check suites of ${repo}@${sha} failed`, e);
      return worst(fallback);
    }
  }

  async function diffOf(repo: string, n: number): Promise<Change[]> {
    try {
      const res = await get(`/repos/${repo}/pulls/${n}`, "application/vnd.github.diff");
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > MAX_DIFF) return [];
      return [{ op: "put", path: `${dirOf(repo)}/!${n}/files/diff.patch`, bytes }];
    } catch (e) {
      deps.log.error(`${name}: diff of ${repo}!${n} failed`, e);
      return [];
    }
  }

  /** The PR's top message (v6's PR example) and, with `diff`, its `files/diff.patch`. */
  async function prTop(repo: string, pr: Pull, diff: boolean): Promise<Change[]> {
    const t = `!${pr.number}`;
    const checks = await checksOf(repo, pr.head.sha);
    const files = diff ? await diffOf(repo, pr.number) : [];
    const fm: Record<string, unknown> = {
      id: t,
      thread: t,
      ts: pr.created_at,
      user: pr.user.login,
      title: pr.title,
      state: pr.merged ? "merged" : pr.state,
      labels: labels(pr),
      assignees: people(pr.assignees),
      head: pr.head.ref,
      base: pr.base.ref,
      head_sha: pr.head.sha,
    };
    if (checks) fm.checks = checks;
    if (files.length) fm.files = ["files/diff.patch"];
    return [{ op: "put", path: at(repo, t), frontmatter: fm, body: pr.body ?? "" }, ...files];
  }

  function commentChange(repo: string, thread: string, c: Comment, review = false): Change {
    const id = review ? `rc-${c.id}` : String(c.id);
    const fm: Record<string, unknown> = { id, thread, ts: c.created_at, user: c.user.login };
    if (c.updated_at && c.updated_at !== c.created_at) fm.edited = c.updated_at;
    if (review) Object.assign(fm, { path: c.path ?? "", line: c.line ?? null });
    return { op: "put", path: at(repo, thread, id), frontmatter: fm, body: c.body ?? "" };
  }

  function reviewChange(repo: string, thread: string, r: Review): Change {
    const id = `review-${r.id}`;
    const fm = { id, thread, ts: r.submitted_at, user: r.user.login, review: r.state.toLowerCase() };
    return { op: "put", path: at(repo, thread, id), frontmatter: fm, body: r.body ?? "" };
  }

  function channelChange(r: Repo): Change {
    const fm = {
      id: r.full_name,
      name: r.full_name,
      default_branch: r.default_branch ?? "",
      topic: r.description ?? "",
    };
    return { op: "put", path: `${dirOf(r.full_name)}/channel.md`, frontmatter: fm, body: "" };
  }

  async function projects(): Promise<string[]> {
    try {
      const repos = await all<Repo>("/installation/repositories?per_page=100", "repositories");
      const out = repos.map((r) => r.full_name).filter((p) => matches(p, globs));
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
      if (!hmacVerify(`${name}-webhook`, req.body, h["x-hub-signature-256"])) return { ok: false };
      const type = h["x-github-event"];
      const key = h["x-github-delivery"];
      if (!type || !key) return { ok: false };
      let p: Payload;
      try {
        p = JSON.parse(req.body.toString("utf8")) as Payload;
      } catch {
        return { ok: false };
      }
      // a group/workspace/org hook also delivers projects outside `repos`: acknowledged, never mirrored
      const project = p.repository?.full_name;
      if (project && !matches(project, globs)) return { ok: true };
      return EVENTS.has(type) ? { ok: true, event: toEvent(type, key, p) } : { ok: true };
    },

    async mirror(e): Promise<Mirrored> {
      const { type, body: p } = e.payload as Wrapped;
      const repo = p.repository?.full_name ?? "";
      const thread = threadOf(type, p);
      const none = { changes: [], wake: false };
      switch (type) {
        case "issues": {
          if (!p.issue || !thread) return none;
          if (p.action === "deleted") return { changes: [{ op: "delete", path: at(repo, thread) }], wake: false };
          return { changes: [issueTop(repo, p.issue)], wake: true };
        }
        case "issue_comment": {
          if (!p.comment || !thread) return none;
          if (p.action === "deleted")
            return { changes: [{ op: "delete", path: at(repo, thread, String(p.comment.id)) }], wake: false };
          return { changes: [commentChange(repo, thread, p.comment)], wake: true };
        }
        case "pull_request": {
          if (!p.pull_request) return none;
          const a = p.action ?? "";
          const diff = ["opened", "reopened", "synchronize", "edited"].includes(a);
          // the PR as it is now: a delivery can be late or out of order, and must not move head_sha back
          const pr = await json<Pull>(`/repos/${repo}/pulls/${p.pull_request.number}`);
          return {
            changes: await prTop(repo, pr, diff),
            wake: ["opened", "closed", "reopened"].includes(a),
          };
        }
        case "pull_request_review": {
          if (!p.review || !thread) return none;
          return { changes: [reviewChange(repo, thread, p.review)], wake: p.action === "submitted" };
        }
        case "pull_request_review_comment": {
          if (!p.comment || !thread) return none;
          if (p.action === "deleted")
            return { changes: [{ op: "delete", path: at(repo, thread, `rc-${p.comment.id}`) }], wake: false };
          return { changes: [commentChange(repo, thread, p.comment, true)], wake: p.action === "created" };
        }
        case "check_suite": {
          const s = p.check_suite;
          if (!s?.pull_requests?.length) return none;
          // `checks` is the PR head's, whatever commit this suite ran on; only a result on a head wakes
          const prs = await Promise.all(s.pull_requests.map((x) => json<Pull>(`/repos/${repo}/pulls/${x.number}`)));
          const onHead = (pr: Pull) => pr.head.sha === s.head_sha;
          const changes = await Promise.all(
            prs.map(
              async (pr): Promise<Change> => ({
                op: "patch",
                path: at(repo, `!${pr.number}`),
                frontmatter: { checks: await checksOf(repo, pr.head.sha, onHead(pr) ? [s] : []) },
              }),
            ),
          );
          return { changes, wake: prs.some((pr) => onHead(pr) && deps.hasRef(ref(repo, `!${pr.number}`))) };
        }
        case "repository":
          return p.action === "created" && p.repository
            ? { changes: [channelChange(p.repository)], wake: false }
            : none;
        case "installation_repositories": {
          const changes: Change[] = [];
          for (const r of (p.repositories_added ?? []).filter((x) => matches(x.full_name, globs))) {
            try {
              changes.push(channelChange(await json<Repo>(`/repos/${r.full_name}`)));
            } catch (err) {
              deps.log.error(`${name}: repo ${r.full_name} failed`, err);
            }
          }
          return { changes, wake: false };
        }
        default:
          return none; // push (the repo mirror's business), anything else
      }
    },

    scopes: projects,
    projects,

    async *history(project, cursor) {
      const since = cursor ? `&since=${encodeURIComponent(cursor)}` : "";
      const changes: Change[] = [channelChange(await json<Repo>(`/repos/${project}`))];
      let max = cursor ?? "";
      const seen = (ts: string) => {
        if (ts > max) max = ts;
      };
      for (const i of await all<Issue>(`/repos/${project}/issues?state=all&per_page=100${since}`)) {
        seen(i.updated_at);
        if (!i.pull_request) changes.push(issueTop(project, i));
        else if (i.state !== "open")
          changes.push(...(await prTop(project, await json<Pull>(`/repos/${project}/pulls/${i.number}`), false)));
      }
      for (const c of await all<Comment>(`/repos/${project}/issues/comments?per_page=100${since}`)) {
        seen(c.updated_at);
        const n = c.issue_url?.match(/\/issues\/(\d+)$/)?.[1];
        if (n) changes.push(commentChange(project, `${c.html_url?.includes("/pull/") ? "!" : "#"}${n}`, c));
      }
      // open PRs whole: state, checks, diff, reviews and review comments (CI moves without touching updated_at)
      for (const pr of await all<Pull>(`/repos/${project}/pulls?state=open&per_page=100`)) {
        const t = `!${pr.number}`;
        changes.push(...(await prTop(project, pr, true)));
        for (const r of await all<Review>(`/repos/${project}/pulls/${pr.number}/reviews?per_page=100`))
          changes.push(reviewChange(project, t, r));
        for (const c of await all<Comment>(`/repos/${project}/pulls/${pr.number}/comments?per_page=100`))
          changes.push(commentChange(project, t, c, true));
      }
      yield { changes, cursor: max };
    },

    clone: (project) => `https://${host}/${project}.git`,

    pushed(e) {
      const w = e.payload as Wrapped;
      return w.type === "push" ? (w.body.repository?.full_name ?? null) : null;
    },

    async *redeliveries(since, seen) {
      const done = new Set<string>();
      for (const d of await all<Delivery>("/app/hook/deliveries?per_page=100")) {
        if (d.delivered_at < since || done.has(d.guid) || seen(d.guid) || !EVENTS.has(d.event)) continue;
        done.add(d.guid);
        const { payload } = (await json<{ request: { payload: Payload | null } }>(`/app/hook/deliveries/${d.id}`))
          .request;
        // the log holds what `webhook()` acknowledged and dropped too: a project outside `repos` stays out
        const project = payload?.repository?.full_name;
        if (!payload || (project && !matches(project, globs))) continue;
        yield { key: d.guid, event: toEvent(d.event, d.guid, payload) };
      }
    },

    status: () => ({ ...st, notes: [`projects mirrored: ${projectCount}`] }),
  };
}
