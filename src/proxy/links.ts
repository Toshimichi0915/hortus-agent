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
