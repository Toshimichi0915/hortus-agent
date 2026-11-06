# hortus-agent: final report

hortus v6 is implemented and reviewed. The review loop ended at round 24 with nothing above nit. `main` is at `a58c964` (Nov 7, 2026), 208 commits, none pushed. Build and lint are clean. The default suite is 699 tests: 666 pass, 0 fail, 33 skipped (opt-in suites).

Read this with `hortus_v7.md`, which records every decision and every review round in full. This report is the summary.

## 1. What was built

One npm package, four bins. About 20,600 lines of TypeScript source and 30,100 lines of tests.

| Bin | Does |
| --- | --- |
| `hortusd` | The daemon. Mirrors sources into DOFs (git + FTS5), runs the Planner and Workers, holds the vault and the proxy, serves the console. |
| `hortus` | The console CLI: `tasks`, `chat`, `approvals`, `search`, `schedules`, `pause`, `install`, `image build`, … |
| `hortus-agent` | A Worker or Planner session on `@hortus/core@1.2.0`. |
| `dof` | Full-text search over the mirrors, from your shell or inside a task. |

Every v6 build step is done. The order and the step-by-step done-whens are in `docs/build-order.md`. Each step has a design doc in `docs/design/` with its implementation, functional tests, UI/UX checks and extensibility checks.

- **Sources:** Slack, Discord, Telegram, GitHub, GitLab, Bitbucket. Messages missed while hortusd or a connection was down are read back by the 10-minute reconcile and routed as if they came live.
- **Secret Vault and proxy:** every credential stays in `vault.json`. Sessions hold only `hortus-secret-<name>` placeholders. The proxy swaps them in where a transform says, scrubs responses, and meters every model call against the task's budget.
- **Approval Gate:** `human` (you decide each request) or `auto` (a judge model passes routine requests; consequential ones, merges, logins and tainted tasks still come to you).
- **Planner:** reads what arrives in batches and creates, attaches to, or closes tasks.
- **Workers:** on the host under Landlock, cgroups and nftables, or in a QEMU microVM.
- **Projects:** a local origin per project. A Worker pushes only its own branch, and `main` moves only when you approve a merge.
- **Schedules:** `at`, `every`, `cron`, with runs that report back to their task.
- **Browser:** headless Chromium for Workers, plus a login view you drive from the console. Cookies are captured into the vault.
- **Console:** a local web UI at `127.0.0.1:7700`, plus an optional remote console behind passkeys.

## 2. How to run it

```sh
pnpm install && pnpm build
dist/bin/hortus.js install            # writes /etc/systemd/system/hortusd.service with sudo
sudo systemctl enable --now hortusd
hortus image build                    # optional: the Worker VM image (Arch: pacstrap, mkinitcpio)
```

Then:
1. Open `http://127.0.0.1:7700`.
2. Set `hortusd.json` on the Settings page.
3. Add credentials on the Credentials page.
4. Check each source on the Sources page.

README has the minimal config, the credential table, and what each service needs on its side.

**Development daemon:**
- With network rules: `scripts/dev-run.sh <name> <HORTUS_HOME>`, a transient system unit with the real unit's capabilities.
- Without them: `HORTUS_NO_NET=1` with a scratch `HORTUS_HOME`.

Never point a development daemon at `~/.hortus`.

**Tests:** `pnpm test` runs the default suite, unit plus end-to-end against fake services. Opt-in suites:

| Variable | Runs |
| --- | --- |
| `HORTUS_TEST_NET=1` | nftables and session addresses (passwordless sudo; `--test-concurrency=1`) |
| `HORTUS_TEST_LLM=1` | live model calls (`HORTUS_TEST_MODEL`) |
| `HORTUS_TEST_VM=1` | Worker VMs (`HORTUS_TEST_IMAGES`; the image kept at `/var/tmp/hortus-vm-home/images`) |
| `HORTUS_TEST_SOAK=1` | the soak for `HORTUS_TEST_SOAK_MIN` minutes |
| `HORTUS_TEST_CHAOS=1` | random SIGKILLs of the daemon under owner orders |

## 3. Decisions you may want to override

v6 left these open or I changed them. Each was decided without asking you, as instructed. The reasons are in `hortus_v7.md`.

