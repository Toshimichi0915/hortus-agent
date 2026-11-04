/** Client registry: proxy-facing address → role and task (`links` rows, cached). The in-process client has no address. */
import type { Role } from "../types.ts";
import { ctx } from "../vault/vault.ts";

export interface Client {
  role: Role;
  task?: string;
  /** "session" | "vm" | "login" … (free text, for the console) */
  kind?: string;
}

export const CORE: Client = { role: "core" };

const cache = new Map<string, Client>();

const norm = (a: string): string => (a.startsWith("::ffff:") ? a.slice(7) : a);

export function load(): void {
  cache.clear();
  const rows = ctx().db.prepare("SELECT address, role, task_id, kind FROM links").all() as {
    address: string;
    role: Role;
    task_id: string | null;
    kind: string | null;
  }[];
  for (const r of rows)
    cache.set(r.address, {
      role: r.role,
      ...(r.task_id ? { task: r.task_id } : {}),
      ...(r.kind ? { kind: r.kind } : {}),
    });
}

export function register(address: string, role: Role, task: string | null, kind: string): void {
  const a = norm(address);
  ctx()
    .db.prepare("INSERT OR REPLACE INTO links(address, role, task_id, kind, created) VALUES (?, ?, ?, ?, ?)")
    .run(a, role, task, kind, new Date().toISOString());
  cache.set(a, { role, ...(task ? { task } : {}), kind });
}

export function release(address: string): void {
  const a = norm(address);
  ctx().db.prepare("DELETE FROM links WHERE address = ?").run(a);
  cache.delete(a);
}

export const lookup = (address: string | undefined): Client | undefined =>
  address ? cache.get(norm(address)) : undefined;

/**
 * Round-robin turns across clients (review round 6): one start per loop turn in all, the next from the next client
 * with one waiting. A start's synchronous part (the pipeline's lookups and transform calls, ~0.7 ms; an RPC's search
 * over megabyte logs, ~12 ms) runs on hortusd's thread: 20 Workers flooding at once ran 20 searches per turn (290 ms)
 * and 1,280 request starts in one turn (950 ms), the console behind them. A per-client queue bounded one Worker only.
 */
const waiting = new Map<Client, (() => void)[]>();
let armed = false;

function pump(): void {
  armed = false;
  const first = waiting.entries().next();
  if (first.done) return;
  const [client, q] = first.value;
  waiting.delete(client);
  const go = q.shift();
  if (q.length) waiting.set(client, q); // to the back of the line
  arm();
  go?.();
}

function arm(): void {
  if (armed || !waiting.size) return;
  armed = true;
  setImmediate(pump);
}

export function turn(client: Client): Promise<void> {
  return new Promise((go) => {
    const q = waiting.get(client);
    if (q) q.push(go);
    else waiting.set(client, [go]);
    arm();
  });
}
