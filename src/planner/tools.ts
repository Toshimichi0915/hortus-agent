/**
 * The Planner's verdicts as RPCs (15-planner.md › RPC handlers), role `planner` only: the proxy stamps the role from
 * the session's link, so a Worker calling these gets `forbidden`. A new verdict is one `define()` here and a line in
 * the planner plugin's prompt.
 */
import { existsSync } from "node:fs";
import { z } from "zod";
import { dirOf } from "../connectors/forge.ts";
import { define } from "../rpc.ts";
import * as paths from "../paths.ts";
import { tasks } from "../runtime/index.ts";
import { missingImage } from "../runtime/vm.ts";
import { RpcError } from "../types.ts";
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

/** An open-or-closed task the Planner may address (not a batch). */
function task(id: string): tasks.TaskRow {
  const t = tasks.get(id);
  if (t.kind === "planner") throw new RpcError("not_found", `no task ${id}`);
  return t;
}

function route(taskId: string, evs: EventRow[]): void {
  const db = pctx().db;
  for (const e of evs) {
    db.prepare("UPDATE events SET task_id = ? WHERE id = ?").run(taskId, e.id);
    for (const ref of refsOf(e))
      db.prepare("INSERT OR REPLACE INTO task_refs(ref, task_id) VALUES (?, ?)").run(ref, taskId);
  }
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
      })
      .default({}),
  }),
  run({ title, brief, event_ids, scope }) {
    const c = pctx().config;
    const evs = events(event_ids);
    for (const e of evs) if (!e.trusted) throw new RpcError("forbidden", `untrusted event e${e.id}`);
    const { project } = scope;
    if (project !== undefined) {
      if (!c.projects[project]) throw new RpcError("not_found", `no project ${project}`);
      const other = evs.find((e) => !isOwner(c, e));
      if (other)
        throw new RpcError("forbidden", `scope.project needs every event to be the owner's (e${other.id} is not)`);
    }
    for (const r of scope.repos ?? []) {
      const [dof = "", name = ""] = r.split(":");
      const d = c.dofs[dof];
      // `owner/repo` (GitLab: groups/sub/repo), no `..` segment: the name also becomes a path and a scope pattern
      const shaped = /^[\w.-]+(\/[\w.-]+)+$/.test(name) && !name.split("/").some((x) => x === "." || x === "..");
      if (!d || !shaped || !(d.repos?.includes(name) || existsSync(paths.repo(dof, dirOf(name)))))
        throw new RpcError("invalid", `unknown repo ${r} (expected <dof>:<project> of a configured forge)`);
    }
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
        ...(scope.repos ? { repos: scope.repos } : {}),
      },
      ...(project !== undefined ? { project } : {}),
      runtime,
      event_keys: [...new Set(evs.flatMap(refsOf))],
    });
    route(t.id, evs);
    return { id: t.id, runtime };
  },
});

define("task_attach", {
  roles: planner,
  input: z.object({ task_id: z.string(), event_ids: EventIds }),
  run({ task_id, event_ids }) {
    task(task_id);
    const evs = events(event_ids);
    const seqs = evs.map((e) => {
      const ref = refsOf(e)[0];
      const where = ref ? `\n(the thread: ${ref.split(":").join("/")}/ under the DOF root)` : "";
      return tasks.inboxWrite(task_id, {
        from: ref ?? `${e.dof}:${e.key}`,
        ...(e.author ? { author: e.author } : {}),
        trusted: !!e.trusted,
        text: `${e.summary ?? ""}${where}`,
        data: { event: e.id, dof: e.dof, key: e.key, refs: refsOf(e) },
      });
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
  run({ task_id, text }) {
    task(task_id);
    // a routing note, not the owner: rendered quoted (agent/inbox.ts)
    return { seq: tasks.inboxWrite(task_id, { from: "planner", trusted: true, text }) };
  },
});

define("task_close", {
  roles: planner,
  input: z.object({ task_id: z.string(), outcome: z.enum(["done", "failed"]) }),
  async run({ task_id, outcome }) {
    task(task_id);
    await tasks.close(task_id, outcome);
    return { ok: true };
  },
});
