#!/usr/bin/env -S node --no-warnings=ExperimentalWarning
/**
 * dof: search the DOF mirrors. Inside a task (`HORTUS_TASK` = ctl/task.json) through the proxy at `<task.rpc>/rpc`,
 * in the owner's shell over the abstract socket. One line per hit: `<dof>/<path>\t<ts>\t<author>\t<title or snippet>`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { taskRpc } from "../rpc.ts";
import type { SearchHit } from "../types.ts";

const USAGE = `usage: dof search <query> [--in <dof>] [--author <id>] [--since <iso>] [--until <iso>] [-n <limit>]
       dof transform submit <dir>`;

const rpc = taskRpc;

/** `<dir>/{manifest.json,transform.js,README.md,tests/*.json}` → `transforms.submit`; the name is the dir's. */
async function submit(dir: string): Promise<number> {
  const root = resolve(dir);
  const files: Record<string, string> = {};
  for (const f of ["manifest.json", "transform.js", "README.md"])
    if (existsSync(join(root, f))) files[f] = readFileSync(join(root, f), "utf8");
  if (existsSync(join(root, "tests")))
    for (const f of readdirSync(join(root, "tests")).filter((x) => x.endsWith(".json")))
      files[`tests/${f}`] = readFileSync(join(root, "tests", f), "utf8");
  try {
    const r = await rpc<{ approval: number | null; url?: string }>("transforms.submit", {
      name: basename(root),
      files,
    });
    console.log(r.approval === null ? "already enabled" : `approval ${r.approval} pending: ${r.url}`);
    return 0;
  } catch (e) {
    console.error(`dof: ${(e as Error).message}`);
    return 1;
  }
}

async function main(): Promise<number> {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof options; allowPositionals: true }>>;
  const options = {
    in: { type: "string" },
    author: { type: "string" },
    since: { type: "string" },
    until: { type: "string" },
    n: { type: "string", short: "n" },
  } as const;
  try {
    parsed = parseArgs({ options, allowPositionals: true });
  } catch (e) {
    console.error(`${(e as Error).message}\n${USAGE}`);
    return 64;
  }
  const [cmd, ...words] = parsed.positionals;
  if (cmd === "transform") {
    if (words[0] !== "submit" || !words[1]) {
      console.error(USAGE);
      return 64;
    }
    return submit(words[1]);
  }
  const { n, ...filters } = parsed.values;
  const limit = n === undefined ? undefined : Number(n);
  if (cmd !== "search" || words.length === 0 || (limit !== undefined && !Number.isInteger(limit))) {
    console.error(USAGE);
    return 64;
  }
  let hits: SearchHit[];
  try {
    hits = await rpc<SearchHit[]>("dof.search", {
      q: words.join(" "),
      ...filters,
      ...(limit === undefined ? {} : { limit }),
    });
  } catch (e) {
    console.error(`dof: ${(e as Error).message}`);
    return 1;
  }
  const cell = (s: string) => s.replace(/\s+/g, " ").trim();
  // the index ranks which hits make the cut; the listing is newest first
  for (const h of [...hits].sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))) {
    console.log([`${h.dof}/${h.path}`, h.ts, h.author, h.title || h.snippet].map(cell).join("\t"));
  }
  return 0;
}

main().then((code) => {
  process.exitCode = code;
});
