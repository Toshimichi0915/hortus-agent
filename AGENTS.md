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

Tests run from compiled `dist/`, so build first. One file: `pnpm build && node --test dist/db.test.js`. Tests use `node:test` + `node:assert/strict`, colocated as `*.test.ts`. Tests that need capabilities or sudo are opt-in (`HORTUS_TEST_NET=1`, `HORTUS_TEST_LLM=1`, `HORTUS_TEST_VM=1`) and skip otherwise.

## Conventions

Same as hortus: source imports use `.ts` extensions (`rewriteRelativeImportExtensions`); ESM only; `verbatimModuleSyntax` (use `import type`); `noUncheckedIndexedAccess`; prefer `interface` over `type` for object shapes; biome: 2-space indent, 120 cols, double quotes, organized imports; `// ponytail:` comments mark deliberate shortcuts with a known ceiling and upgrade path. No new dependencies without a note in `hortus_v7.md`. `node:sqlite` is the database (silence its experimental warning in the bins only).

`HORTUS_HOME` relocates the daemon's state (`~/.hortus` by default); every test uses a temp `HORTUS_HOME`. The owner's real `~/.hortus/secrets.json` is never read or written by this code.

## Layout

`src/types.ts` holds every cross-module contract (events, changes, connectors, task.json, transforms, RPC caller). `src/<area>/` per design doc: `mirror/`, `connectors/`, `vault/`, `proxy/`, `runtime/`, `agent/`, `console/`, `planner/`, `schedules/`, `projects/`, `browser/`. `transforms/<name>/` are the shipped transforms (copied to `dist/transforms`). `test/fakes/` are fake upstream services (Slack first). `native/landlock.c` builds to `dist/hortus-landlock`.
