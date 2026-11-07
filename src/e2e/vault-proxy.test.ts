/**
 * The Secret Vault and proxy: the connector syncs through the
 * pipeline as role core with placeholders only; a client at a session address is refused a raw token, and a
 * placeholder request waits for the owner's decision on the console, passes once, then waits again.
 *
 * Loopback (default suite): the real daemon under HORTUS_NO_NET=1, the proxy on 127.0.0.1, the "session address" a
 * loopback alias registered with `dev.link`. Real network (HORTUS_TEST_NET=1, passwordless sudo): the daemon as a
 * transient unit with its capabilities (scripts/dev-run.sh), hortus0, 10.77.1.9 wired by `dev.link` (address,
 * listeners, links row, cgroup rules), curl moved into that cgroup reaching :443 through the DNAT.
 */
import assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn, spawnSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { openDb } from "../db.ts";
import * as paths from "../paths.ts";
import { rpcClient } from "../rpc.ts";
import { FakeSlack } from "../test/fakes/slack.ts";
import { freePort, stopped, tempDir, until } from "../test/until.ts";

const NET = process.env.HORTUS_TEST_NET === "1";
const UNIT = "hortusd-vault-proxy-test";
const TASK = "T2";
const bin = (name: string) => new URL(`../bin/${name}.js`, import.meta.url).pathname;

interface Reply {
  status: number;
  body: string;
}

const run = (cmd: string, args: string[]): Promise<Reply> =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, { encoding: "utf8" }, (e, out, err) => {
      if (e && !out) return reject(new Error(`${cmd} failed: ${err || e.message}`));
      const i = out.lastIndexOf("\n");
      resolve({ status: Number(out.slice(i + 1)), body: out.slice(0, i) });
    }),
  );

let home: string;
let fake: FakeSlack;
let consolePort: number;
let daemon: ChildProcess | undefined;
/** curl -H "Authorization: Bearer <token>" https://slack.com/api/auth.test from the session address */
let curl: (token: string) => Promise<Reply>;

const cleanupNet = () => {
  spawnSync("sudo", ["systemctl", "stop", UNIT], { stdio: "ignore" });
  spawnSync("sudo", ["nft", "delete", "table", "inet", "hortus"], { stdio: "ignore" });
  spawnSync("sudo", ["ip", "link", "del", "hortus0"], { stdio: "ignore" });
};

before(async () => {
  home = tempDir("hortus-vault-proxy-");
  process.env.HORTUS_HOME = home;
  fake = await FakeSlack.start();
  fake.user("U1", "alice");
  fake.channel("C1", { name: "general", members: ["U1", fake.botUser] });
  consolePort = await freePort();
  const proxy = NET ? {} : { https: await freePort(), http: await freePort(), dns: 0 };
  writeFileSync(
    join(home, "hortusd.json"),
    JSON.stringify({
      owner: { tz: "UTC" },
      dofs: { slack: { type: "slack", owner: "U1" } },
      dev: { upstreams: { "slack.com": fake.url } },
      proxy,
    }),
  );
  writeFileSync(join(home, "vault.json"), JSON.stringify(fake.vault("slack")), { mode: 0o600 });
  const env = { HORTUS_HOME: home, HORTUS_CONSOLE_PORT: String(consolePort) };
  if (NET) {
    cleanupNet();
    const r = spawnSync(
      "sudo",
      [
        "systemd-run",
        "--unit",
        UNIT,
        "--collect",
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
        "KillMode=mixed",
        "-p",
        "RuntimeMaxSec=120",
        ...Object.entries({ ...env, HOME: process.env.HOME, PATH: process.env.PATH }).flatMap(([k, v]) => [
          "-E",
          `${k}=${v}`,
        ]),
        process.execPath,
        "--no-warnings",
        bin("hortusd"),
      ],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 0, r.stderr);
  } else {
    daemon = spawn(process.execPath, ["--no-warnings", bin("hortusd")], {
      env: { ...process.env, ...env, HORTUS_NO_NET: "1" },
      stdio: ["ignore", "ignore", "inherit"],
    });
  }
  // the console starts last: once it answers, every module is up (ping answers before modules start)
  await until(
    () =>
      fetch(`http://127.0.0.1:${consolePort}/approvals`).then(
        (r) => r.ok,
        () => false,
      ),
    15_000,
    "the console",
  );
  // the address belongs to a task row (the pipeline refuses an unknown task)
  const db = openDb(paths.db());
  db.prepare("INSERT INTO tasks(id, kind, title, status, created) VALUES (?, 'chat', 'vault-proxy', 'running', ?)").run(
    TASK,
    new Date().toISOString(),
  );
  db.close();
  const rpc = rpcClient(paths.socket());
  const address = NET ? "10.77.1.9" : "127.0.0.2";
  const link = (await rpc.call("dev.link", { address, role: "worker", task: TASK })) as { cgroup: string | null };
  rpc.close();
  const ca = join(home, "ca", "ca.crt");
  const args = (token: string, port: number, to: string) => [
    "-sS",
    "--max-time",
    "5",
    "--interface",
    address,
    "--resolve",
    `slack.com:${port}:${to}`,
    "--cacert",
    ca,
    "-H",
    `Authorization: Bearer ${token}`,
    "-w",
    "\n%{http_code}",
    `https://slack.com:${port}/api/auth.test`,
  ];
  curl = NET
    ? // root only to move itself into the session's cgroup; the rules match the cgroup, not the user
      (token) =>
        run("sudo", [
          "sh",
          "-c",
          `echo $$ > "${link.cgroup}/cgroup.procs" && exec "$0" "$@"`,
          "curl",
          ...args(token, 443, address),
        ])
    : (token) => run("curl", args(token, (proxy as { https: number }).https, "127.0.0.1"));
});

