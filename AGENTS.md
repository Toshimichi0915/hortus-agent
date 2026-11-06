# AGENTS.md

hortus-agent implements hortus, a reactive agent system that works for one owner. One npm package, four bins: `hortusd` (daemon: DOF mirrors, Secret Vault and proxy, console), `hortus` (console CLI), `hortus-agent` (Worker and Planner on `@hortus/core`), `dof` (search CLI).

## Commands

```sh
pnpm build          # tsc -b, then the Landlock shim, transforms and static files into dist/
pnpm test           # build, then node --test over dist/**/*.test.js
pnpm lint           # biome lint
pnpm format         # biome format --write
```

Tests run from compiled `dist/`, so build first. One file: `pnpm build && node --test dist/db.test.js`. Tests use `node:test` + `node:assert/strict`, colocated as `*.test.ts`. End-to-end tests (`src/e2e/`) run a real `hortusd` under `HORTUS_NO_NET=1` in a delegated user scope (`systemd-run --user --scope`) with fakes behind `dev.upstreams` and a fake provider plugin; they are in the default suite. Opt-in, skipped otherwise: `HORTUS_TEST_NET=1` (nftables and session addresses; passwordless sudo), `HORTUS_TEST_LLM=1` (live model calls; `HORTUS_TEST_MODEL`), `HORTUS_TEST_VM=1` (boots a Worker VM; `HORTUS_TEST_IMAGES` = the image directory, default `$HORTUS_HOME/images`), `HORTUS_TEST_SOAK=1` (`src/e2e/soak.test.ts` for `HORTUS_TEST_SOAK_MIN` minutes, default 60), `HORTUS_TEST_CHAOS=1` (`src/e2e/chaos.test.ts`: random SIGKILLs of the daemon under owner orders; `HORTUS_TEST_CHAOS_KILLS`, default 6). `KEEP=1` keeps an e2e test's fake directory (its `hortusd.log`). An unattended session cannot write `/tmp`, so a fake provider's directory goes in the test config's `policy.cache`.

## Conventions

Same as hortus: source imports use `.ts` extensions (`rewriteRelativeImportExtensions`); ESM only; `verbatimModuleSyntax` (use `import type`); `noUncheckedIndexedAccess`; prefer `interface` over `type` for object shapes; biome: 2-space indent, 120 cols, double quotes, organized imports; `// ponytail:` comments mark deliberate shortcuts with a known ceiling and upgrade path. No new dependencies without the owner's OK. `node:sqlite` is the database (silence its experimental warning in the bins only).

`HORTUS_HOME` relocates the daemon's state (`~/.hortus` by default); every test uses a temp `HORTUS_HOME`. The owner's real `~/.hortus/secrets.json` is never read or written by this code.

## Layout

`README.md` is the owner's guide (install, config, credentials, dev run, tests); its example `hortusd.json` is checked by `src/config.test.ts`. `src/types.ts` holds every cross-module contract (events, changes, connectors, task.json, transforms, RPC caller); the foundation sits beside it (`config.ts`, `db.ts`, `paths.ts`, `rpc.ts`, `ids.ts`, `log.ts`, `ctx.ts`, `install.ts`, `hostile.ts`: capped, no-follow reads of Worker-written files; `crash.ts`). `src/<area>/` per subsystem: `mirror/`, `gateway/` (the connector loop, webhook listener), `connectors/`, `vault/`, `proxy/`, `runtime/`, `agent/`, `console/`, `planner/`, `schedules/`, `projects/`, `browser/`; `src/bin/` the four bins; `src/e2e/` the end-to-end tests, one per feature. `transforms/<name>/` are the shipped transforms (copied to `dist/transforms`). `src/test/fakes/` are fake upstream services (Slack, Discord, Telegram, GitHub, GitLab, Bitbucket, a cookie site, a hostile upstream for the DoS tests, a fake QEMU; compiled with the rest, so tests can import them); `src/test/` also holds the helpers (`tempDir`/`until`, a software WebAuthn authenticator). `native/landlock.c` builds to `dist/hortus-landlock`. `scripts/`: `build.sh` (what `pnpm build` runs), `build-image.sh` (the VM image), `dev-run.sh` (the daemon in a capability-bearing unit).

## Terminology

- **Owner**: the one person hortusd works for. RPC roles (`Role` in `src/types.ts`): `owner` (CLI socket, console), `core` (hortusd itself), `worker`, `planner`, `login`.
- **DOF**: a git-backed directory of Markdown files mirroring one source (a Slack workspace, a GitHub org, ...), one commit per sync, full-text indexed (`dof search`). `mirror/` writes them; `connectors/` fetch; `gateway/` runs connectors and webhooks and turns new messages into events.
- **Event**: a mirrored message that may wake the Planner. A bot's own events never do (loop guard).
- **Planner**: a model session that reads a **batch** of events and answers with verdict RPCs (create a task, add to one, ignore, notify the owner). `planner/`.
- **Worker**: a `hortus-agent` session doing one **task**. Task kinds (`TaskKind`): `chat` (the owner talks to it live), `unattended` (Planner-created), `run` (one firing of a schedule), `planner` (a batch). It runs on the host under Landlock or in a QEMU **Worker VM** (`runtime/`). It talks to hortusd through files in its task directory (`ctl/task.json`, `ctl/inbox/`, stdout lines).
- **Secret Vault / placeholder**: credentials live only in `vault.json`. Sessions see `hortus-secret-<name>`, and the **proxy** (`proxy/`) swaps in the real value only where a **transform** (`transforms/<name>/`, plus the `transforms` DOF a Worker can submit to) says it goes, and scrubs it from responses.
- **Approval Gate**: a request that uses a credential waits for approval (`vault/gate.ts`). `policy` is `human` (the owner decides on the Approvals page) or `auto` (a judge model decides). **Consequential** requests (push, merge, delete, ...) always ask. A **grant** lets a task's later routine requests through.
- **Tainted**: a task that read untrusted text (a stranger's message, a web page, an untrusted search hit) or can read a DOF holding some. The owner decides its gated requests, never the judge. `scope.dofs` limits the DOFs a task can read.
- **Project**: a repo or directory Workers change. Each has a local **origin** (`projects/<name>.git`). Workers push `hortus/<task>`, and `merge()` lands it on `main` through the gate. A non-git project gets a **shadow** repo. A forge project gets a mirrored bare clone (`projects/repos.ts`).
- **Schedule / run**: a Worker sets a recurring or scripted schedule. Each firing is a `run` task under the task that set it, and spends its budget.
- **Console**: the local web UI and `hortus` CLI (`console/`), with an optional remote listener enrolled by passkey.
