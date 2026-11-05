import assert from "node:assert/strict";
import { test } from "node:test";
import { Config } from "../config.ts";
import { renderEvent } from "./planner.ts";

test("renderEvent: a stranger's burst costs the batch 500 characters each; the owner's and a brief's text stay whole", () => {
  const c = Config.parse({ dofs: { slack: { type: "slack", owner: "U1" } } });
  const e = { id: 1, dof: "slack", key: "k", ts: "t", refs: null, task_id: null, summary: "x".repeat(2000) };
  assert.equal(renderEvent(c, { ...e, author: "U2", trusted: 0 }).match(/x/g)?.length, 500);
  assert.equal(renderEvent(c, { ...e, author: "U1", trusted: 1 }).match(/x/g)?.length, 2000);
});
