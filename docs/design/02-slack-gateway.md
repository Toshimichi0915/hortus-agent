# F2 + Step 1 — `slack` connector, gateway, system unit

Spec: v6 › Gateway, Connectors › Messengers (Slack column), Mirror (messenger row), Process. F2 is the connector against a fake Slack; step 1 wires F0+F1+F2 into a running `hortusd`.

## Implementation

### Connector interface (`src/connectors/types.ts`)

v6's interface with `key` and `author` folded into the event and `history` per scope:

```ts
export interface Event {
  dof: string; key: string; ts: string;                 // key: the service's dedupe key
  payload: unknown;                                     // the service's own object, stored in events.payload
  author: { user: string; member: boolean } | null;     // null: no author, never trusted
  bot: boolean;                                         // our bot, or any bot: mirrored, never wakes the Planner
  summary: string;                                      // one line for logs and the Planner batch ("message in C0123 by alice: …")
  refs: string[];                                       // task_refs keys this event belongs to: "<dof>:<channel>:<thread>"
}
export interface Incoming { event: Event; ack(): Promise<void> }
export interface Mirrored { changes: Change[]; wake: boolean }
export interface Connector {
  events(signal: AbortSignal): AsyncIterable<Incoming>;      // reconnects itself with backoff; yields nothing while down
  mirror(e: Event): Promise<Mirrored>;                        // may call the API (channel info on membership changes)
  scopes(): Promise<string[]>;                                // channels the bot is in (+ the owner's DM); forges: projects
  history?(scope: string, cursor: string | null): AsyncIterable<{ changes: Change[]; cursor: string }>;
  dm?(owner: string, text: string): Promise<void>;
  status(): { connected: boolean; lastEvent?: string; error?: string };
}
export interface Deps {
  name: string; config: DofConfig; log: Log;
  fetch(url: string, init?: RequestInit): Promise<Response>;  // placeholder-aware: step 1 swaps from vault.json, step 2 is the pipeline
}
export type Factory = (deps: Deps) => Promise<Connector>;
// src/connectors/index.ts: export const connectors: Record<string, Factory> = { slack }
```

`Change` (F1) gains `op: "patch"`: merge `frontmatter` keys into an existing file (missing file: log, skip). Reactions and membership use it.

### `src/connectors/slack.ts`

- Start: `auth.test` (bot user id `U_BOT`, team), `users.list` cache (id → `name`, `is_bot`, `is_restricted`; refreshed hourly and on an unknown id), `conversations.open` with `config.owner` so the owner's DM channel exists.
- `events()`: `apps.connections.open` (token `hortus-secret-<name>-app`) → WebSocket (Node's global `WebSocket`) → `hello`; each `events_api` envelope yields `{ event, ack }` where `ack` sends `{ envelope_id }`; `disconnect` or close → reconnect with backoff 1 s → 60 s; `slash_commands`/`interactive` envelopes are acked and dropped. `key` = `payload.event_id`; `ts` = the event's `event_ts`; `author` = `event.user` (member: in the users cache, `is_restricted` false, not a bot); `bot` = `event.bot_id` set, subtype `bot_message`, or `user === U_BOT`; `refs` = `[<name>:<channel>:<thread_ts ?? ts>]` for messages and reactions.
- `mirror()`:

| Slack event | Changes |
| --- | --- |
| `message` (no subtype, `thread_broadcast`, `file_share`, `bot_message`, `me_message`; not a subtype-less `message_replied`, which nests `message`) | put `<ch>/<thread>/<ts>.md` (frontmatter per v6: `id`, `thread`, `ts`, `user: "U (name)"`, `files`, `reactions` if any; body `text`); each file ≤ 20 MB downloaded from `url_private_download` → put `<ch>/<thread>/files/<id>-<name>`; larger: `files` entry carries `size` and `url` only |
| `message_changed` | put the same path with `edited` (body from `message.text`) |
| `message_deleted` | delete the path (`deleted_ts`, thread from `previous_message`) |
| `reaction_added` / `reaction_removed` | patch the message's `reactions` (read from the event's `item` plus the names cache: the connector keeps a per-message reaction map it rebuilds from `history` when missing) |
| `member_joined_channel` / `member_left_channel` / `channel_rename` / `channel_created` / `channel_archive` / `channel_unarchive` / `group_rename` / `group_archive` / `group_unarchive` | put `<ch>/channel.md` from `conversations.info` + `conversations.members` |
| anything else | no changes |

`wake` is true for messages and edits by a non-bot, false for the rest (reactions never wake; v6 Gateway).

- `scopes()`: `conversations.list?types=public_channel,private_channel,im,mpim&exclude_archived=true` paginated, `is_member` only, plus the owner's DM.
- `history(scope, cursor)`: `conversations.history?channel&oldest=<cursor>&limit=200` paginated oldest-first, each message as above, `conversations.replies` for every message with `reply_count` (oldest = cursor), files as above; yields one batch per page with `cursor` = the greatest `ts` seen; the first page also yields `channel.md`. `429` → wait `Retry-After`, retry (5 times, then throw: the gateway logs and keeps the old cursor).
- `dm(owner, text)`: `chat.postMessage` to the owner's DM channel.
- Every request goes through `deps.fetch` with `Authorization: Bearer hortus-secret-<name>` (`-app` for `apps.connections.open`) and base `config.api ?? "https://slack.com/api"`. The connector never sees a real token.

### `src/gateway.ts`

