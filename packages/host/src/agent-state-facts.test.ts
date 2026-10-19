import { describe, expect, it } from "vitest";

import type {
  AgentDeliveryItem, AgentExecutionState, AgentModelState, AgentNotificationsState, AgentPermissionsState,
  InteractionRequest, RuntimeEvent, RuntimeMetadata,
} from "@pi-remote/protocol";

import { AgentStateFacts } from "./agent-state-facts.js";
import { AgentStateRegistry, type StateDomain, type StateScope } from "./agent-state-registry.js";

const HOST = "host-1";
const kinds: Record<string, "codex" | "pi"> = { "codex:r1": "codex", "codex:r2": "codex", "pi:r1": "pi" };

const setup = () => {
  const registry = new AgentStateRegistry({ modelEpoch: "model-1" });
  const facts = new AgentStateFacts({ registry, hostId: HOST, kindOf: (runtimeId) => kinds[runtimeId] });
  return { registry, facts };
};

const metadata = (over: Partial<RuntimeMetadata> = {}, runtimeId = "codex:r1"): RuntimeEvent => ({
  type: "runtime.metadata",
  metadata: { runtimeId, name: "Codex", cwd: "D:/repo", status: "idle", sessionId: "s1", ...over },
});

const queued = (queueId: string, state: AgentDeliveryItem["state"] = "accepted"): RuntimeEvent => ({
  type: "message.queued", queueId, text: "继续", delivery: "followUp", state,
});

const request = (requestId: string): InteractionRequest => ({
  kind: "confirm", runtimeId: "codex:r1", requestId, extensionId: "ext", title: "允许执行？",
  expiresAt: 1_800_000_000_000,
});

const scope = (sessionId = "s1", agentKind: "codex" | "pi" = "codex"): StateScope =>
  ({ kind: "agent", key: { hostId: HOST, agentKind, sessionId } });

const read = <T>(registry: AgentStateRegistry, domain: StateDomain, sessionId = "s1", agentKind: "codex" | "pi" = "codex") =>
  registry.read<T>(scope(sessionId, agentKind), domain);

describe("AgentStateFacts 运行 / 模型 / 上下文", () => {
  it("metadata 建立身份并提交运行、模型与上下文事实", () => {
    const { registry, facts } = setup();
    facts.observe("codex:r1", metadata({
      status: "running", model: { provider: "openai", id: "gpt-5" }, thinkingLevel: "high",
      contextUsage: { tokens: 100, contextWindow: 1_000, percent: 10 },
    }));
    const execution = read<AgentExecutionState>(registry, "execution");
    expect(execution?.availability).toBe("ready");
    expect(execution?.value).toEqual({ phase: "running", waitingFor: [], retry: "unavailable", compaction: "unavailable", turn: null });
    expect(read<AgentModelState>(registry, "model")?.value).toEqual({ provider: "openai", id: "gpt-5", thinkingLevel: "high" });
    expect(read<{ contextWindow: number }>(registry, "context")?.value?.contextWindow).toBe(1_000);
  });

  it("后端没报模型或上下文时是整个领域 unknown，不是空值冒充", () => {
    const { registry, facts } = setup();
    facts.observe("codex:r1", metadata());
    expect(read(registry, "model")?.availability).toBe("unknown");
    expect(read(registry, "model")?.value).toBeNull();
    expect(read(registry, "context")?.availability).toBe("unknown");
    facts.observe("codex:r1", metadata({ model: { provider: "custom", id: "m" } }));
    expect(read(registry, "model")?.availability).toBe("ready");
  });

  it("身份建立前到达的事实先缓冲，metadata 到达后立即生效", () => {
    const { registry, facts } = setup();
    facts.observe("codex:r1", { type: "runtime.status", status: "running" });
    expect(registry.stats().entries).toBe(0);
    facts.observe("codex:r1", metadata({ status: "idle" }));
    expect(read<AgentExecutionState>(registry, "execution")?.value?.phase).toBe("running");
  });

  it("不属于任何后端的 runtime 不进入模型", () => {
    const { registry, facts } = setup();
    facts.observe("host:downloads", metadata({}, "host:downloads"));
    expect(registry.stats().entries).toBe(0);
    expect(facts.scopeOf("host:downloads")).toBeUndefined();
  });
});

