/**
 * Runs: a firing of a recurring or scripted row is a new `run` task under the row's task.
 * At each exit of a run its tokens are charged to the parent, its summary becomes the row's `last-summary.md`, and an
 * empty `result` closes it at once without a `logs` entry (and deletes it when it never reached the model).
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { quote } from "../agent/inbox.ts";
import { bus } from "../console/events.ts";
import type { Ctx } from "../ctx.ts";
import { replaceFile } from "../hostile.ts";
import { removeLog } from "../mirror/index.ts";
import * as paths from "../paths.ts";
import * as tasks from "../runtime/tasks.ts";
import { type OutboxMsg, priceOf } from "../types.ts";

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
const usdOf = (t: tasks.TaskRow) => parse<{ usd?: number }>(t.usage, {}).usd ?? 0;

/** "2026-11-04 09:00" in `tz` */
export function local(at: Date, tz: string): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: tz, dateStyle: "short", timeStyle: "short" }).format(at);
}

/**
 * Dollars or hours spent (runs included); the tick does not fire rows of such a task. A chat has no budget, and a model
 * with no price no spending limit.
 */
export function overBudget(t: tasks.TaskRow): boolean {
  const b = parse<{ usd?: number; hours?: number }>(t.budget, {});
  const priced = !!ctx && !!priceOf(ctx.config.prices, ctx.config.worker.provider, ctx.config.worker.model);
  const overUsd = priced && b.usd !== undefined && usdOf(t) >= b.usd;
  return t.kind !== "chat" && (overUsd || (t.hours ?? 0) >= (b.hours ?? Number.POSITIVE_INFINITY));
}

/** What a firing tells the Worker, so it can ask for more in time. */
export const expiry = (at: string): string =>
  `This task's timers expire at ${at} unless a message reaches it; to go on past that, ask the owner.`;

/** The row's id a run belongs to, from its `schedule:<id>` event key. */
export function scheduleOf(run: tasks.TaskRow): number | undefined {
  const k = parse<string[]>(run.event_keys, []).find((e) => e.startsWith("schedule:"));
  return k ? Number(k.slice("schedule:".length)) : undefined;
}

/** A recurring row's run gets `schedules/<id>/`; a one-shot row's run (the row is gone) works in its `work/`. */
export function start(row: ScheduleRow, fired: Date): tasks.TaskRow {
  const p = tasks.get(row.task_id);
  const b = parse(p.budget, ctx?.config.worker.budget ?? { usd: 0, hours: 0 });
  if (row.every_sec || row.cron) mkdirSync(paths.schedule(row.id), { recursive: true });
  const run = tasks.create({
    kind: "run",
    parent: p.id,
    title: `${p.title} @ ${local(fired, row.tz ?? ctx?.config.owner.tz ?? "UTC")}`,
    // wrapped like any non-owner text: a Worker that read a stranger may have written it
    brief: `A timer of this task fired. What it was set to do, as the task wrote it then:\n${quote(row.text)}${
      row.expires_at ? `\n\n${expiry(row.expires_at)}` : ""
    }`,
    event_keys: [`schedule:${row.id}`],
    scope: parse(p.scope, {}),
    ...(p.project ? { project: p.project } : {}),
    // a run is unattended, so a chat's (which has no budget) is held to the chat's whole budget on its own
    budget:
      p.kind === "chat"
        ? { usd: b.usd, hours: b.hours }
        : { usd: Math.max(0, b.usd - usdOf(p)), hours: Math.max(0, b.hours - (p.hours ?? 0)) },
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
  const { n, m } = d
    .prepare(
      "SELECT COALESCE(SUM(json_extract(usage, '$.tokens')), 0) AS n, COALESCE(SUM(json_extract(usage, '$.usd')), 0) AS m FROM tasks WHERE parent = ?",
    )
    .get(parent.id) as { n: number; m: number };
  const u = parse<{ tokens?: number; runs?: number; usd?: number; runs_usd?: number }>(parent.usage, {});
  const own = (u.tokens ?? 0) - (u.runs ?? 0);
  const ownUsd = (u.usd ?? 0) - (u.runs_usd ?? 0);
  d.prepare("UPDATE tasks SET usage = ? WHERE id = ?").run(
    JSON.stringify({
      tokens: own + n,
      runs: n,
      ...(ownUsd + m > 0 ? { usd: ownUsd + m } : {}),
      ...(m > 0 ? { runs_usd: m } : {}),
    }),
    parent.id,
  );
  const charged = tasks.get(parent.id);
  if (overBudget(charged) && !charged.error?.startsWith("budget_exceeded") && !tasks.isClosed(charged.status)) {
    const b = parse(charged.budget, { usd: 0 });
    const error = `budget_exceeded: runs of its schedules used $${usdOf(charged).toFixed(2)}/$${b.usd}; its schedules stop firing`;
    d.prepare("UPDATE tasks SET error = ? WHERE id = ?").run(error, parent.id);
    log().info("parent over budget: schedules stop firing", { task: parent.id, run: run.id });
    // the Planner gets it for the parent. A run that hit the same limit told the owner already
    tasks.failureRow(parent.id, "budget_exceeded", error);
    if (!msgs.some((m) => m.type === "budget_exceeded")) tasks.hooks.failed(`task ${parent.id} is over budget`);
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
  removeLog(id);
  if (tokensOf(tasks.get(id)) === 0)
    for (const t of ["tasks", "inbox", "outbox", "replies"])
      d.prepare(`DELETE FROM ${t} WHERE ${t === "tasks" ? "id" : "task_id"} = ?`).run(id);
  bus.emit("tasks", { id });
}
