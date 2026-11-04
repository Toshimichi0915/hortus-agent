/**
 * Worker VMs under failure (13-worker-vm.md), the real daemon and the real image (HORTUS_TEST_VM=1; the image in
 * `$HORTUS_TEST_IMAGES`, /dev/kvm). Without HORTUS_TEST_NET the daemon runs under HORTUS_NO_NET=1 in a delegated user
 * scope (VMs on `-netdev user`: the fake provider plugin answers inside the guest, the Worker's `done` is an outbox
 * file): SIGKILL during a VM start and during a run, the hours deadline across a restart, `vm.max_concurrent` and a
 * kernel that does not boot. With HORTUS_TEST_NET=1 (passwordless sudo) the daemon is a capability-bearing system unit
 * (scripts/dev-run.sh's properties) and VMs get taps: `planner.runtime: "vm"` end to end, and taps/rules after a kill.
 * The guest runs the image's own copy of hortus-agent (`npm pack` at `hortus image build`), not this tree's dist.
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { openDb } from "../db.ts";
import * as paths from "../paths.ts";
import { FakeSlack } from "../test/fakes/slack.ts";
import { freePort, tempDir, until } from "../test/until.ts";

const ENABLED = process.env.HORTUS_TEST_VM === "1";
const NET = process.env.HORTUS_TEST_NET === "1";
const IMAGES = process.env.HORTUS_TEST_IMAGES ?? "";
const bin = (name: string) => new URL(`../bin/${name}.js`, import.meta.url).pathname;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Inside the guest: plays `/task/out/fake-script.json` turn by turn and records requests to
 * `/task/out/fake-requests.jsonl`. Without a script: a Planner batch creates one task from its first event, a Worker
 * is done at once.
 */
const FAKE = `
import { appendFileSync, existsSync, readFileSync } from "node:fs";
const dir = "/task/out/";
const complete = async (req) => {
  const reqs = dir + "fake-requests.jsonl";
  const prior = existsSync(reqs) ? readFileSync(reqs, "utf8").split("\\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const n = prior.filter((r) => r.tools.length).length;
  appendFileSync(reqs, JSON.stringify({ messages: req.messages, tools: req.tools.map((t) => t.name) }) + "\\n");
  const usage = { input: 10, output: 5, cached: 0 };
  if (!req.tools.length) return { role: "assistant", text: "notes from fake", toolCalls: [], usage };
  let t;
  if (existsSync(dir + "fake-script.json")) t = JSON.parse(readFileSync(dir + "fake-script.json", "utf8"))[n];
  else if (req.tools.some((x) => x.name === "task_create")) {
    const e = /- \\[(e\\d+)\\]/.exec(req.messages[0].content)?.[1];
    t = n === 0 && e ? { calls: [{ name: "task_create", input: { title: "from the planner", brief: "b", event_ids: [e] } }] } : { text: "ok" };
  } else t = n === 0 ? { calls: [{ name: "done", input: { summary: "planned work done" } }] } : undefined;
  t ??= { text: "idle" };
  return { role: "assistant", text: t.text ?? "", usage,
    toolCalls: (t.calls ?? []).map((c, i) => ({ id: "c" + n + "_" + i, name: c.name, input: c.input })) };
};
export default { providers: { fake: { create: () => ({ complete, listModels: async () => ["m"] }) } } };
`;

let home: string;
let fake: string;
let port: number;
let daemon: ChildProcess | undefined;
let unit = "";
let n = 0;
const units: string[] = [];

