/**
 * One pipeline for every client (TLS listener, plain listener, in-process `coreFetch`, WebSocket handshakes):
 * 03-vault-proxy.md › pipeline, steps 1–11. Requests carry placeholders; the template carries handles; only the bytes
 * sent upstream carry secrets, and every response is scrubbed back to placeholders.
 */
import { createHash, randomUUID } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import { PassThrough, pipeline, Readable, type Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import zlib from "node:zlib";
import { family, taint } from "../db.ts";
import { logger } from "../log.ts";
import type { Manifest, Req, ResponseResult, Template } from "../types.ts";
import * as gate from "../vault/gate.ts";
import {
  HANDLE,
  type Handle,
  handles,
  late,
  mintHandle,
  resolvable,
  resolveHandle,
  type Secret,
} from "../vault/ops.ts";
import { providerSecret } from "../vault/providers.ts";
import type { Scrubber } from "../vault/scrub.ts";
import type { Signing } from "../vault/sigv4.ts";
import * as transforms from "../vault/transforms.ts";
import {
  captured,
  ctx,
  effectiveHosts,
  hostIn,
  manifestEntry,
  PREFIX,
  read as readVault,
  scrubber,
  touch,
} from "../vault/vault.ts";
import { internal } from "./internal.ts";
import type { Client } from "./links.ts";

const log = logger("proxy");

export const MB = 1024 * 1024;
export const REQUEST_BUFFER = MB;
export const RESPONSE_BUFFER = 16 * MB;

/** What every transport hands the pipeline. Header names lowercased, repeated values joined. */
export interface IncomingRequest {
  method: string;
  /** path and query as sent: "/api/auth.test?x=1" */
  path: string;
  headers: Record<string, string>;
  body: Readable | null;
  tls: boolean;
  /** TLS only: the SNI the handshake carried */
  sni?: string;
}

export interface Out {
  status: number;
  headers: Record<string, string | string[]>;
  body: Readable | Buffer | string;
}

export function refuse(status: number, msg: string, data?: Record<string, unknown>): Out {
  log.info("refused", { status, msg, ...data });
  return { status, headers: { "content-type": "text/plain; charset=utf-8" }, body: `hortus: ${msg}\n` };
}

const json = (status: number, v: unknown): Out => ({
  status,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(v),
});

// ---------------------------------------------------------------------------------------------------------------------
// Egress (step 3)

export interface Target {
  protocol: "http:" | "https:";
  address: string;
  port: number;
}

export interface TaskRow {
  scope: { credentials?: string[]; repos?: string[] } | null;
  origins: "*" | string[] | null;
  budget: { tokens: number } | null;
  /** tokens counted on its model calls here */
  metered: number;
}

export function taskRow(id: string): TaskRow | undefined {
  const r = ctx().db.prepare("SELECT scope, origins, budget, metered FROM tasks WHERE id = ?").get(id) as
    | { scope: string | null; origins: string | null; budget: string | null; metered: number }
    | undefined;
  if (!r) return undefined;
  return {
    scope: r.scope ? JSON.parse(r.scope) : null,
    origins: r.origins ? JSON.parse(r.origins) : null,
    budget: r.budget ? (JSON.parse(r.budget) as { tokens: number }) : null,
    metered: r.metered,
  };
}

/** Global `origins` merged with the task row's (already narrowed by its projects when the dispatcher wrote it). */
export function originsFor(task: TaskRow | undefined): "*" | string[] {
  const g = ctx().config.origins;
  const t = task?.origins;
  if (!t || t === "*") return g;
  if (g === "*") return t;
  return [...new Set([...g, ...t])];
}

const PRIVATE = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
] as const)
  PRIVATE.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  // IPv4 inside IPv6 (compatible, NAT64); mapped `::ffff:…` is unwrapped in isPrivate (BlockList would match every
  // IPv4 address against ::ffff:0:0/96)
  ["::", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  // IPv4-translated (RFC 2765), 6to4 and Teredo (both carry an IPv4 address a relay may reach), discard, multicast
  ["::ffff:0:0:0", 96],
  ["2002::", 16],
  ["2001::", 32],
  ["100::", 64],
  ["ff00::", 8],
] as const)
  PRIVATE.addSubnet(net, bits, "ipv6");

function inCidrs(address: string, cidrs: string[]): boolean {
  const family = isIP(address) === 6 ? "ipv6" : "ipv4";
  const bl = new BlockList();
  for (const c of cidrs) {
    const [net = "", bits] = c.split("/");
    const f = isIP(net) === 6 ? "ipv6" : "ipv4";
    if (!isIP(net)) continue;
    if (bits === undefined) bl.addAddress(net, f);
    else bl.addSubnet(net, Number(bits), f);
  }
  return bl.check(address, family);
}

function isPrivate(address: string): boolean {
  // IPv4-mapped, dotted (`::ffff:127.0.0.1`) or hex (`::ffff:7f00:1`): checked as the IPv4 address it is
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  const v4 =
    dotted ??
    (hex &&
      [hex[1], hex[2]]
        .flatMap((x) => [Number.parseInt(x as string, 16) >> 8, Number.parseInt(x as string, 16) & 255])
        .join("."));
  if (v4) return PRIVATE.check(v4, "ipv4");
  return PRIVATE.check(address, isIP(address) === 6 ? "ipv6" : "ipv4");
}

let warnedDev = false;

/** `dev.upstreams[host]`, honoured only with HORTUS_HOME set (test and dev runs). */
function devUpstream(host: string): URL | undefined {
  const u = ctx().config.dev?.upstreams?.[host];
  if (!u) return undefined;
  if (process.env.HORTUS_HOME === undefined) {
    if (!warnedDev) log.error("dev.upstreams ignored: HORTUS_HOME is not set");
    warnedDev = true;
    return undefined;
  }
  return new URL(u);
}

/** The host of the session's own model: how it thinks, not egress, and in no list an owner writes for a task's data. */
function modelHost(client: Client): string | undefined {
  const { planner, worker } = ctx().config;
  const name = client.role === "planner" ? planner.provider : client.role === "worker" ? worker.provider : undefined;
  try {
    const endpoint = name && providerSecret(name).endpoint;
    return endpoint ? new URL(endpoint).hostname : undefined;
  } catch {
    return undefined; // not a credential (yet): the session's first call says so
  }
}

export async function egress(
  client: Client,
  host: string,
  tls: boolean,
  task: TaskRow | undefined,
): Promise<Target | Out> {
  const origins = client.role === "core" ? "*" : originsFor(task);
  if (origins !== "*" && !origins.includes(host) && host !== modelHost(client))
    return refuse(403, `host not in origins: ${host}`, { host });
  const dev = devUpstream(host);
  if (dev) {
    const protocol = dev.protocol === "https:" ? "https:" : "http:";
    return { protocol, address: dev.hostname, port: Number(dev.port) || (protocol === "https:" ? 443 : 80) };
  }
  let addresses: { address: string }[];
  try {
    addresses = await dnsLookup(host, { all: true });
    // a lookup of ours that lands on the source port of a session's recent query rides its conntrack entry to that session's
    // DNS, which answers with the session's own address (2 in a live walk, a Worker's model call refused): a new port misses it
    if (addresses.some((a) => a.address.startsWith("10.77."))) addresses = await dnsLookup(host, { all: true });
  } catch (e) {
    return refuse(502, `cannot resolve ${host}: ${(e as NodeJS.ErrnoException).code ?? e}`);
  }
  // no Worker reaches loopback/private/link-local unless chat.allow lists it, "*" or a listed host alike: a listed
  // name's DNS is not the owner's (rebound to 127.0.0.1 or 169.254.169.254); core (hortusd itself) is the owner
  const pick = addresses[0];
  if (client.role !== "core") {
    const allow = ctx().config.chat.allow;
    const bad = addresses.find((a) => isPrivate(a.address) && !inCidrs(a.address, allow));
    if (bad) return refuse(403, `host resolves to a private address: ${host}`, { host, address: bad.address });
  }
  if (!pick) return refuse(502, `cannot resolve ${host}`);
  // connect to the address that was checked, so a second resolution cannot rebind the name
  return { protocol: tls ? "https:" : "http:", address: pick.address, port: tls ? 443 : 80 };
}

