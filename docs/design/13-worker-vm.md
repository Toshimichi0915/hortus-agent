# Step 3g (v6 step 5) — Worker VM: image, boot, virtiofs, taps

Spec: v6 › Security › VM, Process › Network (VM links), Worker (runtimes), Mount. Depends on step 3 (ctl/out protocol) and F3 (proxy on `10.77.0.1`). Parallel with 3b–3f, 3h. Needs `/dev/kvm` and `sudo` once for the image build.

## Implementation

### Image (`scripts/build-image.sh`, run with sudo by `hortus image build`)

1. `pacstrap -c <dir> base linux-firmware-free? no: base nodejs npm git ripgrep python chromium ca-certificates` (no kernel package: the host kernel is used) into a work dir; `systemd` comes with `base` (init = systemd, simplest; the unit below).
2. Install `hortus-agent` from `npm pack` of this repository into `/opt/hortus-agent` (`npm i -g` the tarball) so `hortus-agent` and `dof` are on `PATH`.
3. Trust the hortus CA: `/etc/ca-certificates/trust-source/anchors/hortus.crt` + `update-ca-trust`; `NODE_EXTRA_CA_CERTS=/etc/ssl/certs/hortus.pem` in `/etc/environment`; Chromium's NSS db for the `agent` user (`certutil -A` from `nss`).
4. User `agent` (uid 1000), `~/.hortus/secrets.json` with placeholders is not needed (the task's `ctl/home` is used, v7), only the mounts.
5. Network: `systemd-networkd` on `eth0` with a `10.77.x.2/30` address learned from the kernel command line (`ip=` argument parsed by a tiny oneshot unit) and default route `10.77.x.1`; `/etc/resolv.conf` → `nameserver 10.77.0.1`? No: the VM's DNS and proxy are the host end of its link (v6: the proxy identifies the client by peer address; listeners are on `10.77.0.1`; the VM's default route is the host end, and `10.77.0.1` is reached through it). `resolv.conf` → `10.77.0.1`.
6. `hortus-agent.service`: `After=network-online.target`, `ExecStart=/usr/bin/hortus-agent --task /task`, `ExecStopPost=/usr/bin/systemctl poweroff`, `User=agent`; mounts from `/etc/fstab`: `task-ctl /task/ctl virtiofs ro`, `task-out /task/out virtiofs rw`, `dof /dof virtiofs ro`, `repos /repos virtiofs ro`, `schedule /schedule virtiofs rw,nofail`.
7. `mkfs.ext4 -d <dir> images/agent.ext4 8G`; `mkinitcpio -k /boot/vmlinuz-linux -c <conf with MODULES=(virtio_mmio virtio_net virtio_blk virtio_fs fuse) HOOKS=(base udev autodetect modconf block filesystems)> -g images/initramfs.img`; `cp /boot/vmlinuz-linux images/vmlinuz`. The script is idempotent and prints the image's package versions. Chromium adds ~400 MB; `--no-browser` skips it.

### `src/runtime/vm.ts`

`start(task): Child`:

