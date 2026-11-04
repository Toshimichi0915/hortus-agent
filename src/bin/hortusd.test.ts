import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import * as paths from "../paths.ts";
import { rpcClient, serveSocket } from "../rpc.ts";
import { tempDir } from "../test/until.ts";

const bin = (name: string) => fileURLToPath(new URL(`${name}.js`, import.meta.url));

function daemon(home: string): ChildProcess {
  return spawn(process.execPath, ["--no-warnings", bin("hortusd")], {
    env: { ...process.env, HORTUS_HOME: home, HORTUS_CONSOLE_PORT: "0", HORTUS_NO_NET: "1" },
    stdio: ["ignore", "ignore", "pipe"],
  });
}

const exited = (p: ChildProcess, ms: number) =>
  Promise.race([
    new Promise<number | null>((r) => p.once("exit", (code) => r(code))),
    sleep(ms).then(() => "timeout" as const),
  ]);

async function ping(): Promise<unknown> {
  for (let i = 0; ; i++) {
    const c = rpcClient(paths.socket());
    try {
      return await c.call("ping", {});
    } catch (e) {
      if (i > 100) throw e;
      await sleep(50);
    } finally {
      c.close();
    }
  }
}

function cli(...args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  const p = spawn(process.execPath, ["--no-warnings", bin("hortus"), ...args], { env: process.env });
  let out = "";
  let err = "";
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (err += d));
  return new Promise((r) => p.on("exit", (code) => r({ code, out, err })));
}

test("hortusd: creates HORTUS_HOME 0700, answers ping, a second daemon fails, exits on SIGTERM", async () => {
  const home = `${join(tempDir("hortusd-"), "home")}/`;
  process.env.HORTUS_HOME = home;
  const absent = await cli("ping");
  assert.equal(absent.code, 1);
  assert.equal(
    absent.err,
    `hortusd is not running (socket \\0${paths.socket().slice(1)}): sudo systemctl start hortusd\n`,
  );

  const d = daemon(home);
  try {
    assert.equal(((await ping()) as { pong: boolean }).pong, true);
    assert.equal(statSync(home).mode & 0o777, 0o700);
    assert.ok(existsSync(paths.db()));
    const r = await cli("ping");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^pong/);

    const second = daemon(home);
    assert.equal(await exited(second, 5000), 78);
    assert.equal(((await ping()) as { pong: boolean }).pong, true);

    d.kill("SIGTERM");
    assert.equal(await exited(d, 2000), 0);
  } finally {
    d.kill("SIGKILL");
  }
});

test("hortusd: socket already bound → exits non-zero without creating the DB", async () => {
  const home = tempDir("hortusd-");
  process.env.HORTUS_HOME = home;
  const squatter = await serveSocket(paths.socket());
  try {
    const d = daemon(home);
    assert.equal(await exited(d, 5000), 78);
    assert.equal(existsSync(paths.db()), false);
  } finally {
    squatter.close();
  }
});

test("hortusd: HORTUS_NO_NET=1 without HORTUS_HOME refuses to start", async () => {
  const { HORTUS_HOME: _, ...env } = process.env;
  const d = spawn(process.execPath, ["--no-warnings", bin("hortusd")], {
    env: { ...env, HOME: tempDir("hortusd-nonet-"), HORTUS_NO_NET: "1", HORTUS_CONSOLE_PORT: "0" }, // never ~/.hortus
    stdio: ["ignore", "ignore", "pipe"],
  });
  try {
    assert.equal(await exited(d, 5000), 1);
  } finally {
    d.kill("SIGKILL");
  }
});

/** One error line on stderr (no stack) and exit 78: the unit's RestartPreventExitStatus, so no restart loop. */
async function unfixable(home: string): Promise<{ code: unknown; lines: string[] }> {
  const d = daemon(home);
  let err = "";
  d.stderr?.on("data", (b) => (err += b));
  const code = await exited(d, 10000);
  d.kill("SIGKILL");
  return { code, lines: err.trim().split("\n") };
}

test("hortusd: an invalid hortusd.json → one line naming each key, exit 78", async () => {
  const home = tempDir("hortusd-");
  writeFileSync(join(home, "hortusd.json"), JSON.stringify({ vm: { cpus: "two" } }));
  const { code, lines } = await unfixable(home);
  assert.equal(code, 78);
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.match(
    JSON.parse(lines[0] ?? "").msg,
    /hortusd\.json: vm\.cpus: expected number, received string \(fix the file, then start hortusd again\)$/,
  );
});

test("hortusd: a corrupt DB → one line naming the file and what to do, exit 78", async () => {
  const home = tempDir("hortusd-");
  process.env.HORTUS_HOME = home;
  writeFileSync(paths.db(), Buffer.alloc(8192, 0x5a));
  const { code, lines } = await unfixable(home);
  assert.equal(code, 78);
  const msg = JSON.parse(lines.at(-1) ?? "").msg as string;
  assert.ok(msg.startsWith(`${paths.db()}: file is not a database`), msg);
  assert.match(msg, /move it aside/);
});

test("hortusd: without CAP_NET_ADMIN (run by hand) → one line saying so, exit 78", {
  skip: process.getuid?.() === 0,
}, async () => {
  const home = tempDir("hortusd-");
  const d = spawn(process.execPath, ["--no-warnings", bin("hortusd")], {
    env: { ...process.env, HORTUS_HOME: home, HORTUS_CONSOLE_PORT: "0", HORTUS_NO_NET: "" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let err = "";
  d.stderr?.on("data", (b) => (err += b));
  const code = await exited(d, 10000);
  d.kill("SIGKILL");
  assert.equal(code, 78, err);
  assert.match(JSON.parse(err.trim().split("\n").at(-1) ?? "").msg, /^runtime: .*needs CAP_NET_ADMIN/);
});
