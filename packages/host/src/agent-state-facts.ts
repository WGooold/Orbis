import { randomUUID } from "node:crypto";

import {
  type AgentCapabilityItem, type AgentContextState, type AgentDeliveryItem, type AgentExecutionState,
  type AgentInteractionItem, type AgentKind, type AgentModelState, type AgentNotificationsState,
  type AgentPermissionsState, type DomainAvailability,
  type DomainCompleteness, type DomainSource, type DomainState, type InteractionRequest,
  type RuntimeCapabilities, type RuntimeEvent, type RuntimeMetadata, type RuntimeStatus,
} from "@pi-remote/protocol";

import {
  AgentStateRegistry, type BaselineRead, type StateDomain, type StateScope,
} from "./agent-state-registry.js";

/**
 * 适配层事实接入（ADR-0032 §6，issue #6）。
 *
 * 它把**已经存在**的 runtime 事件归一成领域事实，交给 Registry 这个单写者提交。它不改变
 * 任何转发路径，也不解释原生业务语义：事件里没有的事实，就报 unknown，不拿旧值冒充已确认。
 *
 * 本批接入的领域：
 * - `execution`：运行阶段与等待中的交互；重试/压缩显式 `unavailable`（模块 09/10）。
 * - `delivery`：队列项与权威投递状态（模块 12，只有部分清单）。
 * - `interactions`：待回答请求；`interaction.snapshot` 是完整清单，其余是部分更新（模块 11）。
 * - `model` / `context`：metadata 报了才算 ready，否则整个领域 unknown（模块 15/16）。
 * - `capabilities`：后端发布的完整命令菜单（模块 17）。
 *
 * 历史与 live 正文仍由各 source adapter 的版本化复制负责（ADR-0024/0025），不在这里重复。
 */

/** 只有这些事件可能改变本批接入的领域；其余一律不看。 */
const INTERESTING_EVENTS: ReadonlySet<RuntimeEvent["type"]> = new Set([
  "runtime.metadata", "runtime.status", "runtime.capabilities",
  "message.queued", "message.started", "message.finished",
  "interaction.requested", "interaction.snapshot", "interaction.resolved", "interaction.cancelled",
] as const);

const SESSION_KEYS = ["execution", "model", "context", "permissions"] as const;
const COLLECTION_KEYS = ["delivery", "interactions", "capabilities"] as const;
/** 身份建立前的缓冲上限；超过就丢掉最早的一条，避免为没接上的 runtime 无限占内存。 */
const MAX_PENDING_ITEMS = 128;

export type AgentStateFactsOptions = {
  readonly registry: AgentStateRegistry;
  readonly hostId: string;
  /** runtimeId → 后端 kind。返回 undefined 表示这不是一个后端会话（例如 Host 自己的下载 runtime）。 */
  readonly kindOf: (runtimeId: string) => AgentKind | undefined;
  /**
   * 通知投影的**引用摘要**提供者（模块 18/19）。
   *
   * 通知的条目、期限与设备关闭仍由 Host 的 NotificationStore 唯一拥有（ADR-0028）；
   * 模型只记身份与核对程度，避免出现第二份通知权威。
   */
  readonly notifications?: (runtimeId: string) => AgentNotificationsState | undefined;
  readonly log?: (line: string) => void;
};

type CollectionDomain = "delivery" | "interactions" | "capabilities";

type Pending = {
  status?: RuntimeStatus;
  capabilities?: RuntimeCapabilities;
  metadata?: RuntimeMetadata;
  queue: Map<string, AgentDeliveryItem>;
  interactions: Map<string, AgentInteractionItem>;
  fresh: Set<CollectionDomain>;
};

type SessionFacts = {
  readonly key: string;
  readonly agentKind: AgentKind;
  readonly sessionId: string;
  /** 重新接入会换新代次，旧连接的回调不能再写（ADR-0032 §9）。 */
  epoch: string;
  runtimeId: string;
  revision: number;
  status: RuntimeStatus;
  metadata: RuntimeMetadata | null;
  capabilities: RuntimeCapabilities | null;
  readonly queue: Map<string, AgentDeliveryItem>;
  interactions: Map<string, AgentInteractionItem>;
  /**
   * 自上次重新接入以来已经收到新事实的集合领域。
   *
   * 重新接入会换代次：在那之后没有收到任何事实的集合领域保持「待核对」，不能因为本地
   * 累加器被清空就提交成 ready 的空清单——那等于用「没看见」冒充「不存在」。
   */
  readonly fresh: Set<CollectionDomain>;
};

