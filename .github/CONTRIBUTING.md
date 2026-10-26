# Contributing

Keep the Dappmanager API, terminal commands, Compose service names and persisted
WireGuard identities compatible. Runtime TypeScript uses Node built-ins and the
native QR tool; new production dependencies need a concrete justification.

Follow the [README validation procedure](../README.md#validation) before opening
a PR. Add a regression test for networking, state migration or credential changes.
Use the PR template and report the tested baseline and any untested deployment
paths. The integration test supports a disposable native host through DOCKER_HOST;
it must never replace installed services or use their live config volume.

README.md is maintained directly. There is no LinuxServer/Jenkins documentation
generation, architecture-specific VPN Dockerfile or generated package inventory.
