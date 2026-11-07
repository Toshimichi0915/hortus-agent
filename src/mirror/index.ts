/**
 * The mirror module: DOF repos, the search index and the `logs` DOF, bound to hortusd's DB at `start`. Other modules
 * call `commit` (gateway), `publishLog` (dispatcher), `writeLog` and `search`; Workers reach `search` as `dof.search`.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { changesOf } from "../connectors/files.ts";
import { trusted } from "../connectors/trust.ts";
import type { Ctx, Module } from "../ctx.ts";
import { channelMeta, type DatabaseSync, dofNames, GUIDE, ownersDof, readableOf, taint, taintOf } from "../db.ts";
import * as paths from "../paths.ts";
import { define } from "../rpc.ts";
import { type Caller, type Change, type DiffEntry, RpcError, type SearchHit, type SearchQuery } from "../types.ts";
import * as fts from "./fts.ts";
import * as logs from "./logs.ts";
import * as repo from "./repo.ts";

export { renderSession } from "./logs.ts";
export { parse, render } from "./render.ts";

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
): Promise<{ sha: string; diff: DiffEntry[] } | null> =>
  repo.commit(db(), name, changes, message, ownersDof(name, ctx?.config ?? { dofs: {} }));

/** The shipped guide (`guide/`, copied to dist/guide): how hortus works, for a Worker that is unsure. */
export const guideDir = (): string => fileURLToPath(new URL("../../guide", import.meta.url));

/** Write `logs/<taskId>/<file>` (temp + rename) and upsert each file's index row. */
export const writeLog = (taskId: string, files: Record<string, string>, title?: string): void =>
  logs.writeLog(db(), taskId, files, title);

/** Render `tasks/<id>/out/sessions` and `out/summary.md` into `logs/<id>/` and index both. */
export const publishLog = (taskId: string, title: string, status: string, events?: string[]): Promise<void> =>
  logs.publishLog(db(), taskId, title, status, events);

/** Delete `logs/<taskId>/` and its index rows. */
export const removeLog = (taskId: string): void => logs.removeLog(db(), taskId);

/** Full-text search over every DOF, or over `only` (a task's readable DOFs); an unknown `in` is `not_found`. */
export function search(q: SearchQuery, only?: string[]): SearchHit[] {
  const known = only ?? dofNames(ctx?.config ?? { dofs: {} });
  if (q.in !== undefined && !known.includes(q.in))
    throw new RpcError("not_found", only ? `${q.in} is not in this task's scope.dofs` : `no DOF named ${q.in}`);
  return fts.search(db(), q, only);
}

/**
 * The hits a Worker must not read as the owner's, as `<dof>:<author> (untrusted)`: a connector
 * DOF's author its trust rule does not trust (no author, a bot's file, a stranger), a session log of a tainted task.
 * `transforms` is the owner's (approved code), a `channel.md` hortusd's rendering (`channelMeta`). ponytail: a `members` DOF trusts an author only if an event of theirs was
 * from a member (the index keeps no membership); the trust rule is the gateway's.
 */
function untrustedHits(hits: SearchHit[]): string[] {
  const out = new Set<string>();
  const member = db().prepare("SELECT 1 FROM events WHERE dof = ? AND author = ? AND member = 1 LIMIT 1");
  for (const h of hits) {
    if (ownersDof(h.dof, ctx?.config ?? { dofs: {} })) continue;
    if (h.dof === "logs") {
      const task = h.path.split("/")[0] ?? "";
      if (taintOf(db(), task, ctx?.config ?? { dofs: {} }).length) out.add(`logs:${task} (tainted)`);
      continue;
    }
    const cfg = ctx?.config.dofs[h.dof];
    if (cfg && !h.author && channelMeta(h.path)) continue;
    const author = h.author ? { user: h.author, member: member.get(h.dof, h.author) !== undefined } : null;
    if (!cfg || !trusted({ author, bot: false }, cfg)) out.add(`${h.dof}:${h.author || "?"} (untrusted)`);
  }
  return [...out];
}

/** dof.search for a caller: a Worker sees its scope.dofs only, and its task is tainted by each untrusted hit shown. */
function searchAs(q: SearchQuery, caller: Caller): SearchHit[] {
  const task = caller.role === "worker" ? caller.task : undefined;
  const hits = search(q, task ? readableOf(db(), ctx?.config ?? { dofs: {} }, task) : undefined);
  if (task) for (const u of untrustedHits(hits)) taint(db(), task, `searched the mirror: ${u}`);
  return hits;
}

/** fts.ts compares these as ISO prefixes: `yesterday` or `7d` would silently match nothing (or everything). */
const Day = z.string().regex(/^\d{4}(-\d{2}(-\d{2}([T ].*)?)?)?$/, "a date: YYYY-MM-DD");

const Query = z.object({
  q: z.string().min(1),
  in: z.string().optional(),
  author: z.string().optional(),
  since: Day.optional(),
  until: Day.optional(),
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
    // every start: the guide is this release's, whatever an older one left (no config entry, so nothing removes it)
    await commit(GUIDE, changesOf(guideDir(), GUIDE), "ship: guide").catch((e) =>
      c.log("mirror").error("guide sync failed", e),
    );
    define("dof.search", { roles: ["owner", "worker", "planner"], input: Query, run: searchAs });
  },
  async stop() {},
};
