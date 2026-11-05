/**
 * Landlock profile builder (docs/design/04-host-sandbox.md, hortus_v7.md › Security). Output is the line protocol the
 * shim (native/landlock.c) reads on fd 3. Landlock has no deny rule, so the domain is built by granting every entry
 * along the way to a denied path except the denied one: what is created later under a walked directory is unreachable.
 */
import { execFile } from "node:child_process";
import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Config } from "../config.ts";
import * as paths from "../paths.ts";

export type Kind = "unattended" | "chat";
/** `rn`: read-write without connecting to unix sockets (the shim; /tmp holds X11, tmux and ssh-agent sockets) */
type Mode = "ro" | "rw" | "rn";

export interface ProfileTask {
  id: string;
  clone?: string;
  schedule?: string;
  /** the DOFs it can read (task.json scope.dofs): only their worktrees and repos are granted, never all of dof/ */
  dofs: string[];
  /** absolute cgroup directory the shim joins; omitted only in tests without a delegated cgroup */
  cgroup?: string;
}

/** The shim's path; tests point it at a fake. */
export const shim = { path: fileURLToPath(new URL("../hortus-landlock", import.meta.url)) };

let abiCache: { path: string; result: Promise<number> } | undefined;

/** The running kernel's Landlock ABI (cached per shim path); throws with the shim's one-line reason when there is none. */
export function abi(): Promise<number> {
  if (abiCache?.path !== shim.path) {
    const result = promisify(execFile)(shim.path, ["--abi"]).then(
      (r) => Number(r.stdout.trim()),
      (e: { stderr?: string; message: string }) => {
        throw new Error(`Landlock unavailable: ${(e.stderr ?? "").trim() || e.message}`);
      },
    );
    abiCache = { path: shim.path, result };
  }
  return abiCache.result;
}

/** Realpath, resolving as much of the path as exists (a denied path that does not exist yet still guards its parent). */
function resolve(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    const parent = dirname(p);
    return parent === p ? p : join(resolve(parent), basename(p));
  }
}

const under = (p: string, d: string): boolean => p === d || p.startsWith(d === "/" ? "/" : `${d}/`);

/** The deny set: v7's list, the real ~/.hortus, HORTUS_HOME, and `policy.deny`, as resolved absolute paths. */
export function denySet(config: Pick<Config, "policy">): string[] {
  const h = homedir();
  const uid = process.getuid?.() ?? 0;
  const list = [
    join(h, ".hortus"),
    paths.home(),
    ...[".ssh", ".gnupg", ".aws", ".azure", ".config/gcloud", ".kube", ".docker", ".netrc", ".password-store"].map(
      (p) => join(h, p),
    ),
    // tools' credentials in plain files (the session's gh and npm get their own config, host.ts › sandboxEnv)
    ...[".npmrc", ".config/gh", ".config/glab-cli", ".git-credentials", ".config/git/credentials", ".pypirc"].map(
      (p) => join(h, p),
    ),
    ...[".cargo/credentials", ".cargo/credentials.toml", ".gradle/gradle.properties"].map((p) => join(h, p)),
    ...[".local/share/keyrings", ".mozilla", ".config/chromium", ".config/google-chrome", ".config/BraveSoftware"].map(
      (p) => join(h, p),
    ),
    "/run/docker.sock",
    "/var/run/docker.sock",
    "/sys/fs/cgroup",
    // v7 lists bus and keyring; the whole runtime dir also hides systemd/private (systemd-run --user = escape),
    // gnupg and ssh-agent sockets, which a session could otherwise connect to.
    `/run/user/${uid}`,
    ...(config.policy.deny ?? []),
  ];
  return [...new Set(list.map(resolve))];
}

/** What hortusd itself runs (its `dist/` with the shim, its `node_modules`) and the owner's user units: read-only in
 * every profile, so a chat session cannot unsandbox later sessions or rewrite the daemon. */
