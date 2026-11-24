import { describe, expect, it } from "vitest";
import { type AgentSessionSummary, type CatalogQueryRequest, type HostCatalogState } from "@orbis/protocol";
import { AgentStateRegistry } from "./agent-state-registry.js";
import { CompactStateModel } from "./compact-state-model.js";
import { agentViews, allowsAgent, allowsAgentRequest, deviceAgentView, hiddenKinds, policyAgentViews, projectAgentMessage } from "./device-agent-visibility.js";
import { HostStateFacts } from "./host-state-facts.js";

const kinds = ["pi", "dshDesktop", "kimiCode", "kimiCodeDesktop", "openclaw", "hermes"] as const;
const row = (index: number): AgentSessionSummary => ({ agentKind: kinds[index % kinds.length]!, sessionId: `s${index}`,
  cwd: `/isolated/${index % 6}`, hostname: "fixture", createdAt: 1, modifiedAt: 200 - index, messageCount: 0, firstMessage: "a".repeat(900) });

describe("KIMI-06 negotiated device projections", () => {
  it("isolates Kimi Web and Desktop sessions and requests by their declared features", () => {
    const webOnly = deviceAgentView(new Set(["agent.kimiCode"]));
    const both = deviceAgentView(new Set(["agent.kimiCode", "agent.kimiCodeDesktop"]));
    const web = { agentKind: "kimiCode", runtimeId: "kimi-code:web-root:session_one", sessionId: "kimi-code:web-root:session_one" };
    const desktop = { agentKind: "kimiCodeDesktop", runtimeId: "kimi-code-desktop:desktop-root:session_one", sessionId: "kimi-code-desktop:desktop-root:session_one" };
    expect(allowsAgentRequest(webOnly, { type: "session.activate", target: { type: "resume", ...web } })).toBe(true);
    expect(allowsAgentRequest(webOnly, { type: "session.activate", target: { type: "resume", ...desktop } })).toBe(false);
    expect(allowsAgentRequest(both, { type: "session.activate", target: { type: "resume", ...desktop } })).toBe(true);
    expect(projectAgentMessage(webOnly, { type: "runtime.online", runtime: desktop })).toBeUndefined();
    expect(projectAgentMessage(both, { type: "runtime.online", runtime: desktop })).toEqual({ type: "runtime.online", runtime: desktop });
  });

  it("keeps negotiated snapshot projections, compact baselines, query totals and continuation cursors separate", () => {
    const scope = { kind: "host" } as const;
    const registry = new AgentStateRegistry();
    const facts = new HostStateFacts({ registry });
    const projection = (view: (typeof agentViews)[number], value: unknown) => facts.hiddenCatalog(value as Record<string, unknown>, hiddenKinds(view));
    const compact = new CompactStateModel(registry, value => new Map(agentViews.filter(view => view !== 0).map(view => [view, projection(view, value)])));
    compact.ensure(scope);
    const all = Array.from({ length: 120 }, (_, index) => row(index));
    const commit = (sessions: AgentSessionSummary[]) => facts.catalog({ totalSessions: sessions.length, truncated: false, sessions,
      backends: kinds.map(kind => ({ kind, ready: true, complete: true, sessions: sessions.filter(item => item.agentKind === kind).length, elapsedMs: 1 })) });
    commit(all);
    const known = compact.registry.read<HostCatalogState>(scope, "catalog")!;
    const request: CatalogQueryRequest = { type: "session.catalog.query", requestId: "query", format: "v1", cursor: null, limit: 1,
      query: { text: "", agentKind: null, archived: false, provider: "all" } };
    for (const view of agentViews) {
      const visible = all.filter(item => allowsAgent(view, item.agentKind));
      const header = projection(view, known.value) as HostCatalogState;
      expect(header.totalSessions).toBe(visible.length);
      const catalog = facts.catalogRange({ limit: 1 }, hiddenKinds(view));
      const query = facts.catalogQuery(request, hiddenKinds(view));
      expect(query.page.totalSessions).toBe(visible.length);
      expect(query.directoryCount).toBe(new Set(visible.map(item => item.cwd)).size);
      for (const other of agentViews.filter(value => value !== view)) {
        expect(facts.catalogRange({ cursor: catalog.nextCursor }, hiddenKinds(other)).error).toBe("invalid_cursor");
        expect(facts.catalogQuery({ ...request, cursor: query.page.nextCursor }, hiddenKinds(other)).page.error).toBe("invalid_cursor");
      }
      const collected = [...header.sessions!];
      for (let cursor = header.nextCursor; cursor;) {
        const page = facts.catalogRange({ cursor, limit: 5 }, hiddenKinds(view));
        expect(page).toMatchObject({ offset: collected.length, totalSessions: visible.length, complete: true });
        collected.push(...page.sessions); cursor = page.nextCursor;
      }
      expect(collected).toEqual(visible);
    }
    commit(all.slice(1));
    for (const view of agentViews) {
      const retained = compact.catalogBaseline(known.modelEpoch, known.revision, view)!;
      expect(retained.value).toMatchObject({ totalSessions: all.filter(item => allowsAgent(view, item.agentKind)).length });
      const cursor = (retained.value as HostCatalogState).nextCursor;
      expect(facts.catalogRange({ cursor }, hiddenKinds(view)).error).toBe("snapshot_changed");
    }
    compact.close();
  });

  it("projects Host-disabled sources even for released clients without a feature declaration", () => {
    const disabled = new Set(["dsh", "codex"] as const);
    const view = deviceAgentView(undefined, disabled);
    expect(hiddenKinds(view)).toEqual(expect.arrayContaining(["dsh", "codex"]));
    expect(policyAgentViews(disabled)).toContain(view);
    expect(policyAgentViews(disabled).length).toBeLessThanOrEqual(agentViews.length + 1);
    expect(allowsAgentRequest(view, { type: "session.activate", target: { type: "resume", sessionId: "dsh:cached" } })).toBe(false);
    expect(allowsAgentRequest(view, { type: "runtime.command", runtimeId: "codex:cached" })).toBe(false);
    expect(projectAgentMessage(view, { type: "device.ready", agents: ["pi", "codex", "dsh"], runtimes: [{ runtimeId: "dsh:cached" }] }))
      .toMatchObject({ agents: ["pi"], runtimes: [] });
  });

  it("rejects envelope identities without filtering the user's text", () => {
    const runtimeId = "kimi-code:fixture:session_one";
    for (const message of [
      { type: "session.activate", target: { type: "resume", sessionId: runtimeId } },
      { type: "session.activate", target: { type: "new", agentKind: "kimiCode", cwd: "/test" } },
      { type: "session.catalog.query", query: { agentKind: "kimiCode" } },
      { type: "file.upload.init", runtimeId },
      { type: "runtime.command", runtimeId: "other", command: { sessionId: runtimeId } },
      { type: "agent.state.request", agentKind: "kimiCode", sessionId: runtimeId },
      { type: "diagnostics.request", agentKind: "kimiCode" },
      { type: "transport.fields.read", backend: "kimiCode" },
    ]) expect(allowsAgentRequest(3, message)).toBe(false);
    expect(allowsAgentRequest(3, { type: "runtime.command", runtimeId: "pi", command: { type: "user_message", text: runtimeId } })).toBe(true);
    expect(projectAgentMessage(1, { type: "runtime.online", runtime: { runtimeId } })).toBeUndefined();
    expect(projectAgentMessage(1, { type: "session.archive.changed", agentKind: "kimiCode", sessionId: runtimeId })).toBeUndefined();
    expect(projectAgentMessage(1, { type: "notifications.snapshot", runtimeId })).toBeUndefined();
  });
});