/** user scope (NO_NET) or system unit (NET); resolves once every module started */
async function startDaemon(): Promise<void> {
  unit = `hortusd-vmtest-${process.pid}-${++n}`;
  units.push(unit);
  const logFile = join(fake, "hortusd.log");
  const mark = existsSync(logFile) ? readFileSync(logFile, "utf8").length : 0;
  const env = { HORTUS_HOME: home, HORTUS_CONSOLE_PORT: String(port) };
  if (NET) {
    const r = spawnSync(
      "sudo",
      [
        "systemd-run",
        ...["--unit", unit, "--uid", String(process.getuid?.()), "--gid", String(process.getgid?.())],
        ...["-p", "AmbientCapabilities=CAP_NET_ADMIN CAP_NET_BIND_SERVICE"],
        ...["-p", "CapabilityBoundingSet=CAP_NET_ADMIN CAP_NET_BIND_SERVICE"],
        ...["-p", "SupplementaryGroups=kvm", "-p", "Delegate=yes", "-p", "KillMode=mixed"],
        ...["-p", `StandardError=append:${logFile}`, "-p", "StandardOutput=null"],
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
    daemon = spawn(
      "systemd-run",
      [
        "--user",
        "--scope",
        "-q",
        "--unit",
        unit,
        "-p",
        "Delegate=yes",
        "--",
        process.execPath,
        "--no-warnings",
        bin("hortusd"),
      ],
      { env: { ...process.env, ...env, HORTUS_NO_NET: "1" }, stdio: ["ignore", "ignore", "pipe"] },
    );
    daemon.stderr?.pipe(createWriteStream(logFile, { flags: "a" }));
  }
  await until(
    () => existsSync(logFile) && readFileSync(logFile, "utf8").slice(mark).includes('"msg":"started"'),
    30_000,
    "hortusd started",
  );
}

/** SIGKILL hortusd alone (NO_NET: its QEMU and virtiofsds stay behind in the old scope; NET: systemd's KillMode=mixed
 * kills the rest of the unit, as in production) */
async function killDaemon(): Promise<void> {
  if (NET) {
    spawnSync("sudo", ["systemctl", "kill", "--kill-whom=main", "-s", "KILL", unit]);
    await until(() => spawnSync("systemctl", ["is-active", "-q", unit]).status !== 0, 15_000, "unit gone");
    spawnSync("sudo", ["systemctl", "reset-failed", unit], { stdio: "ignore" });
    return;
  }
  const d = daemon;
  if (!d || d.exitCode !== null || d.signalCode !== null) return;
  d.kill("SIGKILL");
  await new Promise((r) => d.once("exit", r));
}

async function stopDaemon(): Promise<void> {
  if (NET) {
    spawnSync("sudo", ["systemctl", "stop", unit], { stdio: "ignore" });
    spawnSync("sudo", ["systemctl", "reset-failed", unit], { stdio: "ignore" });
    return;
  }
  const d = daemon;
  if (!d || d.exitCode !== null || d.signalCode !== null) return;
  d.kill("SIGTERM");
  await new Promise((r) => d.once("exit", r));
}

const db = <T>(f: (d: ReturnType<typeof openDb>) => T): T => {
  const d = openDb(paths.db());
  try {
    return f(d);
  } finally {
    d.close();
  }
};
interface Row {
  id: string;
  status: string;
  error: string | null;
  hours: number;
  runtime: string;
}
const row = (id: string) => db((d) => d.prepare("SELECT * FROM tasks WHERE id = ?").get(id)) as Row | undefined;

/** a queued VM task with `script` (the fake's turns); the tick starts it within a second */
function vmTask(script: unknown[], hours = 1): string {
  const id = `vmt${Date.now().toString(36)}${++n}`;
  mkdirSync(join(paths.out(id), "work"), { recursive: true });
  mkdirSync(join(paths.ctl(id), "inbox"), { recursive: true });
  writeFileSync(join(paths.out(id), "fake-script.json"), JSON.stringify(script));
  const t = new Date().toISOString();
  db((d) =>
    d
      .prepare(
        `INSERT INTO tasks(id, kind, title, brief, status, scope, budget, usage, runtime, event_keys, created, updated,
          hours) VALUES (?, 'unattended', ?, 'b', 'queued', ?, ?, '{"tokens":0}', 'vm', '[]', ?, ?, 0)`,
      )
      .run(id, id, JSON.stringify({ credentials: [], repos: [] }), JSON.stringify({ tokens: 1e6, hours }), t, t),
  );
  return id;
}
const requests = (id: string): { messages: { role: string; results?: { output: string }[] }[] }[] => {
  const p = join(paths.out(id), "fake-requests.jsonl");
  return existsSync(p)
    ? readFileSync(p, "utf8")
        .split("\n")
        .filter(Boolean)
        .flatMap((l) => {
          try {
            return [JSON.parse(l)];
          } catch {
            return [];
          }
        })
    : [];
};
const outbox = (id: string): { type: string; text: string }[] => {
  const d = join(paths.out(id), "outbox");
  return existsSync(d)
    ? readdirSync(d)
        .sort()
        .map((f) => JSON.parse(readFileSync(join(d, f), "utf8")))
    : [];
};

/** live QEMU / virtiofsd processes naming this HORTUS_HOME */
function vmProcs(): { pid: number; exe: string }[] {
  const out: { pid: number; exe: string }[] = [];
  for (const p of readdirSync("/proc")) {
    if (!/^\d+$/.test(p)) continue;
    try {
      const argv = readFileSync(`/proc/${p}/cmdline`, "utf8").split("\0");
      const stat = readFileSync(`/proc/${p}/stat`, "utf8");
      if (/\) [ZX] /.test(stat)) continue;
      if (/(qemu-system|virtiofsd)/.test(argv[0] ?? "") && argv.some((a) => a.includes(`${home}/tasks/`)))
        out.push({ pid: Number(p), exe: argv[0] ?? "" });
    } catch {}
  }
  return out;
}
const qemus = () => vmProcs().filter((p) => p.exe.includes("qemu"));
const alive = (pid: number) => {
  try {
    return !/\) [ZX] /.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return false;
  }
};
const logText = () => readFileSync(join(fake, "hortusd.log"), "utf8");
const t0 = Date.now();
const mark = (what: string) => console.log(`# [${((Date.now() - t0) / 1000).toFixed(1)} s] ${what}`);

