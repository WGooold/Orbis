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

vi.mock("./claude-version.js", async original => {
  const actual = await original<typeof import("./claude-version.js")>();
  return { ...actual, requireClaudeModsVersion: (cli: string, env: NodeJS.ProcessEnv, cwd?: string) =>
    actual.requireClaudeModsVersion(process.platform === "win32" ? `${cli}.cmd` : cli, env, cwd) };
});

vi.mock("./session-configuration-probe.js", () => ({
  claudeSessionConfiguration: vi.fn(async (_cli, _cwd, _env, selected) => ({ defaults: selected ?? {} })),
}));

import { TerminalClaudeLauncher, posixScript, windowsClaudeConsole, windowsScript } from "./claude-launcher.js";
import { ClaudeStartupBlocked } from "./claude-startup.js";
import { claudeSessionConfiguration } from "./session-configuration-probe.js";

async function writeClaudeFixture(bin: string, loggedIn: boolean, version = "2.1.287") {
  const json = JSON.stringify({ loggedIn });
  const code = loggedIn ? 0 : 1;
  await writeFile(join(bin, "claude"), `#!/bin/sh\nif [ "$1" = '--version' ]; then\n  printf '%s\\n' '${version} (Claude Code)'\n  exit 0\nfi\nprintf '%s\\n' '${json}'\nexit ${code}\n`, { mode: 0o755 });
  if (process.platform === "win32") await writeFile(join(bin, "claude.cmd"), `@echo off\r\nif "%~1"=="--version" (\r\necho ${version} ^(Claude Code^)\r\nexit /b 0\r\n)\r\necho ${json}\r\nexit /b ${code}\r\n`);
}

async function setup() {
  const root = await testDirectory(join(tmpdir(), "orbis-claude-launch-"));
  // Discovery through PATH cannot be expressed on a Windows host: cliPathDirs splits by the
  // simulated platform's separator, so `C:\…` would be cut at its drive colon. The native
  // installer's own directory is searched without PATH and works on every host.
  const bin = join(root, ".local", "bin");
  await mkdir(bin, { recursive: true });
  await writeClaudeFixture(bin, true);
  const pluginDir = join(root, "plugin");
  await mkdir(join(pluginDir, ".claude-plugin"), { recursive: true });
  await writeFile(join(pluginDir, ".claude-plugin", "plugin.json"), "{}");
  const config = join(root, "config");
  await mkdir(config, { recursive: true });
  // A PATH entry for the simulated POSIX platform is prepended with ':' on purpose: this host
  // may be Windows, where the drive colon makes that entry unparsable, and the same directory is
  // still searched as `~/.local/bin`. Both hosts therefore discover the identical launcher path.
  return { root, bin, pluginDir, config, env: { PATH: `${bin}:${process.env.PATH}`, HOME: root } };
}

