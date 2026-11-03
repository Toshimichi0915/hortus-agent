# F0 — Foundation: repository, config, schema, RPC router

Everything else imports this. It is built first, alone, and is small.

## Implementation

### Repository

```
hortus-agent/
  package.json          # name hortus-agent, type module, bins below, deps below
  tsconfig.json         # extends hortus's typescript.json settings (copied): NodeNext, strict, noUncheckedIndexedAccess, rewriteRelativeImportExtensions, rootDir src, outDir dist
  biome.json            # hortus's
  src/
    bin/hortusd.ts bin/hortus.ts bin/hortus-agent.ts bin/dof.ts   # shebang: #!/usr/bin/env -S node --no-warnings=ExperimentalWarning
    config.ts db.ts ids.ts log.ts rpc.ts paths.ts
    connectors/ mirror/ vault/ proxy/ runtime/ console/ planner/ schedules/ projects/ browser/   # later tracks
    *.test.ts colocated
  transforms/<name>/{manifest.json,transform.js,tests/*.json}   # shipped transforms, copied to dist by the build
  native/landlock.c     # F4
  scripts/dev-run.sh scripts/build-image.sh hortusd.service
  test/fakes/           # fake upstreams
```

Dependencies (all added now so parallel tracks never edit `package.json`): `@hortus/core@^1.2.0`, `zod@^4`, `croner@^11`, `quickjs-emscripten@^0.32`, `@simplewebauthn/server@^14`, `ws@^8`. Dev: `typescript`, `@biomejs/biome`, `@types/node`, `@types/ws`. Scripts: `build` (`tsc -b && cc -O2 -o dist/hortus-landlock native/landlock.c && cp -r transforms dist/`), `test` (`pnpm build && node --test 'dist/**/*.test.js'`), `lint`, `format`.

### `paths.ts`

`HOME = process.env.HORTUS_HOME ?? join(homedir(), ".hortus")`. One function per v6 tree entry: `config()`, `vault()`, `db()`, `ca()`, `dof(name)`, `dofRepo(name)` (`dof/<name>.git`), `logs()`, `repo(dof, project)`, `project(name)`, `shadow(name)`, `task(id)`, `ctl(id)`, `out(id)`, `clone(id)`, `schedule(id)`, `images()`, `paused()`, `socket()` (abstract: `\0hortus-<uid>` or `\0hortus-<hash of HOME>` when `HORTUS_HOME` is set).

### `config.ts`

Zod schema of v6 Config plus v7 additions. Defaults: `origins: "*"`, `vm: { cpus: 2, mem_mb: 4096, max_concurrent: 4 }`, `chat.allow: []`, `policy: { "*": "human" }`, `planner.batch_max: 50`, `planner.daily_tokens: 5e6`, `planner.effort: "low"`, `planner.runtime: "host"`, `worker.budget: { tokens: 2e6, hours: 4 }`, `worker.credentials: []` (empty = every configured credential name; v6 lists them explicitly), `worker.context_window: 131072`, `projects: {}`, `dofs: {}`. `load()` throws on an invalid file (never reads it as empty); `save(c)` writes `0600` atomically (temp + rename). `watch(cb)` is not needed: the Settings page is the only writer and calls `reload()` explicitly.

`policy` lookup: `policyFor(category)`: exact key, else `*`. `transforms`, `merge`, `login`, `origin:*` are forced `human` whatever the file says.

### `db.ts`

`openDb(path)` → `DatabaseSync` with `journal_mode=WAL`, `busy_timeout=5000`, `foreign_keys=ON`. Migrations by `PRAGMA user_version`, one `migrate()` with the statements in order. Schema (all timestamps are ISO strings in UTC; JSON columns hold JSON text):

```sql
events(id INTEGER PRIMARY KEY, dof TEXT, key TEXT, ts TEXT, author TEXT, member INTEGER, trusted INTEGER, bot INTEGER,
       payload TEXT, consumed INTEGER DEFAULT 0, task_id TEXT, ignored TEXT, created TEXT, UNIQUE(dof, key));
tasks(id TEXT PRIMARY KEY, kind TEXT, title TEXT, brief TEXT, status TEXT, scope TEXT, origins TEXT, budget TEXT,
      usage TEXT, project TEXT, runtime TEXT, parent TEXT, event_keys TEXT, outcome TEXT, summary TEXT,
      created TEXT, updated TEXT, closed TEXT, started TEXT, hours REAL DEFAULT 0, cwd TEXT);
task_refs(ref TEXT PRIMARY KEY, task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE);
inbox(task_id TEXT, seq INTEGER, body TEXT, created TEXT, PRIMARY KEY(task_id, seq));
outbox(task_id TEXT, seq INTEGER, body TEXT, created TEXT, PRIMARY KEY(task_id, seq));
replies(task_id TEXT, seq INTEGER, body TEXT, created TEXT, PRIMARY KEY(task_id, seq));   -- chat stream lines kept for reconnects
syncs(dof TEXT, scope TEXT, cursor TEXT, last_sync TEXT, PRIMARY KEY(dof, scope));
schedules(id INTEGER PRIMARY KEY, task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE, fire_at TEXT, every_sec INTEGER,
          cron TEXT, tz TEXT, text TEXT, script TEXT, expires_at TEXT, last_run TEXT, created TEXT);
search USING fts5(dof, path, author, ts, title, body, tokenize='trigram');          -- plus a shadow table search_meta(dof, path PRIMARY KEY, rowid) for upserts
approvals(id INTEGER PRIMARY KEY, kind TEXT, category TEXT, hash TEXT, task_id TEXT, summary TEXT, status TEXT,
          requested_at TEXT, decided_at TEXT, decided_by TEXT, prompt_hash TEXT, reason TEXT, payload TEXT);
captured(id INTEGER PRIMARY KEY, name TEXT UNIQUE, value TEXT, origin TEXT, kind TEXT, created TEXT, last_use TEXT);
transforms(name TEXT PRIMARY KEY, hash TEXT, enabled_at TEXT);
passkeys(id TEXT PRIMARY KEY, public_key TEXT, counter INTEGER, device TEXT, transports TEXT, created TEXT, last_use TEXT);
console_sessions(hash TEXT PRIMARY KEY, device TEXT, created TEXT, last_seen TEXT, address TEXT);
enroll_codes(code TEXT PRIMARY KEY, expires_at TEXT);
planner_usage(day TEXT PRIMARY KEY, tokens INTEGER);
links(address TEXT PRIMARY KEY, role TEXT, task_id TEXT, kind TEXT, created TEXT);       -- client registry: VM taps, session addresses, login views
```

