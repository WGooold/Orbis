import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activateManagedAgent, activeManagedEntry, agentEntries, agentPackages, compareAgentVersions,
  extractAgentVersion, fetchNpmLatestVersion, findAgentCopies, installAgentPackage, installPackage,
  listManagedAgentInstallations, queryAgentStatus, resolveNpmTool, runAgentInstaller,
  type AgentInstallProgress, type InstallRun,
} from "./agent-installation.js";
import type { AgentKind } from "@pi-remote/protocol";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "orbis-install-")); roots.push(root); return root;
}
async function fakePackage(prefix: string, kind: AgentKind, version: string, options: { output?: string; bin?: string; name?: string; exit?: number } = {}): Promise<string> {
  const packageRoot = join(prefix, "node_modules", agentPackages[kind]);
  const entry = join(packageRoot, agentEntries[kind]);
  await mkdir(dirname(entry), { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: options.name ?? agentPackages[kind], version, bin: { [kind]: options.bin ?? agentEntries[kind] } }));
  await writeFile(entry, "console.log(" + JSON.stringify(options.output ?? version) + "); process.exit(" + (options.exit ?? 0) + ");");
  return entry;
}
function packageRunner(kind: AgentKind, version: string, options: Parameters<typeof fakePackage>[3] = {}): InstallRun {
  return async (command, args, runOptions) => {
    if (args.includes("install")) {
      await fakePackage(args[args.indexOf("--prefix") + 1]!, kind, version, options);
      return { stdout: "", stderr: "" };
    }
    return runAgentInstaller(command, args, runOptions);
  };
}
const signal = () => new AbortController().signal;

