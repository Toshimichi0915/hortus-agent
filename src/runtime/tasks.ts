/**
 * Task lifecycle: rows, directories, inbox writes, stop, close, budget, and the task.json a start
 * writes. Statuses: queued → running → waiting → (queued → running …) → done | failed. The dispatcher starts and ends
 * sessions; this file never spawns anything. The owner's RPCs (task.open, task.send, …) are defined at the bottom.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { jar } from "../browser/jar.ts";
import type { Config } from "../config.ts";
import { gitOf } from "../connectors/forge.ts";
import { bus } from "../console/events.ts";
import { crashPoint } from "../crash.ts";
import type { Ctx } from "../ctx.ts";
import { now, readable } from "../db.ts";
import { rmTree } from "../hostile.ts";
import { taskId } from "../ids.ts";
import { publishLog, removeLog, renderSession } from "../mirror/index.ts";
import * as paths from "../paths.ts";
import { define } from "../rpc.ts";
import {
  GOES_ON,
  type InboxMsg,
  RpcError,
  type TaskJson,
  type TaskKind,
  type TaskScope,
  type TaskStatus,
} from "../types.ts";
import { providerSecret } from "../vault/providers.ts";
import { read as readVault } from "../vault/vault.ts";

export interface TaskRow {
  id: string;
  kind: TaskKind;
  title: string;
  brief: string;
  status: TaskStatus;
  scope: string | null;
  origins: string | null;
  budget: string | null;
  usage: string | null;
  metered: number;
  project: string | null;
  runtime: string | null;
  parent: string | null;
  event_keys: string | null;
  summary: string | null;
  created: string;
  updated: string;
  closed: string | null;
  started: string | null;
  hours: number;
  cwd: string | null;
  error: string | null;
}

export interface CreateInput {
  kind: TaskKind;
  title: string;
  brief: string;
  /** credentials default to `worker.credentials`, or every vault name when that is empty */
  scope?: Partial<TaskScope>;
  project?: string;
  runtime?: "host" | "vm";
  event_keys?: string[];
  parent?: string;
  cwd?: string;
  budget?: { tokens: number; hours: number };
}

/** Runtimes: chat on the host, a project task by its project's `runtime`, the Planner by
 * `planner.runtime`, everything else in a VM (the dispatcher falls back to the host while the image is missing). */
export function defaultRuntime(c: Config, i: Pick<CreateInput, "kind" | "project">): "host" | "vm" {
  if (i.kind === "chat") return "host";
  if (i.kind === "planner") return c.planner.runtime ?? "host";
  if (i.project) return c.projects[i.project]?.runtime ?? "host";
  return "vm";
}

/**
 * A task reaches the global list plus the lists of its projects, whatever the global setting. A chat includes
 * every project, so one strict project makes every chat strict, and a chat's runs with it. null: no project has a list.
 */
function projectOrigins(c: Config, kind: string, project: string | null | undefined, parent?: string): string[] | null {
  const own = project ? c.projects[project] : undefined;
  const ps = kind === "chat" || parent === "chat" ? Object.values(c.projects) : own ? [own] : [];
  return ps.some((p) => p.origins) ? [...new Set(ps.flatMap((p) => p.origins ?? []))] : null;
}

/**
 * What the dispatcher registers: wake (a task became queued), stop (kill after 30 s), kill (close: end it now). `failed`
 * is hortusd's: `text` to the owner's DM (owner.notify, coalesced) and a Planner wake for the row of `failureRow`.
 */
export const hooks = {
  wake(): void {},
  stop(_id: string): void {},
  async kill(_id: string): Promise<void> {},
  failed(_text: string): void {},
};

let bound: Ctx | undefined;
export function bind(c: Ctx): void {
  bound = c;
}
const ctx = (): Ctx => {
  if (!bound) throw new RpcError("failed", "dispatcher not started");
  return bound;
};

