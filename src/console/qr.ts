/**
 * A QR encoder for the enrolment URL: byte mode, error correction M, versions 1–10 (up to 213 bytes), the mask chosen
 * by the standard penalty (ISO/IEC 18004 § 7.8.3). Follows the structure of Project Nayuki's reference generator.
 */

// error correction M, versions 1..10
const EC = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLOCKS = [1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const ALIGN = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

/** Codewords (data + EC) of a version: modules left after the function patterns, / 8. */
function codewords(v: number): number {
  let r = (16 * v + 128) * v + 64;
  if (v >= 2) {
    const n = Math.floor(v / 7) + 2;
    r -= (25 * n - 10) * n - 55;
    if (v >= 7) r -= 36;
  }
  return Math.floor(r / 8);
}

const dataCodewords = (v: number) => codewords(v) - (EC[v - 1] as number) * (BLOCKS[v - 1] as number);

// GF(256) with x^8 + x^4 + x^3 + x^2 + 1
function mul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function divisor(degree: number): number[] {
  const r = new Array<number>(degree).fill(0);
  r[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      r[j] = mul(r[j] as number, root);
      if (j + 1 < degree) r[j] = (r[j] as number) ^ (r[j + 1] as number);
    }
    root = mul(root, 2);
  }
  return r;
}

function remainder(data: number[], div: number[]): number[] {
  const r = div.map(() => 0);
  for (const b of data) {
    const f = b ^ (r.shift() as number);
    r.push(0);
    div.forEach((c, i) => {
      r[i] = (r[i] as number) ^ mul(c, f);
    });
  }
  return r;
}

/** Data bits → padded data codewords → blocks with EC → interleaved. */
function codewordsFor(bytes: Uint8Array, v: number): number[] {
  const bits: number[] = [];
  const put = (val: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  const cap = dataCodewords(v) * 8;
  put(0b0100, 4);
  put(bytes.length, v < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, cap - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) put(pad, 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));

  const nb = BLOCKS[v - 1] as number;
  const ec = EC[v - 1] as number;
  const short = Math.floor(data.length / nb);
  const longs = data.length % nb;
  const div = divisor(ec);
  const blocks: number[][] = [];
  const ecs: number[][] = [];
  for (let i = 0, k = 0; i < nb; i++) {
    const len = short + (i >= nb - longs ? 1 : 0);
    const block = data.slice(k, k + len);
    k += len;
    blocks.push(block);
    ecs.push(remainder(block, div));
  }
  const out: number[] = [];
  for (let i = 0; i <= short; i++) for (const b of blocks) if (i < b.length) out.push(b[i] as number);
  for (let i = 0; i < ec; i++) for (const e of ecs) out.push(e[i] as number);
  return out;
}

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

class Matrix {
  readonly version: number;
  readonly size: number;
  readonly m: boolean[][];
  readonly fn: boolean[][];

  constructor(version: number) {
    this.version = version;
    this.size = 17 + 4 * version;
    this.m = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.fn = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }

  set(x: number, y: number, dark: boolean): void {
    (this.m[y] as boolean[])[x] = dark;
    (this.fn[y] as boolean[])[x] = true;
  }

