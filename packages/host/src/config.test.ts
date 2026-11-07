import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadHostConfig } from "./config.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe("Orbis Host configuration", () => {
  it("isolates background history only when explicitly configured and validates overrides", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "orbis-history-config-"));
    temporaryDirectories.push(stateDir);
    const base = { relayUrl: "wss://relay.example.test", runtimeCredential: "fixture" };
    await writeFile(join(stateDir, "config.json"), JSON.stringify(base));
    expect((await loadHostConfig({ stateDir, env: {} })).relayHistoryMode).toBe("shared");
    await writeFile(join(stateDir, "config.json"), JSON.stringify({ ...base, relayHistoryMode: "background" }));
    expect((await loadHostConfig({ stateDir, env: {} })).relayHistoryMode).toBe("background");
    expect((await loadHostConfig({ stateDir, env: { ORBIS_RELAY_HISTORY_MODE: "shared" } })).relayHistoryMode).toBe("shared");
    await expect(loadHostConfig({ stateDir, env: { ORBIS_RELAY_HISTORY_MODE: "new-channel" } })).rejects.toThrow("relayHistoryMode");
  });

  // NQ-16: a missing preference selects Auto while explicit WS/QUIC and overrides retain their meaning.
  it("defaults to Auto, persists the chosen mode and strictly validates environment overrides", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "orbis-transport-config-"));
    temporaryDirectories.push(stateDir);
    const base = { relayUrl: "wss://relay.example.test", runtimeCredential: "fixture" };
    await writeFile(join(stateDir, "config.json"), JSON.stringify(base));
    expect((await loadHostConfig({ stateDir, env: {} })).relayTransport).toBe("auto");
    await writeFile(join(stateDir, "config.json"), JSON.stringify({ ...base, relayTransport: "ws" }));
    expect((await loadHostConfig({ stateDir, env: {} })).relayTransport).toBe("ws");
    await writeFile(join(stateDir, "config.json"), JSON.stringify({ ...base, relayTransport: "quic" }));
    expect((await loadHostConfig({ stateDir, env: {} })).relayTransport).toBe("quic");
    expect((await loadHostConfig({ stateDir, env: { ORBIS_RELAY_TRANSPORT: "auto" } })).relayTransport).toBe("auto");
    await expect(loadHostConfig({ stateDir, env: { ORBIS_RELAY_TRANSPORT: "udp" } })).rejects.toThrow("ws、quic 或 auto");
    await writeFile(join(stateDir, "config.json"), JSON.stringify({ ...base, relayTransport: true }));
    await expect(loadHostConfig({ stateDir, env: {} })).rejects.toThrow("ws、quic 或 auto");
  });
  it("loads the Orbis config independently of a malformed legacy Pi config", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "orbis-config-"));
    temporaryDirectories.push(stateDir);
    const agentConfigPath = join(stateDir, "legacy-pi.json");
    await writeFile(agentConfigPath, "invalid");
    await writeFile(join(stateDir, "config.json"), JSON.stringify({ relayUrl: "wss://relay.example.test", runtimeCredential: "current" }));
    const config = await loadHostConfig({ stateDir, agentConfigPath, env: {} });
    expect(config.relayUrl).toBe("wss://relay.example.test");
    expect(config.runtimeCredential).toBe("current");
  });

  it("retains the old Pi config and environment as fallback while preferring Orbis values", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "orbis-config-"));
    temporaryDirectories.push(stateDir);
    const agentConfigPath = join(stateDir, "legacy-pi.json");
    await writeFile(agentConfigPath, JSON.stringify({ relayUrl: "wss://legacy.example.test", runtimeCredential: "legacy" }));
    expect((await loadHostConfig({ stateDir, agentConfigPath, env: {} })).runtimeCredential).toBe("legacy");
    const config = await loadHostConfig({ stateDir, agentConfigPath, env: {
      ORBIS_RELAY_URL: "wss://orbis.example.test", PI_REMOTE_RELAY_URL: "wss://old.example.test",
      PI_REMOTE_RUNTIME_CREDENTIAL: "existing", ORBIS_LAN_PORT: "42132", PI_REMOTE_LAN_PORT: "42133",
    } });
    expect(config.relayUrl).toBe("wss://orbis.example.test");
    expect(config.runtimeCredential).toBe("existing");
    expect(config.lanPort).toBe(42132);
  });
});