// ---------------------------------------------------------------------------------------------------------------------
// Body reading

/** Buffers up to `max` bytes (and, `ms` given, for up to `ms`); past that, a stream of everything (the buffered
 * prefix first). */
export function readUpTo(r: Readable, max: number, ms?: number): Promise<{ buf: Buffer } | { rest: Readable }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    const timer = ms === undefined ? undefined : setTimeout(() => spill(), ms);
    const cleanup = () => {
      clearTimeout(timer);
      r.off("data", onData);
      r.off("end", onEnd);
      r.off("error", onErr);
      r.off("close", onClose);
    };
    // destroyed (the client hung up) before or without an end: else this never settles
    const onClose = () => onErr(new Error("closed before its end"));
    if (r.destroyed) return reject(new Error("closed before its end"));
    const onData = (c: Buffer) => {
      chunks.push(c);
      n += c.length;
      if (n > max) spill();
    };
    const spill = () => {
      cleanup();
      r.pause();
      const pt = new PassThrough();
      for (const x of chunks) pt.write(x);
      r.on("error", (e) => pt.destroy(e));
      r.pipe(pt);
      resolve({ rest: pt });
    };
    const onEnd = () => {
      cleanup();
      resolve({ buf: Buffer.concat(chunks) });
    };
    const onErr = (e: Error) => {
      cleanup();
      reject(e);
    };
    r.on("data", onData);
    r.on("end", onEnd);
    r.on("error", onErr);
    r.on("close", onClose);
  });
}

const RECEIVE_PACK = /^application\/x-git-receive-pack-request/i;

/** Where the pkt-line command list ends (after its flush `0000`); -1 not pkt-lines; undefined: need more bytes. */
function pktEnd(b: Buffer): number | undefined {
  for (let i = 0; i + 4 <= b.length; ) {
    const h = b.toString("latin1", i, i + 4);
    if (!/^[0-9a-f]{4}$/i.test(h)) return -1;
    const n = Number.parseInt(h, 16);
    if (n === 0) return i + 4;
    if (n < 4) return -1;
    i += n;
  }
  return undefined;
}

/** The leading ref commands of a `git-receive-pack` body (≤ 1 MB, about 10,000 refs, else null) and a stream of the
 * whole body. ponytail: a body dripped a byte at a time re-joins what it has per chunk; each turn stays short */
function peekCommands(r: Readable): Promise<{ body: Readable; commands: string | null }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    // a push that hangs up inside its commands: else this never settles (readUpTo's onClose)
    const onClose = () => reject(new Error("closed before its end"));
    const done = (commands: string | null, ended: boolean) => {
      r.off("data", onData);
      r.off("end", onEnd);
      r.off("error", reject);
      r.off("close", onClose);
      r.pause();
      const pt = new PassThrough();
      for (const c of chunks) pt.write(c);
      if (ended) pt.end();
      else {
        r.on("error", (e) => pt.destroy(e));
        r.pipe(pt);
      }
      resolve({ body: pt, commands });
    };
    const onData = (c: Buffer) => {
      chunks.push(c);
      const b = Buffer.concat(chunks);
      const end = pktEnd(b);
      if (end !== undefined) done(end < 0 ? null : b.subarray(0, end).toString("utf8"), false);
      else if (b.length > REQUEST_BUFFER) done(null, false);
    };
    const onEnd = () => done(null, true);
    r.on("data", onData);
    r.on("end", onEnd);
    r.on("error", reject);
    r.on("close", onClose);
  });
}

const utf8 = (b: Buffer): string | undefined => {
  try {
    // ignoreBOM keeps it: a body goes on as decoded, and a CSV from Windows arrived three bytes short
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(b);
  } catch {
    return undefined;
  }
};

const STREAM_REQUEST = /^application\/(x-git-|octet-stream)/i;
const HTML = /^\s*(text\/html|application\/xhtml\+xml)/i;
/** A messenger's own history read by API: what `scope.dofs` would have tainted, by another door. */
export const HISTORY =
  /^(\w+ slack\.com\/api\/(conversations\.(history|replies)|pins\.list)|GET discord\.com\/api\/(v\d+\/)?channels\/\d+\/(messages|pins))/i;
const STREAM_RESPONSE = /^(text\/event-stream|application\/(x-git-|octet-stream))/i;
const HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);

// ---------------------------------------------------------------------------------------------------------------------
// Templates

