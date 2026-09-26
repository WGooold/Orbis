import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRemoteControlConfig } from "./config.js";

describe("remote control configuration", () => {
  it("stays disabled when remote control has not been explicitly configured", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-remote-config-"));
    await expect(loadRemoteControlConfig({ configPath: join(directory, "missing.json"), env: {} }))
      .resolves.toBe(false);
  });

  it("enables only an installed local integration while honoring an explicit user disable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-remote-config-"));
    const configPath = join(directory, "remote-control.json");
    await writeFile(configPath, `\uFEFF${JSON.stringify({ orbisLocalEnabled: true })}`);
    await expect(loadRemoteControlConfig({ configPath, env: {} })).resolves.toBe(true);
    await expect(loadRemoteControlConfig({ env: { PI_CODING_AGENT_DIR: directory } })).resolves.toBe(true);
    await writeFile(configPath, JSON.stringify({ orbisLocalEnabled: true, enabled: false }));
    await expect(loadRemoteControlConfig({ configPath, env: {} })).resolves.toBe(false);
  });

  it("rejects unencrypted public relay URLs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-remote-config-"));
    const configPath = join(directory, "remote-control.json");
    await writeFile(configPath, JSON.stringify({
      enabled: true,
      relayUrl: "ws://relay.example.test",
      runtimeCredential: "secret-runtime-credential",
    }));

    await expect(loadRemoteControlConfig({ configPath, env: {} })).rejects.toThrow("wss://");
  });
});
