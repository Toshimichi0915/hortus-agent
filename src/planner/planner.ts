/**
 * The Planner's batch loop (docs/design/15-planner.md): `wake()` (gateway, a non-chat result, recovery, unpause) →
 * after 2 s one batch of unconsumed events and results, marked consumed before the run, rendered by `renderBatch` as
 * the one user message of a one-shot `planner` session (`tasks/planner-<n>/`, deleted after the run). Guards: PAUSED,
 * `planner.daily_tokens`. The verdicts come back as RPCs (tools.ts).
 */
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { quote } from "../agent/inbox.ts";
import { type Config, today } from "../config.ts";
import { PR_TURN } from "../connectors/forge.ts";
import { bus } from "../console/events.ts";
import { errorLine, parse, tokens } from "../console/html.ts";
import type { Ctx, Module } from "../ctx.ts";
import { type DatabaseSync, now, taintOf } from "../db.ts";
import * as paths from "../paths.ts";
import { define } from "../rpc.ts";
import { runPlanner, tasks } from "../runtime/index.ts";
import { missingImage } from "../runtime/vm.ts";
import type { OutboxMsg, TaskJson } from "../types.ts";
import { read as readVault } from "../vault/vault.ts";

export const DEBOUNCE_MS = 2000;
/** What a guard skipped has no wake of its own: the day's cap over at midnight, a provider's credential added */
const RETRY_MS = 10 * 60_000;
const CAP_LOG_MS = 3600_000;

let ctx: Ctx | undefined;
let timer: NodeJS.Timeout | undefined;
let retry: NodeJS.Timeout | undefined;
let running = false;
let again = false;
let capLogged = 0;
let lastBatch: string | undefined;
/** a batch left tainted tasks' results for one of their own (`batch`) */
let owed = false;

export function pctx(): Ctx {
  if (!ctx) throw new Error("planner not started");
  return ctx;
}
const log = () => ctx?.log("planner") ?? { info() {}, error() {} };

export const usedToday = (c: Ctx): number =>
  (
    c.db.prepare("SELECT tokens FROM planner_usage WHERE day = ?").get(today(c.config)) as
      | { tokens: number }
      | undefined
  )?.tokens ?? 0;

/** Debounced: the first wake starts a 2 s timer, later ones within it join that batch; one batch at a time. */
export function wake(): void {
  if (!ctx || timer) return;
  timer = setTimeout(() => {
    timer = undefined;
    if (running) {
      again = true;
      return;
    }
    running = true;
    batch()
      .catch((e) => {
        log().error("batch failed", e);
        return false;
      })
      .then((ran) => {
        running = false;
        // more than batch_max waiting: the next batch follows at once (after the debounce)
        if (again || (ran && pending() > 0)) {
          again = false;
          wake();
        }
      });
  }, DEBOUNCE_MS);
  timer.unref();
}

function pending(): number {
  if (!ctx) return 0;
  return (ctx.db.prepare("SELECT COUNT(*) AS n FROM events WHERE consumed = 0").get() as { n: number }).n;
}

/** Results too: a task's report waits for a batch like an event. */
const anything = (): boolean =>
  pending() > 0 ||
  ctx?.db
    .prepare(
      `SELECT 1 FROM outbox o JOIN tasks t ON t.id = o.task_id WHERE o.consumed = 0 AND t.kind NOT IN ('chat', 'planner')
       AND json_extract(o.body, '$.type') IN ('result', 'budget_exceeded') AND json_extract(o.body, '$.text') != '' LIMIT 1`,
    )
    .get() !== undefined;

/** v6: a fresh VM per batch; the host until the image is there, or when the owner says so (v7 › Config). */
export const plannerRuntime = (c: Config, missing: string | null = missingImage()): "host" | "vm" =>
  c.planner.runtime ?? (missing ? "host" : "vm");

export interface EventRow {
  id: number;
  dof: string;
  key: string;
  ts: string;
  author: string | null;
  trusted: number;
  summary: string | null;
  refs: string | null;
  task_id: string | null;
}

export const refsOf = (e: Pick<EventRow, "refs">): string[] => (e.refs ? (JSON.parse(e.refs) as string[]) : []);
export const isOwner = (c: Config, e: Pick<EventRow, "dof" | "author">): boolean =>
  e.author !== null && c.dofs[e.dof]?.owner === e.author;

