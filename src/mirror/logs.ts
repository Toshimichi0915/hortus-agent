/**
 * The `logs` DOF: plain files, no repo. `publishLog` renders a task's core sessions into `logs/<id>/session.md`,
 * copies its summary, and upserts both index rows in the same call.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Message, SessionEntry } from "@hortus/core";
import { type DatabaseSync, now } from "../db.ts";
import { MAX_ENTRIES, MAX_SESSION, MAX_SESSIONS, MAX_SUMMARY, readCapped, readDir } from "../hostile.ts";
import { logger } from "../log.ts";
import * as paths from "../paths.ts";
import { remove, upsert } from "./fts.ts";
import { parse, render } from "./render.ts";
import { writeAtomic } from "./repo.ts";

const EXCERPT = 4096;
export const MAX_RENDER = 16 * 1024 * 1024;
const log = logger("logs");

/** A fence longer than any backtick run inside, so tool output can't close it. */
function fenced(lang: string, text: string): string {
  const run = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const f = "`".repeat(run + 1);
  return `${f}${lang}\n${text}${text.endsWith("\n") ? "" : "\n"}${f}`;
}

function excerpt(output: string): string {
  const bytes = Buffer.byteLength(output);
  if (bytes <= EXCERPT) return output;
  return `${Buffer.from(output).subarray(0, EXCERPT).toString()}\n… (${bytes} bytes)`;
}

const CUT = Symbol("cut");

/**
 * `JSON.stringify(v, null, 2)` cut at `max` chars, at a cost bounded by `max`: the input is the Worker's, and a 6 KB
 * line nested 3,000 deep pretty-prints to 18 MB (a session of them ran hortusd out of memory).
 */
export function pretty(v: unknown, max = EXCERPT): string {
  let out = "";
  const w = (s: string) => {
    out += s;
    if (out.length > max) throw CUT;
  };
  const go = (x: unknown, ind: string): void => {
    if (x === null || typeof x !== "object") {
      w(JSON.stringify(x) ?? "null");
      return;
    }
    const arr = Array.isArray(x);
    const items: [string, unknown][] = arr ? x.map((e, i) => [String(i), e]) : Object.entries(x);
    if (!items.length) {
      w(arr ? "[]" : "{}");
      return;
    }
    w(arr ? "[\n" : "{\n");
    items.forEach(([k, e], i) => {
      w(`${ind}  ${arr ? "" : `${JSON.stringify(k)}: `}`);
      go(e, `${ind}  `);
      w(i < items.length - 1 ? ",\n" : "\n");
    });
    w(`${ind}${arr ? "]" : "}"}`);
  };
  try {
    go(v, "");
  } catch (e) {
    if (e !== CUT) throw e;
    return `${out.slice(0, max)}\n… (cut at ${max} chars)`;
  }
  return out;
}

function renderMessage(m: Message): string {
  if (m.role === "user") return m.content;
  if (m.role === "assistant") {
    const calls = m.toolCalls.map((c) => fenced("json", pretty({ name: c.name, input: c.input })));
    return [m.text, ...calls].filter(Boolean).join("\n\n");
  }
  return m.results.map((r) => (r.image ? "[image]" : fenced("", excerpt(r.output)))).join("\n\n");
}

/** Same as core's reader: a line cut short by a crash is skipped (and so is anything but an object). */
const entries = (text: string): SessionEntry[] =>
  text.split("\n").flatMap((line) => {
    try {
      const e: unknown = line ? JSON.parse(line) : null;
      return e && typeof e === "object" ? [e as SessionEntry] : [];
    } catch {
      return [];
    }
  });

/**
 * The last entry's branch, root first, as core's `branch` replays it, but with a visited set: these entries are the
 * Worker's, and two lines whose `parentId`s point at each other would loop core's walk (and hortusd) forever.
 */
function messagesOf(all: SessionEntry[]): Message[] {
  const byId = new Map(all.map((e) => [e.id, e]));
  const seen = new Set<unknown>();
  const path: SessionEntry[] = [];
  for (let e = all.at(-1); e && !seen.has(e.id); e = e.parentId == null ? undefined : byId.get(e.parentId)) {
    seen.add(e.id);
    path.push(e);
  }
  return path.reverse().flatMap((e) => (e.v === 1 && e.type === "message" ? [e.message] : []));
}

