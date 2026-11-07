/**
 * A minimal CDP client over Chromium's DevTools pipe (fds 3/4): `launch` a headless Chromium,
 * `connect` to it, `send` commands (with a flat session id), `on` events, `page()` attaches to the first tab. Used by
 * the Worker's browser tools and by hortusd's login view.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";

export const CHROMIUM = process.env.HORTUS_CHROMIUM ?? "/usr/bin/chromium";

export interface LaunchOpts {
  userDataDir: string;
  /** the hortus CA: trusted by its SPKI pin, so no NSS db and no `--ignore-certificate-errors` */
  caCert?: string;
  /** extra flags (tests under HORTUS_NO_NET: `--host-resolver-rules`) */
  args?: string[];
  /** the command (another browser, a wrapper); default `chromium` */
  cmd?: string[];
  /**
   * `--no-sandbox`: the Worker's browser, whose Landlock domain (no_new_privs, ro /proc) leaves Chromium's namespace
   * sandbox nothing to set up, and whose renderer could do no more than the Worker's own bash. Never for the login view:
   * that one runs as hortusd's user outside any domain and keeps Chromium's sandbox.
   */
  noSandbox?: boolean;
}

export interface Browser {
  /** stdio 3 (Chromium reads commands) and 4 (it writes replies and events): `--remote-debugging-pipe` */
  proc: ChildProcess;
  /** the tail of Chromium's stderr */
  stderr(): string;
  close(): Promise<void>;
}

/** base64 SHA-256 of a PEM certificate's SubjectPublicKeyInfo (`--ignore-certificate-errors-spki-list`). */
export function spki(pem: string): string {
  const der = new X509Certificate(pem).publicKey.export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("base64");
}

