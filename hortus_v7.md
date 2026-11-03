# hortus v7: decisions made while building v6

v7 is v6 as implemented in this repository. Nothing in the v6 design changes; this records what v6 left open and the choices made, so the code and the design agree. Read `hortus_v6.md` first. Sections follow v6's.

## Process

- **One package.** `hortus-agent` (this repository) is one npm package with four bins: `hortusd`, `hortus` (console CLI), `hortus-agent` (Worker and Planner), `dof`. Same TypeScript conventions as hortus (`AGENTS.md` there): ESM, `.ts` imports, `node:test` from `dist/`, biome. `@hortus/core@^1.2.0` from npm, unchanged. The VM image installs the same package.
- **SQLite is `node:sqlite`** (built into Node 22; FTS5 trigram verified). No native build. The experimental warning is silenced with `--no-warnings=ExperimentalWarning` in the bins' shebang lines.
- **`HORTUS_HOME`** (default `~/.hortus`) relocates `hortusd`'s state for tests. Only `hortusd`, `hortus` and `dof` read it; `hortus-agent` finds everything through `task.json`.
- **The owner's `~/.hortus/secrets.json` is never touched.** v6 assumed it holds placeholders; this owner uses the standalone `hortus` CLI with real keys in it. Instead every task gets `tasks/<id>/ctl/home/.hortus/{config.json,secrets.json}` (placeholders, `provider`, `model`, `effort`), and `hortus-agent` sets `HOME` to `ctl/home` only while importing `@hortus/core` (core reads `homedir()` once at import), then restores it, so tools and children see the owner's real `HOME`. The real `~/.hortus` (its `secrets.json`, `sessions/`, `plugins/`) is in every Landlock deny set (Security).
- **Sessions are core's files**: `openSession(leaf, "tasks/<id>/out/sessions")`, one `<epoch>_<uuid>.jsonl` per context (a handoff starts a new file). v6's `out/session.jsonl` is this directory. Resume = `listSessions(dir)[0].leafId`. The inbox cursor is not a separate state file: each inbox message is appended as a user message beginning with `[inbox <seq>]`, so the highest marker in the replayed messages is the cursor. Token usage is the sum of assistant `usage` in the replayed messages; hours are tracked by `hortusd` from process start/stop.
- **The summary and the handoff note** are direct `provider.complete()` calls with `tools: []` on `agent.resolve()`'s provider: core's `run` always passes every tool, and these two calls must have none.
- **Context window**: `provider.contextWindow?.(model)` when the API reports it, else `worker.context_window` from config (default 131072). The handoff fires when the last call's `input + output` exceeds 70% of it.
- **Worker plugins**: `worker.plugins` (config, a list of plugin directories) are copied into `ctl/home/.hortus/plugins/` at task start, so a Worker loads owner-chosen hortus plugins (an MCP bridge, extra tools) without hortusd knowing them. Absent by default.
- **Task ids** are `<base36 ms><8 hex>`, time-ordered. Approval, schedule and inbox ids are integers from SQLite.
- **Dev run**: `hortus install` writes `/etc/systemd/system/hortusd.service` (`User=<owner>`, the capabilities, `Delegate=yes`, `KillMode=mixed`) with `sudo`. Tests that need the network layer start the daemon the same way through `sudo systemd-run` (`scripts/dev-run.sh`); unit tests need no capabilities. There is no sudo inside `hortusd`.

### Config additions

```json
{
  "planner": { "provider": "ollama-cloud", "model": "deepseek-v4.1-flash:1017", "runtime": "host" },
  "worker": { "provider": "ollama-cloud", "model": "deepseek-v4.1-flash:1017", "context_window": 131072, "plugins": [] },
  "dofs": { "slack": { "type": "slack", "owner": "U0123", "api": "https://slack.com/api" } },
  "dev": { "upstreams": { "slack.com": "http://127.0.0.1:4010", "ollama.com": "http://127.0.0.1:4020" } }
}
```

