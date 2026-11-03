/**
 * The two tool-less calls (v7 Process): the summary after the loop and the handoff note when the context fills.
 * Direct `provider.complete` with `tools: []`, because core's `run` always passes every tool.
 */
import type { Agent, Message } from "@hortus/core";
import { writeAtomic } from "../mirror/repo.ts";
import type { TaskJson } from "../types.ts";

export const SUMMARY_PROMPT = `You write the record of an agent's task for its owner. From the conversation, write about 200 words of Markdown with exactly these sections:

## Goal
## Outcome
## Decisions
## Open points

Facts only: what was asked, what was done (with links, file paths, ids), what was decided and why, what is left. No preamble.`;

export const HANDOFF_PROMPT = `The conversation is about to be cut because the context window is full. Write PROGRESS.md for the agent that continues the task in a fresh context with only the task brief and this file. Markdown, as short as complete allows:

## Done
## State (files, branches, ids, pending approvals, anything to re-check)
## Next steps
## Notes (decisions, dead ends, facts learned that are expensive to rediscover)

No preamble.`;

async function complete(agent: Agent, task: TaskJson, system: string, messages: Message[]): Promise<string> {
  const { provider, model } = await agent.resolve({ provider: task.provider, model: task.model });
  const reply = await provider.complete(
    {
      model,
      system,
      // ends on a user turn whatever the last message was
      messages: [...messages, { role: "user", content: "Write it now, as instructed." }],
      tools: [],
      ...(task.effort && { effort: task.effort }),
    },
    () => {},
    () => {},
  );
  return reply.text.trim();
}

export async function summarize(agent: Agent, task: TaskJson, messages: Message[], path: string): Promise<void> {
  writeAtomic(path, `${await complete(agent, task, SUMMARY_PROMPT, messages)}\n`);
}

/** Writes PROGRESS.md and returns it. */
export async function handoff(agent: Agent, task: TaskJson, messages: Message[], path: string): Promise<string> {
  const text = await complete(agent, task, HANDOFF_PROMPT, messages);
  writeAtomic(path, `${text}\n`);
  return text;
}
