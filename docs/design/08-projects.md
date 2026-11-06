# Step 3b — Projects: local origin, `pre-receive`, sync, `merge()`, shadow repos

Spec: v6 › Projects › Local origin, Non-git projects, Concurrency; Console › Projects. Depends on step 3. Parallel with 3c–3h.

## Implementation

### `src/projects/origin.ts`

- `ensure(name)`: `projects/<name>.git` bare (`init --bare`, `receive.denyNonFastForwards true`, `receive.denyDeletes true`, `gc.auto 0`), `hooks/pre-receive` written from a template:

```sh
#!/bin/sh
# role worker: only refs/heads/hortus/<task>, force allowed (denyNonFastForwards is for main; this hook runs first and refuses the rest)
while read old new ref; do
  case "$HORTUS_ROLE" in
    worker) [ "$ref" = "refs/heads/hortus/$HORTUS_TASK" ] || { echo "refused: $ref" >&2; exit 1; } ;;
    core) ;;
    *) echo "refused: role" >&2; exit 1 ;;
  esac
done
```

- `git http-backend` behind `https://hortusd.internal/git/<name>[/…]` (03's internal router): CGI child with `GIT_PROJECT_ROOT=projects/`, `GIT_HTTP_EXPORT_ALL=1`, `PATH_INFO`, `REQUEST_METHOD`, `QUERY_STRING`, `CONTENT_TYPE`, `HORTUS_ROLE`, `HORTUS_TASK`; body streamed in, CGI output parsed for headers and streamed out. Push to a project not in `scope.project` (unattended) or not in `projects` (chat has every project) → 403 before CGI.
- `sync(name, force?)`: a git project → `git -C projects/<name>.git fetch <path> <main>:<main>` (non-ff refused unless `force`, which uses `+<main>:<main>`); a non-git project → `shadow.snapshot(name)` then the fetch from the shadow. Called at every unattended start on the project, after every merge, and by `project.sync`.
- `prepareClone` on a clone that exists rewrites its `objects/info/alternates` to the checkout's current path (`replaceFile`: the Worker owns that file).
- `clone(task, name)`: `git clone --reference <checkout> https://hortusd.internal/git/<name> clones/<task>` runs inside the Worker (the prompt tells it; the dispatcher pre-creates nothing). The clone URL is in `task.json.paths.clone`. Host Workers: the clone goes through the proxy like any request (the session address), so the pre-receive sees the task.

### `src/projects/shadow.ts`

- `ensure(name)`: `shadow/<name>.git` with `core.worktree = <path>`, `info/exclude` from `exclude`, `core.bare false`.
- `snapshot(name)`: `git --git-dir shadow/<name>.git --work-tree <path> add -A && commit -q -m snapshot` (nothing to commit → the current `main` sha); returns the sha. Then `projects/<name>.git fetch shadow main:main`.
- `restore(name, sha)`: `read-tree -u --reset <sha>` in the shadow, then `snapshot` (records the restore as a new commit).

### `src/projects/merge.ts`

- RPC `merge` (role worker, task T): project = T's `scope.project` (403 if none); branch `hortus/<T>` must exist in the origin; `main_sha` = origin `main`; `sha` = branch tip; `git diff --stat main..sha` and the patch (first 64 KB in the summary; the full diff fetched by the page on demand from `approval.get(…, { full: true })`); replace T's pending merge entry (`UPDATE … status='replaced'`); gate `check({ category: "merge", hash: sha256(project, sha, main_sha), summary: { project, branch, main_sha, sha, stat, patch } })` → the entry id is returned to the Worker, who waits for the inbox decision.
- On approval (`gate.decide` → `merge.land(entry)`): for a non-git project, `snapshot` first (an owner edit since → `main` moves → the branch is behind → "rebase"); `git -C <checkout> fetch projects/<name>.git <sha>`; checkout at `main_sha` (`rev-parse HEAD`) and clean (`status --porcelain` empty; non-git: the snapshot sha equals `main_sha`) else fail with the reason; `git -C <checkout> merge --ff-only <sha>` (non-git: `read-tree -u --reset` after the ff in the shadow... simpler: for non-git, the shadow is the checkout's repo, so the same `merge --ff-only` with `--work-tree <path>` rewrites the directory); only on success `git -C projects/<name>.git update-ref refs/heads/main <sha> <main_sha>`; write `{ from: "merge", text: "merged <sha>" }` to T's inbox; the approval entry gets `status = landed`. Failure → the reason on the entry (`reason` column, shown on the page) and in T's inbox; the entry stays `approved` and usable; a later `land` retry from the page is a button.
- When `main` moves (sync or merge), every task with a pending merge on the project gets `{ from: "rebase", text: "main moved to <sha>; rebase hortus/<task> and request merge again" }` and its entry is `replaced`.

### Worker side (F5 feature `merge`)

`merge()` tool → RPC; returns `{ approval: id }`; the prompt says to push first and wait for the inbox decision. The prompt for unattended project tasks: clone with `--reference`, work on `hortus/<id>`, push after every turn, `merge()` when done, report what cannot be resolved in the originating thread.

### Console › Projects page

Add/remove (`project.set`/`project.delete`: `delete` leaves `projects/<name>.git` and `shadow/` in place, renamed `.removed-<ts>`, and open merges on the project `replaced` with the task told), fields, `sync --force`, shadow snapshots (last 20, `git log` of the shadow) with "restore to this" (two-click confirm).

## Functional tests

- Origin: a worker push to `refs/heads/hortus/<T>` passes, force included; to `hortus/<other>` → refused with the hook's message; to `main` → refused; role `core` fetch into `main` passes; a client without a role → refused. Pushes go through `hortusd.internal` with the task from the proxy (not from any header the client sends).
- Sync: an owner commit on `main` lands in the origin on the next unattended start; a rewritten `main` (owner `reset --hard HEAD~1`) is refused, logged and said on the task's card (`startSync`: the task works from the last synced main; with no main in the origin it does not start, the reason on the card), `project.sync` with `force` applies it; uncommitted changes are not in the origin.
- Non-git: a directory with files and an `exclude` list → `snapshot` commits everything but excluded paths; an excluded path is invisible in the clone and absent from diffs; `restore` deletes a file added since the snapshot; the restore is a new commit.
- v6 done-when: an unattended host Worker on a non-git project (fake brief: "add CHANGELOG.md with one line") delivers `hortus/<T>`; the Approvals entry shows the stat and patch; approve → the directory has `CHANGELOG.md`; with an owner edit of another file between request and approval (so `main` moved) → the entry is replaced, the Worker gets "rebase", rebases, pushes, requests again, the new entry shows the resolved diff, approve → lands.
- Conflict: the owner edits the same file between the clean check and the merge → `merge --ff-only` is impossible (branch behind) → nothing moves, the reason is on the entry and in the inbox.
- Two tasks, two approvals on one project: the first lands, the second's `update-ref` with the old `main_sha` fails → "rebase" to that task; nothing is half-applied.
- Dirty checkout: an uncommitted change in the owner's checkout → the approval does not land, the reason says "checkout is not clean", a later retry after the owner commits lands.
- Chat sessions never push or merge: `merge()` is not in a chat task's features (the tool is absent).
- The hook refuses `refs/tags/*` and deletions from workers; `git push --delete` of `hortus/<T>` by its own worker is refused (`denyDeletes`).
- A project name with `/` or `..` is refused by `project.set`.

## UI/UX verification

- A merge entry reads: project, `hortus/<id>` → `main` at `main_sha[:7]`, `+12 −3 in 2 files`, a patch excerpt with file headers, "full diff" folded; approve shows "landed <sha[:7]>" or the failure reason in place, with a "retry" button when the reason is transient (dirty checkout).
- Projects page: the runtime and `main` are dropdown/text inputs; "sync now (force)" explains that it overwrites the origin's `main`; the snapshot list shows time and message; restore is a two-click action.

## Extensibility verification

- The forge origin (6) reuses nothing here but the branch naming (`hortus/<task>`); `merge.ts` is local-origin only by design.
- A new project `runtime` value is a dispatcher row; projects code does not switch on it.
- `restore` and `snapshot` are the only shadow operations; a future "diff since snapshot" page is a `git diff` call on the same repo.

**Round 23.** `prepareClone` clones into `clones/<id>.new`, branches and sets the remote there, then renames: a restart inside the clone left one on `main` with the origin's path as its remote. `merge.request` reads `main` and writes its entry on the project's sync chain (`serialized`), so another task's landing cannot fall between the two.
