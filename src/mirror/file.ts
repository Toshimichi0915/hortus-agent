/** One mirror file, read-only, and the other files of its thread (a search hit's target). */
import { readdirSync, realpathSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { MAX_ENTRIES, readCapped } from "../hostile.ts";
import * as paths from "../paths.ts";

export const MAX_FILE = 1024 * 1024;

export interface DofFile {
  text: string;
  size: number;
  siblings: string[];
}

/** `segs`: the DOF, then its path, one decoded segment each. `error` says why not, for anything leaving the DOF root. */
export function readDofFile(segs: string[]): DofFile | { error: string } {
  if (segs.length < 2 || !segs.every((s) => s && s !== "." && s !== ".." && !/[/\\\0]/.test(s)))
    return { error: "bad path" };
  const [dof, ...rel] = segs as [string, ...string[]];
  // `dof/<name>.git` (the mirror's bare repo) and dot-entries sit next to the worktrees: not a DOF
  if (dof.startsWith(".") || dof.endsWith(".git")) return { error: `no DOF ${dof}` };
  const root = paths.dof(dof);
  const file = join(root, ...rel);
  let real: string;
  try {
    real = realpathSync(file);
    if (!real.startsWith(realpathSync(root) + sep)) return { error: "outside the DOF" };
  } catch {
    return { error: `no file ${rel.join("/")} in ${dof}` };
  }
  // the mirror is written from hostile sources: no links (realpath above only bounds the directories), capped
  const r = readCapped(file, MAX_FILE);
  if (!r) return { error: `not a regular file: ${rel.join("/")}` };
  let siblings: string[] = [];
  try {
    siblings = readdirSync(dirname(real), { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => d.name)
      .sort()
      .slice(0, MAX_ENTRIES);
  } catch {}
  return { ...r, siblings };
}
