/**
 * Network layer, opt-in (HORTUS_TEST_NET=1, needs passwordless sudo): re-runs itself as a transient system unit with
 * hortusd's capabilities and Delegate=yes (as scripts/dev-run.sh), on a test table, dummy interface and tap prefix so
 * a running daemon's rules are never touched. Cleans up with sudo afterwards.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createSocket } from "node:dgram";
import { createServer, type Server } from "node:http";
import { userInfo } from "node:os";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { openDb } from "../db.ts";
import type { Role } from "../types.ts";
import * as cgroup from "./cgroup.ts";
import * as net from "./net.ts";
import * as sessionNet from "./session-net.ts";

const NAMES = { table: "hortus_test", iface: "hortustest0", tap: "hortustt" };
const enabled = process.env.HORTUS_TEST_NET === "1";
const inner = process.env.HORTUS_TEST_NET_INNER === "1";

if (!enabled) {
  test("network layer (set HORTUS_TEST_NET=1)", { skip: "HORTUS_TEST_NET unset" }, () => {});
} else if (!inner) {
  test("network layer inside a capability-bearing unit", () => {
    const env = [
      "HORTUS_TEST_NET=1",
      "HORTUS_TEST_NET_INNER=1",
      `PATH=${process.env.PATH}`,
      `HOME=${process.env.HOME}`,
    ];
    const r = spawnSync(
      "sudo",
      [
        "systemd-run",
        "--uid",
        String(process.getuid?.()),
        "--gid",
        String(process.getgid?.()),
        "-p",
        "AmbientCapabilities=CAP_NET_ADMIN CAP_NET_BIND_SERVICE",
        "-p",
        "CapabilityBoundingSet=CAP_NET_ADMIN CAP_NET_BIND_SERVICE",
        "-p",
        "Delegate=yes",
        "-p",
        "RuntimeMaxSec=90",
        "--pipe",
        "--wait",
        "--collect",
        "--quiet",
        "--same-dir",
        ...env.flatMap((e) => ["-E", e]),
        "--",
        process.execPath,
        "--test",
        "--test-timeout=30000",
        fileURLToPath(import.meta.url),
      ],
      { encoding: "utf8", timeout: 120_000 },
    );
    // Safety net: the inner run cleans up itself; this catches a crash.
    spawnSync("sudo", ["nft", "delete", "table", "inet", NAMES.table], { stdio: "ignore" });
    spawnSync("sudo", ["ip", "link", "del", NAMES.iface], { stdio: "ignore" });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /# fail 0/, r.stdout);
  });
} else {
  Object.assign(net.names, NAMES);
  const db = openDb(":memory:");
  const listeners = new Map<string, { http: Server; dns: ReturnType<typeof createSocket> }>();
  sessionNet.init({
    db,
    proxy: {
      // A stand-in proxy: HTTP "proxy <address>" on the http port, a DNS socket on the dns port answering
      // "dns <address>"; the session reaches them on :80 and :53 through the DNAT rules.
      async listen(a) {
        const http = createServer((_, res) => res.end(`proxy ${a}`));
        await new Promise<void>((r, j) => http.once("error", j).listen(net.ports.http, a, r));
        const dns = createSocket("udp4");
        dns.on("message", (_, from) => dns.send(`dns ${a}`, from.port, from.address));
        await new Promise<void>((r, j) => dns.once("error", j).bind(net.ports.dns, a, r));
        listeners.set(a, { http, dns });
      },
      async unlisten(a) {
        const l = listeners.get(a);
        l?.http.close();
        l?.dns.close();
        listeners.delete(a);
      },
    },
    links: {
      register: (address: string, role: Role, task: string, kind: string) =>
        db.prepare("INSERT INTO links VALUES (?, ?, ?, ?, ?)").run(address, role, task, kind, new Date().toISOString()),
      release: (address: string) => db.prepare("DELETE FROM links WHERE address = ?").run(address),
    },
  });

  /** Run `sh -c script` with the shell first moved into `cg`. */
  const inCgroup = (cg: string, script: string): Promise<{ code: number | null; out: string }> =>
    new Promise((resolve) => {
      const c = spawn("sh", ["-c", `echo $$ > "${cg}/cgroup.procs" && ${script}`], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      c.stdout.on("data", (d) => {
        out += d;
      });
      c.stderr.on("data", (d) => {
        out += d;
      });
      c.on("close", (code) => resolve({ code, out }));
    });
  const curl = (cg: string, url: string) => inCgroup(cg, `curl -sS --max-time 1 ${url}`);
  const ruleset = () => spawnSync("nft", ["list", "table", "inet", NAMES.table], { encoding: "utf8" }).stdout;

  let local: Server;
  let lan: Server; // stands in for a LAN host: reachable unless a rule drops it
  let console_: Server | undefined;
  before(async () => {
    await net.flushStale();
    await net.ensureDummy();
    local = createServer((_, res) => res.end("local"));
    await new Promise<void>((r) => local.listen(0, "127.0.0.1", r));
    console_ = createServer((_, res) => res.end("console"));
    await new Promise<void>((r, j) => console_?.once("error", j).listen(7700, "127.0.0.1", r)).catch(() => {
      console_ = undefined;
    });
  });
  after(async () => {
    local.close();
    lan.close();
    console_?.close();
    for (const id of ["S1", "S2"]) await sessionNet.close(id).catch(() => {});
    for (const id of ["S1", "S2", "X"]) await cgroup.kill(id);
    spawnSync("nft", ["delete", "table", "inet", NAMES.table]);
    spawnSync("ip", ["link", "del", NAMES.iface]);
  });

  test("ensureDummy and the table are idempotent", async () => {
    await net.ensureDummy();
    await net.ensureTable();
    assert.equal(ruleset().match(/ip daddr 10\.77\.1\.0\/24 drop/g)?.length, 1);
  });

  test("a session reaches its proxy, loopback and DNS (DNAT), nothing else", async () => {
    const s1 = await cgroup.create("S1");
    const other = await cgroup.create("X");
    lan = createServer((_, res) => res.end("lan"));
    await new Promise<void>((r) => lan.listen(0, net.PROXY, r));
    const lanUrl = `http://${net.PROXY}:${(lan.address() as { port: number }).port}/`;
    const a = await sessionNet.open("S1", "worker", s1, ["192.0.2.7/32", `${net.PROXY}/32`]);
    assert.equal(a, "10.77.1.2");
    assert.deepEqual(
      db
        .prepare("SELECT role, task_id, kind FROM links")
        .all()
        .map((r) => ({ ...r })),
      [{ role: "worker", task_id: "S1", kind: "session" }],
    );
    const s2 = await cgroup.create("S2");
    const b = await sessionNet.open("S2", "worker", s2, []);
    assert.equal(b, "10.77.1.3");

    assert.equal((await curl(s1, `http://${a}/`)).out, `proxy ${a}`, ":80 DNAT'd to the http port");
    const port = (local.address() as { port: number }).port;
    assert.equal((await curl(s1, `http://127.0.0.1:${port}/`)).out, "local");
    if (console_) assert.equal((await curl(s1, "http://127.0.0.1:7700/")).code, 28, "console: dropped, timed out");
    assert.equal((await curl(s1, `http://${b}/`)).code, 28, "another session's address");
    assert.equal((await curl(s1, lanUrl)).out, "lan", "in S1's chat.allow");
    assert.equal((await curl(s2, lanUrl)).code, 28, "not in S2's chat.allow");
    assert.equal((await curl(other, lanUrl)).out, "lan", "no rules for other cgroups");
    assert.notEqual((await curl(s1, "http://[2606:4700::1111]/")).code, 0, "IPv6");
    // DNS to anywhere lands on the session's own address.
    const dns = await inCgroup(
      s1,
      `${process.execPath} -e 's=require("dgram").createSocket("udp4");s.on("message",m=>{console.log(String(m));process.exit(0)});s.send("q",53,"1.1.1.1");setTimeout(()=>process.exit(3),1000)'`,
    );
    assert.equal(dns.out.trim(), `dns ${a}`);
    // Not a session: another cgroup cannot reach session addresses; the owner's loopback still works.
    assert.equal((await curl(other, `http://${a}/`)).code, 28);
    assert.equal((await curl(other, `http://127.0.0.1:${port}/`)).out, "local");
  });

  test("close removes rules, address and listener; flushStale clears what is left", async () => {
    await sessionNet.close("S1");
    assert.ok(!ruleset().includes("hortus:S1"));
    assert.ok(ruleset().includes("hortus:S2"));
    const addrs = spawnSync("ip", ["-j", "addr", "show", "dev", NAMES.iface], { encoding: "utf8" }).stdout;
    assert.ok(!addrs.includes("10.77.1.2") && addrs.includes("10.77.1.3"));
    assert.ok(!listeners.has("10.77.1.2"));
    await sessionNet.close("S1"); // twice is fine
    await net.flushStale();
    assert.ok(!ruleset().includes("hortus:"));
    assert.ok(
      !spawnSync("ip", ["-j", "addr", "show", "dev", NAMES.iface], { encoding: "utf8" }).stdout.includes("10.77.1.3"),
    );
    await sessionNet.close("S2");
  });

  test("tap: created for the owner, link rules by comment, removed", async () => {
    const t = await net.addTap(200, userInfo().username);
    assert.deepEqual(t, { tap: "hortustt200", hostEnd: "10.77.5.33", vmAddr: "10.77.5.34" });
    await net.addTap(200, userInfo().username);
    await net.vmLinkRules(t.tap, t.vmAddr);
    await net.vmLinkRules(t.tap, t.vmAddr);
    assert.equal(ruleset().match(/hortus:hortustt200/g)?.length, 6);
    assert.match(ruleset(), /tcp dport 443 dnat ip to 10\.77\.0\.1:8443/);
    await net.removeVmLink(t.tap);
    assert.ok(!ruleset().includes("hortus:hortustt200"));
    assert.equal(spawnSync("ip", ["link", "show", "dev", t.tap]).status, 1);
  });
}