describe("TerminalClaudeLauncher", () => {
  // CLAUDE-MODS-MIN-02: a wrapper that cannot report a version still reaches
  // the original authentication, terminal launch and native handshake path.
  it("does not block a usable TUI solely because the version probe is unreadable", async () => {
    const { root, bin, pluginDir, config, env } = await setup();
    await writeClaudeFixture(bin, true, "unreadable");
    const run = vi.fn(async (_command: string, args: readonly string[]) => { await writeFile(`${args[2]!}.started`, ""); });
    const launcher = new TerminalClaudeLauncher({ stateDir: join(root, "state"), configDir: config, env, platform: "darwin", pluginDir, run });
    await launcher.launch({ cwd: root, launchId: "unreadable-version", resume: "saved" });
    expect(run).toHaveBeenCalledTimes(1);
    await writeClaudeFixture(bin, false, "unreadable");
    await expect(launcher.launch({ cwd: root, launchId: "still-check-login" })).rejects.toThrow("账号授权");
    expect(run).toHaveBeenCalledTimes(1);
  });

  // CLAUDE-MODS-MIN-01: reject before opening or writing project trust, including
  // old-session recovery and local setup; re-read after an in-place CLI update.
  it("blocks unsupported Claude before new, resumed and setup launches and configuration reads", async () => {
    const { root, bin, pluginDir, config, env } = await setup();
    await writeClaudeFixture(bin, true, "2.1.286");
    const run = vi.fn(async (_command: string, args: readonly string[]) => { await writeFile(`${args[2]!}.started`, ""); });
    const launcher = new TerminalClaudeLauncher({ stateDir: join(root, "state"), configDir: config, env, platform: "darwin", pluginDir, run });
    for (const extra of [{}, { resume: "saved" }, { setup: true }]) {
      const pending = launcher.launch({ cwd: root, launchId: "old-cli", ...extra });
      await expect(pending).rejects.toBeInstanceOf(ClaudeStartupBlocked);
      await expect(pending).rejects.toThrow("最低 2.1.287");
    }
    vi.mocked(claudeSessionConfiguration).mockClear();
    await expect(launcher.sessionConfiguration(root)).rejects.toThrow("Claude Code 2.1.286");
    expect(claudeSessionConfiguration).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(await readdir(config)).toEqual([]);
    expect(await readdir(join(root, "state/tmp")).catch(() => [])).toEqual([]);
    await writeClaudeFixture(bin, true, "2.1.287");
    await launcher.launch({ cwd: root, launchId: "updated-cli", resume: "saved" });
    expect(run).toHaveBeenCalledTimes(1);
  });

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
    expect(script).toContain(`'${join(bin, "claude")}' '--resume' 'abc-123' '--settings'`);
    expect(script).toContain(`'--plugin-dir' '${pluginDir}'`);
    expect(script).toContain("export DISABLE_AUTOUPDATER='1'");
    expect(script).toContain('rm -f -- "$0"');
    expect(script).toContain("[ -t 0 ] || exit 1");
    expect(script).toContain(".command.started' || exit 1");
    expect((await readdir(join(root, "state", "tmp"))).some(name => name.endsWith(".started"))).toBe(false);

    await writeFile(join(config, "settings.json"), JSON.stringify({ enabledPlugins: { "orbis-host-session-link@orbis-host": true } }));
    const sessionId = "ea3d27e1-d794-4ad4-af9c-92ea81b67f03";
    await launcher.launch({ cwd, launchId: "launch-2", sessionId });
    const installedScript = await readFile(join(root, "state", "tmp", "claude-launch-2.command"), "utf8");
    expect(installedScript).not.toContain("--plugin-dir");
    expect(installedScript).toContain("claude-launch-2.settings.json");
    // The bridge token is reused by native session switches; --session-id pins the created session itself.
    expect(installedScript).toContain(`'--session-id' '${sessionId}'`);
    expect(installedScript).not.toContain("--resume");
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
    await writeClaudeFixture(join(root, ".local", "bin"), false);
    const calls: string[] = [];
    const launcher = new TerminalClaudeLauncher({ stateDir: join(root, "state"), configDir: config, env, platform: "darwin", pluginDir,
      run: async (command, args) => { calls.push(command); await writeFile(`${args[2]!}.started`, ""); } });
    await expect(launcher.launch({ cwd: root, launchId: "no-login" })).rejects.toThrow("账号授权");
    expect(calls).toEqual([]);
    await launcher.launch({ cwd: root, launchId: "local-setup", setup: true });
    expect(calls).toEqual(["/usr/bin/open"]);
  });

  // S57 / SC81: selected permissions and project MCP startup acknowledgements
  // share one private settings file and one launch, without persistent consent.
  it("starts selected bypass mode without another confirmation or persistent acceptance", async () => {
    const { root, config, env, pluginDir } = await setup();
    await writeFile(join(root, ".mcp.json"), '{"mcpServers":{"docs":{}}}');
    const run = vi.fn(async (_command: string, args: readonly string[]) => { await writeFile(`${args[2]!}.started`, ""); });
    const launcher = new TerminalClaudeLauncher({ stateDir: join(root, "state"), configDir: config, env, platform: "darwin", pluginDir, run });
    await launcher.launch({ cwd: root, launchId: "bypass", configuration: { permissions: { mode: "bypassPermissions" } } });
    expect(run).toHaveBeenCalledTimes(1);
    const script = await readFile(join(root, "state/tmp/claude-bypass.command"), "utf8");
    expect(script).toContain("'--permission-mode' 'bypassPermissions'");
    expect(script.match(/'--settings'/gu)).toHaveLength(1);
    expect(JSON.parse(await readFile(join(root, "state/tmp/claude-bypass.settings.json"), "utf8")))
      .toEqual({ skipDangerousModePermissionPrompt: true, enabledMcpjsonServers: ["docs"] });
    expect(JSON.parse(await readFile(join(config, ".claude.json"), "utf8")).bypassPermissionsModeAccepted).toBeUndefined();
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
          .toEqual({ skipDangerousModePermissionPrompt: true, enabledMcpjsonServers: ['name"with&quotes'] });
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
    expect(script.split("\r\n")).toEqual(["@echo off", 'cd /d "C:\\Users\\A B\\repo" || exit /b 1', 'set "ORBIS_CLAUDE_LAUNCH_ID=l"', 'set "ORBIS_STATE_DIR=C:\\state 100%%"', 'set "DISABLE_AUTOUPDATER=1"', 'set "CLAUDE_CONFIG_DIR="',
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

  // WIN-CONSOLE-01: the window comes from the default terminal, never wt.exe, whose elevated
  // profiles turn `cmd.exe /k <script>` into one program name. `""…""` keeps the script path
  // whole through cmd's quote stripping, even with spaces and parentheses in the user path.
  it("opens the Windows launch script in a cmd window through the default terminal", () => {
    const script = "C:\\Users\\John (Work)\\.orbis\\tmp\\claude-l.cmd";
    expect(windowsClaudeConsole(script, "D:\\my repo", { ComSpec: "C:\\Windows\\system32\\cmd.exe" })).toEqual({
      file: "C:\\Windows\\system32\\cmd.exe", argumentLine: `/k ""${script}""`, cwd: "D:\\my repo",
    });
    expect(windowsClaudeConsole(script, "D:\\repo", {}).file).toBe("cmd.exe");
  });
});
