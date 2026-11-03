/**
 * Markdown with a YAML header, schema-free: `render(frontmatter, body)` and its inverse `parse(text)`. The YAML is the
 * small subset v6's examples use: one `key: value` per line, scalars plain unless they could read as something else,
 * arrays and objects inline (flow style).
 */

const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
const KEYWORD = /^(true|false|null|~|yes|no|on|off|[-+]?\.(inf|nan))$/i;

/** A plain scalar that would not read back as the same string must be quoted. */
function needsQuote(s: string, flow: boolean): boolean {
  if (s === "" || s.trim() !== s || /\p{Cc}/u.test(s)) return true;
  if (!Number.isNaN(Number(s)) || NUMBER.test(s) || KEYWORD.test(s)) return true;
  if (/^[!&*%@`#|>?'"[\]{},]/.test(s) || /^-(\s|$)/.test(s)) return true;
  if (s.includes(": ") || s.endsWith(":") || s.includes(" #")) return true;
  return flow && /[,[\]{}:]/.test(s);
}

function scalar(v: unknown, flow: boolean): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return `[${v.map((x) => scalar(x, true)).join(", ")}]`;
  if (typeof v === "object") {
    const parts = Object.entries(v).map(([k, x]) => `${scalar(k, true)}: ${scalar(x, true)}`);
    return parts.length ? `{ ${parts.join(", ")} }` : "{}";
  }
  const s = String(v);
  return needsQuote(s, flow) ? JSON.stringify(s) : s;
}

export function render(frontmatter: Record<string, unknown>, body: string): string {
  const lines = Object.entries(frontmatter).map(([k, v]) => `${scalar(k, true)}: ${scalar(v, false)}\n`);
  return `---\n${lines.join("")}---\n${body}`;
}

function plain(s: string): unknown {
  if (/^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(s)) return Number(s);
  if (s === "true" || s === "false") return s === "true";
  if (s === "null" || s === "~") return null;
  return s;
}

/** Flow-style value parser: `"…"`, `[…]`, `{…}`, plain scalars ending at `,]}` (and `:` for map keys). */
function flowValue(src: string): unknown {
  let i = 0;
  const ws = () => {
    while (src[i] === " ") i++;
  };
  const quoted = (): string => {
    const start = i++;
    while (i < src.length && src[i] !== '"') i += src[i] === "\\" ? 2 : 1;
    i++;
    return JSON.parse(src.slice(start, i)) as string;
  };
  const value = (stops: string): unknown => {
    ws();
    const c = src[i];
    if (c === '"') return quoted();
    if (c === "[") {
      i++;
      const out: unknown[] = [];
      for (ws(); src[i] !== "]" && i < src.length; ws()) {
        out.push(value(",]"));
        ws();
        if (src[i] === ",") i++;
      }
      i++;
      return out;
    }
    if (c === "{") {
      i++;
      // entries, not assignment: an upstream key `__proto__` (a reaction's emoji name) is a key, not a prototype
      const out: [string, unknown][] = [];
      for (ws(); src[i] !== "}" && i < src.length; ws()) {
        const k = String(src[i] === '"' ? quoted() : value(":,}"));
        ws();
        if (src[i] === ":") i++;
        out.push([k, value(",}")]);
        ws();
        if (src[i] === ",") i++;
      }
      i++;
      return Object.fromEntries(out);
    }
    const start = i;
    while (i < src.length && !stops.includes(src[i] as string)) i++;
    return plain(src.slice(start, i).trim());
  };
  return value("");
}

/** Inverse of `render`. No header → empty frontmatter, the whole text is the body. */
export function parse(text: string): { frontmatter: Record<string, unknown>; body: string } {
  if (!text.startsWith("---\n")) return { frontmatter: {}, body: text };
  const end = text.indexOf("\n---\n", 3);
  const header = end < 0 ? null : text.slice(4, end + 1);
  if (header === null) return { frontmatter: {}, body: text };
  const entries: [string, unknown][] = [];
  for (const line of header.split("\n")) {
    if (!line.trim()) continue;
    const key = line.startsWith('"') ? (flowValue(line) as string) : line.slice(0, line.indexOf(":"));
    const rest = line.startsWith('"') ? line.slice(JSON.stringify(key).length) : line.slice(key.length);
    entries.push([key, flowValue(rest.replace(/^:\s?/, ""))]);
  }
  return { frontmatter: Object.fromEntries(entries), body: text.slice(end + 5) };
}
