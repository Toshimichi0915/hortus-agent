/** Test helpers. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
export function memLog(): Log & { infos: string[]; errors: string[] } {
  const infos: string[] = [];
  const errors: string[] = [];
  return { infos, errors, info: (m) => infos.push(m), error: (m, e) => errors.push(`${m}: ${e}`) };
}

const temps: string[] = [];
process.on("exit", () => {
  if (!process.env.KEEP) for (const d of temps) rmSync(d, { recursive: true, force: true });
});

/** `mkdtemp` under the OS temp dir, removed when the process exits (unless `KEEP` is set): the Landlock profile
 * builder enumerates `/tmp`, so leftovers slow every later sandbox spawn. */
export function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
}
