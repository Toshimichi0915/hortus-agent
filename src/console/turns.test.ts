/** Rows to turns (turns.ts): a hostile row, and the finished turns kept while the last is rebuilt. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { str, toTurns, turnBuilder, type TurnRow } from "./turns.ts";

const row = (seq: number, body: unknown): TurnRow => ({ seq, body, created: null });

test("whatever a row holds, every text in a turn is a string", () => {
  let deep: unknown = 1;
  for (let i = 0; i < 200_000; i++) deep = [deep];
  const bodies = [
    "a raw line",
    42,
    null,
    [1, 2],
    { type: "made-up" },
    { type: "text", text: { a: 1 } },
    { type: "thinking", text: 7 },
    { type: "tool_call", id: 1, name: 2, input: deep },
    { type: "tool_result", id: 1, output: { o: 1 } },
    { type: "tool_result", id: "lost", output: null },
    { type: "status", text: ["s"] },
    { type: "error", message: { m: 1 } },
    { type: "owner", text: { t: 1 } },
    { type: "text", text: deep },
  ];
  const parts = toTurns(bodies.map((b, i) => row(i + 1, b))).flatMap((t) => t.parts);
  assert.equal(parts.length, 8);
  for (const p of parts) {
    if (p.kind === "tool") {
      assert.equal(typeof p.name, "string");
      assert.equal(typeof p.id, "string");
      assert.equal(typeof (p.output ?? ""), "string");
      assert.equal(typeof str(p.input), "string");
    } else assert.equal(typeof p.text, "string");
  }
  assert.equal(toTurns([row(1, "a raw line")])[0]?.parts[0]?.kind, "text");
});

test("the finished turns stay the same objects, and the whole equals one pass over the rows", () => {
  const rows: TurnRow[] = [];
  const build = turnBuilder();
  const push = (...bodies: unknown[]) => {
    for (const b of bodies) rows.push(row(rows.length + 1, b));
    return build([...rows]);
  };
  const text = (t: string) => ({ type: "text", text: t });
  const owner = (t: string) => ({ type: "owner", text: t });
  push(text("before any owner"), owner("one"), text("a"));
  push(text("b"), { type: "message", role: "assistant" }, text("c"));
  const a = push(owner("two"), text("d"));
  assert.deepEqual(a, toTurns(rows));
  const b = push(text("e"));
  assert.deepEqual(b, toTurns(rows));
  assert.equal(b.length, a.length);
  for (const i of [0, 1, 2]) assert.equal(b[i], a[i], `turn ${i} was rebuilt`);
  assert.notEqual(b.at(-1), a.at(-1));
  const c = push(owner("three"));
  assert.deepEqual(c, toTurns(rows));
  assert.equal(c[2], b[2]);
  assert.deepEqual(build([row(1, owner("another chat"))]), toTurns([row(1, owner("another chat"))]));
  assert.deepEqual(build([]), []);
});
