/**
 * hortus-agent's entry (05-agent.md). The bin imports @hortus/core first with HOME = ctl/home, so by the time this
 * module loads, core has read the task's ~/.hortus and HOME is the owner's again.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { TaskJson } from "../types.ts";
import { type KindPlugin, runTask } from "./loop.ts";
import { plannerPlugin } from "./planner-plugin.ts";
import { taskPlugin } from "./plugin.ts";
import { readTask } from "./task.ts";

/** The one place a kind picks its plugin. */
export function pluginFor(task: TaskJson, dir: string): KindPlugin {
  switch (task.kind) {
    case "planner":
      return () => plannerPlugin(task);
    default:
      return (onDone) => taskPlugin(task, dir, onDone);
  }
}

/** `--task <dir>`; returns the exit code. */
export async function main(argv: string[]): Promise<number> {
  const i = argv.indexOf("--task");
  const arg = i >= 0 ? argv[i + 1] : undefined;
  if (!arg) {
    console.error("usage: hortus-agent --task <task dir>");
    return 64;
  }
  const dir = resolve(arg);
  const task = readTask(dir);
  // first contact: a VM whose guest never gets this far is killed at vm.boot_timeout_s (vm.ts)
  mkdirSync(join(dir, "out"), { recursive: true });
  writeFileSync(join(dir, "out", "booted"), "");
  mkdirSync(task.paths.work, { recursive: true });
  // chat starts in its scratch dir (v6 Chat); a project task in its clone once it exists
  const clone = task.paths.clone;
  process.chdir(task.kind !== "chat" && clone && existsSync(clone) ? clone : task.paths.work);
  return runTask(dir, task, pluginFor(task, dir));
}