const URL_PARTS = /^(https?:\/\/[^/?#]+)([^?#]*)(\?[^#]*)?/;

/** Basic credentials decoded, so a placeholder or raw secret inside `Authorization: Basic …` is seen. */
function basicDecoded(headers: Record<string, string>): string {
  const a = Object.entries(headers).find(([k]) => k.toLowerCase() === "authorization")?.[1];
  const m = a?.match(/^Basic\s+([A-Za-z0-9+/=]+)\s*$/i);
  return m?.[1] ? Buffer.from(m[1], "base64").toString("utf8") : "";
}

const everything = (r: Req): string[] => [
  r.url,
  ...Object.entries(r.headers).flat(),
  basicDecoded(r.headers),
  r.body ?? "",
];

function pairs(s: string): [string, string][] {
  return s
    .split("&")
    .filter(Boolean)
    .map((p) => {
      const i = p.indexOf("=");
      const k = i < 0 ? p : p.slice(0, i);
      let key = k;
      try {
        key = decodeURIComponent(k.replace(/\+/g, " "));
      } catch {}
      return [key, i < 0 ? "" : p.slice(i + 1)];
    });
}

interface Found {
  h: Handle;
  /** the concrete place: header:<name>, basic:password, query:<k>, form:<k>, path, body, header-name */
  loc: string;
}

/** Every handle in the template with where it sits. A new location kind is one branch here. */
function locate(t: Template, declared: string[]): Found[] {
  const out: Found[] = [];
  const [, , path = "", query = ""] = t.url.match(URL_PARTS) ?? [];
  for (const h of handles(path)) {
    const pat = declared.find((d) => d.startsWith("path:") && path.includes(d.slice(5).replace("{}", h.text)));
    out.push({ h, loc: pat ?? "path" });
  }
  for (const [k, v] of pairs(query.slice(1))) for (const h of handles(v)) out.push({ h, loc: `query:${k}` });
  for (const [k, v] of Object.entries(t.headers)) {
    for (const h of handles(k)) out.push({ h, loc: "header-name" });
    const name = k.toLowerCase();
    for (const h of handles(v))
      out.push({ h, loc: h.kind === "basic" && name === "authorization" ? "basic:password" : `header:${name}` });
  }
  if (t.body) {
    const ct = Object.entries(t.headers).find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "";
    if (/^application\/x-www-form-urlencoded/i.test(ct))
      for (const [k, v] of pairs(t.body)) for (const h of handles(v)) out.push({ h, loc: `form:${k}` });
    else for (const h of handles(t.body)) out.push({ h, loc: "body" });
  }
  return out;
}

const declares = (locs: string[], loc: string): boolean =>
  locs.some((d) => (d.startsWith("header:") ? d.toLowerCase() === loc : d === loc));

/** The concrete locations that hold a value in the template (headers, Basic password, query and form fields). */
function occupied(t: Template): string[] {
  const out = Object.keys(t.headers).map((k) => `header:${k.toLowerCase()}`);
  const auth = Object.entries(t.headers).find(([k]) => k.toLowerCase() === "authorization")?.[1] ?? "";
  if (basicDecoded(t.headers).includes(":") || auth.includes("{basic:")) out.push("basic:password");
  const [, , , query = ""] = t.url.match(URL_PARTS) ?? [];
  for (const [k] of pairs(query.slice(1))) out.push(`query:${k}`);
  const ct = Object.entries(t.headers).find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "";
  if (t.body && /^application\/x-www-form-urlencoded/i.test(ct)) for (const [k] of pairs(t.body)) out.push(`form:${k}`);
  return out;
}

const literal = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `*` one segment, `**` anything, `{project}` one or more segments (captured). */
function glob(p: string): RegExp {
  const src = p
    .split(/(\*\*|\*|\{project\})/)
    .map((s) => (s === "**" ? ".*" : s === "*" ? "[^/]*" : s === "{project}" ? "(.+?)" : literal(s)))
    .join("");
  return new RegExp(`^${src}$`);
}

/** `%65` and `e` are one character (RFC 3986); twice, for a router behind an edge that decodes first (`%2565`). */
const decoded = (s: string): string => {
  const once = (t: string) =>
    t.replace(/%([0-9a-f]{2})/gi, (e, x: string) => {
      const c = String.fromCharCode(Number.parseInt(x, 16));
      return /[\w.~%;\\-]/.test(c) ? c : e;
    });
  return once(once(s));
};

/**
 * The path as an upstream routes it, for the consequential patterns and the dot-segment check: routers drop a doubled or
 * trailing `/`, some a `;` path parameter or take `\` for `/`, and Grape (GitLab's API) a `.json` suffix. The request
 * goes upstream as sent. Those patterns deny, so a spelling they miss was an ordinary request; the scope patterns allow,
 * so a spelling they miss is refused already and they keep the raw path.
 */
const routed = (path: string): string =>
  decoded(path)
    .replace(/;[^/]*/g, "")
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/(.)\/$/, "$1")
    .replace(/(\w)\.json$/i, "$1");

const overrideHeader = (t: Template): boolean =>
  Object.keys(t.headers).some((k) => /^x-(http-)?method(-override)?$/i.test(k));

/** `_method` as a key of a query or a form, however spelled; the same word in a value is someone's text. */
const hasKey = (s: string): boolean =>
  s.split(/[&;]/).some((p) => decoded(p.split("=", 1)[0] ?? "").trim() === "_method");

const BOUNDARY = /;\s*boundary=("?)([^";,\s]+)\1/i;

/** A multipart type's boundary, when only one can be meant: a decoy (`x="boundary=a"; boundary=b`, a second `boundary=`)
 * says one thing here and another to the upstream's parser. */
const boundaryOf = (ct: string): string | undefined =>
  /^multipart\//i.test(ct) && ct.split(/boundary=/i).length === 2 ? ct.match(BOUNDARY)?.[2] : undefined;

/** A real `_method` field: in the query, a urlencoded body (Rack takes a POST with no type as one) or a multipart part's
 * own headers. Any other body is not a form, so nothing in it is a key. */
