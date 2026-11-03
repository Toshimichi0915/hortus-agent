/**
 * The remote console listener (10-remote-console.md): HTTPS on `console.listen` with `console.tls` or a leaf minted
 * from the hortus CA for `console.host`, the same pages behind a passkey login. `gate()` runs inside the shared
 * request handler (server.ts) after the Host and Sec-Fetch-Site guards; it answers the login, enrolment and WebAuthn
 * requests itself and lets a request through only with a live `__Host-hortus` session.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { z } from "zod";
import type { Ctx } from "../ctx.ts";
import type { DatabaseSync } from "../db.ts";
import { now } from "../db.ts";
import { define } from "../rpc.ts";
import { remoteConsole } from "../runtime/net.ts";
import { RpcError } from "../types.ts";
import { hostContext, validHost } from "../vault/ca.ts";
import { bus } from "./events.ts";
import { parse } from "./html.ts";
import { enrollPage } from "./pages/enroll.ts";
import { loginPage } from "./pages/login.ts";
import { handler, json, readBody, send } from "./server.ts";

export const COOKIE = "__Host-hortus";
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
export const IDLE_MS = 30 * DAY;
const CODE_MS = 10 * MIN;
const CHALLENGE_MS = 5 * MIN;
const HOURLY = 60 * MIN;

interface Tls {
  cert: string;
  key: string;
  mtimes: string;
}

interface State {
  ctx: Ctx;
  server: Server;
  host: string;
  port: number;
  /** `https://host[:port]`: the WebAuthn origin and the base of every URL handed out */
  url: string;
  /** set when the files come from `console.tls` (re-read when they change) */
  tls?: Tls;
  timer: NodeJS.Timeout;
}

let state: State | undefined;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** `addr:port`, `[v6]:port`, `:port` or `port`; an empty address listens on every one. */
export function parseListen(listen: string): { address?: string; port: number } {
  const i = listen.lastIndexOf(":");
  const address = i < 0 ? "" : listen.slice(0, i).replace(/^\[|\]$/g, "");
  const port = Number(listen.slice(i + 1));
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`console.listen: bad port in ${listen}`);
  return address ? { address, port } : { port };
}

function readTls(ctx: Ctx, cert: string, key: string): Tls {
  const st = statSync(key);
  if (st.mode & 0o004) ctx.log("console").error("console.tls key is world-readable", undefined, { key });
  const mtimes = `${statSync(cert).mtimeMs}:${st.mtimeMs}`;
  return { cert: readFileSync(cert, "utf8"), key: readFileSync(key, "utf8"), mtimes };
}

