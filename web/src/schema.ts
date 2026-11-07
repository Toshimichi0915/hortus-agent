/**
 * What hortusd.json takes, for the forms: src/config-schema.ts's defaults and rules, so a mistake is named at its field
 * before Save rather than by the daemon after it.
 */
import { Config, DOF_NAME, Effort, PROJECT_NAME } from "../../src/config-schema.ts";

export { DOF_NAME, PROJECT_NAME };
export const DOF_NAME_HINT = "letters, digits, . _ - (no .., no .git ending, not logs or transforms)";
export const PROJECT_NAME_HINT = "letters, digits, . _ - only, starting with a letter or digit";
export const CREDENTIAL_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const CREDENTIAL_NAME_HINT = "lowercase letters, digits, _ and -";
export const HOSTNAME = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

export const EFFORTS = Effort.options;

export const DEFAULTS: Config = Config.parse({});

/** Categories the Approval Gate always puts to the owner, whatever `policy` says (config.ts › policyFor). */
export const ALWAYS_ASKS = [
  { what: "Merges into a project's main branch", why: "Code lands where you work." },
  { what: "New or changed transforms", why: "A transform decides where a credential goes." },
  { what: "Signing in to a website", why: "Only you type your password, in the login view." },
  { what: "Reusing a stored website login", why: "A task borrowing your session on a site." },
];

export const validTz = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

export const checkPath = (p: string): string | undefined =>
  p.startsWith("/") ? undefined : "an absolute path, starting with /";
export const checkHost = (h: string): string | undefined =>
  HOSTNAME.test(h.toLowerCase()) ? undefined : "a host name like api.example.com";
const CIDR = /^(\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?|[0-9a-f:]+(\/\d{1,3})?)$/i;
export const checkCidr = (a: string): string | undefined =>
  CIDR.test(a) ? undefined : "an IP address or range, like 192.168.1.20 or 192.168.1.0/24";

/** `addr:port`, `[v6]:port`, `:port` or `port` (remote.ts › parseListen) */
export function splitListen(listen: string): { address: string; port: number } {
  const i = listen.lastIndexOf(":");
  return { address: i < 0 ? "" : listen.slice(0, i).replace(/^\[|\]$/g, ""), port: Number(listen.slice(i + 1)) };
}

/** hortusd.json's top-level keys: settings.set keeps others, and says so. */
export const KNOWN_KEYS: readonly string[] = Object.keys(Config.shape);

/** The paths the forms show an error at (`*`: one segment); settings.set's issues go to the one they fall under. */
export const FIELDS = [
  "owner.tz",
  "owner.notify",
  "dofs.*",
  "projects.*",
  "planner.batch_max",
  "planner.daily_tokens",
  "worker.context_window",
  "worker.budget.tokens",
  "worker.budget.hours",
  "worker.plugins",
  "vm.cpus",
  "vm.mem_mb",
  "vm.max_concurrent",
  "vm.boot_timeout_s",
  "proxy.https",
  "proxy.http",
  "proxy.dns",
  "policy.read",
  "policy.cache",
  "policy.deny",
  "origins",
  "console.listen",
  "console.host",
  "console.tls",
] as const;

/** Field path → what is wrong, for every field the forms show. */
export function validateConfig(c: Config): Record<string, string> {
  const e: Record<string, string> = {};
  const int = (path: string, v: number, min: number, max = Number.MAX_SAFE_INTEGER) => {
    if (!Number.isInteger(v) || v < min || v > max)
      e[path] =
        max < Number.MAX_SAFE_INTEGER ? `a whole number from ${min} to ${max}` : `a whole number, ${min} or more`;
  };
  if (!validTz(c.owner.tz)) e["owner.tz"] = "not a time zone; pick one from the list (e.g. Asia/Tokyo)";
  if (c.owner.notify && !c.dofs[c.owner.notify]) e["owner.notify"] = `there is no source named ${c.owner.notify}`;
  for (const n of Object.keys(c.dofs)) if (!DOF_NAME.test(n)) e[`dofs.${n}`] = `the name ${n}: ${DOF_NAME_HINT}`;
  for (const n of Object.keys(c.projects))
    if (!PROJECT_NAME.test(n)) e[`projects.${n}`] = `the name ${n}: ${PROJECT_NAME_HINT}`;
  int("planner.batch_max", c.planner.batch_max, 1);
  int("planner.daily_tokens", c.planner.daily_tokens, 0);
  int("worker.context_window", c.worker.context_window, 1);
  if (!(c.worker.budget.tokens >= 0)) e["worker.budget.tokens"] = "0 or more";
  if (!(c.worker.budget.hours >= 0)) e["worker.budget.hours"] = "0 or more";
  for (const p of c.worker.plugins) if (checkPath(p)) e["worker.plugins"] = `${p}: ${checkPath(p)}`;
  int("vm.cpus", c.vm.cpus, 1);
  int("vm.mem_mb", c.vm.mem_mb, 1);
  int("vm.max_concurrent", c.vm.max_concurrent, 1);
  if (!(c.vm.boot_timeout_s > 0)) e["vm.boot_timeout_s"] = "more than 0 seconds";
  for (const k of ["https", "http", "dns"] as const) int(`proxy.${k}`, c.proxy[k], 0, 65535);
  for (const k of ["read", "cache", "deny"] as const)
    for (const p of c.policy[k] ?? []) if (checkPath(p)) e[`policy.${k}`] = `${p}: ${checkPath(p)}`;
  if (c.origins !== "*" && !c.origins.length) e.origins = "add at least one host, or allow any public website";
  if (c.console) {
    const { port } = splitListen(c.console.listen);
    if (!c.console.listen || !Number.isInteger(port) || port < 1 || port > 65535)
      e["console.listen"] = "a port from 1 to 65535";
    if (!c.console.host) e["console.host"] = "the name devices reach this machine by, like hortus.home.arpa";
    if (c.console.tls && (!c.console.tls.cert || !c.console.tls.key))
      e["console.tls"] = "both the certificate and its key, as absolute paths";
  }
  return e;
}

/** The Settings pages' working copy of hortusd.json. */
export interface Draft {
  /** what hortusd has */
  saved: Config;
  /** what the forms show, saved with the Save bar */
  draft: Config;
  set(change: (c: Config) => void): void;
  /** field path → what is wrong (the forms' checks, then hortusd's) */
  errors: Record<string, string>;
  /** a change saved at once (adding a source): to hortusd's copy, and into the draft so Save keeps it */
  commit(change: (c: Config) => void): Promise<boolean>;
}