- `planner.runtime`: `host` (an unattended host session under the unattended Landlock profile, role `planner`) or `vm` (v6's design). Default `host` until the image exists, then `vm` when `/dev/kvm` is usable.
- `planner.provider` / `worker.provider` name a `vault.json` credential; its `transform` and `hosts` say where it goes (below). The `auto` judge uses the Planner's provider and model, not a fixed `anthropic` credential.
- `dofs.<name>.api` overrides a connector's API base (tests against a fake service; a forge's `host` still derives it).
- `proxy: { https: 8443, http: 8080, dns: 8053 }`: the proxy's listener ports (Security › Network). Read at start.
- `vm.fallback_host` (default `true`): while `images/agent.ext4` (or its kernel/initramfs) is missing, a task whose `runtime` is `vm` runs as an unattended host session (Landlock unattended profile, role `worker`) with a log line and a status note on its card naming the missing file; `false` keeps it `queued` with that message in its `error` until `hortus image build`. `runtime` is fixed at creation (v6 › Worker › Runtimes: chat → host, a project task → the project's `runtime`, the Planner → `planner.runtime`, everything else → `vm`), so a task created before the image exists boots a VM on its next start once it does.
- **VM hours budget**: the dispatcher passes the remaining `hours` as `startVm`'s deadline; a SIGKILL exit at or after it is recorded by hortusd as `budget_exceeded: …` in the task's `error` (no outbox row: the seq numbers are the Worker's) and the task waits, even with undrained inbox messages.
- `dev.upstreams` maps a host the proxy intercepts to where it actually connects. Test-only; the Settings page shows it under a "development" heading and the value is refused unless `HORTUS_HOME` is set.

## Gateway and Connectors

- A connector module exports `create(config, deps): Connector`; `connectors/index.ts` maps `type` to it. Adding a type is that module plus `transforms/<type>/`, nothing else.
- `Event` is `{ dof, key, ts, payload, author, bot }`; `Change` is `{ op: "put" | "delete", path, frontmatter?, body?, bytes? }` relative to the DOF root. The mirror writer turns Changes into files and one commit; connectors never touch git.
- Slack mirrors public and private channels, DMs, and group DMs the bot is in; the owner's DM is opened at start (`conversations.open`) so `owner.notify` works before the owner writes.
- Messengers' `events()` reconnects with backoff (1 s doubling to 60 s) and never throws out of the gateway loop; a dead connection shows on the Sources page.

## DOF

- `dof` CLI transport: inside a task (`HORTUS_TASK` set, pointing at `ctl/task.json`) it calls `https://hortusd.internal/rpc/dof.search` through the proxy; in the owner's shell it uses the abstract socket. Same request body, same output.
- `dof search` output: one line per hit, `<dof>/<path>\t<ts>\t<author>\t<title or snippet>`, newest first, 20 by default (`-n`).
- Mirror file names: a channel directory is the service's id (`C0123`), a thread directory the thread's id, a message `<id>.md`. Ids with `/` or `..` are refused by the writer (never written, logged).
- The `logs` index row for a task is written when the files are, by the same function.

## Planner

- The Planner's prompt and tools live in `hortus-agent` behind `task.json.kind = "planner"`: the same binary, the planner plugin instead of the task plugin (RPC tools only, read-only `bash`, no `edit`/`write`). The RPC router refuses `task_create` and friends from any role but `planner`.
- A batch is a one-shot task directory under `tasks/planner-<n>/`, deleted after the run; its JSONL is not kept (the Planner has no persistent context by design).

## Projects

- The origin's `pre-receive` hook is a shell script installed by `hortusd` at project creation; it reads `HORTUS_ROLE` and `HORTUS_TASK` from the environment `git http-backend` inherits.
- `git http-backend` runs as a CGI child of `hortusd` for `https://hortusd.internal/git/<name>`.
- **Pre-clone** (v6 says nothing is pre-cloned): the unattended Landlock profile grants rw on `clones/<id>` only if the path exists when the session spawns, so `hortusd` clones before the first start of an unattended host task on a project: `git clone --no-local [--reference <checkout>] projects/<name>.git clones/<id>` (git projects reference the owner's checkout, which the Worker can read; a non-git project's shadow is under the denied `~/.hortus`, so no reference), `checkout -b hortus/<id>`, `remote set-url origin https://hortusd.internal/git/<name>`. `--no-local` so no object is hard-linked to the origin (the Worker has rw on the clone). VM tasks clone themselves (`/task/out/work/clone`).
- **No `receive.denyNonFastForwards`** on the origin: it applies to every ref and is checked after `pre-receive`, so it would refuse a Worker's force-push of its rebased `hortus/<task>`. `main` is guarded by the hook (a Worker may push only `hortus/<its task>`) and moves only by `sync` (a fetch that refuses non-fast-forward unless forced) and `update-ref main <sha> <main_sha>`. `receive.denyDeletes`, `gc.auto 0`, `http.receivepack true` (the backend's caller is checked before the CGI), `uploadpack.allowAnySHA1InWant true` (landing fetches the approved sha, not the branch).
- **HORTUS_NO_NET git transport** (tests): git cannot bind the session's loopback alias as its source address the way `dof` does, so `hortusd` gives the alias its own plain listener (`listen(alias, ephemeral ports)`: a connection to it is identified by its local address, the alias, i.e. the task) and points the clone's `origin` at `http://<alias>:<port>/git/<name>` with `http.extraHeader = Host: hortusd.internal`, rewritten at every start (the alias can change). The listener stays after the session (reused by the next task on the alias). With networking, the clone keeps `https://hortusd.internal/git/<name>` and goes through the session address.
- A merge entry is `approvals` category `merge`, summary `{ project, branch, main_sha, sha, stat, files, added, removed, patch (first 64 KB), truncated }`; statuses add `landed` and `replaced`; a landing failure is the entry's `reason` and the entry stays `approved` (the Approvals page shows a "Retry" button, `merge.retry`). The full diff beyond 64 KB is not served (the page folds the stored 64 KB). Landings run one at a time; syncs one at a time per project.
- Landing syncs first (git: the checkout's `main`; non-git: a snapshot), so an owner commit or edit since the request moves `main` and sends the task to rebase rather than failing on "checkout is at …". A dirty git checkout keeps the entry approved with "checkout is not clean"; once the owner cleans it (not commits: that moves `main`), "Retry" lands.
- `gate.decide` also writes its generic "approval N approved (merge): retry the request" to the task; the landing's own `from=merge` message ("merged <sha>" or the reason) follows it. The prompt tells the Worker to wait for `from=merge`.
- The sandbox's `GIT_CONFIG_*` add `commit.gpgsign=false`: the owner's `~/.gitconfig` is still read (HOME is the owner's) and may sign commits, which fails without the owner's gpg agent.

## Console

- Server-rendered HTML, no framework, no build step: one template function per page, a 2 KB script for `POST` calls (`X-Hortus: 1`, JSON) and SSE. Every mutating call is `POST /api/<method>` to the same RPC router the CLI uses, with role `owner`.
- `hortus approvals approve|reject <id>` is allowed: the abstract socket is reachable only from the owner's shell, so a decision there is a decision in the console. v6's "no CLI flag" means no flag that approves unattended.
- The `hortus` bin name shadows `@hortus/cli`'s when both are on `PATH`; this owner runs the latter from its repository, so nothing clashes. The CLI's chat is a line-based REPL, not Ink.
- Remote login uses `@simplewebauthn/server`; the browser side is hand-written (`PublicKeyCredential.parseCreationOptionsFromJSON` with a manual fallback).

## Secret Vault

- **Credential `hosts` override.** A manifest's `credentials` keys are default names. The owner may add a credential under any name on the Credentials page, naming its `transform` and optionally `hosts`; it inherits `locations` from the manifest entry of the same `type`. This is how `ollama-cloud` (`transform: "openai"`, `hosts: ["ollama.com"]`) rides the `openai` transform. The runtime enforces the credential's effective `hosts`.
- Shipped LLM transforms: `anthropic` (`api.anthropic.com`, `header:x-api-key`), `openai` (`api.openai.com`, `header:Authorization`), `openrouter`, `ollama` (`ollama.com`). All insert one token; `response()` is identity.
- **Large and streamed bodies**: a request body over 1 MB, or with `Content-Type` `application/x-git-*` or `application/octet-stream`, is given to `request()` with `body: null, stream: true`; the transform may only touch the URL and headers, and the body streams. Responses of `text/event-stream` and `application/x-git-*` skip `response()` and are scrubbed on the fly (the carry is the longest secret). Every other response is buffered up to 16 MB, then `response()` runs.
- **Hash**: SHA-256 of the canonical JSON of the template (method, URL, sorted headers, body) with secret handles left as handles. A request without any handle needs no credential and no approval: only the egress check applies.
- **Approval timing**: a `request` record's hash is single use (`status = approved` → `used` on the pass). The proxy answers `403 {"approval": id, "category": …}`.
- **Hosts the proxy does not intercept**: none. Every SNI is terminated; a host outside the task's `origins` gets a `403` page.
- The CA is trusted by host children through the environment (`SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, `GIT_SSL_CAINFO`, `CURL_CA_BUNDLE`, `REQUESTS_CA_BUNDLE`), not the system store. `hortus install --ca` installs it system-wide for owners who want `curl` in a chat session to work without the variables.
- Per-host certificates are minted with `openssl` as v6 says; RSA 2048 CA, ECDSA P-256 leaves, 398-day validity, SAN = the host.
- **Worker provider placeholders.** `ctl/home/.hortus/secrets.json` holds one entry, `worker.provider`: `{ type, apiKey: "hortus-secret-<provider>", endpoint }`, from the credential's `transform` and its first `hosts` entry (else the transform's host): `anthropic` → type `anthropic`, `https://api.anthropic.com`; `openai` → `openai`, `https://<host>/v1`; `openrouter` → `openai`, `https://<host>/api/v1`; `ollama` → `openai`, `https://<host>/v1` (so `ollama-cloud` gets `https://ollama.com/v1`). Any other transform name is used as the provider type with no endpoint (tests ship a `fake` provider plugin through `worker.plugins`). The table is `PROVIDERS` in `runtime/tasks.ts`.
- **A session's own model credential passes the gate.** For role `worker` (`planner`), requests carrying only `worker.provider` (`planner.provider`) need no grant and no approval, and their body is neither checked for placeholders nor resolved (handles in it stay text): a model call is how the session thinks, and its body is the conversation, which quotes `hortus-secret-…` and `{secret:…}` (an approval's summary) in prompts and tool output. Every other credential is gated as before. (Until 3e's `auto`/`grant`, the alternative was a click per model call.)

## Security

- **Landlock shim**: `hortus-landlock` (C, built by `pnpm build` with `cc`) reads a JSON profile on `fd 3` — `{ cgroup, ro: [], rw: [], scoped: ["signal", "abstract_unix"] }` — writes its own pid to `<cgroup>/cgroup.procs`, builds the ruleset with every filesystem right the running ABI offers, `PR_SET_NO_NEW_PRIVS`, restricts itself, and `execvp`s the rest of its argv. The order matters: the cgroup write happens before `/sys/fs/cgroup` becomes unreachable.
- **Deny set** (both profiles): `~/.hortus` except the task's `ctl/`, `out/`, `clones/<task>`, `schedules/<id>` (runs), `dof/`, `repos/`; `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.azure`, `~/.config/gcloud`, `~/.kube`, `~/.docker`, `~/.netrc`, `~/.password-store`, `~/.local/share/keyrings`, `~/.mozilla`, `~/.config/chromium`, `~/.config/google-chrome`, `~/.config/BraveSoftware`; `/run/docker.sock`, `/var/run/docker.sock`, `/sys/fs/cgroup`, `/run/user/<uid>/bus`, `/run/user/<uid>/keyring`. The owner can add paths with `policy.deny` (config, a list).
- **Unattended rw set**: the clone, `tasks/<id>/out`, the run's `schedules/<id>`, `/tmp`, `/dev/{null,zero,urandom,random,tty,pts,shm}`, `~/.cache`, `~/.npm`, `~/.local/share/pnpm`, `~/.cargo`, `~/.gradle`, `~/.m2`, `~/.pyenv`, `~/.rustup`, plus `policy.cache` (config). Everything else that exists at spawn is read-only; what does not exist is unreachable.
- **Network for host sessions**: one `tls`/`http`/`dns` listener set per session address, bound when the session starts and closed when it ends; the proxy finds the session by `socket.localAddress`. The nftables table is `inet hortus`; per-session rules match `socket cgroupv2 level <depth> "<path>"`, with a final `ip daddr 10.77.1.0/24 drop` for every other cgroup. IPv6 from a session cgroup is dropped except `::1`.
- **High ports, DNAT'd.** A root process on this host holds `*:80` and `*:443`, so binding `10.77.0.1:443` fails. The proxy binds `proxy.https` / `proxy.http` / `proxy.dns` (config, default `8443` / `8080` / `8053`) on `10.77.0.1` and on every session address; nftables DNATs the standard ports to them: session rules (`nat` output, per cgroup) TCP 80/443 and UDP 53 to the session address's ports, VM link rules (`pre`, prerouting on the tap) `10.77.0.1:80/443/53`. DNS is `8053`, not `5353`: mDNS responders hold `0.0.0.0:5353`. `CAP_NET_BIND_SERVICE` is no longer needed (kept in the unit; harmless).
- **`HORTUS_NO_NET=1`** (tests, a daemon without capabilities): no hortus0, no rules; the proxy listens on `127.0.0.1` with the configured ports, which is then the shared address (clients told apart by peer address: loopback aliases such as `127.0.0.2`). A busy loopback port is logged, not fatal.
- **Workers under `HORTUS_NO_NET=1`** get a loopback alias `127.0.0.<n>` registered as their `links` row, and `HORTUS_RPC=http://127.0.0.1:<proxy.http>` plus `HORTUS_RPC_LOCAL=<alias>`: `dof` then posts from the alias to the proxy's plain listener with `Host: hortusd.internal`, so `dof search` works in tests. Nothing else is intercepted in that mode: `curl` to an upstream from a Worker needs the real network mode. `ctl/bin/dof` (a wrapper around `dist/bin/dof.js`) is first on every session's `PATH`.
- **`dev.link({ address, role, task })`** is a dev-only owner RPC (refused unless `HORTUS_HOME` is set) for the step-2 end-to-end test: under `HORTUS_NO_NET=1` it writes the `links` row; otherwise it wires a full session address (`net.addAddress`, listeners, `links`, cgroup `tasks/<task>` and its rules via `sessionNet.open(…, address)`) and returns the cgroup path.
- **Core WebSockets** (Discord's gateway): `coreSocket(url)` is `coreFetch`'s twin, a `ws` client whose connection is an in-process stream pair into the proxy's upgrade relay as role `core`. No address is bound, so no local process can pose as core by peer address; the `ws:text` relay swaps IDENTIFY's placeholder like any client's. Connectors get it as `ConnectorDeps.ws`.
- **VM image**: `vmlinuz` is the host's stock kernel copied into `images/`, with an initramfs built by `mkinitcpio` that includes `virtio_mmio`, `virtio_net`, `virtio_blk`, `virtio_fs` (the stock kernel has the mmio transport as a module). Root is `agent.ext4` on `virtio-blk-device`.
- **Judge model** is the Planner's. `judge_notes` and the fixed prompt are hashed together into `prompt_hash`.

## Chat

- The Worker's stdout is JSON lines (`{"type":"text"|"thinking"|"tool_call"|"tool_result"|"message"|"error", …}`); `hortusd` relays chat ones to the console as SSE and keeps the last 1000 for a reconnecting page. Non-chat tasks' stdout goes to `out/console.log`.
- Owner text is `[inbox <seq>] from=owner` followed by the text, unwrapped. Every other inbox message is wrapped: `[inbox <seq>] from=<origin> author=<id> trusted=<bool>` then the text between `<<<quoted` and `>>>` lines.
- **Chat tasks**: `task.open` creates the task with a fixed brief ("A chat with the owner…") and the owner's text as `[inbox 1]`, so the first words are not sent twice. Every stdout line is one `replies` row, text deltas included (the page renders `text` rows inline, the CLI writes them without a newline). Non-chat stdout goes to `out/console.log`; only its `status`/`error` lines become rows.
- **`task.stream({ id, after? })`** (socket) yields `replies` rows (`{ seq, body, created }`) after `after`, then each new one, across turns; it ends when the task is closed, not when a turn ends (the REPL keeps one stream). A disconnected client's iterator is dropped at the next row or the close.
- **Exit → status**: exit 0 with an inbox message the Worker never drained (cursor = highest `[inbox N]` marker) → `queued`; anything else → `waiting`. A non-zero exit without an outbox file sets `tasks.error` (the last stdout `error` line, else the tail of `console.log`) and waits: no restart without a new inbox message. A start that fails (no Landlock, no session address, no provider) also waits with the reason.

## Schedules

- `croner` for `cron` (as v6). `every` under 300 s and `cron` expressions firing more often than every 5 min are refused at `schedule()`.

## Testing without credentials

No messenger or forge credentials exist on this machine. Each connector ships a fake service under `test/fakes/` (Slack: Socket Mode and the Web API it uses; later Discord, Telegram, GitHub) and every done-when in `docs/build-order.md` is exercised against it through `dofs.<name>.api` and `dev.upstreams`. Verification against the real services is pending the owner's credentials; the checklist for that is in each design doc.

## Deferred (v7)

| Item | Now | Add when |
| --- | --- | --- |
| Owner plugins in hortusd | connectors and transforms are the extension points; the Worker loads hortus plugins | someone wants a console page or an RPC from a plugin |
| `secrets.json` placeholders in `~/.hortus` (v6) | per-task `ctl/home` | the owner stops using the standalone CLI |
| Per-model context windows | `worker.context_window` | the provider reports them |
