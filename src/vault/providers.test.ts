import assert from "node:assert/strict";
import { test } from "node:test";
import { textCapped } from "./providers.ts";

test("textCapped: stops reading a body without end at the cap, in bytes", async () => {
  let pulled = 0;
  const endless = new ReadableStream({
    pull(c) {
      pulled++;
      c.enqueue(new Uint8Array(1024));
    },
  });
  await assert.rejects(textCapped(new Response(endless), 4096), /too long/);
  assert.ok(pulled < 10, `read ${pulled} chunks`);

  assert.equal(await textCapped(new Response("é"), 2), "é");
  await assert.rejects(textCapped(new Response("é"), 1), /too long/, "two bytes, one character");
  assert.equal(await textCapped(new Response(null), 1), "");
});
