/**
 * Every `ip` and `nft` call hortusd makes.
 * hortusd has CAP_NET_ADMIN from its unit; nothing here uses sudo. Every call is idempotent: `ip -j` / `nft -j list`
 * first. `HORTUS_NO_NET=1` turns every export into a logged no-op.
 *
 * Table `inet hortus`:
 *   out      filter/output: jump sessions; ct established,related accept; ip daddr 10.77.1.0/24 drop
 *   sessions per-session rules, each matching the session's cgroup and ending in drop
 *   nat      nat/output: per-session DNAT of 443/80/53 to the proxy's ports (`ports`)
 *   pre      nat/prerouting: per-tap DNAT of 10.77.0.1:443/80/53 to the proxy's ports
 *   input    filter/input: 10.77.0.0/16 only from lo and the taps (a LAN host or container never poses as a
 *            session address); per-tap accept to the proxy, then drop
 *   forward  filter/forward: nothing is forwarded from or to a tap
 * Rules carry `comment "hortus:<task or tap>"` and are deleted by it.
 */
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { logger } from "../log.ts";
import { depth, relative } from "./cgroup.ts";

/** Names; tests point them at their own table, dummy interface and tap prefix so a running daemon is never touched. */
export const names = { table: "hortus", iface: "hortus0", tap: "hortus-t" };

/** The proxy's listener ports (config `proxy`; the runtime module copies them in at start). Root-held *:80/*:443
 * elsewhere on the host is why the proxy binds high ports and nftables DNATs the standard ones. */
export const ports = { https: 8443, http: 8080, dns: 8053 };

export const PROXY = "10.77.0.1";
export const SESSIONS = "10.77.1.0/24";
/** The loopback console's bound port (console/index.ts sets it before the dispatcher starts sessions; it follows
 * HORTUS_CONSOLE_PORT): dropped on 127.0.0.1 and ::1 for sessions. */
export const localConsole = { port: 7700 };
/** The remote console listener's port while it runs (console/remote.ts): dropped on every address for sessions. */
export const remoteConsole = { port: 0 };
/** The webhook listener's bound port (gateway/webhooks.ts; 127.0.0.1 only): dropped for sessions (HMAC holds, but
 * each delivery buffers up to 25 MB before the check). */
export const localWebhook = { port: 0 };

const log = logger("net");

function off(what: string): boolean {
  if (process.env.HORTUS_NO_NET !== "1") return false;
  log.info(`HORTUS_NO_NET=1: skipped ${what}`);
  return true;
}

