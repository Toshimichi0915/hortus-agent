# Step 4 — Planner

Spec: v6 › Planner, Gateway (wake), Config (`owner.notify`, `planner`). Depends on step 3 (and 3e for click-free replies, 3g for `runtime: vm`). 4b runs beside it.

## Implementation

### Wake and batch (`src/planner/planner.ts`)

- `wake()` is called by the gateway (`mirror.wake && !bot`), by the dispatcher on a non-chat `result` / `budget_exceeded` or a failure hortusd recorded (`tasks.hooks.failed`), and after recovery. Debounced 2 s; one batch at a time; `PAUSED` → skip; `planner_usage[today] ≥ daily_tokens` → skip and log once an hour.
- A batch: `SELECT … FROM events WHERE consumed = 0 ORDER BY id LIMIT batch_max` (the gateway holds an event at -2 until `mirror()` says if it wakes) plus unconsumed outbox rows (`result`, `budget_exceeded`) of non-chat tasks; nothing → return. With only trusted events waiting, results of tainted tasks wait for the next batch, of their own (events wait for that one; a stranger's event taints the batch anyway, so they ride along, round 9): a tainted result taints every task its batch creates (v7 › Review round 8). Mark them `consumed = 1` with the batch id before the run (a crashed batch is not re-run: the events stay routed as "consumed" and the next event brings the open cards again; v6: no persistent context, the Planner can `dof search` anything it missed. Trade-off noted in the prompt: "events in earlier batches may have been lost; cards are authoritative").
- Input (one user message): the fixed system prompt (byte-identical: role, the three verdicts, the tools, the rules: untrusted never starts a task, bot events never appear, closed tasks are in `logs`, reply routing by refs), then:

```
## Events
- [e123] slack:C0123:1730000000.123456 (trusted, matches task t_abc) message by U0123 (alice) at …
  <<<quoted …>>>
## Results
- [t_abc] result: <summary.md excerpt>
## Open tasks
- t_abc "Fix crash" (running, host, project foo, 1.2M tokens, refs: slack:C0123:…) — summary "<latest summary 300 chars, one line, a JSON string>"
- t_def "Report" (waiting, vm, 3k tokens) — failed, only the owner starts it again: "<the card's error line, a JSON string>"
```

Non-owner text quoted (v7 Chat format); the owner's own text is not quoted but still labelled.

- Run: `tasks/planner-<n>/` with `task.json.kind = "planner"`, `features: []`, the batch as `brief`; started by the dispatcher on `planner.runtime` (host: unattended profile, role `planner` on its session address; vm: 3g). The directory is deleted after the run; the final text is discarded. Usage from the outbox-less run: the dispatcher reads the session files' `usage` before deleting and adds to `planner_usage`.

### Planner plugin (`src/agent/planner-plugin.ts`, F5's binary)

Tools (RPC through `hortusd.internal`, role `planner` stamped by the proxy): `task_create(title, brief, event_keys, scope)`, `task_attach(task_id, event_ids)`, `event_ignore(event_ids, reason)`, `task_message(task_id, text)`, `task_close(task_id, outcome)`; plus read-only `bash` (for `grep` on `/dof` and `dof search`; `read`); no `edit`/`write`/`send`/`done`. The system prompt replaces core's.

### RPC handlers (`src/planner/tools.ts`)

- `task_create`: every `event_keys` event must exist and be `trusted` (else `forbidden: untrusted event <key>`); `scope.repos` ⊆ known forge projects; `scope.credentials` ⊆ configured names (default `worker.credentials`, or all but `*-app` Slack tokens and webhook secrets); `scope.dofs` ⊆ the DOF names (else `invalid: unknown DOF`), default `[]` (the brief carries the events; `transforms` is always readable), the DOFs the Worker can read and search (v7 › Review round 7); `scope.project` ∈ `projects` and every event's author is `dofs.<dof>.owner` (else `forbidden`); `origins` derived; `runtime` from the project (`host` default) else `vm` when the image exists and `planner`… no: Workers without a project run in a VM (v6: "Everything else runs in a VM"); without an image (`images/agent.ext4` missing) hortusd refuses with `failed: no VM image; set a project or build the image` and the Planner is told (v7 note). Inserts `queued` with `task_refs` from the events' `refs`; events get `task_id`. A batch that held any untrusted event, or a result from a tainted task, taints the new task ("created from a batch with untrusted events (planner-<n>)"): the brief is the Planner's own text written beside the stranger's (v7 › Review round 6).
- `task_attach`: `inboxWrite(task, { from: "<dof>:<channel>:<thread>", author, trusted, text: event.summary + body, data: event })` (the thread's path only when its DOF is in the task's `scope.dofs`) and `task_refs` for the events' refs; `waiting` → `queued`.
- `event_ignore`: `ignored = reason`.
- `task_message`: `inboxWrite({ from: "planner", trusted: false, text })` wrapped (not owner; never `trusted=true`: the Planner reads untrusted events, v7 › round 5). From a batch `task_create` would taint, the note taints the target task ("a note from a batch with untrusted events …").
- The batch task itself is always tainted ("a Planner batch reads every event"): a credentialed request of the Planner's under `auto` goes to the owner, never the judge.
- `task_close`: `tasks.close`.
- All refuse unknown ids with `not_found` and non-planner roles with `forbidden`.

### `owner.notify`

On every new pending approval (`gate.check` inserting), `connectors[owner.notify].dm(owner, "approval <id> pending (<category>) <console url>")`; failures logged; nothing on decision. The DM is the bot's own message → mirrored (Slack, Discord; Telegram sends no update for a bot's message), never wakes (loop guard by `bot`).

