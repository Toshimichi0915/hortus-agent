/**
 * Round 8: does the live Planner scope `scope.dofs` narrowly (HORTUS_TEST_LLM=1, `HORTUS_TEST_MODEL`)? The real
 * planner prompt and tools, live DeepSeek through ollama.com (the key copied into the temp ctl/home, as live.test.ts),
 * one batch of the owner's requests; the verdict RPCs go to a recording stand-in for hortusd.internal. Only two events
 * need a DOF (a thread's history, a search of past messages); every other task must get none. Prints `# planner …`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { run, setup } from "./testkit.ts";

const live = process.env.HORTUS_TEST_LLM === "1";
const MODEL = process.env.HORTUS_TEST_MODEL ?? "deepseek-v4.1-flash:1017";

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
none`;
/** the events whose task needs a DOF beyond the brief */
const NEEDS = new Set(["e3", "e5"]);
/** an issue comment: its other comments are arguably context (the prompt allows it), so either choice passes */
const MAY = new Set(["e7"]);

test("live Planner: scope.dofs only where the task needs more than the brief", {
  skip: !live,
  timeout: 300_000,
}, async () => {
  const created: { event_ids: string[]; scope?: { dofs?: string[] } }[] = [];
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
  const key = all["ollama-cloud"];
  assert.ok(key, "ollama-cloud missing from ~/.hortus/secrets.json");
  const secrets = { "ollama-cloud": { type: "openai", endpoint: "https://ollama.com/v1", apiKey: key.apiKey } };
  const dir = setup(
    {
      id: "planner-1",
      kind: "planner",
      title: "planner batch #1, 7 events",
      brief: BATCH,
      provider: "ollama-cloud",
      model: MODEL,
      context_window: 131072,
      rpc: `http://127.0.0.1:${(rpc.address() as { port: number }).port}`,
      scope: { credentials: [], repos: [], dofs: ["logs", "transforms", "slack", "github"] },
    },
    secrets,
    { provider: "ollama-cloud", model: MODEL },
  );
  try {
    const r = await run(dir, undefined, 240_000);
    assert.equal(r.code, 0, r.stderr + r.stdout.slice(-2000));
  } finally {
    rpc.close();
  }
  const choices = created.map((c) => `${c.event_ids.join("+")}:${JSON.stringify(c.scope?.dofs ?? [])}`);
  const wide = created.filter(
    (c) => (c.scope?.dofs ?? []).length && !c.event_ids.some((e) => NEEDS.has(e) || MAY.has(e)),
  );
  const missed = created.filter((c) => c.event_ids.some((e) => NEEDS.has(e)) && !(c.scope?.dofs ?? []).length);
  console.log(
    `# planner (${MODEL}): ${created.length} tasks, scope.dofs ${choices.join(" ")}; ${wide.length} wider than needed, ${missed.length} without a needed DOF`,
  );
  assert.ok(created.length >= 5, choices.join(" "));
  assert.deepEqual(wide, [], "a DOF given where the brief was enough");
});
