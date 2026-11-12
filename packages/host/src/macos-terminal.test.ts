import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const terminal = vi.hoisted(() => ({ spawn: vi.fn(), pi: vi.fn(), codex: vi.fn(), claude: vi.fn() }));
vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(), spawn: terminal.spawn,
}));
vi.mock("./spawner.js", async importOriginal => ({
  ...await importOriginal<typeof import("./spawner.js")>(), resolvePiCommand: terminal.pi,
}));
vi.mock("./codex-daemon.js", async importOriginal => ({
  ...await importOriginal<typeof import("./codex-daemon.js")>(), resolveCodexCommand: terminal.codex,
}));
vi.mock("./claude-integration-install.js", async importOriginal => ({
  ...await importOriginal<typeof import("./claude-integration-install.js")>(), findClaudeExecutable: terminal.claude,
}));
vi.mock("./claude-startup.js", async importOriginal => ({
  ...await importOriginal<typeof import("./claude-startup.js")>(), checkClaudeAuthentication: vi.fn(async () => undefined),
}));
import { DesktopRuntime, shouldAutoEnableCodexTerminal } from "./desktop-runtime.js";
import { openMacAgentTerminal } from "./macos-agent-terminal.js";

describe("macOS terminal launch", () => {
  let workspace: string;
  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "orbis 工作区's "));
    vi.clearAllMocks();
    vi.stubGlobal("process", { ...process, platform: "darwin" });
    terminal.pi.mockResolvedValue({ command: "/Orbis Tools/node", prefixArgs: ["/My Projects/pi.js"] });
    terminal.codex.mockResolvedValue({ command: "/Orbis Tools/node", prefixArgs: ["/User's tools/$HOME;codex.js"] });
    terminal.claude.mockResolvedValue("/User's tools/claude");
    vi.stubEnv("CLAUDE_CONFIG_DIR", join(workspace, "claude-config"));
    terminal.spawn.mockImplementation((_command: string, args: string[]) => {
      const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
      queueMicrotask(async () => {
        if (args[2]?.includes("claude-") && args[2].endsWith(".command")) await writeFile(`${args[2]}.started`, "");
        child.emit("spawn"); child.emit("exit", 0);
      });
      return child;
    });
  });
  afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); await rm(workspace, { recursive: true, force: true }); });

  it("opens native Claude Code in the selected workspace with the Orbis plugin", async () => {
    const state = join(workspace, "state");
    await new DesktopRuntime(() => {}, state).openAgent("claude", "tui", workspace);
    const files = await readdir(join(state, "tmp"));
    const scripts = files.filter(name => name.endsWith(".command"));
    expect(scripts).toHaveLength(1);
    // SC81: every launch has one private settings file and one executable script.
    const settings = files.filter(name => name.endsWith(".settings.json"));
    expect(files).toHaveLength(2);
    expect(settings).toHaveLength(1);
    expect(JSON.parse(await readFile(join(state, "tmp", settings[0]!), "utf8"))).toEqual({ skipDangerousModePermissionPrompt: true });
    const script = join(state, "tmp", scripts[0]!);
    expect(terminal.spawn).toHaveBeenCalledWith("/usr/bin/open", ["-a", "Terminal", script], expect.objectContaining({ stdio: "ignore", timeout: 15_000 }));
    const contents = await readFile(script, "utf8");
    expect(contents).toContain(`cd -- '${workspace.replaceAll("'", "'\\''")}' || exit 1`);
    expect(contents).toContain("export ORBIS_STATE_DIR=");
    expect(contents).toContain("'/User'\\''s tools/claude' '--settings'");
    expect(contents).toContain("'--plugin-dir'");
    expect(contents).toContain("export DISABLE_AUTOUPDATER='1'");
    expect(terminal.pi).not.toHaveBeenCalled();
    expect(terminal.codex).not.toHaveBeenCalled();
  });

  it("reports a missing Claude CLI without opening a terminal", async () => {
    terminal.claude.mockResolvedValue(undefined);
    await expect(new DesktopRuntime(() => {}, workspace).openAgent("claude", "tui", workspace)).rejects.toThrow("没有找到 Claude Code");
    expect(terminal.spawn).not.toHaveBeenCalled();
  });

  it("rejects Claude when the opener process starts but exits unsuccessfully", async () => {
    terminal.spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
      queueMicrotask(() => { child.emit("spawn"); child.emit("exit", 1); });
      return child;
    });
    await expect(new DesktopRuntime(() => {}, join(workspace, "state")).openAgent("claude", "tui", workspace))
      .rejects.toThrow("Terminal 是否可用");
    expect(await readdir(join(workspace, "state", "tmp"))).toEqual([]);
  });

  it.each([undefined, "relative/path", "/orbis-missing-workspace-for-test"])("rejects an invalid Claude workspace %s before launching", async cwd => {
    await expect(new DesktopRuntime(() => {}, workspace).openAgent("claude", "tui", cwd)).rejects.toThrow(/工作区目录/u);
    expect(terminal.claude).not.toHaveBeenCalled();
    expect(terminal.spawn).not.toHaveBeenCalled();
  });

  it("opens a private command file without Apple Events approval or bridge protocol stdio", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "must-not-appear-in-launch-file");
    await new DesktopRuntime(() => {}, join(workspace, "state")).openAgent("codex", "tui", workspace);
    const [program, args, options] = terminal.spawn.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(program).toBe("/usr/bin/open");
    expect(args.slice(0, 2)).toEqual(["-a", "Terminal"]);
    const script = await readFile(args[2]!, "utf8");
    expect(script).toContain(`cd -- '${workspace.replaceAll("'", "'\\''")}' || exit 1`);
    expect(script).toContain("exec /usr/bin/env '-u' 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE'");
    expect(script).toContain("'/Orbis Tools/node' '/User'\\''s tools/$HOME;codex.js' '-c' 'check_for_update_on_startup=false' '-c' "
      + `'${(`projects.${JSON.stringify(workspace)}.trust_level="trusted"`).replaceAll("'", "'\\''")}'`);
    expect(script).toContain('rm -f -- "$0"');
    expect(script).not.toContain("must-not-appear-in-launch-file");
    expect(options).toMatchObject({ stdio: "ignore", cwd: workspace, timeout: 15_000 });
  });

  it("keeps the Pi extension in the terminal invocation", async () => {
    await new DesktopRuntime(() => {}, join(workspace, "state")).openAgent("pi", "tui", workspace);
    const args = terminal.spawn.mock.calls[0]![1] as string[];
    const script = await readFile(args[2]!, "utf8");
    expect(script).toContain("'PI_SKIP_VERSION_CHECK=1'");
    expect(script).toContain("'/My Projects/pi.js' '--approve' '-e'");
    expect(script.replaceAll("\\", "/")).toContain("/pi-extension/dist/index.js'");
  });

  it("reports failed Terminal open and removes its launch file without requiring automation", async () => {
    terminal.spawn.mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 1));
      return child;
    });
    await expect(new DesktopRuntime(() => {}, join(workspace, "state")).openAgent("codex", "tui", workspace)).rejects.toThrow("Terminal 是否可用");
    expect(await readdir(join(workspace, "state", "tmp"))).toEqual([]);
    expect(shouldAutoEnableCodexTerminal({ platform: "darwin", hostRunning: true, installed: true, compatible: true, state: "disabled", needsElevation: false })).toBe(false);
  });

  it("confirms actual terminal script startup separately from the open process receipt", async () => {
    terminal.spawn.mockImplementation((_command: string, args: string[]) => {
      const child = new EventEmitter();
      queueMicrotask(async () => { await writeFile(`${args[2]!}.started`, ""); child.emit("exit", 0); });
      return child;
    });
    await openMacAgentTerminal({ stateDir: workspace, cwd: workspace, command: "/bin/echo", args: ["ok"], env: {}, confirmStart: true });
    const files = await readdir(join(workspace, "tmp"));
    expect(files.filter(name => name.endsWith(".started"))).toEqual([]);
    expect(await readFile(join(workspace, "tmp", files[0]!), "utf8")).toContain("[ -t 0 ] || exit 1");
  });

  it("does not call open success a terminal start when the script never executes", async () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(10_001);
    await expect(openMacAgentTerminal({ stateDir: workspace, cwd: workspace, command: "/bin/echo", args: ["ok"], env: {}, confirmStart: true }))
      .rejects.toThrow("Terminal 未确认启动");
    expect(await readdir(join(workspace, "tmp"))).toEqual([]);
  });
});
