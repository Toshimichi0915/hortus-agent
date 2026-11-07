/**
 * hortusd.json's rules: every object is loose, so keys this version does not know survive a load/save round trip. A
 * new key is one line here with a default. No node imports: web/ checks its forms with these too.
 */
import { z } from "zod";

// ponytail: copy of @hortus/core's EFFORTS, so hortusd never imports core (core reads homedir() at import)
export const Effort = z.enum(["off", "low", "medium", "high", "xhigh", "max"]);
export const Mode = z.enum(["human", "auto"]);
const Strings = z.array(z.string());
/** a `~/x` here would name nothing, silently: for `policy.deny`, nothing denied */
const Paths = z.array(z.string().startsWith("/", "an absolute path"));

export const DofConfig = z.looseObject({
  type: z.string(),
  owner: z.string().optional(),
  /** "owner" (default), "members", "anyone", or user ids */
  trust: z.union([z.enum(["owner", "members", "anyone"]), Strings]).optional(),
  host: z.string().optional(),
  api: z.string().optional(),
  repos: Strings.optional(),
  /** `files`: the absolute directory copied in */
  path: z.string().optional(),
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

/**
 * A DOF name: `dof/<name>` and `dof/<name>.git` on disk, a Landlock carve-out and a `scope.dofs` entry, so no `..`, no
 * `.git` suffix (another DOF's bare repo), and not `logs`, `transforms` or `hortus` (hortusd's own, with their own trust
 * rules).
 */
export const DOF_NAME = /^(?!.*\.\.)(?!.*\.git$)(?!(logs|transforms|hortus)$)[A-Za-z0-9][\w.-]{0,63}$/;
export const DOF_NAME_HINT =
  "a DOF name: letters, digits, . _ - only (no .., no .git suffix, not logs, transforms or hortus)";

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
  dofs: z.record(z.string().regex(DOF_NAME, DOF_NAME_HINT), DofConfig).default({}),
  planner: z
    .looseObject({
      provider: z.string().optional(),
      model: z.string().optional(),
      effort: Effort.default("low"),
      batch_max: z.number().int().positive().default(50),
      daily_tokens: z.number().int().nonnegative().default(5e6),
      /** unset: a VM once the image is there, the host until then */
      runtime: z.enum(["host", "vm"]).optional(),
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
      /** default scope.credentials; empty = every configured credential but those only hortusd uses (tasks.ts) */
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
      /** the guest's hortus-agent must write out/booted this long after QEMU starts, else the VM is killed */
      boot_timeout_s: z.number().positive().default(120),
      /** image missing: run VM-destined tasks as unattended host sessions (true) or keep them queued */
      fallback_host: z.boolean().default(true),
    })
    .prefault({}),
  chat: z.looseObject({ allow: Strings.default([]) }).prefault({}),
  /** the proxy's listener ports on every address; nftables DNATs 443/80/53 to them */
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
  /** category (`credential:<name>`, `*`, …) → `human` | `auto`, plus the Landlock extensions `deny`, `cache` and `read`
   * (absolute paths). Read per request: a Settings edit applies to the next one. */
  policy: z
    .object({ deny: Paths.optional(), cache: Paths.optional(), read: Paths.optional() })
    .catchall(Mode)
    .default({ "*": "human" }),
  /** category or `*` → owner text the `auto` judge reads after its fixed prompt (never in place of it) */
  judge_notes: z.record(z.string(), z.string()).optional(),
  /** test-only: host → where the proxy really connects; consumers refuse it unless HORTUS_HOME is set */
  dev: z.looseObject({ upstreams: z.record(z.string(), z.string()).default({}) }).optional(),
});

export type Config = z.infer<typeof Config>;
export type DofConfig = z.infer<typeof DofConfig>;
export type ProjectConfig = z.infer<typeof ProjectConfig>;
export type Mode = z.infer<typeof Mode>;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** RFC 7386 JSON Merge Patch: objects merge key by key, `null` deletes, anything else (arrays too) replaces. */
export function mergePatch(target: unknown, patch: unknown): unknown {
  if (!isObject(patch)) return patch;
  const out: Record<string, unknown> = isObject(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch))
    if (v === null) delete out[k];
    else out[k] = mergePatch(out[k], v);
  return out;
}

/** The dotted paths where `a` and `b` differ, down to the leaves (an array is one leaf). */
export function changedPaths(a: unknown, b: unknown, at = ""): string[] {
  if (!isObject(a) || !isObject(b)) return JSON.stringify(a) === JSON.stringify(b) ? [] : [at];
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((k) =>
    changedPaths(a[k], b[k], at ? `${at}.${k}` : k),
  );
}
