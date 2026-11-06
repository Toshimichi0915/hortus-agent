/** Reconnect backoff shared by connectors and the gateway: 1 s doubling to 60 s. */
import { setTimeout as wait } from "node:timers/promises";

export const backoff = (attempt: number): number => Math.min(1000 * 2 ** attempt, 60_000);

/** Resolves after `ms` or as soon as `signal` aborts; never rejects. */
export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  wait(ms, undefined, { signal }).then(
    () => {},
    () => {},
  );
