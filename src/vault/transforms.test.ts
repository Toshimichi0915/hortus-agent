import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "../test/until.ts";
import * as transforms from "./transforms.ts";

process.env.HORTUS_HOME = tempDir("hortus-tf-");

const fixtures = tempDir("hortus-tf-fixtures-");
function fixture(name: string, code: string, tests?: Record<string, unknown>) {
  const dir = join(fixtures, name);
  mkdirSync(join(dir, "tests"), { recursive: true });
  const manifest = { name, credentials: { [name]: { type: "token", hosts: [`${name}.test`], locations: [] } } };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "transform.js"), code);
  for (const [f, c] of Object.entries(tests ?? {})) writeFileSync(join(dir, "tests", f), JSON.stringify(c));
}
fixture("notion", "export function request(req) { return { ...req, headers: { ...req.headers, x: '1' } }; }", {
  "a.json": {
    request: { method: "GET", url: "https://notion.test/", headers: {}, body: null, stream: false },
    template: { method: "GET", url: "https://notion.test/", headers: { x: "1" }, body: null, stream: false },
  },
  "b.json": {
    request: { method: "GET", url: "https://notion.test/", headers: {}, body: null, stream: false },
    template: { method: "GET", url: "https://notion.test/", headers: { x: "2" }, body: null, stream: false },
  },
});

await transforms.load([transforms.shippedDir(), fixtures]);

test("every shipped transform passes its tests", () => {
  for (const name of ["slack", "anthropic", "openai", "openrouter"]) {
    const r = transforms.runTests(name);
    assert.ok(r.length > 0, name);
    for (const x of r) assert.ok(x.ok, `${name}/${x.file}: ${x.diff}`);
  }
});

test("a fixture transform from a test dir loads and its failing test reports a diff", () => {
  const r = transforms.runTests("notion");
  assert.deepEqual(
    r.map((x) => x.ok),
    [true, false],
  );
  assert.match(r[1]?.diff ?? "", /"x":"1"/);
  assert.equal(transforms.byHost("notion.test")?.name, "notion");
  assert.equal(transforms.byHost("api.anthropic.com")?.credential, "anthropic");
});

test("a streamed request keeps body null whatever the transform returns", () => {
  fixture("sneaky", "export function request(req) { return { ...req, body: 'injected' }; }");
  return transforms.load([fixtures]).then(() => {
    const t = transforms.request(
      "sneaky",
      { method: "POST", url: "https://sneaky.test/", headers: {}, body: null, stream: true },
      { now: 0, nonce: "n" },
    );
    assert.equal(t.body, null);
  });
});

test("the transform deadline is CPU time: a call descheduled past it finishes, a spin does not", (t) => {
  const code = "export function f() { let n = 0; for (let i = 0; i < 300000; i++) n += i; return n; }";
  const real = Date.now;
  let calls = 0;
  // a thread off the CPU: the clock leaps past the deadline right after the call starts
  t.mock.method(Date, "now", () => real() + (calls++ ? 10_000 : 0));
  assert.equal(transforms.invoke("x", "f", [], { code }), 44999850000);
  t.mock.restoreAll();
  const spin = { code: "export function f() { for (;;) {} }" };
  assert.throws(() => transforms.invoke("x", "f", [], spin), /interrupted/);
});
