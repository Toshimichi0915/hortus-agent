/** ctl/task.json, validated: hortusd writes it, but a bad file must fail loudly. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { TaskJson } from "../types.ts";

const Cookie = z.object({
  name: z.string(),
  value: z.string(),
  domain: z.string(),
  path: z.string(),
  expires: z.number().optional(),
  secure: z.boolean().optional(),
  httpOnly: z.boolean().optional(),
});

export const TaskSchema = z.object({
  id: z.string(),
  kind: z.enum(["chat", "unattended", "run", "planner"]),
  title: z.string(),
  brief: z.string(),
  scope: z.object({
    credentials: z.array(z.string()),
    repos: z.array(z.string()),
    project: z.string().optional(),
    dofs: z.array(z.string()).optional(),
  }),
  origins: z.union([z.literal("*"), z.array(z.string())]),
  budget: z.object({ usd: z.number().optional(), tokens: z.number().optional(), hours: z.number() }),
  price: z
    .object({ input: z.number(), cached: z.number(), cache_write: z.number().optional(), output: z.number() })
    .optional(),
  hours_used: z.number(),
  provider: z.string(),
  model: z.string(),
  effort: z.enum(["off", "low", "medium", "high", "xhigh", "max"]).optional(),
  context_window: z.number().int().positive(),
  tz: z.string(),
  paths: z.object({
    dof: z.string(),
    repos: z.string().optional(),
    work: z.string(),
    clone: z.string().optional(),
    schedule: z.string().optional(),
  }),
  clone_url: z.string().optional(),
  repo_urls: z.record(z.string(), z.string()).optional(),
  projects: z
    .record(z.string(), z.object({ path: z.string(), main: z.string(), runtime: z.enum(["host", "vm"]) }))
    .optional(),
  cwd: z.string().optional(),
  cookies: z.array(Cookie).optional(),
  script: z.string().optional(),
  rpc: z.string(),
  features: z.array(z.string()),
});

export function readTask(dir: string): TaskJson {
  const path = join(dir, "ctl", "task.json");
  try {
    return TaskSchema.parse(JSON.parse(readFileSync(path, "utf8"))) satisfies TaskJson;
  } catch (e) {
    throw new Error(`invalid ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