let slack: FakeSlack | undefined;

before(async () => {
  if (!ENABLED) return;
  home = tempDir("hortus-vmtest-");
  fake = tempDir("hortus-vmtestfake-");
  process.env.HORTUS_HOME = home;
  // the image trusts the CA it was built with
  cpSync(join(IMAGES, "..", "ca"), join(home, "ca"), { recursive: true });
  mkdirSync(join(home, "images"));
  for (const f of ["agent.ext4", "initramfs.img", "vmlinuz"]) symlinkSync(join(IMAGES, f), join(home, "images", f));
  mkdirSync(join(fake, "plugins", "fake"), { recursive: true });
  writeFileSync(
    join(fake, "plugins", "fake", "hortus.json"),
    JSON.stringify({ name: "fake", version: "1.0.0", entrypoint: "fake.mjs" }),
  );
  writeFileSync(join(fake, "plugins", "fake", "fake.mjs"), FAKE);
  port = await freePort();
  const config: Record<string, unknown> = {
    owner: { tz: "UTC" },
    worker: { provider: "fake", model: "m", plugins: [join(fake, "plugins", "fake")] },
    // boot to the guest's hortus-agent takes a few seconds; 30 s keeps the hung-kernel test short
    vm: { cpus: 1, mem_mb: 1024, max_concurrent: 1, boot_timeout_s: 30 },
  };
  const vault: Record<string, unknown> = { fake: { type: "token", value: "x", transform: "fake" } };
  if (NET) {
    slack = await FakeSlack.start();
    slack.user("U1", "alice");
    slack.channel("D1", { is_im: true, user: "U1", members: [slack.botUser, "U1"], name: "" });
    Object.assign(config, {
      dofs: { slack: { type: "slack", owner: "U1" } },
      dev: { upstreams: { "slack.com": slack.url } },
      planner: { provider: "fake", model: "m", runtime: "vm" },
    });
    Object.assign(vault, slack.vault("slack"));
  } else config.proxy = { https: 0, http: 0, dns: 0 };
  writeFileSync(join(home, "hortusd.json"), JSON.stringify(config));
  writeFileSync(join(home, "vault.json"), JSON.stringify(vault), { mode: 0o600 });
  await startDaemon();
});

