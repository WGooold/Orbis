import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  AgentKeySchema, AgentStateRequestSchema, AgentStateSnapshotSchema, agentKeyId, domainStateConfirmsAbsence,
  domainStateSchema,
} from "./agent-state.js";

const source = { producer: "adapter" as const, sourceId: "codex:1", sourceEpoch: "epoch-a", sourceRevision: 3 };
const noticeSchema = domainStateSchema(z.array(z.strictObject({ id: z.string(), message: z.string() })));

describe("Agent 状态模型身份", () => {
  it("接受四个接入 kind，并保留 identity 校验", () => {
    expect(AgentKeySchema.parse({ hostId: "host", agentKind: "pi", sessionId: "s" }).agentKind).toBe("pi");
    expect(AgentKeySchema.parse({ hostId: "host", agentKind: "codexDesktop", sessionId: "s" }).agentKind).toBe("codexDesktop");
    expect(() => AgentKeySchema.parse({ hostId: "host", agentKind: "claude", sessionId: "s" })).toThrow();
    expect(() => AgentKeySchema.parse({ hostId: "   ", agentKind: "pi", sessionId: "s" })).toThrow();
    expect(() => AgentKeySchema.parse({ hostId: "host", agentKind: "pi", sessionId: "s", runtimeId: "r" })).toThrow();
  });

  it("会话身份区分 host 与 kind，且不含可更换的 runtimeId", () => {
    const base = { hostId: "host", agentKind: "codex" as const, sessionId: "session" };
    expect(agentKeyId(base)).toBe(agentKeyId({ ...base }));
    expect(agentKeyId(base)).not.toBe(agentKeyId({ ...base, agentKind: "codexDesktop" }));
    expect(agentKeyId(base)).not.toBe(agentKeyId({ ...base, hostId: "other" }));
  });
});

describe("领域 envelope", () => {
  it("接受带来源、版本与核对时间的领域状态", () => {
    const parsed = noticeSchema.parse({
      modelEpoch: "model-1", revision: 2, availability: "ready", completeness: "complete",
      source, checkedAt: 1_700_000_000_000, value: [{ id: "n1", message: "沙箱需要配置" }],
    });
    expect(parsed.value?.[0]?.id).toBe("n1");
  });

  it("拒绝未知字段、非法枚举与负版本", () => {
    const base = {
      modelEpoch: "model-1", revision: 0, availability: "ready", completeness: "complete",
      source, checkedAt: 1, value: null,
    };
    expect(() => noticeSchema.parse({ ...base, extra: true })).toThrow();
    expect(() => noticeSchema.parse({ ...base, availability: "stale" })).toThrow();
    expect(() => noticeSchema.parse({ ...base, revision: -1 })).toThrow();
    expect(() => noticeSchema.parse({ ...base, source: { ...source, producer: "relay" } })).toThrow();
  });

  it("模型读取的请求与应答都是严格 schema", () => {
    // 线上消息由协议层补 protocolVersion；负载本身不认识这个字段。
    const wireRequest = AgentStateRequestSchema.safeExtend({ protocolVersion: z.literal(12) });
    const request = wireRequest.parse({ type: "agent.state.request", protocolVersion: 12, requestId: "r", sessionId: "s", agentKind: "codex", domains: ["execution"] });
    expect(request.domains).toEqual(["execution"]);
    expect(() => wireRequest.parse({ type: "agent.state.request", protocolVersion: 12, requestId: "r", extra: 1 })).toThrow();
    expect(() => AgentStateRequestSchema.parse({ type: "agent.state.request", protocolVersion: 12, requestId: "r" })).toThrow();

    const snapshot = AgentStateSnapshotSchema.safeExtend({ protocolVersion: z.literal(12) }).parse({
      type: "agent.state.snapshot", protocolVersion: 12, requestId: "r", scope: "agent", modelEpoch: "m",
      domains: [{ domain: "execution", modelEpoch: "m", revision: 1, availability: "ready", completeness: "complete", source, checkedAt: 1, value: { phase: "idle" } }],
      missing: [{ domain: "live", reason: "no_state" }], truncated: false,
    });
    expect(snapshot.domains[0]?.domain).toBe("execution");
    // 作用域之外的错误原因必须被拒绝：客户端只认这几种。
    expect(() => AgentStateSnapshotSchema.parse({
      type: "agent.state.snapshot", requestId: "r", scope: "agent", modelEpoch: null, domains: [],
      missing: [{ domain: "live", reason: "whatever" }], truncated: false,
    })).toThrow();
  });

  it("只承认 ready + complete 的缺席证明", () => {
    expect(domainStateConfirmsAbsence({ availability: "ready", completeness: "complete" })).toBe(true);
    expect(domainStateConfirmsAbsence({ availability: "ready", completeness: "partial" })).toBe(false);
    expect(domainStateConfirmsAbsence({ availability: "unknown", completeness: "complete" })).toBe(false);
    expect(domainStateConfirmsAbsence({ availability: "unavailable", completeness: "partial" })).toBe(false);
  });
});
