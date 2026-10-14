import { describe, expect, it, vi } from "vitest";

import type { AgentKey, DomainSource } from "@pi-remote/protocol";

import { AgentStateRegistry, type StateScope } from "./agent-state-registry.js";

const host: StateScope = { kind: "host" };
const agent = (sessionId = "s1"): StateScope => ({
  kind: "agent",
  key: { hostId: "host", agentKind: "codex", sessionId } satisfies AgentKey,
});
const device = (deviceId = "phone-1"): StateScope => ({ kind: "device", key: { hostId: "host", deviceId } });
const source = (over: Partial<DomainSource> = {}): DomainSource => ({
  producer: "adapter", sourceId: "codex:1", sourceEpoch: "e1", sourceRevision: 1, ...over,
});
const clock = (): (() => number) => { let now = 1_000; return () => { now += 1; return now; }; };
const ready = { availability: "ready", completeness: "complete" } as const;

describe("AgentStateRegistry 提交与版本", () => {
  it("首次提交登记唯一来源，并盖上当前模型代次", () => {
    const registry = new AgentStateRegistry({ modelEpoch: "model-1", now: clock() });
    const result = registry.commitValue(agent(), "execution", { ...ready, source: source(), value: { phase: "running" } });
    expect(result).toEqual({ ok: true, revision: 1, changed: true });
    const state = registry.read<{ phase: string }>(agent(), "execution");
    expect(state?.value?.phase).toBe("running");
    expect(state?.modelEpoch).toBe("model-1");
    expect(state?.source.sourceId).toBe("codex:1");
  });

  it("内容没变的心跳只刷新核对时间，不推进版本也不广播", () => {
    const registry = new AgentStateRegistry({ now: clock() });
    const listener = vi.fn();
    registry.subscribe(listener);
    const fact = { ...ready, source: source(), value: { phase: "running" } };
    registry.commitValue(agent(), "execution", fact);
    const before = registry.read(agent(), "execution");
    const second = registry.commitValue(agent(), "execution", fact);
    const after = registry.read(agent(), "execution");
    expect(second).toEqual({ ok: true, revision: 1, changed: false });
    expect(after?.revision).toBe(1);
    expect(after?.checkedAt).toBeGreaterThan(before?.checkedAt ?? 0);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("不同来源写同一领域被拒绝，且不影响已提交状态", () => {
    const registry = new AgentStateRegistry({ now: clock() });
    registry.commitValue(host, "providers", { ...ready, source: source({ producer: "host", sourceId: "host:1" }), value: { a: 1 } });
    const conflict = registry.commitValue(host, "providers", { ...ready, source: source({ producer: "host", sourceId: "host:2" }), value: { a: 2 } });
    expect(conflict.ok).toBe(false);
    expect(conflict).toMatchObject({ code: "source_conflict" });
    expect(registry.read<{ a: number }>(host, "providers")?.value?.a).toBe(1);
  });

  it("迟到的旧模型代次被拒绝", () => {
    const registry = new AgentStateRegistry({ now: clock() });
    const stale = registry.commitValue(agent(), "execution", {
      ...ready, source: source(), modelEpoch: "model-old", value: { phase: "running" },
    });
    expect(stale).toMatchObject({ ok: false, code: "stale_model_epoch" });
    expect(registry.read(agent(), "execution")).toBeUndefined();
  });

  it("Host 重建开新代次会清空投影并广播 reset", () => {
    const registry = new AgentStateRegistry({ modelEpoch: "model-1", now: clock() });
    const listener = vi.fn();
    registry.subscribe(listener);
    registry.commitValue(agent(), "execution", { ...ready, source: source(), value: { phase: "running" } });
    const next = registry.beginModelEpoch();
    expect(next).not.toBe("model-1");
    expect(registry.read(agent(), "execution")).toBeUndefined();
    expect(listener).toHaveBeenLastCalledWith({ kind: "reset", modelEpoch: next });
    expect(registry.stats().entries).toBe(0);
  });
});

describe("AgentStateRegistry 清单与缺席删除", () => {
  const items = (...ids: string[]): Record<string, unknown> => Object.fromEntries(ids.map(id => [id, { id }]));

  it("complete 清单整份替换，缺席条目被删除", () => {
    const registry = new AgentStateRegistry({ now: clock() });
    registry.commitCollection(agent(), "interactions", { ...ready, source: source(), items: items("a", "b") });
    registry.commitCollection(agent(), "interactions", { ...ready, source: source({ sourceRevision: 2 }), items: items("b") });
    expect(Object.keys(registry.read<Record<string, unknown>>(agent(), "interactions")?.value ?? {})).toEqual(["b"]);
  });

  it("partial 清单只合并，缺席条目保留", () => {
    const registry = new AgentStateRegistry({ now: clock() });
    registry.commitCollection(agent(), "interactions", { ...ready, source: source(), items: items("a", "b") });
    const merged = registry.commitCollection(agent(), "interactions", {
      source: source({ sourceRevision: 2 }), availability: "ready", completeness: "partial", items: items("c"),
    });
    expect(merged.ok).toBe(true);
    expect(Object.keys(registry.read<Record<string, unknown>>(agent(), "interactions")?.value ?? {}).sort()).toEqual(["a", "b", "c"]);
  });

  it("来源未知或失败时保留最后已知集合，并标明待核对", () => {
    const registry = new AgentStateRegistry({ now: clock() });
    registry.commitCollection(agent(), "delivery", { ...ready, source: source(), items: items("a") });
    registry.commitCollection(agent(), "delivery", {
      source: source({ sourceRevision: 2 }), availability: "unavailable", completeness: "unknown", items: {},
    });
    const state = registry.read<Record<string, unknown>>(agent(), "delivery");
    expect(Object.keys(state?.value ?? {})).toEqual(["a"]);
    expect(state?.availability).toBe("unavailable");
    expect(state?.completeness).toBe("unknown");
  });

  it("来源换代次必须用完整清单重建基线", () => {
    const registry = new AgentStateRegistry({ now: clock() });
    registry.commitCollection(agent(), "interactions", { ...ready, source: source(), items: items("a") });
    const rejected = registry.commitCollection(agent(), "interactions", {
      source: source({ sourceEpoch: "e2", sourceRevision: 0 }), availability: "ready", completeness: "partial", items: items("b"),
    });
    expect(rejected).toMatchObject({ ok: false, code: "source_epoch_baseline_required" });
    expect(Object.keys(registry.read<Record<string, unknown>>(agent(), "interactions")?.value ?? {})).toEqual(["a"]);
    const accepted = registry.commitCollection(agent(), "interactions", {
      source: source({ sourceEpoch: "e2", sourceRevision: 0 }), ...ready, items: items("b"),
    });
    expect(accepted.ok).toBe(true);
    expect(Object.keys(registry.read<Record<string, unknown>>(agent(), "interactions")?.value ?? {})).toEqual(["b"]);
  });

  it("设备视图与 Host / 会话作用域互相隔离", () => {
    const registry = new AgentStateRegistry({ now: clock() });
    const source = { producer: "host", sourceId: "host:1", sourceEpoch: "e1", sourceRevision: 1 } as const;
    registry.commitCollection(device("phone-1"), "notifications", { ...ready, source, items: { n1: { dismissed: true } } });
    registry.commitCollection(device("phone-2"), "notifications", { ...ready, source, items: {} });
    registry.commitCollection(host, "catalog", { ...ready, source, items: {} });
    expect(registry.read(device("phone-1"), "notifications")).toBeDefined();
    expect(registry.endScope(device("phone-1"))).toBe(1);
    expect(registry.read(device("phone-1"), "notifications")).toBeUndefined();
    expect(registry.read(device("phone-2"), "notifications")).toBeDefined();
    expect(registry.read(host, "catalog")).toBeDefined();
  });

  it("终结作用域只清自己的领域", () => {
    const registry = new AgentStateRegistry({ now: clock() });
    registry.commitCollection(agent("s1"), "interactions", { ...ready, source: source(), items: items("a") });
    registry.commitCollection(agent("s2"), "interactions", { ...ready, source: source(), items: items("b") });
    registry.commitValue(host, "catalog", { ...ready, source: source({ producer: "host", sourceId: "host:1" }), value: { sessions: 1 } });
    expect(registry.endScope(agent("s1"))).toBe(1);
    expect(registry.read(agent("s1"), "interactions")).toBeUndefined();
    expect(registry.read(agent("s2"), "interactions")).toBeDefined();
    expect(registry.read(host, "catalog")).toBeDefined();
  });
});

describe("AgentStateRegistry 基线读取与边界", () => {
  it("按已应用版本决定 unchanged / state / baseline", () => {
    const registry = new AgentStateRegistry({ modelEpoch: "model-1", now: clock() });
    expect(registry.readForBaseline(agent(), "capabilities", { modelEpoch: "model-1", revision: 1 }).action).toBe("baseline");
    registry.commitValue(agent(), "capabilities", {
      source: source(), availability: "unknown", completeness: "unknown", value: null,
    });
    expect(registry.readForBaseline(agent(), "capabilities").action).toBe("baseline");
    registry.commitValue(agent(), "capabilities", { ...ready, source: source({ sourceRevision: 2 }), value: { commands: [] } });
    expect(registry.readForBaseline(agent(), "capabilities", { modelEpoch: "model-1", revision: 2 }).action).toBe("unchanged");
    expect(registry.readForBaseline(agent(), "capabilities", { modelEpoch: "model-1", revision: 0 }).action).toBe("state");
    expect(registry.readForBaseline(agent(), "capabilities", { modelEpoch: "model-old", revision: 2 }).action).toBe("state");
  });

  it("超过值预算与条目上限的提交被拒绝", () => {
    const budget = new AgentStateRegistry({ now: clock(), maxValueBytes: 120 });
    const tooLarge = budget.commitValue(agent(), "live", { ...ready, source: source(), value: { text: "x".repeat(400) } });
    expect(tooLarge).toMatchObject({ ok: false, code: "value_too_large" });
    expect(budget.read(agent(), "live")).toBeUndefined();

    const bounded = new AgentStateRegistry({ now: clock(), maxEntries: 1 });
    expect(bounded.commitValue(agent("s1"), "execution", { ...ready, source: source(), value: 1 }).ok).toBe(true);
    expect(bounded.commitValue(agent("s2"), "execution", { ...ready, source: source(), value: 1 })).toMatchObject({ ok: false, code: "registry_full" });
    expect(bounded.commitValue(agent("s1"), "context", { ...ready, source: source(), value: 1 })).toMatchObject({ ok: false, code: "registry_full" });
  });

  it("非法事实在进入写入路径前被拒绝", () => {
    const registry = new AgentStateRegistry({ now: clock() });
    const bad = registry.commitValue(agent(), "execution", {
      availability: "ready", completeness: "complete",
      source: { producer: "adapter", sourceId: "  ", sourceEpoch: "e1", sourceRevision: 0 }, value: null,
    });
    expect(bad).toMatchObject({ ok: false, code: "invalid_fact" });
    expect(registry.stats().entries).toBe(0);
  });

  it("先提交再发布：订阅者读到已提交状态，抛错的订阅者不影响提交", () => {
    const registry = new AgentStateRegistry({ now: clock() });
    const seen: Array<number | undefined> = [];
    registry.subscribe(() => { throw new Error("subscriber boom"); });
    registry.subscribe(change => {
      if (change.kind === "committed") seen.push(registry.read<{ phase: string }>(agent(), "execution")?.revision);
    });
    const result = registry.commitValue(agent(), "execution", { ...ready, source: source(), value: { phase: "running" } });
    expect(result).toMatchObject({ ok: true, revision: 1 });
    expect(seen).toEqual([1]);
  });

  it("读取返回值是副本，外部改动不会污染已提交投影", () => {
    const registry = new AgentStateRegistry({ now: clock() });
    registry.commitValue(agent(), "model", { ...ready, source: source(), value: { id: "gpt", options: ["a"] } });
    const first = registry.read<{ id: string; options: string[] }>(agent(), "model");
    first!.value!.options.push("b");
    first!.value!.id = "mutated";
    const second = registry.read<{ id: string; options: string[] }>(agent(), "model");
    expect(second?.value).toEqual({ id: "gpt", options: ["a"] });
  });

  it("提交在写者上是同步原子的，订阅者内再提交也不会交错", () => {
    const registry = new AgentStateRegistry({ now: clock() });
    const order: string[] = [];
    registry.subscribe(change => {
      if (change.kind !== "committed" || change.domain !== "execution") return;
      order.push("outer:" + change.state.revision);
      if (change.state.revision === 1) {
        registry.commitValue(agent(), "delivery", { ...ready, source: source(), value: { queued: 0 } });
      }
    });
    registry.subscribe(change => { if (change.kind === "committed") order.push("inner:" + change.domain + ":" + change.state.revision); });
    registry.commitValue(agent(), "execution", { ...ready, source: source(), value: { phase: "running" } });
    expect(order).toEqual(["outer:1", "inner:execution:1", "inner:delivery:1"]);
    expect(registry.read(agent(), "delivery")?.revision).toBe(1);
  });
});

describe("AgentStateRegistry 来源水位与显式结束", () => {
  it("只有来源水位变化不推进内容版本", () => {
    const registry = new AgentStateRegistry({ now: clock() });
    registry.commitValue(agent(), "execution", { ...ready, source: source({ sourceRevision: 1 }), value: { phase: "running" } });
    const result = registry.commitValue(agent(), "execution", { ...ready, source: source({ sourceRevision: 9 }), value: { phase: "running" } });
    expect(result).toEqual({ ok: true, revision: 1, changed: false });
    expect(registry.read(agent(), "execution")?.source.sourceRevision).toBe(9);
  });

  it("换代次后标记待核对仍然允许，并保留最后已知值", () => {
    const registry = new AgentStateRegistry({ now: clock() });
    registry.commitValue(agent(), "execution", { ...ready, source: source(), value: { phase: "running" } });
    const unverified = registry.commitValue(agent(), "execution", {
      source: source({ sourceEpoch: "e2", sourceRevision: 0 }), availability: "unknown", completeness: "unknown", value: null,
    });
    expect(unverified.ok).toBe(true);
    const state = registry.read<{ phase: string }>(agent(), "execution");
    expect(state?.availability).toBe("unknown");
    expect(state?.value?.phase).toBe("running");
    expect(state?.source.sourceEpoch).toBe("e2");
    // 新代次里必须用完整清单重建基线，之后才恢复正常提交。
    expect(registry.commitValue(agent(), "execution", {
      source: source({ sourceEpoch: "e2" }), availability: "ready", completeness: "partial", value: { phase: "idle" },
    }).ok).toBe(true);
    const rebuilt = registry.commitValue(agent(), "execution", {
      source: source({ sourceEpoch: "e2" }), ...ready, value: { phase: "idle" },
    });
    expect(rebuilt.ok).toBe(true);
    const baselined = registry.read<{ phase: string }>(agent(), "execution");
    expect(baselined?.availability).toBe("ready");
    expect(baselined?.value?.phase).toBe("idle");
  });

  it("换代次的那一次 ready 提交必须是完整清单", () => {
    const registry = new AgentStateRegistry({ now: clock() });
    registry.commitValue(agent(), "execution", { ...ready, source: source(), value: { phase: "running" } });
    const rejected = registry.commitValue(agent(), "execution", {
      source: source({ sourceEpoch: "e2" }), availability: "ready", completeness: "partial", value: { phase: "idle" },
    });
    expect(rejected).toMatchObject({ ok: false, code: "source_epoch_baseline_required" });
    expect(registry.read<{ phase: string }>(agent(), "execution")?.value?.phase).toBe("running");
  });

  it("显式结束事实只删除列出的条目", () => {
    const registry = new AgentStateRegistry({ now: clock() });
    registry.commitCollection(agent(), "interactions", { ...ready, source: source(), items: { a: { id: "a" }, b: { id: "b" } } });
    const removed = registry.removeCollectionItems(agent(), "interactions", {
      source: source({ sourceRevision: 2 }), availability: "ready", completeness: "partial", removeIds: ["a"],
    });
    expect(removed.ok).toBe(true);
    expect(Object.keys(registry.read<Record<string, unknown>>(agent(), "interactions")?.value ?? {})).toEqual(["b"]);
    expect(registry.removeCollectionItems(agent(), "interactions", {
      source: source(), availability: "ready", completeness: "partial", removeIds: [""],
    })).toMatchObject({ ok: false, code: "invalid_fact" });
  });
});