const json = (v: unknown): string => JSON.stringify(v);
const parse = <T>(s: string | null | undefined, d: T): T => (s ? (JSON.parse(s) as T) : d);
export const isClosed = (s: string): boolean => s === "done" || s === "failed";

/** Tokens its schedules' runs charged to this task (usage.runs, 3c). */
export const runsOf = (t: Pick<TaskRow, "usage">): number => parse<{ runs?: number }>(t.usage, {}).runs ?? 0;

export function get(id: string): TaskRow {
  const r = ctx().db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
  if (!r) throw new RpcError("not_found", `no task ${id}`);
  return r;
}

export function setStatus(id: string, status: TaskStatus, extra: Record<string, unknown> = {}): void {
  const cols = Object.keys(extra);
  ctx()
    .db.prepare(`UPDATE tasks SET status = ?, updated = ?${cols.map((c) => `, ${c} = ?`).join("")} WHERE id = ?`)
    .run(status, now(), ...(Object.values(extra) as (string | number | null)[]), id);
  bus.emit("tasks", { id, status });
}

/** The vault minus what only hortusd uses: offered Slack's `slack-app`, a live Worker replied with it, and Slack refuses it there. */
const sessionCredentials = (): string[] =>
  Object.entries(readVault())
    .filter(([n, e]) => e.type !== "webhook-secret" && !(e.transform === "slack" && n.endsWith("-app")))
    .map(([n]) => n);

