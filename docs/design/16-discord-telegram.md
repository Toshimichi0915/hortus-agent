# Step 4b — `discord` and `telegram` connectors and transforms, `ws:text`

Spec: v6 › Connectors › Messengers (Discord and Telegram columns), Secret Vault (`ws:text`). Depends on step 1's interface and F3; its done-when needs step 4. Parallel with 4.

## Implementation

### `src/connectors/discord.ts`

- Start: `GET /users/@me` (bot id), `GET /users/@me/guilds` → per guild `GET /guilds/{g}/channels` (text and thread-capable), the owner's DM `POST /users/@me/channels` `{ recipient_id: owner }`.
- `events()`: `GET /gateway/bot` → WebSocket; `HELLO` → heartbeat timer; `IDENTIFY` with intents `GUILDS | GUILD_MESSAGES | MESSAGE_CONTENT | GUILD_MESSAGE_REACTIONS | DIRECT_MESSAGES | DIRECT_MESSAGE_REACTIONS | GUILD_MEMBERS`; the token in the frame is `hortus-secret-<name>` (the manifest declares `ws:text`, so the proxy swaps it in the text frame); `RESUME` with `session_id`/`seq` on reconnect, `INVALID_SESSION` → fresh identify. Key `session_id:s`. Events: `MESSAGE_CREATE/UPDATE/DELETE/DELETE_BULK`, `MESSAGE_REACTION_ADD/REMOVE/REMOVE_ALL/REMOVE_EMOJI`, `THREAD_CREATE/UPDATE`, `CHANNEL_CREATE/UPDATE/DELETE`, `GUILD_MEMBER_ADD/REMOVE`. Interactions are acked within 3 s (`POST /interactions/{id}/{token}/callback` type 5) and dropped. Author `member` = `member` present on the message. Bot = `author.bot`.
- Thread: a thread channel is filed under its parent channel's directory: `<guild>/<parent>/<thread>/<message>.md`; a plain channel message: `<guild>/<channel>/<message>/<message>.md` (thread = message, v6). Channel directory = `<guild id>/<channel id>`… v6's schema is `<dof>/<channel>/<thread>/<message>.md`; the channel is `<channel id>` (guild in `channel.md`).
- `history(channel, after)`: `GET /channels/{c}/messages?after=<id>&limit=100` ascending by paging, threads via `GET /channels/{c}/threads/archived/public` + active threads in `GET /guilds/{g}/threads/active`, each with its own cursor; cursor = last id.
- `dm`: `POST /channels/{dm}/messages`.
- Reconnect: RESUME on READY's `resume_gateway_url` (a session-specific host); after four failed connects a new session on the cached URL. Close codes 4004, 4010–4014 (not reconnectable): the reason on Sources, one retry an hour.
- Transform `discord`: `discord.com`, `gateway.discord.gg`, `*.discord.gg` (the resume hosts); `header:Authorization` (`Bot {secret:discord}`) and `ws:text`; consequential: `DELETE discord.com/api/**`, `messages/bulk*`, `bans/*`, `bulk*ban`.

### `src/connectors/telegram.ts`

- `events()`: `getUpdates` long poll (`timeout=50`, `offset = last update_id + 1` is the ack, `allowed_updates` messages, edited messages, channel posts, reactions, chat members); key `update_id`. Author `member`: `getChatMember` cached 1 h (status in member/administrator/creator). Bot: `from.is_bot`.
- Thread: `message_thread_id` (forum topics), else the root of the `reply_to_message` chain (followed through the mirror's files, since the API does not give the chain), else the message itself. Files: `getFile` + download `/file/bot{}/…` ≤ 20 MB. A download a stop cuts fails the mirror, and the gateway drops the row: the update is still Telegram's and comes again whole at the next start.
- `history`: none (v6). `scopes()`: chats seen so far (persisted in `syncs` as cursorless rows, so a restart knows them); the owner's private chat appears when the owner messages the bot once (documented in the Sources page's hint).
- `dm`: `sendMessage` to the owner's chat id.
- The transform's `sendMessage` refs: the thread and the sent message itself. The bot's messages are never updates, so an answer to one is on thread `<that message>` to the connector, and files under `<chat>/<that message>/` (v7 › Review round 9 — step 4b end to end).
- Transform `telegram`: `api.telegram.org`; location `path:/bot{}/` (`/bothortus-secret-telegram/getUpdates` → `/bot{secret:telegram}/…`); consequential: any method (`*`: the API takes GET too, and matching ignores case: its method names do) on `delete*`, `remove*`, `ban*`, `kick*` (`kickChatMember` still works), `leaveChat`, `setWebhook`, `logOut`, and a path with no method (the server then reads a `method` argument).

### `ws:text` in the proxy (`src/proxy/ws.ts`)

For a host whose matching manifest declares `ws:text`, after the handshake the relay parses frames (RFC 6455: fin/opcode/mask/length, client frames masked) with `ws`'s `Receiver`/`Sender` or a 120-line codec: text frames client→upstream run through `request()`-style placeholder replacement for the declared credential (the frame payload is the "body" at location `ws:text`) and the same runtime checks (a raw secret in a frame → the connection is closed with 1008); text frames upstream→client are scrubbed; binary and control frames pass through, re-masked as needed. Discord's gateway compresses (`zlib-stream`) only when asked: the connector does not ask.

### Fakes

`test/fakes/discord.ts` (REST + gateway WS: `HELLO`, `IDENTIFY` check of the token value, `READY`, `MESSAGE_CREATE` on `fake.post`, `RESUME`), `test/fakes/telegram.ts` (`getUpdates` with long poll, `sendMessage`, `getChatMember`, `getFile`).

## Functional tests

- Gateway tests from 02 run against each fake with the same assertions (dedupe, ack order, trust, bot guard, reconnect, membership).
- Discord: `IDENTIFY`'s token reaches the fake as the real value through the `ws:text` relay; a frame containing the real token sent by a client is refused (1008); a resumed session replays missed events and keys dedupe them; a thread message files under the parent; a reaction patches `reactions`; an interaction is acked within 3 s.
- Telegram: the `offset` advances only after insert (a crash between `getUpdates` and insert re-delivers and dedupes); a reply chain of three messages files under the root; a forum topic uses `message_thread_id`; a 25 MB document is metadata only; the owner's first message creates the DM scope and `dm()` works after it; `path:/bot{}/` swap is the only location (a token in a header → refused).
- v6 done-when: the step-4 flow (owner message → task → Worker reply in the thread → follow-up routed by refs; `owner.notify` set to each) passes on Discord and Telegram with `git diff --stat` of the change set showing only `src/connectors/<type>.ts`, `transforms/<type>/`, `connectors/index.ts`, and tests.

## UI/UX verification

- Sources page rows for Discord (gateway session id, heartbeat ack age) and Telegram (last update id, known chats) show the connector-specific hint where it matters ("message the bot once to open your DM").

## Extensibility verification

- `ws:text` is a location in the manifest and a relay mode in the proxy; a future `ws:binary`-with-token service is one more mode.
- The three messengers share no code but the interface and the fake shape; a fourth (Matrix) is the same two files.