export class AgentStateFacts {
  readonly #registry: AgentStateRegistry;
  readonly #hostId: string;
  readonly #kindOf: (runtimeId: string) => AgentKind | undefined;
  readonly #notifications: ((runtimeId: string) => AgentNotificationsState | undefined) | undefined;
  readonly #log: ((line: string) => void) | undefined;
  /** runtimeId → 会话键。 */
  readonly #runtimes = new Map<string, string>();
  readonly #sessions = new Map<string, SessionFacts>();
  /** 身份建立前到达的事件（status / queue / interactions）。 */
  readonly #pending = new Map<string, Pending>();

  constructor(options: AgentStateFactsOptions) {
    this.#registry = options.registry;
    this.#hostId = options.hostId;
    this.#kindOf = options.kindOf;
    this.#notifications = options.notifications;
    this.#log = options.log;
  }

  /** 通知投影变化时刷新模型里的引用摘要（由 Host 的通知 Store 回调触发）。 */
  refreshNotifications(runtimeId: string): void {
    try {
      const session = this.#sessionFor(runtimeId);
      // 身份还没建立时不必补写：attach 时会带上当时的摘要。
      if (session === undefined) return;
      this.#commitNotifications(session, runtimeId);
    } catch (error) {
      this.#log?.(`统一状态模型刷新通知摘要失败 (${runtimeId}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 观察一个后端事件。任何异常都不能影响 Host 的转发路径。 */
  observe(runtimeId: string, event: RuntimeEvent): void {
    // 热路径快速通道：Host 会转发大量与本模型无关的事件（流式 delta、artifact 分片、
    // session 分页）。它们连一次 Map 查找都不该做，否则会给转发吞吐叠加可观开销。
    if (!INTERESTING_EVENTS.has(event.type)) return;
    try {
      this.#observe(runtimeId, event);
    } catch (error) {
      this.#log?.(`统一状态模型记录事实失败 (${runtimeId}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 后端暂断：不是会话结束，只把已知领域标成待核对，保留最后已知值（ADR-0032 §9）。 */
  runtimeOffline(runtimeId: string, reason: string): void {
    try {
      const session = this.#sessionFor(runtimeId);
      if (session === undefined) return;
      session.revision += 1;
      this.#markUnverified(session);
      this.#log?.(`统一状态模型标记来源未知 (${runtimeId}): ${reason}`);
    } catch (error) {
      this.#log?.(`统一状态模型离线标记失败 (${runtimeId}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 会话/接入确认结束后按作用域终结模型，不留旧写入者。 */
  forget(runtimeId: string): number {
    const session = this.#sessionFor(runtimeId);
    this.#pending.delete(runtimeId);
    const key = this.#runtimes.get(runtimeId);
    this.#runtimes.delete(runtimeId);
    if (session === undefined) return 0;
    if (key !== undefined) this.#sessions.delete(key);
    return this.#registry.endScope(this.#scope(session));
  }

  scopeOf(runtimeId: string): StateScope | undefined {
    const session = this.#sessionFor(runtimeId);
    return session === undefined ? undefined : this.#scope(session);
  }

  /** 基线读取：调用方带已应用版本，得到 unchanged / state / baseline。 */
  baseline<T = unknown>(
    runtimeId: string,
    domain: StateDomain,
    known?: { readonly modelEpoch: string; readonly revision: number },
  ): BaselineRead<T> | undefined {
    const session = this.#sessionFor(runtimeId);
    if (session === undefined) return undefined;
    return this.#registry.readForBaseline<T>(this.#scope(session), domain, known);
  }

  snapshot(runtimeId: string): Array<{ domain: StateDomain; state: DomainState<unknown> }> {
    const session = this.#sessionFor(runtimeId);
    return session === undefined ? [] : this.#registry.snapshot(this.#scope(session));
  }

  #observe(runtimeId: string, event: RuntimeEvent): void {
    if (event.type === "runtime.metadata") {
      this.#attach(runtimeId, event.metadata);
      return;
    }
    const key = this.#runtimes.get(runtimeId);
    if (key === undefined) {
      this.#buffer(runtimeId, event);
      return;
    }
    const session = this.#sessions.get(key);
    // 已被新连接取代的旧 runtime：丢掉它的回调，不让旧实例写新代次。
    if (session === undefined || session.runtimeId !== runtimeId) return;
    this.#apply(session, event);
  }

  #buffer(runtimeId: string, event: RuntimeEvent): void {
    const pending: Pending = this.#pending.get(runtimeId) ?? { queue: new Map(), interactions: new Map(), fresh: new Set<CollectionDomain>() };
    switch (event.type) {
      case "runtime.status": pending.status = event.status; break;
      case "runtime.capabilities": pending.capabilities = event.capabilities; pending.fresh.add("capabilities"); break;
      case "message.queued":
        if (pending.queue.size >= MAX_PENDING_ITEMS) pending.queue.delete(pending.queue.keys().next().value as string);
        pending.queue.set(event.queueId, deliveryItem(event));
        pending.fresh.add("delivery");
        break;
      case "interaction.requested":
        if (pending.interactions.size >= MAX_PENDING_ITEMS) pending.interactions.delete(pending.interactions.keys().next().value as string);
        pending.interactions.set(event.request.requestId, interactionItem(event.request));
        pending.fresh.add("interactions");
        break;
      case "interaction.snapshot":
        pending.interactions = new Map(event.requests.slice(-MAX_PENDING_ITEMS).map(request => [request.requestId, interactionItem(request)]));
        pending.fresh.add("interactions");
        break;
      case "interaction.resolved":
      case "interaction.cancelled":
        pending.interactions.delete(event.requestId);
        pending.fresh.add("interactions");
        break;
      default: return;
    }
    this.#pending.set(runtimeId, pending);
  }

  #attach(runtimeId: string, metadata: RuntimeMetadata): void {
    const agentKind = this.#kindOf(runtimeId);
    const sessionId = metadata.sessionId;
    const pending = this.#pending.get(runtimeId);
    if (agentKind === undefined || sessionId === undefined) return;
    this.#pending.delete(runtimeId);
    const key = agentKind + "\u0000" + sessionId;
    let session = this.#sessions.get(key);
    if (session === undefined) {
      session = {
        key, agentKind, sessionId, epoch: randomUUID(), runtimeId, revision: 0,
        status: metadata.status, metadata: null, capabilities: null, queue: new Map(), interactions: new Map(),
        fresh: new Set<CollectionDomain>(),
      };
      this.#sessions.set(key, session);
    } else if (session.runtimeId !== runtimeId) {
      // 重新接入：新代次 + 已知领域标记待核对，然后由新连接的事实重新建立基线。
      session.runtimeId = runtimeId;
      session.epoch = randomUUID();
      session.revision += 1;
      session.queue.clear();
      session.interactions = new Map();
      session.capabilities = null;
      session.fresh.clear();
      this.#markUnverified(session);
    }
    this.#runtimes.set(runtimeId, key);
    session.metadata = metadata;
    session.status = metadata.status;
    if (pending !== undefined) {
      if (pending.status !== undefined) session.status = pending.status;
      if (pending.capabilities !== undefined) session.capabilities = pending.capabilities;
      for (const [id, item] of pending.queue) session.queue.set(id, item);
      for (const [id, item] of pending.interactions) session.interactions.set(id, item);
      for (const domain of pending.fresh) session.fresh.add(domain);
    }
    session.revision += 1;
    const touched = new Set<StateDomain>(["execution", "model", "context", "permissions"]);
    for (const domain of session.fresh) touched.add(domain);
    this.#commit(session, touched);
    // 通知的写者是 Host 的通知投影，不是后端适配器，所以单独提交。
    this.#commitNotifications(session, runtimeId);
  }

  #commitNotifications(session: SessionFacts, runtimeId: string): void {
    const provider = this.#notifications;
    if (provider === undefined) return;
    const summary = provider(runtimeId);
    // 来源恒为同一份 Host 通知投影：代次用固定 id，hostEpoch 记在值里。
    // 这样 Host 重建时整份模型本来就换代次，不会把「通知代次」误当成来源重建。
    const source: DomainSource = {
      producer: "host",
      sourceId: "host:notifications",
      sourceEpoch: "host-notifications",
      sourceRevision: summary?.revision ?? 0,
    };
    this.#registry.commitValue(this.#scope(session), "notifications", summary === undefined
      ? { source, availability: "unknown", completeness: "unknown", value: null }
      : { source, availability: "ready", completeness: summary.complete ? "complete" : "partial", value: summary });
  }

  #apply(session: SessionFacts, event: RuntimeEvent): void {
    let interactionsComplete = false;
    const touched = new Set<StateDomain>();
    switch (event.type) {
      case "runtime.status": session.status = event.status; touched.add("execution"); break;
      case "runtime.capabilities":
        session.capabilities = event.capabilities; session.fresh.add("capabilities"); touched.add("capabilities"); break;
      case "message.queued":
        session.queue.set(event.queueId, deliveryItem(event)); session.fresh.add("delivery"); touched.add("delivery"); break;
      case "message.started":
      case "message.finished": {
        if (event.queueId === undefined) return;
        const item = session.queue.get(event.queueId);
        if (item === undefined) return;
        session.queue.set(event.queueId, { ...item, state: "delivered" });
        session.fresh.add("delivery");
        touched.add("delivery");
        break;
      }
      case "interaction.requested":
        session.interactions.set(event.request.requestId, interactionItem(event.request));
        session.fresh.add("interactions");
        touched.add("interactions");
        // 等待状态由交互集合决定，所以交互变化同时影响运行阶段。
        touched.add("execution");
        break;
      case "interaction.snapshot":
        // 后端给的完整清单：允许按缺席删除。
        session.interactions = new Map(event.requests.map(request => [request.requestId, interactionItem(request)]));
        session.fresh.add("interactions");
        touched.add("interactions");
        touched.add("execution");
        interactionsComplete = true;
        break;
      case "interaction.resolved":
      case "interaction.cancelled":
        session.interactions.delete(event.requestId);
        session.fresh.add("interactions");
        touched.add("interactions");
        touched.add("execution");
        break;
      default: return;
    }
    session.revision += 1;
    this.#commit(session, touched, interactionsComplete, event);
  }