export function create(i: CreateInput): TaskRow {
  const c = ctx();
  const id = taskId();
  const t = now();
  const w = c.config.worker.credentials;
  const scope: TaskScope = {
    credentials: i.scope?.credentials ?? (w.length ? w : sessionCredentials()),
    repos: i.scope?.repos ?? [],
    ...(i.project ? { project: i.project } : {}),
    ...(i.scope?.dofs ? { dofs: i.scope.dofs } : {}),
  };
  const origins = projectOrigins(c.config, i.kind, i.project, i.parent ? get(i.parent).kind : undefined);
  const { tokens, hours } = i.budget ?? c.config.worker.budget;
  const keys = [...(i.event_keys ?? []), ...(i.kind === "chat" ? [`chat:${id}`] : [])];
  c.db
    .prepare(
      `INSERT INTO tasks(id, kind, title, brief, status, scope, origins, budget, usage, project, runtime, parent,
        event_keys, created, updated, hours, cwd) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    )
    .run(
      id,
      i.kind,
      i.title,
      i.brief,
      json(scope),
      origins ? json(origins) : null,
      json({ tokens, hours }),
      json({ tokens: 0 }),
      i.project ?? null,
      i.runtime ?? defaultRuntime(c.config, i),
      i.parent ?? null,
      json(keys),
      t,
      t,
      i.cwd ?? null,
    );
  for (const ref of keys) c.db.prepare("INSERT OR REPLACE INTO task_refs(ref, task_id) VALUES (?, ?)").run(ref, id);
  mkdirSync(join(paths.ctl(id), "inbox"), { recursive: true });
  mkdirSync(join(paths.out(id), "work"), { recursive: true });
  bus.emit("tasks", { id, status: "queued" });
  hooks.wake();
  return get(id);
}

/**
 * What starts a task whose last start or session failed (`error`): the owner (task.send, task.message, an approval they
 * approved, `owner`: their own event through the Planner) and a one-shot timer (each fires once, and nothing else would
 * run it; a recurring one starts its own `run`). A Planner note, a rejection, an expiry, a merge or rebase notice or a
 * stranger's event re-ran the failure once per message (a task without its provider credential
 * restarted once a second); they wait in its inbox.
 */
const restarts = (msg: Omit<InboxMsg, "seq" | "ts">, owner: boolean): boolean =>
  owner ||
  msg.from === "owner" ||
  msg.from === "console" ||
  msg.from.startsWith("schedule:") ||
  (msg.from === "approval" && (msg.data as { decision?: string } | undefined)?.decision === "approved");

/**
 * Next seq, file temp+rename into ctl/inbox, `inbox` row; `waiting` → `queued`. Synchronous, so seqs never race.
 * `owner`: an event of the owner's that the Planner routed here (`from` is its thread).
 */
export function inboxWrite(id: string, msg: Omit<InboxMsg, "seq" | "ts">, owner = false): number {
  const db = ctx().db;
  const t = get(id);
  if (isClosed(t.status)) throw new RpcError("invalid", `task ${id} is ${t.status}`);
  const dir = join(paths.ctl(id), "inbox");
  mkdirSync(dir, { recursive: true });
  // past the files too: a crash between the rename and the INSERT must not hand the next message the same seq
  const files = readdirSync(dir).map((f) => (/^\d{6}\.json$/.test(f) ? Number(f.slice(0, 6)) : 0));
  const { m } = db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM inbox WHERE task_id = ?").get(id) as { m: number };
  const n = Math.max(m, ...files) + 1;
  const full: InboxMsg = { seq: n, ...msg, ts: now() };
  const name = `${String(n).padStart(6, "0")}.json`;
  writeFileSync(join(dir, `.${name}.tmp`), json(full));
  renameSync(join(dir, `.${name}.tmp`), join(dir, name));
  db.prepare("INSERT INTO inbox(task_id, seq, body, created) VALUES (?, ?, ?, ?)").run(id, n, json(full), full.ts);
  if (t.status === "waiting" && (!t.error || restarts(msg, owner))) setStatus(id, "queued");
  else bus.emit("tasks", { id });
  for (const h of inboxHooks) h(t, full);
  hooks.wake();
  return n;
}
/** Called after every inbox write (3c: a non-schedule message extends the task's schedule rows). */
export const inboxHooks: ((task: TaskRow, msg: InboxMsg) => void)[] = [];

/**
 * A failure the Worker could not report (a crash, a VM killed at its hours, a failed start, a schedule's parent over
 * budget) as a Planner `result`/`budget_exceeded` row, so the batch query, its taint deferral and `consumed` treat it
 * as any other, once. Seqs below zero: the positive ones are the Worker's files (`finish` reads past MAX(seq)).
 */
export function failureRow(id: string, type: "result" | "budget_exceeded", text: string): void {
  const db = ctx().db;
  const { n } = db.prepare("SELECT MIN(0, COALESCE(MIN(seq), 0)) - 1 AS n FROM outbox WHERE task_id = ?").get(id) as {
    n: number;
  };
  const ts = now();
  db.prepare("INSERT INTO outbox(task_id, seq, body, created) VALUES (?, ?, ?, ?)").run(
    id,
    n,
    json({ seq: n, type, text, ts }),
    ts,
  );
}

/** STOP: a queued task waits at once; a running one stops after its current tool (killed after 30 s). */
export function stop(id: string): void {
  const t = get(id);
  if (t.status !== "running" && t.status !== "queued") return;
  writeFileSync(join(paths.ctl(id), "STOP"), "");
  if (t.status === "queued") setStatus(id, "waiting");
  else hooks.stop(id);
}

/** End it (the row first, then the running session), publish the log, delete its directories; the row stays. */
export async function close(id: string, outcome: "done" | "failed"): Promise<void> {
  const t = get(id);
  if (isClosed(t.status)) throw new RpcError("invalid", `task ${id} is already ${t.status}`);
  closing.add(id);
  try {
    // closed before the wait: it is a session's teardown or its whole start (a clone, a VM's boot), and a restart in
    // it found the row `running` and ran the task again. Its finish() sees a closed row: accounting only
    setStatus(id, outcome, { closed: now() });
    await hooks.kill(id);
    crashPoint("tasks.close.after-kill");
    await finishClose(id);
  } finally {
    closing.delete(id);
  }
}

/**
 * After the row is closed: its requests, log, directories and schedules. Recovery runs it again for a closed task whose
 * `tasks/<id>` is still there (a crash inside close left the log unpublished and the directories behind).
 */
export async function finishClose(id: string): Promise<void> {
  const db = ctx().db;
  // its requests and task grants wait for no one now (a merge or a transform outlives the task; a login holds a
  // view the login module closes on its decision: kept); in the same turn as the status, before any await
  const r = db
    .prepare(
      "UPDATE approvals SET status = 'expired', decided_at = ?, reason = 'the task closed' WHERE status = 'pending' AND task_id = ? AND category NOT IN ('merge', 'transforms', 'login')",
    )
    .run(now(), id);
  if (r.changes) bus.emit("approvals", { task: id });
  // its schedules' runs end with it (a merged PR's task): one queued or at work would act, and ask, for a closed task.
  // Here, not in close(): recovery finishes a close a crash cut after the row, and its runs with it
  const runs = db.prepare("SELECT id FROM tasks WHERE parent = ? AND status NOT IN ('done', 'failed')").all(id);
  for (const { id: run } of runs as { id: string }[]) await close(run, get(id).status as "done" | "failed");
  const t = get(id);
  crashPoint("tasks.close.after-status");
  await publishLog(id, t.title, t.status).catch((e) => ctx().log("tasks").error("publishLog failed", e, { id }));
  const schedules = db.prepare("SELECT id FROM schedules WHERE task_id = ?").all(id) as { id: number }[];
  for (const dir of [
    paths.task(id),
    paths.clone(id),
    `${paths.clone(id)}.new`,
    ...schedules.map((s) => paths.schedule(s.id)),
  ])
    rmTree(dir);
  db.prepare("DELETE FROM schedules WHERE task_id = ?").run(id);
}
/** ids being closed: the dispatcher does not start them */
export const closing = new Set<string>();

export function budget(id: string, b: { tokens?: number; hours?: number }): void {
  const t = get(id);
  const cur = parse(t.budget, ctx().config.worker.budget);
  // the raise answers a budget_exceeded: the next overrun is a new failure, and a note may start it again
  ctx()
    .db.prepare(
      "UPDATE tasks SET budget = ?, updated = ?, error = CASE WHEN error LIKE 'budget_exceeded%' THEN NULL ELSE error END WHERE id = ?",
    )
    .run(json({ tokens: b.tokens ?? cur.tokens, hours: b.hours ?? cur.hours }), now(), id);
  bus.emit("tasks", { id });
}

// ---------------------------------------------------------------------------------------------------------------------
// task.json and ctl/home

/**
 * A task's row after a config change: the owner extends a project's list because a task was refused, and the proxy reads
 * the row. Called on every reload; a running Worker's prompt keeps the old list until its next start.
 */
export function refreshOrigins(c: Ctx): void {
  const rows = c.db
    .prepare(
      `SELECT t.id, t.kind, t.project, t.origins, p.kind AS parent FROM tasks t LEFT JOIN tasks p ON p.id = t.parent
        WHERE t.status NOT IN ('done', 'failed')`,
    )
    .all() as { id: string; kind: string; project: string | null; origins: string | null; parent: string | null }[];
  const set = c.db.prepare("UPDATE tasks SET origins = ? WHERE id = ?");
  for (const r of rows) {
    const list = projectOrigins(c.config, r.kind, r.project, r.parent ?? undefined);
    const next = list ? json(list) : null;
    if (next !== r.origins) set.run(next, r.id);
  }
}

function mergeOrigins(g: Config["origins"], t: string[] | null): TaskJson["origins"] {
  if (!t) return g;
  if (g === "*") return t;
  return [...new Set([...g, ...t])];
}

/**
 * Every mirrored forge project as `<dof>:<project>`: a chat gets them all.
 * ponytail: read back from the mirror's directory name, so a project with `__` in its name stays out of a chat's
 * scope, and one mirrored later waits for the next chat; ask the connector's `projects()` if that bites.
 */
function mirrored(c: Config): string[] {
  return Object.keys(c.dofs).flatMap((dof) => {
    const dir = join(paths.home(), "repos", dof);
    if (!existsSync(dir)) return [];
    const bare = readdirSync(dir).filter((f) => f.endsWith(".git"));
    return bare.map((f) => `${dof}:${f.slice(0, -4).replace(/__/g, "/")}`);
  });
}

/** Rebuilt from the row and the current config at every start. */
export function taskJson(c: Config, row: TaskRow): TaskJson {
  const { provider, model, effort, context_window } = c.worker;
  if (!provider || !model) throw new Error("worker.provider and worker.model must be set (Settings)");
  const scope = parse<TaskScope>(row.scope, { credentials: [], repos: [] });
  const project = scope.project ?? row.project ?? undefined;
  const out = paths.out(row.id);
  const unattendedProject = project !== undefined && row.kind !== "chat";
  // a run (3c): its row's directory while the row lives, the script runs.start wrote to ctl/
  const sid =
    row.kind === "run" ? parse<string[]>(row.event_keys, []).find((k) => k.startsWith("schedule:")) : undefined;
  const sdir = sid && paths.schedule(sid.slice("schedule:".length));
  const schedule = sdir && existsSync(sdir) ? sdir : undefined;
  const script = row.kind === "run" ? readOr(join(paths.ctl(row.id), "script.sh")) : undefined;
  // 3h: the placeholder jar (own captures, and logins of the origins the task holds a grant on)
  const cookies = bound ? jar(bound.db, row.id) : [];
  const repoUrls = (scope.repos ?? []).flatMap((r) => {
    const i = r.indexOf(":");
    const dof = c.dofs[r.slice(0, i)];
    const git = dof && gitOf(dof);
    return git ? [[r, `https://${git.host}/${r.slice(i + 1)}.git`]] : [];
  });
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    brief: row.brief,
    scope: {
      credentials: scope.credentials ?? [],
      repos: scope.repos ?? [],
      ...(project ? { project } : {}),
      dofs: readable(c, row.scope),
    },
    origins: mergeOrigins(c.origins, parse<string[] | null>(row.origins, null)),
    // what its schedules' runs spent is this task's too (runs.ts › onExit): the session gets what is left
    budget: ((b) => ({ ...b, tokens: Math.max(0, b.tokens - runsOf(row)) }))(parse(row.budget, c.worker.budget)),
    hours_used: row.hours ?? 0,
    provider,
    model,
    ...(effort ? { effort } : {}),
    context_window,
    tz: c.owner.tz,
    paths: {
      dof: join(paths.home(), "dof"),
      repos: join(paths.home(), "repos"),
      work: join(out, "work"),
      ...(unattendedProject ? { clone: paths.clone(row.id) } : {}),
      ...(schedule ? { schedule } : {}),
    },
    ...(script ? { script } : {}),
    ...(unattendedProject ? { clone_url: `https://hortusd.internal/git/${project}` } : {}),
    ...(repoUrls.length ? { repo_urls: Object.fromEntries(repoUrls) } : {}),
    ...(row.kind === "chat"
      ? {
          projects: Object.fromEntries(
            Object.entries(c.projects).map(([n, p]) => [n, { path: p.path, main: p.main, runtime: p.runtime }]),
          ),
          ...(row.cwd ? { cwd: row.cwd } : {}),
        }
      : {}),
    ...(cookies.length ? { cookies } : {}),
    rpc: "https://hortusd.internal",
    features: row.kind === "planner" ? [] : [...(unattendedProject ? ["merge"] : []), "schedule", "browser"],
  };
}

