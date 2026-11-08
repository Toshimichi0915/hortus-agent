/** The console module: the web UI listener and the RPCs it owns. */
import { createHash } from "node:crypto";
import { existsSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { Config, oneLine, save } from "../config.ts";
import { changedPaths, mergePatch } from "../config-schema.ts";
import type { Ctx, Module } from "../ctx.ts";
import { taintOf } from "../db.ts";
import { readDofFile } from "../mirror/file.ts";
import { define } from "../rpc.ts";
import { localConsole } from "../runtime/net.ts";
import { priceOf, RpcError } from "../types.ts";
import * as gate from "../vault/gate.ts";
import { type ApprovalRow, approvalOut, excerpt } from "../vault/gate.ts";
import { diff } from "../vault/submit.ts";
import { bus } from "./events.ts";
import { remoteUrl, startRemote, stopRemote } from "./remote.ts";
import {
  CLOSED_SQL,
  consoleLog,
  lastReplies,
  line,
  OPEN_SQL,
  PAGE,
  PENDING_FOR,
  parse,
  repliesBefore,
  type ScheduleListRow,
  type TaskRow,
  taskOrigin,
  withSummaries,
} from "./rows.ts";
import { type Console, startServer } from "./server.ts";

export { bus } from "./events.ts";

let current: Ctx | undefined;
const ctx = (): Ctx => {
  if (!current) throw new RpcError("failed", "console not started");
  return current;
};

const owner = ["owner"] as const;

/** The approvals that wait on a task: a task's own, and a shared login or grant it waits for. */
const COUNT_PENDING = `SELECT count(*) AS n FROM (${PENDING_FOR})`;

function taskOut(t: TaskRow) {
  const r = t as TaskRow & { scope?: string; origins?: string; event_keys?: string };
  return {
    ...t,
    budget: parse(t.budget) ?? null,
    usage: parse(t.usage) ?? null,
    // whether its dollars count: a model with no price has no spending limit
    priced: !!priceOf(ctx().config.prices, ctx().config.worker.provider, ctx().config.worker.model),
    scope: parse(r.scope) ?? null,
    origins: parse(r.origins) ?? null,
    event_keys: parse(r.event_keys) ?? null,
  };
}

/** The newest `limit` open tasks, then the newest `limit` closed ones, each list from `skip` (the CLI pages `--all`). */
define("task.list", {
  roles: [...owner],
  input: z
    .object({
      limit: z.number().int().positive().max(500).default(50),
      skip: z.number().int().nonnegative().default(0),
    })
    .loose()
    .default({ limit: 50, skip: 0 }),
  run({ limit, skip }) {
    const db = ctx().db;
    const pending = db.prepare(COUNT_PENDING);
    return [
      ...(db.prepare(OPEN_SQL).all(limit, skip) as unknown as TaskRow[]),
      ...(db.prepare(CLOSED_SQL).all(limit, skip) as unknown as TaskRow[]),
    ].map((t) => ({ ...taskOut(t), pending: (pending.get(t.id) as { n: number }).n }));
  },
});

define("task.get", {
  roles: [...owner],
  input: z.object({ id: z.string() }),
  run({ id }) {
    const c = ctx();
    const db = c.db;
    const t = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
    if (!t) throw new RpcError("not_found", `no task ${id}`);
    const rows = <T>(sql: string) => db.prepare(sql).all(id) as unknown as T[];
    // the newest PAGE, oldest first (a scheduled task's 5,000 posts); a body is the Worker's, so through `line`
    const box = (table: "inbox" | "outbox") =>
      rows<{ body: string }>(`SELECT * FROM ${table} WHERE task_id = ? ORDER BY seq DESC LIMIT ${PAGE}`)
        .reverse()
        .map((m) => ({ ...m, body: line(m.body) }));
    const { n: pending } = db.prepare(COUNT_PENDING).get(id) as { n: number };
    return {
      task: { ...taskOut(t), pending },
      summary: t.summary,
      replies: lastReplies(c, id).map((r) => ({ ...r, body: line(r.body) })),
      // what the Approvals page gets: a card reads `payload` and `grantable` (a tainted request says so there)
      approvals: rows<ApprovalRow>(`${PENDING_FOR} ORDER BY id LIMIT ${PAGE}`).map((a) => excerpt(approvalOut(db, a))),
      inbox: box("inbox"),
      outbox: box("outbox"),
      schedules: withSummaries(
        c,
        rows<ScheduleListRow>(
          `SELECT s.*, t.title FROM schedules s LEFT JOIN tasks t ON t.id = s.task_id WHERE s.task_id = ?
            ORDER BY s.fire_at LIMIT ${PAGE}`,
        ),
      ),
      origin: taskOrigin(c, id),
      tainted: taintOf(db, id, c.config),
      console_log: consoleLog(c, t) ?? undefined,
    };
  },
});

/** One task's inbox or outbox, newest first, from `skip`: task.get has only the newest PAGE. */
define("task.messages", {
  roles: [...owner],
  input: z.object({
    id: z.string(),
    box: z.enum(["inbox", "outbox"]),
    limit: z.number().int().positive().max(500).default(50),
    skip: z.number().int().nonnegative().default(0),
  }),
  run({ id, box, limit, skip }) {
    const rows = ctx()
      .db.prepare(`SELECT * FROM ${box} WHERE task_id = ? ORDER BY seq DESC LIMIT ? OFFSET ?`)
      .all(id, limit, skip) as unknown as { body: string }[];
    return rows.map((m) => ({ ...m, body: line(m.body) }));
  },
});

/** A chat's rows before `before`, oldest first: the stream starts at the last 1000, and the page scrolls back from there. */
define("task.earlier", {
  roles: [...owner],
  input: z.object({ id: z.string(), before: z.number().int() }),
  run({ id, before }) {
    return repliesBefore(ctx(), id, before).map((r) => ({ ...r, body: line(r.body) }));
  },
});

define("settings.get", {
  roles: [...owner],
  input: z.unknown(),
  run: () => ({ config: ctx().config }),
});

/**
 * Validates against the Config schema (the error names the zod path), writes hortusd.json, then `reload()`. With
 * `approval`, a pending `settings` proposal is approved by this save: as proposed (approval.decide) or as the owner
 * edited it in Settings.
 */
define("settings.set", {
  roles: [...owner],
  input: z.object({ config: z.unknown(), approval: z.number().int().optional() }),
  async run({ config, approval }) {
    const c = ctx();
    const r = Config.safeParse(config);
    if (!r.success) throw new RpcError("invalid", oneLine(r.error), r.error.issues);
    const proposal = approval === undefined ? undefined : gate.pendingProposal(approval);
    save(r.data, c.paths.config());
    await c.reload();
    // a crash here leaves it saved and pending: approving again finds the current settings already the proposed ones
    if (proposal) {
      const edited = changedPaths(json(r.data), proposal.next).length > 0;
      gate.decide(proposal.id, "approve", "owner", edited ? { reason: "applied with the owner's edits" } : {});
    }
    bus.emit("settings");
    // kept (Config is loose, for a newer version's keys), but a typo (`polcy`) would otherwise read as saved and in force
    const unknown = Object.keys(r.data).filter((k) => !(k in Config.shape));
    return unknown.length
      ? { ok: true, message: `saved; not settings hortusd knows: ${unknown.join(", ")}` }
      : { ok: true };
  },
});

const json = (v: unknown): unknown => JSON.parse(JSON.stringify(v));

/** Settings a change to which widens what a task may reach or who decides: the entry warns about these. */
const WIDENS = [
  "policy",
  "chat.allow",
  "origins",
  "worker.credentials",
  "worker.plugins",
  "judge_notes",
  "dev",
  "dofs",
];

/**
 * The directories a proposal adds that hortusd uses as they are (a project's checkout, a plugin, a `files` DOF): each
 * must be an existing absolute directory outside hortus's own state, where a task's `work` is deleted when the task
 * closes and a missing plugin directory stops every session. A Worker cannot create one, so it learns this now.
 */
function badDir(base: Config, next: Config): string | undefined {
  const state = [resolve(join(homedir(), ".hortus")), ctx().paths.home()];
  const added: [string, string][] = [
    ...Object.entries(next.projects).flatMap(([n, p]): [string, string][] =>
      base.projects[n]?.path === p.path ? [] : [[`projects.${n}.path`, p.path]],
    ),
    ...next.worker.plugins
      .filter((d) => !base.worker.plugins.includes(d))
      .map((d): [string, string] => ["worker.plugins", d]),
    ...Object.entries(next.dofs).flatMap(([n, d]): [string, string][] =>
      d.type === "files" && d.path !== undefined && base.dofs[n]?.path !== d.path ? [[`dofs.${n}.path`, d.path]] : [],
    ),
  ];
  for (const [key, dir] of added) {
    if (!isAbsolute(dir)) return `${key}: ${dir} is not an absolute path`;
    const r = resolve(dir);
    if (state.some((s) => r === s || r.startsWith(`${s}/`)))
      return `${key}: ${dir} is inside hortus's own state (a task's work is deleted when it closes): ask the owner to copy it to a permanent directory first, then propose that path`;
    if (!existsSync(r) || !statSync(r).isDirectory())
      return `${key}: ${dir} is not an existing directory: you cannot create it; ask the owner to put it there first, then propose it`;
  }
  return undefined;
}

/**
 * A Worker proposes a change to hortusd.json as a JSON Merge Patch: validated now (a bad one never reaches the owner),
 * then a `settings` entry the owner always decides (`gate.check`, never the judge). Approving applies it, unless the
 * settings changed since (approval.decide); Settings can open it as a draft to edit first.
 */
define("settings.propose", {
  roles: ["worker"],
  input: z.object({ patch: z.record(z.string(), z.unknown()), reason: z.string().min(1).max(2000) }),
  run({ patch, reason }, caller) {
    const c = ctx();
    const base = json(c.config);
    const r = Config.safeParse(mergePatch(base, patch));
    if (!r.success) throw new RpcError("invalid", oneLine(r.error), r.error.issues);
    const next = json(r.data);
    const paths = changedPaths(base, next);
    if (!paths.length) throw new RpcError("invalid", "the patch changes nothing");
    const bad = badDir(c.config, r.data);
    if (bad) throw new RpcError("invalid", bad);
    const widens = paths.filter((p) => WIDENS.some((w) => p === w || p.startsWith(`${w}.`)));
    const pretty = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
    const summary = { reason, paths, widens, patch, diff: diff(pretty(base), pretty(next)) };
    const hash = createHash("sha256")
      .update(JSON.stringify([base, next]))
      .digest("hex");
    const g = gate.check({ caller, category: "settings", hash, summary, consequential: true });
    if (g === "pass") return { approval: null, message: "already approved" };
    const row = c.db.prepare("SELECT payload FROM approvals WHERE id = ?").get(g.pending) as { payload: string | null };
    c.db
      .prepare("UPDATE approvals SET payload = ? WHERE id = ? AND status = 'pending'")
      .run(JSON.stringify({ ...JSON.parse(row.payload ?? "{}"), base, next }), g.pending);
    return { approval: g.pending, url: gate.approvalUrl(g.pending), paths };
  },
});

define("pause.get", {
  roles: [...owner],
  input: z.unknown(),
  run: () => ({ paused: existsSync(ctx().paths.paused()) }),
});

define("pause.set", {
  roles: [...owner],
  input: z.object({ paused: z.boolean() }),
  run({ paused }) {
    const p = ctx().paths.paused();
    if (paused) writeFileSync(p, "");
    else rmSync(p, { force: true });
    bus.emit("tasks", { paused });
    return { paused };
  },
});

/** Owner only: a Worker's `scope.dofs` limits its reads, and this is not `dof.search`. */
define("dof.file", {
  roles: [...owner],
  input: z.object({ dof: z.string(), path: z.string() }),
  run({ dof, path }) {
    const r = readDofFile([dof, ...path.split("/")]);
    if ("error" in r) throw new RpcError("not_found", r.error);
    return r;
  },
});

let server: Console | undefined;

export const consoleModule: Module & { port(): number } = {
  name: "console",
  async start(c) {
    current = c;
    server = await startServer(c, Number(process.env.HORTUS_CONSOLE_PORT ?? 7700));
    localConsole.port = server.port;
    c.log("console").info("listening", { port: server.port });
    if (c.config.console?.listen) await startRemote(c);
  },
  async stop() {
    await stopRemote();
    await server?.close();
    server = undefined;
    current = undefined;
  },
  port: () => server?.port ?? 0,
};

/** The console's base URL for links sent elsewhere (owner.notify): the remote listener's when it runs. */
export const consoleUrl = (): string => remoteUrl() ?? `http://127.0.0.1:${server?.port ?? 7700}`;
