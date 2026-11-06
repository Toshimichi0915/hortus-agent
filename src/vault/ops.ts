/**
 * Handles and the built-in operations that resolve them, the only cryptography a transform can ask for.
 * `{secret:name}` inserts the value, `{basic:user:name}` the base64 of `user:value`, `{sign:op(args)}` runs
 * `ops[op]` with a JSON argument list whose first element is the credential name. A new operation is one entry here.
 */
import { createHmac, createSign, randomUUID, timingSafeEqual } from "node:crypto";
import type { Role, VaultEntry } from "../types.ts";
import { awsDate, type Signing, sigv4 } from "./sigv4.ts";
import { type CapturedRow, ctx, mint, minted, read } from "./vault.ts";

export interface Handle {
  kind: "secret" | "basic" | "sign";
  /** the whole `{…}` text */
  text: string;
  name: string;
  user?: string;
  op?: string;
  args?: unknown[];
}

// ponytail: sign args end at the first ")}"; a JSON string arg containing ")}" breaks parsing (refused, not leaked)
export const HANDLE =
  /\{(?:secret:([a-z0-9][a-z0-9_-]*)|basic:([^:{}]*):([a-z0-9][a-z0-9_-]*)|sign:([a-z0-9-]+)\((.*?)\))\}/g;

/** Every handle in `s`; a `{sign:…}` whose args are not JSON or whose first arg is not a name → throws. */
export function handles(s: string): Handle[] {
  const out: Handle[] = [];
  for (const m of s.matchAll(HANDLE)) {
    if (m[1]) out.push({ kind: "secret", text: m[0], name: m[1] });
    else if (m[3]) out.push({ kind: "basic", text: m[0], name: m[3], user: m[2] ?? "" });
    else {
      const args = JSON.parse(`[${m[5]}]`) as unknown[];
      // the name first, or an object holding it: aws-sigv4({"name":"aws","region":…}) gets the whole object
      const named = (args[0] as { name?: unknown } | null)?.name;
      if (typeof args[0] === "string")
        out.push({ kind: "sign", text: m[0], name: args[0], op: m[4], args: args.slice(1) });
      else if (typeof named === "string") out.push({ kind: "sign", text: m[0], name: named, op: m[4], args });
      else throw new Error(`sign:${m[4]} needs a credential name first`);
    }
  }
  return out;
}

export type Secret = { entry: VaultEntry } | { captured: CapturedRow };

/** `sign` operations by name; each gets the credential and its args and returns the text that replaces the handle. */
export const ops: Record<string, (s: Secret, args: unknown[], req?: Signing) => string> = {
  "aws-sigv4": sigv4,
  "aws-date": awsDate,
  "app-jwt": (s) => appJwt(app(s)),
  // async (an API call): the pipeline mints it after the gate (`mintHandle`) and inserts the result
  "installation-token": () => {
    throw new Error("installation-token is minted before the request is sent");
  },
};

/** Ops that sign the final request: left in place by the first pass, resolved with `req` once headers and body are set. */
export const late = new Set(["aws-sigv4"]);

/** The value a `{secret:}`/`{basic:}` handle stands for: tokens and captured values only. */
function value(s: Secret): string {
  if ("captured" in s) return s.captured.value;
  if (s.entry.type === "token") return s.entry.value;
  // ponytail: github-app needs the installation-token op; webhook-secret/aws never ride as plain values
  throw new Error(`credential type ${s.entry.type} cannot be inserted as a value`);
}

/** Throws on anything it cannot resolve: the request is refused, never sent without its credential. */
export function resolveHandle(h: Handle, s: Secret, req?: Signing): string {
  if (h.kind === "secret") return value(s);
  if (h.kind === "basic") return Buffer.from(`${h.user}:${value(s)}`).toString("base64");
  const op = h.op ? ops[h.op] : undefined;
  if (!op) throw new Error(`unknown operation ${h.op}`);
  if (!req && late.has(h.op ?? "")) return h.text;
  return op(s, h.args ?? [], req);
}

/** Checks resolvability without producing values (step 8). */
export function resolvable(h: Handle, s: Secret): string | undefined {
  if (h.kind === "sign") return h.op && ops[h.op] ? undefined : `unknown operation ${h.op}`;
  if ("captured" in s || s.entry.type === "token") return undefined;
  return `credential type ${s.entry.type} cannot be inserted as a value`;
}

// ---------------------------------------------------------------------------------------------------------------------
// github-app and webhook-secret

type GithubApp = Extract<VaultEntry, { type: "github-app" }>;

function app(s: Secret): GithubApp {
  if ("entry" in s && s.entry.type === "github-app") return s.entry;
  throw new Error("not a github-app credential");
}

const b64url = (b: string): string => Buffer.from(b).toString("base64url");

