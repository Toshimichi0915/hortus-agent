import type { Ctx } from "../../ctx.ts";
import { button, details, h, layout, type Page, parse, type Raw, raw, time } from "../html.ts";
import { type TransformSummary, transformForm, transformView } from "./transform-entry.ts";

export interface ApprovalRow {
  id: number;
  kind: string | null;
  category: string | null;
  task_id: string | null;
  summary: string | null;
  status: string | null;
  requested_at: string | null;
  decided_at: string | null;
  decided_by: string | null;
  reason: string | null;
}

type Summary = Record<string, unknown>;
const str = (v: unknown): string =>
  typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v);

function requestView(s: Summary): Raw {
  const headers =
    s.headers && typeof s.headers === "object" ? Object.entries(s.headers as Record<string, unknown>) : [];
  const body = str(s.bodyPreview);
  return h`<p class="req"><b>${str(s.method)}</b> ${str(s.host)}<span class="path">${str(s.path)}</span></p>
${headers.length ? h`<table class="kv">${headers.map(([k, v]) => h`<tr><th>${k}</th><td><code>${str(v)}</code></td></tr>`)}</table>` : ""}
${s.rendered ? h`<pre class="rendered">${str(s.rendered)}</pre>` : ""}
${body ? (body.length > 300 ? details(`body (${body.length} chars)`, body) : h`<pre>${body}</pre>`) : ""}`;
}

/** One case per kind; merge (3b), transforms (3f) and login (3h) fall back to the JSON until their steps add a view. */
export function summaryView(kind: string | null, category: string | null, summary: Summary | undefined): Raw {
  const s = summary ?? {};
  if (category === "transforms") return transformView(s as TransformSummary);
  switch (kind) {
    case "request":
      return requestView(s);
    case "grant":
      return h`<p>grant <b>${str(s.credential ?? category?.replace(/^credential:/, ""))}</b> to this task${
        s.host ? h` for ${str(s.host)}` : ""
      }</p>${s.method ? requestView(s) : details("details", s)}`;
    default:
      if (s.method || s.host) return requestView(s);
      return details(`${kind ?? "entry"} details`, s);
  }
}

function decidedLine(a: ApprovalRow): Raw {
  if (a.status === "pending") return raw("");
  const verb =
    a.status === "rejected"
      ? "rejected"
      : a.status === "expired"
        ? "expired"
        : a.decided_by === "judge"
          ? "allowed"
          : "approved";
  return h`<p class="decided">${verb}${a.decided_by ? h` by ${a.decided_by}` : ""}${a.decided_at ? h` at ${time(a.decided_at)}` : ""}${
    a.reason ? h` — ${a.reason}` : ""
  }</p>`;
}

export function approvalEntry(a: ApprovalRow): Raw {
  return h`<article class="approval ${a.status ?? ""}" id="a${a.id}">
<header><a href="/approvals/${a.id}">#${a.id}</a> <b>${a.category ?? a.kind ?? ""}</b>${
    a.task_id ? h` · task <a href="/tasks/${a.task_id}">${a.task_id}</a>` : ""
  } · ${time(a.requested_at)}</header>
${summaryView(a.kind, a.category, parse<Summary>(a.summary))}
${
  a.status === "pending" && a.category === "transforms"
    ? transformForm(a.id, parse<TransformSummary>(a.summary) ?? {})
    : a.status === "pending"
      ? h`<div class="actions">${button("Approve", "approval.decide", { id: a.id, decision: "approve" }, { cls: "ok" })}${button(
          "Reject",
          "approval.decide",
          { id: a.id, decision: "reject" },
          { cls: "bad" },
        )}</div>`
      : decidedLine(a)
}</article>`;
}

export const pendingFor = (ctx: Ctx, task: string): ApprovalRow[] =>
  ctx.db
    .prepare("SELECT * FROM approvals WHERE status = 'pending' AND task_id = ? ORDER BY id DESC")
    .all(task) as unknown as ApprovalRow[];

export const approvals: Page = (ctx, { m }) => {
  const id = m[1];
  if (id !== undefined) {
    const a = ctx.db.prepare("SELECT * FROM approvals WHERE id = ?").get(Number(id)) as ApprovalRow | undefined;
    return layout(
      ctx,
      "approvals",
      `Approval #${id}`,
      a ? h`<div data-refresh id="list">${approvalEntry(a)}</div>` : h`<p>not found</p>`,
    );
  }
  const pending = ctx.db
    .prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY id DESC")
    .all() as unknown as ApprovalRow[];
  const decided = ctx.db
    .prepare(
      "SELECT * FROM approvals WHERE status <> 'pending' ORDER BY coalesce(decided_at, requested_at) DESC LIMIT 50",
    )
    .all() as unknown as ApprovalRow[];
  return layout(
    ctx,
    "approvals",
    "Approvals",
    h`<div data-refresh id="list"><h2>Pending</h2>${pending.length ? pending.map(approvalEntry) : h`<p class="empty">nothing pending</p>`}
<h2>Decided</h2>${decided.length ? decided.map(approvalEntry) : h`<p class="empty">none yet</p>`}</div>`,
  );
};
