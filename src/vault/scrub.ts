/**
 * Replaces secret values by their placeholders, longest first. Streams work on latin1 strings (one char per byte), so
 * binary bodies and UTF-8 secrets are both matched byte for byte. Values under 8 chars are not scrubbed: too likely to
 * match ordinary text; each is logged once.
 */
import { Transform } from "node:stream";
import { logger } from "../log.ts";

const log = logger("scrub");
const warned = new Set<string>();
export const MIN = 8;

interface Pair {
  value: string;
  placeholder: string;
}

export class Scrubber {
  private pairs: Pair[];
  private bytePairs: Pair[];
  readonly maxLen: number;

  constructor(values: Pair[]) {
    const long: Pair[] = [];
    for (const p of values) {
      if (p.value.length >= MIN) long.push(p);
      else if (!warned.has(p.placeholder)) {
        warned.add(p.placeholder);
        log.info("secret shorter than 8 chars is not scrubbed", { placeholder: p.placeholder });
      }
    }
    this.pairs = long.sort((a, b) => b.value.length - a.value.length);
    this.bytePairs = this.pairs.map((p) => ({
      value: Buffer.from(p.value).toString("latin1"),
      placeholder: Buffer.from(p.placeholder).toString("latin1"),
    }));
    this.maxLen = Math.max(0, ...this.bytePairs.map((p) => p.value.length));
  }

  text(s: string): string {
    for (const p of this.pairs) if (s.includes(p.value)) s = s.split(p.value).join(p.placeholder);
    return s;
  }

  /** The first secret value found in `s`, if any (raw-credential refusal). */
  find(s: string): string | undefined {
    return this.pairs.find((p) => s.includes(p.value))?.placeholder;
  }

  private latin1(s: string): string {
    for (const p of this.bytePairs) if (s.includes(p.value)) s = s.split(p.value).join(p.placeholder);
    return s;
  }

  bytes(b: Buffer): Buffer {
    return this.pairs.length ? Buffer.from(this.latin1(b.toString("latin1")), "latin1") : b;
  }

  headers<T extends Record<string, string | string[] | undefined>>(h: T): T {
    const out: Record<string, string | string[] | undefined> = {};
    for (const [k, v] of Object.entries(h)) out[k] = Array.isArray(v) ? v.map((x) => this.text(x)) : v && this.text(v);
    return out as T;
  }

  /** Length of the longest suffix of `s` that is a proper prefix of some secret: held back until the next chunk. */
  private carryLen(s: string): number {
    for (let k = Math.min(this.maxLen - 1, s.length); k > 0; k--) {
      const tail = s.slice(s.length - k);
      if (this.bytePairs.some((p) => p.value.length > k && p.value.startsWith(tail))) return k;
    }
    return 0;
  }

  /**
   * Pass-through that scrubs on the fly. Only a possible secret prefix at a chunk's end is held back, so an event
   * stream is not delayed. `onMatch` (request bodies) turns a match into an error instead of a replacement.
   */
  stream(onMatch?: () => Error): Transform {
    let carry = "";
    return new Transform({
      transform: (chunk: Buffer, _enc, cb) => {
        const s = carry + chunk.toString("latin1");
        // hold back a possible secret prefix (a complete short secret may be the start of a longer one), never
        // splitting a complete match
        let split = s.length - this.carryLen(s);
        for (let moved = true; moved; ) {
          moved = false;
          for (const p of this.bytePairs) {
            const i = s.lastIndexOf(p.value, split - 1);
            if (i >= 0 && i < split && i + p.value.length > split) {
              split = i;
              moved = true;
            }
          }
        }
        const head = s.slice(0, split);
        const out = this.latin1(head);
        if (onMatch && out !== head) return cb(onMatch());
        carry = s.slice(split);
        cb(null, out.length ? Buffer.from(out, "latin1") : undefined);
      },
      flush: (cb) => {
        const out = this.latin1(carry);
        if (onMatch && out !== carry) return cb(onMatch());
        cb(null, out.length ? Buffer.from(out, "latin1") : undefined);
      },
    });
  }
}
