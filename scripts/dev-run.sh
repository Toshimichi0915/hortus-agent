#!/bin/sh
# Start a development copy of hortusd as a transient system unit with the capabilities the real unit has
# (hortus_v7.md › Process › Dev run). Needs passwordless sudo.
#   scripts/dev-run.sh <name> <HORTUS_HOME> [env=value ...]
# Stop with: sudo systemctl stop hortusd-<name>; logs: journalctl -u hortusd-<name> -f
set -e
name="$1"; home="$2"; shift 2
[ -n "$name" ] && [ -n "$home" ] || { echo "usage: $0 <name> <HORTUS_HOME> [env=value ...]" >&2; exit 64; }
root="$(cd "$(dirname "$0")/.." && pwd)"
node="$(command -v node)"
mkdir -p "$home"
envs="-E HORTUS_HOME=$home -E HOME=$HOME -E PATH=$PATH"
for e in "$@"; do envs="$envs -E $e"; done
# shellcheck disable=SC2086
sudo systemd-run --unit "hortusd-$name" --uid "$(id -u)" --gid "$(id -g)" \
  -p "AmbientCapabilities=CAP_NET_ADMIN CAP_NET_BIND_SERVICE" \
  -p "CapabilityBoundingSet=CAP_NET_ADMIN CAP_NET_BIND_SERVICE" \
  -p SupplementaryGroups=kvm -p Delegate=yes -p KillMode=mixed -p LimitNOFILE=65536 \
  $envs "$node" "$root/dist/bin/hortusd.js"
echo "started hortusd-$name (HORTUS_HOME=$home); stop: sudo systemctl stop hortusd-$name"