after(async () => {
  if (NET) cleanupNet();
  else if (daemon) {
    await stopped(daemon);
  }
  await fake.close();
  rmSync(home, { recursive: true, force: true });
});

const consoleReq = (path: string, body?: unknown) =>
  fetch(`http://127.0.0.1:${consolePort}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "X-Hortus": "1", "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const authTests = () => fake.calls.filter((c) => c.method === "auth.test").length;

test(`vault and proxy (${NET ? "hortus0, 10.77.1.9:443 via DNAT" : "loopback"}): placeholders in, approvals on the console`, async () => {
  // (a) the connector syncs through the pipeline: the fake saw only real tokens, never a placeholder
  await until(() => existsSync(join(paths.dof("slack"), "C1", "channel.md")), 15_000, "channel.md");
  assert.ok(fake.auths.length > 0);
  assert.ok(
    fake.auths.every((a) => a === `Bearer ${fake.botToken}` || a === `Bearer ${fake.appToken}`),
    String(fake.auths),
  );
  const rpc = rpcClient(paths.socket());
  const creds = (await rpc.call("credential.list", {})) as { name: string; last_use: string | null }[];
  rpc.close();
  assert.ok(creds.find((c) => c.name === "slack")?.last_use, "the pipeline resolved the slack credential");

  // (b) a raw token from the session address: refused, never forwarded
  const before = authTests();
  const raw = await curl(fake.botToken);
  assert.equal(raw.status, 403, raw.body);
  assert.match(raw.body, /raw credential/);
  assert.equal(authTests(), before);

  // (c) a placeholder: pending until the owner approves on the console, then one pass
  const first = await curl("hortus-secret-slack");
  assert.equal(first.status, 403, first.body);
  const pending = JSON.parse(first.body) as { approval: number; category: string; url: string };
  assert.equal(pending.category, "credential:slack");
  assert.equal(pending.url, `http://127.0.0.1:${consolePort}/approvals/${pending.approval}`);
  assert.equal(authTests(), before);

  // (d) the Approvals page gets the entry with where it goes, pending
  const list = (await (await consoleReq("/api/approval.list", {})).json()) as {
    result: { id: number; category: string; status: string; summary: { host: string; path: string } }[];
  };
  const entry = list.result.find((a) => a.id === pending.approval);
  assert.deepEqual(
    [entry?.category, entry?.status, entry?.summary.host, entry?.summary.path],
    ["credential:slack", "pending", "slack.com", "/api/auth.test"],
  );

  const decided = await consoleReq("/api/approval.decide", { id: pending.approval, decision: "approve" });
  assert.equal(decided.status, 200, await decided.clone().text());
  assert.deepEqual(await decided.json(), { result: { ok: true } });

  const second = await curl("hortus-secret-slack");
  assert.equal(second.status, 200, second.body);
  assert.equal((JSON.parse(second.body) as { ok: boolean; user_id: string }).user_id, fake.botUser);
  assert.equal(authTests(), before + 1);
  assert.equal(fake.auths.at(-1), `Bearer ${fake.botToken}`);

  const third = await curl("hortus-secret-slack");
  assert.equal(third.status, 403, "single use");
  const again = JSON.parse(third.body) as { approval: number };
  assert.notEqual(again.approval, pending.approval);
  assert.equal(authTests(), before + 1);

  // "Approved by you", and no buttons: it is no longer pending
  const after = (await (await consoleReq("/api/approval.get", { id: pending.approval })).json()) as {
    result: { status: string; decided_by: string; decided_at: string | null };
  };
  assert.notEqual(after.result.status, "pending");
  assert.equal(after.result.decided_by, "owner");
  assert.ok(after.result.decided_at);
});
