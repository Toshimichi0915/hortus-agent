import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { Config } from "../config.ts";
import { fieldErrors, pageAt, pageWindow, SLACK } from "./forms.ts";

const FIELDS = ["worker.plugins", "worker.budget.tokens", "console.tls", "dofs.*", "origins"];

test("fieldErrors: settings.set's real issues land on the field they fall under", () => {
  const r = Config.safeParse({
    worker: { plugins: ["/ok", 5], budget: { tokens: "100" } },
    console: { listen: ":7443", tls: { cert: "/c" } },
    dofs: { slack: { type: 1 } },
    planner: { effort: "loud" },
  });
  assert.ok(!r.success);
  const e = fieldErrors(JSON.parse(JSON.stringify(r.error.issues)), FIELDS);
  assert.deepEqual(Object.keys(e).sort(), [
    "console.tls",
    "dofs.slack",
    "planner.effort", // no field: its own path, for Advanced
    "worker.budget.tokens",
    "worker.plugins",
  ]);
  assert.match(e["worker.budget.tokens"] ?? "", /number/);
});

test("fieldErrors: the first issue on a field wins; junk gives nothing", () => {
  const issues = [
    { path: ["worker", "plugins", 0], message: "first" },
    { path: ["worker", "plugins", 1], message: "second" },
    { path: [], message: "root" },
    { path: "worker", message: "not a path" },
    null,
  ];
  assert.deepEqual(fieldErrors(issues, FIELDS), { "worker.plugins": "first", "": "root" });
  assert.deepEqual(fieldErrors("boom", FIELDS), {});
  assert.deepEqual(fieldErrors(z.string().safeParse(1).error?.issues, []), {
    "": "Invalid input: expected string, received number",
  });
});

test("pageAt: page 2 holds still when rows land or leave above it", () => {
  // newest first: ids top-1 down to 0
  const list = (top: number, drop: number[] = []) =>
    Array.from({ length: top }, (_, i) => top - 1 - i).filter((x) => !drop.includes(x));
  const limit = 5;
  const skip = 5;
  const w = pageWindow(skip, limit);
  assert.deepEqual(w, { skip: 0, limit: limit + 2 * SLACK });
  const at = (rows: number[], anchor?: number) =>
    pageAt(rows.slice(w.skip, w.skip + w.limit), skip, limit, (x) => x, anchor);
  // opened on 99..0: page 2 is 94..90
  const first = at(list(100));
  assert.deepEqual(first, { rows: [94, 93, 92, 91, 90], more: true });
  // two rows land on top, then one above the page leaves: still 94..90
  assert.deepEqual(at(list(102), 94).rows, [94, 93, 92, 91, 90]);
  assert.deepEqual(at(list(102, [97]), 94).rows, [94, 93, 92, 91, 90]);
  // the anchor itself left: from skip again
  assert.deepEqual(at(list(100, [94]), 94).rows, [93, 92, 91, 90, 89]);
  // more landed at once than the window has room for: from skip
  assert.deepEqual(at(list(100 + 2 * SLACK + 1), 94).rows, [115, 114, 113, 112, 111]);
  // an anchor the window holds without a full page after it: from skip, not a short page
  assert.deepEqual(at(list(100 + 2 * SLACK - 2), 94).rows, [112, 111, 110, 109, 108]);
  // page 1 never anchors: new rows show
  assert.deepEqual(pageAt(list(102), 0, limit, (x) => x, 99).rows, [101, 100, 99, 98, 97]);
  // the last page
  assert.deepEqual(
    pageAt(list(8), 5, limit, (x) => x),
    { rows: [2, 1, 0], more: false },
  );
  // a later page's window starts SLACK before it
  assert.deepEqual(pageWindow(50, 50), { skip: 40, limit: 70 });
  assert.deepEqual(pageAt(list(200).slice(40, 110), 50, 50, (x) => x).rows[0], 149);
});
