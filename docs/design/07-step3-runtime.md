# Step 3 — Host runtime: tasks, dispatcher, chat, logs, recovery

Spec: v6 › Worker (runtimes, control plane, resume), Chat, Logs, Recovery, Console (Tasks, Chat, Projects, Settings, Search). Wires F4 + F5 + F6 pages into `hortusd`. After this step the owner can chat from the web UI and from `hortus chat`.

## Implementation

### `src/runtime/tasks.ts` — lifecycle

```ts
create(input: { kind; title; brief; scope; project?; runtime?; event_keys; parent?; cwd?; budget? }): Task   // status queued; tasks/<id>/{ctl,out}; task_refs from event_keys
inboxWrite(task, msg: Omit<InboxMsg, "seq" | "ts">): number   // next seq, file temp+rename into ctl/inbox, row in inbox
stop(task)   // touch ctl/STOP; running → the runtime kills after 30 s if still alive; status waiting
close(task, outcome: "done" | "failed")   // publishLog, delete tasks/<id>, clones/<id>, schedules of the task (rows cascade; dirs removed), status done|failed, closed = now
budget(task, { tokens?, hours? })
```

Statuses: `queued → running → waiting → (queued → running …) → done | failed`. `waiting` means idle and resumable; the next inbox message re-queues it (`inboxWrite` sets `queued` when `waiting`). `updated` changes on every transition.

`task.json` is rebuilt at every start from the row and config (model, budget, credentials, paths, `hours_used`), so a budget raised in the console or a credential added by an approval applies on the next start without touching a running Worker (a running one picks decisions up from its inbox).

### `src/runtime/dispatcher.ts`

Every second and on every `wake()`: for each `queued` task whose runtime is free (host: always, unless `PAUSED`; VM: below `max_concurrent`, 3g): start it. Starting a host task:

1. `scope.project` → `projects.sync(name)` and `clone` (3b; before 3b: `cwd` = `out/work`); chat → `cwd` = `out/work`, `projects` and `cwd` into `task.json`.
2. Write `task.json`, `ctl/home`, `ctl/ca.crt`; status `running`, `started = now`.
3. `host.spawnSandboxed` with kind `chat` (chat) or `unattended` (the rest). stdout lines → `replies` rows (chat: every line; others: only `reply`/`result`-equivalent lines are also written by the Worker as outbox files, so stdout goes to `console.log`).
4. On exit: `hours += (now − started)`; read `out/outbox/` (new files since the last seen seq; regular files only, ≤ 1 MB, zod-checked; a bad file is logged and skipped), each → `outbox` row: `reply` → card; `result` → `tasks.summary` from `out/summary.md` (≤ 64 KB) and, for non-chat tasks, the Planner is woken (step 4; before: the task becomes `waiting`); `budget_exceeded` → `waiting` + Planner wake. Then `publishLog` (every exit renders, v6 Logs) and status: `running → waiting` (chat, or a Worker that exited without `done`), `run` kind with empty result → closed (3c).
5. Exit code ≠ 0 with no outbox → `waiting` with `console.log`'s tail on the card (`tasks.error`, a column added here).

Chat `task.open({ text, cwd })`: `create({ kind: "chat", title: first 80 chars, brief: text, event_keys: ["chat:<id>"], scope: every credential name, every repo, project: the project whose path contains `cwd` })`, then `inboxWrite({ from: "owner", text, trusted: true })`. `task.send` → `inboxWrite` (owner). `task.message` → `inboxWrite({ from: "console", trusted: true, text })` wrapped (a routing note, not the owner talking).

### `logs` DOF (F1's `publishLog`) and `logs` config

`dofs.logs` is implicit: always present, no connector. Tasks page lists closed tasks from the `search` rows of `logs` (`title`, `ts`) plus `tasks` rows kept (rows are never deleted; `tasks.summary` holds the last summary).

### Recovery (`src/runtime/recovery.ts`, called at start)

- Every `running` task: `kind` chat → `waiting`; `run` kind with no assistant message in its sessions → closed `failed` (a firing runs at most once); others → `queued` (resume on the same directory; the agent adds synthetic interrupted results, F5).
- Stale `links` rows and `hortus:` nftables rules → flushed; stale cgroups under `tasks/` → removed; pending approvals stay; login views (3h) stay as rows.
- A closed task whose `tasks/<id>` is still there (a crash inside `close`) → `finishClose` again: log published, directories and schedules removed (its pending requests expired in the same turn as the status). Entries past 72 h expire once every module is up, before `started` (round 8).
- Then the gateway's sync poll and (6) redelivery check run.

