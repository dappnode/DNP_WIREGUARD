import fs from "node:fs";
import path from "node:path";
import { isIP } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { spawnSync } from "node:child_process";

export class ConfigError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ConfigOptions {
  dataDir?: string;
  hostnames?: readonly string[];
  attempts?: number;
  retryDelay?: number;
  requestTimeout?: number;
}

export interface CredentialOptions extends ConfigOptions {
  local?: boolean;
  localhost?: boolean;
}

export const defaults = {
  dataDir: process.env.DATA_DIR || "/config",
  hostnames: ["my.dappnode", "dappmanager.dappnode", "172.33.1.7", "10.20.0.7"],
  attempts: 30,
  retryDelay: 1000,
  requestTimeout: 3000,
};

export function readConfig(
  device: string,
  options: ConfigOptions = {},
): string {
  if (!/^[a-zA-Z0-9_]+$/.test(device)) {
    throw new ConfigError(400, "Invalid device");
  }

  const dataDir = options.dataDir || defaults.dataDir;
  const server = fs.readFileSync(
    path.join(dataDir, "wg_confs/wg0.conf"),
    "utf8",
  );
  const activePeers = new Set(
    server
      .split(/\r?\n/)
      .filter((line) => /^# peer_?\w+$/.test(line))
      .map((line) => line.slice(2)),
  );
  // Numeric PEERS counts use peer1; explicitly named peers use peer_name.
  const candidates = [`peer_${device}`];
  if (/^\d+$/.test(device)) candidates.push(`peer${device}`);
  const peer = candidates.find((name) => activePeers.has(name));
  if (!peer) throw new ConfigError(404, "Not found");

  const file = fs.realpathSync(path.join(dataDir, peer, `${peer}.conf`));
  const root = fs.realpathSync(dataDir);
  if (!file.startsWith(`${root}${path.sep}${peer}${path.sep}`)) {
    throw new ConfigError(400, "Invalid config path");
  }
  if (fs.statSync(file).size > 65536) {
    throw new ConfigError(500, "Invalid config size");
  }
  return fs.readFileSync(file, "utf8");
}

export function setEndpoint(config: string, endpoint: string): string {
  if (!/^Endpoint\s*=/m.test(config)) {
    throw new ConfigError(500, "Config has no endpoint");
  }
  return config.replace(/^Endpoint\s*=.*$/m, `Endpoint = ${endpoint}`);
}

export async function getLocalIp(options: ConfigOptions = {}): Promise<string> {
  const settings = { ...defaults, ...options };
  for (let attempt = 0; attempt < settings.attempts; attempt++) {
    for (const hostname of settings.hostnames) {
      try {
        const response = await fetch(
          `http://${hostname}/global-envs/INTERNAL_IP`,
          {
            redirect: "error",
            signal: AbortSignal.timeout(settings.requestTimeout),
          },
        );
        if (!response.ok) {
          await response.body?.cancel();
          continue;
        }
        const ip = await response.text();
        if (isIP(ip)) return ip;
      } catch {
        // Try the next Dappmanager address without logging credential contents.
      }
    }
    if (attempt + 1 < settings.attempts) await delay(settings.retryDelay);
  }
  throw new ConfigError(503, "Dappmanager local IP is unavailable");
}

export async function getConfig(
  device: string,
  { local = false, localhost = false, ...options }: CredentialOptions = {},
): Promise<string> {
  let config = readConfig(device, options);
  // Local variants change only the host, including for non-default server ports.
  const port = config.match(/^Endpoint\s*=\s*.*:(\d+)\s*$/m)?.[1];
  if (!port) throw new ConfigError(500, "Invalid endpoint");

  if (local) {
    const ip = await getLocalIp(options);
    config = setEndpoint(config, `${isIP(ip) === 6 ? `[${ip}]` : ip}:${port}`);
  }
  if (localhost) config = setEndpoint(config, `localhost:${port}`);
  return config;
}

export function renderQr(config: string, terminal = false): Buffer {
  const result = spawnSync(
    "qrencode",
    ["-l", "L", "-t", terminal ? "ANSIUTF8" : "PNG", "-o", "-"],
    { input: config, maxBuffer: 1024 * 1024, timeout: 5000 },
  );
  if (result.error || result.status !== 0) {
    throw new ConfigError(500, "Unable to render QR code");
  }
  return result.stdout;
}
