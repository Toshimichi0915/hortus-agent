/**
 * The webhook listener and the forge chores the gateway loop does not know (v6 › Gateway):
 * `POST /<dof>/webhook` on `127.0.0.1:7701` (`HORTUS_WEBHOOK_PORT`; the owner's tunnel forwards to it) → the forge
 * verifies and parses → the event joins that connector's queue, which its `events()` yields into the gateway loop →
 * `200` once the gateway inserted it (or found the duplicate), before any mirror work. Push events and the 10-min
 * poll fetch the repo mirrors; every hour the delivery log is checked for what never arrived.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Config } from "../config.ts";
import type { Module } from "../ctx.ts";
import { type DatabaseSync, now } from "../db.ts";
import { fetchRepo } from "../projects/repos.ts";
import { coreFetch } from "../proxy/index.ts";
import { localWebhook } from "../runtime/net.ts";
import type { Connector, Event, Forge, Log } from "../types.ts";
import { connectorOf } from "./gateway.ts";

export const MAX_BODY = 25 * 1024 * 1024;
/** request bodies held at once, over every delivery in flight */
export const MAX_INFLIGHT = 4 * MAX_BODY;
let inflight = 0;
export const POLL_MS = 10 * 60_000;
export const REDELIVER_MS = 3600_000;
/** the delivery log's retention */
const LOG_MS = 3 * 86400_000;
/** an event the gateway loop has not taken by then is answered 503 (it is still queued; GitHub's log has it too) */
const ACK_MS = 10_000;

export interface WebhookDeps {
  db: DatabaseSync;
  config(): Config;
  log: Log;
  /** the running connector of `dof` */
  connector(dof: string): Connector | undefined;
  fetchRepo(dof: string, project: string, cloneUrl: string): Promise<void>;
}

export interface ForgeState {
  /** ISO time of the last hourly check */
  lastRedelivery?: string;
  /** deliveries that check found in the log but never in `events` */
  missed: number;
}

export interface Webhooks {
  /** binds 127.0.0.1:`port` (0 = ephemeral); returns the bound port */
  start(port: number): Promise<number>;
  stop(): Promise<void>;
  redeliver(dof?: string): Promise<void>;
  poll(dof?: string): Promise<void>;
  state: Map<string, ForgeState>;
  port?: number;
}

export const isForge = (c: Connector | undefined): c is Forge => !!c && "webhook" in c && "enqueue" in c;

