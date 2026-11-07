/**
 * Where sign-in goes on to: the deep link the owner opened (a DM's `/approvals/7`) rides `/login?next=` through the
 * remote gate (remote.ts) and the SignIn page. It runs in web/ too and imports nothing of node's.
 */

const BASE = "http://console";

/**
 * `p` when it is a path of this origin: one leading `/`, printable ASCII without `\` or `//` (a browser reads `/\x` and
 * `//x` as another host, and drops a tab or newline from `/\t/x`), not the sign-in pages themselves; else `/`.
 */
export function safeNext(p: unknown): string {
  if (typeof p !== "string" || p.length > 2048 || !p.startsWith("/") || p.includes("//") || /[^!-[\]-~]/.test(p))
    return "/";
  const u = new URL(p, BASE);
  if (u.origin !== BASE || u.pathname === "/login" || u.pathname === "/enroll") return "/";
  return p;
}

/** `/login`, with `?next=` when `path` is somewhere `safeNext` lets sign-in go on to. */
export function loginHref(path: unknown): string {
  const next = safeNext(path);
  return next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}`;
}
