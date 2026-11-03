#!/usr/bin/env -S node --no-warnings=ExperimentalWarning
/** hortusd: config → socket (fails fast if another daemon has it, before the DB is touched) → DB → modules. */
import { mkdirSync } from "node:fs";
import { z } from "zod";
import { type Config, load } from "../config.ts";
import type { Ctx, Module } from "../ctx.ts";
import { openDb } from "../db.ts";
import { logger } from "../log.ts";
import { RpcError } from "../types.ts";
import * as paths from "../paths.ts";
import { browserModule } from "../browser/login-view.ts";
import { consoleModule, consoleUrl } from "../console/index.ts";
import { gatewayModule, ownerDm, wireGateway } from "../gateway/gateway.ts";
import { webhooksModule } from "../gateway/webhooks.ts";
import { commit, mirrorModule } from "../mirror/index.ts";
import { coreFetch, coreSocket, links, listen, listenOpts, proxyModule, unlisten } from "../proxy/index.ts";
import { define, serveSocket } from "../rpc.ts";
import { plannerModule, wake as wakePlanner } from "../planner/planner.ts";
import "../planner/tools.ts";
import { cgroup, dispatcherModule, exitHooks, runtimeModule, sessionNet, tasks, vm } from "../runtime/index.ts";
import { schedulesModule } from "../schedules/schedules.ts";
import { gateDeps, transformsDofModule, vaultModule } from "../vault/index.ts";

/** Start order: the mirror (commit, dof.search) before the gateway that writes it; the vault (CA, shipped transforms),
 * then the transforms DOF (ship, then load the enabled rows from its worktree: needs the mirror's commit) before the
 * proxy; the runtime (hortus0, the table) before the proxy binds 10.77.0.1; the dispatcher (recovery, then
 * sessions) once the proxy and links are up; the schedules tick and the Planner after it (its batches are dispatcher
 * sessions); the browser (login views) and the console last. */
const modules: Module[] = [
  mirrorModule,
  vaultModule,
  transformsDofModule,
  runtimeModule,
  proxyModule,
  gatewayModule,
  webhooksModule,
  dispatcherModule,
  schedulesModule,
  plannerModule,
  browserModule,
  consoleModule,
];

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

  // The connector's requests go through the pipeline as role core: placeholders in, tokens inserted by transforms.
  wireGateway({
    commit,
    hasRef: (ref) => ctx.db.prepare("SELECT 1 FROM task_refs WHERE ref = ?").get(ref) !== undefined,
    fetch: () => coreFetch,
    ws: coreSocket,
    // the gateway calls it only for `mirror.wake && !bot` (loop guard)
    wake: wakePlanner,
  });
  // a non-chat Worker's result or budget_exceeded is Planner input
  exitHooks.onResult = (t) => {
    if (t.kind !== "chat") wakePlanner();
  };
  // Session addresses (step 3's dispatcher calls sessionNet.open/close): the proxy's listeners and links registry.
  sessionNet.init({
    db: ctx.db,
    proxy: { listen: async (a) => void (await listen(a, listenOpts(ctx))), unlisten },
    links,
  });
  // VM tasks (3g): the VM's link address is registered as a worker/planner client of the proxy
  vm.init({ links });
  devLink();
  // approval decisions (and later merge/rebase notes) reach the task's inbox, which re-queues a waiting task
  gateDeps.inboxWrite = (id, msg) => void tasks.inboxWrite(id, msg);
  // owner.notify: a one-line DM per new pending approval; the bot's DM is mirrored and never wakes the Planner
  gateDeps.notify = (text) => {
    const dof = ctx.config.owner.notify;
    if (!dof) return;
    ownerDm(dof, `${text} ${consoleUrl()}/approvals`).catch((e) => log.error("owner.notify failed", e, { dof }));
  };
  // planner.runtime = "vm" (and 3g's Worker VMs): the proxy finds a VM by its tap address
  vm.init({ links });

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
  gateDeps.consoleUrl = `http://127.0.0.1:${consoleModule.port()}`;
  log.info("started", { home: paths.home(), modules: started.map((m) => m.name) });
}

/**
 * Dev-only (refused unless HORTUS_HOME is set): register `address` as a client of `role` for `task`. Under
 * HORTUS_NO_NET=1 only the `links` row (a loopback alias reaching 127.0.0.1); otherwise a full session address
 * (address, listeners, links, cgroup `tasks/<task>` with its rules), returning the cgroup a test moves its curl into.
 */
function devLink(): void {
  define("dev.link", {
    roles: ["owner"],
    input: z.object({
      address: z.ipv4(),
      role: z.enum(["worker", "planner", "login"]),
      task: z.string().regex(/^[\w-]+$/),
    }),
    run: async ({ address, role, task }) => {
      if (process.env.HORTUS_HOME === undefined) throw new RpcError("forbidden", "dev.link needs HORTUS_HOME");
      if (process.env.HORTUS_NO_NET === "1") {
        links.register(address, role, task, "dev");
        return { address, cgroup: null };
      }
      const cg = await cgroup.create(task);
      await sessionNet.open(task, role, cg, [], address);
      return { address, cgroup: cg };
    },
  });
}

main().catch((e) => {
  log.error("fatal", e);
  process.exit(1);
});
