// FT-G04: independently version static identity without replacing native authority;
// source generations, unknown state, reset, scope isolation and raw legacy shape survive.
import { describe, expect, it } from "vitest";
import { AgentStateRegistry, type StateScope } from "./agent-state-registry.js";
import { CompactStateModel } from "./compact-state-model.js";
import { buildAgentStateSnapshotParts } from "./agent-state-snapshot.js";

describe("FT-G04 compact model representation", () => {
  it("publishes static identity once while dynamic metadata retains its own facts", () => {
    const raw = new AgentStateRegistry({ modelEpoch: "host-epoch" }), compact = new CompactStateModel(raw);
    const scope: StateScope = { kind: "agent", key: { hostId: "host", agentKind: "codex", sessionId: "session" } };
    const source = { producer: "adapter" as const, sourceId: "backend", sourceEpoch: "native-1", sourceRevision: 1 };
    const identity = { hostId: "host", agentKind: "codex", runtimeId: "runtime", sessionId: "session", name: "Agent", cwd: "/repo",
      status: "idle", contextUsage: { tokens: 1 }, model: { provider: "p", id: "one" }, permissionManagement: { details: "risk" }, sessionLeafId: "leaf" };
    raw.commitValue(scope, "identity", { source, availability: "ready", completeness: "complete", value: identity });
    compact.ensure(scope);
    const first = compact.registry.read(scope, "identity")!;
    expect(first.value).toEqual({ hostId: "host", agentKind: "codex", runtimeId: "runtime", sessionId: "session", name: "Agent", cwd: "/repo" });
    raw.commitValue(scope, "identity", { source: { ...source, sourceRevision: 2 }, availability: "ready", completeness: "complete", value: { ...identity, status: "running", contextUsage: { tokens: 2 } } });
    expect(raw.read(scope, "identity")!.revision).toBeGreaterThan(first.revision);
    expect(compact.registry.read(scope, "identity")!.revision).toBe(first.revision);
    expect(buildAgentStateSnapshotParts({ registry: compact.registry, scope, requestId: "read", domains: ["identity"], stateFormat: "compact-v1",
      known: [{ domain: "identity", modelEpoch: first.modelEpoch, revision: first.revision }] })[0]).toMatchObject({ stateFormat: "compact-v1", domains: [], unchanged: ["identity"] });
    expect(raw.read<Record<string, unknown>>(scope, "identity")!.value).toHaveProperty("status", "running");
    const renamed = { ...identity, name: "New title" };
    raw.commitValue(scope, "identity", { source: { ...source, sourceRevision: 3 }, availability: "ready", completeness: "complete", value: renamed });
    expect(compact.registry.read(scope, "identity")!.revision).toBe(first.revision + 1);
    compact.close();
  });

  it("isolates exact scopes, source replacement, unknown facts and Host epoch reset", () => {
    const raw = new AgentStateRegistry({ modelEpoch: "epoch" }), compact = new CompactStateModel(raw);
    const scope = (hostId: string): StateScope => ({ kind: "agent", key: { hostId, agentKind: "pi", sessionId: "same" } });
    const fact = { source: { producer: "adapter" as const, sourceId: "pi", sourceEpoch: "one", sourceRevision: 1 },
      availability: "ready" as const, completeness: "complete" as const, value: { runtimeId: "r", name: "Agent", cwd: "/same" } };
    for (const host of ["a", "b"]) { raw.commitValue(scope(host), "identity", fact); compact.ensure(scope(host)); }
    raw.commitValue(scope("a"), "identity", { ...fact, availability: "unknown", completeness: "unknown", value: null });
    expect(compact.registry.read(scope("a"), "identity")!.availability).toBe("unknown");
    expect(compact.registry.read(scope("b"), "identity")!.availability).toBe("ready");
    const before = compact.registry.read(scope("b"), "identity")!;
    raw.commitValue(scope("b"), "identity", { ...fact, source: { ...fact.source, sourceEpoch: "two" } });
    expect(compact.registry.read(scope("b"), "identity")!.source.sourceEpoch).not.toBe(before.source.sourceEpoch);
    raw.beginModelEpoch("replacement");
    expect(compact.registry.snapshot(scope("b"))).toEqual([]);
    expect(compact.ensure(scope("b")).currentModelEpoch()).toBe("replacement");
    compact.close();
  });
});
