/**
 * The hortus CA (RSA 2048, 10 years) and per-host leaves (ECDSA P-256, SAN, 398 days), all minted with `openssl`.
 * Leaves are cached on disk (`ca/hosts/`) and as SecureContexts in memory; one mint per host however many SNI hits race.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { createSecureContext, type SecureContext } from "node:tls";
import { promisify } from "node:util";
import * as paths from "../paths.ts";

const run = promisify(execFile);
const openssl = (...args: string[]) => run("openssl", args);

export const caCert = () => join(paths.ca(), "ca.crt");
const caKey = () => join(paths.ca(), "ca.key");
const hostsDir = () => join(paths.ca(), "hosts");

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/** Lowercased host, or throws: only `[a-z0-9.-]`, ≤ 253, no empty labels; checked before any path is built. */
export function validHost(host: string): string {
  const h = host.toLowerCase();
  if (h.length > 253 || !HOST.test(h)) throw new Error(`invalid host ${JSON.stringify(host)}`);
  return h;
}

let ensuring: Promise<void> | undefined;

export function ensure(): Promise<void> {
  ensuring ??= (async () => {
    mkdirSync(hostsDir(), { recursive: true, mode: 0o700 });
    if (existsSync(caKey()) && existsSync(caCert())) return;
    await openssl("genrsa", "-out", caKey(), "2048");
    chmodSync(caKey(), 0o600);
    await openssl(
      ...["req", "-x509", "-new", "-key", caKey(), "-sha256", "-days", "3650", "-subj", "/CN=hortus CA"],
      ...["-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"],
      ...["-out", caCert()],
    );
    chmodSync(caCert(), 0o600);
  })().catch((e) => {
    ensuring = undefined;
    throw e;
  });
  return ensuring;
}

async function mint(host: string, key: string, crt: string): Promise<void> {
  const csr = `${crt}.csr`;
  const ext = `${crt}.ext`;
  try {
    await openssl("genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", key);
    chmodSync(key, 0o600);
    await openssl("req", "-new", "-key", key, "-subj", `/CN=${host}`, "-out", csr);
    const san = isIP(host) ? `IP:${host}` : `DNS:${host}`;
    writeFileSync(ext, `subjectAltName=${san}\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n`, {
      mode: 0o600,
    });
    await openssl(
      ...["x509", "-req", "-in", csr, "-CA", caCert(), "-CAkey", caKey(), "-sha256", "-days", "398"],
      ...["-set_serial", `0x${randomBytes(16).toString("hex")}`, "-extfile", ext, "-out", crt],
    );
    chmodSync(crt, 0o600);
  } finally {
    rmSync(csr, { force: true });
    rmSync(ext, { force: true });
  }
}

const contexts = new Map<string, Promise<SecureContext>>();
export const MAX_CONTEXTS = 512;
/** in-memory SecureContexts (tests) */
export const contextCount = (): number => contexts.size;

export function hostContext(host: string): Promise<SecureContext> {
  let h: string;
  try {
    h = validHost(host);
  } catch (e) {
    return Promise.reject(e);
  }
  let p = contexts.get(h);
  if (!p) {
    // the SNI is the session's to pick: the oldest context goes, so a Worker cycling names cannot grow the map
    // ponytail: the leaves on disk (ca/hosts/) still grow per name; mint only for origins once SNI knows the client
    if (contexts.size >= MAX_CONTEXTS) contexts.delete(contexts.keys().next().value as string);
    p = (async () => {
      await ensure();
      const key = join(hostsDir(), `${h}.key`);
      const crt = join(hostsDir(), `${h}.crt`);
      // ponytail: a cached leaf is reused until restart even past expiry; re-mint by age when daemons run 398 days
      if (!existsSync(key) || !existsSync(crt)) await mint(h, key, crt);
      // the chain carries the CA too: Chromium's SPKI pin (3h) matches a certificate in the presented chain
      return createSecureContext({
        key: readFileSync(key),
        cert: Buffer.concat([readFileSync(crt), readFileSync(caCert())]),
      });
    })();
    contexts.set(h, p);
    p.catch(() => contexts.delete(h));
  }
  return p;
}

/** For `https.createServer({ SNICallback })`. */
export function sniCallback(servername: string, cb: (err: Error | null, ctx?: SecureContext) => void): void {
  hostContext(servername).then(
    (c) => cb(null, c),
    (e) => cb(e),
  );
}
