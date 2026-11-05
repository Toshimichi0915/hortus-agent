/**
 * The dispatcher (07-step3-runtime.md): every second and on `wake()`, start each `queued` host task unless `PAUSED`;
 * relay a session's stdout into `replies`; on exit read `out/` as hostile input and move the status on. A new kind is a
 * row in KINDS; a runtime is a `start` (`host.spawnSandboxed`, `vm.startVm`), picked by the task's `runtime` column.
 * VM tasks start below `vm.max_concurrent`; with the image missing they run on the host (`vm.fallback_host`, v7) or
 * stay queued with the reason in `error`.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { scan } from "../agent/loop.ts";
import type { Config } from "../config.ts";
import { bus } from "../console/events.ts";
import type { Ctx, Module } from "../ctx.ts";
import { now } from "../db.ts";
import { appendText, MAX_ENTRIES, MAX_LINE, readCapped, readDir } from "../hostile.ts";
import { publishLog } from "../mirror/index.ts";
import * as paths from "../paths.ts";
import { prepareClone, startSync } from "../projects/origin.ts";
import { links, listen, listenOpts } from "../proxy/index.ts";
import type { OutboxMsg, StdoutLine, TaskJson, TaskKind } from "../types.ts";
import { agentCmd, type Child, type Exit, type Loopback, spawnSandboxed } from "./host.ts";
import type { Kind } from "./landlock.ts";
import { recover } from "./recovery.ts";
import * as tasks from "./tasks.ts";
import { missingImage, startVm } from "./vm.ts";

/** Per kind: the Landlock profile and whether every stdout line is a chat reply. `planner` runs through runPlanner. */
const KINDS: Record<TaskKind, { profile: Kind; chat: boolean }> = {
  chat: { profile: "chat", chat: true },
  unattended: { profile: "unattended", chat: false },
  run: { profile: "unattended", chat: false },
  planner: { profile: "unattended", chat: false },
};

/** Called after an exit that produced a `result` or `budget_exceeded` (step 4 wakes the Planner for non-chat tasks; 3c
 * closes empty runs). */
export const exitHooks = {
  onResult(_task: tasks.TaskRow, _msg: OutboxMsg): void {},
  /** After every session exit with the fresh row and the new outbox messages (3c: a run's accounting and close). */
  onExit: [] as ((task: tasks.TaskRow, msgs: OutboxMsg[]) => void)[],
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
  /** a Worker session's `hours` so far (its row's at start + the time since), persisted by the tick */
  hours?: () => number;
}

/** how often the tick writes a running session's `hours`: a hortusd killed mid-run loses at most this much of it,
 * where it lost the whole run (and its VM got the full remaining budget again after the restart) */
const HOURS_EVERY_MS = 5000;
let hoursSaved = 0;

function saveHours(): void {
  if (Date.now() - hoursSaved < HOURS_EVERY_MS) return;
  hoursSaved = Date.now();
  const q = db().prepare("UPDATE tasks SET hours = ? WHERE id = ? AND status = 'running'");
  for (const [id, r] of running) if (r.hours) q.run(r.hours(), id);
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
    saveHours();
    if (existsSync(paths.paused())) return;
    const rows = db()
      .prepare("SELECT * FROM tasks WHERE status = 'queued' AND kind != 'planner' ORDER BY updated")
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
 * session's link lets `dof` reach hortusd.internal through the proxy's plain listener on 127.0.0.1 (env below), and
 * the alias's own listeners take its git (sandboxEnv's NO_NET insteadOf); nothing is intercepted transparently.
 */
async function loopbackLink(
  id: string,
  role: "worker" | "planner",
): Promise<{ env: Record<string, string>; loopback?: Loopback }> {
  if (process.env.HORTUS_NO_NET !== "1" || !ctx) return { env: {} };
  const taken = new Set(
    (db().prepare("SELECT address FROM links").all() as { address: string }[]).map((r) => r.address),
  );
  let address: string | undefined;
  for (let n = 2; n <= 254 && !address; n++) if (!taken.has(`127.0.0.${n}`)) address = `127.0.0.${n}`;
  if (!address) throw new Error("no loopback alias free"); // as sessionNet.open: no session without its address
  links.register(address, role, id, "session");
  const { http } = await listen("127.0.0.1", listenOpts(ctx));
  // a listener on the alias itself, for git (forge clones; prepareClone reuses it for the project origin)
  // ponytail: the alias keeps its listener after the session (reused by the next task on it); test mode only
  const { https } = await listen(address, { https: 0, http: 0, dns: 0, proxyAddress: "127.0.0.1" });
  return { env: { HORTUS_RPC: `http://127.0.0.1:${http}`, HORTUS_RPC_LOCAL: address }, loopback: { address, https } };
}

