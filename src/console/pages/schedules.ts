import { button, h, layout, type Page, time } from "../html.ts";

interface Row {
  id: number;
  task_id: string;
  title: string | null;
  fire_at: string | null;
  every_sec: number | null;
  cron: string | null;
  text: string | null;
  last_run: string | null;
  summary: string | null;
}

const when = (r: Row) => (r.cron ? `cron ${r.cron}` : r.every_sec ? `every ${r.every_sec} s` : "once");

export const schedules: Page = (ctx) => {
  const rows = ctx.db
    .prepare(
      `SELECT s.id, s.task_id, t.title, s.fire_at, s.every_sec, s.cron, s.text, s.last_run, t.summary
       FROM schedules s LEFT JOIN tasks t ON t.id = s.task_id ORDER BY s.task_id, s.fire_at`,
    )
    .all() as unknown as Row[];
  return layout(
    ctx,
    "schedules",
    "Schedules",
    h`<div data-refresh id="list">${
      rows.length
        ? h`<table><thead><tr><th>Task</th><th>When</th><th>Next fire</th><th>Text</th><th>Last run</th><th></th></tr></thead><tbody>${rows.map(
            (r) =>
              h`<tr><td><a href="/tasks/${r.task_id}">${r.title || r.task_id}</a></td><td>${when(r)}</td><td>${time(r.fire_at)}</td><td>${
                r.text ?? ""
              }</td><td>${time(r.last_run)}${r.summary ? h`<details><summary>summary</summary><pre>${r.summary}</pre></details>` : ""}</td><td>${button(
                "Unschedule",
                "schedule.unset",
                { id: r.id },
                { confirm: true },
              )}</td></tr>`,
          )}</tbody></table>`
        : h`<p class="empty">no schedules</p>`
    }</div>`,
  );
};
