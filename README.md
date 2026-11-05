# hortus-agent

hortus-agent is an always-on daemon, `hortusd`, that works for one owner. It mirrors the owner's messengers (Slack,
Discord, Telegram) and forges (GitHub, GitLab, Bitbucket) into DOFs: git-backed directories of Markdown files, one
commit per sync, indexed for full-text search (`dof search`). A Planner reads what arrives and routes it: it opens
tasks, adds to running ones, or leaves things alone. Workers do the tasks, each one a `hortus-agent` session (on
`@hortus/core`) in a Landlock sandbox on the host or in its own QEMU VM. The owner talks to them through a chat, reads
their summaries and replies, and decides on approvals in the console: a local web UI (with an optional remote login by
passkey) and the `hortus` CLI.

No Worker or Planner ever holds a secret. Every credential lives in `hortusd`'s vault (`vault.json`); sessions get
placeholders (`hortus-secret-<name>`), and all their traffic goes through `hortusd`'s proxy, which puts the real value in
only where a transform says it belongs (a header, a host) and scrubs it from responses. A request that uses a credential
passes the Approval Gate: the owner approves it on the Approvals page (or, under the `auto` policy, a judge model does,
except for consequential requests, merges, new transforms, logins, and tainted tasks: ones that read a stranger's
message, a web page or an untrusted search hit, or can read a DOF holding one (a stranger's message, hortus's own
replies); the Planner gives a task only the DOFs it needs, `scope.dofs`, usually none; "Approve, and
allow … for this task" (`hortus approvals approve --grant <id>`) on a tainted task's routine request lets its later
ones through, consequential ones still ask). The design is `hortus_v6.md` (in the owner's vault); `hortus_v7.md`
here records every decision made while building it.

## Install

Linux with systemd, Node.js ≥ 22.15, pnpm, a C compiler (for the Landlock shim), git. QEMU, virtiofsd and `/dev/kvm`
for Worker VMs; Chromium for browser tools and the login view.

```sh
pnpm install
pnpm build                 # dist/, including dist/hortus-landlock, the transforms and the console's static files
dist/bin/hortus.js install        # writes /etc/systemd/system/hortusd.service with sudo, then prints the next steps
sudo systemctl enable --now hortusd
```

The bins are `dist/bin/{hortus,hortusd,hortus-agent,dof}.js`; to call them by name, as the rest of this file does, link
them onto `PATH` (`for b in hortus hortusd hortus-agent dof; do ln -s "$PWD/dist/bin/$b.js" ~/.local/bin/$b; done`, or
`pnpm link --global`). The unit runs `hortusd` as you, with `CAP_NET_ADMIN` and `CAP_NET_BIND_SERVICE` (nftables, the proxy's
addresses), `Delegate=yes` (a cgroup per task), and `RestartPreventExitStatus=78`: a start-up error a restart cannot
fix (an invalid `hortusd.json`, a corrupt database) is one log line (`journalctl -u hortusd`) and no restart loop.
`hortus install --force` overwrites a unit that differs; `hortus install --ca` also adds the hortus CA (made at the first
start, `~/.hortus/ca/ca.crt`) to the system trust store.

Worker VMs need an image: `hortus image build` (runs `scripts/build-image.sh` under sudo; `--no-browser` leaves
Chromium out) writes `~/.hortus/images/{agent.ext4,initramfs.img,vmlinuz}`. Until it exists, VM tasks run as sandboxed
host sessions (`vm.fallback_host`). Rebuild it after updating hortus-agent: the guest runs the image's copy.

A host Worker writes only its clone, its `tasks/<id>/out` (`TMPDIR` is `out/tmp`, gone at close) and the Workers' shared
tool caches in `~/.hortus/cache`. It reads almost nothing of yours. Of your home it sees only its own project's checkout and
where toolchains install (`~/.local/bin`, `~/.nvm`, `~/.rustup`, `~/.cargo/bin`, `~/go/bin`, … the list is
`landlock.ts › HOME_READ`), and its `$HOME` is its own empty directory, so your dotfiles, `~/.gitconfig` included, are not
read. `/tmp`, `/mnt`, `/media`, `/srv`, `/var/log`, core dumps and other homes are hidden as well, other projects' checkouts
wherever they are, and of `/dev` it has only `null`, `zero`, `full`, `random`, `urandom`, `tty` and `shm`: what you run
yourself stays out of its reach, and so do your terminals, keyboard and screen.

What a Worker really needs from there goes in `policy.read` (absolute paths, read-only, an entry of the deny set inside one
stays denied): `"policy": { "read": ["/home/you/tools", "/srv/data"] }`. A binary linked from an allowed directory needs its
target listed too (`~/.local/bin/foo` → `~/apps/foo`), or the Worker gets `Permission denied`; the card says which path. A
Worker's `$HOME` is not yours, so a tool it runs does not see your configuration there; a project needing one wants it in
the repository. What is listed is linked into it (`~/.nvm`, `~/.cargo/env`, `~/.tool-versions`, not `~/.local`, which is its
own), read-only: a Worker runs your pyenv, rbenv, asdf, mise and volta shims, ahead of `/usr/bin` as in your shell, but
installs a new version only into a project or a venv (`pip install --user` gets `Permission denied`), and what it installs
itself (`go install`, `cargo install`, `uv tool`) is on its `PATH`. `~/.config/mise` is not shown: `mise use -g` is yours alone.

A chat session keeps `rw` on the rest, minus the deny set: `~/.ssh`, `~/.gnupg`, the cloud, package-manager and agent
credentials, browser and app profiles, wallets and shell histories. That is a list, and a list cannot be complete: a
chat has your reach, with you watching. No Worker, chat or not, has a pty on the host (`script`, `expect`, Python's `pty`)
or `sudo`. A project whose tooling hardcodes `/tmp` wants `"policy": { "cache": ["/tmp"] }`, at the price of tasks seeing
each other's files there, or a VM; a device goes in the same list (`/dev/ttyUSB0`). `GOPATH`, `XDG_DATA_HOME` and the JVM's
`java.io.tmpdir` point into the task's own directories, and `~/.m2/settings.xml` is denied, so a Worker's Maven runs
without your mirrors and servers there.

The console is `http://127.0.0.1:7700`. `hortus help` lists the CLI commands (`tasks`, `chat`, `approvals`, `search`,
`schedules`, `pause`, …).

## Configuration: `~/.hortus/hortusd.json`

A missing file means defaults; an invalid one stops `hortusd` with one line naming each bad key. A minimal setup with one
messenger, one forge and the Planner's (and Workers') model:

```json
{
  "owner": { "tz": "Asia/Tokyo", "notify": "slack" },
  "dofs": {
    "slack": { "type": "slack", "owner": "U0123ABCD" },
    "github": { "type": "github", "owner": "your-login", "repos": ["you/your-repo"] }
  },
  "planner": { "provider": "ollama-cloud", "model": "deepseek-v4.1-flash:1017" },
  "worker": { "provider": "ollama-cloud", "model": "deepseek-v4.1-flash:1017" }
}
```

- `dofs.<name>`: a source; `type` is the connector, `owner` your user id there (only your messages are trusted by
  default: `trust`). Forges list `repos`; a self-hosted one sets `host`.
- `owner.notify`: the DOF whose DM tells you about new approvals and failed tasks.
- `planner.provider` / `worker.provider` name a credential (below); its transform says which API it speaks.
- `policy`: `human` (the default) asks you for **every** credentialed request, one decision each, as v6 says. It is
  many: a clone is 3 decisions, a push 3, and a PR from issue to merge took 25-55 clicks and 1-2M tokens in a live walk,
  now and then reaching a task's 2M token budget, as each decision wakes the Worker with its whole context. `auto` is the
  answer for a credential you trust a Worker with: `"policy": { "*": "human", "credential:github": "auto" }`. You grant
  it once, a judge model passes routine requests, and pushes, merges, deletes and whatever it doubts still come to you:
  the same PR took 4-11 decisions. A task with a PR ends with it, however it ends: merge or close it in the forge and
  the task closes, a merge request still waiting on it dropped (a second open PR keeps the task, and any other request waits for you); if someone else closes it, you are told and it stays closed.
- `origins`: `"*"` (any public host) or a list; a project's own `origins` makes its tasks reach only the global list plus
  that list, whatever the global says, and a chat holds every project's, so one strict project makes every chat strict. A
  session's own model host is never refused, whatever the lists say. A change reaches open tasks at their next request.
- Everything else (`projects`, `policy`, `judge_notes`, `vm`, `chat.allow`, `console.listen` for the remote console,
  `proxy` ports) has defaults; the schema with them is `src/config.ts`, the reasons `hortus_v7.md` › Config.

The Settings page edits this file (validated, then reloaded); so does any editor, followed by a restart.

## Credentials

Add them on the **Credentials** page: a name, a type (`token`, `github-app`, `webhook-secret`, `aws`), the transform
that uses it and, optionally, the hosts it may go to. Values are write-only. They are stored in `~/.hortus/vault.json`
(mode 0600, read only by `hortusd`). For the configuration above:

| Name | Type | Transform | Hosts | Value |
| --- | --- | --- | --- | --- |
| `slack` | token | slack | | the bot token (`xoxb-…`) |
| `slack-app` | token | slack | | the app-level token for Socket Mode (`xapp-…`) |
| `github` | github-app | github | | App id, installation id, private key |
| `github-webhook` | webhook-secret | github | | the App's webhook secret |
| `ollama-cloud` | token | openai | `ollama.com` | the API key |

`slack-app` and webhook secrets stay `hortusd`'s: a session is not offered them.

The Sources page says, per source, what is connected, what is missing, and (for forges) the webhook URL to give the
service and how to tunnel it to the local listener.

### What each service needs on its side

Read from the connectors and the services' documentation, not yet tried on a real account:

| Service | Set up |
| --- | --- |
| Slack | A Socket Mode app. App token: `connections:write`. Bot scopes: `channels:history`, `channels:read`, `groups:history`, `groups:read`, `im:history`, `im:read`, `im:write`, `mpim:history`, `mpim:read`, `users:read`, `chat:write`, `reactions:read`, `files:read`. Bot events: `message.channels`, `message.groups`, `message.im`, `message.mpim`, `reaction_added`, `reaction_removed`, `member_joined_channel`, `member_left_channel`, `channel_rename`, `channel_created`, `channel_archive`, `channel_unarchive`, `group_rename`, `group_archive`, `group_unarchive`. Invite the bot to each channel to mirror. |
| Discord | A bot with the **Server Members** and **Message Content** privileged intents on (without them the gateway closes with 4014 and Sources says so), invited with View Channels, Read Message History and Send Messages (Send in Threads for threads). |
| Telegram | A bot from `@BotFather`, with `/setprivacy` set to Disable, or in groups it only hears commands and replies to it. No webhook on it: `getUpdates` and a webhook exclude each other. |
| GitHub | A GitHub App installed on the repos, permissions contents, issues, pull requests write; checks, actions read; administration write only if tasks create repositories (`src/vault/ops.ts › PERMISSIONS`). Events Issues, Issue comment, Pull request, Pull request review, Pull request review comment, Check suite, Push, Repository. |
| GitLab | A token with `api` (Worker writes go through it), a project or group webhook with the Sources page's URL and the `gitlab-webhook` secret as its token; events: issues, notes, merge requests, pipelines, push. Not a signing-token-only hook (GitLab 19). |
| Bitbucket | A workspace access token when `repos` holds globs or `trust: members` is wanted: a repository token cannot hold the `account` scope, so it can list nothing and sees nobody as a member (exact `repos` names and `trust: owner` work with it). A webhook with the secret; events: issue, pull request, push, commit status. |

## Development

```sh
pnpm build && pnpm lint
pnpm test                  # build, then node --test over dist/**/*.test.js
pnpm build && node --test dist/db.test.js   # one file
```

`HORTUS_HOME` relocates all of `hortusd`'s state (default `~/.hortus`); use a scratch one in development, never your
real one. Two ways to run a development daemon:

- Without network rules, as the end-to-end tests do: `HORTUS_NO_NET=1` (refused unless `HORTUS_HOME` is set) skips
  nftables and session addresses, so no capabilities are needed, only a delegated cgroup:
  `systemd-run --user --scope -p Delegate=yes env HORTUS_HOME=/tmp/hortus-dev HORTUS_NO_NET=1 dist/bin/hortusd.js` (the bins' shebang silences `node:sqlite`'s
  experimental warning; `node dist/bin/hortusd.js` prints it).
  `dev.upstreams` in its `hortusd.json` points hosts at fake services. It works only with `HORTUS_HOME` set (the daemon logs
  an error and uses the real hosts otherwise), and the `hortus` CLI needs the same `HORTUS_HOME` to find that daemon.
- With them: `scripts/dev-run.sh <name> <HORTUS_HOME> [ENV=value …]` starts it as a transient system unit with the real
  unit's capabilities (passwordless sudo); stop it with `sudo systemctl stop hortusd-<name>`, logs with
  `journalctl -u hortusd-<name> -f`. It differs from the installed unit in four ways: it is transient (gone at a stop, so
  no `systemctl start`), it passes your shell's `PATH` (the installed unit has systemd's), it sets `HORTUS_HOME`, and it has
  no `Restart=`.

