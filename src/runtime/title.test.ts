import assert from "node:assert/strict";
import { test } from "node:test";
import { columns, TITLE_MAX } from "./tasks.ts";

test("a title's columns: CJK and full-width count two, so 14 Japanese characters fit where 28 letters do", () => {
  assert.equal(columns("deploy the docs"), 15);
  assert.equal(columns("毎朝のビルド確認"), 16);
  assert.equal(columns("ＡＢ１"), 6);
  assert.equal(columns("한국어"), 6);
  assert.equal(columns("あ".repeat(14)), TITLE_MAX);
  assert.ok(columns("あ".repeat(15)) > TITLE_MAX);
});
