/**
 * Worker VMs under failure, the real daemon and the real image (HORTUS_TEST_VM=1; the image in
 * `$HORTUS_TEST_IMAGES`, /dev/kvm). Without HORTUS_TEST_NET the daemon runs under HORTUS_NO_NET=1 in a delegated user
 * scope (VMs on `-netdev user`: the fake provider plugin answers inside the guest, the Worker's `done` is an outbox
 * file): SIGKILL during a VM start and during a run, the hours deadline across a restart, `vm.max_concurrent`, a kernel
 * that does not boot, and a guest that crashes (panic, Worker, QEMU, virtiofsd) or hangs. With HORTUS_TEST_NET=1 (passwordless sudo) the daemon is a capability-bearing system unit
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
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { openDb } from "../db.ts";
import * as paths from "../paths.ts";
import { FakeSlack } from "../test/fakes/slack.ts";
import { freePort, stopped, tempDir, until } from "../test/until.ts";

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
  await stopped(d);
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
function vmTask(script: unknown[], hours = 1, project?: string, id = `vmt${Date.now().toString(36)}${++n}`): string {
  mkdirSync(join(paths.out(id), "work"), { recursive: true });
  mkdirSync(join(paths.ctl(id), "inbox"), { recursive: true });
  writeFileSync(join(paths.out(id), "fake-script.json"), JSON.stringify(script));
  const t = new Date().toISOString();
  db((d) =>
    d
      .prepare(
        `INSERT INTO tasks(id, kind, title, brief, status, scope, budget, usage, project, runtime, event_keys, created,
          updated, hours) VALUES (?, 'unattended', ?, 'b', 'queued', ?, ?, '{"tokens":0}', ?, 'vm', '[]', ?, ?, 0)`,
      )
      .run(
        id,
        id,
        JSON.stringify({ credentials: [], repos: [], ...(project && { project }) }),
        JSON.stringify({ usd: 1000, hours }),
        project ?? null,
        t,
        t,
      ),
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

/**
 * The Worker is uid `agent` and cannot reach /proc/sysrq-trigger, so a real panic needs root in the guest: a copy of the
 * image with a root service that panics the kernel when `out/work/panic` appears (debugfs, no sudo; QEMU's -snapshot
 * leaves the copy as it is).
 */
function crashImage(): void {
  const img = join(fake, "agent.ext4");
  const unit = join(fake, "crash.service");
  writeFileSync(
    unit,
    `[Service]\nExecStart=/bin/sh -c 'until [ -e /task/out/work/panic ]; do sleep 0.2; done; echo c > /proc/sysrq-trigger'\n`,
  );
  const cp = spawnSync("cp", ["--sparse=always", join(IMAGES, "agent.ext4"), img]);
  assert.equal(cp.status, 0, String(cp.stderr));
  const cmds = join(fake, "debugfs.cmds");
  const dir = "/etc/systemd/system";
  writeFileSync(
    cmds,
    `write ${unit} ${dir}/crash.service\nsymlink ${dir}/multi-user.target.wants/crash.service ${dir}/crash.service\n`,
  );
  const r = spawnSync("debugfs", ["-w", "-f", cmds, img], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  rmSync(join(home, "images", "agent.ext4"));
  symlinkSync(img, join(home, "images", "agent.ext4"));
}

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
    owner: { tz: "UTC", notify: "slack" },
    policy: { "*": "human", cache: [fake] }, // the fake provider records its requests here, on a host Planner too
    worker: { provider: "fake", model: "m", plugins: [join(fake, "plugins", "fake")] },
    // boot to the guest's hortus-agent takes a few seconds; 30 s keeps the hung-kernel test short
    vm: { cpus: 1, mem_mb: 1024, max_concurrent: 1, boot_timeout_s: 30 },
  };
  const vault: Record<string, unknown> = { fake: { type: "token", value: "x", transform: "fake" } };
  slack = await FakeSlack.start();
  slack.user("U1", "alice");
  slack.channel("D1", { is_im: true, user: "U1", members: [slack.botUser, "U1"], name: "" });
  Object.assign(config, {
    dofs: { slack: { type: "slack", owner: "U1" } },
    dev: { upstreams: { "slack.com": slack.url } },
  });
  Object.assign(vault, slack.vault("slack"));
  if (NET) {
    mkdirSync(join(fake, "site"));
    writeFileSync(join(fake, "site", "README.md"), "site\n");
    Object.assign(config, {
      projects: { site: { path: join(fake, "site") } },
      planner: { provider: "fake", model: "m", runtime: "vm" },
    });
  } else {
    config.proxy = { https: 0, http: 0, dns: 0 };
    crashImage();
  }
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

