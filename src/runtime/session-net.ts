/**
 * A host session's network identity: 10.77.1.<n> on the dummy interface, a proxy listener set on it, a `links` row
 * (the proxy finds the session by the local address it was reached at) and the cgroup's nftables rules.
 */
import type { DatabaseSync } from "../db.ts";
import { logger } from "../log.ts";
import type { Role } from "../types.ts";
import * as net from "./net.ts";

export interface SessionNetDeps {
  db: DatabaseSync;
  /** F3's server: bind / close the tls, http and dns listeners on one address */
  proxy: { listen(address: string): Promise<void>; unlisten(address: string): Promise<void> };
  /** F3's links registry (writes and caches the `links` row) */
  links: {
    register(address: string, role: Role, task: string, kind: string): unknown;
    release(address: string): unknown;
  };
}

const log = logger("session-net");
let deps: SessionNetDeps | undefined;
/** task → address, also holding addresses between allocation and `links.register` */
const open_ = new Map<string, string>();

export function init(d: SessionNetDeps): void {
  deps = d;
}

/**
 * Allocate and wire a session address (or wire `fixed`: the dev-only `dev.link`); null under HORTUS_NO_NET=1 (no
 * listener, no rules: tests only).
 */
export async function open(
  task: string,
  role: Role,
  cgroupPath: string,
  chatAllow: string[],
  fixed?: string,
): Promise<string | null> {
  if (process.env.HORTUS_NO_NET === "1") {
    log.info("HORTUS_NO_NET=1: no session address", { task });
    return null;
  }
  if (!deps) throw new Error("session-net: init() was not called");
  const rows = deps.db.prepare("SELECT address FROM links").all() as { address: string }[];
  const taken = new Set([...rows.map((r) => r.address), ...open_.values()]);
  let address = fixed;
  for (let n = 2; n <= 254 && !address; n++) if (!taken.has(`10.77.1.${n}`)) address = `10.77.1.${n}`;
  if (!address) throw new Error("no session address free");
  open_.set(task, address);
  try {
    await net.addAddress(address);
    await deps.proxy.listen(address);
    await deps.links.register(address, role, task, "session");
    await net.sessionRules(task, cgroupPath, address, chatAllow);
  } catch (e) {
    await close(task).catch((err) => log.error("rollback failed", err, { task }));
    throw e;
  }
  return address;
}

/** Release everything `open` set up; safe to call twice and after a partial `open`. */
export async function close(task: string): Promise<void> {
  if (process.env.HORTUS_NO_NET === "1" || !deps) return;
  const row = deps.db.prepare("SELECT address FROM links WHERE task_id = ? AND kind = 'session'").get(task) as
    | { address: string }
    | undefined;
  const address = open_.get(task) ?? row?.address;
  await net.removeSessionRules(task);
  if (address) {
    await deps.proxy.unlisten(address).catch((e) => log.error("unlisten failed", e, { task, address }));
    await deps.links.release(address);
    await net.delAddress(address);
  }
  open_.delete(task);
}
