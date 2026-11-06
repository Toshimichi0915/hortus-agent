/** `/dof/<dof>/<path>`: one mirror file, read-only, and the other files of its thread (a search hit's target). */
import { MAX_FILE, readDofFile } from "../../mirror/file.ts";
import { h, layout, type Page } from "../html.ts";

const enc = (segs: string[]) => segs.map(encodeURIComponent).join("/");

/** A hit's link: a `logs` file is its task's card, anything else this page (segments encoded: paths hold `#`). */
export const dofHref = (dof: string, path: string): string =>
  dof === "logs" ? `/tasks/${encodeURIComponent(path.split("/")[0] ?? "")}` : `/dof/${enc([dof, ...path.split("/")])}`;

export const dofFile: Page = (ctx, { m }) => {
  const no = (why: string) => layout(ctx, "search", "Not found", h`<p>${why}</p>`);
  let segs: string[];
  try {
    segs = `${m[1]}/${m[2]}`.split("/").map(decodeURIComponent);
  } catch {
    return no("bad path");
  }
  const r = readDofFile(segs);
  if ("error" in r) return no(r.error);
  const { siblings } = r;
  const [dof, ...rel] = segs as [string, ...string[]];
  const dir = rel.slice(0, -1);
  const name = rel.at(-1) as string;
  return layout(
    ctx,
    "search",
    name,
    h`<p class="hint">${dof}:${rel.join("/")} (read-only mirror)</p>${
      r.text.includes("\0") ? h`<p>binary file, ${r.size} bytes</p>` : h`<pre>${r.text}</pre>`
    }${r.size > MAX_FILE && !r.text.includes("\0") ? h`<p class="hint">first ${MAX_FILE / 1024} KB of ${r.size} bytes</p>` : ""}${
      siblings.length > 1
        ? h`<h2>In this thread</h2><ul class="hits">${siblings.map((f) =>
            f === name ? h`<li><b>${f}</b></li>` : h`<li><a href="/dof/${enc([dof, ...dir, f])}">${f}</a></li>`,
          )}</ul>`
        : ""
    }`,
  );
};
