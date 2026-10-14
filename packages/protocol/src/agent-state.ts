import { z } from "zod";

/**
 * ADR-0032 的共享 Agent 状态模型（第 1 批：schema、身份与领域 envelope）。
 *
 * 这个模块只定义**契约**：身份怎么算、领域怎么分、每个领域的状态长什么样、什么情况算已确认。
 * 它不含存储、网络或原生语义；Host 端的单写者见 `packages/host/src/agent-state-registry.ts`。
 * 原生执行与原生历史仍是权威，这里描述的是 Host 管理并向客户端发布的标准化投影。
 */

/**
 * 会话条目来源（spec §7.2 的 AgentBackend）。
 *
 * `pi` 的历史会话由 Host 直接扫磁盘（§8.1）；`codex` / `codexDesktop` 是同一个 Codex
 * 产品的两路接入（ADR-0022）；`dsh` 走本机 Web 服务（ADR-0020）。
 */
export const AgentKindSchema = z.enum(["pi", "codex", "codexDesktop", "dsh"]);
export type AgentKind = z.infer<typeof AgentKindSchema>;

const identity = z.string().min(1).max(256).refine(value => value.trim().length > 0, "Identifier must not be blank");

/**
 * Agent 身份：一个后端会话 = (hostId, agentKind, sessionId)。
 *
 * `runtimeId` **不在**身份里：它是可更换的在线路由身份（重连、换路、桌面重开都会变），
 * 而历史会话没有在线 runtime 也必须能被目录和分页读取。
 */
export const AgentKeySchema = z.strictObject({
  hostId: identity,
  agentKind: AgentKindSchema,
  sessionId: identity,
});
export type AgentKey = z.infer<typeof AgentKeySchema>;

/** 稳定的会话身份字符串。只用于本地索引与日志，不是线上字段。 */
export const agentKeyId = (key: AgentKey): string => JSON.stringify([key.hostId, key.agentKind, key.sessionId]);

/**
 * 设备身份。设备视图是 Host 持有的**按设备投影**：同一份共享事实，只对该设备可见的
 * 关闭记录与私有回执在这里过滤，不重新定义共享 Agent 事实。
 */
export const DeviceKeySchema = z.strictObject({
  hostId: identity,
  deviceId: identity,
});
export type DeviceKey = z.infer<typeof DeviceKeySchema>;

export const deviceKeyId = (key: DeviceKey): string => JSON.stringify([key.hostId, key.deviceId]);

/** 设备视图领域：通知关闭、私有命令回执与传输任务。 */
export const DeviceStateDomainSchema = z.enum(["notifications", "operations", "transfers"]);
export type DeviceStateDomain = z.infer<typeof DeviceStateDomainSchema>;

/** 设备操作身份：回执按发起设备和操作隔离，共享操作本身仍归 HostState.operations。 */
export const OperationKeySchema = z.strictObject({
  hostId: identity,
  deviceId: identity,
  operationId: identity,
});
export type OperationKey = z.infer<typeof OperationKeySchema>;

/** 诊断记录身份。会话作用域可空（Host/安装等记录不属于任何会话）。 */
export const RecordKeySchema = z.strictObject({
  hostId: identity,
  agentKey: AgentKeySchema.nullable(),
  recordId: identity,
});
export type RecordKey = z.infer<typeof RecordKeySchema>;

/** 会话内领域（ADR-0032 §4 的 01–24 中归属 AgentState 的部分）。 */
export const AgentStateDomainSchema = z.enum([
  "identity", "availability", "history", "live", "execution", "delivery", "interactions",
  "permissions", "model", "context", "capabilities", "resources", "notifications", "artifacts",
  "records", "providerBinding", "workspaceRef",
]);
export type AgentStateDomain = z.infer<typeof AgentStateDomainSchema>;

/** Host 级共享领域（目录、供应商、文件、操作、记录，以及 §9 的 25–30）。 */
export const HostStateDomainSchema = z.enum([
  "identity", "backends", "catalog", "providers", "workspaces", "files", "operations",
  "diagnostics", "connections", "management",
]);
export type HostStateDomain = z.infer<typeof HostStateDomainSchema>;

/**
 * 领域的可用性。`unknown` 是显式状态：来源未核对、读取失败或后端不支持都不是「空」。
 * 只有 `ready` 才允许发布当前值。
 */
export const DomainAvailabilitySchema = z.enum(["ready", "unavailable", "unknown"]);
export type DomainAvailability = z.infer<typeof DomainAvailabilitySchema>;

/**
 * 领域内容的完整程度。只有 `complete` 的清单可以用「缺席」删除条目；
 * `partial` 只能合并，`unknown` 保留最后已知值。
 */
export const DomainCompletenessSchema = z.enum(["complete", "partial", "unknown"]);
export type DomainCompleteness = z.infer<typeof DomainCompletenessSchema>;

/** 事实由谁确认。原生后端 > 适配层 > Host 自己；Host 不能把转发当作已确认。 */
export const DomainProducerSchema = z.enum(["native", "adapter", "host"]);
export type DomainProducer = z.infer<typeof DomainProducerSchema>;

export const DomainSourceSchema = z.strictObject({
  producer: DomainProducerSchema,
  /** 写入这个领域的唯一来源（后端实例或 Host 服务）。单写者冲突会被 Registry 拒绝。 */
  sourceId: identity,
  /** 来源代次：原生重建/更正换新值。字符串，**不按大小比较**。 */
  sourceEpoch: identity,
  /** 来源自己的版本水位，只在来源事实变化时推进；心跳与分页请求不推进它。 */
  sourceRevision: z.number().int().nonnegative(),
});
export type DomainSource = z.infer<typeof DomainSourceSchema>;

