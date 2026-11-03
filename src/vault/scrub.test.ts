import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import { test } from "node:test";
import { Scrubber } from "./scrub.ts";

const s = new Scrubber([
  { value: "short", placeholder: "hortus-secret-short" },
  { value: "abcdefgh", placeholder: "hortus-secret-a" },
  { value: "abcdefghijkl", placeholder: "hortus-secret-b" },
  { value: "xoxb-real", placeholder: "hortus-secret-slack" },
]);

test("values under 8 chars are not scrubbed", () => {
  assert.equal(s.text("a short word"), "a short word");
});

test("longest first when one value is a prefix of another", () => {
  assert.equal(s.text("x abcdefghijkl y abcdefgh z"), "x hortus-secret-b y hortus-secret-a z");
});

test("headers and bytes", () => {
  assert.deepEqual(s.headers({ a: "Bearer xoxb-real", b: ["xoxb-real", "n"] }), {
    a: "Bearer hortus-secret-slack",
    b: ["hortus-secret-slack", "n"],
  });
  const bin = Buffer.concat([Buffer.from([0xff, 0x00]), Buffer.from("xoxb-real"), Buffer.from([0xfe])]);
  assert.deepEqual(
    s.bytes(bin),
    Buffer.concat([Buffer.from([0xff, 0x00]), Buffer.from("hortus-secret-slack"), Buffer.from([0xfe])]),
  );
});

test("stream: a value straddling chunks is replaced; unrelated tails are not held back", async () => {
  const chunks = ["data: one\n\n", "data: xo", "xb-re", "al!\n\n", "data: abcdefgh", "ijkl\n\n"];
  const out = await text(Readable.from(chunks.map((c) => Buffer.from(c))).pipe(s.stream()));
  assert.equal(out, "data: one\n\ndata: hortus-secret-slack!\n\ndata: hortus-secret-b\n\n");

  // the first chunk has no secret prefix at its end: emitted at once
  const st = s.stream();
  const got: string[] = [];
  st.on("data", (c: Buffer) => got.push(c.toString()));
  st.write(Buffer.from("event\n\n"));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(got, ["event\n\n"]);
  st.end();
});

test("stream with onMatch errors instead of replacing", async () => {
  const st = s.stream(() => new Error("raw"));
  await assert.rejects(text(Readable.from([Buffer.from("x xoxb-"), Buffer.from("real y")]).pipe(st)), /raw/);
});
