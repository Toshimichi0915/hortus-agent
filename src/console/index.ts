/** The console module (06-console.md): the web UI listener and the RPCs it owns. */
import { rmSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { Config, oneLine, save } from "../config.ts";
import type { Ctx, Module } from "../ctx.ts";
import { define } from "../rpc.ts";
import { localConsole } from "../runtime/net.ts";
import { RpcError } from "../types.ts";
import { bus } from "./events.ts";
import { parse } from "./html.ts";
import { PENDING_FOR } from "./pages/approvals.ts";
import { lastReplies } from "./pages/chat.ts";
import { CLOSED_SQL, OPEN_SQL, type TaskRow } from "./pages/tasks.ts";
import { remoteUrl, startRemote, stopRemote } from "./remote.ts";
import { type Console, startServer } from "./server.ts";

export { bus } from "./events.ts";

let current: Ctx | undefined;
const ctx = (): Ctx => {
  if (!current) throw new RpcError("failed", "console not started");
  return current;
};

const owner = ["owner"] as const;

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
    return [
      ...(db.prepare(OPEN_SQL).all(limit, skip) as unknown as TaskRow[]),
      ...(db.prepare(CLOSED_SQL).all(limit, skip) as unknown as TaskRow[]),
    ].map(taskOut);
  },
});

/** A `replies` body (the Worker's stdout line) as JSON when it serializes back, else its text: a line nested a million
 * deep parses but throws in the response's JSON.stringify, which made the task's card unreadable. */
function line(body: string): unknown {
  const v = parse(body);
  try {
    JSON.stringify(v);
    return v ?? body;
  } catch {
    return body;
  }
}

define("task.get", {
  roles: [...owner],
  input: z.object({ id: z.string() }),
  run({ id }) {
    const db = ctx().db;
    const t = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
    if (!t) throw new RpcError("not_found", `no task ${id}`);
    const rows = <T>(sql: string) => db.prepare(sql).all(id) as unknown as T[];
    return {
      task: taskOut(t),
      summary: t.summary,
      replies: lastReplies(current as Ctx, id).map((r) => ({ ...r, body: line(r.body) })),
      approvals: rows<{ summary: string }>(`${PENDING_FOR} ORDER BY id`).map((a) => ({
        ...a,
        summary: parse(a.summary) ?? null,
      })),
      inbox: rows<{ body: string }>("SELECT * FROM inbox WHERE task_id = ? ORDER BY seq DESC LIMIT 50")
        .reverse()
        .map((m) => ({ ...m, body: parse(m.body) ?? m.body })),
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
    // kept (Config is loose, for a newer version's keys), but a typo (`polcy`) would otherwise read as saved and in force
    const unknown = Object.keys(r.data).filter((k) => !(k in Config.shape));
    return unknown.length ? { ok: true, message: `saved; not settings hortusd knows: ${unknown.join(", ")}` } : { ok: true };
  },
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
