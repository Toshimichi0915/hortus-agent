/**
 * The Approval Gate (F3 `human`, 3e `auto`). Records are `approvals` rows: `request` (one template hash, single use; a
 * judge allow is a `request` row `allowed` by `judge`) and `grant` (a category enabled: durable when `task_id` is null,
 * else for that task only). Statuses: pending → approved | rejected | expired; approved → used on the pass.
 */
import { policyFor } from "../config.ts";
import { logger } from "../log.ts";
import { type Caller, type InboxMsg, RpcError } from "../types.ts";
import { judge } from "./judge.ts";
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
  /** a grant entry not bound to the task (the first use under `auto`); the requesting task rides in payload.task */
  durable?: boolean;
  /** an escalation by the judge: its reason (payload.judge) and prompt hash */
  judged?: { reason: string; prompt_hash?: string };
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
  prompt_hash?: string | null;
  reason: string | null;
  payload: string | null;
}

/** An approved grant on the category, durable or for this task. */
export function granted(category: string, task: string | null): boolean {
  const q = ctx().db.prepare(
    "SELECT 1 FROM approvals WHERE kind = 'grant' AND category = ? AND status = 'approved' AND (task_id IS NULL OR task_id = ?)",
  );
  return q.get(category, task) !== undefined;
}

const grantName = (category: string): string => category.replace(/^credential:/, "");

/**
 * The gate for a credentialed request (pipeline step 9). Role core passes; a consequential request or a `human`
 * category goes to the owner per request (`check`); under `auto` a grant is needed once (durable), then the judge
 * allows or escalates. Reads `ctx().config` per call, so a policy edit applies to the next request.
 */
export async function request(input: CheckInput): Promise<"pass" | { pending: number }> {
  if (input.caller.role === "core") return "pass";
  const c = ctx();
  if (input.consequential || policyFor(c.config, input.category) !== "auto") return check(input);
  const task = input.caller.task ?? null;
  if (!granted(input.category, task)) {
    const { method, host, path } = input.summary;
    return check({
      ...input,
      kind: "grant",
      durable: true,
      hash: `grant:${grantName(input.category)}`,
      summary: { grant: grantName(input.category), task, method, host, path },
    });
  }
  // an escalated request already waiting for (or approved by) the owner is not judged again
  const open = c.db
    .prepare(
      "SELECT 1 FROM approvals WHERE kind = 'request' AND hash = ? AND task_id IS ? AND status IN ('pending', 'approved')",
    )
    .get(input.hash, task);
  if (open) return check(input);
  const v = await judge(input.category, input.summary, task);
  if (v.verdict === "escalate") return check({ ...input, judged: v });
  const t = new Date().toISOString();
  c.db
    .prepare(
      "INSERT INTO approvals(kind, category, hash, task_id, summary, status, requested_at, decided_at, decided_by, prompt_hash, reason) VALUES ('request', ?, ?, ?, ?, 'allowed', ?, ?, 'judge', ?, ?)",
    )
    .run(input.category, input.hash, task, JSON.stringify(input.summary), t, t, v.prompt_hash ?? null, v.reason);
  return "pass";
}

/** The owner decides: an approved entry passes (a request once), else the pending one is reused or created. */
export function check(input: CheckInput): "pass" | { pending: number } {
  if (input.caller.role === "core") return "pass";
  const db = ctx().db;
  const kind = input.kind ?? "request";
  const requester = input.caller.task ?? null;
  const task = input.durable ? null : requester;
  // origin:* (always human): a grant on the origin passes every non-consequential request (v6 › Browser)
  if (
    kind === "request" &&
    input.category.startsWith("origin:") &&
    !input.consequential &&
    granted(input.category, task)
  )
    return "pass";
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
  // ponytail: a durable grant entry pending for one task is shared; only its requester hears the decision
  const pending = rows.find((r) => r.status === "pending");
  if (pending) return { pending: pending.id };
  const r = db
    .prepare(
      "INSERT INTO approvals(kind, category, hash, task_id, summary, status, requested_at, payload, prompt_hash) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)",
    )
    .run(
      kind,
      input.category,
      input.hash,
      task,
      JSON.stringify(input.summary),
      new Date().toISOString(),
      JSON.stringify({
        consequential: input.consequential,
        ...(input.durable ? { task: requester } : {}),
        ...(input.judged ? { judge: input.judged.reason } : {}),
      }),
      input.judged?.prompt_hash ?? null,
    );
  const id = Number(r.lastInsertRowid);
  log.info("approval pending", { id, kind, category: input.category, task: requester });
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
  // a durable grant entry tells the task whose request opened it
  const taskId = row.task_id ?? (row.payload ? (JSON.parse(row.payload) as { task?: string }).task : undefined);
  if (!taskId) return;
  try {
    deps.inboxWrite(taskId, {
      from: "approval",
      trusted: true,
      text: `approval ${id} ${status} (${row.category})${status === "approved" ? ": retry the request" : ""}${
        extra?.reason ? ` — ${extra.reason}` : ""
      }`,
      data: { approval: id, decision: status, category: row.category, reason: extra?.reason },
    });
  } catch (e) {
    log.error("inbox write failed", e, { id, task: taskId });
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
