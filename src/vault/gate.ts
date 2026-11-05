/**
 * The Approval Gate (F3 `human`, 3e `auto`). Records are `approvals` rows: `request` (one template hash, single use; a
 * judge allow is a `request` row `allowed` by `judge`) and `grant` (a category enabled: durable when `task_id` is null,
 * else for that task only). Statuses: pending → approved | rejected | expired; approved → used on the pass.
 */
import { policyFor } from "../config.ts";
import { bus } from "../console/events.ts";
import { crashPoint } from "../crash.ts";
import { family, taintOf } from "../db.ts";
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

/** An approved grant on the category for this task, its parent or a run of theirs (`family`). */
function familyGranted(category: string, task: string, extra = ""): boolean {
  const q = ctx().db.prepare(
    `SELECT 1 FROM approvals WHERE kind = 'grant' AND category = ? AND status = 'approved' AND task_id IN (SELECT value FROM json_each(?))${extra}`,
  );
  return q.get(category, JSON.stringify(family(ctx().db, task))) !== undefined;
}

/** An approved grant on the category, durable or for this task. */
export function granted(category: string, task: string | null): boolean {
  const durable = ctx().db.prepare(
    "SELECT 1 FROM approvals WHERE kind = 'grant' AND category = ? AND status = 'approved' AND task_id IS NULL",
  );
  return durable.get(category) !== undefined || (task !== null && familyGranted(category, task));
}

/**
 * A grant on the category for this task that the owner approved on an entry showing the task's taint (its payload's
 * `untrusted`): a scope grant asked while tainted, or "Approve, and allow … for this task". A durable grant never is.
 * ponytail: it covers taint the task gains later too (taint is for good, and the owner already chose to trust the
 * task with the category); compare reasons if that bites.
 */
function taintGranted(category: string, task: string | null): boolean {
  return task !== null && familyGranted(category, task, " AND json_extract(payload, '$.untrusted') IS NOT NULL");
}

const grantName = (category: string): string => category.replace(/^credential:/, "");

/** The tasks an entry's decision goes to: its own, or a durable grant's opener and every task that met it since. */
function requesters(row: Pick<ApprovalRow, "task_id" | "payload">): string[] {
  if (row.task_id) return [row.task_id];
  const p = (row.payload ? JSON.parse(row.payload) : {}) as { task?: string; waiting?: string[] };
  return [...(p.task ? [p.task] : []), ...(p.waiting ?? [])];
}

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
  // a tainted task (v7 › Review round 6: untrusted messages, a web page, a stranger's search hit, a tainted batch):
  // the judge sees only the brief and the request, so the owner decides, once per task if they grant the category
  // to it (round 7: a task grant taken while the entry showed the taint)
  const tainted = taintOf(c.db, task, c.config);
  if (tainted.length)
    return taintGranted(input.category, task)
      ? "pass"
      : check({ ...input, judged: { reason: `tainted: ${tainted.join("; ")}` } });
  // the judge reads the preview: padding must not push what the request does past it (the owner sees the cut)
  if (input.summary.cut) return check({ ...input, judged: { reason: "a body too long for the judge to read whole" } });
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
  // a scope grant asked by a run: its parent's cover it. Never a durable one here: that enables a credential, not the task
  if (kind === "grant" && task !== null && familyGranted(input.category, task)) return "pass";
  const rows = db
    .prepare(
      "SELECT id, status, task_id, payload FROM approvals WHERE kind = ? AND hash = ? AND task_id IS ? AND status IN ('pending', 'approved') ORDER BY id",
    )
    .all(kind, input.hash, task) as unknown as Pick<ApprovalRow, "id" | "status" | "task_id" | "payload">[];
  const approved = rows.find((r) => r.status === "approved");
  if (approved) {
    // a grant stays approved; a request is single use (the conditional update wins one race)
    if (kind === "grant") return "pass";
    const r = db.prepare("UPDATE approvals SET status = 'used' WHERE id = ? AND status = 'approved'").run(approved.id);
    if (r.changes === 1) return "pass";
  }
  // a durable grant entry pending is shared: every task that met it is told the decision (payload.waiting)
  const pending = rows.find((r) => r.status === "pending");
  if (pending) {
    const told = requesters(pending);
    if (input.durable && requester && !told.includes(requester)) {
      const p = JSON.parse(pending.payload ?? "{}") as { waiting?: string[] };
      p.waiting = [...(p.waiting ?? []), requester];
      db.prepare("UPDATE approvals SET payload = ? WHERE id = ?").run(JSON.stringify(p), pending.id);
    }
    return { pending: pending.id };
  }
  const untrusted = taintOf(db, requester, ctx().config);
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
        ...(untrusted.length ? { untrusted } : {}),
      }),
      input.judged?.prompt_hash ?? null,
    );
  const id = Number(r.lastInsertRowid);
  log.info("approval pending", { id, kind, category: input.category, task: requester });
  bus.emit("approvals", { id, task: requester }); // the Approvals page, a chat's inline entries, the nav badge
  try {
    deps.notify(
      `approval ${id} pending (${input.category})${untrusted.length ? `; tainted: ${untrusted.join("; ")}` : ""}`,
    );
  } catch (e) {
    log.error("notify failed", e, { id });
  }
  return { pending: id };
}

