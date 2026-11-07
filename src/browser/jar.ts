/**
 * The placeholder cookie jar: which `captured` rows a task's browser may hold. hortusd only
 * (task.json at start, inbox `cookies` after a login or an origin grant); the browser never sees a real value.
 */
import { type DatabaseSync, family } from "../db.ts";
import type { Cookie } from "../types.ts";

// ponytail: no public suffix list; the last two labels, three when the second-to-last is a common second-level label
// (example.co.uk). Wrong for shared-tenant suffixes (github.io tenants share an origin); the PSL is the upgrade. The
// cookie transform (transforms/cookie/transform.js) has the same rule; a test keeps them equal.
const SLD = ["co", "com", "net", "org", "gov", "ac", "edu"];
export function registrable(host: string): string {
  const h = host.toLowerCase();
  if (/^[0-9.]+$/.test(h) || h.includes(":")) return h;
  const l = h.split(".");
  const n = l.length > 2 && SLD.includes(l[l.length - 2] as string) ? 3 : 2;
  return l.slice(-n).join(".");
}

interface Row {
  id: number;
  name: string;
  origin: string;
  kind: string | null;
  created: string;
  meta: string | null;
}

interface Meta {
  cookieName?: string;
  domain?: string;
  path?: string;
  expires?: string;
  maxAge?: number;
  secure?: boolean;
  httpOnly?: boolean;
  host?: string;
  task?: string | null;
  via?: string;
}

/** Origins the task holds an approved `origin:*` grant on (a login's Done, or the owner's approval of a grant entry). */
export function grantedOrigins(db: DatabaseSync, task: string): string[] {
  const rows = db
    .prepare(
      "SELECT DISTINCT substr(category, 8) AS origin FROM approvals WHERE kind = 'grant' AND task_id IN (SELECT value FROM json_each(?)) AND status = 'approved' AND category LIKE 'origin:%'",
    )
    .all(JSON.stringify(family(db, task))) as { origin: string }[];
  return rows.map((r) => r.origin);
}

/** Cookies captured through a login view for `origin` (what `browser.login` can offer to reuse). */
export function loginCookies(db: DatabaseSync, origin: string): number {
  return (
    db
      .prepare(
        "SELECT count(*) AS n FROM captured WHERE origin = ? AND kind = 'cookie' AND json_extract(meta, '$.via') = 'login'",
      )
      .get(origin) as { n: number }
  ).n;
}

/**
 * The task's jar: its own captured cookies, plus those captured by login views for the origins it holds a grant on;
 * one per (name, domain, path), the latest capture winning. `origin` narrows it to one site.
 */
export function jar(db: DatabaseSync, task: string, origin?: string): Cookie[] {
  const granted = new Set(grantedOrigins(db, task));
  const own = new Set<string | null | undefined>(family(db, task));
  const rows = db
    .prepare("SELECT id, name, origin, kind, created, meta FROM captured WHERE kind = 'cookie' ORDER BY id")
    .all() as unknown as Row[];
  const out = new Map<string, Cookie>();
  for (const r of rows) {
    const m = (r.meta ? JSON.parse(r.meta) : {}) as Meta;
    if (origin && r.origin !== origin) continue;
    if (!own.has(m.task) && !(granted.has(r.origin) && m.via === "login")) continue;
    const c: Cookie = {
      name: m.cookieName ?? r.name,
      value: `hortus-secret-${r.name}`,
      domain: m.domain ?? m.host ?? r.origin,
      path: m.path ?? "/",
    };
    const exp =
      m.maxAge !== undefined
        ? Date.parse(r.created) / 1000 + m.maxAge
        : m.expires
          ? Date.parse(m.expires) / 1000
          : undefined;
    if (exp !== undefined && Number.isFinite(exp)) {
      if (exp * 1000 < Date.now()) continue;
      c.expires = Math.floor(exp);
    }
    if (m.secure) c.secure = true;
    if (m.httpOnly) c.httpOnly = true;
    out.set(`${c.name}\0${c.domain}\0${c.path}`, c);
  }
  return [...out.values()];
}

/**
 * The Credentials page's list: origin, cookie and token count, last use, and whether any of it may hold a login: all
 * but what a Worker got browsing anonymously (an ad network's id, a site's session for a visitor).
 */
export function origins(
  db: DatabaseSync,
): { origin: string; cookies: number; tokens: number; last_use: string | null; login: boolean }[] {
  const rows = db
    .prepare(
      `SELECT origin, sum(kind = 'cookie') AS cookies, sum(kind IS NOT 'cookie') AS tokens, max(last_use) AS last_use,
        max(json_extract(meta, '$.via') IS NOT 'worker' OR json_extract(meta, '$.anonymous') IS NOT 1) AS login
      FROM captured GROUP BY origin ORDER BY origin`,
    )
    .all() as { origin: string; cookies: number; tokens: number; last_use: string | null; login: number }[];
  return rows.map((r) => ({ ...r, login: r.login === 1 }));
}
