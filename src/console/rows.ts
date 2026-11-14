/**
 * What the console's RPCs read, and the text the CLI and the Planner share with them: the task and approval queries, a
 * chat's replies, a schedule's last summary, a task's console log and origin; `parse`, `line`, `tokens`, `errorLine`.
 */
import { join } from "node:path";
import type { Ctx } from "../ctx.ts";
import { readCapped } from "../hostile.ts";
import { parse } from "./text.ts";

export { errorLine, line, PAUSED, parse, tokens } from "./text.ts";

/** Rows per list a read RPC returns by default. */
export const PAGE = 50;

// ---------------------------------------------------------------------------------------------------------------------
// tasks

export interface TaskRow {
  id: string;
  kind: string | null;
  title: string | null;
  status: string | null;
  project: string | null;
  budget: string | null;
  usage: string | null;
  hours: number | null;
  summary: string | null;
  outcome: string | null;
  created: string | null;
  updated: string | null;
  closed: string | null;
  cwd: string | null;
  error?: string | null;
  runtime?: string | null;
  started?: string | null;
  brief?: string | null;
  provider?: string | null;
  model?: string | null;
}

// ponytail: OFFSET paging (rows shift while tasks update; deep pages scan); a keyset cursor if that bites
export const OPEN_SQL =
  "SELECT * FROM tasks WHERE status NOT IN ('done', 'failed') ORDER BY updated DESC LIMIT ? OFFSET ?";
export const CLOSED_SQL =
  "SELECT * FROM tasks WHERE status IN ('done', 'failed') ORDER BY closed DESC LIMIT ? OFFSET ?";
export const KIND_SQL = `SELECT * FROM tasks WHERE kind = $kind
  AND ($updated IS NULL OR updated < $updated OR (updated = $updated AND id < $id))
  ORDER BY updated DESC, id DESC LIMIT $limit`;

/** The last 64 KB of `out/console.log` (a VM's serial output, an unattended session's stdout and stderr). */
export function consoleLog(ctx: Ctx, t: Pick<TaskRow, "id" | "kind">): string | null {
  if (t.kind === "chat") return null;
  // the Worker's file: no links, FIFOs
  return readCapped(join(ctx.paths.out(t.id), "console.log"), 64 * 1024, true)?.text ?? null;
}

/** A Planner-created task: the event it came from. */
export function taskOrigin(ctx: Ctx, id: string) {
  const o = ctx.db
    .prepare("SELECT dof, author, refs, summary FROM events WHERE task_id = ? ORDER BY id LIMIT 1")
    .get(id) as { dof: string; author: string | null; refs: string | null; summary: string | null } | undefined;
  if (!o) return undefined;
  const channel = parse<string[]>(o.refs)?.[0]?.split(":")[1] ?? "—";
  return { dof: o.dof, channel, author: o.author, summary: o.summary ?? "" };
}

/** What the task waits on: its own entries and a durable grant it opened or met (payload.task, payload.waiting). */
export const PENDING_FOR = `SELECT * FROM approvals WHERE status = 'pending' AND (task_id = ?1 OR (task_id IS NULL AND (
  json_extract(payload, '$.task') = ?1 OR EXISTS (SELECT 1 FROM json_each(payload, '$.waiting') WHERE value = ?1))))`;

// ---------------------------------------------------------------------------------------------------------------------
// a chat's replies

export interface ReplyRow {
  seq: number;
  body: string;
  created: string | null;
}

export const lastReplies = (ctx: Ctx, task: string, after = -1, limit = 1000): ReplyRow[] =>
  (
    ctx.db
      .prepare("SELECT seq, body, created FROM replies WHERE task_id = ? AND seq > ? ORDER BY seq DESC LIMIT ?")
      .all(task, after, limit) as unknown as ReplyRow[]
  ).reverse();

/** The newest `limit` rows before a seq, oldest first: a chat's page further back. */
export const repliesBefore = (ctx: Ctx, task: string, before: number, limit = 1000): ReplyRow[] =>
  (
    ctx.db
      .prepare("SELECT seq, body, created FROM replies WHERE task_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?")
      .all(task, before, limit) as unknown as ReplyRow[]
  ).reverse();

/** The next rows after a cursor, oldest first. */
export const repliesAfter = (ctx: Ctx, task: string, after: number): ReplyRow[] =>
  ctx.db
    .prepare("SELECT seq, body, created FROM replies WHERE task_id = ? AND seq > ? ORDER BY seq LIMIT 1000")
    .all(task, after) as unknown as ReplyRow[];

// ---------------------------------------------------------------------------------------------------------------------
// schedules

export interface ScheduleListRow {
  id: number;
  task_id: string;
  title: string | null;
  fire_at: string | null;
  every_sec: number | null;
  cron: string | null;
  tz: string | null;
  text: string | null;
  label: string | null;
  last_run: string | null;
  expires_at: string | null;
  /** the latest run's summary (`withSummaries`) */
  summary?: string | null;
}

/** Each row's `last-summary.md`: in the row's directory, which its runs can write, so read as hostile and capped. */
export const withSummaries = (ctx: Ctx, rows: ScheduleListRow[]): ScheduleListRow[] =>
  rows.map((r) => ({
    ...r,
    summary: readCapped(join(ctx.paths.schedule(r.id), "last-summary.md"), 16 * 1024)?.text ?? null,
  }));

const span = (sec: number) => (sec % 3600 === 0 ? `${sec / 3600}h` : sec % 60 === 0 ? `${sec / 60}m` : `${sec}s`);

/** `at` / `every 15m` / `cron 0 9 * * * Asia/Tokyo` */
export const kindOf = (r: Pick<ScheduleListRow, "cron" | "every_sec" | "tz">): string =>
  r.cron ? `cron ${r.cron} ${r.tz ?? ""}`.trim() : r.every_sec ? `every ${span(r.every_sec)}` : "at";

/** "in 12 min", "in 3 h", "5 min ago" */
export function relative(iso: string, now = Date.now()): string {
  const d = Date.parse(iso) - now;
  const m = Math.round(Math.abs(d) / 60_000);
  const v =
    m < 1
      ? "under a minute"
      : m < 120
        ? `${m} min`
        : m < 48 * 60
          ? `${Math.round(m / 60)} h`
          : `${Math.round(m / 1440)} d`;
  return d >= 0 ? `in ${v}` : `${v} ago`;
}