**Policy and cost**
- **`human` is the default policy, as v6 says, and it is expensive.** A PR from issue to merge took 25 to 55 decisions and 1 to 2M tokens in live walks. Under `"credential:github": "auto"` the same flow took 4 to 11. README recommends `auto` for credentials you trust a Worker with.
- **The `auto` judge uses the Planner's provider and model**, not a fixed Anthropic credential.
- **`planner.runtime`** is `host` until the VM image exists, then `vm`.

**Secrets**
- **Your `~/.hortus/secrets.json` is never touched.** v6 assumed it holds placeholders, but yours holds real keys for the standalone CLI. Each task gets its own `ctl/home/.hortus/secrets.json` with placeholders instead.

**What a Worker can reach**
- **Unattended Workers see an allowlist of `$HOME`, not a denylist.** This tightens v6's "ro on the rest". A Worker sees its project, the toolchain directories in `HOME_READ`, and `policy.read`. Its `$HOME` is its own empty directory. Chats keep v6's denylist.
- **`/tmp` is hidden from unattended Workers.** `TMPDIR` is the task's `out/tmp`. Use `"policy": { "cache": ["/tmp"] }` for tooling that hardcodes `/tmp`.
- **A chat can't connect to sockets in `/tmp`, `/var/tmp` or `/run/screen`.** This keeps it away from your tmux, screen, X and ssh-agent.
- **Workers share tool caches** in `$HORTUS_HOME/cache` (npm, cargo, gradle, Go modules).
- **`chat.allow` applies to every Worker, not only chats.** v6 contradicts itself here. It is your one list of private destinations, and an intranet forge needs it for unattended git.
- **Host sessions need Landlock ABI 9 or later.** An older kernel refuses host sessions instead of running them open.

**Approvals and merges**
- **`hortus approvals approve|reject` works from the CLI.** The socket is reachable only from your shell. A login can still be approved only in the console's login view.
- **Projects pre-clone.** Pre-cloning is the only way the clone gets write access in Landlock.
- **No `denyNonFastForwards` on the origin.** A Worker must force-push its rebased branch, and `main` is guarded by the hook instead.

**Task lifecycle**
- **A task with a PR ends when the PR ends**, whoever merges or closes it. If a stranger closes it, you are told.
- **A task stopped at its budget waits for you.** The Planner may not close it while any of its PRs is open. Raise the budget on the card and it goes on.
- **Failures reach you by DM and as a Planner row.** The Planner does not post in the thread the task came from.
- **Replies to a chat's post route back into that chat, trusted senders only.** This narrows v6: a stranger's reply would start a session on your files with nobody watching.

**Budgets and metering**
- **The proxy meters model calls.** It counts a Worker's own `curl` to its model, streamed or not. A response whose usage it can't read is charged by its bytes. A schedule's runs spend their parent task's budget.

**Other changes**
- **Proxy ports are 8443, 8080 and 8053, DNAT'd from 443, 80 and 53.** A root process on this machine holds 80 and 443.
- **The cookie origin is the registrable domain, without the Public Suffix List.** Host-only cookies are pinned to their exact host, so the shared-suffix problem is left only for `Domain=` cookies. Upgrade path: ship the PSL.
- **Added beyond v6:** `passkey.delete`, `/approvals/<id>/diff` for merges over 64 KB, `GET /dof/<dof>/<path>` for search hits, and the opt-in chaos test.

## 4. Known ceilings

These are recorded in v7 and graded as nits, each with its reason.

- A Worker can read `/proc/<pid>/cmdline` of its own processes. hortusd never puts a secret in an argv.
- A chat has your reach, minus a deny list. A list can't be complete, and you are watching a chat.
- A hung VM guest runs until its `hours` budget. A host session is killed at `hours` + 60 s.
- A Bitbucket merge can't be pinned to the approved sha. The API has no such option.
- Some rules are prompt lines, not code: merge as delivery, a follow-up on a closed task, reading a PR's state first. Live rates were 13 of 13 and 3 of 3, which is evidence, not a guarantee.
- A WebSocket to the model is not metered. `hours` bounds it.
- An edit made while a connection was down is mirrored but not routed.
- A Slack reply in a thread older than the reconcile cursor is not seen. The API lists only thread parents.

## 5. Not verified, needs you

