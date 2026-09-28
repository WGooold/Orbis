import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const registry = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), execFile: registry.exec }));
import { installCodexShim, codexShimStatus, ensureCodexShimWinsPath } from "./codex-shim-install.js";

let root: string | undefined;
afterEach(async () => {
  vi.unstubAllEnvs(); registry.exec.mockReset();
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("Codex user PATH registration", () => {
  it("never writes the inherited system PATH into HKCU or mutates it after a failed registry read", async () => {
    root = await mkdtemp(join(tmpdir(), "orbis-shim-path-"));
    vi.stubEnv("LOCALAPPDATA", join(root, "user"));
    vi.stubEnv("PATH", "C:\\Windows\\System32;C:\\Other Node");
    const runtime = join(root, "Host runtime");
    for (const path of [join(runtime, "node", "node.exe"), join(runtime, "packages", "host", "dist", "codex-shim.js")]) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, "");
    }
    registry.exec.mockImplementation((_program, args: string[], options, callback: (error: Error | null, result: { stdout: string; stderr: string }) => void) => {
      callback(null, { stdout: args[0] === "query" ? "HKEY_CURRENT_USER\\Environment\r\n" : "", stderr: "" });
    });
    await installCodexShim(runtime);
    const bin = join(root, "user", "Orbis", "bin");
    expect(registry.exec.mock.calls.slice(0, 2).map(call => call[1])).toEqual([
      ["query", "HKCU\\Environment"],
      ["add", "HKCU\\Environment", "/v", "Path", "/t", "REG_EXPAND_SZ", "/d", bin, "/f"],
    ]);
    expect(await readFile(join(bin, "codex.cmd"), "utf8")).toContain("ORBIS_CODEX_RUNTIME");
    if (process.platform === "win32") {
      expect((await codexShimStatus(join(root, "other runtime"))).state).toBe("repair");
      const competing = join(root, "other");
      await mkdir(competing);
      await writeFile(join(competing, "codex.cmd"), "@echo off");
      vi.stubEnv("PATH", `${competing};${bin}`);
      registry.exec.mockImplementation((_program, args: string[], _options, callback: (error: Error | null, result: { stdout: string; stderr: string }) => void) => {
        const machine = args[1]?.startsWith("HKLM") === true;
        callback(null, { stdout: args[0] === "query" ? `HKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    ${machine ? competing : bin}\r\n` : "", stderr: "" });
      });
      expect(await codexShimStatus(runtime)).toMatchObject({ state: "repair", detail: expect.stringContaining(join(competing, "codex.cmd")) });
    }
    registry.exec.mockReset();
    registry.exec.mockImplementation((_program, _args, _options, callback: (error: Error) => void) => callback(new Error("Registry unavailable")));
    await expect(installCodexShim(runtime)).rejects.toThrow("Registry unavailable");
    expect(registry.exec.mock.calls).toHaveLength(1);
  });

  it("only rewrites the machine PATH with elevation while another codex wins there", async () => {
    if (process.platform !== "win32") return;
    root = await mkdtemp(join(tmpdir(), "orbis-shim-machine-"));
    vi.stubEnv("LOCALAPPDATA", join(root, "user"));
    const bin = join(root, "user", "Orbis", "bin");
    const competing = join(root, "nodejs");
    await mkdir(bin, { recursive: true });
    await mkdir(competing, { recursive: true });
    await writeFile(join(bin, "codex.cmd"), "@echo off");
    await writeFile(join(competing, "codex.cmd"), "@echo off");
    vi.stubEnv("PATH", `${competing};${bin}`);
    const stubRegistry = (machinePath: string): void => {
      registry.exec.mockReset();
      registry.exec.mockImplementation((_program, args: string[], _options, callback: (error: Error | null, result: { stdout: string; stderr: string }) => void) => {
        const machine = args[1]?.startsWith("HKLM") === true;
        callback(null, { stdout: machine ? `HKEY_LOCAL_MACHINE\\System\r\n    Path    REG_EXPAND_SZ    ${machinePath}\r\n` : "HKEY_CURRENT_USER\\Environment\r\n", stderr: "" });
      });
    };
    const launchers = (): string[] => registry.exec.mock.calls.filter(call => call[1][2] === "-Command").map(call => String(call[1][3]));

    stubRegistry(competing);
    expect(await ensureCodexShimWinsPath()).toBe(true);
    expect(launchers()).toHaveLength(1);
    expect(launchers()[0]).toContain("-Verb RunAs");

    // 机器 PATH 已经放好就不重复提权；改完要重开终端才看得到，所以不能看当前进程的 PATH。
    stubRegistry(`%LOCALAPPDATA%\\Orbis\\bin;${competing}`);
    expect(await ensureCodexShimWinsPath()).toBe(false);
    expect(launchers()).toEqual([]);
  });
});
