const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawnSync } = require("node:child_process");
const { createServer } = require("../dist/src/index");
const {
  readConfig,
  getConfig,
  getLocalIp,
  setEndpoint,
  renderQr,
} = require("../dist/src/config");

const config =
  "[Interface]\nAddress = 10.24.0.2\nPrivateKey = fixture-key\nDNS = 172.33.1.2\n\n[Peer]\nPublicKey = fixture-public-key\nEndpoint = example.org:51821\nAllowedIPs = 172.33.0.0/16\n";
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wg-api-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "wg_confs"));
  fs.mkdirSync(path.join(dir, "peer_dappnode_admin"));
  fs.writeFileSync(
    path.join(dir, "wg_confs/wg0.conf"),
    "[Interface]\n# peer_dappnode_admin\n# peer1\n",
  );
  fs.writeFileSync(
    path.join(dir, "peer_dappnode_admin/peer_dappnode_admin.conf"),
    config,
  );
  return dir;
}
async function listen(t, server) {
  await new Promise((resolve, reject) =>
    server.listen(0, "127.0.0.1", (err) => (err ? reject(err) : resolve())),
  );
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  return `127.0.0.1:${server.address().port}`;
}

test("remote credentials retain their exact contents; local/localhost variants preserve the port", async (t) => {
  const dataDir = fixture(t);
  assert.equal(await getConfig("dappnode_admin", { dataDir }), config);
  const hostname = await listen(
    t,
    http.createServer((req, res) => res.end("192.168.1.45")),
  );
  assert.equal(
    await getConfig("dappnode_admin", {
      dataDir,
      local: true,
      hostnames: [hostname],
    }),
    config.replace("example.org", "192.168.1.45"),
  );
  assert.equal(
    await getConfig("dappnode_admin", { dataDir, localhost: true }),
    config.replace("example.org", "localhost"),
  );
  assert.equal(
    setEndpoint("Endpoint    = example.org:42", "localhost:42"),
    "Endpoint = localhost:42",
  );
});

test("local IP discovery rejects redirects, errors and invalid addresses and uses the fallback", async (t) => {
  let requests = 0;
  let redirected = false;
  const hostname = await listen(
    t,
    http.createServer((req, res) => {
      redirected ||= req.url === "/redirected";
      requests++;
      if (requests === 1) res.writeHead(302, { location: "/redirected" });
      else if (requests === 2) res.writeHead(503);
      res.end(requests === 3 ? "not-an-ip" : "192.168.1.45");
    }),
  );
  assert.equal(
    await getLocalIp({ hostnames: Array(4).fill(hostname), attempts: 1 }),
    "192.168.1.45",
  );
  assert.equal(redirected, false);
  assert.equal(requests, 4);
});

test("IPv6 LAN credentials use a bracketed endpoint", async (t) => {
  const dataDir = fixture(t);
  const hostname = await listen(
    t,
    http.createServer((req, res) => res.end("fd00::1234")),
  );
  assert.match(
    await getConfig("dappnode_admin", {
      dataDir,
      local: true,
      hostnames: [hostname],
    }),
    /Endpoint = \[fd00::1234\]:51821/,
  );
});

test("local discovery fails with a bounded, actionable error", async (t) => {
  const hostname = await listen(
    t,
    http.createServer((req, res) => res.end("invalid")),
  );
  await assert.rejects(
    getLocalIp({ hostnames: [hostname], attempts: 2, retryDelay: 1 }),
    { status: 503 },
  );
});

test("removed peers, traversal and symlinks cannot expose credentials", (t) => {
  const dataDir = fixture(t);
  for (const name of ["../server", "a/../../server", "a\\b", "", "x\0y"])
    assert.throws(() => readConfig(name, { dataDir }), { status: 400 });
  fs.writeFileSync(path.join(dataDir, "wg_confs/wg0.conf"), "[Interface]\n");
  assert.throws(() => readConfig("dappnode_admin", { dataDir }), {
    status: 404,
  });
  fs.writeFileSync(
    path.join(dataDir, "wg_confs/wg0.conf"),
    "# peer_dappnode_admin\n",
  );
  const conf = path.join(
    dataDir,
    "peer_dappnode_admin/peer_dappnode_admin.conf",
  );
  fs.unlinkSync(conf);
  fs.symlinkSync(path.join(dataDir, "wg_confs/wg0.conf"), conf);
  assert.throws(() => readConfig("dappnode_admin", { dataDir }), {
    status: 400,
  });
});

