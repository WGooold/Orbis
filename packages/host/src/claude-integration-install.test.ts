import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ClaudeIntegrationError, findClaudeExecutable, updateClaudeIntegration, type ClaudeCommandRunner } from "./claude-integration-install.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

function recorder(codes: Record<string, number> = {}, version = "2.1.287") {
  const calls: string[][] = [];
  const run: ClaudeCommandRunner = async (_file, args) => {
    calls.push([...args]);
    const key = args.slice(0, 3).join(" ");
    return { code: codes[key] ?? 0, stdout: key === "--version" ? `${version} (Claude Code)` : "", stderr: codes[key] ? "✘ marketplace source is not a directory" : "" };
  };
  return { calls, run };
}

describe("updateClaudeIntegration", () => {
  // CLAUDE-MODS-MIN-02: a failed diagnostic must not disable the existing native installer.
  it("keeps plugin installation available when the version-only probe fails", async () => {
    const { calls, run } = recorder({ "--version": 1 });
    await expect(updateClaudeIntegration({ pluginDir: "/app/plugin", claude: "/bin/claude", run, uninstall: false })).resolves.toBe("installed");
    expect(calls).toHaveLength(4);
    expect(calls[3]).toEqual(["plugin", "update", "orbis-host-session-link@orbis-host", "--scope", "user"]);
  });

  // CLAUDE-MODS-MIN-01: an older CLI must not be presented as a working Mods
  // installation; cleanup remains available after a downgrade.
  it("rejects plugin installation on old Claude while still allowing removal", async () => {
    const { calls, run } = recorder({}, "2.1.286");
    const input = { pluginDir: "/app/plugin", claude: "/bin/claude", run };
    await expect(updateClaudeIntegration({ ...input, uninstall: false })).rejects.toThrow("最低 2.1.287");
    expect(calls).toEqual([["--version"]]);
    calls.length = 0;
    await expect(updateClaudeIntegration({ ...input, uninstall: true })).resolves.toBe("removed");
    expect(calls.map(call => call.slice(0, 2).join(" "))).toEqual(["plugin uninstall", "plugin marketplace"]);
  });

  it("registers the plugin directory, installs and refreshes its cached version at user scope", async () => {
    const { calls, run } = recorder();
    await expect(updateClaudeIntegration({ pluginDir: "/app/runtime/packages/claude-mod", uninstall: false, claude: "/bin/claude", run })).resolves.toBe("installed");
    expect(calls).toEqual([
      ["--version"],
      ["plugin", "marketplace", "add", "/app/runtime/packages/claude-mod"],
      ["plugin", "install", "orbis-host-session-link@orbis-host", "--scope", "user"],
      ["plugin", "update", "orbis-host-session-link@orbis-host", "--scope", "user"],
    ]);
    // The plugin directory comes from a directory URL, so it carries a trailing separator.
    // Claude Code 2.1.310 answers `Path does not exist: <dir>\` for that form of an existing directory.
    for (const [pluginDir, added] of [["/app/runtime/packages/claude-mod/", "/app/runtime/packages/claude-mod"],
      ["D:\\app\\runtime\\packages\\claude-mod\\", "D:\\app\\runtime\\packages\\claude-mod"]] as const) {
      calls.length = 0;
      await expect(updateClaudeIntegration({ pluginDir, uninstall: false, claude: "/bin/claude", run })).resolves.toBe("installed");
      expect(calls[1]).toEqual(["plugin", "marketplace", "add", added]);
    }
  });

  it("reports Claude's own failure instead of claiming the plugin is installed", async () => {
    const { calls, run } = recorder({ "plugin marketplace add": 1 });
    await expect(updateClaudeIntegration({ pluginDir: "/missing", uninstall: false, claude: "/bin/claude", run }))
      .rejects.toThrow(ClaudeIntegrationError);
    expect(calls).toHaveLength(2);
  });

  it("reports a failed cache refresh so a later Host launch can retry the upgrade", async () => {
    const { calls, run } = recorder({ "plugin update orbis-host-session-link@orbis-host": 1 });
    await expect(updateClaudeIntegration({ pluginDir: "/app/plugin", uninstall: false, claude: "/bin/claude", run }))
      .rejects.toThrow("更新 Orbis Claude Code 插件失败");
    expect(calls).toHaveLength(4);
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
    expect(calls).toHaveLength(4);
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
