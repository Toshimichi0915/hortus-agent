/**
 * Forge repo mirrors (17-github.md, v6 › Projects › Forge origin): one bare read cache per project at
 * `repos/<dof>/<owner__repo>.git`, fetched on push events and the 10-min poll, never pruned, `gc.auto 0`. Workers
 * clone with `--reference` to it; it is never a push target.
 *
 * hortusd's own `git fetch` goes through the pipeline as role core like every other upstream call (v7 › Projects):
 * git talks plain HTTP to a one-shot loopback relay that hands each request to `coreFetch` as
 * `https://<host>/<project>.git/…`, so the placeholder in the URL becomes the read-only core installation token in
 * the same place as for a Worker. The relay answers only under a random path prefix and only this project's paths.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { pipeline, Readable } from "node:stream";
import type { ReadableStream } from "node:stream/web";
import { promisify } from "node:util";
import { dirOf } from "../connectors/forge.ts";
import * as paths from "../paths.ts";

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const run = promisify(execFile);
// the owner's ~/.gitconfig (credential helpers, url rewrites) must not reach hortusd's own git
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
const git = (cwd: string, ...args: string[]) => run("git", args, { cwd, env, maxBuffer: 64 * 1024 * 1024 });

/** `repos/<dof>/<owner__repo>.git` */
export const repoDir = (dof: string, project: string): string => paths.repo(dof, dirOf(project));

const chains = new Map<string, Promise<unknown>>();

/** Fetch every branch, tag and PR head of `cloneUrl` into the mirror (created on first use); one fetch per repo at a time. */
export function fetchRepo(dof: string, project: string, cloneUrl: string, fetch: Fetch): Promise<void> {
  const dir = repoDir(dof, project);
  const next = (chains.get(dir) ?? Promise.resolve()).catch(() => {}).then(() => fetchNow(dir, dof, cloneUrl, fetch));
  chains.set(dir, next);
  return next;
}

async function fetchNow(dir: string, dof: string, cloneUrl: string, fetch: Fetch): Promise<void> {
  if (!existsSync(join(dir, "HEAD"))) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    await git(dir, "init", "-q", "--bare");
    await git(dir, "config", "gc.auto", "0");
  }
  const up = new URL(cloneUrl);
  const prefix = `/${randomBytes(16).toString("hex")}`;
  const server = http.createServer((req, res) => {
    const path = req.url ?? "";
    if (!path.startsWith(`${prefix}${up.pathname}/`)) {
      req.resume();
      return void res.writeHead(404).end();
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers))
      if (k !== "host" && k !== "connection" && v !== undefined) headers[k] = [v].flat().join(", ");
    const body = req.method === "POST" ? { body: Readable.toWeb(req) as unknown as BodyInit, duplex: "half" } : {};
    fetch(`${up.origin}${path.slice(prefix.length)}`, { method: req.method, headers, ...body } as RequestInit).then(
      (r) => {
        res.writeHead(r.status, Object.fromEntries(r.headers));
        if (r.body) pipeline(Readable.fromWeb(r.body as unknown as ReadableStream), res, () => {});
        else res.end();
      },
      (e) => res.writeHead(502).end(String(e)),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await git(
      dir,
      "fetch",
      "-q",
      `http://x-access-token:hortus-secret-${dof}@127.0.0.1:${port}${prefix}${up.pathname}`,
      "+refs/heads/*:refs/heads/*",
      "+refs/tags/*:refs/tags/*",
      "+refs/pull/*/head:refs/pull/*/head",
    );
  } finally {
    server.closeAllConnections();
    server.close();
  }
}
