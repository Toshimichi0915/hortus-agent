import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import * as paths from "../paths.ts";
import { rpcClient, serveSocket } from "../rpc.ts";

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
  const home = `${join(mkdtempSync(join(tmpdir(), "hortusd-")), "home")}/`;
  process.env.HORTUS_HOME = home;
  const absent = await cli("ping");
  assert.equal(absent.code, 1);
  assert.equal(absent.err, `hortusd is not running (socket \\0${paths.socket().slice(1)})\n`);

  const d = daemon(home);
  try {
    assert.equal(((await ping()) as { pong: boolean }).pong, true);
    assert.equal(statSync(home).mode & 0o777, 0o700);
    assert.ok(existsSync(paths.db()));
    const r = await cli("ping");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^pong/);

    const second = daemon(home);
    assert.equal(await exited(second, 5000), 1);
    assert.equal(((await ping()) as { pong: boolean }).pong, true);

    d.kill("SIGTERM");
    assert.equal(await exited(d, 2000), 0);
  } finally {
    d.kill("SIGKILL");
  }
});

test("hortusd: socket already bound → exits non-zero without creating the DB", async () => {
  const home = mkdtempSync(join(tmpdir(), "hortusd-"));
  process.env.HORTUS_HOME = home;
  const squatter = await serveSocket(paths.socket());
  try {
    const d = daemon(home);
    assert.equal(await exited(d, 5000), 1);
    assert.equal(existsSync(paths.db()), false);
  } finally {
    squatter.close();
  }
});