function releaseLinks(id: string): void {
  if (process.env.HORTUS_NO_NET !== "1") return;
  const rows = db().prepare("SELECT address FROM links WHERE task_id = ? AND kind = 'session'").all(id) as {
    address: string;
  }[];
  for (const r of rows) links.release(r.address);
}

/** `vm`: boot it with startVm; `note`: a status line on the card (the host fallback for a VM task). */
const SPAWNS: links.Client = { role: "core" };

function start(row: tasks.TaskRow, vm: boolean, note?: string): void {
  if (!ctx) return;
  const c = ctx.config;
  const kind = KINDS[row.kind] ?? KINDS.unattended;
  const startedAt = Date.now();
  tasks.setStatus(row.id, "running", { started: now(), error: null });
  // finish adds to row.hours (the value at start), so the tick's writes in between are never counted twice
  const entry: Running = { vm, done: Promise.resolve(), hours: () => row.hours + (Date.now() - startedAt) / 3.6e6 };
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
      const say = (text: string) => reply(row.id, { type: "status", text });
      if (note) say(note);
      if (vm) {
        // round 8: the guest clones the origin itself, so sync it first (a host task's prepareClone does); without
        // it a VM task cloned an empty origin (or a stale main) and its merge was refused as "not based on main"
        if (task.scope.project && task.paths.clone) await startSync(task.scope.project, say);
        const deadlineMs = Math.max(0, (task.budget.hours - row.hours) * 3.6e6);
        const child = await startVm({ task, config: c, deadlineMs });
        entry.child = child;
        if (stopping || tasks.closing.has(row.id)) await child.kill(); // while it booted: no child to kill yet
        const exit = await child.wait();
        // startVm SIGKILLs QEMU at the deadline: the Worker could not write budget_exceeded, so hortusd notes it
        // a boot timeout: the card's error says so above the serial output's tail (slice(-2000) keeps both)
        await finish(
          row,
          exit,
          startedAt,
          exit.error && `${exit.error}\n${tail(consoleLog, 1500)}`,
          exit.signal === "SIGKILL" && Date.now() - startedAt >= deadlineMs,
        );
        return;
      }
      const { env, loopback } = await loopbackLink(row.id, row.kind === "planner" ? "planner" : "worker");
      // 3b: sync the origin and pre-clone clones/<id> (Landlock grants rw on it only if it exists at spawn; v7)
      await prepareClone(task, env.HORTUS_RPC_LOCAL, say);
      if (kind.chat) reply(row.id, { type: "status", text: "started" });
      // the Landlock profile walk and the spawn are ~8 ms of hortusd's thread each: 20 chats opened at once ran them
      // back to back (180 ms, the console's p95 150 ms); one per loop turn, in line with the Workers' requests
      await links.turn(SPAWNS);
      const child = await spawnSandboxed({
        task,
        kind: kind.profile,
        cmd: agentCmd(row.id),
        cwd: task.paths.work,
        env,
        config: c,
        ...(loopback ? { loopback } : {}),
        onStdout(l) {
          let line: StdoutLine | undefined;
          try {
            line = JSON.parse(l) as StdoutLine;
          } catch {}
          // the Worker's stdout: a `message` or `text` of any type, and no end to the thinking deltas
          if (line?.type === "error") lastError = String(line.message);
          // thinking deltas become one row (the page folds it), flushed by the next other line, the exit or the cap
          if (line?.type === "thinking") {
            thinking += String(line.text);
            if (thinking.length > MAX_LINE) flushThinking();
            return;
          }
          flushThinking();
          // the line as the Worker wrote it: re-serializing its JSON throws on one nested a million deep
          if (kind.chat) reply(row.id, l);
          else {
            if (line?.type === "error" || line?.type === "status") reply(row.id, l);
            appendText(consoleLog, `${l}\n`);
          }
        },
      });
      entry.child = child;
      if (stopping || tasks.closing.has(row.id)) await child.kill(); // while it started: no child to kill yet
      const exit = await child.wait();
      flushThinking();
      await finish(row, exit, startedAt, lastError);
    } catch (e) {
      // could not start (no Landlock, no session address, no provider): waiting with the reason, no retry loop
      const message = e instanceof Error ? e.message : String(e);
      log().error("start failed", e, { task: row.id });
      if (!stopping) {
        tasks.setStatus(row.id, "waiting", { error: message, hours: row.hours + (Date.now() - startedAt) / 3.6e6 });
        if (row.kind !== "chat" && !tasks.closing.has(row.id)) {
          tasks.failureRow(row.id, "result", `failed: ${message}`);
          tasks.hooks.failed(`task ${row.id} failed; what you last sent it may be unanswered`);
        }
      }
      reply(row.id, { type: "error", message });
    } finally {
      clearTimeout(entry.stopTimer);
      releaseLinks(row.id);
      running.delete(row.id);
      wake();
    }
  })();
}

