#!/bin/bash
set -euo pipefail
data=${DATA_DIR:-/config}
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
probe="wgcheck$$"
active=false
cleanup() {
    local status=$1
    trap - EXIT
    rm -f /run/wireguard-ready "$data/.ready"
    ip link del "$probe" 2>/dev/null || true
    if $active; then wg-quick down "$data/wg_confs/wg0.conf" || true; fi
    exit "$status"
}
trap 'cleanup "$?"' EXIT
trap 'exit 0' TERM INT
rm -f /run/wireguard-ready "$data/.ready"
if ! ip link add "$probe" type wireguard; then
    echo 'Host WireGuard support and NET_ADMIN are required. Enable the host kernel module before starting this package.' >&2
    exit 1
fi
WG_VALIDATE_INTERFACE=$probe "$here/configure.sh"
ip link del "$probe"
wg-quick up "$data/wg_confs/wg0.conf"
active=true
touch /run/wireguard-ready "$data/.ready"
echo 'WireGuard is ready.'
while "$here/healthcheck.sh"; do
    sleep 30 &
    wait "$!"
done
echo 'WireGuard interface is no longer healthy.' >&2
cleanup 1
