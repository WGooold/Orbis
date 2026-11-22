/**
 * CODEX-DESKTOP-RESOLVE-01 (ADR-0096): find the CLI of the Codex Desktop that launched the wrapper.
 *
 * Regression: Codex 26.1117 starts its CLI from a helper nested in the bundle, so the parent's own
 * bundle has no `codex-cli`. The previous rule (parent executable, two directories up) produced a path
 * inside the helper, fell back to PATH and exited 127. These tests use that exact layout.
 */
import { execFile } from "node:child_process";
import { chmod, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { fakeCodexBundle } from "../../../scripts/test-fixtures/codex-desktop-bundle.js";
import { testDirectory } from "../../../scripts/test-fixtures/temp-directory.js";
import { stageCodexWrapper } from "./codex-desktop-launcher.js";
import {
  appBundleOf, bundledCodexCliPaths, codexBundleContaining, codexDesktopExecutableOf, enclosingAppBundles, launcherEndpoint,
  macDesktopCliCandidates, macProcessTable, renderCodexDesktopEntryAgent, renderMacCodexLauncher, resolveMacCodexDesktopExecutable, type MacProcess,
} from "./codex-desktop-macos.js";

const posix = process.platform !== "win32";

describe("Codex Desktop bundle facts", () => {
  it("lists enclosing bundles outermost first and maps only main executables to their bundle", () => {
    const helper = "/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Versions/158/Helpers/Codex (Aperitif).app/Contents/MacOS/Codex (Aperitif)";
    expect(enclosingAppBundles(helper)).toEqual([
      "/Applications/ChatGPT.app",
      "/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Versions/158/Helpers/Codex (Aperitif).app",
    ]);
    expect(appBundleOf("/Applications/ChatGPT.app/Contents/MacOS/ChatGPT")).toBe("/Applications/ChatGPT.app");
    expect(appBundleOf("/opt/homebrew/bin/node")).toBeUndefined();
  });

  // macOS paths: these facts only exist in macOS bundles.
  it.runIf(posix)("uses the manifest entry first, then the layouts shipped before it, never outside the CLI root", async () => {
    const root = await testDirectory(join(tmpdir(), "orbis-codex-manifest-"));
    const bundle = await fakeCodexBundle(root);
    expect(bundledCodexCliPaths(bundle.app)).toEqual([bundle.entry, bundle.binary]);
    await writeFile(join(bundle.cliRoot, "codex-package.json"), JSON.stringify({ entrypoint: "next/bin/codex-next" }));
    expect(bundledCodexCliPaths(bundle.app)).toEqual([join(bundle.cliRoot, "next", "bin", "codex-next"), bundle.entry, bundle.binary]);
    for (const entrypoint of ["../../MacOS/ChatGPT", "/usr/bin/true", ""]) {
      await writeFile(join(bundle.cliRoot, "codex-package.json"), JSON.stringify({ entrypoint }));
      expect(bundledCodexCliPaths(bundle.app)).toEqual([bundle.entry, bundle.binary]);
    }
  });

  // macOS paths: these facts only exist in macOS bundles.
  it.runIf(posix)("identifies the outermost Codex bundle from a nested helper", async () => {
    const root = await testDirectory(join(tmpdir(), "orbis-codex-helper-"));
    const bundle = await fakeCodexBundle(root);
    await expect(codexBundleContaining(bundle.helperExecutable)).resolves.toBe(bundle.app);
    await expect(codexBundleContaining(join(root, "elsewhere", "Other.app", "Contents", "MacOS", "Other"))).resolves.toBeUndefined();
  });

  it("escapes the entry value in the login agent", () => {
    const plist = renderCodexDesktopEntryAgent("CODEX_CLI_PATH", "/Users/a&b/<x>/codex-launcher");
    expect(plist).toContain("<string>/Users/a&amp;b/&lt;x&gt;/codex-launcher</string>");
    expect(plist).toContain("<string>setenv</string>");
  });

  it("reads back the endpoint a generated launcher exports, including quotes", () => {
    const endpoint = "/Users/x/state dir's/codex-desktop-endpoint.json";
    expect(launcherEndpoint(renderMacCodexLauncher({ node: "/n", script: "/s", endpoint }))).toBe(endpoint);
    expect(launcherEndpoint(renderMacCodexLauncher({ node: "/n", script: "/s" }))).toBeUndefined();
  });

  // The plain ChatGPT app (com.openai.chat) also ships as ChatGPT.app: only the bundle id counts.
  it.runIf(process.platform === "darwin")("only accepts the Codex bundle identifier", async () => {
    await expect(codexDesktopExecutableOf("/System/Applications/Calculator.app")).resolves.toBeUndefined();
    await expect(resolveMacCodexDesktopExecutable(["/System/Applications/Calculator.app"])).resolves.not.toBe("/System/Applications/Calculator.app/Contents/MacOS/Calculator");
  });
});

describe.runIf(posix)("CLI of the launching Codex Desktop", () => {
  async function fixture() {
    const root = await testDirectory(join(tmpdir(), "orbis-codex-launching-"));
    const bundle = await fakeCodexBundle(root);
    for (const path of [bundle.entry, bundle.binary]) await writeFile(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    // 26.1117: wrapper (300) <- Codex (Aperitif) helper (200) <- ChatGPT (100).
    const table: MacProcess[] = [
      { pid: 100, parent: 1, executable: bundle.guiExecutable },
      { pid: 200, parent: 100, executable: bundle.helperExecutable },
      { pid: 300, parent: 200, executable: process.execPath },
    ];
    const options = { launchingPid: 300, processTable: async () => table, installedExecutable: async () => undefined };
    return { root, bundle, table, options };
  }

  it("resolves the CLI of the bundle that contains the helper", async () => {
    const f = await fixture();
    const resolved = await macDesktopCliCandidates({ PATH: "/usr/bin:/bin" }, f.options);
    expect(resolved.origin).toBe("ancestor");
    expect(resolved.app).toBe(f.bundle.app);
    expect(resolved.candidates.map(cli => cli.command)).toEqual([f.bundle.entry, f.bundle.binary]);
  });

  it("skips non-executable, recursive and out-of-bundle entries, and never substitutes a PATH CLI", async () => {
    const f = await fixture();
    const log: string[] = [];
    await chmod(f.bundle.entry, 0o644);
    expect((await macDesktopCliCandidates({}, { ...f.options, log: line => { log.push(line); } })).candidates.map(cli => cli.command)).toEqual([f.bundle.binary]);
    expect(log.join("\n")).toContain("EACCES");

    await chmod(f.bundle.entry, 0o755);
    // CODEX_CLI_PATH names the Orbis launcher; an entry that resolves to it would recurse forever.
    const launcher = join(f.root, "codex-launcher");
    await writeFile(launcher, "#!/bin/sh\n", { mode: 0o755 });
    await writeFile(join(f.bundle.cliRoot, "codex-package.json"), JSON.stringify({ entrypoint: "bin/linked" }));
    await symlink(launcher, join(f.bundle.cliRoot, "bin", "linked"));
    expect((await macDesktopCliCandidates({ CODEX_CLI_PATH: launcher }, f.options)).candidates.map(cli => cli.command)).toEqual([f.bundle.entry, f.bundle.binary]);
    // A manifest entry that leaves the bundle is not the Desktop's CLI.
    const outside = join(f.root, "outside-codex");
    await writeFile(outside, "#!/bin/sh\n", { mode: 0o755 });
    await writeFile(join(f.bundle.cliRoot, "codex-package.json"), JSON.stringify({ entrypoint: "bin/outside" }));
    await symlink(outside, join(f.bundle.cliRoot, "bin", "outside"));
    expect((await macDesktopCliCandidates({}, f.options)).candidates.map(cli => cli.command)).toEqual([f.bundle.entry, f.bundle.binary]);

    // A codex on PATH is never a substitute for the Desktop's own CLI.
    await writeFile(join(f.root, "codex"), "#!/bin/sh\n", { mode: 0o755 });
    const none = await macDesktopCliCandidates({ PATH: `${f.root}:/usr/bin:/bin` }, { ...f.options, processTable: async () => [], installedExecutable: async () => undefined });
    expect(none).toEqual({ candidates: [], origin: "none" });
  });

  it("marks only an ancestor as the Desktop; an explicit override is honoured without one", async () => {
    const f = await fixture();
    const unrelated = [{ pid: 300, parent: 1, executable: "/Applications/Other.app/Contents/MacOS/Other" }, { pid: 100, parent: 1, executable: f.bundle.guiExecutable }];
    const running = await macDesktopCliCandidates({}, { ...f.options, processTable: async () => unrelated });
    expect(running.origin).toBe("running");
    expect(running.candidates.map(cli => cli.command)).toEqual([f.bundle.entry, f.bundle.binary]);
    const installed = await macDesktopCliCandidates({}, { ...f.options, processTable: async () => [], installedExecutable: async () => f.bundle.guiExecutable });
    expect(installed.origin).toBe("installed");
    const explicit = join(f.root, "explicit-codex");
    await writeFile(explicit, "#!/bin/sh\n", { mode: 0o755 });
    const overridden = await macDesktopCliCandidates({ ORBIS_CODEX_REAL: explicit }, { ...f.options, processTable: async () => unrelated });
    expect(overridden.origin).toBe("explicit");
    expect(overridden.candidates[0]?.command).toBe(explicit);
    expect((await macDesktopCliCandidates({ ORBIS_CODEX_REAL: explicit }, f.options)).origin).toBe("ancestor");
  });
});

// The same layout as a real process tree: GUI -> helper -> wrapper process.
describe.runIf(process.platform === "darwin")("26.1117 process tree", () => {
  const run = promisify(execFile);

  it("resolves the launching bundle from a real helper ancestry", async () => {
    const root = await testDirectory(join(tmpdir(), "orbis-codex-tree-"));
    const bundle = await fakeCodexBundle(root);
    for (const path of [bundle.entry, bundle.binary]) await writeFile(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    if (!await bundle.compileForwarders()) return;
    // Its own process group, so cleanup also ends the helper and sleep it started.
    const child = bundle.runThroughDesktop("/bin/sleep", ["30"], { stdio: "ignore", detached: true });
    try {
      let sleeper: MacProcess | undefined;
      for (let attempt = 0; attempt < 50 && sleeper === undefined; attempt++) {
        const table = await macProcessTable();
        const helper = table.find(row => row.parent === child.pid);
        sleeper = helper && table.find(row => row.parent === helper.pid && row.executable === "/bin/sleep");
        if (sleeper === undefined) await new Promise(resolve => setTimeout(resolve, 100));
      }
      expect(sleeper).toBeDefined();
      const resolved = await macDesktopCliCandidates({}, { launchingPid: sleeper!.pid, installedExecutable: async () => undefined });
      expect(resolved.origin).toBe("ancestor");
      expect(realpathSync(resolved.app!)).toBe(realpathSync(bundle.app));
      expect(resolved.candidates[0]?.command).toBe(bundle.entry);
    } finally { process.kill(-child.pid!, "SIGKILL"); }
  });

  it("runs the bundle's manifest CLI from the launcher when the Orbis runtime is gone", async () => {
    const root = await testDirectory(join(tmpdir(), "orbis-codex-launcher-tree-"));
    const bundle = await fakeCodexBundle(root);
    await writeFile(bundle.entry, '#!/bin/sh\necho "manifest-entry $*"\n', { mode: 0o755 });
    await writeFile(bundle.binary, '#!/bin/sh\necho "binary $*"\n', { mode: 0o755 });
    if (!await bundle.compileForwarders()) return;
    const staged = stageCodexWrapper({ launcher: "", node: join(root, "missing-node"), script: join(root, "missing.js") }, join(root, "wrapper"), undefined, "darwin");
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", HOME: root };
    const { stdout, stderr } = await run(bundle.guiExecutable, [bundle.helperExecutable, staged.launcher, "app-server", "--analytics-default-enabled"], { env });
    expect(stdout).toBe("manifest-entry app-server --analytics-default-enabled\n");
    expect(stderr).toContain("Orbis runtime unavailable");
    // Without the manifest, the earlier layout is used.
    await writeFile(join(bundle.cliRoot, "codex-package.json"), "{");
    await chmod(bundle.entry, 0o644);
    await expect(run(bundle.guiExecutable, [bundle.helperExecutable, staged.launcher, "--version"], { env })).resolves.toMatchObject({ stdout: "binary --version\n" });
  });
});
