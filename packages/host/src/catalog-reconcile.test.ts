import { describe, expect, it } from "vitest";
import { applyStateDelta } from "@orbis/protocol";
import { AgentStateRegistry } from "./agent-state-registry.js";
import { CompactStateModel } from "./compact-state-model.js";
import { buildAgentStateSnapshot } from "./agent-state-snapshot.js";

// FT-G11: a missed publication must not turn a one-entry rename into another
// full directory. Reads use the actual client version, with bounded retention
// and explicit recovery on eviction, representation or source replacement.
const scope = { kind: "host" } as const;
function setup() {
  const raw = new AgentStateRegistry({ modelEpoch: "model" });
  const compact = new CompactStateModel(raw);
  let revision = 0;
  const commit = (value: unknown, sourceEpoch = "source") => raw.commitValue(scope, "catalog", {
    source: { producer: "host", sourceId: "catalog", sourceEpoch, sourceRevision: ++revision },
    availability: "ready", completeness: "complete", value,
  });
  const initial = { sessions: Array.from({ length: 180 }, (_, n) => ({ id: String(n), name: `Session ${n}`, firstMessage: "body".repeat(100) })) };
  commit(initial); compact.ensure(scope);
  const first = compact.registry.read(scope, "catalog")!;
  const read = (knownRevision = first.revision, format: "compact-v1" | "compact-v2" = "compact-v2") => buildAgentStateSnapshot({
    registry: compact.registry, scope, requestId: "read", domains: ["catalog"], stateFormat: format,
    known: [{ domain: "catalog", modelEpoch: first.modelEpoch, revision: knownRevision }],
    catalogBaseline: (epoch, version) => compact.catalogBaseline(epoch, version),
  });
  return { raw, compact, initial, first, commit, read };
}

describe("FT-G11 catalog read reconciliation", () => {
  it("reconstructs from an applied revision even after two missed updates", () => {
    const s = setup();
    s.commit({ ...s.initial, sessions: s.initial.sessions.map((item, n) => n === 100 ? { ...item, name: "renamed" } : item) });
    s.commit({ ...s.initial, sessions: s.initial.sessions.map((item, n) => n === 100 ? { ...item, name: "renamed again" } : item) });
    const response = s.read(), domain = response.domains[0]!;
    expect(domain.value).toBeNull(); expect(domain.delta?.baseRevision).toBe(s.first.revision);
    expect(applyStateDelta(s.first.value, domain.delta!.operations)).toEqual(s.compact.registry.read(scope, "catalog")!.value);
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThan(2_048);
    expect(Buffer.byteLength(JSON.stringify(s.first.value))).toBeGreaterThan(64 * 1024);
    expect(s.read(domain.revision)).toMatchObject({ domains: [], unchanged: ["catalog"] });
    expect(s.read(s.first.revision, "compact-v1").domains[0]!.delta).toBeUndefined();
    s.compact.close();
  });

  it("recovers a full value after retention eviction or source replacement", () => {
    const s = setup();
    for (let i = 0; i < 18; i++) s.commit({ ...s.initial, count: i });
    expect(s.compact.catalogBaseline(s.first.modelEpoch, s.first.revision)).toBeUndefined();
    expect(s.read().domains[0]!.value).not.toBeNull();
    const before = s.compact.registry.read(scope, "catalog")!;
    s.commit({ ...s.initial, count: 20 }, "replacement");
    expect(s.read(before.revision).domains[0]!.delta).toBeUndefined();
    s.raw.beginModelEpoch("new-host");
    expect(s.compact.catalogBaseline(s.first.modelEpoch, before.revision)).toBeUndefined();
    s.compact.close();
  });
});
