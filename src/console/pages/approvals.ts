import type { Ctx } from "../../ctx.ts";
import { button, details, h, layout, more, PAGE, type Page, parse, type Raw, raw, skipOf, time } from "../html.ts";
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
  payload?: string | null;
}

type Summary = Record<string, unknown>;
const str = (v: unknown): string =>
  typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v);

function requestView(s: Summary): Raw {
  const headers =
    s.headers && typeof s.headers === "object" ? Object.entries(s.headers as Record<string, unknown>) : [];
  const body = str(s.bodyPreview);
  return h`<p class="req${s.method === "DELETE" ? " del" : ""}"><b>${str(s.method)}</b> ${str(s.host)}<span class="path">${str(s.path)}</span></p>
${headers.length ? h`<table class="kv">${headers.map(([k, v]) => h`<tr><th>${k}</th><td><code>${str(v)}</code></td></tr>`)}</table>` : ""}
${s.rendered ? h`<pre class="rendered">${str(s.rendered)}</pre>` : ""}
${body ? (body.length > 300 ? details(`body (${body.length} chars)`, body) : h`<pre>${body}</pre>`) : ""}`;
}

/**
 * project, `hortus/<id>` → main at main_sha[:7], `+a −r in n files`, the first 40 patch lines (≤ 8 KB), then the patch
 * folded on the entry's own page (`full`) or a link to it: lists stay small (50 merges were 3 MB of diffs a render).
 */
function mergeView(s: Summary, id: number | undefined, full: boolean): Raw {
  const patch = str(s.patch);
  const lines = patch.split("\n");
  const n = Number(s.files ?? 0);
  return h`<p class="req"><b>${str(s.project)}</b> <code>${str(s.branch)}</code> → <code>main</code> at <code>${str(s.main_sha).slice(0, 7)}</code> (tip <code>${str(s.sha).slice(0, 7)}</code>)</p>
<p class="stat">+${str(s.added)} −${str(s.removed)} in ${String(n)} file${n === 1 ? "" : "s"}</p>
<pre class="patch">${lines.slice(0, 40).join("\n").slice(0, 8192)}${lines.length > 40 ? "\n…" : ""}</pre>
${
  full || id === undefined
    ? details(`full diff${s.truncated ? " (first 64 KB)" : ""}`, patch)
    : h`<p><a href="/approvals/${id}">full diff (${String(lines.length)} lines)</a></p>`
}${details("stat", str(s.stat))}`;
}

/** One case per kind; merge (3b), transforms (3f) and login (3h) fall back to the JSON until their steps add a view. */
export function summaryView(
  kind: string | null,
  category: string | null,
  summary: Summary | undefined,
  taskId?: string | null,
  id?: number,
  full = false,
): Raw {
  const s = summary ?? {};
  if (category === "transforms") return transformView(s as TransformSummary);
  if (category === "merge") return mergeView(s, id, full);
  switch (kind) {
    case "request":
      return requestView(s);
    case "login":
      return h`<p class="req">sign in to <b>${str(s.origin)}</b>: <code>${str(s.url)}</code></p><p class="why">${str(s.why)}</p>`;
    case "grant":
      if (category?.startsWith("origin:"))
        return h`<p>reuse the stored login for <b>${category.slice(7)}</b> in this task${
          s.cookies ? h` (${str(s.cookies)} cookies)` : ""
        }${s.url ? h`: <code>${str(s.url)}</code>` : ""}</p>${s.why ? h`<p class="why">${str(s.why)}</p>` : ""}${
          s.method ? requestView(s) : ""
        }`;
      return h`<p class="grant">${
        taskId
          ? h`allow <b>${grantName(category, s)}</b> for this task only (outside its scope.credentials)`
          : h`enable <b>${grantName(category, s)}</b> for every task (durable)${s.task ? h`, first used by task ${str(s.task)}` : ""}`
      }; the request:</p>${s.method ? requestView(s) : details("details", s)}`;
    default:
      if (s.method || s.host) return requestView(s);
      return details(`${kind ?? "entry"} details`, s);
  }
}

const grantName = (category: string | null, s: Summary): string =>
  str(s.grant ?? category?.replace(/^credential:/, ""));

/** The entry's headline: a grant reads as what it enables, anything else as its category. */
function label(a: ApprovalRow): string {
  if (a.kind !== "grant") return a.category ?? a.kind ?? "";
  const name = grantName(a.category, parse<Summary>(a.summary) ?? {});
  // the header links the task already
  if (name.startsWith("origin:")) return `reuse the login for ${name.slice("origin:".length)}`;
  return a.task_id ? `allow ${name} for this task` : `enable ${name}`;
}

/** A judge allow: one line, so they do not bury the owner's decisions. The reason is verbatim, capped at 200 chars. */
function judgeLine(a: ApprovalRow): Raw {
  const s = parse<Summary>(a.summary) ?? {};
  const reason = a.reason ?? "";
  return h`<p class="judged" id="a${a.id}"><a href="/approvals/${a.id}">#${a.id}</a> ${a.category ?? ""}${
    a.task_id ? h` · <a href="/tasks/${a.task_id}">${a.task_id}</a>` : ""
  } · <b>${str(s.method)}</b> ${str(s.host)}${str(s.path)} · ${time(a.decided_at)} — allowed by judge: ${
    reason.length > 200 ? `${reason.slice(0, 199)}…` : reason
  } <a href="/settings">judge notes</a></p>`;
}

