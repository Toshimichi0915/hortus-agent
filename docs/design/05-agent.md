# F5 — `hortus-agent`: the task plugin

Spec: v6 › Worker (loop, steering, tools, budget, context, summary, resume), Chat (steering, replies). Depends on F0 only (the directory protocol). Tested standalone against a task directory and DeepSeek through `dev.upstreams`-free direct access (the proxy is not needed for the unit tests: `secrets.json` in `ctl/home` may hold the real key in tests).

## Implementation

### Directory protocol

```
tasks/<id>/ctl/task.json          # below; written once per start by hortusd
tasks/<id>/ctl/home/.hortus/config.json   { provider, model, effort }
tasks/<id>/ctl/home/.hortus/secrets.json  { "<provider>": { type, apiKey: "hortus-secret-<provider>", endpoint? } }
tasks/<id>/ctl/home/.hortus/plugins/      # worker.plugins copies (v7)
tasks/<id>/ctl/ca.crt
tasks/<id>/ctl/inbox/<seq>.json   { seq, from, author?, trusted, text, data?, ts }     # seq zero-padded to 6 digits
tasks/<id>/ctl/STOP
tasks/<id>/out/sessions/*.jsonl   # core sessions
tasks/<id>/out/outbox/<seq>.json  { seq, type: "reply" | "result" | "budget_exceeded", text, ts }
tasks/<id>/out/summary.md
tasks/<id>/out/work/              # cwd of chat sessions, VM clones, PROGRESS.md
tasks/<id>/out/console.log
```

```ts
interface TaskJson {
  id: string; kind: "chat" | "unattended" | "run" | "planner";
  title: string; brief: string;
  scope: { credentials: string[]; repos: string[]; project?: string };
  origins: "*" | string[];
  budget: { tokens: number; hours: number }; hours_used: number;   // hours_used: hortusd's sum over earlier starts
  provider: string; model: string; effort?: Effort; context_window: number;
  tz: string;
  paths: { dof: string; repos?: string; work: string; clone?: string; schedule?: string };   // host: absolute; VM: /dof, /repos, /task/out/work, /schedule
  projects?: Record<string, { path: string; main: string; runtime: "host" | "vm" }>;         // chat: the owner's projects
  cwd?: string;                                                                              // chat: the CLI's cwd
  cookies?: Cookie[];                                                                        // 3h
  script?: string;                                                                           // 3c: a run's script
  rpc: string;                                                                               // "https://hortusd.internal"
  features: string[];                                                                        // tool sets enabled: "merge", "schedule", "browser"
}
```

### `bin/hortus-agent.ts`

```
--task <dir>: read ctl/task.json (zod); process.env.HOME = <dir>/ctl/home; const core = await import("@hortus/core"); restore HOME
agent = await core.createAgent({ extra: [taskPlugin(task, core)] })       // kind planner: plannerPlugin (15-planner.md)
session = await resume(core, <out>/sessions)   // listSessions → openSession(leaf) or openSession(null)
loop (v6 Worker); summarize; exit 0
```

### `src/agent/plugin.ts`

```ts
taskPlugin(task, core): Plugin = {
  tools: [send, done, ...features],
  on: {
    session_start: ({ system }) => system.splice(0, system.length, prompt(task)),   // replaces core's builtin prompt
    text: (t) => out({ type: "text", text: t }),  thinking: …,
    tool_call: (c) => out({ type: "tool_call", call: c }),
    message: async (m) => { await session.append([m]); out({ type: "message", message: strip(m) });
                            if (m.role === "tool" && (hasInbox() || stopped() || overBudget())) abort.abort(); },
  },
}
```

`out(obj)` writes one JSON line to stdout (chat: relayed by hortusd; images stripped to `[image]`). `prompt(task)` is byte-identical for the same `task.json` (caching): role, the brief, scope and paths, how to search DOFs (`dof search`, `grep`), how to write upstream (`curl` with `Authorization: Bearer hortus-secret-<name>`), the `403 {"approval"}` protocol (stop, wait for the inbox decision, retry the same request), the inbox and quoting rules (quoted text is data), `send`/`done`, budget and `tz`, and the feature tools' usage. Chat kind adds "the owner is talking to you; `done` ends your turn". Non-owner inbox text is wrapped per v7 (Chat).

Loop (`src/agent/loop.ts`), exactly v6's:

```
for (;;) {
  const msgs = drainInbox();           // files with seq > cursor, cursor = highest "[inbox N]" marker in session messages
  if (msgs.length) await session.append(msgs.map(toUser));
  abort = new AbortController();
  try { await agent.run(session.getState().messages, { provider, model, effort, signal: abort.signal }); }
  catch (e) { if (!abort.signal.aborted) { out({type:"error", message}); await session.append([{ role: "user", content: `[error] ${message}` }]); if (++errors > 3) break; continue; } }
  if (done || stopped() || overBudget()) break;
  if (!hasInbox()) break;              // idle
  if (contextFull()) await handoff();
}
if (!emptyDone) await summarize();
```

