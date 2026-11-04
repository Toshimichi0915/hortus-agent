/**
 * A fake QEMU and virtiofsd on PATH plus three empty image files under $HORTUS_HOME/images: startVm runs without KVM.
 * The "QEMU" writes a kernel banner to the serial file (fd 3) and runs `qemu` (sh; default: hang). Its processes carry
 * `tag` in argv[0] for pgrep. Needs a delegated cgroup (cgroup.create), see `inScope`.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function fakeVm(home: string, tag: string, qemu = `exec -a ${tag} sleep 600`): void {
  mkdirSync(join(home, "images"), { recursive: true });
  for (const f of ["agent.ext4", "initramfs.img", "vmlinuz"]) writeFileSync(join(home, "images", f), "");
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  const sh = (name: string, body: string) => writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  sh("virtiofsd", `while [ "$1" != --socket-path ]; do shift; done; touch "$2"; exec -a ${tag} sleep 600`);
  sh("qemu-system-x86_64", `echo 'Linux version 6.x (fake): loaded' >&3\n${qemu}`);
  process.env.PATH = `${bin}:${process.env.PATH}`;
}

export const hasScope = spawnSync("systemd-run", ["--user", "--scope", "-q", "--", "true"]).status === 0;

/** Re-run the tests of `file` named `^pattern` in a delegated user scope with `INNER=1`; returns node's stdout. */
export function inScope(file: string, pattern: string): string {
  const r = spawnSync(
    "systemd-run",
    [
      ...["--user", "--scope", "-q", "-p", "Delegate=yes", "--"],
      process.execPath,
      ...["--test", `--test-name-pattern=^${pattern}`, file],
    ],
    { encoding: "utf8", env: { ...process.env, NODE_TEST_CONTEXT: undefined, INNER: "1" }, timeout: 60_000 },
  );
  return `${r.stdout}\n${r.stderr}`;
}
