import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
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
import { DesktopRuntime, shouldAutoEnableCodexTerminal } from "./desktop-runtime.js";

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
    terminal.spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
      queueMicrotask(() => { child.emit("spawn"); child.emit("exit", 0); });
      return child;
    });
  });
  afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); await rm(workspace, { recursive: true, force: true }); });

  it("opens native Claude Code in the selected workspace with the Orbis plugin", async () => {
    const state = join(workspace, "state");
    await new DesktopRuntime(() => {}, state).openAgent("claude", "tui", workspace);
    const scripts = await readdir(join(state, "tmp"));
    expect(scripts).toHaveLength(1);
    const script = join(state, "tmp", scripts[0]!);
    expect(terminal.spawn).toHaveBeenCalledWith("/usr/bin/open", ["-a", "Terminal", script], expect.objectContaining({ detached: true, stdio: "ignore" }));
    const contents = await readFile(script, "utf8");
    expect(contents).toContain(`cd -- '${workspace.replaceAll("'", "'\\''")}' || exit 1`);
    expect(contents).toContain("export ORBIS_STATE_DIR=");
    expect(contents).toContain("exec '/User'\\''s tools/claude' '--plugin-dir'");
    expect(terminal.pi).not.toHaveBeenCalled();
    expect(terminal.codex).not.toHaveBeenCalled();
  });

  it("reports a missing Claude CLI without opening a terminal", async () => {
    terminal.claude.mockResolvedValue(undefined);
    await expect(new DesktopRuntime(() => {}, workspace).openAgent("claude", "tui", workspace)).rejects.toThrow("没有找到 Claude Code");
    expect(terminal.spawn).not.toHaveBeenCalled();
  });

  it.each([undefined, "relative/path", "/orbis-missing-workspace-for-test"])("rejects an invalid Claude workspace %s before launching", async cwd => {
    await expect(new DesktopRuntime(() => {}, workspace).openAgent("claude", "tui", cwd)).rejects.toThrow(/工作区目录/u);
    expect(terminal.claude).not.toHaveBeenCalled();
    expect(terminal.spawn).not.toHaveBeenCalled();
  });

  it("opens Terminal with separately passed shell text and no bridge protocol stdio", async () => {
    await new DesktopRuntime(() => {}).openAgent("codex", "tui", workspace);
    const [program, args, options] = terminal.spawn.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(program).toBe("osascript");
    expect(args.slice(0, 1)).toEqual(["-e"]);
    expect(args[1]).toContain('do script (item 1 of argv)');
    expect(args[1]).not.toContain(workspace);
    expect(args[2]).toBe("--");
    expect(args[3]).toBe(`cd -- '${workspace.replaceAll("'", "'\\''")}' && '/Orbis Tools/node' '/User'\\''s tools/$HOME;codex.js'`);
    expect(options).toMatchObject({ stdio: "ignore", cwd: workspace, timeout: 15_000 });
  });

  it("keeps the Pi extension in the terminal invocation", async () => {
    await new DesktopRuntime(() => {}).openAgent("pi", "tui", workspace);
    const args = terminal.spawn.mock.calls[0]![1] as string[];
    expect(args[3]).toContain("'/My Projects/pi.js' '-e'");
    expect(args[3]!.replaceAll("\\", "/")).toContain("/pi-extension/dist/index.js'");
  });

  it("reports denied Terminal automation and never installs the Windows PATH shim", async () => {
    terminal.spawn.mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 1));
      return child;
    });
    await expect(new DesktopRuntime(() => {}).openAgent("codex", "tui", workspace)).rejects.toThrow("自动化权限");
    expect(shouldAutoEnableCodexTerminal({ platform: "darwin", hostRunning: true, installed: true, compatible: true, state: "disabled", needsElevation: false })).toBe(false);
  });
});
