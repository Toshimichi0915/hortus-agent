/**
 * The task plugin: what a Worker is (its prompt and tools). How a run is observed (session, stdout, aborts) is the
 * loop's own plugin, shared with the planner kind (15-planner.md), which swaps only this one.
 */
import type { Plugin } from "@hortus/core";
import type { TaskJson } from "../types.ts";
import { prompt } from "./prompt.ts";
import { featureTools } from "./tools/index.ts";
import { sendDone } from "./tools/send-done.ts";

export function taskPlugin(task: TaskJson, dir: string, onDone: (summary: string) => void): Plugin {
  const system = prompt(task);
  return {
    tools: [...sendDone(dir, onDone), ...featureTools(task)],
    on: {
      // replaces core's builtin prompt (and anything earlier plugins pushed)
      session_start: ({ system: parts }) => void parts.splice(0, parts.length, system),
    },
  };
}
