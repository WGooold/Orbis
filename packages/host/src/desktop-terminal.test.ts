import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const terminal = vi.hoisted(() => ({ spawn: vi.fn(), pi: vi.fn(), codex: vi.fn() }));
vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(), spawn: terminal.spawn,
}));
vi.mock("./spawner.js", async importOriginal => ({
  ...await importOriginal<typeof import("./spawner.js")>(), resolvePiCommand: terminal.pi,
}));
vi.mock("./codex-daemon.js", async importOriginal => ({
  ...await importOriginal<typeof import("./codex-daemon.js")>(), resolveCodexCommand: terminal.codex,
}));
import { DesktopRuntime, shouldAutoEnableCodexTerminal } from "./desktop-runtime.js";

describe("desktop terminal shortcuts", () => {
  let workspace: string;
  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "orbis 工作区's "));
    vi.clearAllMocks();
    terminal.pi.mockResolvedValue({ command: "C:\\Orbis Tools\\node.exe", prefixArgs: ["C:\\My Projects\\pi.js"] });
    terminal.codex.mockResolvedValue({ command: "C:\\Orbis Tools\\node.exe", prefixArgs: ["C:\\User's tools\\codex.js"] });
    terminal.spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    });
  });

  afterEach(async () => { await rm(workspace, { recursive: true, force: true }); });

  function invocation(): { script: string; launcher: string; options: Record<string, unknown> } {
    const [program, args, options] = terminal.spawn.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(program).toBe("powershell.exe");
    expect(args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    const launcher = Buffer.from(args[3]!, "base64").toString("utf16le");
    const encoded = launcher.match(/'-EncodedCommand','([A-Za-z0-9+/=]+)'/)?.[1];
    expect(encoded).toBeTruthy();
    return { script: Buffer.from(encoded!, "base64").toString("utf16le"), launcher, options };
  }

  function directInvocation(): { script: string; options: Record<string, unknown> } {
    const [program, args, options] = terminal.spawn.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(program).toBe("powershell.exe");
    expect(args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    return { script: Buffer.from(args[3]!, "base64").toString("utf16le"), options };
  }

  it("opens Pi and Codex in the selected workspace, preserving paths and Pi integration", async () => {
    const runtime = new DesktopRuntime(() => {});
    for (const kind of ["pi", "codex"]) {
      terminal.spawn.mockClear();
      await runtime.openAgent(kind, "tui", workspace);
      const { script, launcher, options } = invocation();
      if (kind === "codex") expect(script).toBe("& 'C:\\Orbis Tools\\node.exe' 'C:\\User''s tools\\codex.js'");
      else {
        expect(script).toContain("'C:\\My Projects\\pi.js' '-e'");
        expect(script.replaceAll("\\", "/")).toContain("/pi-extension/dist/index.js'");
      }
      expect(launcher).toContain("Start-Process -FilePath 'powershell.exe'");
      expect(launcher).toContain("'-NoProfile','-NoExit','-EncodedCommand'");
      expect(launcher).toContain(`-WorkingDirectory '${workspace.replaceAll("'", "''")}'`);
      expect(launcher).toContain("-WindowStyle Normal -ErrorAction Stop");
      expect(options).toMatchObject({ stdio: "ignore", windowsHide: true, cwd: workspace, timeout: 15_000 });
    }
  });

  it("keeps the separate Codex account setup action", async () => {
    await new DesktopRuntime(() => {}).openAgent("codex");
    const { script, options } = invocation();
    expect(script).toBe("& 'C:\\Orbis Tools\\node.exe' 'C:\\User''s tools\\codex.js' 'login'");
    expect(options.cwd).toBe(homedir());
  });

  it("opens Codex Desktop as a separate GUI process without a terminal window", async () => {
    await new DesktopRuntime(() => {}).openAgent("codexDesktop");
    const { script, options } = directInvocation();
    expect(script).toContain("Get-AppxPackage -Name OpenAI.Codex");
    expect(script).toContain("$package.PackageFamilyName + '!' + $application.Id");
    expect(script).toContain("ActivateApplication(appId");
    expect(script).not.toContain("Start-Process");
    expect(terminal.codex).not.toHaveBeenCalled();
    expect(options).toMatchObject({ stdio: ["ignore", "ignore", "pipe"], windowsHide: true, cwd: homedir(), timeout: 15_000 });
  });

  it("never falls back to the user directory when an interactive workspace is missing or invalid", async () => {
    const file = join(workspace, "not-a-directory.txt");
    await writeFile(file, "not a workspace");
    const runtime = new DesktopRuntime(() => {});
    const switchProvider = vi.spyOn(runtime, "mutateProvider");
    for (const kind of ["pi", "codex"]) {
      for (const cwd of [undefined, "", "relative-workspace", join(workspace, "missing"), file]) {
        await expect(runtime.openAgent(kind, "tui", cwd)).rejects.toThrow("工作区");
        await expect(runtime.openProvider(kind, "test-provider", cwd)).rejects.toThrow("工作区");
      }
    }
    await expect(runtime.openAgent("pi")).rejects.toThrow("工作区");
    expect(switchProvider).not.toHaveBeenCalled();
    expect(terminal.spawn).not.toHaveBeenCalled();
  });

  it("rejects unknown agents and modes without launching anything", async () => {
    const runtime = new DesktopRuntime(() => {});
    await expect(runtime.openAgent("other", "tui")).rejects.toThrow("未知 agent");
    await expect(runtime.openAgent("codex", "shell-command")).rejects.toThrow("未知打开方式");
    await expect(runtime.openAgent("codexDesktop", "tui")).rejects.toThrow("未知打开方式");
    expect(terminal.spawn).not.toHaveBeenCalled();
  });

  it("enables the terminal shim by itself only while the Host runs on Windows", () => {
    const base = { platform: "win32" as NodeJS.Platform, hostRunning: true, installed: true, compatible: true, state: "disabled" as const, needsElevation: false };
    expect(shouldAutoEnableCodexTerminal(base)).toBe(true);
    expect(shouldAutoEnableCodexTerminal({ ...base, state: "repair" })).toBe(true);
    // 检测不等于用户意图：Host 没跑就不改写用户 PATH；提权也永不自动。
    expect(shouldAutoEnableCodexTerminal({ ...base, hostRunning: false })).toBe(false);
    expect(shouldAutoEnableCodexTerminal({ ...base, needsElevation: true })).toBe(false);
    expect(shouldAutoEnableCodexTerminal({ ...base, platform: "linux" })).toBe(false);
    // 已经装好、尚未安装或版本不兼容都不需要（且不应该）再动 PATH。
    expect(shouldAutoEnableCodexTerminal({ ...base, state: "enabled" })).toBe(false);
    expect(shouldAutoEnableCodexTerminal({ ...base, installed: false })).toBe(false);
    expect(shouldAutoEnableCodexTerminal({ ...base, compatible: false })).toBe(false);
  });

  it("reports terminal startup failures back to the desktop", async () => {    terminal.spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
      queueMicrotask(() => child.emit("error", new Error("Terminal unavailable")));
      return child;
    });
    await expect(new DesktopRuntime(() => {}).openAgent("codex", "tui", workspace)).rejects.toThrow("Terminal unavailable");
  });

  it("does not report success when the Windows launcher exits unsuccessfully", async () => {
    terminal.spawn.mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 1));
      return child;
    });
    await expect(new DesktopRuntime(() => {}).openAgent("pi", "tui", workspace)).rejects.toThrow("无法打开终端界面");
  });
});