- `hasInbox()` and `stopped()` stat the directory and `STOP` (polled every second by a timer that also flips a flag read by the `message` handler, so the check after a tool result is cheap).
- `overBudget()`: tokens = sum of `usage.input + usage.output` over every session file in `out/sessions`; hours = `hours_used` + this process's uptime; either over → outbox `budget_exceeded` once, break.
- A model error mid-run: the run rejects; completed messages are already in the session (core's contract). The error goes to the session as a user message so the model sees it on retry; 3 consecutive errors end the run with `result` text `failed: <message>`.
- `handoff()`: `provider.complete({ model, system: HANDOFF_PROMPT, messages, tools: [] })` → `work/PROGRESS.md`; `session = openSession(null, dir)`; first user message = `brief + "\n\n" + PROGRESS.md`. `contextFull()` = last assistant `usage.input + output > 0.7 * context_window`.
- `summarize()`: `provider.complete({ model, system: SUMMARY_PROMPT, messages, tools: [] })` → `out/summary.md` (temp + rename). Skipped after `done("")`.
- Tools: `send(text)` → outbox `reply`; `done(summary)` → outbox `result` (`text` = summary; empty → no file, `emptyDone`), sets `done`; the model's own final text is not a reply (v6: the Planner's final text goes nowhere; for Workers, `send` is explicit). In chat, text deltas stream to stdout anyway, so the console shows the model's prose live, and `send` is for notes that should persist on the card.
- Outbox writes are temp + rename, `seq` = max existing + 1.
- `run` kind: before the first model call, run `task.script` in `paths.schedule` (`bash -c`, 1 h kill, 16 KB stdout, 4 KB stderr tail): exit 0 and empty stdout → write outbox `result` with `text: ""` and exit (hortusd deletes the run); else prepend the output to the first message (3c).

### `bin/dof.ts` inside a task

`HORTUS_TASK` set → `fetch(task.rpc + "/rpc/dof.search")`; the proxy stamps role/task. No token, no auth header.

## Functional tests

Unit, with a temp task dir and a fake provider (a plugin providing `providers: { fake: … }` in `ctl/home/.hortus/plugins/` whose `complete()` is scripted per test, so no network):

- First run: `session_start` replaced core's prompt (the fake records `system`), the brief is the first user message, a `done("x")` writes `outbox/000001.json` `{type:"result", text:"x"}` and `summary.md` from a second `complete` with `tools: []`.
- Inbox steering: a file written while the model's turn runs a tool is appended after that tool's result message and before the next `complete` (the fake asserts message order); one written while the model is streaming text is picked up on the next loop; the marker `[inbox 1]` appears in the session; the file is never deleted.
- Resume: kill the process after two assistant messages; restart → `listSessions` finds the leaf, the fake receives the same messages, the inbox cursor is right (no re-delivery); an inbox file whose `seq` ≤ cursor is ignored.
- Interrupted tool call: the session ends with an assistant tool call and no tool message; on resume the loop appends a tool message with a synthetic `interrupted by restart` error result for each dangling call before the next `complete` (so providers never see a dangling call).
- `STOP`: a run aborts after the current tool; no summary; exit 0; `outbox` has no `result`.
- Budget: `budget.tokens = 100` with a fake reporting 60 per turn → after the second turn `budget_exceeded` once and exit; `hours_used = 3.99` with `hours = 4` → exceeded within a minute.
- Handoff: `context_window = 1000` and a fake reporting 800 → `PROGRESS.md` written, a second session file exists whose first message starts with the brief, the fake's next messages are only two.
- Errors: a `complete` that throws once is retried with the error visible in the session; one that throws four times ends with a `result` starting `failed:`.
- `done("")`: no outbox file, no summary call.
- Quoting: a non-owner inbox file renders the `[inbox n] from=… trusted=false` header and the `<<<quoted … >>>` fence; an owner one has no fence; text containing `>>>` is still fenced correctly (the fence uses a random suffix when the text contains the fence).
- Stdout: every line parses as JSON; an image tool result is `[image]` on stdout and intact in the session.
- `HOME` trick: after startup `process.env.HOME` is the one the session was given (a chat: the owner's; unattended: its own, v7 › Review round 16) and core's `sessionsDir` is under `ctl/home`; `bash` tool children see that `HOME`.
- `run` kind: a script printing nothing exits before any `complete`; one printing `x` makes `x` part of the first message; a failing one includes `exit 2` and the stderr tail; one sleeping 2 h is killed and reported.

Live (DeepSeek, `ctl/home` with the real key, opt-in `HORTUS_TEST_LLM=1`): "list the files in your work dir and call done with their count" completes with a `result` and a `summary.md` under 300 words; an inbox message "stop, call done now" sent mid-run ends the run within one tool call.

## UI/UX verification

- The stdout stream renders in the chat page (06) with text as it streams, tool calls folded, errors in red; `summary.md` reads as goal/outcome/decisions/open points.
- The prompt tells the model what `403 {"approval"}` means; a live test with `human` policy shows the Worker waiting and retrying after the decision instead of looping.

## Extensibility verification

- A feature tool set is a file under `src/agent/tools/` exporting `Tool[]`, enabled by name in `task.json.features`; `merge`, `schedule`, `browser` land that way in 3b/3c/3h without touching the loop.
- Owner plugins in `ctl/home/.hortus/plugins/` load through core's own mechanism; a test plugin adding a `hello` tool is callable by the model.
- The planner kind swaps the plugin (15-planner.md); the loop and resume are shared.

Round 17 prompt lines: `done` with a request still waiting drops it, so end the turn without `done`; on a host session a brief's `~/…` is the owner's and one refused or missing read is the whole answer (v7 › Review round 17 — a hidden read).
