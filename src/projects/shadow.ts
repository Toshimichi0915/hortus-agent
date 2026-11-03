/**
 * Shadow repos for non-git projects (08-projects.md › shadow.ts): `shadow/<name>.git` with the project directory as its
 * work tree and `exclude` in `info/exclude`. A snapshot is `add -A` + commit on the shadow's `main`; the origin fetches
 * it like any checkout. `restore` and `snapshot` are the only operations.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import * as paths from "../paths.ts";

const run = promisify(execFile);
const ID = ["-c", "user.name=hortus", "-c", "user.email=hortus@localhost", "-c", "commit.gpgsign=false"];

/** `git <args>` → trimmed stdout; throws with git's stderr. */
export async function git(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  try {
    const { stdout } = await run("git", args, { maxBuffer: 256 * 1024 * 1024, ...opts });
    return stdout.trim();
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    throw new Error((err.stderr ?? "").trim() || err.message);
  }
}

/** The branch the shadow commits snapshots on (the origin maps it onto the project's `main`). */
export const BRANCH = "main";

const sh = (name: string, path: string, args: string[]) =>
  git([...ID, "--git-dir", paths.shadow(name), "--work-tree", resolve(path), ...args]);

/** Creates the shadow on first use; rewrites `info/exclude` from `exclude` every time. */
export async function ensure(name: string, path: string, exclude: string[] = []): Promise<void> {
  const dir = paths.shadow(name);
  if (!existsSync(join(dir, "HEAD"))) {
    mkdirSync(dir, { recursive: true });
    await git(["init", "-q", "--bare", "-b", BRANCH, dir]);
    await git(["--git-dir", dir, "config", "core.bare", "false"]);
    await git(["--git-dir", dir, "config", "core.worktree", resolve(path)]);
    await git(["--git-dir", dir, "config", "gc.auto", "0"]);
  }
  mkdirSync(join(dir, "info"), { recursive: true });
  // ponytail: a path excluded after it was snapshotted stays tracked; `git rm --cached` it when that matters
  writeFileSync(join(dir, "info", "exclude"), exclude.map((e) => `${e}\n`).join(""));
}

/** `add -A` and commit (nothing to commit → no commit); returns the shadow's `main`. */
export async function snapshot(name: string, path: string, message = "snapshot"): Promise<string> {
  await sh(name, path, ["add", "-A"]);
  const head = await sh(name, path, ["rev-parse", "-q", "--verify", "HEAD"]).catch(() => "");
  const changed = await sh(name, path, ["diff", "--cached", "--quiet"]).then(
    () => false,
    () => true,
  );
  if (!head || changed) await sh(name, path, ["commit", "-q", "--allow-empty", "-m", message]);
  return sh(name, path, ["rev-parse", "HEAD"]);
}

/** The directory back to `sha` (deleting files added since), recorded as a new snapshot. Returns its sha. */
export async function restore(name: string, path: string, sha: string): Promise<string> {
  // snapshot first: a file the shadow never saw is not in the index, so read-tree would leave it in place
  await snapshot(name, path);
  await sh(name, path, ["read-tree", "-u", "--reset", sha]);
  return snapshot(name, path, `restore ${sha.slice(0, 7)}`);
}

export interface Snapshot {
  sha: string;
  ts: string;
  message: string;
}

/** The last `n` snapshots, newest first. */
export async function list(name: string, n = 20): Promise<Snapshot[]> {
  if (!existsSync(paths.shadow(name))) return [];
  const out = await git(["--git-dir", paths.shadow(name), "log", `-n${n}`, "--format=%H%x09%cI%x09%s", BRANCH]).catch(
    () => "",
  );
  return out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [sha = "", ts = "", ...m] = l.split("\t");
      return { sha, ts, message: m.join("\t") };
    });
}

/** `git` on the shadow with the project directory as work tree (merge.ts lands through it). */
export const inShadow = sh;
