/** `equals` (18-gitlab-bitbucket.md): constant-time comparison against a webhook-secret credential. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { tempDir } from "../test/until.ts";
import { equals } from "./ops.ts";
import { write } from "./vault.ts";

process.env.HORTUS_HOME = tempDir("hortus-equals-");
const secret = "s3cret-token-0123456789abcdef";
write({ hook: { type: "webhook-secret", value: secret }, tok: { type: "token", value: secret } });

test("equals: equal → true; a different length, a different last byte, missing, a non-webhook credential → false", () => {
  assert.equal(equals("hook", secret), true);
  assert.equal(equals("hook", `${secret}x`), false);
  assert.equal(equals("hook", secret.slice(0, -1)), false, "a prefix of the secret");
  assert.equal(equals("hook", `${secret.slice(0, -1)}X`), false);
  assert.equal(equals("hook", ""), false);
  assert.equal(equals("hook", undefined), false);
  assert.equal(equals("nope", secret), false);
  assert.equal(equals("tok", secret), false);
});

test("equals: a length mismatch takes as long as a last-byte mismatch (coarse, 1000 runs)", () => {
  const time = (v: string) => {
    const t = process.hrtime.bigint();
    for (let i = 0; i < 1000; i++) equals("hook", v);
    return Number(process.hrtime.bigint() - t);
  };
  time(secret); // warm up
  // interleaved, best of 20 rounds of 1000: the test process shares the machine with the rest of the suite
  let short = Number.POSITIVE_INFINITY;
  let last = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 20; i++) {
    short = Math.min(short, time("x"));
    last = Math.min(last, time(`${secret.slice(0, -1)}X`));
  }
  const ratio = short / last;
  assert.ok(ratio > 0.33 && ratio < 3, `ratio ${ratio}`);
});
