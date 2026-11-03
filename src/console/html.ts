/** HTML for the console pages: `h` escapes every interpolation; `raw()` opts out. */
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
  return `<!doctype html>${h`<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
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
  iso ? h`<time datetime="${iso}">${iso.replace("T", " ").slice(0, 16)}</time>` : raw("—");

export function tokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** `1.2M / 2.0M tokens, 0.5 / 4 h` from the tasks row's JSON columns. */
export function budget(row: { budget?: string | null; usage?: string | null; hours?: number | null }): string {
  const b = parse<{ tokens?: number; hours?: number }>(row.budget) ?? {};
  const u = parse<{ tokens?: number }>(row.usage) ?? {};
  const hrs = Math.round(num(row.hours) * 10) / 10;
  return `${tokens(num(u.tokens))} / ${tokens(num(b.tokens))} tokens, ${hrs} / ${num(b.hours)} h`;
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

export const error = (msg: string): Raw => h`<p class="error">${msg}</p>`;

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