function readOr(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

const DOF_BIN = fileURLToPath(new URL("../bin/dof.js", import.meta.url));

/** task.json, ctl/home/.hortus/{config,secrets}.json and plugins, ctl/bin/dof; clears STOP. (ca.crt: spawnSandboxed.) */
export function prepare(c: Config, task: TaskJson): void {
  const ctl = paths.ctl(task.id);
  const h = join(ctl, "home", ".hortus");
  rmSync(join(h, "plugins"), { recursive: true, force: true });
  for (const d of [join(ctl, "inbox"), join(ctl, "bin"), join(h, "plugins"), task.paths.work])
    mkdirSync(d, { recursive: true });
  rmSync(join(ctl, "STOP"), { force: true });
  writeFileSync(join(ctl, "task.json"), json(task));
  writeFileSync(
    join(h, "config.json"),
    json({ provider: task.provider, model: task.model, ...(task.effort ? { effort: task.effort } : {}) }),
  );
  writeFileSync(join(h, "secrets.json"), json({ [task.provider]: providerSecret(task.provider) }));
  for (const dir of c.worker.plugins) cpSync(dir, join(h, "plugins", basename(dir)), { recursive: true });
  const sh = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
  writeFileSync(join(ctl, "bin", "dof"), `#!/bin/sh\nexec ${sh(process.execPath)} ${sh(DOF_BIN)} "$@"\n`, {
    mode: 0o755,
  });
}

/** The project whose realpath contains `cwd`'s realpath (the longest match), if any. */
export function projectFor(c: Config, cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return undefined;
    }
  };
  const at = real(cwd);
  if (!at) return undefined;
  let best: [string, number] | undefined;
  for (const [name, p] of Object.entries(c.projects)) {
    const root = real(p.path);
    if (root && (at === root || at.startsWith(root + sep)) && root.length > (best?.[1] ?? -1))
      best = [name, root.length];
  }
  return best?.[0];
}

