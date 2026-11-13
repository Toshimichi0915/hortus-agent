/** Rows to turns (turns.ts): a hostile row, and the finished turns kept while the last is rebuilt. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { contextOf, progress, str, type TurnRow, toTurns, turnBuilder } from "./turns.ts";

const row = (seq: number, body: unknown): TurnRow => ({ seq, body, created: null });

test("context rows: the newest well-formed one counts, and none of them makes a turn", () => {
  const rows = [
    row(1, { type: "context", tokens: 10, window: 100 }),
    row(2, { type: "owner", text: "hi" }),
    row(3, { type: "context", tokens: 20, window: 100 }),
    row(4, { type: "context", tokens: "20", window: 0 }),
    row(5, null),
  ];
  assert.deepEqual(contextOf(rows), { tokens: 20, window: 100 });
  assert.equal(contextOf([row(1, { type: "context", tokens: 1, window: 0 })]), undefined);
  assert.deepEqual(
    toTurns(rows.slice(0, 4)).map((t) => t.role),
    ["user"],
  );
});

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
  // older rows put in front (the page scrolled back) join the turn they cut
  const tail = rows.slice(1);
  build(tail);
  assert.deepEqual(build(rows), toTurns(rows));
  assert.deepEqual(build([row(1, owner("another chat"))]), toTurns([row(1, owner("another chat"))]));
  assert.deepEqual(build([]), []);
});

test("done's summary is the turn's text", () => {
  const [t] = toTurns([row(1, { type: "tool_call", id: "c", name: "done", input: { summary: "おはようございます" } })]);
  assert.deepEqual(
    t?.parts.filter((p) => p.kind === "text").map((p) => p.kind === "text" && p.text),
    ["おはようございます"],
  );
});

test("a live turn's progress: its time and commands since its last output", () => {
  const at = (created: string, body: unknown): TurnRow => ({ seq: 1, body, created });
  const bash = { type: "tool_call", id: "c", name: "bash", input: { command: "ls" } };
  const [t] = toTurns([
    at("2026-01-01T00:00:00.000Z", bash),
    at("2026-01-01T00:00:01.000Z", { type: "text", text: "a reply between runs" }),
    at("2026-01-01T00:00:02.000Z", { type: "thinking", text: "hm" }),
    at("2026-01-01T00:00:03.000Z", bash),
    at("2026-01-01T00:00:04.000Z", bash),
    at("2026-01-01T00:00:05.000Z", { type: "tool_call", id: "r", name: "read", input: {} }),
  ]);
  assert.ok(t);
  const steps = t.parts.slice(t.parts.findIndex((p) => p.kind === "text") + 1);
  const after = (ms: number) => Date.parse("2026-01-01T00:00:01.000Z") + ms;
  assert.equal(progress(t, steps, after(59_000)), "59s · 2 commands");
  assert.equal(progress(t, steps, after(12 * 60_000 + 30_000)), "12m 30s · 2 commands");
  assert.equal(progress(t, steps, after(72 * 60_000 + 30_000)), "1h 12m 30s · 2 commands");
  assert.equal(progress(t, steps, after(60 * 60_000)), "1h 0m 0s · 2 commands");
  assert.equal(progress(t, steps, after(-5000)), "0s · 2 commands", "a client clock behind the daemon's");
  const [first] = toTurns([at("2026-01-01T00:00:00.000Z", bash)]);
  assert.ok(first);
  assert.equal(progress(first, first.parts, after(-1000)), "0s · 1 command", "no output yet: from the turn's start");
  assert.equal(progress({ ...t, since: null }, [], after(0)), "");
});
