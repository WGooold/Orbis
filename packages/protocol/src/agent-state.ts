import { z } from "zod";
import { HostProviderAuthenticationSchema, HostProviderUsageSchema, HostProviderHealthSchema, HostProviderRoutingSchema } from "./host-model-domains.js";

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
export const AgentKindSchema = z.enum(["pi", "codex", "codexDesktop", "dsh", "claude"]);
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
  "identity", "availability", "history", "live", "tools", "execution", "delivery", "interactions",
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
export const AgentActivitySchema = z.union([z.literal("unavailable"), z.strictObject({
  phase: z.enum(["idle", "running", "failed"]), turnId: identity.optional(),
  attempt: z.number().int().nonnegative().optional(), detail: z.string().max(4_000).optional(),
})]);
export const AgentExecutionStateSchema = z.strictObject({
  phase: AgentExecutionPhaseSchema,
  /** 正在等待回答的交互 requestId，升序。非空时 phase 必须是 waiting_local_interaction。 */
  waitingFor: z.array(z.string().min(1)).max(64),
  retry: AgentActivitySchema,
  compaction: AgentActivitySchema,
  turn: z.strictObject({ turnId: identity, startedAt: z.number().int().nonnegative(), durationMs: z.number().int().nonnegative().optional() }).nullable().optional(),
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
  runtimeId: z.string().optional(), extensionId: z.string().optional(),
  argumentSummary: z.string().optional(), externalUrl: z.string().optional(),
  confirmLabel: z.string().optional(), cancelLabel: z.string().optional(),
  options: z.array(z.unknown()).optional(), questions: z.array(z.unknown()).optional(),
  minSelections: z.number().optional(), maxSelections: z.number().optional(),
  placeholder: z.string().optional(), initialValue: z.string().optional(),
  minLength: z.number().optional(), maxLength: z.number().optional(), secret: z.boolean().optional(),
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

/** 一条可编辑权限设置（模块 14）。形状与 ADR-0031 的 opaque 契约一致。 */
export const AgentPermissionSettingSchema = z.strictObject({
  id: z.string().min(1).max(256),
  label: z.string().max(512),
  currentValue: z.string().max(4_096).optional(),
  disabledReason: z.string().max(4_000).optional(),
  options: z.array(z.strictObject({
    value: z.string().min(1).max(4_096),
    label: z.string().min(1).max(512),
    description: z.string().max(4_000).optional(),
  })),
});
export type AgentPermissionSetting = z.infer<typeof AgentPermissionSettingSchema>;

/**
 * 权限摘要与设置（模块 14）。
 *
 * `management` 是给客户端显示的 opaque 契约；raw 权限保留供诊断与电脑侧核对。
 * 没有 `management` 不代表权限更宽——它只说明后端没提供编辑界面（ADR-0031）。
 */
export const AgentPermissionsStateSchema = z.strictObject({
  sandbox: z.string(),
  approvalPolicy: z.string(),
  reviewer: z.string().optional(),
  networkAccess: z.boolean().optional(),
  writableRoots: z.array(z.string()).optional(),
  readableRoots: z.array(z.string()).optional(),
  profile: z.string().optional(),
  problem: z.string().optional(),
  management: z.strictObject({
    summary: z.string(),
    details: z.string(),
    tone: z.enum(["restricted", "full", "unknown", "problem"]),
    settings: z.array(AgentPermissionSettingSchema),
  }).nullable(),
});
export type AgentPermissionsState = z.infer<typeof AgentPermissionsStateSchema>;

/** 目录里一个后端的读取结果（模块 03）。失败或未就绪**不是**「这个后端没有会话」。 */
export const HostCatalogBackendSchema = z.strictObject({
  kind: AgentKindSchema,
  ready: z.boolean(),
  sessions: z.number().int().nonnegative(),
  /** 只有真正读完（或明确确认没就绪）才是完整；读取失败必须留 false。 */
  complete: z.boolean(),
  elapsedMs: z.number().int().nonnegative(),
  error: z.string().max(500).optional(),
});
export type HostCatalogBackend = z.infer<typeof HostCatalogBackendSchema>;

export const AgentCatalogSessionSchema = z.strictObject({
  sessionId: identity, name: z.string().max(256).optional(), cwd: z.string().max(4096),
  firstMessage: z.string().max(4_000).optional(), createdAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  modifiedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), messageCount: z.number().int().nonnegative().max(100_000),
  agentKind: AgentKindSchema, hostname: z.string().min(1).max(256), archived: z.boolean().optional(),
  modelProvider: z.string().min(1).max(128).optional(),
});
export type AgentCatalogSession = z.infer<typeof AgentCatalogSessionSchema>;

/** Host 聚合目录的逐后端完整性（HostState.catalog）。 */
export const HostCatalogStateSchema = z.strictObject({
  totalSessions: z.number().int().nonnegative(),
  /** 聚合结果被上限截断：客户端不能把总数当成全部。 */
  truncated: z.boolean(),
  backends: z.array(HostCatalogBackendSchema).max(16),
  checkedAt: z.number().int().nonnegative(),
  sessions: z.array(AgentCatalogSessionSchema).max(2_000).optional(),
  currentProviders: z.array(z.strictObject({ agentKind: AgentKindSchema, provider: z.string().min(1).max(128) })).max(16).optional(),
  snapshotId: identity.optional(),
  nextCursor: z.string().min(1).max(512).nullable().optional(),
});
export type HostCatalogState = z.infer<typeof HostCatalogStateSchema>;

export const AgentStateRangeRequestSchema = z.strictObject({
  type: z.literal("agent.state.range.request"), requestId: identity,
  scope: z.literal("host"), domain: z.literal("catalog"),
  cursor: z.string().min(1).max(512).nullable().optional(), limit: z.number().int().positive().max(200).optional(),
});
export type AgentStateRangeRequest = z.infer<typeof AgentStateRangeRequestSchema>;

export const HostCatalogRangeSchema = z.strictObject({
  modelEpoch: identity, revision: DomainRevisionSchema, snapshotId: identity.nullable(),
  offset: z.number().int().nonnegative(), totalSessions: z.number().int().nonnegative(),
  sessions: z.array(AgentCatalogSessionSchema).max(200),
  nextCursor: z.string().min(1).max(512).nullable(), complete: z.boolean(), truncated: z.boolean(),
  error: z.enum(["snapshot_changed", "catalog_unavailable", "invalid_cursor"]).optional(),
});
export type HostCatalogRange = z.infer<typeof HostCatalogRangeSchema>;

export const AgentStateRangePageSchema = z.strictObject({
  type: z.literal("agent.state.range.page"), requestId: identity,
  scope: z.literal("host"), domain: z.literal("catalog"), page: HostCatalogRangeSchema,
});
export type AgentStateRangePage = z.infer<typeof AgentStateRangePageSchema>;

/**
 * 一个后端的供应商摘要（模块 20–22：手机摘要、配置与认证绑定、用量/健康度/路由）。
 *
 * 秘密永远留在 Host：这里只有 id、展示名与布尔状态，没有 baseUrl、密钥或脚本内容。
 * 拿不到事实的字段显式 `unknown`，不用 0/空值冒充「已确认」。
 */
export const HostProviderSummarySchema = z.strictObject({
  agentKind: AgentKindSchema,
  availability: DomainAvailabilitySchema.optional(),
  profilesTruncated: z.boolean().optional(),
  /** Host 当前选中的供应商 profile id；不是原生会话的 modelProvider。 */
  current: z.string().min(1).max(128).nullable(),
  /** 原生后端当前配置的 modelProvider，用于会话归属筛选；null 表示本次未能核对。 */
  modelProvider: z.string().min(1).max(128).nullable().optional(),
  /** profile 清单；`null` 表示这次没拿到清单（不是「没有 profile」）。 */
  profiles: z.array(z.strictObject({
    id: z.string().min(1).max(128),
    name: z.string().max(256),
    enabled: z.boolean(),
    /** 后端级默认：新会话不带指定 provider 时用它。 */
    globalDefault: z.boolean(),
    mode: z.enum(["additive", "exclusive"]).optional(),
    subscriptionSupported: z.boolean().optional(),
  })).max(64).nullable(),
  /** 认证绑定是否就绪：false 表示缺凭据（客户端提示去电脑上配置），`null` 表示未核对。 */
  authenticated: z.boolean().nullable(),
  /** 是否有一次 provider 切换正在进行：进行中时路由结论还不作数；`null` 表示未核对。 */
  switching: z.boolean().nullable(),
  /** 用量/健康度：Host 没有这份事实时是 `unknown`，不假报数字。 */
  usage: HostProviderUsageSchema,
  authentication: HostProviderAuthenticationSchema.optional(),
  health: HostProviderHealthSchema.optional(),
  routing: HostProviderRoutingSchema.optional(),
});
export type HostProviderSummary = z.infer<typeof HostProviderSummarySchema>;

/** Host 级供应商公共投影（HostState.providers）。 */
export const HostProvidersStateSchema = z.strictObject({
  providers: z.array(HostProviderSummarySchema).max(8),
  /** 这份摘要是什么时候核对的；`unknown` 的字段以这个时点为准。 */
  checkedAt: z.number().int().nonnegative(),
});
export type HostProvidersState = z.infer<typeof HostProvidersStateSchema>;

/**
 * 诊断记录的**目录**投影（HostState.diagnostics，模块 23 的读取侧）。
 *
 * 这里只放「有多少、缺多少、窗口到哪儿」：记录本身是游标分页读的，把它们塞进快照只会造出
 * 一份会过期的副本。`dropped` 与 `persistFailures` 是缺口——只要它们不为 0，客户端就不能把
 * 这里当成完整历史。
 */
export const HostDiagnosticsStateSchema = z.strictObject({
  /** 当前保留窗口里的条数。 */
  records: z.number().int().nonnegative(),
  /** 因条数上限或保留窗口被淘汰的条数。 */
  dropped: z.number().int().nonnegative(),
  /** 落盘失败次数：>0 表示盘上那份比内存里这份少。 */
  persistFailures: z.number().int().nonnegative(),
  oldestAt: z.number().int().nonnegative().nullable(),
  newestAt: z.number().int().nonnegative().nullable(),
  /** 这份摘要是什么时候核对的。 */
  checkedAt: z.number().int().nonnegative(),
});
export type HostDiagnosticsState = z.infer<typeof HostDiagnosticsStateSchema>;

/**
 * 一条有界诊断记录（模块 23）。
 *
 * 记录是**运维事实**，不是聊天正文：只有身份、类别、严重度、短文本与小时点的小键值，
 * 不带原始正文、凭据、脚本或文件内容。缺事实就是没有这条记录，不写「占位记录」。
 */
export const DiagnosticSeveritySchema = z.enum(["info", "warning", "error"]);
export type DiagnosticSeverity = z.infer<typeof DiagnosticSeveritySchema>;

export const DiagnosticRecordSchema = z.strictObject({
  recordId: z.string().min(1).max(256),
  producerEpoch: z.string().min(1).max(256).optional(),
  hostId: z.string().min(1).max(256).optional(),
  operationId: z.string().min(1).max(256).optional(),
  turnId: z.string().min(1).max(256).optional(),
  scope: z.enum(["agent", "host"]),
  agentKind: AgentKindSchema.nullable(),
  sessionId: z.string().min(1).max(256).nullable(),
  /** 类别：运行、传输、审批、供应商、恢复……客户端可以按类别过滤而不必解析文本。 */
  category: z.string().min(1).max(64),
  severity: DiagnosticSeveritySchema,
  message: z.string().min(1).max(512),
  /** 结构化补充：小键值，Host 不往里塞正文、凭据或脚本。 */
  detail: z.record(z.string().min(1).max(64), z.string().max(256)).refine(value => Object.keys(value).length <= 16).optional(),
  at: z.number().int().nonnegative(),
});
export type DiagnosticRecord = z.infer<typeof DiagnosticRecordSchema>;

/**
 * 一页诊断记录（游标读取）。
 *
 * `truncated` 表示「游标给出的位置与当前保留窗口之间已经有记录被淘汰」——客户端必须知道
 * 这里有缺口，而不是把这一页当成完整历史（ADR-0032 的「丢失/淘汰有明确缺口」）。
 */
export const DiagnosticPageSchema = z.strictObject({
  records: z.array(DiagnosticRecordSchema).max(500),
  /** 下一页游标；null 表示已经追平当前最新记录。 */
  nextCursor: z.string().min(1).max(256).nullable(),
  truncated: z.boolean(),
});
export type DiagnosticPage = z.infer<typeof DiagnosticPageSchema>;

/**
 * 读一页诊断记录（模块 23 的读取出口）。
 *
 * 游标由 Host 给出，客户端只负责原样带回来；`cursor` 为 `null` 与不传是两件事的**同一种**
 * 意思（从当前窗口最旧一条开始），所以两者都允许。`limit` 的上限由 Host 的页上限再夹一次。
 */
export const DiagnosticsRequestSchema = z.strictObject({
  type: z.literal("diagnostics.request"),
  requestId: z.string().min(1).max(128),
  cursor: z.string().min(1).max(256).nullable().optional(),
  limit: z.number().int().positive().max(500).optional(),
  category: z.string().min(1).max(64).optional(),
  severity: DiagnosticSeveritySchema.optional(),
  agentKind: AgentKindSchema.optional(),
  sessionId: z.string().min(1).max(256).optional(),
});
export type DiagnosticsRequest = z.infer<typeof DiagnosticsRequestSchema>;

/** 一页诊断记录 + 回带 requestId：并发请求各自认领自己的应答。 */
export const DiagnosticsPageMessageSchema = z.strictObject({
  type: z.literal("diagnostics.page"),
  requestId: z.string().min(1).max(128),
  page: DiagnosticPageSchema,
});
export type DiagnosticsPageMessage = z.infer<typeof DiagnosticsPageMessageSchema>;

/**
 * 线上快照里的一个领域：envelope 加上领域名。
 *
 * `value` 对协议层是不透明的领域负载——它的形状由该领域自己的 schema 定义，读的人按
 * `domain` 去解释，而不是让协议层认识每个领域的内容。
 */
export const AgentStateDomainSnapshotSchema = z.strictObject({
  domain: z.string().min(1).max(64),
  modelEpoch: z.string().min(1).max(256),
  revision: z.number().int().nonnegative(),
  availability: DomainAvailabilitySchema,
  completeness: DomainCompletenessSchema,
  source: DomainSourceSchema,
  checkedAt: z.number().int().nonnegative(),
  value: z.unknown().nullable(),
  /** Complete Host projection, independent of the native source inventory completeness. */
  projectionComplete: z.literal(true).optional(),
});
export type AgentStateDomainSnapshot = z.infer<typeof AgentStateDomainSnapshotSchema>;

/**
 * 读一个作用域的当前投影。缺省按 runtimeId / sessionId 推断成会话作用域；都没有则是 Host 级。
 * `protocolVersion` 由协议层补上（见 index.ts）。
 */
export const AgentStateRequestSchema = z.strictObject({
  type: z.literal("agent.state.request"),
  requestId: z.string().min(1).max(128),
  scope: z.enum(["host", "agent", "device"]).optional(),
  runtimeId: z.string().min(1).max(1_024).optional(),
  agentKind: AgentKindSchema.optional(),
  sessionId: z.string().min(1).max(256).optional(),
  /** 只读这些领域；缺省表示该作用域里当前存在的全部。 */
  domains: z.array(z.string().min(1).max(64)).max(32).optional(),
  subscribe: z.boolean().optional(),
  known: z.array(z.strictObject({ domain: z.string().min(1).max(64), modelEpoch: identity, revision: DomainRevisionSchema })).max(32).optional(),
});
export type AgentStateRequest = z.infer<typeof AgentStateRequestSchema>;

/**
 * 一次模型读取的应答负载（`protocolVersion` 由协议层补上，见 index.ts）。
 *
 * `missing` 与 `truncated` 是这份契约的重点：点名要却没有状态的领域、以及因为字节预算
 * 没能全部放进来的情况，都必须由 Host 说出来，客户端不能从「没看到」推断「不存在」。
 */
export const AgentStateSnapshotSchema = z.strictObject({
  type: z.literal("agent.state.snapshot"),
  requestId: z.string().min(1).max(128),
  scope: z.enum(["host", "agent", "device"]),
  runtimeId: z.string().min(1).max(1_024).optional(),
  agentKind: AgentKindSchema.optional(),
  sessionId: z.string().min(1).max(256).optional(),
  modelEpoch: z.string().min(1).max(256).nullable(),
  domains: z.array(AgentStateDomainSnapshotSchema).max(64),
  missing: z.array(z.strictObject({
    domain: z.string().min(1).max(64),
    reason: z.enum(["no_state", "unknown_domain"]),
  })).max(64),
  truncated: z.boolean(),
  /** A complete-domain publication for an established subscription. */
  update: z.boolean().optional(),
  unchanged: z.array(z.string().min(1).max(64)).max(32).optional(),
  /** 作用域根本解析不出来时才有值（例如 runtime 不在本机、会话身份不全）。 */
  error: z.string().max(500).optional(),
});
export type AgentStateSnapshot = z.infer<typeof AgentStateSnapshotSchema>;

/** 设备操作回执状态（模块 13）。`accepted` 表示 Host 已受理、还没有任何后端结果。 */
export const AgentOperationStateSchema = z.enum([
  "accepted", "pending", "success", "failure", "cancelled",
  "not_cancelable", "already_delivered", "message_id_conflict",
]);
export type AgentOperationState = z.infer<typeof AgentOperationStateSchema>;

/**
 * 通知在统一模型里的**引用摘要**（模块 18/19）。
 *
 * 条目、期限与设备关闭仍由 Host 的通知投影唯一拥有（ADR-0028）；这里只记身份与核对程度。
 * 客户端要内容时读通知快照，不要从这里复制出第二份权威。
 */
export const AgentNotificationsStateSchema = z.strictObject({
  hostEpoch: z.string().min(1).max(256),
  revision: z.number().int().nonnegative(),
  sessionId: z.string().min(1).max(256).nullable(),
  activeCount: z.number().int().nonnegative(),
  conditions: z.array(z.strictObject({
    code: z.string().min(1).max(256),
    severity: z.enum(["info", "warning", "error"]),
  })).max(64),
  complete: z.boolean(),
  verification: z.enum(["confirmed", "unknown"]),
});
export type AgentNotificationsState = z.infer<typeof AgentNotificationsStateSchema>;

/** 一条设备私有回执（DeviceView.operations）。共享操作本身归 HostState.operations。 */
export const AgentOperationItemSchema = z.strictObject({
  operationId: z.string().min(1).max(256),
  runtimeId: z.string().min(1).max(256),
  requestId: z.string().min(1).max(256).optional(),
  state: AgentOperationStateSchema,
  at: z.number().int().nonnegative(),
  detail: z.string().max(2_000).optional(),
});
export type AgentOperationItem = z.infer<typeof AgentOperationItemSchema>;

/**
 * 一条未完成的上传（模块 24 / 33：Host 确认的持久前缀）。
 *
 * `transferId` 是 `.part` 的内容身份，跨重启稳定；手机自己的本地前缀仍由 App 权威，
 * 这里只回答「Host 这一侧确认收到了多少」，不能拿来代替手机的续传判断。
 */
export const DeviceTransferItemSchema = z.strictObject({
  transferId: z.string().min(1).max(256),
  runtimeId: z.string().min(1).max(256),
  fileName: z.string().min(1).max(512),
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  /** 已确认落盘的字节数；`null` 表示这条记录没有写下持久前缀（旧索引）。 */
  durableBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  /** `receiving` 有活句柄；`interrupted` 只剩 `.part`，等下一次 init 续传。 */
  state: z.enum(["receiving", "interrupted"]),
  updatedAt: z.number().int().nonnegative(),
});
export type DeviceTransferItem = z.infer<typeof DeviceTransferItemSchema>;

/**
 * 设备视图里的传输任务（`DeviceView.transfers`，模块 33 的 Host 一侧）。
 *
 * 只列**未完成**的上传：完成的上传已经是目录里的文件，不属于传输任务。列表有界，超界是
 * `truncated`；这里是设备私有投影，不向其他设备广播。
 */
export const DeviceTransfersStateSchema = z.strictObject({
  uploads: z.array(DeviceTransferItemSchema).max(64),
  receiving: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
export type DeviceTransfersState = z.infer<typeof DeviceTransfersStateSchema>;

/** 一条能力菜单项（模块 17）。选项明细仍走既有 `RuntimeSlashCommand`，模型只记形状。 */
export const AgentCapabilityItemSchema = z.strictObject({
  name: z.string().min(1).max(256),
  source: z.enum(["builtin", "extension", "prompt", "skill", "mcp"]),
  description: z.string().max(4_000).optional(),
  argumentKind: z.enum(["text", "select", "tree"]).nullable(),
  argumentRequired: z.boolean().nullable(),
  optionCount: z.number().int().nonnegative(),
  hint: z.string().max(256).optional(),
  argument: z.unknown().optional(),
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
