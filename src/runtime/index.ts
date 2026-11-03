/** Host runtime: Landlock profiles, cgroups, the network layer, sandboxed spawn. */
import type { Module } from "../ctx.ts";
import { abi } from "./landlock.ts";
import * as net from "./net.ts";

export * as cgroup from "./cgroup.ts";
export { agentCmd, type Child, type Exit, type SpawnOpts, sandboxEnv, spawnSandboxed } from "./host.ts";
export { abi, denySet, type Kind, type ProfileTask, profile, shim } from "./landlock.ts";
export * as sessionNet from "./session-net.ts";
export { net };

/** Logs the Landlock ABI once; outside HORTUS_NO_NET flushes stale rules, taps and addresses and sets up hortus0. */
export const runtimeModule: Module = {
  name: "runtime",
  async start(ctx) {
    const log = ctx.log("runtime");
    try {
      log.info("landlock", { abi: await abi() });
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
