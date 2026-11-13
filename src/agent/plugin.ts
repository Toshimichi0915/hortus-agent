/**
 * The task plugin: what a Worker is (its prompt and tools). How a run is observed (session, stdout, aborts) is the
 * loop's own plugin, shared with the planner kind, which swaps only this one.
 */
import { agentsMdPrompt, loadAgentsMd, type Plugin } from "@hortus/core";
import type { TaskJson } from "../types.ts";
import { prompt } from "./prompt.ts";
import { featureTools } from "./tools/index.ts";
import { sendDone } from "./tools/send-done.ts";

/** Where the task's project is: an unattended task's clone; in a chat, the owner's shell when it is inside one of the
 * projects (the one they mean), else the chat's project. Undefined without one. */
export function projectDir(task: TaskJson): string | undefined {
  if (task.kind !== "chat") return task.paths.clone;
  const { cwd } = task;
  const projects = Object.values(task.projects ?? {});
  if (cwd && projects.some((p) => cwd === p.path || cwd.startsWith(`${p.path}/`))) return cwd;
  return task.scope.project ? task.projects?.[task.scope.project]?.path : undefined;
}

export function taskPlugin(task: TaskJson, dir: string, onDone: (summary: string) => void): Plugin {
  const system = prompt(task);
  const project = projectDir(task);
  return {
    tools: [...sendDone(dir, onDone, task.kind === "run"), ...featureTools(task)],
    on: {
      // replaces core's builtin prompt (and anything earlier plugins pushed). The project's AGENTS.md files (its root
      // down to the directory) follow, read every run like core's, so an edit is in the next turn (and a clone made
      // in the first is too); without a project, core's preamble alone tells the model to look for them where it works.
      // One the sandbox hides (EACCES) is left out, not a failed session
      prompt: async ({ system: parts }) => {
        const agentsMd = project ? await loadAgentsMd(project).catch(() => []) : [];
        parts.splice(0, parts.length, system, agentsMdPrompt(agentsMd));
      },
    },
  };
}