export const NOTIFY_MS = 60_000;

/**
 * `send` at most once per `ms`: the first text goes at once, what arrives within the window is counted and sent as one
 * `more(N)` when it closes. owner.notify's DM goes through it: a burst of 200 pending approvals is two DMs, not 200 into
 * the messenger's rate limit.
 */
export function coalesce(
  send: (text: string) => void,
  ms = NOTIFY_MS,
  more = (n: number) => `${n} more approval${n > 1 ? "s" : ""} pending`,
): (text: string) => void {
  let held = 0;
  let window: NodeJS.Timeout | undefined;
  const fire = (text: string): void => {
    send(text);
    window = setTimeout(() => {
      window = undefined;
      const n = held;
      held = 0;
      if (n) fire(more(n));
    }, ms);
    window.unref();
  };
  return (text) => {
    if (window) held++;
    else fire(text);
  };
}

/**
 * The entry may be approved with a task grant: an `auto` request sent to the owner only because its task is tainted
 * (not consequential: those ask every time, v6).
 */
export function grantable(row: { kind: string | null; task_id: string | null; payload?: string | null }): boolean {
  if (row.kind !== "request" || !row.task_id || !row.payload) return false;
  const p = JSON.parse(row.payload) as { consequential?: boolean; judge?: string };
  return !p.consequential && !!p.judge?.startsWith("tainted:");
}

/** `grant`: also approve the entry's category for its task (a `grantable` entry only), see `taintGranted`. */
export function decide(
  id: number,
  decision: "approve" | "reject",
  by: "owner" | "judge",
  extra?: { reason?: string; grant?: boolean },
): void {
  const db = ctx().db;
  const row = db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as ApprovalRow | undefined;
  if (!row) throw new RpcError("not_found", `no approval ${id}`);
  const grant = extra?.grant && decision === "approve";
  if (grant && !grantable(row)) throw new RpcError("invalid", "this entry cannot be approved with a task grant");
  const status = decision === "approve" ? "approved" : "rejected";
  const t = new Date().toISOString();
  atomic(() => applyDecision(row, status, t, by, extra, grant));
}

