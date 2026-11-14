import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { testDirectory } from "../../../scripts/test-fixtures/temp-directory.js";
import { clearDesktopRecovery, desktopRecoveryPath, markDesktopRecoveryRetry, nativeDesktopEnvironment, readDesktopRecoveryReason, recoverNativeDesktop } from "./codex-desktop-recovery.js";

describe("Desktop native startup recovery", () => {
  it("records recovery, keeps retry guidance until bridge success, then clears it", async () => {
    const endpoint = join(await testDirectory(join(tmpdir(), "orbis-recovery-")), "endpoint.json");
    const suspend = vi.fn(async () => {});
    const reason = await recoverNativeDesktop(endpoint, new Error("spawn EPERM"), suspend);
    expect(suspend).toHaveBeenCalledOnce();
    expect(reason).toContain("自行完全退出");
    expect(readDesktopRecoveryReason(endpoint, true)).toBe(reason);
    expect(JSON.parse(await readFile(desktopRecoveryPath(endpoint), "utf8")).detail).toContain("EPERM");
    markDesktopRecoveryRetry(endpoint);
    expect(readDesktopRecoveryReason(endpoint, true)).toBeUndefined();
    expect(readDesktopRecoveryReason(endpoint)).toContain("已通过启动检查");
    clearDesktopRecovery(endpoint);
    expect(readDesktopRecoveryReason(endpoint)).toBeUndefined();
  });

  it("does not claim native recovery succeeded when the registry cannot be changed", async () => {
    const endpoint = join(await testDirectory(join(tmpdir(), "orbis-recovery-failed-")), "endpoint.json");
    const reason = await recoverNativeDesktop(endpoint, "no CLI", async () => { throw new Error("access denied"); });
    expect(reason).toContain("未能恢复");
    expect(reason).not.toContain("已暂停");
  });

  it("removes only Orbis's inherited override and preserves user variables", () => {
    const original = { CODEX_CLI_PATH: "C:\\Local\\Orbis\\wrapper\\bin\\codex-launcher.exe", ORBIS_CODEX_WRAPPER_NODE: "node.exe", ORBIS_CODEX_WRAPPER_SCRIPT: "wrapper.js", ORBIS_CODEX_DESKTOP_ENDPOINT: "endpoint", HTTPS_PROXY: "proxy", CODEX_HOME: "home" };
    expect(nativeDesktopEnvironment(original)).toEqual({ HTTPS_PROXY: "proxy", CODEX_HOME: "home" });
    expect(original.CODEX_CLI_PATH).toBeDefined();
    const foreign = { CODEX_CLI_PATH: "C:\\custom\\codex.exe", CODEX_HOME: "home" };
    expect(nativeDesktopEnvironment(foreign)).toEqual(foreign);
  });
});
