import { join } from "node:path";
import type { Ctx } from "../../ctx.ts";
import { readCapped } from "../../hostile.ts";
import { button, details, h, layout, type Page, time } from "../html.ts";

export interface ScheduleListRow {
  id: number;
  task_id: string;
  title: string | null;
  fire_at: string | null;
  every_sec: number | null;
  cron: string | null;
  tz: string | null;
  text: string | null;
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

const inTz = (iso: string, tz: string) =>
  `${new Intl.DateTimeFormat("sv-SE", { timeZone: tz, dateStyle: "short", timeStyle: "short" }).format(new Date(iso))} ${tz}`;

/** Rows by task; also used on a task's card for its own rows. */
export function scheduleTable(rows: ScheduleListRow[], tz: string, withTask = true) {
  const next = (iso: string | null) =>
    iso ? h`<time datetime="${iso}" data-rel title="${inTz(iso, tz)}">${relative(iso)}</time>` : time(null);
  return h`<table><thead><tr>${withTask ? h`<th>Task</th>` : ""}<th>Text</th><th>Kind</th><th>Next fire</th><th>Last run</th><th>Expires</th><th></th></tr></thead><tbody>${rows.map(
    (r) =>
      h`<tr>${withTask ? h`<td><a href="/tasks/${r.task_id}">${r.title || r.task_id}</a></td>` : ""}<td class="pre">${r.text ?? ""}</td><td>${kindOf(r)}</td><td>${next(r.fire_at)}</td><td>${time(r.last_run)}${r.summary ? details("summary", r.summary) : ""}</td><td>${r.expires_at ? time(r.expires_at) : "never"}</td><td>${button(
        "Unschedule",
        "schedule.unset",
        { id: r.id },
        { confirm: true },
      )}</td></tr>`,
  )}</tbody></table>`;
}

export const schedules: Page = (ctx) => {
  const rows = ctx.db
    .prepare(
      `SELECT s.id, s.task_id, t.title, s.fire_at, s.every_sec, s.cron, s.tz, s.text, s.last_run, s.expires_at
       FROM schedules s LEFT JOIN tasks t ON t.id = s.task_id ORDER BY s.task_id, s.fire_at`,
    )
    .all() as unknown as ScheduleListRow[];
  return layout(
    ctx,
    "schedules",
    "Schedules",
    h`<div data-refresh id="list">${rows.length ? scheduleTable(withSummaries(ctx, rows), ctx.config.owner.tz) : h`<p class="empty">no schedules</p>`}</div>`,
  );
};