  /**
   * 只提交**这次事件改变了的**领域。
   *
   * 每个事件都重算全部领域会让 Host 的转发热路径承担多余的序列化与克隆，而事件吞吐
   * 是有实测临界值的（device-link / artifact 测试都在 10s 上限附近）。
   */
  #commit(session: SessionFacts, touched: ReadonlySet<StateDomain>, interactionsComplete = false, event?: RuntimeEvent): void {
    const scope = this.#scope(session);
    const source = this.#source(session);
    const metadata = session.metadata;

    if (touched.has("execution")) {
      const execution: AgentExecutionState = {
        phase: session.interactions.size > 0 ? "waiting_local_interaction" : session.status,
        waitingFor: [...session.interactions.keys()].sort(),
        retry: "unavailable",
        compaction: "unavailable",
      };
      this.#registry.commitValue(scope, "execution", { source, availability: "ready", completeness: "complete", value: execution });
    }

    if (touched.has("model")) {
      const model = metadata?.model;
      this.#registry.commitValue(scope, "model", model === undefined
        ? { source, availability: "unknown", completeness: "unknown", value: null }
        : {
          source, availability: "ready", completeness: "complete",
          value: {
            provider: model.provider, id: model.id,
            ...(model.name === undefined ? {} : { name: model.name }),
            ...(metadata?.thinkingLevel === undefined ? {} : { thinkingLevel: metadata.thinkingLevel }),
          } satisfies AgentModelState,
        });
    }

    if (touched.has("context")) {
      const usage = metadata?.contextUsage;
      this.#registry.commitValue(scope, "context", usage === undefined
        ? { source, availability: "unknown", completeness: "unknown", value: null }
        : {
          source, availability: "ready", completeness: "complete",
          value: { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent } satisfies AgentContextState,
        });
    }

    if (touched.has("permissions")) {
      const permissions = permissionsValue(metadata);
      this.#registry.commitValue(scope, "permissions", permissions === null
        ? { source, availability: "unknown", completeness: "unknown", value: null }
        : { source, availability: "ready", completeness: "complete", value: permissions });
    }

    if (touched.has("delivery") && session.fresh.has("delivery")) {
      // 后端没有队列完整清单事件，所以这里只能是部分清单：它合并、不删除。
      this.#registry.commitCollection(scope, "delivery", {
        source, availability: "ready", completeness: "partial", items: Object.fromEntries(session.queue),
      });
    }

    if (touched.has("interactions") && session.fresh.has("interactions")) {
      const removed = event?.type === "interaction.resolved" || event?.type === "interaction.cancelled"
        ? [event.requestId] : [];
      if (removed.length > 0 && !interactionsComplete) {
        // 已回答/取消是显式结束事实：按 id 删除，其余条目保留。
        this.#registry.removeCollectionItems(scope, "interactions", {
          source, availability: "ready", completeness: "partial", removeIds: removed,
        });
      } else {
        this.#registry.commitCollection(scope, "interactions", {
          source, availability: "ready",
          completeness: interactionsComplete ? "complete" : "partial",
          items: Object.fromEntries(session.interactions),
        });
      }
    }

    if (touched.has("capabilities") && session.fresh.has("capabilities") && session.capabilities !== null) {
      // 后端的命令菜单是完整清单：缺席即删除。
      this.#registry.commitCollection(scope, "capabilities", {
        source, availability: "ready", completeness: "complete",
        items: Object.fromEntries(session.capabilities.commands.map(command => [command.name, capabilityItem(command)])),
      });
    }
  }

  /** 暂断或重新接入：已知领域标成待核对，Registry 保留最后已知值。 */
  #markUnverified(session: SessionFacts): void {
    const scope = this.#scope(session);
    const source = this.#source(session);
    session.fresh.clear();
    for (const domain of SESSION_KEYS) {
      this.#registry.commitValue(scope, domain, { source, availability: "unknown", completeness: "unknown", value: null });
    }
    for (const domain of COLLECTION_KEYS) {
      this.#registry.commitCollection(scope, domain, { source, availability: "unknown", completeness: "unknown", items: {} });
    }
  }

  #source(session: SessionFacts): DomainSource {
    return {
      producer: "adapter",
      // 来源是后端适配器，不是某条连接：重连换 runtimeId 不该被当成换了写者。
      sourceId: "adapter:" + session.agentKind,
      sourceEpoch: session.epoch,
      sourceRevision: session.revision,
    };
  }

  #scope(session: SessionFacts): StateScope {
    return {
      kind: "agent",
      key: { hostId: this.#hostId, agentKind: session.agentKind, sessionId: session.sessionId },
    };
  }

  #sessionFor(runtimeId: string): SessionFacts | undefined {
    const key = this.#runtimes.get(runtimeId);
    if (key === undefined) return undefined;
    const session = this.#sessions.get(key);
    return session !== undefined && session.runtimeId === runtimeId ? session : undefined;
  }
}

