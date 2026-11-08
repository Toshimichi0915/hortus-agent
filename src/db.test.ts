import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { migrate, openDb } from "./db.ts";
import * as paths from "./paths.ts";
import { tempDir } from "./test/until.ts";

process.env.HORTUS_HOME = tempDir("hortus-db-");

const TABLES = [
  "events",
  "tasks",
  "task_refs",
  "inbox",
  "outbox",
  "replies",
  "syncs",
  "schedules",
  "search",
  "search_meta",
  "approvals",
  "captured",
  "transforms",
  "passkeys",
  "console_sessions",
  "enroll_codes",
  "planner_usage",
  "links",
];

const version = (db: ReturnType<typeof openDb>) =>
  (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;

test("openDb twice is idempotent; WAL; every table exists", () => {
  const a = openDb(paths.db());
  const v = version(a);
  assert.ok(v >= 1);
  assert.equal((a.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, "wal");
  a.close();
  const b = openDb(paths.db());
  assert.equal(version(b), v);
  const names = new Set((b.prepare("SELECT name FROM sqlite_master").all() as { name: string }[]).map((r) => r.name));
  for (const t of TABLES) assert.ok(names.has(t), t);
  b.close();
});

test("FTS5 trigram search accepts an insert and a MATCH", () => {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO search(dof, path, author, ts, title, body) VALUES (?, ?, ?, ?, ?, ?)").run(
    "slack",
    "C1/1.md",
    "U1",
    "2026-01-01T00:00:00Z",
    "hello",
    "the deploy failed on tuesday",
  );
  const rows = db.prepare("SELECT path FROM search WHERE search MATCH ?").all("ploy");
  assert.deepEqual(
    rows.map((r) => r.path),
    ["C1/1.md"],
  );
});

test("ON DELETE CASCADE removes task_refs and schedules", () => {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO tasks(id) VALUES ('t1')").run();
  db.prepare("INSERT INTO task_refs(ref, task_id) VALUES ('slack:C1:1', 't1')").run();
  db.prepare("INSERT INTO schedules(task_id, text) VALUES ('t1', 'x')").run();
  db.prepare("DELETE FROM tasks WHERE id = 't1'").run();
  assert.equal((db.prepare("SELECT count(*) n FROM task_refs").get() as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT count(*) n FROM schedules").get() as { n: number }).n, 0);
});

test("the WAL file shrinks back to journal_size_limit after a big transaction is checkpointed", () => {
  const file = `${tempDir("hortus-wal-")}/db.sqlite`;
  const db = openDb(file);
  const wal = () => statSync(`${file}-wal`).size;
  db.exec("CREATE TABLE big(b BLOB)");
  db.exec("BEGIN");
  for (let i = 0; i < 400; i++) db.prepare("INSERT INTO big VALUES (?)").run(Buffer.alloc(64 * 1024, i));
  db.exec("COMMIT");
  assert.ok(wal() > 20 * 1024 * 1024, `wal ${wal()}`);
  // the auto-checkpoint backfills it; the next write resets the WAL and truncates the file to the limit
  db.exec("PRAGMA wal_checkpoint(PASSIVE)");
  db.prepare("INSERT INTO big VALUES (?)").run(Buffer.alloc(16));
  assert.ok(wal() <= 8 * 1024 * 1024, `wal ${wal()}`);
  db.close();
});

test("a task's token budget moves to dollars, and the Planner's day takes a dollar count", () => {
  const db = new DatabaseSync(":memory:");
  migrate(db, 4); // the schema as it was before the move
  db.prepare("INSERT INTO planner_usage(day, tokens) VALUES ('2026-01-01', 7)").run();
  const add = db.prepare("INSERT INTO tasks(id, kind, title, status, budget) VALUES (?, ?, 't', 'waiting', ?)");
  add.run("w", "unattended", JSON.stringify({ tokens: 2e6, hours: 4 }));
  add.run("p", "planner", JSON.stringify({ tokens: 500, hours: 0.5 }));
  add.run("broken", "chat", "not json");
  migrate(db);
  const budget = (id: string) =>
    (db.prepare("SELECT budget FROM tasks WHERE id = ?").get(id) as { budget: string }).budget;
  assert.deepEqual(JSON.parse(budget("w")), { hours: 4, usd: 20 });
  assert.deepEqual(JSON.parse(budget("p")), { tokens: 500, hours: 0.5 });
  assert.equal(budget("broken"), "not json");
  assert.deepEqual({ ...(db.prepare("SELECT tokens, usd FROM planner_usage").get() as object) }, { tokens: 7, usd: 0 });
  db.close();
});
