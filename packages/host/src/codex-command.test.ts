import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findAgentCopies } from "./agent-installation.js";
import { resolveCodexCommand } from "./codex-daemon.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "orbis-codex-command-")); roots.push(root);
  const env: NodeJS.ProcessEnv = { PATH: "", USERPROFILE: join(root, "User Profile"),
    LOCALAPPDATA: join(root, "Local AppData"), APPDATA: join(root, "Roaming") };
  return { root, env, visible: join(env.LOCALAPPDATA!, "Programs", "OpenAI", "Codex", "bin"),
    current: join(env.USERPROFILE!, ".codex", "packages", "standalone", "current") };
}
async function native(dir: string) {
  const entry = join(dir, "codex.exe");
  await mkdir(dir, { recursive: true });
  await writeFile(entry, "MZ fixture");
  return entry;
}
async function npm(dir: string) {
  const root = join(dir, "node_modules", "@openai", "codex");
  const entry = join(root, "bin", "codex.js");
  await mkdir(dirname(entry), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "@openai/codex", version: "1.2.3" }));
  await writeFile(entry, "");
  return entry;
}

describe("Windows standalone and npm Codex command discovery", () => {
  // The irm installer changes user PATH; an already-running Host still needs to find its stable entry.
  it("discovers the official install directory with a stale Host PATH and no npm package", async () => {
    const { env, visible } = await fixture(); const entry = await native(visible);
    expect(await findAgentCopies("codex", env, "win32")).toEqual([{ entry }]);
    expect(await resolveCodexCommand(env, "win32")).toEqual({ command: entry, prefixArgs: [] });
  });

  // Installer overrides and both current junction layouts must work without PATH refresh.
  it.each(["install-dir", "current-bin", "legacy-current"])("discovers the %s standalone layout", async layout => {
    const { root, env } = await fixture();
    env.CODEX_HOME = join(root, "Custom Codex Home");
    env.CODEX_INSTALL_DIR = join(root, "Custom Install");
    const current = join(env.CODEX_HOME, "packages", "standalone", "current");
    const entry = await native(layout === "install-dir" ? env.CODEX_INSTALL_DIR : layout === "current-bin" ? join(current, "bin") : current);
    expect(await resolveCodexCommand(env, "win32")).toEqual({ command: entry, prefixArgs: [] });
  });

  // Mixed installs must select the same copy as PATH, never preferring all native or all npm entries.
  it.each([true, false])("respects PATH order with native first=%s", async nativeFirst => {
    const { root, env } = await fixture();
    const nativeDir = join(root, "Native Codex"); const npmDir = join(root, "npm");
    const binary = await native(nativeDir); const script = await npm(npmDir);
    env.Path = (nativeFirst ? [nativeDir, npmDir] : [npmDir, nativeDir]).map(dir => `"${dir}"`).join(";");
    delete env.PATH;
    expect((await findAgentCopies("codex", env, "win32")).map(copy => copy.entry)).toEqual(nativeFirst ? [binary, script] : [script, binary]);
    expect(await resolveCodexCommand(env, "win32")).toEqual(nativeFirst
      ? { command: binary, prefixArgs: [] } : { command: process.execPath, prefixArgs: [script] });
  });

  // Windows resolves .exe ahead of npm's .cmd in a shared directory.
  it("prefers a native executable over an adjacent npm shim", async () => {
    const { root, env } = await fixture(); env.PATH = root;
    const binary = await native(root); const script = await npm(root);
    expect((await findAgentCopies("codex", env, "win32")).map(copy => copy.entry)).toEqual([binary, script]);
  });

  // Deduplicate installer junction aliases without pinning the selected entry to a versioned release.
  it("retains the visible installer junction when current resolves to the same executable", async () => {
    const { env, visible, current } = await fixture();
    await native(join(current, "bin"));
    await mkdir(dirname(visible), { recursive: true });
    await symlink(join(current, "bin"), visible, "junction");
    env.PATH = [visible, visible].join(";");
    expect(await findAgentCopies("codex", env, "win32")).toEqual([{ entry: join(visible, "codex.exe") }]);
  });

  // Selecting an entry survives startup without converting a native executable to a Node script.
  it.each(["native", "npm"])("honors an explicitly selected %s entry", async kind => {
    const { root, env } = await fixture();
    const entry = kind === "native" ? await native(root) : await npm(root);
    env.ORBIS_CODEX_ENTRY = entry;
    expect(await resolveCodexCommand(env, "win32")).toEqual(kind === "native"
      ? { command: entry, prefixArgs: [] } : { command: process.execPath, prefixArgs: [entry] });
  });

  // A broken first npm installation remains an error, rather than silently changing the active version.
  it("keeps a broken PATH default selected ahead of another runnable installation", async () => {
    const { root, env, visible } = await fixture(); env.PATH = root;
    const entry = await npm(root); await rm(entry); await native(visible);
    expect((await findAgentCopies("codex", env, "win32"))[0]?.entry).toBe(entry);
    await expect(resolveCodexCommand(env, "win32")).rejects.toThrow();
  });

  // Falling back from Orbis's own PATH shim must never launch that shim recursively.
  it("skips codex.cmd and reports missing standalone/npm installations", async () => {
    const { root, env } = await fixture(); env.PATH = root;
    await writeFile(join(root, "codex.cmd"), "@echo off\r\nset ORBIS_CODEX_RUNTIME=fixture\r\n");
    expect(await findAgentCopies("codex", env, "win32")).toEqual([]);
    await expect(resolveCodexCommand(env, "win32")).rejects.toThrow("未找到 Codex CLI");
  });
});
