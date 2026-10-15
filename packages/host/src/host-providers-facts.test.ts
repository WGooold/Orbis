import { describe, expect, it } from "vitest";

import { AgentStateRegistry } from "./agent-state-registry.js";
import { HostStateFacts, providerSwitchingFact } from "./host-state-facts.js";

const summary = (over: Partial<Parameters<HostStateFacts["providers"]>[0]["providers"][number]> = {}) => ({
  agentKind: "codex" as const,
  current: "custom",
  profiles: [{ id: "custom", name: "Custom", enabled: true, globalDefault: true }],
  authenticated: true,
  switching: false,
  usage: { availability: "unknown" as const, detail: null },
  ...over,

});

describe("HostStateFacts.providers", () => {
  it("把供应商摘要写进 HostState.providers，并带上核对时点", () => {
    const registry = new AgentStateRegistry();
    const facts = new HostStateFacts({ registry, now: () => 1_700_000_000_000 });

    facts.providers({ providers: [summary()] });

    const state = facts.readProviders();
    expect(state?.providers).toHaveLength(1);
    expect(state?.providers[0]).toMatchObject({ agentKind: "codex", current: "custom", authenticated: true });
    expect(state?.checkedAt).toBe(1_700_000_000_000);
  });

  it("一个后端都没有时是 unknown，而不是「这台电脑没有供应商」", () => {
    const registry = new AgentStateRegistry();
    const facts = new HostStateFacts({ registry });

    facts.providers({ providers: [] });

    expect(registry.read({ kind: "host" }, "providers")?.availability).toBe("unknown");
  });

  it("拿不到用量事实时保留 unknown，不用 0 冒充已确认", () => {
    const registry = new AgentStateRegistry();
    const facts = new HostStateFacts({ registry });

    facts.providers({ providers: [summary({ usage: { availability: "unknown", detail: "供应商未报配额" } })] });

    expect(facts.readProviders()?.providers[0]?.usage).toEqual({
      availability: "unknown",
      detail: "供应商未报配额",
    });
  });

  it("摘要内容不变时不推进领域版本", () => {
    const registry = new AgentStateRegistry();
    const facts = new HostStateFacts({ registry, now: () => 1 });
    const scope = { kind: "host" } as const;

    facts.providers({ providers: [summary()] });
    const first = registry.read(scope, "providers")?.revision;
    facts.providers({ providers: [summary()] });

    // checkedAt 变了但内容口径不变：版本不因心跳式刷新而推进。
    expect(registry.read(scope, "providers")?.revision).toBe(first);
  });
});

describe("providerSwitchingFact", () => {
  it("只有 Host 自己正在切换的那个后端才是 true，其余是未核对而不是 false", () => {
    expect(providerSwitchingFact("dsh", "dsh")).toBe(true);
    // 没在切换不等于没有切换：桌面端可以在带外改配置，所以是 null（未核对）。
    expect(providerSwitchingFact("dsh", "codex")).toBeNull();
    expect(providerSwitchingFact(undefined, "pi")).toBeNull();
  });
});

