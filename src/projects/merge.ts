/**
 * `merge()` and the landing (08-projects.md › merge.ts): a Worker asks for `hortus/<task>` → `main`, the gate opens a
 * `merge` entry hashed on (project, sha, main_sha); on approval the checkout fast-forwards, then the origin's `main`
 * (`update-ref` with the old sha). Nothing moves unless both can; the reason goes on the entry and to the inbox.
 */
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";
import { bus } from "../console/events.ts";
import { crashPoint } from "../crash.ts";
import { logger } from "../log.ts";
import * as paths from "../paths.ts";
import { define } from "../rpc.ts";
import { RpcError } from "../types.ts";
import * as gate from "../vault/gate.ts";
import { ctx } from "../vault/vault.ts";
import { isGit, mainMoved, project, revParse, serialized, sync } from "./origin.ts";
import { git, inShadow } from "./shadow.ts";

const log = logger("merge");
export const MAX_PATCH = 64 * 1024;

export interface MergeSummary {
  project: string;
  branch: string;
  main_sha: string;
  sha: string;
  stat: string;
  files: number;
  added: number;
  removed: number;
  patch: string;
  truncated: boolean;
}

/** The merge entry for the caller's branch (one open entry per task: older ones become `replaced`). */
export async function request(taskId: string): Promise<{ approval: number; url: string }> {
  const db = ctx().db;
  const t = db.prepare("SELECT kind, scope FROM tasks WHERE id = ?").get(taskId) as
    | { kind: string; scope: string | null }
    | undefined;
  if (!t) throw new RpcError("not_found", `no task ${taskId}`);
  const name = (JSON.parse(t.scope ?? "{}") as { project?: string }).project;
  if (t.kind === "chat" || !name) throw new RpcError("forbidden", "merge needs an unattended task with a project");
  const p = project(name);
  // non-git: a snapshot at each request, so an owner edit since the task started sends this one to rebase first
  await sync(name).catch((e) => log.error("sync before merge failed", e, { task: taskId }));
  const dir = paths.project(name);
  const branch = `hortus/${taskId}`;
  const sha = await revParse(dir, `refs/heads/${branch}`);
  if (!sha) throw new RpcError("invalid", `${branch} is not in the origin: push it first`);
  const main_sha = await revParse(dir, `refs/heads/${p.main}`);
  if (sha === main_sha) throw new RpcError("invalid", `${branch} is ${p.main}: nothing to merge`);
  const based = await git(["--git-dir", dir, "merge-base", "--is-ancestor", main_sha, sha]).then(
    () => true,
    () => false,
  );
  if (!based)
    throw new RpcError("invalid", `${branch} is not based on ${p.main} (${main_sha.slice(0, 7)}): fetch, rebase, push`);
  const hash = createHash("sha256").update(`${name}\0${sha}\0${main_sha}`).digest("hex");
  db.prepare(
    "UPDATE approvals SET status = 'replaced', reason = 'a newer merge request' WHERE category = 'merge' AND task_id = ? AND status IN ('pending', 'approved') AND hash != ?",
  ).run(taskId, hash);
  const open = db
    .prepare(
      "SELECT id FROM approvals WHERE category = 'merge' AND task_id = ? AND hash = ? AND status IN ('pending', 'approved')",
    )
    .get(taskId, hash) as { id: number } | undefined;
  if (open) return { approval: open.id, url: gate.approvalUrl(open.id) };

  const d = (...a: string[]) => git(["--git-dir", dir, "diff", ...a, main_sha, sha]);
  const numstat = (await d("--numstat")).split("\n").filter(Boolean);
  const nums = numstat.map((l) => l.split("\t").map((n) => Number(n) || 0));
  const patch = await d();
  const summary: MergeSummary = {
    project: name,
    branch,
    main_sha,
    sha,
    stat: await d("--stat"),
    files: numstat.length,
    added: nums.reduce((s, [a = 0]) => s + a, 0),
    removed: nums.reduce((s, [, r = 0]) => s + r, 0),
    patch: patch.slice(0, MAX_PATCH),
    truncated: patch.length > MAX_PATCH,
  };
  const r = gate.check({
    caller: { role: "worker", task: taskId },
    category: "merge",
    hash,
    summary: summary as unknown as gate.Summary,
    consequential: true,
  });
  if (r === "pass") throw new RpcError("failed", "merge passed the gate without an entry");
  return { approval: r.pending, url: gate.approvalUrl(r.pending) };
}

let chain: Promise<unknown> = Promise.resolve();

/** Lands an approved merge entry; one at a time. Returns null when it landed, else the reason (also on the entry). */
export function land(id: number): Promise<string | null> {
  const next = chain.then(() => landNow(id));
  chain = next.catch(() => {});
  return next;
}

