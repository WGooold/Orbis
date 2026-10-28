import { describe, expect, it } from "vitest";
import { HostCatalogRangeSchema, HostCatalogStateSchema, type AgentSessionSummary, type HostCatalogBackend, type HostCatalogState } from "@orbis/protocol";
import { AgentStateRegistry } from "./agent-state-registry.js";
import { HostStateFacts } from "./host-state-facts.js";

const backend = (sessions: number, changes: Partial<HostCatalogBackend> = {}): HostCatalogBackend =>
  ({ kind: "pi", ready: true, complete: true, sessions, elapsedMs: 1, ...changes });
const session = (index: number, changes: Partial<AgentSessionSummary> = {}): AgentSessionSummary => ({
  agentKind: "pi", sessionId: `session-${index}`, hostname: "Host", cwd: "D:/repo", createdAt: 1, modifiedAt: 2, messageCount: 1, ...changes,
});
const setup = () => {
  const registry = new AgentStateRegistry({ modelEpoch: "catalog-model" });
  const facts = new HostStateFacts({ registry });
  const read = () => registry.read<HostCatalogState>({ kind: "host" }, "catalog")!;
  return { registry, facts, read };
};

describe("Host catalog immutable ranges", () => {
  it("fits long summaries into the public budget and retrieves the whole source without mixed versions", () => {
    const { facts, read } = setup();
    const all = Array.from({ length: 100 }, (_, index) => session(index, { cwd: `D:/${"目录".repeat(2_000)}`, firstMessage: "预览".repeat(2_000) }));
    facts.catalog({ totalSessions: all.length, truncated: false, backends: [backend(all.length)], sessions: all });
    const first = read();
    HostCatalogStateSchema.parse(first.value);
    expect(Buffer.byteLength(JSON.stringify(first.value))).toBeLessThan(192 * 1024);
    expect(first.value!.sessions!.length).toBeLessThan(all.length);
    expect(first.completeness).toBe("partial");
    expect(first.value!.totalSessions).toBe(all.length);
    const received = [...first.value!.sessions!];
    let cursor = first.value!.nextCursor;
    while (cursor) {
      const page = HostCatalogRangeSchema.parse(facts.catalogRange({ cursor, limit: 200 }));
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(192 * 1024);
      expect(page).toMatchObject({ modelEpoch: first.modelEpoch, revision: first.revision, snapshotId: first.value!.snapshotId, offset: received.length, complete: true, truncated: false });
      received.push(...page.sessions); cursor = page.nextCursor;
    }
    expect(received).toEqual(all);
    facts.catalog({ totalSessions: all.length, truncated: false, backends: [backend(all.length, { elapsedMs: 99 })], sessions: all });
    expect(read().value!.snapshotId).toBe(first.value!.snapshotId);
    expect(read().value!.checkedAt).toBe(first.value!.checkedAt);
    expect(read().revision).toBe(first.revision);
  });

  it("caps the inline count and changes the version when only an entry beyond the window changes", () => {
    const { facts, read } = setup();
    const all = Array.from({ length: 2_100 }, (_, index) => session(index));
    const publish = () => facts.catalog({ totalSessions: all.length, truncated: false, backends: [backend(all.length)], sessions: all });
    publish(); const first = read(); const cursor = first.value!.nextCursor!;
    expect(first.value!.sessions!.length).toBeLessThanOrEqual(2_000);
    expect(facts.catalogRange({ limit: 999 }).sessions).toHaveLength(200);
    all[2_099] = session(2_099, { name: "changed beyond inline window" }); publish();
    expect(read().revision).toBeGreaterThan(first.revision);
    expect(read().value!.snapshotId).not.toBe(first.value!.snapshotId);
    expect(facts.catalogRange({ cursor })).toMatchObject({ error: "snapshot_changed", sessions: [], complete: false });
    expect(facts.catalogRange({ cursor: "malformed cursor" })).toMatchObject({ error: "invalid_cursor", sessions: [] });
    expect(facts.catalogRange({ cursor: Buffer.from(JSON.stringify([read().value!.snapshotId, 9_999])).toString("base64url") }).error).toBe("invalid_cursor");
  });

  it("preserves incomplete backend entries and full inventory across provider projection updates", () => {
    const { facts, read } = setup();
    const all = [session(1), session(2, { agentKind: "codex" })];
    facts.catalog({ totalSessions: 2, truncated: false, backends: [backend(1), backend(1, { kind: "codex" })], sessions: all });
    facts.catalog({ totalSessions: 0, truncated: false, backends: [backend(0), backend(0, { kind: "codex", complete: false, error: "read failed" })], sessions: [] });
    facts.catalogProviders([{ agentKind: "codex", provider: "current" }]);
    expect(read().value!.currentProviders).toEqual([{ agentKind: "codex", provider: "current" }]);
    expect(facts.catalogRange()).toMatchObject({ totalSessions: 1, complete: false, truncated: false, sessions: [all[1]] });
    facts.catalog({ totalSessions: 0, truncated: false, backends: [backend(0), backend(0, { kind: "codex" })], sessions: [] });
    expect(facts.catalogRange()).toMatchObject({ totalSessions: 0, complete: true, sessions: [] });
  });

  it("bounds retained inventories by count and bytes while advertising the true source total", () => {
    const { facts, read } = setup();
    const countBound = Array.from({ length: 20_001 }, (_, index) => session(index));
    facts.catalog({ totalSessions: countBound.length, truncated: false, backends: [backend(countBound.length)], sessions: countBound });
    expect(read().value).toMatchObject({ totalSessions: 20_001, truncated: true });
    let page = facts.catalogRange({ limit: 200 }); let total = page.sessions.length;
    while (page.nextCursor) { page = facts.catalogRange({ cursor: page.nextCursor, limit: 200 }); total += page.sessions.length; }
    expect(total).toBe(20_000); expect(page).toMatchObject({ totalSessions: 20_001, complete: false, truncated: true });
    const byteBound = Array.from({ length: 1_200 }, (_, index) => session(index, { firstMessage: "x".repeat(4_000), cwd: `D:/${"x".repeat(4_000)}` }));
    facts.catalog({ totalSessions: byteBound.length, truncated: false, backends: [backend(byteBound.length)], sessions: byteBound });
    page = facts.catalogRange({ limit: 200 }); total = page.sessions.length;
    while (page.nextCursor) { page = facts.catalogRange({ cursor: page.nextCursor, limit: 200 }); total += page.sessions.length; }
    expect(total).toBeLessThan(byteBound.length); expect(total).toBeGreaterThan(0);
    expect(page).toMatchObject({ totalSessions: byteBound.length, complete: false, truncated: true });
  });

  it("keeps committed ranges readable after a rejected replacement", () => {
    const { facts, read } = setup();
    expect(facts.catalogRange().error).toBe("catalog_unavailable");
    facts.catalog({ totalSessions: 1, truncated: false, backends: [backend(1)], sessions: [session(1)] });
    const first = read();
    facts.catalog({ totalSessions: 1, truncated: false, backends: [backend(1)], sessions: [session(2, { firstMessage: "x".repeat(4_001) })] });
    expect(read()).toEqual(first); expect(facts.catalogRange().sessions).toEqual([session(1)]);
  });
});
