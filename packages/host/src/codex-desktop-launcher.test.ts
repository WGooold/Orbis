import { testDirectory } from "../../../scripts/test-fixtures/temp-directory.js";
/**
 * Host-side launch of Codex Desktop (ADR-0022, ADR-0096). Opening Codex never depends on Orbis: these
 * tests pin when the wrapper is registered, when Codex opens natively instead, and that cancellation
 * never opens the application afterwards.
 */
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

const activation = vi.hoisted(() => ({ launch: vi.fn(), ensureEntry: vi.fn(), readLaunchd: vi.fn(async (): Promise<string | undefined> => undefined), readEntry: vi.fn(), suspend: vi.fn(), candidates: vi.fn(), macCandidates: vi.fn(), select: vi.fn() }));
const filesystem = vi.hoisted(() => ({ chmod: vi.fn(), rename: vi.fn() }));
vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, chmodSync: filesystem.chmod.mockImplementation(actual.chmodSync), renameSync: filesystem.rename.mockImplementation(actual.renameSync) };
});
vi.mock("./codex-desktop-app.js", () => ({ launchCodexDesktopApp: activation.launch }));
vi.mock("./codex-desktop-macos.js", async original => ({ ...await original<typeof import("./codex-desktop-macos.js")>(),
  readLaunchdEnvironment: activation.readLaunchd, macDesktopCliCandidates: activation.macCandidates }));
vi.mock("./codex-shim-install.js", async original => ({ ...await original<typeof import("./codex-shim-install.js")>(),
  ensureCodexDesktopEntry: activation.ensureEntry, readWindowsCodexDesktopEntry: activation.readEntry, suspendCodexDesktopEntry: activation.suspend }));
vi.mock("./codex-desktop-cli.js", () => ({ windowsDesktopCliCandidates: activation.candidates }));
vi.mock("./codex-desktop-startup.js", async original => ({ ...await original<typeof import("./codex-desktop-startup.js")>(), selectStartupCli: activation.select }));

import { codexWrapperRoot, launchCodexDesktop, repairWindowsCodexDesktopEntry, resolveCodexWrapper, stageCodexWrapper } from "./codex-desktop-launcher.js";
import { readDesktopRecoveryStatus, recordDesktopUnattached, recoverNativeDesktop } from "./codex-desktop-recovery.js";

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

function asPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: platform });
  return run().finally(() => Object.defineProperty(process, "platform", descriptor));
}

