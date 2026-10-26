#!/usr/bin/env node
import { ConfigError, getConfig, renderQr } from "../config";

const help = `Get your wireguard credentials. Command: dappnode_wireguard

--qr         Show a terminal QR code
--local      Use the LAN endpoint
--localhost  Use the localhost endpoint
--help       Print this message`;

async function main(): Promise<void> {
  const flags = new Set(process.argv.slice(2));
  if (flags.has("--help")) {
    console.log(help);
    return;
  }
  for (const flag of flags) {
    if (!["--qr", "--local", "--localhost"].includes(flag)) {
      throw new ConfigError(400, `Unknown option: ${flag}`);
    }
  }

  const config = await getConfig("dappnode_admin", {
    local: flags.has("--local"),
    localhost: flags.has("--localhost"),
  });
  const mode = flags.has("--local") ? "local" : "remote";
  const format = flags.has("--qr") ? "qr" : "text";
  console.log(
    `Preparing ${mode} ${format} Wireguard credentials; use CTRL + C to stop`,
  );
  if (!flags.has("--qr")) {
    console.log(`\n\n${config}\n\n`);
    return;
  }
  try {
    process.stdout.write(renderQr(config, true));
  } catch {
    console.error(
      "Unable to render QR code; showing text credentials instead.",
    );
    console.log(config);
  }
}

main().catch((error: unknown) => {
  console.error(
    error instanceof ConfigError
      ? error.message
      : "Unable to read WireGuard credentials",
  );
  process.exitCode = 1;
});
