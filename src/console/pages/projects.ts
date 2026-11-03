import type { Snapshot } from "../../projects/shadow.ts";
import { button, error, h, layout, type Page, time, tryCall } from "../html.ts";

export const projects: Page = async (ctx) => {
  const list = Object.entries(ctx.config.projects);
  // non-git projects: the last 20 shadow snapshots, each restorable (two clicks)
  const snaps = await Promise.all(
    list.map(async ([name]) => {
      const r = await tryCall<Snapshot[]>("project.snapshots", { name });
      if (!r.ok) return error(r.error);
      if (!r.value.length) return h``;
      return h`<details><summary>snapshots of ${name}</summary><table><tbody>${r.value.map(
        (s) =>
          h`<tr><td>${time(s.ts)}</td><td><code>${s.sha.slice(0, 7)}</code></td><td>${s.message}</td><td class="actions">${button(
            "Restore to this",
            "project.restore",
            { name, sha: s.sha },
            { confirm: true },
          )}</td></tr>`,
      )}</tbody></table></details>`;
    }),
  );
  return layout(
    ctx,
    "projects",
    "Projects",
    h`<div data-refresh id="list">${
      list.length
        ? h`<table><thead><tr><th>Name</th><th>Path</th><th>Main</th><th>Runtime</th><th>Exclude</th><th>Origins</th><th></th></tr></thead><tbody>${list.map(
            ([name, p]) =>
              h`<tr><td>${name}</td><td><code>${p.path}</code></td><td>${p.main}</td><td>${p.runtime}</td><td>${(p.exclude ?? []).join(", ")}</td><td>${(
                p.origins ?? []
              ).join(
                ", ",
              )}</td><td class="actions">${button("Sync now (force)", "project.sync", { name, force: true }, { confirm: true })}${button(
                "Remove",
                "project.delete",
                { name },
                { confirm: true },
              )}</td></tr>`,
          )}</tbody></table>
<p class="hint">Sync now (force) overwrites the origin's main with the checkout's, even when it was rewritten; pending merges are sent to rebase. Remove keeps the origin and shadow on disk, renamed <code>.removed-&lt;time&gt;</code>.</p>
${snaps}`
        : h`<p class="empty">no projects</p>`
    }</div>
<h2>Add or change</h2><form data-call="project.set" data-reset>
<label>Name <input name="name" required></label><label>Path <input name="path" required placeholder="/absolute/path"></label>
<label>Main <input name="main" placeholder="main"></label>
<label>Runtime <select name="runtime"><option>host</option><option>vm</option></select></label>
<label>Exclude <input name="exclude" data-list placeholder="comma-separated globs"></label>
<label>Origins <input name="origins" data-list placeholder="comma-separated hosts"></label>
<button>Save</button></form>`,
  );
};
