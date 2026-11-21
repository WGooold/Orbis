/**
 * The wrapper entry (ADR-0022, ADR-0096): which CLI runs, how often, and what happens when it cannot.
 * The macOS cases use the 26.1117 layout, where the GUI starts the CLI from a nested helper.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, copyFile, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { fakeCodexBundle } from "../../../scripts/test-fixtures/codex-desktop-bundle.js";
import { testDirectory } from "../../../scripts/test-fixtures/temp-directory.js";
import { stageCodexWrapper } from "./codex-desktop-launcher.js";
import type { MacProcess } from "./codex-desktop-macos.js";
import { desktopRecoveryPath, readDesktopRecoveryStatus, recoverNativeDesktop } from "./codex-desktop-recovery.js";
import { isAppServerInvocation, requestsCodeModeHost } from "./codex-desktop-invocation.js";
import { main } from "./codex-desktop-wrapper.js";

describe("Codex Desktop invocations", () => {
  it("bridges only a long-running app-server, not the one-shot startup queries", () => {
    expect(requestsCodeModeHost(["-c", "features.code_mode_host=true", "app-server"])).toBe(true);
    expect(requestsCodeModeHost(["app-server"])).toBe(false);
    expect(requestsCodeModeHost(["--version"])).toBe(false);
    expect(isAppServerInvocation(["app-server"])).toBe(true);
    expect(isAppServerInvocation(["app-server", "--print-startup-config", "--startup-client-info", "{}"])).toBe(false);
    expect(isAppServerInvocation(["app-server", "--startup-sign-out"])).toBe(false);
  });
});

describe.runIf(process.platform !== "win32")("wrapper on macOS", () => {
  async function fixture() {
    const root = await testDirectory(join(tmpdir(), "orbis-codex-wrapper-"));
    const bundle = await fakeCodexBundle(root);
    const endpoint = join(root, "state", "endpoint.json"), calls = join(root, "calls");
    const env = { PATH: "/usr/bin:/bin", ORBIS_CODEX_DESKTOP_ENDPOINT: endpoint, TEST_CLI_CALLS: calls };
    const ancestry: MacProcess[] = [
      { pid: 100, parent: 1, executable: bundle.guiExecutable },
      { pid: 200, parent: 100, executable: bundle.helperExecutable },
      { pid: 300, parent: 200, executable: process.execPath },
    ];
    const reap = vi.fn(async () => {});
    const options = { platform: "darwin" as const, launchingPid: 300, processTable: async () => ancestry, installedExecutable: async () => undefined, reap };
    const makeCli = (path: string, label: string, body = "exit 0", mode = 0o755) =>
      writeFile(path, `#!/bin/sh\nprintf '%s\\n' '${label}' "$@" >> "$TEST_CLI_CALLS"\n${body}\n`, { mode });
    const prior = process.exitCode;
    onTestFinished(() => { process.exitCode = prior; vi.restoreAllMocks(); });
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    return { root, bundle, endpoint, calls, env, ancestry, options, reap, makeCli };
  }
  const listenFails = (code: number) => `case "$*" in *--listen*) exit ${code} ;; esac`;

  // CODEX-DESKTOP-RESOLVE-01: the old wrapper looked for codex-cli inside the helper and exited 127.
  it("serves from the bundle containing the helper, after clearing orphaned backends", async () => {
    const f = await fixture();
    await f.makeCli(f.bundle.entry, "entry", listenFails(2));
    await f.makeCli(f.bundle.binary, "must-not-run");
    await main(["app-server"], f.env, f.options);
    // The bridge could not start; the same CLI then serves the GUI natively.
    expect(await readFile(f.calls, "utf8")).toMatch(/^entry\napp-server\n--listen\nws:\/\/127\.0\.0\.1:\d+\nentry\napp-server\n$/u);
    expect(process.exitCode).toBe(0);
    expect(f.reap).toHaveBeenCalledExactlyOnceWith(f.endpoint);
    expect(readDesktopRecoveryStatus(f.endpoint)).toMatchObject({ state: "closed", reason: expect.stringContaining("未接入 Orbis") });
  });

  // A forwarding script can spawn yet fail to exec its target (126/127 before listening).
  it("moves to the next CLI of the same bundle when one cannot exec", async () => {
    const f = await fixture();
    await f.makeCli(f.bundle.entry, "entry", listenFails(127));
    await f.makeCli(f.bundle.binary, "binary", listenFails(2));
    await main(["app-server"], f.env, f.options);
    expect((await readFile(f.calls, "utf8")).split("\n").filter(line => line === "entry" || line === "binary")).toEqual(["entry", "binary", "binary"]);
    expect(process.exitCode).toBe(0);
  });

  it("reports a native stdio failure instead of keeping the degraded but usable status", async () => {
    const f = await fixture();
    await f.makeCli(f.bundle.entry, "entry", "exit 9");
    await main(["app-server"], f.env, f.options);
    expect(process.exitCode).toBe(9);
    expect(readDesktopRecoveryStatus(f.endpoint)).toMatchObject({ state: "error", reason: expect.stringContaining("异常退出") });
  });

  // Another client honouring CODEX_CLI_PATH must not become the Desktop endpoint.
  it("passes a server start through unchanged when no Desktop is among the ancestors", async () => {
    const f = await fixture();
    await f.makeCli(f.bundle.entry, "entry");
    const unrelated = [{ pid: 300, parent: 1, executable: "/Applications/Other.app/Contents/MacOS/Other" }, f.ancestry[0]!];
    await main(["app-server"], f.env, { ...f.options, processTable: async () => unrelated });
    expect(await readFile(f.calls, "utf8")).toBe("entry\napp-server\n");
    expect(f.reap).not.toHaveBeenCalled();
    expect(readDesktopRecoveryStatus(f.endpoint)).toBeUndefined();
  });

  // Only the read-only probe may be retried; its stdout is never mixed with another candidate's.
  it("forwards the real policy error of the first CLI that speaks the startup protocol", async () => {
    const f = await fixture();
    const explicit = join(f.root, "old-entry");
    await f.makeCli(explicit, "broken-script", "echo not-json; exit 127");
    const policy = '{"error":{"code":-32000,"message":"policy denied"}}';
    await f.makeCli(f.bundle.entry, "entry", `echo '${policy}'; exit 1`);
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await main(["app-server", "--print-startup-config"], { ...f.env, ORBIS_CODEX_REAL: explicit }, f.options);
    expect(stdout).toHaveBeenCalledExactlyOnceWith(policy + "\n");
    expect(process.exitCode).toBe(1);
    expect((await readFile(f.calls, "utf8")).split("\n").filter(line => line === "--print-startup-config")).toHaveLength(2);
    expect(readDesktopRecoveryStatus(f.endpoint)).toBeUndefined();
  });

  it("never retries sign-out after the CLI started, even when it returned 127", async () => {
    const f = await fixture();
    await f.makeCli(f.bundle.entry, "entry", "exit 127");
    await f.makeCli(f.bundle.binary, "must-not-run");
    await main(["app-server", "--startup-sign-out"], f.env, f.options);
    expect(await readFile(f.calls, "utf8")).toBe("entry\napp-server\n--startup-sign-out\n");
    expect(process.exitCode).toBe(127);
    expect(readDesktopRecoveryStatus(f.endpoint)).toBeUndefined();
  });

  it("suspends the entry only when nothing can start, and says why on the last stderr line", async () => {
    const f = await fixture();
    for (const cli of [f.bundle.entry, f.bundle.binary]) await f.makeCli(cli, "must-not-run");
    for (const cli of [f.bundle.entry, f.bundle.binary]) await chmod(cli, 0o644);
    const suspend = vi.fn(async () => {});
    const recover = vi.fn<typeof recoverNativeDesktop>((path, error) => recoverNativeDesktop(path, error, suspend, "cli", "darwin"));
    const stderr = vi.mocked(process.stderr.write);
    await main(["app-server"], f.env, { ...f.options, recover });
    expect(process.exitCode).toBe(127);
    expect(suspend).toHaveBeenCalledOnce();
    const { detail } = JSON.parse(await readFile(desktopRecoveryPath(f.endpoint), "utf8")) as { detail: string };
    for (const path of [f.bundle.entry, f.bundle.binary]) expect(detail).toContain(`${path}（EACCES）`);
    expect(stderr.mock.calls.at(-1)?.[0]).toEqual(expect.stringContaining("程序坞"));
    expect(readDesktopRecoveryStatus(f.endpoint)).toMatchObject({ state: "error", reason: expect.stringContaining("程序坞") });
  });

  // An Orbis fault must not cost the user this launch: the launcher's native mode runs the Desktop's CLI.
  it("runs the Desktop's own CLI natively before suspending the entry", async () => {
    const f = await fixture();
    for (const cli of [f.bundle.entry, f.bundle.binary]) { await f.makeCli(cli, "unused"); await chmod(cli, 0o644); }
    const recover = vi.fn(async () => "suspended");
    const runNative = vi.fn(async () => 0);
    await main(["app-server"], f.env, { ...f.options, recover, runNative });
    expect(runNative).toHaveBeenCalledExactlyOnceWith(["app-server"], f.env);
    expect(process.exitCode).toBe(0);
    expect(recover).not.toHaveBeenCalled();
    expect(readDesktopRecoveryStatus(f.endpoint)).toMatchObject({ state: "closed", reason: expect.stringContaining("Codex 自带 CLI") });
    // 127 from the launcher means the bundle has no runnable CLI either: suspend as before.
    runNative.mockResolvedValueOnce(127);
    await main(["app-server"], f.env, { ...f.options, recover, runNative });
    expect(recover).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(127);
  });

  // ps itself failed: the caller may be the Desktop, so its unattached state must be explained.
  it("records why a server start was not attached when its caller could not be checked", async () => {
    const f = await fixture();
    await f.makeCli(f.bundle.entry, "entry");
    await main(["app-server"], f.env, { ...f.options, processTable: async () => { throw new Error("ps unavailable"); }, installedExecutable: async () => f.bundle.guiExecutable });
    expect(await readFile(f.calls, "utf8")).toBe("entry\napp-server\n");
    expect(readDesktopRecoveryStatus(f.endpoint)).toMatchObject({ state: "closed", reason: expect.stringContaining("ps unavailable") });
  });
});

const builtEntry = fileURLToPath(new URL("../dist/codex-desktop-wrapper.js", import.meta.url));

// A broken or half-updated install: the entry loads, its implementation does not.
describe.runIf(process.platform !== "win32" && existsSync(builtEntry))("wrapper entry without its implementation", () => {
  it("runs Codex through the launcher's native mode and explains why", async () => {
    const root = await testDirectory(join(tmpdir(), "orbis-codex-wrapper-broken-"));
    for (const file of ["codex-desktop-wrapper.js", "codex-desktop-native-fallback.js"]) await copyFile(join(dirname(builtEntry), file), join(root, file));
    await writeFile(join(root, "package.json"), '{"type":"module"}');
    const real = join(root, "codex");
    await writeFile(real, '#!/bin/sh\necho "native $*"\nexit 7\n', { mode: 0o755 });
    const launcher = stageCodexWrapper({ launcher: "", node: process.execPath, script: join(root, "codex-desktop-wrapper.js") }, join(root, "wrapper"), undefined, "darwin").launcher;
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", HOME: root, CODEX_CLI_PATH: launcher, ORBIS_CODEX_REAL: real };
    const run = promisify(execFile);
    const failure = await run(process.execPath, [join(root, "codex-desktop-wrapper.js"), "--version"], { env }).catch((error: unknown) => error) as { code: number; stdout: string; stderr: string };
    expect(failure).toMatchObject({ code: 7, stdout: "native --version\n" });
    expect(failure.stderr).toContain("Orbis 包装器无法加载");
    // Without a launcher to fall back to, Codex gets the next step on its last error line.
    const alone = await run(process.execPath, [join(root, "codex-desktop-wrapper.js"), "--version"], { env: { PATH: "/usr/bin:/bin" } }).catch((error: unknown) => error) as { code: number; stderr: string };
    expect(alone.code).toBe(127);
    expect(alone.stderr.trim().split("\n").at(-1)).toContain("重新安装 Orbis Host");
  });
});
