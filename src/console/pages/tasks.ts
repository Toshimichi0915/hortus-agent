import type { DatabaseSync } from "../../db.ts";
import {
  budget,
  button,
  empty,
  errorLine,
  h,
  isOpen,
  layout,
  more,
  PAGE,
  type Page,
  pausedLine,
  type Raw,
  skipOf,
  status,
  time,
} from "../html.ts";

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
}

// ponytail: OFFSET paging (rows shift while tasks update; deep pages scan); a keyset cursor if that bites
const OPEN = "status NOT IN ('done', 'failed')";
const CLOSED = "status IN ('done', 'failed')";
export const OPEN_SQL = `SELECT * FROM tasks WHERE ${OPEN} ORDER BY updated DESC LIMIT ? OFFSET ?`;
export const CLOSED_SQL = `SELECT * FROM tasks WHERE ${CLOSED} ORDER BY closed DESC LIMIT ? OFFSET ?`;
export const countTasks = (db: DatabaseSync, open: boolean): number =>
  (db.prepare(`SELECT count(*) AS n FROM tasks WHERE ${open ? OPEN : CLOSED}`).get() as { n: number }).n;

/** Stop and close for an open task; nothing for a closed one. */
export function taskActions(t: TaskRow): Raw {
  if (!isOpen(t.status)) return h``;
  return h`${t.kind === "chat" ? h`<a href="/chat/${t.id}">chat</a> ` : ""}${
    t.status === "running" || t.status === "queued" ? button("Stop", "task.stop", { id: t.id }, { confirm: true }) : ""
  }${button("Close", "task.close", { id: t.id, outcome: "done" }, { confirm: true })}`;
}

const title = (t: TaskRow) => h`<a href="/tasks/${t.id}">${t.title || t.id}</a>`;

export const tasks: Page = (ctx, { q }) => {
  const skip = skipOf(q);
  const open = ctx.db.prepare(OPEN_SQL).all(PAGE, skip) as unknown as TaskRow[];
  const closed = ctx.db.prepare(CLOSED_SQL).all(PAGE, skip) as unknown as TaskRow[];
  return layout(
    ctx,
    "tasks",
    "Tasks",
    h`<p><a href="/chat">New chat</a></p><div data-refresh id="list">${pausedLine(ctx)}
<h2>Open</h2>${more(q, "open tasks", open.length, countTasks(ctx.db, true))}${
      open.length
        ? h`<table><thead><tr><th>Status</th><th>Title</th><th>Project</th><th>Kind</th><th>Budget</th><th>Updated</th><th></th></tr></thead><tbody>${open.map(
            (t) =>
              h`<tr><td>${status(t.status)}</td><td>${title(t)}${t.error ? h`<br><span class="error">${errorLine(t.error)}</span>` : ""}</td><td>${t.project ?? ""}</td><td>${t.kind ?? ""}</td><td>${budget(t)}</td><td>${time(t.updated)}</td><td class="actions">${taskActions(t)}</td></tr>`,
          )}</tbody></table>`
        : empty(q, "no open tasks")
    }
<h2>Closed</h2>${more(q, "closed tasks", closed.length, countTasks(ctx.db, false))}${
      closed.length
        ? h`<table class="closed"><thead><tr><th>Status</th><th>Title</th><th>Closed</th></tr></thead><tbody>${closed.map(
            (t) => h`<tr><td>${status(t.status)}</td><td>${title(t)}</td><td>${time(t.closed)}</td></tr>`,
          )}</tbody></table>`
        : empty(q, "no closed tasks")
    }</div>`,
  );
};
