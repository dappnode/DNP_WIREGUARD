# Dappnode WireGuard

A kernel-backed WireGuard server for Dappnode. The `wireguard` service configures
one `wg0` interface and forwarding/NAT. The `api` service supplies client
credentials to Dappmanager, the installer and terminal commands. Both services
support AMD64 and ARM64 with the same architecture-neutral Dockerfiles.

## Requirements

The host must provide WireGuard and the netfilter support used by iptables.
Enable missing modules through the host installer/administrator. The VPN
container requires only `NET_ADMIN`; it does not load host modules, mount
`/lib/modules`, use host networking or access the Docker socket. Missing kernel
support fails startup with an explicit error instead of hanging indefinitely.

The API is internal to `dncore_network`; never publish its TCP port. It serves
private client credentials and retains the existing Dappnode network trust model.
Its config volume is read-only. The VPN service is the only config writer.

## Dappnode contract

- Services, container names, DNS aliases, `/config` volume and UDP port 51820 are
  unchanged. Dappmanager adds/removes devices through the `PEERS` environment
  variable and recreates the server container.
- `PEERS=dappnode_admin` creates the default admin. A comma-separated name list
  or a numeric count is supported. An explicitly empty list keeps the server
  running with no authorized peers. Removed peers lose tunnel and API access;
  their files remain available for identity-preserving re-add and rollback.
- `GET /:device` returns the remote config; `?local` substitutes the host LAN IP;
  `?qr` returns a PNG. The unsupported `?local&qr` combination returns 400.
  Readiness is available at `/-/health`, outside the peer-name namespace.
  Credentials have `Cache-Control: no-store`. Invalid device names return 400,
  inactive/missing peers return 404 and local-IP discovery failures return 503.
- `getWireguardCredentials` remains installed in the `api` container. The host
  `dappnode_wireguard` alias still supports `--local`, `--localhost`, `--qr` and
  `--help`. Local variants retain the configured server port.
- `/app/show-peer` remains available in the VPN container. QR rendering uses
  upstream `qrencode` for both services. The API remains strict TypeScript,
  using Node built-ins with **zero production npm dependencies**.

## Configuration

| Variable | Default / behavior |
| --- | --- |
| `PEERS` | Required; Dappnode sets `dappnode_admin`. Empty means no authorized peers. |
| `SERVERURL` | Explicit host; otherwise `_DAPPNODE_GLOBAL_HOSTNAME`, then Dappmanager's `HOSTNAME` endpoint. |
| `SERVERPORT` | `51820`. Update the Compose port mapping too when changing it. |
| `PEERDNS` | `172.33.1.2,10.20.0.2` (Dappnode BIND); explicit servers only. |
| `INTERNAL_SUBNET` | `10.24.0.0`; IPv4 /24 addressing, preserving existing host IDs. |
| `ALLOWEDIPS` | `172.33.0.0/16,10.20.0.0/24`; client-side routed ranges. |
| `LOG_CONFS` | Credential contents are never logged. Use the credential CLI explicitly. |

Generated files belong to Dappnode's UID/GID `1000:1000`, mode `0600`.
APK selects signed WireGuard tools for the target architecture.
Both images require CA bundles at least `20261020-r0` for RHSB-2026-012; Node is
pinned to the patched 24.22.1 LTS image.

## Upgrade and rollback

Server/peer private keys, public keys, PSKs, client addresses, peer folder names
and generated WireGuard config format are retained. Files are staged, validated
by `wg setconf` against a temporary interface, and individually replaced by
atomic rename; the server config is published last. Identical files are not
rewritten. Existing PSK-less clients stay PSK-less. Missing identities and
inconsistent key/config pairs fail instead of generating replacement identities.
Persisted `.donoteditthisfile` content is never read or executed. A sanitized
copy is written only so the currently installed Dappnode image can roll back.

The refactor is Dappnode server-only. Preflight rejects the following before
publishing configs, rather than silently dropping unsupported behavior:

- Client mode (no `PEERS` variable) and additional tunnel files.
- `PEERDNS=auto` and clients pointing at the former VPN/CoreDNS address.
  Move DNS to explicit BIND servers using the previous
  release and redistribute changed client configs before migrating.
- Custom server/client options, firewall hooks and symlinks in the volume.
- `SERVER_ALLOWEDIPS_PEER_<name>` and `PERSISTENTKEEPALIVE_PEERS` overrides.

Older numeric peer folders, existing client listen ports and the old
`/config/wg0.conf` location are retained for upgrade compatibility. Saved template
and CoreDNS files no longer control generation; they are left untouched for
rollback. The runtime ships no template fixtures or template matching logic.
Keep a backup of the volume and previous images before upgrading. An unsupported
installation should remain on its previous image until its customization has
been reviewed. The previous image can reuse the same config volume for rollback;
upgrade/rollback/re-add behavior is exercised by the integration suite.

For a read-only compatibility audit, run
`/usr/local/lib/wireguard/configure.sh --preflight` in a disposable new-image
container with the old volume mounted read-only and the same server environment.
The diagnostic checks persisted configuration without publishing files or keys;
normal startup additionally validates the draft through the kernel.

The package does not include CoreDNS, resolver rewriting, LinuxServer/s6, Docker
Mods, cron, module tools, arbitrary shell templates or a user-space VPN daemon.
Upstream `wg-quick` still handles interface/routing lifecycle and the established
iptables forwarding rules are retained.

## Validation

```sh
cd api
# Development tools only; the final API image contains no node_modules.
yarn install --frozen-lockfile
yarn format:check
yarn build && yarn test
cd ..
docker build -t wireguard-refactor:test .
docker build -t wireguard-api-refactor:test api
node tests/integration.cjs
```

Both image builds run their own tests. The VPN configuration tests need no
kernel privileges. Integration tests require a native Linux Docker host with
WireGuard support and create only disposable containers, volumes and private
networks. They publish no ports and never mount the host's live config volume.
`DOCKER_HOST=ssh://<test-host>` selects a remote daemon; the Node test runner stays
local. Set `WIREGUARD_TEST_IMAGE` and `WIREGUARD_API_TEST_IMAGE` for custom tags.

For an actual release upgrade/rollback test, also set `WIREGUARD_BASELINE_IMAGE`
and `WIREGUARD_BASELINE_API_IMAGE` to the currently installed image IDs. The suite
uses those images with **fresh synthetic credentials**, never the installed
service's secrets. It checks handshake/traffic, direct BIND DNS, forwarding/NAT,
all credential modes, read-only API storage, peer add/remove/revocation/re-add,
restart recovery, rollback/roll-forward and CA distrust. The Linux test client
uses `wg-quick` with explicit DNS queries; real-device/public-endpoint testing is
separate.

Set `WIREGUARD_LEGACY_LISTEN_PORT=1` with the old baseline image to also exercise
the historical stock peer template and CoreDNS file retained in older installations.

The previous package was derived from [LinuxServer's WireGuard image](https://github.com/linuxserver/docker-wireguard).
See [LICENSE](LICENSE) for repository licensing.
