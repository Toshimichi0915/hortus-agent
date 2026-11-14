/**
 * Schedules: the `schedules` rows a Worker sets with `schedule.set`, and the one-minute tick that
 * fires them. A due row is advanced (or, one-shot, deleted) before it acts, so a firing happens at most once: a one-shot
 * row without a script writes its task's inbox, every other row starts a run (runs.ts). A new trigger kind is a column
 * and a case in `advance`; runs and expiry are untouched.
 */
import { existsSync, rmSync } from "node:fs";
import { Cron } from "croner";
import { z } from "zod";
import { bus } from "../console/events.ts";
import { type ScheduleListRow, withSummaries } from "../console/rows.ts";
import { crashPoint } from "../crash.ts";
import type { Ctx, Module } from "../ctx.ts";
import * as paths from "../paths.ts";
import { define } from "../rpc.ts";
import { exitHooks } from "../runtime/dispatcher.ts";
import * as tasks from "../runtime/tasks.ts";
import { type Caller, RpcError } from "../types.ts";
import type { ScheduleRow } from "./runs.ts";
import * as runs from "./runs.ts";

export const MIN_INTERVAL = 300;
export const MAX_SCRIPT = 16 * 1024;
export const EXPIRY_MS = 7 * 24 * 3600_000;

let ctx: Ctx | undefined;
let timer: NodeJS.Timeout | undefined;
/** The tick's clock; tests replace it. */
export const clock = { now: (): number => Date.now() };
const iso = (ms: number) => new Date(ms).toISOString();

const db = () => {
  if (!ctx) throw new RpcError("failed", "schedules not started");
  return ctx.db;
};
const log = () => ctx?.log("schedules") ?? { info() {}, error() {} };

/** croner moves a time skipped by DST to the next valid one; `match` is false there, so it is dropped. */
function cronNext(c: Cron, from: Date): Date | null {
  let next = c.nextRun(from);
  while (next && !c.match(next)) next = c.nextRun(next);
  return next;
}