/** The App's JWT: RS256, `iat` 60 s back (clock drift), 10 min life. */
export function appJwt(e: GithubApp, now = Date.now()): string {
  const iat = Math.floor(now / 1000) - 60;
  const claims = { iat, exp: iat + 600, iss: String(e.appId) };
  const data = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify(claims))}`;
  return `${data}.${createSign("RSA-SHA256").update(data).sign(e.privateKey).toString("base64url")}`;
}

/** `X-Hub-Signature-256` against the `webhook-secret` credential `name`, constant time; anything missing → false. */
export function hmacVerify(name: string, body: Buffer, sig: string | undefined): boolean {
  const e = read()[name];
  if (e?.type !== "webhook-secret" || !sig) return false;
  const want = Buffer.from(`sha256=${createHmac("sha256", e.value).update(body).digest("hex")}`);
  const got = Buffer.from(sig);
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * `value` equals the `webhook-secret` credential `name` (GitLab's `X-Gitlab-Token`), constant time: `value` is copied
 * into a buffer of the secret's length, so a length mismatch still compares every byte before answering false.
 */
export function equals(name: string, value: string | undefined): boolean {
  const e = read()[name];
  if (e?.type !== "webhook-secret" || value === undefined) return false;
  const want = Buffer.from(e.value);
  const raw = Buffer.from(value);
  const got = Buffer.alloc(want.length);
  raw.copy(got);
  return timingSafeEqual(got, want) && raw.length === want.length;
}

/** The GitHub App permissions a token is minted with, per role. */
export const PERMISSIONS = {
  worker: { contents: "write", issues: "write", pull_requests: "write", checks: "read", actions: "read" },
  core: { contents: "read", issues: "read", pull_requests: "read", checks: "read" },
} as const;
export const TOKEN_TTL_MS = 50 * 60_000;

/** The REST base of DOF `name` (a connector uses the credential of its own name): `api`, `host`/api/v3, else github.com. */
function apiOf(name: string): string {
  const c = ctx().config;
  const d = c.dofs[name];
  const api = (d?.api ?? (d?.host ? `https://${d.host}/api/v3` : "https://api.github.com")).replace(/\/$/, "");
  const u = new URL(api);
  const dev = process.env.HORTUS_HOME !== undefined ? c.dev?.upstreams?.[u.host] : undefined;
  return dev ? `${dev.replace(/\/$/, "")}${u.pathname.replace(/\/$/, "")}` : api;
}

/**
 * An installation token for `repos` (repo names; null = every repo of the installation) with `permissions`, minted by
 * hortusd itself (it holds the key; no transform runs) and cached `TOKEN_TTL_MS` under `key` (none → per request).
 * Every minted token joins the scrub set.
 */
export async function installationToken(
  name: string,
  repos: string[] | null,
  permissions: Record<string, string>,
  key?: string,
): Promise<string> {
  const hit = key ? minted.get(key) : undefined;
  if (hit && hit.expires > Date.now()) return hit.value;
  const e = read()[name];
  if (e?.type !== "github-app") throw new Error(`${name} is not a github-app credential`);
  const res = await fetch(`${apiOf(name)}/app/installations/${e.installationId}/access_tokens`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${appJwt(e)}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "hortus",
    },
    body: JSON.stringify({ ...(repos ? { repositories: repos } : {}), permissions }),
  });
  if (!res.ok) throw new Error(`minting failed: HTTP ${res.status}`);
  const { token } = (await res.json()) as { token: string };
  mint(key ?? `${name}#once#${randomUUID()}`, token, TOKEN_TTL_MS);
  return token;
}

/**
 * Resolve one `{sign:installation-token({"name":…,"basic"?:user,"admin"?:true})}` for a caller: Workers get their
 * task's `scope.repos` of this DOF with the Worker permissions (+ `administration: write`, uncached, for the create
 * endpoints), role core every repo, read only. `basic` → the base64 of `user:token` for `Authorization: Basic`.
 */
export async function mintHandle(h: Handle, role: Role, task: string | undefined, repos: string[]): Promise<string> {
  const a = (h.args?.[0] ?? {}) as { basic?: string; admin?: boolean };
  let token: string;
  if (role === "core") token = await installationToken(h.name, null, PERMISSIONS.core, `${h.name}#core`);
  else {
    const names = repos
      .filter((r) => r.startsWith(`${h.name}:`))
      .map((r) => r.slice(h.name.length + 1).split("/")[1] ?? "")
      .sort();
    const perms: Record<string, string> = { ...PERMISSIONS.worker, ...(a.admin ? { administration: "write" } : {}) };
    token = await installationToken(h.name, names, perms, a.admin ? undefined : `${h.name}#${task}#${names}`);
  }
  return a.basic === undefined ? token : Buffer.from(`${a.basic}:${token}`).toString("base64");
}
