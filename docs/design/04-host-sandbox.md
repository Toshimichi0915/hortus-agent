# F4 — Host sandbox: Landlock shim, profiles, cgroups, session network

Spec: v6 › Process (one uid), Network (host sessions), Security › Host. Depends on F0; F3's `net.ts` for the shared nftables table. Wired in step 3.

## Implementation

### `native/landlock.c` → `dist/hortus-landlock`

Usage: `hortus-landlock -- <cmd> [args…]` with the profile on fd 3, one directive per line:

```
cgroup /sys/fs/cgroup/system.slice/hortusd.service/tasks/<id>
ro /usr
rw /home/me/.hortus/tasks/<id>/out
scope signal
scope abstract
end
```

Steps, in this order: read all lines (a line over 4096 bytes or an unknown directive → exit 64 with a message); if `cgroup`: write `getpid()` to `<cgroup>/cgroup.procs` (failure → exit 65); query the ABI (`landlock_create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION)`); build `handled_access_fs` = every right the ABI knows (v1 13 rights, +REFER v2, +TRUNCATE v3, +IOCTL_DEV v5) and `scoped` = `LANDLOCK_SCOPE_SIGNAL | LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET` when the ABI ≥ 6 and the profile asks; for each `ro`/`rw` path: `open(O_PATH|O_CLOEXEC)` (ENOENT → skip), `fstat`, rights = read set (`READ_FILE|READ_DIR|EXECUTE`) or read+write set (`+WRITE_FILE|REMOVE_DIR|REMOVE_FILE|MAKE_*|REFER|TRUNCATE|IOCTL_DEV`) masked to file-applicable rights when not a directory; `landlock_add_rule`; `prctl(PR_SET_NO_NEW_PRIVS, 1)`; `landlock_restrict_self`; `execvp`. No ABI (ENOSYS/EOPNOTSUPP) → exit 66: `hortusd` refuses to start host sessions on such a kernel rather than running them open. Constants are defined under `#ifndef` so the file builds against older headers. ~200 lines, no dependencies, `cc -O2 -Wall`.

### `src/runtime/landlock.ts` — profile builder

```ts
profile(kind: "unattended" | "chat", task: { id: string; clone?: string; schedule?: string; cgroup: string }): string   // the directive text
```

- `deny` = v7's deny set (Security) + `config.policy.deny`, as absolute existing paths; `~/.hortus` is denied as a whole with carve-outs `dof/<name>` and `dof/<name>.git` for each DOF in task.json's `scope.dofs` (v7 › Review round 7; never the DOF root), `repos/`, `tasks/<id>/ctl`, `tasks/<id>/out`, `clones/<id>`, `schedules/<id>`.
- `grant(dir, mode)`: if no denied path lies under `dir` → one directive for `dir`; else one directive per entry of `dir` that is not itself denied, recursing into entries that contain a denied path. Applied to `/`.
- `$HOME` of an unattended session (`host.ts › caches`): `out/work/.cache/home`, with `HOME_READ` linked into it (not `.local/*`); `PATH` is the task's own bins, `ctl/bin`, version managers' shims, the unit's, the usual bin directories. `.cache/.gitignore` keeps all of it out of a `git add -A` in `work`.
- Modes: `unattended`: `ro` on `/` less `$HOME`, `HIDDEN` (`/home`, `/mnt`, `/media`, `/run/media`, `/srv`, `/tmp`, `/var/tmp`, `/var/log`, `/var/mail`, `/var/spool`, core dumps, `/var/lib/libvirt`, `/sys/firmware`) and every other project's checkout, then `ro` on what is shown: the task's own project, the running `node`, `HOME_READ` (toolchains), `policy.read` (v7 › Review round 16); `HOME` is `out/work/.cache/home`, the toolchains' roots stay (`RUSTUP_HOME`, `PYENV_ROOT`, …); `rw` for the clone, `out`, the schedule dir (`GOPATH`, `XDG_DATA_HOME` and the JVM's `java.io.tmpdir` point into `out`); `rn` for `/dev/{null,zero,full,random,urandom,tty,shm}`, the Workers' shared caches under `$HORTUS_HOME/cache` and `config.policy.cache`; `/tmp` is unreachable (`TMPDIR` is `out/tmp`) and the rest of `/dev` too (tool homes are task-local under `out/work/.cache`: v7 › Security › Host, rounds 14 and 15); `chat`: everything `rw` except the deny set, `/dev/pts` and `/dev/input`. A carve-out under a denied directory (`~/.hortus/dof`) is granted explicitly with its mode. Both: `scope signal`, `scope abstract`.
- Symlinks: Landlock works on the opened path, so `/bin → usr/bin` style links need no special care; a denied path given as a symlink is resolved with `realpath` first.

