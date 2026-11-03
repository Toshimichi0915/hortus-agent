import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import * as paths from "../paths.ts";
import { tempDir } from "../test/until.ts";
import { caCert, ensure, hostContext, validHost } from "./ca.ts";

process.env.HORTUS_HOME = tempDir("hortus-ca-");
const run = promisify(execFile);

test("100 parallel hostContext calls mint once; files are 0600", async () => {
  await ensure();
  const ctxs = await Promise.all(Array.from({ length: 100 }, () => hostContext("slack.com")));
  assert.ok(ctxs.every((c) => c === ctxs[0]));
  const hosts = readdirSync(join(paths.ca(), "hosts"));
  assert.deepEqual(hosts.sort(), ["slack.com.crt", "slack.com.key"]);
  for (const f of ["ca.key", "ca.crt", "hosts/slack.com.key", "hosts/slack.com.crt"])
    assert.equal(statSync(join(paths.ca(), f)).mode & 0o777, 0o600, f);
});

test("the leaf verifies against ca.crt and carries the SAN", async () => {
  const crt = join(paths.ca(), "hosts", "slack.com.crt");
  const v = await run("openssl", ["verify", "-CAfile", caCert(), crt]);
  assert.match(v.stdout, /OK/);
  const t = await run("openssl", ["x509", "-in", crt, "-noout", "-text"]);
  assert.match(t.stdout, /DNS:slack\.com/);
  assert.match(t.stdout, /prime256v1|P-256/);
  await hostContext("10.0.0.1");
  const ip = await run("openssl", ["x509", "-in", join(paths.ca(), "hosts", "10.0.0.1.crt"), "-noout", "-text"]);
  assert.match(ip.stdout, /IP Address:10\.0\.0\.1/);
});

test("hosts with .. or / are refused before touching the filesystem", async () => {
  for (const h of ["../etc", "a/b", "a..b", "", "x".repeat(254), ".lead", "a_b"]) {
    assert.throws(() => validHost(h));
    await assert.rejects(hostContext(h));
  }
  assert.equal(validHost("API.Slack.com"), "api.slack.com");
});
