import http, { type Server } from "node:http";
import fs from "node:fs";
import path from "node:path";
import {
  ConfigError,
  type ConfigOptions,
  defaults,
  getConfig,
  renderQr,
} from "./config";

export function createServer(options: ConfigOptions = {}): Server {
  return http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "http://my.dappnode");
    res.setHeader("Cache-Control", "no-store");

    if (req.method === "OPTIONS") {
      res
        .writeHead(204, {
          "Access-Control-Allow-Methods": "GET,HEAD",
          "Access-Control-Allow-Headers":
            req.headers["access-control-request-headers"] || "",
        })
        .end();
      return;
    }

    try {
      const url = new URL(req.url || "/", "http://api.wireguard.dappnode");
      if (req.method !== "GET" && req.method !== "HEAD") {
        throw new ConfigError(405, "Method not allowed");
      }
      if (url.pathname === "/-/health") {
        const ready = fs.existsSync(
          path.join(options.dataDir || defaults.dataDir, ".ready"),
        );
        res
          .writeHead(ready ? 200 : 503)
          .end(ready ? "OK" : "WireGuard is not ready");
        return;
      }

      const encodedDevice = url.pathname.match(/^\/([^/]+)\/?$/)?.[1];
      if (!encodedDevice) throw new ConfigError(404, "Not found");
      let device: string;
      try {
        device = decodeURIComponent(encodedDevice);
      } catch {
        throw new ConfigError(400, "Invalid device");
      }

      const local = url.searchParams.has("local");
      const qr = url.searchParams.has("qr");
      if (local && qr) {
        throw new ConfigError(
          400,
          "QR mode is not supported for local HTTP credentials",
        );
      }
      const config = await getConfig(device, { ...options, local });
      const body =
        req.method === "HEAD" ? undefined : qr ? renderQr(config) : config;
      res.writeHead(200, {
        "Content-Type": qr ? "image/png" : "text/plain; charset=utf-8",
      });
      res.end(body);
    } catch (error: unknown) {
      const missing =
        error instanceof Error && "code" in error && error.code === "ENOENT";
      const status =
        error instanceof ConfigError ? error.status : missing ? 404 : 500;
      const message =
        error instanceof ConfigError
          ? error.message
          : status === 404
            ? "Not found"
            : "Unable to read peer configuration";
      if (!res.headersSent) {
        res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
      }
      res.end(message);
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.SERVER_PORT || 80);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("SERVER_PORT must be a valid TCP port");
  }
  const server = createServer().listen(port, "0.0.0.0", () => {
    console.log(`Listening on port ${port}`);
  });
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      server.close();
      server.closeAllConnections();
    });
  }
}
