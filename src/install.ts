/** `hortus install [--force] [--ca]`: the hortusd system unit, written with `sudo tee`. */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as paths from "./paths.ts";

export const CA_ANCHOR = "/etc/ca-certificates/trust-source/anchors/hortus.crt";

export interface InstallOpts {
  force?: boolean;
  /** install the hortus CA into the system trust store (Arch: trust-source anchors); skipped until hortusd made it */
  ca?: boolean;
  /** the CA certificate (default `<HORTUS_HOME>/ca/ca.crt`) */
  caCert?: string;
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
LimitNOFILE=65536
Restart=on-failure
# a bad hortusd.json, a corrupt or locked DB: exit 78, fix and start again (no restart loop)
RestartPreventExitStatus=78

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
  if (opts.ca) {
    const crt = opts.caCert ?? join(paths.ca(), "ca.crt");
    // ponytail: Arch's p11-kit layout only; Debian (/usr/local/share/ca-certificates + update-ca-certificates) when needed
    if (!existsSync(crt)) print(`--ca: ${crt} does not exist yet (start hortusd once); skipped`);
    else
      for (const c of [["install", "-m", "644", crt, CA_ANCHOR], ["update-ca-trust"]]) {
        print(`sudo ${c.join(" ")}`);
        run("sudo", c);
      }
  }
  const hint = () => {
    if (!existsSync(join(paths.images(), "agent.ext4")))
      print("no Worker VM image yet: hortus image build (sudo; until then VM tasks run on the host, vm.fallback_host)");
  };
  if (old === text) {
    print(`${path} is up to date`);
    hint();
    return false;
  }
  if (old !== undefined && !opts.force) throw new Error(`${path} exists and differs; rerun with --force to overwrite`);
  run("sudo", ["tee", path], text);
  run("sudo", ["systemctl", "daemon-reload"]);
  print(`wrote ${path}\n  sudo systemctl enable hortusd\n  sudo systemctl start hortusd`);
  hint();
  return true;
}
