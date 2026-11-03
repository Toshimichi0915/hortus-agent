#!/usr/bin/env -S node --no-warnings=ExperimentalWarning
/** hortus: the owner's console CLI, a line-oriented client of hortusd's abstract socket. */
import * as paths from "../paths.ts";
import { type RpcClient, rpcClient } from "../rpc.ts";
import { RpcError } from "../types.ts";

interface Command {
  usage: string;
  run(args: string[], rpc: RpcClient): Promise<void>;
}

/** Later steps add `chat`, `tasks`, `approvals`, `install`, … here. */
const commands: Record<string, Command> = {
  ping: {
    usage: "ping                 check that hortusd answers",
    async run(_args, rpc) {
      const r = (await rpc.call("ping", {})) as { pid: number };
      console.log(`pong (hortusd pid ${r.pid})`);
    },
  },
};

function usage(): never {
  console.error(
    `usage: hortus <command>\n\n${Object.values(commands)
      .map((c) => `  ${c.usage}`)
      .join("\n")}`,
  );
  process.exit(64);
}

const [name, ...args] = process.argv.slice(2);
const cmd = name === undefined ? undefined : commands[name];
if (!cmd) usage();
const rpc = rpcClient(paths.socket());
try {
  await cmd.run(args, rpc);
} catch (e) {
  const code = (e as NodeJS.ErrnoException).code;
  if (code === "ECONNREFUSED" || code === "ENOENT") {
    console.error(`hortusd is not running (socket ${paths.socket().replace("\0", "\\0")})`);
  } else console.error(e instanceof RpcError ? `${e.code}: ${e.message}` : String(e));
  process.exitCode = 1;
} finally {
  rpc.close();
}
