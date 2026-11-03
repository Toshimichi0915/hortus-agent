/** What every hortusd module receives in `start(ctx)`. */
import type { Config } from "./config.ts";
import type { DatabaseSync } from "./db.ts";
import type * as paths from "./paths.ts";
import type { Log } from "./types.ts";

export interface Ctx {
  /** The current config. `reload()` replaces it: read `ctx.config` when needed, never keep a copy. */
  config: Config;
  db: DatabaseSync;
  paths: typeof paths;
  /** A scoped logger: `ctx.log("gateway").info(...)`. */
  log(scope: string): Log;
  /** Re-read hortusd.json (throws on an invalid file and keeps the old config), then each module's `reload(prev)`. */
  reload(): Promise<void>;
}

/** A part of hortusd (gateway, proxy, console, dispatcher, scheduler). Started in list order, stopped in reverse. */
export interface Module {
  name: string;
  start(ctx: Ctx): Promise<void>;
  stop(): Promise<void>;
  /** Called after `ctx.config` was swapped; `prev` is the old config, for diffing. */
  reload?(prev: Config): Promise<void>;
}
