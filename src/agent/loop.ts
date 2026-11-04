/**
 * The Worker loop (v6 Worker, 05-agent.md › Loop), shared by every kind: the kind's plugin says what the agent is, the
 * observer here keeps the session, stdout and the abort conditions.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { createAgent, listSessions, type Message, openSession, type Plugin, type Session } from "@hortus/core";
import { AUX_TOKENS, MAX_ENTRIES, MAX_SESSION, MAX_SESSIONS, readCapped, readDir } from "../hostile.ts";
import { logger } from "../log.ts";
import type { TaskJson } from "../types.ts";
import { drain, marker, pending, quote } from "./inbox.ts";
import { writeOutbox } from "./outbox.ts";
import { formatScript, runScript } from "./script.ts";
import { out, outMessage } from "./stdout.ts";
import { handoff, summarize } from "./summary.ts";

/** Builds the kind's plugin; `onDone(summary)` ends the loop after the current tool. */
export type KindPlugin = (onDone: (summary: string) => void) => Plugin;

type Usage = NonNullable<Extract<Message, { role: "assistant" }>["usage"]>;

/** Tokens over every session file (handoffs included) and the highest `[inbox N]` marker in them. */
export function scan(dir: string): { tokens: number; cursor: number } {
  let tokens = 0;
  let cursor = 0;
  // hortusd runs this over a Worker's directory too: no links, FIFOs, unbounded files or file counts
  let budget = MAX_SESSIONS;
  // the Worker's file: `null` lines, strings, negative or non-number usage must neither throw nor shrink the count
  // (and 1e308 twice is Infinity: one usage is under 1e12)
  const n = (x: unknown): number => (typeof x === "number" && x > 0 && x < 1e12 ? x : 0);
  const count = (text: string) => {
    budget -= text.length;
    // a session's first user message is the brief (or a run's text, a handoff's notes), never a drained message: a
    // brief that happens to start with `[inbox 99]` must not hide messages 1–99
    let first = true;
    for (const line of text.split("\n")) {
      let e: { type?: string; message?: Message } | null;
      try {
        e = JSON.parse(line);
      } catch {
        continue; // empty, or cut short by a crash
      }
      const m = e?.type === "message" ? e.message : undefined;
      if (m?.role === "assistant") tokens += n(m.usage?.input) + n(m.usage?.output);
      if (m?.role === "user" && !first && typeof m.content === "string")
        cursor = Math.max(cursor, marker(m.content) ?? 0);
      if (m?.role === "user") first = false;
    }
  };
  readDir(
    dir,
    (n) => n.endsWith(".jsonl"),
    MAX_ENTRIES,
    (names, read, dropped) => {
      if (dropped) logger("scan").error(`${dropped} session files ignored`, undefined, { dir });
      for (const n of names) if (budget > 0) count(read(n, Math.min(MAX_SESSION, budget))?.text ?? "");
    },
  );
  tokens += n(Number(readCapped(join(dirname(dir), AUX_TOKENS), 32)?.text));
  return { tokens, cursor };
}

/**
 * The latest session (by last write: a handoff can start a file within the same second), or a new one. A tool call
 * the previous process died in gets an error result, so providers never see a dangling call.
 */
export async function resume(dir: string): Promise<Session> {
  const latest = (await listSessions(dir))
    .map((s) => ({ s, t: statSync(s.path).mtimeMs }))
    .sort((a, b) => b.t - a.t)[0]?.s;
  const session = await openSession(latest?.leafId ?? null, dir);
  const last = session.getState().messages.at(-1);
  if (last?.role === "assistant" && last.toolCalls.length)
    await session.append([
      {
        role: "tool",
        results: last.toolCalls.map((c) => ({ id: c.id, output: "interrupted by restart", isError: true })),
      },
    ]);
  return session;
}

