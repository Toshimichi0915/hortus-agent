/** Feature `schedule`: `schedule` and `unschedule` over `schedule.set|unset`; hortusd validates. */
import { type Tool, tool } from "@hortus/core";
import { z } from "zod";
import type { TaskJson } from "../../types.ts";
import { taskRpc } from "../rpc.ts";

export function scheduleTools(task: TaskJson): Tool[] {
  return [
    tool({
      name: "schedule",
      description: `Set a timer for this task. Exactly one of \`at\` (ISO 8601 time, one-shot), \`every\` (seconds, ≥ 300) or \`cron\` (5 fields, evaluated in \`tz\`, IANA, default ${task.tz}). \`script\`: bash (≤ 16 KB) run before the model at each firing. Returns the id.`,
      inputSchema: z.object({
        text: z.string().min(1).describe("what to do when it fires"),
        at: z.string().optional(),
        every: z.number().int().optional(),
        cron: z.string().optional(),
        tz: z.string().optional(),
        script: z.string().optional(),
        ...(task.kind === "chat"
          ? {
              project: z
                .string()
                .optional()
                .describe(
                  `the project its runs work on (a name from your prompt's projects; default ${task.scope.project ?? "none"})`,
                ),
            }
          : {}),
      }),
      execute: async (input) => {
        const r = await taskRpc<{ id: number; fire_at: string; expires_at: string | null }>(
          task.rpc,
          "schedule.set",
          input,
        );
        return `scheduled: id ${r.id}, next fire ${r.fire_at}, ${r.expires_at ? `expires ${r.expires_at}` : "never expires"}`;
      },
    }),
    tool({
      name: "unschedule",
      description: "Remove a timer by id (in a run: the parent's timers).",
      inputSchema: z.object({ id: z.number().int() }),
      execute: async ({ id }) => {
        await taskRpc(task.rpc, "schedule.unset", { id });
        return `unscheduled ${id}`;
      },
    }),
  ];
}
