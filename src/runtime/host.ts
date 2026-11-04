/** A host session: its cgroup, its session address, the Landlock shim, and the cleanup after it exits. */
import { spawn } from "node:child_process";
import { closeSync, copyFileSync, createWriteStream, existsSync, lstatSync, mkdirSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { Config } from "../config.ts";
import { gitOf } from "../connectors/forge.ts";
import { logger } from "../log.ts";
import { lines, MAX_LINE, openAppend } from "../hostile.ts";
import * as paths from "../paths.ts";
import type { TaskJson } from "../types.ts";
import * as cgroup from "./cgroup.ts";
import { abi, type Kind, profile, shim } from "./landlock.ts";
import * as sessionNet from "./session-net.ts";

export interface SpawnOpts {
  task: TaskJson;
  kind: Kind;
  cmd: string[];
  cwd: string;
  /** extra variables on top of the sandbox's own */
  env?: Record<string, string>;
  /** policy.deny / policy.cache / chat.allow are read from it */
  config: Config;
  /** HORTUS_NO_NET=1: the session's loopback alias and its TLS listener (forge git goes there; sandboxEnv) */
  loopback?: Loopback;
  onStdout(line: string): void;
  /** stderr always goes to out/console.log; this also gets it line by line */
  onStderr?(line: string): void;
}

export interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** hortusd's own reason for ending it (a VM boot timeout), shown as the task's error */
  error?: string;
}

export interface Child {
  pid: number;
  /** resolves after the cgroup is empty and removed and the session address released */
  wait(): Promise<Exit>;
  /** cgroup.kill: the session and everything it forked */
  kill(): Promise<void>;
}

const log = logger("runtime");

/** `hortus-agent --task tasks/<id>`, run by the current node. */
export const agentCmd = (id: string): string[] => [
  process.execPath,
  fileURLToPath(new URL("../bin/hortus-agent.js", import.meta.url)),
  "--task",
  paths.task(id),
];

export interface Loopback {
  address: string;
  https: number;
}

