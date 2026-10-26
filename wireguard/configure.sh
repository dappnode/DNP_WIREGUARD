#!/bin/bash
# Render the Dappnode server configuration. Never evaluate persisted shell files.
set -euo pipefail
umask 077
shopt -s nullglob
data=${DATA_DIR:-/config}
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
fail() { echo "WireGuard configuration: $*" >&2; exit 1; }
[[ $# == 0 || ( $# == 1 && $1 == --preflight ) ]] || fail 'Supported option: --preflight'
ipv4() {
    local part
    [[ $1 =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
    local -a parts
    IFS=. read -ra parts <<< "$1"
    for part in "${parts[@]}"; do
        [[ ${#part} -le 3 ]] && ((10#$part <= 255)) || return 1
    done
}

[[ ${PEERS+x} ]] || fail 'Client mode is unsupported. Keep the previous image for client-mode configurations.'
[[ ${USE_COREDNS:-false} == false ]] || fail 'CoreDNS is no longer included. Configure PEERDNS to use Dappnode BIND.'
[[ ${PEERDNS:-} != auto ]] || fail 'PEERDNS=auto requires the previous image. Set explicit DNS servers before migrating.'
[[ ${PUID:-1000} =~ ^[0-9]+$ && ${PGID:-1000} =~ ^[0-9]+$ ]] || fail 'PUID and PGID must be numeric.'
for template in server.conf peer.conf; do
    file="$data/templates/$template"
    if [[ -f $file ]]; then
        references=("$here/legacy/$template")
        if [[ $template == peer.conf ]]; then references+=("$here/legacy/peer-with-listen-port.conf"); fi
        matched=false
        for reference in "${references[@]}"; do
            if cmp -s "$file" "$reference"; then
                matched=true
            elif [[ $template == peer.conf ]] && cmp -s "$file" <(sed '/^PresharedKey =/d' "$reference"); then
                matched=true
            fi
        done
        $matched || fail "Custom template $file requires manual migration; no configuration was changed."
    fi
done
if [[ -f $data/coredns/Corefile ]] &&
    ! cmp -s "$data/coredns/Corefile" "$here/legacy/Corefile" &&
    ! cmp -s "$data/coredns/Corefile" "$here/legacy/Corefile-without-errors"; then
    fail 'A custom CoreDNS configuration requires manual migration.'
fi
for file in "$data"/wg_confs/*.conf; do
    [[ ${file##*/} == wg0.conf ]] || fail 'Additional tunnels require the previous image or manual migration.'
done
[[ ! -d $data ]] || [[ -z $(find "$data" -type l -print -quit) ]] || fail 'Symlinks inside the config volume require manual migration.'

subnet=${INTERNAL_SUBNET:-10.24.0.0}
ipv4 "$subnet" || fail 'INTERNAL_SUBNET must be an IPv4 /24 network address.'
prefix=${subnet%.*}
port=${SERVERPORT:-51820}
if ! [[ $port =~ ^[0-9]+$ && ${#port} -le 5 ]] || ! ((10#$port >= 1 && 10#$port <= 65535)); then
    fail 'Invalid SERVERPORT.'
fi
dns=${PEERDNS:-172.33.1.2,10.20.0.2}
allowed=${ALLOWEDIPS:-172.33.0.0/16,10.20.0.0/24}
[[ $dns =~ ^[a-zA-Z0-9.:,\ _-]+$ ]] || fail 'Invalid PEERDNS.'
[[ $allowed =~ ^[a-fA-F0-9.:/,\ ]+$ ]] || fail 'Invalid ALLOWEDIPS.'
keepalive=${PERSISTENTKEEPALIVE_PEERS:-}
[[ $keepalive =~ ^[a-zA-Z0-9_,\ ]*$ ]] || fail 'Invalid PERSISTENTKEEPALIVE_PEERS.'
host=${SERVERURL:-${_DAPPNODE_GLOBAL_HOSTNAME:-}}
if [[ -z $host || $host == auto ]]; then
    host=${_DAPPNODE_GLOBAL_HOSTNAME:-}
    for ((attempt=0; attempt<10 && ${#host}==0; attempt++)); do
        for manager in my.dappnode dappmanager.dappnode 172.33.1.7 10.20.0.7; do
            host=$(curl --fail --silent --show-error --max-time 3 --max-redirs 0 "http://$manager/global-envs/HOSTNAME" 2>/dev/null) || host=
            [[ -z $host ]] || break
        done
        [[ -n $host ]] || sleep 1
    done
fi
if [[ $host == \[*\] ]]; then host=${host:1:${#host}-2}; fi
if [[ $host == *:* ]]; then
    [[ $host =~ ^[a-fA-F0-9:.]+$ ]] || fail 'Invalid IPv6 SERVERURL.'
else
    [[ $host =~ ^[a-zA-Z0-9._-]+$ ]] || fail 'SERVERURL is unavailable or invalid.'
fi
endpoint=$host
if [[ $host == *:* && $host != \[*\] ]]; then endpoint="[$host]"; fi

declare -a peers=()
declare -A seen=() reserved=() assigned=()
if [[ $PEERS =~ ^[0-9]+$ ]]; then
    if [[ ${#PEERS} -gt 3 ]] || ((10#$PEERS > 253)); then
        fail 'At most 253 peers are supported.'
    fi
    for ((i=1;i<=10#$PEERS;i++)); do peers+=("$i"); done
else
    IFS=, read -ra peers <<< "$PEERS"
fi
for i in "${peers[@]}"; do
    [[ $i =~ ^[a-zA-Z0-9_]+$ ]] || fail 'Peer names must contain only letters, numbers and underscores.'
    [[ ! ${seen[$i]+yes} ]] || fail 'Duplicate peer name.'
    seen[$i]=1
    extra_name="SERVER_ALLOWEDIPS_PEER_$i"
    extra=${!extra_name:-}
    [[ -z $extra || $extra =~ ^[a-fA-F0-9.:/,\ ]+$ ]] || fail "Invalid $extra_name."
done
((${#peers[@]} <= 253)) || fail 'At most 253 peers are supported.'

server_conf="$data/wg_confs/wg0.conf"
if [[ ! -e $server_conf && -f $data/wg0.conf ]]; then server_conf="$data/wg0.conf"; fi
if [[ -f $server_conf ]]; then
    [[ -s $data/server/privatekey-server ]] || fail 'Existing server key is missing; refusing to replace its identity.'
    [[ $(sed -n 's/^PrivateKey = //p' "$server_conf") == "$(cat "$data/server/privatekey-server")" ]] || fail 'Saved server configuration and private key disagree.'
    # Custom lifecycle commands and interface extensions must not be discarded.
    while IFS= read -r line; do
        case $line in
            ''|'#'*|'[Interface]'|'[Peer]'|Address\ =*|ListenPort\ =*|PrivateKey\ =*|PublicKey\ =*|PresharedKey\ =*|AllowedIPs\ =*|PersistentKeepalive\ =*) ;;
            PostUp\ =*|PostDown\ =*) grep -Fxq "$line" "$here/legacy/server.conf" || fail 'Custom firewall hooks require manual migration.' ;;
            *) fail 'Custom server configuration requires manual migration.' ;;
        esac
    done < "$server_conf"
fi
for file in "$data"/peer*/peer*.conf; do
    address=$(sed -n 's/^Address[[:space:]]*=[[:space:]]*//p' "$file")
    address=${address%/32}
    ipv4 "$address" || fail "Invalid saved peer address in $file."
    last=${address##*.}
    ((10#$last >= 2 && 10#$last <= 254)) || fail 'Saved peer address is outside the supported pool.'
    reserved[$((10#$last))]=1
    saved_dns=$(sed -n 's/^DNS[[:space:]]*=[[:space:]]*//p' "$file")
    [[ ,${saved_dns// /}, != *,"${address%.*}.1",* ]] || fail 'A saved client uses the removed CoreDNS server. Migrate its DNS using the previous image first.'
done

if [[ ${1:-} == --preflight ]]; then
    echo 'WireGuard compatibility preflight passed; no files were changed.'
    exit 0
fi

mkdir -p "$data"
stage=$(mktemp -d "$data/.wireguard-stage.XXXXXX")
trap 'rm -rf -- "$stage"' EXIT
key() {
    local relative=$1 existing_config=$2 private public
    mkdir -p "$stage/$(dirname "$relative")"
    if [[ -s $data/$relative ]]; then cp "$data/$relative" "$stage/$relative"
    elif [[ -f $existing_config ]]; then fail 'A saved peer key is missing; refusing to replace it.'
    else wg genkey > "$stage/$relative"; fi
    private=$(cat "$stage/$relative")
    if [[ -f $existing_config ]]; then
        [[ $(sed -n 's/^PrivateKey = //p' "$existing_config") == "$private" ]] || fail 'Saved configuration and private key disagree.'
    fi
    public=$(printf '%s\n' "$private" | wg pubkey 2>/dev/null) || fail 'Invalid saved private key.'
    KEY_PRIVATE=$private
    KEY_PUBLIC=$public
}
key server/privatekey-server "$server_conf"
server_public=$KEY_PUBLIC
printf '%s\n' "$server_public" > "$stage/server/publickey-server"
mkdir -p "$stage/wg_confs"
cat > "$stage/wg_confs/wg0.conf" <<EOF
[Interface]
Address = $prefix.1
ListenPort = $port
PrivateKey = $KEY_PRIVATE
PostUp = iptables -A FORWARD -i %i -j ACCEPT; iptables -A FORWARD -o %i -j ACCEPT; iptables -t nat -A POSTROUTING -o eth+ -j MASQUERADE
PostDown = iptables -D FORWARD -i %i -j ACCEPT; iptables -D FORWARD -o %i -j ACCEPT; iptables -t nat -D POSTROUTING -o eth+ -j MASQUERADE

EOF
for i in "${peers[@]}"; do
    if [[ $i =~ ^[0-9]+$ ]]; then peer="peer$i"; else peer="peer_$i"; fi
    conf="$data/$peer/$peer.conf"
    key "$peer/privatekey-$peer" "$conf"
    printf '%s\n' "$KEY_PUBLIC" > "$stage/$peer/publickey-$peer"
    if [[ -f $conf ]]; then
        address=$(sed -n 's/^Address[[:space:]]*=[[:space:]]*//p' "$conf")
        address=${address%/32}
        last=${address##*.}
        last=$((10#$last))
    else
        last=2
        while [[ ${reserved[$last]+yes} && $last -le 254 ]]; do last=$((last+1)); done
        ((last <= 254)) || fail 'No free peer addresses remain; archive unused peer folders explicitly to reclaim them.'
    fi
    client_port=
    if [[ -f $conf ]]; then
        client_port=$(sed -n 's/^ListenPort = //p' "$conf")
        if [[ -n $client_port ]]; then
            if ! [[ $client_port =~ ^[0-9]+$ && ${#client_port} -le 5 ]] || ! ((10#$client_port >= 1 && 10#$client_port <= 65535)); then
                fail 'Invalid saved client ListenPort.'
            fi
        fi
    fi
    [[ ! ${assigned[$last]+yes} ]] || fail 'Saved peers have conflicting addresses; refusing to renumber them.'
    assigned[$last]=1 reserved[$last]=1
    psk=
    if [[ -f $conf ]]; then
        psk=$(sed -n 's/^PresharedKey = //p' "$conf")
        if [[ -s $data/$peer/presharedkey-$peer ]]; then
            [[ $psk == "$(cat "$data/$peer/presharedkey-$peer")" ]] || fail 'Saved peer configuration and preshared key disagree.'
        fi
        [[ -z $psk ]] || printf '%s\n' "$psk" > "$stage/$peer/presharedkey-$peer"
    else
        wg genpsk > "$stage/$peer/presharedkey-$peer"
        psk=$(cat "$stage/$peer/presharedkey-$peer")
    fi
    cat > "$stage/$peer/$peer.conf" <<EOF
[Interface]
Address = $prefix.$last
PrivateKey = $KEY_PRIVATE
EOF
    [[ -z $client_port ]] || printf 'ListenPort = %s\n' "$client_port" >> "$stage/$peer/$peer.conf"
    printf 'DNS = %s\n\n[Peer]\nPublicKey = %s\n' "$dns" "$server_public" >> "$stage/$peer/$peer.conf"
    [[ -z $psk ]] || printf 'PresharedKey = %s\n' "$psk" >> "$stage/$peer/$peer.conf"
    printf 'Endpoint = %s:%s\nAllowedIPs = %s\n' "$endpoint" "$port" "$allowed" >> "$stage/$peer/$peer.conf"
    {
        printf '[Peer]\n# %s\nPublicKey = %s\n' "$peer" "$KEY_PUBLIC"
        [[ -z $psk ]] || printf 'PresharedKey = %s\n' "$psk"
        extra_name="SERVER_ALLOWEDIPS_PEER_$i"
        extra=${!extra_name:-}
        printf 'AllowedIPs = %s.%s/32%s\n' "$prefix" "$last" "${extra:+,$extra}"
        if [[ ,${keepalive// /}, == *,all,* || ,${keepalive// /}, == *,"$i",* ]]; then printf 'PersistentKeepalive = 25\n'; fi
        printf '\n'
    } >> "$stage/wg_confs/wg0.conf"
    qrencode -l L -o "$stage/$peer/$peer.png" < "$stage/$peer/$peer.conf"
done
# Normal startup validates the draft through the kernel before publishing any file.
if [[ -n ${WG_VALIDATE_INTERFACE:-} ]]; then
    if ! wg setconf "$WG_VALIDATE_INTERFACE" <(wg-quick strip "$stage/wg_confs/wg0.conf") 2> "$stage/kernel-error"; then
        fail 'WireGuard rejected the draft. Verify the saved keys and allowed routes; existing configuration was not replaced.'
    fi
    rm "$stage/kernel-error"
fi
cat > "$stage/.donoteditthisfile" <<EOF
ORIG_SERVERURL="$host"
ORIG_SERVERPORT="$port"
ORIG_PEERDNS="$dns"
ORIG_PEERS="$PEERS"
ORIG_INTERFACE="$prefix"
ORIG_ALLOWEDIPS="$allowed"
ORIG_PERSISTENTKEEPALIVE_PEERS="$keepalive"
EOF
publish() {
    local source=$1 relative=${1#"$stage/"} target
    target="$data/$relative"
    mkdir -p "$(dirname "$target")"
    chown "${PUID:-1000}:${PGID:-1000}" "$source"
    chmod 600 "$source"
    if [[ -f $target ]] && cmp -s "$source" "$target"; then
        chown "${PUID:-1000}:${PGID:-1000}" "$target"
        chmod 600 "$target"
    else mv -f -- "$source" "$target"; fi
}
while IFS= read -r -d '' file; do publish "$file"; done < <(find "$stage" -type f ! -path "$stage/wg_confs/wg0.conf" -print0)
publish "$stage/wg_confs/wg0.conf"
echo "WireGuard configuration ready (${#peers[@]} peers)."
