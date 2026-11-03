# F1 — Mirror, search index, `dof search`, logs renderer

Spec: v6 › DOF (Mirror, Logs, Mount, Commands). Depends on F0 only. Tested with synthetic Changes; no connector needed.

## Implementation

### `src/mirror/types.ts`

```ts
export interface Change { op: "put" | "patch" | "delete"; path: string; frontmatter?: Record<string, unknown>; body?: string; bytes?: Buffer }
// patch: merge `frontmatter` keys into an existing Markdown file (a key set to null is removed); file missing → log, skip
// path is relative to the DOF root: "<channel>/channel.md", "<channel>/<thread>/<message>.md", "<channel>/<thread>/files/<id>-<name>"
```

`frontmatter` + `body` render to Markdown with a YAML header (keys in insertion order; strings quoted when they could parse as numbers, like Slack's `ts`; arrays inline; objects one level deep inline as in v6's `reactions`). `bytes` writes a binary file as is. Rendering is one function `render(frontmatter, body)`, its inverse `parse(text)` is for tests and the Worker-facing `dof` CLI only.

### `src/mirror/repo.ts`

One bare repo per DOF at `dof/<name>.git`, one worktree at `dof/<name>/` (`git worktree add`, branch `main`). `init(name)` creates both with an empty root commit, `user.name hortus`, `gc.auto 0`.

`commit(name, changes: Change[], message): Promise<{ sha: string; diff: DiffEntry[] } | null>`:

1. Refuse any `path` containing `..`, a leading `/`, or a `\0`; refuse a message path whose channel, thread or message id contains `/` (log, drop the Change, continue with the rest).
2. Write puts to a temp name in the same directory and `rename` (a reader never sees a half file), `unlink` deletes, remove directories that become empty.
3. `git add -A && git commit -q -m <message>`; nothing to commit → return `null` (a sync with no new objects is not a commit).
4. Return `git diff-tree --no-commit-id --name-status -r <sha>` as `{ status: "A" | "M" | "D"; path }[]`.

Serialized per DOF with a promise chain (one sync at a time per repo); different DOFs run in parallel. `gitDir`/`worktree` paths come from `paths.ts`.

The `logs` DOF has no repo: `writeLog(taskId, files)` writes with the same temp-and-rename and calls the indexer directly.

### `src/mirror/index.ts` (FTS)

`index(dof, entries: DiffEntry[])`: for each `A`/`M` entry ending in `.md`, parse the file and upsert the row `(dof, path, author, ts, title, body)` (`author` from `user`, `title` from `title` or, for a message, the first 80 chars of the body; `channel.md` indexes `name`/`topic`); for each `D` delete the row. Files under `files/` and binaries are not indexed. Upsert via `search_meta(dof, path) → rowid`; FTS5 external content is not used (simpler, the mirror is the source of truth).

`search(q, { in?: string; author?: string; since?: string; until?: string; limit = 20 })`:

- `q.length >= 3` → `search MATCH ?` with the query quoted as a trigram phrase (`"` escaped), ranked by `bm25(search)`, then `ts DESC`. Shorter → `title LIKE ? OR body LIKE ?` with `%q%`.
- Filters are `AND`ed; `since`/`until` compare the ISO `ts` strings.
- Returns `{ dof, path, author, ts, title, snippet }`, `snippet` from `snippet(search, 5, '[', ']', '…', 12)` for MATCH, else the first 120 chars.

### `src/mirror/logs.ts`

`renderSession(dir): string` reads every `*.jsonl` in `out/sessions/` in name order (lexical = chronological) and, replaying each with core's `listSessions`/`branch` semantics (import `@hortus/core` directly here, `hortusd` has the real HOME), emits `## <seq> <role> <ts>` sections: user text as is, assistant text as is, tool calls as fenced `json`, tool results as fenced text (the first 4 KB of each, then `… (<n> bytes)`), images as `[image]`. Secrets never appear because the Worker never had them. `publishLog(taskId, title, status, events)` writes `logs/<id>/session.md` and copies `out/summary.md` (absent → a one-line `No summary.`), then upserts two index rows with `title` = the task title and `ts` = now.

### RPC `dof.search`

`define("dof.search", { roles: ["owner", "worker", "planner"], input: { q, in?, author?, since?, until?, limit? } })` → the rows above. Every DOF is searchable by every role (v6: every Planner and Worker sees `logs` like any DOF).

### `bin/dof.ts`

`dof search <query> [--in <dof>] [--author <id>] [--since <iso>] [--until <iso>] [-n <limit>]`. Transport per v7: `HORTUS_TASK` set → `https://hortusd.internal/rpc/dof.search` (the proxy stamps the role); else the abstract socket. Output: `<dof>/<path>\t<ts>\t<author>\t<title or snippet>`, newest first. Exit 1 with the RPC error on failure, 0 with no output on no hits.

## Functional tests

- `render`/`parse` round-trip the two v6 examples byte for byte, including the quoted `"1730000000.123456"` id and the inline `reactions` object.
- `commit`: a put creates the file and one commit whose diff lists `A`; the same put again returns `null` (no commit); a delete lists `D` and removes an emptied thread directory; a message edited upstream overwrites the file and `git log -p` still shows the old body on `main`.
- Path safety: `../x.md`, `/etc/x`, `a/b\0c` and a thread id `../..` are dropped and logged; the other Changes in the batch still land.
- Concurrency: 50 concurrent `commit` calls on one DOF produce 50 commits with no `index.lock` error; two DOFs commit in parallel.
- Index: after a commit the row is searchable; after a delete it is gone; an `M` updates the row (search for the old body finds nothing); binary files under `files/` create no row.
- Search: a CJK query (3 characters) matches; a 2-character query falls back to `LIKE`; `--in logs` restricts; `--author` matches the `user` id, not the display name; `--since`/`--until` bound inclusively; results are newest first; a query with `"` or `*` does not error; limit caps.
- Logs: a session with a tool call returning 100 KB renders a 4 KB excerpt and a byte count; an image result renders `[image]`; a missing `summary.md` renders `No summary.`; a half-written `.jsonl` line (crash) is skipped as core does; re-publishing replaces the files and keeps one index row per path.
- A read during a checkout: a reader polling a file during 100 commits never reads an empty or truncated file (temp-and-rename).

## UI/UX verification

- `dof search` output lines align in a terminal (tabs), the newest hit first, a snippet never contains a newline.
- An unknown `--in` name prints `no DOF named <x>` and exits 1.

## Extensibility verification

- A connector emits only `Change`s; nothing in F1 names Slack. Adding a forge later adds frontmatter keys (`state`, `checks`) with no change here: `render` is schema-free.
- A new DOF kind without a repo (like `logs`) reuses `writeLog`'s temp-and-rename and the indexer.
- The indexer's `title` rule is the one place a new object kind might need a line.
