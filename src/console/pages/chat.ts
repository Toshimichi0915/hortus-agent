import type { Ctx } from "../../ctx.ts";
import { details, h, isOpen, layout, type Page, parse, pausedLine, type Raw, raw, status } from "../html.ts";
import { approvalEntry, pendingFor } from "./approvals.ts";
import type { TaskRow } from "./tasks.ts";

export interface ReplyRow {
  seq: number;
  body: string;
  created: string | null;
}

/** One stdout line (StdoutLine JSON in `replies.body`) as HTML; also what the chat SSE sends. */
export function replyLine(r: ReplyRow): Raw {
  try {
    return line(r);
  } catch {
    // the row is the Worker's line: one whose JSON cannot be re-serialized (nested too deep) shows as its text
    return h`<div class="r text">${r.body.slice(0, 64 * 1024)}</div>`;
  }
}

function line(r: ReplyRow): Raw {
  const l = parse<Record<string, unknown>>(r.body);
  const text = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v ?? ""));
  if (!l || typeof l !== "object") return h`<div class="r text">${r.body}</div>`;
  switch (l.type) {
    case "thinking":
      return h`<div class="r thinking">${details("thinking", text(l.text))}</div>`;
    case "tool_call": {
      const input = l.input as Record<string, unknown> | undefined;
      const line =
        typeof input?.command === "string" ? `$ ${input.command}` : `${text(l.name)} ${JSON.stringify(input ?? {})}`;
      return h`<div class="r tool">${line}</div>`;
    }
    case "tool_result":
      return h`<div class="r result${l.isError ? " error" : ""}">${details("output", text(l.output))}</div>`;
    case "error":
      return h`<div class="r error">${text(l.message)}</div>`;
    case "status":
      return h`<div class="r status">${text(l.text)}</div>`;
    case "owner":
      return h`<div class="r owner">${text(l.text)}</div>`;
    case "message":
      return raw("");
    default:
      return h`<div class="r text">${text(l.text ?? r.body)}</div>`;
  }
}

export const lastReplies = (ctx: Ctx, task: string, after = -1, limit = 1000): ReplyRow[] =>
  (
    ctx.db
      .prepare("SELECT seq, body, created FROM replies WHERE task_id = ? AND seq > ? ORDER BY seq DESC LIMIT ?")
      .all(task, after, limit) as unknown as ReplyRow[]
  ).reverse();

/** The next rows after a cursor, oldest first. */
export const repliesAfter = (ctx: Ctx, task: string, after: number): ReplyRow[] =>
  ctx.db
    .prepare("SELECT seq, body, created FROM replies WHERE task_id = ? AND seq > ? ORDER BY seq LIMIT 1000")
    .all(task, after) as unknown as ReplyRow[];

/** `rows` is the newest of a task's stream: seqs start at 1, so what is missing is plain, and the session log has it. */
export const cutRows = (id: string, rows: ReplyRow[]): Raw => {
  const n = (rows[0]?.seq ?? 1) - 1;
  return n > 0
    ? h`<p class="hint more">${n.toLocaleString("en")} earlier lines not shown (a line can be a few words of a reply): the whole conversation is in <a href="/tasks/${id}/log" target="_blank" rel="noopener">session.md</a></p>`
    : raw("");
};

const composer = (method: string, input: unknown, extra: Raw = raw("")) =>
  h`<form class="composer" data-call="${method}" data-input="${JSON.stringify(input)}"${raw(
    method === "task.open" ? ' data-go="/chat/{id}"' : "",
  )}>${extra}<textarea name="text" rows="3" required placeholder="Message (Enter sends, Shift+Enter for a newline)"></textarea><button>Send</button></form>`;

export const chat: Page = (ctx, { m }) => {
  const id = m[1];
  if (id === undefined) {
    const projects = Object.entries(ctx.config.projects);
    return layout(
      ctx,
      "chat",
      "Chat",
      h`<p class="hint">Start a chat: the first message opens a task. Pick a project to work in its checkout.</p>${composer(
        "task.open",
        {},
        h`<label>Project <select name="cwd"><option value="">none (scratch directory)</option>${projects.map(
          ([name, p]) => h`<option value="${p.path}">${name}</option>`,
        )}</select></label>`,
      )}`,
    );
  }
  const t = ctx.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
  if (!t) return layout(ctx, "chat", "Chat", h`<p>no task ${id}</p>`);
  const rows = lastReplies(ctx, id);
  const last = rows.at(-1)?.seq ?? -1;
  return layout(
    ctx,
    "chat",
    t.title || id,
    h`<p><span data-refresh id="chat-status">${status(t.status)} · <a href="/tasks/${id}">task card</a></span> <span id="conn" class="hint" role="status"></span></p>
${isOpen(t.status) ? pausedLine(ctx) : ""}<div id="stream" data-task="${id}" data-last="${last}">${cutRows(id, rows)}${rows.map(replyLine)}</div>
<div data-refresh id="approvals">${pendingFor(ctx, id).map((a) => approvalEntry(a))}</div>
${isOpen(t.status) ? composer("task.send", { id }) : h`<p class="hint">This chat is closed. <a href="/chat">Start a new one</a>.</p>`}`,
  );
};
