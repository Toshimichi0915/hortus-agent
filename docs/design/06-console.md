# F6 + console pages — web UI, `hortus` CLI, RPC methods

Spec: v6 › Console (pages, writes, decisions, task card), Chat (transport). F6 is the shell (server, guards, SSE, CLI over the socket); the pages are added by the step that gives them data (2: Approvals, Credentials; 3: Tasks, Chat, Projects, Settings, Search; 3c: Schedules; 6: Sources; 3d: Remote).

## Implementation

### `src/console/server.ts`

`http.createServer` on `127.0.0.1:7700` (port from `HORTUS_CONSOLE_PORT` for tests). Guards on every request, before routing:

- `Host` ∈ {`127.0.0.1:7700`, `localhost:7700`, `console.host`} else `421`.
- `Sec-Fetch-Site` absent, `same-origin` or `none` else `403`; `POST` additionally requires `X-Hortus: 1` and `Content-Type: application/json` else `403`.
- `GET` pages set `Content-Security-Policy: default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self' 'unsafe-inline'`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`.

Routes: pages (`GET`), `POST /api/<method>` → `rpc.call(method, body, { role: "owner" })` → `{ result }` or `{ error }` with status 400/403/404/500 by code, `GET /events/<name>?…` SSE (`text/event-stream`, 15 s keepalive comments, `Last-Event-ID` honoured where backed by a table), `GET /static/app.js|app.css` from `src/console/static/` (copied to `dist/`). Unknown → 404 page. Request bodies capped at 1 MB. Errors never include stacks.

### Pages (`src/console/pages/*.ts`)

Each is `(ctx, params) => string` using a shared `layout(title, body, nav)` and `h()` (HTML escape, applied to every interpolated value by default; `raw()` opts out). No framework, no client-side templating: `app.js` has `post(method, input)` (fetch with the headers, `alert`-free: errors land in a `<output>` line), `sse(name, handler)`, and small per-page behaviours keyed by `data-page`. CSS: system font stack, `prefers-color-scheme`, a 72 ch column, tables, `<details>` for long previews.

| Page | Route | Shows | Does (RPC) |
| --- | --- | --- | --- |
| Tasks | `/` | open tasks first (status, title, project, kind, budget used `tokens/limit`, hours, updated), then closed from `logs` (title, status, exit time); 50 of each, newest first, `?skip=N` for older (every capped list says `showing 1–50 of N … · older`) | open chat (`task.open`), `task.message`, `task.stop`, `task.budget`, `task.close`; link to `/tasks/:id` |
| Task | `/tasks/:id` | the card: row fields, replies (`replies` table), latest `summary.md`, pending approvals of the task under "Waiting for you" (its own and a durable grant entry it opened or met), messages and inbox (newest 50 each, `?skip=N`), link to `session.md` (`/tasks/:id/log`, plain text) | the same actions |
| Chat | `/chat`, `/chat/:id` | the stream (SSE `chat` from `replies` rows, so a reconnecting page sees the last 1000 lines), a textarea, the task's pending approvals inline, project picker (sets `cwd`) | `task.open` (first message), `task.send`, approve/reject |
| Approvals | `/approvals`, `/approvals/:id` | pending first, then decided (50 of each, `?skip=N`); each: id, category, task, requested, summary (03-vault-proxy.md); merge entries (3b): stat, patch excerpt (40 lines, ≤ 8 KB), the full diff in `<details>` on `/approvals/:id` only (lists link it); transform entries (3f): manifest diff and credential fields; login entries (3h): the view; a tainted task's non-consequential `auto` request: also "Approve, and allow `<name>` for this task" (11-auto-gate.md) | `approval.decide` (a stale page's "already decided" re-renders it) |
| Credentials | `/credentials` | name, type, transform, hosts, last use | `credential.set` (type-specific fields, value fields `type=password`, never prefilled), `credential.delete` |
| Projects | `/projects` | name, path, main, runtime, exclude, origins, shadow snapshots (3b) | `project.set`, `project.delete`, `project.sync` (force), `project.restore` |
| Settings | `/settings` | the rest of `hortusd.json` as a JSON editor (`<textarea>`, validated server-side, errors shown with the zod path), `policy` and `judge_notes` as a table (category → select, notes), `PAUSED` toggle, enrolment code and sessions (3d), `dev` keys under a "development" heading | `settings.set`, `pause.set`, `enroll.code`, `session.revoke` |
| Sources | `/sources` | per connector: connected, last event, last sync per scope, mirror size (`du` of the worktree, cached 1 min), error | `source.resync` |
| Search | `/search?q=` | `dof search` results with the filters as form fields | `dof.search` |
| Schedules | `/schedules` | rows by task, next fire, last run's summary | `schedule.unset` |

Changes propagate by SSE `events` (approvals, tasks): the page re-fetches its own route's JSON (`GET /api/page/<name>` returns the data the page was rendered from) and re-renders the affected list with a small DOM diff — or, simpler and acceptable: reloads the page body via `fetch` and `innerHTML` when the stream says its page changed, keeping the scroll position and the textarea contents. The chat stream is append-only.

### `src/console/cli.ts` → `bin/hortus.ts`

Line-oriented client of the abstract socket (`rpc.serveSocket` frames). Commands:

```
hortus ping
hortus tasks [--all | <id>]                 # table (newest 50 open and closed; --all every one) / card with replies and summary
hortus chat [-r <id>] [<text>…]             # REPL: prints the stream (text live, tool calls as one line each), reads lines; Ctrl-D closes (task → waiting)
hortus approvals [--all | approve [--grant]|reject <id>]  # pending first (newest 50 of each; --all every one); --grant: "Approve, and allow … for this task"
hortus stop <id> | close <id> [failed]
hortus search <query> [--in …] (alias of dof search)
hortus sync --force <project>               # 3b
hortus schedules                            # 3c
hortus pause | resume
hortus install [--ca] [--force]
```

The chat REPL subscribes to the stream with the RPC `task.stream` (a long-lived socket frame sequence: the socket transport allows a method to push `{ id, event }` frames until `{ id, done }`); the web UI uses SSE for the same rows.

### RPC methods (role `owner` unless noted)

`ping`; `dof.search` (owner, worker, planner); `task.list({ limit?, skip? })`, `task.get`, `task.open({ text, cwd? })`, `task.send({ id, text })`, `task.message({ id, text })`, `task.stop`, `task.close({ id, outcome })`, `task.budget({ id, tokens?, hours? })`, `task.log`, `task.stream` (socket only); `approval.list({ status?, limit?, skip? })`, `approval.count({ status? })` (the nav badge), `approval.get`, `approval.decide({ id, decision, credentials?, reason?, grant? })`; `credential.list`, `credential.set`, `credential.delete`; `project.set`, `project.delete`, `project.sync`, `project.restore`; `settings.get`, `settings.set`, `pause.set`; `source.list`, `source.resync`; `schedule.list`, `schedule.unset` (owner, worker), `schedule.set` (worker); planner tools (planner); `merge` (worker); `transforms.submit` (worker); `browser.login` (worker); `enroll.code`, `session.list`, `session.revoke` (owner, loopback).

## Functional tests

- Guards: `Host: evil.example` → 421; `Sec-Fetch-Site: cross-site` → 403; `POST` without `X-Hortus` → 403; with it and `same-origin` → 200; a `GET` from `curl` with no `Sec-Fetch-Site` → 200 (the CLI-like case); a body of 2 MB → 413.
- `POST /api/task.open` with invalid input → 400 with the zod path; an unknown method → 404; a handler error → 500 with a message and no stack.
- SSE: a client with `Last-Event-ID: 7` on `/events/chat?task=x` receives rows 8…; keepalives every 15 s; closing the response unsubscribes (no leak after 100 connect/disconnect cycles).
- Every page renders with an empty database (no `undefined` in the HTML, asserted by a crawler test over all routes), and with 500 tasks under 200 ms.
- Escaping: a task title `<script>alert(1)</script>` renders escaped on every page that shows titles; a reply containing `</textarea>` cannot break the chat form.
- CLI: `hortus ping` without a daemon prints the one-line error and exits 1; `hortus tasks` on an empty DB prints `no tasks`; `hortus chat` sends the first line as `task.open` with the shell's cwd and later lines as `task.send`; Ctrl-D exits 0 and the task is `waiting`; `hortus approvals approve 99` on a missing id prints `not found` and exits 1; `approve` on a decided one prints `already decided`.
- Settings: invalid JSON in the editor → the error names the key and nothing is written; a valid edit is written and `reload()` runs (a connector whose config changed restarts; one unchanged keeps its connection: asserted via the fake Slack's connection count).
- CSP: no inline `<script>`; `app.js` loads; a page with a CSP violation fails the crawler test (the test reads the console log of a headless Chromium, 3h's CDP helper, when available; else a regex over the HTML).

## UI/UX verification (walk through in a browser; a checklist for the reviewer)

- Navigation bar on every page: Tasks, Chat, Approvals (with a pending count badge), Credentials, Projects, Schedules, Sources, Search, Settings; the current page is marked.
- Tasks: open tasks are visually separated from closed; status is a word, not a code; budget reads `1.2M / 2.0M tokens, 0.5 / 4 h`; actions on a closed task are hidden; "Stop" asks for confirmation inline (a second click), never a dialog.
- Task card: the summary is first, replies in order with time, the pending approval has its buttons right there, `session.md` opens in a new tab as plain text.
- Chat: the stream auto-scrolls while at the bottom and stops when the owner scrolled up; Enter sends, Shift+Enter is a newline; the textarea keeps its text through a reconnect; a 403 approval during a chat shows the entry inline and its decision continues the stream without the owner leaving the page; opening `/chat` with no task shows the project picker and a hint.
- Approvals: a pending entry is readable in 5 seconds: category, where it goes, what it changes; long bodies and diffs are folded; approve and reject are not adjacent to each other's mirror actions on neighbouring rows (each row has its own pair, aligned); a decided entry shows "approved by owner at …" or "allowed by judge" with the reason.
- Credentials: values never echo; a replace clears the field after save; the type picker changes the fields shown.
- Settings: a save error is next to the editor, the editor keeps the text; the `PAUSED` toggle explains what pausing does in one line.
- Everything works without JavaScript for reading (pages are server-rendered); actions need `app.js`.
- Keyboard: every action is a `<button>` or `<a>`, focus order follows reading order, `Esc` clears an `<output>` message.
- Dark and light schemes both pass a contrast check on text and the status colours.

## Extensibility verification

- A new page is one file under `pages/` plus a route line and a nav entry; the layout, guards and `post()` are shared.
- A new action is a `define()` in its module; the page calls `post("<method>", …)`; no server route is added.
- Approval summaries render through `summaryView(kind, summary)` with one case per kind; 3b/3f/3h add cases.
- The CLI's command table mirrors RPC methods one to one, so a plugin-shaped addition is one row.
