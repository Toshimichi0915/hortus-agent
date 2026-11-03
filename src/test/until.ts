/** Test helpers. */
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
