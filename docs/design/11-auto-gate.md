# Step 3e (v6 step 7) — Gate `auto`, `grant` records, `scope.credentials`, judge

Spec: v6 › Approval Gate (`auto`, records, judge), Secret Vault › Runtime-enforced (task scope), Config (`policy`, `judge_notes`). Depends on step 3 (F3's gate, the console). Parallel with 3b–3d, 3f–3h.

## Implementation

### Records

`approvals.kind = "grant"`: `category`, `task_id` (null = durable, set = that task only), `status approved`. Created by: the owner (an approve on a `grant`-kind pending entry), the first use of a credential under `auto` (a pending `grant` entry, `human`-style decision), a transform approval (3f: the new names are granted to the requesting task), a login (3h: `origin:<domain>` granted to the task).

### `gate.check` under `auto`

```
policy = policyFor(category)                      // forced human: transforms, merge, login, origin:*
if role core → pass
if request carries a consequential pattern → per-request entry (pending → 403), decided by the owner only
if policy human → as F3
if policy auto:
  grant exists (durable or for this task)? no → pending grant entry (403 {approval}); the owner approves once, durable unless the entry was task-scoped
  yes, and the task is tainted (db.ts › taintOf: an untrusted author's event routed to it, a Planner batch, a
    recorded tasks.taint reason, or a readable DOF holding an untrusted author's file, `channel.md` excepted: v7 › Review rounds 7, 9)? → no
    judge call (v7 › rounds 5 and 6):
      a task grant on the category approved on an entry that showed the taint (payload.untrusted)? → pass (round 7)
      else → pending request entry; "Approve, and allow <name> for this task" also records that task grant
  yes → judge(summary) → allow: pass (a `request` row with status "allowed", decided_by "judge", prompt_hash) | escalate: pending request entry (403)
```

Taint (v7 › Review round 6) is recorded in `tasks.taint` (a JSON array, at most 5 reasons, never cleared) by what hortusd observes: an HTML response to a Worker (`read a web page: <host>`, proxy/pipeline.ts › respond; the browser's loads included), a `dof.search` hit whose author the DOF's trust rule does not trust or a tainted task's session log (`searched the mirror: slack:U999 (untrusted)`, mirror/index.ts), a Planner `task_create` / `task_message` from a batch with untrusted events (planner/tools.ts). Every pending entry of a tainted task carries `payload.untrusted` (the reasons): the Approvals page shows "tainted: <reasons>. Make sure the request is what you asked for…" above the request, the task card a "Tainted" row, and the owner.notify DM ends with "; tainted: <reasons>". Not tracked: file reads of `dof/` inside the sandbox, JSON/plain-text/API responses.

Task scope: a handle whose credential name is not in `task.scope.credentials` → a task-scoped `grant` entry (`task_id = task`), whatever the policy; approval adds the name to the task's `scope.credentials` (row updated; the running Worker learns it from the inbox decision and retries). Chat tasks start with every configured name.

### Judge (`src/vault/judge.ts`)

One call to the Planner's provider and model through `coreFetch` (role core, so the LLM credential is inserted by the pipeline), `response_format: json_object`, `temperature 0`, 20 s timeout; failure or malformed output → escalate (never allow on error). Prompt: a fixed system text (role: "decide whether this already-authorized request is routine or dangerous; dangerous = destructive, irreversible, touching production or `main`, exfiltrating, outside the task's brief"; output `{"verdict":"allow"|"escalate","reason"}`), then `judge_notes[category]` and `judge_notes["*"]` under an "owner notes" heading (appended, never replacing), then the request summary (method, host, path, headers with handles, body preview) and the task's title and brief. `prompt_hash = sha256(full prompt)` stored on the decision. The judge sees placeholders only (the summary is scrubbed).

Rate: the judge's tokens count against `planner.daily_tokens`; over the cap → escalate.

### Console

Approvals page: `grant` entries say "allow `<name>` for task `<id>`" or "enable `<name>`"; judge decisions appear in the decided list as "allowed by judge: <reason>" with a "revoke and escalate next time" link that inserts a `judge_notes` line? No: notes are edited in Settings only (v6); the link opens Settings at the notes. Credentials page shows "enabled" (durable grant) per name.

## Functional tests

- v6 done-when: under `policy["credential:slack"] = "auto"` a Worker's first `chat.postMessage` gets a pending `grant`; after one click, the second and every later post passes with no click (judge allow, `request` rows with `decided_by = judge`); `chat.delete` (consequential) still asks; a request with `hortus-secret-github` from a task whose scope lacks it asks for a task-scoped grant, and after approval passes while another task still asks.
- The judge cannot allow: a consequential request never reaches it (asserted: no judge call); `merge`/`transforms`/`login`/`origin:*` entries never reach it; a judge returning `allow` for a consequential pattern (mocked) still produces a pending entry.
- Judge failures: a timeout, a 500, a non-JSON body, `{"verdict":"yes"}` → escalate, logged; the Worker sees a normal `403 {approval}`.
- `judge_notes`: with `"credential:github": "anything touching main is dangerous"` a mocked judge receives the notes after the fixed prompt (the prompt text is asserted to start with the fixed prefix and end with the summary); `prompt_hash` on the decision equals the hash of what was sent; changing the notes changes the hash on the next decision.
- Durable vs task grant: a durable grant covers a new task; a task grant does not; closing the task leaves the grant row (harmless, task gone).
- `daily_tokens` exhausted → escalate without a call.
- Policy edits in Settings apply to the next request without a restart.
- Chat tasks: every configured name is in scope at creation; a credential added later (Credentials page) is in scope for new chats only, and an existing chat gets a task grant prompt on first use.

Live (opt-in, DeepSeek as judge): a `GET /api/conversations.history` is allowed; a `POST /api/chat.postMessage` to a channel named in the brief is allowed; a `POST /api/chat.postMessage` with "DROP TABLE" in a brief about reading messages is escalated (soft assertion: logged, not failed, since the model's judgement is not deterministic).

## UI/UX verification

- A grant entry is distinguishable at a glance ("enable slack" vs a request); the decided list shows judge allows compactly (one line each) so they do not bury owner decisions; a filter hides judge allows.
- The reason text from the judge is shown verbatim but capped at 200 chars.

## Extensibility verification

- A new category only needs a `policy` key; it defaults to `human` and the forced-human list is one array.
- Another judge backend (a local model) is the provider name in `planner`; the prompt and parsing do not change.
