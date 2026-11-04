/**
 * hortusd.json (hortus_v6.md › Config, hortus_v7.md › Config additions). Every object is loose: keys this version does
 * not know survive a load/save round trip. A new key is one line here with a default.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import * as paths from "./paths.ts";

// ponytail: copy of @hortus/core's EFFORTS, so hortusd never imports core (core reads homedir() at import, v7 › Process)
const Effort = z.enum(["off", "low", "medium", "high", "xhigh", "max"]);
const Mode = z.enum(["human", "auto"]);
const Strings = z.array(z.string());

export const DofConfig = z.looseObject({
  type: z.string(),
  owner: z.string().optional(),
  /** "owner" (default), "members", "anyone", or user ids */
  trust: z.union([z.enum(["owner", "members", "anyone"]), Strings]).optional(),
  host: z.string().optional(),
  api: z.string().optional(),
  repos: Strings.optional(),
});

export const ProjectConfig = z.looseObject({
  path: z.string(),
  main: z.string().default("main"),
  runtime: z.enum(["host", "vm"]).default("host"),
  exclude: Strings.optional(),
  origins: Strings.optional(),
});

/** A project name: also a directory, a URL segment and a ref part (projects/origin.ts) */
export const PROJECT_NAME = /^(?!.*\.\.)[A-Za-z0-9][\w.-]{0,63}$/;
export const PROJECT_NAME_HINT = "a project name: letters, digits, . _ - only (no ..), starting with a letter or digit";

export const Config = z.looseObject({
  owner: z
    .looseObject({
      // checked here: Intl throws on an unknown zone, and the Planner's day and the Schedules page format with it
      tz: z
        .string()
        .refine(
          (tz) => {
            try {
              return !!new Intl.DateTimeFormat("en", { timeZone: tz });
            } catch {
              return false;
            }
          },
          { message: "not an IANA time zone (e.g. Asia/Tokyo)" },
        )
        .default(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
      notify: z.string().optional(),
    })
    .prefault({}),
  dofs: z.record(z.string(), DofConfig).default({}),
  planner: z
    .looseObject({
      provider: z.string().optional(),
      model: z.string().optional(),
      effort: Effort.default("low"),
      batch_max: z.number().int().positive().default(50),
      daily_tokens: z.number().int().nonnegative().default(5e6),
      runtime: z.enum(["host", "vm"]).default("host"),
    })
    .prefault({}),
  worker: z
    .looseObject({
      provider: z.string().optional(),
      model: z.string().optional(),
      effort: Effort.optional(),
      budget: z
        .looseObject({ tokens: z.number().nonnegative().default(2e6), hours: z.number().nonnegative().default(4) })
        .prefault({}),
      /** default scope.credentials; empty = every configured credential */
      credentials: Strings.default([]),
      context_window: z.number().int().positive().default(131072),
      plugins: Strings.default([]),
    })
    .prefault({}),
  origins: z.union([z.literal("*"), Strings]).default("*"),
  vm: z
    .looseObject({
      cpus: z.number().int().positive().default(2),
      mem_mb: z.number().int().positive().default(4096),
      max_concurrent: z.number().int().positive().default(4),
      /** image missing: run VM-destined tasks as unattended host sessions (true) or keep them queued (v7) */
      fallback_host: z.boolean().default(true),
    })
    .prefault({}),
  chat: z.looseObject({ allow: Strings.default([]) }).prefault({}),
  /** the proxy's listener ports on every address; nftables DNATs 443/80/53 to them (v7 › Security › Network) */
  proxy: z
    .looseObject({
      https: z.number().int().min(0).max(65535).default(8443),
      http: z.number().int().min(0).max(65535).default(8080),
      dns: z.number().int().min(0).max(65535).default(8053),
    })
    .prefault({}),
  console: z
    .looseObject({
      listen: z.string(),
      host: z.string().optional(),
      tls: z.looseObject({ cert: z.string(), key: z.string() }).optional(),
    })
    .optional(),
  projects: z.record(z.string().regex(PROJECT_NAME, PROJECT_NAME_HINT), ProjectConfig).default({}),
  /** category (`credential:<name>`, `*`, …) → `human` | `auto`, plus the Landlock extensions `deny` and `cache` (path
   * lists, v7 › Security). Read per request: a Settings edit applies to the next one. */
  policy: z.object({ deny: Strings.optional(), cache: Strings.optional() }).catchall(Mode).default({ "*": "human" }),
  /** category or `*` → owner text the `auto` judge reads after its fixed prompt (never in place of it) */
  judge_notes: z.record(z.string(), z.string()).optional(),
  /** test-only: host → where the proxy really connects; consumers refuse it unless HORTUS_HOME is set */
  dev: z.looseObject({ upstreams: z.record(z.string(), z.string()).default({}) }).optional(),
});

export type Config = z.infer<typeof Config>;
export type DofConfig = z.infer<typeof DofConfig>;
export type ProjectConfig = z.infer<typeof ProjectConfig>;
export type Mode = z.infer<typeof Mode>;

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

const FORCED_HUMAN = new Set(["transforms", "merge", "login"]);

/** The Approval Gate mode: exact key, else `*`, else human. transforms/merge/login/origin:* are always human. */
export function policyFor(c: Config, category: string): Mode {
  if (FORCED_HUMAN.has(category) || category.startsWith("origin:")) return "human";
  const p = c.policy as Record<string, unknown>;
  const v = p[category] ?? p["*"];
  return v === "auto" ? "auto" : "human";
}
