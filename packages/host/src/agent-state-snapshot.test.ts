import { describe, expect, it } from "vitest";

import { PROTOCOL_VERSION, type DomainSource } from "@pi-remote/protocol";

import { AgentStateRegistry, type StateScope } from "./agent-state-registry.js";
import { buildAgentStateSnapshot, buildAgentStateSnapshotParts } from "./agent-state-snapshot.js";

const HOST = "host-1";
const agentScope = (sessionId = "s1"): StateScope =>
  ({ kind: "agent", key: { hostId: HOST, agentKind: "codex", sessionId } });
const hostScope: StateScope = { kind: "host" };
const deviceScope = (deviceId = "phone-1"): StateScope => ({ kind: "device", key: { hostId: HOST, deviceId } });
const source = (sourceId = "adapter:codex"): DomainSource =>
  ({ producer: sourceId.startsWith("adapter") ? "adapter" : "host", sourceId, sourceEpoch: "e1", sourceRevision: 1 });
const ready = { availability: "ready", completeness: "complete" } as const;

const populate = (registry: AgentStateRegistry): void => {
  registry.commitValue(agentScope(), "execution", { ...ready, source: source(), value: { phase: "running" } });
  registry.commitValue(agentScope(), "model", { ...ready, source: source(), value: { provider: "openai", id: "gpt" } });
};

