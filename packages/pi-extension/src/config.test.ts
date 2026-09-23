import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRemoteControlConfig } from "./config.js";

describe("remote control configuration", () => {
  it("stays disabled when remote control has not been explicitly configured", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-remote-config-"));
    await expect(loadRemoteControlConfig({ configPath: join(directory, "missing.json"), env: {} }))
      .resolves.toBeUndefined();
  });

  it("loads a UTF-8 BOM-prefixed configuration file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-remote-config-"));
    const configPath = join(directory, "remote-control.json");
    await writeFile(configPath, `\uFEFF${JSON.stringify({
      enabled: true,
      relayUrl: "wss://relay.example.test",
      runtimeCredential: "secret-runtime-credential",
    })}`, "utf8");

    await expect(loadRemoteControlConfig({ configPath, env: {} })).resolves.toEqual({
      relayUrl: "wss://relay.example.test",
      credential: "secret-runtime-credential",
    });
  });

  it("loads an explicitly enabled encrypted relay configuration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-remote-config-"));
    const configPath = join(directory, "remote-control.json");
    await writeFile(configPath, JSON.stringify({
      enabled: true,
      relayUrl: "wss://relay.example.test",
      runtimeCredential: "secret-runtime-credential",
    }));

    await expect(loadRemoteControlConfig({ configPath, env: {} })).resolves.toEqual({
      relayUrl: "wss://relay.example.test",
      credential: "secret-runtime-credential",
    });
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