### `src/runtime/cgroup.ts`

`base()` = `/sys/fs/cgroup` + the `0::` line of `/proc/self/cgroup`. `create(id)` → `mkdir -p <base>/tasks/<id>`, returns the path; `kill(id)` → write `1` to `cgroup.kill`, poll `cgroup.procs` until empty (max 5 s), `rmdir`; `pids(id)`; `depth(path)` for nftables (`level`). Delegation is systemd's (`Delegate=yes`; in `systemd-run --user --scope -p Delegate=yes` for tests).

### `src/runtime/session-net.ts`

`open(task, cgroupPath)`: allocate `n` (2–254, first free), `net.addAddress(10.77.1.n)`, `proxy.listen(10.77.1.n)`, `links.register(10.77.1.n, role, task, "session")`, nftables rules in `inet hortus` for `socket cgroupv2 level <depth> "<path relative to /sys/fs/cgroup>"`:

```
nat:  udp dport 53 dnat ip to 10.77.1.n:8053          (ports: config `proxy`, v7 › Security › Network)
      ip daddr 10.77.1.n tcp dport 80 dnat ip to 10.77.1.n:8080
      ip daddr 10.77.1.n tcp dport 443 dnat ip to 10.77.1.n:8443
out:  ip daddr 10.77.1.n tcp dport { 8080, 8443 } accept
      ip daddr 10.77.1.n udp dport 8053 accept
      ip daddr 127.0.0.1 tcp dport 7700 drop
      ip daddr 127.0.0.0/8 accept
      ip6 daddr ::1 accept        # minus the console's and the remote listener's ports (3d adds them)
      ip daddr { chat.allow… } accept     (chat and unattended alike: the list is the owner's)
      drop
```

plus, installed once at start after the session rules' position: `ip daddr 10.77.1.0/24 drop` for every other cgroup (hortusd's own excluded by cgroup match of its base). Rules carry `comment "hortus:<task>"`; `close(task)` deletes by comment (`nft -a list chain` → handles), unlistens, releases the address. On start, stale rules with a `hortus:` comment are flushed.

### `src/runtime/host.ts`

```ts
spawnSandboxed(opts: { task: TaskJson; kind: "unattended" | "chat"; cmd: string[]; cwd: string; env: Env; onStdout(line) }): Child  // { pid, wait(): Promise<exit>, kill() }
```

Creates the cgroup, the session address, writes the profile to the shim's fd 3, spawns `hortus-landlock -- node <dist>/bin/hortus-agent.js --task <dir>` with env: real `HOME` (chat; unattended its own), `PATH` (`host.ts › sessionPath`: hortusd's plus the owner's usual bin directories), `LANG`, `TERM=dumb`, `HORTUS_TASK=<ctl/task.json>`, CA variables (`SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, `GIT_SSL_CAINFO`, `CURL_CA_BUNDLE`, `REQUESTS_CA_BUNDLE` → `ca/ca.crt` — readable: `~/.hortus/ca` is denied, so the cert is copied to `tasks/<id>/ctl/ca.crt`), `GIT_CONFIG_COUNT` with `user.name=hortus`, `user.email=hortus@localhost`, `credential.helper=`, `safe.directory=*`, one `url.https://<user>:hortus-secret-<dof>@<host>/.insteadOf=https://<host>/` per configured forge (6), `GH_TOKEN=hortus-secret-github` when configured. stdout lines go to `onStdout`, stderr to `out/console.log`. `wait()` resolves with the exit code; `kill()` = `cgroup.kill`. The session address and rules are released after the cgroup is empty.