/** One event as the Planner (and a created task's brief) sees it: the owner's text plain but labelled, others quoted. */
export function renderEvent(c: Config, e: EventRow, matches: string[] = []): string {
  const owner = isOwner(c, e);
  const tags = [
    owner ? "owner" : `author ${e.author ?? "unknown"}`,
    e.trusted ? "trusted" : "untrusted",
    ...matches.map((m) => `matches task ${m}`),
  ];
  const text = e.summary ?? "(no summary)";
  // every ref: a Discord thread's first, `<parent>:<thread>`, reads like a message in the parent (2 live runs in 8
  // answered there); its second, `<thread>:<thread>`, says where to post
  // a stranger's text is enough to route by at 500: every model call of a batch re-reads it, against daily_tokens
  const shown = e.trusted ? text : text.slice(0, 500);
  return `- [e${e.id}] ${refsOf(e).join(" ") || `${e.dof}:${e.key}`} (${tags.join(", ")}) at ${e.ts}\n${owner ? text : quote(shown)}`;
}

interface ResultRow {
  task_id: string;
  body: string;
}

const oneLine = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n);

/** The batch's one user message (15-planner.md › Input). The fixed system prompt is the planner plugin's. */
/** Each PR/MR of a task (a `!<n>` in its refs) and its end, if its last turn is one (a reopening undoes it). A ref the
 * task only commented on counts too, and its PR may stay open: then the task reads as not ended, the safe side.
 * ponytail: a scan of `events` per PR of an open task, each batch; an index on `refs` if open PRs ever number hundreds. */
export function prTurns(db: DatabaseSync, id: string): { ref: string; end?: { summary: string; trusted: number } }[] {
  const turns = db.prepare("SELECT summary, trusted FROM events WHERE refs = json_array(?) ORDER BY id DESC");
  const refs = db.prepare("SELECT ref FROM task_refs WHERE task_id = ? AND ref LIKE '%:!%'").all(id) as {
    ref: string;
  }[];
  return refs.map(({ ref }) => {
    const rows = turns.all(ref) as { summary: string | null; trusted: number }[];
    const end = rows.find((r): r is { summary: string; trusted: number } => PR_TURN.test(r.summary ?? ""));
    return end && !/^\S+reopen/.test(end.summary) ? { ref, end } : { ref };
  });
}

export function renderBatch(c: Ctx, events: EventRow[], results: ResultRow[]): string {
  const refStmt = c.db.prepare(
    "SELECT r.task_id, t.status, t.project FROM task_refs r JOIN tasks t ON t.id = r.task_id WHERE r.ref = ?",
  );
  const ev = events.map((e) => {
    const m = new Set<string>();
    for (const ref of refsOf(e))
      for (const r of refStmt.all(ref) as { task_id: string; status: string; project: string | null }[])
        m.add(
          tasks.isClosed(r.status)
            ? `${r.task_id} (${r.status}${r.project ? `, project ${r.project}` : ""})`
            : r.task_id,
        );
    return renderEvent(c.config, e, [...m]);
  });
  const res = results.map((r) => {
    const m = JSON.parse(r.body) as OutboxMsg;
    // the done(summary) text: what the Worker reports to the Planner (summary.md is the card's)
    return `- [${r.task_id}] ${m.type}:\n${quote(m.text.slice(0, 2000))}`;
  });
  const open = (
    c.db
      .prepare(
        "SELECT * FROM tasks WHERE status NOT IN ('done', 'failed') AND kind NOT IN ('chat', 'planner') ORDER BY created",
      )
      .all() as unknown as tasks.TaskRow[]
  ).map((t) => {
    const refs = (c.db.prepare("SELECT ref FROM task_refs WHERE task_id = ?").all(t.id) as { ref: string }[]).map(
      (r) => r.ref,
    );
    const what = [
      t.status,
      t.runtime ?? "host",
      t.project && `project ${t.project}`,
      `${tokens(parse<{ tokens?: number }>(t.usage)?.tokens ?? 0)} tokens`,
    ];
    if (refs.length) what.push(`refs: ${refs.join(" ")}`);
    // a task waiting on its own timer is not finished: closing it deletes them
    const { n: timers } = c.db.prepare("SELECT COUNT(*) AS n FROM schedules WHERE task_id = ?").get(t.id) as {
      n: number;
    };
    if (timers) what.push(`${timers} timer${timers > 1 ? "s" : ""}`);
    // "is anything waiting on me?" was answered "no approvals" with seven pending: nothing here said so
    const { n: asks } = c.db
      .prepare("SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending' AND task_id = ?")
      .get(t.id) as { n: number };
    if (asks) what.push(`${asks} waiting for the owner`);
    // the Worker's report may predate the end, and this batch may be the only word of it: a close refused while it ran
    // left the task on a PR that ended, with a report saying "open" (round 21)
    const ended = prTurns(c.db, t.id).flatMap((p) => (p.end ? [p.ref] : []));
    if (ended.length) what.push(`ended: ${ended.join(" ")}`);
    // a Worker's record (it may restate what a stranger wrote): a JSON string, data like the title
    const summary = t.summary ? ` — summary ${JSON.stringify(oneLine(t.summary, 300))}` : "";
    // a note would wait in its inbox (tasks.ts › restarts): the Planner sees why, as data like the summary
    const failed =
      t.error && t.status === "waiting"
        ? ` — failed, only the owner starts it again: ${JSON.stringify(oneLine(errorLine(t.error), 300))}`
        : "";
    return `- ${t.id} ${JSON.stringify(t.title)} (${what.filter(Boolean).join(", ")})${summary}${failed}`;
  });
  const section = (title: string, lines: string[]) => `## ${title}\n${lines.length ? lines.join("\n") : "none"}`;
  // what no open task's line counts: a merge or transform that outlived its task, a chat's request
  const { n: all } = c.db.prepare("SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'").get() as {
    n: number;
  };
  const total = all ? [`${all} approval${all > 1 ? "s" : ""} waiting for the owner in all`] : [];
  return [section("Events", ev), section("Results", res), section("Open tasks", open), ...total].join("\n\n");
}

