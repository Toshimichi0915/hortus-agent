/** The web UI's form and list helpers that are worth a test: they run in web/ and import nothing of node's. */

/** JSON's equality, whatever order the keys were added in: a draft's new key comes last, the same key from hortusd in its schema's order. */
export function sameJson(a: unknown, b: unknown): boolean {
  const sorted = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sorted);
    if (!v || typeof v !== "object") return v;
    const o = v as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(o)
        .sort()
        .map((k) => [k, sorted(o[k])]),
    );
  };
  return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
}

/**
 * settings.set's `invalid` data (zod's issues) as field → message. A path goes to the longest field it falls under
 * (`worker.plugins.1` → `worker.plugins`; `*` is any one segment), else to itself joined, which Advanced lists; the
 * first issue on a field wins. Anything but an array of issues gives nothing.
 */
export function fieldErrors(issues: unknown, fields: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(issues)) return out;
  const pats = fields.map((f) => f.split("."));
  for (const i of issues as { path?: unknown; message?: unknown }[]) {
    if (!Array.isArray(i?.path) || typeof i.message !== "string") continue;
    const path = i.path.map(String);
    let best: string[] | undefined;
    for (const p of pats)
      if (p.length <= path.length && p.every((s, k) => s === "*" || s === path[k]) && p.length > (best?.length ?? 0))
        best = path.slice(0, p.length);
    const key = (best ?? path).join(".");
    out[key] ??= i.message;
  }
  return out;
}

/**
 * Paging that holds still: page `skip` of a list the newest rows land on top of. Fetch the window, `SLACK` rows either
 * side, and past the first page show `limit` rows from the row that headed it last time (`anchor`), so rows landing
 * or leaving above do not shift the page; without the anchor in the window (it left, or over `SLACK` rows landed
 * between two reloads), from `skip`. A pending merge carries its 64 KB patch, so the window stays small.
 */
export const SLACK = 10;
export const pageWindow = (skip: number, limit: number) => ({
  skip: Math.max(0, skip - SLACK),
  limit: limit + 2 * SLACK,
});

export function pageAt<T>(
  rows: readonly T[],
  skip: number,
  limit: number,
  key: (r: T) => string | number,
  anchor?: string | number,
): { rows: T[]; more: boolean } {
  const w = pageWindow(skip, limit);
  const i = skip > 0 && anchor !== undefined ? rows.findIndex((r) => key(r) === anchor) : -1;
  // an anchor near the window's end would leave a short page with more beyond it: from skip then
  const start = i >= 0 && (i + limit <= rows.length || rows.length < w.limit) ? i : skip - w.skip;
  return { rows: rows.slice(start, start + limit), more: rows.length > start + limit };
}
