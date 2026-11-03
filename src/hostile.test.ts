import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { appendText, readCapped, replaceFile } from "./hostile.ts";
import { tempDir } from "./test/until.ts";

test("hostile files: links and FIFOs are never followed, read or blocked on", () => {
  const d = tempDir("hortus-hostile-");
  const secret = join(d, "secret");
  writeFileSync(secret, "s3cret\n");
  symlinkSync(secret, join(d, "summary.md"));
  assert.equal(readCapped(join(d, "summary.md"), 100), null);
  execFileSync("mkfifo", [join(d, "fifo")]);
  assert.equal(readCapped(join(d, "fifo"), 100), null, "no hang on a FIFO");

  symlinkSync(secret, join(d, "console.log"));
  appendText(join(d, "console.log"), "line\n");
  assert.equal(readFileSync(secret, "utf8"), "s3cret\n");
  assert.equal(readFileSync(join(d, "console.log"), "utf8"), "line\n", "the link was replaced by a file");
  appendText(join(d, "fifo"), "x\n");
  assert.equal(readFileSync(join(d, "fifo"), "utf8"), "x\n");

  symlinkSync(secret, join(d, "last-summary.md"));
  replaceFile(join(d, "last-summary.md"), "sum");
  assert.equal(readFileSync(secret, "utf8"), "s3cret\n");
  assert.equal(readCapped(join(d, "last-summary.md"), 2)?.text, "su");
  assert.equal(readCapped(join(d, "last-summary.md"), 2, true)?.text, "um");
});
