/**
 * A task's rows as a conversation's turns, for web/src/thread.tsx. It runs in web/ and imports nothing of node's. A row
 * is the Worker's line, so nothing here trusts its shape: whatever a line holds comes out as a string a page can render.
 */

export interface TurnRow {
  seq: number;
  body: unknown;
  created: string | null;
}

export interface Tool {
  kind: "tool";
  id: string;
  name: string;
  input: unknown;
  output?: string;
  isError?: boolean;
}

export type Part =
  | { kind: "text"; text: string; closed?: boolean }
  | { kind: "thinking"; text: string }
  | Tool
  | { kind: "status"; text: string }
  | { kind: "error"; text: string };

export interface Turn {
  role: "user" | "assistant";
  key: number;
  /** the turn's first row and its latest */
  started: string | null;
  at: string | null;
  parts: Part[];
}

/** A line's field as text; JSON for what is not a string, and what cannot be serialized (nested too deep) as a note. */
export function str(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v ?? "");
  } catch {
    return "(a line too deep to show)";
  }
}

const isOwner = (r: TurnRow) => (r.body as { type?: unknown } | null)?.type === "owner";

/** The newest well-formed `context` row: how full the session's context is. */
export function contextOf(rows: TurnRow[]): { tokens: number; window: number } | undefined {
  for (let i = rows.length - 1; i >= 0; i--) {
    const b = rows[i]?.body as { type?: unknown; tokens?: unknown; window?: unknown } | null;
    if (b?.type !== "context") continue;
    const { tokens, window } = b;
    if (
      typeof tokens === "number" &&
      typeof window === "number" &&
      tokens >= 0 &&
      window > 0 &&
      Number.isFinite(tokens + window)
    )
      return { tokens, window };
  }
  return undefined;
}

/** Text and thinking arrive as deltas, a row each: a run of them is one part; a `message` row ends a text part. */
export function toTurns(rows: TurnRow[]): Turn[] {
  const turns: Turn[] = [];
  for (const r of rows) {
    // what the Worker printed that is not a line of ours: the old console's `text` row too
    const b = (r.body && typeof r.body === "object" ? r.body : { type: "text", text: str(r.body) }) as Record<
      string,
      unknown
    >;
    if (b.type === "context") continue; // the header's ring (`contextOf`), not part of a turn
    if (b.type === "owner") {
      turns.push({
        role: "user",
        key: r.seq,
        started: r.created,
        at: r.created,
        parts: [{ kind: "text", text: str(b.text) }],
      });
      continue;
    }
    let t = turns.at(-1);
    if (!t || t.role === "user") {
      t = { role: "assistant", key: r.seq, started: r.created, at: r.created, parts: [] };
      turns.push(t);
    }
    t.at = r.created;
    const last = t.parts.at(-1);
    switch (b.type) {
      case "message":
        if (last?.kind === "text") last.closed = true;
        break;
      case "thinking":
        if (last?.kind === "thinking") last.text += str(b.text);
        else t.parts.push({ kind: "thinking", text: str(b.text) });
        break;
      case "tool_call": {
        t.parts.push({ kind: "tool", id: str(b.id), name: str(b.name), input: b.input });
        // `done`'s summary is the answer (a chat's reply, a task's result): it shows as text, not only as a step
        const summary = b.name === "done" ? (b.input as { summary?: unknown } | null)?.summary : undefined;
        if (summary) t.parts.push({ kind: "text", text: str(summary), closed: true });
        break;
      }
      case "tool_result": {
        const id = str(b.id);
        const tool = { output: str(b.output), isError: !!b.isError };
        const call = t.parts.find((p): p is Tool => p.kind === "tool" && p.id === id);
        if (call) Object.assign(call, tool);
        else t.parts.push({ kind: "tool", id, name: "tool", input: {}, ...tool });
        break;
      }
      case "status":
        t.parts.push({ kind: "status", text: str(b.text) });
        break;
      case "error":
        t.parts.push({ kind: "error", text: str(b.message) });
        break;
      default: {
        const text = str(b.text ?? b);
        if (last?.kind === "text" && !last.closed) last.text += text;
        else t.parts.push({ kind: "text", text });
      }
    }
  }
  return turns;
}

/**
 * How long a live turn has run and the commands it ran: "1h 12m 30s · 13 commands". `cut`: the stream's last 1000 rows start
 * inside this turn, so its first rows are missing and both numbers are floors ("+").
 */
export function progress(t: Turn, now: number, cut = false): string {
  const plus = cut ? "+" : "";
  const bits: string[] = [];
  if (t.started) {
    const s = Math.floor(Math.max(0, now - Date.parse(t.started)) / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor(s / 60) % 60;
    bits.push(`${h ? `${h}h ` : ""}${h || m ? `${m}m ` : ""}${s % 60}s${plus}`);
  }
  const n = t.parts.filter((p) => p.kind === "tool" && p.name === "bash").length;
  if (n) bits.push(`${n}${plus} ${n === 1 ? "command" : "commands"}`);
  return bits.join(" · ");
}

/**
 * `toTurns` for one growing list of rows, which keeps what is finished: an owner row starts a turn, so everything before
 * the last one never changes. Those turns stay the same objects (a memoized turn does not render again), and each call
 * rebuilds only the rows from there on. A list that is not the same one (a shorter one, another first row) starts over.
 */
export function turnBuilder(): (rows: TurnRow[]) => Turn[] {
  let first: TurnRow | undefined;
  let built = 0;
  let done: Turn[] = [];
  return (rows) => {
    let start = rows.length - 1;
    while (start > 0 && !isOwner(rows[start] as TurnRow)) start--;
    start = Math.max(start, 0);
    if (rows[0] !== first || start < built) {
      first = rows[0];
      built = 0;
      done = [];
    }
    if (start > built) {
      done = [...done, ...toTurns(rows.slice(built, start))];
      built = start;
    }
    return [...done, ...toTurns(rows.slice(start))];
  };
}
