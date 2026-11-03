/**
 * Feature tool sets, enabled by name in task.json `features`. `merge` (3b), `schedule` (3c) and `browser` (3h) land
 * here as `<name>: (task) => Tool[]` without touching the loop.
 */
import type { Tool } from "@hortus/core";
import type { TaskJson } from "../../types.ts";
import { out } from "../stdout.ts";
import { browserTools } from "./browser.ts";
import { scheduleTools } from "./schedule.ts";

export const features: Record<string, (task: TaskJson) => Tool[]> = {
  schedule: scheduleTools,
  browser: (task) => browserTools(task),
};

/** Tools of every enabled feature; a name without a tool set yet is reported and skipped, not fatal. */
export function featureTools(task: TaskJson): Tool[] {
  return task.features.flatMap((name) => {
    const make = features[name];
    if (make) return make(task);
    out({ type: "error", message: `unknown feature in task.json: ${name}` });
    return [];
  });
}