// ---------------------------------------------------------------------------------------------------------------------
// RPCs, role owner

const owner = ["owner"] as const;
const Id = z.object({ id: z.string() });

define("task.open", {
  roles: [...owner],
  input: z.object({ text: z.string().min(1), cwd: z.string().optional() }),
  run({ text, cwd }) {
    const c = ctx().config;
    const project = projectFor(c, cwd);
    const t = create({
      kind: "chat",
      title: text.replace(/\s+/g, " ").trim().slice(0, 80),
      // the owner's words arrive as [inbox 1]; repeating them as the brief would say everything twice
      brief: "A chat with the owner. Their messages arrive in your inbox.",
      scope: { credentials: sessionCredentials(), repos: mirrored(c) },
      ...(project ? { project } : {}),
      ...(cwd ? { cwd } : {}),
    });
    inboxWrite(t.id, { from: "owner", trusted: true, text });
    ownerLine(t.id, text);
    return { id: t.id };
  },
});

/** A chat's stream shows the owner's own words too (a `replies` row of type `owner`, between the Worker's lines). */
function ownerLine(id: string, text: string): void {
  ctx()
    .db.prepare(
      "INSERT INTO replies(task_id, seq, body, created) SELECT ?, COALESCE(MAX(seq), 0) + 1, ?, ? FROM replies WHERE task_id = ?",
    )
    .run(id, JSON.stringify({ type: "owner", text }), now(), id);
  bus.emit(`chat:${id}`);
}