- **None of the six connectors has run against the real service.** Each was built from the public API docs and tested against a fake. README › "What each service needs on its side" is the setup checklist.
- **The remote console's passkey hasn't been tried on a real phone.** A software authenticator was used.
- **`hortus install` was read but never run on this machine.** The live walks used `scripts/dev-run.sh`, which differs from the installed unit in four ways that README lists.
- **The login and enrolment pages were not rendered at phone width**, because Chromium refused the minted certificate.

## 6. How it was checked

**The loop:** 24 review rounds by fresh reviewer agents (Opus 5.5, medium effort), each fixing what it found and leaving a test it had seen fail. A round's new code then got a second reader. The loop ended when a round found nothing above nit.

**Grading:**
- **Above nit** means data lost or corrupted, a security boundary broken, a task stuck or the daemon down, a wrong result or misleading screen in normal use, or a v6 requirement unmet without a v7 decision.
- **Nit** means everything else, including a ceiling recorded in v7 with a sound reason.

**Live walks:** a transient system unit with real `hortus0` and nftables, Planner, Workers and judge on DeepSeek v4.1 Flash (`deepseek-v4.1-flash:1017` on `ollama.com`), with fake services behind `dev.upstreams`. Hundreds of flows were walked over the rounds. Round 23 alone walked about 40 on host and VM Workers.

**Final runs on the final source tree (`329aa73`; `a58c964` only adds docs):**

| Run | Result |
| --- | --- |
| `pnpm build && pnpm lint` | clean |
| default ×3 | 699 tests, 666 pass, 0 fail |
| `--test-concurrency=64` under 16 busy loops ×2 | 666 pass, 0 fail |
| `HORTUS_TEST_NET=1` | 667 pass, 0 fail |
| `HORTUS_TEST_LLM=1` | 674 pass, 0 fail |
| NET + LLM live files | 6 of 6 |
| VM / VM + NET | 23 pass / 14 pass, 0 fail |
| chaos | 10 of 10 runs at 10 kills (100 kills, 400 orders, none lost) |

Round 23 also ran a 30-minute soak on its final tree, and it passed.

**The intermittent `sandbox.test` failure** (`Could not find or load main class Tmp.java`) was not a product defect. The journal shows a terminal of yours in `ac-server` switched the system Java to 8 at 10:13 on Nov 6, and back to 21 at 10:21. Java 8 can't run a source file directly, and both failures fell in that window. The test now compiles with `javac` first.

## 7. Things you should know

- **Your vault:** `hortus_v6.md` has my uncommitted edit to its Build order table, plus a "Parallel work" paragraph. The untracked `hortus_v6_ja.md` there is not mine.
- **Your real key:** only the `ollama-cloud` entry of `~/.hortus/secrets.json` was read, by the test helper and the walk drivers, and copied into temp vaults.
  - In round 17 a live model printed a temp `secrets.json` holding that key, and the output went to Ollama's API.
  - No other real credential was read or sent.
- **Real services reached:**
  - `ollama.com`, for the model.
  - `ollama.com` once more with a placeholder key, which was rejected with a 401.
  - `slack.com` once, with a fake's made-up token, from a misconfigured run.
  - The npm registry, anonymously, during one pnpm run.
  - Forks downloaded checksum-verified `glab`, `git-lfs`, cargo, mise and asdf binaries for toolchain tests.
- **Processes I killed:** two orphaned Chromium crashpad handlers and one leftover test daemon, each by pid after checking what it held. Never by name.
- **Files deleted:** a fork deleted an empty `/tmp/x`. I removed three temp homes our own tests left in `/tmp` on Nov 6.
- **Git history:**
  - A `node_modules` symlink was committed by mistake in round 22 (`3290d70`) and removed in `1c42601`. It stays in history.
  - Commits before `ef0b020` end with a `Claude-Session` line. Later ones end with only `Co-Authored-By`.
- **Interruptions:** your reboot on Nov 6 and two API rate limits cut the work off. It resumed each time, and the only loss was one live walk, which was redone.
- **System state now:** no hortus units, no `hortus0`, no `inet hortus` table, no fixture users or homes, no worktrees or extra branches. `/var/tmp/hortus-vm-home` holds the VM image built on round 23's final tree. Remove it if you don't want it.
