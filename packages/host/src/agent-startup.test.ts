import { homedir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { CODEX_STARTUP_ARGS, CLAUDE_STARTUP_ENV, PI_STARTUP_ENV, codexWorkspaceApprovalArgs, codexWorkspaceTrustKey, prepareCodexWorkspace } from "./agent-startup.js";

describe("Agent startup workspace authorization", () => {
  it("keeps update checks disabled only for Orbis-launched processes", () => {
    expect(CODEX_STARTUP_ARGS).toEqual(["-c", "check_for_update_on_startup=false"]);
    expect(CLAUDE_STARTUP_ENV).toEqual({ DISABLE_AUTOUPDATER: "1" });
    expect(PI_STARTUP_ENV).toEqual({ PI_SKIP_VERSION_CHECK: "1" });
  });
  it("quotes Codex paths as a single config key without changing execution permissions", () => {
    for (const cwd of ["/work/a.b", '/work/a"quote', "C:\\work\\a b", "D:/project"]) {
      expect(codexWorkspaceTrustKey(cwd)).toBe(`projects.${JSON.stringify(cwd)}.trust_level`);
      expect(codexWorkspaceApprovalArgs(cwd)).toEqual(["-c", `projects.${JSON.stringify(cwd)}.trust_level="trusted"`]);
    }
  });
  it.each(["relative/path", "/", "C:\\", "D:/", "/work/\nrepo", homedir()])("rejects ambiguous or overly broad paths: %s", cwd => {
    expect(() => codexWorkspaceTrustKey(cwd)).toThrow();
  });
  it("writes only one selected project through the actual backend config service", async () => {
    const request = vi.fn().mockResolvedValueOnce({ config: { projects: { "/other": { trust_level: "trusted" } } } })
      .mockResolvedValueOnce({ status: "ok", version: "2" });
    await prepareCodexWorkspace({ request }, "/work/a.b");
    expect(request.mock.calls).toEqual([
      ["config/read", { cwd: "/work/a.b", includeLayers: false }, 5000],
      ["config/batchWrite", { edits: [{ keyPath: 'projects."/work/a.b".trust_level', value: "trusted", mergeStrategy: "replace" }], reloadUserConfig: true }, 5000],
    ]);
  });
  it("does not rewrite an already trusted project", async () => {
    const request = vi.fn().mockResolvedValue({ config: { projects: { "/work": { trust_level: "trusted" } } } });
    await prepareCodexWorkspace({ request }, "/work");
    expect(request).toHaveBeenCalledTimes(1);
  });
  it.each(["okOverridden", undefined])("does not mistake a blocked or malformed reply for readiness: %s", status => {
    const request = vi.fn().mockResolvedValueOnce({ config: {} }).mockResolvedValueOnce({ status });
    return expect(prepareCodexWorkspace({ request }, "/work")).rejects.toThrow("未生效");
  });
  it("does not proceed after native configuration errors", async () => {
    const request = vi.fn().mockRejectedValue(new Error("native configuration rejected"));
    await expect(prepareCodexWorkspace({ request }, "/work")).rejects.toThrow("native configuration rejected");
    expect(request).toHaveBeenCalledTimes(1);
  });
});