define("task.send", {
  roles: [...owner],
  input: z.object({ id: z.string(), text: z.string().min(1) }),
  run({ id, text }) {
    const seq = inboxWrite(id, { from: "owner", trusted: true, text });
    if (get(id).kind === "chat") ownerLine(id, text);
    return { seq };
  },
});

define("task.message", {
  roles: [...owner],
  input: z.object({ id: z.string(), text: z.string().min(1) }),
  // a routing note from the console, not the owner talking: rendered quoted (inbox.ts)
  run: ({ id, text }) => ({ seq: inboxWrite(id, { from: "console", trusted: true, text }) }),
});

define("task.stop", {
  roles: [...owner],
  input: Id,
  run({ id }) {
    stop(id);
    return { ok: true, message: "stopping: the task halts after its current tool (killed after 30 s)" };
  },
});

define("task.close", {
  roles: [...owner],
  input: z.object({ id: z.string(), outcome: z.enum(["done", "failed"]).default("done") }),
  async run({ id, outcome }) {
    await close(id, outcome);
    return { ok: true };
  },
});

/**
 * A chat gone for good: closed first if open, then its rows, its decided approvals and its `logs` DOF entry, and its
 * schedules' runs too.
 */
define("task.delete", {
  roles: [...owner],
  input: Id,
  async run({ id }) {
    if (get(id).kind !== "chat") throw new RpcError("invalid", `task ${id} is not a chat`);
    if (!isClosed(get(id).status)) await close(id, "done");
    const db = ctx().db;
    const runs = db.prepare("SELECT id FROM tasks WHERE parent = ?").all(id) as { id: string }[];
    for (const t of [...runs.map((r) => r.id), id]) {
      removeLog(t);
      for (const table of ["inbox", "outbox", "replies"]) db.prepare(`DELETE FROM ${table} WHERE task_id = ?`).run(t);
      // a pending one outlives the close (a transform, a login) and still wants the owner's decision: kept
      db.prepare("DELETE FROM approvals WHERE task_id = ? AND status != 'pending'").run(t);
      db.prepare("DELETE FROM tasks WHERE id = ?").run(t);
    }
    bus.emit("tasks", { id });
    bus.emit("approvals", { task: id });
    return { ok: true };
  },
});