function overrideField(t: Template, ct: string, llmCall: boolean): boolean {
  if (hasKey((t.url.match(URL_PARTS)?.[3] ?? "").slice(1))) return true;
  if (llmCall || !t.body) return false;
  if (ct === "" || /^application\/x-www-form-urlencoded/i.test(ct)) return hasKey(t.body);
  if (!/^multipart\//i.test(ct)) return false;
  const field = /^content-disposition:.*\bname="?_method\b/im;
  const boundary = boundaryOf(ct);
  if (!boundary) return field.test(t.body);
  return t.body.split(`--${boundary}`).some((part) => field.test(part.split(/\r?\n\r?\n/, 1)[0] ?? ""));
}

const sorted = (h: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(h)
      .map(([k, v]) => [k.toLowerCase(), v] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );

/** SHA-256 of the canonical template: handles as handles, headers sorted, body verbatim. A multipart boundary is framing
 * a client draws anew per run (curl, requests), so it is cut from both: else no retry of an approved upload ever matched.
 * The body stays in pieces, so where each boundary stood still counts. */
export function hashTemplate(t: Template): string {
  const headers = sorted(t.headers);
  const ct = headers["content-type"] ?? "";
  const boundary = boundaryOf(ct);
  // whole delimiter lines only (RFC 2046): cut anywhere, a body with "XX" in it under boundary=XX, or a line `--XX 100`,
  // approved "evil" for "XX" as well. Left, a line that only starts like one is text, and hashes as it stands
  const delimiter = boundary && new RegExp(`\\r\\n--${literal(boundary)}(?=(?:--)?[ \\t]*(?:\\r\\n|$))`);
  const canon = JSON.stringify({
    method: t.method.toUpperCase(),
    url: t.url,
    headers: boundary ? { ...headers, "content-type": ct.replace(BOUNDARY, "; boundary=") } : headers,
    body: delimiter && t.body !== null ? `\r\n${t.body}`.split(delimiter) : t.body,
  });
  return createHash("sha256").update(canon).digest("hex");
}

// ---------------------------------------------------------------------------------------------------------------------
// Steps 1–9

export interface Prepared {
  client: Client;
  host: string;
  raw: Req;
  template: Template;
  tf?: { name: string; manifest: Manifest };
  /** the `cookie` layer runs (no credential transform for the host, or a site manifest: one with `captures`) (3h) */
  cookie: boolean;
  target: Target;
  consequential: boolean;
  /** passed the gate through an owner's approval (not role core, not handle-free) */
  approved: boolean;
  secrets: Map<string, Secret>;
  body: Readable | null;
  scrub: Scrubber;
  /** the session's own model call: its body is conversation, sent as is (handles in it are text, not handles) */
  llmCall?: boolean;
  /** a task's model call: its usage counts against `budget.tokens` */
  metered?: boolean;
  /** handle text → value, for handles minted asynchronously after the gate (installation tokens) */
  tokens?: Map<string, string>;
}

export async function prepare(client: Client, req: IncomingRequest): Promise<Prepared | Out> {
  // 1. host
  const hostHeader = req.headers.host?.replace(/:\d+$/, "").toLowerCase();
  const host = req.tls ? req.sni?.toLowerCase() : hostHeader;
  if (!host) return refuse(400, "no host");
  if (req.tls && hostHeader && hostHeader !== host) return refuse(400, "Host does not match SNI", { host });

  // 3. egress
  const task = client.task ? taskRow(client.task) : undefined;
  if (client.task && !task) return refuse(403, "unknown task", { task: client.task });
  const target = await egress(client, host, req.tls, task);
  if ("status" in target) return target;

  // 4. transform and raw request
  const tfHit = transforms.byHost(host);
  const tf = tfHit && { name: tfHit.name, manifest: tfHit.manifest };
  const cookie = (!tf || tf.manifest.captures !== undefined) && transforms.get(COOKIE) !== undefined;
  const ct = req.headers["content-type"] ?? "";
  let stream = STREAM_REQUEST.test(ct) || Number(req.headers["content-length"] ?? 0) > REQUEST_BUFFER;
  let text: string | null = null;
  let body: Readable | null = null;
  if (req.body && stream) {
    body = req.body;
    // a push's identity is its ref commands, not the pack: they become the (read-only) body the transform renders
    // and the hash covers, while the whole stream still goes upstream (v6 › Projects › Push)
    if (RECEIVE_PACK.test(ct)) ({ body, commands: text } = await peekCommands(body));
  } else if (req.body) {
    const r = await readUpTo(req.body, REQUEST_BUFFER);
    if ("rest" in r) {
      stream = true;
      body = r.rest;
    } else if (r.buf.length) {
      const s = utf8(r.buf);
      if (s === undefined) {
        stream = true;
        body = Readable.from([r.buf]);
      } else text = s;
    }
  }
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && !k.startsWith("x-hortus-")) headers[k] = v;
  const url = `${req.tls ? "https" : "http"}://${host}${req.path.startsWith("/") ? req.path : `/${req.path}`}`;
  const raw: Req = { method: req.method.toUpperCase(), url, headers, body: text, stream };

  // the session's own model credential is how it thinks, not an act: no grant, no gate, and the body (the
  // conversation, which quotes placeholders and handles) is neither checked nor resolved (v7 › Secret Vault); core's
  // model is the Planner's (the gate's judge, whose prompt quotes the request's handles)
  const cfg = ctx().config;
  const llm =
    client.role === "planner" || client.role === "core"
      ? cfg.planner.provider
      : client.role === "worker"
        ? cfg.worker.provider
        : undefined;
  const llmEntry = llm === undefined ? undefined : readVault()[llm];
  // a credential's transform defaults to its name (vault/providers.ts)
  const llmCall = llm !== undefined && llmEntry !== undefined && (llmEntry.transform ?? llm) === tf?.name;

  // 5. raw secrets anywhere
  const scrub = scrubber(host);
  for (const s of everything(raw)) {
    const hit = scrub.find(s);
    if (hit) return refuse(403, "raw credential", { host, placeholder: hit });
  }
  // handles come from transforms only: a client writing `{secret:…}` or `{sign:…}` itself would pick the op and its
  // arguments (an admin installation token, say) that no transform emits. A model call's body is conversation.
  if (everything(llmCall ? { ...raw, body: null } : raw).some((s) => s.search(HANDLE) !== -1))
    return refuse(403, "handle syntax in the request: use hortus-secret-<name> placeholders", { host });

  // 6. template
  let template: Template = raw;
  for (const name of [...(cookie ? [COOKIE] : []), ...(tf ? [tf.name] : [])]) {
    try {
      template = transforms.request(name, template, { now: Date.now(), nonce: randomUUID() });
    } catch (e) {
      log.error("transform failed", e, { transform: name, host });
      return refuse(502, "transform failed", { transform: name });
    }
    const m = template.url.match(URL_PARTS);
    if (!m || m[1]?.toLowerCase() !== url.match(URL_PARTS)?.[1]?.toLowerCase())
      return refuse(502, "transform changed the host", { transform: name });
  }

  // 7. placeholders the transform did not map
  if (everything(llmCall ? { ...template, body: null } : template).some((s) => s.includes(PREFIX)))
    return refuse(403, "unmapped placeholder", { host });

  // 8. handles: name, destination, location, task scope, project scope, consequential
  const vault = readVault();
  const tfLocations = tf ? Object.values(tf.manifest.credentials).flatMap((c) => c.locations) : [];
  let found: Found[];
  try {
    found = locate(llmCall ? { ...template, body: null } : template, tfLocations);
  } catch (e) {
    return refuse(403, `bad handle: ${(e as Error).message}`, { host });
  }
  // a declared location of a token/github-app credential holding anything but a handle: the owner's own tokens (on
  // disk, outside the vault) must not carry a session past the gate
  if (tf) {
    const strict = Object.values(tf.manifest.credentials)
      .filter((c) => c.type === "token" || c.type === "github-app")
      .flatMap((c) => c.locations);
    const handled = new Set(
      found.flatMap((f) => (f.loc === "basic:password" ? [f.loc, "header:authorization"] : [f.loc])),
    );
    const bare = occupied(template).find((loc) => declares(strict, loc) && !handled.has(loc));
    if (bare) return refuse(403, `raw credential: ${bare} holds no placeholder`, { host });
  }
  // a credential only ever leaves over TLS (dev.upstreams aside: tests talk plain HTTP to their fakes)
  if (found.length && !req.tls && !devUpstream(host))
    return refuse(403, "a credential never goes over plain http: use https", { host });
  const secrets = new Map<string, Secret>();
  const manifests = new Set<Manifest>(tf ? [tf.manifest] : []);
  let category: string | undefined;
  const requestPath = template.url.match(URL_PARTS)?.[2] || "/";
  // `{project}` takes each in-scope project of the credentials used (`<name>:<project>`), never a capture: a project
  // spans segments (`o/r`), which a capture cannot delimit
  const names = new Set(found.map((f) => f.h.name));
  const projects = (task?.scope?.repos ?? [])
    .filter((r) => names.has(r.slice(0, r.indexOf(":"))))
    .map((r) => r.slice(r.indexOf(":") + 1));
  // both ways: GitLab's `g%2Fp` is one segment to `projects/*`, and to a router that decodes first `o%2Fr` is two. An
  // in-scope project stays one: `acme%2Fservices/issues` apart read as the `*/services**` of a project called `acme`
  const path = routed(requestPath);
  const whole = projects.reduce((s, x) => s.replaceAll(encodeURIComponent(x), "-"), path);
  const apart = routed(whole.replace(/%2f/gi, "/"));
  // the scope patterns match the raw path, and upstreams (or their edges) resolve dot segments: a credentialed
  // `/projects/g%2Fp/../g%2Fother` would reach a project outside the scope. Refused, plain or encoded.
  if (found.length && /(^|\/)\.{1,2}(\/|$)/.test(apart))
    return refuse(403, "a credentialed path may not hold a dot segment", { host });
  // Rack::MethodOverride, in GitLab's stack, makes a POST whatever these say: the judged method would not be the method
  // run. No client of the shipped transforms sends one. ponytail: a custom transform for an API that needs the header
  // cannot use it through the proxy
  if (found.length && (overrideHeader(template) || overrideField(template, ct, llmCall)))
    return refuse(403, "a credentialed request may not override its method", { host });
  // v6: each push shows `old new refname`. A gzipped body (git never sends one) or a list over 1 MB shows none
  if (found.length && RECEIVE_PACK.test(ct) && template.body === null)
    return refuse(403, "a push whose ref commands cannot be read: gzipped, or over 1 MB of them; push fewer refs", {
      host,
    });
  for (const { h, loc } of found) {
    const name = h.name;
    let secret: Secret;
    if (name.startsWith("c-")) {
      const row = captured(name);
      if (!row) return refuse(403, `unknown credential ${name}`, { host });
      // `origin` is the registrable domain as this code reckons it, so tenants of a shared suffix have one (v7 › Browser)
      if (row.only ? host !== row.only : host !== row.origin && !host.endsWith(`.${row.origin}`))
        return refuse(403, `destination: ${name} does not go to ${host}`, { host });
      // a cookie rides in Cookie, a bearer token in Authorization, or where the site manifest says
      const own = row.kind === "bearer" ? "header:authorization" : "header:cookie";
      if (!declares([...tfLocations, own], loc))
        return refuse(403, `location: ${name} may not ride in ${loc}`, { host });
      secret = { captured: row };
      const origin = `origin:${row.origin}`;
      category ??= origin;
      // the task's own captures ride freely; anyone else's need a grant on the origin (a login, or the owner's
      // approval of a task-scoped grant entry); the login view is the owner at the keyboard
      if (client.task && client.role !== "login" && !family(ctx().db, client.task).includes(capturedBy(row.id) ?? "")) {
        const g = gate.check({
          caller: client,
          category: origin,
          hash: `grant:${origin}`,
          kind: "grant",
          consequential: false,
          summary: { grant: origin, task: client.task, method: template.method, host, path: requestPath },
        });
        if (g !== "pass") return pendingOut(g.pending, origin);
      }
    } else {
      const entry = Object.hasOwn(vault, name) ? vault[name] : undefined;
      if (!entry) return refuse(403, `unknown credential ${name}`, { host });
      const manifest = transforms.credentialManifest(name, entry, tf?.manifest);
      if (!hostIn(effectiveHosts(name, entry, manifest), host))
        return refuse(403, `destination: ${name} does not go to ${host}`, { host });
      if (!declares(manifestEntry(name, entry, manifest)?.locations ?? [], loc))
        return refuse(403, `location: ${name} may not ride in ${loc}`, { host });
      if (manifest) manifests.add(manifest);
      secret = { entry };
      category ??= `credential:${name}`;
      const creds = task?.scope?.credentials;
      if (client.task && creds && !creds.includes(name) && name !== llm) {
        const g = gate.check({
          caller: client,
          category: `credential:${name}`,
          hash: `grant:${name}`,
          kind: "grant",
          consequential: false,
          summary: { grant: name, task: client.task, method: template.method, host, path: requestPath },
        });
        if (g !== "pass") return pendingOut(g.pending, `credential:${name}`);
      }
    }
    const why = resolvable(h, secret);
    if (why) return refuse(403, why, { host });
    secrets.set(name, secret);
  }
  const lines = [path, apart].map((l) => `${template.method} ${host}${l}`);
  // captured credentials: every method but GET/HEAD is consequential, plus the site manifest's patterns (3h)
  const capturedOnly = found.length > 0 && found.every((f) => f.h.name.startsWith("c-"));
  // a streamed body (over 1 MB, octet-stream) is outside the hash and the judge's view: the owner decides each one
  // (git's bodies excepted, on git's paths: a push is hashed by its ref commands, a fetch writes nothing)
  const git = apart.match(/\/git-(upload|receive)-pack$/i)?.[1]?.toLowerCase();
  const blind =
    found.length > 0 &&
    template.stream &&
    !(git && ct.toLowerCase().startsWith(`application/x-git-${git}-pack-request`));
  // over http.postBuffer git first posts a bare flush to see that auth holds: no command, so nothing a receive-pack
  // writes and nothing to show the owner (it asked twice more per push, each entry blank)
  const probe =
    git === "receive" && RECEIVE_PACK.test(ct) && template.body === "0000" && req.headers["content-length"] === "4";
  // a vouched read (GraphQL) still needs repos to narrow its token to: `repositories: []` is not known to mean none
  const read = template.read === true && projects.length > 0;
  const listed = [...manifests].some((m) =>
    (m.consequential ?? []).some((p) => lines.some((l) => new RegExp(glob(p), "i").test(l))),
  );
  const consequential =
    !probe &&
    (blind ||
      // ignoring case: Telegram's method names are case-insensitive, so `/deletemessage` is `/deleteMessage`
      (!read && listed) ||
      (found.some((f) => f.h.name.startsWith("c-")) && !["GET", "HEAD"].includes(template.method.toUpperCase())));
  if (found.length && client.task) {
    for (const m of manifests) {
      if (!m.scope?.length || consequential) continue;
      const ok = m.scope.some((p) =>
        p.includes("{project}")
          ? // GitLab's API names a project URL-encoded (`g%2Fsub%2Fp`), its git URLs plain
            projects.some((x) =>
              [x, encodeURIComponent(x)].some((v) => glob(p.split("{project}").join(v)).test(`${host}${requestPath}`)),
            )
          : glob(p).test(`${host}${requestPath}`),
      );
      if (!ok) return refuse(403, `project scope: ${host}${requestPath} is outside the task's repos`, { host });
    }
  }

  // the session's own model calls, counted here too: a Worker's `curl` to its model is in no session file, and those
  // files are the Worker's. Past the budget and one context (the agent's own stop and its summary call come first) they end
  const model = found.length > 0 && found.every((f) => f.h.name === llm);
  const metered = model && !!client.task && (client.role === "worker" || client.role === "planner");
  if (metered && task?.budget && task.metered >= overdrawn(task.budget.tokens))
    return refuse(403, `budget exceeded: ${task.metered}/${task.budget.tokens} tokens through the proxy`, { host });

  // 9. gate (only requests that carry a credential); a model call only where its manifest names it: a big conversation
  // is a streamed body, and no act
  let approved = false;
  if (found.length && category && !probe && (!model || listed)) {
    const hash = hashTemplate(template);
    // a grant on the origin (checked above) passes captured-only requests that are not consequential
    const granted = capturedOnly && (client.role === "login" || !consequential);
    if (client.role !== "core" && !granted) {
      const g = await gate.request({
        caller: client,
        category,
        hash,
        consequential,
        summary: summarize(template, host, requestPath, scrub, tf?.name),
      });
      if (g !== "pass") return pendingOut(g.pending, category);
      approved = true;
    }
  }

  // installation tokens are minted only for a request that passed, per caller and its scope.repos
  const tokens = new Map<string, string>();
  for (const { h } of found) {
    if (h.op !== "installation-token" || tokens.has(h.text)) continue;
    try {
      tokens.set(h.text, await mintHandle(h, client.role, client.task, task?.scope?.repos ?? []));
    } catch (e) {
      log.error("installation token failed", e, { host });
      return refuse(502, `installation token: ${(e as Error).message}`, { host });
    }
  }
  // a token minted just now must be in the set that scrubs this very response
  const s = tokens.size ? scrubber(host) : scrub;
  return {
    client,
    host,
    raw,
    template,
    tf,
    cookie,
    target,
    consequential,
    approved,
    secrets,
    body,
    scrub: s,
    llmCall,
    metered,
    tokens,
  };
}

// `message`: all gh prints of an error body (a bare `403 Forbidden` without it)
const pendingOut = (id: number, category: string): Out =>
  json(403, {
    approval: id,
    category,
    url: gate.approvalUrl(id),
    message: `hortus: approval ${id} is waiting for the owner`,
  });

/** What an approval shows of a body. Past it the tail is hidden from the judge, so the owner decides (gate.ts). */
const PREVIEW = 8192;

function summarize(t: Template, host: string, path: string, scrub: Scrubber, tf?: string): gate.Summary {
  const body = t.body === null ? null : scrub.text(t.body);
  const s: gate.Summary = {
    method: t.method,
    host,
    // the query too: `sendMessage?chat_id=…&text=…` says all it does there
    path: path + (t.url.match(URL_PARTS)?.[3] ?? ""),
    headers: scrub.headers(t.headers),
    bodyPreview: body === null ? (t.stream ? "(streamed)" : null) : body.slice(0, PREVIEW),
  };
  if (body && body.length > PREVIEW) {
    s.bodyPreview += `\n… ${body.length - PREVIEW} more chars not shown`;
    s.cut = true;
  }
  if (tf) {
    try {
      const r = transforms.render(tf, t);
      if (r !== undefined) s.rendered = scrub.text(r);
    } catch (e) {
      log.error("render failed", e, { transform: tf });
    }
  }
  return s;
}

// ---------------------------------------------------------------------------------------------------------------------
// Step 10: upstream

const agents = {
  "http:": new http.Agent({ keepAlive: true }),
  "https:": new https.Agent({ keepAlive: true }),
};

/** `req` given: only the late handles (aws-sigv4), signed over the final request. */
function resolveIn(s: string, p: Prepared, encode: boolean, req?: Signing): string {
  for (const h of handles(s)) {
    if (req && !late.has(h.op ?? "")) continue;
    const secret = p.secrets.get(h.name);
    if (!secret) throw new Error(`unresolved handle ${h.name}`);
    const v = p.tokens?.get(h.text) ?? resolveHandle(h, secret, req);
    s = s.split(h.text).join(encode ? encodeURIComponent(v) : v);
  }
  return s;
}

/** The upstream request with handles resolved. `extra` headers (WebSocket upgrade) are added after the hop filter. */
export function upstream(
  p: Prepared,
  extra: Record<string, string> = {},
): { req: http.ClientRequest; body: Buffer | Readable | null } {
  const t = p.template;
  const [, , path = "/", query = ""] = t.url.match(URL_PARTS) ?? [];
  const q = query
    ? `?${query
        .slice(1)
        .split("&")
        .map((kv) => resolveIn(kv, p, true))
        .join("&")}`
    : "";
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(t.headers)) {
    const name = k.toLowerCase();
    if (HOP.has(name) || name === "content-length" || name === "accept-encoding") continue;
    headers[name] = resolveIn(v, p, false);
  }
  // scrubbing needs plain bytes
  headers["accept-encoding"] = "identity";
  headers.host = p.host;
  let body: Buffer | Readable | null = null;
  if (t.body !== null && !t.stream) {
    const form = /^application\/x-www-form-urlencoded/i.test(headers["content-type"] ?? "");
    body = Buffer.from(
      p.llmCall
        ? t.body
        : form
          ? t.body
              .split("&")
              .map((kv) => resolveIn(kv, p, true))
              .join("&")
          : resolveIn(t.body, p, false),
    );
    headers["content-length"] = String(body.length);
  } else if (p.body) {
    body = p.body;
    const len = p.raw.headers["content-length"];
    if (len) headers["content-length"] = len;
  }
  Object.assign(headers, extra);
  const reqPath = resolveIn(path || "/", p, false);
  const signing: Signing = {
    method: t.method,
    path: reqPath,
    query: q.slice(1),
    headers,
    payload: body instanceof Readable ? "stream" : body,
  };
  for (const [k, v] of Object.entries(headers))
    if (handles(v).some((h) => late.has(h.op ?? ""))) headers[k] = resolveIn(v, p, false, signing);
  for (const [name, s] of p.secrets) {
    if ("entry" in s) touch(name);
    else ctx().db.prepare("UPDATE captured SET last_use = ? WHERE id = ?").run(new Date().toISOString(), s.captured.id);
  }
  const mod = p.target.protocol === "https:" ? https : http;
  const req = mod.request({
    host: p.target.address,
    port: p.target.port,
    method: t.method,
    path: reqPath + q,
    headers,
    agent: Object.keys(extra).length ? false : agents[p.target.protocol],
    ...(p.target.protocol === "https:" && !isIP(p.host) ? { servername: p.host } : {}),
  });
  return { req, body };
}

