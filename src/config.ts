/** hortusd.json on disk: its rules are config-schema.ts. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { z } from "zod";
import { Config, type Mode } from "./config-schema.ts";
import * as paths from "./paths.ts";

export { Config, DofConfig, type Mode, PROJECT_NAME, PROJECT_NAME_HINT, ProjectConfig } from "./config-schema.ts";

/** Missing file → defaults. Unreadable, invalid JSON or schema → throws naming the path (never read as empty). */
export function load(path = paths.config()): Config {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return Config.parse({});
    throw e;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`${path}: ${(e as Error).message}`);
  }
  const r = Config.safeParse(raw);
  if (!r.success) throw new Error(`${path}: ${oneLine(r.error)}`);
  return r.data;
}

/** A schema error as one line naming each key: `vm.cpus: expected number, received string; owner.tz: …`. */
export function oneLine(e: z.ZodError): string {
  return e.issues
    .map((i) => `${i.path.join(".") || "(top level)"}: ${i.message.replace(/^Invalid input: /, "")}`)
    .join("; ");
}

/** Atomic (temp + rename), mode 0600. */
export function save(c: Config, path = paths.config()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(c, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/** The owner's calendar day: the `planner_usage` key, the Planner's and the judge's alike. */
export const today = (c: Config): string => new Intl.DateTimeFormat("en-CA", { timeZone: c.owner.tz }).format();

const FORCED_HUMAN = new Set(["transforms", "merge", "login", "settings"]);

/** The Approval Gate mode: exact key, else `*`, else human. transforms/merge/login/settings/origin:* are always human. */
export function policyFor(c: Config, category: string): Mode {
  if (FORCED_HUMAN.has(category) || category.startsWith("origin:")) return "human";
  const p = c.policy as Record<string, unknown>;
  const v = p[category] ?? p["*"];
  return v === "auto" ? "auto" : "human";
}
