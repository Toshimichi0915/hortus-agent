/** The Worker's stdout: one JSON line per StdoutLine. hortusd relays chat ones, logs the rest. */
import type { Message } from "@hortus/core";
import type { StdoutLine } from "../types.ts";

export function out(line: StdoutLine): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

/** A message as stdout lines: its tool results (images as `[image]`), then the role; text already streamed. */
export function outMessage(m: Message): void {
  if (m.role === "tool")
    for (const r of m.results) {
      const output = r.images?.length ? (r.output ? `[image] ${r.output}` : "[image]") : r.output;
      out({ type: "tool_result", id: r.id, output, ...(r.isError && { isError: true }) });
    }
  out({ type: "message", role: m.role });
}