// ---------------------------------------------------------------------------------------------------------------------
// Step 11: response

function flatHeaders(h: http.IncomingHttpHeaders): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined || k === "connection" || k === "keep-alive" || k === "transfer-encoding") continue;
    out[k] = v;
  }
  return out;
}

/**
 * Refs and repos are `<dof>:…`; a transform speaks only for the configured DOFs of its own type. It writes its type
 * for the DOF, which it cannot know: the DOF is the credential of that name (a connector's is `hortus-secret-<dof>`).
 */
function addRefs(p: Prepared, all: string[] | undefined, allRepos: string[] | undefined): void {
  const task = p.client.task;
  if (!task) return;
  const dofs = ctx().config.dofs;
  // a transform names refs after its type; the DOF is the one whose credential the request carried (`gle`, type gitlab)
  const type = p.tf?.name ?? "";
  const dof = [...p.secrets.keys()].find((n) => dofs[n]?.type === type);
  const named = (r: string) => (dof && r.startsWith(`${type}:`) ? `${dof}${r.slice(type.length)}` : r);
  const own = (r: string) => {
    const d = r.split(":", 1)[0] ?? "";
    return r.includes(":") && Object.hasOwn(dofs, d) && dofs[d]?.type === p.tf?.name;
  };
  const refs = all?.map(named).filter(own);
  const repos = allRepos?.map(named).filter(own);
  const db = ctx().db;
  // a live task keeps its ref; a closed one's goes to the task working there now (the Planner sees open tasks' refs)
  const ref = db.prepare(`INSERT INTO task_refs(ref, task_id) VALUES (?, ?) ON CONFLICT(ref) DO UPDATE SET
    task_id = excluded.task_id WHERE (SELECT status FROM tasks WHERE id = task_refs.task_id) IN ('done', 'failed')`);
  for (const r of refs ?? []) ref.run(r, task);
  if (repos?.length && p.consequential && p.approved) {
    const row = taskRow(task);
    const scope = row?.scope ?? {};
    scope.repos = [...new Set([...(scope.repos ?? []), ...repos])];
    db.prepare("UPDATE tasks SET scope = ? WHERE id = ?").run(JSON.stringify(scope), task);
  }
}

