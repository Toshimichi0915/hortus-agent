/** HTML for the console pages: `h` escapes every interpolation; `raw()` opts out. */
import { existsSync } from "node:fs";
import type { Ctx } from "../ctx.ts";
import { call } from "../rpc.ts";
import { type Caller, RpcError } from "../types.ts";

export class Raw {
  constructor(readonly html: string) {}
  toString(): string {
    return this.html;
  }
}

export const raw = (html: string): Raw => new Raw(html);

const ENT: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ENT[c] as string);

function part(v: unknown): string {
  if (v instanceof Raw) return v.html;
  if (Array.isArray(v)) return v.map(part).join("");
  if (v === null || v === undefined || v === false) return "";
  if (typeof v === "object") return esc(JSON.stringify(v));
  return esc(String(v));
}

/** Tagged template: `h\`<p>${text}</p>\``. Arrays are joined, null/undefined/false render nothing, objects as JSON. */
export function h(strings: TemplateStringsArray, ...vals: unknown[]): Raw {
  let out = strings[0] ?? "";
  for (let i = 0; i < vals.length; i++) out += part(vals[i]) + (strings[i + 1] ?? "");
  return new Raw(out);
}

const NAV: [string, string, string][] = [
  ["tasks", "/", "Tasks"],
  ["chat", "/chat", "Chat"],
  ["approvals", "/approvals", "Approvals"],
  ["credentials", "/credentials", "Credentials"],
  ["projects", "/projects", "Projects"],
  ["schedules", "/schedules", "Schedules"],
  ["sources", "/sources", "Sources"],
  ["search", "/search", "Search"],
  ["settings", "/settings", "Settings"],
];

