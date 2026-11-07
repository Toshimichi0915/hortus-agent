/** Host runtime: Landlock profiles, cgroups, the network layer, sandboxed spawn. */
import type { Module } from "../ctx.ts";
import { abi, usernsBlocked } from "./landlock.ts";
import * as net from "./net.ts";

export * as cgroup from "./cgroup.ts";
export { dispatcherModule, exitHooks, isStopping, runPlanner, wake } from "./dispatcher.ts";
export { agentCmd, type Child, type Exit, type SpawnOpts, sandboxEnv, spawnSandboxed } from "./host.ts";
export { abi, denySet, type Kind, type ProfileTask, profile, shim, usernsBlocked } from "./landlock.ts";
export * as sessionNet from "./session-net.ts";
export * as tasks from "./tasks.ts";
export * as vm from "./vm.ts";
export { net };

/** Logs the Landlock ABI once, takes the proxy ports from config; outside HORTUS_NO_NET flushes stale rules, taps and addresses and sets up hortus0. */
export const runtimeModule: Module = {
  name: "runtime",
  async start(ctx) {
    const log = ctx.log("runtime");
    // ponytail: ports are read at start; a changed `proxy` needs a restart
    Object.assign(net.ports, ctx.config.proxy);
    try {
      log.info("landlock", { abi: await abi() });
      const blocked = await usernsBlocked();
      // a chat then walks around its deny set as before: the directories holding one (~, a dev checkout's parent) take
      // no new entries
      if (blocked) log.info("chat sessions without mount masks", { reason: blocked });
    } catch (e) {
      log.error("host sessions disabled", e);
    }
    if (process.env.HORTUS_NO_NET === "1") {
      log.info("HORTUS_NO_NET=1: network layer skipped");
      return;
    }
    await net.flushStale();
    await net.ensureDummy();
  },
  async stop() {},
};