/** `last-summary.md` (hortusd copies it from the previous run's summary.md), at most 64 KB; "" when missing. */
function readSummary(dir: string): string {
  try {
    return readFileSync(join(dir, "last-summary.md"), "utf8")
      .slice(0, 64 * 1024)
      .trim();
  } catch {
    return "";
  }
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Runs the task in `dir` to its end; returns the exit code. */
export async function runTask(dir: string, task: TaskJson, kindPlugin: KindPlugin): Promise<number> {
  const sessionsDir = join(dir, "out", "sessions");
  const started = Date.now();
  let { tokens, cursor } = scan(sessionsDir);
  let session = await resume(sessionsDir);
  let lastUsage: Usage | undefined;
  for (const m of session.getState().messages) if (m.role === "assistant") lastUsage = m.usage;
  let abort = new AbortController();
  let done = false;
  let emptyDone = false;
  let errors = 0;

  const stopped = () => existsSync(join(dir, "ctl", "STOP"));
  const hasInbox = () => pending(dir, cursor).length > 0;
  const hours = () => task.hours_used + (Date.now() - started) / 3_600_000;
  const overBudget = () => tokens >= task.budget.tokens || hours() >= task.budget.hours;
  let window = task.context_window;
  const contextFull = () => !!lastUsage && lastUsage.input + lastUsage.output > 0.7 * window;
  const append = async (msgs: Message[]) => {
    await session.append(msgs);
    for (const m of msgs) outMessage(m);
  };

  const observer: Plugin = {
    on: {
      text: (text) => out({ type: "text", text }),
      thinking: (text) => out({ type: "thinking", text }),
      tool_call: (c) => out({ type: "tool_call", id: c.id, name: c.name, input: c.input }),
      message: async (m) => {
        if (m.role === "assistant") {
          tokens += (m.usage?.input ?? 0) + (m.usage?.output ?? 0);
          lastUsage = m.usage;
          errors = 0;
        }
        await append([m]); // per message, so a crash loses nothing
        // polled here directly (one readdir + stat per tool result), not only by the timer, so steering lands right
        // after the tool that was running; no inotify (virtiofs)
        if (m.role === "tool" && (done || hasInbox() || stopped() || overBudget() || contextFull())) abort.abort();
      },
    },
  };
  const agent = await createAgent({
    extra: [
      kindPlugin((summary) => {
        done = true;
        emptyDone = !summary;
      }),
      observer,
    ],
  });
  const { provider } = await agent.resolve({ provider: task.provider, model: task.model });
  window = (await provider.contextWindow?.(task.model).catch(() => undefined)) ?? task.context_window;

  // STOP is the owner's button: abort a stream too (a running tool still finishes, its result is kept)
  const timer = setInterval(() => stopped() && abort.abort(), 1000);
  timer.unref();
  try {
    if (session.getState().messages.length === 0) {
      // a run (3c): the row's text, the previous run's summary, the script's output
      const first = [task.brief];
      const last = task.kind === "run" && task.paths.schedule && readSummary(task.paths.schedule);
      if (last) first.push(`[previous run's summary]\n${quote(last)}`);
      if (task.kind === "run" && task.script) {
        const r = await runScript(task.script, task.paths.schedule ?? task.paths.work);
        if (r.code === 0 && !r.killed && !r.stdout.trim()) {
          writeOutbox(dir, "result", ""); // a quiet watch: no model call, hortusd deletes the run
          out({ type: "status", text: "script: nothing to do" });
          return 0;
        }
        first.push(formatScript(r));
      }
      await append([{ role: "user", content: first.join("\n\n") }]);
    }

    let end: "done" | "stop" | "budget" | "idle" | "failed";
    let failure = "";
    const halt = () => (stopped() ? "stop" : overBudget() ? "budget" : undefined);
    for (;;) {
      const h = halt();
      if (h) {
        end = h;
        break;
      }
      const msgs = drain(dir, cursor);
      if (msgs.length) {
        cursor = Math.max(cursor, ...msgs.map((m) => m.seq));
        await append(msgs.map((m) => ({ role: "user", content: m.text })));
      }
      abort = new AbortController();
      try {
        const { signal } = abort;
        await agent.run(session.getState().messages, {
          provider: task.provider,
          model: task.model,
          signal,
          ...(task.effort && { effort: task.effort }),
        });
      } catch (e) {
        if (!abort.signal.aborted) {
          failure = errorText(e);
          out({ type: "error", message: failure });
          await append([{ role: "user", content: `[error] ${failure}` }]);
          if (++errors > 3) {
            end = "failed";
            break;
          }
          // a rate limit or an overloaded provider: back off (0.5, 1, 2 s) rather than burn the retries at once
          await new Promise((r) => setTimeout(r, 500 * 2 ** (errors - 1)));
          continue;
        }
      }
      if (done) {
        end = "done";
        break;
      }
      const h2 = halt();
      if (h2) {
        end = h2;
        break;
      }
      const full = contextFull();
      // a final answer with nothing new is idle; an abort for a full context continues in a new one
      if (!hasInbox() && !(abort.signal.aborted && full)) {
        end = "idle";
        break;
      }
      if (full) {
        try {
          const progress = await handoff(
            agent,
            task,
            session.getState().messages,
            join(task.paths.work, "PROGRESS.md"),
          );
          session = await openSession(null, sessionsDir);
          lastUsage = undefined;
          out({ type: "status", text: "context full: continuing in a new session" });
          await append([
            { role: "user", content: `${task.brief}\n\n# PROGRESS.md (your notes so far)\n\n${progress}` },
          ]);
        } catch (e) {
          out({ type: "error", message: `handoff failed: ${errorText(e)}` });
        }
      }
    }

    out({ type: "status", text: end });
    if (end === "failed") {
      writeOutbox(dir, "result", `failed: ${failure}`);
      return 1;
    }
    if (end === "budget")
      writeOutbox(
        dir,
        "budget_exceeded",
        `budget exceeded: ${tokens}/${task.budget.tokens} tokens, ${hours().toFixed(2)}/${task.budget.hours} hours`,
      );
    // a Planner batch has no summary: its verdicts were RPCs and its final text is discarded
    if (end === "stop" || emptyDone || task.kind === "planner") return 0;
    try {
      await summarize(agent, task, session.getState().messages, join(dir, "out", "summary.md"));
    } catch (e) {
      out({ type: "error", message: `summary failed: ${errorText(e)}` });
    }
    return 0;
  } finally {
    clearInterval(timer);
  }
}
