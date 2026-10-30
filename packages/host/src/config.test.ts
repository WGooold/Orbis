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
