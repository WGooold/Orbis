// ADR-0076 DSH-DESKTOP-06 / ADR-0064: a device without `agent.dshDesktop` must receive exactly what a
// released App validates. Released iOS rejects a whole catalog page containing an unknown agent kind and
// checks offsets and totals across range pages, so Desktop rows are filtered with consistent cursors.
import { describe, expect, it } from "vitest";
import { HostCatalogRangeSchema, HostCatalogStateSchema, type AgentSessionSummary, type HostCatalogState } from "@orbis/protocol";
import { AgentStateRegistry } from "./agent-state-registry.js";
import { HostStateFacts } from "./host-state-facts.js";
import { hiddenFromLegacy, legacyDeviceMessage, legacyHostDomain } from "./dsh-desktop-visibility.js";

const session = (index: number, agentKind: AgentSessionSummary["agentKind"]): AgentSessionSummary => ({
  agentKind, sessionId: `${agentKind === "dshDesktop" ? "dsh-desktop" : "dsh"}:s${index}`, hostname: "Host", cwd: `D:/${"目录".repeat(800)}`,
  createdAt: 1, modifiedAt: 2, messageCount: 1, firstMessage: "预览".repeat(800),
});

describe("Desktop visibility for released Apps", () => {
  it("pages the catalog without Desktop rows, with totals and offsets a released App accepts", () => {
    const registry = new AgentStateRegistry({ modelEpoch: "m" });
    const facts = new HostStateFacts({ registry });
    // Interleave Desktop sessions so that they fall inside, between and after pages.
    const all = Array.from({ length: 120 }, (_, index) => session(index, index % 3 === 0 ? "dshDesktop" : "dsh"));
    const visible = all.filter(item => item.agentKind !== "dshDesktop");
    facts.catalog({ totalSessions: all.length, truncated: false, sessions: all, backends: [
      { kind: "dsh", ready: true, complete: true, sessions: visible.length, elapsedMs: 1 },
      { kind: "dshDesktop", ready: true, complete: true, sessions: all.length - visible.length, elapsedMs: 1 },
    ], currentProviders: [{ agentKind: "dsh", provider: "deepseek-web" }, { agentKind: "dshDesktop", provider: "native" }] });
    const committed = registry.read<HostCatalogState>({ kind: "host" }, "catalog")!;
    const first = legacyHostDomain("catalog", committed.value, value => facts.hiddenCatalog(value, "dshDesktop")) as HostCatalogState;
    HostCatalogStateSchema.parse(first);
    expect(JSON.stringify(first)).not.toContain("dshDesktop");
    expect(first.totalSessions).toBe(visible.length);
    const received = [...first.sessions!];
    let cursor = first.nextCursor;
    expect(cursor).toBeTruthy();
    // The full cursor space is not accepted in the filtered view and vice versa.
    expect(facts.catalogRange({ cursor: committed.value!.nextCursor! }, "dshDesktop").error).toBe("invalid_cursor");
    expect(facts.catalogRange({ cursor: cursor! }).error).toBe("invalid_cursor");
    while (cursor) {
      const page = HostCatalogRangeSchema.parse(facts.catalogRange({ cursor, limit: 7 }, "dshDesktop"));
      expect(page).toMatchObject({ offset: received.length, totalSessions: visible.length, snapshotId: first.snapshotId, revision: committed.revision });
      received.push(...page.sessions);
      cursor = page.nextCursor;
    }
    expect(received).toEqual(visible);
  });

  it("removes Desktop backends, statuses, providers and operations from host-scope values", () => {
    const backends = legacyHostDomain("backends", { backends: [{ kind: "dsh" }, { kind: "dshDesktop" }], agents: ["dsh", "dshDesktop"],
      launchableAgents: ["dshDesktop"], codexDesktop: null, dshDesktop: { state: "attached", reason: "x" } }, value => value);
    expect(backends).toEqual({ backends: [{ kind: "dsh" }], agents: ["dsh"], launchableAgents: [], codexDesktop: null });
    expect(legacyHostDomain("providers", { providers: [{ agentKind: "dshDesktop" }, { agentKind: "pi" }] }, value => value)).toEqual({ providers: [{ agentKind: "pi" }] });
    expect(legacyHostDomain("operations", { items: [{ agentKind: "dshDesktop" }, { agentKind: null }] }, value => value)).toEqual({ items: [{ agentKind: null }] });
  });

  it("drops Desktop runtime traffic and filters bootstrap, list and diagnostics messages", () => {
    expect(hiddenFromLegacy({ type: "runtime.event", runtimeId: "dsh-desktop:a" })).toBe(true);
    expect(hiddenFromLegacy({ type: "runtime.online", runtime: { runtimeId: "dsh-desktop:a" } })).toBe(true);
    expect(hiddenFromLegacy({ type: "session.archive.changed", agentKind: "dshDesktop" })).toBe(true);
    expect(hiddenFromLegacy({ type: "runtime.event", runtimeId: "dsh:a" })).toBe(false);
    expect(legacyDeviceMessage({ type: "device.ready", runtimes: [{ runtimeId: "dsh:a" }, { runtimeId: "dsh-desktop:a" }], agents: ["dshDesktop", "pi"],
      launchableAgents: ["dshDesktop"], dshDesktop: { state: "closed" }, hostFeatures: ["device.features"] }))
      .toEqual({ type: "device.ready", runtimes: [{ runtimeId: "dsh:a" }], agents: ["pi"], launchableAgents: [], hostFeatures: ["device.features"] });
    expect(legacyDeviceMessage({ type: "session.list.result", sessions: [{ sessionId: "dsh-desktop:a", agentKind: "dshDesktop" }, { sessionId: "p", agentKind: "pi" }] }))
      .toEqual({ type: "session.list.result", sessions: [{ sessionId: "p", agentKind: "pi" }] });
    expect(legacyDeviceMessage({ type: "diagnostics.page", page: { records: [{ agentKind: "dshDesktop" }, { agentKind: null }], nextCursor: null, truncated: false } }))
      .toEqual({ type: "diagnostics.page", page: { records: [{ agentKind: null }], nextCursor: null, truncated: false } });
  });
});

// HERMES-COMPAT-01: filtered offsets must not cross any of the four feature views.
it("binds cursor pages and totals to the independent Hermes and Desktop features", () => {
  const registry = new AgentStateRegistry({ modelEpoch: "m" });
  const facts = new HostStateFacts({ registry });
  const kinds = ["pi", "hermes", "dshDesktop"] as const;
  const all = Array.from({ length: 21 }, (_, index) => session(index, kinds[index % kinds.length]!));
  facts.catalog({ totalSessions: all.length, truncated: false, sessions: all,
    backends: kinds.map(kind => ({ kind, ready: true, complete: kind !== "hermes", sessions: 7, elapsedMs: 0 })) });
  const views = [[], ["hermes"], ["dshDesktop"], ["dshDesktop", "hermes"]] as const;
  for (const [index, hidden] of views.entries()) {
    const expected = all.filter(row => !hidden.some(kind => row.agentKind === kind));
    const first = facts.catalogRange({ limit: 2 }, hidden);
    expect(first).toMatchObject({ totalSessions: expected.length, sessions: expected.slice(0, 2), complete: hidden.some(kind => kind === "hermes") });
    const cursor = first.nextCursor!;
    expect(facts.catalogRange({ cursor, limit: 2 }, hidden)).toMatchObject({ offset: 2, sessions: expected.slice(2, 4) });
    views.forEach((other, otherIndex) => {
      if (index !== otherIndex) expect(facts.catalogRange({ cursor }, other).error).toBe("invalid_cursor");
    });
  }
});