describe("Agent download and installation lifecycle", () => {
  it("compares stable, prerelease, build metadata and large Codex versions like CC Switch", () => {
    expect(compareAgentVersions("0.1.2505172116", "0.1.999999999")).toBe(1);
    expect(compareAgentVersions("1.2.3-alpha.10", "1.2.3-alpha.2")).toBe(1);
    expect(compareAgentVersions("1.2.3-beta", "1.2.3")).toBe(-1);
    expect(compareAgentVersions("1.2.3+abc", "1.2.3+def")).toBe(0);
    expect(compareAgentVersions("1.2.3-1", "1.2.3-alpha")).toBe(-1);
    for (const value of ["1.2", "1.2.3-", "1.2.3-a..b", "false"]) expect(compareAgentVersions(value, "1.2.3")).toBeUndefined();
    expect(extractAgentVersion("codex-cli 0.116.0")).toBe("0.116.0");
    expect(extractAgentVersion("dsh 0.1.7-rc.1\n")).toBe("0.1.7-rc.1");
  });

  it("only accepts fixed npm packages and version specifications", () => {
    for (const version of ["--global", "file:evil", "https://evil.test", "latest && calc", "1.2.3\n", "1.2.3-01", ""]) expect(() => installPackage("pi", version)).toThrow();
    expect(() => installPackage("other", "latest")).toThrow();
  });

  it("queries the small dist-tags endpoint and keeps prerelease channels opt-in", async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ latest: "1.2.3", alpha: "1.9.0-alpha.1" })));
    vi.stubGlobal("fetch", request);
    expect(await fetchNpmLatestVersion(agentPackages.codex)).toBe("1.2.3");
    expect(request.mock.calls[0]?.[0]).toBe("https://registry.npmjs.org/-/package/@openai%2fcodex/dist-tags");
    expect(request.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal);
  });

  it.each([new Response("missing", { status: 404 }), new Response("null"), new Response('{"latest":false}'), new Response("invalid")])("handles unavailable or malformed registries without inventing an update", async response => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    expect(await fetchNpmLatestVersion(agentPackages.pi)).toBeUndefined();
  });

  it("does not label a missing Agent as broken or offer a downgrade", async () => {
    const root = await fixture();
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response('{"latest":"1.0.0"}')));
    expect(await queryAgentStatus("codex", root, { installed: false, installedButBroken: false }, true)).toMatchObject({ installed: false, installedButBroken: false, latestVersion: "1.0.0", updateAvailable: false });
    expect(await queryAgentStatus("codex", root, { installed: true, installedButBroken: false, version: "2.0.0-alpha.1" }, true)).toMatchObject({ updateAvailable: false });
    expect(await queryAgentStatus("codex", root, { installed: true, installedButBroken: false, version: "0.9.0" }, true)).toMatchObject({ updateAvailable: true });
  });

  it("recommends Orbis's published DSH ACP version when npm latest is older", async () => {
    const root = await fixture();
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response('{"latest":"0.1.5-rc.3"}')));
    expect(await queryAgentStatus("dsh", root, { installed: true, installedButBroken: false, version: "0.1.5-rc.3" }, true)).toMatchObject({ latestVersion: "0.1.5-rc.3", recommendedVersion: "0.1.7-rc.1", updateAvailable: true, compatibilityNote: expect.stringContaining("手机接入") });
    expect(await queryAgentStatus("dsh", root, { installed: true, installedButBroken: false, version: "0.1.7-rc.1" }, true)).toMatchObject({ updateAvailable: false });
  });

  it("anchors npm to the selected Node and never falls back to a different PATH npm", async () => {
    const root = await fixture();
    await writeFile(join(root, "node.exe"), "");
    await expect(resolveNpmTool(root)).rejects.toThrow("npm");
    const npm = join(root, "node_modules", "npm", "bin", "npm-cli.js");
    await mkdir(dirname(npm), { recursive: true }); await writeFile(npm, "");
    expect(await resolveNpmTool(root)).toEqual({ command: join(root, "node.exe"), args: [npm] });
  });

  it.each(["pi", "codex", "dsh"] as const)("installs, verifies and persists %s across restart", async kind => {
    const root = await fixture(); const stages: AgentInstallProgress[] = [];
    const result = await installAgentPackage(kind, "1.2.3", root, signal(), progress => stages.push(progress), { run: packageRunner(kind, "1.2.3") });
    expect(await activeManagedEntry(kind, root)).toBe(result.entry);
    expect(await listManagedAgentInstallations(kind, root)).toEqual([expect.objectContaining({ version: "1.2.3", entry: result.entry, active: true })]);
    expect(stages.map(value => value.stage)).toEqual(["resolving", "downloading", "verifying", "activating", "done"]);
    await access(result.entry);
  });

  it("keeps the previous version runnable and supports validated rollback", async () => {
    const root = await fixture();
    const first = await installAgentPackage("codex", "1.0.0", root, signal(), undefined, { run: packageRunner("codex", "1.0.0") });
    const second = await installAgentPackage("codex", "2.0.0", root, signal(), undefined, { run: packageRunner("codex", "2.0.0") });
    expect(await activeManagedEntry("codex", root)).toBe(second.entry);
    expect(await activateManagedAgent("codex", first.id!, root, signal())).toMatchObject({ entry: first.entry, version: "1.0.0" });
    expect(await activeManagedEntry("codex", root)).toBe(first.entry);
    expect((await listManagedAgentInstallations("codex", root)).filter(item => item.active)).toHaveLength(1);
  });

  it.each([
    { output: "wrong output" }, { output: "2.0.0" }, { bin: "../../../../outside.js" },
    { name: "unrelated-package" }, { exit: 1 },
  ])("rejects unusable or mismatched packages, cleaning only the failed installation", async options => {
    const root = await fixture();
    const previous = await installAgentPackage("pi", "0.9.0", root, signal(), undefined, { run: packageRunner("pi", "0.9.0") });
    const before = await readdir(join(root, "pi"));
    await expect(installAgentPackage("pi", "1.0.0", root, signal(), undefined, { run: packageRunner("pi", "1.0.0", options) })).rejects.toThrow("原有 Agent 保持可用");
    expect(await activeManagedEntry("pi", root)).toBe(previous.entry);
    expect(await readdir(join(root, "pi"))).toEqual(before);
  });

  it("cancels immediately before activation without replacing the old manifest", async () => {
    const root = await fixture();
    const previous = await installAgentPackage("dsh", "1.0.0", root, signal(), undefined, { run: packageRunner("dsh", "1.0.0") });
    const abort = new AbortController();
    await expect(installAgentPackage("dsh", "2.0.0", root, abort.signal, progress => { if (progress.stage === "activating") abort.abort(); }, { run: packageRunner("dsh", "2.0.0") })).rejects.toThrow("安装已取消");
    expect(await activeManagedEntry("dsh", root)).toBe(previous.entry);
    expect(await readdir(join(root, "dsh"))).toHaveLength(2);
  });

  it("cleans a failed npm download, classifies integrity errors and hides registry secrets", async () => {
    const root = await fixture();
    const run: InstallRun = async () => { throw { stderr: "npm EINTEGRITY https://user:secret@registry.test/token", code: 1 }; };
    await expect(installAgentPackage("pi", "latest", root, signal(), undefined, { run })).rejects.toThrow("完整性校验失败");
    expect(await readdir(join(root, "pi"))).toEqual([]);
  });

  it("updates the detected global npm prefix and verifies its actual version", async () => {
    const root = await fixture(); const prefix = join(root, "Global Node");
    const entry = await fakePackage(prefix, "codex", "1.0.0");
    const run = vi.fn(packageRunner("codex", "2.0.0"));
    const result = await installAgentPackage("codex", "2.0.0", join(root, "managed"), signal(), undefined, { existingEntry: entry, run });
    expect(result.entry).toBe(entry);
    expect(run.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(["--global", "--prefix", prefix, "--include=optional", "@openai/codex@2.0.0"]));
    expect(await listManagedAgentInstallations("codex", join(root, "managed"))).toEqual([]);
  });

  it("does not mistake project dependencies for a global npm installation", async () => {
    const root = await fixture(); const entry = await fakePackage(root, "pi", "1.0.0");
    await writeFile(join(root, "package.json"), "{}"); const run = vi.fn();
    await expect(installAgentPackage("pi", "latest", join(root, "managed"), signal(), undefined, { existingEntry: entry, run })).rejects.toThrow("项目依赖");
    expect(run).not.toHaveBeenCalled();
  });

  it("finds all npm copies in PATH order, including broken entries", async () => {
    const root = await fixture(); const first = join(root, "one"); const second = join(root, "two");
    const a = await fakePackage(first, "codex", "1.0.0"); const b = await fakePackage(second, "codex", "2.0.0");
    await rm(a);
    expect(await findAgentCopies("codex", { PATH: [first, second, first].join(delimiter) })).toEqual([{ entry: a, version: "1.0.0" }, { entry: b, version: "2.0.0" }]);
  });

  it("fails closed on a corrupt installation record", async () => {
    const root = await fixture(); await mkdir(join(root, "pi"));
    await writeFile(join(root, "pi", "installations.json"), "broken"); const run = vi.fn();
    await expect(installAgentPackage("pi", "latest", root, signal(), undefined, { run })).rejects.toThrow("安装记录不可读");
    expect(run).not.toHaveBeenCalled();
    expect(await readFile(join(root, "pi", "installations.json"), "utf8")).toBe("broken");
  });

  it("waits for cancellation of the owned process tree", async () => {
    const abort = new AbortController();
    const pending = runAgentInstaller(process.execPath, ["-e", "setInterval(()=>{},1000)"], { signal: abort.signal, timeout: 10_000 });
    setTimeout(() => abort.abort(), 200);
    await expect(pending).rejects.toThrow("取消");
  });
});
