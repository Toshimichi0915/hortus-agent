/**
 * GitLab (18-gitlab-bitbucket.md): project or group webhooks through the tunnel (`X-Gitlab-Token` checked with `equals`
 * against `<name>-webhook`), REST v4 history. A static project/group access token: every request carries the
 * placeholder `hortus-secret-<name>` in `PRIVATE-TOKEN` through `deps.fetch` (the pipeline as role core). Project ids
 * are `group/…/project`, URL-encoded in API paths; their channel directory is `group__…__project`.
 */
import type { Change, ConnectorDeps, ConnectorStatus, Event, Forge, Mirrored } from "../types.ts";
import { equals } from "../vault/ops.ts";
import { cached, dirOf, eventQueue, HttpError, iso, matches, oneLine, rest } from "./forge.ts";

const MAX_DIFF = 20 * 1024 * 1024;
const HOUR = 3600_000;
/** Reporter and up */
const MEMBER_LEVEL = 20;
const KINDS = new Set(["issue", "note", "merge_request", "push", "pipeline"]);
/** project and group access tokens act as `project_<id>_bot_<hash>` / `group_<id>_bot_<hash>` */
const BOT_NAME = /^(project|group)_\d+_bot/;

interface User {
  id: number;
  username: string;
  bot?: boolean;
}
interface Project {
  path_with_namespace: string;
  default_branch?: string | null;
  description?: string | null;
}
interface Issue {
  iid: number;
  title: string;
  description?: string | null;
  state: string;
  labels?: string[];
  assignees?: User[];
  author: User;
  created_at: string;
  updated_at: string;
}
interface MR extends Issue {
  source_branch: string;
  target_branch: string;
  sha: string;
  head_pipeline?: { id: number; status: string } | null;
}
interface Note {
  id: number;
  body?: string;
  note?: string;
  author?: User;
  system?: boolean;
  noteable_type?: string;
  created_at: string;
  updated_at: string;
  position?: { new_path?: string; new_line?: number | null } | null;
}
interface FileChange {
  old_path: string;
  new_path: string;
  diff: string;
  new_file?: boolean;
  deleted_file?: boolean;
  renamed_file?: boolean;
  a_mode?: string;
  b_mode?: string;
}
interface Payload {
  object_kind: string;
  user?: User;
  user_id?: number;
  user_username?: string;
  project?: Project;
  ref?: string;
  object_attributes?: {
    iid?: number;
    id?: number;
    title?: string;
    note?: string;
    description?: string;
    action?: string;
    state?: string;
    status?: string;
    sha?: string;
    ref?: string;
    noteable_type?: string;
    system?: boolean;
    created_at?: string;
    updated_at?: string;
    position?: Note["position"];
  };
  issue?: { iid: number };
  merge_request?: { iid: number } | null;
  commit?: { id: string };
}
/** events.payload: the hook's kind and body, plus the MRs a pipeline belongs to (looked up at receipt) */
interface Wrapped {
  type: string;
  body: Payload;
  mrs?: number[];
}

const state = (s: string) => (s === "opened" ? "open" : s);

/** `success`/`skipped` pass, `failed`/`canceled` fail, anything still to run is `pending`. */
function ci(status: string | undefined): string | null {
  if (!status) return null;
  if (status === "success" || status === "skipped") return "success";
  if (status === "failed" || status === "canceled") return "failure";
  return "pending";
}

/** `/changes` → one unified diff: git's header per file, then GitLab's hunk text. */
export function patchOf(changes: FileChange[]): string {
  return changes
    .map((c) => {
      const out = [`diff --git a/${c.old_path} b/${c.new_path}`];
      if (c.new_file) out.push(`new file mode ${c.b_mode ?? "100644"}`);
      if (c.deleted_file) out.push(`deleted file mode ${c.a_mode ?? "100644"}`);
      if (c.renamed_file) out.push(`rename from ${c.old_path}`, `rename to ${c.new_path}`);
      if (c.diff)
        out.push(
          `--- ${c.new_file ? "/dev/null" : `a/${c.old_path}`}`,
          `+++ ${c.deleted_file ? "/dev/null" : `b/${c.new_path}`}`,
          c.diff.replace(/\n?$/, ""),
        );
      return `${out.join("\n")}\n`;
    })
    .join("");
}