describe("AgentStateFacts 交互与等待", () => {
  it("待回答的交互把会话标成 waiting，并带出 requestId", () => {
    const { registry, facts } = setup();
    facts.observe("codex:r1", metadata({ status: "running" }));
    facts.observe("codex:r1", { type: "interaction.requested", request: request("i1") });
    const execution = read<AgentExecutionState>(registry, "execution");
    expect(execution?.value?.phase).toBe("waiting_local_interaction");
    expect(execution?.value?.waitingFor).toEqual(["i1"]);
    expect(read(registry, "interactions")?.completeness).toBe("partial");
  });

  it("已回答的交互按 id 删除，状态回到运行阶段", () => {
    const { registry, facts } = setup();
    facts.observe("codex:r1", metadata({ status: "running" }));
    facts.observe("codex:r1", { type: "interaction.requested", request: request("i1") });
    facts.observe("codex:r1", { type: "interaction.resolved", requestId: "i1", source: "remote" });
    expect(read<AgentExecutionState>(registry, "execution")?.value?.phase).toBe("running");
    expect(Object.keys(read<Record<string, unknown>>(registry, "interactions")?.value ?? {})).toEqual([]);
  });

  it("interaction.snapshot 是完整清单，缺席条目被删除", () => {
    const { registry, facts } = setup();
    facts.observe("codex:r1", metadata());
    facts.observe("codex:r1", { type: "interaction.requested", request: request("i1") });
    facts.observe("codex:r1", { type: "interaction.snapshot", requests: [request("i2")] });
    const state = read<Record<string, unknown>>(registry, "interactions");
    expect(Object.keys(state?.value ?? {})).toEqual(["i2"]);
    expect(state?.completeness).toBe("complete");
  });
});

describe("AgentStateFacts 队列与能力", () => {
  it("队列只有部分清单：合并更新，且不能当基线", () => {
    const { registry, facts } = setup();
    facts.observe("codex:r1", metadata());
    facts.observe("codex:r1", queued("q1"));
    let state = read<Record<string, AgentDeliveryItem>>(registry, "delivery");
    expect(state?.completeness).toBe("partial");
    expect(state?.value?.q1?.state).toBe("accepted");
    facts.observe("codex:r1", queued("q1", "delivered"));
    state = read<Record<string, AgentDeliveryItem>>(registry, "delivery");
    expect(state?.value?.q1?.state).toBe("delivered");
    expect(facts.baseline("codex:r1", "delivery")?.action).toBe("baseline");
  });

  it("message.finished 带 queueId 时把对应队列项标成已投递", () => {
    const { registry, facts } = setup();
    facts.observe("codex:r1", metadata());
    facts.observe("codex:r1", queued("q1"));
    // 事件形状由 protocol 校验；这里只验证投影读取 queueId，所以用一个最小消息对象。
    facts.observe("codex:r1", { type: "message.finished", queueId: "q1", message: { messageId: "m1" } } as unknown as RuntimeEvent);
    expect(read<Record<string, AgentDeliveryItem>>(registry, "delivery")?.value?.q1?.state).toBe("delivered");
  });

  it("能力菜单是完整清单，缺席命令被删除", () => {
    const { registry, facts } = setup();
    const command = (name: string) => ({ name, source: "builtin" as const, argument: { kind: "select" as const, required: false, options: [{ value: "a", label: "A" }] } });
    facts.observe("codex:r1", metadata());
    facts.observe("codex:r1", { type: "runtime.capabilities", capabilities: { commands: [command("model"), command("thinking")] } });
    expect(Object.keys(read<Record<string, unknown>>(registry, "capabilities")?.value ?? {}).sort()).toEqual(["model", "thinking"]);
    facts.observe("codex:r1", { type: "runtime.capabilities", capabilities: { commands: [command("model")] } });
    const state = read<Record<string, { optionCount: number }>>(registry, "capabilities");
    expect(Object.keys(state?.value ?? {})).toEqual(["model"]);
    expect(state?.value?.model?.optionCount).toBe(1);
  });
});

