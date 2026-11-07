/** The console's text helpers with no node imports, so web/ shares them: `parse`, `line`, `tokens`, `PAUSED`, `errorLine`. */
export function parse<T = unknown>(text: string | null | undefined): T | undefined {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

/** A `replies` body (the Worker's stdout line) as JSON when it serializes back, else its text: a line nested a million
 * deep parses but throws in the response's JSON.stringify, which made the task's card unreadable. */
export function line(body: string): unknown {
  const v = parse(body);
  try {
    JSON.stringify(v);
    return v ?? body;
  } catch {
    return body;
  }
}

export function tokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

/** What `PAUSED` does (dispatcher, schedules tick, Planner wake), as the CLI says it. */
export const PAUSED = "queued tasks, schedules and the Planner wait; running tasks go on.";

/** A task error's headline: its last line (a crash's last words), but hortusd's own reason when the serial tail follows
 * it (a VM boot timeout or a dead guest, dispatcher.ts). */
export const errorLine = (e: string): string =>
  (/^(boot timeout|guest died):/.test(e) ? e.split("\n")[0] : e.split("\n").at(-1)) ?? "";
