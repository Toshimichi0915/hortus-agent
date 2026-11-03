/** One cgroup v2 directory per task under hortusd's own (delegated: `Delegate=yes`). */
import { readFileSync } from "node:fs";
import { mkdir, readFile, rmdir, writeFile } from "node:fs/promises";
import { join, relative as rel } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export const ROOT = "/sys/fs/cgroup";

/** hortusd's cgroup directory: /sys/fs/cgroup + the `0::` line of /proc/self/cgroup. */
export function base(): string {
  const line = readFileSync("/proc/self/cgroup", "utf8")
    .split("\n")
    .find((l) => l.startsWith("0::"));
  if (!line) throw new Error("no cgroup v2 entry in /proc/self/cgroup");
  return join(ROOT, line.slice(3));
}

export const path = (id: string): string => join(base(), "tasks", id);

/** ENOENT, or ENODEV from a cgroup removed while we held its path. */
const gone = (e: unknown): boolean => ["ENOENT", "ENODEV"].includes((e as NodeJS.ErrnoException).code ?? "");

export async function create(id: string): Promise<string> {
  const p = path(id);
  await mkdir(p, { recursive: true });
  return p;
}

export async function pids(id: string): Promise<number[]> {
  try {
    const text = await readFile(join(path(id), "cgroup.procs"), "utf8");
    return text.split("\n").filter(Boolean).map(Number);
  } catch (e) {
    if (gone(e)) return [];
    throw e;
  }
}

/** SIGKILL everything in the cgroup, wait (≤ 5 s) until it is empty, remove it. Missing cgroup → no-op. */
export async function kill(id: string): Promise<void> {
  const p = path(id);
  try {
    await writeFile(join(p, "cgroup.kill"), "1");
  } catch (e) {
    if (gone(e)) return;
    throw e;
  }
  // rmdir succeeds once the cgroup is unpopulated (cgroup.procs empties a little before dying tasks are released).
  for (let i = 0; ; i++) {
    try {
      return await rmdir(p);
    } catch (e) {
      if (gone(e)) return;
      if ((e as NodeJS.ErrnoException).code !== "EBUSY" || i === 100) throw e;
    }
    await sleep(50);
  }
}

/** Path relative to the cgroup root, as nftables' `socket cgroupv2` wants it. */
export const relative = (p: string): string => rel(ROOT, p);
/** `socket cgroupv2 level <depth>`: the number of components below the root. */
export const depth = (p: string): number => relative(p).split("/").filter(Boolean).length;