function applyDecision(
  row: ApprovalRow,
  status: "approved" | "rejected",
  t: string,
  by: "owner" | "judge",
  extra: { reason?: string } | undefined,
  grant: boolean | undefined,
): void {
  const db = ctx().db;
  const id = row.id;
  const r = db
    .prepare(
      "UPDATE approvals SET status = ?, decided_at = ?, decided_by = ?, reason = ? WHERE id = ? AND status = 'pending'",
    )
    .run(status, t, by, extra?.reason ?? null, id);
  if (r.changes !== 1) throw new RpcError("invalid", "already decided");
  if (grant)
    db.prepare(
      "INSERT INTO approvals(kind, category, hash, task_id, summary, status, requested_at, decided_at, decided_by, payload) VALUES ('grant', ?, ?, ?, ?, 'approved', ?, ?, ?, ?)",
    ).run(
      row.category,
      `grant:${grantName(row.category)}`,
      row.task_id,
      JSON.stringify({ grant: grantName(row.category), task: row.task_id, from: id }),
      t,
      t,
      by,
      JSON.stringify({ untrusted: taintOf(db, row.task_id, ctx().config) }),
    );
  if (row.kind === "grant" && status === "approved" && row.task_id) addToScope(row.task_id, row.category);
  log.info("approval decided", { id, status, by });
  bus.emit("approvals", { id }); // another tab, the CLI or the phone decided: every open page follows
  crashPoint("gate.decide.before-inbox");
  for (const taskId of requesters(row))
    try {
      deps.inboxWrite(taskId, {
        from: "approval",
        trusted: true,
        text: `approval ${id} ${status} (${row.category})${status === "approved" ? ": retry the request" : ""}${
          grant ? "; the owner allowed the category for this task (consequential requests still ask)" : ""
        }${extra?.reason ? ` — ${extra.reason}` : ""}`,
        data: { approval: id, decision: status, category: row.category, reason: extra?.reason },
      });
    } catch (e) {
      log.error("inbox write failed", e, { id, task: taskId });
    }
}

/**
 * Round 8: a decision (or an expiry), its task grant and its inbox messages commit together; a crash between them
 * left the entry decided and its tasks never told, waiting for good. A SAVEPOINT nests in a caller's transaction
 * (submit.ts). A crash rolls it all back to pending (the owner decides again); an inbox file already renamed stays, a
 * stale "retry" the Worker meets as a 403 pending. At depth 0 the SAVEPOINT is a deferred transaction, unlike every
 * BEGIN IMMEDIATE here: fine while `f` writes first (both do: a write waits busy_timeout, only a read then a write fails
 * at once).
 */
function atomic(f: () => void): void {
  const db = ctx().db;
  db.exec("SAVEPOINT gate");
  try {
    f();
  } catch (e) {
    db.exec("ROLLBACK TO gate");
    throw e;
  } finally {
    db.exec("RELEASE gate");
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

/**
 * Every minute: pending entries older than 72 h become `expired`; a retry then creates a fresh entry. The requesting
 * task hears it as it would a rejection (v6: "expires as rejected"): a Worker waiting on the entry was otherwise
 * left waiting for good, with nothing pending on its card.
 */
export function expire(now = Date.now()): number {
  const cutoff = new Date(now - EXPIRE_MS).toISOString();
  let rows: Pick<ApprovalRow, "id" | "category" | "task_id" | "payload">[] = [];
  atomic(() => {
    rows = ctx()
      .db.prepare(
        "UPDATE approvals SET status = 'expired', decided_at = ? WHERE status = 'pending' AND requested_at < ? RETURNING id, category, task_id, payload",
      )
      .all(new Date(now).toISOString(), cutoff) as typeof rows;
    if (rows.length) crashPoint("gate.expire.before-inbox");
    tellExpired(rows);
  });
  if (rows.length) bus.emit("approvals", {});
  return rows.length;
}

function tellExpired(rows: Pick<ApprovalRow, "id" | "category" | "task_id" | "payload">[]): void {
  for (const a of rows)
    for (const taskId of requesters(a))
      try {
        deps.inboxWrite(taskId, {
          from: "approval",
          trusted: true,
          text: `approval ${a.id} expired (${a.category}): the owner did not decide within 72 h: take it as rejected, do not ask again`,
          data: { approval: a.id, decision: "expired", category: a.category },
        });
      } catch (e) {
        log.error("inbox write failed", e, { id: a.id, task: taskId });
      }
}
