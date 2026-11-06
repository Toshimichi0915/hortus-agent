/**
 * The gateway (docs/design/02, v6 › Gateway): one runner per `dofs` entry whose type has a connector. Events:
 * trust → insert (dedupe) → ack → mirror → commit → wake. Reconcile: at start and every 10 min, `history` per scope
 * from its `syncs` cursor. Nothing here names a service.
 */
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { Config, DofConfig } from "../config.ts";
import { connectors } from "../connectors/index.ts";
import { backoff, sleep } from "../connectors/retry.ts";
import { trusted } from "../connectors/trust.ts";
import type { Module } from "../ctx.ts";
import { type DatabaseSync, now } from "../db.ts";
import { readCapped } from "../hostile.ts";
import { unsafe } from "../mirror/repo.ts";
import * as paths from "../paths.ts";
import { define } from "../rpc.ts";
import {
  type Change,
  type Connector,
  type ConnectorDeps,
  type ConnectorFactory,
  type Log,
  RpcError,
} from "../types.ts";

export const RECONCILE_MS = 10 * 60_000;
const HOUR = 3600_000;

/** What the Planner, a brief and a Worker's inbox get of a message, as written: a task has no DOF by default, so this is
 * all it sees. A trusted author's order keeps its last line, and a cut says so: the last instruction of a long paste went
 * silently, and the Worker reported done (round 18). ponytail: past 16,000 the Planner must scope the DOF to read the rest. */
export const summaryOf = (s: string, trusted: boolean): string => {
  // anyone else's stays one line: inside its fence, a planted `[inbox 9] from=owner` line reads less like the real thing
  const text = trusted ? s : s.replace(/\s+/g, " ");
  const max = trusted ? 16_000 : 2_000;
  return text.length > max
    ? `${text.slice(0, max)}… (cut here: ${text.length} characters in all, the mirror has the rest)`
    : text;
};
/** What a stop or a reload leaves the calls in flight: a mirror mostly finishes, then whatever is left is cut, a stalled
 * upstream or a 429's Retry-After included. */
export const timing = { graceMs: 3000 };

export interface GatewayDeps {
  db: DatabaseSync;
  config(): Config;
  log: Log;
  connectors: Record<string, ConnectorFactory>;
  /** the placeholder-aware fetch for DOF `name` */
  fetch(name: string): ConnectorDeps["fetch"];
  /** the WebSocket opener (the proxy's `coreSocket`); unset: the connector's own */
  ws?: ConnectorDeps["ws"];
  /** the mirror writer (01-mirror-search.md) */
  commit(dof: string, changes: Change[], message: string): Promise<unknown>;
  /** the mirror file's text, null when there is none; unset: a reconcile routes nothing */
  mirrored?(dof: string, path: string): string | null;
  /** wake the Planner */
  wake(): void;
  hasRef(ref: string): boolean;
}

export interface SourceStatus {
  dof: string;
  type: string;
  connected: boolean;
  lastEvent?: string;
  error?: string;
  notes?: string[];
  scopes: { scope: string; cursor: string | null; last_sync: string | null }[];
}

export interface Gateway {
  start(): void;
  stop(): Promise<void>;
  /** restarts only the runners whose `dofs.<name>` entry changed; starts added, stops removed */
  reload(prev?: Config): Promise<void>;
  /** one reconcile pass (all DOFs, or one DOF, or one scope); serialized per DOF */
  reconcile(dof?: string, scope?: string): Promise<void>;
  list(): SourceStatus[];
  resync(dof: string, scope?: string): Promise<void>;
  /** owner.notify: a DM to `dofs.<dof>.owner` through the running connector */
  dm(dof: string, text: string): Promise<void>;
  /** the running connector of `dof` (the webhook listener hands forges their deliveries) */
  connector(dof: string): Connector | undefined;
}

