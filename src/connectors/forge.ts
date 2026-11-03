/**
 * What every forge connector shares (17-github.md): the in-process event queue the webhook listener fills, the
 * project → directory rule, and the `repos` glob filter.
 */
import type { Event, Incoming } from "../types.ts";

/**
 * The webhook listener's hand-off to the gateway loop. `push` queues one event and resolves when the gateway acks it
 * (after its INSERT, before any mirror work), so the listener answers `200` only once the row exists. One consumer.
 */
export function eventQueue(): { push(e: Event): Promise<void>; events(signal: AbortSignal): AsyncIterable<Incoming> } {
  const items: Incoming[] = [];
  let wake: (() => void) | undefined;
  const notify = () => {
    wake?.();
    wake = undefined;
  };
  return {
    push: (event) =>
      new Promise<void>((resolve) => {
        items.push({ event, ack: async () => resolve() });
        notify();
      }),
    async *events(signal) {
      signal.addEventListener("abort", notify);
      try {
        while (!signal.aborted) {
          const item = items.shift();
          if (item) yield item;
          else await new Promise<void>((r) => (wake = r));
        }
      } finally {
        signal.removeEventListener("abort", notify);
      }
    },
  };
}

/** A channel id with `/` would nest in the mirror: `owner/repo` lives in `owner__repo/` (v7 › DOF). */
export const dirOf = (project: string): string => project.replace(/\//g, "__");

/** `dofs.<name>.repos` globs: `*` one segment, `**` anything; none configured → every project. */
export function matches(project: string, globs: string[] | undefined): boolean {
  if (!globs?.length) return true;
  return globs.some((g) => {
    const src = g
      .split(/(\*\*|\*)/)
      .map((s) => (s === "**" ? ".*" : s === "*" ? "[^/]*" : s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
      .join("");
    return new RegExp(`^${src}$`).test(project);
  });
}

/** CI conclusions: anything that is not a pass is a failure; a suite still running makes the whole `pending`. */
export function worst(suites: { status: string; conclusion: string | null }[]): string | null {
  if (!suites.length) return null;
  if (suites.some((s) => s.status !== "completed")) return "pending";
  const ok = new Set(["success", "neutral", "skipped"]);
  return suites.every((s) => ok.has(s.conclusion ?? "")) ? "success" : "failure";
}