- Link: `n` = first free tap index; `ip tuntap add hortus-t<n> mode tap user <owner>`; `10.77.<n/64+2>.<(n%64)*4+1>/30` on the host end (so 64 links per /24 under `10.77.2–5`), up; `rp_filter=1` on the tap; nft rules for the link (F3's `net`: accept TCP 80/443 and UDP 53 to `10.77.0.1`, drop the rest, forward chain drop) and `links.register(<VM address>, role, task, "vm")`. The proxy also `listen`s on each host end address? No: the VM reaches `10.77.0.1` via its default route over the point-to-point link; `10.77.0.1` is on the dummy interface and routable locally. DNS answers with `10.77.0.1` (the listener's own address).
- virtiofsd: one `virtiofsd --sandbox namespace --socket-path tasks/<id>/vfs/<tag>.sock --shared-dir <path> [--readonly]` per share (`task-ctl`, `task-out`, `dof` (a per-task view: one directory per `scope.dofs` DOF, each bind-mounted read-only from `~/.hortus/dof/<name>` inside an unprivileged user and mount namespace around virtiofsd, `vm.ts › virtiofsd`; v7 › Review round 7; microvm has 8 virtio-mmio slots, so one share per DOF does not fit), `repos`, `schedule` for runs). The sockets live outside every share (a guest cannot plant anything at their paths).
- QEMU: `qemu-system-x86_64 -M microvm,accel=kvm,acpi=off -cpu host -smp <cpus> -m <mem_mb> -kernel images/vmlinuz -initrd images/initramfs.img -append "console=ttyS0 root=/dev/vda rw quiet reboot=t panic=1 ip=<vm>::<host>:255.255.255.252::eth0:off" -drive id=root,file=images/agent.ext4,format=raw,if=none -device virtio-blk-device,drive=root -snapshot -netdev tap,id=n0,ifname=hortus-t<n>,script=no,downscript=no -device virtio-net-device,netdev=n0 -object memory-backend-memfd,id=mem,size=<mem_mb>M,share=on -numa node,memdev=mem -chardev socket,id=vfs0,path=<sock> -device vhost-user-fs-device,chardev=vfs0,tag=task-ctl … -nographic -serial file:<out>/console.log -nodefaults -no-reboot`. QEMU is a child of `hortusd` in the task's cgroup (created as for host tasks; no Landlock).
- The Worker inside reads `/task/ctl/task.json` with VM paths (`paths.dof = /dof` etc.; the dispatcher writes a VM variant of `task.json`).
- Exit: QEMU exits on poweroff (`-no-reboot`); the dispatcher's exit handling is the host one (outbox, log, status). `kill()` = `cgroup.kill` (QEMU and virtiofsd), then the tap and rules are removed. `hours` → kill at the budget (`hortusd` kills QEMU when the task's hours run out, v6).
- `max_concurrent` enforced by the dispatcher; `PAUSED` as for host tasks.
- Guest exit (round 10): QEMU exits 0 however the guest's service ended, so `hortus-agent` writes its exit code to `out/ended` last; a guest that left none exits 1 with `guest died: …` (an image older than round 10 reports every session so: rebuild it).
- Guest crashes (round 11): `panic=1` on the kernel line, so a panic reboots and ends QEMU (`-no-reboot`) instead of spinning until `hours`; any virtiofsd exit ends the VM (`virtiofsd exited: …`); a signal on QEMU names itself. A guest that hangs without panicking runs until `hours` or a STOP (v7 › Review round 11).
- Boot timeout (round 5): the guest's hortus-agent writes `out/booted` at its start; without it after `vm.boot_timeout_s` (120) the VM is killed and the task waits with `boot timeout: …` and the `console.log` tail.

### Planner VM (`planner.runtime = "vm"`)

Step 4's Planner batch directory is started with `vm.start` and role `planner` on its link; the same image. It occupies a `max_concurrent` slot while it runs but never waits for one (v7).

## Functional tests

- Boot: a VM task with a fake-provider plugin copied into `ctl/home/.hortus/plugins` boots, the agent runs, `done` writes the outbox, the VM powers off, and the whole cycle takes under 15 s (boot about 1–3 s with KVM; the test asserts < 15 s to leave slack).
- v6 done-when: a VM task on a git project clones the origin through `https://hortusd.internal/git/<name>` (the pre-receive sees role worker and the task), pushes `hortus/<id>`, `merge()` opens the entry, approve lands; `kill -9` of QEMU mid-run → the task is `queued` at the next tick, a new VM boots on the same `out/` and the session resumes (the fake provider asserts the earlier messages).
- Isolation: inside the VM `curl https://example.com` resolves to `10.77.0.1`, reaches the proxy and gets the `origins` treatment; `curl http://10.77.0.1:7700/` is refused by nft (not the console port: it is bound to 127.0.0.1 on the host, so the VM's packet is dropped); `ping 1.1.1.1` fails; a second VM's address is unreachable; `/task/ctl` is read-only (`touch` → EROFS); `/dof` is read-only; writes to `/task/out/work` persist after poweroff; writes to `/` are gone after poweroff (`-snapshot`).
- virtiofs: a DOF sync during the run is visible inside the VM within a second (a file appears without remount); `git status` on a 10k-file clone in `work/` completes under 5 s.
- Budget hours: `hours = 0.01` → QEMU killed after ~36 s and the task `waiting` with `budget_exceeded` noted by hortusd (the Worker could not write it).
- Links: 2 VMs get distinct /30s; releasing one frees the tap for the next; stale `hortus-t*` taps are deleted at daemon start.
- Image build: the script fails loudly without `sudo`; a rebuilt image keeps the same CA; `hortus image build --no-browser` produces a smaller image that still passes the boot test.
- `max_concurrent = 1`: a second VM task stays `queued` until the first exits.

## UI/UX verification

- The task card shows `runtime: vm`, the VM's uptime, and a "console.log" fold with the serial output; a boot failure (missing image) shows "images/agent.ext4 missing: run `hortus image build`" on the card and in the log.
- `hortus image build` prints progress per step and the final image size.

## Extensibility verification

- Firecracker (v6 Deferred) replaces `vm.ts`'s command line and the shares with vsock; the dispatcher's `start/kill/wait` contract and the task directory do not change.
- A share is one entry in a table (tag, path, ro); a run's `/schedule` is that one line.
