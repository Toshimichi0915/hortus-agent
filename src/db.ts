/**
 * The SQLite DB (node:sqlite). Timestamps are ISO strings in UTC; JSON columns hold JSON text. A new table is one
 * string appended to `migrations`; `openDb` on an older file applies the missing ones (PRAGMA user_version).
 */
import { mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Config } from "./config.ts";
import { gitOf } from "./connectors/forge.ts";
import { trusted } from "./connectors/trust.ts";
import * as paths from "./paths.ts";

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
  // the card's error line (a Worker that exited non-zero without an outbox message)
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
  // the Planner's batch line (Event.summary, Event.refs as JSON) and which result rows a batch has read
  `ALTER TABLE events ADD COLUMN summary TEXT; ALTER TABLE events ADD COLUMN refs TEXT;
  ALTER TABLE outbox ADD COLUMN consumed INTEGER DEFAULT 0;`,
  // why a task's context holds text the owner did not vouch for (a JSON array of reasons)
  "ALTER TABLE tasks ADD COLUMN taint TEXT;",
  // a DOF's authors without scanning the FTS table (untrustedDofs)
  `ALTER TABLE search_meta ADD COLUMN author TEXT;
  UPDATE search_meta SET author = (SELECT author FROM search WHERE search.rowid = search_meta.rowid);
  CREATE INDEX search_meta_author ON search_meta(dof, author);`,
  // which passkey a session signed in with, so deleting it ends them (null: from before this)
  "ALTER TABLE console_sessions ADD COLUMN passkey TEXT;",
  // a task's runs, looked up at every gate check (family)
  "CREATE INDEX tasks_parent ON tasks(parent);",
  // when a scope's first sync ended (only what is newer is a missed message) and the tokens the proxy
  // counted on a task's model calls
  `ALTER TABLE syncs ADD COLUMN first TEXT; UPDATE syncs SET first = last_sync;
  ALTER TABLE tasks ADD COLUMN metered INTEGER NOT NULL DEFAULT 0;`,
  // the CI result a live event mirrored (gateway › missed), so a reconcile does not route it again
  `ALTER TABLE events ADD COLUMN heard TEXT;
  CREATE INDEX events_heard ON events(dof, heard) WHERE heard IS NOT NULL;`,
  // a task's budget is in dollars: what the proxy counted, and open tasks move to the default (a token count converts to
  // no price). A Planner batch's row is gone at the next start
  `ALTER TABLE tasks ADD COLUMN metered_usd REAL NOT NULL DEFAULT 0;
  UPDATE tasks SET budget = json_set(json_remove(budget, '$.tokens'), '$.usd', 20)
    WHERE json_valid(budget) AND kind <> 'planner';`,
  // the Planner's and the judge's day in dollars; `tokens` stays what Settings shows for a model with no price
  "ALTER TABLE planner_usage ADD COLUMN usd REAL NOT NULL DEFAULT 0;",
  // a chat's own model (and its runs'); null follows `worker` in the config
  "ALTER TABLE tasks ADD COLUMN provider TEXT; ALTER TABLE tasks ADD COLUMN model TEXT;",
  // a project's own origins went: the global list is the one list
  "ALTER TABLE tasks DROP COLUMN origins;",
  // the project a chat's recurring row gives its runs (a chat names any of its projects; null: the task's own)
  "ALTER TABLE schedules ADD COLUMN project TEXT;",
];

const TAINT_MAX = 5;

/**
 * A task and every run of its schedules: one holder of grants and logins (each firing is a new task, and a grant
 * asked of one was asked again at the next).
 */
export function family(db: DatabaseSync, task: string): string[] {
  const r = db.prepare("SELECT parent FROM tasks WHERE id = ?").get(task) as { parent: string | null } | undefined;
  const root = r?.parent ?? task;
  const runs = db.prepare("SELECT id FROM tasks WHERE parent = ?").all(root) as { id: string }[];
  return [root, ...runs.map((x) => x.id)];
}

/**
 * Marks the task tainted: from now on the owner decides its gated requests, never the judge.
 * At most TAINT_MAX distinct reasons are kept; the first ones say enough.
 */