export function flags(o: LaunchOpts): string[] {
  const f = [
    "--headless=new",
    // a pipe, never a port: every session reaches 127.0.0.1, and a DevTools port has no authentication (another task
    // could drive this browser, or the owner's login view, as its own)
    "--remote-debugging-pipe",
    `--user-data-dir=${o.userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--window-size=1280,900",
    // no background traffic of its own: every request the proxy sees is the page's
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--disable-features=Translate,OptimizationHints,MediaRouter,NetworkTimeServiceQuerying",
    "--disable-domain-reliability",
    "--disable-client-side-phishing-detection",
    "--no-pings",
    // no uploads; the handler itself still starts, see launch
    "--disable-crash-reporter",
    "--disable-breakpad",
    "--password-store=basic",
    "--use-mock-keychain",
    ...(o.noSandbox ? ["--no-sandbox"] : []),
  ];
  if (o.caCert && existsSync(o.caCert))
    f.push(`--ignore-certificate-errors-spki-list=${spki(readFileSync(o.caCert, "utf8"))}`);
  return [...f, ...(o.args ?? []), "about:blank"];
}

/** Spawns Chromium with its DevTools on fds 3/4; `connect` checks it answers. */
export async function launch(o: LaunchOpts): Promise<Browser> {
  mkdirSync(o.userDataDir, { recursive: true });
  const [bin = CHROMIUM, ...pre] = o.cmd ?? [CHROMIUM];
  const proc = spawn(bin, [...pre, ...flags(o)], {
    stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      // crashpad starts whatever the flags say (only --disable-crashpad-for-testing stops it, and crashes the network
      // service); this keeps its database, and dumps of a login page, out of the owner's ~/.config/chromium
      BREAKPAD_DUMP_LOCATION: join(o.userDataDir, "crash"),
      // a Worker's TMPDIR is under HORTUS_HOME, and past 62 bytes the singleton socket in it (sun_path) is a FATAL at start
      ...(o.noSandbox ? { TMPDIR: "/dev/shm" } : {}),
    },
  });
  let stderr = "";
  proc.stderr?.on("data", (c: Buffer) => {
    stderr = (stderr + c.toString()).slice(-4000);
  });
  // a missing binary emits `error` and never `exit`: connect reports it, close must not wait for an exit
  const exited = new Promise<void>((r) => {
    proc.once("exit", () => {
      r();
      // crashpad's handler daemonizes holding stderr: one that outlives the browser kept these open, an fd leak per
      // launch in hortusd and a test process that never ended. A second for what the browser last wrote.
      setTimeout(() => {
        for (const s of proc.stdio) s?.destroy();
      }, 1000).unref();
    });
    proc.once("error", (e) => {
      stderr = `${e.message}${stderr ? `\n${stderr}` : ""}`;
      r();
    });
  });
  const close = async () => {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
    await exited;
  };
  return { proc, stderr: () => stderr.trim().slice(-500), close };
}

type Handler = (params: Record<string, unknown>, sessionId?: string) => void;

export interface Cdp {
  send<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T>;
  /** returns the unsubscribe function */
  on(event: string, h: Handler): () => void;
  close(): void;
  closed: Promise<void>;
}

/** The DevTools pipe of `b` (NUL-separated JSON); waits (≤ 15 s) for Chromium to answer. */
export async function connect(b: Browser): Promise<Cdp> {
  const out = b.proc.stdio[3] as Writable;
  const inp = b.proc.stdio[4] as Readable;
  let open = true;
  let next = 1;
  const waiting = new Map<number, { resolve(v: unknown): void; reject(e: Error): void; method: string }>();
  const handlers = new Map<string, Set<Handler>>();
  let buf = Buffer.alloc(0);
  out.on("error", () => {});
  const closed = new Promise<void>((r) => {
    const end = () => {
      if (!open) return r();
      open = false;
      for (const w of waiting.values()) w.reject(new Error(`cdp: closed during ${w.method}: ${b.stderr()}`));
      waiting.clear();
      r();
    };
    inp.once("close", end);
    b.proc.once("exit", end);
  });
  inp.on("data", (c: Buffer) => {
    buf = Buffer.concat([buf, c]);
    for (let i = buf.indexOf(0); i >= 0; i = buf.indexOf(0)) {
      const m = JSON.parse(buf.subarray(0, i).toString("utf8")) as {
        id?: number;
        result?: unknown;
        error?: { message: string };
        method?: string;
        params?: Record<string, unknown>;
        sessionId?: string;
      };
      buf = buf.subarray(i + 1);
      if (m.id !== undefined) {
        const w = waiting.get(m.id);
        waiting.delete(m.id);
        if (m.error) w?.reject(new Error(`${w.method}: ${m.error.message}`));
        else w?.resolve(m.result);
      } else if (m.method) for (const h of handlers.get(m.method) ?? []) h(m.params ?? {}, m.sessionId);
    }
  });
  const cdp: Cdp = {
    send(method, params = {}, sessionId) {
      if (!open) return Promise.reject(new Error(`cdp: closed (${method})`));
      const id = next++;
      out.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
      return new Promise((resolve, reject) =>
        waiting.set(id, { resolve: resolve as (v: unknown) => void, reject, method }),
      );
    },
    on(event, h) {
      const s = handlers.get(event) ?? new Set();
      handlers.set(event, s);
      s.add(h);
      return () => s.delete(h);
    },
    close() {
      open = false;
      for (const w of waiting.values()) w.reject(new Error(`cdp: closed during ${w.method}`));
      waiting.clear();
    },
    closed,
  };
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      cdp.send("Browser.getVersion"),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), 15_000);
      }),
    ]);
  } catch (e) {
    await b.close();
    throw new Error(`chromium did not start (${(e as Error).message}): ${b.stderr()}`);
  } finally {
    clearTimeout(timer);
  }
  return cdp;
}

/** The first page target (one is opened if none), attached with `flatten: true`; returns its session id. */
export async function page(cdp: Cdp): Promise<string> {
  const { targetInfos } = await cdp.send<{ targetInfos: { targetId: string; type: string }[] }>("Target.getTargets");
  let targetId = targetInfos.find((t) => t.type === "page")?.targetId;
  if (!targetId) ({ targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" }));
  const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
  return sessionId;
}
