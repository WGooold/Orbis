import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { createOpenClawLocalLauncher, localOpenClawPort } from "./openclaw-local-launch.js";

// HOST-AGENT-START-01: a local invocation never replaces a listening port; first pairing keeps an owned service alive.
it.skipIf(process.platform === "win32")("starts only the configured loopback Gateway and leaves it running for device approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbis-openclaw-start-"));
  const binary = join(root, "bin", "openclaw"), marker = join(root, "owned.json");
  const server = createServer(socket => socket.destroy());
  await mkdir(dirname(binary));
  await writeFile(binary, `#!/usr/bin/env node
    const fs = require("node:fs");
    const args = process.argv.slice(2);
    if (args[0] === "--version") console.log("OpenClaw 2026.11.5 (fixture)");
    else require("node:net").createServer(socket => socket.destroy()).listen(Number(args[args.indexOf("--port") + 1]), "127.0.0.1", () => {
      fs.writeFileSync(process.env.FIXTURE_MARKER, JSON.stringify({ args, pid: process.pid, inherited: process.env.ORBIS_OPENCLAW_TOKEN }));
    });
  `, { mode: 0o700 });
  const env = { HOME: root, PATH: [dirname(binary), dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
    ORBIS_QA_HOME: root, FIXTURE_MARKER: marker, ORBIS_OPENCLAW_TOKEN: "private-fixture-value" };
  const launcher = createOpenClawLocalLauncher(env);
  const guard = { signal: AbortSignal.timeout(7_000), check: () => {} };
  let ready = false, epoch = 0;
  const attached = { ready: () => ready, pairingEpoch: () => epoch, retry: async () => { ready = true; } };
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const remote of ["wss://gateway.example.test", "ws://192.0.2.20:18789", "wss://127.0.0.1:18789"]) {
      expect(localOpenClawPort(remote)).toBeUndefined();
      await expect(launcher.start(remote, guard, attached)).rejects.toThrow("只接入已有服务");
    }
    await launcher.start(url, guard, attached);
    expect(ready).toBe(true);
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    ready = false;
    await expect(launcher.start(url, guard, { ...attached, retry: async () => { epoch++; } })).rejects.toThrow("等待在 OpenClaw 中批准");
    const owned = JSON.parse(await readFile(marker, "utf8")) as { pid: number; args: string[]; inherited?: string };
    expect(owned.args).toEqual(["gateway", "run", "--bind", "loopback", "--port", String(localOpenClawPort(url)), "--tailscale", "off"]);
    expect(owned.inherited).toBeUndefined();
    expect(() => process.kill(owned.pid, 0)).not.toThrow();
  } finally {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    const owned = await readFile(marker, "utf8").then(value => JSON.parse(value) as { pid: number }, () => undefined);
    if (owned) {
      try { process.kill(owned.pid, "SIGTERM"); } catch { /* The fixture may already have exited. */ }
      await vi.waitFor(() => expect(() => process.kill(owned.pid, 0)).toThrow());
    }
    await rm(root, { recursive: true, force: true });
  }
});
