import assert from "node:assert/strict";
import { test } from "node:test";
import { taskId, token } from "./ids.ts";

test("1000 task ids are unique and sort by creation time", () => {
  const ids = Array.from({ length: 1000 }, taskId);
  assert.equal(new Set(ids).size, 1000);
  assert.deepEqual([...ids].sort(), ids);
  assert.match(ids[0] as string, /^[0-9a-z]+[0-9a-f]{8}$/);
});

test("token is base64url of n bytes", () => {
  assert.match(token(32), /^[A-Za-z0-9_-]{43}$/);
});
