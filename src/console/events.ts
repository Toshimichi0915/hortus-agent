/**
 * In-process bus the console's SSE endpoints subscribe to. Other modules emit after their DB write:
 * `bus.emit("approvals", payload)`, `bus.emit("tasks", payload)`, `bus.emit("chat:<task id>")` (after inserting the
 * `replies` row; the chat stream reads new rows from the table, so its payload is ignored), `bus.emit("sessions")`
 * after deleting `console_sessions` rows (a remote stream whose row is gone ends).
 */
import { EventEmitter } from "node:events";

export const bus = new EventEmitter();
bus.setMaxListeners(0);
