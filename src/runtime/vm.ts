/**
 * A VM task (docs/design/13-worker-vm.md): QEMU microvm with the host kernel, `images/agent.ext4` under `-snapshot`,
 * one virtiofsd per share, a tap link to the proxy. QEMU and the virtiofsds live in the task's cgroup; `kill()` is
 * `cgroup.kill`. `HORTUS_NO_NET=1` swaps the tap for `-netdev user` (boot-only: no proxy, no rules, no links row).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Config } from "../config.ts";
import { logger } from "../log.ts";
import { openAppend } from "../hostile.ts";
import * as paths from "../paths.ts";
import type { Role, TaskJson } from "../types.ts";
import * as cgroup from "./cgroup.ts";
import type { Child, Exit } from "./host.ts";
import * as net from "./net.ts";

export interface VmDeps {
  /** F3's links registry: the proxy finds the VM by its peer address */
  links: {
    register(address: string, role: Role, task: string, kind: string): unknown;
    release(address: string): unknown;
  };
}

export interface VmOpts {
  /** the host task.json; startVm writes its VM variant to ctl/task.json */
  task: TaskJson;
  config: Pick<Config, "vm">;
  /** kill QEMU this many ms after start (the remaining `hours` budget) */
  deadlineMs?: number;
}

export interface Share {
  tag: string;
  path: string;
  ro: boolean;
}

export interface Link {
  tap: string;
  hostEnd: string;
  vmAddr: string;
}

const log = logger("vm");
let deps: VmDeps | undefined;
/** tap indexes in use by this process (stale ones are deleted by net.flushStale at start) */
const used = new Set<number>();
const MAX_LINKS = 256;
const IMAGE = ["agent.ext4", "initramfs.img", "vmlinuz"];
const MAX_TIMER = 2 ** 31 - 1;

export function init(d: VmDeps): void {
  deps = d;
}

/** null, or the error a task card shows when the image has not been built. */
export function missingImage(dir = paths.images()): string | null {
  const gone = IMAGE.filter((f) => !existsSync(join(dir, f)));
  return gone.length ? `${join(dir, gone[0] ?? "")} missing: run \`hortus image build\`` : null;
}

/** The same task as the Worker inside the VM sees it. */
export function vmTaskJson(task: TaskJson): TaskJson {
  const p = task.paths;
  return {
    ...task,
    paths: {
      dof: "/dof",
      work: "/task/out/work",
      ...(p.repos && { repos: "/repos" }),
      ...(p.clone && { clone: "/task/out/work/clone" }),
      ...(p.schedule && { schedule: "/schedule" }),
    },
  };
}

/** The virtiofs shares (tags match the image's /etc/fstab); optional ones only when the host path exists. */
export function shares(task: TaskJson): Share[] {
  const opt = (tag: string, path: string | undefined, ro: boolean): Share[] =>
    path && existsSync(path) ? [{ tag, path, ro }] : [];
  return [
    { tag: "task-ctl", path: paths.ctl(task.id), ro: true },
    { tag: "task-out", path: paths.out(task.id), ro: false },
    ...opt("dof", task.paths.dof, true),
    ...opt("repos", task.paths.repos, true),
    ...opt("schedule", task.paths.schedule, false),
  ];
}

export interface QemuSpec {
  images: string;
  cpus: number;
  memMb: number;
  /** null: `-netdev user` (HORTUS_NO_NET) */
  link: Link | null;
  sockets: { tag: string; sock: string }[];
  console: string;
}

/** a QEMU option value: `,` separates options, so a path (under HORTUS_HOME) doubles it */
const opt = (v: string): string => v.replaceAll(",", ",,");

export function qemuArgs(s: QemuSpec): string[] {
  const ip = s.link
    ? `ip=${s.link.vmAddr}::${s.link.hostEnd}:255.255.255.252::eth0:off`
    : "ip=10.0.2.15::10.0.2.2:255.255.255.0::eth0:off";
  return [
    ...["-M", "microvm,accel=kvm,acpi=off,memory-backend=mem", "-cpu", "host"],
    ...["-smp", String(s.cpus), "-m", `${s.memMb}M`],
    ...["-object", `memory-backend-memfd,id=mem,size=${s.memMb}M,share=on`],
    ...["-kernel", join(s.images, "vmlinuz"), "-initrd", join(s.images, "initramfs.img")],
    ...["-append", `console=ttyS0 root=/dev/vda rw quiet reboot=t net.ifnames=0 ${ip}`],
    ...["-drive", `id=root,file=${opt(join(s.images, "agent.ext4"))},format=raw,if=none`],
    ...["-device", "virtio-blk-device,drive=root", "-snapshot"],
    ...[
      "-netdev",
      // restrict=on: no host loopback (the console) through 10.0.2.2, no internet
      s.link ? `tap,id=n0,ifname=${s.link.tap},script=no,downscript=no` : "user,id=n0,restrict=on",
      "-device",
      "virtio-net-device,netdev=n0",
    ],
    ...s.sockets.flatMap((v, i) => [
      ...["-chardev", `socket,id=vfs${i},path=${opt(v.sock)}`],
      ...["-device", `vhost-user-fs-device,chardev=vfs${i},tag=${v.tag}`],
    ]),
    ...["-chardev", `file,id=con,path=${opt(s.console)},append=on`, "-serial", "chardev:con"],
    ...["-nographic", "-nodefaults", "-no-reboot"],
  ];
}