export function taint(db: DatabaseSync, task: string, reason: string): void {
  const r = db.prepare("SELECT taint, parent FROM tasks WHERE id = ?").get(task) as
    | { taint: string | null; parent: string | null }
    | undefined;
  if (!r) return;
  const list = r.taint ? (JSON.parse(r.taint) as string[]) : [];
  if (list.includes(reason) || list.length >= TAINT_MAX) return;
  db.prepare("UPDATE tasks SET taint = ? WHERE id = ?").run(JSON.stringify([...list, reason]), task);
}

/**
 * Why the task's context holds untrusted text: untrusted events routed to it (task_attach), the Planner batch it is
 * (every batch reads strangers), and what `taint()` recorded. Empty: untainted, as far as hortusd can see.
 */
/** A forge's event with no author is a CI result: a state and a sha, nobody's words, so it taints nothing. Under `auto` the
 * first one sent the rest of a PR's requests to the owner, up to 47 of them. */
export const isCi = (c: Pick<Config, "dofs">, e: { dof: string; author: string | null }): boolean => {
  const d = c.dofs[e.dof];
  return e.author === null && !!d && !!gitOf(d);
};

export function taintOf(db: DatabaseSync, task: string | null | undefined, c: Pick<Config, "dofs">): string[] {
  if (!task) return [];
  const t = db.prepare("SELECT kind, taint, scope, parent FROM tasks WHERE id = ?").get(task) as
    | { kind: string | null; taint: string | null; scope: string | null; parent: string | null }
    | undefined;
  if (!t) return [];
  // a run reads what its parent wrote (`text`) and what earlier runs left (the summary, /schedule): a task that read a
  // stranger set a timer, and its run went to the judge as clean. Its parent reads neither, so it stays as it was
  const inherited = t.parent
    ? [
        ...taintOf(db, t.parent, c),
        ...(
          db
            .prepare("SELECT taint FROM tasks WHERE parent = ? AND id != ? AND taint IS NOT NULL")
            .all(t.parent, task) as {
            taint: string;
          }[]
        ).flatMap((r) => JSON.parse(r.taint) as string[]),
      ]
    : [];
  const authors = (
    db
      .prepare(
        "SELECT DISTINCT dof, author FROM events WHERE task_id IN (SELECT value FROM json_each(?)) AND trusted = 0",
      )
      // an earlier run's reader is this one's too, through what it left; the parent's come with its own taintOf
      .all(JSON.stringify(t.parent ? family(db, task).filter((id) => id !== t.parent) : [task])) as {
      dof: string;
      author: string | null;
    }[]
  )
    .filter((r) => !isCi(c, r))
    .slice(0, 5)
    .map((r) => `${r.dof}:${r.author ?? "?"}`);
  const own = [
    ...(t.kind === "planner" ? ["a Planner batch reads every event"] : []),
    ...(authors.length ? [`read untrusted messages (${authors.join(", ")})`] : []),
    ...(t.taint ? (JSON.parse(t.taint) as string[]) : []),
    ...(t.kind === "planner" ? [] : untrustedDofs(db, task, mounted(c, t.scope), c)),
  ];
  return [...new Set([...own, ...inherited])];
}

/**
 * `readable`, plus the DOFs on disk the config no longer names that the scope did (unset: any): the host profile and
 * the VM view are built at spawn, so a DOF removed or renamed in the config while a task runs stays readable to it.
 */
function mounted(c: Pick<Config, "dofs">, scope: string | null): string[] {
  const can = readable(c, scope);
  const dofs = (scope ? (JSON.parse(scope) as { dofs?: string[] }) : {}).dofs;
  let gone: string[] = [];
  try {
    gone = readdirSync(join(paths.home(), "dof")).filter(
      (n) => !n.endsWith(".git") && !can.includes(n) && (!dofs || dofs.includes(n)),
    );
  } catch {}
  return [...can, ...gone];
}

/** The shipped guide's DOF: how hortus works, readable by every task, never configured, so never removed. */
export const GUIDE = "hortus";

/** Every DOF name: the configured connectors', `logs`, `transforms` and the guide. */
export const dofNames = (c: Pick<Config, "dofs">): string[] => ["logs", "transforms", GUIDE, ...Object.keys(c.dofs)];

/** The owner's text: approved transforms, the shipped guide, a `files` directory. Never taints, any file layout. */
export const ownersDof = (d: string, c: Pick<Config, "dofs">): boolean =>
  d === "transforms" || d === GUIDE || c.dofs[d]?.type === "files";