test("a kernel with no root (the initramfs drops to its shell and sits there): boot timeout, the task waits, not restarted", {
  skip: offline,
}, async () => {
  const i = join(home, "images", "agent.ext4");
  const real = readlinkSync(i);
  rmSync(i);
  writeFileSync(i, "not a filesystem\n".repeat(1000));
  try {
    const id = vmTask([{ text: "never" }]);
    const t = Date.now();
    await until(() => row(id)?.status === "waiting", 90_000, "waiting");
    const secs = (Date.now() - t) / 1000;
    const err = row(id)?.error ?? "";
    mark(`hung boot: waiting after ${secs.toFixed(1)} s: ${err.slice(0, 300).replaceAll("\n", " | ")}`);
    assert.match(err, /^boot timeout: no contact from the guest within 30 s/);
    assert.match(err, /emergency shell/, "the console.log tail follows");
    assert.ok(secs >= 25 && secs < 60, `${secs} s`);
    await until(() => qemus().length === 0, 10_000, "QEMU gone");
    await sleep(3000);
    assert.equal(started(id), 1, "not restarted");
    assert.equal(row(id)?.status, "waiting");
  } finally {
    rmSync(i);
    symlinkSync(real, i);
  }
});

test("a kernel that panics at boot: guest died at once, not at the boot timeout", { skip: offline }, async () => {
  const i = join(home, "images", "initramfs.img");
  rmSync(i);
  writeFileSync(i, "not an initramfs\n".repeat(100));
  try {
    const id = vmTask([{ text: "never" }]);
    const t = Date.now();
    await until(() => row(id)?.status === "waiting", 30_000, "waiting");
    mark(`panic at boot: waiting after ${((Date.now() - t) / 1000).toFixed(1)} s`);
    assert.match(row(id)?.error ?? "", /^guest died: .*Kernel panic/s);
    await until(() => qemus().length === 0, 10_000, "QEMU gone");
    await sleep(3000);
    assert.equal(started(id), 1, "not restarted");
  } finally {
    rmSync(i);
    symlinkSync(join(IMAGES, "initramfs.img"), i);
  }
});

/** the owner's failure DMs so far (the first of a minute names its task, the rest are "N more") */
const failureDms = () =>
  (slack as FakeSlack).calls
    .filter((c) => c.method === "chat.postMessage" && c.params.channel === "D1")
    .map((c) => c.params.text ?? "")
    .filter((t) => /failed|over budget/.test(t));
const planned = (id: string) =>
  db((d) => d.prepare("SELECT body FROM outbox WHERE task_id = ? AND seq < 0").all(id)) as { body: string }[];
const started = (id: string) =>
  logText()
    .split("\n")
    .filter((l) => l.includes('"msg":"starting"') && l.includes(id)).length;

/** The task ended by `crash`: waiting, the card says `error`, one DM, one Planner row, and a restart changes nothing. */
async function crashes(script: unknown[], crash: (id: string) => Promise<void> | void, error: RegExp): Promise<void> {
  const dms = failureDms().length;
  const id = vmTask(script);
  await until(() => existsSync(join(paths.out(id), "booted")), 60_000, "the guest's first contact");
  const t = Date.now();
  await crash(id);
  await until(() => row(id)?.status === "waiting", 90_000, "waiting");
  const err = row(id)?.error ?? "";
  mark(`${((Date.now() - t) / 1000).toFixed(1)} s to waiting, ${err.slice(0, 160).replaceAll("\n", " | ")}`);
  assert.match(err, error);
  await until(() => qemus().length === 0, 10_000, "QEMU gone");
  await until(() => failureDms().length > dms, 70_000, "the DM");
  assert.equal(failureDms().length, dms + 1, String(failureDms().slice(dms)));
  assert.equal(planned(id).length, 1);
  assert.equal(JSON.parse(planned(id)[0]?.body ?? "{}").type, "result");
  assert.equal(outbox(id).filter((m) => m.type === "result").length, 0, "the Worker said nothing");
  await killDaemon();
  await startDaemon();
  await sleep(3000);
  assert.equal(row(id)?.status, "waiting");
  assert.equal(row(id)?.error, err);
  assert.equal(started(id), 1, "not restarted");
  assert.equal(failureDms().length, dms + 1, "no second DM");
  assert.equal(planned(id).length, 1, "no second row");
}

const longTool = (first: string) => [{ calls: [{ name: "bash", input: { command: `${first}; sleep 600` } }] }];

