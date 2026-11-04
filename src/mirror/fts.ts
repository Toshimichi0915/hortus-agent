/** The search index: FTS5 trigram rows `(dof, path, author, ts, title, body)` upserted through `search_meta`. */
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { DatabaseSync } from "../db.ts";
import type { DiffEntry, SearchHit, SearchQuery } from "../types.ts";
import { parse } from "./render.ts";

export interface Row {
  dof: string;
  path: string;
  author: string;
  ts: string;
  title: string;
  body: string;
}

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

/** Characters of a body that are indexed: trigram-indexing a Worker's 255 MB session.md held hortusd ~4 s. */
// ponytail: a hit past the first 4M characters of one file is not found; split rows per chunk if logs need it
export const INDEXED = 4 * 1024 * 1024;

export function upsert(db: DatabaseSync, r: Row): void {
  remove(db, r.dof, r.path);
  const { lastInsertRowid } = db
    .prepare("INSERT INTO search(dof, path, author, ts, title, body) VALUES (?, ?, ?, ?, ?, ?)")
    .run(r.dof, r.path, r.author, r.ts, r.title.slice(0, 1024), r.body.slice(0, INDEXED));
  db.prepare("INSERT INTO search_meta(dof, path, rowid, author) VALUES (?, ?, ?, ?)").run(
    r.dof,
    r.path,
    lastInsertRowid,
    r.author,
  );
}

export function remove(db: DatabaseSync, dof: string, path: string): void {
  const old = db.prepare("SELECT rowid FROM search_meta WHERE dof = ? AND path = ?").get(dof, path) as
    | { rowid: number }
    | undefined;
  if (!old) return;
  db.prepare("DELETE FROM search WHERE rowid = ?").run(old.rowid);
  db.prepare("DELETE FROM search_meta WHERE dof = ? AND path = ?").run(dof, path);
}

/** One indexed row from a mirror file; the `title` rule is the one place a new object kind might need a line. */
export function rowOf(dof: string, path: string, text: string): Row {
  const { frontmatter: fm, body } = parse(text);
  // `user: U0123 (alice)` → the id; --author matches ids, not display names
  const author = str(fm.user).split(" ")[0] ?? "";
  if (basename(path) === "channel.md") {
    return { dof, path, author, ts: str(fm.ts), title: str(fm.name), body: [str(fm.topic), body].join("\n").trim() };
  }
  return { dof, path, author, ts: str(fm.ts), title: str(fm.title) || body.slice(0, 80), body };
}

/** Index a commit's diff: Markdown objects only, never attachments under `files/`. */
export function index(db: DatabaseSync, dof: string, root: string, entries: DiffEntry[]): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const e of entries) {
      if (!e.path.endsWith(".md") || e.path.split("/").includes("files")) continue;
      if (e.status === "D") remove(db, dof, e.path);
      else upsert(db, rowOf(dof, e.path, readFileSync(join(root, e.path), "utf8")));
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Trigram MATCH for 3+ characters (bm25, then newest), `LIKE` below that (newest first). Filters are ANDed. */
/** `only`: the DOFs a task can read (scope.dofs); hits elsewhere are never returned. */
export function search(db: DatabaseSync, query: SearchQuery, only?: string[]): SearchHit[] {
  const limit = Math.min(Math.max(1, Math.floor(query.limit ?? 20)), 200);
  const where: string[] = [];
  const args: (string | number)[] = [];
  const and = (sql: string, ...a: (string | number)[]) => {
    where.push(sql);
    args.push(...a);
  };
  const match = [...query.q].length >= 3;
  if (match) {
    and("search MATCH ?", `{title body} : "${query.q.replaceAll('"', '""')}"`);
  } else {
    const like = `%${query.q.replace(/[\\%_]/g, "\\$&")}%`;
    and("(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')", like, like);
  }
  if (query.in !== undefined) and("dof = ?", query.in);
  if (only) and(`dof IN (${only.map(() => "?").join(", ") || "NULL"})`, ...only);
  if (query.author !== undefined) and("author = ?", query.author);
  if (query.since !== undefined) and("ts >= ?", query.since);
  // inclusive at the given precision: --until 2026-10-27 keeps the whole day
  if (query.until !== undefined) and("substr(ts, 1, ?) <= ?", query.until.length, query.until);
  // FTS5's snippet() is quadratic in a row's hits: "the" over 300 one-MB session logs held the daemon 188 s. The
  // window around the first hit is cut here instead, from the body's first 64K characters (ponytail: a first hit
  // past them shows the body's head).
  const order = match ? "bm25(search), ts DESC" : "ts DESC";
  const rows = db
    .prepare(
      `SELECT dof, path, author, ts, title, substr(body, 1, ${match ? 65536 : 120}) AS snippet FROM search WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ?`,
    )
    .all(...args, limit) as unknown as SearchHit[];
  return rows.map((r) => ({
    ...r,
    title: oneLine(r.title),
    snippet: oneLine(match ? around(r.snippet, query.q) : r.snippet),
  }));
}

/** `…before[hit]after…` around the first case-insensitive hit of `q`, else the head. */
function around(body: string, q: string): string {
  const lower = body.toLowerCase();
  const i = lower.indexOf(q.toLowerCase());
  // a lowercasing that changes lengths (İ) would misplace the cut: the head instead
  if (i < 0 || lower.length !== body.length) return body.slice(0, 120);
  const a = Math.max(0, i - 60);
  const b = i + q.length;
  return `${a ? "…" : ""}${body.slice(a, i)}[${body.slice(i, b)}]${body.slice(b, b + 60)}${b + 60 < body.length ? "…" : ""}`;
}
