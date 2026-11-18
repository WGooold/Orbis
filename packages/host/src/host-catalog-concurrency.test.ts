import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { AgentSessionSummary, HostCatalogState } from "@orbis/protocol";
import { ClaudeBackend, PiBackend } from "./agent-backend.js";
import { HostService } from "./host-service.js";

it("reads independent catalogs concurrently and keeps backend and equal-time session order", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "orbis-catalog-concurrency-"));
  let releasePi!: () => void;
  const piGate = new Promise<void>(resolve => { releasePi = resolve; });
  const entry = (agentKind: "pi" | "claude", archived: boolean): AgentSessionSummary => ({
    sessionId: `${agentKind}-${archived ? "archived" : "active"}`, agentKind, archived,
    cwd: stateDir, hostname: "test", createdAt: 1_000, modifiedAt: 1_000, messageCount: 0,
  });
  const pi = vi.spyOn(PiBackend.prototype, "catalog").mockImplementation(async (archived = false) => {
    await piGate;
    return [entry("pi", archived)];
  });
  const claude = vi.spyOn(ClaudeBackend.prototype, "catalog").mockImplementation(async (archived = false) => [entry("claude", archived)]);
  let host: HostService | undefined;
  let read: ReturnType<HostService["readHostRange"]> | undefined;
  try {
    host = await HostService.create({ relayUrl: "ws://127.0.0.1:1", credential: "catalog-test", stateDir, sessionsRoot: join(stateDir, "pi"),
      claude: { configDir: join(stateDir, "claude") }, lan: false, reconnect: false });
    read = host.readHostRange({ limit: 200 });
    // Claude must start while Pi is still blocked. Releasing in reverse order
    // also catches accidental completion-order changes to the committed model.
    await vi.waitFor(() => expect(claude).toHaveBeenCalledTimes(2));
    expect(pi).toHaveBeenCalledTimes(2);
    releasePi();
    const page = await read;
    expect(page.sessions.map(session => session.sessionId)).toEqual(["pi-active", "pi-archived", "claude-active", "claude-archived"]);
    const catalog = host.readHostState(["catalog"]).domains.find(domain => domain.domain === "catalog")!.value as HostCatalogState;
    expect(catalog.backends.map(backend => backend.kind)).toEqual(["pi", "claude"]);
    expect(catalog.backends.every(backend => backend.complete && backend.sessions === 2)).toBe(true);
  } finally {
    releasePi();
    await read?.catch(() => undefined);
    await host?.stop();
    pi.mockRestore(); claude.mockRestore();
    await rm(stateDir, { recursive: true, force: true });
  }
});
