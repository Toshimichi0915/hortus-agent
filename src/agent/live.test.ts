/** Live DeepSeek through ollama.com (opt-in: HORTUS_TEST_LLM=1). The key is copied into the temp ctl/home only. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { outbox, run, sessionFiles, setup, writeInbox } from "./testkit.ts";

const live = process.env.HORTUS_TEST_LLM === "1";
const MODEL = "deepseek-v4.1-flash:1017";

function liveTask(brief: string): string {
  const all = JSON.parse(readFileSync(join(homedir(), ".hortus", "secrets.json"), "utf8"));
  const key = all["ollama-cloud"];
  assert.ok(key, "ollama-cloud missing from ~/.hortus/secrets.json");
  const secrets = { "ollama-cloud": { type: "openai", endpoint: "https://ollama.com/v1", apiKey: key.apiKey } };
  return setup({ provider: "ollama-cloud", model: MODEL, brief, context_window: 131072 }, secrets, {
    provider: "ollama-cloud",
    model: MODEL,
  });
}

test("live: list the work dir, done with the count, a short summary", { skip: !live, timeout: 300_000 }, async () => {
  const dir = liveTask("List the files in your work dir and call done with their count.");
  for (const n of ["a.txt", "b.txt", "c.txt"]) writeFileSync(join(dir, "out", "work", n), n);
  const r = await run(dir, undefined, 240_000);
  assert.equal(r.code, 0, r.stderr + r.stdout.slice(-2000));
  const result = outbox(dir).find((m) => m.type === "result");
  assert.ok(result, "no result");
  assert.match(result.text, /3|three/i);
  const summary = readFileSync(join(dir, "out", "summary.md"), "utf8");
  assert.ok(summary.split(/\s+/).filter(Boolean).length < 300, summary);
  console.log(`result: ${result.text}\n--- summary.md ---\n${summary}`);
});

test("live: an inbox message mid-run ends it within one tool call", { skip: !live, timeout: 300_000 }, async () => {
  const dir = liveTask(
    "Run the bash command `sleep 2` ten times, as ten separate bash tool calls, one per turn. Then call done with 'finished'.",
  );
  let sent = false;
  const r = await run(
    dir,
    (l) => {
      if (l.type === "tool_result" && !sent) {
        sent = true;
        writeInbox(dir, { seq: 1, from: "owner", trusted: true, text: "stop, call done now" });
      }
    },
    240_000,
  );
  assert.equal(r.code, 0, r.stderr + r.stdout.slice(-2000));
  const msgs = sessionFiles(dir)[0]?.messages ?? [];
  const i = msgs.findIndex((m) => m.content?.startsWith("[inbox 1]"));
  assert.ok(i > 0, "inbox never delivered");
  const next = msgs.slice(i).find((m) => m.role === "assistant") as unknown as { toolCalls: { name: string }[] };
  assert.deepEqual(
    next.toolCalls.map((c) => c.name),
    ["done"],
  );
  assert.ok(outbox(dir).some((m) => m.type === "result"));
  const bashCalls = r.lines.filter((l) => l.type === "tool_call" && l.name === "bash").length;
  console.log(`bash calls before stopping: ${bashCalls}; inbox delivered after message ${i}`);
});
