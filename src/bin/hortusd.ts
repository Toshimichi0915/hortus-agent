#!/usr/bin/env -S node --no-warnings=ExperimentalWarning
/** hortusd: config → socket (fails fast if another daemon has it, before the DB is touched) → DB → modules. */
import { mkdirSync } from "node:fs";
import { z } from "zod";
import { type Config, load } from "../config.ts";
import type { Ctx, Module } from "../ctx.ts";
import { openDb } from "../db.ts";
import { logger } from "../log.ts";
import * as paths from "../paths.ts";
import { define, serveSocket } from "../rpc.ts";

/** Later steps append their module here (gateway, proxy, console, dispatcher, scheduler). */
const modules: Module[] = [];

const log = logger("hortusd");

async function main(): Promise<void> {
  const config = load();
  mkdirSync(paths.home(), { recursive: true, mode: 0o700 });

  define("ping", {
    roles: ["owner", "core", "worker", "planner", "login"],
    input: z.unknown(),
    run: async () => ({ pong: true, pid: process.pid }),
  });

  let server: Awaited<ReturnType<typeof serveSocket>>;
  try {
    server = await serveSocket(paths.socket());
  } catch (e) {
    log.error(`cannot bind ${JSON.stringify(paths.socket())}: another hortusd on this HORTUS_HOME?`, e);
    process.exit(1);
  }

  const ctx: Ctx = {
    config,
    db: openDb(paths.db()),
    paths,
    log: logger,
    async reload() {
      const prev: Config = ctx.config;
      ctx.config = load();
      for (const m of started) await m.reload?.(prev);
    },
  };

  const started: Module[] = [];
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info("stopping", { signal });
    server.close();
    for (const m of started.reverse()) {
      try {
        await m.stop();
      } catch (e) {
        log.error(`${m.name} stop failed`, e);
      }
    }
    ctx.db.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  for (const m of modules) {
    await m.start(ctx);
    started.push(m);
  }
  log.info("started", { home: paths.home(), modules: started.map((m) => m.name) });
}

main().catch((e) => {
  log.error("fatal", e);
  process.exit(1);
});
