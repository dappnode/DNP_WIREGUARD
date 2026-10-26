// Private-network stand-in for Dappmanager and BIND. No external DNS is used.
const http = require("node:http");
const dgram = require("node:dgram");
const os = require("node:os");
const ip = Object.values(os.networkInterfaces())
  .flat()
  .find((entry) => entry.family === "IPv4" && !entry.internal).address;
http
  .createServer((req, res) => {
    res.end(
      req.url === "/source"
        ? req.socket.remoteAddress
        : req.url.endsWith("INTERNAL_IP")
          ? "192.168.50.2"
          : "wg-test-server",
    );
  })
  .listen(80, "0.0.0.0");
const dns = dgram.createSocket("udp4");
dns.on("message", (query, client) => {
  let end = 12;
  while (end < query.length && query[end]) end += query[end] + 1;
  if (end + 5 > query.length) return;
  const isA = query.readUInt16BE(end + 1) === 1;
  const header = Buffer.from(query.subarray(0, 12));
  header.writeUInt16BE(0x8180, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(isA ? 1 : 0, 6);
  header.writeUInt32BE(0, 8);
  const answer = Buffer.from([
    0xc0,
    0x0c,
    0,
    1,
    0,
    1,
    0,
    0,
    0,
    60,
    0,
    4,
    ...ip.split(".").map(Number),
  ]);
  dns.send(
    Buffer.concat([
      header,
      query.subarray(12, end + 5),
      ...(isA ? [answer] : []),
    ]),
    client.port,
    client.address,
  );
});
dns.bind(53, "0.0.0.0");
