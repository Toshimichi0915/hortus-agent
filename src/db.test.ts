import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "./db.ts";
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
