import type { SearchHit, SearchQuery } from "../../types.ts";
import { error, h, layout, type Page, time, tryCall } from "../html.ts";

const FIELDS = ["in", "author", "since", "until"] as const;

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
              h`<li><b>${x.title || x.path}</b> <span class="hint">${x.dof}:${x.path} · ${x.author} · ${time(x.ts)}</span><p class="pre">${x.snippet}</p></li>`,
          )}</ol>`
        : h`<p class="empty">no results</p>`;
  }
  return layout(
    ctx,
    "search",
    "Search",
    h`<form method="get" action="/search" class="search"><input name="q" value="${query.q}" placeholder="query" autofocus>
${FIELDS.map((f) => h`<label>${f} <input name="${f}" value="${query[f] ?? ""}"></label>`)}
<button>Search</button></form>${results}`,
  );
};
