import { randomBytes } from "node:crypto";

let last = 0;

/** `<base36 ms><8 hex>`, strictly time-ordered within this process (the ms is bumped on a collision). */
export function taskId(): string {
  last = Math.max(Date.now(), last + 1);
  return last.toString(36) + randomBytes(4).toString("hex");
}

export const token = (n: number): string => randomBytes(n).toString("base64url");
