import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  AgentKeySchema, agentKeyId, domainStateConfirmsAbsence, domainStateSchema,
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

  it("只承认 ready + complete 的缺席证明", () => {
    expect(domainStateConfirmsAbsence({ availability: "ready", completeness: "complete" })).toBe(true);
    expect(domainStateConfirmsAbsence({ availability: "ready", completeness: "partial" })).toBe(false);
    expect(domainStateConfirmsAbsence({ availability: "unknown", completeness: "complete" })).toBe(false);
    expect(domainStateConfirmsAbsence({ availability: "unavailable", completeness: "partial" })).toBe(false);
  });
});
