/**
 * The Worker's Chromium on the host runs inside the Worker's Landlock domain (unattended profile): a node process
 * under the shim drives a BrowserSession, as hortus-agent does. Its profile is under out/work; ~/.ssh and a
 * `policy.deny` path are unreadable to it. Unprivileged (Landlock needs no capabilities); skipped without Landlock or
 * Chromium.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Config } from "../config.ts";
import * as paths from "../paths.ts";
import { abi, profile, shim } from "../runtime/landlock.ts";
import { CHROMIUM } from "./cdp.ts";

// under $HOME, not /tmp: /tmp is an rw tree in the unattended profile
const root = mkdtempSync(join(homedir(), ".hortus-3h-landlock-"));
process.env.HORTUS_HOME = join(root, "home");
after(() => rmSync(root, { recursive: true, force: true }));

const landlock = await abi().then(
  () => true,
  () => false,
);
const why = !landlock ? "no Landlock" : !existsSync(CHROMIUM) ? "no chromium" : false;

test("Chromium inside the unattended domain: profile under out/work, ~/.ssh and policy.deny unreadable", {
  skip: why,
}, async () => {
  const work = join(paths.out("T"), "work");
  mkdirSync(work, { recursive: true });
  mkdirSync(join(paths.ctl("T"), "inbox"), { recursive: true });
  const secret = join(root, "secret");
  mkdirSync(secret);
  writeFileSync(join(secret, "x.txt"), "TOPSECRET");
  writeFileSync(join(work, "ok.txt"), "VISIBLE");
  const ssh = join(homedir(), ".ssh");
  const sshFile = existsSync(ssh) ? readdirSync(ssh).find((f) => statSync(join(ssh, f)).isFile()) : undefined;
  const files = [join(work, "ok.txt"), join(secret, "x.txt"), ...(sshFile ? [join(ssh, sshFile)] : [])];

  const tools = fileURLToPath(new URL("./tools.js", import.meta.url));
  const script = join(work, "drive.mjs");
  writeFileSync(
    script,
    `import { BrowserSession } from ${JSON.stringify(tools)};
const task = { id: "T", paths: { work: ${JSON.stringify(work)} }, cookies: [] };
const s = new BrowserSession(task, ${JSON.stringify(paths.task("T"))});
const out = {};
for (const f of ${JSON.stringify(files)}) {
  const nav = await s.navigate("file://" + f);
  out[f] = nav.startsWith("navigation failed") ? nav : await s.eval("document.body.innerText");
}
await s.close();
console.log(JSON.stringify(out));`,
  );
  const config = Config.parse({ policy: { deny: [secret] } });
  const text = profile("unattended", { id: "T" }, config);
  const r = await new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const c = spawn(shim.path, ["--", process.execPath, script], {
      cwd: work,
      env: { HOME: homedir(), PATH: process.env.PATH ?? "/usr/bin:/bin" },
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    c.stdout?.on("data", (d) => {
      out += d;
    });
    c.stderr?.on("data", (d) => {
      err += d;
    });
    (c.stdio[3] as Writable).on("error", () => {}).end(text);
    c.on("close", (code) => resolve({ code, out, err }));
  });
  assert.equal(r.code, 0, r.err.slice(-2000));
  const got = JSON.parse(r.out.trim().split("\n").at(-1) ?? "{}") as Record<string, string>;
  assert.equal(got[join(work, "ok.txt")], "VISIBLE");
  assert.match(got[join(secret, "x.txt")] ?? "", /ERR_ACCESS_DENIED/);
  if (sshFile) assert.match(got[join(ssh, sshFile)] ?? "", /ERR_ACCESS_DENIED/);
  assert.ok(
    existsSync(join(work, "chrome", "Default")) || existsSync(join(work, "chrome", "Local State")),
    "profile in out/work/chrome",
  );
});
