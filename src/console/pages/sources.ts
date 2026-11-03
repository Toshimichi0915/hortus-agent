import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PlannerStatus } from "../../planner/planner.ts";
import type { Ctx } from "../../ctx.ts";
import { forgeState } from "../../gateway/webhooks.ts";
import type { ConnectorStatus } from "../../types.ts";
import { read as readVault } from "../../vault/vault.ts";
import { button, error, h, layout, type Page, type Raw, time, tryCall } from "../html.ts";

/** A forge's rows (17-github.md): installation, deliveries, the redelivery check, the URL to give the App. */
function forgeRows(ctx: Ctx, name: string): Raw {
  const e = readVault()[name];
  const inst =
    e?.type === "github-app" ? `App ${e.appId}, installation ${e.installationId}` : "no github-app credential";
  const q = ctx.db.prepare("SELECT count(*) AS n, max(created) AS last FROM events WHERE dof = ? AND created >= ?");
  const today = q.get(name, new Date().toISOString().slice(0, 10)) as { n: number; last: string | null };
  const day = q.get(name, new Date(Date.now() - 86400_000).toISOString()) as { n: number; last: string | null };
  const last = (ctx.db.prepare("SELECT max(created) AS t FROM events WHERE dof = ?").get(name) as { t: string | null })
    .t;
  const st = forgeState(name);
  const missed = st?.missed ?? 0;
  return h`<p>installation: ${inst} · deliveries today ${today.n} · last delivery ${time(last)} · last redelivery check ${time(
    st?.lastRedelivery,
  )}</p><p class="hint">Webhook URL for the App: <code>https://&lt;your tunnel&gt;/${name}/webhook</code> (secret: the <code>${name}-webhook</code> credential). The tunnel forwards to <code>http://127.0.0.1:7701</code>: <code>cloudflared tunnel --url http://127.0.0.1:7701</code> or <code>ssh -R</code>; hortus installs neither.</p>${
    missed && !day.n
      ? h`<p class="error">no deliveries in 24 h while events were expected (${missed} found only in the delivery log)</p>`
      : missed
        ? h`<p class="error">${missed} deliveries arrived only through the redelivery check: check the tunnel</p>`
        : ""
  }`;
}

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
        ctx.config.dofs[name]?.type === "github" ? forgeRows(ctx, name) : ""
      }${
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
  const ps = await tryCall<PlannerStatus>("planner.status", {});
  const p = ps.ok ? ps.value : undefined;
  const pc = ctx.config.planner;
  // the batch loop only logs these: the owner should see why nothing is routed
  const unset =
    !pc.provider || !pc.model
      ? "planner.provider and planner.model are not set (Settings): no batch runs"
      : !readVault()[pc.provider]
        ? `planner.provider ${pc.provider} is not a credential (Credentials): no batch runs`
        : "";
  const planner = !p
    ? ""
    : h`<section class="source" id="planner"><h2>Planner</h2>${unset ? error(unset) : ""}<p>last batch ${time(p.last)} · events routed today ${String(
        p.routed,
      )} · tokens today ${p.tokens.toLocaleString("en")} / ${p.cap.toLocaleString("en")}${p.tokens >= p.cap ? " (cap reached: batches skipped)" : ""}</p></section>`;
  return layout(
    ctx,
    "sources",
    "Sources",
    h`<div data-refresh id="list">${r.ok ? "" : error(r.error)}${tfNotes}${planner}${rows.length ? rows : h`<p class="empty">no sources</p>`}</div>`,
  );
};
