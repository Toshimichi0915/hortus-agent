# Step 3h (v6 step 9) — Browser tools, `cookie` transform, `browser_login`, login view

Spec: v6 › Security › Browser (Chromium, tools, cookies, site transforms, approvals, origins, logins). Depends on step 3 and F3; the login view needs the console. Parallel with 3b–3g.

## Implementation

### CDP client (`src/browser/cdp.ts`)

`launch({ userDataDir, port })` spawns `chromium --headless=new --remote-debugging-port=<port> --user-data-dir=<dir> --no-first-run --no-default-browser-check --disable-gpu --window-size=1280,900` (in the Worker's cgroup and Landlock domain on the host: the profile builder grants `out/work/chrome` rw and the Chromium binary's needs are under `/usr`; in the VM, as is). `connect()` reads `http://127.0.0.1:<port>/json/version` → `webSocketDebuggerUrl` → Node's `WebSocket`; `send(method, params, sessionId?)` with ids, `on(event)`; `Target.attachToTarget` with `flatten: true` for the page. Used by both the Worker's tools and hortusd's login view.

### Worker tools (F5 feature `browser`)

| Tool | Does |
| --- | --- |
| `browser_navigate(url)` | `Page.navigate`, waits for `Page.loadEventFired` (10 s) → title, final URL, a 403 page from the proxy is reported as "host not in origins" |
| `browser_click(selector)` / `browser_type(selector, text)` | `DOM.querySelector` + `DOM.getBoxModel` → `Input.dispatchMouseEvent`; `Input.insertText` |
| `browser_screenshot()` | `Page.captureScreenshot` → `Image` (PNG) |
| `browser_eval(js)` | `Runtime.evaluate` with `returnByValue`, 5 s timeout |
| `browser_tree()` | `Accessibility.getFullAXTree` reduced to role/name/value lines, 20 KB cap |
| `browser_console()` | the last 50 `Runtime.consoleAPICalled` / `Log.entryAdded` entries |
| `browser_login(url, why)` | RPC `browser.login` → pauses: the tool returns "waiting for the owner" and the next inbox `cookies` message resumes |

Cookies: at start the plugin injects `task.json.cookies` (placeholder values) with `Network.setCookie`; each inbox `{ from: "cookies", data: [cookies] }` injects again. Screenshots are dropped from the session at the next handoff (the handoff rewrites the context anyway).

### `cookie` transform and captures

- `transforms/cookie/`: no credential names of its own; `request()` maps `Cookie` header values `hortus-secret-c-<id>` to `{secret:c-<id>}` and `Authorization: Bearer hortus-secret-c-<id>` the same; `response()` returns `capture` for every `Set-Cookie` (`name`, `value`, `origin` = the registrable domain of the request host, `kind: "cookie"`, `cookieName`, `Domain`/`Path`/`Expires` kept as metadata) and the body's bearer tokens when a site transform says where.
- `captured` rows: `name` = `c-<id>`, placeholder `hortus-secret-c-<id>`. The response to the client carries `Set-Cookie` with the placeholder value so the browser's jar is placeholder-only; the proxy matches `Domain`/`Path` by letting the browser do it (stateless, v6).
- Runtime rules (03): a captured secret rides only to its `origin` (registrable domain; the public suffix list is not shipped: v7 uses "the last two labels, three when the second is one of `co, com, net, org, gov, ac, edu`" — a ponytail rule noted in code); category `origin:<domain>`, always `human`; a `grant` on the origin passes non-consequential requests; consequential = every method but GET/HEAD without a site manifest; site manifests (`transforms/<site>/`, `captures` and `consequential` lists) refine it.
- `scope.credentials` does not apply to captured names; the task's jar is "every captured cookie of origins the task holds a grant on" (`approvals` grant rows with `task_id` = task, category `origin:*`).

### Login view (`src/browser/login-view.ts`)

