#!/usr/bin/env -S node --no-warnings=ExperimentalWarning
/**
 * dof: search the DOF mirrors. Inside a task (`HORTUS_TASK` = ctl/task.json) through the proxy at `<task.rpc>/rpc`,
 * in the owner's shell over the abstract socket. One line per hit: `<dof>/<path>\t<ts>\t<author>\t<title or snippet>`.
 */
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { parseArgs } from "node:util";
import * as paths from "../paths.ts";
import { rpcClient } from "../rpc.ts";
import type { SearchHit, SearchQuery, TaskJson } from "../types.ts";

const USAGE = "usage: dof search <query> [--in <dof>] [--author <id>] [--since <iso>] [--until <iso>] [-n <limit>]";

async function rpc(input: SearchQuery): Promise<SearchHit[]> {
  const taskFile = process.env.HORTUS_TASK;
  if (!taskFile) {
    const client = rpcClient(paths.socket());
    try {
      return (await client.call("dof.search", input)) as SearchHit[];
    } finally {
      client.close();
    }
  }
  const task = JSON.parse(readFileSync(taskFile, "utf8")) as TaskJson;
  const local = process.env.HORTUS_RPC_LOCAL;
  const res = local
    ? await loopback(`${process.env.HORTUS_RPC}/rpc/dof.search`, local, JSON.stringify(input))
    : await fetch(`${task.rpc}/rpc/dof.search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  if (!res.ok) {
    const e = body as { error?: { message?: string }; message?: string } | undefined;
    throw new Error(e?.error?.message ?? e?.message ?? `${res.status} ${text}`);
  }
  return (body as { result: SearchHit[] }).result;
}

/**
 * HORTUS_NO_NET=1 (tests): no DNS or DNAT for hortusd.internal, so the request goes to the proxy's plain listener on
 * 127.0.0.1 from the session's loopback alias, which is how the proxy knows the task (v7 › Security › HORTUS_NO_NET).
 */
function loopback(
  url: string,
  localAddress: string,
  body: string,
): Promise<{ ok: boolean; status: number; text(): Promise<string> }> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      { method: "POST", localAddress, headers: { host: "hortusd.internal", "content-type": "application/json" } },
      (res) => {
        let t = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          t += c;
        });
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          resolve({ ok: status >= 200 && status < 300, status, text: async () => t });
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
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
  const { n, ...filters } = parsed.values;
  const limit = n === undefined ? undefined : Number(n);
  if (cmd !== "search" || words.length === 0 || (limit !== undefined && !Number.isInteger(limit))) {
    console.error(USAGE);
    return 64;
  }
  let hits: SearchHit[];
  try {
    hits = await rpc({ q: words.join(" "), ...filters, ...(limit === undefined ? {} : { limit }) });
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
