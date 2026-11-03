import { budget, button, h, isOpen, layout, type Page, type Raw, status, time } from "../html.ts";

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
}

export const OPEN_SQL = "SELECT * FROM tasks WHERE status NOT IN ('done', 'failed') ORDER BY updated DESC";
export const CLOSED_SQL = "SELECT * FROM tasks WHERE status IN ('done', 'failed') ORDER BY closed DESC LIMIT 50";

/** Stop and close for an open task; nothing for a closed one. */
export function taskActions(t: TaskRow): Raw {
  if (!isOpen(t.status)) return h``;
  return h`${t.kind === "chat" ? h`<a href="/chat/${t.id}">chat</a> ` : ""}${
    t.status === "running" || t.status === "queued" ? button("Stop", "task.stop", { id: t.id }, { confirm: true }) : ""
  }${button("Close", "task.close", { id: t.id, outcome: "done" }, { confirm: true })}`;
}

const title = (t: TaskRow) => h`<a href="/tasks/${t.id}">${t.title || t.id}</a>`;

export const tasks: Page = (ctx) => {
  const open = ctx.db.prepare(OPEN_SQL).all() as unknown as TaskRow[];
  const closed = ctx.db.prepare(CLOSED_SQL).all() as unknown as TaskRow[];
  return layout(
    ctx,
    "tasks",
    "Tasks",
    h`<p><a href="/chat">New chat</a></p><div data-refresh id="list">
<h2>Open</h2>${
      open.length
        ? h`<table><thead><tr><th>Status</th><th>Title</th><th>Project</th><th>Kind</th><th>Budget</th><th>Updated</th><th></th></tr></thead><tbody>${open.map(
            (t) =>
              h`<tr><td>${status(t.status)}</td><td>${title(t)}</td><td>${t.project ?? ""}</td><td>${t.kind ?? ""}</td><td>${budget(t)}</td><td>${time(t.updated)}</td><td class="actions">${taskActions(t)}</td></tr>`,
          )}</tbody></table>`
        : h`<p class="empty">no open tasks</p>`
    }
<h2>Closed</h2>${
      closed.length
        ? h`<table class="closed"><thead><tr><th>Status</th><th>Title</th><th>Closed</th></tr></thead><tbody>${closed.map(
            (t) => h`<tr><td>${status(t.status)}</td><td>${title(t)}</td><td>${time(t.closed)}</td></tr>`,
          )}</tbody></table>`
        : h`<p class="empty">no closed tasks</p>`
    }</div>`,
  );
};