function run(cmd: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    c.stdout?.on("data", (d) => {
      out += d;
    });
    c.stderr?.on("data", (d) => {
      err += d;
    });
    c.on("error", reject);
    c.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${cmd} ${args.join(" ")}: ${err.trim() || `exit ${code}`}`)),
    );
    if (input !== undefined) c.stdin?.end(input);
  });
}

const nft = (script: string) => run("nft", ["-f", "-"], script);
const T = () => `inet ${names.table}`;

/** `ip -j` output, or null when the object does not exist. */
async function ipJson(args: string[]): Promise<{ ifname?: string; addr_info?: { local: string }[] }[] | null> {
  try {
    return JSON.parse(await run("ip", ["-j", ...args]));
  } catch {
    return null;
  }
}

async function addresses(dev: string): Promise<string[]> {
  return ((await ipJson(["addr", "show", "dev", dev])) ?? []).flatMap((l) => (l.addr_info ?? []).map((a) => a.local));
}

interface NftRule {
  chain: string;
  handle: number;
  comment?: string;
}

async function rules(): Promise<NftRule[] | null> {
  try {
    const j = JSON.parse(await run("nft", ["-j", "list", "table", "inet", names.table]));
    return (j.nftables as { rule?: NftRule }[]).flatMap((e) => (e.rule ? [e.rule] : []));
  } catch {
    return null;
  }
}

async function deleteByComment(comment: string): Promise<void> {
  const del = ((await rules()) ?? []).filter((r) => r.comment === comment);
  if (del.length) await nft(del.map((r) => `delete rule ${T()} ${r.chain} handle ${r.handle}\n`).join(""));
}

/** The table and its base chains, created once (a table that exists is left as it is). */
export async function ensureTable(): Promise<void> {
  if (off("ensureTable") || (await rules()) !== null) return;
  const tap = `"${names.tap}*"`;
  await nft(`table ${T()} {
  chain sessions {
  }
  chain out {
    type filter hook output priority 0; policy accept;
    jump sessions
    ct state established,related accept
    ip daddr ${SESSIONS} drop
  }
  chain nat {
    type nat hook output priority -100; policy accept;
  }
  chain pre {
    type nat hook prerouting priority -100; policy accept;
  }
  chain input {
    type filter hook input priority 0; policy accept;
    iifname "lo" ip daddr 10.77.0.0/16 accept
    iifname != "${names.tap}*" ip daddr 10.77.0.0/16 drop
  }
  chain forward {
    type filter hook forward priority 0; policy accept;
    iifname ${tap} drop
    oifname ${tap} drop
  }
}
`);
}

/** The dummy interface the proxy listens on: `hortus0` with 10.77.0.1/32, up; and the table. */
export async function ensureDummy(): Promise<void> {
  if (off("ensureDummy")) return;
  const dev = names.iface;
  if (!(await ipJson(["link", "show", "dev", dev]))) await run("ip", ["link", "add", dev, "type", "dummy"]);
  if (!(await addresses(dev)).includes(PROXY)) await run("ip", ["addr", "add", `${PROXY}/32`, "dev", dev]);
  await run("ip", ["link", "set", dev, "up"]);
  await ensureTable();
}

export async function addAddress(a: string): Promise<void> {
  if (off(`addAddress ${a}`)) return;
  if (!(await addresses(names.iface)).includes(a)) await run("ip", ["addr", "add", `${a}/32`, "dev", names.iface]);
}

export async function delAddress(a: string): Promise<void> {
  if (off(`delAddress ${a}`)) return;
  if ((await addresses(names.iface)).includes(a)) await run("ip", ["addr", "del", `${a}/32`, "dev", names.iface]);
}

const quote = (s: string): string => {
  if (/["\n\\]/.test(s)) throw new Error(`cannot quote ${JSON.stringify(s)} for nft`);
  return `"${s}"`;
};

/**
 * Rules for one host session: its cgroup reaches its own address (80/443 DNAT'd to the proxy's ports), loopback except
 * the console, and `chatAllow`; DNS to anywhere is DNAT'd to its address's DNS port; everything else is dropped.
 * Replaces earlier rules of the task.
 */
export async function sessionRules(
  task: string,
  cgroupPath: string,
  address: string,
  chatAllow: string[],
): Promise<void> {
  if (off(`sessionRules ${task}`)) return;
  await removeSessionRules(task);
  const m = `socket cgroupv2 level ${depth(cgroupPath)} ${quote(relative(cgroupPath))}`;
  const c = `comment ${quote(`hortus:${task}`)}`;
  const v4 = chatAllow.filter((a) => !a.includes(":"));
  const v6 = chatAllow.filter((a) => a.includes(":"));
  const s = (r: string) => `add rule ${T()} sessions ${m} ${r} ${c}\n`;
  const nat = (r: string) => `add rule ${T()} nat ${m} ${r} ${c}\n`;
  const p = ports;
  await nft(
    nat(`meta nfproto ipv4 udp dport 53 dnat ip to ${address}:${p.dns}`) +
      nat(`ip daddr ${address} tcp dport 80 dnat ip to ${address}:${p.http}`) +
      nat(`ip daddr ${address} tcp dport 443 dnat ip to ${address}:${p.https}`) +
      s(`ip daddr ${address} tcp dport { ${p.http}, ${p.https} } accept`) +
      s(`ip daddr ${address} udp dport ${p.dns} accept`) +
      // another session's address (or 10.77.0.1 bound as a source) is never reachable, whatever chat.allow says
      s("ip daddr 10.77.0.0/16 drop") +
      (remoteConsole.port ? s(`tcp dport ${remoteConsole.port} drop`) : "") +
      s(`ip daddr 127.0.0.1 tcp dport ${localConsole.port} drop`) +
      (localWebhook.port ? s(`ip daddr 127.0.0.1 tcp dport ${localWebhook.port} drop`) : "") +
      // DNS over TCP to a local resolver would skip the proxy's (UDP 53 is DNAT'd to it above)
      s("tcp dport 53 drop") +
      s("ip daddr 127.0.0.0/8 accept") +
      s(`ip6 daddr ::1 tcp dport ${localConsole.port} drop`) +
      s("ip6 daddr ::1 accept") +
      (v4.length ? s(`ip daddr { ${v4.join(", ")} } accept`) : "") +
      (v6.length ? s(`ip6 daddr { ${v6.join(", ")} } accept`) : "") +
      s("drop"),
  );
}

export async function removeSessionRules(task: string): Promise<void> {
  if (off(`removeSessionRules ${task}`)) return;
  await deleteByComment(`hortus:${task}`);
}

/** Tap `n`: 10.77.<n/64+2>.<(n%64)*4+1>/30 on the host end, the VM at +1 (64 links per /24 in 10.77.2–5). */
export function tapAddresses(n: number): { tap: string; hostEnd: string; vmAddr: string } {
  const net = `10.77.${Math.floor(n / 64) + 2}`;
  const h = (n % 64) * 4 + 1;
  return { tap: `${names.tap}${n}`, hostEnd: `${net}.${h}`, vmAddr: `${net}.${h + 1}` };
}

/** Create tap `n` owned by `user` (QEMU opens it without capabilities), address its host end, up, rp_filter=1. */
export async function addTap(n: number, user: string): Promise<{ tap: string; hostEnd: string; vmAddr: string }> {
  const t = tapAddresses(n);
  if (off(`addTap ${t.tap}`)) return t;
  if (!(await ipJson(["link", "show", "dev", t.tap])))
    await run("ip", ["tuntap", "add", "dev", t.tap, "mode", "tap", "user", user]);
  if (!(await addresses(t.tap)).includes(t.hostEnd)) await run("ip", ["addr", "add", `${t.hostEnd}/30`, "dev", t.tap]);
  await run("ip", ["link", "set", t.tap, "up"]);
  await writeFile(`/proc/sys/net/ipv4/conf/${t.tap}/rp_filter`, "1");
  return t;
}

/** The VM on `tap` (source `vmAddr`) reaches the proxy's 80/443/53 (DNAT'd to `ports`) and nothing else on the host. */
export async function vmLinkRules(tap: string, vmAddr: string): Promise<void> {
  if (off(`vmLinkRules ${tap}`)) return;
  await deleteByComment(`hortus:${tap}`);
  const c = `comment ${quote(`hortus:${tap}`)}`;
  const r = (x: string) => `add rule ${T()} input iifname ${quote(tap)} ${x} ${c}\n`;
  const d = (x: string) => `add rule ${T()} pre iifname ${quote(tap)} ip saddr ${vmAddr} ip daddr ${PROXY} ${x} ${c}\n`;
  const p = ports;
  await nft(
    d(`tcp dport 80 dnat ip to ${PROXY}:${p.http}`) +
      d(`tcp dport 443 dnat ip to ${PROXY}:${p.https}`) +
      d(`udp dport 53 dnat ip to ${PROXY}:${p.dns}`) +
      r(`ip saddr ${vmAddr} ip daddr ${PROXY} tcp dport { ${p.http}, ${p.https} } accept`) +
      r(`ip saddr ${vmAddr} ip daddr ${PROXY} udp dport ${p.dns} accept`) +
      r("drop"),
  );
}

/** Rules and the tap itself. */
export async function removeVmLink(tap: string): Promise<void> {
  if (off(`removeVmLink ${tap}`)) return;
  await deleteByComment(`hortus:${tap}`);
  if (await ipJson(["link", "show", "dev", tap])) await run("ip", ["link", "del", "dev", tap]);
}

/** At start: drop the table (every `hortus:` rule with it) and recreate it, delete stale taps and session addresses. */
export async function flushStale(): Promise<void> {
  if (off("flushStale")) return;
  if ((await rules()) !== null) await run("nft", ["delete", "table", "inet", names.table]);
  await ensureTable();
  for (const l of (await ipJson(["link", "show"])) ?? [])
    if (l.ifname?.startsWith(names.tap)) await run("ip", ["link", "del", "dev", l.ifname]);
  for (const a of await addresses(names.iface)) if (a.startsWith("10.77.1.")) await delAddress(a);
}
