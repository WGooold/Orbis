import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkClaudeAuthentication, claudeStartupSettings } from "./claude-startup.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "orbis-claude-startup-")); roots.push(root);
  const cwd = join(root, "repo"), configDir = join(root, "config");
  await mkdir(join(cwd, ".claude"), { recursive: true }); await mkdir(configDir);
  return { cwd, configDir, env: {}, managedSettingsPath: join(root, "managed.json") };
}
const plugin = "orbis-host-session-link@orbis-host";

describe("Claude startup prerequisites", () => {
  it("rejects failed account readiness without including native account details", async () => {
    const input = await fixture();
    const cli = join(input.configDir, process.platform === "win32" ? "auth-fixture.cmd" : "auth-fixture");
    const fixtureScript = (loggedIn: boolean) => {
      const json = JSON.stringify({ loggedIn, email: "private@example.invalid" });
      const code = loggedIn ? 0 : 1;
      return process.platform === "win32" ? `@echo off\r\necho ${json}\r\nexit /b ${code}\r\n`
        : `#!/bin/sh\nprintf '%s\\n' '${json}'\nexit ${code}\n`;
    };
    await writeFile(cli, fixtureScript(false), { mode: 0o755 });
    await expect(checkClaudeAuthentication(cli, input.cwd, process.env)).rejects.toThrow("尚未完成账号授权");
    await expect(checkClaudeAuthentication(cli, input.cwd, process.env)).rejects.not.toThrow("private@example.invalid");
    await writeFile(cli, fixtureScript(true));
    await expect(checkClaudeAuthentication(cli, input.cwd, process.env)).resolves.toBeUndefined();
  });

  it("snapshots only current project MCP names and preserves explicit denials", async () => {
    const input = await fixture();
    await writeFile(join(input.cwd, ".mcp.json"), JSON.stringify({ mcpServers: { docs: { command: "fixture" }, denied: {}, search: {} } }));
    const contents = JSON.stringify({ disabledMcpjsonServers: ["denied"], permissions: { defaultMode: "manual" } });
    await writeFile(join(input.cwd, ".claude/settings.local.json"), contents);
    const result = await claudeStartupSettings(input);
    expect(result).toEqual({ installed: false, args: ["--settings", '{"enabledMcpjsonServers":["docs","search"]}'] });
    expect(await readFile(join(input.cwd, ".claude/settings.local.json"), "utf8")).toBe(contents);
    expect(JSON.stringify(result)).not.toContain("enableAllProjectMcpServers");
  });
  it("does not add a blanket approval when no project MCP exists", async () => {
    expect(await claudeStartupSettings(await fixture())).toEqual({ installed: false, args: [] });
  });
  it("uses enabled Orbis installation and rejects explicit disable rather than loading a second copy", async () => {
    const input = await fixture();
    await writeFile(join(input.configDir, "settings.json"), JSON.stringify({ enabledPlugins: { [plugin]: true } }));
    expect((await claudeStartupSettings(input)).installed).toBe(true);
    await writeFile(join(input.cwd, ".claude/settings.local.json"), JSON.stringify({ enabledPlugins: { [plugin]: false } }));
    await expect(claudeStartupSettings(input)).rejects.toThrow("明确禁用");
  });
  it.each(["CLAUDE_CODE_SAFE_MODE", "CLAUDE_CODE_SIMPLE"])("rejects %s before opening an unusable terminal", async name => {
    await expect(claudeStartupSettings({ ...await fixture(), env: { [name]: "1" } })).rejects.toThrow(name);
  });
  it("reports hooks disabled and honors settings precedence", async () => {
    const input = await fixture();
    await writeFile(join(input.configDir, "settings.json"), '{"disableAllHooks":true}');
    await expect(claudeStartupSettings(input)).rejects.toThrow("disableAllHooks");
    await writeFile(join(input.cwd, ".claude/settings.local.json"), '{"disableAllHooks":false}');
    expect((await claudeStartupSettings(input)).args).toEqual([]);
    await writeFile(input.managedSettingsPath, '{"disableAllHooks":true}');
    await expect(claudeStartupSettings(input)).rejects.toThrow("disableAllHooks");
  });
  it("reports managed Mods restriction without overriding it", async () => {
    const input = await fixture();
    const policy = JSON.stringify({ pluginConfigs: { "cc-plugin-sec-default@builtin": { options: { allowManagedModsOnly: true } } } });
    await writeFile(join(input.configDir, "settings.json"), policy);
    await expect(claudeStartupSettings(input)).resolves.toMatchObject({ installed: false });
    await writeFile(input.managedSettingsPath, policy);
    await expect(claudeStartupSettings(input)).rejects.toThrow("管理策略");
  });
  it("requires managed plugin enablement under managed-only hooks", async () => {
    const input = await fixture();
    await writeFile(input.managedSettingsPath, '{"allowManagedHooksOnly":true}');
    await expect(claudeStartupSettings(input)).rejects.toThrow("管理设置启用");
    await writeFile(input.managedSettingsPath, JSON.stringify({ allowManagedHooksOnly: true, enabledPlugins: { [plugin]: true } }));
    await expect(claudeStartupSettings(input)).resolves.toMatchObject({ installed: true });
  });
  it("does not approve servers or disable the plugin from unrelated ancestors", async () => {
    const input = await fixture();
    await mkdir(join(input.cwd, "child"));
    await writeFile(join(input.cwd, ".mcp.json"), '{"mcpServers":{"parent-only":{}}}');
    await writeFile(join(input.cwd, ".claude/settings.json"), JSON.stringify({ enabledPlugins: { [plugin]: false } }));
    await expect(claudeStartupSettings({ ...input, cwd: join(input.cwd, "child") })).resolves.toEqual({ installed: false, args: [] });
  });
  it.each(["settings.json", "settings.local.json"])("reports malformed %s without exposing contents", async name => {
    const input = await fixture();
    await writeFile(join(input.cwd, ".claude", name), "private-malformed-value");
    await expect(claudeStartupSettings(input)).rejects.toThrow("格式无效");
    await expect(claudeStartupSettings(input)).rejects.not.toThrow("private-malformed-value");
  });
});
