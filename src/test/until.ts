/** Test helpers. */
import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Log } from "../types.ts";

/** Polls `pred` every 20 ms; throws after `ms`. */
export async function until<T>(pred: () => T | Promise<T>, ms = 3000, what = "condition"): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await pred();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

/** A Log that keeps lines instead of printing them. */
/** SIGTERM and the exit, bounded: a daemon that ignores it fails its test, it does not hold the run. */
export async function stopped(d: ChildProcess, ms = 30_000): Promise<void> {
  if (d.exitCode !== null || d.signalCode !== null) return;
  const exit = new Promise((r) => d.once("exit", r));
  d.kill("SIGTERM");
  let late = false;
  const timer = setTimeout(() => {
    late = true;
    d.kill("SIGKILL");
  }, ms);
  await exit;
  clearTimeout(timer);
  if (late) throw new Error(`hortusd ignored SIGTERM for ${ms / 1000} s`);
}

export function memLog(): Log & { infos: string[]; errors: string[] } {
  const infos: string[] = [];
  const errors: string[] = [];
  return { infos, errors, info: (m) => infos.push(m), error: (m, e) => errors.push(`${m}: ${e}`) };
}

const temps: string[] = [];
process.on("exit", () => {
  if (!process.env.KEEP) for (const d of temps) rmSync(d, { recursive: true, force: true, maxRetries: 2 });
});
// The runner SIGTERMs a test file that times out and ^C sends SIGINT; neither runs `exit` handlers by default.
// ponytail: SIGKILL still leaks; the `hortus-*` prefix makes leftovers easy to sweep.
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const)
  process.once(sig, () => process.exit(128 + constants.signals[sig]));

const PORTS = join(tmpdir(), "hortus-ports");
const held: string[] = [];
process.on("exit", () => {
  try {
    for (const f of held) rmSync(f, { force: true });
    rmdirSync(PORTS);
  } catch {} // another test file still holds ports
});

/**
 * A port is probed free and then bound later by a daemon, so test files running at once picked the same one (about one
 * suite run in three once 30 files did: `EADDRINUSE`, a daemon without its proxy). The file claims it across processes.
 * ponytail: a SIGKILLed test file's claims stay until /tmp is cleared; 12,000 ports to choose from.
 */
function reserve(port: number): boolean {
  const f = join(PORTS, String(port));
  try {
    mkdirSync(PORTS, { recursive: true });
    writeFileSync(f, "", { flag: "wx" });
  } catch {
    return false; // claimed, or the directory was just removed: the caller draws again
  }
  held.push(f);
  return true;
}

/** `mkdtemp` under the OS temp dir, removed when the process exits (unless `KEEP` is set): the Landlock profile
 * builder enumerates `/tmp`, so leftovers slow every later sandbox spawn. */
export function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
}

/** A free TCP port on 127.0.0.1 for a daemon the test starts, picked below the kernel's ephemeral range (32768+): a
 * port bound and released (the old `listen(0)` probe) was handed out again to another test file's `listen(0)` before
 * the daemon took it, and the test then talked to that file's console ("no method task.open"). */
export async function freePort(): Promise<number> {
  for (;;) {
    const port = 20_000 + Math.floor(Math.random() * 12_000);
    if (!reserve(port)) continue;
    const ok = await new Promise<boolean>((resolve) => {
      const s = createServer()
        .once("error", () => resolve(false))
        .listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
    });
    if (ok) return port;
  }
}
