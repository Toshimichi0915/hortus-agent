import { button, h, layout, type Page } from "../html.ts";

export const projects: Page = (ctx) => {
  const list = Object.entries(ctx.config.projects);
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
              ).join(", ")}</td><td class="actions">${button("Sync", "project.sync", { name, force: true })}${button(
                "Remove",
                "project.delete",
                { name },
                { confirm: true },
              )}</td></tr>`,
          )}</tbody></table>`
        : h`<p class="empty">no projects</p>`
    }</div>
<h2>Add or change</h2><form data-call="project.set" data-reset>
<label>Name <input name="name" required></label><label>Path <input name="path" required></label>
<label>Main <input name="main" placeholder="main"></label>
<label>Runtime <select name="runtime"><option>host</option><option>vm</option></select></label>
<label>Exclude <input name="exclude" data-list placeholder="comma-separated globs"></label>
<label>Origins <input name="origins" data-list placeholder="comma-separated hosts"></label>
<button>Save</button></form>`,
  );
};
