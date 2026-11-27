/**
 * ADR-0096 CODEX-DESKTOP-LAUNCH-02: a running Codex Desktop without endpoint gets the precise reason
 * and next step, never only "not attached".
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { testDirectory } from "../../../scripts/test-fixtures/temp-directory.js";
import { diagnoseNoEndpoint } from "./codex-desktop-integration.js";

vi.mock("./codex-desktop-cli.js", async original => ({ ...await original<typeof import("./codex-desktop-cli.js")>(),
  isRegisteredWindowsDesktopCli: vi.fn(),
}));
import { isRegisteredWindowsDesktopCli } from "./codex-desktop-cli.js";

describe("why a running Codex Desktop is not attached", () => {
  // CODEX-DESKTOP-WIN-ENTRY-01: a verified Store CLI is adoptable without user registry edits.
  it("asks to reopen through Orbis rather than remove the official Windows override", async () => {
    const cli = "C:\\Program Files\\WindowsApps\\Codex\\app\\resources\\codex.exe";
    vi.mocked(isRegisteredWindowsDesktopCli).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const diagnose = () => diagnoseNoEndpoint("endpoint.json", { platform: "win32", starting: () => false, readEntry: async () => cli });
    const first = await diagnose();
    expect(first?.status).toMatchObject({ state: "closed", reason: expect.stringContaining("从托盘完全退出 Codex，再从 Orbis 打开") });
    expect(first?.status.reason).not.toContain("移除");
    expect((await diagnose())?.status).toMatchObject({ state: "error", reason: expect.stringContaining("移除该设置") });
  });

  it("names a starting wrapper, a foreign entry, a missing entry and a Desktop opened before the entry", async () => {
    const endpoint = join(await testDirectory(join(tmpdir(), "orbis-desktop-diagnosis-")), "codex-desktop-endpoint.json");
    const ours = "/Users/x/Library/Application Support/Orbis/wrapper/bin/codex-launcher";
    const diagnose = (entry: string | undefined | Error, starting = false) => diagnoseNoEndpoint(endpoint, {
      platform: "darwin", starting: () => starting,
      readEntry: async () => { if (entry instanceof Error) throw entry; return entry; },
    });
    expect(await diagnose(undefined, true)).toMatchObject({ pending: true, status: { state: "closed", reason: expect.stringContaining("请稍候") } });
    expect(await diagnose("/opt/custom/codex")).toEqual({ status: { state: "error", reason: expect.stringContaining("/opt/custom/codex") } });
    expect((await diagnose("/opt/custom/codex"))?.status.reason).toContain("移除该设置");
    expect(await diagnose(undefined)).toEqual({ status: { state: "closed", reason: expect.stringContaining("尚未登记") } });
    expect(await diagnose(ours)).toEqual({ status: { state: "closed", reason: expect.stringContaining("⌘Q") } });
    // An unreadable entry proves nothing; the generic presence reason stays.
    expect(await diagnose(new Error("launchctl failed"))).toBeUndefined();
    expect(await diagnoseNoEndpoint(endpoint, { platform: "linux", starting: () => false })).toBeUndefined();
  });
});
