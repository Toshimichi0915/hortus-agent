/** A host session: its cgroup, its session address, the Landlock shim, and the cleanup after it exits. */
import { spawn } from "node:child_process";
import { closeSync, copyFileSync, createWriteStream, existsSync, lstatSync, mkdirSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { Config } from "../config.ts";
import { gitOf } from "../connectors/forge.ts";
import { lines, MAX_LINE, openAppend, replaceFile } from "../hostile.ts";
import { logger } from "../log.ts";
import * as paths from "../paths.ts";
import type { TaskJson } from "../types.ts";
import * as cgroup from "./cgroup.ts";
import { abi, HOME_READ, type Kind, profile, shim } from "./landlock.ts";
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
  /** hortusd's own reason for ending it (a VM boot timeout, a dead guest), shown as the task's error */
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

/** A session's PATH: the system unit's is systemd's own, without what the owner installed under $HOME. Not hortusd's: it
 * runs outside every sandbox, and a chat writes these. Version managers first, as in the owner's shell: behind
 * `/usr/bin` a project's `.python-version` would run the system's python, and say nothing. */
const sessionPath = (): string => {
  const home = (l: string[]) => l.map((p) => join(homedir(), p));
  return [
    ...home([".pyenv/shims", ".pyenv/bin", ".rbenv/shims", ".rbenv/bin", ".asdf/shims", ".volta/bin"]),
    ...home([".local/share/mise/shims"]),
    process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    dirname(process.execPath),
    ...home([".local/bin", ".local/share/pnpm", ".cargo/bin", "go/bin", ".bun/bin", ".deno/bin"]),
  ].join(":");
};

/** The sandbox environment; nothing else of hortusd's environment leaks in. */
export function sandboxEnv(task: TaskJson, config?: Config, loopback?: Loopback): Record<string, string> {
  const ctl = paths.ctl(task.id);
  const m2 = join(homedir(), ".m2", "repository");
  const env: Record<string, string> = {
    HOME: homedir(),
    PATH: `${join(ctl, "bin")}:${sessionPath()}`,
    LANG: process.env.LANG ?? "C.UTF-8",
    TERM: "dumb",
    // no terminal: the owner's core.editor (nvim here) would wait on it for good in `rebase -i`, `merge`, `commit --amend`
    GIT_EDITOR: "true",
    HORTUS_TASK: join(ctl, "task.json"),
    // core's bash saves a long output in tmpdir() with the default mode: under /tmp that was a world-readable copy of
    // what this task read (past scope.dofs, untainted) that no close removed. Goes with tasks/<id>.
    TMPDIR: join(paths.out(task.id), "tmp"),
    // ~/.config/gh and glab-cli (they hold the owner's tokens) and ~/.npmrc are denied: gh refuses to run without a
    // config dir, pnpm warns on every run (yarn 1 reads ~/.npmrc regardless and fails)
    GH_CONFIG_DIR: join(paths.out(task.id), "work", ".cache", "gh"),
    GLAB_CONFIG_DIR: join(paths.out(task.id), "work", ".cache", "glab"),
    npm_config_userconfig: join(paths.out(task.id), "work", ".cache", "npmrc"),
    // ~/.m2/settings.xml is denied too, and Maven dies on one it cannot read (a NullPointerException, no path): user.home
    // moves it for Maven's JVM alone. `-s` in MAVEN_ARGS would beat a project's own `-s`: the first one wins
    // the owner's repository, or the task's: with entries denied in ~/.m2 a session cannot create a new one there
    MAVEN_OPTS: `-Duser.home=${join(paths.out(task.id), "work", ".cache")} -Dmaven.repo.local=${existsSync(m2) ? m2 : join(paths.out(task.id), "work", ".cache", ".m2", "repository")}`,
    MAVEN_USER_HOME: join(paths.out(task.id), "work", ".cache", ".m2"),
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
    // git-lfs asks the forge for locks before every push: a credentialed POST, so a second approval per try
    ["lfs.locksverify", "false"],
    // what `git lfs install` wrote to ~/.gitconfig, which a Worker does not read (caches): pointers otherwise
    ["filter.lfs.clean", "git-lfs clean -- %f"],
    ["filter.lfs.smudge", "git-lfs smudge -- %f"],
    ["filter.lfs.process", "git-lfs filter-process"],
  ];
  // plain `git clone https://<host>/o/r.git` carries the forge's placeholder as the Basic password,
  // under the user each forge expects
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
 * Workers' shared caches (`paths.cache()`) linked in: never the owner's, as `~/.cache` holds what the owner runs outside
 * any sandbox (ms-playwright's browsers, pre-commit's hooks, cargo's sources). `out/` and the caches are the Workers':
 * nothing is created through a link one planted. */
export function caches(out: string, path = sessionPath()): Record<string, string> {
  const w = join(out, "work", ".cache");
  const shared = paths.cache();
  const dir = (p: string) => {
    try {
      mkdirSync(p);
    } catch {}
    try {
      return lstatSync(p).isDirectory();
    } catch {
      return false;
    }
  };
  const links: Record<string, string[]> = { cargo: ["registry", "git"], gradle: ["caches"], npm: ["_cacache"] };
  const real = homedir();
  if ([join(out, "work"), w, join(w, "home"), shared].every(dir)) {
    // `git init` in the scratch directory, then `git add -A`: the task's HOME and caches are nobody's commit
    try {
      replaceFile(join(w, ".gitignore"), "*\n");
    } catch {} // a read-only .cache only spoils its own `git add -A`; thrown, the start left its cgroup and address behind
    for (const [tool, subs] of Object.entries(links))
      if (dir(join(w, tool)) && dir(join(shared, tool)))
        for (const s of subs)
          try {
            // EEXIST on a restart leaves the link be
            if (dir(join(shared, tool, s))) symlinkSync(join(shared, tool, s), join(w, tool, s));
          } catch {}
    // what the profile shows, where a project's scripts look (`. ~/.nvm/nvm.sh`, `~/.cargo/env`): nvm is only a shell
    // function, and nothing else finds it. ponytail: not `.local`, whose `~/.local/bin` installers write; it is on PATH
    for (const e of HOME_READ)
      try {
        if (!e.startsWith(".local/") && existsSync(join(real, e)) && dir(dirname(join(w, "home", e))))
          symlinkSync(join(real, e), join(w, "home", e));
      } catch {}
  }
  return {
    // what this task installs, ahead of the owner's: `go install`, `cargo install`, `uv tool`, `pnpm add -g`
    PATH: [...["home/.local/bin", "cargo/bin", "go/bin", "pnpm", "bin"].map((p) => join(w, p)), path].join(":"),
    // the owner's is hidden (landlock.ts › profile), and a file a tool may not open is not one that is missing: libgit2
    // dies on ~/.gitconfig (`cargo new`, a git dependency), git warns on every run. Its own: nothing there, and writable
    HOME: join(w, "home"),
    // what finds itself by $HOME, where HOME_READ shows it
    RUSTUP_HOME: join(real, ".rustup"),
    PYENV_ROOT: join(real, ".pyenv"),
    RBENV_ROOT: join(real, ".rbenv"),
    ASDF_DATA_DIR: join(real, ".asdf"),
    VOLTA_HOME: join(real, ".volta"),
    MISE_DATA_DIR: join(real, ".local/share/mise"),
    PYTHONUSERBASE: join(real, ".local"),
    CARGO_HOME: join(w, "cargo"),
    GRADLE_USER_HOME: join(w, "gradle"),
    // pnpm's store defaults to $PNPM_HOME/store (npm_config_store_dir made npm warn on every command)
    PNPM_HOME: join(w, "pnpm"),
    // _npx, _logs and the rest task-local (~/.npm is read-only); _cacache is the shared one, linked
    npm_config_cache: join(w, "npm"),
    npm_config_update_notifier: "false",
    // pnpm's store locks: /tmp without it, and /tmp takes no writes here (landlock.ts › profile)
    XDG_RUNTIME_DIR: join(out, "tmp"),
    // pip, uv, go-build, yarn, gh and the rest of what `~/.cache` would hold
    XDG_CACHE_HOME: join(shared, "xdg"),
    // ~/go is read-only: its pkg/sumdb is what every first fetch of a module writes, its bin `go install`
    GOPATH: join(w, "go"),
    GOMODCACHE: join(shared, "go"),
    // uv tool, uvx: ~/.local/share/uv/tools is read-only
    XDG_DATA_HOME: join(w, "share"),
    MAVEN_OPTS: `-Duser.home=${w} -Dmaven.repo.local=${join(shared, "m2")}`,
    // ./mvnw unpacks Maven there, ~/.m2/wrapper otherwise
    MAVEN_USER_HOME: join(shared, "m2"),
    // the JVM ignores TMPDIR: /tmp is compiled in, so every createTempFile and JUnit @TempDir failed under Maven and Gradle
    // and user.home comes from passwd, not HOME
    JAVA_TOOL_OPTIONS: `-Djava.io.tmpdir=${join(out, "tmp")} -Duser.home=${join(w, "home")}`,
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
  mkdirSync(paths.cache(), { recursive: true }); // first: the profile grants what exists
  try {
    mkdirSync(join(out, "tmp"));
  } catch {} // there from an earlier session; a file or link the Worker planted only spoils its own TMPDIR
  // ~/.hortus/ca is denied, so the session gets its own readable copy of the CA certificate.
  const caSrc = join(paths.ca(), "ca.crt");
  if (existsSync(caSrc)) copyFileSync(caSrc, join(paths.ctl(id), "ca.crt"));

  const text = profile(
    o.kind,
    {
      id,
      ...(o.task.scope.project ? { project: o.task.scope.project } : {}),
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

  const env = sandboxEnv(o.task, o.config, o.loopback);
  const child = spawn(shim.path, ["--", ...o.cmd], {
    cwd: o.cwd,
    env: { ...env, ...(o.kind === "unattended" ? caches(out, env.PATH) : {}), ...o.env },
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
      child.kill("SIGKILL"); // just spawned, the shim may not be in its cgroup yet
      await cgroup.kill(id);
    },
  };
}
