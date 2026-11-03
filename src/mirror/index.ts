/**
 * The mirror module: DOF repos, the search index and the `logs` DOF, bound to hortusd's DB at `start`. Other modules
 * call `commit` (gateway), `publishLog` (dispatcher), `writeLog` and `search`; Workers reach `search` as `dof.search`.
 */
import { z } from "zod";
import type { Ctx, Module } from "../ctx.ts";
import type { DatabaseSync } from "../db.ts";
import { define } from "../rpc.ts";
import { type Change, type DiffEntry, RpcError, type SearchHit, type SearchQuery } from "../types.ts";
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
    define("dof.search", { roles: ["owner", "worker", "planner"], input: Query, run: (q) => search(q) });
  },
  async stop() {},
};
