import assert from "node:assert/strict";
import { test } from "node:test";
import { plannerPlugin } from "../agent/planner-plugin.ts";
import { Config } from "../config.ts";
import type { Ctx } from "../ctx.ts";
import { openDb } from "../db.ts";
import { logger } from "../log.ts";
import { tempDir } from "../test/until.ts";
import type { TaskJson } from "../types.ts";
import { renderBatch, renderEvent } from "./planner.ts";

test("renderEvent: a stranger's burst costs the batch 500 characters each; the owner's and a brief's text stay whole", () => {
  const c = Config.parse({ dofs: { slack: { type: "slack", owner: "U1" } } });
  const e = { id: 1, dof: "slack", key: "k", ts: "t", refs: null, task_id: null, summary: "x".repeat(2000) };
  assert.equal(renderEvent(c, { ...e, author: "U2", trusted: 0 }).match(/x/g)?.length, 500);
  assert.equal(renderEvent(c, { ...e, author: "U1", trusted: 1 }).match(/x/g)?.length, 2000);
});

test("renderBatch: a request no open task counts (a merge outliving its task) is in the total", () => {
  const db = openDb(`${tempDir("hortus-batch-")}/db.sqlite`);
  const c = { config: Config.parse({}), db, log: logger } as unknown as Ctx;
  assert.doesNotMatch(renderBatch(c, [], []), /waiting for the owner/);
  db.prepare(
    "INSERT INTO approvals(kind, category, status, requested_at) VALUES ('request', 'merge', 'pending', 't')",
  ).run();
  assert.match(renderBatch(c, [], []), /1 approval waiting for the owner in all/);
});

test("a follow-up's tag names a closed task's project; the prompt names the DOF root its hits are under", () => {
  const db = openDb(`${tempDir("hortus-batch-")}/db.sqlite`);
  const c = { config: Config.parse({}), db, log: logger } as unknown as Ctx;
  db.prepare(
    "INSERT INTO tasks(id, kind, title, brief, status, project) VALUES ('T', 'unattended', 't', 'b', 'done', 'p')",
  ).run();
  db.prepare("INSERT INTO task_refs(ref, task_id) VALUES ('s:c:1', 'T')").run();
  const e = {
    id: 1,
    dof: "s",
    key: "k",
    ts: "t",
    author: "U",
    trusted: 1,
    summary: "x",
    refs: '["s:c:1"]',
    task_id: null,
  };
  assert.match(renderBatch(c, [e], []), /matches task T \(done, project p\)/);
  const system: string[] = [];
  const start = plannerPlugin({ paths: { dof: "/d/dof" } } as TaskJson).on?.session_start as (a: unknown) => void;
  start({ system });
  assert.match(system.join(), /hits are under: \/d\/dof/);
  // reviews and CI reach a PR's task only while it is open
  assert.match(system.join(), /not complete while that stays open/);
});
