/**
 * ctl/inbox/<seq>.json → user messages. Files are never deleted; each message starts with `[inbox <seq>]`, so
 * the highest marker in the sessions is the cursor. Owner text is plain; everything else is quoted data.
 */
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { InboxMsg } from "../types.ts";

const InboxSchema = z.object({
  seq: z.number(),
  from: z.string(),
  author: z.string().optional(),
  trusted: z.boolean(),
  text: z.string(),
  data: z.unknown().optional(),
  ts: z.string(),
});

/** `<<<quoted` … `>>>`; when the text holds `>>>`, both lines carry a random suffix the text cannot contain. */
export function quote(text: string): string {
  let suffix = "";
  while (text.includes(`>>>${suffix}`)) suffix = `-${randomBytes(4).toString("hex")}`;
  return `<<<quoted${suffix}\n${text}\n>>>${suffix}`;
}

export function render(seq: number, m: Pick<InboxMsg, "from" | "author" | "trusted" | "text">): string {
  if (m.from === "owner") return `[inbox ${seq}] from=owner\n${m.text}`;
  const author = m.author === undefined ? "" : ` author=${m.author}`;
  return `[inbox ${seq}] from=${m.from}${author} trusted=${m.trusted}\n${quote(m.text)}`;
}

/** The seq of an `[inbox N]` user message, else undefined. */
export function marker(content: string): number | undefined {
  const m = /^\[inbox (\d+)\]/.exec(content);
  return m ? Number(m[1]) : undefined;
}

/** Seqs of inbox files above `cursor`, ascending (file names only: cheap enough for every tool result). */
export function pending(dir: string, cursor: number): number[] {
  let names: string[];
  try {
    names = readdirSync(join(dir, "ctl", "inbox"));
  } catch {
    return [];
  }
  return names
    .flatMap((n) => (/^\d{6}\.json$/.test(n) ? [Number(n.slice(0, 6))] : []))
    .filter((s) => s > cursor)
    .sort((a, b) => a - b);
}

/** Every file above `cursor` as message text; an unreadable one still yields its marker, so it is not retried forever. */
export function drain(dir: string, cursor: number): { seq: number; text: string }[] {
  return pending(dir, cursor).map((seq) => {
    const path = join(dir, "ctl", "inbox", `${String(seq).padStart(6, "0")}.json`);
    try {
      return { seq, text: render(seq, InboxSchema.parse(JSON.parse(readFileSync(path, "utf8")))) };
    } catch (e) {
      return { seq, text: `[inbox ${seq}] unreadable: ${e instanceof Error ? e.message : String(e)}` };
    }
  });
}

/**
 * The owner's messages up to `cursor`, rendered as drained, oldest first: the newest that fit in `max` chars (a handoff
 * passes them on verbatim). Anyone else's are left out, so nothing a stranger wrote comes back as the owner's.
 */
export function ownerMessages(dir: string, cursor: number, max: number): { text: string; dropped: number } {
  const all = pending(dir, 0)
    .filter((seq) => seq <= cursor)
    .flatMap((seq) => {
      try {
        const path = join(dir, "ctl", "inbox", `${String(seq).padStart(6, "0")}.json`);
        const m = InboxSchema.parse(JSON.parse(readFileSync(path, "utf8")));
        return m.from === "owner" ? [render(seq, m)] : [];
      } catch {
        return []; // drained as `unreadable`: nothing to pass on
      }
    });
  const kept: string[] = [];
  let left = max;
  for (let i = all.length - 1; i >= 0; i--) {
    const t = all[i] as string;
    if (t.length > left) break;
    kept.unshift(t);
    left -= t.length;
  }
  return { text: kept.join("\n\n"), dropped: all.length - kept.length };
}
