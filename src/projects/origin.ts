/**
 * The local origin (08-projects.md › origin.ts): `projects/<name>.git` bare, its `pre-receive` hook, `sync` from the
 * owner's checkout (git) or the shadow (non-git), the pre-clone of an unattended task, `git http-backend` on
 * `hortusd.internal/git/<name>`, and the owner's `project.*` RPCs. `main` moves only by `sync` and an approved merge.
 */
import { spawn } from "node:child_process";
import { chmodSync, existsSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { z } from "zod";
import { type Config, PROJECT_NAME, PROJECT_NAME_HINT, ProjectConfig, save } from "../config.ts";
import { bus } from "../console/events.ts";
import { crashPoint } from "../crash.ts";
import { replaceFile } from "../hostile.ts";
import { logger } from "../log.ts";
import * as paths from "../paths.ts";
import { type Client, type IncomingRequest, internalRoutes, listen, type Out } from "../proxy/index.ts";
import { refuse } from "../proxy/pipeline.ts";
import { define } from "../rpc.ts";
import { RpcError, type TaskJson } from "../types.ts";
import { deps } from "../vault/gate.ts";
import { ctx } from "../vault/vault.ts";
import * as shadow from "./shadow.ts";

const { git } = shadow;
const log = logger("projects");

/** A project name: one path segment, no `..`. */
export const NAME = PROJECT_NAME;

// Workers may push only hortus/<their task> (force allowed); core (hortusd) anything; nobody else. Deletions are
// refused by receive.denyDeletes before this runs.
const HOOK = `#!/bin/sh
while read old new ref; do
  case "$HORTUS_ROLE" in
    worker) [ "$ref" = "refs/heads/hortus/$HORTUS_TASK" ] || { echo "refused: $ref" >&2; exit 1; } ;;
    core) ;;
    *) echo "refused: role" >&2; exit 1 ;;
  esac
done
`;

export function project(name: string): ProjectConfig {
  const p = ctx().config.projects[name];
  if (!NAME.test(name) || !p) throw new RpcError("not_found", `no project ${name}`);
  return p;
}

/** A git project is a directory with `.git`; anything else is shadowed. */
export const isGit = (p: ProjectConfig): boolean => existsSync(join(p.path, ".git"));

/** The bare origin with its config and hook (idempotent: the hook is rewritten each time). */
export async function ensure(name: string): Promise<string> {
  const p = project(name);
  const dir = paths.project(name);
  if (!existsSync(join(dir, "HEAD"))) {
    await git(["init", "-q", "--bare", "-b", p.main, dir]);
    // receive.denyNonFastForwards is not set: it applies to every ref, so a Worker's rebased force-push of its own
    // branch would be refused; main is guarded by the hook (no Worker ref but hortus/<task>) and update-ref (v7)
    for (const kv of [
      "receive.denyDeletes=true",
      "gc.auto=0",
      "http.receivepack=true",
      "uploadpack.allowAnySHA1InWant=true",
    ])
      await git(["--git-dir", dir, "config", ...kv.split("=")]);
  }
  await git(["--git-dir", dir, "symbolic-ref", "HEAD", `refs/heads/${p.main}`]);
  writeFileSync(join(dir, "hooks", "pre-receive"), HOOK);
  chmodSync(join(dir, "hooks", "pre-receive"), 0o755);
  if (!isGit(p)) await shadow.ensure(name, p.path, p.exclude);
  return dir;
}

export const revParse = (dir: string, ref: string): Promise<string> =>
  git(["--git-dir", dir, "rev-parse", "-q", "--verify", `${ref}^{commit}`]).catch(() => "");

/**
 * The checkout's `main` (or a fresh shadow snapshot) into the origin, fast-forward only unless `force`. Returns the
 * origin's `main`; a move sends "rebase" to the project's pending merges.
 */
export function sync(name: string, force = false): Promise<{ main: string; moved: boolean }> {
  // one at a time per project: a task start, a merge request and a landing may sync together (shadow commit, ref lock)
  return serialized(name, () => syncNow(name, force));
}

/** `fn` on `name`'s sync chain: no sync of the project runs meanwhile (a landing's ff and update-ref). */
export function serialized<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const next = (syncing.get(name) ?? Promise.resolve()).then(fn);
  const tail = next.catch(() => {});
  syncing.set(name, tail);
  void tail.then(() => syncing.get(name) === tail && syncing.delete(name));
  return next;
}
const syncing = new Map<string, Promise<unknown>>();

