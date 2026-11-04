import { join } from "node:path";
import { taintOf } from "../../db.ts";
import { readCapped } from "../../hostile.ts";
import {
  budget,
  button,
  details,
  errorLine,
  h,
  isOpen,
  layout,
  more,
  PAGE,
  type Page,
  parse,
  skipOf,
  time,
} from "../html.ts";
import { approvalEntry, pendingFor } from "./approvals.ts";
import { lastReplies, replyLine } from "./chat.ts";
import { type ScheduleListRow, scheduleTable } from "./schedules.ts";
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

/** The last 64 KB of `out/console.log` (a VM's serial output, an unattended session's stdout and stderr). */
function tail(f: string): string | null {
  return readCapped(f, 64 * 1024, true)?.text ?? null; // the Worker's file: no links, FIFOs
}

export const task: Page = (ctx, { m, q }) => {
  const id = m[1] as string;
  const t = ctx.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
  if (!t) return layout(ctx, "tasks", "Task", h`<p>no task ${id}</p>`);
  // the newest PAGE of each, oldest first; `?skip=` pages back (a scheduled task's 5,000 posts were a 3 MB card)
  const skip = skipOf(q);
  const box = (table: "outbox" | "inbox") => ({
    rows: (
      ctx.db
        .prepare(`SELECT seq, body, created FROM ${table} WHERE task_id = ? ORDER BY seq DESC LIMIT ? OFFSET ?`)
        .all(id, PAGE, skip) as unknown as MsgRow[]
    ).reverse(),
    total: (ctx.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE task_id = ?`).get(id) as { n: number }).n,
  });
  const outbox = box("outbox");
  const inbox = box("inbox");
  const replies = lastReplies(ctx, id, -1, 200);
  const timers = ctx.db
    .prepare("SELECT * FROM schedules WHERE task_id = ? ORDER BY fire_at")
    .all(id) as unknown as ScheduleListRow[];
  // a Planner-created task: the event it came from (15-planner.md › UI/UX)
  const origin = ctx.db
    .prepare("SELECT dof, author, refs, summary FROM events WHERE task_id = ? ORDER BY id LIMIT 1")
    .get(id) as { dof: string; author: string | null; refs: string | null; summary: string | null } | undefined;
  const channel = origin ? (parse<string[]>(origin.refs)?.[0]?.split(":")[1] ?? "—") : "";
  const open = isOpen(t.status);
  const tainted = taintOf(ctx.db, id, ctx.config);
  const pending = pendingFor(ctx, id);
  const up =
    t.runtime === "vm" && t.status === "running" && t.started
      ? ` · up ${Math.round((Date.now() - Date.parse(t.started)) / 60_000)} min`
      : "";
  const log = t.kind === "chat" ? null : tail(join(ctx.paths.out(id), "console.log"));
  return layout(
    ctx,
    "tasks",
    t.title || id,
    h`<div data-refresh id="card">
${t.error ? h`<div class="r error">${errorLine(t.error)}${t.error.includes("\n") ? details("full error", t.error) : ""}</div>` : ""}
<section class="summary">${t.summary ? h`<pre>${t.summary}</pre>` : h`<p class="empty">no summary yet</p>`}</section>
${t.brief ? details("Brief", t.brief) : ""}
<table class="kv">
<tr><th>Status</th><td>${t.status ?? ""}${t.outcome ? ` (${t.outcome})` : ""}</td></tr>
<tr><th>Kind</th><td>${t.kind ?? ""}</td></tr><tr><th>Runtime</th><td>${t.runtime ?? "host"}${up}</td></tr>
<tr><th>Project</th><td>${t.project ?? "—"}</td></tr>
${origin ? h`<tr><th>Origin</th><td>${origin.dof} · channel ${channel} · author ${origin.author ?? "—"}<br><span class="pre">${origin.summary ?? ""}</span></td></tr>` : ""}
${tainted.length ? h`<tr><th>Tainted</th><td class="untrusted">${tainted.join("; ")} (the owner decides its gated requests)</td></tr>` : ""}
<tr><th>Budget</th><td>${budget(t)}</td></tr><tr><th>Created</th><td>${time(t.created)}</td></tr>
<tr><th>Updated</th><td>${time(t.updated)}</td></tr>${t.closed ? h`<tr><th>Closed</th><td>${time(t.closed)}</td></tr>` : ""}
</table>
<p><a href="/tasks/${id}/log" target="_blank" rel="noopener">session.md</a></p>${log ? details("console.log", log) : ""}
<div class="actions">${taskActions(t)}${open ? button("Close as failed", "task.close", { id, outcome: "failed" }, { confirm: true }) : ""}</div>
${pending.length ? h`<h2>Waiting for you</h2>${pending.map((a) => approvalEntry(a))}` : ""}
${timers.length ? h`<h2>Schedules</h2>${scheduleTable(timers, ctx.config.owner.tz, false)}` : ""}
<h2>Messages</h2>${more(q, "messages", outbox.rows.length, outbox.total)}${outbox.rows.length ? h`<ul class="msgs">${outbox.rows.map(msg)}</ul>` : h`<p class="empty">none</p>`}
<h2>Stream</h2>${replies.length ? h`<div class="stream">${replies.map((r) => h`<div class="line">${time(r.created)} ${replyLine(r)}</div>`)}</div>` : h`<p class="empty">none</p>`}
<h2>Inbox</h2>${more(q, "inbox messages", inbox.rows.length, inbox.total)}${inbox.rows.length ? h`<ul class="msgs">${inbox.rows.map(msg)}</ul>` : h`<p class="empty">empty</p>`}
</div>${
      open
        ? h`<h2>Note to the task</h2><form data-call="task.message" data-input="${JSON.stringify({ id })}"><textarea name="text" rows="2" required></textarea><button>Send note</button></form>
<h2>Budget</h2><form data-call="task.budget" data-input="${JSON.stringify({ id })}"><label>tokens <input type="number" name="tokens" min="0"></label> <label>hours <input type="number" name="hours" min="0" step="0.5"></label> <button>Set budget</button></form>`
        : ""
    }`,
  );
};