after(async () => {
  if (!ENABLED) return;
  await stopDaemon();
  for (const u of units)
    if (NET) spawnSync("sudo", ["systemctl", "stop", u], { stdio: "ignore" });
    else spawnSync("systemctl", ["--user", "stop", `${u}.scope`], { stdio: "ignore" });
  for (const p of vmProcs()) spawnSync("kill", ["-9", String(p.pid)]);
  if (NET) {
    spawnSync("sudo", ["nft", "delete", "table", "inet", "hortus"], { stdio: "ignore" });
    spawnSync("sudo", ["ip", "link", "del", "hortus0"], { stdio: "ignore" });
  }
  await slack?.close();
  if (process.env.KEEP) console.log(`# kept ${fake}`);
});

const skip = !ENABLED ? "HORTUS_TEST_VM unset" : !IMAGES ? "HORTUS_TEST_IMAGES unset" : false;
const offline = skip || (NET && "the NO_NET tests (run without HORTUS_TEST_NET)");
const online = skip || (!NET && "HORTUS_TEST_NET unset");

test("SIGKILL during a VM start: the orphans are reaped at restart, the task boots again and finishes", {
  skip: offline,
}, async () => {
  const id = vmTask([{ calls: [{ name: "done", input: { summary: "after the crash" } }] }]);
  await until(() => qemus().length > 0, 20_000, "QEMU spawned");
  const old = vmProcs();
  mark(`killing hortusd with ${old.map((p) => p.exe.split("/").at(-1)).join(", ")} up`);
  await killDaemon();
  assert.ok(
    old.every((p) => alive(p.pid)),
    "the VM outlives hortusd",
  );
  await startDaemon();
  assert.deepEqual(
    old.filter((p) => alive(p.pid)),
    [],
    "orphans killed during recovery",
  );
  assert.match(logText(), /killed orphaned task processes/);
  await until(() => outbox(id).some((m) => m.type === "result"), 120_000, "the task's result");
  mark("finished after the restart");
  await until(() => row(id)?.status === "waiting", 20_000, "waiting");
  await until(() => vmProcs().length === 0, 10_000, "no VM processes");
});

test("SIGKILL during a run: the task resumes on the same out/ (the dangling tool call closed), nothing left over", {
  skip: offline,
}, async () => {
  const id = vmTask([
    { calls: [{ name: "bash", input: { command: "echo one > /task/out/work/first; sleep 30; echo slept" } }] },
    { calls: [{ name: "bash", input: { command: "cat /task/out/work/first" } }] },
    { calls: [{ name: "done", input: { summary: "resumed" } }] },
  ]);
  await until(() => existsSync(join(paths.out(id), "work", "first")), 120_000, "the first tool ran");
  const old = vmProcs();
  mark("killing hortusd mid-run");
  await killDaemon();
  await startDaemon();
  assert.deepEqual(
    old.filter((p) => alive(p.pid)),
    [],
    "orphans killed",
  );
  await until(() => outbox(id).some((m) => m.type === "result"), 150_000, "the task's result");
  mark("resumed and finished");
  const r = requests(id);
  const results = r.flatMap((q) => q.messages.flatMap((m) => m.results ?? []).map((x) => x.output));
  assert.ok(results.includes("interrupted by restart"), JSON.stringify(results));
  assert.ok(
    results.some((x) => x.includes("one")),
    "out/work survived",
  );
  assert.ok(!results.some((x) => x.includes("slept")), "the killed VM's tool never finished");
  assert.deepEqual(outbox(id).at(-1), { ...outbox(id).at(-1), type: "result", text: "resumed" });
  await until(() => vmProcs().length === 0, 10_000, "no VM processes");
  await until(() => !existsSync(join(paths.task(id), "vfs")), 5000, "the sockets directory gone");
});

