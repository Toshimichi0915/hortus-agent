/**
 * The dispatcher (07-step3-runtime.md): every second and on `wake()`, start each `queued` host task unless `PAUSED`;
 * relay a session's stdout into `replies`; on exit read `out/` as hostile input and move the status on. A new kind is a
 * row in KINDS; a runtime is a `start` (`host.spawnSandboxed`, `vm.startVm`), picked by the task's `runtime` column.
 * VM tasks start below `vm.max_concurrent`; with the image missing they run on the host (`vm.fallback_host`, v7) or
 * stay queued with the reason in `error`.
 */
import { closeSync, constants, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { scan } from "../agent/loop.ts";
import { bus } from "../console/events.ts";
import type { Ctx, Module } from "../ctx.ts";
import { now } from "../db.ts";
import { publishLog } from "../mirror/index.ts";
import { prepareClone } from "../projects/origin.ts";
import * as paths from "../paths.ts";
import { links, listen, listenOpts } from "../proxy/index.ts";
import type { OutboxMsg, StdoutLine, TaskKind } from "../types.ts";
import { type Child, type Exit, agentCmd, spawnSandboxed } from "./host.ts";
import type { Kind } from "./landlock.ts";
import { recover } from "./recovery.ts";
import * as tasks from "./tasks.ts";
import { missingImage, startVm } from "./vm.ts";

/** Per kind: the Landlock profile and whether every stdout line is a chat reply. */
const KINDS: Record<TaskKind, { profile: Kind; chat: boolean }> = {
  chat: { profile: "chat", chat: true },
  unattended: { profile: "unattended", chat: false },
  run: { profile: "unattended", chat: false },
  planner: { profile: "unattended", chat: false },
};

/** Called after an exit that produced a `result` (step 4 wakes the Planner for non-chat tasks; 3c closes empty runs). */
export const exitHooks = {
  onResult(_task: tasks.TaskRow, _msg: OutboxMsg): void {},
};

export const MAX_OUTBOX = 1024 * 1024;
export const MAX_SUMMARY = 64 * 1024;
export const STOP_KILL_MS = 30_000;

const Outbox = z.object({
  seq: z.number().int().positive(),
  type: z.enum(["reply", "result", "budget_exceeded"]),
  text: z.string(),
  ts: z.string(),
});

interface Running {
  vm: boolean;
  child?: Child;
  done: Promise<void>;
  stopTimer?: NodeJS.Timeout;
}

const running = new Map<string, Running>();
let ctx: Ctx | undefined;
let timer: NodeJS.Timeout | undefined;
let ticking = false;
let stopping = false;

const db = () => {
  if (!ctx) throw new Error("dispatcher not started");
  return ctx.db;
};
const log = () => ctx?.log("dispatcher") ?? { info() {}, error() {} };

export function wake(): void {
  setImmediate(tick);
}

function tick(): void {
  if (!ctx || ticking || stopping) return;
  ticking = true;
  try {
    if (existsSync(paths.paused())) return;
    const rows = db()
      .prepare("SELECT * FROM tasks WHERE status = 'queued' ORDER BY updated")
      .all() as unknown as tasks.TaskRow[];
    let vms = [...running.values()].filter((r) => r.vm).length;
    for (const row of rows) {
      if (running.has(row.id) || tasks.closing.has(row.id)) continue;
      if (row.runtime !== "vm") {
        start(row, false);
        continue;
      }
      const missing = missingImage();
      if (missing && !ctx.config.vm.fallback_host) {
        // not startable until `hortus image build`: the card shows why, the tick retries
        if (row.error !== missing) db().prepare("UPDATE tasks SET error = ? WHERE id = ?").run(missing, row.id);
        continue;
      }
      if (missing) {
        log().info("VM image missing: running on the host (vm.fallback_host)", { task: row.id });
        start(row, false, `${missing}; running as an unattended host session (vm.fallback_host)`);
        continue;
      }
      if (vms >= ctx.config.vm.max_concurrent) continue;
      vms++;
      start(row, true);
    }
  } catch (e) {
    log().error("tick failed", e);
  } finally {
    ticking = false;
  }
}

/** A `replies` row, then `chat:<id>` on the bus (the SSE and task.stream read rows, not the payload). */
export function reply(id: string, line: StdoutLine | string): void {
  const body = typeof line === "string" ? line : JSON.stringify(line);
  db()
    .prepare(
      "INSERT INTO replies(task_id, seq, body, created) SELECT ?, COALESCE(MAX(seq), 0) + 1, ?, ? FROM replies WHERE task_id = ?",
    )
    .run(id, body, now(), id);
  bus.emit(`chat:${id}`);
}

/**
 * HORTUS_NO_NET=1 has no session address and no transparent interception: a loopback alias registered as the
 * session's link lets `dof` reach hortusd.internal through the proxy's plain listener on 127.0.0.1 (env below);
 * curl to upstreams still needs the real network mode.
 */
async function loopbackLink(id: string, role: "worker" | "planner"): Promise<Record<string, string>> {
  if (process.env.HORTUS_NO_NET !== "1" || !ctx) return {};
  const taken = new Set(
    (db().prepare("SELECT address FROM links").all() as { address: string }[]).map((r) => r.address),
  );
  let address: string | undefined;
  for (let n = 2; n <= 254 && !address; n++) if (!taken.has(`127.0.0.${n}`)) address = `127.0.0.${n}`;
  if (!address) return {};
  links.register(address, role, id, "session");
  const { http } = await listen("127.0.0.1", listenOpts(ctx));
  return { HORTUS_RPC: `http://127.0.0.1:${http}`, HORTUS_RPC_LOCAL: address };
}

function releaseLinks(id: string): void {
  if (process.env.HORTUS_NO_NET !== "1") return;
  const rows = db().prepare("SELECT address FROM links WHERE task_id = ? AND kind = 'session'").all(id) as {
    address: string;
  }[];
  for (const r of rows) links.release(r.address);
}

/** `vm`: boot it with startVm; `note`: a status line on the card (the host fallback for a VM task). */
function start(row: tasks.TaskRow, vm: boolean, note?: string): void {
  if (!ctx) return;
  const c = ctx.config;
  const kind = KINDS[row.kind] ?? KINDS.unattended;
  const startedAt = Date.now();
  tasks.setStatus(row.id, "running", { started: now(), error: null });
  const entry: Running = { vm, done: Promise.resolve() };
  running.set(row.id, entry);
  let lastError: string | undefined;
  let thinking = "";
  const flushThinking = () => {
    if (thinking && kind.chat) reply(row.id, { type: "thinking", text: thinking });
    thinking = "";
  };
  const consoleLog = join(paths.out(row.id), "console.log");
  entry.done = (async () => {
    try {
      const task = tasks.taskJson(c, row);
      tasks.prepare(c, task);
      if (note) reply(row.id, { type: "status", text: note });
      if (vm) {
        const deadlineMs = Math.max(0, (task.budget.hours - row.hours) * 3.6e6);
        const child = await startVm({ task, config: c, deadlineMs });
        entry.child = child;
        const exit = await child.wait();
        // startVm SIGKILLs QEMU at the deadline: the Worker could not write budget_exceeded, so hortusd notes it
        await finish(
          row,
          exit,
          startedAt,
          undefined,
          exit.signal === "SIGKILL" && Date.now() - startedAt >= deadlineMs,
        );
        return;
      }
      const env = await loopbackLink(row.id, row.kind === "planner" ? "planner" : "worker");
      env.PATH = `${join(paths.ctl(row.id), "bin")}:${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`;
      // 3b: sync the origin and pre-clone clones/<id> (Landlock grants rw on it only if it exists at spawn; v7)
      await prepareClone(task, env.HORTUS_RPC_LOCAL);
      if (kind.chat) reply(row.id, { type: "status", text: "started" });
      const child = await spawnSandboxed({
        task,
        kind: kind.profile,
        cmd: agentCmd(row.id),
        cwd: task.paths.work,
        env,
        config: c,
        onStdout(l) {
          let line: StdoutLine | undefined;
          try {
            line = JSON.parse(l) as StdoutLine;
          } catch {}
          if (line?.type === "error") lastError = line.message;
          // thinking deltas become one row (the page folds it), flushed by the next other line or the exit
          if (line?.type === "thinking") {
            thinking += line.text;
            return;
          }
          flushThinking();
          if (kind.chat) reply(row.id, line ?? l);
          else {
            if (line?.type === "error" || line?.type === "status") reply(row.id, line);
            appendFile(consoleLog, `${l}\n`).catch(() => {});
          }
        },
      });
      entry.child = child;
      const exit = await child.wait();
      flushThinking();
      await finish(row, exit, startedAt, lastError);
    } catch (e) {
      // could not start (no Landlock, no session address, no provider): waiting with the reason, no retry loop
      const message = e instanceof Error ? e.message : String(e);
      log().error("start failed", e, { task: row.id });
      if (!stopping)
        tasks.setStatus(row.id, "waiting", { error: message, hours: row.hours + (Date.now() - startedAt) / 3.6e6 });
      reply(row.id, { type: "error", message });
    } finally {
      clearTimeout(entry.stopTimer);
      releaseLinks(row.id);
      running.delete(row.id);
      wake();
    }
  })();
}

/** Opens without following links and reads at most `max` bytes; null for anything but a regular file. */
function readCapped(path: string, max: number): { text: string; size: number } | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    const buf = Buffer.alloc(Math.min(st.size, max));
    const n = readSync(fd, buf, 0, buf.length, 0);
    return { text: buf.subarray(0, n).toString("utf8"), size: st.size };
  } finally {
    closeSync(fd);
  }
}

