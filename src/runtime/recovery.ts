/**
 * Recovery at start (07-step3-runtime.md › Recovery): tasks left `running` by a crash, stale session links and cgroups.
 * Stale `hortus:` nftables rules and addresses are flushed by the runtime module (net.flushStale); pending approvals
 * stay; the gateway's reconcile runs at its own start.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { scan } from "../agent/loop.ts";
import type { Ctx } from "../ctx.ts";
import * as paths from "../paths.ts";
import { links } from "../proxy/index.ts";
import * as cgroup from "./cgroup.ts";
import * as tasks from "./tasks.ts";

export async function recover(c: Ctx): Promise<void> {
  const log = c.log("recovery");
  const rows = c.db.prepare("SELECT id, kind FROM tasks WHERE status = 'running'").all() as {
    id: string;
    kind: string;
  }[];
  for (const { id, kind } of rows) {
    if (kind === "chat") tasks.setStatus(id, "waiting");
    // a firing runs at most once: a run that never reached the model is over
    else if (kind === "run" && scan(join(paths.out(id), "sessions")).tokens === 0) await tasks.close(id, "failed");
    // resume in the same directory; the agent closes dangling tool calls (F5)
    else tasks.setStatus(id, "queued");
    log.info("recovered", { task: id, kind });
  }
  // a VM's tap link too: its tap is gone (net.flushStale), the row would map the address to a dead task
  const stale = c.db.prepare("SELECT address FROM links WHERE kind IN ('session', 'vm')").all() as {
    address: string;
  }[];
  for (const { address } of stale) links.release(address);
  let dirs: string[] = [];
  try {
    // the cgroup's own control files sit beside the task cgroups
    dirs = readdirSync(join(cgroup.base(), "tasks"), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {}
  for (const id of dirs) await cgroup.kill(id).catch((e) => log.error("stale cgroup", e, { task: id }));
}