/**
 * 权限领域值。`management` 缺失是 null（后端没提供编辑界面），不是「权限更宽」；
 * 整个 `permissions` 缺失才是领域 unknown（ADR-0031）。
 */
const permissionsValue = (metadata: RuntimeMetadata | null): AgentPermissionsState | null => {
  const permissions = metadata?.permissions;
  if (permissions === undefined) return null;
  const management = metadata?.permissionManagement;
  return {
    ...permissions,
    management: management === undefined ? null : {
      summary: management.summary,
      details: management.details,
      tone: management.tone,
      settings: management.settings.map(setting => ({
        id: setting.id,
        label: setting.label,
        ...(setting.currentValue === undefined ? {} : { currentValue: setting.currentValue }),
        ...(setting.disabledReason === undefined ? {} : { disabledReason: setting.disabledReason }),
        options: setting.options.map(option => ({
          value: option.value,
          label: option.label,
          ...(option.description === undefined ? {} : { description: option.description }),
        })),
      })),
    },
  };
};

const deliveryItem = (event: Extract<RuntimeEvent, { type: "message.queued" }>): AgentDeliveryItem => ({
  queueId: event.queueId,
  text: event.text,
  delivery: event.delivery,
  state: event.state,
  ...(event.error === undefined ? {} : { error: event.error }),
});

const interactionItem = (request: InteractionRequest): AgentInteractionItem => ({
  requestId: request.requestId,
  kind: request.kind,
  title: request.title,
  ...(request.description === undefined ? {} : { description: request.description }),
  ...(request.toolName === undefined ? {} : { toolName: request.toolName }),
  expiresAt: request.expiresAt,
  // 未回答的请求就是会话继续推进的阻塞点；回答后条目本身被移除。
  blocking: true,
  ...(request.submitted === undefined ? {} : { submitted: request.submitted }),
});

const capabilityItem = (command: RuntimeCapabilities["commands"][number]): AgentCapabilityItem => ({
  name: command.name,
  source: command.source,
  ...(command.description === undefined ? {} : { description: command.description }),
  argumentKind: command.argument?.kind ?? null,
  argumentRequired: command.argument?.required ?? null,
  optionCount: command.argument?.options?.length ?? 0,
  ...(command.argument?.hint === undefined ? {} : { hint: command.argument.hint }),
});

/** 兼容导出的类型别名，供 Host 其他模块引用而不必再导入 protocol。 */
export type { DomainAvailability, DomainCompleteness };
