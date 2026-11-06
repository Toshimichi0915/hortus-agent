# Connecting the web UI to the RPC

Build steps for moving `web/` off its mock and onto hortusd's console API. The old console stays the default until
step 8, because logins can only be finished in a web UI. Steps 1 and 2 change nothing unless `HORTUS_WEB=1` is set.
Steps 7 and 8 are the risky ones: do each as its own commit.

## Step 1: Build and serve

1. `scripts/build.sh`: run `vite build web` after `tsc -b`, and add `! -path 'dist/web/*'` to the stale-file `find`.
   Without that, the `find` deletes the bundle's JS on every build.
2. `src/console/server.ts`: behind `HORTUS_WEB=1`, serve `dist/web/assets/*` from a list of files read at start, so no
   path from the request reaches the filesystem. Any other GET returns `index.html`; `/api/*` and `/events/*` are
   unchanged.
3. `web/vite.config.ts`: proxy `/api` and `/events` to `127.0.0.1:7700`, with `changeOrigin` so the daemon's Host check
   passes.

Done when: `HORTUS_WEB=1` serves the app and `/tasks/<id>` opens on a hard reload with no CSP errors.

## Step 2: Real transport in `web/src/api.ts`

1. `call()`: POST `/api/<method>` with `Content-Type: application/json` and `X-Hortus: 1`. Turn
   `{ error: { code, message, data } }` into `ApiError`.
2. One `EventSource` per page: `streamRows` and `subscribe` must share it, using
   `/events/tasks,approvals,chat?task=<id>`. `server.ts` combines them on purpose, because each open stream holds one of
   a browser's six connections.
3. Reconnecting: resume from the last `seq` (`Last-Event-ID` is already supported) and show "Reconnecting…" in the chat.
4. Mock switch: load `mock.ts` by dynamic import behind `VITE_MOCK=1`, so it stays out of production bundles.

Done when: a read-only page shows daemon data and updates live.

## Step 3: Fill the read gaps (daemon)

Add each with a test, in `src/console/index.ts` or the module that owns it.

| RPC | Change |
| --- | --- |
| `pause.get` | New; checks `paths.paused()` |
| `task.list` | Add `pending` |
| `task.get` | Add `outbox`, `schedules`, `origin`, `tainted`, `console_log` (capped through `readCapped`) |
| `approval.list` / `approval.get` | Add `task_title` |
| `credential.list` | Add `enabled` (the durable grant) |
| `source.list` | Add `size`, `deliveries_today`, `last_delivery`, `missing`, `webhook`, moved from `pages/sources.ts` |
| `dof.file` | New; move the path and symlink checks from `pages/dof.ts` unchanged |
| `project.status`, `vm.image`, `remote.status`, `transforms.list` | New |

Also add a `settings` bus event, emitted after settings, credential and project writes, and accept it in `/events`.

## Step 4: Chat

1. `/events/chat`: send `{ seq, html, body, created }`, keeping `html` until step 8 because the old console reads it.
   Reuse the `line()` guard for rows that cannot be re-serialized.
2. `task.open` and `task.send` need no RPC changes; only the stream payload above changes.
3. Long chats: stop re-parsing the whole conversation for every streamed word. Keep finished turns memoized and rebuild
   only the last one.
4. Older rows: show the "earlier lines not shown" note with a link to the session log.

Done when: a real chat streams, stops, and survives killing the connection partway through a reply.

## Step 5: Approvals and login view

1. Connect `approval.decide`, `merge.retry` and `merge.diff`, with the credentials form for transforms.
2. Replace `FakeSite` with a `<canvas>` fed by `/events/login?id=`, drawing `frame` and handling `until`, `closed` and
   `error`.
3. Send real x and y from the canvas through `login.input`, and delete `login.frame`.

Done when: a login against `src/test/fakes/site.ts` finishes and the task receives placeholder cookies.

## Step 6: Settings, Sources, Projects, Credentials

1. Connect `settings.set`, mapping zod's `issues[].path` to fields, and show its `message` for unknown keys.
2. Add source: `settings.set`, then `credential.set`. If the second fails, say the source was added without its
   credentials.
3. Add paging to Tasks and Approvals using `limit` and `skip`; the pages load everything at once today.

## Step 7: Remote console (security review needed)

1. `gate()` in `remote.ts`: allow unauthenticated requests for `index.html` and the hashed assets only. They contain no
   data. `/api/*` and `/events/*` stay 401.
2. When `call()` gets a 401, go to `/login`.
3. Port `webauthn.js` into `SignIn` and `Enroll`. An invalid code must show the same login page it does now.
4. Keep enrolment refused over the remote listener, using `remote.status`.

Done when: `src/e2e/remote-console.test.ts` passes, and a real passkey has been tried on a phone.

## Step 8: Cut over and remove the old console

1. Make the new UI the default and remove `HORTUS_WEB`. Keep the `/tasks` and `/approvals/<id>` links used in DMs
   working.
2. Move these helpers out of the old pages first: `errorLine`, `PAUSED`, `tokens`, `parse`, `kindOf`, `relative`,
   `OPEN_SQL`, `CLOSED_SQL`, `PENDING_FOR`, `lastReplies`, `repliesAfter`.
3. Delete `src/console/pages/`, `html.ts` and `static/`. Keep `qr.ts`, which the new UI imports.
4. Drop `html` from the chat stream, and the static-file lines from `build.sh`.
5. Port the tests. A rough grep matches 21 test files, though many of those only use URLs. Keep the DoS, large-list and
   hostile-output cases, moved to the RPCs or to the rendered app.

Done when: `pnpm test` and `pnpm lint` pass, `grep -r "console/pages" src` is empty, and the `HORTUS_TEST_NET=1` suite
has been run.

## Step 9: Tidy up

Delete `mock.ts` and the gap comment in `api.ts`, and update `README.md` and `AGENTS.md`. Then import the `Config` rules
from a schema split out of `config.ts`, replacing the copy in `web/src/schema.ts`.

## Not verifiable without the owner

- Real phones and real passkeys (the repo has a software authenticator only).
- Real sites with CAPTCHAs or one-time codes in the login view.
- The `HORTUS_TEST_NET=1` suite, which needs passwordless sudo.