/** The sandbox environment (04-host-sandbox.md › host.ts); nothing else of hortusd's environment leaks in. */
export function sandboxEnv(task: TaskJson, config?: Config, loopback?: Loopback): Record<string, string> {
  const ctl = paths.ctl(task.id);
  const env: Record<string, string> = {
    HOME: homedir(),
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    LANG: process.env.LANG ?? "C.UTF-8",
    TERM: "dumb",
    HORTUS_TASK: join(ctl, "task.json"),
    // ~/.config/gh (its hosts.yml holds the owner's token) and ~/.npmrc are denied: gh refuses to run without a
    // config dir, pnpm warns on every run (yarn 1 reads ~/.npmrc regardless and fails)
    GH_CONFIG_DIR: join(paths.out(task.id), "work", ".cache", "gh"),
    npm_config_userconfig: join(paths.out(task.id), "work", ".cache", "npmrc"),
  };
  const ca = join(ctl, "ca.crt");
  if (existsSync(ca))
    for (const k of ["SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS", "GIT_SSL_CAINFO", "CURL_CA_BUNDLE", "REQUESTS_CA_BUNDLE"])
      env[k] = ca;
  const git: [string, string][] = [
    ["user.name", "hortus"],
    ["user.email", "hortus@localhost"],
    ["credential.helper", ""],
    ["safe.directory", "*"],
    // the owner's ~/.gitconfig may sign commits; the sandbox has no gpg agent (3b)
    ["commit.gpgsign", "false"],
  ];
  // plain `git clone https://<host>/o/r.git` carries the forge's placeholder as the Basic password (v6 › Projects),
  // under the user each forge expects (18-gitlab-bitbucket.md)
  for (const [name, d] of Object.entries(config?.dofs ?? {})) {
    const g = gitOf(d);
    if (!g) continue;
    const { user, host } = g;
    // HORTUS_NO_NET=1 has no DNS/DNAT: the forge host resolves to the session's alias, on its listener's port
    const at = loopback ? `${host}:${loopback.https}` : host;
    git.push([`url.https://${user}:hortus-secret-${name}@${at}/.insteadOf`, `https://${host}/`]);
    if (loopback) git.push(["http.curloptResolve", `${at}:${loopback.address}`]);
  }
  env.GIT_CONFIG_COUNT = String(git.length);
  git.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k;
    env[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  if (task.scope.credentials.includes("github")) env.GH_TOKEN = "hortus-secret-github";
  return env;
}

/** An unattended session's tool homes under `out/work/.cache` (the profile leaves the owner's read-only), with the
 * shared cache directories linked in. `out/` is the Worker's: nothing is created through a link it planted. */
export function caches(out: string): Record<string, string> {
  const w = join(out, "work", ".cache");
  const real = (p: string) => {
    try {
      mkdirSync(p);
    } catch {}
    try {
      return lstatSync(p).isDirectory();
    } catch {
      return false;
    }
  };
  const h = homedir();
  const links: Record<string, string[]> = { cargo: ["registry", "git"], gradle: ["caches"], npm: ["_cacache"] };
  if ([join(out, "work"), w].every(real))
    for (const [tool, subs] of Object.entries(links))
      if (real(join(w, tool)))
        for (const s of subs)
          try {
            // only an existing target: the profile grants it only then; EEXIST on a restart leaves the link be
            if (existsSync(join(h, `.${tool}`, s))) symlinkSync(join(h, `.${tool}`, s), join(w, tool, s));
          } catch {}
  return {
    CARGO_HOME: join(w, "cargo"),
    GRADLE_USER_HOME: join(w, "gradle"),
    // pnpm's store defaults to $PNPM_HOME/store (npm_config_store_dir made npm warn on every command)
    PNPM_HOME: join(w, "pnpm"),
    // _npx, _logs and the rest task-local (~/.npm is read-only); _cacache is the shared one, linked
    npm_config_cache: join(w, "npm"),
    npm_config_update_notifier: "false",
  };
}

/** The lowest Landlock ABI a host session runs under (9: RESOLVE_UNIX). */
export const MIN_ABI = 9;

export async function spawnSandboxed(o: SpawnOpts): Promise<Child> {
  const id = o.task.id;
  try {
    // below 6 a session reaches hortusd's abstract socket (owner RPCs); below 9 it connects to any pathname socket
    // (systemd --user's private socket is `systemd-run --user`, i.e. no sandbox): refused rather than run open
    const v = await abi();
    if (v < MIN_ABI)
      throw new Error(`Landlock ABI ${v} is too old for host sessions (needs ${MIN_ABI}: unix-socket rules)`);
  } catch (e) {
    log.error("refusing to start a host session", e, { task: id });
    throw e;
  }
  const out = paths.out(id);
  mkdirSync(out, { recursive: true });
  mkdirSync(paths.ctl(id), { recursive: true });
  // ~/.hortus/ca is denied, so the session gets its own readable copy of the CA certificate.
  const caSrc = join(paths.ca(), "ca.crt");
  if (existsSync(caSrc)) copyFileSync(caSrc, join(paths.ctl(id), "ca.crt"));

  const text = profile(
    o.kind,
    {
      id,
      clone: o.task.paths.clone,
      schedule: o.task.paths.schedule,
      dofs: o.task.scope.dofs ?? [],
      cgroup: cgroup.path(id),
    },
    o.config,
  );
  // first: a planted link or FIFO there is replaced, and a failure leaves no cgroup, address or child behind
  const logFd = openAppend(join(out, "console.log"));
  const cg = await cgroup.create(id);
  try {
    await sessionNet.open(id, o.task.kind === "planner" ? "planner" : "worker", cg, o.config.chat.allow);
  } catch (e) {
    closeSync(logFd);
    await cgroup.kill(id);
    throw e;
  }

  const child = spawn(shim.path, ["--", ...o.cmd], {
    cwd: o.cwd,
    env: { ...sandboxEnv(o.task, o.config, o.loopback), ...(o.kind === "unattended" ? caches(out) : {}), ...o.env },
    stdio: ["ignore", "pipe", "pipe", "pipe"],
  });
  const [, stdout, stderr, fd3] = child.stdio as unknown as [null, Readable, Readable, Writable];
  fd3.on("error", () => {}).end(text); // EPIPE when the shim dies first: its exit code says why
  // ENOSPC (or EIO) on console.log: an `error` without a listener would kill hortusd; the session goes on unlogged
  const logFile = createWriteStream("", { fd: logFd }).on("error", () => stderr.resume());
  stderr.pipe(logFile);
  lines(stdout, MAX_LINE, o.onStdout);
  if (o.onStderr) lines(stderr, MAX_LINE, o.onStderr);

  const done = new Promise<Exit>((resolve, reject) => {
    let exit: Exit = { code: null, signal: null };
    let cleaning: Promise<void> | undefined;
    // Stragglers die with the session (so the pipes close), then the address goes back. Once.
    const cleanup = () => {
      cleaning ??= cgroup.kill(id).then(() => sessionNet.close(id));
      return cleaning;
    };
    child.on("error", (e) => {
      cleanup().then(() => reject(e), reject);
    });
    child.on("exit", (code, signal) => {
      exit = { code, signal };
      cleanup().catch((e) => log.error("session cleanup failed", e, { task: id }));
    });
    child.on("close", () => {
      logFile.end(() => cleanup().then(() => resolve(exit), reject));
    });
  });
  done.catch(() => {});
  return {
    pid: child.pid ?? -1,
    wait: () => done,
    kill: async () => {
      await cgroup.kill(id);
    },
  };
}
