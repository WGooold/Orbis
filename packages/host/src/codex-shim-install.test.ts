import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const registry = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), execFile: registry.exec }));
import { codexDesktopEntryAgentPath, renderCodexDesktopEntryAgent } from "./codex-desktop-macos.js";
import { installCodexShim, codexShimStatus, ensureCodexShimWinsPath, codexDesktopEntryDecision, looksLikeOrbisWrapperEntry, suspendCodexDesktopEntry, ensureCodexDesktopEntry, removeCodexDesktopEntry } from "./codex-shim-install.js";

let root: string | undefined;
afterEach(async () => {
  vi.unstubAllEnvs(); registry.exec.mockReset();
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

// CODEX-DESKTOP-MAC-RECOVERY-01: every launchctl call is mocked; no user entry or login item is touched.
it.runIf(process.platform === "darwin")("suspends only the matching macOS override and its generated login item", async () => {
  root = await mkdtemp(join(tmpdir(), "orbis-launchd-recovery-"));
  vi.stubEnv("HOME", root);
  const launcher = join(root, "Orbis", "wrapper", "bin", "codex-launcher");
  const agent = codexDesktopEntryAgentPath(root);
  await mkdir(dirname(agent), { recursive: true });
  await writeFile(agent, renderCodexDesktopEntryAgent("CODEX_CLI_PATH", launcher));
  let current: string | undefined = "/Users/test/bin/custom-codex";
  registry.exec.mockImplementation((program: string, args: string[], _options, callback: (error: Error | null, result: { stdout: string; stderr: string }) => void) => {
    expect(program).toBe("/bin/launchctl");
    if (args[0] === "unsetenv") current = undefined;
    callback(null, { stdout: current ?? "", stderr: "" });
  });
  await expect(suspendCodexDesktopEntry(launcher)).rejects.toThrow("不是 Orbis");
  expect(registry.exec.mock.calls.filter(call => call[1][0] === "unsetenv")).toHaveLength(0);

  current = launcher;
  await writeFile(agent, "not our generated login item");
  await expect(suspendCodexDesktopEntry(launcher)).rejects.toThrow("登录项已改变");
  expect(current).toBe(launcher);
  expect(await readFile(agent, "utf8")).toBe("not our generated login item");

  await writeFile(agent, renderCodexDesktopEntryAgent("CODEX_CLI_PATH", launcher));
  await suspendCodexDesktopEntry(launcher);
  expect(current).toBeUndefined();
  await expect(readFile(agent)).rejects.toMatchObject({ code: "ENOENT" });
});

const windowsLauncher = "C:\\Users\\x\\AppData\\Local\\Orbis\\wrapper\\bin\\codex-launcher.exe";
const packageFullName = "OpenAI.Codex_26.1111.2228.0_x64__2p2nqsd0c76g0";
const installLocation = `C:\\Program Files\\WindowsApps\\${packageFullName}`;
const bundledCli = `${installLocation}\\app\\resources\\codex.exe`;

async function onWindows<T>(run: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "win32" });
  try { return await run(); }
  finally { Object.defineProperty(process, "platform", descriptor); }
}

type RegistryEntry = { raw: string; value: string; kind: "String" | "ExpandString" };
type RegistryChange = { action: "register"; expected: RegistryEntry | null; launcher: string; preserveOriginal: boolean }
  | { action: "suspend"; expected: RegistryEntry };
const stringEntry = (value: string): RegistryEntry => ({ raw: value, value, kind: "String" });
const installedPackage = { installLocation, packageFullName, signatureKind: "Store" };

// The PowerShell boundary is mocked: keep the current entry and backup separate, with a compare-before-write check.
function mockWindowsEntry(initial: RegistryEntry | null, packages: readonly typeof installedPackage[] | Error = [installedPackage]) {
  const writes: RegistryChange[] = [];
  const state = { entry: initial, backup: null as RegistryEntry | null, onDiscovery: undefined as (() => void) | undefined,
    readError: undefined as Error | undefined, writeError: undefined as Error | undefined };
  registry.exec.mockImplementation((program: string, args: string[], _options, callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void) => {
    expect(program).toBe("powershell.exe");
    const script = args.includes("-EncodedCommand") ? Buffer.from(args.at(-1)!, "base64").toString("utf16le") : args.at(-1)!;
    const reply = (data?: object) => callback(null, { stdout: data === undefined ? "" : JSON.stringify(data), stderr: "" });
    if (script.includes("Get-AppxPackage")) {
      state.onDiscovery?.();
      if (packages instanceof Error) return callback(packages);
      return reply({ packages });
    }
    if (script.includes("SendMessageTimeout")) return reply();
    // Allow the reproduction to run against the v0.1.25 user-entry reader as well.
    if (script.includes("GetEnvironmentVariable('CODEX_CLI_PATH', 'User')")) return reply({ value: state.entry?.value ?? null });
    const encoded = /\$requestJson = '([A-Za-z0-9+/=]+)'/u.exec(script)?.[1];
    if (encoded === undefined) throw new Error("Unexpected PowerShell request");
    const request = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as { action: "read" } | RegistryChange;
    if (request.action === "read") return state.readError === undefined ? reply({ entry: state.entry }) : callback(state.readError);
    if (state.entry?.raw !== request.expected?.raw || state.entry?.kind !== request.expected?.kind) return callback(new Error("CODEX_CLI_PATH changed"));
    if (state.writeError !== undefined) return callback(state.writeError);
    writes.push(request);
    if (request.action === "register") {
      if (request.preserveOriginal) state.backup = state.entry;
      else if (!state.entry?.value.trim()) state.backup = null;
      state.entry = stringEntry(request.launcher);
    } else {
      state.entry = state.backup;
      state.backup = null;
    }
    return reply();
  });
  return { state, writes };
}