A failure nobody watched (dispatcher `finish`/`start`, `runs.onExit`, a dead batch; `tasks.hooks.failed`) goes the same way through its own `coalesce`: `task <id> failed <console url>/tasks`, `N more tasks failed`. Ids and fixed words only (v7 › Review round 10).

### Routing hints

Each event in the batch is annotated with `matches task <id>` when any of its `refs` is in `task_refs`; the Planner still decides (v6 Deferred: code-only routing later).

## Functional tests

With the fake Slack, a fake provider for the Planner where determinism matters, DeepSeek live for the done-when:

- v6 done-when: the owner's DM "in project foo, add a line to README and tell me here" → one batch → `task_create` with `scope.project: foo` → a host task → the Worker edits in the clone, pushes, `merge()`, replies in the DM thread via `chat.postMessage`; the reply's `refs` route a follow-up DM to the same task (`task_attach`); the pending merge approval produced a one-line DM with the console URL.
- Untrusted: a stranger's message under `trust: "owner"` → the Planner's `task_create` is refused (fake provider forcing it) and the event is ignored; the same stranger replying in the Worker's thread → attached (refs match); the owner's "look at what bob said" → a task whose brief carries bob's text quoted.
- Loop guard: the bot's own reply produces no batch; `owner.notify` DMs produce no batch.
- Debounce and cap: 10 events within 1 s → one batch; 120 events with `batch_max 50` → three batches in sequence.
- `daily_tokens`: a cap of 1000 with a batch using 1500 → the next wake is skipped, logged once, and resumes the next day (clock mocked).
- `PAUSED` → no batch; unpause → one batch with everything pending.
- Results: a Worker's `done` on an unattended task wakes a batch with a `## Results` section; the Planner's `task_close(done)` closes it; `budget_exceeded` shows as such.
- Recovery: a Planner VM/host run killed mid-batch does not re-run the batch; the next event's batch lists the open cards.
- Planner cannot: `send`/`done`/`edit` are absent from its tools; an RPC `task_create` from a worker-role address → `forbidden`; the Planner's `bash` cannot write (unattended profile with no rw dirs but `out/`).
- `task_create` without a project and without an image → the Planner receives `failed: no VM image…` and the test asserts it then calls `event_ignore` or retries with a project (fake-scripted).
- The system prompt is byte-identical across two batches (hash asserted) and the user message changes.

## UI/UX verification

- The Tasks page shows a Planner batch as a transient row ("planner batch #12, 3 events") only while running; the Sources page shows the Planner's last batch time, events routed today, and tokens used against `daily_tokens`.
- A task created by the Planner shows its originating event (DOF, channel, author) on the card.

## Extensibility verification

- A new verdict tool is a `define()` with role `planner` and a line in the Planner prompt.
- `summary` is the only text of an event the Planner, a brief and a task's inbox get, so connectors keep up to 2,000 characters of it (v7 › Review round 17), and the gateway cuts its own log line and commit subject to 120.
- The batch format is one function (`renderBatch`); a connector's events appear through `summary`/`refs` only, so 4b and 6 add nothing here.
