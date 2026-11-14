import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testDirectory } from "../../../scripts/test-fixtures/temp-directory.js";
const runtime = vi.hoisted(() => ({ candidates: vi.fn(), select: vi.fn(), passthrough: vi.fn(), start: vi.fn() }));
vi.mock("./codex-desktop-cli.js", () => ({ windowsDesktopCliCandidates: runtime.candidates }));
vi.mock("./codex-desktop-startup.js", async original => ({
  ...await original<typeof import("./codex-desktop-startup.js")>(),
  selectStartupCli: runtime.select, passthroughCandidates: runtime.passthrough, startDesktopCli: runtime.start,
}));
import { main } from "./codex-desktop-wrapper.js";
import { DesktopCliSpawnError } from "./codex-desktop-startup.js";

const copy = { command: "existing-copy.exe", prefixArgs: [], source: "desktop-cache" };
const packaged = { command: "packaged.exe", prefixArgs: [], source: "desktop-package" };
afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); process.exitCode = 0; });
async function environment() {
  return { ORBIS_CODEX_DESKTOP_ENDPOINT: join(await testDirectory(join(tmpdir(), "orbis-wrapper-main-")), "endpoint.json") };
}

describe("wrapper entry integration", () => {
  it("forwards the selected startup policy JSON and stderr byte for byte, including native errors", async () => {
    const result = { code: 1, stdout: '{"error":{"code":-32000,"message":"policy denied"}}\n', stderr: "native log\n" };
    runtime.candidates.mockResolvedValue([copy, packaged]);
    runtime.select.mockResolvedValue({ cli: copy, result });
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const recover = vi.fn();
    await main(["app-server", "--print-startup-config", "--startup-client-info", '{"version":"26.1106.6628.0"}'], await environment(), { platform: "win32", recover });
    expect(stdout).toHaveBeenCalledExactlyOnceWith(result.stdout);
    expect(stderr).toHaveBeenCalledExactlyOnceWith(result.stderr);
    expect(process.exitCode).toBe(1);
    expect(recover).not.toHaveBeenCalled();
    expect(runtime.passthrough).not.toHaveBeenCalled();
    expect(runtime.candidates.mock.calls[0]?.[1].desktopVersion).toBe("26.1106.6628.0");
  });

  it("probes sign-out with a read-only query, then executes sign-out only once", async () => {
    runtime.candidates.mockResolvedValue([copy, packaged]);
    runtime.select.mockResolvedValue({ cli: copy });
    runtime.start.mockResolvedValue({ child: {}, closed: Promise.resolve(2) });
    const args = ["app-server", "--print-startup-config", "--startup-sign-out"];
    const recover = vi.fn();
    await main(args, await environment(), { platform: "win32", recover });
    expect(runtime.select.mock.calls[0]?.[1]).not.toContain("--startup-sign-out");
    expect(runtime.start).toHaveBeenCalledOnce();
    expect(runtime.start.mock.calls[0]?.[1]).toEqual(args);
    expect(process.exitCode).toBe(2);
    expect(recover).not.toHaveBeenCalled();
  });

  it("can select the next CLI if spawn fails after the selected CLI passed its probe", async () => {
    runtime.candidates.mockResolvedValue([copy, packaged]);
    runtime.select.mockResolvedValueOnce({ cli: copy }).mockResolvedValueOnce({ cli: packaged });
    runtime.start.mockRejectedValueOnce(new DesktopCliSpawnError(copy.command, new Error("EPERM")))
      .mockResolvedValueOnce({ child: {}, closed: Promise.resolve(0) });
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const recover = vi.fn();
    await main(["app-server", "--startup-sign-out"], await environment(), { platform: "win32", recover });
    expect(runtime.start).toHaveBeenCalledTimes(2);
    expect(runtime.select.mock.calls[1]?.[0]).toEqual([packaged]);
    expect(recover).not.toHaveBeenCalled();
  });

  it("persists recovery only after all startup candidates are unavailable, without fake success JSON", async () => {
    runtime.candidates.mockResolvedValue([copy, packaged]);
    runtime.select.mockRejectedValue(new Error("all candidates EPERM"));
    const recover = vi.fn(async () => "native recovery");
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const env = await environment();
    await main(["app-server", "--print-startup-config"], env, { platform: "win32", recover });
    expect(process.exitCode).toBe(127);
    expect(stdout).not.toHaveBeenCalled();
    expect(recover).toHaveBeenCalledExactlyOnceWith(env.ORBIS_CODEX_DESKTOP_ENDPOINT, expect.any(Error));
  });
});