/** false when a guard skipped it or there was nothing to do */
async function batch(): Promise<boolean> {
  const c = pctx();
  const cfg = c.config.planner;
  if (existsSync(paths.paused())) return false;
  const used = usedToday(c);
  if (used >= cfg.daily_tokens) {
    if (Date.now() - capLogged > CAP_LOG_MS) {
      log().info("planner.daily_tokens reached: batches skipped until tomorrow", { used, cap: cfg.daily_tokens });
      capLogged = Date.now();
    }
    return false;
  }
  if (!cfg.provider || !cfg.model) {
    log().error("planner.provider and planner.model must be set (Settings): batch skipped");
    return false;
  }
  if (!readVault()[cfg.provider]) {
    log().error(`planner.provider ${cfg.provider} is not a credential in vault.json: batch skipped`);
    return false;
  }
  // checked before anything is consumed: a batch that cannot start must not lose its events
  const noImage = cfg.runtime === "vm" ? missingImage() : null;
  const runtime = plannerRuntime(c.config);
  if (noImage) {
    log().error(`planner.runtime is vm: ${noImage}; batch skipped`);
    return false;
  }
  let events = c.db
    .prepare("SELECT * FROM events WHERE consumed = 0 ORDER BY id LIMIT ?")
    .all(cfg.batch_max) as unknown as (EventRow & { id: number })[];
  let results = c.db
    .prepare(
      `SELECT o.task_id, o.seq, o.body FROM outbox o JOIN tasks t ON t.id = o.task_id
       WHERE o.consumed = 0 AND t.kind NOT IN ('chat', 'planner')
       AND json_extract(o.body, '$.type') IN ('result', 'budget_exceeded') AND json_extract(o.body, '$.text') != ''
       ORDER BY o.created`,
    )
    .all() as unknown as (ResultRow & { seq: number })[];
  // v7 › Review round 8: a tainted task's result taints every task the batch creates (tools.ts › batchTaint), and on
  // a busy day nearly every batch carries one; so with events waiting, those results get the next batch of their own
  // (events wait for it, so a steady stream of events cannot hold results back for more than one batch). Not when a
  // stranger's event taints these events anyway: a second batch would keep nothing clean and spend daily_tokens
  const tainted = (r: ResultRow) => taintOf(c.db, r.task_id, c.config).length > 0;
  if (owed) {
    owed = false;
    if (results.some(tainted)) events = [];
  } else if (events.length && events.every((e) => e.trusted) && results.some(tainted)) {
    results = results.filter((r) => !tainted(r));
    owed = again = true;
  }
  if (!events.length && !results.length) return false;

  // consumed before the run: a crashed batch is not re-run (cards are authoritative; 15-planner.md › Wake and batch)
  const { n } = c.db
    .prepare(
      "SELECT COALESCE(MAX(m), 0) + 1 AS n FROM (SELECT MAX(consumed) AS m FROM events UNION ALL SELECT MAX(consumed) FROM outbox)",
    )
    .get() as { n: number };
  c.db.exec("BEGIN IMMEDIATE");
  try {
    for (const e of events) c.db.prepare("UPDATE events SET consumed = ? WHERE id = ?").run(n, e.id);
    for (const r of results)
      c.db.prepare("UPDATE outbox SET consumed = ? WHERE task_id = ? AND seq = ?").run(n, r.task_id, r.seq);
    c.db.exec("COMMIT");
  } catch (e) {
    c.db.exec("ROLLBACK");
    throw e;
  }

  const id = `planner-${n}`;
  const t = now();
  const budget = { tokens: Math.max(1, cfg.daily_tokens - used), hours: 0.5 };
  c.db
    .prepare(
      `INSERT INTO tasks(id, kind, title, brief, status, scope, budget, usage, runtime, event_keys, created, updated,
        started, hours) VALUES (?, 'planner', ?, ?, 'running', ?, ?, '{"tokens":0}', ?, '[]', ?, ?, ?, 0)`,
    )
    .run(
      id,
      `planner batch #${n}, ${events.length} events${results.length ? `, ${results.length} results` : ""}`,
      renderBatch(c, events, results),
      JSON.stringify({ credentials: [], repos: [] }),
      JSON.stringify(budget),
      runtime,
      t,
      t,
      t,
    );
  bus.emit("tasks", { id, status: "running" });
  lastBatch = t;
  log().info("batch", { id, events: events.length, results: results.length });
  try {
    const row = tasks.get(id);
    const asPlanner = { ...c.config, worker: { ...c.config.worker, provider: cfg.provider, model: cfg.model } };
    const task: TaskJson = { ...tasks.taskJson(asPlanner, row), effort: cfg.effort, features: [] };
    const used = await runPlanner(row, task, runtime);
    c.db
      .prepare(
        "INSERT INTO planner_usage(day, tokens) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET tokens = tokens + excluded.tokens",
      )
      .run(today(c.config), used);
  } finally {
    c.db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
    rmSync(paths.task(id), { recursive: true, force: true });
    bus.emit("tasks", { id });
  }
  return true;
}