/** New `out/outbox/<seq>.json` files, as hostile input: regular files only, ≤ 1 MB, schema-checked, seq = name. */
export function readOutbox(id: string, after: number): OutboxMsg[] {
  const box = join(paths.out(id), "outbox");
  let names: string[];
  try {
    names = readdirSync(box);
  } catch {
    return [];
  }
  const out: OutboxMsg[] = [];
  for (const name of names.filter((n) => /^\d{6}\.json$/.test(n)).sort()) {
    const seq = Number(name.slice(0, 6));
    if (seq <= after) continue;
    const f = readCapped(join(box, name), MAX_OUTBOX + 1);
    const bad = (why: string) => log().error(`outbox file ignored: ${why}`, undefined, { task: id, name });
    if (!f) {
      bad("not a regular file");
      continue;
    }
    if (f.size > MAX_OUTBOX) {
      bad(`${f.size} bytes`);
      continue;
    }
    let m: z.infer<typeof Outbox>;
    try {
      m = Outbox.parse(JSON.parse(f.text));
    } catch (e) {
      bad(e instanceof Error ? e.message.slice(0, 200) : "invalid");
      continue;
    }
    if (m.seq !== seq) {
      bad(`seq ${m.seq} in ${name}`);
      continue;
    }
    out.push(m);
  }
  return out;
}