test("a kernel panic in a running guest ends the task at once", { skip: offline }, () =>
  crashes(
    longTool("touch /task/out/work/panic"),
    (id) => until(() => existsSync(join(paths.out(id), "work", "panic")), 60_000, "the tool ran").then(() => {}),
    /^guest died: .*Rebooting in 1 seconds/s,
  ),
);

test("the Worker killed inside the guest", { skip: offline }, () =>
  crashes(longTool("pkill -9 -f bin/hortus-agent"), () => {}, /^guest died: /),
);

test("QEMU killed from outside", { skip: offline }, () =>
  crashes(
    longTool("touch /task/out/work/go"),
    async (id) => {
      await until(() => existsSync(join(paths.out(id), "work", "go")), 60_000, "the tool ran");
      for (const q of qemus()) process.kill(q.pid, "SIGKILL");
    },
    /^QEMU killed by SIGKILL/,
  ),
);

test("virtiofsd killed under a running guest", { skip: offline }, () =>
  crashes(
    longTool("touch /task/out/work/go"),
    async (id) => {
      await until(() => existsSync(join(paths.out(id), "work", "go")), 60_000, "the tool ran");
      for (const p of vmProcs()) if (p.exe.includes("virtiofsd")) process.kill(p.pid, "SIGKILL");
    },
    /virtiofsd|guest died/,
  ),
);

test("a guest that hangs after boot: running until its hours, the card's STOP ends it in 30 s, nothing notified", {
  skip: offline,
}, async () => {
  const dms = failureDms().length;
  const id = vmTask(longTool("touch /task/out/work/go"));
  await until(() => existsSync(join(paths.out(id), "work", "go")), 60_000, "the tool ran");
  for (const q of qemus()) process.kill(q.pid, "SIGSTOP");
  await sleep(5000);
  assert.equal(row(id)?.status, "running");
  const r = await fetch(`http://127.0.0.1:${port}/api/task.stop`, {
    method: "POST",
    headers: { "X-Hortus": "1", "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
  assert.equal(r.status, 200, await r.text());
  await until(() => row(id)?.status === "waiting", 45_000, "the STOP's kill");
  assert.equal(row(id)?.error, null);
  await until(() => qemus().length === 0, 10_000, "QEMU gone");
  await sleep(2000);
  assert.equal(failureDms().length, dms);
  assert.equal(planned(id).length, 0);
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

test("a VM task clones the origin, pushes hortus/<id>, and its merge lands through the same gate", {
  skip: online,
}, async () => {
  const id = `vmm${Date.now().toString(36)}`;
  const clone = "/task/out/work/clone";
  const push = [
    "touch /tmp/hortus-guest-tmp", // the guest's own /tmp: writable, and not the host's
    `git clone -q https://hortusd.internal/git/site ${clone} 2>&1`,
    `cd ${clone}`,
    "echo '- vm' > CHANGELOG.md",
    "git add -A",
    "git -c user.name=w -c user.email=w@example.invalid commit -qm vm",
    `git push -q origin HEAD:refs/heads/hortus/${id} 2>&1`,
    "echo pushed",
  ].join(" && ");
  vmTask(
    [
      { calls: [{ name: "bash", input: { command: push } }] },
      { calls: [{ name: "merge", input: {} }] },
      { calls: [{ name: "done", input: { summary: "merged from a vm" } }] },
    ],
    1,
    "site",
    id,
  );
  const entry = await until(
    () =>
      db((d) =>
        d.prepare("SELECT id FROM approvals WHERE task_id = ? AND category = 'merge' AND status = 'pending'").get(id),
      ) as { id: number } | undefined,
    180_000,
    "the merge entry",
  );
  assert.match(JSON.stringify(requests(id)), /pushed/);
  assert.ok(!existsSync("/tmp/hortus-guest-tmp"));
  const r = await fetch(`http://127.0.0.1:${port}/api/approval.decide`, {
    method: "POST",
    headers: { "X-Hortus": "1", "Content-Type": "application/json" },
    body: JSON.stringify({ id: entry.id, decision: "approve" }),
  });
  assert.equal(r.status, 200, await r.text());
  const st = db((d) => d.prepare("SELECT status, reason FROM approvals WHERE id = ?").get(entry.id)) as {
    status: string;
    reason: string | null;
  };
  assert.equal(st.status, "landed", String(st.reason));
  assert.equal(readFileSync(join(fake, "site", "CHANGELOG.md"), "utf8"), "- vm\n");
  await until(() => outbox(id).some((m) => m.type === "result"), 180_000, "the task's result");
});
