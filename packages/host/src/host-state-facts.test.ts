import { describe, expect, it } from "vitest";

import type { HostCatalogBackend, HostCatalogState } from "@orbis/protocol";

import { AgentStateRegistry } from "./agent-state-registry.js";
import { HostStateFacts } from "./host-state-facts.js";

const setup = () => {
  const registry = new AgentStateRegistry({ modelEpoch: "model-1" });
  let now = 1_000;
  const facts = new HostStateFacts({ registry, now: () => ++now });
  return { registry, facts };
};

const backend = (over: Partial<HostCatalogBackend> = {}): HostCatalogBackend =>
  ({ kind: "pi", ready: true, sessions: 3, complete: true, elapsedMs: 5, ...over });

const state = (registry: AgentStateRegistry) => registry.read<HostCatalogState>({ kind: "host" }, "catalog");

describe("HostStateFacts 目录完整性", () => {
  it("全部后端读全且未截断时才是完整目录", () => {
    const { registry, facts } = setup();
    facts.catalog({ totalSessions: 3, truncated: false, backends: [backend()] });
    const catalog = state(registry);
    expect(catalog?.availability).toBe("ready");
    expect(catalog?.completeness).toBe("complete");
    expect(catalog?.value?.totalSessions).toBe(3);
    expect(facts.read()?.checkedAt).toBeGreaterThan(0);
  });

  it("任一后端读失败就不是完整清单，并留下原因", () => {
    const { registry, facts } = setup();
    facts.catalog({
      totalSessions: 3, truncated: false,
      backends: [backend(), backend({ kind: "codex", sessions: 0, complete: false, error: "catalog failed" })],
    });
    const catalog = state(registry);
    expect(catalog?.completeness).toBe("partial");
    expect(catalog?.value?.backends[1]).toMatchObject({ kind: "codex", complete: false, error: "catalog failed" });
  });

  it("后端没就绪与结果被截断都降级为部分清单", () => {
    const { registry, facts } = setup();
    facts.catalog({ totalSessions: 0, truncated: false, backends: [backend({ kind: "dsh", ready: false, sessions: 0, complete: false })] });
    expect(state(registry)?.completeness).toBe("partial");
    facts.catalog({ totalSessions: 2_000, truncated: true, backends: [backend({ sessions: 2_500 })] });
    const truncated = state(registry);
    expect(truncated?.completeness).toBe("partial");
    expect(truncated?.value?.truncated).toBe(true);
  });

  it("协商后的 Codex 投影不依赖隐藏来源，目录查询、供应商筛选和旧更新均保留统一库存", () => {
    const { registry, facts } = setup();
    const terminal = { sessionId: "native-thread", cwd: "/fixture", createdAt: 1, modifiedAt: 10, messageCount: 4,
      agentKind: "codex" as const, hostname: "host", modelProvider: "openai" };
    const desktop = { ...terminal, sessionId: "codex-desktop:native-thread", agentKind: "codexDesktop" as const, modifiedAt: 11 };
    const unified = { ...terminal, sessionId: `codex-history:${"a".repeat(64)}`, agentKind: "codex" as const,
      modifiedAt: 12, codexLaunchModes: ["desktop" as const, "terminal" as const] };
    const base = { totalSessions: 2, truncated: false, backends: [
      backend({ kind: "codex", sessions: 1 }), backend({ kind: "codexDesktop", sessions: 1 }),
    ], sessions: [terminal, desktop], currentProviders: [
      { agentKind: "codex" as const, provider: "openai" }, { agentKind: "codexDesktop" as const, provider: "openai" },
    ] };
    facts.catalog(base, { sessions: [unified], complete: true, ready: true });

    const page = facts.catalogRange({}, undefined, true);
    expect(page.sessions.map(row => row.sessionId)).toEqual([unified.sessionId]);
    expect(page.sessions[0]).toMatchObject({ agentKind: "codex", codexLaunchModes: ["desktop", "terminal"] });

    const queried = facts.catalogQuery({ type: "session.catalog.query", requestId: "q", format: "v1",
      query: { text: "fixture", agentKind: "codex", archived: false, provider: "current" }, cursor: null, limit: 20 }, undefined, true);
    expect(queried.page.sessions.map(row => row.sessionId)).toEqual([unified.sessionId]);
    expect(queried.providers).toEqual(["openai"]);

    // Stale per-source filter selections are folded into the one Codex family.
    const staleFilter = facts.catalogQuery({ type: "session.catalog.query", requestId: "q-old-filter", format: "v1",
      query: { text: "", agentKind: "codexDesktop", archived: false, provider: "all" }, cursor: null, limit: 20 }, undefined, true);
    expect(staleFilter.page.sessions.map(row => row.sessionId)).toEqual([unified.sessionId]);
    expect(staleFilter.providers).toEqual(["openai"]);

    const committed = registry.read<HostCatalogState>({ kind: "host" }, "catalog")!.value!;
    const hidden = facts.hiddenCatalog(committed as unknown as Record<string, unknown>, [], true);
    expect((hidden.sessions as { sessionId: string }[]).map(row => row.sessionId)).toEqual([unified.sessionId]);

    // A later ordinary projection update does not own the negotiated inventory and
    // therefore cannot erase the canonical rows used by devices that negotiated it.
    facts.catalog({ ...base, totalSessions: 3, sessions: [...base.sessions, {
      ...terminal, sessionId: "pi-session", agentKind: "pi" as const, modelProvider: undefined,
    }] });
    expect(facts.catalogView([], true).sessions?.map(row => row.sessionId).sort())
      .toEqual([unified.sessionId, "pi-session"].sort());
  });
  it("还没有聚合过时目录领域不存在，读取返回 undefined", () => {
    const { facts } = setup();
    expect(facts.read()).toBeUndefined();
  });
});
