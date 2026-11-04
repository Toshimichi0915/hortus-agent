/**
 * Load (round 4): a 5,000-message backfill as one sync, then small syncs on top of it; prints the indexing time and
 * `dof.search` latency (trigram MATCH and the 2-character LIKE fallback) as `# load …` lines.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { tempDir } from "../test/until.ts";

process.env.HORTUS_HOME = tempDir("hortus-mirrorload-");
const { Config } = await import("../config.ts");
const { openDb } = await import("../db.ts");
const { logger } = await import("../log.ts");
const paths = await import("../paths.ts");
const { commit, mirrorModule, search } = await import("./index.ts");

const db = openDb(paths.db());
await mirrorModule.start({
  config: Config.parse({ dofs: { slack: { type: "slack" } } }),
  db,
  paths,
  log: logger,
  reload: async () => {},
});

const WORDS = [
  "deploy",
  "rollback",
  "invoice",
  "kubernetes",
  "latency",
  "migration",
  "postgres",
  "review",
  "ok",
  "日本語",
];
const msg = (i: number) => ({
  op: "put" as const,
  path: `C${i % 20}/T${i % 50}/${1730000000 + i}.000100.md`,
  frontmatter: { id: `${1730000000 + i}.000100`, ts: new Date(1.73e12 + i * 60_000).toISOString(), user: `U${i % 7}` },
  body: `message ${i} about ${WORDS[i % WORDS.length]} and ${WORDS[(i * 7) % WORDS.length]} ticket-${i}\n`.repeat(3),
});
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) * p)] ?? 0;
const ms = (t: number) => `${t.toFixed(1)} ms`;

test("5,000 messages: one sync indexes them; small syncs and searches stay fast", { timeout: 120_000 }, async () => {
  let t = performance.now();
  const r = await commit(
    "slack",
    Array.from({ length: 5000 }, (_, i) => msg(i)),
    "backfill",
  );
  const backfill = performance.now() - t;
  assert.equal(r?.diff.length, 5000);
  const rows = (db.prepare("SELECT COUNT(*) AS n FROM search WHERE dof = 'slack'").get() as { n: number }).n;
  assert.equal(rows, 5000);

  const syncs: number[] = [];
  for (let s = 0; s < 10; s++) {
    t = performance.now();
    await commit(
      "slack",
      Array.from({ length: 10 }, (_, i) => msg(5000 + s * 10 + i)),
      `sync ${s}`,
    );
    syncs.push(performance.now() - t);
  }

  const lat = (q: string) => {
    const xs: number[] = [];
    let hits = 0;
    for (let i = 0; i < 30; i++) {
      t = performance.now();
      hits = search({ q }).length;
      xs.push(performance.now() - t);
    }
    return { p50: pct(xs, 0.5), p95: pct(xs, 0.95), hits };
  };
  const qs = { common: "deploy", rare: "ticket-4321", unicode: "日本語", like2: "ok", none: "zzzqqq" };
  const res = Object.fromEntries(Object.entries(qs).map(([k, q]) => [k, lat(q)]));
  console.log(
    `# load mirror: 5000-message sync ${ms(backfill)}; 10-message syncs p50 ${ms(pct(syncs, 0.5))} max ${ms(Math.max(...syncs))}`,
  );
  for (const [k, v] of Object.entries(res))
    console.log(`# load search ${k} (${qs[k as keyof typeof qs]}): p50 ${ms(v.p50)} p95 ${ms(v.p95)}, ${v.hits} hits`);
  assert.equal(res.rare?.hits, 1);
  assert.equal(res.common?.hits, 20);
  assert.equal(res.like2?.hits, 20);
  assert.ok(backfill < 60_000, `backfill ${backfill} ms`);
  for (const v of Object.values(res)) assert.ok(v.p95 < 250, JSON.stringify(res));
});
