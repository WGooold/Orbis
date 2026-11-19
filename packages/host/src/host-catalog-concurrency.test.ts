import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionSummary, HostCatalogBackend, HostCatalogState } from "@orbis/protocol";
import { HostService } from "./host-service.js";
import type { AgentBackend } from "./agent-backend.js";
import { DshRuntime } from "./dsh-runtime.js";
import type { DshWebConnection } from "./dsh-web-client.js";
import { DSH_DESKTOP_FLAVOR } from "./dsh-web-runtime.js";
import { createBusinessRelayServer as createRelayServer, relayBusinessHostOptions, stopRelayBusinessTransports } from "./fixtures/relay-business-transport.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeStubClient(): DshWebConnection {
  return {
    onEvent: undefined,
    onExit: undefined,
    onReconnect: undefined,
    request: vi.fn(async (method: string) => (method === "session/list" ? { items: [] } : {})) as DshWebConnection["request"],
    subscribe(_method, _args, frame) {
      queueMicrotask(() => frame({ type: "baseline", value: { archivedSessionIds: [] } }));
      return () => {};
    },
    respondEvent: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  };
}

describe("Host catalog collection concurrency", () => {
  const dirs: string[] = [];
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()!();
    while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
    await stopRelayBusinessTransports();
  });

  it("collects ready backend catalogs concurrently instead of stalling behind one slow backend", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "orbis-catalog-parallel-"));
    dirs.push(stateDir);
    const relay = await createRelayServer({
      port: 0, runtimeCredentials: ["runtime-secret"], adminToken: "owner-secret", stateFile: join(stateDir, "relay-state.json"),
    });
    cleanups.push(() => relay.close());

    const activeFirst = deferred<readonly AgentSessionSummary[]>();
    const activeSecond = deferred<readonly AgentSessionSummary[]>();
    const startedKinds: string[] = [];

    const slowBackend = new DshRuntime(makeStubClient());
    const fastBackend = new DshRuntime(makeStubClient(), undefined, { flavor: DSH_DESKTOP_FLAVOR });
    const overrideCatalog = (
      backend: DshRuntime,
      kind: HostCatalogBackend["kind"],
      gate: ReturnType<typeof deferred<readonly AgentSessionSummary[]>>,
    ) => {
      const provider = backend as unknown as AgentBackend & { archivedCatalogSupported?: boolean };
      provider.archivedCatalogSupported = false;
      Object.defineProperty(provider, "isReady", { value: () => true });
      Object.defineProperty(provider, "catalog", {
        value: async () => {
          startedKinds.push(kind);
          return await gate.promise;
        },
      });
      Object.defineProperty(provider, "catalogCoverage", { value: undefined });
    };
    overrideCatalog(slowBackend, "dsh", activeFirst);
    overrideCatalog(fastBackend, "dshDesktop", activeSecond);

    const host = await HostService.create({
      relayUrl: relay.url, ...relayBusinessHostOptions(relay.url),
      credential: "runtime-secret", adminToken: "owner-secret", stateDir, reconnect: false, lan: false,
      sessionsRoot: join(stateDir, "pi-sessions"),
    });
    await host.start();
    cleanups.push(() => host.stop());

    await host.attachDshRuntime(slowBackend);
    await host.attachDshRuntime(fastBackend);

    const reading = host.readHostRange();
    // Both backends must begin fetching concurrently even before the first one resolves.
    await vi.waitFor(() => expect(startedKinds).toEqual(["dsh", "dshDesktop"]));

    activeSecond.resolve([{
      agentKind: "dshDesktop", sessionId: "desktop-1", hostname: "host", cwd: "/repo",
      createdAt: 10, modifiedAt: 20, messageCount: 2,
    }]);
    activeFirst.resolve([{
      agentKind: "dsh", sessionId: "web-1", hostname: "host", cwd: "/repo",
      createdAt: 5, modifiedAt: 15, messageCount: 1,
    }]);

    await reading;
    const hostState = host.readHostState(["catalog"]);
    const catalogDomain = hostState.domains.find(d => d.domain === "catalog");
    const value = catalogDomain?.value as HostCatalogState;
    expect(value.sessions?.map(s => s.sessionId)).toEqual(["desktop-1", "web-1"]);
    expect(value.backends.filter(b => b.kind === "dsh" || b.kind === "dshDesktop")).toEqual([
      expect.objectContaining({ kind: "dsh", ready: true, sessions: 1 }),
      expect.objectContaining({ kind: "dshDesktop", ready: true, sessions: 1 }),
    ]);
  });
});
