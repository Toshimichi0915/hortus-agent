/**
 * In-process bus the console's SSE endpoints subscribe to. Other modules emit after their DB write:
 * `bus.emit("approvals", payload)`, `bus.emit("tasks", payload)`, `bus.emit("chat:<task id>")` (after inserting the
 * `replies` row; the chat stream reads new rows from the table, so its payload is ignored), `bus.emit("sessions")`
 * after deleting `console_sessions` rows (a remote stream whose row is gone ends), `bus.emit("settings")` after a
 * settings, credential, project or remote device write (the payload says nothing: the page asks again).
 */
import { EventEmitter } from "node:events";
import { logger } from "../log.ts";

const log = logger("bus");

/** A listener that throws (an SSE writer rendering a Worker's line, say) is logged, never thrown into the emitter: the
 * emitter is a DB write path (a session's stdout, the gate), and a throw there ended hortusd. */
class Bus extends EventEmitter {
  override emit(name: string | symbol, ...args: unknown[]): boolean {
    const fs = this.rawListeners(name) as ((...a: unknown[]) => void)[];
    for (const f of fs)
      try {
        f.apply(this, args);
      } catch (e) {
        log.error("listener failed", e, { event: String(name) });
      }
    return fs.length > 0;
  }
}

export const bus = new Bus();
bus.setMaxListeners(0);