export function readOnlySet(): string[] {
  const root = fileURLToPath(new URL("../..", import.meta.url)); // dist/runtime/landlock.js → the package root
  return [join(root, "dist"), join(root, "node_modules"), join(homedir(), ".config", "systemd")].map(resolve);
}

/** Directives granting `mode` on `dir` minus everything in `deny`. */
function grant(dir: string, mode: Mode, deny: string[], out: string[]): void {
  if (deny.some((d) => under(dir, d))) return;
  if (!deny.some((d) => under(d, dir))) {
    if (!dir.includes("\n")) out.push(`${mode} ${dir}`);
    return;
  }
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // ponytail: an unreadable directory along a denied path is left out entirely (the safe side)
  }
  for (const e of entries) {
    const p = join(dir, e);
    let link = false;
    try {
      link = lstatSync(p).isSymbolicLink();
    } catch {
      continue;
    }
    if (!link) {
      grant(p, mode, deny, out);
      continue;
    }
    // The shim follows links: a writable grant never does (a session writes /tmp, the caches and out/: a link it plants
    // there, `/tmp/x → ~/.bashrc`, would hand the next session rw on the target); its target's own path is walked from
    // `/` anyway. A read-only one only when the whole target is clear of the deny set.
    if (mode !== "ro") continue;
    const real = resolve(p);
    if (existsSync(real) && !deny.some((d) => under(real, d) || under(d, real)) && !p.includes("\n"))
      out.push(`${mode} ${p}`);
  }
}

// Shared caches holding nothing the owner runs; `~/.cargo/bin`, `~/.gradle/init.d`, `~/.pyenv` and the like stay
// read-only (they are on the owner's PATH or run by its builds). The rest goes to task-local homes (host.ts › caches).
export const RW_HOME = [".cache", ".npm/_cacache", ".cargo/registry", ".cargo/git", ".gradle/caches", ".m2/repository"];
const RW_DEV = ["null", "zero", "full", "random", "urandom", "tty", "ptmx", "pts", "shm"].map((d) => `/dev/${d}`);

/** The directive text for one task under `kind`. */
export function profile(kind: Kind, task: ProfileTask, config: Pick<Config, "policy">): string {
  const deny = denySet(config);
  const ro = readOnlySet().filter((p) => !deny.some((d) => under(p, d)));
  const denyRw = [...deny, ...ro]; // every write grant skips them; they are granted read-only below
  const out: string[] = [];
  if (task.cgroup) out.push(`cgroup ${task.cgroup}`);
  const base: Mode = kind === "chat" ? "rw" : "ro";
  grant("/", base, base === "rw" ? denyRw : deny, out);
  if (kind === "unattended") {
    const h = homedir();
    // ponytail: a Worker's own sockets under /tmp cannot be connected to either; point TMPDIR at out/ if that bites
    for (const p of ["/tmp", ...RW_DEV, ...RW_HOME.map((p) => join(h, p)), ...(config.policy.cache ?? [])])
      if (existsSync(p)) grant(resolve(p), "rn", denyRw, out);
  }
  for (const p of ro) if (existsSync(p)) grant(p, "ro", deny, out);
  // Carve-outs under the denied HORTUS_HOME, still minus every other deny entry (policy.deny inside out/, say).
  const hortus = [resolve(join(homedir(), ".hortus")), resolve(paths.home())];
  const rest = deny.filter((d) => !hortus.includes(d));
  const carve: [string | undefined, Mode][] = [
    ...task.dofs.flatMap((d): [string, Mode][] => [
      [paths.dof(d), "ro"],
      [paths.dofRepo(d), "ro"],
    ]),
    [join(paths.home(), "repos"), "ro"],
    [paths.ctl(task.id), "ro"],
    [paths.out(task.id), "rw"],
    [task.clone, "rw"],
    [task.schedule, "rw"],
  ];
  for (const [p, mode] of carve) if (p && existsSync(p)) grant(resolve(p), mode, rest, out);
  out.push("scope signal", "scope abstract", "end");
  return `${out.join("\n")}\n`;
}
