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
import { PassThrough, pipeline, Readable } from "node:stream";
import { logger } from "../log.ts";
import type { Manifest, Req, Template } from "../types.ts";
import * as gate from "../vault/gate.ts";
import { type Handle, handles, late, resolvable, resolveHandle, type Secret } from "../vault/ops.ts";
import type { Signing } from "../vault/sigv4.ts";
import type { Scrubber } from "../vault/scrub.ts";
import * as transforms from "../vault/transforms.ts";
import {
  captured,
  ctx,
  effectiveHosts,
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
}

function taskRow(id: string): TaskRow | undefined {
  const r = ctx().db.prepare("SELECT scope, origins FROM tasks WHERE id = ?").get(id) as
    | { scope: string | null; origins: string | null }
    | undefined;
  if (!r) return undefined;
  return { scope: r.scope ? JSON.parse(r.scope) : null, origins: r.origins ? JSON.parse(r.origins) : null };
}

/** Global `origins` merged with the task row's (already narrowed by its projects when the dispatcher wrote it). */
function originsFor(task: TaskRow | undefined): "*" | string[] {
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
] as const)
  PRIVATE.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
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
  const v4 = address.startsWith("::ffff:") ? address.slice(7) : address;
  return PRIVATE.check(v4, isIP(v4) === 6 ? "ipv6" : "ipv4");
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

export async function egress(
  client: Client,
  host: string,
  tls: boolean,
  task: TaskRow | undefined,
): Promise<Target | Out> {
  const origins = client.role === "core" ? "*" : originsFor(task);
  if (origins !== "*" && !origins.includes(host)) return refuse(403, `host not in origins: ${host}`, { host });
  const dev = devUpstream(host);
  if (dev) {
    const protocol = dev.protocol === "https:" ? "https:" : "http:";
    return { protocol, address: dev.hostname, port: Number(dev.port) || (protocol === "https:" ? 443 : 80) };
  }
  let addresses: { address: string }[];
  try {
    addresses = await dnsLookup(host, { all: true });
  } catch (e) {
    return refuse(502, `cannot resolve ${host}: ${(e as NodeJS.ErrnoException).code ?? e}`);
  }
  // "*" never includes loopback/private/link-local unless chat.allow lists it; core (hortusd itself) is the owner
  const pick = addresses[0];
  if (client.role !== "core" && origins === "*") {
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

/** Buffers up to `max` bytes; past that, a stream of everything (the buffered prefix first). */
export function readUpTo(r: Readable, max: number): Promise<{ buf: Buffer } | { rest: Readable }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    const cleanup = () => {
      r.off("data", onData);
      r.off("end", onEnd);
      r.off("error", onErr);
    };
    const onData = (c: Buffer) => {
      chunks.push(c);
      n += c.length;
      if (n <= max) return;
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
  });
}

const utf8 = (b: Buffer): string | undefined => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(b);
  } catch {
    return undefined;
  }
};

const STREAM_REQUEST = /^application\/(x-git-|octet-stream)/i;
const STREAM_RESPONSE = /^(text\/event-stream|application\/x-git-)/i;
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

