/** A run's script (v6 Schedules): bash in the schedule dir before the first model call, 1 h kill. */
import { spawn } from "node:child_process";
import { quote } from "./inbox.ts";

const STDOUT_MAX = 16 * 1024;
const STDERR_TAIL = 4 * 1024;

export interface ScriptResult {
  code: number | null;
  killed: boolean;
  stdout: string;
  stderr: string;
}

export function runScript(script: string, cwd: string, timeoutMs = 3600_000): Promise<ScriptResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", script], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length < STDOUT_MAX) stdout = Buffer.concat([stdout, d]).subarray(0, STDOUT_MAX);
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr = Buffer.concat([stderr, d]);
      if (stderr.length > STDERR_TAIL) stderr = stderr.subarray(-STDERR_TAIL);
    });
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try {
        process.kill(-(child.pid ?? 0), "SIGKILL"); // the whole group: the script's children too
      } catch {}
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, killed, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") });
    });
  });
}

/** The script's part of a run's first message, quoted as data. */
export function formatScript(r: ScriptResult, timeoutMs = 3600_000): string {
  const status = r.killed ? `killed after ${timeoutMs / 1000} s` : `exit ${r.code}`;
  const parts = [`[script] ${status}`, `stdout (first 16 KB):\n${quote(r.stdout)}`];
  if (r.killed || r.code !== 0) parts.push(`stderr (last 4 KB):\n${quote(r.stderr)}`);
  return parts.join("\n");
}