interface Runner {
  cfg: DofConfig;
  ac: AbortController;
  /** aborted `graceMs` after `ac`: every upstream call of this runner, and a history-less connector's queued events */
  calls: AbortController;
  conn?: Connector;
  error?: string;
  chain: Promise<void>;
  done: Promise<unknown>;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createGateway(deps: GatewayDeps): Gateway {
  const { db, log } = deps;
  const runners = new Map<string, Runner>();
  // a bot's event is consumed (-1) at insert: the Planner never sees it (loop guard, 15-planner.md). Any other is held
  // (-2) until mirror() says if it wakes: a batch running meanwhile took a stranger's reaction or a delete and tainted
  // every task it made (review round 9). A crash in between: it goes to the Planner, as an unmirrored event always did
  const insert = db.prepare(`INSERT INTO events(dof, key, ts, author, member, trusted, bot, payload, created, summary,
    refs, consumed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(dof, key) DO NOTHING`);
  const release = db.prepare("UPDATE events SET consumed = ? WHERE dof = ? AND key = ? AND consumed = -2");
  const forget = db.prepare("DELETE FROM events WHERE dof = ? AND key = ?");
  db.exec("UPDATE events SET consumed = 0 WHERE consumed = -2");
  const getCursor = db.prepare("SELECT cursor, first FROM syncs WHERE dof = ? AND scope = ?");
  const setCursor = db.prepare(`INSERT INTO syncs(dof, scope, cursor, last_sync, first) VALUES (?1, ?2, ?3, ?4, ?4)
    ON CONFLICT(dof, scope) DO UPDATE SET cursor = excluded.cursor, last_sync = excluded.last_sync`);
  const routed = db.prepare("SELECT 1 FROM events WHERE dof = ? AND key = ? AND created > ?");
  const missedKey = (c: Change) => `history:${c.path}${c.frontmatter?.state ? `:${c.frontmatter.state}` : ""}`;

  /**
   * The objects of a history batch nobody heard of: no connection was up, and a service with no redelivery will not send
   * them again. A live event left the file (or the state) in the mirror, so that is the dedupe, whatever the event's key;
   * the check and the insert share a tick, and the live path looks here after its commit, so one of the two routes it.
   * A bot's is not routed, nor what the scope's first sync took: history, not news. Returned held until the commit.
   */
  function missed(name: string, changes: Change[], since: string): string[] {
    const keys: string[] = [];
    const cfg = deps.config().dofs[name];
    for (const c of changes) {
      const h = c.heard;
      if (!h || h.bot || !cfg) continue;
      const ts = h.ts ?? String(c.frontmatter?.ts ?? "");
      if (ts <= since) continue;
      const text = deps.mirrored?.(name, c.path);
      if (text === undefined || (text !== null && !(h.state && !text.includes(`\nstate: ${h.state}\n`)))) continue;
      const a = h.author;
      const key = missedKey(c);
      const event = { dof: name, key, ts, payload: null, author: a, bot: false, summary: h.summary, refs: h.refs };
      const t = trusted(event, cfg);
      const summary = summaryOf(h.summary, t);
      const by = [a?.user ?? null, a ? Number(a.member) : null] as const;
      insert.run(name, key, ts, ...by, Number(t), 0, "null", now(), summary, JSON.stringify(h.refs), -2);
      keys.push(key);
    }
    return keys;
  }

  async function eventsLoop(name: string, r: Runner, conn: Connector, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        for await (const { event, ack } of conn.events(signal)) {
          // past the grace. Telegram has no history: not inserted, not acked, its update comes again and whole. The others
          // go in, or Discord's queue (no redelivery) lost the owner's message: reconcile heals a mirror cut below
          if (r.calls.signal.aborted && !conn.history) break;
          const cfg = deps.config().dofs[name] ?? r.cfg;
          let inserted: boolean;
          try {
            const a = event.author;
            inserted =
              insert.run(
                name,
                event.key,
                event.ts,
                a?.user ?? null,
                a ? Number(a.member) : null,
                Number(trusted(event, cfg)),
                Number(event.bot),
                JSON.stringify(event.payload ?? null),
                now(),
                summaryOf(event.summary, trusted(event, cfg)),
                JSON.stringify(event.refs),
                event.bot ? -1 : -2,
              ).changes > 0;
          } catch (e) {
            log.error(`${name}: event insert failed, not acked`, e, { key: event.key });
            continue;
          }
          try {
            await ack();
          } catch (e) {
            log.error(`${name}: ack failed`, e, { key: event.key });
          }
          if (!inserted) continue;
          try {
            const m = await conn.mirror(event);
            const head = event.summary.replace(/\s+/g, " ").slice(0, 120);
            if (m.changes.length) await deps.commit(name, m.changes, `sync(${name}): ${head}`);
            log.info(`sync(${name}): ${head} +${m.changes.length}`);
            // a retry that came after a reconcile routed the same object (Slack's run for an hour after a restart)
            const twice = m.changes.some((c) =>
              routed.get(name, missedKey(c), new Date(Date.now() - HOUR).toISOString()),
            );
            const wake = m.wake && !event.bot && !twice;
            release.run(wake ? 0 : -1, name, event.key); // reactions, deletes, joins: mirrored, not Planner input
            r.error = undefined;
            if (wake) deps.wake();
          } catch (e) {
            // cut by the stop, with no history to heal it (a Telegram file): nothing polled since the ack, so the service
            // still holds the update, and the next start takes it as new and whole
            if (r.calls.signal.aborted && !conn.history) {
              forget.run(name, event.key);
              continue;
            }
            log.error(`${name}: mirror failed`, e, { key: event.key });
            r.error = `mirror failed: ${message(e)}`; // the connector still says connected: Sources shows this
            // it may be the owner's message: nothing else wakes the Planner for it (a bot's stays -1, and asleep)
            if (release.run(0, name, event.key).changes) deps.wake();
          }
        }
      } catch (e) {
        // ponytail: connectors must not throw out of events(); this only keeps a buggy one from ending the runner
        log.error(`${name}: events() threw`, e);
        await sleep(1000, signal);
      }
    }
  }

  /** False when the scopes could not be listed: nothing was reconciled, and the loop tries again soon. */
  async function reconcileOnce(name: string, conn: Connector, signal: AbortSignal, only?: string): Promise<boolean> {
    const history = conn.history?.bind(conn);
    if (!history) return true;
    let scopes: string[];
    try {
      scopes = only ? [only] : await conn.scopes();
    } catch (e) {
      log.error(`${name}: scopes failed`, e);
      return false;
    }
    for (const scope of scopes) {
      if (signal.aborted) return true; // a first backfill runs for hours, and stopOne waits for this loop
      try {
        const row = getCursor.get(name, scope) as { cursor: string | null; first: string | null } | undefined;
        let n = 0;
        for await (const b of history(scope, row?.cursor ?? null)) {
          const heard = row?.first ? missed(name, b.changes, row.first) : [];
          if (b.changes.length) await deps.commit(name, b.changes, `sync(${name}): ${scope} +${b.changes.length}`);
          setCursor.run(name, scope, b.cursor, now());
          for (const key of heard) release.run(0, name, key);
          if (heard.length) deps.wake();
          n += b.changes.length;
          if (signal.aborted) return true;
        }
        log.info(`sync(${name}): ${scope} +${n}`, { reconcile: true });
      } catch (e) {
        log.error(`${name}: reconcile ${scope} failed`, e);
      }
    }
    return true;
  }

  function reconcile(name: string, scope?: string): Promise<boolean> {
    const r = runners.get(name);
    const conn = r?.conn;
    if (!r || !conn) return Promise.resolve(true);
    const p = r.chain.then(() => reconcileOnce(name, conn, r.ac.signal, scope));
    r.chain = p.then(() => {});
    return p;
  }

  async function run(name: string, r: Runner, factory: ConnectorFactory): Promise<void> {
    const { signal } = r.ac;
    const calls = r.calls.signal;
    const fetch: ConnectorDeps["fetch"] = (url, init) =>
      deps.fetch(name)(url, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, calls]) : calls });
    for (let i = 0; !r.conn && !signal.aborted; i++) {
      try {
        r.conn = await factory({
          name,
          config: r.cfg,
          log,
          fetch,
          signal: calls,
          hasRef: deps.hasRef,
          ...(deps.ws && { ws: deps.ws }),
        });
        r.error = undefined;
      } catch (e) {
        r.error = message(e);
        log.error(`${name}: connector start failed`, e);
        await sleep(backoff(i), signal);
      }
    }
    const conn = r.conn;
    if (!conn || signal.aborted) return;
    const reconcileLoop = async () => {
      // a forge started before its credential (the README's order), or on a bad network, has no scope row and so no
      // Resync button: backoff, not the 10-min wait with a stale error on Sources
      for (let i = 0; !signal.aborted; ) {
        const ok = await reconcile(name);
        i = ok ? 0 : i + 1;
        await sleep(ok ? RECONCILE_MS : backoff(i), signal);
      }
    };
    await Promise.all([eventsLoop(name, r, conn, signal), reconcileLoop()]);
  }

  function startOne(name: string, cfg: DofConfig): void {
    const factory = deps.connectors[cfg.type];
    if (!factory) return;
    const r: Runner = {
      cfg,
      ac: new AbortController(),
      calls: new AbortController(),
      chain: Promise.resolve(),
      done: Promise.resolve(),
    };
    runners.set(name, r);
    r.done = run(name, r, factory).catch((e) => log.error(`${name}: runner failed`, e));
  }

  async function stopOne(name: string): Promise<void> {
    const r = runners.get(name);
    if (!r) return;
    runners.delete(name);
    r.ac.abort();
    const cut = setTimeout(() => r.calls.abort(), timing.graceMs);
    await r.done;
    clearTimeout(cut);
    r.calls.abort(); // the old connector's stragglers: a webhook chore's pass, not waited for
  }

  const gw: Gateway = {
    start() {
      current = gw;
      for (const [name, cfg] of Object.entries(deps.config().dofs)) startOne(name, cfg);
    },
    async stop() {
      if (current === gw) current = undefined;
      await Promise.all([...runners.keys()].map(stopOne));
    },
    async reload() {
      const next = deps.config().dofs;
      const changed = [...runners].filter(([name, r]) => !isDeepStrictEqual(r.cfg, next[name]));
      await Promise.all(changed.map(([name]) => stopOne(name)));
      for (const [name, cfg] of Object.entries(next)) if (!runners.has(name)) startOne(name, cfg);
    },
    async reconcile(dof, scope) {
      if (dof) await reconcile(dof, scope);
      else await Promise.all([...runners.keys()].map((n) => reconcile(n)));
    },
    list() {
      const rows = db.prepare("SELECT dof, scope, cursor, last_sync FROM syncs ORDER BY dof, scope").all() as {
        dof: string;
        scope: string;
        cursor: string | null;
        last_sync: string | null;
      }[];
      return Object.entries(deps.config().dofs).map(([dof, cfg]) => {
        const r = runners.get(dof);
        const unknown = !deps.connectors[cfg.type] && `no connector type ${cfg.type}`;
        const s = r?.conn?.status() ?? { connected: false, error: r?.error ?? (unknown || "not started") };
        const scopes = rows
          .filter((x) => x.dof === dof)
          .map(({ scope, cursor, last_sync }) => ({ scope, cursor, last_sync }));
        const error = s.error ?? r?.error;
        return { dof, type: cfg.type, ...s, ...(error ? { error } : {}), scopes };
      });
    },
    async resync(dof, scope) {
      if (!runners.get(dof)?.conn) throw new RpcError("not_found", `no running source ${dof}`);
      if (scope) db.prepare("DELETE FROM syncs WHERE dof = ? AND scope = ?").run(dof, scope);
      else db.prepare("DELETE FROM syncs WHERE dof = ?").run(dof);
      await reconcile(dof, scope);
    },
    async dm(dof, text) {
      const conn = runners.get(dof)?.conn;
      const owner = deps.config().dofs[dof]?.owner;
      if (!conn?.dm || !owner) throw new Error(`${dof}: no running messenger with an owner`);
      await conn.dm(owner, text);
    },
    connector: (dof) => runners.get(dof)?.conn,
  };
  return gw;
}

