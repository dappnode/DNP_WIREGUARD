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
| `SERVER_ALLOWEDIPS_PEER_<name>` | Optional additional server-side routes for that peer. |
| `PERSISTENTKEEPALIVE_PEERS` | Optional comma-separated names or `all`; 25 seconds. |
| `PUID`, `PGID` | `1000`; generated config and key files are owned by these IDs, mode 0600. |
| `LOG_CONFS` | Credential contents are never logged. Use the credential CLI explicitly. |

`WIREGUARD_RELEASE` remains a build argument for an explicit Alpine tools version.
APK chooses a signed package for the target architecture when it is omitted.
Both images require CA bundles at least `20261020-r0` for RHSB-2026-012; Node is
pinned to the patched 24.22.1 LTS image.

## Upgrade and rollback

Server/peer private keys, public keys, PSKs, client addresses, peer folder names
and generated WireGuard config format are retained. Files are staged, validated
by `wg setconf` against a temporary interface, and individually replaced by
atomic rename; the server config is published last. Identical files are not
rewritten. Existing PSK-less clients stay PSK-less. Missing identities and
inconsistent key/config pairs fail instead of generating replacement identities.
Persisted `.donoteditthisfile` content is never executed.

The refactor is Dappnode server-only. Preflight rejects the following before
publishing configs, rather than silently dropping unsupported behavior:

- Client mode (no `PEERS` variable), additional tunnel files and custom templates.
- `PEERDNS=auto`, clients pointing at the former VPN/CoreDNS address, and custom
  CoreDNS configurations. Move DNS to explicit BIND servers using the previous
  release and redistribute changed client configs before migrating.
- Custom server firewall hooks/interface extensions and symlinks in the volume.

Default legacy templates, including older profiles with `ListenPort = 51820`,
and the old `/config/wg0.conf` location are recognized. Existing client listen
ports are retained.
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
The legacy template fixtures retain its format for migration checks. See
[LICENSE](LICENSE) for repository licensing.
