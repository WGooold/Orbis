import { testDirectory } from "../../../scripts/test-fixtures/temp-directory.js";
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// These tests render macOS launch scripts on every runner. Execute the fake
// CLI through its native Windows shim when the test runner itself is Windows.
vi.mock("./claude-startup.js", async original => {
  const actual = await original<typeof import("./claude-startup.js")>();
  return { ...actual, checkClaudeAuthentication: (cli: string, cwd: string, env: NodeJS.ProcessEnv) =>
    actual.checkClaudeAuthentication(process.platform === "win32" ? `${cli}.cmd` : cli, cwd, env) };
});

import { TerminalClaudeLauncher, posixScript, windowsScript } from "./claude-launcher.js";

async function writeClaudeFixture(bin: string, loggedIn: boolean) {
  const json = JSON.stringify({ loggedIn });
  const code = loggedIn ? 0 : 1;
  await writeFile(join(bin, "claude"), `#!/bin/sh\nprintf '%s\\n' '${json}'\nexit ${code}\n`, { mode: 0o755 });
  if (process.platform === "win32") await writeFile(join(bin, "claude.cmd"), `@echo off\r\necho ${json}\r\nexit /b ${code}\r\n`);
}

async function setup() {
  const root = await testDirectory(join(tmpdir(), "orbis-claude-launch-"));
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  await writeClaudeFixture(bin, true);
  const pluginDir = join(root, "plugin");
  await mkdir(join(pluginDir, ".claude-plugin"), { recursive: true });
  await writeFile(join(pluginDir, ".claude-plugin", "plugin.json"), "{}");
  const config = join(root, "config");
  await mkdir(config, { recursive: true });
  return { root, bin, pluginDir, config, env: { PATH: `${bin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`, HOME: root } };
}

