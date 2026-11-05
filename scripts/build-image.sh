#!/bin/sh
# The Worker VM image (docs/design/13-worker-vm.md): $HORTUS_HOME/images/{agent.ext4,initramfs.img,vmlinuz}.
# Run as root (`sudo hortus image build [--no-browser]`). Idempotent: every run rebuilds from scratch in a temp dir and
# replaces the three files at the end. Needs a built tree (`pnpm build`) and the hortus CA ($HORTUS_HOME/ca/ca.crt).
set -eu

browser=chromium
[ "${1:-}" = "--no-browser" ] && browser=
[ "$(id -u)" = 0 ] || { echo "build-image: must run as root (sudo)" >&2; exit 1; }
repo=$(cd "$(dirname "$0")/.." && pwd)
home=${HORTUS_HOME:-$(getent passwd "${SUDO_USER:-root}" | cut -d: -f6)/.hortus}
images=$home/images
ca=$home/ca/ca.crt
[ -f "$ca" ] || { echo "build-image: $ca missing (hortusd creates it at its first start)" >&2; exit 1; }
[ -f "$repo/dist/bin/hortus-agent.js" ] || { echo "build-image: $repo/dist missing: run pnpm build" >&2; exit 1; }
kernel=/boot/vmlinuz-linux

work=$(mktemp -d /var/tmp/hortus-image.XXXXXX)
root=$work/root
cleanup() {
  umount -R "$root" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT INT TERM
step() { echo "==> [$(date +%T)] $*"; }

step "pacstrap into $root"
mkdir -p "$root"
# shellcheck disable=SC2086 # $browser is empty or one word
pacstrap -c "$root" base nodejs npm git ripgrep python ca-certificates nss $browser >"$work/pacstrap.log" 2>&1 ||
  { tail -30 "$work/pacstrap.log" >&2; exit 1; }

step "hortus-agent from npm pack"
pkg=$(cd "$repo" && npm pack --silent --pack-destination "$work" | tail -1)
mount --bind "$root" "$root" # arch-chroot wants a mountpoint
cp "$work/$pkg" "$root/var/tmp/hortus-agent.tgz"
arch-chroot "$root" npm i -g --loglevel=error --no-fund --no-audit --prefix /opt/hortus-agent /var/tmp/hortus-agent.tgz
rm "$root/var/tmp/hortus-agent.tgz"
for b in "$root"/opt/hortus-agent/bin/*; do ln -sf "/opt/hortus-agent/bin/$(basename "$b")" "$root/usr/local/bin/"; done

step "user agent, CA, network, mounts, unit"
arch-chroot "$root" useradd -m -u 1000 -U -s /bin/bash agent
install -m 644 "$ca" "$root/etc/ca-certificates/trust-source/anchors/hortus.crt"
arch-chroot "$root" update-ca-trust
install -m 644 "$ca" "$root/etc/ssl/certs/hortus.pem" # hortusd writes ca.crt 0600; the guest's agent reads this
echo "NODE_EXTRA_CA_CERTS=/etc/ssl/certs/hortus.pem" >>"$root/etc/environment"
arch-chroot "$root" runuser -u agent -- sh -c \
  'mkdir -p ~/.pki/nssdb && certutil -d sql:$HOME/.pki/nssdb -N --empty-password &&
   certutil -d sql:$HOME/.pki/nssdb -A -t C,, -n hortus -i /etc/ssl/certs/hortus.pem'

echo hortus-vm >"$root/etc/hostname"
echo "nameserver 10.77.0.1" >"$root/etc/resolv.conf"
cat >"$root/etc/gitconfig" <<'EOF'
[user]
	name = hortus
	email = hortus@localhost
[safe]
	directory = *
EOF
# plain `git clone https://<forge>/o/r.git` carries the forge's placeholder (as host.ts › sandboxEnv does on the host):
# one insteadOf per forge DOF in hortusd.json, with the user each forge wants (connectors/forge.ts › gitOf).
# ponytail: baked at build time; a forge added later needs `hortus image build` again (or a task.json-driven entry)
if [ -f "$home/hortusd.json" ]; then
  node -e '
const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).dofs ?? {};
const forges = { github: ["x-access-token", "github.com"], gitlab: ["oauth2", "gitlab.com"], bitbucket: ["x-token-auth", "bitbucket.org"] };
for (const [n, c] of Object.entries(d)) {
  const g = forges[c.type];
  if (!g) continue;
  const h = c.type === "bitbucket" ? g[1] : (c.host ?? g[1]);
  console.log(`[url "https://${g[0]}:hortus-secret-${n}@${h}/"]\n\tinsteadOf = https://${h}/`);
}' "$home/hortusd.json" >>"$root/etc/gitconfig"
fi
# eth0's address comes from the kernel's ip= argument: systemd-network-generator writes the .network file for networkd.
mkdir -p "$root/task/ctl" "$root/task/out" "$root/dof" "$root/repos" "$root/schedule"
cat >>"$root/etc/fstab" <<'EOF'
task-ctl  /task/ctl  virtiofs  ro,nofail  0 0
task-out  /task/out  virtiofs  rw,nofail  0 0
dof       /dof       virtiofs  ro,nofail  0 0
repos     /repos     virtiofs  ro,nofail  0 0
schedule  /schedule  virtiofs  rw,nofail  0 0
EOF
cat >"$root/etc/systemd/system/hortus-agent.service" <<'EOF'
[Unit]
Description=hortus Worker
Wants=network-online.target
After=network-online.target
WantsMountsFor=/task/ctl /task/out /dof /repos /schedule

[Service]
User=agent
WorkingDirectory=/home/agent
Environment=NODE_EXTRA_CA_CERTS=/etc/ssl/certs/hortus.pem HORTUS_TASK=/task/ctl/task.json
ExecStart=/usr/local/bin/hortus-agent --task /task
# microvm with acpi=off cannot power off: a reboot (reboot=t) makes QEMU exit under -no-reboot
ExecStopPost=+/usr/bin/systemctl reboot --no-block
StandardOutput=journal+console
StandardError=journal+console

[Install]
WantedBy=multi-user.target
EOF
arch-chroot "$root" systemctl enable systemd-networkd systemd-network-generator hortus-agent >/dev/null 2>&1
arch-chroot "$root" systemctl mask systemd-firstboot ldconfig getty.target >/dev/null 2>&1
arch-chroot "$root" systemctl set-default multi-user.target >/dev/null 2>&1
arch-chroot "$root" systemd-machine-id-setup >/dev/null 2>&1
echo "Storage=volatile" >>"$root/etc/systemd/journald.conf"
umount -R "$root" 2>/dev/null || true

step "packages"
pacman -r "$root" -Q nodejs npm git ripgrep python systemd $browser
rm -rf "$root/var/cache/pacman/pkg"/*

step "agent.ext4, initramfs, kernel"
mkdir -p "$images"
mkfs.ext4 -q -F -L hortus -d "$root" "$work/agent.ext4" 8G
cat >"$work/mkinitcpio.conf" <<'EOF'
MODULES=(virtio_mmio virtio_net virtio_blk virtiofs fuse)
BINARIES=()
FILES=()
HOOKS=(base udev autodetect modconf block filesystems)
COMPRESSION=zstd
EOF
mkinitcpio --nopost -k "$kernel" -c "$work/mkinitcpio.conf" -g "$work/initramfs.img" >"$work/mkinitcpio.log" 2>&1 ||
  { tail -30 "$work/mkinitcpio.log" >&2; exit 1; }
cp "$kernel" "$work/vmlinuz"
for f in agent.ext4 initramfs.img vmlinuz; do mv -f "$work/$f" "$images/$f"; done
if [ -n "${SUDO_UID:-}" ]; then chown -R "$SUDO_UID:$SUDO_GID" "$images"; fi
step "done: $(du -h --apparent-size "$images/agent.ext4" | cut -f1) apparent, $(du -h "$images/agent.ext4" | cut -f1) used"