```
start(ctx): for each dofs entry with a connector type: create, then run two loops until stop:
  events loop:  for await ({event, ack}) → trusted = trust(event, cfg) → INSERT INTO events … ON CONFLICT DO NOTHING
                → await ack() → if inserted: mirrored = await c.mirror(event); commit(dof, changes, `sync(${dof}): ${event.summary}`);
                  if (mirrored.wake && !event.bot) ctx.planner?.wake()
  reconcile loop: at start and every 10 min: for scope of c.scopes(): cursor = syncs row; for await (batch of c.history(scope, cursor))
                → commit; UPDATE syncs. Errors are logged per scope and never stop the loop.
```

`trust(event, cfg)`: `author === null || bot` → false; `cfg.trust` `owner` (default) → `author.user === cfg.owner`; `members` → owner or `author.member`; `anyone` → true; a list → includes. `status()` of every connector plus `syncs` feed the Sources page (06-console.md); `source.resync` resets a scope's cursor and runs `history` once.

Step 1's `deps.fetch` (`src/vault/direct.ts`): reads `vault.json`, replaces `hortus-secret-<name>` in `Authorization` with the credential's value, forwards with global `fetch`. Replaced in step 2 by the in-process pipeline client with the same signature; the connector does not change.

### Step 1 wiring

- `bin/hortusd.ts` starts `gateway` after the DB. `hortus install [--ca]` writes `/etc/systemd/system/hortusd.service` (v6 Process: `User=<owner>`, `AmbientCapabilities=CAP_NET_ADMIN CAP_NET_BIND_SERVICE`, `CapabilityBoundingSet` the same, `SupplementaryGroups=kvm`, `Delegate=yes`, `KillMode=mixed`, `Restart=on-failure`, `Environment=HOME=<owner home>`, `ExecStart=<node> <dist>/bin/hortusd.js`) with `sudo tee` and runs `systemctl daemon-reload`. `scripts/dev-run.sh <name> <HORTUS_HOME>` starts a copy with `sudo systemd-run --unit hortusd-<name> --uid <owner> -p AmbientCapabilities=… -p Delegate=yes -p KillMode=mixed -E HORTUS_HOME=…`.
- `vault.json`: `credential.set` is a console action (step 2); at step 1 the owner writes the file by hand (`{ "slack": { "type": "token", "value": "xoxb-…", "transform": "slack" }, "slack-app": … }`), as v6 says ("read directly").

### Fake Slack (`test/fakes/slack.ts`)

An HTTP + WebSocket server with in-memory state and a configured bot token / app token (`Authorization` must match or `invalid_auth`). Implements `auth.test`, `users.list`, `conversations.{list,info,members,history,replies,open}`, `chat.{postMessage,update,delete}`, `reactions.add`, `apps.connections.open` (returns its own `ws://` URL), file download. Socket Mode: `hello`, envelopes for every state change made through the API or the test handle (`fake.post(channel, { user, text, thread_ts })`, `fake.edit`, `fake.delete`, `fake.react`, `fake.join`), acks recorded, `fake.disconnect()` closes the socket to test reconnects, `fake.replay(envelope)` resends one. `chat.postMessage` by the bot token creates the message as `U_BOT` and emits an event, so the loop guard is testable.

## Functional tests

- Mapping: each event kind above yields the Changes listed, with v6's exact frontmatter keys; a message in a thread lands under the parent's directory; a top-level message's `thread` equals its `id`; a `thread_broadcast` is filed under its thread.
- Dedupe: `fake.replay` of a delivered envelope is acked and inserts no row (`changes === 0`), and the mirror is not touched (same `main` sha).
- Ack order: the ack is sent after the insert and before the commit (a mirror failure never loses the ack); a connector whose `mirror` throws logs and continues with the next event.
- Reconnect: `fake.disconnect()` → the connector reconnects within 2 s and later events arrive; a WebSocket that never sends `hello` is retried; backoff is capped at 60 s.
- Trust: owner id → trusted; a workspace member under `trust: "owner"` → untrusted; under `members` → trusted; a guest (`is_restricted`) under `members` → untrusted; `anyone` still refuses bots; a list refuses ids not in it; an event without `user` is untrusted.
- Bot: `chat.postMessage` by the bot produces a mirrored file and no wake.
- History: an empty mirror backfills every member channel including the owner's DM; a cursor skips messages older than it; replies of a thread older than the cursor are fetched only if the parent is newer; a 429 with `Retry-After: 1` delays and succeeds; a scope that throws keeps its old cursor and the other scopes proceed.
- Files: a 1 KB file lands under `files/`; a 25 MB file produces metadata only; a file name with `/` is sanitized to `_`.
- Membership: a `member_joined_channel` for the bot adds the channel to `scopes()` and the next reconcile backfills it.
- `dm`: posts to the owner's DM channel and nowhere else.
- Step 1 end-to-end (`scripts/dev-run.sh` against the fake, `dofs.slack.api` pointing at it): `fake.post` → within 3 s `dof/slack/<ch>/<ts>/<ts>.md` exists on `main` and `dof search <word>` prints it.

Edge cases: a message with an empty `text` and one file; `ts` with trailing zeros preserved as a string; a user id not in the cache (a deactivated user) renders `user: U999`; two events for the same message in one batch (new then edited) produce two commits in order; the daemon restarted between ack and commit loses nothing visible after the next reconcile (the 10-min reconcile re-mirrors it).

## UI/UX verification

- `hortus install` prints the unit path and the two commands to enable and start it; it refuses to overwrite a unit that differs without `--force`.
- Logs on stderr show one line per event: `sync(slack): C0123 +1` and one per reconcile scope.

## Extensibility verification

- `discord`/`telegram` (4b) are new files under `src/connectors/` plus one line in `connectors/index.ts`; the gateway, mirror, trust and tests of this step do not change. Verify by grepping `gateway.ts` for `slack`: zero hits.
- The fake's shape (`post`/`edit`/`delete`/`react`/`replay`/`disconnect`) is the template for the other fakes, so the same gateway tests run against each connector.
