/** Feature `settings`: `propose_settings()` asks the owner to change hortusd.json (an approval they always decide). */
import { type Tool, tool } from "@hortus/core";
import { z } from "zod";
import type { TaskJson } from "../../types.ts";
import { taskRpc } from "../rpc.ts";

export const settings = (task: TaskJson): Tool[] => [
  tool({
    name: "propose_settings",
    description: `Ask the owner to change hortus's own settings (hortusd.json), when they asked for it or agreed to it. \`patch\` is a JSON Merge Patch: objects merge key by key, null deletes a key, an array replaces the whole array. Keys: owner.{tz,notify}, planner.{provider,model,effort,batch_max,daily_usd,runtime}, worker.{provider,model,effort,budget.{usd,hours},credentials,context_window,plugins}, prices.<provider>.<model>.{input,cached,cache_write,output} (dollars per million tokens; a model with no price at the Workers' provider has no spending limit), vm.{cpus,mem_mb,max_concurrent,boot_timeout_s,fallback_host}, chat.allow, origins, proxy.{https,http,dns}, policy (category → "human" | "auto", plus deny/cache/read paths), judge_notes, dofs.<name>, projects.<name>. A directory it names (projects.<name>.path, worker.plugins, a files DOF's path) must already exist, be absolute and lie outside hortus's own directories (never your scratch directory). An invalid patch is refused at once with the field named. Otherwise the owner sees the diff and approves, edits or rejects it: end your turn and wait for the decision in your inbox (from=approval).`,
    inputSchema: z.object({
      patch: z.record(z.string(), z.unknown()),
      reason: z.string().describe("one or two sentences for the owner: what this changes and why"),
    }),
    execute: async (input) => {
      try {
        const r = await taskRpc<{ approval: number | null; paths?: string[]; message?: string }>(
          task.rpc,
          "settings.propose",
          input,
        );
        if (r.approval === null) return r.message ?? "already approved";
        return `proposed (${r.paths?.join(", ")}): approval ${r.approval} pending; end your turn and wait for the decision in your inbox`;
      } catch (e) {
        return `proposal refused: ${(e as Error).message}`;
      }
    },
  }),
];
