import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as installation from "./agent-installation.js";
import * as discovery from "./claude-integration-install.js";
import * as version from "./claude-version.js";
import { fetchClaudeLatestVersion, updateClaudeCode } from "./claude-update.js";

describe("Claude's native updater", () => {
  beforeEach(() => {
    vi.spyOn(discovery, "findClaudeExecutable").mockResolvedValue("/fixture/bin/claude");
    vi.spyOn(version, "readClaudeVersion").mockResolvedValueOnce("2.1.321").mockResolvedValue("2.1.322");
    vi.spyOn(installation, "runAgentInstaller").mockResolvedValue({ stdout: "updated", stderr: "" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("2.1.322\n")));
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  // HOST-CLAUDE-UPDATE-01: keep the selected native/package-manager launcher,
  // run its updater, and use its post-update version rather than command output.
  it("uses the exact launcher and configured environment, then verifies its version", async () => {
    const signal = new AbortController().signal;
    const env = { PATH: "/fixture/bin", CLAUDE_CONFIG_DIR: "/fixture/config" };
    const stages: string[] = [];
    await expect(updateClaudeCode({ signal, env, onStage: stage => stages.push(stage) }))
      .resolves.toEqual({ entry: "/fixture/bin/claude", version: "2.1.322" });
    expect(installation.runAgentInstaller).toHaveBeenCalledExactlyOnceWith("/fixture/bin/claude", ["--settings", '{"autoUpdatesChannel":"latest"}', "update"], { env, signal, timeout: 600_000 });
    expect(version.readClaudeVersion).toHaveBeenCalledTimes(2);
    expect(version.readClaudeVersion).toHaveBeenLastCalledWith("/fixture/bin/claude", env);
    expect(stages).toEqual(["downloading", "verifying"]);
  });

  it("does not install another copy when Claude is missing", async () => {
    vi.mocked(discovery.findClaudeExecutable).mockResolvedValue(undefined);
    await expect(updateClaudeCode({ signal: new AbortController().signal })).rejects.toThrow("没有找到 Claude Code");
    expect(installation.runAgentInstaller).not.toHaveBeenCalled();
  });

  // A native command's successful exit is insufficient when the launcher is
  // broken afterwards, and failed output must not expose proxy credentials.
  it("does not report success if the updated launcher cannot report a version", async () => {
    vi.mocked(version.readClaudeVersion).mockRejectedValue(new Error("无法读取 Claude Code 版本"));
    await expect(updateClaudeCode({ signal: new AbortController().signal })).rejects.toThrow("无法读取");
  });
  it("reports failure without publishing installer diagnostics", async () => {
    vi.mocked(installation.runAgentInstaller).mockRejectedValue(Object.assign(new Error("failed"), { stderr: "https://user:secret@proxy.invalid" }));
    await expect(updateClaudeCode({ signal: new AbortController().signal })).rejects.toThrow("请运行 claude update");
    expect(version.readClaudeVersion).toHaveBeenCalledTimes(1);
  });
  it("keeps cancellation distinct and skips post-update success", async () => {
    const abort = new AbortController();
    vi.mocked(installation.runAgentInstaller).mockImplementation(async () => {
      abort.abort(new Error("cancelled fixture"));
      throw new Error("child stopped");
    });
    await expect(updateClaudeCode({ signal: abort.signal })).rejects.toThrow("cancelled fixture");
    expect(version.readClaudeVersion).toHaveBeenCalledTimes(1);
  });
  it("never starts an updater for an already cancelled request", async () => {
    const abort = new AbortController(); abort.abort();
    await expect(updateClaudeCode({ signal: abort.signal })).rejects.toThrow();
    expect(discovery.findClaudeExecutable).not.toHaveBeenCalled();
    expect(installation.runAgentInstaller).not.toHaveBeenCalled();
  });
  it("passes the updater environment into the owned process runner", async () => {
    vi.mocked(installation.runAgentInstaller).mockRestore();
    const result = await installation.runAgentInstaller(process.execPath, ["-p", "process.env.CLAUDE_CONFIG_DIR"], {
      env: { CLAUDE_CONFIG_DIR: "/fixture/native-update-config" }, signal: new AbortController().signal, timeout: 5000,
    });
    expect(result.stdout.trim()).toBe("/fixture/native-update-config");
  });

  // HOST-CLAUDE-UPDATE-02: a successful updater can remain on a delayed package
  // channel or a pinned wrapper. Only the actual launcher reaching latest proves success.
  it("rejects a successful update that leaves the selected launcher behind latest", async () => {
    vi.mocked(version.readClaudeVersion).mockReset().mockResolvedValue("2.1.321");
    await expect(updateClaudeCode({ signal: new AbortController().signal })).rejects.toThrow("更新后仍为 2.1.321，最新版本为 2.1.322");
  });
  it.each(["2.1.322", "2.1.323"])("does not downgrade or reinstall an up-to-date launcher %s", async current => {
    vi.mocked(version.readClaudeVersion).mockReset().mockResolvedValue(current);
    await expect(updateClaudeCode({ signal: new AbortController().signal })).resolves.toHaveProperty("version", current);
    expect(installation.runAgentInstaller).not.toHaveBeenCalled();
  });
  it("does not start an update when the official latest cannot be checked", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("secret proxy diagnostics"));
    await expect(updateClaudeCode({ signal: new AbortController().signal })).rejects.toThrow("最新版本查询失败");
    expect(installation.runAgentInstaller).not.toHaveBeenCalled();
  });
  it.each(["bad response", '{"latest":"2.1.322"}', "2.01.322"])("rejects an invalid official latest pointer %s", async body => {
    vi.mocked(fetch).mockResolvedValue(new Response(body));
    await expect(fetchClaudeLatestVersion()).resolves.toBeUndefined();
  });
  it("reads the official native release pointer with a bounded, cancellable request", async () => {
    const signal = new AbortController().signal;
    await expect(fetchClaudeLatestVersion(signal)).resolves.toBe("2.1.322");
    expect(fetch).toHaveBeenCalledWith("https://downloads.claude.ai/claude-code-releases/latest", expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });
});