/** Host 模型的聚合发布版本，每个领域各自单调递增。 */
export const DomainRevisionSchema = z.number().int().nonnegative();

/**
 * 领域 envelope。宿主模型代次（`modelEpoch`）与通知协议的 `hostEpoch` 是两件事：
 * 前者随 Host 模型重建更换，后者是 ADR-0028 的设备级通知代次，二者不得互相代替。
 */
export const domainStateSchema = <T extends z.ZodType>(value: T) => z.strictObject({
  modelEpoch: identity,
  revision: DomainRevisionSchema,
  availability: DomainAvailabilitySchema,
  completeness: DomainCompletenessSchema,
  source: DomainSourceSchema,
  /** 最后一次核对时间。刷新它不代表内容版本变化。 */
  checkedAt: z.number().int().nonnegative(),
  /** `unknown` / `unavailable` 时保留最后已知值；显式清空要 `ready` + `complete` + `null`。 */
  value: value.nullable(),
});

export type DomainState<T> = {
  modelEpoch: string;
  revision: number;
  availability: DomainAvailability;
  completeness: DomainCompleteness;
  source: DomainSource;
  checkedAt: number;
  value: T | null;
};

/** 运行阶段。与协议 `RuntimeStatus` 同值，避免模型模块反向依赖 index.ts。 */
export const AgentExecutionPhaseSchema = z.enum(["idle", "running", "waiting_local_interaction"]);
export type AgentExecutionPhase = z.infer<typeof AgentExecutionPhaseSchema>;

/**
 * 运行与等待（模块 09）＋重试与压缩（模块 10）。
 *
 * 模块 10 目前没有后端事实来源，因此显式声明 `unavailable`——不能用 idle 或日志文案
 * 冒充「重试已恢复」。等适配层提供真实阶段后再替换这两个字面量。
 */
export const AgentExecutionStateSchema = z.strictObject({
  phase: AgentExecutionPhaseSchema,
  /** 正在等待回答的交互 requestId，升序。非空时 phase 必须是 waiting_local_interaction。 */
  waitingFor: z.array(z.string().min(1)).max(64),
  retry: z.literal("unavailable"),
  compaction: z.literal("unavailable"),
});
export type AgentExecutionState = z.infer<typeof AgentExecutionStateSchema>;

/** 一条队列项（模块 12）。`text` 在消息成为 canonical 之前是唯一正文来源。 */
export const AgentDeliveryItemSchema = z.strictObject({
  queueId: z.string().min(1).max(256),
  text: z.string().min(1).max(4_096),
  delivery: z.enum(["steer", "followUp"]),
  state: z.enum(["accepted", "delivered", "cancelled", "rejected", "not_cancelable"]),
  error: z.string().max(4_000).optional(),
});
export type AgentDeliveryItem = z.infer<typeof AgentDeliveryItemSchema>;

/** 一条待回答的交互（模块 11）。回答提交回执属于 DeviceView，不在共享事实里。 */
export const AgentInteractionItemSchema = z.strictObject({
  requestId: z.string().min(1).max(256),
  kind: z.enum(["confirm", "select", "multi-select", "input", "questionnaire"]),
  title: z.string().min(1).max(4_000),
  description: z.string().max(4_000).optional(),
  toolName: z.string().min(1).max(256).optional(),
  expiresAt: z.number().int().positive(),
  /** 未回答即阻塞该会话推进，所以当前模型里恒为 true；回答后条目被移除。 */
  blocking: z.boolean(),
  submitted: z.boolean().optional(),
});
export type AgentInteractionItem = z.infer<typeof AgentInteractionItemSchema>;

/** 当前模型与思考级别（模块 15）。 */
export const AgentModelStateSchema = z.strictObject({
  provider: z.string().min(1).max(128),
  id: z.string().min(1).max(256),
  name: z.string().min(1).max(256).optional(),
  thinkingLevel: z.string().min(1).max(128).optional(),
});
export type AgentModelState = z.infer<typeof AgentModelStateSchema>;

/** 上下文占用（模块 16）。后端不能估计时是整个领域的 unknown，不是这里的 null。 */
export const AgentContextStateSchema = z.strictObject({
  tokens: z.number().int().nonnegative().nullable(),
  contextWindow: z.number().int().positive().nullable(),
  percent: z.number().min(0).max(100).nullable(),
});
export type AgentContextState = z.infer<typeof AgentContextStateSchema>;

/** 一条能力菜单项（模块 17）。选项明细仍走既有 `RuntimeSlashCommand`，模型只记形状。 */
export const AgentCapabilityItemSchema = z.strictObject({
  name: z.string().min(1).max(256),
  source: z.enum(["builtin", "extension", "prompt", "skill", "mcp"]),
  description: z.string().max(4_000).optional(),
  argumentKind: z.enum(["text", "select", "tree"]).nullable(),
  argumentRequired: z.boolean().nullable(),
  optionCount: z.number().int().nonnegative(),
  hint: z.string().max(256).optional(),
});
export type AgentCapabilityItem = z.infer<typeof AgentCapabilityItemSchema>;

/**
 * 是否允许按「缺席」删除条目。
 *
 * 只有来自同一有效来源、`ready` 且 `complete` 的清单能证明某条已经不存在；
 * 部分清单、超时、读取失败和来源未知都必须保留最后已知值。
 */
export const domainStateConfirmsAbsence = (
  state: Pick<DomainState<unknown>, "availability" | "completeness">,
): boolean => state.availability === "ready" && state.completeness === "complete";
