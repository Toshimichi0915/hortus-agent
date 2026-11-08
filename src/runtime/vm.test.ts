/**
 * VM command line and task.json mapping (always); a real boot behind HORTUS_TEST_VM=1 (needs /dev/kvm and a built
 * image in `$HORTUS_TEST_IMAGES` or `$HORTUS_HOME/images`). With a tap the test re-runs itself under `sudo systemd-run`
 * with CAP_NET_ADMIN and Delegate=yes, on a test table and tap prefix; `HORTUS_NO_NET=1` boots with `-netdev user`.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import { outbox, sessionFiles, setup } from "../agent/testkit.ts";
import * as paths from "../paths.ts";
import { call } from "../rpc.ts";
import { fakeVm, hasScope, inScope } from "../test/fakes/vm.ts";
import { tempDir } from "../test/until.ts";
import type { TaskJson } from "../types.ts";
import * as net from "./net.ts";
import { deadline, init, missingImage, qemuArgs, shares, startVm, virtiofsd, vmTaskJson } from "./vm.ts";

const host: TaskJson = {
  id: "t1",
  kind: "unattended",
  title: "t",
  brief: "b",
  scope: { credentials: [], repos: [] },
  origins: [],
  budget: { usd: 1, hours: 1 },
  hours_used: 0,
  provider: "fake",
  model: "m",
  context_window: 1,
  tz: "UTC",
  paths: { dof: "/h/.hortus/dof", repos: "/h/.hortus/repos", work: "/h/.hortus/tasks/t1/out/work", clone: "/h/c" },
  rpc: "https://hortusd.internal",
  features: [],
};

test("vmTaskJson maps host paths to the VM's mounts", () => {
  const v = vmTaskJson(host);
  assert.deepEqual(v.paths, { dof: "/dof", repos: "/repos", work: "/task/out/work", clone: "/task/out/work/clone" });
  assert.deepEqual(vmTaskJson({ ...host, paths: { dof: "/x", work: "/y", schedule: "/s/1" } }).paths, {
    dof: "/dof",
    work: "/task/out/work",
    schedule: "/schedule",
  });
  assert.equal(v.id, "t1");
  assert.deepEqual(host.paths.dof, "/h/.hortus/dof", "input untouched");
});

test("qemuArgs: microvm, direct kernel boot, snapshot root, tap, one vhost-user-fs per share", () => {
  const a = qemuArgs({
    images: "/i",
    cpus: 2,
    memMb: 4096,
    link: { tap: "hortus-t3", hostEnd: "10.77.2.13", vmAddr: "10.77.2.14" },
    sockets: [
      { tag: "task-ctl", sock: "/o/vfs-task-ctl.sock" },
      { tag: "task-out", sock: "/o/vfs-task-out.sock" },
    ],
    console: "/o/console.log",
  });
  const after = (flag: string) => a.filter((_, i) => a[i - 1] === flag);
  assert.deepEqual(after("-M"), ["microvm,accel=kvm,acpi=off,memory-backend=mem"]);
  assert.deepEqual(after("-object"), ["memory-backend-memfd,id=mem,size=4096M,share=on"]);
  assert.deepEqual(after("-kernel"), ["/i/vmlinuz"]);
  assert.deepEqual(after("-initrd"), ["/i/initramfs.img"]);
  assert.match(
    after("-append")[0] ?? "",
    /root=\/dev\/vda .*ip=10\.77\.2\.14::10\.77\.2\.13:255\.255\.255\.252::eth0:off/,
  );
  assert.deepEqual(after("-netdev"), ["tap,id=n0,ifname=hortus-t3,script=no,downscript=no"]);
  assert.deepEqual(after("-device"), [
    "virtio-blk-device,drive=root",
    "virtio-net-device,netdev=n0",
    "vhost-user-fs-device,chardev=vfs0,tag=task-ctl",
    "vhost-user-fs-device,chardev=vfs1,tag=task-out",
  ]);
  assert.ok(a.includes("-snapshot") && a.includes("-no-reboot") && a.includes("-nodefaults"));
  assert.match(after("-append")[0] ?? "", / reboot=t panic=1 /, "a panic ends QEMU");
  assert.deepEqual(after("-serial"), ["chardev:con"]);
  assert.ok(after("-chardev").includes("file,id=con,path=/o/console.log,append=on"));

  const u = qemuArgs({ images: "/i", cpus: 1, memMb: 512, link: null, sockets: [], console: "/c" });
  assert.deepEqual(
    u.filter((_, i) => u[i - 1] === "-netdev"),
    ["user,id=n0,restrict=on"],
  );
});

test("qemuArgs: a comma in a path is doubled", () => {
  const a = qemuArgs({
    images: "/h,x",
    cpus: 1,
    memMb: 512,
    link: null,
    sockets: [{ tag: "t", sock: "/h,x/s" }],
    console: "/c,1",
  });
  assert.ok(a.includes("id=root,file=/h,,x/agent.ext4,format=raw,if=none"));
  assert.ok(a.includes("socket,id=vfs0,path=/h,,x/s"));
  assert.ok(a.includes("file,id=con,path=/c,,1,append=on"));
});

test("the DOF share is a view of scope.dofs: only those worktrees are visible to virtiofsd (no VM)", () => {
  const root = tempDir("hortus-vmview-");
  const dof = join(root, "dof");
  for (const d of ["slack/C1", "gh/o", "slack.git"]) mkdirSync(join(dof, d), { recursive: true });
  writeFileSync(join(dof, "slack", "C1", "m.md"), "in scope\n");
  writeFileSync(join(dof, "gh", "o", "i.md"), "out of scope\n");
  const t: TaskJson = {
    ...host,
    scope: { ...host.scope, dofs: ["slack", "missing", ".."] },
    paths: { dof, work: root },
  };
  const share = shares(t).find((s) => s.tag === "dof");
  assert.deepEqual(share?.only, ["slack", "slack.git"], "an absent DOF and a path-like name are left out");
  if (!share) return;
  // the real wrapper (unshare + bind mounts), with a fake virtiofsd that lists what its --shared-dir holds
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "virtiofsd"),
    '#!/bin/sh\nwhile [ "$1" != --shared-dir ]; do shift; done\nid -u\ncd "$2" && find . -name "*.md" | sort && cat slack/C1/m.md\n',
  );
  chmodSync(join(bin, "virtiofsd"), 0o755);
  const view = join(root, "view");
  for (const d of ["", "slack", "slack.git"]) mkdirSync(join(view, d), { recursive: true });
  const v = virtiofsd(share, join(root, "s.sock"), view);
  assert.equal(v.cmd, "unshare");
  assert.ok(v.args.includes("--readonly") && v.args.at(v.args.indexOf("--shared-dir") + 1) === view);
  const out = execFileSync(v.cmd, v.args, {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(out, `${process.getuid?.()}\n./slack/C1/m.md\nin scope\n`, "the owner's uid, slack only");
  assert.equal(spawnSync("find", [view, "-name", "*.md"], { encoding: "utf8" }).stdout, "", "no mount on the host");
  assert.equal(virtiofsd({ tag: "task-out", path: "/o", ro: false }, "/s", "/v").cmd, "virtiofsd");
});

test("deadline: past 2^31-1 ms it re-arms instead of firing at once; clear stops it", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let fired = 0;
    deadline(2 ** 31 + 10, () => fired++);
    mock.timers.tick(1000);
    assert.equal(fired, 0);
    mock.timers.tick(2 ** 31 - 1000);
    assert.equal(fired, 0);
    mock.timers.tick(20);
    assert.equal(fired, 1);
    const clear = deadline(5, () => fired++);
    clear();
    mock.timers.tick(10);
    assert.equal(fired, 1);
  } finally {
    mock.timers.reset();
  }
});

test("build-image: the guest's copy of the CA is world-readable, as hortusd's 0600 ca.crt is not", () => {
  // a plain `cp` kept 0600 as root: `runuser agent certutil` failed, so `hortus image build` failed on every real home
  const script = readFileSync(new URL("../../scripts/build-image.sh", import.meta.url), "utf8");
  assert.match(script, /^install -m 644 "\$ca" "\$root\/etc\/ssl\/certs\/hortus\.pem"/m);
});

test("vm.image: all three files, built when, for the owner alone", async () => {
  const owner = { role: "owner" } as const;
  const home = process.env.HORTUS_HOME;
  process.env.HORTUS_HOME = tempDir("hortus-vm-image-");
  try {
    const dir = paths.images();
    assert.deepEqual(await call("vm.image", {}, owner), { present: false, dir });
    mkdirSync(dir, { recursive: true });
    for (const f of ["agent.ext4", "initramfs.img"]) writeFileSync(join(dir, f), "");
    assert.equal(((await call("vm.image", {}, owner)) as { present: boolean }).present, false);
    writeFileSync(join(dir, "vmlinuz"), "");
    assert.deepEqual(await call("vm.image", {}, owner), {
      present: true,
      dir,
      built: statSync(join(dir, "agent.ext4")).mtime.toISOString(),
    });
    await assert.rejects(call("vm.image", {}, { role: "worker", task: "t" }), /not allowed/);
  } finally {
    if (home === undefined) delete process.env.HORTUS_HOME;
    else process.env.HORTUS_HOME = home;
  }
});

test("missingImage names the first missing file and the fix", () => {
  const d = tempDir("hortus-img-");
  assert.equal(missingImage(d), `${join(d, "agent.ext4")} missing: run \`hortus image build\``);
  for (const f of ["agent.ext4", "initramfs.img", "vmlinuz"]) writeFileSync(join(d, f), "");
  assert.equal(missingImage(d, "/nonexistent"), "qemu-system-x86_64 not found on PATH: install it");
  const bin = tempDir("hortus-imgbin-");
  writeFileSync(join(bin, "qemu-system-x86_64"), "", { mode: 0o755 });
  assert.equal(missingImage(d, bin), "virtiofsd not found on PATH: install it");
  writeFileSync(join(bin, "virtiofsd"), "", { mode: 0o644 });
  assert.equal(missingImage(d, bin), "virtiofsd not found on PATH: install it", "not executable");
  chmodSync(join(bin, "virtiofsd"), 0o755);
  // /dev/kvm: whatever this machine has (the VM tests need it)
  assert.ok([null, "/dev/kvm not accessible: join the kvm group"].includes(missingImage(d, bin)));
});

/** a QEMU that "boots" a kernel and hangs (no guest ever writes out/booted), virtiofsds that only make their socket */
test("boot timeout: no first contact from the guest → the VM is killed, the exit names the timeout", {
  skip: !hasScope && "no systemd --user scope",
}, async () => {
  // cgroup.create needs a delegated cgroup: this test re-runs alone in a user scope
  if (process.env.INNER !== "1")
    return assert.match(inScope(fileURLToPath(import.meta.url), "boot timeout"), /# pass 1/);
  const home = tempDir("hortus-boothome-");
  process.env.HORTUS_HOME = home;
  process.env.HORTUS_NO_NET = "1";
  const tag = `hortus-boot-${process.pid}`;
  fakeVm(home, tag);
  const dir = setup({ paths: { dof: join(home, "dof"), work: "unused" } });
  mkdirSync(join(home, "tasks"));
  symlinkSync(dir, join(home, "tasks", "t1"));
  mkdirSync(join(dir, "out", "booted")); // a previous guest's leftover: removed before the boot, not counted
  const task = JSON.parse(readFileSync(join(dir, "ctl", "task.json"), "utf8")) as TaskJson;
  const t0 = Date.now();
  const vm = await startVm({
    task,
    config: { vm: { cpus: 1, mem_mb: 64, max_concurrent: 1, fallback_host: true, boot_timeout_s: 1.5 } },
    deadlineMs: 60_000,
  });
  assert.ok(spawnSync("pgrep", ["-f", tag]).status === 0, "the fakes run");
  const exit = await vm.wait();
  const secs = (Date.now() - t0) / 1000;
  assert.match(exit.error ?? "", /^boot timeout: no contact from the guest within 1\.5 s/);
  assert.equal(exit.signal, "SIGKILL");
  assert.ok(secs < 10, `${secs} s`);
  assert.match(readFileSync(join(dir, "out", "console.log"), "utf8"), /Linux version 6\.x \(fake\): loaded/);
  assert.notEqual(spawnSync("pgrep", ["-f", tag]).status, 0, "QEMU and the virtiofsds are gone");
});

test("a virtiofsd gone under a running guest ends the VM, the exit says so", {
  skip: !hasScope && "no systemd --user scope",
}, async () => {
  if (process.env.INNER !== "1")
    return assert.match(inScope(fileURLToPath(import.meta.url), "a virtiofsd gone"), /# pass 1/);
  const home = tempDir("hortus-vfshome-");
  process.env.HORTUS_HOME = home;
  process.env.HORTUS_NO_NET = "1";
  const tag = `hortus-vfs-${process.pid}`;
  fakeVm(home, tag);
  const dir = setup({ paths: { dof: join(home, "dof"), work: "unused" } });
  mkdirSync(join(home, "tasks"));
  symlinkSync(dir, join(home, "tasks", "t1"));
  const task = JSON.parse(readFileSync(join(dir, "ctl", "task.json"), "utf8")) as TaskJson;
  const vm = await startVm({
    task,
    config: { vm: { cpus: 1, mem_mb: 64, max_concurrent: 1, fallback_host: true, boot_timeout_s: 30 } },
    deadlineMs: 60_000,
  });
  spawnSync("pkill", ["-9", "-o", "-f", tag]); // the oldest: the first virtiofsd, QEMU comes last
  const exit = await vm.wait();
  assert.match(exit.error ?? "", /^virtiofsd exited: /);
  assert.notEqual(spawnSync("pgrep", ["-f", tag]).status, 0, "QEMU and the other virtiofsds are gone");
});

test("a clean end, virtiofsd gone first: QEMU still freeing its guest stays a good exit", {
  skip: !hasScope && "no systemd --user scope",
}, async () => {
  if (process.env.INNER !== "1")
    return assert.match(inScope(fileURLToPath(import.meta.url), "a clean end, virtiofsd"), /# pass 1/);
  const home = tempDir("hortus-vfshome-");
  process.env.HORTUS_HOME = home;
  process.env.HORTUS_NO_NET = "1";
  const tag = `hortus-vfs-${process.pid}`;
  fakeVm(home, tag, "sleep 2.5; exit 0");
  const dir = setup({ paths: { dof: join(home, "dof"), work: "unused" } });
  mkdirSync(join(home, "tasks"));
  symlinkSync(dir, join(home, "tasks", "t1"));
  const task = JSON.parse(readFileSync(join(dir, "ctl", "task.json"), "utf8")) as TaskJson;
  const vm = await startVm({
    task,
    config: { vm: { cpus: 1, mem_mb: 64, max_concurrent: 1, fallback_host: true, boot_timeout_s: 30 } },
    deadlineMs: 60_000,
  });
  writeFileSync(join(dir, "out", "ended"), "0");
  spawnSync("pkill", ["-9", "-o", "-f", tag]);
  const exit = await vm.wait();
  assert.equal(exit.error, undefined);
  assert.equal(exit.code, 0);
});

const enabled = process.env.HORTUS_TEST_VM === "1";
const offline = process.env.HORTUS_NO_NET === "1";
const inner = process.env.HORTUS_TEST_VM_INNER === "1";
const NAMES = { table: "hortus_vmtest", iface: "hortusvmt0", tap: "hortusvt" };

if (!enabled) {
  test("VM boot (set HORTUS_TEST_VM=1)", { skip: "HORTUS_TEST_VM unset" }, () => {});
} else if (!offline && !inner) {
  test("VM boot inside a capability-bearing unit", () => {
    const env = [
      "HORTUS_TEST_VM=1",
      "HORTUS_TEST_VM_INNER=1",
      `HORTUS_TEST_IMAGES=${process.env.HORTUS_TEST_IMAGES ?? paths.images()}`,
      `PATH=${process.env.PATH}`,
      `HOME=${process.env.HOME}`,
    ];
    const r = spawnSync(
      "sudo",
      [
        "systemd-run",
        ...["--uid", String(process.getuid?.()), "--gid", String(process.getgid?.())],
        ...["-p", "AmbientCapabilities=CAP_NET_ADMIN", "-p", "CapabilityBoundingSet=CAP_NET_ADMIN"],
        ...["-p", "Delegate=yes", "-p", "RuntimeMaxSec=150"],
        ...["--pipe", "--wait", "--collect", "--quiet", "--same-dir"],
        ...env.flatMap((e) => ["-E", e]),
        "--",
        process.execPath,
        "--test",
        "--test-timeout=120000",
        fileURLToPath(import.meta.url),
      ],
      { encoding: "utf8", timeout: 180_000 },
    );
    spawnSync("sudo", ["nft", "delete", "table", "inet", NAMES.table], { stdio: "ignore" });
    for (let n = 0; n < 4; n++) spawnSync("sudo", ["ip", "link", "del", `${NAMES.tap}${n}`], { stdio: "ignore" });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /# fail 0/, r.stdout);
  });
} else {
  test("VM boot: the agent runs, /task/ctl is read-only, out/work persists, the VM powers off", async () => {
    const images = process.env.HORTUS_TEST_IMAGES ?? paths.images();
    const home = tempDir("hortus-vmhome-");
    process.env.HORTUS_HOME = home;
    symlinkSync(images, join(home, "images"));
    const links: string[] = [];
    if (!offline) {
      Object.assign(net.names, NAMES);
      await net.ensureTable();
      init({ links: { register: (a) => links.push(`+${a}`), release: (a) => links.push(`-${a}`) } });
    }

    const dir = setup({
      scope: { credentials: [], repos: [], dofs: ["slack"] },
      paths: { dof: join(home, "dof"), work: "unused" },
    });
    mkdirSync(join(home, "dof", "slack"), { recursive: true });
    mkdirSync(join(home, "dof", "github")); // out of scope: not in the guest's /dof
    execFileSync("git", ["init", "-q", "--bare", join(home, "dof", "slack.git")]);
    writeFileSync(join(home, "dof", "slack", "hello.md"), "hi from the DOF\n");
    mkdirSync(join(home, "tasks"));
    symlinkSync(dir, join(home, "tasks", "t1"));
    // The VM sees only ctl/ and out/: the fake provider keeps its script and request log in out/.
    const fake = join(dir, "ctl", "home", ".hortus", "plugins", "fake", "fake.mjs");
    writeFileSync(fake, readFileSync(fake, "utf8").replace(/const dir = .*;/, 'const dir = "/task/out/";'));
    const bash = (command: string) => ({ name: "bash", input: { command } });
    writeFileSync(
      join(dir, "out", "fake-script.json"),
      JSON.stringify([
        { calls: [bash("touch /task/ctl/x")] },
        { calls: [bash("echo kept > /task/out/work/persist.txt && echo gone > ~/gone && cat /dof/slack/hello.md")] },
        { calls: [bash("touch /dof/x; ls /dof; ip -4 -o addr show eth0; systemd-analyze")] },
        { calls: [bash("echo mirror-repo: $(git --git-dir /dof/slack.git rev-parse --is-bare-repository)")] },
        { calls: [{ name: "done", input: { summary: "booted" } }] },
      ]),
    );
    const task = JSON.parse(readFileSync(join(dir, "ctl", "task.json"), "utf8")) as TaskJson;

    const mtime = statSync(join(images, "agent.ext4")).mtimeMs;
    const t0 = Date.now();
    const vm = await startVm({
      task,
      config: { vm: { cpus: 2, mem_mb: 1024, max_concurrent: 1, fallback_host: true, boot_timeout_s: 120 } },
      deadlineMs: 70_000,
    });
    const exit = await vm.wait();
    const secs = (Date.now() - t0) / 1000;
    console.log(`# VM boot-to-poweroff ${secs.toFixed(1)} s, exit ${JSON.stringify(exit)}`);
    const log = readFileSync(join(dir, "out", "console.log"), "utf8");
    assert.ok(secs < 60, `powered off after ${secs} s\n${log.slice(-6000)}`);
    assert.equal(exit.code, 0, log.slice(-4000));

    const vmTask = JSON.parse(readFileSync(join(dir, "ctl", "task.json"), "utf8")) as TaskJson;
    assert.equal(vmTask.paths.work, "/task/out/work");
    assert.deepEqual(
      outbox(dir).map((m) => [m.type, m.text]),
      [["result", "booted"]],
      log.slice(-4000),
    );
    const sessions = JSON.stringify(sessionFiles(dir));
    assert.match(sessions, /touch: cannot touch '\/task\/ctl\/x': Read-only file system/);
    assert.match(sessions, /touch: cannot touch '\/dof\/x': Read-only file system/);
    assert.match(sessions, /hi from the DOF/);
    assert.match(sessions, /mirror-repo: true/);
    assert.doesNotMatch(sessions, /github/, "a DOF outside scope.dofs is not in the guest's /dof");
    assert.ok(!existsSync(join(dir, "ctl", "x")));
    assert.equal(readFileSync(join(dir, "out", "work", "persist.txt"), "utf8"), "kept\n");
    assert.equal(statSync(join(images, "agent.ext4")).mtimeMs, mtime, "-snapshot: the image is untouched");
    if (!offline) {
      assert.equal(links.length, 2);
      const addr = links[0]?.slice(1) ?? "";
      assert.deepEqual(links, [`+${addr}`, `-${addr}`]);
      assert.match(sessions, new RegExp(`inet ${addr.replaceAll(".", "\\.")}/30`));
      await net.flushStale().catch(() => {});
      spawnSync("nft", ["delete", "table", "inet", NAMES.table]);
    }
  });
}