const joined = (h: Record<string, string | string[]>): Record<string, string> =>
  Object.fromEntries(Object.entries(h).map(([k, v]) => [k, Array.isArray(v) ? v.join("\n") : v]));

const DECODERS: Record<string, () => Transform> = {
  gzip: () => zlib.createGunzip(),
  "x-gzip": () => zlib.createGunzip(),
  deflate: () => zlib.createInflate(),
  br: () => zlib.createBrotliDecompress(),
};

/** Responses one client may be buffering at once (≤ 16 MB each, a few copies while scrubbed and transformed): 10
 * endless bodies cost hortusd 165 MB, and MAX_INFLIGHT of them would have been ~12 GB. Further responses wait, their
 * upstream sockets paused. `BUFFERING_ALL` bounds every client together (review round 6: 20 Workers × 4 were +1.1 GB);
 * a freed slot goes to the oldest waiter whose client is under its own bound. hortusd's own (core) calls are not
 * counted. */
export const BUFFERING = 4;
export const BUFFERING_ALL = 16;
export const BUFFER_MS = 30_000;
const owned = new Map<Client, number>();
const waiters: { c: Client; go: () => void }[] = [];
let buffering = 0;
const free = (c: Client) => buffering < BUFFERING_ALL && (owned.get(c) ?? 0) < BUFFERING;
const take = (c: Client) => {
  buffering++;
  owned.set(c, (owned.get(c) ?? 0) + 1);
};