// The staged runtime must live outside the Host install: Windows locks launcher and node for the
// whole Desktop session, so a Host update could not replace them.
describe("staged Codex wrapper runtime on Windows", () => {
  async function source() {
    const dir = await testDirectory(join(tmpdir(), "orbis-wrapper-source-"));
    await mkdir(join(dir, "bin"), { recursive: true });
    await mkdir(join(dir, "node"), { recursive: true });
    await writeFile(join(dir, "bin", "codex-launcher.exe"), "launcher-bytes");
    await writeFile(join(dir, "node", "node.exe"), "node-bytes", { mode: 0o755 });
    await writeFile(join(dir, "wrapper.js"), "wrapper-script");
    return { launcher: join(dir, "bin", "codex-launcher.exe"), node: join(dir, "node", "node.exe"), script: join(dir, "wrapper.js") };
  }

  it("keeps native startup during recovery if no matching CLI passes preflight", async () => {
    const wrapper = await source();
    const root = await testDirectory(join(tmpdir(), "orbis-wrapper-recovery-"));
    const endpoint = join(root, "state", "endpoint.json");
    activation.suspend.mockResolvedValue(undefined);
    await recoverNativeDesktop(endpoint, "EPERM");
    activation.candidates.mockResolvedValue([]);
    activation.select.mockRejectedValue(new Error("no matching CLI"));
    activation.launch.mockResolvedValue(undefined);
    vi.stubEnv("CODEX_CLI_PATH", "C:\\Local\\Orbis\\wrapper\\bin\\codex-launcher.exe");
    await asPlatform("win32", () => launchCodexDesktop(wrapper, endpoint, { root }));
    expect(activation.ensureEntry).not.toHaveBeenCalled();
    expect(activation.launch).toHaveBeenCalledOnce();
    expect(activation.launch.mock.calls[0]?.[0].CODEX_CLI_PATH).toBeUndefined();
    expect(readDesktopRecoveryStatus(endpoint)?.reason).toContain("已暂停");
    expect(activation.candidates.mock.calls[0]?.[1].parentPid).toBe(0);
  });

  it("only re-enables wrapping after preflight and retains reopen guidance until bridge readiness", async () => {
    const wrapper = await source();
    const root = await testDirectory(join(tmpdir(), "orbis-wrapper-retry-"));
    const endpoint = join(root, "state", "endpoint.json");
    await recoverNativeDesktop(endpoint, "EPERM");
    activation.candidates.mockResolvedValue([]);
    activation.select.mockResolvedValue({ cli: { command: "current.exe" } });
    activation.ensureEntry.mockResolvedValue({ state: "enabled" });
    activation.launch.mockResolvedValue(undefined);
    await asPlatform("win32", () => launchCodexDesktop(wrapper, endpoint, { root }));
    expect(activation.select.mock.invocationCallOrder[0]).toBeLessThan(activation.ensureEntry.mock.invocationCallOrder[0]!);
    expect(readDesktopRecoveryStatus(endpoint, true)).toBeUndefined();
    expect(readDesktopRecoveryStatus(endpoint)?.reason).toContain("已通过启动检查");
  });

  // HOST-DESKTOP-CANCEL-01: stopping the Host during any recovery step must never open the GUI.
  it.each(["discovery", "preflight", "failed-preflight", "native-recovery"])("cancels recovery during %s before opening the application", async phase => {
    const wrapper = await source();
    const root = await testDirectory(join(tmpdir(), "orbis-wrapper-recovery-cancel-"));
    const endpoint = join(root, "state", "endpoint.json");
    const abort = new AbortController();
    const cancel = () => abort.abort(new Error("cancelled recovery launch"));
    activation.suspend.mockReset().mockResolvedValue(undefined);
    await recoverNativeDesktop(endpoint, "EPERM");
    activation.suspend.mockClear();
    activation.candidates.mockReset().mockImplementation(async () => {
      if (phase === "discovery") cancel();
      return [];
    });
    activation.select.mockReset().mockImplementation(async () => {
      if (phase === "preflight" || phase === "failed-preflight") cancel();
      if (phase === "failed-preflight" || phase === "native-recovery") throw new Error("no matching CLI");
      return { cli: { command: "current.exe" } };
    });
    if (phase === "native-recovery") activation.suspend.mockImplementationOnce(async () => { cancel(); });
    await expect(asPlatform("win32", () => launchCodexDesktop(wrapper, endpoint, { root, signal: abort.signal })))
      .rejects.toThrow("cancelled recovery launch");
    expect(activation.ensureEntry).not.toHaveBeenCalled();
    expect(activation.launch).not.toHaveBeenCalled();
    if (phase !== "native-recovery") expect(activation.suspend).not.toHaveBeenCalled();
  });

  it("opens Codex as the Start menu would when the user entry belongs to someone else, and says so", async () => {
    const wrapper = await source();
    const root = await testDirectory(join(tmpdir(), "orbis-wrapper-foreign-"));
    const endpoint = join(root, "endpoint.json");
    activation.ensureEntry.mockResolvedValue({ state: "foreign", detail: "CODEX_CLI_PATH 已被其他程序占用（C:\\custom\\codex.exe）" });
    activation.launch.mockResolvedValue(undefined);
    vi.stubEnv("CODEX_CLI_PATH", "C:\\custom\\codex.exe");
    // A Host launched from a managed Codex session can inherit this wrapper setting.
    vi.stubEnv("ORBIS_CODEX_DESKTOP_ENDPOINT", join(root, "inherited-endpoint.json"));
    await asPlatform("win32", () => launchCodexDesktop(wrapper, endpoint, { root }));
    expect(activation.launch).toHaveBeenCalledOnce();
    expect(activation.launch.mock.calls[0]?.[0].CODEX_CLI_PATH).toBe("C:\\custom\\codex.exe");
    expect(activation.launch.mock.calls[0]?.[0].ORBIS_CODEX_DESKTOP_ENDPOINT).toBeUndefined();
    expect(readDesktopRecoveryStatus(endpoint)).toMatchObject({ state: "closed", reason: expect.stringContaining("C:\\custom\\codex.exe") });
    // A Host without its wrapper still opens Codex and records why it is not attached.
    await asPlatform("win32", () => launchCodexDesktop(undefined, endpoint, { root }));
    expect(readDesktopRecoveryStatus(endpoint)?.reason).toContain("缺少 Codex 包装器");
  });

  it("stages only the two files the desktop app locks, and only copies what changed", async () => {
    const wrapper = await source();
    const root = await testDirectory(join(tmpdir(), "orbis-wrapper-staged-"));
    const staged = stageCodexWrapper(wrapper, root, undefined, "win32");
    // Fixed layout: the launcher finds node and the script relative to itself.
    expect(staged.launcher).toBe(join(root, "bin", "codex-launcher.exe"));
    expect(staged.node).toBe(join(root, "node", "node.exe"));
    expect(staged.script).toBe(join(root, "packages", "host", "dist", "codex-desktop-wrapper.js"));
    await expect(readFile(staged.node, "utf8")).resolves.toBe("node-bytes");
    const stub = await readFile(staged.script, "utf8");
    expect(stub).toContain("void import(");
    expect(stub).toContain("wrapper.js");
    expect(stub).toContain("main(process.argv.slice(2))");
    // node.exe is 80 MB+: unchanged sources are not copied again.
    const beforeLauncher = (await stat(staged.launcher)).mtimeMs;
    const beforeStub = (await stat(staged.script)).mtimeMs;
    stageCodexWrapper(wrapper, root, undefined, "win32");
    expect((await stat(staged.launcher)).mtimeMs).toBe(beforeLauncher);
    expect((await stat(staged.script)).mtimeMs).toBe(beforeStub);
    await writeFile(wrapper.script, "wrapper-script-v2");
    stageCodexWrapper(wrapper, root, undefined, "win32");
    expect((await stat(staged.script)).mtimeMs).not.toBe(beforeStub);
    expect(codexWrapperRoot({ LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" }, "win32")).toBe(join("C:\\Users\\x\\AppData\\Local", "Orbis", "wrapper"));
    expect(codexWrapperRoot({ ORBIS_CODEX_WRAPPER_ROOT: root })).toBe(root);
  });

  // A stub that points at itself recurses until the wrapper dies, and Codex falls back to an in-memory server.
  it("is idempotent when handed an already staged wrapper", async () => {
    const wrapper = await source();
    const root = await testDirectory(join(tmpdir(), "orbis-wrapper-idempotent-"));
    const staged = stageCodexWrapper(wrapper, root, undefined, "win32");
    expect(stageCodexWrapper(staged, root, undefined, "win32")).toEqual(staged);
    const stub = await readFile(staged.script, "utf8");
    expect(stub).not.toContain(staged.script.replaceAll("\\", "/"));
    expect(stub).not.toContain(staged.script.replaceAll("/", "\\"));
  });

  // CODEX-DESKTOP-BOOTSTRAP-01: the Start-menu launcher runs the staged .js outside the ESM package.
  it("loads the Windows staged entry without a package manifest or Node syntax detection", async () => {
    const wrapper = await source();
    const root = await testDirectory(join(tmpdir(), "orbis-wrapper-shell-"));
    const endpointPath = join(root, "状态目录's", "codex-desktop-endpoint.json");
    await writeFile(join(dirname(wrapper.script), "package.json"), '{"type":"module"}');
    await writeFile(wrapper.script, "export function main(args) { console.log(JSON.stringify({ args, endpoint: process.env.ORBIS_CODEX_DESKTOP_ENDPOINT })); }");
    const staged = stageCodexWrapper(wrapper, root, endpointPath, "win32");
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: "--no-experimental-detect-module" };
    delete env.ORBIS_CODEX_DESKTOP_ENDPOINT;
    const run = promisify(execFile);
    const args = ["app-server", "--print-startup-config", "--startup-client-info", '{"name":"codex_desktop","title":"Codex Desktop"}'];
    const output = (endpoint: string) => JSON.stringify({ args, endpoint }) + "\n";
    await expect(run(process.execPath, [staged.script, ...args], { env })).resolves.toMatchObject({ stdout: output(endpointPath), stderr: "" });
    await expect(run(process.execPath, [staged.script, ...args], { env: { ...env, ORBIS_CODEX_DESKTOP_ENDPOINT: "explicit-endpoint" } })).resolves.toMatchObject({ stdout: output("explicit-endpoint") });
    const changed = join(root, "next-state", "codex-desktop-endpoint.json");
    stageCodexWrapper(wrapper, root, changed, "win32");
    await expect(run(process.execPath, [staged.script, ...args], { env })).resolves.toMatchObject({ stdout: output(changed) });
  });

  it("repairs a registered legacy Windows bootstrap on upgrade without changing its endpoint or registry entry", async () => {
    const wrapper = await source();
    const root = await testDirectory(join(tmpdir(), "orbis-wrapper-upgrade-"));
    const endpoint = join(root, "state directory's", "endpoint.json");
    const staged = stageCodexWrapper(wrapper, root, endpoint, "win32");
    await writeFile(staged.script, [
      'import { main } from "file:///previous-install/codex-desktop-wrapper.js";',
      `process.env.ORBIS_CODEX_DESKTOP_ENDPOINT ??= ${JSON.stringify(endpoint)};`,
      "await main(process.argv.slice(2));",
    ].join("\n"));
    activation.readEntry.mockResolvedValue(staged.launcher);
    await repairWindowsCodexDesktopEntry(wrapper, root);
    expect(await readFile(staged.script, "utf8")).toContain(`void import(${JSON.stringify(pathToFileURL(wrapper.script).href)})`);
    expect(await readFile(staged.script, "utf8")).toContain(`ORBIS_CODEX_DESKTOP_ENDPOINT ??= ${JSON.stringify(endpoint)};`);
    expect(activation.ensureEntry).not.toHaveBeenCalled();
    expect(activation.suspend).not.toHaveBeenCalled();
  });

  it.each([undefined, "C:\\custom\\codex.exe"])("does not enable or replace the user override during install: %s", async current => {
    const wrapper = await source();
    const root = await testDirectory(join(tmpdir(), "orbis-wrapper-not-registered-"));
    activation.readEntry.mockResolvedValue(current);
    await repairWindowsCodexDesktopEntry(wrapper, root);
    expect(existsSync(join(root, "bin"))).toBe(false);
    expect(activation.ensureEntry).not.toHaveBeenCalled();
    expect(activation.suspend).not.toHaveBeenCalled();
  });

  it("suspends exactly the registered wrapper if the installer cannot replace a broken stub", async () => {
    const wrapper = await source();
    const root = await testDirectory(join(tmpdir(), "orbis-wrapper-upgrade-denied-"));
    const staged = stageCodexWrapper(wrapper, root, undefined, "win32");
    await writeFile(staged.script, "broken legacy stub");
    activation.readEntry.mockResolvedValue(staged.launcher);
    activation.suspend.mockResolvedValue(undefined);
    filesystem.rename.mockImplementationOnce(() => { throw new Error("cannot replace bootstrap"); });
    await expect(repairWindowsCodexDesktopEntry(wrapper, root)).rejects.toThrow("cannot replace bootstrap");
    expect(activation.suspend).toHaveBeenCalledWith(staged.launcher);
    expect(activation.ensureEntry).not.toHaveBeenCalled();
    await expect(readFile(staged.script, "utf8")).resolves.toBe("broken legacy stub");
  });

  it("opens native Desktop rather than enabling an incomplete Windows bootstrap", async () => {
    const wrapper = await source();
    const root = await testDirectory(join(tmpdir(), "orbis-wrapper-stage-denied-"));
    const endpoint = join(root, "state", "endpoint.json");
    const launcher = join(root, "bin", "codex-launcher.exe");
    vi.stubEnv("CODEX_CLI_PATH", launcher);
    activation.suspend.mockReset().mockResolvedValue(undefined);
    activation.launch.mockReset().mockResolvedValue(undefined);
    filesystem.rename.mockImplementationOnce(() => { throw new Error("cannot publish bootstrap"); });
    await asPlatform("win32", () => launchCodexDesktop(wrapper, endpoint, { root }));
    expect(activation.ensureEntry).not.toHaveBeenCalled();
    expect(activation.suspend).toHaveBeenCalledExactlyOnceWith(launcher);
    expect(activation.launch.mock.calls[0]?.[0].CODEX_CLI_PATH).toBeUndefined();
    expect(readDesktopRecoveryStatus(endpoint)?.reason).toContain("未能准备好 Codex 包装器");
  });

  it("registers the user entry before activating, and retries a failed wrapped activation natively", async () => {
    const wrapper = await source();
    const root = await testDirectory(join(tmpdir(), "orbis-wrapper-activate-"));
    const endpointPath = join(root, "state", "codex-desktop-endpoint.json");
    // CODEX-DESKTOP-WIN-ENTRY-01: users retry after v0.1.25 recorded the native-open rejection.
    recordDesktopUnattached(endpointPath, "Previous launch treated the Store CLI as foreign");
    let enabled!: () => void;
    activation.ensureEntry.mockReset().mockImplementation(() => new Promise(resolve => { enabled = () => resolve({ state: "enabled" }); }));
    activation.launch.mockReset().mockResolvedValue(undefined);
    const opened = asPlatform("win32", () => launchCodexDesktop(wrapper, endpointPath, { root }));
    await vi.waitFor(() => expect(activation.ensureEntry).toHaveBeenCalled());
    expect(activation.launch).not.toHaveBeenCalled();
    enabled();
    await opened;
    expect(readDesktopRecoveryStatus(endpointPath, true)).toBeUndefined();
    const staged = stageCodexWrapper(wrapper, root, endpointPath, "win32");
    expect(activation.ensureEntry).toHaveBeenCalledWith(staged.launcher);
    expect(activation.launch).toHaveBeenCalledWith(expect.objectContaining({
      CODEX_CLI_PATH: staged.launcher, ORBIS_CODEX_WRAPPER_SCRIPT: staged.script, ORBIS_CODEX_DESKTOP_ENDPOINT: endpointPath,
    }), undefined);
    activation.launch.mockClear().mockRejectedValueOnce(new Error("activation failed")).mockResolvedValueOnce(undefined);
    activation.ensureEntry.mockResolvedValue({ state: "enabled" });
    await asPlatform("win32", () => launchCodexDesktop(wrapper, endpointPath, { root }));
    expect(activation.launch).toHaveBeenCalledTimes(2);
    expect(activation.launch.mock.calls[1]?.[0].ORBIS_CODEX_DESKTOP_ENDPOINT).toBeUndefined();
  });

  // HOST-DESKTOP-CANCEL-01: stop can arrive while the entry is being registered.
  it("cancels wrapper activation before opening the application", async () => {
    const wrapper = await source();
    const root = await testDirectory(join(tmpdir(), "orbis-wrapper-cancel-"));
    const abort = new AbortController();
    let enabled!: () => void;
    activation.ensureEntry.mockReset().mockImplementation(() => new Promise(resolve => { enabled = () => resolve({ state: "enabled" }); }));
    activation.launch.mockReset().mockResolvedValue(undefined);
    const result = asPlatform("win32", () => launchCodexDesktop(wrapper, join(root, "endpoint.json"), { root, signal: abort.signal })).catch((error: unknown) => error);
    await vi.waitFor(() => expect(activation.ensureEntry).toHaveBeenCalled());
    abort.abort(new Error("cancelled wrapper launch"));
    enabled();
    expect(await result).toEqual(abort.signal.reason);
    expect(activation.launch).not.toHaveBeenCalled();
  });
});

// macOS generates one launcher; Codex executes it through CODEX_CLI_PATH.
describe("Codex Desktop launch on macOS", () => {
  const run = promisify(execFile);
  // Never let this machine's own Codex or Orbis overrides leak into a fixture.
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: "/usr/bin:/bin" };
  for (const key of ["NODE_OPTIONS", "CODEX_CLI_PATH", "ORBIS_CODEX_WRAPPER_NODE", "ORBIS_CODEX_WRAPPER_SCRIPT", "ORBIS_CODEX_DESKTOP_ENDPOINT", "ORBIS_CODEX_REAL"]) delete env[key];

  it("generates a launcher that runs the installed wrapper directly with the Host endpoint", async () => {
    const dir = await testDirectory(join(tmpdir(), "orbis wrapper's source-"));
    const script = join(dir, "codex-desktop-wrapper.js");
    await writeFile(join(dir, "package.json"), '{"type":"module"}');
    await writeFile(script, "console.log(JSON.stringify({ argv: process.argv.slice(2), endpoint: process.env.ORBIS_CODEX_DESKTOP_ENDPOINT }));");
    const root = await testDirectory(join(tmpdir(), "orbis wrapper's root-"));
    // The forwarding stub of earlier launchers is removed once nothing references it.
    const legacyStub = join(root, "packages", "host", "dist", "codex-desktop-wrapper.js");
    await mkdir(dirname(legacyStub), { recursive: true });
    await writeFile(legacyStub, "legacy");
    const endpoint = join(root, "state dir's", "codex-desktop-endpoint.json");
    const staged = stageCodexWrapper({ launcher: "", node: process.execPath, script }, root, endpoint, "darwin");
    expect(staged).toEqual({ launcher: join(root, "bin", "codex-launcher"), node: process.execPath, script });
    expect(existsSync(legacyStub)).toBe(false);
    expect(filesystem.chmod).toHaveBeenCalledWith(staged.launcher, 0o755);
    const before = (await stat(staged.launcher)).mtimeMs;
    // Re-staging without an endpoint keeps the one already registered (custom state directories).
    stageCodexWrapper({ launcher: "", node: process.execPath, script }, root, undefined, "darwin");
    expect((await stat(staged.launcher)).mtimeMs).toBe(before);
    if (process.platform === "win32") return;
    const argv = ["app-server", "--analytics-default-enabled", "it's"];
    await expect(run(staged.launcher, argv, { env })).resolves.toMatchObject({ stdout: `${JSON.stringify({ argv, endpoint })}\n` });
    await expect(run(staged.launcher, argv, { env: { ...env, ORBIS_CODEX_DESKTOP_ENDPOINT: "explicit" } })).resolves
      .toMatchObject({ stdout: `${JSON.stringify({ argv, endpoint: "explicit" })}\n` });
  });

  it.runIf(process.platform !== "win32")("runs an explicit CLI when the Orbis runtime is gone, without replaying its status", async () => {
    const dir = await testDirectory(join(tmpdir(), "orbis-wrapper-fallback-"));
    const real = join(dir, "codex");
    await writeFile(real, '#!/bin/sh\necho real "$@"\nexit 42\n', { mode: 0o755 });
    const staged = stageCodexWrapper({ launcher: "", node: join(dir, "missing-node"), script: join(dir, "missing.js") }, join(dir, "wrapper"), undefined, "darwin");
    await expect(run(staged.launcher, ["--version"], { env: { ...env, ORBIS_CODEX_REAL: real } })).rejects.toMatchObject({ code: 42, stdout: "real --version\n" });
    const native = await run(staged.launcher, ["--version"], { env }).then(
      result => ({ code: 0, ...result }),
      error => ({ code: (error as NodeJS.ErrnoException).code, stdout: String((error as { stdout?: unknown }).stdout ?? ""), stderr: String((error as { stderr?: unknown }).stderr ?? "") }),
    );
    expect(native.stdout).not.toBe("real --version\n");
    expect(native.code === 127 || native.stdout.length > 0).toBe(true);
  });

  // A file can pass -x and still fail exec (a missing interpreter). Fall back only when exec itself failed.
  it.runIf(process.platform !== "win32")("uses the native CLI when the executable Node entry cannot exec", async () => {
    const root = await testDirectory(join(tmpdir(), "orbis-mac-exec-fallback-"));
    const node = join(root, "node"), script = join(root, "wrapper.js"), real = join(root, "codex");
    await writeFile(node, "#!/nonexistent-orbis-test-interpreter\n", { mode: 0o755 });
    await writeFile(script, "");
    await writeFile(real, '#!/bin/sh\nprintf "%s\\n" "$@"\nexit 42\n', { mode: 0o755 });
    const staged = stageCodexWrapper({ launcher: "", node, script }, join(root, "wrapper"), undefined, "darwin");
    await expect(run(staged.launcher, ["--version"], { env: { ...env, ORBIS_CODEX_REAL: real } }))
      .rejects.toMatchObject({ code: 42, stdout: "--version\n", stderr: expect.stringContaining("nonexistent-orbis-test-interpreter") });
  });

  async function macWrapper(root: string) {
    const script = join(root, "codex-desktop-wrapper.js");
    await writeFile(script, "");
    return { launcher: "", node: process.execPath, script };
  }

  it.runIf(process.platform !== "win32")("registers the launcher before opening Codex with the Host endpoint", async () => {
    const root = await testDirectory(join(tmpdir(), "orbis-mac-launch-"));
    const wrapper = await macWrapper(root), endpoint = join(root, "state", "endpoint.json"), wrapperRoot = join(root, "wrapper");
    activation.ensureEntry.mockResolvedValue({ state: "enabled" });
    activation.launch.mockResolvedValue(undefined);
    await asPlatform("darwin", () => launchCodexDesktop(wrapper, endpoint, { root: wrapperRoot }));
    const launcher = join(wrapperRoot, "bin", "codex-launcher");
    expect(activation.ensureEntry).toHaveBeenCalledWith(launcher);
    expect(activation.ensureEntry.mock.invocationCallOrder[0]).toBeLessThan(activation.launch.mock.invocationCallOrder[0]!);
    expect(activation.launch.mock.calls[0]?.[0]).toMatchObject({ CODEX_CLI_PATH: launcher, ORBIS_CODEX_DESKTOP_ENDPOINT: endpoint });
    expect(readDesktopRecoveryStatus(endpoint)).toBeUndefined();
  });

  // CODEX-DESKTOP-MAC-RECOVERY-01: open the installed application without registering a broken entry.
  it("neutralizes a stale Orbis override for the native GUI launch, not a foreign one", async () => {
    const dir = await testDirectory(join(tmpdir(), "orbis-mac-native-launch-"));
    const endpoint = join(dir, "endpoint.json");
    const ours = join(dir, "Orbis", "wrapper", "bin", "codex-launcher");
    const foreign = join(dir, "someone-else", "codex");
    activation.launch.mockReset().mockResolvedValue(undefined);
    activation.readLaunchd.mockResolvedValueOnce(ours).mockResolvedValueOnce(foreign);
    vi.stubEnv("CODEX_CLI_PATH", ours);
    await asPlatform("darwin", () => launchCodexDesktop(undefined, endpoint, { root: dir }));
    expect(activation.launch.mock.calls[0]?.[0].CODEX_CLI_PATH).toBe("");
    expect(activation.ensureEntry).not.toHaveBeenCalled();
    expect(process.env.CODEX_CLI_PATH).toBe(ours);
    expect(readDesktopRecoveryStatus(endpoint)).toMatchObject({ state: "closed", reason: expect.stringContaining("原生方式") });
    expect(readDesktopRecoveryStatus(endpoint)?.reason).toContain("缺少 Codex 包装器");
    await asPlatform("darwin", () => launchCodexDesktop(undefined, endpoint, { root: dir }));
    expect(activation.launch.mock.calls[1]?.[0].CODEX_CLI_PATH).toBeUndefined();
    expect(activation.suspend).not.toHaveBeenCalled();
  });

  it.runIf(process.platform !== "win32")("records the precise reason when the entry cannot be registered", async () => {
    const root = await testDirectory(join(tmpdir(), "orbis-mac-entry-refused-"));
    const wrapper = await macWrapper(root), endpoint = join(root, "state", "endpoint.json");
    activation.ensureEntry.mockResolvedValue({ state: "foreign", detail: "CODEX_CLI_PATH 已被其他程序占用（/opt/custom/codex）" });
    activation.launch.mockResolvedValue(undefined);
    await asPlatform("darwin", () => launchCodexDesktop(wrapper, endpoint, { root: join(root, "wrapper") }));
    expect(activation.launch).toHaveBeenCalledOnce();
    expect(readDesktopRecoveryStatus(endpoint)).toMatchObject({ state: "closed", reason: expect.stringContaining("/opt/custom/codex") });
  });

  // A native launch is not a successful preflight for re-enabling the wrapper.
  it.runIf(process.platform !== "win32")("keeps native startup across retries until the installed CLI passes preflight", async () => {
    const root = await testDirectory(join(tmpdir(), "orbis-mac-wrapper-retry-"));
    const wrapper = await macWrapper(root), endpoint = join(root, "state", "endpoint.json"), wrapperRoot = join(root, "wrapper");
    activation.launch.mockReset().mockResolvedValue(undefined);
    activation.macCandidates.mockResolvedValue({ candidates: [], origin: "installed" });
    activation.select.mockReset().mockRejectedValue(new Error("no compatible CLI"));
    activation.ensureEntry.mockReset().mockResolvedValue({ state: "enabled" });
    await recoverNativeDesktop(endpoint, "failed", async () => {}, "cli", "darwin");
    for (let i = 0; i < 2; ++i) {
      await asPlatform("darwin", () => launchCodexDesktop(wrapper, endpoint, { root: wrapperRoot }));
      // The suspended record survives the native open: only a passing preflight may clear it.
      expect(readDesktopRecoveryStatus(endpoint)).toMatchObject({ state: "error", reason: expect.stringContaining("已暂停") });
    }
    expect(activation.macCandidates.mock.calls[0]?.[1]).toEqual({ launchingPid: 0 });
    expect(activation.select).toHaveBeenCalledTimes(2);
    expect(activation.ensureEntry).not.toHaveBeenCalled();
    expect(activation.launch.mock.calls.every(call => call[0].ORBIS_CODEX_DESKTOP_ENDPOINT === undefined)).toBe(true);
    activation.select.mockResolvedValueOnce({ cli: { command: "current" } });
    await asPlatform("darwin", () => launchCodexDesktop(wrapper, endpoint, { root: wrapperRoot }));
    expect(activation.ensureEntry).toHaveBeenCalledOnce();
    expect(activation.launch.mock.calls.at(-1)?.[0].ORBIS_CODEX_DESKTOP_ENDPOINT).toBe(endpoint);
    expect(readDesktopRecoveryStatus(endpoint, true)).toBeUndefined();
  });

  it("resolves the wrapper without a shipped launcher binary and ignores staged artifacts as sources", async () => {
    const root = await testDirectory(join(tmpdir(), "orbis-wrapper-resolve-"));
    const script = join(root, "wrapper.js");
    await writeFile(script, "");
    const resolved = resolveCodexWrapper({ ORBIS_CODEX_WRAPPER_ROOT: join(root, "staged"), ORBIS_CODEX_WRAPPER_SCRIPT: script }, "darwin");
    expect(resolved).toMatchObject({ launcher: join(root, "staged", "bin", "codex-launcher"), script });
    // A Host started from a Codex shell inherits the wrapper's own variables; never stage from them.
    const inherited = resolveCodexWrapper({ ORBIS_CODEX_WRAPPER_ROOT: root, ORBIS_CODEX_WRAPPER_SCRIPT: script }, "darwin");
    expect(inherited?.script).not.toBe(script);
    expect(codexWrapperRoot({}, "darwin")).toContain(join("Library", "Application Support", "Orbis", "wrapper"));
  });
});
