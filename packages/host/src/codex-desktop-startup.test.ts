import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
const processApi = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), spawn: processApi.spawn }));
import { DesktopCliSpawnError, desktopVersionFromArgs, isStartupPolicyQuery, isStartupProtocolResponse, passthroughCandidates, queryDesktopStartup, selectStartupCli, startDesktopCli, startupProbeArgs } from "./codex-desktop-startup.js";

const candidates = ["pin", "cache", "package"].map(source => ({ command: source + ".exe", prefixArgs: [], source }));
const good = { code: 0, stdout: '{"appServerVersion":"0.167","configRequirements":{}}', stderr: "" };
const queryArgs = ["app-server", "--print-startup-config"];
function childResult(code: number, stdout = "", stderr = "", error?: Error) {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  setImmediate(() => {
    if (error) child.emit("error", error);
    else {
      child.emit("spawn");
      child.stdout.end(stdout);
      child.stderr.end(stderr);
    }
    setImmediate(() => child.emit("close", code, null));
  });
  return child;
}
afterEach(() => { vi.restoreAllMocks(); processApi.spawn.mockReset(); });

describe("Desktop startup compatibility and retry boundaries", () => {
  it("falls back from both synchronous EPERM and asynchronous spawn errors", async () => {
    processApi.spawn.mockImplementationOnce(() => { throw Object.assign(new Error("spawn EPERM"), { code: "EPERM" }); })
      .mockImplementationOnce(() => childResult(127, "", "", new Error("spawn EACCES")))
      .mockImplementationOnce(() => childResult(0, good.stdout));
    const selected = await selectStartupCli(candidates, queryArgs, {}, () => {});
    expect(selected.cli.source).toBe("package");
    expect(selected.result.stdout).toBe(good.stdout);
    expect(processApi.spawn).toHaveBeenCalledTimes(3);
  });

  it("rejects a version-capable old CLI with no startup JSON then selects the compatible copy", async () => {
    const query = vi.fn().mockResolvedValueOnce({ code: 2, stdout: "", stderr: "unexpected argument --print-startup-config" }).mockResolvedValueOnce(good);
    expect((await selectStartupCli(candidates, queryArgs, {}, () => {}, query)).cli.source).toBe("cache");
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("passes through real policy errors exactly once without selecting another CLI", async () => {
    const policy = { code: 1, stdout: '{"error":{"code":-32000,"message":"organization policy denied"}}\n', stderr: "diagnostic\n" };
    const query = vi.fn().mockResolvedValue(policy);
    expect((await selectStartupCli(candidates, queryArgs, {}, () => {}, query)).result).toEqual(policy);
    expect(query).toHaveBeenCalledOnce();
    expect(isStartupProtocolResponse('{"error":"invalid"}')).toBe(false);
    expect(isStartupProtocolResponse("codex-cli 0.167")).toBe(false);
  });

  it("never replays a side-effecting command after spawn, even if it exits 2", async () => {
    processApi.spawn.mockImplementation(() => childResult(2));
    expect(await passthroughCandidates(candidates, ["app-server", "--startup-sign-out"], {}, () => {})).toBe(2);
    expect(processApi.spawn).toHaveBeenCalledOnce();
  });

  it("only retries arbitrary commands when the OS did not start the process", async () => {
    processApi.spawn.mockImplementationOnce(() => { throw new Error("spawn EPERM"); }).mockImplementationOnce(() => childResult(3));
    expect(await passthroughCandidates(candidates, ["login"], {}, () => {})).toBe(3);
    expect(processApi.spawn).toHaveBeenCalledTimes(2);
  });

  it("does not turn sign-out into a retryable query and preserves client info in the safe probe", async () => {
    const info = '{"name":"codex_desktop","version":"26.1106.6628.0"}';
    const args = [...queryArgs, "--startup-sign-out", "--startup-client-info", info];
    expect(isStartupPolicyQuery(args)).toBe(false);
    expect(startupProbeArgs(args)).toEqual([...queryArgs, "--startup-client-info", info]);
    expect(desktopVersionFromArgs(args)).toBe("26.1106.6628.0");
    expect(desktopVersionFromArgs(["--startup-client-info", "invalid"])).toBeUndefined();
    await expect(queryDesktopStartup(candidates[0]!, args, {})).rejects.toThrow("只读");
    expect(processApi.spawn).not.toHaveBeenCalled();
  });

  it("buffers all output and enforces the timeout on only its own probe child", async () => {
    processApi.spawn.mockImplementationOnce(() => childResult(0, good.stdout, "log\n"));
    await expect(queryDesktopStartup(candidates[0]!, queryArgs, {})).resolves.toEqual({ ...good, stderr: "log\n" });
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => { setImmediate(() => child.emit("close", null, "SIGTERM")); return true; }) });
    processApi.spawn.mockImplementationOnce(() => { setImmediate(() => child.emit("spawn")); return child; });
    await expect(queryDesktopStartup(candidates[0]!, queryArgs, {}, 10)).rejects.toThrow("超时");
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("wraps a synchronous spawn failure for the command retry boundary", async () => {
    processApi.spawn.mockImplementation(() => { throw new Error("spawn EPERM"); });
    await expect(startDesktopCli(candidates[0]!, [], {})).rejects.toBeInstanceOf(DesktopCliSpawnError);
  });
});