### Settings and `PAUSED`

`settings.set` validates, writes, `reload()`: config object swapped; the gateway diffs `dofs` and restarts changed connectors; the dispatcher reads `PAUSED` (`paths.paused()` presence) on each tick; `pause.set` creates/removes the file.

## Functional tests

End-to-end with `scripts/dev-run.sh`, the fake Slack, DeepSeek through `dev.upstreams` (`ollama.com` → a recording proxy is not needed: the real endpoint is fine; the test asserts behaviour, not tokens):

- v6 done-when: a chat opened from the web UI with "search the slack DOF for `deploy` and reply in that thread with a one-line summary" → the Worker runs `dof search`, `curl`s `chat.postMessage` with the placeholder, gets `403 {approval}`, the Approvals page shows it, one click → the fake receives the message with the real token → the thread file appears in the mirror; the chat stream shows the whole exchange.
- "edit README.md of project foo: add a line" with `cwd` inside `foo` → the file changes in place in the owner's checkout; `git status` in the checkout shows the change.
- Close the chat page, reopen `/chat/<id>`: the stream shows the earlier lines; a new message continues with context (the model refers to the earlier edit).
- `hortus tasks` shows the card with the Worker's `send` notes and the summary after `done`.
- A second chat task: "what did task <title> conclude?" → the Worker finds it with `dof search --in logs` and reads `summary.md`.
- A chat session running `cat ~/.hortus/vault.json` gets `Permission denied` (F4) and the stream shows it.
- Recovery: `systemctl kill -s KILL hortusd-test` mid-run → restart → the unattended task is `queued` and resumes (its next assistant message references the earlier tool result), the chat task is `waiting`.
- `STOP` on a running chat: the Worker stops after its current tool; status `waiting`; `hortus chat -r <id>` resumes it.
- Budget: `task.budget` raise on a `waiting` task with `budget_exceeded` → the next message runs.
- `close`: `tasks/<id>` and `clones/<id>` are gone, `dof/logs/<id>/` exists, `dof search --in logs` finds the title; the row stays with `summary`.
- Hostile `out/`: a symlink `outbox/000009.json → /etc/passwd` is ignored and logged; a 2 MB outbox file is ignored; a JSON file with an unknown `type` is ignored; `summary.md` of 1 MB is truncated to 64 KB on the card.
- `PAUSED`: a queued task does not start; removing the file starts it within 2 s.
- Reload: changing `dofs.slack.trust` restarts only slack (the fake counts one reconnect); changing `worker.model` does not restart anything and the next task start uses it.

Edge cases: two `task.send` within 10 ms get seq 1 and 2 (serialized); an owner message while the task is `queued` (not yet started) is in the first drain; `task.open` with `cwd` outside every project sets no project; a project path that is a symlink matches by `realpath`; the Worker exits before writing any session (model key invalid) → `waiting` with the error on the card, not a crash loop (no automatic restart without a new inbox message; round 8, round 9: while `tasks.error` is set only the owner starts it (a message, a note, an approval they approved, their own event through the Planner) or a one-shot timer; Planner notes, rejections, expiries, merge and rebase notices and strangers' events wait in the inbox; a Worker that gave up after four failed model calls sets it too; a session ended by shutdown or close sets none).

## UI/UX verification

- The chat page shows "connecting…" then the stream; a Worker start takes under 2 s on the host and the page shows "started" as the first event.
- An approval raised from a chat appears inline within a second; after approval the next stream line is the Worker's retry.
- The card's error line (exit without outbox) is one line with a "show console.log" fold.
- `hortus chat` prints tool calls as `$ <command>` grey lines and model text as it streams; Ctrl-C stops the current turn (`STOP`), a second Ctrl-C quits.

## Extensibility verification

- A new task kind is a row in the dispatcher's kind table (runtime, profile, wake target); the lifecycle does not change.
- A new runtime (3g's VM) implements `start(task): Child` beside `host.ts`; the dispatcher picks it by `runtime`.
- A new outbox type is one case in the exit handler and the zod union.