test("the hours deadline across a restart: the VM gets what is left, not the whole budget again", {
  skip: offline,
}, async () => {
  const budget = 100; // seconds
  const id = vmTask(
    // the resumed session gets the second turn: the same long tool again
    [1, 2].map(() => ({ calls: [{ name: "bash", input: { command: "touch /task/out/work/go; sleep 600" } }] })),
    budget / 3600,
  );
  await until(() => existsSync(join(paths.out(id), "work", "go")), 120_000, "the tool started");
  await sleep(45_000);
  const before = row(id)?.hours ?? 0;
  mark(`killing hortusd after ${(before * 3600).toFixed(0)} s on the task (persisted)`);
  assert.ok(before * 3600 > 30, `hours persisted while running: ${before}`);
  await killDaemon();
  const t = Date.now();
  await startDaemon();
  await until(() => row(id)?.error?.startsWith("budget_exceeded"), 120_000, "budget_exceeded");
  const secs = (Date.now() - t) / 1000;
  mark(`budget_exceeded ${secs.toFixed(1)} s after the restart: ${row(id)?.error}`);
  assert.ok(secs < budget - 25, `the deadline was the whole budget again (${secs} s)`);
  assert.equal(row(id)?.status, "waiting");
  await until(() => vmProcs().length === 0, 10_000, "no VM processes");
});

test("vm.max_concurrent: 1 with three queued VM tasks: one QEMU at a time, all three finish", {
  skip: offline,
}, async () => {
  const ids = [1, 2, 3].map((i) =>
    vmTask([
      { calls: [{ name: "bash", input: { command: "sleep 2" } }] },
      { calls: [{ name: "done", input: { summary: `vm ${i}` } }] },
    ]),
  );
  let most = 0;
  const t = Date.now();
  await until(
    () => {
      most = Math.max(most, qemus().length);
      return ids.every((id) => outbox(id).some((m) => m.type === "result"));
    },
    300_000,
    "three results",
  );
  mark(`three VM tasks in ${((Date.now() - t) / 1000).toFixed(1)} s, at most ${most} QEMU at once`);
  assert.equal(most, 1);
});

test("a kernel that does not boot: the task waits with QEMU's error and is not restarted", {
  skip: offline,
}, async () => {
  const k = join(home, "images", "vmlinuz");
  rmSync(k);
  writeFileSync(k, "not a kernel\n".repeat(100));
  try {
    const id = vmTask([{ text: "never" }]);
    await until(() => row(id)?.status === "waiting", 60_000, "waiting");
    const err = row(id)?.error ?? "";
    mark(`no kernel: ${err.slice(0, 200)}`);
    assert.match(err, /^qemu: .*kernel/m);
    assert.doesNotMatch(err, /virtiofsd/, "QEMU's error, not virtiofsd's chatter");
    const starts = () =>
      logText()
        .split("\n")
        .filter((l) => l.includes('"msg":"starting"') && l.includes(id)).length;
    assert.equal(starts(), 1);
    await sleep(5000);
    assert.equal(starts(), 1, "not restarted");
    assert.equal(row(id)?.status, "waiting");
  } finally {
    rmSync(k);
    symlinkSync(join(IMAGES, "vmlinuz"), k);
  }
});

test("a kernel that loads and hangs (no initramfs: it panics with panic=0): boot timeout, the task waits, not restarted", {
  skip: offline,
}, async () => {
  const i = join(home, "images", "initramfs.img");
  rmSync(i);
  writeFileSync(i, "not an initramfs\n".repeat(100));
  try {
    const id = vmTask([{ text: "never" }]);
    const t = Date.now();
    await until(() => row(id)?.status === "waiting", 90_000, "waiting");
    const secs = (Date.now() - t) / 1000;
    const err = row(id)?.error ?? "";
    mark(`hung kernel: waiting after ${secs.toFixed(1)} s: ${err.slice(0, 300).replaceAll("\n", " | ")}`);
    assert.match(err, /^boot timeout: no contact from the guest within 30 s/);
    assert.match(err, /Kernel panic|Linux version/, "the console.log tail follows");
    assert.ok(secs >= 25 && secs < 60, `${secs} s`);
    await until(() => qemus().length === 0, 10_000, "QEMU gone");
    const starts = () =>
      logText()
        .split("\n")
        .filter((l) => l.includes('"msg":"starting"') && l.includes(id)).length;
    await sleep(3000);
    assert.equal(starts(), 1, "not restarted");
    assert.equal(row(id)?.status, "waiting");
  } finally {
    rmSync(i);
    symlinkSync(join(IMAGES, "initramfs.img"), i);
  }
});

