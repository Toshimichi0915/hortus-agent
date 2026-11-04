/** tempDir: removed on exit and on the signals the test runner and ^C send. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { test } from "node:test";

const child = (sig: NodeJS.Signals) =>
  new Promise<{ dir: string; code: number | null }>((resolve) => {
    const url = new URL("./until.js", import.meta.url).href;
    const src = `const { tempDir } = await import(${JSON.stringify(url)}); console.log(tempDir("hortus-untiltest-")); setInterval(() => {}, 1000);`;
    const p = spawn(process.execPath, ["--input-type=module", "-e", src], { env: { ...process.env, KEEP: "" } });
    let out = "";
    p.stdout.on("data", (b) => {
      out += b;
      if (out.includes("\n")) p.kill(sig);
    });
    p.on("exit", (code) => resolve({ dir: out.trim(), code }));
  });

for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  test(`tempDir: removed when the test process gets ${sig}`, async () => {
    const { dir, code } = await child(sig);
    assert.match(dir, /hortus-untiltest-/);
    assert.equal(existsSync(dir), false);
    assert.ok(code !== null && code > 128);
  });
}
