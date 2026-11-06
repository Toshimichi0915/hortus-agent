/**
 * Markdown to React elements, never to an HTML string: what a Worker or a mirrored message says cannot inject markup.
 * The subset models write: fenced code, headings, nested and task lists, quotes, tables, rules; code, bold, italic,
 * strikethrough, links (http, https, mailto and in-app paths only) and bare URLs. Unclosed fences render as code, so a
 * reply mid-stream looks right.
 */
import type { ReactNode } from "react";
import { CopyButton, cn, Link } from "./ui.tsx";

export function Markdown({ text, className }: { text: string; className?: string }) {
  return <div className={cn(MD, className)}>{blocks(text.replace(/\r\n?/g, "\n").split("\n"), "m")}</div>;
}

const MD =
  "text-[15.5px] leading-[1.7] wrap-anywhere [&_:not(pre)>code]:rounded [&_:not(pre)>code]:border [&_:not(pre)>code]:bg-muted [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-px [&_:not(pre)>code]:text-[.86em] [&_a]:text-brand-text [&_a]:underline [&_a]:underline-offset-2 [&_blockquote]:border-l-[3px] [&_blockquote]:pl-4 [&_blockquote]:text-foreground/80 [&_li]:marker:text-muted-foreground [&_li+li]:mt-1 [&_li>*+*]:mt-[.8em] [&_li>p]:m-0 [&_ol]:list-decimal [&_ol]:pl-6 [&_strong]:font-semibold [&_ul]:list-disc [&_ul]:pl-6 [&>*+*]:mt-[.8em]";
const HEADINGS = [
  "mt-6! text-[1.32em] leading-snug font-semibold first:mt-0!",
  "mt-5! text-[1.16em] leading-snug font-semibold first:mt-0!",
  "mt-5! text-[1.04em] font-semibold first:mt-0!",
  "mt-5! text-[1.04em] font-semibold first:mt-0!",
  "mt-5! text-[1.04em] font-semibold first:mt-0!",
  "mt-5! text-[1.04em] font-semibold first:mt-0!",
];
const TOK: Record<string, string> = {
  c: "text-muted-foreground italic",
  s: "text-emerald-700 dark:text-emerald-300",
  n: "text-amber-700 dark:text-amber-300",
  k: "text-violet-700 dark:text-violet-300",
  f: "text-blue-700 dark:text-blue-300",
  t: "text-rose-700 dark:text-rose-300",
};

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>\s?/;
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

const indent = (l: string) => l.length - l.trimStart().length;
const blank = (l: string | undefined) => l === undefined || l.trim() === "";
const isTable = (l: string, next: string | undefined) => l.includes("|") && next !== undefined && TABLE_SEP.test(next);
const starts = (l: string, next: string | undefined) =>
  FENCE.test(l) || HEADING.test(l) || HR.test(l) || QUOTE.test(l) || LIST.test(l) || isTable(l, next);