/** New `out/outbox/<seq>.json` files, as hostile input: regular files only, ≤ 1 MB, schema-checked, seq = name. */
export function readOutbox(id: string, after: number): OutboxMsg[] {
  const fresh = (n: string) => /^\d{6}\.json$/.test(n) && Number(n.slice(0, 6)) > after;
  return (
    readDir(join(paths.out(id), "outbox"), fresh, MAX_ENTRIES, (names, read, dropped) => {
      if (dropped) log().error(`${dropped} outbox files left for the next read`, undefined, { task: id });
      return names.flatMap((name) => outboxFile(id, name, read(name, MAX_OUTBOX + 1)) ?? []);
    }) ?? []
  );
}

function outboxFile(id: string, name: string, f: { text: string; size: number } | null): OutboxMsg | undefined {
  const bad = (why: string) => void log().error(`outbox file ignored: ${why}`, undefined, { task: id, name });
  if (!f) return bad("not a regular file");
  if (f.size > MAX_OUTBOX) return bad(`${f.size} bytes`);
  let m: z.infer<typeof Outbox>;
  try {
    m = Outbox.parse(JSON.parse(f.text));
  } catch (e) {
    return bad(e instanceof Error ? e.message.slice(0, 200) : "invalid");
  }
  if (m.seq !== Number(name.slice(0, 6))) return bad(`seq ${m.seq} in ${name}`);
  return m;
}

function tail(path: string, bytes = 2000): string {
  return readCapped(path, bytes, true)?.text.replace(/\r/g, "").trim() ?? ""; // a serial console ends lines with \r\n
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
  // a crash after a `send` still shows its error; a `result` (failed: …) or budget_exceeded already says why
  const failed = exit.code !== 0 && !msgs.some((m) => m.type === "result" || m.type === "budget_exceeded");
  // the Worker gave up (its model calls failed 4 times: `result` "failed: …"): on the card too, so only the owner
  // starts it again (tasks.inboxWrite), not every approval or note re-running the failure
  const gaveUp = msgs.find((m) => m.type === "result" && m.text.startsWith("failed: "))?.text;
  // and an exhausted budget likewise: nothing but the owner's raise makes a new start worth anything
  const spent = msgs.find((m) => m.type === "budget_exceeded")?.text;
  // a session hortusd or the owner ended (shutdown, close, a STOP killed after 30 s) did not fail: killed, it exits
  // non-zero with no result, and the card said so; after a restart that error also stopped approvals starting the chat
  // (tasks.ts › restarts)
  const error =
    stopping || tasks.closing.has(id) || existsSync(join(paths.ctl(id), "STOP"))
      ? null
      : overBudget
        ? `budget_exceeded: the VM was stopped after ${hours.toFixed(2)} h (budget hours)`
        : failed
          ? (lastError ?? (tail(join(out, "console.log")) || `exit ${exit.code ?? exit.signal}`)).slice(-2000)
          : spent !== undefined
            ? `budget_exceeded: ${spent.slice(0, 2000)}`
            : (gaveUp?.slice(0, 2000) ?? null);
  const fresh = tasks.get(id);
  // what reached the inbox during this session: an older message a clean exit left behind is the Worker's choice (it
  // drains at its start), and re-queueing on it let a hostile one boot again for its whole `hours`, a Planner batch each
  const { n: inbox } = d
    .prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM inbox WHERE task_id = ? AND created > ?")
    .get(id, fresh.started ?? "") as { n: number };
  const current = fresh.status;
  // `runs`: tokens its schedule runs charged to this task (3c), kept on top of its own sessions' count
  const runs = (JSON.parse(fresh.usage ?? "{}") as { runs?: number }).runs ?? 0;
  const usage = JSON.stringify(runs ? { tokens: tokens + runs, runs } : { tokens });
  const extra = { hours, usage, summary: summary ?? row.summary, error };
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
    // an owner message the Worker never drained re-queues it; a crash waits for the next message (no restart loop),
    // and so do a STOP and an exhausted budget (both exit 0 without draining: re-queueing them would loop)
    const halted =
      overBudget || msgs.some((m) => m.type === "budget_exceeded") || existsSync(join(paths.ctl(id), "STOP"));
    tasks.setStatus(id, exit.code === 0 && inbox > cursor && !halted ? "queued" : "waiting", extra);
  }
  if (error) reply(id, { type: "error", message: error });
  // `error` is this session's, so once per failure, and no restart re-reads it. A chat's owner is at the keyboard and
  // the stream shows it; a Worker's own `result`/`budget_exceeded` already is the Planner's row
  if (error && row.kind !== "chat") {
    const budget = error.startsWith("budget_exceeded");
    if (!msgs.some((m) => m.type !== "reply"))
      tasks.failureRow(id, budget ? "budget_exceeded" : "result", budget ? error : `failed: ${error}`);
    // what it drained into this turn is in its session, unanswered, and the next owner message resumes it
    tasks.hooks.failed(
      budget ? `task ${id} is over budget` : `task ${id} failed; what you last sent it may be unanswered`,
    );
  }
  log().info("session ended", { task: id, code: exit.code, signal: exit.signal, outbox: msgs.length });
  await publishLog(id, row.title, tasks.get(id).status).catch((e) => log().error("publishLog failed", e, { task: id }));
  if (!stopping)
    for (const h of exitHooks.onExit)
      try {
        h(tasks.get(id), msgs);
      } catch (e) {
        log().error("exit hook failed", e, { task: id });
      }
  for (const m of msgs) if (m.type !== "reply") exitHooks.onResult(tasks.get(id), m);
}

