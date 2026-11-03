/**
 * The Approval Gate, policy `human` (F3). Records are `approvals` rows: `request` (one template hash, single use) and
 * `grant` (a credential for one task; durable grants and `auto` are 3e). Statuses: pending → approved | rejected |
 * expired; approved → used on the pass.
 */
import { logger } from "../log.ts";
import { type Caller, type InboxMsg, RpcError } from "../types.ts";
import { ctx } from "./vault.ts";

const log = logger("gate");

export type Summary = Record<string, unknown>;

/** Wired by the integration: the task inbox writer (step 3), owner.notify (step 4), the console's base URL. */
export const deps = {
  inboxWrite(taskId: string, msg: Omit<InboxMsg, "seq" | "ts">): void {
    log.info("inbox write not wired", { task: taskId, text: msg.text });
  },
  notify(text: string): void {
    log.info("owner.notify not wired", { text });
  },
  consoleUrl: "http://127.0.0.1:7700",
};

export const approvalUrl = (id: number): string => `${deps.consoleUrl}/approvals/${id}`;

export const EXPIRE_MS = 72 * 3600_000;

export interface CheckInput {
  caller: Caller;
  category: string;
  hash: string;
  summary: Summary;
  consequential: boolean;
  /** `grant`: a credential outside the task's scope.credentials (the hash is `grant:<name>`) */
  kind?: "request" | "grant";
}

export interface ApprovalRow {
  id: number;
  kind: string;
  category: string;
  hash: string;
  task_id: string | null;
  summary: string;
  status: string;
  requested_at: string;
  decided_at: string | null;
  decided_by: string | null;
  reason: string | null;
  payload: string | null;
}

export function check(input: CheckInput): "pass" | { pending: number } {
  if (input.caller.role === "core") return "pass";
  const db = ctx().db;
  const kind = input.kind ?? "request";
  const task = input.caller.task ?? null;
  // ponytail: policy "auto" is treated as human until 3e (judge, durable grants)
  const rows = db
    .prepare(
      "SELECT id, status FROM approvals WHERE kind = ? AND hash = ? AND task_id IS ? AND status IN ('pending', 'approved') ORDER BY id",
    )
    .all(kind, input.hash, task) as { id: number; status: string }[];
  const approved = rows.find((r) => r.status === "approved");
  if (approved) {
    // a grant stays approved; a request is single use (the conditional update wins one race)
    if (kind === "grant") return "pass";
    const r = db.prepare("UPDATE approvals SET status = 'used' WHERE id = ? AND status = 'approved'").run(approved.id);
    if (r.changes === 1) return "pass";
  }
  const pending = rows.find((r) => r.status === "pending");
  if (pending) return { pending: pending.id };
  const r = db
    .prepare(
      "INSERT INTO approvals(kind, category, hash, task_id, summary, status, requested_at, payload) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)",
    )
    .run(
      kind,
      input.category,
      input.hash,
      task,
      JSON.stringify(input.summary),
      new Date().toISOString(),
      JSON.stringify({ consequential: input.consequential }),
    );
  const id = Number(r.lastInsertRowid);
  log.info("approval pending", { id, category: input.category, task });
  try {
    deps.notify(`approval ${id} pending (${input.category})`);
  } catch (e) {
    log.error("notify failed", e, { id });
  }
  return { pending: id };
}

export function decide(
  id: number,
  decision: "approve" | "reject",
  by: "owner" | "judge",
  extra?: { reason?: string },
): void {
  const db = ctx().db;
  const row = db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as ApprovalRow | undefined;
  if (!row) throw new RpcError("not_found", `no approval ${id}`);
  const status = decision === "approve" ? "approved" : "rejected";
  const r = db
    .prepare(
      "UPDATE approvals SET status = ?, decided_at = ?, decided_by = ?, reason = ? WHERE id = ? AND status = 'pending'",
    )
    .run(status, new Date().toISOString(), by, extra?.reason ?? null, id);
  if (r.changes !== 1) throw new RpcError("invalid", "already decided");
  if (row.kind === "grant" && status === "approved" && row.task_id) addToScope(row.task_id, row.category);
  log.info("approval decided", { id, status, by });
  if (!row.task_id) return;
  try {
    deps.inboxWrite(row.task_id, {
      from: "approval",
      trusted: true,
      text: `approval ${id} ${status} (${row.category})${status === "approved" ? ": retry the request" : ""}${
        extra?.reason ? ` — ${extra.reason}` : ""
      }`,
      data: { approval: id, decision: status, category: row.category, reason: extra?.reason },
    });
  } catch (e) {
    log.error("inbox write failed", e, { id, task: row.task_id });
  }
}

/** A grant for `credential:<name>` adds the name to the task's scope.credentials. */
function addToScope(taskId: string, category: string): void {
  if (!category.startsWith("credential:")) return;
  const name = category.slice("credential:".length);
  const db = ctx().db;
  const t = db.prepare("SELECT scope FROM tasks WHERE id = ?").get(taskId) as { scope: string | null } | undefined;
  if (!t) return;
  const scope = (t.scope ? JSON.parse(t.scope) : {}) as { credentials?: string[] };
  if (scope.credentials?.includes(name)) return;
  scope.credentials = [...(scope.credentials ?? []), name];
  db.prepare("UPDATE tasks SET scope = ? WHERE id = ?").run(JSON.stringify(scope), taskId);
}

/** Every minute: pending entries older than 72 h become `expired`; a retry then creates a fresh entry. */
export function expire(now = Date.now()): number {
  const cutoff = new Date(now - EXPIRE_MS).toISOString();
  const r = ctx()
    .db.prepare("UPDATE approvals SET status = 'expired', decided_at = ? WHERE status = 'pending' AND requested_at < ?")
    .run(new Date(now).toISOString(), cutoff);
  return Number(r.changes);
}
