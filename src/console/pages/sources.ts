import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ConnectorStatus } from "../../types.ts";
import { button, error, h, layout, type Page, time, tryCall } from "../html.ts";

const sizes = new Map<string, { at: number; text: string }>();

/** `du` of the mirror worktree, cached 1 min. */
async function size(dir: string): Promise<string> {
  const c = sizes.get(dir);
  if (c && Date.now() - c.at < 60_000) return c.text;
  let text = "—";
  try {
    const { stdout } = await promisify(execFile)("du", ["-sh", dir], { timeout: 10_000 });
    text = stdout.split("\t")[0] ?? "—";
  } catch {}
  sizes.set(dir, { at: Date.now(), text });
  return text;
}

interface SyncRow {
  dof: string;
  scope: string;
  last_sync: string | null;
}

type Listed =
  | (ConnectorStatus & { name?: string; dof?: string; status?: ConnectorStatus })[]
  | Record<string, ConnectorStatus>;

export const sources: Page = async (ctx) => {
  const r = await tryCall<Listed>("source.list", {});
  const status = new Map<string, ConnectorStatus>();
  if (r.ok && Array.isArray(r.value)) for (const s of r.value) status.set(s.name ?? s.dof ?? "", s.status ?? s);
  else if (r.ok) for (const [k, v] of Object.entries(r.value ?? {})) status.set(k, v);
  const syncs = ctx.db
    .prepare("SELECT dof, scope, last_sync FROM syncs ORDER BY dof, scope")
    .all() as unknown as SyncRow[];
  const names = [...new Set([...Object.keys(ctx.config.dofs), ...status.keys(), ...syncs.map((s) => s.dof)])].filter(
    Boolean,
  );
  const rows = await Promise.all(
    names.map(async (name) => {
      const s = status.get(name);
      const scopes = syncs.filter((x) => x.dof === name);
      return h`<section class="source"><h2>${name}</h2><p>${
        s ? (s.connected ? "connected" : "disconnected") : "status unknown"
      } · last event ${time(s?.lastEvent)} · mirror ${await size(ctx.paths.dof(name))}</p>${
        s?.error ? h`<p class="error">${s.error}</p>` : ""
      }${(s?.notes ?? []).map((n) => h`<p class="hint">${n}</p>`)}${
        scopes.length
          ? h`<table><thead><tr><th>Scope</th><th>Last sync</th><th></th></tr></thead><tbody>${scopes.map(
              (x) =>
                h`<tr><td>${x.scope}</td><td>${time(x.last_sync)}</td><td>${button("Resync", "source.resync", {
                  dof: name,
                  scope: x.scope,
                })}</td></tr>`,
            )}</tbody></table>`
          : ""
      }</section>`;
    }),
  );
  const tf = await tryCall<{ notes: string[] }>("transforms.status", {});
  const tfNotes = tf.ok ? tf.value.notes.map((n) => h`<p class="error">${n}</p>`) : [];
  return layout(
    ctx,
    "sources",
    "Sources",
    h`<div data-refresh id="list">${r.ok ? "" : error(r.error)}${tfNotes}${rows.length ? rows : h`<p class="empty">no sources</p>`}</div>`,
  );
};
