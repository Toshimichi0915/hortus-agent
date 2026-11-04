# Step 3c — Schedules

Spec: v6 › Schedules. Depends on step 3. Parallel with 3b, 3d–3h.

## Implementation

### `src/schedules/schedules.ts`

- RPC `schedule.set` (role worker; `task` from the proxy): `{ text, at?, every?, cron?, tz?, script? }` exactly one of `at`/`every`/`cron`; `every ≥ 300`; `cron` 5 fields, validated with `croner`, and refused when two consecutive fires are under 300 s apart (checked over the next 10 fires); `tz` IANA (default `owner.tz`); `script ≤ 16 KB`. In a run (`parent` set) the row belongs to the parent (`task_id = parent`). Returns `id`. `schedule.unset` (worker on its own or its parent's rows; owner on any).
- `fire_at`: `at` as given (must be in the future); `every` → `now + every`; `cron` → `Cron(expr, { timezone: tz }).nextRun()`. DST: `croner` drops a skipped time and fires a repeated one once (asserted in tests with `America/New_York` around the transitions).
- `expires_at`: 7 days after the last inbox message of the task or any of its runs that was not written by a schedule; `inboxWrite` updates the task's rows (`cron` rows never expire); `schedule.set` sets it from the latest such message; a one-shot `at` beyond `expires_at` is refused with the limit in the error.
- Tick (every minute, skipped while `PAUSED`): `SELECT … WHERE fire_at <= now`. For each row, first advance (`every` → `fire_at += every` until > now; `cron` → next run; `at` → delete the row), then act: one-shot without script → `inboxWrite(task, { from: "schedule:<id>", text, data: { expires_at } })` (a `waiting` task re-queues; a `running` one is steered); anything else → `runs.start(row)` unless a run of the row is `queued` or `running` (skipped, logged). Expired rows are deleted on the tick. `last_run = now` on every firing.
- Deleting a task deletes its rows (cascade) and `schedules/<id>/` directories.

### `src/schedules/runs.ts`

`start(row)`: `tasks.create({ kind: "run", parent: row.task_id, title: "<parent title> @ <fire time in tz>", brief: row.text, event_keys: ["schedule:<id>"], scope: parent's scope, project: parent's project, budget: parent's remaining })` with `task.json.script` and `paths.schedule = schedules/<id>/` (created, rw for the run: F4 adds it to the profile). The first message (built by the Worker, F5): the row's `text`, the latest `summary.md` of an earlier run of the row (kept in `schedules/<id>/last-summary.md` by the dispatcher at run exit), and the script output, wrapped as non-owner text. Runtime: where an unattended task of that scope runs (never in place: a chat parent's runs run as unattended host tasks in `out/work`). The run's usage is added to the parent's `usage` at exit; the parent over budget → rows stop firing and `budget_exceeded` goes to the Planner for the parent (step 4; before: the parent is marked). A run with an empty `result` is closed at once and its log is not kept (deleted with the directory; no `logs` entry).

### Worker side (F5 feature `schedule`)

Tools `schedule(text, { at | every | cron }, tz?, script?)` → `id`, `unschedule(id)`. The prompt explains one-shot vs run, `/schedule` persistence, and the 5-minute minimum. `tz` from `task.json` for "tomorrow 9:00" arithmetic.

### Console › Schedules page

Rows by task: text, kind (`at` / `every 15m` / `cron … tz`), next fire, last run, expires; "unschedule". `hortus schedules` prints the same table.

## Functional tests

- v6 done-when: a Worker (fake provider scripting the tool calls) schedules `at = now + 2 min` and calls `done()`; the task is `waiting`; at the tick the inbox gets `schedule:<id>` and the task starts again with its context (the fake sees the earlier messages); the row is gone.
- An hourly row with a script printing nothing: the tick starts a run, the run's Worker exits before any model call, the run is deleted, no `logs` entry, `last_run` updated; the script then prints `found 1`: a run with a fresh session whose first message has the text, the output, and (after a second firing) the previous run's summary.
- Minimum interval: `every: 60` → refused; `cron "* * * * *"` → refused; `cron "*/5 * * * *"` → accepted.
- DST: `cron "30 2 * * *"` in `America/New_York` on the spring-forward day fires next on the following day; the fall-back day fires once.
- Expiry: a row whose task's last non-schedule inbox message is 8 days old is deleted at the tick; an owner reply extends it (the row's `expires_at` moves); `cron` rows survive.
- Overlap: an `every: 300` row whose run takes 10 minutes skips one firing (logged) and the next starts after the run ends.
- Budget: the parent with 100 tokens left and a run using 150 → the parent's usage exceeds, the next firing is skipped and `budget_exceeded` is recorded for the parent.
- Scope: a run on a project runs unattended on the host even when the parent is a chat task; its `paths.schedule` is writable and survives across runs (a file written by run 1 is read by run 2); `work/` does not survive.
- `unschedule` from a run acts on the parent's row; a worker calling `unschedule` on another task's row → `forbidden`.
- Recovery: a `running` run killed before its first model call is closed `failed` at restart and not re-fired; one killed after resumes.
- `PAUSED` stops ticks; un-pausing fires overdue rows once each (not once per missed interval: `every` advances past now).
- Missed while hortusd was down: a daily `cron` in `America/New_York` missed for 3 days across the fall-back fires once at the first tick, then at 9:00 EST (v7 › Schedules › Missed firings).

## UI/UX verification

- The Schedules page shows a human next-fire ("in 12 min", with the absolute time in `owner.tz` on hover); runs appear on the Tasks page titled with the parent's title and the fire time; the parent's card lists its schedules.
- A refused `schedule()` returns a one-line reason the Worker can act on ("minimum interval is 5 minutes").

## Extensibility verification

- A new trigger kind (e.g. "on a file change") would be a column and a case in the tick; runs and expiry are untouched.
- The script runner is F5's; a different interpreter is a `task.json` field.
