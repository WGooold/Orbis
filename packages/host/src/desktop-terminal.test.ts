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
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });
  });

  function invocation(): { script: string; options: Record<string, unknown> } {
    const [program, args, options] = terminal.spawn.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(program).toBe("powershell.exe");
    expect(args.slice(0, 3)).toEqual(["-NoProfile", "-NoExit", "-EncodedCommand"]);
    return { script: Buffer.from(args[3]!, "base64").toString("utf16le"), options };
  }

  it("opens the Codex interactive CLI, preserving paths with spaces and apostrophes", async () => {
    const runtime = new DesktopRuntime(() => {});
    await runtime.openAgent("codex", "tui");
    const { script, options } = invocation();
    expect(script).toBe("& 'C:\\Orbis Tools\\node.exe' 'C:\\User''s tools\\codex.js'");
    expect(options).toMatchObject({ detached: true, stdio: "ignore", windowsHide: false, cwd: homedir() });
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
});