export function layout(ctx: Ctx, page: string, title: string, body: Raw): string {
  const pending = (
    ctx.db.prepare("SELECT count(*) AS n FROM approvals WHERE status = 'pending'").get() as { n: number }
  ).n;
  const nav = NAV.map(
    ([id, href, label]) =>
      h`<a href="${href}"${raw(id === page ? ' aria-current="page"' : "")}>${label}${
        id === "approvals" && pending > 0 ? h` <span class="badge">${pending}</span>` : ""
      }</a>`,
  );
  return `<!doctype html>${h`<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="data:,">
<title>${title} · hortus</title><link rel="stylesheet" href="/static/app.css"><script src="/static/app.js" defer></script></head>
<body data-page="${page}"><nav>${nav}</nav><main><h1>${title}</h1>${body}<output id="msg" role="status"></output></main></body></html>`}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// helpers

export function parse<T = unknown>(text: string | null | undefined): T | undefined {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

export const time = (iso: string | null | undefined): Raw =>
  // UTC without JavaScript; app.js rewrites it in the browser's time zone
  iso ? h`<time datetime="${iso}" title="UTC">${iso.replace("T", " ").slice(0, 16)}</time>` : raw("—");

export function tokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** `1.2M / 2.0M tokens, 0.5 / 4 h` from the tasks row's JSON columns. */
export function budget(row: {
  budget?: string | null;
  usage?: string | null;
  hours?: number | null;
  metered?: number | null;
}): string {
  const b = parse<{ tokens?: number; hours?: number }>(row.budget) ?? {};
  const u = parse<{ tokens?: number; runs?: number }>(row.usage) ?? {};
  const hrs = Math.round(num(row.hours) * 10) / 10;
  // usage is written when a session ends; the proxy's count (plus what its runs charged) is the spend so far
  const used = Math.max(num(u.tokens), num(row.metered) + num(u.runs));
  return `${tokens(used)} / ${tokens(num(b.tokens))} tokens, ${hrs} / ${num(b.hours)} h`;
}

export const OPEN = ["queued", "running", "waiting"];
export const isOpen = (status: string | null | undefined): boolean => OPEN.includes(status ?? "");

export const status = (s: string | null | undefined): Raw =>
  h`<span class="st st-${s ?? "unknown"}">${s ?? "unknown"}</span>`;

export const details = (label: string, v: unknown): Raw =>
  h`<details><summary>${label}</summary><pre>${typeof v === "string" ? v : JSON.stringify(v, null, 2)}</pre></details>`;

/** A button that posts `method(input)`; `confirm` arms it on the first click and acts on the second. */
export function button(label: string, method: string, input: unknown, opts: { confirm?: boolean; cls?: string } = {}) {
  return h`<button type="button" class="${opts.cls ?? ""}" data-call="${method}" data-input="${JSON.stringify(input)}"${raw(
    opts.confirm ? " data-confirm" : "",
  )}>${label}</button>`;
}

/** What `PAUSED` does (dispatcher, schedules tick, Planner wake), said the same on Tasks, Settings and in the CLI. */
export const PAUSED = "queued tasks, schedules and the Planner wait; running tasks go on.";

/** A task error's headline: its last line (a crash's last words), but hortusd's own reason when the serial tail follows
 * it (a VM boot timeout or a dead guest, dispatcher.ts). */
export const errorLine = (e: string): string =>
  (/^(boot timeout|guest died):/.test(e) ? e.split("\n")[0] : e.split("\n").at(-1)) ?? "";

export const error = (msg: string): Raw => h`<p class="error">${msg}</p>`;

/** The Tasks, Chat and task card line: a message to a paused task stays `queued`, and nothing else there says why. */
export const pausedLine = (ctx: Ctx): Raw =>
  existsSync(ctx.paths.paused())
    ? h`<p class="error">Paused: ${PAUSED} <a href="/settings">Resume in Settings</a>.</p>`
    : raw("");

/** Rows per list on a page; `?skip=N` pages every capped list of that page together (SQL `LIMIT PAGE OFFSET N`). */
export const PAGE = 50;
/** `?skip=` as an OFFSET SQLite takes (an integer, not `1e300`). */
export const skipOf = (q: URLSearchParams): number =>
  Math.min(1e9, Math.max(0, Math.floor(Number(q.get("skip")) || 0)));

/**
 * What a capped list cut and how to see more: `showing 51–100 of 5,123 open tasks · newer · older`, nothing when
 * the list fits. The links keep the page's other query parameters.
 */
export function more(q: URLSearchParams, what: string, shown: number, total: number): Raw {
  const skip = skipOf(q);
  if (skip === 0 && shown >= total) return raw("");
  const link = (to: number, label: string) => {
    const p = new URLSearchParams(q);
    if (to) p.set("skip", String(to));
    else p.delete("skip");
    return h` · <a href="?${p.toString()}">${label}</a>`;
  };
  const n = (v: number) => v.toLocaleString("en");
  return h`<p class="hint more">showing ${shown ? `${n(skip + 1)}–${n(skip + shown)}` : "none"} of ${n(total)} ${what}${
    skip ? link(Math.max(0, skip - PAGE), "newer") : ""
  }${skip + shown < total ? link(skip + PAGE, "older") : ""}</p>`;
}

/** A list's empty line, on its first page only: past it `more` says "showing none of N", and "nothing pending" lied. */
export const empty = (q: URLSearchParams, text: string): Raw => (skipOf(q) ? raw("") : h`<p class="empty">${text}</p>`);

/** An RPC another module owns may be absent: the page shows an error line instead of failing. */
export async function tryCall<T>(
  method: string,
  input: unknown,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: (await call(method, input, { role: "owner" })) as T };
  } catch (e) {
    return { ok: false, error: e instanceof RpcError ? `${method}: ${e.message}` : `${method}: ${String(e)}` };
  }
}

export interface Params {
  /** regex captures of the route */
  m: string[];
  q: URLSearchParams;
  /** who asks: `remote` and `session` are set on the remote listener */
  caller?: Caller;
}

export type Page = (ctx: Ctx, p: Params) => string | Promise<string>;