  functionPatterns(): void {
    const s = this.size;
    for (let i = 0; i < s; i++) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }
    for (const [cx, cy] of [
      [3, 3],
      [s - 4, 3],
      [3, s - 4],
    ] as const)
      for (let dy = -4; dy <= 4; dy++)
        for (let dx = -4; dx <= 4; dx++) {
          const d = Math.max(Math.abs(dx), Math.abs(dy));
          const x = cx + dx;
          const y = cy + dy;
          if (x >= 0 && x < s && y >= 0 && y < s) this.set(x, y, d !== 2 && d !== 4);
        }
    const pos = ALIGN[this.version - 1] as number[];
    const last = pos.length - 1;
    pos.forEach((px, i) => {
      pos.forEach((py, j) => {
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++) this.set(px + dx, py + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      });
    });
    this.format(0);
    if (this.version >= 7) {
      let rem = this.version;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const bits = (this.version << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const bit = ((bits >>> i) & 1) === 1;
        const a = s - 11 + (i % 3);
        const b = Math.floor(i / 3);
        this.set(a, b, bit);
        this.set(b, a, bit);
      }
    }
  }

  /** Format information: level M (bits 00) and the mask, BCH(15,5), both copies, and the dark module. */
  format(mask: number): void {
    const data = mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i: number) => ((bits >>> i) & 1) === 1;
    const s = this.size;
    for (let i = 0; i <= 5; i++) this.set(8, i, bit(i));
    this.set(8, 7, bit(6));
    this.set(8, 8, bit(7));
    this.set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) this.set(s - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.set(8, s - 15 + i, bit(i));
    this.set(8, s - 8, true);
  }

  place(data: number[]): void {
    const s = this.size;
    let i = 0;
    for (let right = s - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < s; vert++)
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const y = ((right + 1) & 2) === 0 ? s - 1 - vert : vert;
          if (!this.fn[y]?.[x] && i < data.length * 8) {
            (this.m[y] as boolean[])[x] = (((data[i >>> 3] as number) >>> (7 - (i & 7))) & 1) === 1;
            i++;
          }
        }
    }
  }

  mask(k: number): void {
    const f = MASKS[k] as (x: number, y: number) => boolean;
    for (let y = 0; y < this.size; y++)
      for (let x = 0; x < this.size; x++)
        if (!this.fn[y]?.[x] && f(x, y)) (this.m[y] as boolean[])[x] = !this.m[y]?.[x];
  }

  penalty(): number {
    const s = this.size;
    let result = 0;
    const at = (x: number, y: number) => this.m[y]?.[x] === true;
    const lines = (col: boolean) => {
      for (let a = 0; a < s; a++) {
        let color = false;
        let run = 0;
        const hist = [0, 0, 0, 0, 0, 0, 0];
        const add = (len: number) => {
          hist.pop();
          hist.unshift(hist[0] === 0 ? len + s : len);
        };
        const count = () => {
          const n = hist[1] as number;
          const core = n > 0 && hist[2] === n && hist[3] === n * 3 && hist[4] === n && hist[5] === n;
          return (
            (core && (hist[0] as number) >= n * 4 && (hist[6] as number) >= n ? 1 : 0) +
            (core && (hist[6] as number) >= n * 4 && (hist[0] as number) >= n ? 1 : 0)
          );
        };
        for (let b = 0; b < s; b++) {
          const v = col ? at(a, b) : at(b, a);
          if (v === color) {
            run++;
            if (run === 5) result += 3;
            else if (run > 5) result++;
          } else {
            add(run);
            if (!color) result += count() * 40;
            color = v;
            run = 1;
          }
        }
        if (color) {
          add(run);
          run = 0;
        }
        add(run + s);
        result += count() * 40;
      }
    };
    lines(false);
    lines(true);
    let dark = 0;
    for (let y = 0; y < s; y++)
      for (let x = 0; x < s; x++) {
        const c = at(x, y);
        if (c) dark++;
        if (x < s - 1 && y < s - 1 && c === at(x + 1, y) && c === at(x, y + 1) && c === at(x + 1, y + 1)) result += 3;
      }
    const total = s * s;
    result += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
    return result;
  }
}

/** The module matrix (`true` = dark), rows top to bottom. `mask` forces one (tests); default: the lowest penalty. */
export function encode(text: string, mask?: number): boolean[][] {
  const bytes = new TextEncoder().encode(text);
  let v = 1;
  while (v <= 10 && dataCodewords(v) * 8 < 4 + (v < 10 ? 8 : 16) + bytes.length * 8) v++;
  if (v > 10) throw new Error(`QR: ${bytes.length} bytes do not fit version 10-M`);
  const q = new Matrix(v);
  q.functionPatterns();
  q.place(codewordsFor(bytes, v));
  let best = mask ?? 0;
  if (mask === undefined) {
    let min = Infinity;
    for (let k = 0; k < 8; k++) {
      q.mask(k);
      q.format(k);
      const p = q.penalty();
      if (p < min) [min, best] = [p, k];
      q.mask(k);
    }
  }
  q.mask(best);
  q.format(best);
  return q.m;
}

/** An SVG with a 4-module quiet zone; one path of horizontal runs. */
export function svg(text: string, px = 4): string {
  const m = encode(text);
  const n = m.length + 8;
  let d = "";
  m.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (!row[x]) continue;
      let w = 1;
      while (row[x + w]) w++;
      d += `M${x + 4} ${y + 4}h${w}v1h-${w}z`;
      x += w - 1;
    }
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${n * px}" height="${n * px}" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect width="${n}" height="${n}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