function tail(path: string, bytes = 2000): string {
  try {
    const t = readFileSync(path, "utf8");
    return t.slice(-bytes).trim();
  } catch {
    return "";
  }
}

async function finish(
  row: tasks.TaskRow,
  exit: Exit,
  startedAt: number,
  lastError?: string,
  overBudget = false,
): Promise<void> {
  const id = row.id;
  const d = db();
  const out = paths.out(id);
  const hours = row.hours + (Date.now() - startedAt) / 3.6e6;
  const { tokens, cursor } = scan(join(out, "sessions"));
  const seen = (d.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM outbox WHERE task_id = ?").get(id) as { n: number })
    .n;
  const msgs = readOutbox(id, seen);
  for (const m of msgs)
    d.prepare("INSERT OR IGNORE INTO outbox(task_id, seq, body, created) VALUES (?, ?, ?, ?)").run(
      id,
      m.seq,
      JSON.stringify(m),
      now(),
    );
  const summary = readCapped(join(out, "summary.md"), MAX_SUMMARY)?.text ?? null;
  const failed = exit.code !== 0 && msgs.length === 0;
  const error = overBudget
    ? `budget_exceeded: the VM was stopped after ${hours.toFixed(2)} h (budget hours)`
    : failed
      ? (lastError ?? (tail(join(out, "console.log")) || `exit ${exit.code ?? exit.signal}`)).slice(-2000)
      : null;
  const { n: inbox } = d.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM inbox WHERE task_id = ?").get(id) as {
    n: number;
  };
  const current = tasks.get(id).status;
  const extra = { hours, usage: JSON.stringify({ tokens }), summary: summary ?? row.summary, error };
  if (stopping || current !== "running") {
    // shutdown (recovery decides at the next start) or closed meanwhile: only the accounting
    d.prepare("UPDATE tasks SET hours = ?, usage = ?, summary = ?, error = ? WHERE id = ?").run(
      hours,
      extra.usage,
      extra.summary,
      error,
      id,
    );
  } else {
    // an owner message the Worker never drained re-queues it; a crash waits for the next message (no restart loop)
    // ponytail: a `run` with an empty result is closed by 3c; budget_exceeded waits like any other exit until step 4
    tasks.setStatus(id, exit.code === 0 && inbox > cursor && !overBudget ? "queued" : "waiting", extra);
  }
  if (error) reply(id, { type: "error", message: error });
  log().info("session ended", { task: id, code: exit.code, signal: exit.signal, outbox: msgs.length });
  await publishLog(id, row.title, tasks.get(id).status).catch((e) => log().error("publishLog failed", e, { task: id }));
  for (const m of msgs) if (m.type === "result") exitHooks.onResult(tasks.get(id), m);
}

export const dispatcherModule: Module = {
  name: "dispatcher",
  async start(c) {
    ctx = c;
    stopping = false;
    tasks.bind(c);
    await recover(c);
    tasks.hooks.wake = wake;
    tasks.hooks.stop = (id) => {
      const r = running.get(id);
      if (!r) return;
      clearTimeout(r.stopTimer);
      r.stopTimer = setTimeout(() => void r.child?.kill(), STOP_KILL_MS);
      r.stopTimer.unref();
    };
    tasks.hooks.kill = async (id) => {
      const r = running.get(id);
      if (!r) return;
      await r.child?.kill();
      await r.done;
    };
    timer = setInterval(tick, 1000);
    wake();
  },
  async stop() {
    stopping = true;
    clearInterval(timer);
    await Promise.all(
      [...running.values()].map(async (r) => {
        await r.child?.kill().catch(() => {});
        await r.done;
      }),
    );
    ctx = undefined;
  },
};
