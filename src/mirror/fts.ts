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

export function upsert(db: DatabaseSync, r: Row): void {
  remove(db, r.dof, r.path);
  const { lastInsertRowid } = db
    .prepare("INSERT INTO search(dof, path, author, ts, title, body) VALUES (?, ?, ?, ?, ?, ?)")
    .run(r.dof, r.path, r.author, r.ts, r.title, r.body);
  db.prepare("INSERT INTO search_meta(dof, path, rowid) VALUES (?, ?, ?)").run(r.dof, r.path, lastInsertRowid);
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
  db.exec("BEGIN");
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
export function search(db: DatabaseSync, query: SearchQuery): SearchHit[] {
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
  if (query.author !== undefined) and("author = ?", query.author);
  if (query.since !== undefined) and("ts >= ?", query.since);
  // inclusive at the given precision: --until 2026-10-27 keeps the whole day
  if (query.until !== undefined) and("substr(ts, 1, ?) <= ?", query.until.length, query.until);
  const snippet = match ? "snippet(search, 5, '[', ']', '…', 12)" : "substr(body, 1, 120)";
  const order = match ? "bm25(search), ts DESC" : "ts DESC";
  const rows = db
    .prepare(
      `SELECT dof, path, author, ts, title, ${snippet} AS snippet FROM search WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ?`,
    )
    .all(...args, limit) as unknown as SearchHit[];
  return rows.map((r) => ({ ...r, title: oneLine(r.title), snippet: oneLine(r.snippet) }));
}
