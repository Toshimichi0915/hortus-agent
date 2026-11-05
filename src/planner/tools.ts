/**
 * The Planner's verdicts as RPCs (15-planner.md › RPC handlers), role `planner` only: the proxy stamps the role from
 * the session's link, so a Worker calling these gets `forbidden`. A new verdict is one `define()` here and a line in
 * the planner plugin's prompt.
 */
import { existsSync } from "node:fs";
import { z } from "zod";
import { dirOf, gitOf, PR_TURN } from "../connectors/forge.ts";
import { dofNames, isCi, readableOf, taint, taintOf } from "../db.ts";
import { define } from "../rpc.ts";
import * as paths from "../paths.ts";
import { tasks } from "../runtime/index.ts";
import { missingImage } from "../runtime/vm.ts";
import { type Caller, RpcError } from "../types.ts";
import { read as readVault } from "../vault/vault.ts";
import { type EventRow, isOwner, pctx, refsOf, renderEvent } from "./planner.ts";

const planner = ["planner" as const];
const EventIds = z.array(z.string()).min(1);

export const NO_IMAGE = "no VM image; set a project or build the image";

/** `e123` or `123` → the rows, in the given order; unknown → not_found. */
function events(ids: string[]): EventRow[] {
  const db = pctx().db;
  return ids.map((s) => {
    const m = /^e?(\d+)$/.exec(s.trim());
    const row = m && (db.prepare("SELECT * FROM events WHERE id = ?").get(Number(m[1])) as EventRow | undefined);
    if (!row) throw new RpcError("not_found", `no event ${s}`);
    return row;
  });
}

/** An open-or-closed task the Planner may address: not a batch, not a chat (the owner's; the Planner never sees one). */
function task(id: string): tasks.TaskRow {
  const t = tasks.get(id);
  if (t.kind === "planner" || t.kind === "chat") throw new RpcError("not_found", `no task ${id}`);
  return t;
}

/**
 * Why the calling batch is tainted for the tasks it writes to (v7 › Review round 6): its untrusted events, its results
 * from tainted tasks. A brief or note is the Planner's own text, so a stranger's instruction in the same batch may be
 * in it; undefined: the batch held owner-vouched input only (the open-task list aside, data in the prompt).
 */
function batchTaint(caller: Caller): string | undefined {
  const n = /^planner-(\d+)$/.exec(caller.task ?? "")?.[1];
  if (n === undefined) return undefined;
  const db = pctx().db;
  const untrusted = db.prepare("SELECT dof, author FROM events WHERE consumed = ? AND trusted = 0").all(Number(n)) as {
    dof: string;
    author: string | null;
  }[];
  const strangers = untrusted.some((e) => !isCi(pctx().config, e));
  const results = db.prepare("SELECT DISTINCT task_id FROM outbox WHERE consumed = ?").all(Number(n)) as {
    task_id: string;
  }[];
  if (strangers) return `created from a batch with untrusted events (${caller.task})`;
  const from = results.find((r) => taintOf(db, r.task_id, pctx().config).length);
  return from ? `created from a batch with tainted task ${from.task_id}'s result (${caller.task})` : undefined;
}

function route(taskId: string, evs: EventRow[]): void {
  const db = pctx().db;
  for (const e of evs) {
    db.prepare("UPDATE events SET task_id = ? WHERE id = ?").run(taskId, e.id);
    for (const ref of refsOf(e))
      db.prepare("INSERT OR REPLACE INTO task_refs(ref, task_id) VALUES (?, ?)").run(ref, taskId);
  }
}

/** The end of a PR of this task, if the last turn of one is an end (a reopening undoes it).
 * ponytail: any of its PRs; a task with two PRs, one ended, loses what waits on the other. */
function prEnd(id: string): { summary: string; trusted: number } | undefined {
  const rows = pctx()
    .db.prepare(
      `SELECT e.summary, e.trusted FROM events e, json_each(e.refs) j JOIN task_refs r ON r.ref = j.value
       WHERE r.task_id = ? ORDER BY e.id DESC`,
    )
    .all(id) as { summary: string | null; trusted: number }[];
  const turn = rows.find((r): r is { summary: string; trusted: number } => PR_TURN.test(r.summary ?? ""));
  return turn && !/^\S+reopen/.test(turn.summary) ? turn : undefined;
}