// CODEX-DESKTOP-WIN-ENTRY-01: the installed MSIX's own CLI is not a third-party override.
describe("Windows Codex Desktop user entry", () => {
  it("registers the wrapper when CODEX_CLI_PATH names the installed Codex Store CLI", () => onWindows(async () => {
    const native = stringEntry(bundledCli);
    const { state, writes } = mockWindowsEntry(native);
    await expect(ensureCodexDesktopEntry(windowsLauncher)).resolves.toMatchObject({ state: "enabled" });
    expect(state.entry).toEqual(stringEntry(windowsLauncher));
    expect(writes).toEqual([{ action: "register", expected: native, launcher: windowsLauncher, preserveOriginal: true }]);
    // Reopening Codex must not overwrite the saved value with the wrapper itself.
    await expect(ensureCodexDesktopEntry(windowsLauncher)).resolves.toMatchObject({ state: "enabled" });
    expect(writes).toHaveLength(1);
    await suspendCodexDesktopEntry(windowsLauncher);
    expect(state.entry).toEqual(native);
    expect(state.backup).toBeNull();
    await suspendCodexDesktopEntry();
    expect(writes.map(write => write.action)).toEqual(["register", "suspend"]);
  }));

  it("restores the unexpanded Store path and its type when uninstalling after a launcher move", () => onWindows(async () => {
    const native = { raw: bundledCli.replace("C:\\Program Files", "%ProgramFiles%"), value: bundledCli.toLowerCase(), kind: "ExpandString" } as const;
    const { state, writes } = mockWindowsEntry(native);
    const moved = windowsLauncher.replace("Users\\x", "Users\\y");
    await expect(ensureCodexDesktopEntry(windowsLauncher)).resolves.toMatchObject({ state: "enabled" });
    await expect(ensureCodexDesktopEntry(moved)).resolves.toMatchObject({ state: "enabled" });
    expect(state.entry?.value).toBe(moved);
    expect(writes[1]).toMatchObject({ preserveOriginal: false });
    await removeCodexDesktopEntry();
    expect(state.entry).toEqual(native);
  }));

  it.each([
    ["a custom executable", "C:\\custom\\codex.exe", [installedPackage]],
    ["an unregistered package path", bundledCli.replace("26.1111.2228.0", "26.1023.1.0"), [installedPackage]],
    ["a same-name package from a different publisher", bundledCli, [{ ...installedPackage, packageFullName: packageFullName.replace("2p2nqsd0c76g0", "anotherpublisher") }]],
    ["a development-signed registration", bundledCli, [{ ...installedPackage, signatureKind: "Developer" }]],
    ["ambiguous registered packages", bundledCli, [installedPackage, { ...installedPackage, installLocation: installLocation.replace("C:", "D:") }]],
    ["unavailable package discovery", bundledCli, new Error("AppX unavailable")],
  ] as const)("leaves %s untouched", (_name, path, packages) => onWindows(async () => {
    const native = stringEntry(path);
    const { state, writes } = mockWindowsEntry(native, packages);
    await expect(ensureCodexDesktopEntry(windowsLauncher)).resolves.toMatchObject({ state: "foreign" });
    expect(writes).toEqual([]);
    expect(state.entry).toEqual(native);
  }));

  it("leaves the native value in place when its original registry value cannot be preserved", () => onWindows(async () => {
    const native = stringEntry(bundledCli);
    const { state, writes } = mockWindowsEntry(native);
    state.writeError = new Error("cannot save original value");
    await expect(ensureCodexDesktopEntry(windowsLauncher)).resolves.toMatchObject({ state: "foreign" });
    expect(writes).toEqual([]);
    expect(state.entry).toEqual(native);
  }));

  it("does not replace a newly edited override after checking the Store registration", () => onWindows(async () => {
    const { state, writes } = mockWindowsEntry(stringEntry(bundledCli));
    const custom = stringEntry("C:\\custom\\codex.exe");
    state.onDiscovery = () => { state.entry = custom; };
    await expect(ensureCodexDesktopEntry(windowsLauncher)).resolves.toMatchObject({ state: "foreign" });
    expect(writes).toEqual([]);
    expect(state.entry).toEqual(custom);
  }));

  it("never treats an unreadable user entry as permission to replace it", () => onWindows(async () => {
    const { state } = mockWindowsEntry(stringEntry(bundledCli));
    state.readError = new Error("access denied");
    await expect(ensureCodexDesktopEntry(windowsLauncher)).resolves.toMatchObject({ state: "foreign", detail: expect.stringContaining("无法读取") });
    expect(registry.exec).toHaveBeenCalledOnce();
  }));

  it("still registers and removes the wrapper normally when the user value was absent", () => onWindows(async () => {
    const { state, writes } = mockWindowsEntry(null);
    await expect(ensureCodexDesktopEntry(windowsLauncher)).resolves.toMatchObject({ state: "enabled" });
    expect(writes[0]).toMatchObject({ expected: null, preserveOriginal: false });
    expect(state.entry?.value).toBe(windowsLauncher);
    await removeCodexDesktopEntry();
    expect(state.entry).toBeNull();
  }));

  it("removes only an owned Desktop entry and verifies the registry result", () => onWindows(async () => {
    const { state, writes } = mockWindowsEntry(stringEntry(windowsLauncher));
    state.writeError = new Error("CODEX_CLI_PATH write did not take effect");
    await expect(suspendCodexDesktopEntry()).rejects.toThrow("did not take effect");
    expect(state.entry?.value).toBe(windowsLauncher);
    state.writeError = undefined;
    await suspendCodexDesktopEntry();
    expect(state.entry).toBeNull();
    expect(writes.map(write => write.action)).toEqual(["suspend"]);

    state.entry = stringEntry("C:\\custom\\codex.exe");
    await expect(suspendCodexDesktopEntry()).rejects.toThrow("不是 Orbis");
    expect(state.entry.value).toBe("C:\\custom\\codex.exe");
    // CODEX-DESKTOP-BOOTSTRAP-01: an installer may suspend only the entry it tried to repair.
    state.entry = stringEntry(windowsLauncher.replace("wrapper", "other-wrapper"));
    await expect(suspendCodexDesktopEntry(windowsLauncher)).rejects.toThrow("已改变");
    expect(writes).toHaveLength(1);

    registry.exec.mockClear();
    state.readError = new Error("access denied");
    await expect(suspendCodexDesktopEntry()).rejects.toThrow("access denied");
    expect(registry.exec).toHaveBeenCalledOnce();
  }));
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
      expect(await codexShimStatus(runtime)).toMatchObject({ state: "repair", detail: expect.stringContaining(join(competing, "codex.cmd")), needsElevation: true });
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

// 桌面版接入的入口写在用户级 CODEX_CLI_PATH 上，这是「用户自己打开桌面版也能接入」的
// 唯一支点；它的所有权规则必须写死：空就写、是我的就指向最新位置、**是别人的绝不动**。
describe("Codex desktop entry ownership", () => {
  const launcher = "C:\\Users\\x\\AppData\\Local\\Orbis\\wrapper\\bin\\codex-launcher.exe";

  it("takes an empty slot, repoints its own stale value, and never overwrites a foreign one", () => {
    expect(codexDesktopEntryDecision(undefined, launcher)).toMatchObject({ state: "enabled", write: launcher });
    expect(codexDesktopEntryDecision("   ", launcher)).toMatchObject({ state: "enabled", write: launcher });
    expect(codexDesktopEntryDecision(launcher, launcher)).toMatchObject({ state: "enabled" });
    expect(codexDesktopEntryDecision(launcher, launcher).write).toBeUndefined();

    // 旧安装位置（同样是我们自己的文件）→ 重新指向，不留下一个死路径。
    const moved = "D:\\old\\Orbis\\wrapper\\bin\\codex-launcher.exe";
    expect(looksLikeOrbisWrapperEntry(moved)).toBe(true);
    expect(codexDesktopEntryDecision(moved, launcher)).toMatchObject({ state: "enabled", write: launcher });

    // 别人的 CLI（例如用户自己包的 wrapper）：只报告，绝不改。
    const foreign = "C:\\Users\\x\\tools\\my-codex.exe";
    expect(looksLikeOrbisWrapperEntry(foreign)).toBe(false);
    const decision = codexDesktopEntryDecision(foreign, launcher);
    expect(decision.state).toBe("foreign");
    expect(decision.write).toBeUndefined();
    expect(decision.detail).toContain("CODEX_CLI_PATH");
  });
});

describe("Codex desktop entry ownership on macOS", () => {
  const launcher = "/Users/x/Library/Application Support/Orbis/wrapper/bin/codex-launcher";

  it("recognizes its own generated launcher and still leaves foreign values alone", () => {
    expect(looksLikeOrbisWrapperEntry(launcher)).toBe(true);
    expect(codexDesktopEntryDecision(undefined, launcher, "darwin")).toMatchObject({ state: "enabled", write: launcher });
    expect(codexDesktopEntryDecision(undefined, launcher, "darwin").detail).toContain("程序坞");
    expect(codexDesktopEntryDecision("/Users/old/Library/Application Support/Orbis/wrapper/bin/codex-launcher", launcher, "darwin"))
      .toMatchObject({ state: "enabled", write: launcher });
    expect(looksLikeOrbisWrapperEntry("/opt/homebrew/bin/codex")).toBe(false);
    expect(codexDesktopEntryDecision("/opt/homebrew/bin/codex", launcher, "darwin")).toMatchObject({ state: "foreign" });
  });
});