export async function create(deps: ConnectorDeps): Promise<Forge> {
  const { name, config: cfg } = deps;
  const host = cfg.host ?? "gitlab.com";
  const api = (cfg.api ?? `https://${host}/api/v4`).replace(/\/$/, "");
  const globs = cfg.repos as string[] | undefined;
  const st: ConnectorStatus = { connected: false };
  const queue = eventQueue();
  let projectCount = 0;
  const { json, all } = rest(deps, api, { "private-token": `hortus-secret-${name}`, "user-agent": "hortus" });
  const P = (p: string) => `/projects/${encodeURIComponent(p)}`;

  let self: Promise<User | undefined> | undefined;
  /** the token's own user (its notes are ours); retried after a failure */
  const me = () =>
    (self ??= json<User>("/user").catch((e) => {
      deps.log.error(`${name}: GET /user failed`, e);
      self = undefined;
      return undefined;
    }));
  const memberOf = cached(HOUR, async (key: string) => {
    const [p = "", uid = ""] = key.split("\0");
    try {
      return (await json<{ access_level: number }>(`${P(p)}/members/all/${uid}`)).access_level >= MEMBER_LEVEL;
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return false;
      throw e;
    }
  });
  async function member(p: string, uid: number | undefined): Promise<boolean> {
    if (uid === undefined) return false;
    try {
      return await memberOf(`${p}\0${uid}`);
    } catch (e) {
      deps.log.error(`${name}: member check failed`, e);
      return false;
    }
  }

  const ref = (p: string, thread: string) => `${name}:${p}:${thread}`;
  const at = (p: string, thread: string, file = thread) => `${dirOf(p)}/${thread}/${file}.md`;

  function threadOf(b: Payload): string | null {
    const a = b.object_attributes;
    if (b.object_kind === "issue" && a?.iid) return `#${a.iid}`;
    if (b.object_kind === "merge_request" && a?.iid) return `!${a.iid}`;
    if (b.object_kind === "note") {
      if (b.issue) return `#${b.issue.iid}`;
      if (b.merge_request) return `!${b.merge_request.iid}`;
      if (b.commit) return `commit-${b.commit.id.slice(0, 12)}`;
    }
    return null;
  }

  async function toEvent(type: string, key: string, b: Payload): Promise<Event> {
    const p = b.project?.path_with_namespace ?? "";
    const thread = threadOf(b);
    const a = b.object_attributes;
    const pipeline = type === "pipeline";
    let mrs: number[] = [];
    if (pipeline) {
      if (b.merge_request?.iid) mrs = [b.merge_request.iid];
      else if (a?.ref && a.sha) {
        try {
          const open = await all<MR>(
            `${P(p)}/merge_requests?state=opened&source_branch=${encodeURIComponent(a.ref)}&per_page=100`,
          );
          mrs = open.filter((m) => m.sha === a.sha).map((m) => m.iid);
        } catch (e) {
          deps.log.error(`${name}: MRs of ${p}@${a.ref} failed`, e);
        }
      }
    }
    const u: User | undefined =
      b.user ?? (b.user_username ? { id: b.user_id ?? -1, username: b.user_username } : undefined);
    const own = u ? (await me())?.id === u.id : false;
    const bot = !pipeline && !!u && (own || u.bot === true || BOT_NAME.test(u.username));
    const result = pipeline && a?.sha ? `${a.status} on ${a.sha.slice(0, 7)}` : a?.status;
    const text = oneLine(a?.note ?? a?.title ?? result ?? b.ref);
    return {
      dof: name,
      key,
      ts: iso(a?.updated_at ?? a?.created_at),
      payload: { type, body: b, ...(pipeline ? { mrs } : {}) } satisfies Wrapped,
      // pipelines carry no author (they never start work) and are not bot traffic: they must reach their task
      author: u && !pipeline ? { user: u.username, member: await member(p, u.id) } : null,
      bot,
      summary: `${type}${a?.action ? `.${a.action}` : ""} ${p}${thread ?? ""} by ${u?.username ?? "?"}: ${text}`,
      refs: thread ? [ref(p, thread)] : mrs.map((n) => ref(p, `!${n}`)),
    };
  }

  const people = (us: User[] | undefined) => (us ?? []).map((x) => x.username);

  function issueTop(p: string, i: Issue): Change {
    const t = `#${i.iid}`;
    const fm = { id: t, thread: t, ts: iso(i.created_at), user: i.author.username, title: i.title };
    return {
      op: "put",
      path: at(p, t),
      frontmatter: { ...fm, state: state(i.state), labels: i.labels ?? [], assignees: people(i.assignees) },
      body: i.description ?? "",
    };
  }

  async function checksOf(p: string, sha: string): Promise<string | null> {
    try {
      return ci((await json<{ status: string }[]>(`${P(p)}/pipelines?sha=${sha}&per_page=1`))[0]?.status);
    } catch (e) {
      deps.log.error(`${name}: pipelines of ${p}@${sha} failed`, e);
      return null;
    }
  }

  async function diffOf(p: string, iid: number): Promise<Change[]> {
    try {
      const { changes } = await json<{ changes: FileChange[] }>(`${P(p)}/merge_requests/${iid}/changes`);
      const bytes = Buffer.from(patchOf(changes));
      if (bytes.length > MAX_DIFF) return [];
      return [{ op: "put", path: `${dirOf(p)}/!${iid}/files/diff.patch`, bytes }];
    } catch (e) {
      deps.log.error(`${name}: changes of ${p}!${iid} failed`, e);
      return [];
    }
  }

  async function prTop(p: string, mr: MR, diff: boolean): Promise<Change[]> {
    const t = `!${mr.iid}`;
    const checks = await checksOf(p, mr.sha);
    const files = diff ? await diffOf(p, mr.iid) : [];
    const fm: Record<string, unknown> = {
      id: t,
      thread: t,
      ts: iso(mr.created_at),
      user: mr.author.username,
      title: mr.title,
      state: state(mr.state),
      labels: mr.labels ?? [],
      assignees: people(mr.assignees),
      head: mr.source_branch,
      base: mr.target_branch,
      head_sha: mr.sha,
    };
    if (checks) fm.checks = checks;
    if (files.length) fm.files = ["files/diff.patch"];
    return [{ op: "put", path: at(p, t), frontmatter: fm, body: mr.description ?? "" }, ...files];
  }

  function noteChange(p: string, thread: string, n: Note, user: string): Change {
    const id = String(n.id);
    const fm: Record<string, unknown> = { id, thread, ts: iso(n.created_at), user };
    if (n.updated_at && iso(n.updated_at) !== iso(n.created_at)) fm.edited = iso(n.updated_at);
    if (n.system) fm.system = true;
    if (n.position?.new_path) Object.assign(fm, { path: n.position.new_path, line: n.position.new_line ?? null });
    return { op: "put", path: at(p, thread, id), frontmatter: fm, body: n.body ?? n.note ?? "" };
  }

  function reviewChange(p: string, thread: string, u: User, ts: string): Change {
    const id = `review-${u.id}`;
    const fm = { id, thread, ts: iso(ts), user: u.username, review: "approved" };
    return { op: "put", path: at(p, thread, id), frontmatter: fm, body: "" };
  }

  function channelChange(r: Project): Change {
    const fm = {
      id: r.path_with_namespace,
      name: r.path_with_namespace,
      default_branch: r.default_branch ?? "",
      topic: r.description ?? "",
    };
    return { op: "put", path: `${dirOf(r.path_with_namespace)}/channel.md`, frontmatter: fm, body: "" };
  }

  async function projects(): Promise<string[]> {
    try {
      const list = await all<Project>("/projects?membership=true&min_access_level=30&simple=true&per_page=100");
      const out = list.map((r) => r.path_with_namespace).filter((p) => matches(p, globs));
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

  async function approvals(p: string, iid: number): Promise<Change[]> {
    const a = await json<{ approved_by?: { user: User }[]; updated_at?: string }>(
      `${P(p)}/merge_requests/${iid}/approvals`,
    );
    return (a.approved_by ?? []).map((x) => reviewChange(p, `!${iid}`, x.user, a.updated_at ?? ""));
  }

  return {
    events: (signal) => queue.events(signal),

    enqueue(e) {
      st.lastEvent = e.ts;
      return queue.push(e);
    },

    async webhook(req) {
      const h = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v]));
      if (!equals(`${name}-webhook`, h["x-gitlab-token"])) return { ok: false };
      const key = h["x-gitlab-event-uuid"];
      if (!key) return { ok: false };
      let b: Payload;
      try {
        b = JSON.parse(req.body.toString("utf8")) as Payload;
      } catch {
        return { ok: false };
      }
      // a group/workspace/org hook also delivers projects outside `repos`: acknowledged, never mirrored
      const project = b.project?.path_with_namespace;
      if (project && !matches(project, globs)) return { ok: true };
      return KINDS.has(b.object_kind) ? { ok: true, event: await toEvent(b.object_kind, key, b) } : { ok: true };
    },

    async mirror(e): Promise<Mirrored> {
      const { type, body: b, mrs } = e.payload as Wrapped;
      const p = b.project?.path_with_namespace ?? "";
      const thread = threadOf(b);
      const a = b.object_attributes;
      const none = { changes: [], wake: false };
      switch (type) {
        case "issue": {
          if (!a?.iid) return none;
          return { changes: [issueTop(p, await json<Issue>(`${P(p)}/issues/${a.iid}`))], wake: true };
        }
        case "note": {
          if (!a?.id || !thread || !b.user) return none;
          const n = { ...a, id: a.id, created_at: a.created_at ?? "", updated_at: a.updated_at ?? "" };
          return { changes: [noteChange(p, thread, n, b.user.username)], wake: !a.system };
        }
        case "merge_request": {
          if (!a?.iid || !thread) return none;
          const act = a.action ?? "";
          if (act === "approved" && b.user)
            return { changes: [reviewChange(p, thread, b.user, a.updated_at ?? "")], wake: true };
          if (act === "unapproved" && b.user)
            return { changes: [{ op: "delete", path: at(p, thread, `review-${b.user.id}`) }], wake: false };
          const mr = await json<MR>(`${P(p)}/merge_requests/${a.iid}`);
          return {
            changes: await prTop(p, mr, ["open", "reopen", "update"].includes(act)),
            wake: ["open", "close", "reopen", "merge"].includes(act),
          };
        }
        case "pipeline": {
          if (!mrs?.length || !a?.sha) return none;
          // `checks` is the MR head's, whatever commit this pipeline ran on; only a result on a head wakes. A
          // merged-results pipeline runs on a merge commit: `head_pipeline` is how it is the head's.
          const open = await Promise.all(mrs.map((n) => json<MR>(`${P(p)}/merge_requests/${n}`)));
          const onHead = (m: MR) => m.sha === a.sha || m.head_pipeline?.id === a.id;
          const changes = await Promise.all(
            open.map(
              async (m): Promise<Change> => ({
                op: "patch",
                path: at(p, `!${m.iid}`),
                frontmatter: {
                  checks: ci(onHead(m) ? a.status : m.head_pipeline?.status) ?? (await checksOf(p, m.sha)),
                },
              }),
            ),
          );
          return { changes, wake: open.some((m) => onHead(m) && deps.hasRef(ref(p, `!${m.iid}`))) };
        }
        default:
          return none; // push (the repo mirror's business)
      }
    },

    scopes: projects,
    projects,

    async *history(project, cursor) {
      const after = cursor ? `&updated_after=${encodeURIComponent(cursor)}` : "";
      const changes: Change[] = [channelChange(await json<Project>(P(project)))];
      let max = cursor ?? "";
      const seen = (ts: string) => {
        const t = iso(ts);
        if (t > max) max = t;
      };
      const notes = async (kind: string, iid: number, thread: string) => {
        for (const n of await all<Note>(`${P(project)}/${kind}/${iid}/notes?per_page=100`))
          changes.push(noteChange(project, thread, n, n.author?.username ?? ""));
      };
      for (const i of await all<Issue>(`${P(project)}/issues?scope=all&per_page=100${after}`)) {
        seen(i.updated_at);
        changes.push(issueTop(project, i));
        await notes("issues", i.iid, `#${i.iid}`);
      }
      for (const mr of await all<MR>(`${P(project)}/merge_requests?state=all&per_page=100${after}`)) {
        seen(mr.updated_at);
        if (mr.state === "opened") continue; // below, whole
        changes.push(...(await prTop(project, mr, false)));
        await notes("merge_requests", mr.iid, `!${mr.iid}`);
      }
      // open MRs whole: state, checks, diff, notes and approvals (a pipeline moves without touching updated_at)
      for (const mr of await all<MR>(`${P(project)}/merge_requests?state=opened&per_page=100`)) {
        changes.push(...(await prTop(project, mr, true)));
        await notes("merge_requests", mr.iid, `!${mr.iid}`);
        changes.push(...(await approvals(project, mr.iid)));
      }
      yield { changes, cursor: max };
    },

    clone: (project) => `https://${host}/${project}.git`,

    pushed(e) {
      const w = e.payload as Wrapped;
      return w.type === "push" ? (w.body.project?.path_with_namespace ?? null) : null;
    },

    status: () => ({ ...st, notes: [`projects mirrored: ${projectCount}`] }),
  };
}
