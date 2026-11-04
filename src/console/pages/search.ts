import type { SearchHit, SearchQuery } from "../../types.ts";
import { error, h, layout, type Page, type Raw, time, tryCall } from "../html.ts";
import { dofHref } from "./dof.ts";

const FIELDS = ["in", "author", "since", "until"] as const;
const HINTS = { in: "a DOF: slack, logs…", author: "a user id", since: "YYYY-MM-DD", until: "YYYY-MM-DD" };

/** The snippet's `[hit]` (fts.ts › around) as a <mark>: brackets in the text itself (`[inbox 1]`) stay as they are. */
export function hit(snippet: string, q: string): Raw {
  const i = snippet.toLowerCase().indexOf(`[${q.toLowerCase()}]`);
  if (i < 0 || snippet.length !== snippet.toLowerCase().length) return h`${snippet}`;
  const j = i + q.length + 2;
  return h`${snippet.slice(0, i)}<mark>${snippet.slice(i + 1, j - 1)}</mark>${snippet.slice(j)}`;
}

export const search: Page = async (ctx, { q }) => {
  const query: SearchQuery = { q: q.get("q") ?? "" };
  for (const f of FIELDS) {
    const v = q.get(f);
    if (v) query[f] = v;
  }
  let results = h``;
  if (query.q) {
    const r = await tryCall<SearchHit[]>("dof.search", query);
    results = !r.ok
      ? error(r.error)
      : r.value.length
        ? h`<ol class="hits">${r.value.map(
            (x) =>
              h`<li><a href="${dofHref(x.dof, x.path)}"><b>${x.title || x.path}</b></a> <span class="hint">${x.dof}:${x.path} · ${x.author ? `${x.author} · ` : ""}${time(x.ts)}</span><p class="pre">${hit(x.snippet, query.q)}</p></li>`,
          )}</ol>`
        : h`<p class="empty">no results</p>`;
  }
  return layout(
    ctx,
    "search",
    "Search",
    h`<form method="get" action="/search" class="search"><input name="q" value="${query.q}" placeholder="query" autofocus>
${FIELDS.map((f) => h`<label>${f} <input name="${f}" value="${query[f] ?? ""}" placeholder="${HINTS[f]}"></label>`)}
<button>Search</button></form>${results}`,
  );
};
