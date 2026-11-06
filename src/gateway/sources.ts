/** What a source's card shows beyond its connector's status, from the vault, `events` and the disk. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DatabaseSync } from "../db.ts";
import { read } from "../vault/vault.ts";

export const FORGE_TYPES = ["github", "gitlab", "bitbucket"];

/** A connector's credentials as it names them (`<name>`; Slack's Socket Mode `<name>-app`; a forge's webhook secret). */
const CREDENTIALS: Record<string, string[]> = {
  slack: ["", "-app"],
  discord: [""],
  telegram: [""],
  ...Object.fromEntries(FORGE_TYPES.map((t) => [t, ["", "-webhook"]])),
};

/** A missing one reached the owner only as the connector's "auth.test: HTTP 403" (a fresh install). */
export function missingCredentials(name: string, type: string): string[] {
  const v = read();
  return (CREDENTIALS[type] ?? []).map((x) => name + x).filter((n) => !Object.hasOwn(v, n));
}

export function deliveries(db: DatabaseSync, dof: string): { today: number; last: string | null } {
  const r = db
    .prepare("SELECT sum(created >= ?) AS today, max(created) AS last FROM events WHERE dof = ?")
    .get(new Date().toISOString().slice(0, 10), dof) as { today: number | null; last: string | null };
  return { today: r.today ?? 0, last: r.last };
}

const sizes = new Map<string, { at: number; text: string | undefined }>();

/** `du` of the mirror worktree, cached 1 min. */
export async function mirrorSize(dir: string): Promise<string | undefined> {
  const c = sizes.get(dir);
  if (c && Date.now() - c.at < 60_000) return c.text;
  let text: string | undefined;
  try {
    const { stdout } = await promisify(execFile)("du", ["-sh", dir], { timeout: 10_000 });
    text = stdout.split("\t")[0];
  } catch {}
  sizes.set(dir, { at: Date.now(), text });
  return text;
}