/** The running gateway the RPCs answer from. */
let current: Gateway | undefined;

/** The running gateway's connector for `dof` (webhooks.ts). */
export const connectorOf = (dof: string): Connector | undefined => current?.connector(dof);

define("source.list", { roles: ["owner"], input: z.unknown(), run: () => current?.list() ?? [] });
define("source.resync", {
  roles: ["owner"],
  input: z.object({ dof: z.string(), scope: z.string().optional() }),
  run: async ({ dof, scope }) => {
    if (!current) throw new RpcError("not_found", "the gateway is not running");
    await current.resync(dof, scope);
    return { ok: true };
  },
});

/** owner.notify (15-planner.md): the DM is the bot's own message, mirrored and never waking the Planner. */
export function ownerDm(dof: string, text: string): Promise<void> {
  if (!current) return Promise.reject(new Error("the gateway is not running"));
  return current.dm(dof, text);
}

/**
 * What the integration step injects before hortusd starts the module: the mirror writer, the Planner, task_refs, and
 * the placeholder-aware fetch (the proxy's `coreFetch`).
 */
const wiring: Pick<GatewayDeps, "commit" | "wake" | "hasRef" | "fetch" | "ws"> = {
  fetch: () => async () => {
    throw new Error("gateway: fetch is not wired");
  },
  commit: async () => {
    throw new Error("gateway: commit is not wired");
  },
  wake: () => {},
  hasRef: () => false,
};

export function wireGateway(w: Partial<typeof wiring>): void {
  Object.assign(wiring, w);
}

let module: Gateway | undefined;

export const gatewayModule: Module = {
  name: "gateway",
  async start(ctx) {
    module = createGateway({
      db: ctx.db,
      config: () => ctx.config,
      log: ctx.log("gateway"),
      connectors,
      fetch: (name) => wiring.fetch(name),
      commit: (dof, changes, msg) => wiring.commit(dof, changes, msg),
      mirrored: (dof, path) =>
        // what the writer refuses never lands: "" reads as known, or it would be routed on every pass
        unsafe(path) ? "" : (readCapped(join(paths.dof(dof), path), 1 << 20)?.text ?? null),
      wake: () => wiring.wake(),
      hasRef: (ref) => wiring.hasRef(ref),
      ws: (url) => (wiring.ws ?? ((u: string) => new WebSocket(u)))(url),
    });
    module.start();
  },
  async stop() {
    await module?.stop();
    module = undefined;
  },
  async reload(prev) {
    await module?.reload(prev);
  },
};