describe("AgentStateFacts 重新接入与隔离", () => {
  it("重新接入换代次：旧条目保留但标记待核对，旧连接回调被忽略", () => {
    const { registry, facts } = setup();
    facts.observe("codex:r1", metadata({ status: "running" }));
    facts.observe("codex:r1", queued("q1"));
    expect(read(registry, "delivery")?.availability).toBe("ready");

    facts.observe("codex:r2", metadata({ runtimeId: "codex:r2", status: "idle" }));
    const afterAttach = read<Record<string, AgentDeliveryItem>>(registry, "delivery");
    expect(afterAttach?.availability).toBe("unknown");
    expect(Object.keys(afterAttach?.value ?? {})).toEqual(["q1"]);

    facts.observe("codex:r1", queued("q2"));
    expect(Object.keys(read<Record<string, AgentDeliveryItem>>(registry, "delivery")?.value ?? {})).toEqual(["q1"]);

    facts.observe("codex:r2", queued("q3"));
    const fresh = read<Record<string, AgentDeliveryItem>>(registry, "delivery");
    expect(fresh?.availability).toBe("unknown");
    facts.observe("codex:r2", { type: "delivery.snapshot", complete: true, items: [{ queueId: "q3", text: "q3", delivery: "followUp", state: "accepted" }] });
    expect(read(registry, "delivery")?.availability).toBe("ready");
    expect(Object.keys(read<Record<string, AgentDeliveryItem>>(registry, "delivery")?.value ?? {})).toEqual(["q3"]);
  });

  it("后端暂断标记待核对但保留最后已知值", () => {
    const { registry, facts } = setup();
    facts.observe("codex:r1", metadata({ status: "running" }));
    facts.runtimeOffline("codex:r1", "loopback closed");
    const execution = read<AgentExecutionState>(registry, "execution");
    expect(execution?.availability).toBe("unknown");
    expect(execution?.value?.phase).toBe("running");
  });

  it("两个会话各自成域，终结一个不影响另一个", () => {
    const { registry, facts } = setup();
    facts.observe("codex:r1", metadata({ sessionId: "s1" }));
    facts.observe("pi:r1", metadata({ runtimeId: "pi:r1", sessionId: "s2" }));
    expect(read(registry, "execution", "s1", "pi")).toBeUndefined();
    expect(read(registry, "execution", "s2", "pi")).toBeDefined();
    expect(facts.forget("codex:r1")).toBeGreaterThan(0);
    expect(read(registry, "execution", "s1")).toBeUndefined();
    expect(read(registry, "execution", "s2", "pi")).toBeDefined();
  });

  it("基线读取给出 unchanged / state / baseline", () => {
    const { registry, facts } = setup();
    facts.observe("codex:r1", metadata({ status: "idle" }));
    const state = read<AgentExecutionState>(registry, "execution");
    expect(facts.baseline("codex:r1", "execution", { modelEpoch: state!.modelEpoch, revision: state!.revision })?.action).toBe("unchanged");
    expect(facts.baseline("codex:r1", "execution")?.action).toBe("state");
    expect(facts.baseline("codex:r1", "history")).toMatchObject({ action: "baseline", state: { availability: "unknown", value: null } });
    expect(facts.baseline("codex:r9", "execution")).toBeUndefined();
  });

  it("权限来自 metadata：有 management 才是可编辑契约，离线保留最后已知值", () => {
    const { registry, facts } = setup();
    facts.observe("codex:r1", metadata());
    expect(read(registry, "permissions")?.availability).toBe("unknown");

    facts.observe("codex:r1", metadata({
      status: "running",
      permissions: { sandbox: "workspace-write", approvalPolicy: "on-request", problem: "配置文件不可读" },
    }));
    const withoutManagement = read<AgentPermissionsState>(registry, "permissions");
    expect(withoutManagement?.availability).toBe("ready");
    // 没有 management 只表示后端没提供编辑界面，不代表权限更宽。
    expect(withoutManagement?.value?.management).toBeNull();
    expect(withoutManagement?.value?.problem).toBe("配置文件不可读");

    facts.observe("codex:r1", metadata({
      permissions: { sandbox: "read-only", approvalPolicy: "never" },
      permissionManagement: {
        summary: "只读", details: "当前会话不能写盘", tone: "restricted",
        settings: [{
          id: "sandbox", label: "沙箱", currentValue: "read-only",
          options: [{ value: "read-only", label: "只读" }, { value: "workspace-write", label: "可写工作区" }],
        }],
      },
    }));
    const management = read<AgentPermissionsState>(registry, "permissions");
    expect(management?.value?.management?.tone).toBe("restricted");
    expect(management?.value?.management?.settings[0]?.options).toHaveLength(2);

    facts.runtimeOffline("codex:r1", "loopback closed");
    const offline = read<AgentPermissionsState>(registry, "permissions");
    expect(offline?.availability).toBe("unknown");
    expect(offline?.value?.sandbox).toBe("read-only");
  });

  it("通知只以引用摘要进入模型，写者是 Host 通知投影而不是适配器", () => {
    const registry = new AgentStateRegistry({ modelEpoch: "model-1" });
    let summary: AgentNotificationsState | undefined;
    const facts = new AgentStateFacts({
      registry, hostId: HOST, kindOf: (runtimeId) => kinds[runtimeId], notifications: () => summary,
    });
    facts.observe("codex:r1", metadata());
    expect(read(registry, "notifications")?.availability).toBe("unknown");

    summary = {
      hostEpoch: "host-epoch", revision: 3, sessionId: "s1", activeCount: 1,
      conditions: [{ code: "codex.turn.retry", severity: "warning" }],
      complete: false, verification: "unknown",
    };
    facts.refreshNotifications("codex:r1");
    const state = read<AgentNotificationsState>(registry, "notifications");
    expect(state?.availability).toBe("ready");
    expect(state?.completeness).toBe("partial");
    expect(state?.value?.activeCount).toBe(1);
    expect(state?.value?.hostEpoch).toBe("host-epoch");
    // 通知写者与适配器领域是两个来源，互不冲突。
    expect(state?.source.sourceId).toBe("host:notifications");
    expect(read(registry, "execution")?.source.sourceId).toBe("adapter:codex");
  });

  it("身份未建立时刷新通知摘要不会写进模型，也不会抛错", () => {
    const registry = new AgentStateRegistry({ modelEpoch: "model-1" });
    const facts = new AgentStateFacts({
      registry, hostId: HOST, kindOf: (runtimeId) => kinds[runtimeId],
      notifications: () => ({
        hostEpoch: "h", revision: 1, sessionId: null, activeCount: 0, conditions: [],
        complete: true, verification: "confirmed",
      }),
    });
    expect(() => facts.refreshNotifications("codex:r9")).not.toThrow();
    expect(registry.stats().entries).toBe(0);
  });

  it("无关或迟到的事件不会抛错，也不会写进模型", () => {
    const { registry, facts } = setup();
    expect(() => facts.observe("codex:r1", { type: "interaction.resolved", requestId: "nope", source: "remote" })).not.toThrow();
    expect(() => facts.observe("codex:r9", { type: "runtime.capabilities", capabilities: { commands: [] } })).not.toThrow();
    expect(() => facts.observe("codex:r1", { type: "message.delta", messageId: "m", delta: { text: "x" } } as unknown as RuntimeEvent)).not.toThrow();
    expect(registry.stats().entries).toBe(0);
  });
});