async function syncNow(name: string, force: boolean): Promise<{ main: string; moved: boolean }> {
  const p = project(name);
  const dir = await ensure(name);
  const git_ = isGit(p);
  if (!git_) await shadow.snapshot(name, p.path);
  const src = git_ ? resolve(p.path) : paths.shadow(name);
  const ref = git_ ? p.main : shadow.BRANCH;
  const before = await revParse(dir, `refs/heads/${p.main}`);
  try {
    await git(["--git-dir", dir, "fetch", src, `${force ? "+" : ""}refs/heads/${ref}:refs/heads/${p.main}`]);
  } catch (e) {
    const msg = (e as Error).message;
    if (/non-fast-forward|rejected/.test(msg)) {
      log.error("sync refused: main was rewritten", undefined, { project: name });
      throw new RpcError(
        "invalid",
        `${name}: ${p.main} was rewritten in the checkout; \`hortus sync --force ${name}\``,
      );
    }
    throw e;
  }
  const main = await revParse(dir, `refs/heads/${p.main}`);
  if (main !== before) {
    log.info("main moved", { project: name, from: before, to: main, force });
    mainMoved(name, main);
  }
  return { main, moved: main !== before };
}

/**
 * `main` moved: every open merge entry on the project for another base is `replaced` and its task told to rebase.
 * `except`: the entry that just landed.
 */
export function mainMoved(name: string, main: string, except?: number): void {
  const db = ctx().db;
  // an approved entry for this very sha: a landing a crash cut between the checkout's ff and the origin's update-ref
  // (this sync carried the rest); it landed, it is not "replaced"
  const done = db
    .prepare(
      `UPDATE approvals SET status = 'landed', reason = NULL WHERE category = 'merge' AND status = 'approved'
        AND json_extract(summary, '$.project') = ? AND json_extract(summary, '$.sha') = ? AND id IS NOT ?
        RETURNING id, task_id`,
    )
    .all(name, main, except ?? null) as { id: number; task_id: string | null }[];
  for (const r of done) {
    log.info("merge landed (completed by a sync)", { id: r.id, project: name, sha: main });
    if (r.task_id)
      try {
        deps.inboxWrite(r.task_id, {
          from: "merge",
          trusted: true,
          text: `merged ${main}`,
          data: { approval: r.id, landed: true, sha: main },
        });
      } catch (e) {
        log.error("inbox write failed", e, { id: r.id, task: r.task_id });
      }
  }
  if (done.length) bus.emit("approvals", {});
  const rows = db
    .prepare(
      `SELECT id, task_id FROM approvals WHERE category = 'merge' AND status IN ('pending', 'approved')
        AND json_extract(summary, '$.project') = ? AND json_extract(summary, '$.main_sha') != ? AND id IS NOT ?`,
    )
    .all(name, main, except ?? null) as { id: number; task_id: string | null }[];
  if (rows.length) bus.emit("approvals", {});
  for (const r of rows) {
    db.prepare("UPDATE approvals SET status = 'replaced', reason = ? WHERE id = ?").run(
      `main moved to ${main.slice(0, 7)}`,
      r.id,
    );
    if (!r.task_id) continue;
    try {
      deps.inboxWrite(r.task_id, {
        from: "rebase",
        trusted: true,
        text: `main moved to ${main}; rebase hortus/${r.task_id} and request merge again`,
        data: { approval: r.id, main },
      });
    } catch (e) {
      log.error("rebase notice failed", e, { task: r.task_id });
    }
  }
}

/**
 * A task on `name` is about to start (host: prepareClone; VM: the guest clones the origin itself). A failed sync (main
 * rewritten in the checkout, the path gone) goes on `note`, the card: the merge is refused much later and only the log
 * said why. With no main in the origin there is nothing to work on: it throws, and the task waits with the reason.
 */
export async function startSync(name: string, note: (text: string) => void): Promise<void> {
  await sync(name).catch(async (e) => {
    log.error("sync at task start failed", e, { project: name });
    if (!(await revParse(paths.project(name), `refs/heads/${project(name).main}`))) throw e;
    note(`project sync failed, working from the last synced main: ${(e as Error).message}`);
  });
}

/**
 * Before an unattended host task on a project starts (the Landlock profile grants rw on `clones/<id>` only if it
 * exists, so hortusd pre-clones; v7): sync, then on first start `git clone --no-local --reference <checkout>` of the
 * origin on `hortus/<id>`, `origin` set to `clone_url`. `loopback` (HORTUS_NO_NET only): the session's alias, given
 * its own listener so git reaches hortusd.internal with the task's identity.
 */
