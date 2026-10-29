import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { TerminalClaudeLauncher, posixScript, windowsScript } from "./claude-launcher.js";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "orbis-claude-launch-"));
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "claude"), "#!/bin/sh\n", { mode: 0o755 });
  const pluginDir = join(root, "plugin");
  await mkdir(join(pluginDir, ".claude-plugin"), { recursive: true });
  await writeFile(join(pluginDir, ".claude-plugin", "plugin.json"), "{}");
  const config = join(root, "config");
  await mkdir(config, { recursive: true });
  return { root, bin, pluginDir, config, env: { PATH: bin, HOME: root } };
}

describe("TerminalClaudeLauncher", () => {
  it("opens Terminal on macOS with a self-removing script that loads the plugin only when it is not installed", async () => {
    const { root, bin, pluginDir, config, env } = await setup();
    const runs: [string, readonly string[]][] = [];
    const launcher = new TerminalClaudeLauncher({ stateDir: join(root, "state"), configDir: config, env, platform: "darwin", pluginDir,
      run: async (command, args) => { runs.push([command, args]); } });
    expect(await launcher.unavailable()).toBeUndefined();
    await launcher.launch({ cwd: "/work/it's here", resume: "abc-123", launchId: "launch-1" });
    expect(runs).toEqual([["/usr/bin/open", ["-a", "Terminal", join(root, "state", "tmp", "claude-launch-1.command")]]]);
    const script = await readFile(join(root, "state", "tmp", "claude-launch-1.command"), "utf8");
    expect(script).toContain("cd -- '/work/it'\\''s here' || exit 1");
    expect(script).toContain("export ORBIS_CLAUDE_LAUNCH_ID='launch-1'");
    expect(script).toContain(`exec '${join(bin, "claude")}' '--resume' 'abc-123' '--plugin-dir' '${pluginDir}'`);
    expect(script).toContain('rm -f -- "$0"');

    await writeFile(join(config, "settings.json"), JSON.stringify({ enabledPlugins: { "orbis-host-session-link@orbis-host": true } }));
    await launcher.launch({ cwd: "/work", launchId: "launch-2" });
    expect(await readFile(join(root, "state", "tmp", "claude-launch-2.command"), "utf8")).toContain(`exec '${join(bin, "claude")}'\n`);
  });

  it("reports why it cannot open a terminal instead of guessing", async () => {
    const { root, config, env } = await setup();
    expect(await new TerminalClaudeLauncher({ stateDir: root, configDir: config, env, platform: "linux" }).unavailable()).toContain("终端窗口");
    expect(await new TerminalClaudeLauncher({ stateDir: root, configDir: config, env: { PATH: "/nowhere" }, home: "/nowhere", platform: "darwin" }).unavailable())
      .toContain("没有找到 Claude Code");
    const launcher = new TerminalClaudeLauncher({ stateDir: join(root, "s"), configDir: config, env, platform: "darwin", pluginDir: join(root, "missing"),
      run: async () => undefined });
    await expect(launcher.launch({ cwd: "/w", launchId: "x" })).rejects.toThrow("Host 设置");
    expect(await readdir(join(root, "s", "tmp")).catch(() => [])).toEqual([]);
  });

  it("writes cmd scripts with quoted paths for Windows", () => {
    const script = windowsScript({ cwd: "C:\\Users\\A B\\repo", claude: "C:\\bin\\claude.exe", args: ["--resume", "id"], launchId: "l", stateDir: "C:\\state 100%" });
    expect(script.split("\r\n")).toEqual(["@echo off", 'cd /d "C:\\Users\\A B\\repo"', 'set "ORBIS_CLAUDE_LAUNCH_ID=l"', 'set "ORBIS_STATE_DIR=C:\\state 100%%"',
      '"C:\\bin\\claude.exe" "--resume" "id"', ""]);
    expect(posixScript({ cwd: "/r", claude: "/c", args: [], launchId: "l", stateDir: "/s" })).toMatch(/^#!\/bin\/sh\n/u);
  });
});
