import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { claudeLaunchConfig, claudeWorkspaceTrustRoot, trustClaudeWorkspace } from "./claude-workspace-trust.js";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "orbis-claude-trust-")));
  roots.push(root);
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  return { root, cwd, configFile: join(root, "config", ".claude.json") };
}
async function git(cwd: string, ...args: string[]) {
  return exec("git", args, { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" } });
}

describe("Claude workspace trust", () => {
  it("locates default and explicitly selected config files", () => {
    const home = join(tmpdir(), "orbis-test-home"), standard = join(home, ".claude"), custom = join(home, "custom");
    expect(claudeLaunchConfig(standard, {}, home)).toEqual({ file: join(home, ".claude.json") });
    expect(claudeLaunchConfig(custom, { CLAUDE_CONFIG_DIR: custom }, home))
      .toEqual({ file: join(custom, ".claude.json"), directory: custom });
    expect(claudeLaunchConfig(custom, {}, home)).toEqual({ file: join(custom, ".claude.json"), directory: custom });
    expect(claudeLaunchConfig(standard, { CLAUDE_CONFIG_DIR: custom }, home))
      .toEqual({ file: join(home, ".claude.json") });
    expect(claudeLaunchConfig(standard, { CLAUDE_CONFIG_DIR: standard }, home))
      .toEqual({ file: join(standard, ".claude.json"), directory: standard });
  });

  it("writes only the selected project's trust and preserves all other config", async () => {
    const input = await fixture();
    await mkdir(join(input.root, "config"));
    const before = { preferences: { theme: "dark" }, projects: { [input.cwd]: { mcpServers: { sample: {} }, allowedTools: [] },
      "/unrelated": { hasTrustDialogAccepted: false } } };
    await writeFile(input.configFile, JSON.stringify(before));
    expect(await trustClaudeWorkspace(input)).toBe(input.cwd);
    expect(JSON.parse(await readFile(input.configFile, "utf8"))).toEqual({ ...before, projects: { ...before.projects,
      [input.cwd]: { ...before.projects[input.cwd], hasTrustDialogAccepted: true } } });
    if (process.platform !== "win32") expect((await stat(input.configFile)).mode & 0o777).toBe(0o600);
    const modified = (await stat(input.configFile)).mtimeMs;
    await trustClaudeWorkspace(input);
    expect((await stat(input.configFile)).mtimeMs).toBe(modified);
  });

  it("creates missing config and serializes simultaneous launches without losing projects", async () => {
    const input = await fixture();
    const other = join(input.root, "other");
    await mkdir(other);
    await Promise.all([trustClaudeWorkspace(input), trustClaudeWorkspace({ ...input, cwd: other })]);
    expect(JSON.parse(await readFile(input.configFile, "utf8")).projects).toEqual({
      [input.cwd]: { hasTrustDialogAccepted: true }, [other]: { hasTrustDialogAccepted: true },
    });
  });

  it.each(["{broken", "[]", '{"projects":[]}', '{"projects":null}'])("preserves invalid configuration: %s", async contents => {
    const input = await fixture();
    await mkdir(join(input.root, "config"));
    await writeFile(input.configFile, contents);
    await expect(trustClaudeWorkspace(input)).rejects.toThrow("配置");
    expect(await readFile(input.configFile, "utf8")).toBe(contents);
  });

  it("resolves subdirectories, linked worktrees, nested repositories and inherited Git environment", async () => {
    const input = await fixture();
    await git(input.cwd, "init", "-q");
    await git(input.cwd, "-c", "user.name=Orbis Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "fixture");
    const child = join(input.cwd, "child");
    await mkdir(child);
    expect(await claudeWorkspaceTrustRoot(child)).toBe(input.cwd);
    const linked = join(input.root, "linked");
    await git(input.cwd, "worktree", "add", "--detach", linked);
    expect(await claudeWorkspaceTrustRoot(linked)).toBe(input.cwd);
    await git(child, "init", "-q");
    expect(await claudeWorkspaceTrustRoot(child, { ...process.env, GIT_DIR: join(input.cwd, ".git"), GIT_WORK_TREE: input.cwd })).toBe(child);
  });

  it("preserves a config symlink and resolves workspace symlinks", async () => {
    const input = await fixture();
    await mkdir(join(input.root, "config"));
    const target = join(input.root, "actual.json");
    await writeFile(target, "{}");
    await symlink(target, input.configFile);
    const linked = join(input.root, "alias");
    await symlink(input.cwd, linked);
    await trustClaudeWorkspace({ ...input, cwd: linked });
    expect(await realpath(input.configFile)).toBe(target);
    expect(JSON.parse(await readFile(target, "utf8")).projects[input.cwd].hasTrustDialogAccepted).toBe(true);
  });

  it("refuses overly broad roots, missing directories and unresolved Git scope", async () => {
    const input = await fixture();
    await expect(trustClaudeWorkspace({ ...input, home: input.cwd })).rejects.toThrow("具体项目目录");
    await expect(trustClaudeWorkspace({ ...input, cwd: "/" })).rejects.toThrow("具体项目目录");
    await expect(trustClaudeWorkspace({ ...input, cwd: join(input.root, "missing") })).rejects.toThrow();
    await expect(trustClaudeWorkspace({ ...input, env: { PATH: "/nonexistent" } })).rejects.toThrow("信任范围");
    await expect(readFile(input.configFile)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
