/** Search over every mirror (`dof search`), and one mirrored file. */
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Input } from "@/components/ui/input";
import { type ReactNode, useEffect, useState } from "react";
import { type Config, type DofFile, type SearchHit, useCall } from "../api.ts";
import { Markdown } from "../markdown.tsx";
import {
  buttonVariants,
  Callout,
  Empty,
  Icon,
  Link,
  navigate,
  Page,
  RelTime,
  ServiceTile,
  Spinner,
  useLocation,
} from "../ui.tsx";

const FIELDS = ["in", "author", "since", "until"] as const;

/** The snippet's `[hit]` as a <mark>. */
function marked(snippet: string): ReactNode {
  const m = /\[([^\]]+)\]/.exec(snippet);
  if (!m) return snippet;
  return (
    <>
      {snippet.slice(0, m.index)}
      <mark>{m[1]}</mark>
      {snippet.slice(m.index + m[0].length)}
    </>
  );
}

/** A `logs` hit is its task's card; anything else the file view. */
const hitHref = (h: SearchHit) =>
  h.dof === "logs"
    ? `/tasks/${encodeURIComponent(h.path.split("/")[0] ?? "")}`
    : `/dof/${[h.dof, ...h.path.split("/")].map(encodeURIComponent).join("/")}`;

export function Search() {
  const { query } = useLocation();
  const q = query.get("q") ?? "";
  const applied = Object.fromEntries(FIELDS.map((f) => [f, query.get(f) ?? ""])) as Record<
    (typeof FIELDS)[number],
    string
  >;
  const [text, setText] = useState(q);
  const [f, setF] = useState(applied);
  const [more, setMore] = useState(FIELDS.some((k) => applied[k]));
  useEffect(() => setText(q), [q]);
  const cfg = useCall<{ config: Config }>("settings.get", {}, ["settings"]);
  const input = { q, ...Object.fromEntries(FIELDS.filter((k) => applied[k]).map((k) => [k, applied[k]])) };
  const hits = useCall<SearchHit[]>(q ? "dof.search" : null, input);
  const dofs = Object.entries(cfg.data?.config.dofs ?? {});
  const submit = (next = f) => {
    const p = new URLSearchParams();
    if (text.trim()) p.set("q", text.trim());
    for (const k of FIELDS) if (next[k]) p.set(k, next[k]);
    navigate(`/search?${p}`);
  };
  return (
    <Page title="Search" description="Every message and issue hortus mirrors, and the logs of past tasks.">
      <search>
        <form
          className="flex flex-col gap-2.5"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <label className="flex items-center gap-2.5 rounded-xl border border-input bg-card py-1 pr-1 pl-4 text-muted-foreground shadow-xs focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 [&_input]:min-w-0 [&_input]:flex-1 [&_input]:bg-transparent [&_input]:py-2 [&_input]:text-base [&_input]:text-foreground [&_input]:outline-none">
            <Icon name="search" size={20} />
            <span className="sr-only">Search for</span>
            <input
              type="search"
              value={text}
              placeholder="Search messages, issues, pull requests…"
              ref={(el) => {
                if (el && !q) el.focus();
              }}
              onChange={(e) => setText(e.target.value)}
            />
            <button type="submit" className={buttonVariants()}>
              Search
            </button>
          </label>
          <button
            type="button"
            className="inline-flex w-fit items-center gap-1.5 text-[13px] font-medium text-brand-text hover:underline"
            aria-expanded={more}
            onClick={() => setMore(!more)}
          >
            <Icon name="settings" size={15} /> Filters{FIELDS.some((k) => applied[k]) && " (on)"}
          </button>
          {more && (
            <div className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] items-end gap-3 rounded-xl border bg-card p-3.5">
              <label className="flex flex-col gap-1.5 text-[13px] text-foreground/80 [&_[data-slot=native-select-wrapper]]:w-full">
                <span>Where</span>
                <NativeSelect value={f.in} onChange={(e) => setF({ ...f, in: e.target.value })}>
                  <NativeSelectOption value="">Everywhere</NativeSelectOption>
                  {dofs.map(([name]) => (
                    <NativeSelectOption key={name} value={name}>
                      {name}
                    </NativeSelectOption>
                  ))}
                  <NativeSelectOption value="logs">Task logs</NativeSelectOption>
                </NativeSelect>
              </label>
              <label className="flex flex-col gap-1.5 text-[13px] text-foreground/80 [&_[data-slot=native-select-wrapper]]:w-full">
                <span>From (user id)</span>
                <Input
                  className="font-mono"
                  value={f.author}
                  placeholder="U0123ABCD"
                  onChange={(e) => setF({ ...f, author: e.target.value })}
                />
              </label>
              <label className="flex flex-col gap-1.5 text-[13px] text-foreground/80 [&_[data-slot=native-select-wrapper]]:w-full">
                <span>Since</span>
                <Input type="date" value={f.since} onChange={(e) => setF({ ...f, since: e.target.value })} />
              </label>
              <label className="flex flex-col gap-1.5 text-[13px] text-foreground/80 [&_[data-slot=native-select-wrapper]]:w-full">
                <span>Until</span>
                <Input type="date" value={f.until} onChange={(e) => setF({ ...f, until: e.target.value })} />
              </label>
              <button
                type="button"
                className="inline-flex w-fit items-center gap-1.5 text-[13px] font-medium text-brand-text hover:underline"
                onClick={() => {
                  const none = { in: "", author: "", since: "", until: "" };
                  setF(none);
                  submit(none);
                }}
              >
                Clear
              </button>
            </div>
          )}
        </form>
      </search>
      {!q ? (
        <Empty icon="search" title="Search everything hortus has read">
          Words match anywhere in a message, an issue or a task log. Use the filters to narrow it to one source, one
          person or some dates.
        </Empty>
      ) : hits.error ? (
        <Callout tone="danger">{hits.error}</Callout>
      ) : !hits.data ? (
        <div className="grid flex-1 place-items-center p-12 text-muted-foreground">
          <Spinner />
        </div>
      ) : hits.data.length ? (
        <>
          <p className="text-muted-foreground text-[13px]">
            {hits.data.length} result{hits.data.length === 1 ? "" : "s"} for “{q}”
          </p>
          <ol className="flex flex-col gap-2.5">
            {hits.data.map((h) => (
              <li key={`${h.dof}/${h.path}`}>
                <Link
                  to={hitHref(h)}
                  className="flex flex-col gap-1 rounded-xl border bg-card px-4 py-3.5 text-inherit transition-shadow hover:shadow-sm"
                >
                  <span className="flex flex-wrap items-center gap-2 text-xs text-foreground/80">
                    {h.dof === "logs" ? (
                      <Icon name="tasks" size={16} />
                    ) : (
                      <ServiceTile type={cfg.data?.config.dofs[h.dof]?.type ?? h.dof} size={18} />
                    )}
                    {h.dof === "logs" ? "Task log" : h.dof}
                    <span className="text-muted-foreground">
                      · {h.author} · <RelTime iso={h.ts} />
                    </span>
                  </span>
                  <span className="font-semibold">{h.title || h.path}</span>
                  <span className="text-sm leading-normal text-foreground/80">{marked(h.snippet)}</span>
                </Link>
              </li>
            ))}
          </ol>
        </>
      ) : (
        <Empty icon="search" title={`Nothing found for “${q}”`}>
          Try fewer words, or clear the filters.
        </Empty>
      )}
    </Page>
  );
}

