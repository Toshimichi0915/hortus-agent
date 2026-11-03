/**
 * The mirror writer: one bare repo per DOF (`dof/<name>.git`) with its worktree `dof/<name>/` on `main`. `commit`
 * turns Changes into files (temp + rename, so a reader never sees a half file) and one commit, serialized per DOF.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { crashPoint } from "../crash.ts";
import type { DatabaseSync } from "../db.ts";
import { logger } from "../log.ts";
import * as paths from "../paths.ts";
import type { Change, DiffEntry } from "../types.ts";
import { index } from "./fts.ts";
import { parse, render } from "./render.ts";

const run = promisify(execFile);
const log = logger("mirror");
// the owner's ~/.gitconfig (signing, hooks, templates) must not reach the mirror
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };

async function git(cwd: string, ...args: string[]): Promise<string> {
  const p = run("git", args, { cwd, env, maxBuffer: 256 * 1024 * 1024 });
  p.child.stdin?.end();
  return (await p).stdout;
}

/** The last commit whose diff is in the search index; trails `main` only after a crash between the two. */
const INDEXED = "refs/hortus/indexed";

/** `<status>\0<path>\0…` pairs */
function entries(z: string[]): DiffEntry[] {
  const diff: DiffEntry[] = [];
  for (let i = 0; i + 1 < z.length; i += 2) diff.push({ status: z[i] as DiffEntry["status"], path: z[i + 1] ?? "" });
  return diff;
}

/**
 * At start, before any commit: drop the index lock a git killed with hortusd left (every later commit would fail), and
 * index what a crash between a commit and its indexing left out (a re-sync of the same content commits nothing).
 */
export async function recover(db: DatabaseSync, name: string): Promise<void> {
  const tree = paths.dof(name);
  if (!existsSync(join(tree, ".git"))) return;
  rmSync(join(paths.dofRepo(name), "worktrees", basename(tree), "index.lock"), { force: true });
  const head = (await git(tree, "rev-parse", "HEAD")).trim();
  const from = (await git(tree, "rev-parse", "-q", "--verify", INDEXED).catch(() => "")).trim();
  if (from === head) return;
  // no ref yet (a repo from before it existed): taken as indexed
  if (from) {
    const diff = entries((await git(tree, "diff", "--no-renames", "-z", "--name-status", from, head)).split("\0"));
    index(db, name, tree, diff);
    log.info("indexed commits a crash left out", { dof: name, from, to: head, files: diff.length });
  }
  await git(tree, "update-ref", INDEXED, head);
}

/** Create the bare repo and its worktree with an empty root commit on `main`; no-op when both exist. */
export async function init(name: string): Promise<void> {
  const gitDir = paths.dofRepo(name);
  const tree = paths.dof(name);
  if (existsSync(join(tree, ".git"))) return;
  if (!existsSync(join(gitDir, "HEAD"))) {
    mkdirSync(gitDir, { recursive: true, mode: 0o700 });
    await git(gitDir, "init", "-q", "--bare", "-b", "main");
    await git(gitDir, "config", "user.name", "hortus");
    await git(gitDir, "config", "user.email", "hortus@localhost");
    await git(gitDir, "config", "gc.auto", "0");
    writeFileSync(join(gitDir, "info", "exclude"), ".*.tmp-*\n");
    const empty = (await git(gitDir, "mktree")).trim();
    const root = (await git(gitDir, "commit-tree", empty, "-m", `init(${name})`)).trim();
    await git(gitDir, "update-ref", "refs/heads/main", root);
    await git(gitDir, "update-ref", INDEXED, root);
  }
  await git(gitDir, "worktree", "prune");
  await git(gitDir, "worktree", "add", "-q", tree, "main");
}

/**
 * Refuse traversal, absolute paths, NULs and `.git`; a Markdown object must be `<channel>/channel.md` or
 * `<channel>/<thread>/<message>.md`, so an id holding `/` shows up as a wrong depth.
 */
export function unsafe(path: string): string | null {
  if (path.startsWith("/") || path.includes("\0")) return "absolute path or NUL";
  const segs = path.split("/");
  if (segs.some((s) => s === "" || s === "." || s === ".." || s === ".git")) return "empty, ., .. or .git segment";
  const isFile = segs.length === 4 && segs[2] === "files";
  if (path.endsWith(".md") && !isFile && !(segs.length === 2 ? segs[1] === "channel.md" : segs.length === 3)) {
    return "a Markdown object is <channel>/channel.md or <channel>/<thread>/<message>.md";
  }
  return null;
}

let tmpSeq = 0;
/** Temp name in the same directory, then rename: readers see the old file or the new one, never a part. */
export function writeAtomic(file: string, data: string | Buffer): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = join(dirname(file), `.${basename(file)}.tmp-${process.pid}-${tmpSeq++}`);
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

/** Remove `dir` and its parents up to (not including) `root` while they are empty. */
function prune(dir: string, root: string): void {
  for (let d = dir; d.startsWith(`${root}/`); d = dirname(d)) {
    try {
      rmdirSync(d);
    } catch {
      return;
    }
  }
}

function apply(root: string, c: Change): void {
  const file = join(root, c.path);
  if (c.op === "delete") {
    try {
      unlinkSync(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    prune(dirname(file), root);
    return;
  }
  if (c.op === "patch") {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      log.info("patch of a missing file skipped", { path: c.path });
      return;
    }
    const { frontmatter, body } = parse(text);
    for (const [k, v] of Object.entries(c.frontmatter ?? {})) {
      if (v === null) delete frontmatter[k];
      else frontmatter[k] = v;
    }
    writeAtomic(file, render(frontmatter, body));
  } else writeAtomic(file, c.bytes ?? render(c.frontmatter ?? {}, c.body ?? ""));
}

async function commitNow(db: DatabaseSync | null, name: string, changes: Change[], message: string) {
  await init(name);
  const root = paths.dof(name);
  for (const c of changes) {
    const why = unsafe(c.path);
    if (why) log.error("change dropped: unsafe path", undefined, { dof: name, path: c.path, why });
    else apply(root, c);
  }
  await git(root, "add", "-A");
  try {
    await git(root, "diff", "--cached", "--quiet");
    return null; // a sync with nothing new is not a commit
  } catch (e) {
    if ((e as { code?: unknown }).code !== 1) throw e;
  }
  await git(root, "commit", "-q", "--no-verify", "-m", message);
  // -z: "<sha>\0<status>\0<path>\0…", paths unquoted
  const [sha = "", ...rest] = (await git(root, "diff-tree", "-r", "-z", "--name-status", "HEAD")).split("\0");
  const diff = entries(rest);
  crashPoint(`mirror.after-commit:${name}`);
  // inside the chain: the files still hold this commit's content
  if (db) {
    index(db, name, root, diff);
    await git(root, "update-ref", INDEXED, sha);
  }
  return { sha, diff };
}

const chains = new Map<string, Promise<unknown>>();

/** One sync at a time per DOF; different DOFs run in parallel. `db` given → the diff is indexed before returning. */
export function commit(
  db: DatabaseSync | null,
  name: string,
  changes: Change[],
  message: string,
): Promise<{ sha: string; diff: DiffEntry[] } | null> {
  if (unsafe(name) !== null || name.includes("/")) return Promise.reject(new Error(`bad DOF name ${name}`));
  const next = (chains.get(name) ?? Promise.resolve())
    .catch(() => {})
    .then(() => commitNow(db, name, changes, message));
  chains.set(name, next);
  return next;
}
