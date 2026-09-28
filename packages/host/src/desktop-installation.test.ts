import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
const installation = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("./agent-installation.js", async original => ({
  ...await original<typeof import("./agent-installation.js")>(), installAgentPackage: installation.run,
}));
import { agentEntries, agentPackages } from "./agent-installation.js";
import { DesktopRuntime, type DesktopEvent } from "./desktop-runtime.js";
import { resolveCodexCommand } from "./codex-daemon.js";
import { readCodexSelection } from "./codex-selection.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.clearAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true, maxRetries: 3 })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "orbis-desktop-install-")); roots.push(root);
  const prefix = join(root, "npm");
  vi.stubEnv("ORBIS_AGENT_INSTALL_ROOT", join(root, "agents"));
  vi.stubEnv("PATH", prefix); vi.stubEnv("APPDATA", join(root, "appdata"));
  for (const kind of ["pi", "codex", "dsh"] as const) {
    vi.stubEnv("ORBIS_" + kind.toUpperCase() + "_ENTRY", "");
    const packageRoot = join(prefix, "node_modules", agentPackages[kind]);
    const entry = join(packageRoot, agentEntries[kind]);
    await mkdir(dirname(entry), { recursive: true });
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: agentPackages[kind], version: "1.0.0" }));
    await writeFile(entry, 'console.log("1.0.0")');
  }
  const events: DesktopEvent[] = [];
  const runtime = new DesktopRuntime(event => events.push(event), join(root, "state"), { codex: join(root, "codex"), pi: join(root, "pi"), dsh: join(root, "dsh") });
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response('{"latest":"2.0.0"}')));
  return { root, prefix, runtime, events };
}

