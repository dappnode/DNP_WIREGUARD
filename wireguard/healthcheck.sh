#!/bin/sh
set -eu
test -f /run/wireguard-ready
test "$(wg show wg0 listen-port)" = "${SERVERPORT:-51820}"
ip -o link show wg0 | grep -q '<[^>]*UP'
