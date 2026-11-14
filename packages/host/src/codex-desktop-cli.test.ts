import { mkdir, readFile, readdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { testDirectory } from "../../../scripts/test-fixtures/temp-directory.js";
import { desktopInstallationCli, windowsDesktopCliCandidates, type WindowsDesktopDiscovery } from "./codex-desktop-cli.js";

async function fixture() {
  const root = await testDirectory(join(tmpdir(), "orbis-cli-match-"));
  const local = join(root, "Local");
  const install = join(root, "WindowsApps", "OpenAI.Codex_26.1106.6628.0_x64__test");
  const packaged = join(install, "app", "resources", "codex.exe");
  const discovery: WindowsDesktopDiscovery = { packages: [{ installLocation: install, packageFullName: "OpenAI.Codex_26.1106.6628.0_x64__test" }] };
  const file = async (path: string, value: string) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, value); return path; };
  await file(packaged, "current-cli");
  await file(join(dirname(packaged), "codex-code-mode-host.exe"), "current-helper");
  const copy = async (name: string, cli = "current-cli", helper: string | null = "current-helper") => {
    const path = await file(join(local, "OpenAI", "Codex", "bin", name, "codex.exe"), cli);
    if (helper !== null) await file(join(dirname(path), "codex-code-mode-host.exe"), helper);
    return path;
  };
  const options = { discover: async () => discovery, digestCacheFile: join(root, "state", "hashes.json") };
  return { root, local, packaged, discovery, options, file, copy };
}

describe("matching the launching Desktop's existing CLI", () => {
  it("uses the actual GUI installation even when a newer package is registered", () => {
    const ancestor = join("C:/WindowsApps/OpenAI.Codex_26.1103.1.0_x64__test/app", "ChatGPT.exe");
    const newer = { installLocation: "C:/WindowsApps/new", packageFullName: "OpenAI.Codex_26.1106.1.0_x64__test" };
    expect(desktopInstallationCli({ ancestorExecutable: ancestor, packages: [newer] }, "26.1106.1.0"))
      .toBe(join(dirname(ancestor), "resources", "codex.exe"));
    expect(desktopInstallationCli({ packages: [newer] })).toBe(join(newer.installLocation, "app", "resources", "codex.exe"));
    const old = { installLocation: "C:/WindowsApps/old", packageFullName: "OpenAI.Codex_26.1103.1.0_x64__test" };
    expect(desktopInstallationCli({ packages: [newer, old] })).toBeUndefined();
    expect(desktopInstallationCli({ packages: [newer, old] }, "26.1103.1")).toBe(join(old.installLocation, "app", "resources", "codex.exe"));
  });

  it("prefers a complete identical official copy, ignoring mtime and incomplete companions", async () => {
    const f = await fixture();
    const valid = await f.copy("valid");
    const stale = await f.copy("stale", "old-cli");
    await utimes(stale, new Date("2030-01-01"), new Date("2030-01-01"));
    await f.copy("missing", "current-cli", null);
    await f.copy("wrong-helper", "current-cli", "older-helper");
    const candidates = await windowsDesktopCliCandidates({ LOCALAPPDATA: f.local }, f.options);
    expect(candidates.map(cli => cli.command)).toEqual([valid, f.packaged]);
    expect(candidates.map(cli => cli.source)).toEqual(["desktop-cache", "desktop-package"]);
    expect(await readdir(join(f.root, "state"))).toEqual(["hashes.json"]);
    expect(JSON.parse(await readFile(f.options.digestCacheFile, "utf8")).schema).toBe(1);
  });

  it("revalidates hashes after upgrade and never selects the old cached runtime", async () => {
    const f = await fixture();
    await f.copy("old");
    expect((await windowsDesktopCliCandidates({ LOCALAPPDATA: f.local }, f.options))[0]?.source).toBe("desktop-cache");
    await f.file(f.packaged, "updated-cli");
    await f.file(join(dirname(f.packaged), "codex-code-mode-host.exe"), "updated-helper");
    expect((await windowsDesktopCliCandidates({ LOCALAPPDATA: f.local }, f.options)).map(cli => cli.command)).toEqual([f.packaged]);
    const updated = await f.copy("updated", "updated-cli", "updated-helper");
    expect((await windowsDesktopCliCandidates({ LOCALAPPDATA: f.local }, f.options))[0]?.command).toBe(updated);
    // A companion changed in place must invalidate the metadata cache too.
    await f.file(join(dirname(updated), "codex-code-mode-host.exe"), "corrupt-helper");
    expect((await windowsDesktopCliCandidates({ LOCALAPPDATA: f.local }, f.options)).map(cli => cli.command)).toEqual([f.packaged]);
  });

  it("falls through missing, stale or recursive pins; a matching explicit CLI stays first", async () => {
    const f = await fixture();
    const copy = await f.copy("valid");
    const env = { LOCALAPPDATA: f.local, ORBIS_CODEX_REAL: join(f.root, "missing.exe") };
    expect((await windowsDesktopCliCandidates(env, f.options))[0]?.command).toBe(copy);
    const launcher = await f.file(join(f.root, "Orbis", "codex-launcher.exe"), "wrapper");
    expect((await windowsDesktopCliCandidates({ ...env, ORBIS_CODEX_REAL: launcher }, f.options))[0]?.command).toBe(copy);
    const pin = await f.file(join(f.root, "custom", "codex.exe"), "explicit-cli");
    expect((await windowsDesktopCliCandidates({ ...env, ORBIS_CODEX_REAL: pin }, f.options))[0]?.command).toBe(copy);
    await f.file(pin, "current-cli");
    await f.file(join(dirname(pin), "codex-code-mode-host.exe"), "current-helper");
    expect((await windowsDesktopCliCandidates({ ...env, ORBIS_CODEX_REAL: pin }, f.options))[0]?.command).toBe(pin);
  });

  it("requires the separate code-mode helper and matches all shipped companions", async () => {
    const f = await fixture();
    const copy = await f.copy("valid");
    await f.file(join(dirname(f.packaged), "codex-command-runner.exe"), "runner");
    expect((await windowsDesktopCliCandidates({ LOCALAPPDATA: f.local }, f.options)).map(cli => cli.command)).toEqual([f.packaged]);
    await f.file(join(dirname(copy), "codex-command-runner.exe"), "runner");
    expect((await windowsDesktopCliCandidates({ LOCALAPPDATA: f.local }, f.options))[0]?.command).toBe(copy);
    const pin = await f.file(join(f.root, "bare", "codex.exe"), "explicit");
    expect((await windowsDesktopCliCandidates({ LOCALAPPDATA: f.local, ORBIS_CODEX_REAL: pin }, { ...f.options, requireCodeModeHost: true }))[0]?.command).toBe(copy);
  });

  it("does not pick an arbitrary cache or PATH binary when installation discovery is ambiguous", async () => {
    const f = await fixture();
    await f.copy("unverified");
    const log = vi.fn();
    expect(await windowsDesktopCliCandidates({ LOCALAPPDATA: f.local }, { discover: async () => ({ packages: [] }), log })).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("无法唯一确认"));
  });
});
