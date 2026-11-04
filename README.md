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
message, a web page or an untrusted search hit, or can read a DOF holding a stranger's text; the Planner gives a task
only the DOFs it needs, `scope.dofs`; "Approve, and allow … for this task" on a tainted task's routine request lets
its later ones through, consequential ones still ask). The design is `hortus_v6.md` (in the owner's vault); `hortus_v7.md`
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
- `owner.notify`: the DOF whose DM tells you about new approvals.
- `planner.provider` / `worker.provider` name a credential (below); its transform says which API it speaks.
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

The Sources page says, per source, what is connected, what is missing, and (for forges) the webhook URL to give the
service and how to tunnel it to the local listener.

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
  `dev.upstreams` in its `hortusd.json` points hosts at fake services.
- With them: `scripts/dev-run.sh <name> <HORTUS_HOME> [ENV=value …]` starts it as a transient system unit with the real
  unit's capabilities (passwordless sudo); stop it with `sudo systemctl stop hortusd-<name>`, logs with
  `journalctl -u hortusd-<name> -f`.

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