describe("TerminalClaudeLauncher", () => {
  it("opens Terminal on macOS with a self-removing script that loads the plugin only when it is not installed", async () => {
    const { root, bin, pluginDir, config, env } = await setup();
    const cwd = await realpath(await mkdir(join(root, "work", "it's here"), { recursive: true }).then(() => join(root, "work", "it's here")));
    const runs: [string, readonly string[]][] = [];
    const launcher = new TerminalClaudeLauncher({ stateDir: join(root, "state"), configDir: config, env, platform: "darwin", pluginDir,
      run: async (command, args) => {
        expect(JSON.parse(await readFile(join(config, ".claude.json"), "utf8")).projects[cwd].hasTrustDialogAccepted).toBe(true);
        runs.push([command, args]);
        await writeFile(`${args[2]!}.started`, "");
      } });
    expect(await launcher.unavailable()).toBeUndefined();
    await launcher.launch({ cwd, resume: "abc-123", launchId: "launch-1" });
    expect(runs).toEqual([["/usr/bin/open", ["-a", "Terminal", join(root, "state", "tmp", "claude-launch-1.command")]]]);
    const script = await readFile(join(root, "state", "tmp", "claude-launch-1.command"), "utf8");
    expect(script).toContain(`cd -- '${cwd.replaceAll("'", "'\\''")}' || exit 1`);
    expect(script).toContain(`export CLAUDE_CONFIG_DIR='${config}'`);
    expect(JSON.parse(await readFile(join(config, ".claude.json"), "utf8")).projects[cwd]).toEqual({ hasTrustDialogAccepted: true });
    expect(script).not.toContain("--dangerously-skip-permissions");
    expect(script).toContain("export ORBIS_CLAUDE_LAUNCH_ID='launch-1'");
    expect(script).toContain(`exec '${join(bin, "claude")}' '--resume' 'abc-123' '--plugin-dir' '${pluginDir}'`);
    expect(script).toContain('rm -f -- "$0"');
    expect(script).toContain("[ -t 0 ] || exit 1");
    expect(script).toContain(".command.started' || exit 1");
    expect((await readdir(join(root, "state", "tmp"))).some(name => name.endsWith(".started"))).toBe(false);

    await writeFile(join(config, "settings.json"), JSON.stringify({ enabledPlugins: { "orbis-host-session-link@orbis-host": true } }));
    await launcher.launch({ cwd, launchId: "launch-2" });
    expect(await readFile(join(root, "state", "tmp", "claude-launch-2.command"), "utf8")).toContain(`exec '${join(bin, "claude")}'\n`);
  });

  it("reports why it cannot open a terminal instead of guessing", async () => {
    const { root, config, env } = await setup();
    expect(await new TerminalClaudeLauncher({ stateDir: root, configDir: config, env, platform: "linux" }).unavailable()).toContain("终端窗口");
    expect(await new TerminalClaudeLauncher({ stateDir: root, configDir: config, env: { PATH: "/nowhere" }, home: "/nowhere", platform: "darwin" }).unavailable())
      .toContain("没有找到 Claude Code");
    const launcher = new TerminalClaudeLauncher({ stateDir: join(root, "s"), configDir: config, env, platform: "darwin", pluginDir: join(root, "missing"),
      run: async () => undefined });
    await expect(launcher.launch({ cwd: root, launchId: "x" })).rejects.toThrow("Host 设置");
    expect(await readdir(join(root, "s", "tmp")).catch(() => [])).toEqual([]);
  });

  it("fails before opening for missing login but keeps explicit local setup reachable", async () => {
    const { root, config, env, pluginDir } = await setup();
    await writeClaudeFixture(join(root, "bin"), false);
    const calls: string[] = [];
    const launcher = new TerminalClaudeLauncher({ stateDir: join(root, "state"), configDir: config, env, platform: "darwin", pluginDir,
      run: async (command, args) => { calls.push(command); await writeFile(`${args[2]!}.started`, ""); } });
    await expect(launcher.launch({ cwd: root, launchId: "no-login" })).rejects.toThrow("账号授权");
    expect(calls).toEqual([]);
    await launcher.launch({ cwd: root, launchId: "local-setup", setup: true });
    expect(calls).toEqual(["/usr/bin/open"]);
  });

  it("passes project MCP consent by private file and cleans up on opener failure", async () => {
    const { root, config, env, pluginDir } = await setup();
    await writeFile(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { 'name"with&quotes': {} } }));
    const launcher = new TerminalClaudeLauncher({ stateDir: join(root, "state"), configDir: config, env, platform: "darwin", pluginDir,
      run: async () => {
        const script = await readFile(join(root, "state/tmp/claude-mcp.command"), "utf8");
        expect(script).not.toContain('name"with&quotes');
        expect(script).toContain("claude-mcp.settings.json");
        expect(JSON.parse(await readFile(join(root, "state/tmp/claude-mcp.settings.json"), "utf8")))
          .toEqual({ enabledMcpjsonServers: ['name"with&quotes'] });
        throw new Error("opener failed");
      } });
    await expect(launcher.launch({ cwd: root, launchId: "mcp" })).rejects.toThrow("opener failed");
    expect(await readdir(join(root, "state/tmp"))).toEqual([]);
  });

  it("does not open a terminal when trust cannot be recorded", async () => {
    const { root, config, env, pluginDir } = await setup();
    await writeFile(join(config, ".claude.json"), "invalid config");
    let opened = false;
    const launcher = new TerminalClaudeLauncher({ stateDir: join(root, "state"), configDir: config, env, platform: "darwin", pluginDir,
      run: async () => { opened = true; } });
    await expect(launcher.launch({ cwd: root, launchId: "invalid" })).rejects.toThrow("配置不是有效 JSON");
    expect(opened).toBe(false);
    expect(await readFile(join(config, ".claude.json"), "utf8")).toBe("invalid config");
    expect(await readdir(join(root, "state", "tmp")).catch(() => [])).toEqual([]);
  });

  it("rejects an unexecuted script and removes it instead of claiming the terminal opened", async () => {
    const { root, config, env, pluginDir } = await setup();
    await writeFile(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { fixture: {} } }));
    const launcher = new TerminalClaudeLauncher({ stateDir: join(root, "state"), configDir: config, env,
      platform: "darwin", pluginDir, run: async () => undefined });
    const clock = vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(10_001);
    try {
      await expect(launcher.launch({ cwd: root, launchId: "never-started" })).rejects.toThrow("未确认执行 Claude Code 启动脚本");
      expect(await readdir(join(root, "state", "tmp"))).toEqual([]);
    } finally { clock.mockRestore(); }
  });

  it("writes cmd scripts with quoted paths for Windows", () => {
    const script = windowsScript({ cwd: "C:\\Users\\A B\\repo", claude: "C:\\bin\\claude.exe", args: ["--resume", "id"], launchId: "l", stateDir: "C:\\state 100%" });
    expect(script.split("\r\n")).toEqual(["@echo off", 'cd /d "C:\\Users\\A B\\repo" || exit /b 1', 'set "ORBIS_CLAUDE_LAUNCH_ID=l"', 'set "ORBIS_STATE_DIR=C:\\state 100%%"', 'set "CLAUDE_CONFIG_DIR="',
      '"C:\\bin\\claude.exe" "--resume" "id"', ""]);
    expect(posixScript({ cwd: "/r", claude: "/c", args: [], launchId: "l", stateDir: "/s" })).toMatch(/^#!\/bin\/sh\n/u);
    expect(posixScript({ cwd: "/r", claude: "/c", args: [], launchId: "l", stateDir: "/s" })).toContain("unset CLAUDE_CONFIG_DIR");
    expect(windowsScript({ cwd: "C:\\repo", claude: "C:\\claude.exe", args: [], launchId: "l", stateDir: "C:\\state",
      configDir: "C:\\config 100%" })).toContain('set "CLAUDE_CONFIG_DIR=C:\\config 100%%"');
  });

  // SC82: a .cmd child must return so private startup settings are removed.
  it("starts Windows script launchers through the shared invocation and retains cleanup", () => {
    const script = windowsScript({ cwd: "C:\\work", claude: "C:\\用户 Tools\\claude.cmd", args: ["--model", "a&b"],
      launchId: "l", stateDir: "C:\\state", settingsFile: "C:\\state\\settings.json" });
    const encoded = /-EncodedCommand ([A-Za-z0-9+/=]+)/u.exec(script)![1]!;
    const command = Buffer.from(encoded, "base64").toString("utf16le");
    expect(command).toContain("System.Diagnostics.ProcessStartInfo");
    expect(command).toContain("claude.cmd");
    expect(command).toContain("a^&b");
    expect(script).toContain('del /q "C:\\state\\settings.json"');
  });
});
