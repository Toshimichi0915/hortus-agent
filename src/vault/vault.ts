/**
 * vault.json (credentials) and the bound ctx shared by the vault and proxy modules. Only hortusd reads this file; values
 * never leave this process except inserted into an upstream request by the pipeline.
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Ctx } from "../ctx.ts";
import * as paths from "../paths.ts";
import type { Manifest, VaultEntry } from "../types.ts";
import { Scrubber } from "./scrub.ts";

let bound: Ctx | undefined;

/** vaultModule/proxyModule.start bind the daemon's ctx; everything below reads it fresh. */
export function bind(c: Ctx): void {
  bound = c;
}

export function ctx(): Ctx {
  if (!bound) throw new Error("vault: not started (no ctx bound)");
  return bound;
}

export const PREFIX = "hortus-secret-";
export const placeholder = (name: string): string => `${PREFIX}${name}`;
/** Credential names are URL-safe so placeholders can ride in URLs; `c-` is reserved for captured ones. */
export const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

let cache: { mtime: number; entries: Record<string, VaultEntry> } | undefined;

export function read(): Record<string, VaultEntry> {
  let mtime: number;
  try {
    mtime = statSync(paths.vault()).mtimeMs;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
  if (cache?.mtime !== mtime) cache = { mtime, entries: JSON.parse(readFileSync(paths.vault(), "utf8")) };
  return cache.entries;
}

/** Atomic (temp + rename), mode 0600. */
export function write(v: Record<string, VaultEntry>): void {
  const path = paths.vault();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(v, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  cache = undefined;
  scrubCache = undefined;
}

/** Throttled (once a minute per name): the Credentials page shows it, nothing depends on precision. */
export function touch(name: string): void {
  const v = read();
  const e = v[name];
  if (!e) return;
  const now = new Date();
  if (e.last_use && now.getTime() - Date.parse(e.last_use) < 60_000) return;
  write({ ...v, [name]: { ...e, last_use: now.toISOString() } });
}

/** Tokens minted by ops (github-app installation tokens, step 17): scrubbed like any other secret. */
export const minted = new Map<string, { value: string; expires: number }>();
let mintedVersion = 0;
export function mint(key: string, value: string, ttlMs: number): void {
  minted.set(key, { value, expires: Date.now() + ttlMs });
  mintedVersion++;
}

export interface CapturedRow {
  id: number;
  name: string;
  value: string;
  origin: string;
  kind: string | null;
}

export function captured(name: string): CapturedRow | undefined {
  return ctx().db.prepare("SELECT id, name, value, origin, kind FROM captured WHERE name = ?").get(name) as
    | CapturedRow
    | undefined;
}

/** Every secret value with the placeholder that replaces it in responses. */
export function secretValues(): { value: string; placeholder: string }[] {
  const out: { value: string; placeholder: string }[] = [];
  for (const [name, e] of Object.entries(read())) {
    const p = placeholder(name);
    if (e.type === "token" || e.type === "webhook-secret") out.push({ value: e.value, placeholder: p });
    else if (e.type === "github-app") out.push({ value: e.privateKey, placeholder: p });
    else if (e.type === "aws") out.push({ value: e.secret, placeholder: p }, { value: e.keyId, placeholder: p });
  }
  for (const [key, m] of minted) out.push({ value: m.value, placeholder: placeholder(key) });
  if (bound) {
    for (const r of ctx().db.prepare("SELECT name, value FROM captured").all() as { name: string; value: string }[])
      out.push({ value: r.value, placeholder: placeholder(r.name) });
  }
  return out;
}

let scrubCache: { key: string; s: Scrubber } | undefined;

/** Rebuilt when vault.json, the captured table, or the minted-token cache changes. */
export function scrubber(): Scrubber {
  const c = bound
    ? (ctx().db.prepare("SELECT count(*) AS n, max(id) AS m FROM captured").get() as { n: number; m: number | null })
    : { n: 0, m: 0 };
  read();
  const key = `${cache?.mtime ?? 0}:${c.n}:${c.m}:${mintedVersion}`;
  if (scrubCache?.key !== key) scrubCache = { key, s: new Scrubber(secretValues()) };
  return scrubCache.s;
}

/** The credential's `hosts`, else the manifest entry of the same name, else the manifest entry of the same type (v7). */
export function effectiveHosts(name: string, entry: VaultEntry, manifest: Manifest | undefined): string[] {
  if (entry.hosts) return entry.hosts;
  return manifestEntry(name, entry, manifest)?.hosts ?? [];
}

export function manifestEntry(name: string, entry: VaultEntry, manifest: Manifest | undefined) {
  if (!manifest) return undefined;
  return manifest.credentials[name] ?? Object.values(manifest.credentials).find((c) => c.type === entry.type);
}