function blocks(lines: string[], key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    const k = `${key}.${i}`;
    if (blank(line)) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const body: string[] = [];
      for (i++; i < lines.length && !(lines[i] as string).trimStart().startsWith(fence[1] as string); i++)
        body.push(lines[i] as string);
      i++;
      out.push(<CodeBlock key={k} lang={fence[2]} code={body.join("\n")} />);
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      const n = (h[1] as string).length;
      // a message sits under the page's own headings
      const Tag = `h${Math.min(6, n + 2)}` as "h3";
      out.push(
        <Tag key={k} className={HEADINGS[n - 1]}>
          {inline(h[2] ?? "", k)}
        </Tag>,
      );
      i++;
      continue;
    }
    if (HR.test(line)) {
      out.push(<hr key={k} />);
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && !blank(lines[i]) && (QUOTE.test(lines[i] as string) || body.length === 0))
        body.push((lines[i++] as string).replace(QUOTE, ""));
      out.push(<blockquote key={k}>{blocks(body, k)}</blockquote>);
      continue;
    }
    if (isTable(line, lines[i + 1])) {
      const cells = (l: string) =>
        l
          .trim()
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((c) => c.trim());
      const head = cells(line);
      const align = cells(lines[i + 1] as string).map((c) =>
        c.endsWith(":") ? (c.startsWith(":") ? "center" : "right") : undefined,
      );
      const rows: string[][] = [];
      for (i += 2; i < lines.length && !blank(lines[i]) && (lines[i] as string).includes("|"); i++)
        rows.push(cells(lines[i] as string));
      out.push(
        <div
          key={k}
          className="overflow-x-auto rounded-lg border [&_table]:w-full [&_table]:text-[.92em] [&_td]:border-t [&_td]:px-3 [&_td]:py-1.5 [&_th]:bg-muted [&_th]:px-3 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-semibold"
        >
          <table>
            <thead>
              <tr>
                {head.map((c, j) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: columns have no identity but their place
                  <th key={j} style={{ textAlign: align[j] }}>
                    {inline(c, `${k}h${j}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity but their place
                <tr key={ri}>
                  {head.map((_, j) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: as above
                    <td key={j} style={{ textAlign: align[j] }}>
                      {inline(r[j] ?? "", `${k}.${ri}.${j}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (LIST.test(line)) {
      const [node, next] = list(lines, i, k);
      out.push(node);
      i = next;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && !blank(lines[i]) && (para.length === 0 || !starts(lines[i] as string, lines[i + 1])))
      para.push((lines[i++] as string).trim());
    // a line break inside a paragraph is kept, as chat replies mean it
    const kids: ReactNode[] = [];
    for (let j = 0; j < para.length; j++) {
      if (j) kids.push(<br key={`${k}b${j}`} />);
      kids.push(...inline(para[j] as string, `${k}.${j}`));
    }
    out.push(<p key={k}>{kids}</p>);
  }
  return out;
}

function list(lines: string[], start: number, key: string): [ReactNode, number] {
  const first = LIST.exec(lines[start] as string) as RegExpExecArray;
  const base = (first[1] as string).length;
  const ordered = /\d/.test(first[2] as string);
  const items: { body: string[]; task?: boolean; done?: boolean }[] = [];
  let i = start;
  while (i < lines.length) {
    const m = LIST.exec(lines[i] as string);
    if (!m || (m[1] as string).length !== base || /\d/.test(m[2] as string) !== ordered) break;
    const pad = base + (m[2] as string).length + 1;
    let text = m[3] as string;
    const t = /^\[([ xX])\]\s+/.exec(text);
    if (t) text = text.slice(t[0].length);
    const body = [text];
    for (i++; i < lines.length; i++) {
      const l = lines[i] as string;
      if (blank(l)) {
        const next = lines[i + 1];
        if (next !== undefined && !blank(next) && indent(next) > base) {
          body.push("");
          continue;
        }
        break;
      }
      if (indent(l) > base) body.push(l.slice(Math.min(indent(l), pad)));
      else if (!starts(l, lines[i + 1])) body.push(l.trim());
      else break;
    }
    items.push({ body, ...(t ? { task: true, done: t[1] !== " " } : {}) });
    // a blank line between two items of this list
    const next = lines[i + 1];
    if (blank(lines[i]) && next !== undefined && LIST.test(next) && indent(next) === base) i++;
  }
  const Tag = ordered ? "ol" : "ul";
  const n = ordered ? Number.parseInt(first[2] as string, 10) : 1;
  return [
    <Tag
      key={key}
      start={n !== 1 ? n : undefined}
      className={items.some((x) => x.task) ? "list-none! pl-1! [&_input]:mr-2 [&_input]:accent-brand" : undefined}
    >
      {items.map((it, j) => {
        const k = `${key}.${j}`;
        return (
          <li key={k}>
            {it.task && <input type="checkbox" checked={it.done} disabled aria-label={it.done ? "done" : "to do"} />}
            {it.body.length === 1 ? inline(it.body[0] ?? "", k) : blocks(it.body, k)}
          </li>
        );
      })}
    </Tag>,
    i,
  ];
}

// escape | `code` | [text](url) | <url> or url | **b** | __b__ | ~~s~~ | *i* | _i_
const INLINE =
  /\\([\\`*_[\]()#+\-.!|~<>])|(`+)([^`]|[^`][\s\S]*?[^`])\2(?!`)|\[([^\]\n]+)\]\(([^()\s]+)\)|<?(https?:\/\/[^\s<>]*[^\s<>.,;:!?'")\]])>?|\*\*(?=\S)([\s\S]*?\S)\*\*|__(?=\S)([\s\S]*?\S)__|~~(?=\S)([\s\S]*?\S)~~|\*(?=[^\s*])([\s\S]*?[^\s*])\*|(?<![\p{L}\p{N}_])_(?=[^\s_])([\s\S]*?[^\s_])_(?![\p{L}\p{N}_])/gu;

const safeHref = (u: string): string | undefined =>
  /^(https?:|mailto:)/i.test(u) || /^\/(?!\/)/.test(u) || u.startsWith("#") ? u : undefined;

function anchor(href: string, children: ReactNode, key: string): ReactNode {
  const safe = safeHref(href);
  if (!safe) return <span key={key}>{children}</span>;
  if (safe.startsWith("/"))
    return (
      <Link key={key} to={safe}>
        {children}
      </Link>
    );
  return (
    <a key={key} href={safe} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

function inline(s: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of s.matchAll(INLINE)) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const k = `${key}i${n++}`;
    if (m[1] !== undefined) out.push(m[1]);
    else if (m[3] !== undefined) out.push(<code key={k}>{m[3]}</code>);
    else if (m[4] !== undefined) out.push(anchor(m[5] as string, inline(m[4], k), k));
    else if (m[6] !== undefined) out.push(anchor(m[6], m[6], k));
    else if (m[7] !== undefined || m[8] !== undefined)
      out.push(<strong key={k}>{inline((m[7] ?? m[8]) as string, k)}</strong>);
    else if (m[9] !== undefined) out.push(<del key={k}>{inline(m[9], k)}</del>);
    else out.push(<em key={k}>{inline((m[10] ?? m[11]) as string, k)}</em>);
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Code blocks: a header with the language and Copy, and a light colouring of comments, strings, numbers and keywords

export function CodeBlock({ code, lang = "" }: { code: string; lang?: string | undefined }) {
  return (
    <div className="overflow-hidden rounded-lg border bg-muted/40">
      <div className="flex items-center justify-between border-b bg-muted py-0.5 pr-1 pl-3.5 font-sans text-xs text-muted-foreground">
        <span>{lang || "text"}</span>
        <CopyButton text={code} label="Copy" showLabel />
      </div>
      <pre className="overflow-x-auto px-3.5 py-3 text-[13px] leading-relaxed">
        <code className="block w-max min-w-full">{highlight(code, lang)}</code>
      </pre>
    </div>
  );
}

const KNOWN =
  /^(js|jsx|ts|tsx|javascript|typescript|json|jsonc|sh|bash|zsh|shell|console|py|python|go|rs|rust|java|c|cpp|h|cs|rb|ruby|yaml|yml|toml|css|sql|swift|kt|kotlin|php|ini|dockerfile|make|makefile)$/;
const HASH = /^(sh|bash|zsh|shell|console|py|python|rb|ruby|yaml|yml|toml|ini|dockerfile|make|makefile)$/;
const STR = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/.source;
const REST = `(${STR})|\\b(\\d[\\d_.]*(?:e[+-]?\\d+)?)\\b|([A-Za-z_$][\\w$]*)`;
const TOKEN_C = new RegExp(`(\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/)|${REST}`, "g");
const TOKEN_HASH = new RegExp(`((?<![\\w$])#[^\\n]*)|${REST}`, "g");
const KEYWORDS = new Set(
  "const let var function return if else for while do switch case break continue new class extends import export from default async await try catch finally throw typeof instanceof in of interface type enum implements public private protected readonly static yield def lambda pass raise with as elif not and or is None True False null undefined true false nil fn pub mut impl struct trait use mod match loop go func package defer chan select range echo then fi done esac local set unset self this super void SELECT FROM WHERE INSERT UPDATE DELETE JOIN ON AND OR ORDER BY GROUP LIMIT".split(
    " ",
  ),
);

function highlight(code: string, lang: string): ReactNode {
  const l = lang.toLowerCase();
  if (l === "diff" || l === "patch")
    return code.split("\n").map((line, i) => (
      <span
        // biome-ignore lint/suspicious/noArrayIndexKey: a line's place is its identity
        key={i}
        className={cn(
          "-mx-3.5 block px-3.5",
          line.startsWith("+") && !line.startsWith("+++")
            ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
            : line.startsWith("-") && !line.startsWith("---")
              ? "bg-rose-50 text-rose-800 dark:bg-rose-950 dark:text-rose-300"
              : line.startsWith("@@") && "bg-brand/10 text-brand-text",
        )}
      >
        {line}
        {"\n"}
      </span>
    ));
  if (!KNOWN.test(l)) return code;
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of code.matchAll(HASH.test(l) ? TOKEN_HASH : TOKEN_C)) {
    if (m.index > last) out.push(code.slice(last, m.index));
    const word = m[4];
    const cls = m[1]
      ? "c"
      : m[2]
        ? "s"
        : m[3]
          ? "n"
          : word && KEYWORDS.has(word)
            ? "k"
            : word && code[m.index + word.length] === "("
              ? "f"
              : word && /^[A-Z][a-z]/.test(word) && !HASH.test(l)
                ? "t"
                : undefined;
    out.push(
      cls ? (
        <span key={n++} className={TOK[cls]}>
          {m[0]}
        </span>
      ) : (
        m[0]
      ),
    );
    last = m.index + m[0].length;
  }
  if (last < code.length) out.push(code.slice(last));
  return out;
}
