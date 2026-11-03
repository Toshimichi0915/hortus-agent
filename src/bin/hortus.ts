#!/usr/bin/env -S node --no-warnings=ExperimentalWarning
/** hortus: the owner's console CLI, a line-oriented client of hortusd's abstract socket. One row per command. */
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import * as paths from "../paths.ts";
import { type RpcClient, rpcClient } from "../rpc.ts";
import { RpcError, type SearchHit } from "../types.ts";

interface Command {
  usage: string;
  run(args: string[], rpc: RpcClient): Promise<void>;
}

class Usage extends Error {}

const tty = process.stdout.isTTY;
const grey = (s: string) => (tty ? `\x1b[90m${s}\x1b[0m` : s);
const red = (s: string) => (process.stderr.isTTY ? `\x1b[31m${s}\x1b[0m` : s);

type Row = Record<string, unknown>;
const s = (v: unknown): string => (v === undefined || v === null ? "" : typeof v === "string" ? v : JSON.stringify(v));

function tokens(n: unknown): string {
  const x = typeof n === "number" ? n : 0;
  return x >= 1e6 ? `${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `${(x / 1e3).toFixed(1)}k` : String(x);
}

function budget(t: Row): string {
  const b = (t.budget ?? {}) as Row;
  const u = (t.usage ?? {}) as Row;
  return `${tokens(u.tokens)}/${tokens(b.tokens)} tok, ${Math.round(Number(t.hours ?? 0) * 10) / 10}/${s(b.hours) || 0} h`;
}

/** A stream event or a replies row (`{seq, body}`) as one printed line; null for lines the REPL does not show. */
function line(ev: unknown): string | null {
  let l = ev as Row | null;
  if (l && typeof l.body === "string") {
    try {
      l = JSON.parse(l.body) as Row;
    } catch {
      return l.body as string;
    }
  } else if (l && typeof l.body === "object") l = l.body as Row;
  if (!l || typeof l !== "object") return s(l);
  switch (l.type) {
    case "text":
      return s(l.text);
    case "tool_call": {
      const input = l.input as Row | undefined;
      return grey(
        typeof input?.command === "string" ? `$ ${input.command}` : `${s(l.name)} ${JSON.stringify(input ?? {})}`,
      );
    }
    case "error":
      return red(s(l.message));
    case "status":
      return grey(s(l.text));
    case "thinking":
    case "tool_result":
    case "message":
      return null;
    default:
      return l.text === undefined ? null : s(l.text);
  }
}

function errorText(e: unknown): string {
  const code = (e as NodeJS.ErrnoException).code;
  if (code === "ECONNREFUSED" || code === "ENOENT")
    return `hortusd is not running (socket ${paths.socket().replace("\0", "\\0")})`;
  if (e instanceof RpcError) return `${e.code.replace("_", " ")}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

const needId = (id: string | undefined, what: string): string => {
  if (!id) throw new Usage(`usage: hortus ${what}`);
  return id;
};

async function chat(args: string[], rpc: RpcClient): Promise<void> {
  // not parseArgs: the text may contain dashes
  let id = args[0] === "-r" ? needId(args[1], "chat -r <id> [<text>…]") : undefined;
  const positionals = id === undefined ? args : args.slice(2);
  let closing = false;
  let interrupts = 0;
  const follow = async (task: string) => {
    try {
      for await (const ev of rpc.stream("task.stream", { id: task })) {
        const out = line(ev);
        if (out !== null) console.log(out);
      }
    } catch (e) {
      if (!closing) console.error(red(errorText(e)));
    }
  };
  let chain: Promise<void> = Promise.resolve();
  const say = (text: string) => {
    interrupts = 0;
    chain = chain.then(async () => {
      try {
        if (id === undefined) {
          const r = (await rpc.call("task.open", { text, cwd: process.cwd() })) as { id?: string } | string;
          id = typeof r === "string" ? r : s(r.id);
          console.error(grey(`task ${id} (hortus chat -r ${id} to resume)`));
          void follow(id);
        } else await rpc.call("task.send", { id, text });
      } catch (e) {
        console.error(red(errorText(e)));
        if (!(e instanceof RpcError)) process.exit(1);
      }
    });
  };
  if (id !== undefined) void follow(id);
  if (positionals.length) say(positionals.join(" "));
  const rl = createInterface({ input: process.stdin, terminal: false });
  const interrupt = () => {
    if (++interrupts > 1 || id === undefined) process.exit(130);
    console.error(grey("stopping the task (Ctrl-C again to exit)"));
    rpc.call("task.stop", { id }).catch((e) => console.error(red(errorText(e))));
  };
  rl.on("SIGINT", interrupt);
  process.on("SIGINT", interrupt);
  rl.on("line", (l) => {
    if (l.trim()) say(l);
  });
  await new Promise<void>((resolve) => rl.on("close", resolve));
  await chain;
  closing = true;
}

const commands: Record<string, Command> = {
  ping: {
    usage: "ping                                check that hortusd answers",
    async run(_args, rpc) {
      const r = (await rpc.call("ping", {})) as { pid: number };
      console.log(`pong (hortusd pid ${r.pid})`);
    },
  },
  tasks: {
    usage: "tasks [<id>]                        open and recent tasks, or one task's card",
    async run([id], rpc) {
      if (id === undefined) {
        const list = (await rpc.call("task.list", {})) as Row[];
        if (!list.length) return console.log("no tasks");
        for (const t of list) console.log([t.id, t.status, t.kind, budget(t), t.title].map(s).join("\t"));
        return;
      }
      const c = (await rpc.call("task.get", { id })) as {
        task: Row;
        summary?: string;
        replies: Row[];
        approvals: Row[];
        inbox: Row[];
      };
      const t = c.task;
      console.log(
        `${s(t.title) || id}\n${s(t.status)} · ${s(t.kind)}${t.project ? ` · ${s(t.project)}` : ""} · ${budget(t)}`,
      );
      if (c.summary) console.log(`\n${c.summary}`);
      for (const a of c.approvals) console.log(`\npending approval #${s(a.id)} ${s(a.category)}`);
      if (c.replies.length) console.log("");
      for (const r of c.replies) {
        const out = line(r);
        if (out !== null) console.log(out);
      }
    },
  },
  chat: {
    usage: "chat [-r <id>] [<text>…]            talk to a chat task; Ctrl-C stops it, Ctrl-D leaves",
    run: chat,
  },
  approvals: {
    usage: "approvals [approve|reject <id>]     pending first",
    async run([verb, id], rpc) {
      if (verb === undefined) {
        const list = (await rpc.call("approval.list", {})) as Row[];
        if (!list.length) return console.log("no approvals");
        const sorted = [...list].sort((a, b) => Number(b.status === "pending") - Number(a.status === "pending"));
        for (const a of sorted) {
          const sum = (typeof a.summary === "string" ? JSON.parse(a.summary) : (a.summary ?? {})) as Row;
          const where = [sum.method, sum.host, sum.path].filter(Boolean).map(s).join(" ");
          console.log([`#${s(a.id)}`, a.status, a.category, a.task_id, where].map(s).join("\t"));
        }
        return;
      }
      if (verb !== "approve" && verb !== "reject") throw new Usage("usage: hortus approvals [approve|reject <id>]");
      const n = Number(needId(id, `approvals ${verb} <id>`));
      await rpc.call("approval.decide", { id: n, decision: verb });
      console.log(`${verb === "approve" ? "approved" : "rejected"} #${n}`);
    },
  },
  stop: {
    usage: "stop <id>                           stop a running task (it becomes waiting)",
    async run([id], rpc) {
      await rpc.call("task.stop", { id: needId(id, "stop <id>") });
    },
  },
  close: {
    usage: "close <id> [failed]                 close a task (done unless failed)",
    async run([id, outcome], rpc) {
      await rpc.call("task.close", {
        id: needId(id, "close <id> [failed]"),
        outcome: outcome === "failed" ? "failed" : "done",
      });
    },
  },
  search: {
    usage: "search <query> [--in d] [--author a] [--since t] [--until t] [--limit n]",
    async run(args, rpc) {
      const str = { type: "string" } as const;
      const { values, positionals } = parseArgs({
        args,
        options: { in: str, author: str, since: str, until: str, limit: str },
        allowPositionals: true,
      });
      if (!positionals.length) throw new Usage("usage: hortus search <query>");
      const { limit, ...rest } = values;
      const hits = (await rpc.call("dof.search", {
        q: positionals.join(" "),
        ...rest,
        ...(limit ? { limit: Number(limit) } : {}),
      })) as SearchHit[];
      if (!hits.length) return console.log("no results");
      for (const x of hits) console.log(`${x.dof}:${x.path}\t${x.author}\t${x.ts}\n  ${x.snippet.replace(/\n/g, " ")}`);
    },
  },
  sync: {
    usage: "sync --force <project>              re-sync a project from its origin",
    async run(args, rpc) {
      const { values, positionals } = parseArgs({
        args,
        options: { force: { type: "boolean" } },
        allowPositionals: true,
      });
      await rpc.call("project.sync", {
        name: needId(positionals[0], "sync --force <project>"),
        force: values.force ?? false,
      });
    },
  },
  schedules: {
    usage: "schedules                           scheduled firings by task",
    async run(_args, rpc) {
      const list = (await rpc.call("schedule.list", {})) as Row[];
      if (!list.length) return console.log("no schedules");
      for (const r of list) console.log([r.id, r.task_id, r.fire_at, r.cron ?? r.every_sec, r.text].map(s).join("\t"));
    },
  },
  pause: {
    usage: "pause                               stop starting queued tasks",
    async run(_args, rpc) {
      await rpc.call("pause.set", { paused: true });
      console.log("paused");
    },
  },
  resume: {
    usage: "resume                              start queued tasks again",
    async run(_args, rpc) {
      await rpc.call("pause.set", { paused: false });
      console.log("resumed");
    },
  },
  image: {
    usage: "image build [--no-browser]          build the Worker VM image (sudo)",
    run: async (a) => (await import("../runtime/image.ts")).imageBuild(a),
  },
  install: {
    usage: "install [--ca] [--force]            install the systemd unit (and the CA system-wide)",
    async run(args) {
      const { values } = parseArgs({ args, options: { ca: { type: "boolean" }, force: { type: "boolean" } } });
      // ponytail: lazy, untyped import so this builds before src/install.ts exists; type it once it does
      const file = "../install.js";
      let mod: { install?: (o: { ca: boolean; force: boolean }) => Promise<void> | void };
      try {
        mod = await import(file);
      } catch {
        throw new Error("install is not available in this build");
      }
      if (!mod.install) throw new Error("install is not available in this build");
      await mod.install({ ca: values.ca ?? false, force: values.force ?? false });
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
  console.error(e instanceof Usage ? e.message : errorText(e));
  process.exitCode = e instanceof Usage ? 64 : 1;
} finally {
  rpc.close();
}