/** The listener; `stopRemote()` closes it. Throws on a missing `console.host` or unreadable TLS files. */
export async function startRemote(ctx: Ctx): Promise<void> {
  const c = ctx.config.console;
  if (!c?.listen) return;
  if (!c.host) throw new Error("console.listen needs console.host (the certificate name and the passkey RP ID)");
  const host = validHost(c.host);
  const { address, port } = parseListen(c.listen);
  let tls: Tls | undefined;
  let creds: { cert: string; key: string };
  if (c.tls) creds = tls = readTls(ctx, c.tls.cert, c.tls.key);
  else {
    await hostContext(host);
    const at = (ext: string) => readFileSync(join(ctx.paths.ca(), "hosts", `${host}.${ext}`), "utf8");
    creds = { cert: at("crt"), key: at("key") };
  }
  const server: Server = createServer(
    creds,
    handler(ctx, () => (server.address() as AddressInfo).port, true),
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, address, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const actual = (server.address() as AddressInfo).port;
  remoteConsole.port = actual;
  const timer = setInterval(() => hourly(), HOURLY);
  timer.unref();
  state = { ctx, server, host, port: actual, url: `https://${host}${actual === 443 ? "" : `:${actual}`}`, tls, timer };
  ctx.log("console").info("remote listening", { listen: c.listen, port: actual, tls: c.tls ? "console.tls" : "ca" });
}

export async function stopRemote(): Promise<void> {
  const s = state;
  if (!s) return;
  state = undefined;
  remoteConsole.port = 0;
  clearInterval(s.timer);
  s.server.closeAllConnections();
  await new Promise<void>((resolve) => s.server.close(() => resolve()));
}

/** `https://console.host[:port]` while the remote listener runs. */
export const remoteUrl = (): string | undefined => state?.url;

/** The hourly chores: idle sessions and expired codes out, `console.tls` re-read when its files changed. */
export function hourly(at = Date.now()): void {
  const s = state;
  if (!s) return;
  const db = s.ctx.db;
  const cut = new Date(at - IDLE_MS).toISOString();
  const gone = db.prepare("DELETE FROM console_sessions WHERE last_seen < ?").run(cut).changes;
  db.prepare("DELETE FROM enroll_codes WHERE expires_at < ?").run(new Date(at).toISOString());
  if (gone) {
    s.ctx.log("console").info("idle sessions removed", { count: gone });
    bus.emit("sessions"); // their open SSE streams end (server.ts › openStream)
  }
  const t = s.ctx.config.console?.tls;
  if (s.tls && t) {
    try {
      const next = readTls(s.ctx, t.cert, t.key);
      if (next.mtimes !== s.tls.mtimes) {
        s.server.setSecureContext({ cert: next.cert, key: next.key });
        s.tls = next;
        s.ctx.log("console").info("console.tls reloaded");
      }
    } catch (e) {
      s.ctx.log("console").error("console.tls reload failed; keeping the old certificate", e);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// sessions

function cookieToken(req: IncomingMessage): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, v] = part.trim().split("=", 2);
    if (k === COOKIE && v) return v;
  }
  return undefined;
}

/** The session row's hash for this request's cookie; touches `last_seen` at most once a minute. */
function lookup(db: DatabaseSync, req: IncomingMessage): string | undefined {
  const token = cookieToken(req);
  if (!token) return undefined;
  const hash = sha(token);
  const row = db.prepare("SELECT last_seen FROM console_sessions WHERE hash = ?").get(hash) as
    | { last_seen: string }
    | undefined;
  if (!row) return undefined;
  const age = Date.now() - Date.parse(row.last_seen);
  if (age > IDLE_MS) {
    db.prepare("DELETE FROM console_sessions WHERE hash = ?").run(hash);
    return undefined;
  }
  if (age > MIN) db.prepare("UPDATE console_sessions SET last_seen = ? WHERE hash = ?").run(now(), hash);
  return hash;
}

function login(db: DatabaseSync, req: IncomingMessage, res: ServerResponse, device: string): void {
  const token = randomBytes(32).toString("base64url");
  const t = now();
  db.prepare("INSERT INTO console_sessions(hash, device, created, last_seen, address) VALUES (?, ?, ?, ?, ?)").run(
    sha(token),
    device,
    t,
    t,
    req.socket.remoteAddress ?? "",
  );
  // Max-Age is the browser's cap (400 days): the idle limit is enforced here, by last_seen
  res.setHeader("Set-Cookie", `${COOKIE}=${token}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=34560000`);
}

// ---------------------------------------------------------------------------------------------------------------------
// the gate

const PUBLIC_STATIC = /^\/static\/(?:app\.css|webauthn\.js)$/;

/**
 * Called for every remote request. Returns the session hash to go on with (`""` for the login page's static files),
 * or `undefined` when it has answered the request itself.
 */
export async function gate(ctx: Ctx, req: IncomingMessage, res: ServerResponse, url: URL): Promise<string | undefined> {
  const s = state;
  const path = url.pathname;
  if (!s) {
    send(res, 503, "text/plain", "remote console stopped");
    return undefined;
  }
  if (req.method === "POST" && path.startsWith("/webauthn/")) {
    await webauthn(s, path, req, res);
    return undefined;
  }
  if (req.method === "GET" && path === "/enroll") {
    const code = url.searchParams.get("code") ?? "";
    send(res, 200, "text/html", liveCode(ctx.db, code) ? enrollPage(s.host, code) : loginPage(s.host));
    return undefined;
  }
  const session = lookup(ctx.db, req);
  if (session) return session;
  if ((req.method === "GET" || req.method === "HEAD") && PUBLIC_STATIC.test(path)) return "";
  req.resume();
  const denied = req.method === "POST" || path.startsWith("/events/");
  send(res, denied ? 401 : 200, "text/html", loginPage(s.host));
  return undefined;
}

// ---------------------------------------------------------------------------------------------------------------------
// WebAuthn

const registering = new Map<string, { challenge: string; exp: number }>();
const challenges = new Map<string, { exp: number; address: string }>();
/** Login challenges one remote address may hold: a flood from one cannot push out the owner's pending one. */
export const PER_ADDRESS = 5;

// ponytail: per address, not per /64: an IPv6 host with many addresses can still fill the 1000; rate-limit if seen
/** Expired challenges out; at most 1000 outstanding (the oldest go first): login/options is unauthenticated. */
function remember<V>(m: Map<string, V>, k: string, v: V, exp: (v: V) => number): void {
  const t = Date.now();
  for (const [key, val] of m) if (exp(val) < t || m.size >= 1000) m.delete(key);
  m.set(k, v);
}

interface PasskeyRow {
  id: string;
  public_key: string;
  counter: number;
  device: string;
  transports: string;
}

const passkeys = (db: DatabaseSync) =>
  db.prepare("SELECT * FROM passkeys ORDER BY created").all() as unknown as PasskeyRow[];

function liveCode(db: DatabaseSync, code: string): boolean {
  return !!code && !!db.prepare("SELECT 1 FROM enroll_codes WHERE code = ? AND expires_at > ?").get(code, now());
}

const Body = z.object({
  code: z.string().max(100).optional(),
  device: z.string().max(200).optional(),
  response: z.looseObject({ id: z.string(), response: z.looseObject({}) }).optional(),
});

class Refused extends Error {}

const EXPIRED = "This enrolment link has expired or was already used. Make a new one in Settings at the machine.";

async function webauthn(s: State, path: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const db = s.ctx.db;
  const log = s.ctx.log("console");
  const address = req.socket.remoteAddress;
  const text = await readBody(req);
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(JSON.parse(text ?? ""));
  } catch {
    return json(res, 400, { error: { message: "The request was malformed." } });
  }
  try {
    switch (path) {
      case "/webauthn/register/options": {
        const code = body.code ?? "";
        if (!liveCode(db, code)) throw new Refused(EXPIRED);
        const options = await generateRegistrationOptions({
          rpName: "hortus",
          rpID: s.host,
          userName: "owner",
          userDisplayName: "hortus owner",
          userID: new TextEncoder().encode("owner"),
          attestationType: "none",
          authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
          excludeCredentials: passkeys(db).map((p) => ({ id: p.id, transports: parse<string[]>(p.transports) })),
        });
        remember(registering, code, { challenge: options.challenge, exp: Date.now() + CHALLENGE_MS }, (v) => v.exp);
        return json(res, 200, options);
      }
      case "/webauthn/register/verify": {
        const code = body.code ?? "";
        const pending = registering.get(code);
        if (!pending || pending.exp < Date.now() || !liveCode(db, code) || !body.response) throw new Refused(EXPIRED);
        const response = body.response as unknown as RegistrationResponseJSON;
        const v = await verifyRegistrationResponse({
          response,
          expectedChallenge: pending.challenge,
          expectedOrigin: s.url,
          expectedRPID: s.host,
          requireUserVerification: false,
        }).catch((e) => {
          log.error("passkey registration refused", e, { address });
          throw new Refused("The device's answer could not be verified. Try again.");
        });
        if (!v.verified) throw new Refused("The device's answer could not be verified. Try again.");
        registering.delete(code);
        // single use: the code goes in the same synchronous step that adds the passkey
        if (db.prepare("DELETE FROM enroll_codes WHERE code = ? AND expires_at > ?").run(code, now()).changes !== 1)
          throw new Refused(EXPIRED);
        const c = v.registrationInfo.credential;
        const device = body.device?.trim() || "device";
        const t = now();
        db.prepare(
          "INSERT INTO passkeys(id, public_key, counter, device, transports, created, last_use) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).run(
          c.id,
          Buffer.from(c.publicKey).toString("base64url"),
          c.counter,
          device,
          JSON.stringify(c.transports ?? response.response.transports ?? []),
          t,
          t,
        );
        log.info("passkey enrolled", { device, address });
        login(db, req, res, device);
        return json(res, 200, { ok: true });
      }
      case "/webauthn/login/options": {
        const keys = passkeys(db);
        if (!keys.length) throw new Refused("No device is enrolled yet. Enrol this one from Settings at the machine.");
        const options = await generateAuthenticationOptions({
          rpID: s.host,
          allowCredentials: keys.map((p) => ({ id: p.id, transports: parse<string[]>(p.transports) })),
          userVerification: "preferred",
        });
        const from = address ?? "";
        const mine = [...challenges].filter(([, v]) => v.address === from); // insertion order: oldest first
        for (const [c] of mine.slice(0, Math.max(0, mine.length - PER_ADDRESS + 1))) challenges.delete(c);
        remember(challenges, options.challenge, { exp: Date.now() + CHALLENGE_MS, address: from }, (v) => v.exp);
        return json(res, 200, options);
      }
      case "/webauthn/login/verify": {
        const response = body.response as unknown as AuthenticationResponseJSON | undefined;
        const row =
          response &&
          (db.prepare("SELECT * FROM passkeys WHERE id = ?").get(response.id) as unknown as PasskeyRow | undefined);
        if (!response || !row) throw new Refused("This passkey is not enrolled here.");
        const v = await verifyAuthenticationResponse({
          response,
          expectedChallenge: (c) => {
            const exp = challenges.get(c)?.exp;
            challenges.delete(c);
            return exp !== undefined && exp > Date.now();
          },
          expectedOrigin: s.url,
          expectedRPID: s.host,
          credential: {
            id: row.id,
            publicKey: Buffer.from(row.public_key, "base64url"),
            counter: row.counter,
            transports: parse<string[]>(row.transports) as never,
          },
          requireUserVerification: false,
        }).catch((e) => {
          // a non-increasing counter lands here too (the library refuses it): logged, never accepted
          log.error("passkey assertion refused", e, { device: row.device, address });
          throw new Refused("Sign-in failed: the passkey's answer could not be verified.");
        });
        if (!v.verified) throw new Refused("Sign-in failed: the passkey's answer could not be verified.");
        db.prepare("UPDATE passkeys SET counter = ?, last_use = ? WHERE id = ?").run(
          v.authenticationInfo.newCounter,
          now(),
          row.id,
        );
        login(db, req, res, row.device);
        return json(res, 200, { ok: true });
      }
      default:
        return json(res, 404, { error: { message: "No such endpoint." } });
    }
  } catch (e) {
    if (e instanceof Refused) return json(res, 400, { error: { message: e.message } });
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// RPCs and what the Settings page reads

export interface SessionOut {
  id: string;
  device: string;
  created: string;
  last_seen: string;
  address: string;
  current: boolean;
}

export function sessions(db: DatabaseSync, current?: string): SessionOut[] {
  const rows = db
    .prepare("SELECT hash, device, created, last_seen, address FROM console_sessions ORDER BY last_seen DESC")
    .all() as unknown as (Omit<SessionOut, "id" | "current"> & { hash: string })[];
  return rows.map(({ hash, ...r }) => ({ id: hash, ...r, current: hash === current }));
}

/** The live enrolment code (the newest), with its URL. */
export function liveEnroll(db: DatabaseSync): { code: string; url: string; expires_at: string } | undefined {
  if (!state) return undefined;
  const r = db
    .prepare("SELECT code, expires_at FROM enroll_codes WHERE expires_at > ? ORDER BY expires_at DESC LIMIT 1")
    .get(now()) as { code: string; expires_at: string } | undefined;
  return r && { ...r, url: `${state.url}/enroll?code=${r.code}` };
}

/** Where the served certificate comes from, for the Settings page. */
export const certSource = (): string | undefined =>
  state && (state.tls ? `console.tls (${state.ctx.config.console?.tls?.cert})` : "minted from the hortus CA");

const running = (): State => {
  if (!state) throw new RpcError("invalid", "the remote console is off: set console.listen and console.host");
  return state;
};

define("enroll.code", {
  roles: ["owner"],
  input: z.object({}).loose().default({}),
  run(_, caller) {
    if (caller.remote) throw new RpcError("forbidden", "enrolment codes are made at the machine only");
    const db = running().ctx.db;
    const code = randomBytes(16).toString("base64url");
    db.prepare("DELETE FROM enroll_codes").run();
    db.prepare("INSERT INTO enroll_codes(code, expires_at) VALUES (?, ?)").run(
      code,
      new Date(Date.now() + CODE_MS).toISOString(),
    );
    return liveEnroll(db);
  },
});

define("session.list", {
  roles: ["owner"],
  input: z.object({}).loose().default({}),
  run: (_, caller) => (state ? sessions(state.ctx.db, caller.session) : []),
});

define("session.revoke", {
  roles: ["owner"],
  input: z.object({ id: z.string() }),
  run({ id }) {
    const s = running();
    if (!s.ctx.db.prepare("DELETE FROM console_sessions WHERE hash = ?").run(id).changes)
      throw new RpcError("not_found", "no such session");
    s.ctx.log("console").info("session revoked", { id: id.slice(0, 12) });
    bus.emit("sessions");
    return { ok: true };
  },
});
