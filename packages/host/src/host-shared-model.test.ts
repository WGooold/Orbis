import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { HostOperationsState } from "@orbis/protocol";
import { HostService } from "./host-service.js";
import { AgentEnablementController, AgentEnablementStore } from "./agent-enablement.js";
import { deviceAgentView, projectBackendDomain } from "./device-agent-visibility.js";
import { ProviderManager } from "./provider-manager.js";
import { createBusinessRelayServer, relayBusinessHostOptions, stopRelayBusinessTransports } from "./fixtures/relay-business-transport.js";

describe("Host shared model integration", () => {
  it("drains in-flight provider reads on close and rejects all late publication or diagnostics", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "orbis-host-close-model-"));
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const publicState = vi.fn(async () => { await held; throw new Error("late failed read"); });
    const host = await HostService.create({ relayUrl: "ws://127.0.0.1:1", credential: "credential", stateDir,
      providers: { publicState } as unknown as ProviderManager, lan: false, loopback: false });
    const pending = host.refreshProviderFacts();
    let stopped = false;
    const closing = host.stop().then(() => { stopped = true; });
    try {
      await Promise.resolve(); await Promise.resolve();
      expect(stopped).toBe(false);
      release(); await pending; await closing;
      expect(host.readHostProviders()).toBeUndefined();
      expect(host.readHostDiagnostics()?.records).toBe(0);
      const before = host.readHostState();
      await host.refreshProviderFacts();
      host.recordDiagnostic({ scope: "host", agentKind: null, sessionId: null, category: "provider", severity: "warning", message: "closed" });
      expect(publicState).toHaveBeenCalledTimes(4);
      expect(host.readHostState()).toEqual(before);
      expect(host.readHostDiagnostics()?.records).toBe(0);
    } finally { release(); await closing; await rm(stateDir, { recursive: true, force: true }); }
  });

  // AGENT-DIAL-01: Desktop-only can read the shared Codex profile, but does not advertise CLI access.
  it("keeps Codex providers available for Desktop without exposing CLI backends", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "orbis-desktop-provider-only-"));
    const manager = new ProviderManager(stateDir, { codex: join(stateDir, "codex"), pi: join(stateDir, "pi"), dsh: join(stateDir, "dsh"), claude: join(stateDir, "claude") });
    const relay = await createBusinessRelayServer({ port: 0, runtimeCredentials: ["fixture"] });
    const policy = new AgentEnablementController(new AgentEnablementStore(stateDir, async () => ({ codexDesktop: true })), () => {});
    const desktopRuntime = {
      kind: "codexDesktop", runtimeId: "codex-desktop-fixture", isReady: () => true, currentProvider: vi.fn(async () => "desktop-profile"),
      ownsRuntime: () => false, seedDesktopThreads: vi.fn(), setEventSink: vi.fn(), directoryEntries: () => [],
      markStarted: vi.fn(), nativeHistoryId: (id: string) => id, runtimeIdFor: (id: string) => "codex-desktop:" + id,
    } as never;
    let host: HostService | undefined;
    try {
      host = await HostService.create({ relayUrl: relay.url, ...relayBusinessHostOptions(relay.url), credential: "fixture", stateDir,
        providers: manager, agentEnablement: policy, codexDesktopRuntime: desktopRuntime, lan: false, loopback: false, reconnect: false });
      await host.start();
      await host.refreshProviderFacts();
      const desktopOnly = deviceAgentView(undefined, new Set(["codex", "pi", "claude", "dsh"]));
      expect(policy.allows("codex")).toBe(false);
      expect(host.readHostState(["backends"]).domains[0]?.value).toMatchObject({ backends: expect.not.arrayContaining([expect.objectContaining({ kind: "codex" })]) });
      const providers = host.readHostProviders();
      expect(providers?.providers).toEqual(expect.arrayContaining([
        expect.objectContaining({ agentKind: "codex", profiles: expect.any(Array), modelProvider: null }),
        expect.objectContaining({ agentKind: "codexDesktop", modelProvider: "desktop-profile" }),
      ]));
      const visibleProviders = projectBackendDomain(desktopOnly, "providers", providers) as { providers: { agentKind: string }[] };
      expect(visibleProviders.providers.some(row => row.agentKind === "codex")).toBe(true);
      expect(visibleProviders.providers.some(row => row.agentKind === "codexDesktop")).toBe(true);
      const neither = deviceAgentView(undefined, new Set(["codex", "codexDesktop"]));
      expect(projectBackendDomain(neither, "providers", providers)).toMatchObject({ providers: [] });
    } finally { await host?.stop(); await stopRelayBusinessTransports(); await relay.close(); await rm(stateDir, { recursive: true, force: true }); }
  });

  it("retains bounded shared operation identities and terminal states without device-private receipts", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "orbis-host-operations-"));
    const host = await HostService.create({ relayUrl: "ws://127.0.0.1:1", credential: "credential", stateDir, lan: false, loopback: false });
    const operations = () => host.readHostState(["operations"]).domains[0]?.value as HostOperationsState;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    try {
      const pending = host.changeProvider("pi", () => held);
      await Promise.resolve();
      const during = operations();
      expect(during.items).toHaveLength(1);
      expect(during.items?.[0]).toMatchObject({ kind: "provider.change", state: "running", agentKind: "pi" });
      const operationId = during.items![0]!.operationId;
      release(); await pending;
      expect(operations().items?.[0]).toMatchObject({ operationId, state: "succeeded" });
      await expect(host.changeProvider("pi", async () => { throw new Error("failure"); })).rejects.toThrow("failure");
      expect(operations().items?.at(-1)?.state).toBe("failed");
      for (let index = 0; index < 256; index++) await host.changeProvider("pi", async () => {});
      expect(operations().items).toHaveLength(256);
      expect(operations().truncated).toBe(true);
      expect(host.readHostState(["operations"]).domains[0]?.completeness).toBe("partial");
      expect(JSON.stringify(operations())).not.toMatch(/deviceId|requestId|credential/);
    } finally { release(); await host.stop(); await rm(stateDir, { recursive: true, force: true }); }
  });

  it("provides a first-read baseline for service domains before a transport is started", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "orbis-host-model-"));
    const host = await HostService.create({ relayUrl: "ws://127.0.0.1:1", credential: "private-credential", stateDir, lan: false, loopback: false });
    try {
      const state = host.readHostState(["identity", "backends", "workspaces", "files", "operations", "connections", "management"]);
      expect(state.missing).toEqual([]);
      expect(state.truncated).toBe(false);
      expect(state.domains.find(domain => domain.domain === "identity")?.value).toMatchObject({ hostId: host.hostId });
      expect(state.domains.find(domain => domain.domain === "management")?.value).toMatchObject({ lifecycle: "stopped", backends: expect.arrayContaining([{ kind: "codex", installed: null, version: null }]) });
      expect(state.domains.find(domain => domain.domain === "workspaces")?.completeness).toBe("partial");
      expect(JSON.stringify(state)).not.toMatch(/private-credential|privateRaw|publicRaw|pskRoot/);
      const second = host.readHostState(["identity", "backends", "management"]);
      for (const domain of second.domains) expect(domain.revision).toBe(state.domains.find(previous => previous.domain === domain.domain)?.revision);
    } finally { await host.stop(); await rm(stateDir, { recursive: true, force: true }); }
  });

  it("keeps a last-known public provider projection on a failed reconciliation", async () => {
    const root = await mkdtemp(join(tmpdir(), "orbis-host-provider-model-"));
    const paths = { pi: join(root, "pi"), codex: join(root, "codex"), dsh: join(root, "dsh") };
    for (const path of Object.values(paths)) await mkdir(path);
    const providers = new ProviderManager(join(root, "state"), paths);
    await providers.save("codex", "saved", "Saved", { auth: { OPENAI_API_KEY: "private-provider-key" }, config: 'model_provider="custom"\n[model_providers.custom]\nbase_url="https://provider.test/v1"\n' }, true);
    const host = await HostService.create({ relayUrl: "ws://127.0.0.1:1", credential: "credential", stateDir: join(root, "host"), providers, lan: false, loopback: false });
    try {
      await host.refreshProviderFacts();
      expect(host.readHostProviders()?.providers.find(provider => provider.agentKind === "codex")).toMatchObject({ current: "saved", authenticated: true });
      vi.spyOn(providers, "publicState").mockRejectedValue(new Error("reconciliation failed"));
      await host.refreshProviderFacts();
      const provider = host.readHostProviders()?.providers.find(provider => provider.agentKind === "codex");
      expect(provider).toMatchObject({ availability: "unknown", current: "saved", profiles: [{ id: "saved" }] });
      expect(JSON.stringify(host.readHostState(["providers"]))).not.toContain("private-provider-key");
    } finally { vi.restoreAllMocks(); await host.stop(); await rm(root, { recursive: true, force: true }); }
  });
});