function decidedLine(a: ApprovalRow): Raw {
  if (a.status === "pending") return raw("");
  if (a.category === "merge") {
    const sha = str(parse<Summary>(a.summary)?.sha).slice(0, 7);
    if (a.status === "landed")
      return h`<p class="decided">landed <code>${sha}</code>${a.decided_at ? h` (approved ${time(a.decided_at)})` : ""}</p>`;
    if (a.status === "replaced") return h`<p class="decided">replaced${a.reason ? h` — ${a.reason}` : ""}</p>`;
    // approved but not landed: the reason, and a retry (a dirty checkout is transient)
    if (a.status === "approved" && a.decided_by === "owner" && a.reason)
      return h`<p class="decided error">approved, not landed — ${a.reason}</p><div class="actions">${button("Retry", "merge.retry", { id: a.id })}</div>`;
  }
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

/** `full`: the entry's own page (`/approvals/:id`), where a merge shows its whole diff. */
export function approvalEntry(a: ApprovalRow, full = false): Raw {
  const payload = a.status === "pending" ? parse<{ judge?: string; untrusted?: string[] }>(a.payload) : undefined;
  const escalated = payload?.judge;
  const untrusted = payload?.untrusted ?? [];
  return h`<article class="approval ${a.status ?? ""} kind-${a.kind ?? ""}" id="a${a.id}">
<header><a href="/approvals/${a.id}">#${a.id}</a> <b>${label(a)}</b>${
    a.task_id ? h` · task <a href="/tasks/${a.task_id}">${a.task_id}</a>` : ""
  } · ${time(a.requested_at)}</header>
${
  untrusted.length
    ? h`<p class="hint untrusted">tainted: ${untrusted.join("; ")}. Make sure the request is what you asked for, not what they asked for</p>`
    : ""
}
${escalated ? h`<p class="hint">escalated${untrusted.length ? "" : " by judge"}: ${escalated.slice(0, 200)}</p>` : ""}
${
  // a decided merge keeps its 40-line excerpt folded: the decided list stays scannable
  a.status !== "pending" && a.category === "merge"
    ? h`<details><summary>the change</summary>${summaryView(a.kind, a.category, parse<Summary>(a.summary), a.task_id, a.id, full)}</details>`
    : summaryView(a.kind, a.category, parse<Summary>(a.summary), a.task_id, a.id, full)
}
${
  a.status === "pending" && a.category === "transforms"
    ? transformForm(a.id, parse<TransformSummary>(a.summary) ?? {})
    : a.status === "pending" && a.kind === "login"
      ? h`<div class="actions"><a class="button ok" href="/approvals/${a.id}/login">Open login view</a>${button(
          "Reject",
          "login.reject",
          { id: a.id },
          { cls: "bad" },
        )}</div>`
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

export const approvals: Page = (ctx, { m, q }) => {
  const id = m[1];
  if (id !== undefined) {
    const a = ctx.db.prepare("SELECT * FROM approvals WHERE id = ?").get(Number(id)) as ApprovalRow | undefined;
    return layout(
      ctx,
      "approvals",
      `Approval #${id}`,
      a ? h`<div data-refresh id="list">${approvalEntry(a, true)}</div>` : h`<p>not found</p>`,
    );
  }
  const skip = skipOf(q);
  const pending = ctx.db
    .prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY id DESC LIMIT ? OFFSET ?")
    .all(PAGE, skip) as unknown as ApprovalRow[];
  const hideJudge = q.get("judge") === "hide";
  const where = `status <> 'pending'${hideJudge ? " AND decided_by IS NOT 'judge'" : ""}`;
  const decided = ctx.db
    .prepare(`SELECT * FROM approvals WHERE ${where} ORDER BY coalesce(decided_at, requested_at) DESC LIMIT ? OFFSET ?`)
    .all(PAGE, skip) as unknown as ApprovalRow[];
  const count = (sql: string) =>
    (ctx.db.prepare(`SELECT count(*) AS n FROM approvals WHERE ${sql}`).get() as { n: number }).n;
  return layout(
    ctx,
    "approvals",
    "Approvals",
    h`<div data-refresh id="list"><h2>Pending</h2>${more(q, "pending", pending.length, count("status = 'pending'"))}${pending.length ? pending.map((a) => approvalEntry(a)) : h`<p class="empty">nothing pending</p>`}
<h2>Decided</h2><p class="hint">${
      hideJudge
        ? h`<a href="/approvals">show judge allows</a>`
        : h`<a href="/approvals?judge=hide">hide judge allows</a>`
    }</p>${more(q, "decided", decided.length, count(where))}${
      decided.length
        ? decided.map((a) => (a.decided_by === "judge" ? judgeLine(a) : approvalEntry(a)))
        : h`<p class="empty">none yet</p>`
    }</div>`,
  );
};
