#!/usr/bin/env -S node --no-warnings=ExperimentalWarning
/**
 * hortus-agent --task <dir>: the Worker (05-agent.md). @hortus/core reads homedir() once at import, so HOME points at
 * <dir>/ctl/home for that import only (v7 Process); tools and their children see the session's HOME.
 */
import { join, resolve } from "node:path";

const i = process.argv.indexOf("--task");
const dir = i >= 0 ? process.argv[i + 1] : undefined;
if (!dir) {
  console.error("usage: hortus-agent --task <task dir>");
  process.exit(64);
}
const home = process.env.HOME;
process.env.HOME = join(resolve(dir), "ctl", "home");
try {
  await import("@hortus/core");
} finally {
  if (home === undefined) delete process.env.HOME;
  else process.env.HOME = home;
}
const { main } = await import("../agent/index.ts");
try {
  process.exit(await main(process.argv.slice(2)));
} catch (e) {
  process.stdout.write(`${JSON.stringify({ type: "error", message: e instanceof Error ? e.message : String(e) })}\n`);
  process.exit(1);
}
