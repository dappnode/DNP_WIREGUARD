#!/bin/bash
set -euo pipefail
umask 077
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
export DATA_DIR="$work/config" PEERS=dappnode_admin SERVERURL=example.org SERVERPORT=51820
export PEERDNS=172.33.1.2,10.20.0.2 INTERNAL_SUBNET=10.24.0.0
export ALLOWEDIPS=172.33.0.0/16,10.20.0.0/24 PUID=1000 PGID=1000
configure=/usr/local/lib/wireguard/configure.sh
fail() { echo "Configuration test failed: $*" >&2; exit 1; }
hashes() { find "$DATA_DIR" -type f | sort | xargs sha256sum; }
"$configure"
before=$(hashes)
"$configure" --preflight
[[ $(hashes) == "$before" ]] || fail 'preflight changed files'
"$configure"
[[ $(hashes) == "$before" ]] || fail 'non-idempotent render'
key=$(cat "$DATA_DIR/peer_dappnode_admin/privatekey-peer_dappnode_admin")
psk=$(cat "$DATA_DIR/peer_dappnode_admin/presharedkey-peer_dappnode_admin")
PEERS=dappnode_admin,laptop "$configure"
grep -Fq 'Address = 10.24.0.3' "$DATA_DIR/peer_laptop/peer_laptop.conf" || fail 'address allocation'
PEERS=laptop "$configure"
! grep -Fq '# peer_dappnode_admin' "$DATA_DIR/wg_confs/wg0.conf" || fail 'peer not revoked'
"$configure"
[[ $(cat "$DATA_DIR/peer_dappnode_admin/privatekey-peer_dappnode_admin") == "$key" ]] || fail 'identity rotated'
[[ $(cat "$DATA_DIR/peer_dappnode_admin/presharedkey-peer_dappnode_admin") == "$psk" ]] || fail 'PSK rotated'
grep -Fq 'Address = 10.24.0.2' "$DATA_DIR/peer_dappnode_admin/peer_dappnode_admin.conf" || fail 'address changed'
PEERS='' "$configure"
! grep -q '^\[Peer\]' "$DATA_DIR/wg_confs/wg0.conf" || fail 'empty peer list is not a server'
"$configure"
SERVERURL=new.example.org SERVERPORT=51821 "$configure"
grep -Fq 'Endpoint = new.example.org:51821' "$DATA_DIR/peer_dappnode_admin/peer_dappnode_admin.conf" || fail 'endpoint update'
[[ $(cat "$DATA_DIR/server/privatekey-server") == $(sed -n 's/^PrivateKey = //p' "$DATA_DIR/wg_confs/wg0.conf") ]] || fail 'server identity differs'
INTERNAL_SUBNET=10.25.0.0 "$configure"
grep -Fq 'Address = 10.25.0.2' "$DATA_DIR/peer_dappnode_admin/peer_dappnode_admin.conf" || fail 'subnet change did not preserve host ID'
"$configure"
before=$(hashes)
for args in 'PEERDNS=auto' 'SERVERPORT=99999' 'INTERNAL_SUBNET=999.1.1.0' 'PEERS=bad/name' 'PEERS=dappnode_admin,dappnode_admin' "SERVERURL=\$(touch /tmp/wg-injection)"; do
    if env "$args" "$configure" >/dev/null 2>&1; then fail 'invalid input accepted'; fi
    [[ $(hashes) == "$before" ]] || fail 'invalid input changed files'