const nftComments = (): string[] => {
  const r = spawnSync("sudo", ["nft", "-j", "list", "table", "inet", "hortus"], { encoding: "utf8" });
  if (r.status !== 0) return [];
  return (JSON.parse(r.stdout).nftables as { rule?: { comment?: string } }[]).flatMap((e) =>
    e.rule?.comment ? [e.rule.comment] : [],
  );
};
const taps = () =>
  (JSON.parse(spawnSync("ip", ["-j", "link", "show"], { encoding: "utf8" }).stdout) as { ifname: string }[])
    .map((l) => l.ifname)
    .filter((n) => n.startsWith("hortus-t"));

test("planner.runtime vm: an owner DM → a Planner batch in a VM → task_create → the Worker VM finishes", {
  skip: online,
}, async () => {
  const s = slack as FakeSlack;
  const t = Date.now();
  s.post("D1", { user: "U1", text: "please do the vm thing" });
  const created = await until(
    () =>
      db((d) => d.prepare("SELECT id FROM tasks WHERE title = 'from the planner'").get()) as { id: string } | undefined,
    180_000,
    "the Planner's task_create",
  );
  mark(`Planner VM created ${created.id} after ${((Date.now() - t) / 1000).toFixed(1)} s`);
  assert.equal(row(created.id)?.runtime, "vm");
  await until(() => outbox(created.id).some((m) => m.type === "result"), 180_000, "the Worker's result");
  assert.equal(outbox(created.id).at(-1)?.text, "planned work done");
  mark(`Worker VM done after ${((Date.now() - t) / 1000).toFixed(1)} s`);
  await until(
    () => taps().length === 0 && !nftComments().some((c) => c.startsWith("hortus:hortus-t")),
    20_000,
    "taps gone",
  );
  const planners = db((d) => d.prepare("SELECT id FROM tasks WHERE kind = 'planner'").all());
  assert.deepEqual(planners, [], "the batch row is transient");
});

test("SIGKILL with a VM on a tap: the restart flushes the tap and its rules, the task resumes and cleans up", {
  skip: online,
}, async () => {
  // the previous test's Worker result wakes a second batch (a Planner VM takes a slot but never waits for one)
  await until(
    () =>
      logText().split('"msg":"planner batch ended"').length > 2 &&
      taps().length === 0 &&
      !db((d) => d.prepare("SELECT 1 FROM tasks WHERE kind = 'planner'").get()),
    60_000,
    "the result's Planner batch",
  );
  const id = vmTask([
    { calls: [{ name: "bash", input: { command: "touch /task/out/work/go; sleep 20" } }] },
    { calls: [{ name: "done", input: { summary: "net resumed" } }] },
  ]);
  await until(() => existsSync(join(paths.out(id), "work", "go")), 120_000, "the tool started");
  const tap = taps();
  assert.equal(tap.length, 1, String(tap));
  assert.ok(nftComments().includes(`hortus:${tap[0]}`));
  await killDaemon();
  assert.equal(qemus().length, 0, "KillMode=mixed took the VM with hortusd");
  await startDaemon();
  // flushStale ran: the old tap and rules are gone, or the resumed VM reuses the index
  for (const c of nftComments().filter((x) => x.startsWith("hortus:hortus-t"))) assert.ok(taps().includes(c.slice(7)));
  await until(() => outbox(id).some((m) => m.type === "result"), 150_000, "the task's result");
  await until(
    () => taps().length === 0 && !nftComments().some((c) => c.startsWith("hortus:hortus-t")),
    20_000,
    "taps gone",
  );
  // released after the tap (cleanup order)
  await until(() => !db((d) => d.prepare("SELECT 1 FROM links WHERE kind = 'vm'").get()), 10_000, "links row released");
});
