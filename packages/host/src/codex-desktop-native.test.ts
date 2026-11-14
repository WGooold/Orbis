/**
 * Opt-in Windows regression: npm run build, then set ORBIS_NATIVE_DESKTOP_TEST=1
 * and run this file. No real Host/GUI restart, user registry write or model call.
 */
import { execFile, spawn } from "node:child_process";
import { appendFile, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { testDirectory } from "../../../scripts/test-fixtures/temp-directory.js";
import { discoverWindowsDesktop, windowsDesktopCliCandidates } from "./codex-desktop-cli.js";
import { queryDesktopStartup, selectStartupCli, startupProbeArgs } from "./codex-desktop-startup.js";
import { CodexAppServer } from "./codex-daemon.js";

const exec = promisify(execFile);
const enabled = process.platform === "win32" && process.env.ORBIS_NATIVE_DESKTOP_TEST === "1";
const wrapper = fileURLToPath(new URL("../dist/codex-desktop-wrapper.js", import.meta.url));
const recovery = fileURLToPath(new URL("../dist/codex-desktop-recovery.js", import.meta.url));

async function fixture() {
  const root = await testDirectory(join(tmpdir(), "orbis-native-desktop-"));
  const loader = join(root, "wrapper.mjs");
  const endpoint = join(root, "state", "endpoint.json");
  const home = join(root, "codex-home");
  await mkdir(home);
  // Inject only the registry operation. Exercise the real recovery file and wrapper.
  await writeFile(loader, [
    "import { main } from " + JSON.stringify(pathToFileURL(wrapper).href) + ";",
    "import { recoverNativeDesktop } from " + JSON.stringify(pathToFileURL(recovery).href) + ";",
    "await main(process.argv.slice(2), process.env, { recover: (file, error) => recoverNativeDesktop(file, error, async () => {}) });",
  ].join("\n"));
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: home, ORBIS_CODEX_DESKTOP_ENDPOINT: endpoint };
  for (const key of ["CODEX_CLI_PATH", "ORBIS_CODEX_REAL", "ORBIS_CODEX_DESKTOP_CLI", "ORBIS_CODEX_WRAPPER_NODE", "ORBIS_CODEX_WRAPPER_SCRIPT"]) delete env[key];
  return { root, loader, env, endpoint };
}
async function invoke(loader: string, args: string[], env: NodeJS.ProcessEnv) {
  try {
    const result = await exec(process.execPath, [loader, ...args], { env, windowsHide: true, timeout: 40_000, maxBuffer: 8 * 1024 * 1024 });
    return { code: 0, ...result };
  } catch (error) {
    const result = error as { code?: unknown; stdout?: string; stderr?: string };
    if (typeof result.code !== "number") throw error;
    return { code: result.code, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }
}

describe.runIf(enabled)("Windows native Desktop CLI regression", () => {
  it("survives an actual deny-execute ACL, does not replay commands and records total failure", async () => {
    expect(existsSync(wrapper), "Run npm run build before native regression").toBe(true);
    const f = await fixture();
    const packaged = join(f.root, "package", "codex.exe");
    const pinned = join(f.root, "pin", "codex.exe");
    const cached = join(f.root, "Local", "OpenAI", "Codex", "bin", "matching", "codex.exe");
    for (const path of [packaged, pinned, cached]) await mkdir(dirname(path), { recursive: true });
    const source = join(f.root, "fixture.cs");
    await writeFile(source, [
      "using System; using System.IO;",
      "class Cli { static int Main(string[] args) {",
      "if (Array.IndexOf(args, \"--print-startup-config\") >= 0) {",
      "if (Environment.GetEnvironmentVariable(\"FIXTURE_POLICY_ERROR\") == \"1\") { Console.WriteLine(\"{\\\"error\\\":{\\\"code\\\":-32000,\\\"message\\\":\\\"native policy denied\\\"}}\"); return 12; }",
      "Console.WriteLine(\"{\\\"appServerVersion\\\":\\\"fixture\\\",\\\"configRequirements\\\":{}}\"); return 0; }",
      "File.AppendAllText(Environment.GetEnvironmentVariable(\"FIXTURE_EXECUTIONS\"), \"executed\\n\"); return 2; } }",
    ].join("\n"));
    const compile = "Add-Type -Path '" + source.replaceAll("'", "''") + "' -OutputAssembly '" + packaged.replaceAll("'", "''") + "' -OutputType ConsoleApplication";
    await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", compile], { windowsHide: true });
    await copyFile(packaged, pinned);
    await copyFile(packaged, cached);
    const sid = (await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "[Security.Principal.WindowsIdentity]::GetCurrent().User.Value"], { windowsHide: true })).stdout.trim();
    expect(sid).toMatch(/^S-1-/u);
    const env = { ...f.env, LOCALAPPDATA: join(f.root, "Local"), ORBIS_CODEX_DESKTOP_CLI: packaged, ORBIS_CODEX_REAL: pinned, FIXTURE_EXECUTIONS: join(f.root, "executions.txt") };
    try {
      await exec("icacls.exe", [pinned, "/deny", "*" + sid + ":(X)"], { windowsHide: true });
      const denied = await invoke(f.loader, startupProbeArgs([]), env);
      expect(denied.code).toBe(0);
      expect(JSON.parse(denied.stdout).appServerVersion).toBe("fixture");
      expect(denied.stderr).toMatch(/EPERM|EACCES/u);
      expect(denied.stderr).toContain("source=desktop-cache");
      const policy = await invoke(f.loader, startupProbeArgs([]), { ...env, FIXTURE_POLICY_ERROR: "1" });
      expect(policy.code).toBe(12);
      expect(JSON.parse(policy.stdout).error.message).toBe("native policy denied");
      expect(existsSync(join(dirname(f.endpoint), "codex-desktop-recovery.json"))).toBe(false);
      const command = await invoke(f.loader, ["login"], env);
      expect(command.code).toBe(2);
      expect(await readFile(env.FIXTURE_EXECUTIONS, "utf8")).toBe("executed\n");
      // No automatic replay after an already-started command's nonzero exit.
      await exec("icacls.exe", [pinned, "/remove:d", "*" + sid], { windowsHide: true });
      // A valid PE with an old identity can still answer the protocol, but must not stay pinned.
      await appendFile(pinned, "old-version-identity");
      expect(JSON.parse((await exec(pinned, startupProbeArgs([]), { env })).stdout).appServerVersion).toBe("fixture");
      const stale = await invoke(f.loader, startupProbeArgs([]), env);
      expect(stale.code).toBe(0);
      expect(stale.stderr).toContain("ORBIS_CODEX_REAL 已失效或与当前桌面安装不匹配");
      expect(stale.stderr).toContain("source=desktop-cache");
      for (const path of [cached, packaged]) await exec("icacls.exe", [path, "/deny", "*" + sid + ":(X)"], { windowsHide: true });
      const unavailable = await invoke(f.loader, startupProbeArgs([]), env);
      expect(unavailable.code).toBe(127);
      expect(unavailable.stdout).toBe("");
      expect(JSON.parse(await readFile(join(dirname(f.endpoint), "codex-desktop-recovery.json"), "utf8")).phase).toBe("native");
    } finally {
      for (const path of [pinned, cached, packaged]) await exec("icacls.exe", [path, "/remove:d", "*" + sid], { windowsHide: true });
    }
  }, 90_000);

  it("uses existing official files for a real policy query and a shared stdio/WebSocket server", async () => {
    const f = await fixture();
    const discovery = await discoverWindowsDesktop(0);
    expect(discovery.packages.length).toBeGreaterThan(0);
    const guiPid = Number((await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "Get-Process ChatGPT -ErrorAction SilentlyContinue | Where-Object { $_.Path -match 'OpenAI\\.Codex_' -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1 -ExpandProperty Id"],
    { windowsHide: true })).stdout.trim());
    if (guiPid > 0) {
      const ancestry = await discoverWindowsDesktop(guiPid);
      expect(ancestry.ancestorExecutable).toMatch(/[\\/]OpenAI\.Codex_[^\\/]+[\\/]app[\\/]ChatGPT\.exe$/u);
      expect(ancestry.packages).toEqual([]);
    }
    const candidates = await windowsDesktopCliCandidates(f.env, { discover: async () => discovery, digestCacheFile: join(f.root, "digests.json") });
    expect(candidates.some(cli => cli.source === "desktop-cache")).toBe(true);
    const selected = await selectStartupCli(candidates, startupProbeArgs([]), f.env, () => {});
    expect(selected.cli.source).toBe("desktop-cache");
    expect(selected.result.code).toBe(0);
    const packaged = candidates.find(cli => cli.source === "desktop-package")!;
    // This machine allows WindowsApps execution outside package identity.
    expect((await queryDesktopStartup(packaged, startupProbeArgs([]), f.env)).code).toBe(0);
    const policy = await invoke(f.loader, startupProbeArgs([]), { ...f.env, ORBIS_CODEX_REAL: join(f.root, "gone.exe") });
    expect(policy.code).toBe(0);
    expect(JSON.parse(policy.stdout).appServerVersion).toBeDefined();
    const bridge = spawn(process.execPath, [f.loader, "app-server"], { env: f.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const closed = new Promise<number | null>(resolve => bridge.once("close", resolve));
    let output = "", diagnostics = "";
    bridge.stdout.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
    bridge.stderr.setEncoding("utf8").on("data", (chunk: string) => { diagnostics = (diagnostics + chunk).slice(-4096); });
    let external: CodexAppServer | undefined;
    try {
      await expect.poll(() => existsSync(f.endpoint), { timeout: 30_000 }).toBe(true);
      const descriptor = JSON.parse(await readFile(f.endpoint, "utf8")) as { url: string; codexPid: number };
      bridge.stdin.write(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "orbis_native_test", title: "test", version: "1" } } }) + "\n");
      await expect.poll(() => output.includes('"id":1'), { timeout: 10_000 }).toBe(true);
      bridge.stdin.write('{"method":"initialized"}\n{"id":2,"method":"thread/loaded/list","params":{}}\n');
      await expect.poll(() => output.includes('"id":2'), { timeout: 10_000 }).toBe(true);
      external = await CodexAppServer.createExternal({ endpoint: descriptor.url, clientName: "orbis_native_test_secondary" });
      expect(await external.request("thread/loaded/list", {})).toMatchObject({ data: [] });
      expect(JSON.parse(output.split("\n").find(line => line.includes('"id":2'))!).result).toMatchObject({ data: [] });
      await external.stop();
      external = undefined;
      bridge.stdin.end();
      expect(await Promise.race([closed, delay(10_000).then(() => "timeout")]), diagnostics).toBe(0);
      expect(existsSync(f.endpoint)).toBe(false);
      expect(() => process.kill(descriptor.codexPid, 0)).toThrow();
    } finally {
      await external?.stop();
      bridge.stdin.end();
      if (await Promise.race([closed.then(() => true), delay(2_000).then(() => false)]) === false) bridge.kill();
    }
  }, 90_000);
});
