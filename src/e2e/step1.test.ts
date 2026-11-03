/**
 * Step 1 done-when (docs/build-order.md): a Slack message is a file on `main` within seconds and `dof search` finds it.
 * Runs the real daemon (HORTUS_NO_NET=1) and the fake Slack through the pipeline (`dev.upstreams`).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import * as paths from "../paths.ts";
import { rpcClient } from "../rpc.ts";
import { FakeSlack } from "../test/fakes/slack.ts";

const bin = (name: string) => new URL(`../bin/${name}.js`, import.meta.url).pathname;
const until = async (pred: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 100));
  }
};

let home: string;
let fake: FakeSlack;
let daemon: ReturnType<typeof spawn>;

before(async () => {
  home = mkdtempSync(join(tmpdir(), "hortus-step1-"));
  process.env.HORTUS_HOME = home;
  fake = await FakeSlack.start();
  fake.user("U1", "alice");
  fake.channel("C1", { name: "general", members: ["U1", fake.botUser] });
  writeFileSync(
    join(home, "hortusd.json"),
    JSON.stringify({
      owner: { tz: "UTC" },
      dofs: { slack: { type: "slack", owner: "U1" } },
      dev: { upstreams: { "slack.com": fake.url } },
      proxy: { https: 0, http: 0, dns: 0 },
    }),
  );
  writeFileSync(join(home, "vault.json"), JSON.stringify(fake.vault("slack")), { mode: 0o600 });
  daemon = spawn(process.execPath, [bin("hortusd")], {
    env: { ...process.env, HORTUS_HOME: home, HORTUS_CONSOLE_PORT: "0", HORTUS_NO_NET: "1" },
    stdio: ["ignore", "ignore", "inherit"],
  });
});

after(async () => {
  daemon.kill("SIGTERM");
  await new Promise((r) => daemon.once("exit", r));
  await fake.close();
  rmSync(home, { recursive: true, force: true });
});

test("a Slack message is a file on main within seconds and dof search finds it", async () => {
  const rpc = rpcClient(paths.socket());
  await until(() => {
    try {
      execFileSync("git", ["-C", paths.dofRepo("slack"), "rev-parse", "main"], { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  }, 15_000);
  // the connector is up once the first reconcile committed channel.md
  await until(() => existsSync(join(paths.dof("slack"), "C1", "channel.md")), 15_000);
  const msg = fake.post("C1", { user: "U1", text: "we should deploy the fix tonight" });
  const file = join(paths.dof("slack"), "C1", msg.ts, `${msg.ts}.md`);
  await until(() => existsSync(file), 5_000);
  const text = readFileSync(file, "utf8");
  assert.match(text, /user: U1 \(alice\)/);
  assert.match(text, /deploy the fix tonight/);
  const log = execFileSync("git", ["-C", paths.dofRepo("slack"), "log", "--format=%s", "main"], { encoding: "utf8" });
  assert.match(log, /^sync\(slack\)/m);
  const hits = (await rpc.call("dof.search", { q: "deploy" })) as { path: string }[];
  assert.ok(
    hits.some((h) => h.path.endsWith(`${msg.ts}.md`)),
    JSON.stringify(hits),
  );
  const cli = execFileSync(process.execPath, [bin("dof"), "search", "deploy"], {
    env: { ...process.env, HORTUS_HOME: home },
    encoding: "utf8",
  });
  assert.match(cli, new RegExp(`slack/C1/${msg.ts.replace(".", "\\.")}`));
  rpc.close();
  assert.ok(readdirSync(join(home, "dof")).includes("slack.git"));
});
