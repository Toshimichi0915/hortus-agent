/**
 * `files`: a directory of the owner's own files (`dofs.<name>.path`), copied into the DOF at start and every reconcile,
 * so `dof search` and a Worker's mount see it. Nothing in it is an event: it never wakes the Planner, and its text is
 * the owner's (it never taints). The shipped `hortus` guide is synced the same way (mirror/index.ts).
 */
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import * as paths from "../paths.ts";
import type { Change, Connector, ConnectorFactory } from "../types.ts";

/** ponytail: a bigger file is skipped (a docs directory, not a dataset); a per-DOF cap if one is ever needed */
const MAX_FILE = 4 << 20;

/** Regular files under `dir`, relative; dot-entries and symlinks skipped (nothing outside `dir` comes along). */
function walk(dir: string, at = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(dir, at), { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const rel = at ? `${at}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(dir, rel));
    else if (e.isFile() && lstatSync(join(dir, rel)).size <= MAX_FILE) out.push(rel);
  }
  return out;
}

/** What makes DOF `name` a copy of `src`: every file put (the commit drops what did not change), the rest deleted. */
export function changesOf(src: string, name: string): Change[] {
  const want = walk(src);
  const tree = paths.dof(name);
  const have = existsSync(tree) ? walk(tree) : [];
  return [
    ...want.map((p): Change => ({ op: "put", path: p, bytes: readFileSync(join(src, p)) })),
    ...have.filter((p) => !want.includes(p)).map((p): Change => ({ op: "delete", path: p })),
  ];
}

export const create: ConnectorFactory = async ({ name, config }) => {
  const src = typeof config.path === "string" ? config.path : "";
  if (!isAbsolute(src)) throw new Error("dofs.<name>.path: an absolute directory");
  readdirSync(src); // missing or unreadable: the start fails, retried with backoff, and Sources shows why
  const conn: Connector = {
    async *events(signal) {
      await new Promise((r) => signal.addEventListener("abort", r, { once: true }));
    },
    mirror: () => Promise.reject(new Error("a files DOF has no events")),
    scopes: async () => [src],
    async *history() {
      yield { changes: changesOf(src, name), cursor: "" };
    },
    status: () => ({ connected: true }),
  };
  return conn;
};