The default suite runs unit tests and the end-to-end tests (`src/e2e/`: a real `hortusd` under `HORTUS_NO_NET=1` in a
delegated user scope, fake upstream services from `src/test/fakes/` behind `dev.upstreams`, a fake model provider).
Opt-in suites, skipped otherwise:

- `HORTUS_TEST_NET=1`: nftables and session addresses (passwordless sudo; run with `--test-concurrency=1`).
- `HORTUS_TEST_LLM=1`: live model calls (`HORTUS_TEST_MODEL` picks the model).
- `HORTUS_TEST_VM=1`: boots Worker VMs (`HORTUS_TEST_IMAGES`, default `$HORTUS_HOME/images`; needs `/dev/kvm`).
- `HORTUS_TEST_SOAK=1`: the soak test at full speed for `HORTUS_TEST_SOAK_MIN` minutes (default 60; the default suite runs 1.5 min of it).

`KEEP=1` keeps an end-to-end test's temp directory (with its `hortusd.log`).

## Where things are

- `AGENTS.md`: conventions and the source layout.
- `docs/build-order.md`: the build steps, what each one's done-when is, and their status.
- `docs/design/*.md`: one design per step (implementation, functional tests, UI/UX checklist).
- `hortus_v7.md`: the decisions v6 left open, as built, and each review round's findings.