/** `*` one segment, `**` anything, `{project}` one or more segments (captured). */
function glob(p: string): RegExp {
  const src = p
    .split(/(\*\*|\*|\{project\})/)
    .map((s) =>
      s === "**" ? ".*" : s === "*" ? "[^/]*" : s === "{project}" ? "(.+?)" : s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("");
  return new RegExp(`^${src}$`);
}

const sorted = (h: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(h)
      .map(([k, v]) => [k.toLowerCase(), v] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );

/** SHA-256 of the canonical template: handles as handles, headers sorted, body verbatim. */
export function hashTemplate(t: Template): string {
  const canon = JSON.stringify({
    method: t.method.toUpperCase(),
    url: t.url,
    headers: sorted(t.headers),
    body: t.body,
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
  target: Target;
  consequential: boolean;
  /** passed the gate through an owner's approval (not role core, not handle-free) */
  approved: boolean;
  secrets: Map<string, Secret>;
  body: Readable | null;
  scrub: Scrubber;
  /** the session's own model call: its body is conversation, sent as is (handles in it are text, not handles) */
  llmCall?: boolean;
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
  const ct = req.headers["content-type"] ?? "";
  let stream = STREAM_REQUEST.test(ct) || Number(req.headers["content-length"] ?? 0) > REQUEST_BUFFER;
  let text: string | null = null;
  let body: Readable | null = null;
  if (req.body && stream) body = req.body;
  else if (req.body) {
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

  // 5. raw secrets anywhere
  const scrub = scrubber();
  for (const s of everything(raw)) {
    const hit = scrub.find(s);
    if (hit) return refuse(403, "raw credential", { host, placeholder: hit });
  }

  // 6. template
  let template: Template = raw;
  if (tf) {
    try {
      template = transforms.request(tf.name, raw, { now: Date.now(), nonce: randomUUID() });
    } catch (e) {
      log.error("transform failed", e, { transform: tf.name, host });
      return refuse(502, "transform failed", { transform: tf.name });
    }
    const m = template.url.match(URL_PARTS);
    if (!m || m[1]?.toLowerCase() !== url.match(URL_PARTS)?.[1]?.toLowerCase())
      return refuse(502, "transform changed the host", { transform: tf.name });
  }

  // the session's own model credential is how it thinks, not an act: no grant, no gate, and the body (the
  // conversation, which quotes placeholders and handles) is neither checked nor resolved (v7 › Secret Vault)
  const cfg = ctx().config;
  const llm =
    client.role === "planner" ? cfg.planner.provider : client.role === "worker" ? cfg.worker.provider : undefined;
  const llmCall = llm !== undefined && tf !== undefined && readVault()[llm]?.transform === tf.name;

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
  const secrets = new Map<string, Secret>();
  const manifests = new Set<Manifest>(tf ? [tf.manifest] : []);
  let category: string | undefined;
  const requestPath = template.url.match(URL_PARTS)?.[2] || "/";
  for (const { h, loc } of found) {
    const name = h.name;
    let secret: Secret;
    if (name.startsWith("c-")) {
      const row = captured(name);
      if (!row) return refuse(403, `unknown credential ${name}`, { host });
      if (host !== row.origin && !host.endsWith(`.${row.origin}`))
        return refuse(403, `destination: ${name} does not go to ${host}`, { host });
      // ponytail: captured locations = anything the host's transform declares, plus Cookie (3h refines per kind)
      if (!declares([...tfLocations, "header:cookie"], loc))
        return refuse(403, `location: ${name} may not ride in ${loc}`, { host });
      secret = { captured: row };
      category ??= `origin:${row.origin}`;
    } else {
      const entry = vault[name];
      if (!entry) return refuse(403, `unknown credential ${name}`, { host });
      const manifest = (entry.transform && transforms.get(entry.transform)?.manifest) || tf?.manifest;
      if (!effectiveHosts(name, entry, manifest).includes(host))
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
  const line = `${template.method} ${host}${requestPath}`;
  const consequential = [...manifests].some((m) => (m.consequential ?? []).some((p) => glob(p).test(line)));
  if (found.length && client.task) {
    for (const m of manifests) {
      if (!m.scope?.length || consequential) continue;
      const repos = task?.scope?.repos ?? [];
      const ok = m.scope.some((p) => {
        const hit = glob(p).exec(`${host}${requestPath}`);
        return hit && (hit[1] === undefined || repos.some((r) => r === hit[1] || r.endsWith(`:${hit[1]}`)));
      });
      if (!ok) return refuse(403, `project scope: ${host}${requestPath} is outside the task's repos`, { host });
    }
  }

  // 9. gate (only requests that carry a credential)
  let approved = false;
  if (found.length && category && !found.every((f) => f.h.name === llm)) {
    const hash = hashTemplate(template);
    if (client.role !== "core") {
      const g = gate.check({
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
  return { client, host, raw, template, tf, target, consequential, approved, secrets, body, scrub, llmCall };
}

const pendingOut = (id: number, category: string): Out =>
  json(403, { approval: id, category, url: gate.approvalUrl(id) });

function summarize(t: Template, host: string, path: string, scrub: Scrubber, tf?: string): gate.Summary {
  const s: gate.Summary = {
    method: t.method,
    host,
    path,
    headers: scrub.headers(t.headers),
    bodyPreview: t.body === null ? (t.stream ? "(streamed)" : null) : scrub.text(t.body).slice(0, 2048),
  };
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
    const v = resolveHandle(h, secret, req);
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

function addRefs(p: Prepared, refs: string[] | undefined, repos: string[] | undefined): void {
  const task = p.client.task;
  if (!task) return;
  const db = ctx().db;
  for (const r of refs ?? []) db.prepare("INSERT OR IGNORE INTO task_refs(ref, task_id) VALUES (?, ?)").run(r, task);
  if (repos?.length && p.consequential && p.approved) {
    const row = taskRow(task);
    const scope = row?.scope ?? {};
    scope.repos = [...new Set([...(scope.repos ?? []), ...repos])];
    db.prepare("UPDATE tasks SET scope = ? WHERE id = ?").run(JSON.stringify(scope), task);
  }
}

async function respond(p: Prepared, res: http.IncomingMessage): Promise<Out> {
  const status = res.statusCode ?? 502;
  let headers = p.scrub.headers(flatHeaders(res.headers));
  const ct = String(res.headers["content-type"] ?? "");
  if (p.raw.method === "HEAD" || status === 204 || status === 304) {
    res.resume();
    return { status, headers, body: "" };
  }
  const streamed = (r: Readable): Out => {
    const { "content-length": _, ...h } = headers;
    const s = p.scrub.stream();
    pipeline(r, s, () => {});
    return { status, headers: h, body: s };
  };
  if (STREAM_RESPONSE.test(ct)) return streamed(res);
  const r = await readUpTo(res, RESPONSE_BUFFER);
  // ponytail: over 16 MB skips response() and is scrubbed as a stream (downloads), not refused
  if ("rest" in r) return streamed(r.rest);
  const text = utf8(r.buf);
  if (text === undefined || !p.tf) {
    const body = text === undefined ? p.scrub.bytes(r.buf) : Buffer.from(p.scrub.text(text));
    return { status, headers: { ...headers, "content-length": String(body.length) }, body };
  }
  const flat: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) flat[k] = Array.isArray(v) ? v.join("\n") : v;
  let result: ReturnType<typeof transforms.response>;
  try {
    result = transforms.response(p.tf.name, { status, headers: flat, body: p.scrub.text(text) }, p.raw);
  } catch (e) {
    log.error("transform failed", e, { transform: p.tf.name, host: p.host });
    return refuse(502, "transform failed", { transform: p.tf.name });
  }
  if (result.capture?.length) {
    const db = ctx().db;
    for (const c of result.capture)
      db.prepare(
        "INSERT INTO captured(name, value, origin, kind, created) VALUES (?, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, origin = excluded.origin, kind = excluded.kind",
      ).run(c.name, c.value, c.origin, c.kind ?? null, new Date().toISOString());
  }
  addRefs(p, result.refs, result.repos);
  const scrub = result.capture?.length ? scrubber() : p.scrub;
  headers = {};
  for (const [k, v] of Object.entries(result.res.headers)) {
    if (k.toLowerCase() === "content-length") continue;
    headers[k] = k.toLowerCase() === "set-cookie" ? scrub.text(v).split("\n") : scrub.text(v);
  }
  const body = Buffer.from(scrub.text(result.res.body ?? ""));
  return { status: result.res.status, headers: { ...headers, "content-length": String(body.length) }, body };
}

/** The whole pipeline for one request. */
export async function handle(client: Client, req: IncomingRequest): Promise<Out> {
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
