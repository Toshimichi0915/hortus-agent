/**
 * The mirror module: DOF repos, the search index and the `logs` DOF, bound to hortusd's DB at `start`. Other modules
 * call `commit` (gateway), `publishLog` (dispatcher), `writeLog` and `search`; Workers reach `search` as `dof.search`.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Ctx, Module } from "../ctx.ts";
import { trusted } from "../connectors/trust.ts";
import { type DatabaseSync, taint, taintOf } from "../db.ts";
import * as paths from "../paths.ts";
import { define } from "../rpc.ts";
import { type Caller, type Change, type DiffEntry, RpcError, type SearchHit, type SearchQuery } from "../types.ts";
import * as fts from "./fts.ts";
import * as logs from "./logs.ts";
import * as repo from "./repo.ts";

export { parse, render } from "./render.ts";
export { renderSession } from "./logs.ts";

let ctx: Ctx | undefined;

const db = (): DatabaseSync => {
  if (!ctx) throw new Error("mirror module not started");
  return ctx.db;
};

/** Apply Changes to the DOF's worktree as one commit on `main` and index its diff; nothing changed → null. */
export const commit = (
  name: string,
  changes: Change[],
  message: string,
): Promise<{ sha: string; diff: DiffEntry[] } | null> => repo.commit(db(), name, changes, message);

/** Write `logs/<taskId>/<file>` (temp + rename) and upsert each file's index row. */
export const writeLog = (taskId: string, files: Record<string, string>, title?: string): void =>
  logs.writeLog(db(), taskId, files, title);

/** Render `tasks/<id>/out/sessions` and `out/summary.md` into `logs/<id>/` and index both. */
export const publishLog = (taskId: string, title: string, status: string, events?: string[]): Promise<void> =>
  logs.publishLog(db(), taskId, title, status, events);

/** Full-text search over every DOF; an unknown `in` is `not_found`. */
export function search(q: SearchQuery): SearchHit[] {
  const known = new Set(["logs", "transforms", ...Object.keys(ctx?.config.dofs ?? {})]);
  if (q.in !== undefined && !known.has(q.in)) throw new RpcError("not_found", `no DOF named ${q.in}`);
  return fts.search(db(), q);
}

/**
 * The hits a Worker must not read as the owner's (v7 › Review round 6), as `<dof>:<author> (untrusted)`: a connector
 * DOF's author its trust rule does not trust (no author, a bot's file, a stranger), a session log of a tainted task.
 * `transforms` is the owner's (approved code). ponytail: a `members` DOF trusts an author only if an event of theirs was
 * from a member (the index keeps no membership); the trust rule is the gateway's.
 */
function untrustedHits(hits: SearchHit[]): string[] {
  const out = new Set<string>();
  const member = db().prepare("SELECT 1 FROM events WHERE dof = ? AND author = ? AND member = 1 LIMIT 1");
  for (const h of hits) {
    if (h.dof === "transforms") continue;
    if (h.dof === "logs") {
      const task = h.path.split("/")[0] ?? "";
      if (taintOf(db(), task).length) out.add(`logs:${task} (tainted)`);
      continue;
    }
    const cfg = ctx?.config.dofs[h.dof];
    const author = h.author ? { user: h.author, member: member.get(h.dof, h.author) !== undefined } : null;
    if (!cfg || !trusted({ author, bot: false }, cfg)) out.add(`${h.dof}:${h.author || "?"} (untrusted)`);
  }
  return [...out];
}

/** dof.search for a caller: a Worker's task is tainted by each untrusted hit it is shown. */
function searchAs(q: SearchQuery, caller: Caller): SearchHit[] {
  const hits = search(q);
  if (caller.role === "worker" && caller.task)
    for (const u of untrustedHits(hits)) taint(db(), caller.task, `searched the mirror: ${u}`);
  return hits;
}

const Query = z.object({
  q: z.string().min(1),
  in: z.string().optional(),
  author: z.string().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  limit: z.number().int().positive().max(200).optional(),
});

export const mirrorModule: Module = {
  name: "mirror",
  async start(c) {
    ctx = c;
    let names: string[] = [];
    try {
      names = readdirSync(join(paths.home(), "dof"))
        .filter((f) => f.endsWith(".git"))
        .map((f) => f.slice(0, -4));
    } catch {}
    for (const n of names)
      await repo.recover(c.db, n).catch((e) => c.log("mirror").error("recovery failed", e, { dof: n }));
    define("dof.search", { roles: ["owner", "worker", "planner"], input: Query, run: searchAs });
  },
  async stop() {},
};
