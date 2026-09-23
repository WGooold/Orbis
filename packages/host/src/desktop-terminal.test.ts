import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
import { DesktopRuntime } from "./desktop-runtime.js";

describe("desktop terminal shortcuts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    terminal.pi.mockResolvedValue({ command: "C:\\Orbis Tools\\node.exe", prefixArgs: ["C:\\My Projects\\pi.js"] });
    terminal.codex.mockResolvedValue({ command: "C:\\Orbis Tools\\node.exe", prefixArgs: ["C:\\User's tools\\codex.js"] });
    terminal.spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    });
  });

  function invocation(): { script: string; launcher: string; options: Record<string, unknown> } {
    const [program, args, options] = terminal.spawn.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(program).toBe("powershell.exe");
    expect(args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    const launcher = Buffer.from(args[3]!, "base64").toString("utf16le");
    const encoded = launcher.match(/'-EncodedCommand','([A-Za-z0-9+/=]+)'/)?.[1];
    expect(encoded).toBeTruthy();
    return { script: Buffer.from(encoded!, "base64").toString("utf16le"), launcher, options };
  }

  it("opens the Codex interactive CLI, preserving paths with spaces and apostrophes", async () => {
    const runtime = new DesktopRuntime(() => {});
    await runtime.openAgent("codex", "tui");
    const { script, launcher, options } = invocation();
    expect(script).toBe("& 'C:\\Orbis Tools\\node.exe' 'C:\\User''s tools\\codex.js'");
    expect(launcher).toContain("Start-Process -FilePath 'powershell.exe'");
    expect(launcher).toContain("'-NoProfile','-NoExit','-EncodedCommand'");
    expect(launcher).toContain(`-WorkingDirectory '${homedir().replaceAll("'", "''")}'`);
    expect(launcher).toContain("-WindowStyle Normal -ErrorAction Stop");
    expect(options).toMatchObject({ stdio: "ignore", windowsHide: true, cwd: homedir(), timeout: 15_000 });
  });

  it("keeps the separate Codex account setup action", async () => {
    await new DesktopRuntime(() => {}).openAgent("codex");
    expect(invocation().script).toBe("& 'C:\\Orbis Tools\\node.exe' 'C:\\User''s tools\\codex.js' 'login'");
  });

  it("opens Pi with the Orbis extension attached", async () => {
    await new DesktopRuntime(() => {}).openAgent("pi", "tui");
    const { script } = invocation();
    expect(script).toContain("'C:\\My Projects\\pi.js' '-e'");
    expect(script.replaceAll("\\", "/")).toContain("/pi-extension/dist/index.js'");
  });

  it("rejects unknown agents and modes without launching anything", async () => {
    const runtime = new DesktopRuntime(() => {});
    await expect(runtime.openAgent("other", "tui")).rejects.toThrow("未知 agent");
    await expect(runtime.openAgent("codex", "shell-command")).rejects.toThrow("未知打开方式");
    expect(terminal.spawn).not.toHaveBeenCalled();
  });

  it("reports terminal startup failures back to the desktop", async () => {
    terminal.spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
      queueMicrotask(() => child.emit("error", new Error("Terminal unavailable")));
      return child;
    });
    await expect(new DesktopRuntime(() => {}).openAgent("codex", "tui")).rejects.toThrow("Terminal unavailable");
  });

  it("does not report success when the Windows launcher exits unsuccessfully", async () => {
    terminal.spawn.mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 1));
      return child;
    });
    await expect(new DesktopRuntime(() => {}).openAgent("pi", "tui")).rejects.toThrow("无法打开终端界面");
  });
});