async function slot(c: Client): Promise<() => void> {
  if (c.role === "core") return () => {};
  if (free(c)) take(c);
  else await new Promise<void>((go) => waiters.push({ c, go }));
  return () => {
    buffering--;
    const n = (owned.get(c) ?? 1) - 1;
    if (n) owned.set(c, n);
    else owned.delete(c);
    const i = waiters.findIndex((w) => free(w.c));
    const w = i < 0 ? undefined : waiters.splice(i, 1)[0];
    if (w) {
      take(w.c); // the slot passes on
      w.go();
    }
  };
}

/** Where the proxy refuses a task's model calls: `budget.tokens` plus one context, for the summary after the agent's stop. */
export const overdrawn = (tokens: number): number => tokens + ctx().config.worker.context_window;

/**
 * Input and output tokens of a model response or an SSE event, as core reckons them (`usage` of the openai and anthropic
 * providers), so a call the agent also logs counts the same. ponytail: the two shipped shapes, in the proxy rather than
 * in `transforms/` because a stream skips `response()`; a custom provider's other shape is not counted.
 */
function usageOf(v: unknown): { input: number; output: number } | undefined {
  const o = v as { usage?: unknown; message?: { usage?: unknown }; response?: { usage?: unknown } } | null;
  const u = (o?.usage ?? o?.message?.usage ?? o?.response?.usage) as Record<string, unknown> | null | undefined;
  if (!u || typeof u !== "object") return undefined;
  const n = (k: string) => (typeof u[k] === "number" && u[k] > 0 && u[k] < 1e12 ? u[k] : 0);
  return {
    input: n("prompt_tokens") || n("input_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens"),
    output: n("completion_tokens") || n("output_tokens"),
  };
}

function charge(p: Prepared, tokens: number): void {
  if (tokens > 0)
    ctx()
      .db.prepare("UPDATE tasks SET metered = metered + ? WHERE id = ?")
      .run(tokens, p.client.task as string);
}

/** A stream's usage, read as it passes. A stream reports none unless asked (`stream_options`, which a `curl` leaves out):
 * then its bytes, at 4 a token, or that one flag would be a way round the count. */
function meterStream(p: Prepared, r: Readable): void {
  const text = new StringDecoder("utf8");
  let carry = "";
  let bytes = p.raw.body?.length ?? 0;
  let input = 0;
  let output = 0;
  let seen = false;
  const line = (l: string) => {
    if (!l.includes('"usage"')) return;
    try {
      const u = usageOf(JSON.parse(l.replace(/^data:\s*/, "")));
      if (!u) return;
      seen = true;
      input = Math.max(input, u.input); // Anthropic's arrive in two events, each cumulative
      output = Math.max(output, u.output);
    } catch {} // not JSON: nothing to count
  };
  r.on("data", (b: Buffer) => {
    bytes += b.length;
    const lines = (carry + text.write(b)).split("\n");
    carry = (lines.pop() ?? "").slice(-(1 << 20));
    lines.forEach(line);
  });
  r.once("close", () => {
    line(carry);
    charge(p, seen ? input + output : Math.ceil(bytes / 4));
  });
}

/** Set-Cookie captured first, whatever the body or transport (HEAD, 204, a stream, binary, a WebSocket's handshake): the
 * client never gets a real value. The scrubber that knows the capture. */
export function takeCookies(p: Prepared, res: http.IncomingMessage): Scrubber {
  if (!p.cookie || res.headers["set-cookie"] === undefined) return p.scrub;
  // unscrubbed: a value it already knows would read as a placeholder and its new Expires be lost (a rolling session)
  const raw = joined(flatHeaders(res.headers));
  const r = transforms.response(COOKIE, { status: res.statusCode ?? 502, headers: raw, body: null }, p.raw);
  if (!r.capture?.length) return p.scrub;
  store(p, r.capture);
  return scrubber(p.host);
}

export async function respond(p: Prepared, res: http.IncomingMessage): Promise<Out> {
  const status = res.statusCode ?? 502;
  let scrub: Scrubber;
  try {
    scrub = takeCookies(p, res);
  } catch (e) {
    res.resume();
    log.error("transform failed", e, { transform: COOKIE, host: p.host });
    return refuse(502, "transform failed", { transform: COOKIE });
  }
  let headers = scrub.headers(flatHeaders(res.headers));
  const ct = String(res.headers["content-type"] ?? "");
  if (p.raw.method === "HEAD" || status === 204 || status === 304) {
    res.resume();
    return { status, headers, body: "" };
  }
  // a web page (any HTML response, credentialed or not: the browser's loads, a forge's issue page) taints the task for
  // good (v7 › Review round 6). ponytail: HTML only; a stranger's text in JSON, plain text or an API response is not
  // tracked (npm, PyPI and Go would taint every build); add types if that bites. A messenger's history is: the prompt no
  // longer sends Workers there (round 18), so what reads it means to. A forge's issues through its API stay a ceiling: the
  // forge prompt needs them, and tainting them is `auto` meaning `human`
  if (p.client.task && p.client.role === "worker" && HTML.test(ct))
    taint(ctx().db, p.client.task, `read a web page: ${p.host}`);
  const asked = `${p.raw.method} ${p.host}${routed(p.template.url.match(URL_PARTS)?.[2] ?? "")}`;
  if (p.client.task && p.client.role === "worker" && HISTORY.test(asked))
    taint(ctx().db, p.client.task, `read a messenger's history: ${p.host}`);
  // `accept-encoding: identity` is only a request: a compressed body would hide every value from the scrubber
  let src: Readable = res;
  const enc = String(res.headers["content-encoding"] ?? "identity")
    .toLowerCase()
    .trim();
  if (enc !== "identity") {
    const decode = DECODERS[enc];
    if (!decode) {
      res.resume();
      return refuse(502, `unsupported content-encoding ${enc}`, { host: p.host });
    }
    const d = decode();
    pipeline(res, d, () => {});
    src = d;
    const { "content-encoding": _e, "content-length": _l, ...plain } = headers;
    headers = plain;
  }
  const streamed = (r: Readable): Out => {
    if (p.metered) meterStream(p, r);
    const { "content-length": _, ...h } = headers;
    const s = scrub.stream();
    pipeline(r, s, () => {});
    return { status, headers: h, body: s };
  };
  // a host with no transform has nothing to read in a body (its Set-Cookie is captured above): held until whole, a wheel
  // at 500 KB/s sent no byte past pip's 15 s read timeout, and four such downloads held every slot of a client
  if (STREAM_RESPONSE.test(ct) || !p.tf) return streamed(src);
  const release = await slot(p.client);
  let r: Awaited<ReturnType<typeof readUpTo>>;
  try {
    // a body still arriving after BUFFER_MS streams on (as one over 16 MB does): a drip cannot hold the slot
    r = await readUpTo(src, RESPONSE_BUFFER, BUFFER_MS);
  } finally {
    release();
  }
  // ponytail: over 16 MB (or still arriving after 30 s) skips response() and is scrubbed as a stream, not refused
  if ("rest" in r) return streamed(r.rest);
  const text = utf8(r.buf);
  // no `usage`, no charge (an error, a model list): a provider that reports none is not stopped by this
  if (p.metered && text !== undefined) {
    try {
      const u = usageOf(JSON.parse(text));
      if (u) charge(p, u.input + u.output);
    } catch {} // not JSON: nothing to count
  }
  if (text === undefined) {
    const body = scrub.bytes(r.buf);
    return { status, headers: { ...headers, "content-length": String(body.length) }, body };
  }
  let result: ReturnType<typeof transforms.response> = {
    res: { status, headers: joined(headers), body: scrub.text(text) },
  };
  const capture: Capture[] = [];
  // the host's transform first, then the cookie layer over its result (with the site manifest, for body captures)
  for (const name of [...(p.tf ? [p.tf.name] : []), ...(p.cookie ? [COOKIE] : [])]) {
    const site = name === COOKIE && p.tf ? { captures: p.tf.manifest.captures ?? [] } : undefined;
    try {
      const r = transforms.response(name, result.res, p.raw, undefined, site);
      capture.push(...(r.capture ?? []));
      result = { ...result, ...r };
    } catch (e) {
      log.error("transform failed", e, { transform: name, host: p.host });
      return refuse(502, "transform failed", { transform: name });
    }
  }
  if (capture.length) {
    store(p, capture);
    scrub = scrubber(p.host);
  }
  addRefs(p, result.refs, result.repos);
  headers = {};
  for (const [k, v] of Object.entries(result.res.headers)) {
    if (k.toLowerCase() === "content-length") continue;
    headers[k] = k.toLowerCase() === "set-cookie" ? scrub.text(v).split("\n") : scrub.text(v);
  }
  const body = Buffer.from(scrub.text(result.res.body ?? ""));
  return { status: result.res.status, headers: { ...headers, "content-length": String(body.length) }, body };
}

