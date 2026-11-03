/** The console module (06-console.md): the web UI listener and the RPCs it owns. */
import { rmSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { Config, save } from "../config.ts";
import type { Ctx, Module } from "../ctx.ts";
import { define } from "../rpc.ts";
import { RpcError } from "../types.ts";
import { bus } from "./events.ts";
import { parse } from "./html.ts";
import { lastReplies } from "./pages/chat.ts";
import { CLOSED_SQL, OPEN_SQL, type TaskRow } from "./pages/tasks.ts";
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

define("task.list", {
  roles: [...owner],
  input: z.object({}).loose().default({}),
  run() {
    const db = ctx().db;
    return [
      ...(db.prepare(OPEN_SQL).all() as unknown as TaskRow[]),
      ...(db.prepare(CLOSED_SQL).all() as unknown as TaskRow[]),
    ].map(taskOut);
  },
});

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
      replies: lastReplies(current as Ctx, id).map((r) => ({ ...r, body: parse(r.body) ?? r.body })),
      approvals: rows<{ summary: string }>(
        "SELECT * FROM approvals WHERE task_id = ? AND status = 'pending' ORDER BY id",
      ).map((a) => ({ ...a, summary: parse(a.summary) ?? null })),
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
    if (!r.success) throw new RpcError("invalid", z.prettifyError(r.error), r.error.issues);
    save(r.data, c.paths.config());
    await c.reload();
    return { ok: true };
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
    c.log("console").info("listening", { port: server.port });
  },
  async stop() {
    await server?.close();
    server = undefined;
    current = undefined;
  },
  port: () => server?.port ?? 0,
};
