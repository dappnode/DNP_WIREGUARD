// Run with DOCKER_HOST=ssh://<test-host> to use a remote native Docker daemon.
// Only fresh named volumes/private networks are used. No host ports are published.
const { execFileSync } = require("node:child_process");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { X509Certificate } = require("node:crypto");

const image = process.env.WIREGUARD_TEST_IMAGE || "wireguard-refactor:test";
const apiImage =
  process.env.WIREGUARD_API_TEST_IMAGE || "wireguard-api-refactor:test";
const baseline = process.env.WIREGUARD_BASELINE_IMAGE || image;
const baselineApi = process.env.WIREGUARD_BASELINE_API_IMAGE;
const legacyListenPort = process.env.WIREGUARD_LEGACY_LISTEN_PORT === "1";
const prefix = `wg-refactor-${process.pid}-${Date.now()}`;
const network = `${prefix}-network`;
let volume = `${prefix}-config`;
const volumes = [volume];
const server = `${prefix}-server`,
  client = `${prefix}-client`,
  api = `${prefix}-api`,
  backend = `${prefix}-backend`;
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "wg-refactor-"));
const checks = [];
let backendIp, serverIp;
function docker(args, input) {
  if (["run", "create"].includes(args[0]))
    args = [args[0], "--cpus", "1", "--memory", "512m", ...args.slice(1)];
  return execFileSync("docker", args, {
    input,
    encoding: "utf8",
    timeout: 90000,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}
function inside(name, args, input) {
  return docker(
    ["exec", ...(input === undefined ? [] : ["-i"]), name, ...args],
    input,
  );
}
async function until(check, description, timeout = 180000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      if (check()) return;
    } catch {
      /* A starting/rekeying service is expected to be temporarily unavailable. */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out: ${description}`);
}
function startServer(tag, peers = "dappnode_admin") {
  docker([
    "run",
    "-d",
    "--name",
    server,
    "--network",
    network,
    "--network-alias",
    "wg-test-server",
    ...(serverIp ? ["--ip", serverIp] : []),
    "--cap-add",
    "NET_ADMIN",
    "-v",
    `${volume}:/config`,
    "-e",
    `PEERS=${peers}`,
    "-e",
    "SERVERURL=wg-test-server",
    "-e",
    "SERVERPORT=51820",
    "-e",
    "INTERNAL_SUBNET=10.24.0.0",
    "-e",
    `PEERDNS=${backendIp}`,
    "-e",
    `ALLOWEDIPS=10.24.0.0/24,${backendIp}/32`,
    "-e",
    "LOG_CONFS=false",
    tag,
  ]);
}
async function ready() {
  await until(
    () =>
      inside(server, [
        "/bin/sh",
        "-ec",
        'test "$(wg show wg0 listen-port)" = 51820; test -f /run/activeconfs -o -f /run/wireguard-ready',
      ]) === "",
    "server readiness",
  );
}
function identity(peer = "peer_dappnode_admin") {
  return inside(server, [
    "/bin/sh",
    "-ec",
    `sha256sum /config/server/* /config/${peer}/*key*; grep '^Address =' /config/${peer}/${peer}.conf`,
  ]);
}
function traffic() {
  inside(client, ["ping", "-c", "2", "-W", "2", "10.24.0.1"]);
  const handshakes = inside(server, ["wg", "show", "wg0", "latest-handshakes"]);
  assert.ok(
    handshakes.split("\n").some((line) => Number(line.split(/\s+/)[1]) > 0),
    "no handshake",
  );
}
function reconnect() {
  inside(client, [
    "/bin/bash",
    "-ec",
    "wg-quick down /tmp/wg0.conf; wg-quick up /tmp/wg0.conf",
  ]);
}
function startClient(config) {
  docker([
    "run",
    "-d",
    "--name",
    client,
    "--network",
    network,
    "--cap-add",
    "NET_ADMIN",
    "--entrypoint",
    "/bin/sh",
    image,
    "-c",
    "sleep 1800",
  ]);
  inside(
    client,
    ["/bin/sh", "-ec", "cat > /tmp/wg0.conf; chmod 600 /tmp/wg0.conf"],
    config.replace(/^DNS =.*\n/m, "") + "\n",
  );
  inside(client, ["wg-quick", "up", "/tmp/wg0.conf"]);
}
async function replaceServer(tag, peers, forceReconnect = true) {
  docker(["stop", server]);
  docker(["rm", server]);
  startServer(tag, peers);
  await ready();
  if (forceReconnect) reconnect();
}
function startApi(tag) {
  docker([
    "run",
    "-d",
    "--name",
    api,
    "--network",
    network,
    "-v",
    `${volume}:/config:ro`,
    tag,
  ]);
}
async function apiReady(device = "dappnode_admin") {
  await until(
    () =>
      inside(api, [
        "node",
        "-e",
        `fetch('http://127.0.0.1/${device}').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`,
      ]) === "",
    "API readiness",
  );
}
const apiCheck = `const assert=require('node:assert/strict'),fs=require('node:fs'),{execFileSync}=require('node:child_process');(async()=>{
const expected=fs.readFileSync('/config/peer_dappnode_admin/peer_dappnode_admin.conf','utf8');
for(const suffix of ['', '?local']){const r=await fetch('http://127.0.0.1/dappnode_admin'+suffix);assert.ok(r.ok,'HTTP config status');assert.ok(r.headers.get('access-control-allow-origin')==='http://my.dappnode','CORS');assert.ok(await r.text()===(suffix?expected.replace(/^Endpoint =.*$/m,'Endpoint = 192.168.50.2:51820'):expected),'credential response changed');}
const qr=await fetch('http://127.0.0.1/dappnode_admin?qr');assert.ok(qr.ok,'HTTP QR status');assert.ok(Buffer.from(await qr.arrayBuffer()).subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),'invalid PNG');
for(const flags of [[],['--local'],['--localhost'],['--qr'],['--local','--qr'],['--help']]){const out=execFileSync('getWireguardCredentials',flags,{encoding:'utf8'});assert.ok(out.length>0,'empty CLI result');if(!flags.length)assert.ok(out.includes(expected),'CLI config changed');if(flags.includes('--localhost'))assert.ok(out.includes('Endpoint = localhost:51820'),'localhost endpoint');}
console.log('API/CLI modes passed');})().catch(e=>{console.error(e.message);process.exit(1)});`;

(async () => {
  try {
    docker(["network", "create", "--internal", network]);
    // Let Docker choose a free subnet, then make it explicit. Older daemons
    // reject static container IPs when the network used automatic IPAM.
    const subnet = JSON.parse(docker(["network", "inspect", network]))[0].IPAM
      .Config[0].Subnet;
    docker(["network", "rm", network]);
    docker(["network", "create", "--internal", "--subnet", subnet, network]);
    docker(["volume", "create", volume]);
    docker([
      "create",
      "--name",
      backend,
      "--network",
      network,
      "--network-alias",
      "my.dappnode",
      "--entrypoint",
      "node",
      apiImage,
      "/tmp/mock-services.cjs",
    ]);
    docker([
      "cp",
      path.join(__dirname, "mock-services.cjs"),
      `${backend}:/tmp/mock-services.cjs`,
    ]);
    docker(["start", backend]);
    backendIp = JSON.parse(docker(["inspect", backend]))[0].NetworkSettings
      .Networks[network].IPAddress;
    startServer(baseline);
    await ready();
    if (legacyListenPort) {
      assert.notEqual(
        baseline,
        image,
        "historical-template test needs the old image",
      );
      // Reproduce the historical stock template using synthetic credentials only.
      inside(server, [
        "/bin/sh",
        "-ec",
        "sed -i '/^PrivateKey =/a ListenPort = 51820' /config/templates/peer.conf; sed -i '/^[[:space:]]*errors$/d' /config/coredns/Corefile; rm /config/wg_confs/wg0.conf",
      ]);
      docker(["restart", server]);
      await ready();
      checks.push("historical stock peer template and CoreDNS file");
    }
    serverIp = JSON.parse(docker(["inspect", server]))[0].NetworkSettings
      .Networks[network].IPAddress;
    const originalIdentity = identity();
    const originalConfig = inside(server, [
      "cat",
      "/config/peer_dappnode_admin/peer_dappnode_admin.conf",
    ]);
    // The peer is an independent Linux client, not the removed package client mode.
    startClient(originalConfig);
    traffic();
    checks.push("baseline handshake and encrypted traffic");
    if (baselineApi) {
      startApi(baselineApi);
      await apiReady();
      inside(api, ["node", "-e", apiCheck]);
      docker(["stop", api]);
      docker(["rm", api]);
      checks.push("deployed API/CLI baseline");
    }
    await replaceServer(image, "dappnode_admin", false);
    await until(() => {
      traffic();
      return true;
    }, "upgrade reconnect");
    assert.equal(
      identity(),
      originalIdentity,
      "upgrade rotated identity or address",
    );
    assert.ok(
      inside(server, [
        "cat",
        "/config/peer_dappnode_admin/peer_dappnode_admin.conf",
      ]) === originalConfig,
      "upgrade changed client credentials",
    );
    checks.push("upgrade preserves credentials, keys, PSKs and peer IPs");
    assert.ok(
      inside(client, ["nslookup", "my.dappnode", backendIp]).includes(
        backendIp,
      ),
      "BIND DNS route failed",
    );
    assert.ok(
      inside(client, ["ip", "route", "get", backendIp]).includes("dev wg0"),
      "backend bypasses tunnel",
    );
    assert.equal(
      inside(client, [
        "curl",
        "-fsS",
        "--max-time",
        "5",
        `http://${backendIp}/source`,
      ]),
      serverIp,
      "NAT did not use server IP",
    );
    checks.push(
      "DNS and HTTP forwarding/NAT through the tunnel without CoreDNS",
    );
    startApi(apiImage);
    await apiReady();
    inside(api, ["node", "-e", apiCheck]);
    assert.ok(
      JSON.parse(docker(["inspect", api]))[0].Mounts.some(
        (mount) => mount.Destination === "/config" && !mount.RW,
      ),
      "API volume is writable",
    );
    inside(api, [
      "node",
      "-e",
      "fetch('http://127.0.0.1/dappnode_admin%2f..%2fserver').then(r=>process.exit(r.status===400?0:1))",
    ]);
    checks.push("API/CLI credentials, CORS, PNG and read-only storage");
    await replaceServer(image, "dappnode_admin,laptop");
    traffic();
    assert.equal(identity(), originalIdentity, "adding peer rotated identity");
    await replaceServer(image, "laptop", false);
    const result = inside(api, [
      "node",
      "-e",
      "fetch('http://127.0.0.1/dappnode_admin').then(r=>console.log(r.status))",
    ]);
    assert.equal(result, "404", "removed peer credentials remain accessible");
    let blocked = false;
    try {
      traffic();
    } catch {
      blocked = true;
    }
    assert.ok(blocked, "removed peer can still use tunnel");
    await replaceServer(image, "dappnode_admin,laptop");
    traffic();
    assert.equal(
      identity(),
      originalIdentity,
      "re-adding peer rotated identity/address",
    );
    checks.push(
      "PEERS add/remove revokes traffic and credentials; re-add preserves identity",
    );
    docker(["restart", server]);
    await ready();
    await until(() => {
      traffic();
      return true;
    }, "restart reconnect");
    docker(["restart", api]);
    await apiReady();
    inside(api, ["node", "-e", apiCheck]);
    assert.equal(identity(), originalIdentity, "restart changed identity");
    assert.equal(
      inside(client, [
        "curl",
        "-fsS",
        "--max-time",
        "5",
        `http://${backendIp}/source`,
      ]),
      serverIp,
    );
    checks.push("restart reconnect, credentials and NAT");
    if (baseline !== image) {
      await replaceServer(baseline, "dappnode_admin,laptop");
      traffic();
      assert.equal(identity(), originalIdentity, "rollback changed identity");
      await replaceServer(image, "dappnode_admin,laptop");
      traffic();
      assert.equal(
        identity(),
        originalIdentity,
        "roll-forward changed identity",
      );
      checks.push(
        "rollback to deployed image and roll-forward preserve access",
      );

      // Exercise a separate old numeric installation, never converting its
      // peer1 directories into named peers or generating replacement keys.
      docker(["rm", "-f", client]);
      docker(["stop", server]);
      docker(["rm", server]);
      volume = `${prefix}-numeric-config`;
      volumes.push(volume);
      docker(["volume", "create", volume]);
      startServer(baseline, "2");
      await ready();
      const numericIdentity = identity("peer1");
      const numericConfig = inside(server, ["cat", "/config/peer1/peer1.conf"]);
      startClient(numericConfig);
      traffic();
      await replaceServer(image, "2", false);
      await until(() => {
        traffic();
        return true;
      }, "numeric upgrade reconnect");
      assert.equal(
        identity("peer1"),
        numericIdentity,
        "numeric identity changed",
      );
      assert.ok(
        inside(server, ["cat", "/config/peer1/peer1.conf"]) === numericConfig,
        "numeric client profile changed",
      );
      docker(["rm", "-f", api]);
      startApi(apiImage);
      await apiReady("1");
      await replaceServer(image, "1");
      inside(api, [
        "node",
        "-e",
        "fetch('http://127.0.0.1/2').then(r=>process.exit(r.status===404?0:1))",
      ]);
      await replaceServer(image, "2");
      assert.equal(
        identity("peer1"),
        numericIdentity,
        "numeric resize changed identity",
      );
      assert.ok(
        inside(server, ["/app/show-peer", "1"]).includes("\x1b["),
        "numeric CLI QR failed",
      );
      await replaceServer(baseline, "2");
      traffic();
      await replaceServer(image, "2");
      traffic();
      assert.equal(
        identity("peer1"),
        numericIdentity,
        "numeric rollback changed identity",
      );
      checks.push(
        "old numeric PEERS upgrade, resize, API/CLI, rollback and roll-forward",
      );
    }
    for (const tag of [image, apiImage]) {
      const bundle = docker([
        "run",
        "--rm",
        "--entrypoint",
        "cat",
        tag,
        "/etc/ssl/certs/ca-certificates.crt",
      ]);
      const certs = bundle.match(
        /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
      );
      assert.ok(
        certs.length > 100 &&
          !certs.some((cert) =>
            /CN=(?:AAA Certificate Services|Comodo AAA Services|emSign ECC Root CA - G3)(?:\n|$)/i.test(
              new X509Certificate(cert).subject,
            ),
          ),
        "compromised CA remains trusted",
      );
    }
    inside(api, [
      "node",
      "-e",
      "const {X509Certificate}=require('node:crypto');if(require('node:tls').rootCertificates.some(c=>/CN=(AAA Certificate Services|Comodo AAA Services|emSign ECC Root CA - G3)(\\n|$)/i.test(new X509Certificate(c).subject)))process.exit(1)",
    ]);
    checks.push("system and bundled Node CA distrust");
    const report = {
      dockerHost: process.env.DOCKER_HOST || "local",
      image,
      apiImage,
      baseline,
      checks,
    };
    if (process.env.WIREGUARD_TEST_REPORT)
      fs.writeFileSync(
        process.env.WIREGUARD_TEST_REPORT,
        JSON.stringify(report, null, 2),
      );
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(error.message);
    for (const name of [server, client, api]) {
      try {
        console.error(`${name}: ${docker(["logs", "--tail", "30", name])}`);
      } catch {
        /* May not have started. */
      }
    }
    process.exitCode = 1;
  } finally {
    for (const name of [api, client, server, backend]) {
      try {
        docker(["rm", "-f", name]);
      } catch {
        /* Absent after failed startup. */
      }
    }
    for (const testVolume of volumes) {
      try {
        docker(["volume", "rm", testVolume]);
      } catch {
        /* Reported by the final cleanup check when applicable. */
      }
    }
    try {
      docker(["network", "rm", network]);
    } catch {
      /* Absent after failed creation. */
    }
    fs.rmSync(fixture, { recursive: true, force: true });
  }
})();