/** After `gate.decide(id, "approve")`: a merge entry lands (other categories are not ours); why not, if it did not. */
export async function onApproved(id: number): Promise<string | null> {
  const row = ctx().db.prepare("SELECT category FROM approvals WHERE id = ?").get(id) as
    | { category: string }
    | undefined;
  return row?.category === "merge" ? await land(id) : null;
}

async function landNow(id: number): Promise<string | null> {
  const db = ctx().db;
  const row = () =>
    db.prepare("SELECT status, task_id, summary FROM approvals WHERE id = ?").get(id) as
      | { status: string; task_id: string | null; summary: string }
      | undefined;
  const r = row();
  if (!r) throw new RpcError("not_found", `no approval ${id}`);
  if (r.status !== "approved") throw new RpcError("invalid", `approval ${id} is ${r.status}, not approved`);
  const s = JSON.parse(r.summary) as MergeSummary;
  const tell = (text: string, data: Record<string, unknown>) => {
    if (!r.task_id) return;
    try {
      gate.deps.inboxWrite(r.task_id, { from: "merge", trusted: true, text, data: { approval: id, ...data } });
    } catch (e) {
      log.error("inbox write failed", e, { id, task: r.task_id });
    }
  };
  const fail = (reason: string): string => {
    log.info("merge did not land", { id, reason });
    db.prepare("UPDATE approvals SET reason = ? WHERE id = ?").run(reason, id);
    bus.emit("approvals", { id });
    tell(`merge ${id} did not land: ${reason}`, { landed: false, reason });
    return reason;
  };
  try {
    const p = project(s.project);
    const origin = paths.project(s.project);
    // non-git: the snapshot at approval; an owner edit since moves main, which replaces this entry (rebase notice)
    await sync(s.project);
    // the checks, the ff and the update-ref on the project's sync chain: a sync in between (another task's start)
    // would carry the checkout's new main into the origin first and send this entry a rebase notice
    return await serialized(s.project, async () => {
      const landed = () => {
        db.prepare("UPDATE approvals SET status = 'landed', reason = NULL WHERE id = ?").run(id);
        bus.emit("approvals", { id });
        log.info("merge landed", { id, project: s.project, sha: s.sha });
        tell(`merged ${s.sha}`, { landed: true, sha: s.sha });
        mainMoved(s.project, s.sha, id);
        return null;
      };
      const status = row()?.status;
      if (status === "landed") return null; // the sync above completed a landing a crash cut short (mainMoved)
      if (status !== "approved") return `main moved; ${s.branch} must be rebased`;
      // a crash after the origin's update-ref, before the entry said so
      if ((await revParse(origin, `refs/heads/${p.main}`)) === s.sha) return landed();
      const git_ = isGit(p);
      const co = resolve(p.path);
      const g = git_ ? (a: string[]) => git(["-C", co, ...a]) : (a: string[]) => inShadow(s.project, p.path, a);
      if (git_) {
        const branch = await g(["symbolic-ref", "-q", "--short", "HEAD"]).catch(() => "(detached)");
        if (branch !== p.main) return fail(`checkout is on ${branch}, not ${p.main}`);
      }
      const head = await g(["rev-parse", "HEAD"]);
      if (head !== s.main_sha) return fail(`checkout is at ${head.slice(0, 7)}, not ${s.main_sha.slice(0, 7)}`);
      if (git_ && (await g(["status", "--porcelain", "--untracked-files=no"]))) return fail("checkout is not clean");
      await g(["fetch", "-q", origin, s.sha]);
      try {
        await g(["merge", "-q", "--ff-only", s.sha]);
      } catch (e) {
        return fail(`merge --ff-only refused: ${(e as Error).message.slice(0, 500)}`);
      }
      crashPoint("merge.after-ff");
      try {
        await git(["--git-dir", origin, "update-ref", `refs/heads/${p.main}`, s.sha, s.main_sha]);
      } catch (e) {
        // ponytail: unreachable while the landing holds the sync chain and the checkout was at main_sha; logged
        log.error("checkout moved but the origin did not", e, { id });
        return fail(`update-ref refused: ${(e as Error).message.slice(0, 500)}`);
      }
      crashPoint("merge.after-update-ref");
      return landed();
    });
  } catch (e) {
    return fail(e instanceof Error ? e.message.slice(0, 500) : String(e));
  }
}

define("merge", {
  roles: ["worker"],
  input: z.unknown(),
  run(_input, caller) {
    if (!caller.task) throw new RpcError("forbidden", "merge needs a task");
    return request(caller.task);
  },
});

define("merge.retry", {
  roles: ["owner"],
  input: z.object({ id: z.number().int() }),
  async run({ id }) {
    const reason = await land(id);
    return { landed: reason === null, reason };
  },
});
