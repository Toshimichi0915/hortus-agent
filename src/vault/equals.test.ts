/** `equals`: constant-time comparison against a webhook-secret credential. */
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
