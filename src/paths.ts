/** The ~/.hortus tree. Read lazily so tests can point HORTUS_HOME at a temp dir. */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const home = (): string => resolve(process.env.HORTUS_HOME ?? join(homedir(), ".hortus"));
const at = (...p: string[]): string => join(home(), ...p);

export const config = () => at("hortusd.json");
export const vault = () => at("vault.json");
export const db = () => at("db.sqlite");
export const ca = () => at("ca");
export const dof = (name: string) => at("dof", name);
export const dofRepo = (name: string) => at("dof", `${name}.git`);
export const logs = () => at("dof", "logs");
export const repo = (dof: string, project: string) => at("repos", dof, `${project}.git`);
export const project = (name: string) => at("projects", `${name}.git`);
export const shadow = (name: string) => at("shadow", `${name}.git`);
export const task = (id: string) => at("tasks", id);
export const ctl = (id: string) => at("tasks", id, "ctl");
export const out = (id: string) => at("tasks", id, "out");
export const clone = (id: string) => at("clones", id);
export const schedule = (id: string | number) => at("schedules", String(id));
export const images = () => at("images");
/** the Workers' shared tool caches (never the owner's) */
export const cache = () => at("cache");
export const paused = () => at("PAUSED");

/** Abstract unix socket: per uid, or per HORTUS_HOME so tests never meet a real daemon. */
export function socket(): string {
  if (process.env.HORTUS_HOME === undefined) return `\0hortus-${process.getuid?.() ?? 0}`;
  return `\0hortus-${createHash("sha256").update(home()).digest("hex").slice(0, 12)}`;
}
