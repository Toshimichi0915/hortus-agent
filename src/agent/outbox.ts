/** out/outbox/<seq>.json, temp + rename so hortusd never reads half a file. */
import { mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OutboxMsg } from "../types.ts";

export function writeOutbox(dir: string, type: OutboxMsg["type"], text: string): OutboxMsg {
  const box = join(dir, "out", "outbox");
  mkdirSync(box, { recursive: true });
  const seqs = readdirSync(box).flatMap((n) => (/^\d{6}\.json$/.test(n) ? [Number(n.slice(0, 6))] : []));
  const seq = Math.max(0, ...seqs) + 1;
  const msg: OutboxMsg = { seq, type, text, ts: new Date().toISOString() };
  const name = `${String(seq).padStart(6, "0")}.json`;
  const tmp = join(box, `.${name}.tmp`);
  writeFileSync(tmp, JSON.stringify(msg));
  renameSync(tmp, join(box, name));
  return msg;
}
