import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { updatePiIntegration } from "./pi-integration-install.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(): Promise<{ agentDir: string; extensionDir: string; oldDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "orbis-pi-install-"));
  dirs.push(root);
  const agentDir = join(root, "agent");
  const extensionDir = join(root, "host", "packages", "pi-extension");
  const oldDir = join(root, "old", "packages", "pi-extension");
  for (const dir of [extensionDir, oldDir]) {
    await mkdir(join(dir, "dist"), { recursive: true });
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "@pi-remote/pi-extension" }));
    await writeFile(join(dir, "dist", "index.js"), "export default () => {};\n");
  }
  await mkdir(agentDir);
  return { agentDir, extensionDir, oldDir };
}

const json = async (path: string): Promise<Record<string, unknown>> => JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;

describe("installed Pi integration", () => {
  it("replaces the old Orbis package without changing other Pi settings, and survives reinstallation", async () => {
    const { agentDir, extensionDir, oldDir } = await fixture();
    const settingsPath = join(agentDir, "settings.json");
    const controlPath = join(agentDir, "remote-control.json");
    const other = { source: "npm:pi-subagents", skills: [] };
    await writeFile(settingsPath, JSON.stringify({ defaultModel: "my-model", packages: [oldDir, other] }));
    await writeFile(controlPath, JSON.stringify({ relayUrl: "wss://example.test", runtimeCredential: "private", custom: 7 }));

    await updatePiIntegration({ extensionDir, agentDir });
    await updatePiIntegration({ extensionDir, agentDir });
    expect(await json(settingsPath)).toEqual({ defaultModel: "my-model", packages: [other, extensionDir] });
    expect(await json(controlPath)).toEqual({ relayUrl: "wss://example.test", runtimeCredential: "private", custom: 7, orbisLocalEnabled: true });

    await updatePiIntegration({ extensionDir, agentDir, uninstall: true });
    expect(await json(settingsPath)).toEqual({ defaultModel: "my-model", packages: [other] });
    expect(await json(controlPath)).toEqual({ relayUrl: "wss://example.test", runtimeCredential: "private", custom: 7 });
  });

  it("does not overwrite an explicit opt-out or malformed Pi settings", async () => {
    const { agentDir, extensionDir } = await fixture();
    const settingsPath = join(agentDir, "settings.json");
    const controlPath = join(agentDir, "remote-control.json");
    await writeFile(controlPath, JSON.stringify({ enabled: false, orbisLocalEnabled: false }));
    await writeFile(settingsPath, "not json");
    await expect(updatePiIntegration({ extensionDir, agentDir })).rejects.toThrow();
    expect(await readFile(settingsPath, "utf8")).toBe("not json");
    expect(await json(controlPath)).toEqual({ enabled: false, orbisLocalEnabled: false });

    await writeFile(settingsPath, "{}");
    await updatePiIntegration({ extensionDir, agentDir });
    expect(await json(controlPath)).toEqual({ enabled: false, orbisLocalEnabled: false });
  });
});
