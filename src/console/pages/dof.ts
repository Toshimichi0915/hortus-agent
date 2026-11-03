/** `/dof/<dof>/<path>`: one mirror file, read-only, and the other files of its thread (a search hit's target). */
import { readdirSync, realpathSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { readCapped } from "../../hostile.ts";
import { h, layout, type Page } from "../html.ts";

const MAX = 1024 * 1024;
const enc = (segs: string[]) => segs.map(encodeURIComponent).join("/");

/** A hit's link: a `logs` file is its task's card, anything else this page (segments encoded: paths hold `#`). */
export const dofHref = (dof: string, path: string): string =>
  dof === "logs" ? `/tasks/${encodeURIComponent(path.split("/")[0] ?? "")}` : `/dof/${enc([dof, ...path.split("/")])}`;

/** Decoded segments, or null for anything that could leave the DOF root. */
function segments(raw: string): string[] | null {
  try {
    const segs = raw.split("/").map(decodeURIComponent);
    return segs.every((s) => s && s !== "." && s !== ".." && !/[/\\\0]/.test(s)) ? segs : null;
  } catch {
    return null;
  }
}

export const dofFile: Page = (ctx, { m }) => {
  const segs = segments(`${m[1]}/${m[2]}`);
  const no = (why: string) => layout(ctx, "search", "Not found", h`<p>${why}</p>`);
  if (!segs) return no("bad path");
  const [dof, ...rel] = segs as [string, ...string[]];
  // `dof/<name>.git` (the mirror's bare repo) and dot-entries sit next to the worktrees: not a DOF
  if (dof.startsWith(".") || dof.endsWith(".git")) return no(`no DOF ${dof}`);
  const root = ctx.paths.dof(dof);
  const file = join(root, ...rel);
  let real: string;
  try {
    real = realpathSync(file);
    if (!real.startsWith(realpathSync(root) + sep)) return no("outside the DOF");
  } catch {
    return no(`no file ${rel.join("/")} in ${dof}`);
  }
  // the mirror is written from hostile sources: no links (realpath above only bounds the directories), capped
  const r = readCapped(file, MAX);
  if (!r) return no(`not a regular file: ${rel.join("/")}`);
  let siblings: string[] = [];
  try {
    siblings = readdirSync(dirname(real), { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => d.name)
      .sort();
  } catch {}
  const dir = rel.slice(0, -1);
  const name = rel.at(-1) as string;
  return layout(
    ctx,
    "search",
    name,
    h`<p class="hint">${dof}:${rel.join("/")} (read-only mirror)</p>${
      r.text.includes("\0") ? h`<p>binary file, ${r.size} bytes</p>` : h`<pre>${r.text}</pre>`
    }${r.size > MAX && !r.text.includes("\0") ? h`<p class="hint">first ${MAX / 1024} KB of ${r.size} bytes</p>` : ""}${
      siblings.length > 1
        ? h`<h2>In this thread</h2><ul class="hits">${siblings.map((f) =>
            f === name ? h`<li><b>${f}</b></li>` : h`<li><a href="/dof/${enc([dof, ...dir, f])}">${f}</a></li>`,
          )}</ul>`
        : ""
    }`,
  );
};