export async function prepareClone(
  task: TaskJson,
  loopback?: string,
  note: (text: string) => void = () => {},
): Promise<void> {
  const name = task.scope.project;
  const dir = task.paths.clone;
  if (!name || !dir) return;
  const p = project(name);
  await startSync(name, note);
  if (!existsSync(dir)) {
    // only where the objects are the checkout's own: git refuses a linked worktree, and a Worker sees the checkout alone,
    // so a clone with alternates beyond it could not read them. Without it the clone is a full copy of the origin
    const objects = join(p.path, ".git/objects");
    const ref =
      existsSync(objects) && !existsSync(join(objects, "info/alternates")) ? ["--reference", resolve(p.path)] : [];
    // whole or not at all: a restart inside a clone left one on `main` with the origin's path as its remote, and as
    // `dir` existed nothing finished it (round 23). No session has run in `.new`: hortusd's own to remove
    const tmp = `${dir}.new`;
    rmSync(tmp, { recursive: true, force: true });
    await git(["clone", "-q", "--no-local", ...ref, paths.project(name), tmp]);
    crashPoint("origin.after-clone");
    await git(["-C", tmp, "checkout", "-q", "-b", `hortus/${task.id}`]);
    await git(["-C", tmp, "remote", "set-url", "origin", task.clone_url ?? `https://hortusd.internal/git/${name}`]);
    renameSync(tmp, dir);
  } else if (
    existsSync(join(dir, ".git/objects/info/alternates")) &&
    realpathSync(join(dir, ".git/objects/info")) === join(realpathSync(dir), ".git/objects/info")
  ) {
    // the checkout may have moved (project.set): every git command in the clone died on the old path
    // ponytail: a move to where --reference would not be used (a linked worktree) leaves the clone broken; close the task
    // (the Worker owns this clone: replaceFile takes a link planted as `alternates`, the realpath one on the way to it,
    // `.git → the owner's other repo`, which would otherwise lose that repo's own file. No session runs here to race it)
    replaceFile(join(dir, ".git/objects/info/alternates"), `${resolve(p.path)}/.git/objects\n`);
  }
  if (loopback) {
    // the dispatcher's loopbackLink opened it already (listen returns the existing ports)
    const { http } = await listen(loopback, { https: 0, http: 0, dns: 0, proxyAddress: "127.0.0.1" });
    await git(["-C", dir, "remote", "set-url", "origin", `http://${loopback}:${http}/git/${name}`]);
    await git(["-C", dir, "config", "--replace-all", "http.extraHeader", "Host: hortusd.internal"]);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// git http-backend on hortusd.internal/git/<name>

/** Role core: any project; a chat Worker: any configured one; an unattended Worker: its `scope.project`. */
function allowed(client: Client, name: string): boolean {
  if (client.role === "core") return true;
  if (client.role !== "worker" || !client.task) return false;
  const t = ctx().db.prepare("SELECT kind, scope FROM tasks WHERE id = ?").get(client.task) as
    | { kind: string; scope: string | null }
    | undefined;
  if (!t) return false;
  if (t.kind === "chat") return true;
  return (JSON.parse(t.scope ?? "{}") as { project?: string }).project === name;
}

async function backend(client: Client, req: IncomingRequest, rest: string): Promise<Out> {
  const [name = "", ...tail] = rest.split("/");
  if (!NAME.test(name) || !ctx().config.projects[name] || tail.includes("..")) {
    req.body?.resume();
    return refuse(404, `no project ${name}`);
  }
  if (!allowed(client, name)) {
    req.body?.resume();
    return refuse(403, `project ${name} is not in this task's scope`);
  }
  await ensure(name);
  const h = req.headers;
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    GIT_PROJECT_ROOT: join(paths.home(), "projects"),
    GIT_HTTP_EXPORT_ALL: "1",
    PATH_INFO: `/${name}.git/${tail.join("/")}`,
    REQUEST_METHOD: req.method.toUpperCase(),
    QUERY_STRING: req.path.split("?")[1] ?? "",
    CONTENT_TYPE: h["content-type"] ?? "",
    REMOTE_USER: `${client.role}:${client.task ?? ""}`,
    REMOTE_ADDR: "127.0.0.1",
    HORTUS_ROLE: client.role,
    HORTUS_TASK: client.task ?? "",
    ...(h["content-length"] ? { CONTENT_LENGTH: h["content-length"] } : {}),
    ...(h["content-encoding"] ? { HTTP_CONTENT_ENCODING: h["content-encoding"] } : {}),
    ...(h["git-protocol"] ? { GIT_PROTOCOL: h["git-protocol"] } : {}),
  };
  const child = spawn("git", ["http-backend"], { env, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.on("error", () => {});
  if (req.body) req.body.pipe(child.stdin);
  else child.stdin.end();
  let stderr = "";
  child.stderr.on("data", (c: Buffer) => {
    stderr += c.toString();
  });
  child.on("close", (code) => {
    if (code) log.error("git http-backend failed", undefined, { project: name, code, stderr: stderr.slice(-2000) });
  });
  // CGI: headers up to the blank line, then the body streamed as it comes
  return new Promise<Out>((done) => {
    let buf = Buffer.alloc(0);
    const onData = (c: Buffer) => {
      buf = Buffer.concat([buf, c]);
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      child.stdout.off("data", onData);
      child.stdout.off("end", onEnd);
      const headers: Record<string, string> = {};
      let status = 200;
      for (const line of buf.subarray(0, end).toString("latin1").split("\r\n")) {
        const i = line.indexOf(":");
        if (i < 0) continue;
        const k = line.slice(0, i).trim().toLowerCase();
        const v = line.slice(i + 1).trim();
        if (k === "status") status = Number.parseInt(v, 10) || 500;
        else headers[k] = v;
      }
      const body = new PassThrough();
      body.write(buf.subarray(end + 4));
      child.stdout.pipe(body);
      done({ status, headers, body });
    };
    const onEnd = () => done(refuse(502, `git http-backend: ${stderr.trim().slice(-500) || "no response"}`));
    child.stdout.on("data", onData);
    child.stdout.on("end", onEnd);
  });
}

internalRoutes.push(
  { method: "GET", prefix: "/git/", run: backend },
  { method: "POST", prefix: "/git/", run: backend },
);

// ---------------------------------------------------------------------------------------------------------------------
// RPCs, role owner (the Projects page and `hortus sync --force`)

const owner = ["owner" as const];
const Name = z.object({ name: z.string().regex(NAME, PROJECT_NAME_HINT) });

async function writeConfig(change: (c: Config) => void): Promise<void> {
  const c = ctx();
  const next = structuredClone(c.config);
  change(next);
  save(next, paths.config());
  await c.reload();
}

define("project.set", {
  roles: owner,
  input: ProjectConfig.extend(Name.shape),
  async run({ name, ...p }) {
    if (!isAbsolute(p.path)) throw new RpcError("invalid", "path must be absolute");
    if (!existsSync(p.path) || !statSync(p.path).isDirectory())
      throw new RpcError("invalid", `${p.path} is not a directory`);
    await writeConfig((c) => {
      c.projects[name] = p;
    });
    return sync(name);
  },
});

define("project.delete", {
  roles: owner,
  input: Name,
  async run({ name }) {
    project(name);
    await writeConfig((c) => {
      delete c.projects[name];
    });
    // an open merge names a branch in the origin moved aside below: approved, it died on `not our ref`, and its `approved`
    // status answered the task's next request after a re-add
    const open = ctx()
      .db.prepare(
        `UPDATE approvals SET status = 'replaced', reason = 'the project was removed' WHERE category = 'merge'
          AND status IN ('pending', 'approved') AND json_extract(summary, '$.project') = ? RETURNING task_id`,
      )
      .all(name) as { task_id: string | null }[];
    if (open.length) bus.emit("approvals", {});
    for (const { task_id } of open)
      try {
        if (task_id) deps.inboxWrite(task_id, { from: "merge", trusted: true, text: `project ${name} was removed` });
      } catch (e) {
        log.error("inbox write failed", e, { task: task_id });
      }
    // the origin and shadow stay on disk, out of the way
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    for (const dir of [paths.project(name), paths.shadow(name)])
      if (existsSync(dir)) renameSync(dir, `${dir}.removed-${ts}`);
    return { ok: true };
  },
});

define("project.sync", {
  roles: owner,
  input: Name.extend({ force: z.boolean().default(false) }),
  run: ({ name, force }) => sync(name, force),
});

define("project.snapshots", {
  roles: owner,
  input: Name,
  run({ name }) {
    project(name);
    return shadow.list(name);
  },
});

define("project.restore", {
  roles: owner,
  input: Name.extend({ sha: z.string().regex(/^[0-9a-f]{40}$/) }),
  async run({ name, sha }) {
    const p = project(name);
    if (isGit(p)) throw new RpcError("invalid", `${name} is a git project: restore with git`);
    await ensure(name);
    const restored = await shadow.restore(name, p.path, sha);
    return { sha: restored, ...(await sync(name)) };
  },
});
