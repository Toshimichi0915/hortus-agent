/** One JSON line per entry on stderr (journald picks it up). */
import type { Log } from "./types.ts";

function write(level: "info" | "error", scope: string, msg: string, data?: Record<string, unknown>): void {
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), level, scope, msg, ...data })}\n`);
}

export const log = (scope: string, msg: string, data?: Record<string, unknown>): void =>
  write("info", scope, msg, data);

export function logger(scope: string): Log {
  return {
    info: (msg, data) => write("info", scope, msg, data),
    error: (msg, err, data) =>
      write("error", scope, msg, {
        ...data,
        ...(err === undefined ? {} : { error: err instanceof Error ? (err.stack ?? err.message) : String(err) }),
      }),
  };
}