function cronOf(expr: string, tz: string): Cron {
  try {
    return new Cron(expr, { timezone: tz, mode: "5-part" });
  } catch (e) {
    throw new RpcError("invalid", `cron: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Latest inbox message to the task or its runs that a schedule did not write; the task's creation without one. */
function lastHuman(taskId: string): number {
  const { t } = db()
    .prepare(
      `SELECT MAX(created) AS t FROM inbox WHERE (task_id = ? OR task_id IN (SELECT id FROM tasks WHERE parent = ?))
       AND json_extract(body, '$.from') NOT LIKE 'schedule:%'`,
    )
    .get(taskId, taskId) as { t: string | null };
  return Date.parse(t ?? tasks.get(taskId).created);
}

/** The task that owns rows set by `caller`: a run's rows belong to its parent (runs never nest). */
function ownerOf(caller: Caller): string {
  if (!caller.task) throw new RpcError("forbidden", "no task for this caller");
  const t = tasks.get(caller.task);
  return t.parent ?? t.id;
}

function removeRow(id: number): void {
  db().prepare("DELETE FROM schedules WHERE id = ?").run(id);
  db().prepare("DELETE FROM schedule_runs WHERE schedule_id = ?").run(id);
  rmSync(paths.schedule(id), { recursive: true, force: true });
}

const SetInput = z.object({
  text: z.string().min(1),
  at: z.string().optional(),
  every: z.number().int().optional(),
  cron: z.string().optional(),
  tz: z.string().optional(),
  script: z.string().optional(),
  project: z.string().optional(),
});

export function set(
  input: z.infer<typeof SetInput>,
  caller: Caller,
): { id: number; fire_at: string; expires_at: string | null } {
  const taskId = ownerOf(caller);
  // a run outlives its parent's close, which deleted the rows: one set now would fire under a closed task for good
  if (tasks.isClosed(tasks.get(taskId).status)) throw new RpcError("invalid", `task ${taskId} is closed`);
  const { text, at, every, cron, script } = input;
  const owner = tasks.get(taskId);
  // a chat edits every project in place, so naming one for its runs widens nothing; any other task has its own or none
  const project = input.project === owner.project ? undefined : input.project;
  if (project !== undefined) {
    if (owner.kind !== "chat")
      throw new RpcError("invalid", `only a chat names a project; this task's runs have ${owner.project ?? "none"}`);
    if (!ctx?.config.projects[project])
      throw new RpcError(
        "invalid",
        `no project ${project} (${Object.keys(ctx?.config.projects ?? {}).join(", ") || "none registered"})`,
      );
    if (at !== undefined && script === undefined)
      throw new RpcError("invalid", "a one-shot `at` without a script wakes this chat, not a run: drop `project`");
  }
  if ([at, every, cron].filter((v) => v !== undefined).length !== 1)
    throw new RpcError("invalid", "give exactly one of at, every, cron");
  const tz = input.tz ?? ctx?.config.owner.tz ?? "UTC";
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
  } catch {
    throw new RpcError("invalid", `unknown timezone ${tz} (an IANA name, e.g. Asia/Tokyo)`);
  }
  if (script !== undefined && Buffer.byteLength(script) > MAX_SCRIPT)
    throw new RpcError("invalid", `script is ${Buffer.byteLength(script)} bytes; the limit is 16 KB`);
  const now = clock.now();
  const expires = cron === undefined ? lastHuman(taskId) + EXPIRY_MS : undefined;
  if (expires !== undefined && expires <= now)
    throw new RpcError(
      "invalid",
      `this task's timers expired at ${iso(expires)} (7 days after the last message that was not from a timer); use cron`,
    );
  let fire: number;
  if (at !== undefined) {
    fire = Date.parse(at);
    if (Number.isNaN(fire)) throw new RpcError("invalid", `at: not an ISO 8601 time: ${at}`);
    if (fire <= now) throw new RpcError("invalid", `at ${iso(fire)} is not in the future (now ${iso(now)})`);
    if (expires !== undefined && fire > expires)
      throw new RpcError(
        "invalid",
        `at is after this task's schedules expire (${iso(expires)}, 7 days after the last message)`,
      );
  } else if (every !== undefined) {
    if (every < MIN_INTERVAL) throw new RpcError("invalid", "minimum interval is 5 minutes (every ≥ 300)");
    fire = now + every * 1000;
  } else {
    const c = cronOf(cron as string, tz);
    const fires: Date[] = [];
    for (let d = cronNext(c, new Date(now)); d && fires.length < 11; d = cronNext(c, d)) fires.push(d);
    if (!fires[0]) throw new RpcError("invalid", `cron ${cron} never fires`);
    for (let i = 1; i < fires.length; i++)
      if ((fires[i] as Date).getTime() - (fires[i - 1] as Date).getTime() < MIN_INTERVAL * 1000)
        throw new RpcError("invalid", "minimum interval is 5 minutes (cron fires more often)");
    fire = fires[0].getTime();
  }
  const r = db()
    .prepare(
      `INSERT INTO schedules(task_id, fire_at, every_sec, cron, tz, text, script, expires_at, created, project)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(
      taskId,
      iso(fire),
      every ?? null,
      cron ?? null,
      tz,
      text,
      script ?? null,
      expires === undefined ? null : iso(expires),
      iso(now),
      project ?? null,
    ) as { id: number };
  log().info("scheduled", { id: r.id, task: taskId, fire_at: iso(fire) });
  bus.emit("tasks", { id: taskId });
  return { id: r.id, fire_at: iso(fire), expires_at: expires === undefined ? null : iso(expires) };
}

/** Moves a fired row on; false when it was a one-shot (now deleted). */
function advance(row: ScheduleRow, now: number): boolean {
  let next: number;
  if (row.every_sec) {
    next = Date.parse(row.fire_at as string);
    // every advances past now: overdue rows fire once, not once per missed interval
    while (next <= now) next += row.every_sec * 1000;
  } else if (row.cron) {
    next = cronNext(cronOf(row.cron, row.tz ?? "UTC"), new Date(now))?.getTime() ?? Number.NaN;
  } else {
    db().prepare("DELETE FROM schedules WHERE id = ?").run(row.id);
    return false;
  }
  if (Number.isNaN(next)) removeRow(row.id);
  else db().prepare("UPDATE schedules SET fire_at = ?, last_run = ? WHERE id = ?").run(iso(next), iso(now), row.id);
  return true;
}

/** The row's run that is still queued or running, if any: a row never has two at once. */
const activeRun = (id: number) =>
  db()
    .prepare(
      "SELECT t.id FROM task_refs r JOIN tasks t ON t.id = r.task_id WHERE r.ref = ? AND t.status IN ('queued', 'running')",
    )
    .get(`schedule:${id}`) as { id: string } | undefined;

/** One pass: expired rows deleted, due rows advanced and fired. Skipped while PAUSED. */
export function tick(): void {
  if (!ctx || existsSync(paths.paused())) return;
  const now = clock.now();
  const d = db();
  const expired = d.prepare("SELECT id FROM schedules WHERE expires_at <= ?").all(iso(now)) as { id: number }[];
  for (const { id } of expired) {
    try {
      removeRow(id);
      log().info("expired", { id });
    } catch (e) {
      log().error("expiring a row failed", e, { id });
    }
  }
  const due = d
    .prepare("SELECT * FROM schedules WHERE fire_at <= ? ORDER BY fire_at")
    .all(iso(now)) as unknown as ScheduleRow[];
  for (const row of due) {
    try {
      const task = tasks.get(row.task_id);
      // stays due: it fires at the first tick after the owner raises the budget
      if (runs.overBudget(task)) continue;
      const fired = new Date(Date.parse(row.fire_at as string));
      const recurring = advance(row, now);
      if (!recurring && !row.script) {
        tasks.inboxWrite(row.task_id, {
          from: `schedule:${row.id}`,
          trusted: true,
          text: row.expires_at ? `${row.text}\n\n${runs.expiry(row.expires_at)}` : row.text,
          data: { expires_at: row.expires_at },
        });
        continue;
      }
      const busy = activeRun(row.id);
      if (busy) {
        log().info("skipped: a run of this schedule is still active", { id: row.id, run: busy.id });
        continue;
      }
      runs.start(row, fired);
      crashPoint("schedules.after-fire");
    } catch (e) {
      log().error("firing failed", e, { id: row.id });
    }
  }
}

/** An inbox message not written by a schedule extends the rows of the task (or of a run's parent). */
function extend(t: tasks.TaskRow, msg: { from: string; ts: string }): void {
  if (!ctx || msg.from.startsWith("schedule:")) return;
  db()
    .prepare("UPDATE schedules SET expires_at = ? WHERE task_id = ? AND cron IS NULL")
    .run(iso(Date.parse(msg.ts) + EXPIRY_MS), t.parent ?? t.id);
}

define("schedule.set", { roles: ["worker"], input: SetInput, run: (i, caller) => set(i, caller) });

define("schedule.unset", {
  roles: ["worker", "owner"],
  input: z.object({ id: z.number().int() }),
  run({ id }, caller) {
    const row = db().prepare("SELECT task_id FROM schedules WHERE id = ?").get(id) as { task_id: string } | undefined;
    if (!row) throw new RpcError("not_found", `no schedule ${id}`);
    if (caller.role !== "owner" && row.task_id !== ownerOf(caller))
      throw new RpcError("forbidden", `schedule ${id} belongs to another task`);
    removeRow(id);
    bus.emit("tasks", { id: row.task_id });
    return { ok: true };
  },
});

/** With each row's last run's summary, as the Schedules page shows it. */
define("schedule.list", {
  roles: ["owner"],
  input: z.object({}).passthrough(),
  run: () =>
    withSummaries(
      ctx as Ctx,
      db()
        .prepare(
          "SELECT s.*, t.title FROM schedules s LEFT JOIN tasks t ON t.id = s.task_id ORDER BY s.task_id, s.fire_at",
        )
        .all() as unknown as ScheduleListRow[],
    ),
});

/** The owner fires a recurring row now: a run like the tick's, and the row's next firing stays where it was. */
define("schedule.fire", {
  roles: ["owner"],
  input: z.object({ id: z.number().int() }),
  run({ id }) {
    const row = db().prepare("SELECT * FROM schedules WHERE id = ?").get(id) as unknown as ScheduleRow | undefined;
    if (!row) throw new RpcError("not_found", `no schedule ${id}`);
    if (!row.every_sec && !row.cron)
      throw new RpcError("invalid", `schedule ${id} is a one-shot; it fires once, on time`);
    if (runs.overBudget(tasks.get(row.task_id)))
      throw new RpcError("invalid", `task ${row.task_id} is over budget; raise it first`);
    const busy = activeRun(id);
    if (busy) throw new RpcError("invalid", `a run of this schedule is still active (${busy.id})`);
    const now = clock.now();
    db().prepare("UPDATE schedules SET last_run = ? WHERE id = ?").run(iso(now), id);
    const run = runs.start(row, new Date(now));
    bus.emit("tasks", { id: row.task_id });
    return { id: run.id };
  },
});

/** A row's firings, newest first: `status` null when the run was deleted (it never reached the model). */
define("schedule.runs", {
  roles: ["owner"],
  input: z.object({ id: z.number().int() }),
  run: ({ id }) =>
    db()
      .prepare(
        `SELECT r.task_id, r.fired, t.status, COALESCE(json_extract(t.usage, '$.tokens'), 0) AS tokens
         FROM schedule_runs r LEFT JOIN tasks t ON t.id = r.task_id WHERE r.schedule_id = ? ORDER BY r.fired DESC`,
      )
      .all(id),
});

const drop = <T>(list: T[], x: T) => {
  const i = list.indexOf(x);
  if (i >= 0) list.splice(i, 1);
};

export const schedulesModule: Module = {
  name: "schedules",
  async start(c) {
    ctx = c;
    runs.bind(c);
    tasks.inboxHooks.push(extend);
    exitHooks.onExit.push(runs.onExit);
    timer = setInterval(tick, Number(process.env.HORTUS_SCHEDULE_TICK_MS) || 60_000);
    timer.unref();
  },
  async stop() {
    clearInterval(timer);
    drop(tasks.inboxHooks, extend);
    drop(exitHooks.onExit, runs.onExit);
    ctx = undefined;
  },
};
