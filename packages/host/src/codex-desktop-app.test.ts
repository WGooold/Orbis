import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import { beforeEach, describe, expect, it, vi } from "vitest";

const activation = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async original => ({
  ...await original<typeof import("node:child_process")>(), spawn: activation.spawn,
}));
import { launchCodexDesktopApp, openCodexDesktopThread } from "./codex-desktop-app.js";

beforeEach(() => {
  activation.spawn.mockReset().mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { stderr: new PassThrough() });
    queueMicrotask(() => child.emit("exit", 0));
    return child;
  });
});

function script(): string {
  const [program, args] = activation.spawn.mock.calls[0] as [string, string[]];
  expect(program).toBe("powershell.exe");
  expect(args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
  return Buffer.from(args[3]!, "base64").toString("utf16le");
}

describe("registered Codex desktop activation", () => {
  it.runIf(process.platform === "win32")("opens a verified local thread route and rejects unverified routes before spawning", async () => {
    await openCodexDesktopThread("thread-123", "local");
    expect(script()).toContain("codex://threads/thread-123?hostId=local");
    expect(script()).toContain("-WindowStyle Hidden");
    expect(activation.spawn).toHaveBeenCalledTimes(1);
    await expect(openCodexDesktopThread("thread-123", "codex-desktop:thread-123")).rejects.toThrow("route_unverified");
    await expect(openCodexDesktopThread("bad'$(command)", "local")).rejects.toThrow("route_unverified");
    expect(activation.spawn).toHaveBeenCalledTimes(1);
    activation.spawn.mockImplementationOnce(() => {
      const child = new EventEmitter(); queueMicrotask(() => child.emit("exit", 1)); return child;
    });
    await expect(openCodexDesktopThread("thread-123", "local")).rejects.toThrow("无法重新打开");
  });
  it("reports asynchronous spawn and application activation failures", async () => {
    activation.spawn.mockImplementationOnce(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("error", new Error("powershell unavailable")));
      return child;
    });
    await expect(launchCodexDesktopApp()).rejects.toThrow("powershell unavailable");
    activation.spawn.mockImplementationOnce(() => {
      const child = Object.assign(new EventEmitter(), { stderr: new PassThrough() });
      queueMicrotask(() => { child.stderr.write("activation access denied"); child.emit("exit", 1); });
      return child;
    });
    await expect(launchCodexDesktopApp()).rejects.toThrow("activation access denied");
  });

  it.runIf(process.platform === "win32")("resolves the same registered app across package upgrades and compiles the Windows activation bridge", async () => {
    await launchCodexDesktopApp();
    const activationScript = script().replace("[OrbisDesktopActivation]::Open($appId) | Out-Null", "$appId");
    const execute = promisify(execFile);
    for (const version of ["1.0.0.0", "2.0.0.0"]) {
      // Real PowerShell and C# compilation, with discovery fixtures only. Never
      // open or restart the user's GUI during automated tests.
      const fixture = `
function Get-AppxPackage { [pscustomobject]@{ PackageFamilyName = 'OpenAI.Codex_test'; PackageFullName = 'OpenAI.Codex_${version}_x64__test'; InstallLocation = 'C:\\WindowsApps\\OpenAI.Codex_${version}' } }
function Get-AppxPackageManifest { [pscustomobject]@{ Package = [pscustomobject]@{ Applications = [pscustomobject]@{ Application = @(
  [pscustomobject]@{ Id = 'Runner'; Executable = 'app/resources/codex-command-runner.exe' },
  [pscustomobject]@{ Id = 'Desktop'; Executable = 'app/ChatGPT.exe' }
) } } } }
`;
      const { stdout } = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(fixture + activationScript, "utf16le").toString("base64")], { windowsHide: true });
      expect(stdout.trim()).toBe("OpenAI.Codex_test!Desktop");
    }
    const missing = "function Get-AppxPackage { $null }\n" + activationScript;
    await expect(execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(missing, "utf16le").toString("base64")], { windowsHide: true })).rejects.toThrow();
  });
});