/**
 * Every `*.jsonl` in `dir`, in name order (lexical = chronological), each replayed along its leaf's branch.
 * ponytail: entries carry no time, so `<ts>` is the session file's start; per-message times need a core change
 */
export async function renderSession(dir: string): Promise<string> {
  // read here, not with core's listSessions: out/sessions is the Worker's, so no links, FIFOs, unbounded files or counts
  const out: string[] = [];
  let seq = 0;
  let budget = MAX_SESSIONS;
  // the rendered text is capped too: 256 MB of the Worker's user turns rendered to 255 MB, held in RSS at every exit
  let room = MAX_RENDER;
  readDir(
    dir,
    (n) => n.endsWith(".jsonl"),
    MAX_ENTRIES,
    (names, read, dropped) => {
      if (dropped) log.error(`${dropped} session files not rendered`, undefined, { dir });
      for (const n of names) {
        if (budget <= 0) break;
        const text = read(n, Math.min(MAX_SESSION, budget))?.text ?? "";
        budget -= text.length;
        // a planted `zzz.jsonl` has no start time (and must not make every publish throw)
        const t = Number(n.split("_")[0]) * 1000;
        const ts = Number.isFinite(t) && Math.abs(t) <= 8.64e15 ? new Date(t).toISOString() : "?";
        for (const m of messagesOf(entries(text))) {
          let md: string;
          try {
            md = renderMessage(m);
          } catch {
            md = "(not a message)"; // a planted line of the wrong shape loses itself, not the log
          }
          const s = `## ${++seq} ${String(m?.role)} ${ts}\n\n${md}\n`;
          room -= s.length + 1;
          if (room < 0) {
            out.push(`… (session log cut at ${MAX_RENDER / 1024 / 1024} MB)\n`);
            return;
          }
          out.push(s);
        }
      }
    },
  );
  return out.join("\n");
}

const safeId = (id: string): boolean => /^[A-Za-z0-9_-]+$/.test(id);

/** Write `logs/<taskId>/<name>` files (temp + rename) and upsert their index rows: `title` given, `ts` now. */
export function writeLog(db: DatabaseSync, taskId: string, files: Record<string, string>, title = taskId): void {
  if (!safeId(taskId)) throw new Error(`bad task id ${taskId}`);
  const ts = now();
  for (const [name, text] of Object.entries(files)) {
    if (!safeId(name.replace(/\.md$/, ""))) throw new Error(`bad log file name ${name}`);
    writeAtomic(join(paths.logs(), taskId, name), text);
    upsert(db, { dof: "logs", path: `${taskId}/${name}`, author: "", ts, title, body: parse(text).body });
  }
}

/** `logs/<taskId>/` gone, and its index rows. */
export function removeLog(db: DatabaseSync, taskId: string): void {
  if (!safeId(taskId)) throw new Error(`bad task id ${taskId}`);
  rmSync(join(paths.logs(), taskId), { recursive: true, force: true });
  for (const f of ["summary.md", "session.md"]) remove(db, "logs", `${taskId}/${f}`);
}

/** Render the task's sessions and summary into the `logs` DOF; every exit replaces both files. */
export async function publishLog(
  db: DatabaseSync,
  taskId: string,
  title: string,
  status: string,
  events?: string[],
): Promise<void> {
  const out = paths.out(taskId);
  // the row: a card's `## Ended` belongs in the record the Planner reads for a follow-up, and only the row has it (the
  // file is the Worker's). A log saying "open, not merged" of a merged PR sent 2 of 2 follow-ups to its dead branch
  const t = db.prepare("SELECT summary, created, event_keys FROM tasks WHERE id = ?").get(taskId) as
    | { summary: string | null; created: string | null; event_keys: string | null }
    | undefined;
  const summary = t?.summary ?? readCapped(join(out, "summary.md"), MAX_SUMMARY)?.text ?? "No summary.\n";
  const keys = events ?? (t?.event_keys ? (JSON.parse(t.event_keys) as string[]) : undefined);
  const header = {
    title,
    status,
    ...(keys ? { events: keys } : {}),
    ...(t?.created ? { opened: t.created } : {}),
    updated: now(),
  };
  writeLog(
    db,
    taskId,
    { "summary.md": render(header, summary), "session.md": await renderSession(join(out, "sessions")) },
    title,
  );
}
