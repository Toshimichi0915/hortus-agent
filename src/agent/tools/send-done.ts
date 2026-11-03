/**
 * `send` → outbox `reply`; `done` → outbox `result` (empty: no file, except in a run, where hortusd closes the run on an
 * empty result) and tells the loop to stop after this tool.
 */
import { type Tool, tool } from "@hortus/core";
import { z } from "zod";
import { writeOutbox } from "../outbox.ts";

export function sendDone(dir: string, onDone: (summary: string) => void, keepEmpty = false): Tool[] {
  return [
    tool({
      name: "send",
      description:
        "Post a note to the task card (progress, a question for the owner). Persists; does not end the task.",
      inputSchema: z.object({ text: z.string().min(1) }),
      execute: async ({ text }) => {
        writeOutbox(dir, "reply", text);
        return "sent";
      },
    }),
    tool({
      name: "done",
      description:
        "Finish the task. `summary` is the result (what was done, links, open points); an empty string reports nothing (use it when there was nothing to do). Call it alone, as your last tool call.",
      inputSchema: z.object({ summary: z.string() }),
      execute: async ({ summary }) => {
        if (summary || keepEmpty) writeOutbox(dir, "result", summary);
        onDone(summary);
        return "done";
      },
    }),
  ];
}
