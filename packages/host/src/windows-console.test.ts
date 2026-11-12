/**
 * WIN-CONSOLE-01: Windows agent windows open through ShellExecute (the system default
 * terminal), never through `wt.exe`. A Windows Terminal profile set to run as Administrator
 * makes `wt.exe` re-serialize the child command as one quoted program name (0x80070002).
 *
 * POSIX runners cannot execute PowerShell, so the launcher script is decoded and its
 * literals asserted exactly; the window behavior itself needs Windows acceptance.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { openWindowsConsole, WindowsConsoleLaunchError, windowsConsoleLaunch } from "./windows-console.js";

const decode = (args: readonly string[]): string => Buffer.from(args.at(-1) ?? "", "base64").toString("utf16le");

describe("windowsConsoleLaunch", () => {
  it("starts a hidden Windows PowerShell launcher that uses ShellExecute instead of wt.exe", () => {
    const launch = windowsConsoleLaunch({ file: "powershell.exe", argumentLine: "-NoProfile -NoExit -EncodedCommand QQBCAA==", cwd: "D:\\repo" },
      { SystemRoot: "C:\\Windows" });
    expect(launch.command).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(launch.args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    const script = decode(launch.args);
    expect(script).not.toMatch(/\bwt(?:\.exe)?\b/iu);
    expect(script).toContain("$orbisConsole.FileName = 'powershell.exe'");
    expect(script).toContain("$orbisConsole.Arguments = '-NoProfile -NoExit -EncodedCommand QQBCAA=='");
    expect(script).toContain("$orbisConsole.WorkingDirectory = 'D:\\repo'");
    expect(script).toContain("$orbisConsole.UseShellExecute = $true");
    expect(script).toContain("[System.Diagnostics.Process]::Start($orbisConsole)");
  });

  // Paths reach PowerShell as single-quoted literals: `$` stays text, brackets are not
  // wildcards, and typographic single quotes (which PowerShell also treats as quotes) are doubled.
  it("keeps quotes, brackets, spaces and dollar signs in paths literal", () => {
    const cwd = "D:\\张三's ‘工作’ [1] $HOME";
    const script = decode(windowsConsoleLaunch({ file: "C:\\Program Files\\x's.exe", argumentLine: '/k ""C:\\a b\\x.cmd""', cwd }, {}).args);
    expect(script).toContain("$orbisConsole.WorkingDirectory = 'D:\\张三''s ‘‘工作’’ [1] $HOME'");
    expect(script).toContain("$orbisConsole.FileName = 'C:\\Program Files\\x''s.exe'");
    expect(script).toContain(`$orbisConsole.Arguments = '/k ""C:\\a b\\x.cmd""'`);
  });

  it("rejects line breaks and NUL that would end the encoded statement", () => {
    for (const cwd of ["D:\\a\nb", "D:\\a\rb", "D:\\a\0b", ""]) {
      expect(() => windowsConsoleLaunch({ file: "powershell.exe", argumentLine: "", cwd })).toThrow("启动参数无效");
    }
  });
});

describe("openWindowsConsole", () => {
  const fakeLauncher = (code: number | null, stdout = "", stderr = "") => vi.fn(() => {
    const child = Object.assign(new EventEmitter(), { pid: 4321, stdout: new EventEmitter(), stderr: new EventEmitter() });
    queueMicrotask(() => {
      if (stdout) child.stdout.emit("data", Buffer.from(stdout));
      if (stderr) child.stderr.emit("data", Buffer.from(stderr));
      child.emit("close", code);
    });
    return child;
  });
  const request = { file: "powershell.exe", argumentLine: "-NoProfile", cwd: "D:\\repo" };

  // The launcher's exit status, not its spawn event, decides success.
  it("resolves the new window's process ID and passes the agent environment to the launcher", async () => {
    const spawnProcess = fakeLauncher(0, "9876");
    await expect(openWindowsConsole(request, { env: { ORBIS_STATE_DIR: "D:\\state" }, spawnProcess: spawnProcess as never })).resolves.toBe(9876);
    expect(spawnProcess.mock.calls[0]).toEqual([expect.stringMatching(/powershell\.exe$/u), expect.any(Array),
      expect.objectContaining({ env: { ORBIS_STATE_DIR: "D:\\state" }, windowsHide: true, timeout: 15_000 })]);
    await expect(openWindowsConsole(request, { env: {}, spawnProcess: fakeLauncher(0) as never })).resolves.toBe(4321);
  });

  it("reports a failed or timed-out launcher with its first error line", async () => {
    const failed = openWindowsConsole(request, { env: {}, spawnProcess: fakeLauncher(1, "", "\r\n系统找不到指定的文件。\r\nAt line:1") as never });
    await expect(failed).rejects.toBeInstanceOf(WindowsConsoleLaunchError);
    await expect(failed).rejects.toThrow("终端启动器退出（1）：系统找不到指定的文件。");
    await expect(openWindowsConsole(request, { env: {}, spawnProcess: fakeLauncher(null) as never }))
      .rejects.toThrow("终端启动器超时");
  });
});