/** `fn` after `ms` (unref'd), re-armed in steps: setTimeout fires at once past 2^31-1 ms (~24.8 days). Returns clear. */
export function deadline(ms: number, fn: () => void): () => void {
  let timer: NodeJS.Timeout;
  const arm = (left: number) => {
    timer = setTimeout(() => (left > MAX_TIMER ? arm(left - MAX_TIMER) : fn()), Math.min(left, MAX_TIMER));
    timer.unref();
  };
  arm(ms);
  return () => clearTimeout(timer);
}

async function until(ok: () => boolean, ms: number, what: string): Promise<void> {
  for (let t = 0; !ok(); t += 20) {
    if (t >= ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

/** Boot the task's VM. Rejects when the image is missing or the link/shares cannot be set up (everything undone). */
export async function startVm(o: VmOpts): Promise<Child> {
  const missing = missingImage();
  if (missing) throw new Error(missing);
  const { task } = o;
  const id = task.id;
  const offline = process.env.HORTUS_NO_NET === "1";
  if (!offline && !deps) throw new Error("vm: init() was not called");
  const out = paths.out(id);
  mkdirSync(join(out, "work"), { recursive: true });
  writeFileSync(join(paths.ctl(id), "task.json"), JSON.stringify(vmTaskJson(task), null, 2));
  // opened here (no link followed); QEMU's serial chardev gets the same file as its fd 3
  const logFd = openAppend(join(out, "console.log"));
  const logFile = createWriteStream("", { fd: logFd });
  // hortusd's own, outside every share: the guest cannot plant anything where the sockets go
  const vfs = join(paths.task(id), "vfs");
  const procs: ChildProcess[] = [];
  let link: Link | null = null;
  let n = -1;
  let cg = "";
  let cleaning: Promise<void> | undefined;
  // each step on its own: one failing never skips the tap index or the log close
  const step = async (what: string, f: () => unknown) => {
    try {
      await f();
    } catch (e) {
      log.error(`${what} failed`, e, { task: id });
    }
  };
  const cleanup = () => {
    cleaning ??= (async () => {
      await step("cgroup kill", () => cgroup.kill(id));
      for (const p of procs) if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL");
      const l = link;
      if (l) {
        await step("removeVmLink", () => net.removeVmLink(l.tap));
        if (!offline) await step("links release", () => deps?.links.release(l.vmAddr));
      }
      await step("socket cleanup", () => rmSync(vfs, { force: true, recursive: true }));
      used.delete(n);
      await new Promise<void>((r) => logFile.end(r));
    })();
    return cleaning;
  };
  const attach = async (p: ChildProcess) => {
    procs.push(p);
    p.stderr?.pipe(logFile, { end: false });
    p.on("error", (e) => log.error("spawn failed", e, { task: id, cmd: p.spawnfile }));
    if (p.pid) await writeFile(join(cg, "cgroup.procs"), String(p.pid));
  };
  try {
    // ponytail: pids join the cgroup right after spawn, so a fork in the first instant would stay outside; QEMU and
    // virtiofsd do not fork at start. A clone3(CLONE_INTO_CGROUP) helper closes it if that ever matters.
    cg = await cgroup.create(id);
    if (!offline) {
      for (n = 0; used.has(n); n++);
      if (n >= MAX_LINKS) throw new Error("no VM link free");
      used.add(n);
      link = await net.addTap(n, userInfo().username);
      await net.vmLinkRules(link.tap, link.vmAddr);
      await deps?.links.register(link.vmAddr, task.kind === "planner" ? "planner" : "worker", id, "vm");
    }
    const sockets: { tag: string; sock: string }[] = [];
    rmSync(vfs, { force: true, recursive: true });
    mkdirSync(vfs, { mode: 0o700 });
    for (const s of shares(task)) {
      const sock = join(vfs, `${s.tag}.sock`);
      const args = [
        // namespace (unprivileged user + mount namespace, the share as its root): a symlink the guest plants cannot
        // point virtiofsd outside the shared directory
        "--sandbox",
        "namespace",
        "--socket-path",
        sock,
        "--shared-dir",
        s.path,
        ...(s.ro ? ["--readonly"] : []),
      ];
      await attach(spawn("virtiofsd", args, { stdio: ["ignore", "ignore", "pipe"] }));
      sockets.push({ tag: s.tag, sock });
    }
    await until(() => sockets.every((s) => existsSync(s.sock)), 5000, "virtiofsd sockets");
    const args = qemuArgs({
      images: paths.images(),
      cpus: o.config.vm.cpus,
      memMb: o.config.vm.mem_mb,
      link,
      sockets,
      console: "/dev/fd/3",
    });
    log.info("starting", { task: id, tap: link?.tap, vm: link?.vmAddr });
    const qemu = spawn("qemu-system-x86_64", args, { stdio: ["ignore", "ignore", "pipe", logFd] });
    await attach(qemu);
    const done = new Promise<Exit>((resolve, reject) => {
      const clear =
        o.deadlineMs === undefined
          ? () => {}
          : deadline(o.deadlineMs, () => {
              log.info("hours budget reached: killing the VM", { task: id });
              void cleanup();
            });
      qemu.on("error", (e) => {
        clear();
        cleanup().then(() => reject(e), reject);
      });
      qemu.on("exit", (code, signal) => {
        clear();
        cleanup().then(() => resolve({ code, signal }), reject);
      });
    });
    done.catch(() => {});
    return { pid: qemu.pid ?? -1, wait: () => done, kill: () => cleanup() };
  } catch (e) {
    await cleanup();
    throw e;
  }
}
