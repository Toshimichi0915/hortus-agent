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
 * listed instead: `HOME_READ`). These are the common ones: agents, wallets, app profiles, histories (v7 › Round 16). */
const STORES =
  `.claude .claude.json .codex .gemini .copilot .1password .electrum .electrum-ravencoin .bitcoin .monero Monero
  .thunderbird .pulumi .terraform.d .vault-token .s3cfg .boto .config/rclone .config/op .config/1Password .config/Claude
  .config/Code .config/Cursor .config/discord .config/github-copilot .config/evolution .config/Slack .config/Signal
  .config/google-chrome-beta .config/microsoft-edge .config/vivaldi .bash_history .zsh_history .psql_history .mysql_history
  .local/share/fish/fish_history .mariadb_history .python_history .node_repl_history`.split(/\s+/);

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

/** All an unattended session sees of `$HOME`: where toolchains install, none a credential store (v7 › Review round 16).
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

/** The directive text for one task under `kind`. */
export function profile(
  kind: Kind,
  task: ProfileTask,
  config: Pick<Config, "policy"> & Partial<Pick<Config, "projects">>,
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
  // unattended: of /dev, only RW_DEV: `ro` opened /dev/fb0 (the screen) and the owner's console /dev/tty<n>. /dev/stdout
  // and /dev/fd are links, which need no rule. ponytail: a chat keeps the rest, the owner's boards and /dev/kvm with them
  // unattended: of `$HOME` only what is listed, not `ro` less what is hidden: the stores on one machine cannot be listed
  const home = resolve(homedir());
  const own = task.project ? config.projects?.[task.project]?.path : undefined;
  const others = Object.values(config.projects ?? {})
    .map((p) => resolve(p.path))
    .filter((p) => kind === "unattended" && !(own && under(resolve(own), p)));
  grant("/", base, base === "rw" ? [...denyRw, ...SHARED] : [...deny, ...others, home, ...HIDDEN.map(resolve), "/dev"], out);
  // a chat writes there but connects to nothing already listening: a tmux, screen or X server is the owner's own shell,
  // outside the domain with vault.json in reach. ponytail: where a tool puts one elsewhere (TMUX_TMPDIR), `policy.deny`
  if (kind === "chat") for (const p of SHARED) if (existsSync(p)) grant(p, "rn", denyRw, out);
  if (kind === "unattended") {
    for (const p of [own, process.execPath, ...HOME_READ.map((e) => join(home, e)), ...(config.policy.read ?? [])])
      if (p && existsSync(p)) grant(resolve(p), "ro", [...deny, ...others], out);
    // ponytail: no /tmp (v7 › Host): what a session writes there any other can read and nothing removes, so TMPDIR is
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
  out.push("scope signal", "scope abstract", "end");
  return `${out.join("\n")}\n`;
}