describe("buildAgentStateSnapshot", () => {
  it.each([false, true])("publishes execution first and separately from other domains (update=%s)", update => {
    const registry = new AgentStateRegistry();
    populate(registry);
    const parts = buildAgentStateSnapshotParts({ registry, requestId: "split", scope: agentScope(),
      identity: { runtimeId: "runtime", agentKind: "codex", sessionId: "s1" }, update });
    expect(parts.map(part => part.domains.map(domain => domain.domain))).toEqual([["execution"], ["model"]]);
    expect(parts.every(part => part.requestId === "split" && part.runtimeId === "runtime" && part.update === update && !part.truncated)).toBe(true);
  });
  it("keeps execution missing and unchanged results separate without losing other domain results", () => {
    const registry = new AgentStateRegistry({ modelEpoch: "model" });
    registry.commitValue(agentScope(), "model", { ...ready, source: source(), value: { id: "gpt" } });
    const input = { registry, requestId: "split", scope: agentScope(), domains: ["model", "execution", "live"] };
    const missing = buildAgentStateSnapshotParts(input);
    expect(missing).toHaveLength(2);
    expect(missing[0]).toMatchObject({ domains: [], missing: [{ domain: "execution", reason: "no_state" }] });
    expect(missing[1]).toMatchObject({ domains: [{ domain: "model" }], missing: [{ domain: "live", reason: "no_state" }] });
    registry.commitValue(agentScope(), "execution", { ...ready, source: source(), value: { phase: "idle" } });
    const unchanged = buildAgentStateSnapshotParts({ ...input, known: [{ domain: "execution", modelEpoch: "model", revision: 1 }] });
    expect(unchanged[0]).toMatchObject({ domains: [], missing: [], unchanged: ["execution"] });
    expect(unchanged[1]?.domains.map(domain => domain.domain)).toEqual(["model"]);
  });
  it("splits at domain boundaries so a large inventory cannot starve later domains", () => {
    const registry = new AgentStateRegistry({ maxValueBytes: 1024 * 1024 });
    registry.commitValue(hostScope, "catalog", { ...ready, source: source("host:catalog"), value: "x".repeat(300_000) });
    registry.commitValue(hostScope, "providers", { ...ready, source: source("host:providers"), value: { current: "p" } });
    const parts = buildAgentStateSnapshotParts({ registry, requestId: "large", scope: hostScope });
    expect(parts).toHaveLength(2);
    expect(parts.every(part => !part.truncated && part.domains.length === 1)).toBe(true);
    expect(parts.flatMap(part => part.domains.map(domain => domain.domain))).toEqual(["catalog", "providers"]);
  });
  it("返回该作用域已提交的全部领域，按名字排序并带各自 envelope", () => {
    const registry = new AgentStateRegistry({ modelEpoch: "model-1" });
    populate(registry);
    const snapshot = buildAgentStateSnapshot({
      registry, requestId: "r1", scope: agentScope(), identity: { agentKind: "codex", sessionId: "s1" },
    });
    expect(snapshot.type).toBe("agent.state.snapshot");
    // 跟着协议常量走：硬版本升级时这条断言要一起升，而不是留一个写死的旧值。
  expect(snapshot.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(snapshot.scope).toBe("agent");
    expect(snapshot.modelEpoch).toBe("model-1");
    expect(snapshot.domains.map(entry => entry.domain)).toEqual(["execution", "model"]);
    expect(snapshot.domains[0]).toMatchObject({ availability: "ready", completeness: "complete", revision: 1 });
    expect(snapshot.domains[0]?.value).toEqual({ phase: "running" });
    expect(snapshot.domains[0]?.source.sourceId).toBe("adapter:codex");
    expect(snapshot.missing).toEqual([]);
    expect(snapshot.truncated).toBe(false);
  });

  it("Host 作用域点 diagnostics 时读到记录目录（模块 23 的读取侧）", () => {
    const registry = new AgentStateRegistry({ modelEpoch: "model-1" });
    // completeness 由写入方（HostStateFacts）按「有没有缺口」决定，这里照它写下的形状提交。
    registry.commitValue(hostScope, "diagnostics", {
      availability: "ready",
      completeness: "partial",
      source: source("host:diagnostics"),
      value: { records: 2, dropped: 1, persistFailures: 0, oldestAt: 10, newestAt: 20, checkedAt: 30 },
    });

    const snapshot = buildAgentStateSnapshot({ registry, requestId: "r1", scope: hostScope, domains: ["diagnostics"] });

    expect(snapshot.missing).toEqual([]);
    // 淘汰过就是 partial：客户端据此知道手里那份不是全部历史。
    expect(snapshot.domains[0]).toMatchObject({ domain: "diagnostics", completeness: "partial" });
    expect(snapshot.domains[0]?.value).toMatchObject({ records: 2, dropped: 1 });
  });

  it("点名要的领域没有状态时报 no_state，名字不属于该作用域时报 unknown_domain", () => {
    const registry = new AgentStateRegistry({ modelEpoch: "model-1" });
    populate(registry);
    const snapshot = buildAgentStateSnapshot({
      registry, requestId: "r2", scope: agentScope(),
      domains: ["model", "interactions", "providers"],
    });
    expect(snapshot.domains.map(entry => entry.domain)).toEqual(["model"]);
    expect(snapshot.missing).toEqual([
      { domain: "interactions", reason: "no_state" },
      // providers 是 Host 级领域，问会话作用域要它是名字错了，不是「没有状态」。
      { domain: "providers", reason: "unknown_domain" },
    ]);
  });

  it("超出字节预算时按序截断并置 truncated，不装作完整", () => {
    const registry = new AgentStateRegistry({ modelEpoch: "model-1" });
    registry.commitValue(agentScope(), "execution", { ...ready, source: source(), value: { phase: "running" } });
    registry.commitValue(agentScope(), "live", { ...ready, source: source(), value: { text: "x".repeat(4_000) } });
    const snapshot = buildAgentStateSnapshot({
      registry, requestId: "r3", scope: agentScope(), maxBytes: 1_200,
    });
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.domains.map(entry => entry.domain)).toEqual(["execution"]);
  });

  it("Host 与设备作用域各自只认自己的领域", () => {
    const registry = new AgentStateRegistry({ modelEpoch: "model-1" });
    registry.commitValue(hostScope, "catalog", { ...ready, source: source("host:catalog"), value: { totalSessions: 2 } });
    registry.commitCollection(deviceScope(), "operations", { ...ready, source: source("host:device-operations"), items: { c1: { state: "success" } } });
    const hostSnapshot = buildAgentStateSnapshot({ registry, requestId: "r4", scope: hostScope, domains: ["catalog", "execution"] });
    expect(hostSnapshot.scope).toBe("host");
    expect(hostSnapshot.domains.map(entry => entry.domain)).toEqual(["catalog"]);
    expect(hostSnapshot.missing).toEqual([{ domain: "execution", reason: "unknown_domain" }]);

    const deviceSnapshot = buildAgentStateSnapshot({ registry, requestId: "r5", scope: deviceScope(), identity: {} });
    expect(deviceSnapshot.scope).toBe("device");
    expect(deviceSnapshot.domains.map(entry => entry.domain)).toEqual(["operations"]);
    expect(deviceSnapshot.domains[0]?.value).toEqual({ c1: { state: "success" } });
  });

  it("空作用域返回空 domains 而不是报错：这是「确实还没有状态」", () => {
    const registry = new AgentStateRegistry({ modelEpoch: "model-1" });
    const snapshot = buildAgentStateSnapshot({ registry, requestId: "r6", scope: agentScope("never-seen") });
    expect(snapshot.domains).toEqual([]);
    expect(snapshot.missing).toEqual([]);
    expect(snapshot.error).toBeUndefined();
    expect(snapshot.modelEpoch).toBe("model-1");
  });
});