/**
 * The DOFs a task can read: its `scope.dofs` (the Planner's choice) that still exist, plus
 * `transforms` (the owner's approved code, the examples a new transform starts from) and the guide; every DOF when unset (chats,
 * Planner batches, rows from before the field).
 */
export function readable(c: Pick<Config, "dofs">, scope: string | null | undefined): string[] {
  const all = dofNames(c);
  const dofs = (scope ? (JSON.parse(scope) as { dofs?: string[] }) : {}).dofs;
  return dofs ? all.filter((n) => n === "transforms" || n === GUIDE || dofs.includes(n)) : all;
}

/** `readable` for a task id (an unknown one: every DOF, as for a row without the field). */
export function readableOf(db: DatabaseSync, c: Pick<Config, "dofs">, task: string): string[] {
  const r = db.prepare("SELECT scope FROM tasks WHERE id = ?").get(task) as { scope: string | null } | undefined;
  return readable(c, r?.scope);
}

/**
 * `<channel>/channel.md`, hortusd's rendering of the service's channel or repo record: the one
 * authorless file that does not taint, or every connector DOF would. ponytail: its free text (a topic, a repo
 * description, display names) is set by whoever the service lets, a stranger included, and is read as the owner's;
 * upgrade: record who set it per connector (Slack's `topic.creator`; forges have nothing comparable).
 */
export const channelMeta = (path: string): boolean => /^[^/]+\/channel\.md$/.test(path);

/**
 * A reason per readable DOF holding text from an author its trust rule does not trust: a Worker
 * can `cat` any file it can read, so the whole DOF counts, checked at every gate decision (a stranger posting later
 * taints too). `transforms` is the owner's; `logs` counts once it holds another task's log (sessions quote what they
 * read). Each file's author is judged as a `dof.search` hit is (mirror/index.ts › untrustedHits): an authorless file
 * (channel.md: a topic anyone in the channel sets) and hortusd's own bot replies (they may quote what a tainted task
 * read) are untrusted, so in practice a messenger DOF hortusd posts in always taints, and an unattended task stays
 * auto-judgeable by not reading it (the Planner's default `dofs: []`; the brief carries the events).
 */
function untrustedDofs(db: DatabaseSync, task: string, dofs: string[], c: Pick<Config, "dofs">): string[] {
  const out: string[] = [];
  const member = db.prepare("SELECT 1 FROM events WHERE dof = ? AND author = ? AND member = 1 LIMIT 1");
  const authors = db.prepare(
    `SELECT DISTINCT author FROM search_meta WHERE dof = ? AND (COALESCE(author, '') != '' OR path NOT GLOB '*/channel.md' OR path GLOB '*/*/channel.md')`,
  );
  for (const d of dofs) {
    if (ownersDof(d, c)) continue;
    if (d === "logs") {
      if (db.prepare("SELECT 1 FROM search_meta WHERE dof = 'logs' AND instr(path, ?) != 1 LIMIT 1").get(`${task}/`))
        out.push("can read logs, which holds other tasks' sessions");
      continue;
    }
    const cfg = c.dofs[d];
    if (!cfg) {
      // no trust rule left to judge its authors by: any file counts
      if (authors.get(d)) out.push(`can read ${d}, which is no longer configured`);
      continue;
    }
    for (const { author } of authors.iterate(d) as Iterable<{ author: string | null }>) {
      const a = author ? { user: author, member: member.get(d, author) !== undefined } : null;
      if (!trusted({ author: a, bot: false }, cfg)) {
        out.push(`can read ${d}, which holds untrusted authors (${author || "?"})`);
        break;
      }
    }
  }
  return out;
}

export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  // journal_size_limit: the auto-checkpoint keeps the WAL backfilled, but its file stays at its high-water mark, and an
  // FTS5 segment merge grows with the index (4 → 9.5 MB in 30 min); truncated back to 8 MB after one
  db.exec(
    "PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_size_limit = 8388608;",
  );
  migrate(db);
  return db;
}

/** One migration per transaction; the version is read under the write lock, so two openers never both apply one. */
export function migrate(db: DatabaseSync, leaveOut = 0): void {
  const version = () => (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  for (;;) {
    if (version() >= migrations.length - leaveOut) return; // up to date: an opener takes no write lock
    db.exec("BEGIN IMMEDIATE");
    try {
      const v = version();
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