/** Where a Planner batch runs (`planner.runtime`, 15-planner.md); a Worker VM (3g) is the same `vm` row. */
const RUNTIMES: Record<"host" | "vm", (task: TaskJson, onStdout: (l: string) => void) => Promise<Child>> = {
  host: async (task, onStdout) => {
    const { env } = await loopbackLink(task.id, "planner");
    const c = ctx?.config as Config;
    return spawnSandboxed({
      task,
      kind: KINDS.planner.profile,
      cmd: agentCmd(task.id),
      cwd: task.paths.work,
      env,
      config: c,
      onStdout,
    });
  },
  vm: (task) => startVm({ task, config: ctx?.config as Config, deadlineMs: task.budget.hours * 3.6e6 }),
};

/** Not a task, so no Planner row (a batch that dies on its own failure would be fed it again); its events stay consumed
 * (15-planner.md › Wake and batch), so the owner's message may have gone unanswered: the DM is what says so. */
const BATCH_FAILED = "a Planner batch failed: its events may be unrouted";

/**
 * One Planner batch: `row` (kind planner, inserted `running` by the planner module, which deletes it and its directory
 * afterwards) runs to its exit as role `planner`; returns the tokens its session used. Stdout goes to console.log only.
 */
export async function runPlanner(row: tasks.TaskRow, task: TaskJson, runtime: "host" | "vm"): Promise<number> {
  if (!ctx || stopping) throw new Error("dispatcher not started");
  tasks.prepare(ctx.config, task);
  const consoleLog = join(paths.out(row.id), "console.log");
  let release = () => {};
  const entry: Running = { vm: runtime === "vm", done: new Promise<void>((r) => (release = r)) };
  running.set(row.id, entry);
  try {
    entry.child = await RUNTIMES[runtime](task, (l) => appendText(consoleLog, `${l}\n`));
    if (stopping) await entry.child.kill();
    const exit = await entry.child.wait();
    const { tokens } = scan(join(paths.out(row.id), "sessions"));
    log().info("planner batch ended", { task: row.id, code: exit.code, signal: exit.signal, tokens });
    if (exit.code !== 0 && !stopping) tasks.hooks.failed(BATCH_FAILED);
    return tokens;
  } catch (e) {
    if (!stopping) tasks.hooks.failed(BATCH_FAILED);
    throw e;
  } finally {
    releaseLinks(row.id);
    running.delete(row.id);
    release();
  }
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
      r.stopTimer = setTimeout(
        () => void r.child?.kill().catch((e) => log().error("stop kill failed", e, { task: id })),
        STOP_KILL_MS,
      );
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
