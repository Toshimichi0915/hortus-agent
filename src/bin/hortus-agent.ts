#!/usr/bin/env -S node --no-warnings=ExperimentalWarning
/**
 * hortus-agent --task <dir>: the Worker. @hortus/core reads its config, secrets and plugins from HORTUS_HOME, the task's
 * <dir>/ctl/home/.hortus; HOME stays the session's, for tools and their children too.
 */
import { join, resolve } from "node:path";

const i = process.argv.indexOf("--task");
const dir = i >= 0 ? process.argv[i + 1] : undefined;
if (!dir) {
  console.error("usage: hortus-agent --task <task dir>");
  process.exit(64);
}
process.env.HORTUS_HOME = join(resolve(dir), "ctl", "home", ".hortus");
const { main } = await import("../agent/index.ts");
try {
  process.exit(await main(process.argv.slice(2)));
} catch (e) {
  process.stdout.write(`${JSON.stringify({ type: "error", message: e instanceof Error ? e.message : String(e) })}\n`);
  process.exit(1);
}