/** `---` frontmatter, then the body. */
function split(text: string): { meta: [string, string][]; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { meta: [], body: text };
  const meta = (m[1] ?? "").split("\n").flatMap((l): [string, string][] => {
    const i = l.indexOf(":");
    return i > 0
      ? [
          [
            l.slice(0, i).trim(),
            l
              .slice(i + 1)
              .trim()
              .replace(/^"|"$/g, ""),
          ],
        ]
      : [];
  });
  return { meta, body: text.slice(m[0].length) };
}

export function DofFileView({ dof, path }: { dof: string; path: string }) {
  const f = useCall<DofFile>("dof.file", { dof, path });
  const name = path.split("/").at(-1) ?? path;
  const dir = path.split("/").slice(0, -1);
  const back = { to: "/search", label: "Search" };
  if (f.error)
    return (
      <Page title={name} back={back}>
        <Callout tone="danger">{f.error}</Callout>
      </Page>
    );
  if (!f.data)
    return (
      <Page title={name} back={back}>
        <Spinner />
      </Page>
    );
  const { meta, body } = split(f.data.text);
  return (
    <Page
      title={meta.find(([k]) => k === "title")?.[1] ?? name}
      back={back}
      description={
        <span className="font-mono text-[13px]">
          {dof}:{path} · read-only mirror
        </span>
      }
    >
      {meta.length > 0 && (
        <dl className="mb-0! grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2 rounded-xl bg-card px-5 py-4 text-[13px] ring-1 ring-foreground/10 [&_dd]:min-w-0 [&_dd]:wrap-anywhere [&_dt]:text-muted-foreground">
          {meta.map(([k, v]) => (
            <div key={k} className="contents">
              <dt>{k}</dt>
              <dd>{k === "ts" ? <RelTime iso={v} /> : v}</dd>
            </div>
          ))}
        </dl>
      )}
      {f.data.text.includes("\0") ? (
        <p className="text-muted-foreground">A binary file, {f.data.size.toLocaleString()} bytes.</p>
      ) : (
        <div className="mb-0! grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2 rounded-xl bg-card px-5 py-4 text-[13px] ring-1 ring-foreground/10 [&_dd]:min-w-0 [&_dd]:wrap-anywhere [&_dt]:text-muted-foreground">
          <Markdown text={body} />
        </div>
      )}
      {f.data.siblings.length > 1 && (
        <section className="flex flex-col gap-2 *:data-[slot=button]:self-start">
          <h2 className="text-[13px] font-semibold tracking-wide text-muted-foreground uppercase">In this thread</h2>
          <ul className="">
            {f.data.siblings.map((s) =>
              s === name ? (
                <li key={s}>
                  <b>{s}</b>
                </li>
              ) : (
                <li key={s}>
                  <Link to={`/dof/${[dof, ...dir, ...s.split("/")].map(encodeURIComponent).join("/")}`}>{s}</Link>
                </li>
              ),
            )}
          </ul>
        </section>
      )}
    </Page>
  );
}
