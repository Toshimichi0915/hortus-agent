/**
 * Landlock profile builder. Output is the line protocol the
 * shim (native/landlock.c) reads on fd 3. Landlock has no deny rule, so the domain is built by granting every entry
 * along the way to a denied path except the denied one: what is created later under a walked directory is unreachable.
 */
import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
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
  /** the task's `scope.project`: its checkout is the one the profile shows (`--reference`), the others stay hidden */
  project?: string;
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

let nsCache: { path: string; result: Promise<string | undefined> } | undefined;

/** Why the shim cannot mount in its own user namespace (undefined: it can, so a chat's deny set is masked rather than
 * walked); Ubuntu's `apparmor_restrict_unprivileged_userns` is the usual reason. Cached per shim path, never throws. */
export function usernsBlocked(): Promise<string | undefined> {
  if (nsCache?.path !== shim.path) {
    // a timeout: a shim that hangs here (a stand-in in a test, say) would hold every chat start
    const result = promisify(execFile)(shim.path, ["--userns"], { timeout: 5000 }).then(
      () => undefined,
      (e: { stderr?: string; message: string }) => (e.stderr ?? "").trim() || e.message,
    );
    nsCache = { path: shim.path, result };
  }
  return nsCache.result;
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

/** ponytail: a chat has the owner's reach and a list of stores cannot be complete (an unattended session is shown what is
 * listed instead: `HOME_READ`). These are the common ones: agents, wallets, app profiles, histories. */
const STORES =
  `.claude .claude.json .codex .gemini .copilot .1password .electrum .electrum-ravencoin .bitcoin .monero Monero
  .thunderbird .pulumi .terraform.d .vault-token .s3cfg .boto .config/rclone .config/op .config/1Password .config/Claude
  .config/Code .config/Cursor .config/discord .config/github-copilot .config/evolution .config/Slack .config/Signal
  .config/google-chrome-beta .config/microsoft-edge .config/vivaldi .bash_history .zsh_history .psql_history .mysql_history
  .local/share/fish/fish_history .mariadb_history .python_history .node_repl_history`.split(/\s+/);

/** The deny set: the credential stores below, the real ~/.hortus, HORTUS_HOME, and `policy.deny`,
 * as resolved absolute paths. */
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
    ...[".npmrc", ".config/gh", ".config/glab-cli", ".git-credentials", ".config/git/credentials", ".pypirc"].map((p) =>
      join(h, p),
    ),
    ...[".cargo/credentials", ".cargo/credentials.toml", ".gradle/gradle.properties"].map((p) => join(h, p)),
    ...[".m2/settings.xml", ".m2/settings-security.xml"].map((p) => join(h, p)),
    ...[".local/share/keyrings", ".mozilla", ".config/chromium", ".config/google-chrome", ".config/BraveSoftware"].map(
      (p) => join(h, p),
    ),
    ...STORES.map((p) => join(h, p)),
    "/run/docker.sock",
    "/var/run/docker.sock",
    "/run/libvirt", // the `libvirt` group is root, as `docker` is
    "/sys/fs/cgroup",
    // bus and keyring are listed; the whole runtime dir also hides systemd/private (systemd-run --user = escape),
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

interface Mount {
  dev: string;
  root: string;
  at: string;
}

/** This namespace's mounts (`/proc/self/mountinfo`: major:minor, the root within the filesystem, the mount point). */
function mountTable(): Mount[] {
  const octal = (s: string) => s.replace(/\\(\d{3})/g, (_, o: string) => String.fromCharCode(Number.parseInt(o, 8)));
  return readFileSync("/proc/self/mountinfo", "utf8")
    .split("\n")
    .map((l) => l.split(" "))
    .filter((f) => f.length > 4)
    .map((f) => ({ dev: f[2] ?? "", root: octal(f[3] ?? ""), at: octal(f[4] ?? "") }));
}

/** `p` and the paths the same file has through every other mount of its filesystem (a bind mount, a btrfs subvolume
 * mounted twice): a mask on `p` alone would leave them open. */
function aliases(p: string, table: Mount[]): string[] {
  const m = table
    .filter((m) => under(p, m.at))
    .reduce<Mount | undefined>(
      (a, b) => (!a || b.at.length >= a.at.length ? b : a), // the last one mounted at the deepest point is what `p` is
      undefined,
    );
  if (!m) return [p];
  const rel = join(m.root, p.slice(m.at.length));
  const other = table.filter((n) => n !== m && n.dev === m.dev && under(rel, n.root));
  return [p, ...other.map((n) => join(n.at, rel.slice(n.root.length)))];
}

const depth = (p: string) => (p === "/" ? 0 : p.split("/").length - 1);

/** A chat's mount directives (the shim's namespace): the existing deny set masked, the read-only set and every parent a
 * session could rename (and so swap the tree under) bound in place, the carve-outs put back inside the masks. Deeper
 * paths after shallower ones, so each lands on what is above it. What does not exist cannot be mounted on: the caller
 * still walks it (`grant`). */
function nsMounts(deny: string[], ro: string[], carve: [string, Mode][]): string[] {
  const table = mountTable();
  const writable = (d: string) => {
    try {
      accessSync(d, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  };
  const ops = new Map<string, [number, string]>(); // line → [order within a depth, path]
  const add = (rank: number, op: string, p: string) => {
    if (!p.includes("\n")) ops.set(`${op} ${p}`, [rank, p]);
  };
  for (const p of ro.filter((p) => existsSync(p))) {
    for (let a = dirname(p); a !== "/" && a !== dirname(a); a = dirname(a)) if (writable(dirname(a))) add(0, "pin", a);
    for (const q of aliases(p, table)) add(1, "rdonly", q);
  }
  for (const p of deny.filter((p) => existsSync(p))) for (const q of aliases(p, table)) add(1, "mask", q);
  for (const [p, mode] of carve) add(2, `expose ${mode === "ro" ? "ro" : "rw"}`, p);
  return [...ops].sort(([, [ra, a]], [, [rb, b]]) => depth(a) - depth(b) || ra - rb).map(([line]) => line);
}

/** All an unattended session sees of `$HOME`: where toolchains install, none a credential store.
 * Not `.gitconfig`: git takes a hidden one silently, but dies on a shown one's `include` of a hidden file. */
export const HOME_READ = `.local/bin .local/lib .local/share/pnpm .local/share/mise .local/share/fnm .local/share/pipx
  .local/share/uv/python .local/share/uv/tools .nvm .fnm .volta .asdf .tool-versions .pyenv .rbenv .rustup .cargo/bin
  .cargo/env .bun .deno go/bin .dotnet .sdkman`.split(/\s+/);

/** The owner's data outside `$HOME`, hidden from unattended sessions like what is in it: what tasks and programs left in
 * `/tmp`, disks, other homes, and what the uid or its groups can read of the system: core dumps (the memory of what
 * crashed), the journal, libvirt's disks, firmware variables. A project or tool there goes in `policy.read`. */
const HIDDEN = `/home /mnt /media /run/media /srv /tmp /var/tmp /var/log /var/mail /var/spool /var/lib/systemd/coredump
  /var/lib/libvirt /sys/firmware`.split(/\s+/);

/** What every program of the owner's shares, sockets to their terminals and screen among them. */
const SHARED = ["/tmp", "/var/tmp", "/run/screen"].map(resolve);

const RW_DEV = ["null", "zero", "full", "random", "urandom", "tty", "shm"].map((d) => `/dev/${d}`);

/** The directive text for one task under `kind`. `ns` (a chat, `usernsBlocked()` clear): what exists of the deny and
 * read-only sets is mounted over in the shim's namespace instead of walked around, so the directories holding it
 * (`~/Desktop/projects` above a dev checkout) take new entries. */
export function profile(
  kind: Kind,
  task: ProfileTask,
  config: Pick<Config, "policy"> & Partial<Pick<Config, "projects">>,
  ns = false,
): string {
  // ponytail: /dev/pts is the owner's terminals and /dev/input their keyboard (the `input` group, or a seat's ACL), keys
  // read with no ioctl, and Landlock cannot tell a session's pty from theirs: no pty on a host Worker, chat or not (script,
  // expect); hortus chat is pipes, and a VM has its own
  const deny = [...denySet(config), "/dev/pts", "/dev/input"];
  const ro = readOnlySet().filter((p) => !deny.some((d) => under(p, d)));
  const denyRw = [...deny, ...ro]; // every write grant skips them; they are granted read-only below
  const out: string[] = [];
  if (task.cgroup) out.push(`cgroup ${task.cgroup}`);
  const base: Mode = kind === "chat" ? "rw" : "ro";
  const masked = ns && kind === "chat";
  // unattended: of /dev, only RW_DEV: `ro` opened /dev/fb0 (the screen) and the owner's console /dev/tty<n>. /dev/stdout
  // and /dev/fd are links, which need no rule. ponytail: a chat keeps the rest, the owner's boards and /dev/kvm with them
  // unattended: of `$HOME` only what is listed, not `ro` less what is hidden: the stores on one machine cannot be listed
  const home = resolve(homedir());
  const own = task.project ? config.projects?.[task.project]?.path : undefined;
  const others = Object.values(config.projects ?? {})
    .map((p) => resolve(p.path))
    .filter((p) => kind === "unattended" && !(own && under(resolve(own), p)));
  // ponytail: a missing deny entry (~/.aws on a machine without one) cannot be masked, so its parent is still walked and
  // takes no new entry: `~` itself, nearly always. Creating it would let the session plant what the owner's tool fills
  const walked = masked ? denyRw.filter((p) => !existsSync(p)) : denyRw;
  grant(
    "/",
    base,
    base === "rw" ? [...walked, ...SHARED] : [...deny, ...others, home, ...HIDDEN.map(resolve), "/dev"],
    out,
  );
  // a chat writes there but connects to nothing already listening: a tmux, screen or X server is the owner's own shell,
  // outside the domain with vault.json in reach. ponytail: where a tool puts one elsewhere (TMUX_TMPDIR), `policy.deny`
  if (kind === "chat") for (const p of SHARED) if (existsSync(p)) grant(p, "rn", denyRw, out);
  if (kind === "unattended") {
    for (const p of [own, process.execPath, ...HOME_READ.map((e) => join(home, e)), ...(config.policy.read ?? [])])
      if (p && existsSync(p)) grant(resolve(p), "ro", [...deny, ...others], out);
    // ponytail: no /tmp: what a session writes there any other can read and nothing removes, so TMPDIR is
    // out/tmp and a tool that hardcodes /tmp gets EACCES; `policy.cache: ["/tmp"]` gives it back, with the leak
    for (const p of [...RW_DEV, ...(config.policy.cache ?? [])])
      if (existsSync(p)) grant(resolve(p), "rn", denyRw, out);
  }
  // a Worker runs dist/ and node_modules; the units are held read-only for a chat, which would otherwise write them
  for (const p of kind === "chat" ? ro : ro.slice(0, 2)) if (existsSync(p)) grant(p, "ro", deny, out);
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
    [kind === "unattended" ? paths.cache() : undefined, "rn"],
  ];
  for (const [p, mode] of carve) if (p && existsSync(p)) grant(resolve(p), mode, rest, out);
  if (masked) {
    const shown = carve.flatMap(([p, mode]): [string, Mode][] => (p && existsSync(p) ? [[resolve(p), mode]] : []));
    out.unshift(...nsMounts(deny, ro, shown));
  }
  out.push("scope signal", "scope abstract", "end");
  return `${out.join("\n")}\n`;
}
