import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testDirectory } from "../../../scripts/test-fixtures/temp-directory.js";
import { AgentKindSchema } from "@orbis/protocol";
import { createRelayServer } from "../../relay/src/index.js";
import { loadDesktopQa, type DesktopQaConfiguration } from "./desktop-qa.js";
import { DesktopRuntime, type DesktopEvent } from "./desktop-runtime.js";
import { HostService } from "./host-service.js";
import { CodexDesktopLifecycle } from "./codex-desktop-lifecycle.js";
import { DshDesktopLifecycle } from "./dsh-desktop-lifecycle.js";
import { DshRuntime } from "./dsh-runtime.js";
import * as loginEnvironment from "./login-shell-env.js";
import * as claudeInstallation from "./claude-integration-install.js";

const activation = { version: 1 as const, environmentId: "qa-desktop-fixture", relayUrl: "wss://qa.example.test:18443", credential: "qa-desktop-fixture-credential-12345" };

describe("QA-ACT-02 isolated desktop bridge", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  async function fixture(): Promise<{ root: string; qa: DesktopQaConfiguration; runtime: DesktopRuntime; events: DesktopEvent[] }> {
    const root = await testDirectory(join(tmpdir(), "orbis-qa-desktop-"));
    const home = join(root, "home");
    await mkdir(home);
    const env = { HOME: home, USERPROFILE: home, APPDATA: join(home, ".config"), LOCALAPPDATA: join(home, ".local/share"),
      XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local/share"),
      ORBIS_AGENT_INSTALL_ROOT: join(home, "agents"), CODEX_HOME: join(home, ".codex"), DSH_HOME: join(home, ".dsh"),
      PI_CODING_AGENT_DIR: join(home, ".pi/agent"), CLAUDE_CONFIG_DIR: join(home, ".claude"), ORBIS_QA_HOME: home,
      ORBIS_QA_ACTIVATION_FILE: join(root, "qa-activation.json"), ORBIS_HOST_STATE_DIR: join(root, "host"),
      PATH: join(home, "empty-path"), ORBIS_DSH_WEB_URL: undefined, ORBIS_PI_ENTRY: undefined, ORBIS_CODEX_ENTRY: undefined,
      ORBIS_DSH_ENTRY: undefined, ORBIS_ENABLED: undefined, ORBIS_RELAY_URL: undefined, ORBIS_RUNTIME_CREDENTIAL: undefined };
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    const qa = { activation, home };
    const events: DesktopEvent[] = [];
    const runtime = new DesktopRuntime(event => events.push(event), join(root, "host"),
      { pi: env.PI_CODING_AGENT_DIR, codex: env.CODEX_HOME, dsh: env.DSH_HOME, claude: env.CLAUDE_CONFIG_DIR }, qa);
    return { root, qa, runtime, events };
  }

  // A stray package file or ordinary environment must not opt the released bridge into QA activation.
  it("loads only explicit activation with isolated directories and safe error messages", async () => {
    const { root, qa, runtime } = await fixture();
    try {
      const path = join(root, "qa-activation.json");
      await writeFile(path, JSON.stringify(activation), { mode: 0o600 });
      expect(await loadDesktopQa({})).toBeUndefined();
      expect(await loadDesktopQa(process.env)).toEqual(qa);
      await expect(loadDesktopQa({ ORBIS_QA_ACTIVATION_FILE: path })).rejects.toThrow("isolated home and state");
      await writeFile(path, `{"credential":"${activation.credential}`);
      await expect(loadDesktopQa(process.env)).rejects.toThrow(/^Cannot read valid QA activation JSON$/);
    } finally { await runtime.close(); }
  });

  // HOST-AGENT-VERSION-01: publish the entire display catalog even when agents are off,
  // without confusing exact protocol matches or integration references with a minimum.
  it("publishes version requirements as separate desktop bootstrap metadata", async () => {
    const { runtime } = await fixture();
    try {
      const result = await runtime.initialize() as {
        agentVersionRequirements: Record<string, unknown>;
        agentEnablement: { agents: Array<{ kind: string; label: string; enabled: boolean }> };
      };
      expect(Object.keys(result.agentVersionRequirements).sort()).toEqual([...AgentKindSchema.options].sort());
      expect(result.agentVersionRequirements).toMatchObject({
        claude: { kind: "minimum", version: "2.1.287" },
        codexDesktop: { kind: "unknown" },
        dsh: { kind: "baseline", version: "0.2.2-rc.2" },
        dshDesktop: { kind: "baseline", version: "0.2.2-rc.2" },
        kimiCode: { kind: "minimum", version: "2.6.3" },
        kimiCodeDesktop: { kind: "embeddedServiceMinimum", version: "2.6.2" },
        opencode: { kind: "minimum", version: "2.3.2" },
        openclaw: { kind: "localLaunchMinimum", version: "2026.11.5" },
        agy: { kind: "minimum", version: "1.5.17" },
      });
      expect(result.agentEnablement.agents.some(row => !row.enabled)).toBe(true);
      for (const row of result.agentEnablement.agents) expect(Object.keys(row).sort()).toEqual(["enabled", "kind", "label"]);
    } finally { await runtime.close(); }
  });

  // GUI settings cannot reconnect a test package to the production Relay, desktop backends or global integrations.
  it("uses package activation for a real connection and keeps the running Host isolated", async () => {
    const { root, qa, runtime, events } = await fixture();
    const relay = await createRelayServer({ runtimeCredentials: [activation.credential], qaPairingCredential: activation.credential });
    qa.activation = { ...activation, relayUrl: relay.url };
    const create = vi.spyOn(HostService, "create");
    const pi = vi.spyOn(runtime, "setPiIntegration");
    const claude = vi.spyOn(runtime, "setClaudeIntegration");
    const codexInstalled = vi.spyOn(CodexDesktopLifecycle.prototype, "isInstalled");
    const codexProbe = vi.spyOn(CodexDesktopLifecycle.prototype, "probe");
    const dshInstalled = vi.spyOn(DshDesktopLifecycle.prototype, "isInstalled");
    const dshWatch = vi.spyOn(DshDesktopLifecycle.prototype, "watch");
    const dshExisting = vi.spyOn(DshRuntime, "connectExisting").mockResolvedValue(undefined);
    vi.spyOn(runtime, "detect").mockResolvedValue([]);
    try {
      await runtime.start({ relayUrl: "wss://production.example.test", credential: "production-credential", lanPort: 8788,
        piIntegrationEnabled: true, claudeIntegrationEnabled: true, codexEnabled: false, dshEnabled: false,
        dshWebUrl: "http://127.0.0.1:43210/?token=productiontoken1234" });
      expect(events).toContainEqual({ event: "state", state: "connected" });
      const options = create.mock.calls[0]![0];
      const initial = await runtime.readAgentEnablement();
      expect(initial.agents.every(row => !row.enabled)).toBe(true);
      expect(await options.agentEnablement?.read()).toEqual(initial);
      expect(await runtime.setAgentEnablement({ kind: "pi", enabled: true, expectedRevision: initial.revision })).toMatchObject({ status: "applied" });
      expect(await runtime.setAgentEnablement({ kind: "codexDesktop", enabled: true, expectedRevision: 1 })).toMatchObject({ status: "applied" });
      expect(await runtime.setAgentEnablement({ kind: "dshDesktop", enabled: true, expectedRevision: 2 })).toMatchObject({ status: "applied" });
      expect(options).toMatchObject({ relayUrl: relay.url, credential: activation.credential, lanPort: 0,
        stateDir: join(root, "host"), sessionsRoot: join(qa.home, ".pi/agent/sessions"),
        codexDesktopLaunchable: false, dshDesktopLaunchable: false, claude: { configDir: join(qa.home, ".claude") } });
      expect(process.env.ORBIS_DSH_WEB_URL).toBeUndefined();
      expect(pi).not.toHaveBeenCalled(); expect(claude).not.toHaveBeenCalled();
      expect(codexInstalled).not.toHaveBeenCalled(); expect(codexProbe).not.toHaveBeenCalled();
      expect(dshInstalled).not.toHaveBeenCalled(); expect(dshWatch).not.toHaveBeenCalled();
      await expect(options.ensureCodexDesktop!()).rejects.toThrow("QA Host");
      await expect(options.ensureDshDesktopRuntime!()).rejects.toThrow("QA Host");
      expect(await options.recoverDshDesktopRuntime!()).toBeUndefined();
      expect(await runtime.pair()).toMatchObject({ qr: expect.stringMatching(/^data:image\/png;base64,/u), expiresAt: expect.any(Number) });
      await runtime.stop();
      for (const [env] of dshExisting.mock.calls) expect(env).toMatchObject({ DSH_HOME: join(qa.home, ".dsh") });
      expect(await readFile(join(root, "host/host.json"), "utf8")).not.toContain(activation.credential);
    } finally { await runtime.close(); await relay.close(); }
  });

  it("skips login environment and automatic global integration during initialization", async () => {
    const { runtime } = await fixture();
    const login = vi.spyOn(loginEnvironment, "adoptLoginShellEnvironment");
    const windows = vi.spyOn(loginEnvironment, "adoptWindowsEnvironment");
    const claude = vi.spyOn(runtime, "setClaudeIntegration");
    vi.spyOn(claudeInstallation, "findClaudeExecutable").mockResolvedValue(undefined);
    try {
      await expect(runtime.initialize({ claudeIntegrationEnabled: true })).resolves.toHaveProperty("hostId");
      expect(login).not.toHaveBeenCalled(); expect(windows).not.toHaveBeenCalled(); expect(claude).not.toHaveBeenCalled();
      await expect(runtime.piCommand("install")).rejects.toThrow("QA Host");
      await expect(runtime.setPiIntegration(true)).rejects.toThrow("QA Host");
      await expect(runtime.setClaudeIntegration(true)).rejects.toThrow("QA Host");
      await expect(runtime.enableCodexTerminal("/fixture")).rejects.toThrow("QA Host");
      await expect(runtime.openAgent("codexDesktop")).rejects.toThrow("QA Host");
      await expect(runtime.openAgent("dshDesktop")).rejects.toThrow("QA Host");
      await expect(runtime.openAgent("kimiCode")).rejects.toThrow("QA Host");
    } finally { await runtime.close(); }
  });

  it("keeps production registration required even with QA environment variables present", async () => {
    const { root, runtime: unused } = await fixture();
    const runtime = new DesktopRuntime(() => {}, join(root, "production-state"),
      { pi: join(root, "production-pi"), codex: join(root, "production-codex"), dsh: join(root, "production-dsh"), claude: join(root, "production-claude") });
    try { await expect(runtime.start({ relayUrl: activation.relayUrl, credential: activation.credential })).rejects.toThrow("注册并激活"); }
    finally { await runtime.close(); await unused.close(); }
  });
});
