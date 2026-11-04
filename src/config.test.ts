import assert from "node:assert/strict";
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Config, load, policyFor, save } from "./config.ts";
import * as paths from "./paths.ts";
import { tempDir } from "./test/until.ts";

process.env.HORTUS_HOME = tempDir("hortus-config-");

test("missing file → defaults", () => {
  const c = load(join(paths.home(), "absent.json"));
  assert.equal(c.origins, "*");
  assert.deepEqual(c.vm, { cpus: 2, mem_mb: 4096, max_concurrent: 4, fallback_host: true });
  assert.deepEqual(c.chat.allow, []);
  assert.deepEqual(c.policy, { "*": "human" });
  assert.equal(c.planner.batch_max, 50);
  assert.equal(c.planner.daily_tokens, 5e6);
  assert.equal(c.planner.effort, "low");
  assert.equal(c.planner.runtime, "host");
  assert.deepEqual(c.worker.budget, { tokens: 2e6, hours: 4 });
  assert.deepEqual(c.worker.credentials, []);
  assert.equal(c.worker.context_window, 131072);
  assert.deepEqual(c.projects, {});
  assert.deepEqual(c.dofs, {});
});

test("invalid JSON or schema → throws naming the path", () => {
  const bad = join(paths.home(), "bad.json");
  writeFileSync(bad, "{ not json");
  assert.throws(
    () => load(bad),
    (e: Error) => e.message.startsWith(bad),
  );
  writeFileSync(bad, JSON.stringify({ vm: { cpus: "two" }, owner: { tz: 3 } }));
  assert.throws(
    () => load(bad),
    (e: Error) =>
      e.message === `${bad}: owner.tz: expected string, received number; vm.cpus: expected number, received string`,
  );
  writeFileSync(bad, JSON.stringify({ owner: { tz: "Mars/Olympus" } }));
  assert.throws(() => load(bad), { message: `${bad}: owner.tz: not an IANA time zone (e.g. Asia/Tokyo)` });
});

test("policyFor: forced human, exact key, * fallback, empty policy", () => {
  const c = Config.parse({
    policy: { merge: "auto", transforms: "auto", login: "auto", "origin:x.com": "auto", "*": "auto" },
  });
  for (const k of ["merge", "transforms", "login", "origin:x.com"]) assert.equal(policyFor(c, k), "human");
  const d = Config.parse({ policy: { "credential:slack": "auto", "*": "human" } });
  assert.equal(policyFor(d, "credential:slack"), "auto");
  assert.equal(policyFor(d, "credential:x"), "human");
  assert.equal(policyFor(Config.parse({ policy: { "*": "auto" } }), "credential:x"), "auto");
  const empty = Config.parse({ policy: {} });
  assert.deepEqual(empty.policy, {});
  assert.equal(policyFor(empty, "credential:x"), "human");
  assert.equal(policyFor(Config.parse({ policy: { deny: ["/x"] } }), "deny"), "human");
});

test("save: atomic, 0600, unknown keys survive a round trip", () => {
  const file = paths.config();
  const c = Config.parse({ future: { a: 1 }, vm: { cpus: 8, gpu: true }, dofs: { s: { type: "slack", extra: "x" } } });
  save(c);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(
    readdirSync(paths.home()).filter((f) => f.endsWith(".tmp")),
    [],
  );
  const back = load() as Config & { future: unknown };
  assert.deepEqual(back.future, { a: 1 });
  assert.equal((back.vm as Record<string, unknown>).gpu, true);
  assert.equal((back.dofs.s as Record<string, unknown>).extra, "x");
  assert.equal(back.vm.cpus, 8);
  assert.ok(existsSync(file));
});

test("a project name outside letters, digits, . _ - is refused by the config schema", () => {
  assert.throws(() => Config.parse({ projects: { "<b>x</b>": { path: "/tmp" } } }), /a project name: letters/);
  assert.ok(Config.parse({ projects: { "my-app.v2": { path: "/tmp" } } }).projects["my-app.v2"]);
});
