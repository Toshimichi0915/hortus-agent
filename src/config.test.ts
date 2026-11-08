import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Config, load, policyFor, save } from "./config.ts";
import * as paths from "./paths.ts";
import { tempDir } from "./test/until.ts";
import { highestPrice, priceOf, usageCost } from "./types.ts";

process.env.HORTUS_HOME = tempDir("hortus-config-");

test("prices: a model's rates, its dated name's, and what a call costs", () => {
  const opus = { input: 4, cache_read: 0.2, cache_write: 5, output: 20 };
  const gpt = { input: 2, cache_read: 0.1, output: 10 };
  const six = { input: 10, cache_read: 1, output: 50 };
  const listed = { opus, gpt, "gpt-6": six };
  const hosted = { input: 1, cache_read: 0.1, output: 2 };
  const prices = { a: listed, b: { opus: hosted } };
  assert.equal(priceOf(prices, "a", "opus"), opus);
  assert.equal(priceOf(prices, "b", "opus"), hosted, "one model, another host's rates");
  assert.equal(priceOf(prices, "b", "gpt"), undefined, "a's rates say nothing of b");
  assert.equal(priceOf(prices, "c", "opus"), undefined);
  assert.equal(priceOf(prices, undefined, "opus"), undefined);
  assert.equal(priceOf(prices, "a", "opus-2026-01-01"), opus);
  assert.equal(priceOf(prices, "a", "gpt-6-2026-01-01"), six, "the longest name it extends");
  assert.equal(priceOf(prices, "a", "opus-20260101"), opus);
  assert.equal(priceOf(prices, "a", "opusx"), undefined, "a name is no bare prefix");
  assert.equal(priceOf(prices, "a", "gpt-6-pro"), undefined, "another model, not a dated name");
  assert.equal(priceOf(prices, "a", "opus-5"), undefined, "nor a version");
  assert.equal(priceOf(prices, "a", "opus:free"), undefined, "nor a variant");
  assert.equal(priceOf(prices, "a", undefined), undefined);
  assert.equal(priceOf(prices, "a", "constructor"), undefined, "nothing of Object's");
  assert.equal(priceOf(prices, "constructor", "name"), undefined, "nor as a provider");

  // 1M each: 700k fresh + 200k read + 100k written, then output
  const u = { input: 1e6, cacheRead: 2e5, cacheWrite: 1e5, output: 1e6 };
  assert.ok(Math.abs(usageCost(u, opus) - (0.7 * 4 + 0.2 * 0.2 + 0.1 * 5 + 20)) < 1e-9);
  assert.ok(Math.abs(usageCost(u, gpt) - (0.7 * 2 + 0.2 * 0.1 + 0.1 * 2 + 10)) < 1e-9, "a write at input by default");
  // a Worker's own file or `curl` reports what it likes: more cached than input cannot pay it back
  assert.equal(usageCost({ input: 10, cacheRead: 1e9, cacheWrite: 1e9, output: 0 }, { ...gpt, cache_read: 0 }), 0);

  assert.deepEqual(highestPrice(listed), { input: 10, cache_read: 1, cache_write: 10, output: 50 });
  assert.deepEqual(highestPrice({}), { input: 0, cache_read: 0, cache_write: 0, output: 0 });
  assert.deepEqual(
    Config.parse({ prices: { p: { m: { input: 1, cached: 0.1, output: 2 } } } }).prices.p?.m,
    { input: 1, cache_read: 0.1, output: 2 },
    "a hortusd.json from before the rename",
  );
  assert.throws(() => Config.parse({ prices: { p: { m: { input: 0, cache_read: 0, output: 1 } } } }), /prices/);
});

test("missing file → defaults", () => {
  const c = load(join(paths.home(), "absent.json"));
  assert.equal(c.origins, "*");
  assert.deepEqual(c.vm, { cpus: 2, mem_mb: 4096, max_concurrent: 4, fallback_host: true, boot_timeout_s: 120 });
  assert.deepEqual(c.chat.allow, []);
  assert.deepEqual(c.policy, { "*": "human" });
  assert.equal(c.planner.batch_max, 50);
  assert.equal(c.planner.daily_usd, 5);
  assert.equal(c.planner.effort, "low");
  assert.equal(c.planner.runtime, undefined);
  assert.deepEqual(c.worker.budget, { usd: 20, hours: 4 });
  assert.deepEqual(c.prices, {});
  assert.deepEqual(c.worker.credentials, []);
  assert.equal(c.worker.context_window, 131072);
  assert.deepEqual(c.projects, {});
  assert.deepEqual(c.dofs, {});
});

test("a project's old `origins` key still loads: it no longer does anything", () => {
  const c = Config.parse({ projects: { a: { path: "/x/a", origins: ["a.test"] } } });
  assert.equal(c.origins, "*");
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

test("policy path lists are absolute: `~/x` would name nothing, a deny that denies nothing", () => {
  for (const k of ["deny", "cache", "read"]) {
    assert.throws(() => Config.parse({ policy: { [k]: ["~/x"] } }));
    assert.deepEqual(Config.parse({ policy: { [k]: ["/x"] } }).policy[k], ["/x"]);
  }
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

test("a DOF name that is a path, another DOF's bare repo or hortusd's own DOF is refused", () => {
  // `..` would carve HORTUS_HOME into the profile (vault.json); `x.git` is x's repo; `transforms` never taints
  for (const n of ["..", "a/b", "", ".x", "slack.git", "logs", "transforms", "hortus"])
    assert.throws(() => Config.parse({ dofs: { [n]: { type: "slack" } } }), /a DOF name/, n);
  assert.ok(Config.parse({ dofs: { "slack2.work": { type: "slack" }, logs2: { type: "slack" } } }).dofs.logs2);
});

test("README's example hortusd.json validates (no unknown top-level key); its provider's transform ships", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const block = /```json\n([\s\S]*?)\n```/.exec(readme)?.[1] ?? "";
  const c = Config.strict().parse(JSON.parse(block));
  assert.equal(c.planner.provider, "openrouter");
  assert.deepEqual(Object.keys(c.dofs), ["slack", "github"]);
  assert.match(readme, /\| `openrouter` \| token \| openrouter \| \|/);
  assert.ok(existsSync(new URL("transforms/openrouter/manifest.json", import.meta.url)));
});