define("task_create", {
  roles: planner,
  input: z.object({
    title: z.string().min(1).max(200),
    brief: z.string().min(1),
    event_ids: EventIds,
    scope: z
      .object({
        project: z.string().optional(),
        repos: z.array(z.string()).optional(),
        credentials: z.array(z.string()).optional(),
        dofs: z.array(z.string()).optional(),
      })
      .default({}),
  }),
  run({ title, brief, event_ids, scope }, caller) {
    const c = pctx().config;
    const evs = events(event_ids);
    for (const e of evs) if (!e.trusted) throw new RpcError("forbidden", `untrusted event e${e.id}`);
    const { project } = scope;
    // an order on a forge's thread is about that repo: a follow-up on a closed PR created without it had every call
    // refused, and its Worker spent its whole budget on them (1 of 8 live)
    const forged = evs.flatMap(refsOf).flatMap((r) => {
      const [dof = "", name = ""] = r.split(":");
      const d = c.dofs[dof];
      return d && gitOf(d) ? [`${dof}:${name}`] : [];
    });
    const repos = scope.repos?.length ? scope.repos : [...new Set(forged)];
    if (project !== undefined) {
      if (!c.projects[project]) throw new RpcError("not_found", `no project ${project}`);
      const other = evs.find((e) => !isOwner(c, e));
      if (other)
        throw new RpcError("forbidden", `scope.project needs every event to be the owner's (e${other.id} is not)`);
    }
    for (const r of repos) {
      const [dof = "", name = ""] = r.split(":");
      const d = c.dofs[dof];
      // `owner/repo` (GitLab: groups/sub/repo), no `..` segment: the name also becomes a path and a scope pattern
      const shaped = /^[\w.-]+(\/[\w.-]+)+$/.test(name) && !name.split("/").some((x) => x === "." || x === "..");
      if (!d || !shaped || !(d.repos?.includes(name) || existsSync(paths.repo(dof, dirOf(name)))))
        throw new RpcError("invalid", `unknown repo ${r} (expected <dof>:<project> of a configured forge)`);
    }
    const known = dofNames(c);
    for (const d of scope.dofs ?? [])
      if (!known.includes(d)) throw new RpcError("invalid", `unknown DOF ${d} (expected one of ${known.join(", ")})`);
    const names = new Set(Object.keys(readVault()));
    for (const n of scope.credentials ?? [])
      if (!names.has(n)) throw new RpcError("invalid", `unknown credential ${n}`);
    let runtime: "host" | "vm";
    if (project !== undefined) runtime = c.projects[project]?.runtime ?? "host";
    else if (!missingImage()) runtime = "vm";
    // v7: without the image a project-less task runs on the host only when the owner said so
    else if ((c.vm as { fallback_host?: boolean }).fallback_host === true) runtime = "host";
    else throw new RpcError("failed", NO_IMAGE);
    const full = `${brief}\n\n## Originating events\n${evs.map((e) => renderEvent(c, e)).join("\n")}`;
    const t = tasks.create({
      kind: "unattended",
      title,
      brief: full,
      scope: {
        ...(scope.credentials ? { credentials: scope.credentials } : {}),
        repos,
        // v7 › Review round 7: none unless the Planner asks (the brief carries the events)
        dofs: scope.dofs ?? [],
      },
      ...(project !== undefined ? { project } : {}),
      runtime,
      event_keys: [...new Set(evs.flatMap(refsOf))],
    });
    route(t.id, evs);
    const why = batchTaint(caller);
    if (why) taint(pctx().db, t.id, why);
    return { id: t.id, runtime };
  },
});

