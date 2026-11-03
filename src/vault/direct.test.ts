import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { directFetch } from "./direct.ts";

test("swaps only the allowed placeholders, reading vault.json per call", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "hortus-direct-"));
  process.env.HORTUS_HOME = home;
  writeFileSync(
    join(home, "vault.json"),
    JSON.stringify({ a: { type: "token", value: "real-a" }, b: { value: "real-b" } }),
  );
  const server = createServer((req, res) => res.end(req.headers.authorization ?? ""));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const f = directFetch(["a"]);
  const auth = async (v: string) => (await f(url, { headers: { Authorization: v } })).text();
  assert.equal(await auth("Bearer hortus-secret-a"), "Bearer real-a");
  assert.equal(await auth("Bearer hortus-secret-b"), "Bearer hortus-secret-b");
  writeFileSync(join(home, "vault.json"), JSON.stringify({ a: { value: "rotated" } }));
  assert.equal(await auth("Bearer hortus-secret-a"), "Bearer rotated");
  assert.equal(await (await f(url)).text(), "");
});
