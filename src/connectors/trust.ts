/** Whether an event's author is trusted. Bots and authorless events never are. */
import type { Event } from "../types.ts";

export function trusted(e: Pick<Event, "author" | "bot">, cfg: { owner?: string; trust?: unknown }): boolean {
  if (e.author === null || e.bot) return false;
  const { user, member } = e.author;
  if (user === cfg.owner) return true;
  const t = cfg.trust ?? "owner";
  if (Array.isArray(t)) return t.includes(user);
  if (t === "anyone") return true;
  if (t === "members") return member;
  return false;
}
