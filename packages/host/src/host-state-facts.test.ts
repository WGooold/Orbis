import { describe, expect, it } from "vitest";

import type { HostCatalogBackend, HostCatalogState } from "@pi-remote/protocol";

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

  it("还没有聚合过时目录领域不存在，读取返回 undefined", () => {
    const { facts } = setup();
    expect(facts.read()).toBeUndefined();
  });
});
