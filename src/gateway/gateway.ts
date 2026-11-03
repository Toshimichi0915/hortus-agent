/**
 * The gateway (docs/design/02, v6 › Gateway): one runner per `dofs` entry whose type has a connector. Events:
 * trust → insert (dedupe) → ack → mirror → commit → wake. Reconcile: at start and every 10 min, `history` per scope
 * from its `syncs` cursor. Nothing here names a service.
 */
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { Config, DofConfig } from "../config.ts";
import { connectors } from "../connectors/index.ts";
import { backoff, sleep } from "../connectors/retry.ts";
import { trusted } from "../connectors/trust.ts";
import type { Module } from "../ctx.ts";
import { type DatabaseSync, now } from "../db.ts";
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

export interface GatewayDeps {
  db: DatabaseSync;
  config(): Config;
  log: Log;
  connectors: Record<string, ConnectorFactory>;
  /** the placeholder-aware fetch for DOF `name` */
  fetch(name: string): ConnectorDeps["fetch"];
  /** the mirror writer (01-mirror-search.md) */
  commit(dof: string, changes: Change[], message: string): Promise<unknown>;
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
}

interface Runner {
  cfg: DofConfig;
  ac: AbortController;
  conn?: Connector;
  error?: string;
  chain: Promise<void>;
  done: Promise<unknown>;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createGateway(deps: GatewayDeps): Gateway {
  const { db, log } = deps;
  const runners = new Map<string, Runner>();
  // a bot's event is consumed (-1) at insert: the Planner never sees it (loop guard, 15-planner.md)
  const insert = db.prepare(`INSERT INTO events(dof, key, ts, author, member, trusted, bot, payload, created, summary,
    refs, consumed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(dof, key) DO NOTHING`);
  const quiet = db.prepare("UPDATE events SET consumed = -1 WHERE dof = ? AND key = ? AND consumed = 0");
  const getCursor = db.prepare("SELECT cursor FROM syncs WHERE dof = ? AND scope = ?");
  const setCursor = db.prepare(`INSERT INTO syncs(dof, scope, cursor, last_sync) VALUES (?, ?, ?, ?)
    ON CONFLICT(dof, scope) DO UPDATE SET cursor = excluded.cursor, last_sync = excluded.last_sync`);

  async function eventsLoop(name: string, r: Runner, conn: Connector, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        for await (const { event, ack } of conn.events(signal)) {
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
                event.summary,
                JSON.stringify(event.refs),
                event.bot ? -1 : 0,
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
            if (m.changes.length) await deps.commit(name, m.changes, `sync(${name}): ${event.summary}`);
            log.info(`sync(${name}): ${event.summary} +${m.changes.length}`);
            if (m.wake && !event.bot) deps.wake();
            else quiet.run(name, event.key); // reactions, deletes, joins: mirrored, not Planner input
          } catch (e) {
            log.error(`${name}: mirror failed`, e, { key: event.key });
          }
        }
      } catch (e) {
        // ponytail: connectors must not throw out of events(); this only keeps a buggy one from ending the runner
        log.error(`${name}: events() threw`, e);
        await sleep(1000, signal);
      }
    }
  }

  async function reconcileOnce(name: string, conn: Connector, only?: string): Promise<void> {
    const history = conn.history?.bind(conn);
    if (!history) return;
    let scopes: string[];
    try {
      scopes = only ? [only] : await conn.scopes();
    } catch (e) {
      log.error(`${name}: scopes failed`, e);
      return;
    }
    for (const scope of scopes) {
      try {
        const row = getCursor.get(name, scope) as { cursor: string | null } | undefined;
        let n = 0;
        for await (const b of history(scope, row?.cursor ?? null)) {
          if (b.changes.length) await deps.commit(name, b.changes, `sync(${name}): ${scope} +${b.changes.length}`);
          setCursor.run(name, scope, b.cursor, now());
          n += b.changes.length;
        }
        log.info(`sync(${name}): ${scope} +${n}`, { reconcile: true });
      } catch (e) {
        log.error(`${name}: reconcile ${scope} failed`, e);
      }
    }
  }

  function reconcile(name: string, scope?: string): Promise<void> {
    const r = runners.get(name);
    const conn = r?.conn;
    if (!r || !conn) return Promise.resolve();
    const p = r.chain.then(() => reconcileOnce(name, conn, scope));
    r.chain = p;
    return p;
  }

  async function run(name: string, r: Runner, factory: ConnectorFactory): Promise<void> {
    const { signal } = r.ac;
    for (let i = 0; !r.conn && !signal.aborted; i++) {
      try {
        r.conn = await factory({ name, config: r.cfg, log, fetch: deps.fetch(name), hasRef: deps.hasRef });
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
      while (!signal.aborted) {
        await reconcile(name);
        await sleep(RECONCILE_MS, signal);
      }
    };
    await Promise.all([eventsLoop(name, r, conn, signal), reconcileLoop()]);
  }

  function startOne(name: string, cfg: DofConfig): void {
    const factory = deps.connectors[cfg.type];
    if (!factory) return;
    const r: Runner = { cfg, ac: new AbortController(), chain: Promise.resolve(), done: Promise.resolve() };
    runners.set(name, r);
    r.done = run(name, r, factory).catch((e) => log.error(`${name}: runner failed`, e));
  }

  async function stopOne(name: string): Promise<void> {
    const r = runners.get(name);
    if (!r) return;
    runners.delete(name);
    r.ac.abort();
    await r.done;
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
      for (const [name, r] of [...runners]) if (!isDeepStrictEqual(r.cfg, next[name])) await stopOne(name);
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
      return Object.entries(deps.config().dofs)
        .filter(([, cfg]) => deps.connectors[cfg.type])
        .map(([dof, cfg]) => {
          const r = runners.get(dof);
          const s = r?.conn?.status() ?? { connected: false, error: r?.error ?? "not started" };
          const scopes = rows
            .filter((x) => x.dof === dof)
            .map(({ scope, cursor, last_sync }) => ({ scope, cursor, last_sync }));
          return { dof, type: cfg.type, ...s, scopes };
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
  };
  return gw;
}

/** The running gateway the RPCs answer from. */
let current: Gateway | undefined;

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
const wiring: Pick<GatewayDeps, "commit" | "wake" | "hasRef" | "fetch"> = {
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
      wake: () => wiring.wake(),
      hasRef: (ref) => wiring.hasRef(ref),
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
