/** Test helpers: a temp task directory and the real binary as a child process. Not loaded by the agent itself. */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "../test/until.ts";
import type { OutboxMsg, StdoutLine, TaskJson } from "../types.ts";

const BIN = fileURLToPath(new URL("../bin/hortus-agent.js", import.meta.url));

/**
 * The fake provider: `complete()` records every request to `<task>/fake-requests.jsonl` and plays
 * `<task>/fake-script.json` turn by turn (requests with tools only; tool-less ones, the summary and the handoff, answer
 * "notes from fake"). A turn: `{ text?, calls?: [{ name, input }], usage?, throw?, kill?, inbox?: InboxMsg, delay? }`.
 */
const FAKE = `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const dir = fileURLToPath(new URL("../../../../../", import.meta.url));
const reqs = dir + "fake-requests.jsonl";
const complete = async (req, cb) => {
  const done = existsSync(reqs) ? readFileSync(reqs, "utf8").split("\\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const n = done.filter((r) => r.tools.length).length;
  appendFileSync(reqs, JSON.stringify({ system: req.system, messages: req.messages.map(({ entryId, ...m }) => m), tools: req.tools.map((t) => t.name),
    effort: req.effort, home: process.env.HOME, cwd: process.cwd() }) + "\\n");
  if (!req.tools.length) return { role: "assistant", text: "notes from fake", toolCalls: [], usage: { input: 7, output: 3, cacheRead: 0 } };
  const script = JSON.parse(readFileSync(dir + "fake-script.json", "utf8"));
  const t = script[n] ?? { text: "idle" };
  if (t.inbox) writeFileSync(dir + "ctl/inbox/" + String(t.inbox.seq).padStart(6, "0") + ".json", JSON.stringify(t.inbox));
  if (t.delay) await new Promise((r) => setTimeout(r, t.delay));
  if (t.kill) process.kill(process.pid, "SIGKILL");
  if (t.throw) throw new Error(t.throw);
  if (t.text) cb?.text?.(t.text);
  return {
    role: "assistant",
    text: t.text ?? "",
    toolCalls: (t.calls ?? []).map((c, i) => ({ id: "c" + n + "_" + i, name: c.name, input: c.input })),
    usage: { input: 10, output: 5, cacheRead: 0, ...t.usage },
  };
};
export default { providers: { fake: { create: () => ({ complete, listModels: async () => ["m"] }) } } };
`;

export interface Turn {
  text?: string;
  calls?: { name: string; input: unknown }[];
  usage?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  throw?: string;
  kill?: boolean;
  inbox?: Record<string, unknown>;
  delay?: number;
}

// removed at exit: live tests put a real key in them
const dirs: string[] = [];
process.on("exit", () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const json = (path: string, v: unknown) => writeFileSync(path, JSON.stringify(v, null, 2));

/** A task dir with `ctl/home` (config, secrets, plugins) and a real-HOME stand-in at `<dir>/realhome`. */
export function setup(task: Partial<TaskJson> = {}, secrets?: unknown, config?: unknown): string {
  const dir = tempDir("hortus-agent-");
  dirs.push(dir);
  const h = join(dir, "ctl", "home", ".hortus");
  for (const d of ["ctl/inbox", "out/work", "realhome", "schedule"]) mkdirSync(join(dir, d), { recursive: true });
  mkdirSync(join(h, "plugins", "fake"), { recursive: true });
  json(join(h, "config.json"), config ?? { provider: "fake", model: "m" });
  json(join(h, "secrets.json"), secrets ?? { fake: { type: "fake", apiKey: "x" } });
  json(join(h, "plugins", "fake", "hortus.json"), { name: "fake", version: "1.0.0", entrypoint: "fake.mjs" });
  writeFileSync(join(h, "plugins", "fake", "fake.mjs"), FAKE);
  const full: TaskJson = {
    id: "t1",
    kind: "unattended",
    title: "Test task",
    brief: "Do the test thing.",
    scope: { credentials: [], repos: [] },
    origins: [],
    budget: { usd: 1_000_000, hours: 10 },
    hours_used: 0,
    provider: "fake",
    model: "m",
    context_window: 100_000,
    tz: "Asia/Tokyo",
    paths: { dof: join(dir, "dof"), work: join(dir, "out", "work"), schedule: join(dir, "schedule") },
    rpc: "https://hortusd.internal",
    features: [],
    ...task,
  };
  json(join(dir, "ctl", "task.json"), full);
  return dir;
}

export const script = (dir: string, turns: Turn[]) => json(join(dir, "fake-script.json"), turns);

export interface Run {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  lines: StdoutLine[];
  stderr: string;
}

/** Runs the binary to its exit; `onLine` sees each stdout line as it arrives. */
export function run(dir: string, onLine?: (l: StdoutLine) => void, timeoutMs = 60_000): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, "--task", dir], {
      env: { ...process.env, HOME: join(dir, "realhome") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let buf = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d;
      buf += d;
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
        if (onLine) onLine(JSON.parse(line));
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const lines = stdout
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as StdoutLine);
      resolve({ code, signal, stdout, lines, stderr });
    });
  });
}

export interface Recorded {
  system: string;
  messages: { role: string; content?: string; text?: string; results?: { output: string; isError?: boolean }[] }[];
  tools: string[];
  home: string;
  cwd: string;
}

export function requests(dir: string): Recorded[] {
  const p = join(dir, "fake-requests.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

export function outbox(dir: string): OutboxMsg[] {
  const box = join(dir, "out", "outbox");
  if (!existsSync(box)) return [];
  return readdirSync(box)
    .filter((n) => /^\d{6}\.json$/.test(n))
    .sort()
    .map((n) => JSON.parse(readFileSync(join(box, n), "utf8")));
}

export function writeInbox(
  dir: string,
  msg: { seq: number; from: string; author?: string; trusted: boolean; text: string },
): void {
  const name = `${String(msg.seq).padStart(6, "0")}.json`;
  json(join(dir, "ctl", "inbox", name), { ts: new Date().toISOString(), ...msg });
}

/** Messages of every session file, newest file last. */
export function sessionFiles(dir: string): { name: string; messages: { role: string; content?: string }[] }[] {
  const s = join(dir, "out", "sessions");
  return readdirSync(s)
    .filter((n) => n.endsWith(".jsonl"))
    .map((n) => ({ name: n, text: readFileSync(join(s, n), "utf8") }))
    .map(({ name, text }) => ({
      name,
      messages: text
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .filter((e) => e.type === "message")
        .map((e) => e.message),
    }));
}
