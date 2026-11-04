/**
 * The SQLite DB (node:sqlite). Timestamps are ISO strings in UTC; JSON columns hold JSON text. A new table is one
 * string appended to `migrations`; `openDb` on an older file applies the missing ones (PRAGMA user_version).
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type { DatabaseSync } from "node:sqlite";

export const now = (): string => new Date().toISOString();

const migrations: string[] = [
  `
  CREATE TABLE events(id INTEGER PRIMARY KEY, dof TEXT, key TEXT, ts TEXT, author TEXT, member INTEGER, trusted INTEGER,
    bot INTEGER, payload TEXT, consumed INTEGER DEFAULT 0, task_id TEXT, ignored TEXT, created TEXT, UNIQUE(dof, key));
  CREATE TABLE tasks(id TEXT PRIMARY KEY, kind TEXT, title TEXT, brief TEXT, status TEXT, scope TEXT, origins TEXT,
    budget TEXT, usage TEXT, project TEXT, runtime TEXT, parent TEXT, event_keys TEXT, outcome TEXT, summary TEXT,
    created TEXT, updated TEXT, closed TEXT, started TEXT, hours REAL DEFAULT 0, cwd TEXT);
  CREATE TABLE task_refs(ref TEXT PRIMARY KEY, task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE);
  CREATE TABLE inbox(task_id TEXT, seq INTEGER, body TEXT, created TEXT, PRIMARY KEY(task_id, seq));
  CREATE TABLE outbox(task_id TEXT, seq INTEGER, body TEXT, created TEXT, PRIMARY KEY(task_id, seq));
  CREATE TABLE replies(task_id TEXT, seq INTEGER, body TEXT, created TEXT, PRIMARY KEY(task_id, seq));
  CREATE TABLE syncs(dof TEXT, scope TEXT, cursor TEXT, last_sync TEXT, PRIMARY KEY(dof, scope));
  CREATE TABLE schedules(id INTEGER PRIMARY KEY, task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE, fire_at TEXT,
    every_sec INTEGER, cron TEXT, tz TEXT, text TEXT, script TEXT, expires_at TEXT, last_run TEXT, created TEXT);
  CREATE VIRTUAL TABLE search USING fts5(dof, path, author, ts, title, body, tokenize='trigram');
  CREATE TABLE search_meta(dof TEXT, path TEXT, rowid INTEGER, PRIMARY KEY(dof, path));
  CREATE TABLE approvals(id INTEGER PRIMARY KEY, kind TEXT, category TEXT, hash TEXT, task_id TEXT, summary TEXT,
    status TEXT, requested_at TEXT, decided_at TEXT, decided_by TEXT, prompt_hash TEXT, reason TEXT, payload TEXT);
  CREATE TABLE captured(id INTEGER PRIMARY KEY, name TEXT UNIQUE, value TEXT, origin TEXT, kind TEXT, created TEXT,
    last_use TEXT);
  CREATE TABLE transforms(name TEXT PRIMARY KEY, hash TEXT, enabled_at TEXT);
  CREATE TABLE passkeys(id TEXT PRIMARY KEY, public_key TEXT, counter INTEGER, device TEXT, transports TEXT,
    created TEXT, last_use TEXT);
  CREATE TABLE console_sessions(hash TEXT PRIMARY KEY, device TEXT, created TEXT, last_seen TEXT, address TEXT);
  CREATE TABLE enroll_codes(code TEXT PRIMARY KEY, expires_at TEXT);
  CREATE TABLE planner_usage(day TEXT PRIMARY KEY, tokens INTEGER);
  CREATE TABLE links(address TEXT PRIMARY KEY, role TEXT, task_id TEXT, kind TEXT, created TEXT);
  CREATE INDEX events_consumed ON events(consumed);
  CREATE INDEX events_task ON events(task_id);
  CREATE INDEX tasks_status ON tasks(status);
  CREATE INDEX approvals_status ON approvals(status);
  CREATE INDEX schedules_fire ON schedules(fire_at);
  CREATE INDEX inbox_task_seq ON inbox(task_id, seq);
  `,
  // step 3: the card's error line (a Worker that exited non-zero without an outbox message)
  "ALTER TABLE tasks ADD COLUMN error TEXT;",
  // 3c: schedule ids are never reused (a run's `schedule:<id>` key and `schedules/<id>/` outlive a deleted row)
  `
  CREATE TABLE schedules_new(id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
    fire_at TEXT, every_sec INTEGER, cron TEXT, tz TEXT, text TEXT, script TEXT, expires_at TEXT, last_run TEXT,
    created TEXT);
  INSERT INTO schedules_new SELECT * FROM schedules;
  DROP TABLE schedules;
  ALTER TABLE schedules_new RENAME TO schedules;
  CREATE INDEX schedules_fire ON schedules(fire_at);
  `,
  // 3h: a capture's metadata (cookie name, Domain/Path/Expires, the request host, the capturing task and role)
  "ALTER TABLE captured ADD COLUMN meta TEXT;",
  // step 4: the Planner's batch line (Event.summary, Event.refs as JSON) and which result rows a batch has read
  `ALTER TABLE events ADD COLUMN summary TEXT; ALTER TABLE events ADD COLUMN refs TEXT;
  ALTER TABLE outbox ADD COLUMN consumed INTEGER DEFAULT 0;`,
  // review round 6: why a task's context holds text the owner did not vouch for (a JSON array of reasons)
  "ALTER TABLE tasks ADD COLUMN taint TEXT;",
];

const TAINT_MAX = 5;

/**
 * Marks the task tainted (v7 › Review round 6): from now on the owner decides its gated requests, never the judge.
 * At most TAINT_MAX distinct reasons are kept; the first ones say enough.
 */
export function taint(db: DatabaseSync, task: string, reason: string): void {
  const r = db.prepare("SELECT taint FROM tasks WHERE id = ?").get(task) as { taint: string | null } | undefined;
  if (!r) return;
  const list = r.taint ? (JSON.parse(r.taint) as string[]) : [];
  if (list.includes(reason) || list.length >= TAINT_MAX) return;
  db.prepare("UPDATE tasks SET taint = ? WHERE id = ?").run(JSON.stringify([...list, reason]), task);
}

/**
 * Why the task's context holds untrusted text: untrusted events routed to it (task_attach), the Planner batch it is
 * (every batch reads strangers), and what `taint()` recorded. Empty: untainted, as far as hortusd can see.
 */
export function taintOf(db: DatabaseSync, task: string | null | undefined): string[] {
  if (!task) return [];
  const t = db.prepare("SELECT kind, taint FROM tasks WHERE id = ?").get(task) as
    | { kind: string | null; taint: string | null }
    | undefined;
  if (!t) return [];
  const authors = (
    db
      .prepare(
        "SELECT DISTINCT dof, COALESCE(author, '?') AS author FROM events WHERE task_id = ? AND trusted = 0 LIMIT 5",
      )
      .all(task) as { dof: string; author: string }[]
  ).map((r) => `${r.dof}:${r.author}`);
  return [
    ...(t.kind === "planner" ? ["a Planner batch reads every event"] : []),
    ...(authors.length ? [`read untrusted messages (${authors.join(", ")})`] : []),
    ...(t.taint ? (JSON.parse(t.taint) as string[]) : []),
  ];
}

export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

/** One migration per transaction; the version is read under the write lock, so two openers never both apply one. */
export function migrate(db: DatabaseSync): void {
  for (;;) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const { user_version: v } = db.prepare("PRAGMA user_version").get() as { user_version: number };
      const sql = migrations[v];
      if (sql === undefined) {
        db.exec("COMMIT");
        return;
      }
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}
