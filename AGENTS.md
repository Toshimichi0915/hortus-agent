# AGENTS.md

hortus-agent implements hortus v6 (`hortus_v6.md` in the owner's vault; `hortus_v7.md` here records the decisions made while building). One npm package, four bins: `hortusd` (daemon: DOF mirrors, Secret Vault and proxy, console), `hortus` (console CLI), `hortus-agent` (Worker and Planner on `@hortus/core`), `dof` (search CLI).

Read `docs/build-order.md` for the order and `docs/design/*.md` for each step's design before touching its code.

## Commands

```sh
pnpm build          # tsc -b, then the Landlock shim, transforms and static files into dist/
pnpm test           # build, then node --test over dist/**/*.test.js
pnpm lint           # biome lint
pnpm format         # biome format --write
```

Tests run from compiled `dist/`, so build first. One file: `pnpm build && node --test dist/db.test.js`. Tests use `node:test` + `node:assert/strict`, colocated as `*.test.ts`. End-to-end tests (`src/e2e/`) run a real `hortusd` under `HORTUS_NO_NET=1` in a delegated user scope (`systemd-run --user --scope`) with fakes behind `dev.upstreams` and a fake provider plugin; they are in the default suite. Opt-in, skipped otherwise: `HORTUS_TEST_NET=1` (nftables and session addresses; passwordless sudo), `HORTUS_TEST_LLM=1` (live model calls; `HORTUS_TEST_MODEL`), `HORTUS_TEST_VM=1` (boots a Worker VM; `HORTUS_TEST_IMAGES` = the image directory, default `$HORTUS_HOME/images`). `KEEP=1` keeps an e2e test's fake directory (its `hortusd.log`).

## Conventions

Same as hortus: source imports use `.ts` extensions (`rewriteRelativeImportExtensions`); ESM only; `verbatimModuleSyntax` (use `import type`); `noUncheckedIndexedAccess`; prefer `interface` over `type` for object shapes; biome: 2-space indent, 120 cols, double quotes, organized imports; `// ponytail:` comments mark deliberate shortcuts with a known ceiling and upgrade path. No new dependencies without a note in `hortus_v7.md`. `node:sqlite` is the database (silence its experimental warning in the bins only).

`HORTUS_HOME` relocates the daemon's state (`~/.hortus` by default); every test uses a temp `HORTUS_HOME`. The owner's real `~/.hortus/secrets.json` is never read or written by this code.

## Layout

`src/types.ts` holds every cross-module contract (events, changes, connectors, task.json, transforms, RPC caller). `src/<area>/` per design doc: `mirror/`, `gateway/` (the connector loop, webhook listener), `connectors/`, `vault/`, `proxy/`, `runtime/`, `agent/`, `console/`, `planner/`, `schedules/`, `projects/`, `browser/`; `src/bin/` the four bins; `src/e2e/` the per-step end-to-end tests. `transforms/<name>/` are the shipped transforms (copied to `dist/transforms`). `src/test/fakes/` are fake upstream services (Slack, Discord, Telegram, GitHub, a cookie site; compiled with the rest, so tests can import them). `native/landlock.c` builds to `dist/hortus-landlock`. `scripts/`: `build.sh` (what `pnpm build` runs), `build-image.sh` (the VM image), `dev-run.sh` (the daemon in a capability-bearing unit).
