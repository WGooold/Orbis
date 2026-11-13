import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as installation from "./agent-installation.js";
import * as discovery from "./claude-integration-install.js";
import * as version from "./claude-version.js";
import { updateClaudeCode } from "./claude-update.js";

describe("Claude's native updater", () => {
  beforeEach(() => {
    vi.spyOn(discovery, "findClaudeExecutable").mockResolvedValue("/fixture/bin/claude");
    vi.spyOn(version, "readClaudeVersion").mockResolvedValue("2.1.322");
    vi.spyOn(installation, "runAgentInstaller").mockResolvedValue({ stdout: "updated", stderr: "" });
  });
  afterEach(() => vi.restoreAllMocks());

  // HOST-CLAUDE-UPDATE-01: keep the selected native/package-manager launcher,
  // run its updater, and use its post-update version rather than command output.
  it("uses the exact launcher and configured environment, then verifies its version", async () => {
    const signal = new AbortController().signal;
    const env = { PATH: "/fixture/bin", CLAUDE_CONFIG_DIR: "/fixture/config" };
    const stages: string[] = [];
    await expect(updateClaudeCode({ signal, env, onStage: stage => stages.push(stage) }))
      .resolves.toEqual({ entry: "/fixture/bin/claude", version: "2.1.322" });
    expect(installation.runAgentInstaller).toHaveBeenCalledExactlyOnceWith("/fixture/bin/claude", ["update"], { env, signal, timeout: 600_000 });
    expect(version.readClaudeVersion).toHaveBeenCalledExactlyOnceWith("/fixture/bin/claude", env);
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
    expect(version.readClaudeVersion).not.toHaveBeenCalled();
  });
  it("keeps cancellation distinct and skips post-update success", async () => {
    const abort = new AbortController();
    vi.mocked(installation.runAgentInstaller).mockImplementation(async () => {
      abort.abort(new Error("cancelled fixture"));
      throw new Error("child stopped");
    });
    await expect(updateClaudeCode({ signal: abort.signal })).rejects.toThrow("cancelled fixture");
    expect(version.readClaudeVersion).not.toHaveBeenCalled();
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
});