test("numeric legacy peer folders remain readable", (t) => {
  const dataDir = fixture(t);
  fs.mkdirSync(path.join(dataDir, "peer1"));
  fs.writeFileSync(path.join(dataDir, "peer1/peer1.conf"), config);
  assert.equal(readConfig("1", { dataDir }), config);
});

test("HTTP contract: raw text, bare local query, HEAD, CORS, errors and readiness", async (t) => {
  const dataDir = fixture(t);
  const manager = await listen(
    t,
    http.createServer((req, res) => res.end("192.168.1.45")),
  );
  const host = await listen(t, createServer({ dataDir, hostnames: [manager] }));
  const url = `http://${host}`;
  const remote = await fetch(`${url}/dappnode_admin`);
  assert.equal(remote.status, 200);
  assert.equal(remote.headers.get("cache-control"), "no-store");
  assert.equal(
    remote.headers.get("access-control-allow-origin"),
    "http://my.dappnode",
  );
  assert.equal(await remote.text(), config);
  assert.equal(
    await (await fetch(`${url}/dappnode_admin?local`)).text(),
    config.replace("example.org", "192.168.1.45"),
  );
  assert.equal(
    await (await fetch(`${url}/dappnode_admin`, { method: "HEAD" })).text(),
    "",
  );
  assert.equal(
    (await fetch(`${url}/dappnode_admin`, { method: "OPTIONS" })).status,
    204,
  );
  assert.equal(
    (await fetch(`${url}/dappnode_admin`, { method: "POST" })).status,
    405,
  );
  assert.equal((await fetch(`${url}/dappnode_admin?local&qr`)).status, 400);
  assert.equal((await fetch(`${url}/missing`)).status, 404);
  assert.equal((await fetch(`${url}/a%2F..%2Fserver`)).status, 400);
  assert.equal((await fetch(`${url}/-/health`)).status, 503);
  fs.writeFileSync(path.join(dataDir, ".ready"), "");
  assert.equal((await fetch(`${url}/-/health`)).status, 200);
});

test(
  "QR output is PNG over HTTP and ANSI in the CLI",
  { skip: spawnSync("qrencode", ["--version"]).status !== 0 },
  async (t) => {
    const dataDir = fixture(t);
    const host = await listen(t, createServer({ dataDir }));
    const response = await fetch(`http://${host}/dappnode_admin?qr`);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.deepEqual(
      Buffer.from(await response.arrayBuffer()).subarray(0, 8),
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    assert.ok(renderQr(config, true).includes(Buffer.from("\x1b[")));
  },
);

test("the installed CLI supports help, remote/localhost credentials and rejects removed peers", (t) => {
  const dataDir = fixture(t);
  const run = (...flags) =>
    spawnSync(
      process.execPath,
      [
        path.join(
          __dirname,
          "../dist/src/executables/getWireguardCredentials.js",
        ),
        ...flags,
      ],
      { env: { ...process.env, DATA_DIR: dataDir }, encoding: "utf8" },
    );
  assert.match(run("--help").stdout, /--localhost/);
  assert.ok(run().stdout.includes(config));
  assert.match(run("--localhost").stdout, /Endpoint = localhost:51821/);
  assert.equal(run("--unknown").status, 1);
  fs.writeFileSync(path.join(dataDir, "wg_confs/wg0.conf"), "[Interface]\n");
  assert.equal(run().status, 1);
});

test("health remains a valid peer name; readiness has a separate namespace", async (t) => {
  const dataDir = fixture(t);
  fs.appendFileSync(path.join(dataDir, "wg_confs/wg0.conf"), "# peer_health\n");
  fs.mkdirSync(path.join(dataDir, "peer_health"));
  fs.writeFileSync(path.join(dataDir, "peer_health/peer_health.conf"), config);
  const host = await listen(t, createServer({ dataDir }));
  const response = await fetch(`http://${host}/health`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), config);
});