const COOKIE = "cookie";
type Capture = NonNullable<ResponseResult["capture"]>[number];

const capturedBy = (id: number): string | null =>
  (
    ctx().db.prepare("SELECT json_extract(meta, '$.task') AS task FROM captured WHERE id = ?").get(id) as
      | { task: string | null }
      | undefined
  )?.task ?? null;

/**
 * Captures → `captured` rows named `c-<id>`, keyed by (origin, kind, cookie or token name, capturing task): a cookie the
 * site sets again replaces the value under the same name, so jars keep working. Replaced as insert, then delete: the id
 * moves up and the scrubber (keyed on count and max id) rebuilds; the other way round SQLite gives the newest row its id
 * back, and a site that rotates its cookie handed the Worker the real value. A capture for another site than the
 * request's is dropped.
 */
function store(p: Prepared, list: Capture[]): void {
  const db = ctx().db;
  const task = p.client.task ?? null;
  const t = new Date().toISOString();
  for (const c of list) {
    if (p.host !== c.origin && !p.host.endsWith(`.${c.origin}`)) {
      log.error("capture for another origin dropped", undefined, { host: p.host, origin: c.origin });
      continue;
    }
    // a host-only cookie is its host's, as in a browser: a sibling's `session` must not replace it under one placeholder
    const hostOnly = c.kind === "cookie" && c.meta?.domain === undefined;
    const key = `${String(c.meta?.cookieName ?? c.meta?.key ?? c.name)}${hostOnly ? `@${p.host}` : ""}`;
    const meta = JSON.stringify({ ...c.meta, key, host: p.host, task, via: p.client.role });
    const old = db
      .prepare(
        "SELECT id, name FROM captured WHERE origin = ? AND kind IS ? AND json_extract(meta, '$.key') = ? AND json_extract(meta, '$.task') IS ?",
      )
      .get(c.origin, c.kind ?? null, key, task) as { id: number; name: string } | undefined;
    // `created` is this value's: a Max-Age counts from it (jar.ts), and a site's rolling session sets it on every response
    const r = db
      .prepare("INSERT INTO captured(name, value, origin, kind, created, last_use, meta) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(`c-new-${randomUUID()}`, c.value, c.origin, c.kind ?? null, t, t, meta);
    if (old) db.prepare("DELETE FROM captured WHERE id = ?").run(old.id);
    db.prepare("UPDATE captured SET name = coalesce(?, 'c-' || id) WHERE id = ?").run(
      old?.name ?? null,
      r.lastInsertRowid,
    );
  }
}

/** An upstream socket with no bytes either way for this long is dropped (a server that never answers, or never
 * finishes TLS, held its socket and fd forever). Streams are fine: LLM streams and git keep bytes flowing. */
export const IDLE_MS = 10 * 60_000;

/** Ends the upstream side when `signal` aborts (the client hung up) or the socket idles past IDLE_MS. */
export function bound(req: http.ClientRequest, signal?: AbortSignal): void {
  req.setTimeout(IDLE_MS, () => req.destroy(new Error(`no bytes for ${IDLE_MS / 60_000} min`)));
  if (!signal) return;
  if (signal.aborted) return void req.destroy(new Error("the client went away"));
  const abort = () => req.destroy(new Error("the client went away"));
  signal.addEventListener("abort", abort, { once: true });
  req.once("close", () => signal.removeEventListener("abort", abort));
}

/** The whole pipeline for one request; `signal` aborts the upstream request (the client hung up). */
export async function handle(client: Client, req: IncomingRequest, signal?: AbortSignal): Promise<Out> {
  const h = (req.tls ? req.sni : req.headers.host?.replace(/:\d+$/, ""))?.toLowerCase();
  // 2. hortusd.internal
  if (h === "hortusd.internal") return internal(client, req);
  const p = await prepare(client, req);
  if ("status" in p) return p;
  let up: ReturnType<typeof upstream>;
  try {
    up = upstream(p);
  } catch (e) {
    return refuse(403, (e as Error).message, { host: p.host });
  }
  bound(up.req, signal);
  return new Promise<Out>((resolve) => {
    let rawHit = false;
    up.req.on("response", (res) => {
      respond(p, res).then(resolve, (e) => resolve(refuse(502, `upstream: ${(e as Error).message}`)));
    });
    up.req.on("error", (e) =>
      resolve(rawHit ? refuse(403, "raw credential", { host: p.host }) : refuse(502, `upstream: ${e.message}`)),
    );
    if (up.body instanceof Readable) {
      // a streamed body is checked on the fly: a raw secret aborts the upstream request
      const detect = p.scrub.stream(() => {
        rawHit = true;
        return new Error("raw credential in streamed body");
      });
      pipeline(up.body, detect, up.req, (e) => {
        if (e) up.req.destroy(e);
      });
    } else up.req.end(up.body ?? undefined);
  });
}
