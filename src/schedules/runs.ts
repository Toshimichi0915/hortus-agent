/**
 * Runs (09-schedules.md › runs.ts): a firing of a recurring or scripted row is a new `run` task under the row's task.
 * At each exit of a run its tokens are charged to the parent, its summary becomes the row's `last-summary.md`, and an
 * empty `result` closes it at once without a `logs` entry (and deletes it when it never reached the model).
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bus } from "../console/events.ts";
import type { Ctx } from "../ctx.ts";
import { remove as unindex } from "../mirror/fts.ts";
import { replaceFile } from "../hostile.ts";
import * as paths from "../paths.ts";
import * as tasks from "../runtime/tasks.ts";
import type { OutboxMsg } from "../types.ts";

export interface ScheduleRow {
  id: number;
  task_id: string;
  fire_at: string | null;
  every_sec: number | null;
  cron: string | null;
  tz: string | null;
  text: string;
  script: string | null;
  expires_at: string | null;
  last_run: string | null;
  created: string;
}

let ctx: Ctx | undefined;
export function bind(c: Ctx): void {
  ctx = c;
}
const db = () => {
  if (!ctx) throw new Error("schedules not started");
  return ctx.db;
};
const log = () => ctx?.log("schedules") ?? { info() {}, error() {} };

const parse = <T>(s: string | null | undefined, d: T): T => (s ? (JSON.parse(s) as T) : d);
const tokensOf = (t: tasks.TaskRow) => parse<{ tokens?: number }>(t.usage, {}).tokens ?? 0;

/** "2026-11-04 09:00" in `tz` */
export function local(at: Date, tz: string): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: tz, dateStyle: "short", timeStyle: "short" }).format(at);
}

/** Tokens or hours spent (runs included); the tick does not fire rows of such a task. */
export function overBudget(t: tasks.TaskRow): boolean {
  const b = parse(t.budget, { tokens: Number.POSITIVE_INFINITY, hours: Number.POSITIVE_INFINITY });
  return tokensOf(t) >= b.tokens || (t.hours ?? 0) >= b.hours;
}

/** The row's id a run belongs to, from its `schedule:<id>` event key. */
export function scheduleOf(run: tasks.TaskRow): number | undefined {
  const k = parse<string[]>(run.event_keys, []).find((e) => e.startsWith("schedule:"));
  return k ? Number(k.slice("schedule:".length)) : undefined;
}

/** A recurring row's run gets `schedules/<id>/`; a one-shot row's run (the row is gone) works in its `work/`. */
export function start(row: ScheduleRow, fired: Date): tasks.TaskRow {
  const p = tasks.get(row.task_id);
  const b = parse(p.budget, ctx?.config.worker.budget ?? { tokens: 0, hours: 0 });
  if (row.every_sec || row.cron) mkdirSync(paths.schedule(row.id), { recursive: true });
  const run = tasks.create({
    kind: "run",
    parent: p.id,
    title: `${p.title} @ ${local(fired, row.tz ?? ctx?.config.owner.tz ?? "UTC")}`,
    brief: row.text,
    event_keys: [`schedule:${row.id}`],
    scope: parse(p.scope, {}),
    ...(p.project ? { project: p.project } : {}),
    budget: { tokens: Math.max(0, b.tokens - tokensOf(p)), hours: Math.max(0, b.hours - (p.hours ?? 0)) },
  });
  // read by taskJson at the run's start (the dispatcher starts it on a later tick, never synchronously)
  if (row.script) writeFileSync(join(paths.ctl(run.id), "script.sh"), row.script);
  return run;
}

/** exitHooks.onExit */
export function onExit(run: tasks.TaskRow, msgs: OutboxMsg[]): void {
  if (run.kind !== "run" || !run.parent) return;
  const d = db();
  const parent = tasks.get(run.parent);
  // the sum over every run of the parent, so a resumed run is never charged twice
  const { n } = d
    .prepare("SELECT COALESCE(SUM(json_extract(usage, '$.tokens')), 0) AS n FROM tasks WHERE parent = ?")
    .get(parent.id) as { n: number };
  const u = parse<{ tokens?: number; runs?: number }>(parent.usage, {});
  const own = (u.tokens ?? 0) - (u.runs ?? 0);
  d.prepare("UPDATE tasks SET usage = ? WHERE id = ?").run(JSON.stringify({ tokens: own + n, runs: n }), parent.id);
  const charged = tasks.get(parent.id);
  if (overBudget(charged) && !charged.error?.startsWith("budget_exceeded")) {
    // recorded on the card only: the Planner has nothing to decide (the schedules stop; the owner raises the budget)
    const b = parse(charged.budget, { tokens: 0 });
    d.prepare("UPDATE tasks SET error = ? WHERE id = ?").run(
      `budget_exceeded: runs of its schedules used ${tokensOf(charged)}/${b.tokens} tokens; its schedules stop firing`,
      parent.id,
    );
    log().info("parent over budget: schedules stop firing", { task: parent.id, run: run.id });
  }
  bus.emit("tasks", { id: parent.id });

  const sid = scheduleOf(run);
  if (sid !== undefined && run.summary && existsSync(paths.schedule(sid)))
    replaceFile(join(paths.schedule(sid), "last-summary.md"), run.summary); // the run could plant a link there

  const results = msgs.filter((m) => m.type === "result");
  if (results.length && results.every((m) => !m.text.trim()))
    void discard(run.id).catch((e) => log().error("closing an empty run failed", e, { task: run.id }));
}

/** Closed (dirs gone), no `logs` entry; deleted outright when it spent nothing (a quiet script). Not awaited by the
 * exit hook: close() waits for the session's own exit handling to end. */
async function discard(id: string): Promise<void> {
  const run = tasks.get(id);
  if (!tasks.isClosed(run.status)) await tasks.close(id, "done");
  const d = db();
  rmSync(join(paths.logs(), id), { recursive: true, force: true });
  for (const f of ["summary.md", "session.md"]) unindex(d, "logs", `${id}/${f}`);
  if (tokensOf(tasks.get(id)) === 0)
    for (const t of ["tasks", "inbox", "outbox", "replies"])
      d.prepare(`DELETE FROM ${t} WHERE ${t === "tasks" ? "id" : "task_id"} = ?`).run(id);
  bus.emit("tasks", { id });
}