define("task_attach", {
  roles: planner,
  input: z.object({ task_id: z.string(), event_ids: EventIds }),
  run({ task_id, event_ids }) {
    task(task_id);
    const evs = events(event_ids);
    const can = readableOf(pctx().db, pctx().config, task_id);
    const seqs = evs.map((e) => {
      const ref = refsOf(e)[0];
      // a thread outside the task's scope.dofs is not mounted: no pointer to it
      const where =
        ref && can.includes(e.dof) ? `\n(the thread: ${ref.split(":").map(dirOf).join("/")}/ under the DOF root)` : "";
      return tasks.inboxWrite(
        task_id,
        {
          from: ref ?? `${e.dof}:${e.key}`,
          // the owner's follow-up on a forge read as a stranger's: "merge this" answered with "that's the owner's call"
          ...(e.author ? { author: isOwner(pctx().config, e) ? `${e.author} (the owner)` : e.author } : {}),
          trusted: !!e.trusted,
          text: `${e.summary ?? ""}${where}`,
          data: { event: e.id, dof: e.dof, key: e.key, refs: refsOf(e) },
        },
        isOwner(pctx().config, e),
      );
    });
    route(task_id, evs);
    return { seqs };
  },
});

define("event_ignore", {
  roles: planner,
  input: z.object({ event_ids: EventIds, reason: z.string().min(1) }),
  run({ event_ids, reason }) {
    const db = pctx().db;
    for (const e of events(event_ids)) db.prepare("UPDATE events SET ignored = ? WHERE id = ?").run(reason, e.id);
    return { ignored: event_ids.length };
  },
});

define("task_message", {
  roles: planner,
  input: z.object({ task_id: z.string(), text: z.string().min(1) }),
  run({ task_id, text }, caller) {
    task(task_id);
    const why = batchTaint(caller);
    if (why) taint(pctx().db, task_id, why.replace("created from", "a note from"));
    // a routing note, not the owner: rendered quoted (agent/inbox.ts); the Planner reads untrusted events, so its note
    // is never `trusted=true` (an injected Planner must not hand a Worker a trusted request)
    return { seq: tasks.inboxWrite(task_id, { from: "planner", trusted: false, text }) };
  },
});

define("task_close", {
  roles: planner,
  input: z.object({ task_id: z.string(), outcome: z.enum(["done", "failed"]) }),
  async run({ task_id, outcome }) {
    const { status } = task(task_id);
    // it has work in hand: a close at a PR's merge killed the Worker with the owner's last line unanswered and its
    // "pushed to the PR" the last thing said (1 of 4 live). Its result comes here when it ends
    if (status === "running" || status === "queued")
      throw new RpcError("invalid", `task ${task_id} is ${status}; attach what is new and leave it open`);
    // a task waiting on its own timers is not finished, and closing deletes them: the owner decides that one
    const { n } = pctx().db.prepare("SELECT COUNT(*) AS n FROM schedules WHERE task_id = ?").get(task_id) as {
      n: number;
    };
    if (n) throw new RpcError("invalid", `task ${task_id} has ${n} timer${n > 1 ? "s" : ""}; it is waiting for them`);
    // a Worker's `done` with its reply still waiting (5 of 10 live runs, against the prompt): a close would drop the reply,
    // as `finishClose` expires what this counts. Its decision wakes the task, and the next `done` closes it
    const { w } = pctx()
      .db.prepare(
        "SELECT COUNT(*) AS w FROM approvals WHERE status = 'pending' AND task_id = ? AND category NOT IN ('merge', 'transforms', 'login')",
      )
      .get(task_id) as { w: number };
    // but the owner's own end of the PR makes it moot: a merge by the forge's button left the Worker's merge request waiting
    // and the close refused, 3 of 3 live, with a dead entry on the Approvals page until it expired (round 20)
    const end = prEnd(task_id);
    if (w && !end?.trusted)
      throw new RpcError("invalid", `task ${task_id} has a request waiting for the owner; leave it open`);
    // the card's last word was the Worker's "open, not merged". ponytail: the card only: out/summary.md is the Worker's
    // file, not one for hortusd to append to, so `logs/<id>/summary.md` keeps it
    const how = end && /^\S+ \S+ by .*?(?=: )/.exec(end.summary)?.[0];
    if (how)
      pctx()
        .db.prepare("UPDATE tasks SET summary = COALESCE(summary, '') || ? WHERE id = ?")
        .run(`\n\n## Ended\n${how}\n`, task_id);
    await tasks.close(task_id, outcome);
    return { ok: true };
  },
});
