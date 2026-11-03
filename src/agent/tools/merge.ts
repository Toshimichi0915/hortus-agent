/** Feature `merge` (3b): `merge()` asks hortusd to merge `hortus/<task>` into the project's `main` (an approval). */
import { type Tool, tool } from "@hortus/core";
import { z } from "zod";
import type { TaskJson } from "../../types.ts";
import { taskRpc } from "../rpc.ts";

export const merge = (task: TaskJson): Tool[] => [
  tool({
    name: "merge",
    description: `Ask the owner to merge hortus/${task.id} (as pushed to the origin) into main. Commit and push first, in an earlier tool call (calls in one batch run concurrently). Returns the approval id; end your turn and wait: the result arrives in your inbox as from=merge ("merged <sha>" or why it did not land) or from=rebase (main moved: fetch, rebase, force-push, call merge again).`,
    inputSchema: z.object({}),
    execute: async () => {
      try {
        const r = await taskRpc<{ approval: number }>(task.rpc, "merge", {});
        return `merge requested: approval ${r.approval} pending; end your turn and wait for the decision in your inbox`;
      } catch (e) {
        return `merge refused: ${(e as Error).message}`;
      }
    },
  }),
];