done
[[ ! -f /tmp/wg-injection ]] || fail 'shell injection executed'
cp "$DATA_DIR/peer_dappnode_admin/peer_dappnode_admin.conf" "$work/original-profile"
sed -i 's/^DNS = .*/DNS = 10.24.0.1, 1.1.1.1/' "$DATA_DIR/peer_dappnode_admin/peer_dappnode_admin.conf"
before=$(hashes)
if "$configure" >/dev/null 2>&1; then fail 'removed CoreDNS address accepted in DNS list'; fi
[[ $(hashes) == "$before" ]] || fail 'removed CoreDNS rejection changed files'
mv "$work/original-profile" "$DATA_DIR/peer_dappnode_admin/peer_dappnode_admin.conf"
printf '%s\n' "\$(touch \"$work/executed\")" > "$DATA_DIR/.donoteditthisfile"
"$configure"
[[ ! -f $work/executed ]] || fail 'persisted state was executed'
mkdir -p "$DATA_DIR/templates"
mkdir -p "$DATA_DIR/coredns"
cp /usr/local/lib/wireguard/legacy/Corefile-without-errors "$DATA_DIR/coredns/Corefile"
# The older stock template is still cached on deployed installations. Preserve
# the resulting client ListenPort and exact profile when migrating it.
cp /usr/local/lib/wireguard/legacy/peer-with-listen-port.conf "$DATA_DIR/templates/peer.conf"
sed -i '/^PrivateKey =/a ListenPort = 51820' "$DATA_DIR/peer_dappnode_admin/peer_dappnode_admin.conf"
before=$(hashes)
"$configure" --preflight
[[ $(hashes) == "$before" ]] || fail 'historical stock preflight changed files'
profile=$(cat "$DATA_DIR/peer_dappnode_admin/peer_dappnode_admin.conf")
"$configure"
[[ $(cat "$DATA_DIR/peer_dappnode_admin/peer_dappnode_admin.conf") == "$profile" ]] || fail 'historical stock migration changed a profile'
sed -i 's/^ListenPort = .*/ListenPort = 99999/' "$DATA_DIR/peer_dappnode_admin/peer_dappnode_admin.conf"
before=$(hashes)
if "$configure" >/dev/null 2>&1; then fail 'invalid saved client port accepted'; fi
[[ $(hashes) == "$before" ]] || fail 'invalid saved client port changed files'
sed -i 's/^ListenPort = .*/ListenPort = 51820/' "$DATA_DIR/peer_dappnode_admin/peer_dappnode_admin.conf"
printf 'custom DNS configuration\n' > "$DATA_DIR/coredns/Corefile"
before=$(hashes)
if "$configure" >/dev/null 2>&1; then fail 'custom CoreDNS configuration ignored'; fi
[[ $(hashes) == "$before" ]] || fail 'custom CoreDNS failure changed files'
cp /usr/local/lib/wireguard/legacy/Corefile "$DATA_DIR/coredns/Corefile"
printf 'custom template\n' > "$DATA_DIR/templates/server.conf"
before=$(hashes)
if "$configure" >/dev/null 2>&1; then fail 'custom template overwritten'; fi
[[ $(hashes) == "$before" ]] || fail 'custom template failure changed files'
rm "$DATA_DIR/templates/server.conf"
cp "$DATA_DIR/wg_confs/wg0.conf" "$DATA_DIR/wg_confs/extra.conf"
before=$(hashes)
if "$configure" >/dev/null 2>&1; then fail 'additional tunnel ignored'; fi
[[ $(hashes) == "$before" ]] || fail 'extra tunnel failure changed files'
rm "$DATA_DIR/wg_confs/extra.conf"
if env -u PEERS "$configure" >/dev/null 2>&1; then fail 'client mode accepted'; fi
PEERS=3 "$configure"
test -f "$DATA_DIR/peer1/peer1.conf"
# Missing PSKs are valid for previously generated clients and must stay missing.
rm "$DATA_DIR/peer1/presharedkey-peer1"
sed -i '/^PresharedKey =/d' "$DATA_DIR/peer1/peer1.conf"
PEERS=3 "$configure"
test ! -e "$DATA_DIR/peer1/presharedkey-peer1"
# A missing PSK file can be recovered from the existing client config without rotation.
psk=$(cat "$DATA_DIR/peer2/presharedkey-peer2")
rm "$DATA_DIR/peer2/presharedkey-peer2"
PEERS=3 "$configure"
test "$(cat "$DATA_DIR/peer2/presharedkey-peer2")" = "$psk"
test "$(stat -c '%u:%g:%a' "$DATA_DIR/server/privatekey-server")" = 1000:1000:600
echo 'Configuration lifecycle, migration guards and identity preservation passed.'
