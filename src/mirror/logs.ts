/**
 * The `logs` DOF: plain files, no repo. `publishLog` renders a task's core sessions into `logs/<id>/session.md`,
 * copies its summary, and upserts both index rows in the same call.
 */
import { join } from "node:path";
import { branch, type Message, type SessionEntry } from "@hortus/core";
import { type DatabaseSync, now } from "../db.ts";
import { MAX_ENTRIES, MAX_SESSION, MAX_SESSIONS, MAX_SUMMARY, readCapped, readDir } from "../hostile.ts";
import { logger } from "../log.ts";
import * as paths from "../paths.ts";
import { upsert } from "./fts.ts";
import { parse, render } from "./render.ts";
import { writeAtomic } from "./repo.ts";

const EXCERPT = 4096;
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

function renderMessage(m: Message): string {
  if (m.role === "user") return m.content;
  if (m.role === "assistant") {
    const calls = m.toolCalls.map((c) => fenced("json", JSON.stringify({ name: c.name, input: c.input }, null, 2)));
    return [m.text, ...calls].filter(Boolean).join("\n\n");
  }
  return m.results.map((r) => (r.image ? "[image]" : fenced("", excerpt(r.output)))).join("\n\n");
}

/** Same as core's reader: a line cut short by a crash is skipped. */
const entries = (text: string): SessionEntry[] =>
  text.split("\n").flatMap((line) => {
    try {
      return line ? [JSON.parse(line) as SessionEntry] : [];
    } catch {
      return [];
    }
  });

/**
 * Every `*.jsonl` in `dir`, in name order (lexical = chronological), each replayed along its leaf's branch.
 * ponytail: entries carry no time, so `<ts>` is the session file's start; per-message times need a core change
 */
export async function renderSession(dir: string): Promise<string> {
  // read here, not with core's listSessions: out/sessions is the Worker's, so no links, FIFOs, unbounded files or counts
  const out: string[] = [];
  let seq = 0;
  let budget = MAX_SESSIONS;
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
        const all = entries(text);
        const leaf = all.at(-1);
        if (!leaf) continue;
        // a planted `zzz.jsonl` has no start time (and must not make every publish throw)
        const t = Number(n.split("_")[0]) * 1000;
        const ts = Number.isFinite(t) && Math.abs(t) <= 8.64e15 ? new Date(t).toISOString() : "?";
        for (const m of branch(all, leaf.id).messages) {
          out.push(`## ${++seq} ${m.role} ${ts}\n\n${renderMessage(m)}\n`);
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

/** Render the task's sessions and summary into the `logs` DOF; every exit replaces both files. */
export async function publishLog(
  db: DatabaseSync,
  taskId: string,
  title: string,
  status: string,
  events?: string[],
): Promise<void> {
  const out = paths.out(taskId);
  const summary = readCapped(join(out, "summary.md"), MAX_SUMMARY)?.text ?? "No summary.\n";
  const header = { title, status, ...(events ? { events } : {}), updated: now() };
  writeLog(
    db,
    taskId,
    { "summary.md": render(header, summary), "session.md": await renderSession(join(out, "sessions")) },
    title,
  );
}