export function createWebhooks(deps: WebhookDeps): Webhooks {
  const { log } = deps;
  const seen = deps.db.prepare("SELECT 1 FROM events WHERE dof = ? AND key = ?");
  const state = new Map<string, ForgeState>();
  const timers: NodeJS.Timeout[] = [];
  let server: http.Server | undefined;

  const forgeOf = (dof: string): Forge | undefined => {
    if (!deps.config().dofs[dof]) return undefined;
    const c = deps.connector(dof);
    return isForge(c) ? c : undefined;
  };
  const forges = (only?: string) => (only ? [only] : Object.keys(deps.config().dofs)).filter((d) => forgeOf(d));

  /** Queue `event`; true once the gateway inserted it. A push also fetches the repo mirror. */
  async function route(dof: string, forge: Forge, event: Event): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const acked = await Promise.race([
      forge.enqueue(event).then(() => true),
      new Promise<false>((r) => {
        timer = setTimeout(() => r(false), ACK_MS);
      }),
    ]);
    clearTimeout(timer);
    const p = forge.pushed(event);
    if (p) deps.fetchRepo(dof, p, forge.clone(p)).catch((e) => log.error(`${dof}: repo mirror ${p} failed`, e));
    return acked;
  }

  async function onRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const end = (status: number) => void res.writeHead(status, { "content-type": "text/plain" }).end(`${status}\n`);
    const dof = req.url?.match(/^\/([^/?]+)\/webhook(?:\?|$)/)?.[1];
    const forge = dof ? forgeOf(dof) : undefined;
    const refuse = (status: number) => {
      req.resume();
      end(status);
    };
    if (req.method !== "POST" || !dof || !forge) return refuse(404);
    if (Number(req.headers["content-length"] ?? 0) > MAX_BODY) return refuse(413);
    const chunks: Buffer[] = [];
    let n = 0;
    let held = 0;
    let busy = false;
    // the tunnel is the internet's way in and the signature is checked after the body: every unsigned 25 MB POST
    // in flight is held at once, so the sum is capped (past it: 503, GitHub retries from its delivery log)
    try {
      for await (const c of req as AsyncIterable<Buffer>) {
        n += c.length;
        if (n > MAX_BODY) continue;
        if (inflight + c.length > MAX_INFLIGHT) {
          busy = true;
          break;
        }
        inflight += c.length;
        held += c.length;
        chunks.push(c);
      }
    } finally {
      inflight -= held;
    }
    if (busy) return end(503);
    if (n > MAX_BODY) return end(413);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers[k] = [v].flat().join(", ");
    const body = Buffer.concat(chunks);
    chunks.length = 0;
    const r = await forge.webhook({ headers, body });
    if (!r.ok) return end(401);
    if (r.event && !(await route(dof, forge, r.event))) return end(503);
    end(200);
  }

  async function redeliver(only?: string): Promise<void> {
    for (const dof of forges(only)) {
      const forge = forgeOf(dof);
      if (!forge?.redeliveries) continue;
      let missed = 0;
      try {
        const since = new Date(Date.now() - LOG_MS).toISOString();
        for await (const { event } of forge.redeliveries(since, (k) => seen.get(dof, k) !== undefined)) {
          missed++;
          await route(dof, forge, event);
        }
        state.set(dof, { lastRedelivery: now(), missed });
        if (missed) log.info(`${dof}: redelivered ${missed} missed deliveries`);
      } catch (e) {
        log.error(`${dof}: redelivery check failed`, e);
      }
    }
  }

  async function poll(only?: string): Promise<void> {
    for (const dof of forges(only)) {
      const forge = forgeOf(dof);
      if (!forge) continue;
      try {
        for (const p of await forge.projects())
          await deps.fetchRepo(dof, p, forge.clone(p)).catch((e) => log.error(`${dof}: repo mirror ${p} failed`, e));
      } catch (e) {
        log.error(`${dof}: projects failed`, e);
      }
    }
  }

  const wh: Webhooks = {
    state,
    redeliver,
    poll,
    async start(port) {
      server = http.createServer((req, res) => {
        onRequest(req, res).catch((e) => {
          log.error("webhook failed", e);
          if (!res.headersSent) res.writeHead(500).end();
        });
      });
      await new Promise<void>((resolve, reject) => {
        server?.once("error", reject);
        server?.listen(port, "127.0.0.1", () => resolve());
      });
      wh.port = (server.address() as AddressInfo).port;
      // the first pass waits for the connectors to start; then every 10 min / hour
      const every = (ms: number, f: () => Promise<void>) => {
        timers.push(setTimeout(() => void f(), 10_000).unref(), setInterval(() => void f(), ms).unref());
      };
      every(POLL_MS, () => poll());
      every(REDELIVER_MS, () => redeliver());
      log.info("listening", { port: wh.port });
      return wh.port;
    },
    async stop() {
      for (const t of timers) clearTimeout(t);
      const s = server;
      server = undefined;
      if (!s) return;
      s.closeAllConnections();
      await new Promise<void>((r) => s.close(() => r()));
    },
  };
  return wh;
}

let module: Webhooks | undefined;

/** The Sources page's forge rows. */
export const forgeState = (dof: string): ForgeState | undefined => module?.state.get(dof);

export const webhooksModule: Module = {
  name: "webhooks",
  async start(ctx) {
    module = createWebhooks({
      db: ctx.db,
      config: () => ctx.config,
      log: ctx.log("webhooks"),
      connector: connectorOf,
      fetchRepo: (dof, project, url) => fetchRepo(dof, project, url, coreFetch),
    });
    // ponytail: a busy port is logged, not fatal (parallel test daemons); the Sources page then shows no deliveries
    await module
      .start(Number(process.env.HORTUS_WEBHOOK_PORT ?? 7701))
      .then((port) => {
        localWebhook.port = port; // dropped for sessions, like the console
      })
      .catch((e) => ctx.log("webhooks").error("listen failed", e));
  },
  async stop() {
    await module?.stop();
    module = undefined;
  },
};
