/**
 * VM command line and task.json mapping (always); a real boot behind HORTUS_TEST_VM=1 (needs /dev/kvm and a built
 * image in `$HORTUS_TEST_IMAGES` or `$HORTUS_HOME/images`). With a tap the test re-runs itself under `sudo systemd-run`
 * with CAP_NET_ADMIN and Delegate=yes, on a test table and tap prefix; `HORTUS_NO_NET=1` boots with `-netdev user`.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { outbox, sessionFiles, setup } from "../agent/testkit.ts";
import * as paths from "../paths.ts";
import type { TaskJson } from "../types.ts";
import * as net from "./net.ts";
import { init, missingImage, qemuArgs, startVm, vmTaskJson } from "./vm.ts";

const host: TaskJson = {
  id: "t1",
  kind: "unattended",
  title: "t",
  brief: "b",
  scope: { credentials: [], repos: [] },
  origins: [],
  budget: { tokens: 1, hours: 1 },
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
  assert.deepEqual(after("-serial"), ["chardev:con"]);
  assert.ok(after("-chardev").includes("file,id=con,path=/o/console.log,append=on"));

  const u = qemuArgs({ images: "/i", cpus: 1, memMb: 512, link: null, sockets: [], console: "/c" });
  assert.deepEqual(
    u.filter((_, i) => u[i - 1] === "-netdev"),
    ["user,id=n0"],
  );
});

test("missingImage names the first missing file and the fix", () => {
  const d = mkdtempSync(join(tmpdir(), "hortus-img-"));
  assert.equal(missingImage(d), `${join(d, "agent.ext4")} missing: run \`hortus image build\``);
  for (const f of ["agent.ext4", "initramfs.img", "vmlinuz"]) writeFileSync(join(d, f), "");
  assert.equal(missingImage(d), null);
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
    const home = mkdtempSync(join(tmpdir(), "hortus-vmhome-"));
    process.env.HORTUS_HOME = home;
    symlinkSync(images, join(home, "images"));
    const links: string[] = [];
    if (!offline) {
      Object.assign(net.names, NAMES);
      await net.ensureTable();
      init({ links: { register: (a) => links.push(`+${a}`), release: (a) => links.push(`-${a}`) } });
    }

    const dir = setup({ paths: { dof: join(home, "dof"), work: "unused" } });
    mkdirSync(join(home, "dof", "slack"), { recursive: true });
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
        { calls: [bash("touch /dof/x; ip -4 -o addr show eth0; systemd-analyze")] },
        { calls: [{ name: "done", input: { summary: "booted" } }] },
      ]),
    );
    const task = JSON.parse(readFileSync(join(dir, "ctl", "task.json"), "utf8")) as TaskJson;

    const mtime = statSync(join(images, "agent.ext4")).mtimeMs;
    const t0 = Date.now();
    const vm = await startVm({
      task,
      config: { vm: { cpus: 2, mem_mb: 1024, max_concurrent: 1, fallback_host: true } },
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
