/** `hortus install [--force] [--ca]`: the hortusd system unit (v6 › Process), written with `sudo tee`. */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface InstallOpts {
  force?: boolean;
  /** install the hortus CA into the system trust store: a no-op until the CA exists (F3) */
  ca?: boolean;
  user?: string;
  home?: string;
  node?: string;
  /** the dist/ directory holding bin/hortusd.js */
  dist?: string;
  unitPath?: string;
  /** runs a privileged command (default: execFileSync, stdin = input) */
  run?(cmd: string, args: string[], input?: string): void;
  print?(line: string): void;
}

export function unit(o: { user: string; home: string; node: string; dist: string }): string {
  const caps = "CAP_NET_ADMIN CAP_NET_BIND_SERVICE";
  return `[Unit]
Description=hortusd (hortus daemon)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${o.user}
Environment=HOME=${o.home}
ExecStart=${o.node} --no-warnings=ExperimentalWarning ${join(o.dist, "bin", "hortusd.js")}
AmbientCapabilities=${caps}
CapabilityBoundingSet=${caps}
SupplementaryGroups=kvm
Delegate=yes
KillMode=mixed
Restart=on-failure

[Install]
WantedBy=multi-user.target
`;
}

/** Returns whether the unit was written. Throws when a different unit exists and `force` is not set. */
export function install(opts: InstallOpts = {}): boolean {
  const path = opts.unitPath ?? "/etc/systemd/system/hortusd.service";
  const print = opts.print ?? console.log;
  const run =
    opts.run ??
    ((cmd: string, args: string[], input?: string) =>
      execFileSync(cmd, args, { input, stdio: [input === undefined ? "inherit" : "pipe", "ignore", "inherit"] }));
  const text = unit({
    user: opts.user ?? userInfo().username,
    home: opts.home ?? homedir(),
    node: opts.node ?? process.execPath,
    dist: opts.dist ?? dirname(fileURLToPath(import.meta.url)),
  });
  let old: string | undefined;
  try {
    old = readFileSync(path, "utf8");
  } catch {}
  if (opts.ca) print("--ca: no CA yet (step 2 installs it); skipped");
  if (old === text) {
    print(`${path} is up to date`);
    return false;
  }
  if (old !== undefined && !opts.force) throw new Error(`${path} exists and differs; rerun with --force to overwrite`);
  run("sudo", ["tee", path], text);
  run("sudo", ["systemctl", "daemon-reload"]);
  print(`wrote ${path}\n  sudo systemctl enable hortusd\n  sudo systemctl start hortusd`);
  return true;
}
