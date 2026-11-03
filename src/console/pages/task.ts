import { budget, button, h, isOpen, layout, type Page, parse, time } from "../html.ts";
import { approvalEntry, pendingFor } from "./approvals.ts";
import { lastReplies, replyLine } from "./chat.ts";
import { type TaskRow, taskActions } from "./tasks.ts";

interface MsgRow {
  seq: number;
  body: string;
  created: string | null;
}

const msg = (r: MsgRow) => {
  const b = parse<{ from?: string; type?: string; text?: string }>(r.body);
  return h`<li>${time(r.created)} <b>${b?.from ?? b?.type ?? ""}</b> <span class="pre">${b?.text ?? r.body}</span></li>`;
};

export const task: Page = (ctx, { m }) => {
  const id = m[1] as string;
  const t = ctx.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
  if (!t) return layout(ctx, "tasks", "Task", h`<p>no task ${id}</p>`);
  const outbox = ctx.db
    .prepare("SELECT seq, body, created FROM outbox WHERE task_id = ? ORDER BY seq")
    .all(id) as unknown as MsgRow[];
  const inbox = (
    ctx.db
      .prepare("SELECT seq, body, created FROM inbox WHERE task_id = ? ORDER BY seq DESC LIMIT 50")
      .all(id) as unknown as MsgRow[]
  ).reverse();
  const replies = lastReplies(ctx, id, -1, 200);
  const open = isOpen(t.status);
  return layout(
    ctx,
    "tasks",
    t.title || id,
    h`<div data-refresh id="card">
<section class="summary">${t.summary ? h`<pre>${t.summary}</pre>` : h`<p class="empty">no summary yet</p>`}</section>
<table class="kv">
<tr><th>Status</th><td>${t.status ?? ""}${t.outcome ? ` (${t.outcome})` : ""}</td></tr>
<tr><th>Kind</th><td>${t.kind ?? ""}</td></tr><tr><th>Project</th><td>${t.project ?? "—"}</td></tr>
<tr><th>Budget</th><td>${budget(t)}</td></tr><tr><th>Created</th><td>${time(t.created)}</td></tr>
<tr><th>Updated</th><td>${time(t.updated)}</td></tr>${t.closed ? h`<tr><th>Closed</th><td>${time(t.closed)}</td></tr>` : ""}
</table>
<p><a href="/tasks/${id}/log" target="_blank" rel="noopener">session.md</a></p>
<div class="actions">${taskActions(t)}${open ? button("Close as failed", "task.close", { id, outcome: "failed" }, { confirm: true }) : ""}</div>
${pendingFor(ctx, id).map(approvalEntry)}
<h2>Messages</h2>${outbox.length ? h`<ul class="msgs">${outbox.map(msg)}</ul>` : h`<p class="empty">none</p>`}
<h2>Stream</h2>${replies.length ? h`<div class="stream">${replies.map((r) => h`<div class="line">${time(r.created)} ${replyLine(r)}</div>`)}</div>` : h`<p class="empty">none</p>`}
<h2>Inbox</h2>${inbox.length ? h`<ul class="msgs">${inbox.map(msg)}</ul>` : h`<p class="empty">empty</p>`}
</div>${
      open
        ? h`<h2>Note to the task</h2><form data-call="task.message" data-input="${JSON.stringify({ id })}"><textarea name="text" rows="2" required></textarea><button>Send note</button></form>
<h2>Budget</h2><form data-call="task.budget" data-input="${JSON.stringify({ id })}"><label>tokens <input type="number" name="tokens" min="0"></label> <label>hours <input type="number" name="hours" min="0" step="0.5"></label> <button>Set budget</button></form>`
        : ""
    }`,
  );
};