describe("desktop Agent installation commands", () => {
  it("persists the selected Codex npm copy for the Host and standalone shim", async () => {
    const { runtime, root, prefix, events } = await fixture();
    await runtime.detect();
    const alternate = join(root, "alternate-npm", "node_modules", agentPackages.codex, agentEntries.codex);
    await mkdir(dirname(alternate), { recursive: true });
    await writeFile(alternate, 'console.log("2.0.0")');
    await writeFile(join(root, "alternate-npm", "node_modules", agentPackages.codex, "package.json"), JSON.stringify({ name: agentPackages.codex, version: "2.0.0" }));
    vi.stubEnv("PATH", prefix + delimiter + join(root, "alternate-npm"));
    expect(await runtime.selectCodexEntry(alternate)).toEqual({ entry: alternate, version: "2.0.0" });
    expect(await readCodexSelection()).toBe(alternate);
    expect((await resolveCodexCommand()).prefixArgs).toEqual([alternate]);
    expect(events).toContainEqual({ event: "agentInstalled", kind: "codex", entry: alternate, version: "2.0.0" });
    expect((await runtime.detect({ codexEntry: alternate })).find(status => status.kind === "codex")?.entry).toBe(alternate);
    await runtime.close();
  });

  it("updates the detected Agent to latest without requiring a source choice", async () => {
    const { runtime, prefix } = await fixture();
    await runtime.detect();
    const entry = join(prefix, "node_modules", agentPackages.codex, agentEntries.codex);
    installation.run.mockResolvedValue({ entry, version: "2.0.0" });
    expect(await runtime.updateAgent("codex")).toEqual({ entry, version: "2.0.0" });
    expect(installation.run.mock.calls[0]?.[1]).toBe("latest");
    expect(installation.run.mock.calls[0]?.[5]).toEqual({ existingEntry: entry });
    // Bundled/project dependencies must get a managed update instead of an in-place npm install.
    await writeFile(join(prefix, "package.json"), "{}");
    await runtime.detect();
    await runtime.updateAgent("codex");
    expect(installation.run.mock.calls[1]?.[5]).toEqual({});
    await runtime.close();
  });

  it("preserves a successful Codex download when terminal selection storage fails", async () => {
    const { runtime, root, events } = await fixture();
    await runtime.detect();
    const entry = join(root, "installed", "bin", "codex.js");
    installation.run.mockResolvedValue({ entry, version: "2.0.0" });
    await rm(join(root, "agents"), { recursive: true, force: true });
    await writeFile(join(root, "agents"), "unwritable selection directory");
    expect(await runtime.install("codex", "2.0.0", "managed")).toEqual({ entry, version: "2.0.0" });
    expect(events).toContainEqual({ event: "agentInstalled", kind: "codex", entry, version: "2.0.0" });
    await runtime.close();
  });

  it("detects broken default entries without silently choosing a different copy", async () => {
    const { runtime, prefix, root } = await fixture();
    await rm(join(prefix, "node_modules", agentPackages.codex, agentEntries.codex));
    const second = join(root, "other-npm");
    const secondEntry = join(second, "node_modules", agentPackages.codex, agentEntries.codex);
    await mkdir(dirname(secondEntry), { recursive: true });
    await writeFile(secondEntry, 'console.log("2.0.0")');
    await writeFile(join(second, "node_modules", agentPackages.codex, "package.json"), JSON.stringify({ name: agentPackages.codex, version: "2.0.0" }));
    vi.stubEnv("PATH", prefix + delimiter + second);
    const statuses = await runtime.detect();
    expect(statuses.find(status => status.kind === "codex")).toMatchObject({ installed: false, installedButBroken: true, installationSource: "npm" });
    await expect(resolveCodexCommand()).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    await runtime.close();
  });

  it("preserves checked versions during local refresh, clearing stale results on registry failure", async () => {
    const { runtime } = await fixture();
    expect((await runtime.detect({}, true)).every(status => status.updateAvailable)).toBe(true);
    expect((await runtime.detect()).every(status => status.latestVersion === "2.0.0")).toBe(true);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    expect((await runtime.detect({}, true)).every(status => !status.latestVersion && !status.updateAvailable && status.latestError)).toBe(true);
    await runtime.close();
  });

  it("continues batch updates after one failure and emits settings only for verified successes", async () => {
    const { runtime, events, prefix } = await fixture();
    await runtime.detect({}, true);
    installation.run.mockImplementation(async (kind: "pi" | "codex" | "dsh") => {
      if (kind === "codex") throw new Error("download failed");
      return { entry: join(prefix, "node_modules", agentPackages[kind], agentEntries[kind]), version: "2.0.0", id: "install-record-id" };
    });
    expect(await runtime.installAll("update")).toEqual({ succeeded: 2, failures: ["codex: download failed"], cancelled: false });
    expect(installation.run.mock.calls.map(call => call[0])).toEqual(["pi", "codex", "dsh"]);
    const installed = events.filter(event => event.event === "agentInstalled");
    expect(installed).toHaveLength(2);
    expect(installed.every(event => !("id" in event))).toBe(true); // id is reserved for RPC responses.
    await runtime.close();
  });

  it("cancels the running batch and skips remaining downloads", async () => {
    const { runtime } = await fixture();
    await runtime.detect({}, true);
    installation.run.mockImplementation(async (_kind, _version, _root, signal: AbortSignal) => {
      runtime.cancelInstall();
      signal.throwIfAborted();
    });
    const result = await runtime.installAll("update");
    expect(result.cancelled).toBe(true);
    expect(installation.run).toHaveBeenCalledTimes(1);
    await runtime.close();
  });

  it("rejects overlapping installs and waits for cancellation before closing", async () => {
    const { runtime } = await fixture();
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    installation.run.mockImplementation(async (_kind, _version, _root, signal: AbortSignal) => {
      entered();
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled"))));
    });
    const pending = runtime.install("pi", "latest", "managed");
    const rejected = expect(pending).rejects.toThrow("cancelled");
    await started;
    await expect(runtime.install("codex")).rejects.toThrow("另一个安装");
    await runtime.close();
    await rejected;
  });

  it("resolves current DSH latest at install time while enforcing phone compatibility", async () => {
    const { runtime, prefix } = await fixture();
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response('{"latest":"0.1.5-rc.3"}')));
    await runtime.detect({}, true);
    installation.run.mockResolvedValue({ version: "0.1.7-rc.1", entry: join(prefix, "node_modules", agentPackages.dsh, agentEntries.dsh) });
    await runtime.install("dsh", "latest");
    expect(installation.run.mock.calls[0]?.[1]).toBe("0.1.7-rc.1");
    await expect(runtime.install("dsh", "0.1.5-rc.3")).rejects.toThrow("手机接入需要");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"latest":"0.1.7-rc.2"}')));
    await runtime.updateAgent("dsh");
    expect(installation.run.mock.calls[1]?.[1]).toBe("0.1.7-rc.2");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(runtime.updateAgent("dsh")).rejects.toThrow("最新版本查询失败");
    expect(installation.run).toHaveBeenCalledTimes(2);
    await runtime.close();
  });
});