RPC `browser.login({ url, why })` (role worker): if `captured` has cookies for the origin → a `grant` entry (`origin:<domain>`, task-scoped) with summary `{ url, why, cookies: n }`; approval → the placeholders to the task's jar (`task.json.cookies` rebuilt at next start) and inbox `cookies`. Else a `login` entry with summary `{ url, why }` and a view:

- When the owner opens the entry, `hortusd` launches its own Chromium (`launch` above) in a cgroup `tasks/<task>-login` with a session address and nft rules like a host session's, `links.register(address, "login", task)`, user data dir `tasks/<id>/out/login-chrome` (deleted after). The page streams `Page.startScreencast` (JPEG, quality 60, every frame) over SSE as base64 to a `<canvas>`; mouse and key events from the canvas go back as `POST /api/login.input` → `Input.dispatchMouseEvent` / `dispatchKeyEvent` (scaled to the page size).
- The view's traffic goes through the pipeline with role `login`: captures land in `captured` as above; the cookie placeholders are what the view's browser holds too.
- "Done" → closes the view, approves the entry, grants `origin:<domain>` to the task, sends `cookies`; "Reject" → closes, rejects, inbox decision; 15 min idle → closed, entry stays pending (reopen restarts Chromium, v6 Recovery).
- Form logins: a plain `<form>` with a password field: the Worker types `hortus-secret-<name>` and a site manifest with `form:password` swaps it (03 locations). Documented in the prompt.

### Project `origins`

Already enforced by the pipeline (F3); this step adds the Projects page field and the `send`-and-continue behaviour in the prompt ("a 403 origins page is final; tell the owner with `send`").

## Functional tests

- CDP: `launch` + `navigate` to a local fake site through the proxy (the host session's DNS points at the proxy, the CA is in Chromium's NSS db / `--ignore-certificate-errors` is not used); `screenshot` returns a PNG; `eval("1+1")` → 2; `tree` lists a button's name; `console` captures `console.log`.
- Cookies: the fake site sets `session=secret123`; the task's next request to it carries `Cookie: session=hortus-secret-c-1` from the browser and the fake sees `secret123`; a request to another origin with that placeholder → 403 destination; `GET` passes on the grant, `POST` asks per request; a site manifest marking `GET /logout` consequential makes that GET ask.
- v6 done-when: a Worker calls `browser_login` for the fake site (a JS-hashed password form); the entry shows the view; the test drives the canvas endpoints (`login.input` with typed keys) to submit the form; "Done" → the Worker's inbox has `cookies`, its next navigation is logged in; the task is stopped and started again (new process) and is still logged in (the jar in `task.json`).
- Idle: a view with no input for 15 min closes; reopening the entry starts a new Chromium and the page streams again.
- Recovery: a daemon restart with a `login` entry pending keeps the entry; opening it works.
- Origins: `origins: ["fake.test"]` → `browser_navigate("https://other.test")` reports "host not in origins" without an approval entry.
- Landlock: on the host, Chromium runs inside the Worker's domain (it cannot read `~/.ssh`), and its profile dir is under `out/work`.
- Scrubbing: a page that echoes a cookie into its HTML shows the placeholder in `browser_eval(document.cookie)` and in screenshots' text (the page received the placeholder).
- The registrable-domain rule: `app.example.co.uk` and `api.example.co.uk` share an origin; `example.com` and `example.org` do not.

## UI/UX verification

- A login entry shows the URL, the Worker's `why`, and a live view at the page's aspect ratio; typing and clicking feel immediate (< 100 ms round trip on loopback); "Done" and "Reject" are outside the canvas; an idle timer is visible.
- A grant entry for a known origin says "reuse the stored login for `example.com` in task <id>".
- Credentials page lists captured origins (count of cookies, last use) with "forget" (deletes the rows; placeholders in old jars then 403).

## Extensibility verification

- A site transform is a transforms-DOF submission (3f) with `captures`/`consequential`/`form:password`; no code.
- Another browser (a real display, a remote CDP) is `launch()`'s command; the tools and the view speak CDP only.