Indexes: `events(consumed)`, `events(task_id)`, `tasks(status)`, `approvals(status)`, `schedules(fire_at)`, `inbox(task_id, seq)`.

Typed helpers only where used twice; otherwise modules write their own SQL. `now()` returns the ISO string.

### `ids.ts`

`taskId()` = `Date.now().toString(36) + randomBytes(4).toString("hex")`. `token(n)` = `randomBytes(n).toString("base64url")`.

### `log.ts`

`log(scope, msg, data?)` → one JSON line on stderr (journald picks it up). No levels beyond `info`/`error`; `error` includes the stack.

### `rpc.ts`

One handler table, three transports (abstract socket for the CLI, `POST /api/<m>` for the web UI, `https://hortusd.internal/rpc/<m>` through the proxy).

```ts
export type Role = "owner" | "core" | "worker" | "planner" | "login";
export interface Caller { role: Role; task?: string }
export interface Method<I, O> { roles: Role[]; input: z.ZodType<I>; run(input: I, caller: Caller): Promise<O> }
export const methods: Map<string, Method<any, any>>;
export function define<I, O>(name: string, m: Method<I, O>): void;      // throws on a duplicate name
export function call(name: string, input: unknown, caller: Caller): Promise<unknown>;
// errors: RpcError(code: "not_found" | "forbidden" | "invalid" | "failed", message, data?)
export function serveSocket(path: string): Promise<Server>;              // newline-delimited JSON: {id, method, input} → {id, result} | {id, error}; role owner
```

A `worker`/`planner` caller's `task` is set by the transport (the proxy's link lookup), never by the body. Streaming methods (chat stream, task card updates) are not RPC: they are SSE endpoints on the console (`06-console.md`).

### `bin/hortusd.ts`

`main()`: load config → open DB → start the parts that exist (`gateway`, `proxy`, `console`, `dispatcher`, `scheduler`, each a module with `start(ctx)` / `stop()`) → `SIGTERM` stops them in reverse. `ctx = { config, db, reload(), paths }`. At F0 only the socket and `ping` exist.

## Functional tests

- `config`: missing file → defaults; invalid JSON or schema → throws naming the path; `policyFor("merge")` is `human` even when the file says `auto`; `policyFor("credential:x")` falls back to `*`; `save` leaves no temp file and mode is `0600`.
- `db`: `openDb` twice on one file is idempotent (`user_version` unchanged); every table in the schema exists; FTS5 trigram table accepts an insert and a `MATCH`; `ON DELETE CASCADE` removes `task_refs` and `schedules` with their task.
- `ids`: 1000 ids are unique and sort by creation time.
- `rpc`: `define` twice throws; `call` with a role outside `roles` → `forbidden` before input validation runs (validation errors must not leak to a caller who may not call); invalid input → `invalid` with the zod issue; a handler throwing a non-`RpcError` → `failed` with the message, stack only in the log; the socket transport answers out of order calls by `id`, survives a malformed line (answers `{error: invalid}` and keeps the connection), and rejects a frame over 16 MB.
- `hortusd`: starts with `HORTUS_HOME` pointing at an empty directory, creates it `0700`, answers `ping` over the socket, exits cleanly on `SIGTERM` within 2 s.

Edge cases: `HORTUS_HOME` with a trailing slash; a config with unknown keys (kept, not dropped, so a newer version's keys survive an older binary); `policy` with an empty object; two daemons on the same `HORTUS_HOME` (the second fails to bind the socket and exits non-zero without touching the DB).

## UI/UX verification

None at this step (no UI). The CLI's error for an absent daemon is one line: `hortusd is not running (socket \0hortus-1000)`.

## Extensibility verification

- A new RPC method is one `define()` call in its module; no transport changes.
- A new table is one migration appended; `openDb` on an older file applies it.
- A new config key is one line in the schema with a default; `Settings` renders it without code (06-console.md).
- The `Caller.role` union is the only place roles are listed; adding one (a future `reviewer`) touches it and the transports that mint it.
