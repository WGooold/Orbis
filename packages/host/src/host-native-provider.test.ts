import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentKind, HostProviderSummary } from "@pi-remote/protocol";
import type { CodexRuntime } from "./codex-runtime.js";
import { HostService } from "./host-service.js";
import type { ProviderManager } from "./provider-manager.js";

function nativeBackend(kind: "codex" | "codexDesktop", provider: string) {
  const backend = { kind, runtimeId: kind, isReady: vi.fn(() => true),
    currentProvider: vi.fn(async (): Promise<string | undefined> => provider),
    seedDesktopThreads: vi.fn(), setEventSink: vi.fn(), directoryEntries: () => [] };
  return { backend, runtime: backend as unknown as CodexRuntime };
}

function manager() {
  const publicState = vi.fn(async (agentKind: AgentKind): Promise<HostProviderSummary> => ({
    agentKind, current: "managed-profile-uuid", profiles: [{ id: "managed-profile-uuid", name: "Custom", enabled: true, globalDefault: true }],
    authenticated: true, switching: null, usage: { availability: "unknown", detail: null },
  }));
  return { publicState, providers: { publicState } as unknown as ProviderManager };
}

describe("native Codex provider ownership in the Host model", () => {
  it("keeps managed profile ids separate and reads terminal and desktop defaults independently", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "orbis-native-provider-"));
    const terminal = nativeBackend("codex", "terminal");
    const desktop = nativeBackend("codexDesktop", "custom");
    const profiles = manager();
    const host = await HostService.create({ stateDir, relayUrl: "ws://127.0.0.1:1", credential: "test",
      loopback: false, lan: false, providers: profiles.providers, codexRuntime: terminal.runtime, codexDesktopRuntime: desktop.runtime });
    try {
      await host.refreshProviderFacts();
      const rows = () => host.readHostProviders()!.providers;
      expect(rows().find(row => row.agentKind === "codex")).toMatchObject({ current: "managed-profile-uuid", modelProvider: "terminal" });
      expect(rows().find(row => row.agentKind === "codexDesktop")).toMatchObject({ current: null, modelProvider: "custom", profiles: null });
      expect(profiles.publicState.mock.calls.map(([kind]) => kind)).toEqual(["pi", "codex", "dsh"]);
      desktop.backend.currentProvider.mockResolvedValue("other");
      await host.refreshProviderFacts();
      expect(rows().find(row => row.agentKind === "codexDesktop")?.modelProvider).toBe("other");
      desktop.backend.currentProvider.mockRejectedValue(new Error("disconnected"));
      await host.refreshProviderFacts();
      expect(rows().find(row => row.agentKind === "codexDesktop")?.modelProvider).toBeNull();
      terminal.backend.isReady.mockReturnValue(false);
      await host.refreshProviderFacts();
      expect(rows().find(row => row.agentKind === "codex")).toMatchObject({ current: "managed-profile-uuid", modelProvider: null });
    } finally { await host.stop(); await rm(stateDir, { recursive: true, force: true }); }
  });

  it("reads the native desktop provider even without a Host profile manager", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "orbis-native-provider-"));
    const desktop = nativeBackend("codexDesktop", "custom");
    const host = await HostService.create({ stateDir, relayUrl: "ws://127.0.0.1:1", credential: "test",
      loopback: false, lan: false, codexDesktopRuntime: desktop.runtime });
    try {
      await host.refreshProviderFacts();
      expect(host.readHostProviders()?.providers.find(row => row.agentKind === "codexDesktop"))
        .toMatchObject({ current: null, modelProvider: "custom", profiles: null });
    } finally { await host.stop(); await rm(stateDir, { recursive: true, force: true }); }
  });

  it("rejects late native defaults and discards a read whose backend went offline", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "orbis-native-provider-order-"));
    const desktop = nativeBackend("codexDesktop", "custom");
    const pendingReads: Array<(provider: string) => void> = [];
    desktop.backend.currentProvider.mockImplementation(() => new Promise(resolve => { pendingReads.push(resolve); }));
    const host = await HostService.create({ stateDir, relayUrl: "ws://127.0.0.1:1", credential: "test",
      loopback: false, lan: false, codexDesktopRuntime: desktop.runtime });
    try {
      const older = host.refreshProviderFacts();
      const newer = host.refreshProviderFacts();
      pendingReads[1]!("new"); await newer;
      pendingReads[0]!("old"); await older;
      expect(host.readHostProviders()?.providers.find(row => row.agentKind === "codexDesktop")?.modelProvider).toBe("new");
      const offline = host.refreshProviderFacts();
      desktop.backend.isReady.mockReturnValue(false);
      pendingReads[2]!("old"); await offline;
      expect(host.readHostProviders()?.providers.find(row => row.agentKind === "codexDesktop")?.modelProvider).toBeNull();
    } finally { await host.stop(); await rm(stateDir, { recursive: true, force: true }); }
  });
});
