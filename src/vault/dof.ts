/**
 * The `transforms` DOF (12-transforms-dof.md): a repo written only by hortusd through the mirror. Shipped transforms are
 * copied in once (`ship: <names>`); `transforms(name, hash, enabled_at)` binds each enabled name to the content the owner
 * approved, and `load()` serves only worktree files whose hash still matches (a hand-edited file disables its transform).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Ctx, Module } from "../ctx.ts";
import { logger } from "../log.ts";
import { commit } from "../mirror/index.ts";
import * as paths from "../paths.ts";
import { define } from "../rpc.ts";
import type { Change } from "../types.ts";
import * as transforms from "./transforms.ts";
import { bind, ctx } from "./vault.ts";

const log = logger("transforms");
export const DOF = "transforms";

let notes: string[] = [];
/** Lines for the Sources page. */
export const status = (): string[] => notes;

/** Every file under `dir`, relative, sorted. */
function filesOf(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[]).filter((f) => statSync(join(dir, f)).isFile()).sort();
}

function bound(): Map<string, string> {
  const rows = ctx().db.prepare("SELECT name, hash FROM transforms WHERE enabled_at IS NOT NULL").all() as {
    name: string;
    hash: string;
  }[];
  return new Map(rows.map((r) => [r.name, r.hash]));
}

const upsert = (name: string, hash: string): void => {
  ctx()
    .db.prepare(
      "INSERT INTO transforms(name, hash, enabled_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET hash = excluded.hash, enabled_at = excluded.enabled_at",
    )
    .run(name, hash, new Date().toISOString());
};

/** The enabled rows from the worktree; a hash mismatch is skipped, logged and noted. */
export async function load(): Promise<void> {
  const rows = bound();
  const bad: string[] = [];
  await transforms.load([paths.dof(DOF)], (name, hash) => {
    const want = rows.get(name);
    if (want === hash) return true;
    if (want) {
      bad.push(name);
      log.error("transform disabled: hash mismatch", undefined, { name });
    }
    return false;
  });
  notes = bad.length ? [`transforms: ${bad.length} disabled (hash mismatch)`] : [];
}

/** Shipped transforms whose name has no binding yet → one commit and their rows. */
// ponytail: a shipped transform already bound is never refreshed by a release; re-ship by deleting its row
export async function ship(root = transforms.shippedDir()): Promise<string[]> {
  if (!existsSync(root)) return [];
  const have = bound();
  const changes: Change[] = [];
  const binds: [string, string][] = [];
  for (const name of readdirSync(root).sort()) {
    const dir = join(root, name);
    if (have.has(name) || !existsSync(join(dir, "manifest.json")) || !existsSync(join(dir, "transform.js"))) continue;
    for (const f of filesOf(dir)) changes.push({ op: "put", path: `${name}/${f}`, bytes: readFileSync(join(dir, f)) });
    const hash = transforms.hashOf(
      readFileSync(join(dir, "manifest.json"), "utf8"),
      readFileSync(join(dir, "transform.js"), "utf8"),
    );
    binds.push([name, hash]);
  }
  if (!binds.length) return [];
  await commit(DOF, changes, `ship: ${binds.map(([n]) => n).join(", ")}`);
  for (const [n, h] of binds) upsert(n, h);
  return binds.map(([n]) => n);
}

/** An approved submission: its files replace `<name>/` in one commit, the binding moves to `hash`, the table reloads. */
export async function install(name: string, files: Record<string, string>, hash: string): Promise<void> {
  const dir = join(paths.dof(DOF), name);
  const keep = Object.keys(files).filter((f) => !f.endsWith(".md"));
  const changes: Change[] = keep.map((f) => ({ op: "put", path: `${name}/${f}`, bytes: Buffer.from(files[f] ?? "") }));
  if (existsSync(dir))
    for (const f of filesOf(dir)) if (!keep.includes(f)) changes.push({ op: "delete", path: `${name}/${f}` });
  await commit(DOF, changes, `transform(${name}): ${hash.slice(0, 8)}`);
  upsert(name, hash);
  await load();
}

define("transforms.status", {
  roles: ["owner"],
  input: z.unknown(),
  run: () => ({ notes: status(), enabled: [...bound()].map(([name, hash]) => ({ name, hash })) }),
});

/** Start after mirrorModule (commit) and vaultModule (ctx, QuickJS): its table replaces the shipped-only one. */
export const transformsDofModule: Module = {
  name: "transforms",
  async start(c: Ctx) {
    bind(c);
    const shipped = await ship();
    if (shipped.length) log.info("shipped transforms", { names: shipped });
    await load();
  },
  async stop() {},
};