export interface PlannerStatus {
  last?: string;
  routed: number;
  tokens: number;
  cap: number;
}

/** The Sources page's Planner row (RPC `planner.status`, so the console does not import the runtime). */
export function status(c: Ctx): PlannerStatus {
  const day = today(c.config);
  // ponytail: "today" for events is the UTC day of their insert; the owner's tz day would need a stored local date
  const { n } = c.db
    .prepare(
      "SELECT COUNT(*) AS n FROM events WHERE (task_id IS NOT NULL OR ignored IS NOT NULL) AND substr(created, 1, 10) = ?",
    )
    .get(new Date().toISOString().slice(0, 10)) as { n: number };
  const row = c.db.prepare("SELECT tokens FROM planner_usage WHERE day = ?").get(day) as { tokens: number } | undefined;
  // ponytail: the last batch time is in memory; "—" after a restart until the next batch
  return {
    ...(lastBatch ? { last: lastBatch } : {}),
    routed: n,
    tokens: row?.tokens ?? 0,
    cap: c.config.planner.daily_tokens,
  };
}

define("planner.status", { roles: ["owner"], input: z.unknown(), run: () => status(pctx()) });

export const plannerModule: Module = {
  name: "planner",
  async start(c) {
    ctx = c;
    // a batch killed with hortusd is not re-run: its events stayed consumed; the dispatcher never starts this kind
    for (const { id } of c.db.prepare("SELECT id FROM tasks WHERE kind = 'planner'").all() as { id: string }[])
      c.db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
    let dirs: string[] = [];
    try {
      dirs = readdirSync(join(paths.home(), "tasks")).filter((d) => d.startsWith("planner-"));
    } catch {}
    for (const d of dirs) rmSync(paths.task(d), { recursive: true, force: true });
    bus.on("tasks", onTasks);
    wake();
    retry = setInterval(() => anything() && wake(), RETRY_MS);
    retry.unref();
  },
  async reload() {
    if (anything()) wake(); // a Settings save may be what a skipped batch waited for
  },
  async stop() {
    bus.off("tasks", onTasks);
    clearTimeout(timer);
    clearInterval(retry);
    timer = undefined;
    ctx = undefined;
  },
};

/** unpause (pause.set emits `{ paused: false }`) wakes a batch with everything pending */
function onTasks(e?: { paused?: boolean }): void {
  if (e?.paused === false) wake();
}
