import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ClaudeIntegrationError, findClaudeExecutable, updateClaudeIntegration, type ClaudeCommandRunner } from "./claude-integration-install.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

function recorder(codes: Record<string, number> = {}) {
  const calls: string[][] = [];
  const run: ClaudeCommandRunner = async (_file, args) => {
    calls.push([...args]);
    const key = args.slice(0, 3).join(" ");
    return { code: codes[key] ?? 0, stdout: "", stderr: codes[key] ? "✘ marketplace source is not a directory" : "" };
  };
  return { calls, run };
}

describe("updateClaudeIntegration", () => {
  it("registers the plugin directory, installs and refreshes its cached version at user scope", async () => {
    const { calls, run } = recorder();
    await expect(updateClaudeIntegration({ pluginDir: "/app/runtime/packages/claude-mod", uninstall: false, claude: "/bin/claude", run })).resolves.toBe("installed");
    expect(calls).toEqual([
      ["plugin", "marketplace", "add", "/app/runtime/packages/claude-mod"],
      ["plugin", "install", "orbis-host-session-link@orbis-host", "--scope", "user"],
      ["plugin", "update", "orbis-host-session-link@orbis-host", "--scope", "user"],
    ]);
  });

  it("reports Claude's own failure instead of claiming the plugin is installed", async () => {
    const { calls, run } = recorder({ "plugin marketplace add": 1 });
    await expect(updateClaudeIntegration({ pluginDir: "/missing", uninstall: false, claude: "/bin/claude", run }))
      .rejects.toThrow(ClaudeIntegrationError);
    expect(calls).toHaveLength(1);
  });

  it("reports a failed cache refresh so a later Host launch can retry the upgrade", async () => {
    const { calls, run } = recorder({ "plugin update orbis-host-session-link@orbis-host": 1 });
    await expect(updateClaudeIntegration({ pluginDir: "/app/plugin", uninstall: false, claude: "/bin/claude", run }))
      .rejects.toThrow("更新 Orbis Claude Code 插件失败");
    expect(calls).toHaveLength(3);
  });

  it("removes plugin and marketplace, tolerating either being absent", async () => {
    const { calls, run } = recorder({ "plugin uninstall orbis-host-session-link@orbis-host": 1, "plugin marketplace remove": 1 });
    await expect(updateClaudeIntegration({ pluginDir: "/x", uninstall: true, claude: "/bin/claude", run })).resolves.toBe("removed");
    expect(calls.map(call => call.slice(0, 2).join(" "))).toEqual(["plugin uninstall", "plugin marketplace"]);
  });

  it("installs for a new desktop profile without a saved preference", async () => {
    const root = await mkdtemp(join(tmpdir(), "orbis-claude-install-")); roots.push(root);
    const { calls, run } = recorder();
    await expect(updateClaudeIntegration({ pluginDir: root, uninstall: false, desktopSettingsPath: join(root, "settings.ini"), claude: "/bin/claude", run })).resolves.toBe("installed");
    expect(calls).toHaveLength(3);
  });

  it("preserves an explicit desktop opt-out during an update, but still removes on uninstall", async () => {
    const root = await mkdtemp(join(tmpdir(), "orbis-claude-install-")); roots.push(root);
    const settings = join(root, "settings.ini");
    await writeFile(settings, "\uFEFF[General]\r\nclaudeIntegrationEnabled=false\r\n");
    const { calls, run } = recorder();
    const input = { pluginDir: root, desktopSettingsPath: settings, claude: "/bin/claude", run };
    await expect(updateClaudeIntegration({ ...input, uninstall: false })).resolves.toBe("disabled");
    expect(calls).toEqual([]);
    await expect(updateClaudeIntegration({ ...input, uninstall: true })).resolves.toBe("removed");
    expect(calls).toHaveLength(2);
  });

  it("does not confuse another QSettings section with the integration preference", async () => {
    const root = await mkdtemp(join(tmpdir(), "orbis-claude-install-")); roots.push(root);
    const settings = join(root, "settings.ini");
    await writeFile(settings, "[General]\nclaudeIntegrationEnabled=true\n[Other]\nclaudeIntegrationEnabled=false\n");
    const { run } = recorder();
    await expect(updateClaudeIntegration({ pluginDir: root, uninstall: false, desktopSettingsPath: settings, claude: "/bin/claude", run })).resolves.toBe("installed");
  });
});

describe("findClaudeExecutable", () => {
  it("finds claude on PATH and in the native installer's default location", async () => {
    const home = await mkdtemp(join(tmpdir(), "orbis-claude-home-"));
    roots.push(home);
    const local = join(home, ".local", "bin");
    await mkdir(local, { recursive: true });
    await writeFile(join(local, "claude"), "#!/bin/sh\n");
    await chmod(join(local, "claude"), 0o755);
    await expect(findClaudeExecutable({ PATH: "/nonexistent" }, "darwin", home)).resolves.toBe(join(local, "claude"));
  });

  it("reports nothing when Claude Code is absent", async () => {
    const home = await mkdtemp(join(tmpdir(), "orbis-claude-home-"));
    roots.push(home);
    await expect(findClaudeExecutable({ PATH: home }, "darwin", home)).resolves.toBeUndefined();
  });
});