## Functional tests

Shim and profiles (no capabilities; inside `systemd-run --user --scope -p Delegate=yes` when available, else the cgroup directive is omitted and that assertion skipped):

- A child under `unattended` with `HORTUS_HOME` as the home: `cat vault.json` → EACCES; `cat hortusd.json` → EACCES; `ls tasks/<other>` → EACCES; `cat dof/slack/C1/channel.md` → ok; `touch out/x` → ok; `touch <clone>/x` → ok; `touch ~/x` → EACCES; `touch /tmp/x` → EACCES; `echo > /dev/null` → ok; with a fixture `HOME`: `~/.claude/.credentials.json`, a new directory nobody listed and another project's `.env` → EACCES, a toolchain in `~/.nvm` runs, also through a link from `~/.local/bin`, a link out of the list → EACCES until `policy.read` names it; a file created in a denied directory after spawn is still unreachable.
- Under `chat`: `touch ~/x` → ok; `cat ~/.ssh/id_ed25519` → EACCES; `cat ~/.hortus/secrets.json` → EACCES; `cat vault.json` → EACCES.
- Scoping: the child cannot `kill -0 <hortusd pid>` (EPERM) and `connect` to the abstract socket fails (EPERM); it cannot write to `/sys/fs/cgroup/...` (EACCES, the path is denied).
- `cgroup.kill` ends a child that forked a `sleep 1000` grandchild; `pids()` lists both before.
- The shim refuses an unknown directive, a missing `--`, a profile over 1 MB, and runs without any `ro`/`rw` line (everything denied; `exec` of the command itself fails with EACCES — the test asserts the exit code).
- The ABI query result is logged once at start; a mocked ENOSYS makes `spawnSandboxed` throw and the daemon log says why.
- `profile()`: output contains no path under a denied directory except carve-outs; every emitted path exists; each `scope.dofs` DOF (and its `.git`) appears as `ro`, the DOF root and other DOFs never and `tasks/<id>/out` as `rw`; the chat profile has no `ro` lines except carve-outs that are read-only by design (`dof`, `repos`, `ctl`); a `policy.deny` entry that is a symlink is denied by its target.

Network (`HORTUS_TEST_NET=1`, under `scripts/dev-run.sh`):

- From the session cgroup: `curl https://slack.com` resolves to `10.77.1.n` and reaches the proxy; `curl http://127.0.0.1:7700/` is dropped (times out, no RST); `curl http://127.0.0.1:<other port>` works; `curl http://10.77.1.n+1` (another session) is dropped; `curl http://192.168.24.1` is dropped unless in `chat.allow`; `dig @1.1.1.1 example.com` is answered by the proxy's DNS (DNAT); IPv6 to `2606:4700::1111` is dropped.
- From the owner's shell (another cgroup): `curl http://10.77.1.n` is dropped; hortusd itself still binds the address.
- `close()` removes the rules (`nft list ruleset` has no `hortus:<task>` comment), the address, and the listener; a daemon restart flushes stale `hortus:` rules.

Edge cases: 253 concurrent sessions exhaust addresses → `open()` throws `no session address free` and the task stays `queued`; a cgroup path with a space; the shim's fd 3 closed early by the parent (profile truncated → the shim exits 64 rather than running open).

## UI/UX verification

- `out/console.log` of a session that failed to sandbox contains the shim's one-line reason, and the task card shows it (step 3).

## Extensibility verification

- A new profile (v6 Deferred: confined chat) is a `kind` and a mode table row in `landlock.ts`; the shim does not change.
- `policy.deny`, `policy.cache` and `policy.read` let the owner extend the sets from Settings without code.
- The shim speaks a line protocol, so a future vsock/VM launcher or a different sandbox can reuse the profile builder.

**Round 22.** A chat's `/tmp`, `/var/tmp` and `/run/screen` are `rn`, not `rw`: `landlock.ts › SHARED`. A session's own sockets there still answer it. A host session is killed at its `hours` plus `HOST_GRACE` (60 s), as QEMU is at its deadline.
