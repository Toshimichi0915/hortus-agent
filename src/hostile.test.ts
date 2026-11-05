import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { appendText, lines, readCapped, readDir, replaceFile, rmTree } from "./hostile.ts";
import { tempDir } from "./test/until.ts";

test("rmTree: a tree a session left read-only goes, and what a link in it names stays as it was", () => {
  const d = tempDir("hortus-rmtree-");
  const outside = join(d, "outside");
  mkdirSync(outside);
  chmodSync(outside, 0o555);
  const t = join(d, "task");
  mkdirSync(join(t, "ro/deep"), { recursive: true });
  writeFileSync(join(t, "ro/deep/f"), "x");
  symlinkSync(outside, join(t, "ro/link"));
  chmodSync(join(t, "ro/deep"), 0o555);
  chmodSync(join(t, "ro"), 0o555);
  rmTree(t);
  assert.equal(existsSync(t), false);
  assert.equal(execFileSync("stat", ["-c", "%a", outside], { encoding: "utf8" }).trim(), "555");
  chmodSync(outside, 0o755); // tempDir's cleanup
});

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

test("readDir: never through a linked directory or entry; sorted, capped, the rest counted", () => {
  const d = tempDir("hortus-readdir-");
  const real = join(d, "real");
  mkdirSync(real);
  for (const n of ["c", "a", "b", "skip.tmp"]) writeFileSync(join(real, n), n);
  writeFileSync(join(d, "secret"), "s3cret");
  symlinkSync(join(d, "secret"), join(real, "d"));
  const all = (dir: string, max: number) =>
    readDir(
      dir,
      (n) => !n.endsWith(".tmp"),
      max,
      (names, read, dropped) => ({
        got: names.map((n) => [n, read(n, 10)?.text ?? null]),
        dropped,
      }),
    );
  assert.deepEqual(all(real, 3), {
    got: [
      ["a", "a"],
      ["b", "b"],
      ["c", "c"],
    ],
    dropped: 1,
  });
  assert.deepEqual(all(real, 10)?.got.at(-1), ["d", null], "a linked entry is not read");
  symlinkSync(real, join(d, "link"));
  assert.equal(all(join(d, "link"), 10), null, "a linked directory is not listed");
  assert.equal(all(join(d, "secret"), 10), null, "a file is not a directory");
  assert.equal(all(join(d, "gone"), 10), null);
});

test("lines: a line without an end is cut at the cap, the next one is whole", async () => {
  const s = new PassThrough();
  const got: string[] = [];
  lines(s, 8, (l) => got.push(l));
  s.write("ab\r\n\n");
  for (let i = 0; i < 100; i++) s.write("x".repeat(1000));
  s.write("yy\nnext");
  s.end("!");
  await new Promise((r) => s.on("end", r));
  assert.deepEqual(got, ["ab", "", "xxxxxxxx", "next!"]);
});
