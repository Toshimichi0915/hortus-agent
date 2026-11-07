#!/usr/bin/env -S node --no-warnings=ExperimentalWarning
/** hortus: the owner's console CLI, a line-oriented client of hortusd's abstract socket. One row per command. */
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { errorLine, kindOf, PAUSED, relative, type ScheduleListRow, tokens } from "../console/rows.ts";
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

function budget(t: Row): string {
  const b = (t.budget ?? {}) as Row;
  const u = (t.usage ?? {}) as Row;
  // usage is written when a session ends; the proxy's count (plus its runs') is the spend so far
  const used = Math.max(Number(u.tokens) || 0, (Number(t.metered) || 0) + (Number(u.runs) || 0));
  const cap = t.kind === "chat" ? "" : `/${tokens(Number(b.tokens) || 0)}`;
  return `${tokens(used)}${cap} tok, ${Math.round(Number(t.hours ?? 0) * 10) / 10}/${s(b.hours) || 0} h`;
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
    case "owner":
      return `> ${s(l.text).replace(/\n/g, "\n> ")}`;
    case "thinking":
    case "tool_result":
    case "message":
      return null;
    default:
      return l.text === undefined ? null : s(l.text);
  }
}

/** The line's type (`text`, `owner`, …) of a stream event or a replies row. */
function typeOf(ev: unknown): unknown {
  const r = ev as Row | null;
  if (typeof r?.body === "string") return /^\{"type":"(\w+)"/.exec(r.body)?.[1];
  return r?.type ?? (r?.body as Row | undefined)?.type;
}
const isText = (ev: unknown) => typeOf(ev) === "text";

/** Lines as the REPL shows them: text deltas run together, every other line starts on a fresh one. */
function printer(): { print(ev: unknown): void; end(): void } {
  let mid = false;
  return {
    print(ev) {
      const out = line(ev);
      if (out === null) return;
      if (isText(ev)) {
        process.stdout.write(out);
        mid = !out.endsWith("\n");
      } else {
        console.log(mid ? `\n${out}` : out);
        mid = false;
      }
    },
    end: () => void (mid && process.stdout.write("\n")),
  };
}

function errorText(e: unknown): string {
  const code = (e as NodeJS.ErrnoException).code;
  if (code === "ECONNREFUSED" || code === "ENOENT")
    return `hortusd is not running (socket ${paths.socket().replace("\0", "\\0")}): sudo systemctl start hortusd`;
  // the message says what happened; only a refusal is worth naming as one
  if (e instanceof RpcError) return e.code === "forbidden" ? `forbidden: ${e.message}` : e.message;
  return e instanceof Error ? e.message : String(e);
}

/**
 * A two-list RPC (task.list: open then closed; approval.list: pending then decided), grouped by `first`. Without
 * `--all`: the newest 50 of each, and a line per list that had more; with it: every page of 500.
 */
async function listing(
  rpc: RpcClient,
  method: string,
  all: boolean,
  first: (r: Row) => boolean,
): Promise<{ rows: Row[]; cut: boolean }> {
  const page = all ? 500 : 50;
  const rows: Row[] = [];
  for (let skip = 0; ; skip += page) {
    const got = (await rpc.call(method, { limit: all ? page : page + 1, skip })) as Row[];
    rows.push(...got);
    if (!all || !got.length) break;
  }
  const a = rows.filter(first);
  const b = rows.filter((r) => !first(r));
  if (all) return { rows: [...a, ...b], cut: false };
  return { rows: [...a.slice(0, page), ...b.slice(0, page)], cut: a.length > page || b.length > page };
}
const cutLine = (cmd: string) => grey(`… only the newest 50 of each list; hortus ${cmd} --all for every one`);

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
  let lastError = "";
  // the stream and the send can fail for the same reason (no such task): said once, and the exit code says it too
  const report = (e: unknown) => {
    const t = errorText(e);
    if (t !== lastError) console.error(red(t));
    lastError = t;
    process.exitCode = 1;
  };
  // the web chat shows a pending entry inline; here only the model's words would say the Worker waits on the owner
  const told = new Set<unknown>();
  const waiting = async (task: string) => {
    const c = (await rpc.call("task.get", { id: task }).catch(() => null)) as { approvals: Row[] } | null;
    for (const a of c?.approvals ?? []) {
      if (!told.has(a.id)) console.error(grey(`approval #${s(a.id)} pending (${s(a.category)}): hortus approvals`));
      told.add(a.id);
    }
  };
  const follow = async (task: string) => {
    try {
      const p = printer();
      // the owner's own lines: the REPL user typed them
      for await (const ev of rpc.stream("task.stream", { id: task })) {
        if (typeOf(ev) !== "owner") p.print(ev);
        if (typeOf(ev) === "status") await waiting(task);
      }
    } catch (e) {
      if (!closing) report(e);
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
        report(e);
        if (!(e instanceof RpcError)) process.exit(1);
      }
    });
  };
  if (id !== undefined) {
    // an unknown or closed id fails here, before the REPL (not as a stream error nobody waits for)
    try {
      const { task } = (await rpc.call("task.get", { id })) as { task: Row };
      if (task.status === "done" || task.status === "failed") throw new Error(`task ${id} is ${s(task.status)}`);
    } catch (e) {
      report(e);
      return;
    }
    void follow(id);
  }
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
    usage: "tasks [--all | <id>]                open and recent tasks, or one task's card",
    async run([id], rpc) {
      if (id === undefined || id === "--all") {
        const closed = (t: Row) => t.status === "done" || t.status === "failed";
        const { rows, cut } = await listing(rpc, "task.list", id === "--all", (t) => !closed(t));
        if (!rows.length) return console.log("no tasks");
        for (const t of rows) console.log([t.id, t.status, t.kind, budget(t), t.title].map(s).join("\t"));
        if (cut) console.log(cutLine("tasks"));
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
      if (t.error) console.log(red(errorLine(s(t.error))));
      if (c.summary) console.log(`\n${c.summary}`);
      for (const a of c.approvals) console.log(`\npending approval #${s(a.id)} ${s(a.category)}`);
      if (c.replies.length) console.log("");
      const p = printer();
      for (const r of c.replies) p.print(r);
      p.end();
    },
  },
  chat: {
    usage: "chat [-r <id>] [<text>…]            talk to a chat task; Ctrl-C stops it, Ctrl-D leaves",
    run: chat,
  },
  approvals: {
    usage: "approvals [--all | approve [--grant]|reject <id>]  pending first; --grant: allow for the task",
    async run(argv, rpc) {
      // --grant: "Approve, and allow … for this task" (a tainted task's non-consequential entry, gate.grantable)
      const grant = argv.includes("--grant");
      const [verb, id] = argv.filter((a) => a !== "--grant");
      if (verb === undefined || verb === "--all") {
        const { rows, cut } = await listing(rpc, "approval.list", verb === "--all", (a) => a.status === "pending");
        if (!rows.length) return console.log("no approvals");
        for (const a of rows) {
          const sum = (typeof a.summary === "string" ? JSON.parse(a.summary) : (a.summary ?? {})) as Row;
          // a request's method host path; a login's origin; a transform's name and what it puts on which hosts
          const puts = Object.entries((sum.credentials ?? {}) as Record<string, { hosts?: string[] }>).map(
            ([n, c]) => `put ${n} on ${(c.hosts ?? []).join(", ")}`,
          );
          const merge =
            a.category === "merge" ? `${s(sum.project)} ${s(sum.branch)} +${s(sum.added)} −${s(sum.removed)}` : "";
          const where = [sum.method, sum.host, sum.path, sum.origin, sum.name, puts.join("; "), merge]
            .filter(Boolean)
            .map(s)
            .join(" ");
          console.log([`#${s(a.id)}`, a.status, a.category, a.task_id, where].map(s).join("\t"));
          if (a.status === "approved" && a.category === "merge" && a.reason)
            console.log(`\tnot landed: ${s(a.reason)} (Retry is on the Approvals page)`);
          if (a.status !== "pending") continue;
          // what the Approvals page warns of: `approve` here is the same decision, and no entry page to open first
          const taint = ((a.payload as Row | null)?.untrusted ?? []) as string[];
          if (sum.rendered) console.log(`\t${s(sum.rendered)}`);
          if (taint.length) console.log(`\ttainted: ${taint.join("; ")}`);
          if (a.grantable) console.log(`\tapprove --grant ${s(a.id)} also allows ${s(a.category)} for this task`);
          const missing = ((sum.missing ?? []) as Row[]).map((m) => m.name);
          if (missing.length)
            console.log(`\tno value yet for ${missing.join(", ")}: the Approvals page takes them with the approval`);
        }
        if (cut) console.log(cutLine("approvals"));
        return;
      }
      if ((verb !== "approve" && verb !== "reject") || (grant && verb !== "approve"))
        throw new Usage("usage: hortus approvals [approve [--grant] <id> | reject <id>]");
      const n = Number(needId(id, `approvals ${verb} <id>`));
      const r = (await rpc.call("approval.decide", { id: n, decision: verb, ...(grant ? { grant } : {}) })) as Row;
      console.log(
        s(r.message) ||
          `${verb === "approve" ? "approved" : "rejected"} #${n}${grant ? ", and allowed for its task" : ""}`,
      );
    },
  },
  stop: {
    usage: "stop <id>                           stop a running task (it becomes waiting)",
    async run([id], rpc) {
      const r = (await rpc.call("task.stop", { id: needId(id, "stop <id>") })) as { message?: string };
      console.log(r.message ?? "stopping");
    },
  },
  close: {
    usage: "close <id> [failed]                 close a task (done unless failed)",
    async run([id, outcome], rpc) {
      // a typo must not record the opposite outcome: a closed task stays closed
      if (outcome !== undefined && outcome !== "failed") throw new Usage("usage: hortus close <id> [failed]");
      await rpc.call("task.close", { id: needId(id, "close <id> [failed]"), outcome: outcome ?? "done" });
      console.log(`closed ${id}`);
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
    usage:
      "sync [--force] <project>             update the project's origin from its checkout (--force: main was rewritten)",
    async run(args, rpc) {
      const { values, positionals } = parseArgs({
        args,
        options: { force: { type: "boolean" } },
        allowPositionals: true,
      });
      const name = needId(positionals[0], "sync [--force] <project>");
      await rpc.call("project.sync", { name, force: values.force ?? false });
      console.log(`synced ${name}`);
    },
  },
  schedules: {
    usage: "schedules                           scheduled firings by task",
    async run(_args, rpc) {
      const list = (await rpc.call("schedule.list", {})) as Row[];
      if (!list.length) return console.log("no schedules");
      for (const r of list as unknown as ScheduleListRow[])
        console.log(
          [
            r.id,
            r.title || r.task_id,
            kindOf(r),
            r.fire_at ? `${relative(r.fire_at)} (${r.fire_at})` : "",
            r.last_run ?? "-",
            r.expires_at ?? "never",
            r.text,
          ]
            .map(s)
            .join("\t"),
        );
    },
  },
  pause: {
    usage: `pause                               ${PAUSED}`,
    async run(_args, rpc) {
      await rpc.call("pause.set", { paused: true });
      console.log("paused");
    },
  },
  resume: {
    usage: "resume                              undo pause",
    async run(_args, rpc) {
      await rpc.call("pause.set", { paused: false });
      console.log("resumed");
    },
  },
  image: {
    usage: "image build [--no-browser]          build the Worker VM image (sudo)",
    run: async (a) => {
      if (a[0] !== "build" || a.slice(1).some((x) => x !== "--no-browser"))
        throw new Usage("usage: hortus image build [--no-browser]");
      await (await import("../runtime/image.ts")).imageBuild(a);
    },
  },
  install: {
    usage: "install [--ca] [--force]            install the systemd unit (and the CA system-wide)",
    async run(args) {
      const { values } = parseArgs({ args, options: { ca: { type: "boolean" }, force: { type: "boolean" } } });
      (await import("../install.ts")).install({ ca: values.ca ?? false, force: values.force ?? false });
    },
  },
};

/** Asked for (`help`, `--help`): stdout, exit 0; a missing or unknown command: stderr, exit 64. */
function usage(asked = false): never {
  const text = `usage: hortus <command>\n\n${Object.values(commands)
    .map((c) => `  ${c.usage}`)
    .join("\n")}`;
  if (asked) console.log(text);
  else console.error(text);
  process.exit(asked ? 0 : 64);
}

const HELP = ["help", "--help", "-h"];
const [name, ...args] = process.argv.slice(2);
if (name !== undefined && HELP.includes(name)) usage(true);
const cmd = name === undefined ? undefined : commands[name];
if (!cmd) {
  if (name !== undefined) console.error(`unknown command ${name}`);
  usage();
}
if (args[0] === "--help" || args[0] === "-h") {
  console.log(`usage: hortus ${cmd.usage}`);
  process.exit(0);
}
const rpc = rpcClient(paths.socket());
try {
  await cmd.run(args, rpc);
} catch (e) {
  console.error(e instanceof Usage ? e.message : errorText(e));
  process.exitCode = e instanceof Usage ? 64 : 1;
} finally {
  rpc.close();
}
