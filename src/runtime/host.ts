/** A host session: its cgroup, its session address, the Landlock shim, and the cleanup after it exits. */
import { spawn } from "node:child_process";
import { copyFileSync, createWriteStream, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { Config } from "../config.ts";
import { logger } from "../log.ts";
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
  onStdout(line: string): void;
  /** stderr always goes to out/console.log; this also gets it line by line */
  onStderr?(line: string): void;
}

export interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
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

/** The sandbox environment (04-host-sandbox.md › host.ts); nothing else of hortusd's environment leaks in. */
export function sandboxEnv(task: TaskJson): Record<string, string> {
  const ctl = paths.ctl(task.id);
  const env: Record<string, string> = {
    HOME: homedir(),
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    LANG: process.env.LANG ?? "C.UTF-8",
    TERM: "dumb",
    HORTUS_TASK: join(ctl, "task.json"),
  };
  const ca = join(ctl, "ca.crt");
  if (existsSync(ca))
    for (const k of ["SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS", "GIT_SSL_CAINFO", "CURL_CA_BUNDLE", "REQUESTS_CA_BUNDLE"])
      env[k] = ca;
  // ponytail: forge insteadOf entries (one per configured forge) arrive with step 6
  const git: [string, string][] = [
    ["user.name", "hortus"],
    ["user.email", "hortus@localhost"],
    ["credential.helper", ""],
    ["safe.directory", "*"],
    // the owner's ~/.gitconfig may sign commits; the sandbox has no gpg agent (3b)
    ["commit.gpgsign", "false"],
  ];
  env.GIT_CONFIG_COUNT = String(git.length);
  git.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k;
    env[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  if (task.scope.credentials.includes("github")) env.GH_TOKEN = "hortus-secret-github";
  return env;
}

export async function spawnSandboxed(o: SpawnOpts): Promise<Child> {
  const id = o.task.id;
  try {
    await abi();
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
    { id, clone: o.task.paths.clone, schedule: o.task.paths.schedule, cgroup: cgroup.path(id) },
    o.config,
  );
  const cg = await cgroup.create(id);
  try {
    await sessionNet.open(id, o.task.kind === "planner" ? "planner" : "worker", cg, o.config.chat.allow);
  } catch (e) {
    await cgroup.kill(id);
    throw e;
  }

  const child = spawn(shim.path, ["--", ...o.cmd], {
    cwd: o.cwd,
    env: { ...sandboxEnv(o.task), ...o.env },
    stdio: ["ignore", "pipe", "pipe", "pipe"],
  });
  const [, stdout, stderr, fd3] = child.stdio as unknown as [null, Readable, Readable, Writable];
  fd3.on("error", () => {}).end(text); // EPIPE when the shim dies first: its exit code says why
  const logFile = createWriteStream(join(out, "console.log"), { flags: "a" });
  stderr.pipe(logFile);
  createInterface({ input: stdout }).on("line", (l) => o.onStdout(l));
  if (o.onStderr) createInterface({ input: stderr }).on("line", (l) => o.onStderr?.(l));

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
