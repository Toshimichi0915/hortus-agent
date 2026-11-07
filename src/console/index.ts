/** The console module: the web UI listener and the RPCs it owns. */
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { Config, oneLine, save } from "../config.ts";
import type { Ctx, Module } from "../ctx.ts";
import { taintOf } from "../db.ts";
import { readDofFile } from "../mirror/file.ts";
import { define } from "../rpc.ts";
import { localConsole } from "../runtime/net.ts";
import { RpcError } from "../types.ts";
import { type ApprovalRow, approvalOut, excerpt } from "../vault/gate.ts";
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

define("settings.get", {
  roles: [...owner],
  input: z.unknown(),
  run: () => ({ config: ctx().config }),
});

/** Validates against the Config schema (the error names the zod path), writes hortusd.json, then `reload()`. */
define("settings.set", {
  roles: [...owner],
  input: z.object({ config: z.unknown() }),
  async run({ config }) {
    const c = ctx();
    const r = Config.safeParse(config);
    if (!r.success) throw new RpcError("invalid", oneLine(r.error), r.error.issues);
    save(r.data, c.paths.config());
    await c.reload();
    bus.emit("settings");
    // kept (Config is loose, for a newer version's keys), but a typo (`polcy`) would otherwise read as saved and in force
    const unknown = Object.keys(r.data).filter((k) => !(k in Config.shape));
    return unknown.length
      ? { ok: true, message: `saved; not settings hortusd knows: ${unknown.join(", ")}` }
      : { ok: true };
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
