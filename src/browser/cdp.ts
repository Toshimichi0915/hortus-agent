/**
 * A minimal CDP client (14-browser.md › CDP client) over Node's global WebSocket: `launch` a headless Chromium,
 * `connect` to it, `send` commands (with a flat session id), `on` events, `page()` attaches to the first tab. Used by
 * the Worker's browser tools and by hortusd's login view.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { X509Certificate, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export const CHROMIUM = process.env.HORTUS_CHROMIUM ?? "/usr/bin/chromium";

export interface LaunchOpts {
  userDataDir: string;
  /** 0 (default): Chromium picks one and writes it to `<userDataDir>/DevToolsActivePort` */
  port?: number;
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
  proc: ChildProcess;
  /** `ws://127.0.0.1:<port>/devtools/browser/<id>` */
  ws: string;
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
    `--remote-debugging-port=${o.port ?? 0}`,
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
    // crashpad writes under ~/.config/chromium, which every Landlock domain denies
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

/** Spawns Chromium and waits (≤ 15 s) for its DevTools endpoint. */
export async function launch(o: LaunchOpts): Promise<Browser> {
  mkdirSync(o.userDataDir, { recursive: true });
  const portFile = join(o.userDataDir, "DevToolsActivePort");
  const [bin = CHROMIUM, ...pre] = o.cmd ?? [CHROMIUM];
  const proc = spawn(bin, [...pre, ...flags(o)], { stdio: ["ignore", "ignore", "pipe"], detached: false });
  let stderr = "";
  proc.stderr?.on("data", (c: Buffer) => {
    stderr = (stderr + c.toString()).slice(-4000);
  });
  const exited = new Promise<void>((r) => proc.once("exit", () => r()));
  const close = async () => {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
    await exited;
  };
  const start = Date.now();
  // a stale file from an earlier run names a dead port: only trust one written after the spawn
  const t0 = Date.now() - 1000;
  for (;;) {
    if (proc.exitCode !== null || proc.signalCode !== null)
      throw new Error(`chromium exited (${proc.exitCode ?? proc.signalCode}): ${stderr.trim().slice(-500)}`);
    try {
      const { mtimeMs } = statSync(portFile);
      const [port, path] = readFileSync(portFile, "utf8").split("\n");
      if (mtimeMs >= t0 && port && path) return { proc, ws: `ws://127.0.0.1:${port}${path}`, close };
    } catch {}
    if (Date.now() - start > 15_000) {
      await close();
      throw new Error(`chromium did not start: ${stderr.trim().slice(-500)}`);
    }
    await sleep(50);
  }
}

type Handler = (params: Record<string, unknown>, sessionId?: string) => void;

export interface Cdp {
  send<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T>;
  /** returns the unsubscribe function */
  on(event: string, h: Handler): () => void;
  close(): void;
  closed: Promise<void>;
}

/** `ws` from `launch`, or `http://127.0.0.1:<port>` (reads `/json/version`). */
export async function connect(endpoint: string): Promise<Cdp> {
  let url = endpoint;
  if (endpoint.startsWith("http")) {
    const v = (await (await fetch(`${endpoint}/json/version`)).json()) as { webSocketDebuggerUrl: string };
    url = v.webSocketDebuggerUrl;
  }
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error(`cdp: cannot connect to ${url}`)), { once: true });
  });
  let next = 1;
  const waiting = new Map<number, { resolve(v: unknown): void; reject(e: Error): void; method: string }>();
  const handlers = new Map<string, Set<Handler>>();
  const closed = new Promise<void>((r) =>
    ws.addEventListener("close", () => {
      for (const w of waiting.values()) w.reject(new Error(`cdp: closed during ${w.method}`));
      waiting.clear();
      r();
    }),
  );
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(String(e.data)) as {
      id?: number;
      result?: unknown;
      error?: { message: string };
      method?: string;
      params?: Record<string, unknown>;
      sessionId?: string;
    };
    if (m.id !== undefined) {
      const w = waiting.get(m.id);
      waiting.delete(m.id);
      if (m.error) w?.reject(new Error(`${w.method}: ${m.error.message}`));
      else w?.resolve(m.result);
    } else if (m.method) for (const h of handlers.get(m.method) ?? []) h(m.params ?? {}, m.sessionId);
  });
  return {
    send(method, params = {}, sessionId) {
      if (ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error(`cdp: closed (${method})`));
      const id = next++;
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
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
    close: () => ws.close(),
    closed,
  };
}

/** The first page target (one is opened if none), attached with `flatten: true`; returns its session id. */
export async function page(cdp: Cdp): Promise<string> {
  const { targetInfos } = await cdp.send<{ targetInfos: { targetId: string; type: string }[] }>("Target.getTargets");
  let targetId = targetInfos.find((t) => t.type === "page")?.targetId;
  if (!targetId) ({ targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" }));
  const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
  return sessionId;
}
