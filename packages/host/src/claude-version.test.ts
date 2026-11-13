import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { testDirectory } from "../../../scripts/test-fixtures/temp-directory.js";
import { readClaudeVersion, requireClaudeModsVersion, supportsClaudeMods } from "./claude-version.js";

describe("Claude Mods minimum version", () => {
  // CLAUDE-MODS-MIN-02: wrappers can redirect version output or fail a version-only
  // invocation while the real TUI remains usable. Preserve native hello as the authority.
  it("accepts a supported version printed on stderr", async () => {
    const run = async () => ({ code: 0, stdout: "", stderr: "2.1.322 (Claude Code)\n" });
    await expect(readClaudeVersion("fixture", {}, undefined, run)).resolves.toBe("2.1.322");
  });

  it("uses the Claude version instead of an earlier wrapper banner", async () => {
    const run = async () => ({ code: 0, stdout: "Wrapper version 1.0.0\n2.1.322 (Claude Code)\n" });
    await expect(readClaudeVersion("fixture", {}, undefined, run)).resolves.toBe("2.1.322");
  });

  it("keeps a version-probe failure advisory while rejecting a confirmed old version", async () => {
    const unreadable = async () => ({ code: 1, stdout: "" });
    await expect(readClaudeVersion("fixture", {}, undefined, unreadable)).rejects.toThrow("无法读取");
    await expect(requireClaudeModsVersion("fixture", {}, undefined, unreadable)).resolves.toBeUndefined();
    await expect(requireClaudeModsVersion("fixture", {}, undefined, async () => ({ code: 0, stdout: "2.1.286 (Claude Code)" })))
      .rejects.toThrow("最低 2.1.287");
  });

  // CLAUDE-MODS-MIN-01: terminal support starts at the stable release, not a
  // prerelease or a numerically larger string in an unrelated CLI diagnostic.
  it.each([
    ["2.1.286", false], ["2.1.287-rc.1", false], ["2.1.287", true],
    ["v2.1.287", true], ["2.1.287+build.1", true], ["2.1.322", true],
    ["2.2.0", true], ["dev-build-999", false],
  ])("classifies %s as supported=%s", (version, supported) => {
    expect(supportsClaudeMods(version)).toBe(supported);
  });

  // Exercise the actual child-process invocation, including paths with spaces
  // and Windows command wrappers, without touching a user's native installation.
  it("reads the selected executable again after it is upgraded", async () => {
    const root = await testDirectory(join(tmpdir(), "orbis-claude-version-"));
    const bin = join(root, "CLI tools");
    await mkdir(bin);
    const cli = join(bin, process.platform === "win32" ? "claude.cmd" : "claude");
    const write = async (version: string) => writeFile(cli, process.platform === "win32"
      ? `@echo off\r\nif not "%~1"=="--version" exit /b 1\r\necho ${version} ^(Claude Code^)\r\n`
      : `#!/bin/sh\n[ "$1" = '--version' ] || exit 1\nprintf '%s\\n' '${version} (Claude Code)'\n`, { mode: 0o755 });
    await write("2.1.286");
    expect(await readClaudeVersion(cli, process.env, root)).toBe("2.1.286");
    await expect(requireClaudeModsVersion(cli, process.env, root)).rejects.toThrow("最低 2.1.287");
    await write("2.1.287");
    await expect(requireClaudeModsVersion(cli, process.env, root)).resolves.toBeUndefined();
  });

  it.each([
    { code: 1, stdout: "2.1.999 private diagnostic" },
    { code: 0, stdout: "private malformed output" },
  ])("does not treat a failed or unreadable probe as compatibility", async result => {
    const pending = readClaudeVersion("fixture", {}, undefined, async () => result);
    await expect(pending).rejects.toThrow("无法读取 Claude Code 版本");
    await expect(pending).rejects.not.toThrow("private");
  });
});
