/**
 * Does the live Planner scope `scope.dofs` narrowly (HORTUS_TEST_LLM=1, `HORTUS_TEST_MODEL`)? The real
 * planner prompt and tools, live DeepSeek through openrouter.ai (the key copied into the temp ctl/home, as live.test.ts),
 * one batch of the owner's requests; the verdict RPCs go to a recording stand-in for hortusd.internal. Only two events
 * need a DOF (a thread's history, a search of past messages); every other task should get none. Prints `# planner …`.
 *
 * A tally over RUNS batches, not one batch: the model hands a DOF to about 1 unneeded task in 25 with this
 * prompt ("reply to bob" so as to read the channel, "remind me" so as to confirm in the thread), and to 1 in 5 without
 * its rule, so one batch failed 1 run in 4 and told nobody anything. The bound sits between the two rates.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { run, setup } from "./testkit.ts";

const live = process.env.HORTUS_TEST_LLM === "1";
const MODEL = process.env.HORTUS_TEST_MODEL ?? "deepseek/deepseek-v4.1-flash-1017";

const owner = (id: number, ref: string, text: string) =>
  `- [e${id}] ${ref} (owner, trusted) at 2026-11-04T09:0${id}:00Z\nmessage in D1 by alice: ${text}`;
const BATCH = `## Events
${[
  owner(1, "slack:D1:1762246800.000100", "post 'standup moved to 10:30' in #general"),
  owner(2, "slack:D1:1762246860.000100", "remind me tomorrow at 9 to call the bank"),
  owner(
    3,
    "slack:D1:1762246920.000100",
    "summarize the long thread in #general from yesterday about the release, for me",
  ),
  owner(4, "slack:D1:1762246980.000100", "reply to bob in #general: yes, we ship on Friday"),
  owner(5, "slack:D1:1762247040.000100", "what did we decide about pricing last month? search our slack and tell me"),
  owner(6, "slack:D1:1762247100.000100", "open an issue on o/r titled 'flaky CI on main'"),
].join("\n")}
- [e7] github:o/r#12 (owner, trusted) at 2026-11-04T09:07:00Z
issue_comment.created o/r#12 by toshi: please fix the typo in the README

## Results
none

## Open tasks
none

## Projects
none`;
/** the events whose task needs a DOF beyond the brief */
const NEEDS = new Set(["e3", "e5"]);
/** an issue comment: its other comments are arguably context (the prompt allows it), so either choice passes */
const MAY = new Set(["e7"]);

const RUNS = 5;
/** of RUNS × 5 unambiguous tasks; at 1 in 25 this fails about 1 tally in 50, at 1 in 5 it passes about 1 in 4 */
const MAX_WIDE = 3;

interface Created {
  event_ids: string[];
  scope?: { dofs?: string[] };
}

async function batch(): Promise<Created[]> {
  const created: Created[] = [];
  const rpc = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      const method = req.url?.replace("/rpc/", "") ?? "";
      const input = JSON.parse(body || "{}");
      let result: unknown = { ok: true };
      if (method === "task_create") {
        created.push(input);
        result = { id: `T${created.length}`, runtime: "host" };
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ result }));
    });
  });
  await new Promise<void>((r) => rpc.listen(0, "127.0.0.1", r));
  const all = JSON.parse(readFileSync(join(homedir(), ".hortus", "secrets.json"), "utf8"));
  const key = all.openrouter;
  assert.ok(key, "openrouter missing from ~/.hortus/secrets.json");
  const secrets = { openrouter: { type: "openai", endpoint: "https://openrouter.ai/api/v1", apiKey: key.apiKey } };
  const dir = setup(
    {
      id: "planner-1",
      kind: "planner",
      title: "planner batch #1, 7 events",
      brief: BATCH,
      provider: "openrouter",
      model: MODEL,
      context_window: 131072,
      rpc: `http://127.0.0.1:${(rpc.address() as { port: number }).port}`,
      scope: { credentials: [], repos: [], dofs: ["logs", "transforms", "slack", "github"] },
    },
    secrets,
    { provider: "openrouter", model: MODEL },
  );
  try {
    const r = await run(dir, undefined, 240_000);
    assert.equal(r.code, 0, r.stderr + r.stdout.slice(-2000));
  } finally {
    rpc.close();
  }
  return created;
}

test("live Planner: scope.dofs only where the task needs more than the brief", {
  skip: !live,
  timeout: 300_000,
}, async () => {
  const runs = await Promise.all(Array.from({ length: RUNS }, batch));
  const choices = runs.map((r) => r.map((c) => `${c.event_ids.join("+")}:${JSON.stringify(c.scope?.dofs ?? [])}`));
  const all = runs.flat();
  const wide = all.filter((c) => (c.scope?.dofs ?? []).length && !c.event_ids.some((e) => NEEDS.has(e) || MAY.has(e)));
  const missed = all.filter((c) => c.event_ids.some((e) => NEEDS.has(e)) && !(c.scope?.dofs ?? []).length);
  for (const c of choices) console.log(`# planner (${MODEL}): ${c.length} tasks, scope.dofs ${c.join(" ")}`);
  console.log(`# planner tally: ${wide.length} wider than needed, ${missed.length} without a needed DOF, ${RUNS} runs`);
  for (const c of choices) assert.ok(c.length >= 5, c.join(" "));
  assert.ok(wide.length <= MAX_WIDE, `${wide.length} DOFs given where the brief was enough: ${JSON.stringify(wide)}`);
  assert.ok(missed.length <= 1, `${missed.length} tasks without a DOF they need: ${JSON.stringify(missed)}`);
});