define("task.budget", {
  roles: [...owner],
  input: z.object({
    id: z.string(),
    tokens: z.number().nonnegative().optional(),
    hours: z.number().nonnegative().optional(),
  }),
  run({ id, ...b }) {
    const t = get(id);
    // a closed task never runs again: a raise from a card opened before the close would only wipe why it failed
    if (isClosed(t.status)) throw new RpcError("invalid", `task ${id} is ${t.status}`);
    // the raise means go on, and nothing else would start it: the page just said "ok". Not a schedule's parent over
    // budget: its timers fire again by themselves
    const spent = t.status === "waiting" && GOES_ON.test(t.error ?? "");
    budget(id, b);
    if (spent) inboxWrite(id, { from: "console", trusted: true, text: "The owner raised the budget: go on." });
    return { ok: true };
  },
});

/** session.md: rendered live from out/sessions while open, the published file once closed. */
define("task.log", {
  roles: [...owner],
  input: Id,
  async run({ id }) {
    const t = get(id);
    if (!isClosed(t.status)) return renderSession(join(paths.out(id), "sessions"));
    return readFile(join(paths.logs(), id, "session.md"), "utf8").catch(() => "");
  },
});

/**
 * Replies rows after `after`, then every new one as it lands; ends when the task is closed. The CLI keeps one stream
 * across turns, so it does not end when a turn does.
 */
define("task.stream", {
  roles: [...owner],
  input: z.object({ id: z.string(), after: z.number().int().optional() }),
  run({ id, after }) {
    get(id);
    const db = ctx().db;
    return (async function* () {
      let last = after ?? -1;
      let signal: () => void = () => {};
      const onRow = () => signal();
      const topic = `chat:${id}`;
      bus.on(topic, onRow);
      bus.on("tasks", onRow);
      try {
        for (;;) {
          const rows = db
            .prepare("SELECT seq, body, created FROM replies WHERE task_id = ? AND seq > ? ORDER BY seq")
            .all(id, last) as { seq: number; body: string; created: string }[];
          for (const r of rows) {
            last = r.seq;
            yield r;
          }
          if (isClosed(get(id).status)) return;
          // ponytail: a client that disconnected is noticed at the next row or the close; fine for one owner
          await new Promise<void>((r) => {
            signal = r;
            setTimeout(r, 30_000).unref();
          });
        }
      } finally {
        bus.off(topic, onRow);
        bus.off("tasks", onRow);
      }
    })();
  },
});
