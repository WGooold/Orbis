/** AgentBackend adapter for an already-running DeepSeek Harness Web session. */
import { createHash, randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  NotificationSource,
  RecoverableSessionSource,
  SessionSyncPreparer,
  type AgentDeliveryItem, type AgentSessionSummary, type ChatMessage, type InteractionRequest, type RemoteSessionEntry,
  type RuntimeCapabilities, type RuntimeCommand, type RuntimeEvent, type RuntimeMetadata,
} from "@pi-remote/protocol";
import type { AgentActivateTarget, AgentBackend, BackendActivation, CommandDispatch } from "./agent-backend.js";
import { DshWebClient, type DshWebConnection, type DshWebEvent } from "./dsh-web-client.js";
import { dshErrorText, dshWebEntries, dshWebEntryId, dshWebEntryText, dshWebMessage, dshWebTreeOptions, type DshStreamDecoder, type DshWebLogEvent } from "./dsh-web-history.js";
import { localHostname } from "./sessions.js";
import { dshPermissionOptions, dshPermissions } from "./dsh-permissions.js";
import { dshUserQuestionInteraction, dshUserQuestionAnswer } from "./dsh-user-questions.js";
import { dshPermissionManagement } from "./permission-management.js";
import { ActivationError } from "./spawner.js";
import { applyDshWebProvider } from "./dsh-web-provider.js";
import { DshWebDiscovery, type DshLiveSession } from "./dsh-web-discovery.js";

type Obj = Record<string, unknown>;
/**
 * 流式 patch 的合并窗口（ADR-0035 §15）：DSH Web 每个增量都会改 live 状态，逐条发布在真机上
 * 实测 96 帧/秒，手机端每条都要落盘 + 全量重投影。100ms 与 Pi 扩展取同一值。
 */
export const STREAM_COALESCE_MS = 100;
type WorkspaceView = { workspaceId: string; path: string; title?: string; sessionIds?: string[] };
const object = (value: unknown): Obj => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Obj : {};
const arrayObjects = (value: unknown): Obj[] => Array.isArray(value) ? value.map(object) : [];
const publicId = (id: string): string => `dsh:${id}`;
const textOf = (value: unknown): string => value instanceof Error ? value.message : String(value);
const wire = (value: unknown): string => JSON.stringify(value);
const webEntrySeq = (entryId: string): number => {
  const suffix = /:web:(\d+)$/.exec(entryId)?.[1];
  const seq = suffix === undefined ? Number.MAX_SAFE_INTEGER : Number(suffix);
  return Number.isSafeInteger(seq) ? seq : Number.MAX_SAFE_INTEGER;
};
const webEntrySeqOrUndefined = (entryId: string | null | undefined): number | undefined => {
  if (typeof entryId !== "string") return undefined;
  const suffix = /:web:(\d+)$/.exec(entryId)?.[1];
  if (suffix === undefined) return undefined;
  const seq = Number(suffix);
  return Number.isSafeInteger(seq) ? seq : undefined;
};

type Approval = { id: string; session: WebSession; interaction: InteractionRequest; timer?: NodeJS.Timeout; releaseWait?: () => void; responding?: boolean };
/** 会话实际选中的模型与思考档位；`session/modelCatalog.default` 只是部署默认值，不是会话事实。 */
type ModelSelection = { provider: string; model: string; reasoningEffort?: string };
type WebSession = {
  source: RecoverableSessionSource;
  sourceCheckedAt: number;
  sourceCheck?: { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
  notifications: NotificationSource; skillsGeneration: number; modelGeneration: number; followGeneration: number;
  id: string; cwd: string; createdAt: number; title?: string; entries: RemoteSessionEntry[]; skills: { name: string; description: string }[];
  /** 分页预处理缓存：翻页只换页，不重算索引与显示投影（ADR-0035 §10）。 */
  preparer: SessionSyncPreparer;
  running: boolean; closing: boolean; options: Obj[]; modelCatalog?: Obj; selection?: ModelSelection; selectionSeq: number; usage?: RuntimeMetadata["contextUsage"];
  /** 上一次发布出去的命令词表；同一份内容不重复下发（历史树挂在它上面）。 */
  capabilitiesSignature?: string;
  lastSeq: number; turnId?: string; turnStartedAt?: number;
  permissionProfile?: string; permissionSandbox?: string; permissionApproval?: string;
  permissionSeq: number; permissionSandboxSeq: number; permissionApprovalSeq: number; permissionGeneration: number;
  permissionBusy: boolean; permissionOptions: ReturnType<typeof dshPermissionOptions>;
  queue: Map<string, { itemId: string; text: string; delivery: "steer" | "followUp" }>;
  deliverySeq: number; deliveryGeneration: number;
  activity: Extract<RuntimeEvent, { type: "execution.activity" }>;
  activitySeq: number; compactionId?: string;
  messages: Map<string, { fingerprint: string; status: "pending" | "success" | "failure" | "cancelled"; entryId?: string }>;
  persistedMappings: Map<string, string>;
  retiredAttempts: Set<string>;
  streamIndexes: Map<string, number>;
  unsubscribe: () => void; following: boolean; streamMessages: Map<string, ChatMessage>; tools: Map<string, string>;
};

/**
 * This adapter never starts or stops dsh. `stop()` only closes its own Web
 * transport, leaving the user's browser and Web process untouched.
 */
export class DshWebRuntime implements AgentBackend {
  readonly kind = "dsh" as const;
  readonly #client: DshWebConnection;
  readonly #decoder: DshStreamDecoder | undefined;
  readonly #discovery: DshWebDiscovery;
  readonly #detached = new Set<string>();
  /** Last observed `running` per native Session: false→true is new browser work. */
  readonly #running = new Map<string, boolean>();
  readonly #sessions = new Map<string, WebSession>();
  readonly #activating = new Map<string, Promise<BackendActivation>>();
  readonly #approvals = new Map<string, Approval>();
  #ready = true;
  #controlUnsubscribe: (() => void) | undefined;
  #controlRetry: NodeJS.Timeout | undefined;
  #stopping: Promise<void> | undefined;
  #sink: (event: RuntimeEvent, runtimeId: string) => void = () => {};
  onMetadataChange: (() => void) | undefined;
  onOffline: ((reason: string, runtimes: RuntimeMetadata[]) => void) | undefined;
  onCatalogChange: (() => void) | undefined;
  onArchiveChange: ((sessionId: string, archived: boolean) => void) | undefined;

  /** 流式 patch 合并窗口（ADR-0035 §15）；0 = 原行为，生产入口传 `STREAM_COALESCE_MS`。 */
  readonly #coalesceMs: number;

  constructor(client: DshWebConnection, decoder?: DshStreamDecoder, options: { coalesceMs?: number } = {}) {
    this.#client = client;
    this.#decoder = decoder;
    this.#coalesceMs = Math.max(0, options.coalesceMs ?? 0);
    this.#discovery = new DshWebDiscovery(client, {
      live: item => this.#observe(item),
      offline: (id, removed) => {
        if (removed) { this.#detached.delete(id); this.#running.delete(id); }
        const session = this.#sessions.get(publicId(id));
        if (session) this.#detachSession(session, "DeepSeek Web 实例已离线");
      },
      archived: (id, archived) => {
        const session = this.#sessions.get(publicId(id));
        if (archived && session) this.#detachSession(session, "DeepSeek Web 会话已归档");
        this.onArchiveChange?.(publicId(id), archived);
      },
      changed: () => this.onCatalogChange?.(),
    });
    client.onEvent = event => this.#event(event);
    client.onReconnect = () => { void this.#resyncAll().catch(error => this.#report(textOf(error))); };
    client.onExit = reason => {
      if (!this.#ready) return;
      this.#ready = false;
      this.#discovery.stop();
      for (const id of this.#approvals.keys()) this.#cancelApproval(id, "disconnected");
      const runtimes = this.directoryEntries();
      this.onOffline?.(reason, runtimes);
    };
  }

  static async create(
    options: Parameters<typeof DshWebClient.connect>[0] = {},
    decoder?: DshStreamDecoder,
    runtimeOptions: { coalesceMs?: number } = {},
  ): Promise<DshWebRuntime> {
    return new DshWebRuntime(await DshWebClient.connect(options), decoder, runtimeOptions);
  }
  setEventSink(sink: (event: RuntimeEvent, runtimeId: string) => void): void { this.#sink = sink; }
  start(): Promise<void> {
    const discovery = this.#discovery.start();
    this.#subscribeControl();
    return discovery;
  }
  #subscribeControl(): void {
    if (!this.#ready) return;
    this.#controlUnsubscribe = this.#client.subscribe("session/control", {}, raw => {
      const frame = object(raw);
      if (frame.type === "baseline") {
        for (const [id, baseline] of Object.entries(object(object(frame.value).projections))) {
          this.#titleProjection(id, baseline, true);
          const session = this.#sessions.get(publicId(id)); if (session) {
            this.#permissionProjection(session, baseline);
            this.#deliveryProjection(session, baseline);
            this.#modelSelectionProjection(session, baseline);
          }
        }
      } else if (frame.type === "projection" && typeof frame.sessionId === "string") {
        const baseline = { asOfSeq: frame.seq, values: { [String(frame.key)]: frame.value } };
        if (frame.key === "title") this.#titleProjection(frame.sessionId, baseline);
        const session = this.#sessions.get(publicId(frame.sessionId));
        if (session && frame.key === "permissions") this.#permissionProjection(session, baseline);
        if (session && frame.key === "inbox") this.#deliveryProjection(session, baseline);
        if (session && frame.key === "modelSelection") this.#modelSelectionProjection(session, baseline);
      }
    }, () => {
      this.#controlUnsubscribe?.(); this.#controlUnsubscribe = undefined;
      if (!this.#ready) return;
      this.#controlRetry = setTimeout(() => { this.#controlRetry = undefined; this.#subscribeControl(); }, 2_000);
      this.#controlRetry.unref();
    });
  }
  announce(): void {
    for (const session of this.#sessions.values()) {
      void this.#loadModelCatalog(session);
      session.notifications.announce();
      this.#publishMetadata(session);
      void this.#loadDelivery(session);
      this.#emit(session, structuredClone(session.activity));
      // 新接入的设备手里没有命令词表，必须强制重发一次。
      this.#publishCapabilities(session, true);
      this.#emit(session, { type: "interaction.snapshot", requests: [...this.#approvals.values()].filter(item => item.session === session).map(item => item.interaction) });
    }
  }
  isReady(): boolean { return this.#ready; }
  syncNotifications(runtimeId: string): void {
    const session = this.#sessions.get(runtimeId); if (!session || session.closing) return;
    session.notifications.announce();
    const codes = new Set(session.notifications.snapshot().notifications.map(item => item.code));
    if (codes.has("dsh.skills")) void this.#loadSkills(session);
    if (codes.has("dsh.models")) void this.#loadModelCatalog(session);
    if (codes.has("dsh.permissions")) void this.#loadPermissions(session);
    if (codes.has("dsh.recovery") && !session.following) this.#discovery.retry();
  }
  ownsRuntime(runtimeId: string): boolean { return this.#sessions.has(runtimeId); }
  directoryEntries(): RuntimeMetadata[] { return [...this.#sessions.values()].map(session => this.#metadata(session)); }
  currentProvider(): Promise<string | undefined> { return Promise.resolve("deepseek-web"); }
  async assertProviderSwitchReady(): Promise<void> {
    if (this.#activating.size || [...this.#sessions.values()].some(session => session.running || session.closing) || this.#approvals.size > 0) throw new Error("DeepSeek Web 正在工作或等待审批，请结束任务后切换供应商");
    const list = object(await this.#client.request("session/list", { _request: {} }));
    if (arrayObjects(list.items).some(session => session.running)) throw new Error("DeepSeek Web 浏览器会话正在工作，请结束任务后切换供应商");
  }
  async reloadProviderConfiguration(env: NodeJS.ProcessEnv, live = false): Promise<void> {
    // 编辑当前在用的供应商时 DSH 自己热加载补丁文件，正在进行的回复在下一步才用新配置，
    // 不需要为了写配置先让用户停下手上的会话；切换供应商仍然要求空闲。
    if (!live) await this.assertProviderSwitchReady();
    await applyDshWebProvider(this.#client, env);
    for (const session of this.#sessions.values()) await this.#loadModelCatalog(session);
  }

  async catalog(archived = false): Promise<AgentSessionSummary[]> {
    return await this.#catalogRows(archived, false);
  }

  /**
   * `includeBlank` 是「侧栏目录」与「按 ID 恢复」的差别：还没有任何内容的新会话（原生
   * `blank`）不进侧栏，但手机可能记着它的 ID（上次选中、新分支、网页链接），照样要能打开。
   */
  async #catalogRows(archived: boolean, includeBlank: boolean): Promise<AgentSessionSummary[]> {
    const archiveIds = await this.#archivedSessionIds();
    const generation = this.#discovery.titles.generation;
    const result = await this.#client.request<Obj>("session/list", { _request: {} });
    if (generation !== this.#discovery.titles.generation) return this.#catalogRows(archived, includeBlank);
    const items = Array.isArray(result.items) ? result.items : Array.isArray(result.sessions) ? result.sessions : [];
    return items.flatMap(raw => {
      const item = object(raw); const id = typeof item.sessionId === "string" ? item.sessionId : typeof item.id === "string" ? item.id : undefined;
      const cwd = typeof item.cwd === "string" ? item.cwd : undefined;
      // Subagent identities require their durable parent address and cannot be
      // resumed through ordinary session/create. Blank sessions are browser drafts.
      if (!id || !cwd || archiveIds.has(id) !== archived || item.origin === "subagent" || (!includeBlank && item.blank === true)) return [];
      const local = this.#sessions.get(publicId(id));
      const title = this.#discovery.titles.read(id, item);
      return [{ sessionId: publicId(id), agentKind: "dsh" as const, hostname: localHostname(), cwd,
        archived,
        createdAt: local?.createdAt ?? Number(item.createdAt ?? item.updatedAt ?? Date.now()), modifiedAt: Number(item.updatedAt ?? item.createdAt ?? Date.now()),
        messageCount: local?.entries.length ?? 0, ...(title === undefined ? {} : { name: title ?? "" }) }];
    });
  }

  #archivedSessionIds(): Promise<Set<string>> {
    return new Promise((resolve, reject) => {
      let unsubscribe = () => {};
      const timer = setTimeout(() => { unsubscribe(); reject(new Error("DeepSeek Web 会话归档目录超时")); }, 15_000);
      const finish = (error?: Error, ids?: Set<string>) => { clearTimeout(timer); queueMicrotask(() => unsubscribe()); if (error) reject(error); else resolve(ids!); };
      unsubscribe = this.#client.subscribe("workspace/follow", {}, raw => {
        const frame = object(raw);
        if (frame.type === "baseline") finish(undefined, new Set((object(frame.value).archivedSessionIds as string[] | undefined) ?? []));
      }, error => finish(error));
    });
  }

  async setArchived(sessionId: string, archived: boolean): Promise<void> {
    if (!sessionId.startsWith("dsh:")) throw new Error("不属于 DeepSeek Harness 的会话");
    const runtimeId = sessionId;
    await this.#client.request(archived ? "workspace/archiveSession" : "workspace/unarchiveSession", { request: { sessionId: sessionId.slice(4) } });
    if (archived) {
      // Archiving is a sidebar/workspace operation. Once it succeeds, detach a
      // local runtime as well so the archived session cannot keep accepting
      // prompts through the phone while the Web registry blocks its work.
      const session = this.#sessions.get(runtimeId);
      if (session) this.#detachSession(session, "DeepSeek Web 会话已归档");
    }
  }

  activate(target: AgentActivateTarget): Promise<BackendActivation> {
    if (!this.#ready) return Promise.reject(new ActivationError("agent_unsupported", "DeepSeek Web 未连接"));
    if (target.type === "resume") {
      if (!target.sessionId.startsWith("dsh:")) return Promise.reject(new ActivationError("session_not_found", "不属于 DeepSeek Harness 的会话"));
      this.#detached.delete(target.sessionId.slice(4));
      const current = this.#sessions.get(target.sessionId);
      if (current && !current.closing) {
        return this.#ensureWorkspace(current.cwd).then(() => ({ sessionId: target.sessionId, spawnMode: "headless" as const }));
      }
      const prior = this.#activating.get(target.sessionId); if (prior) return prior;
      const operation = this.#scheduleActivation(target).finally(() => this.#activating.delete(target.sessionId));
      this.#activating.set(target.sessionId, operation); return operation;
    }
    return this.#scheduleActivation(target);
  }
  #scheduleActivation(target: AgentActivateTarget): Promise<BackendActivation> {
    const operation = this.#activate(target); return operation;
  }
  async #activate(target: AgentActivateTarget): Promise<BackendActivation> {
    let id: string; let cwd: string; let title: string | undefined; let createdAt = Date.now();
    if (target.type === "new") {
      cwd = target.cwd;
      if (!isAbsolute(cwd) || !(await stat(cwd).then(info => info.isDirectory(), () => false))) throw new ActivationError("cwd_missing", "请选择存在的绝对目录");
      const workspaceId = await this.#ensureWorkspace(cwd);
      const created = object(await this.#client.request("session/create", { request: { workspaceId } }));
      id = typeof created.sessionId === "string" ? created.sessionId : "";
      if (!id) throw new Error("DeepSeek Web 没有返回会话 ID");
    } else {
      id = target.sessionId.slice(4);
      const item = (await this.#catalogRows(false, true)).find(value => value.sessionId === target.sessionId);
      if (!item) throw new ActivationError("session_not_found", "找不到这个 DeepSeek Web 会话");
      cwd = item.cwd; createdAt = item.createdAt; title = item.name;
      const workspaceId = await this.#ensureWorkspace(cwd);
      await this.#client.request("session/create", { request: { sessionId: id, workspaceId } });
    }
    if (!this.#ready) throw new ActivationError("agent_unsupported", "DeepSeek Web 已断开");
    this.#detached.delete(id);
    // 重新打开一个刚 detach 的会话时，#sessions 里已经没有它；用发现流保存的原生 running，
    // 否则手机在下一帧状态通知到达前会把它显示成「空闲」。
    this.#attach({ sessionId: id, cwd, createdAt, ...(title === undefined ? {} : { title }), running: this.#sessions.get(publicId(id))?.running ?? this.#running.get(id) ?? false });
    return { sessionId: publicId(id), spawnMode: "headless" };
  }

  /**
   * Discovery publishes every live Session, but only work in progress occupies an
   * online card: an idle Agent stays a catalog row until the phone opens it.
   * `running` flipping false→true is new browser work, which also revives a
   * Session the phone had quit — an already-busy Session it quit stays detached.
   */
  #observe(item: DshLiveSession): void {
    const previous = this.#running.get(item.sessionId);
    this.#running.set(item.sessionId, item.running);
    if (this.#sessions.has(publicId(item.sessionId))) { this.#attach(item); return; }
    if (!item.running) return;
    if (this.#detached.has(item.sessionId) && previous !== false) return;
    this.#detached.delete(item.sessionId);
    this.#attach(item);
  }

  #attach(item: DshLiveSession): void {
    if (!this.#ready) return;
    const id = item.sessionId;
    const runtimeId = publicId(id);
    const current = this.#sessions.get(runtimeId);
    if (current) {
      const changed = current.cwd !== item.cwd || current.running !== item.running || item.title !== undefined && current.title !== item.title;
      current.cwd = item.cwd; current.running = item.running;
      if (item.title !== undefined) { if (item.title) current.title = item.title; else delete current.title; }
      if (!current.following) this.#followSession(current);
      if (changed) this.#publishMetadata(current);
      return;
    }
    const session: WebSession = { id, cwd: item.cwd, createdAt: item.createdAt, ...(item.title ? { title: item.title } : {}), entries: [], preparer: new SessionSyncPreparer(), skills: [], running: item.running, closing: false, options: [], lastSeq: -1, selectionSeq: -1, permissionSeq: -1, permissionSandboxSeq: -1, permissionApprovalSeq: -1, permissionGeneration: 0, permissionBusy: false, permissionOptions: [],
      source: new RecoverableSessionSource(publicId(id), event => {
        if (this.#sessions.get(publicId(id)) === session) this.#sink(event, publicId(id));
      }, { coalesceMs: this.#coalesceMs }), sourceCheckedAt: 0,
      notifications: new NotificationSource(randomUUID(), publicId(id), event => {
        if (this.#sessions.get(publicId(id))?.notifications.epoch === event.producerEpoch) this.#sink(event, publicId(id));
      }), skillsGeneration: 0, modelGeneration: 0, followGeneration: 0,
      queue: new Map(), deliverySeq: -1, deliveryGeneration: 0,
      activity: { type: "execution.activity", retry: "unavailable", compaction: "unavailable" }, activitySeq: -1,
      messages: new Map(), persistedMappings: new Map(), streamMessages: new Map(), streamIndexes: new Map(), retiredAttempts: new Set(), tools: new Map(), following: false, unsubscribe: () => {} };
    this.#sessions.set(runtimeId, session);
    // Announce before follow can deliver messages: APP needs the runtime identity first.
    this.#publishMetadata(session);
    this.#followSession(session);
    this.#publishCapabilities(session, true);
    void this.#loadSkills(session);
    void this.#loadModelCatalog(session);
    void this.#loadPermissions(session);
  }

  #followSession(session: WebSession): void {
    session.following = true;
    const generation = ++session.followGeneration;
    const fail = (error: unknown) => {
      if (this.#sessions.get(publicId(session.id)) !== session || session.closing || generation !== session.followGeneration) return;
      ++session.followGeneration;
      session.unsubscribe(); session.following = false;
      session.source.setAvailability(false, false);
      session.sourceCheckedAt = 0;
      if (session.sourceCheck) { clearTimeout(session.sourceCheck.timer); session.sourceCheck.reject(new Error(textOf(error))); delete session.sourceCheck; }
      this.#report(textOf(error), publicId(session.id));
      this.#discovery.retry();
    };
    // Only follow a native live Agent (or an explicitly activated Session).
    // The opening supplies a tail plus the current assistant prefix.
    try {
      session.unsubscribe = this.#client.subscribe("session/follow", { request: { address: { kind: "session", sessionId: session.id }, maxMessages: 2_000, assistantStream: true } },
        frame => { if (generation === session.followGeneration) this.#follow(session, frame); }, fail);
    } catch (error) { fail(error); }
  }

  dispatchCommand(runtimeId: string, commandId: string, command: RuntimeCommand): CommandDispatch {
    const session = this.#sessions.get(runtimeId); if (!this.#ready || !session) return "offline";
    if (!["user_message", "user_message.cancel", "stop", "session.sync", "slash.execute", "permissions.update", "interaction.respond"].includes(command.type)) return "unsupported";
    void this.#command(session, commandId, command).catch(error => this.#emit(session, { type: "command.result", commandId, ok: false, status: "failure", error: dshErrorText(error) }));
    return "handled";
  }
  async #command(session: WebSession, commandId: string, command: RuntimeCommand): Promise<void> {
    if (session.closing) throw new Error("DSH Web 会话正在关闭");
    // 只有命令可以带结果正文（`/tree` 的新分支会话 ID 与原文）；其余命令的结果只是回执。
    let result: unknown;
    switch (command.type) {
      case "session.sync": {
        if (command.sessionId !== publicId(session.id)) throw new Error("session_mismatch");
        if (command.range === "preview") await this.#checkSource(session);
        await this.#loadDelivery(session);
        this.#emit(session, structuredClone(session.activity));
        await this.#refreshPage(session, command.maxEntries,
          command.range === "history" ? webEntrySeqOrUndefined(command.beforeEntryId) : undefined);
        // 响应要带 `source.seq`，先刷掉合并窗口；否则客户端拿到的 knownState 会在窗口结束后失效
        // （ADR-0035 §15 的配套不变量）。
        session.source.flushPending();
        this.#emit(session, session.preparer.select({
          entries: session.entries, sessionId: command.sessionId,
          leafId: session.entries.at(-1)?.entryId ?? null, request: command,
          source: session.source.snapshot(),
          ...(session.entries[0]?.parentId == null ? {} : { historyBoundaryParentId: session.entries[0].parentId }),
        }));
        this.#publishCapabilities(session);
        this.#emit(session, { type: "interaction.snapshot", requests: [...this.#approvals.values()].filter(item => item.session === session).map(item => item.interaction) }); break;
      }
      case "user_message": await this.#prompt(session, commandId, command); return;
      case "user_message.cancel": {
        const queued = session.queue.get(command.messageId);
        const itemId = queued?.itemId ?? command.messageId;
        await this.#client.request("session/updateQueue", { request: { sessionId: session.id, itemId, action: { kind: "remove" } } });
        session.queue.delete(command.messageId);
        this.#emit(session, { type: "message.queued", queueId: command.messageId, text: queued?.text ?? command.messageId, delivery: queued?.delivery ?? "followUp", state: "cancelled" }); break;
      }
      case "stop":
        await this.#client.request("session/cancel", { request: { sessionId: session.id } });
        this.#cancelSessionApprovals(session, "cancelled"); break;
      case "interaction.respond": await this.#respondInteraction(session, command); break;
      case "permissions.update":
        if (command.settingId !== "permission-preset") throw new Error("权限设置不可用，请刷新会话");
        await this.#slash(session, command.value, "permission-preset"); break;
      case "slash.execute":
        if (command.name === "quit") {
          // 先中断、再回执、最后 detach：APP 收到 runtime.offline 时会把该 runtime 上未完成的
          // 命令记成 cancelled，回执必须先到；而 detach 不会停掉原生 turn，不自己发
          // session/cancel 就会变成「手机以为退出了，电脑上还在继续烧模型」。
          await this.#cancelRunningTurn(session);
          this.#emit(session, { type: "command.result", commandId, ok: true, status: "success" });
          this.#detached.add(session.id);
          this.#detachSession(session, "DeepSeek Web 会话已关闭");
          return;
        }
        result = await this.#slash(session, command.args, command.name); break;
      default: throw new Error("不支持的 DSH Web 命令");
    }
    this.#emit(session, { type: "command.result", commandId, ok: true, status: "success", ...(result === undefined ? {} : { result }) });
  }

  async #prompt(session: WebSession, commandId: string, command: Extract<RuntimeCommand, { type: "user_message" }>): Promise<void> {
    const fingerprint = createHash("sha256").update(JSON.stringify([command.text, command.attachments ?? [], command.delivery])).digest("hex");
    const prior = command.messageId ? session.messages.get(command.messageId) : undefined;
    if (prior) {
      const conflict = prior.fingerprint !== fingerprint;
      this.#emit(session, { type: "command.result", commandId, ok: !conflict && prior.status !== "failure",
        status: conflict ? "message_id_conflict" : prior.status });
      return;
    }
    const requestId = command.messageId ?? randomUUID();
    const content = [{ type: "text", text: command.text + (command.attachments?.length ? `\n\n附件路径：\n${command.attachments.join("\n")}` : "") }];
    const delivery = command.delivery ?? "followUp";
    const receipt: { fingerprint: string; status: "pending" | "success" | "failure" | "cancelled" } = { fingerprint, status: "pending" };
    session.messages.set(requestId, receipt);
    session.queue.set(requestId, { itemId: requestId, text: command.text, delivery });
    this.#emit(session, { type: "command.result", commandId, ok: true, status: "pending" });
    const mode = command.delivery === "steer" ? "steer" : "queue";
    try {
      await this.#client.request("session/prompt", { request: { requestId, sessionId: session.id, mode, content } });
      receipt.status = "success"; session.running = true;
      this.#publishMetadata(session);
      this.#emit(session, { type: "message.queued", queueId: requestId, text: command.text, delivery, state: "accepted" });
      this.#emit(session, { type: "command.result", commandId, ok: true, status: "success" });
    } catch (error) { receipt.status = "failure"; session.queue.delete(requestId); throw error; }
  }

  async #slash(session: WebSession, args: string, name: string): Promise<unknown> {
    if (name === "tree") return await this.#tree(session, args.trim());
    if (name === "permission-preset") {
      if (session.running || session.permissionBusy || [...this.#approvals.values()].some(item => item.session === session)) throw new Error("请先完成当前任务和待处理审批，再调整权限");
      const selected = args.trim();
      if (!session.permissionOptions?.some(option => option.value === selected)) throw new Error("权限配置不可用，请刷新会话");
      session.permissionBusy = true;
      try {
        const result = object(await this.#client.request("commands/execute", { agentId: session.id, line: `/permission ${selected}`, submittedAttachments: [] }));
        const outcome = object(result.result);
        if (outcome.kind !== "success") throw new Error(typeof outcome.text === "string" ? outcome.text : "DSH 未确认权限命令");
        const baseline = await this.#client.request("session/projections", { request: { sessionId: session.id } });
        this.#permissionProjection(session, baseline);
        if (session.permissionProfile !== selected) throw new Error("权限设置未确认，请检查当前配置后重试");
      } finally { session.permissionBusy = false; this.#publishMetadata(session); }
      return;
    }
    if (name === "name") {
      const title = args.trim(); if (!title) throw new Error("会话名称不能为空");
      const result = object(await this.#client.request("session/rename", { request: { sessionId: session.id, title } }));
      this.#titleProjection(session.id, { asOfSeq: result.seq, values: { title: result.title } });
      return;
    }
    if (name === "fork" || name === "clone") {
      const parsed = args.trim() === "" ? undefined : Number(args.trim());
      if (parsed !== undefined && !Number.isSafeInteger(parsed)) throw new Error("分支位置必须是有效事件序号");
      const result = object(await this.#client.request("session/fork", { request: { sessionId: session.id, ...(parsed === undefined ? {} : { atSeq: parsed }) } }));
      if (typeof result.sessionId === "string") session.notifications.outcome({ code: "dsh.fork", occurrenceId: result.sessionId,
        scope: { operationId: result.sessionId }, severity: "info", message: `已创建分支 dsh:${result.sessionId}` }); return;
    }
    if (name === "session") return; // Chat recovery uses the owned, bounded session.sync task.
    if (name === "skills") { await this.#client.request("skills/list", { request: { sessionId: session.id } }); return; }
    const skill = session.skills.find(item => item.name === name);
    if (skill) {
      const text = `/${name}${args.trim() ? ` ${args.trim()}` : ""}`;
      const requestId = randomUUID();
      await this.#client.request("session/prompt", { request: { requestId, sessionId: session.id, mode: "queue", content: [{ type: "text", text }] } });
      session.queue.set(requestId, { itemId: requestId, text, delivery: "followUp" });
      return;
    }
    if (name === "model") {
      const catalog = session.modelCatalog ?? object(await this.#client.request("session/modelCatalog", {}));
      const model = this.#findModel(catalog, args.trim());
      if (!model) throw new Error("找不到模型");
      const result = object(await this.#client.request("session/selectModel", { request: { sessionId: session.id, provider: model.provider, model: model.model, ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}) } }));
      // DSH 返回规范化后的选择；`modelSelection` 投影随后会用同一个值覆盖它。
      this.#applySelection(session, result.selected);
      return;
    }
    if (name === "thinking") {
      const selected = args.trim();
      const current = this.#selection(session);
      if (!current) throw new Error("请先选择模型");
      let effort = selected;
      try { const parsed = JSON.parse(selected) as unknown; if (typeof parsed === "string") effort = parsed; } catch { /* Plain effort id. */ }
      const available = this.#thinkingChoices(session).some(choice => choice.value === effort);
      if (!available) throw new Error("找不到思考级别");
      const result = object(await this.#client.request("session/selectModel", { request: { sessionId: session.id, provider: current.provider, model: current.model, reasoningEffort: effort } }));
      this.#applySelection(session, result.selected);
      return;
    }
    throw new Error(`不支持的 DSH Web 命令：/${name}`);
  }
  /**
   * `/tree <entryId>`：DSH 的原生日志不支持「回到某条消息」，分支是 `session/fork` 从某个
   * 事件切点复制包含前缘的前缀、生成一个新会话。因此：
   *
   * - 落到用户消息 = 从它**之前**切，原文交回手机（改完重发就是新分支）；
   * - 落到别的节点 = 从它本身切，接着往下聊。
   *
   * 结果里带新会话 ID，手机据此切到新分支；新分支在这里就接入，免得手机的 resume 与原生
   * 会话目录抢跑。整个动作不改动原会话。
   */
  async #tree(session: WebSession, entryId: string): Promise<{ sessionId: string; editorText?: string }> {
    const entry = session.entries.find(candidate => candidate.entryId === entryId);
    if (!entry) throw new Error("找不到这条记录，请刷新会话后重试");
    const seq = webEntrySeqOrUndefined(entryId);
    if (seq === undefined) throw new Error("这条记录没有可用的原生事件序号");
    const editing = object(entry.data.message).role === "user";
    const atSeq = editing ? seq - 1 : seq;
    if (atSeq < 0) throw new Error("这条消息是会话的第一条，没有更早的内容可以回退");
    const fork = object(await this.#client.request("session/fork", { request: { sessionId: session.id, atSeq } }));
    const childId = typeof fork.sessionId === "string" ? fork.sessionId : "";
    if (!childId) throw new Error("DeepSeek Web 没有返回新分支的会话 ID");
    // 这是用户明确要的跳转，不是目录发现：新分支即使空闲也直接接入。
    this.#attach({ sessionId: childId, cwd: session.cwd, createdAt: Date.now(), running: false });
    const editorText = editing ? dshWebEntryText(entry) : "";
    return { sessionId: publicId(childId), ...(editorText ? { editorText } : {}) };
  }
  /**
   * `/quit` 的前半段：让原生 turn 真正停下来。
   *
   * 取消失败就**不** detach：APP 一旦失去这个 runtime，就再没有入口看见或停止仍在电脑上
   * 运行的会话；失败必须如实回给手机，让用户重试。
   */
  async #cancelRunningTurn(session: WebSession): Promise<void> {
    if (!session.running) return;
    try {
      await this.#client.request("session/cancel", { request: { sessionId: session.id } });
      session.running = false;
    } catch (error) {
      throw new Error(`无法中断 DeepSeek Web 会话：${dshErrorText(error)}`);
    }
  }
  #findModel(catalog: Obj, selected: string): { provider: string; model: string; reasoningEffort?: string } | undefined {
    let parsed: Obj = {};
    try { parsed = object(JSON.parse(selected)); } catch { /* A plain model id remains valid. */ }
    const providerHint = typeof parsed.provider === "string" ? parsed.provider : undefined;
    const modelHint = typeof parsed.model === "string" ? parsed.model : undefined;
    const effortHint = typeof parsed.reasoningEffort === "string" ? parsed.reasoningEffort : undefined;
    for (const group of arrayObjects(catalog.groups)) {
      const provider = typeof group.provider === "string" ? group.provider : typeof group.id === "string" ? group.id : "";
      for (const model of arrayObjects(group.models)) {
        const id = typeof model.id === "string" ? model.id : typeof model.model === "string" ? model.model : "";
        if ((modelHint !== undefined && id === modelHint && (providerHint === undefined || provider === providerHint)) || (modelHint === undefined && (id === selected || wire(id) === selected))) return { provider, model: id, ...(effortHint === undefined ? {} : { reasoningEffort: effortHint }) };
      }
    }
    return undefined;
  }

  async #respondInteraction(session: WebSession, command: Extract<RuntimeCommand, { type: "interaction.respond" }>): Promise<void> {
    const pending = this.#approvals.get(command.requestId); if (!pending || pending.session !== session || command.extensionId !== "dsh") throw new Error("交互已结束或不属于这个会话");
    if (pending.responding) throw new Error("答案正在提交，请稍候");
    const response = command.response;
    let value: unknown;
    if (response.kind !== "cancel") {
      if (pending.interaction.kind === "questionnaire") value = dshUserQuestionAnswer(pending.interaction, response);
      else {
        if (response.kind !== "select" || pending.interaction.kind !== "select" || !pending.interaction.options.some(option => option.value === response.value)) throw new Error("无效的 DSH 审批选项");
        value = response.value;
      }
    }
    pending.responding = true;
    try {
      await this.#client.respondEvent(pending.id, response.kind === "cancel"
        ? { kind: "rejected", error: { name: "AbortError", message: "cancelled" } }
        : { kind: "result", value });
    } catch (error) { pending.responding = false; throw error; }
    if (this.#approvals.get(command.requestId) !== pending) return;
    clearTimeout(pending.timer); this.#approvals.delete(command.requestId); pending.releaseWait?.();
    this.#emit(session, { type: "interaction.resolved", requestId: command.requestId, source: "remote" });
  }

  #event(event: DshWebEvent): void {
    if (!this.#ready) return;
    if (event.type === "emit") {
      if (event.event === "permission-presets/catalog-changed") for (const session of this.#sessions.values()) void this.#loadPermissions(session);
      this.#discovery.event(event); return;
    }
    if (event.type === "cancel") { this.#cancelApproval(event.eventId, "cancelled"); return; }
    if (event.type !== "waterfall") return;
    if (event.event !== "approval/request" && event.event !== "permission/request" && event.event !== "user-questions/request") { void this.#client.respondEvent(event.eventId, { kind: "next" }).catch(() => {}); return; }
    const agentId = event.agentId.replace(/^dsh:/, "");
    const session = this.#sessions.get(publicId(agentId)); if (!session || session.closing) { void this.#client.respondEvent(event.eventId, { kind: "next" }).catch(() => {}); return; }
    const request = object(event.request);
    if (event.event === "user-questions/request") { this.#questionEvent(session, event, request); return; }
    const rawOptions = Array.isArray(request.options) ? request.options : Array.isArray(request.choices) ? request.choices : [];
    const options = event.event === "approval/request" && rawOptions.length === 0
      ? [{ value: "allowed-once", label: "允许一次" }, { value: "rejected", label: "拒绝" }]
      : rawOptions.map((value, index) => { const item = object(value); const id = String(item.id ?? item.optionId ?? item.value ?? `option-${index}`); return { value: id, label: String(item.label ?? item.name ?? id) }; });
    const requestId = event.eventId;
    const previous = this.#approvals.get(requestId);
    if (previous) {
      // The gateway replays an unresolved waterfall after a carrier
      // reconnect. Keep one Orbis interaction and extend its deadline instead
      // of showing a duplicate approval or allowing the old timer to cancel
      // the replayed request.
      clearTimeout(previous.timer);
      const timer = setTimeout(() => this.#cancelApproval(requestId, "timeout"), 300_000); timer.unref();
      previous.timer = timer;
      previous.id = event.eventId;
      return;
    }
    const interaction: InteractionRequest = { kind: "select", runtimeId: publicId(session.id), requestId, extensionId: "dsh", title: String(request.title ?? request.toolName ?? "DeepSeek 工具执行审批"), description: String(request.description ?? object(request.displayReason)["zh-CN"] ?? object(request.displayReason).zh ?? request.reason ?? object(request.displayReason).en ?? "请确认 DeepSeek Harness 是否执行此操作"), expiresAt: Date.now() + 300_000, options: options.length ? options : [{ value: "allow", label: "允许" }, { value: "reject", label: "拒绝" }] };
    // The Gateway replays still-pending waterfall requests after a carrier
    // reconnect. Keep the original UI request and timer instead of emitting a
    // duplicate prompt; the client's event generation has already been updated.
    if (this.#approvals.has(requestId)) return;
    const timer = setTimeout(() => this.#cancelApproval(requestId, "timeout"), 300_000); timer.unref();
    this.#approvals.set(requestId, { id: event.eventId, session, interaction, timer }); this.#emit(session, { type: "interaction.requested", request: interaction });
  }
  #questionEvent(session: WebSession, event: Extract<DshWebEvent, { type: "waterfall" }>, request: Obj): void {
    const interaction = dshUserQuestionInteraction(publicId(session.id), event.eventId, request);
    if (!interaction) { void this.#client.respondEvent(event.eventId, { kind: "next" }).catch(() => {}); return; }
    const previous = this.#approvals.get(event.eventId);
    if (previous) { clearTimeout(previous.timer); previous.releaseWait?.(); }
    const pending: Approval = { id: event.eventId, session, interaction: previous?.interaction ?? interaction };
    this.#approvals.set(event.eventId, pending);
    const wait = object(request.wait);
    if (wait.timed !== true || typeof wait.callId !== "string") {
      if (!previous) this.#emit(session, { type: "interaction.requested", request: interaction });
      return;
    }
    // A timed question requires a business-stream claim before exposing its
    // countdown. Reattach that claim when the gateway replays the waterfall.
    let opened = false;
    try {
      pending.releaseWait = this.#client.subscribe("userQuestions/attachWait", { agentId: session.id, callId: wait.callId }, raw => {
        if (this.#approvals.get(event.eventId) !== pending || opened) return;
        const remainingMs = object(raw).remainingMs;
        if (typeof remainingMs !== "number" || !Number.isFinite(remainingMs) || remainingMs <= 0) { this.#cancelApproval(event.eventId, "timeout"); return; }
        opened = true;
        pending.interaction = { ...interaction, expiresAt: Date.now() + Math.ceil(remainingMs) };
        pending.timer = setTimeout(() => this.#cancelApproval(event.eventId, "timeout"), remainingMs); pending.timer.unref();
        this.#emit(session, { type: "interaction.requested", request: pending.interaction });
      }, () => {
        if (this.#approvals.get(event.eventId) === pending) this.#cancelApproval(event.eventId, "cancelled");
      });
      if (this.#approvals.get(event.eventId) !== pending) pending.releaseWait();
    } catch { this.#cancelApproval(event.eventId, "cancelled"); }
  }
  #cancelApproval(id: string, reason: "cancelled" | "timeout" | "disconnected" | "owner_closed"): void {
    const pending = this.#approvals.get(id); if (!pending) return;
    clearTimeout(pending.timer); this.#approvals.delete(id); pending.releaseWait?.();
    const timedOut = reason === "timeout" && pending.interaction.kind === "questionnaire";
    void this.#client.respondEvent(pending.id, { kind: "rejected", error: { name: "AbortError", message: reason, ...(timedOut ? { code: "ASK_TIMED_OUT" } : {}) } }).catch(() => {});
    this.#emit(pending.session, { type: "interaction.cancelled", requestId: id, reason });
  }
  #cancelSessionApprovals(session: WebSession, reason: "cancelled" | "owner_closed"): void { for (const [id, item] of this.#approvals) if (item.session === session) this.#cancelApproval(id, reason); }

  #follow(session: WebSession, value: unknown): void {
    if (this.#sessions.get(publicId(session.id)) !== session || session.closing) return;
    session.source.transaction(() => this.#followFrame(session, value));
  }
  #followFrame(session: WebSession, value: unknown): void {
    const frame = object(value);
    if (frame.type === "snapshot") {
      if (!Array.isArray(frame.records) || frame.header === null || typeof frame.header !== "object"
        || !Number.isSafeInteger(frame.cursor) || Number(frame.cursor) < -1
        || frame.records.some(record => { const event = object(object(record).event);
          return !Number.isSafeInteger(event.seq) || Number(event.seq) < 0 || !Number.isFinite(event.time) || typeof event.type !== "string";
        })) return;
      const header = object(frame.header); const events = arrayObjects(frame.records).map(record => { const event = object(record.event); return { seq: Number(event.seq), time: Number(event.time), type: String(event.type), data: event.data }; });
      this.#titleProjection(session.id, frame.projections, true);
      this.#permissionProjection(session, frame.projections);
      this.#deliveryProjection(session, frame.projections);
      this.#modelSelectionProjection(session, frame.projections);
      for (const event of events) this.#permissionEvent(session, event);
      this.#rememberTools(session, events);
      const snapshotEntries = dshWebEntries(session.id, events);
      // `session/follow` always opens with a bounded tail page. On a WebSocket
      // reconnect the same session object already owns its older prefix; replacing
      // it with that tail would make a transient carrier disconnect erase history
      // from the phone. Durable Session events are append-only, so merge by the
      // stable Web entry id and retain the existing order.
      if (session.entries.length === 0) { session.entries = snapshotEntries; session.preparer.invalidate(); }
      else {
        const entries = new Map(session.entries.map(entry => [entry.entryId, entry]));
        for (const entry of snapshotEntries) if (!entries.has(entry.entryId)) entries.set(entry.entryId, entry);
        session.entries = [...entries.values()].sort((left, right) => webEntrySeq(left.entryId) - webEntrySeq(right.entryId));
    session.preparer.invalidate();
        session.preparer.invalidate();
      }
      session.lastSeq = Math.max(session.lastSeq, Number(frame.cursor ?? -1)); session.createdAt = Number(header.createdAt ?? session.createdAt); session.cwd = typeof header.cwd === "string" ? header.cwd : session.cwd;
      this.#syncSnapshotTurnState(session, events);
      // This bounded native window cannot confirm activity omitted before its first event.
      if (Number(frame.cursor) >= session.activitySeq) {
        session.activity = { type: "execution.activity", retry: "unavailable", compaction: "unavailable" };
        session.activitySeq = -1; delete session.compactionId;
        let turnId: string | undefined;
        for (const event of events) {
          if (event.type === "turn/start") turnId = dshWebEntryId(session.id, event.seq);
          this.#activityEvent(session, event, false, { turnId });
          if (event.type === "turn/end") turnId = undefined;
        }
      }
      this.#emit(session, structuredClone(session.activity));
      this.#publishMetadata(session);
      // A phone can attach after the browser already received part of a reply.
      // Restore that prefix before accepting the following live chunks.
      const priorStreams = session.streamMessages;
      session.streamMessages = new Map();
      session.streamIndexes.clear();
      session.source.replaceLive({ complete: false, turn: null, messages: [], tools: [] });
      session.tools.clear();
      this.#rememberTools(session, events);
      for (const event of events) {
        const data = object(event.data);
        if (event.type === "tool/result") session.tools.delete(String(object(data.message).toolCallId));
      }
      if (session.turnId && session.turnStartedAt !== undefined) session.source.observe({ type: "turn.started", turnId: session.turnId, startedAt: session.turnStartedAt });
      for (const event of events) {
        if (event.type !== "tool/call") continue;
        const data = object(event.data);
        const toolCallId = String(data.callId ?? dshWebEntryId(session.id, event.seq));
        if (!session.tools.has(toolCallId)) continue;
        let args: unknown = data.arguments ?? {};
        if (typeof args === "string") { try { args = JSON.parse(args); } catch { /* Preserve native text. */ } }
        session.source.observe({ type: "tool.started", toolCallId, toolName: session.tools.get(toolCallId)!, arguments: args });
      }
      const attempt = object(object(frame.assistantStream).activeAttempt);
      if (typeof attempt.attemptId === "string") {
        session.retiredAttempts.delete(attempt.attemptId);
        this.#assistantFrame(session, { type: "start", attemptId: attempt.attemptId,
          time: Number(attempt.startedAt ?? priorStreams.get(attempt.attemptId)?.timestamp ?? Date.now()) });
        const stream = Array.isArray(attempt.stream) ? attempt.stream : [];
        const records = this.#decoder ? this.#decoder(stream) : arrayObjects(stream);
        for (const record of records) this.#assistantFrame(session, { type: "chunk", attemptId: attempt.attemptId, time: record.time, chunk: record.chunk });
      }
      this.#reconcileSource(session);
      // ADR-0043：有界 follow tail 里没有本轮的 `turn/start`，只说明「本轮起点不在这一页」，
      // 不说明 live 清单不完整：live 正文来自 assistantStream 的完整前缀，后续事件按 seq
      // 顺序应用，缺口由 #checkSource 重新核对。以前这里据此把 complete 降成 false，
      // checkpoint 于是不再是基线——Host 丢掉 canonical、手机既不能投影也不能应用 patch，
      // 运行期间的历史就整段消失（现场：长轮次一开头，聊天页只剩本轮 live 卡片）。
      session.source.setAvailability(true, true);
      session.sourceCheckedAt = Date.now();
      if (session.sourceCheck) { clearTimeout(session.sourceCheck.timer); session.sourceCheck.resolve(); delete session.sourceCheck; }
      session.notifications.resolve("dsh.recovery");
      // 这份 baseline 刚改过 durable 日志，历史树可能变了。去重后没有变化就什么都不发。
      this.#publishCapabilities(session);
      return;
    }
    if (frame.type === "event") { const event = object(frame.event); this.#applyEvent(session, { seq: Number(event.seq), time: Number(event.time), type: String(event.type), data: event.data }); return; }
    if (frame.type === "assistant-stream") this.#assistantFrame(session, object(frame.frame));
  }
  async #refreshPage(session: WebSession, maxMessages = 2_000, beforeSeq?: number): Promise<void> {
    // Empty Sessions have a valid `-1` cursor. Sending 0 makes the Web
    // controller reject the page because it is past that Session's log.
    const generation = session.followGeneration;
    const throughSeq = session.lastSeq < 0 ? -1 : session.lastSeq;
    const result = object(await this.#client.request("session/page", { request: {
      address: { kind: "session", sessionId: session.id },
      throughSeq, ...(beforeSeq === undefined ? {} : { beforeSeq }),
      maxMessages: Math.min(2_000, Math.max(1, maxMessages)),
    } }));
    if (generation !== session.followGeneration || session.closing || this.#sessions.get(publicId(session.id)) !== session) throw new Error("session_source_changed");
    if (!Array.isArray(result.records)) return;
    const events = arrayObjects(result.records).map(record => {
      const event = object(record.event);
      return { seq: Number(event.seq), time: Number(event.time), type: String(event.type), data: event.data };
    }).filter(event => Number.isSafeInteger(event.seq));
    if (events.length === 0) return;
    this.#rememberTools(session, events);
    const pageEntries = dshWebEntries(session.id, events);
    const entries = new Map(session.entries.map(entry => [entry.entryId, entry]));
    for (const entry of pageEntries) if (!entries.has(entry.entryId)) entries.set(entry.entryId, entry);
    session.entries = [...entries.values()].sort((left, right) => webEntrySeq(left.entryId) - webEntrySeq(right.entryId));
    session.lastSeq = Math.max(session.lastSeq, ...events.map(event => event.seq));
    this.#reconcileSource(session);
  }
  #syncSnapshotTurnState(session: WebSession, events: readonly DshWebLogEvent[]): void {
    let start: DshWebLogEvent | undefined;
    let boundarySeen = false;
    for (const event of events) {
      if (event.type === "turn/start") { start = event; boundarySeen = true; }
      else if (event.type === "turn/end") { start = undefined; boundarySeen = true; }
    }
    // A bounded reconnect tail may begin in the middle of an existing turn and
    // contain no boundary. Preserve the live bit in that case.
    if (!boundarySeen) return;
    if (start === undefined) {
      session.running = false;
      delete session.turnId;
      delete session.turnStartedAt;
      return;
    }
    session.running = true;
    session.turnId = dshWebEntryId(session.id, start.seq);
    session.turnStartedAt = start.time;
  }
  #rememberTools(session: WebSession, events: readonly { type: string; data: unknown }[]): void {
    for (const event of events) {
      if (event.type !== "tool/call") continue;
      const data = object(event.data);
      const callId = typeof data.callId === "string" ? data.callId : undefined;
      const name = typeof data.name === "string" && data.name.length > 0 ? data.name : undefined;
      if (callId && name) session.tools.set(callId, name);
    }
  }
  #applyEvent(session: WebSession, event: DshWebLogEvent): void {
    session.source.transaction(() => {
      this.#applyNativeEvent(session, event);
      this.#reconcileSource(session);
    });
  }
  #applyNativeEvent(session: WebSession, event: { seq: number; time: number; type: string; data: unknown }): void {
    if (!Number.isSafeInteger(event.seq) || event.seq <= session.lastSeq) return;
    if (session.lastSeq >= 0 && event.seq !== session.lastSeq + 1) {
      session.source.setAvailability(false, false);
      session.sourceCheckedAt = 0;
      void this.#checkSource(session).catch(error => this.#report(textOf(error), publicId(session.id)));
      return;
    }
    if (session.lastSeq === -1 && event.seq === 0) session.source.setAvailability(true, !session.running);
    session.lastSeq = event.seq;
    this.#activityEvent(session, event);
    this.#permissionEvent(session, event);
    const data = object(event.data);
    if (event.type === "tool/call") {
      const toolCallId = String(data.callId ?? dshWebEntryId(session.id, event.seq));
      const toolName = typeof data.name === "string" && data.name.length > 0 ? data.name : "tool";
      session.tools.set(toolCallId, toolName);
      let args: unknown = data.arguments ?? {};
      if (typeof args === "string") {
        try { args = JSON.parse(args) as unknown; } catch { /* Preserve malformed tool JSON as text. */ }
      }
      this.#emit(session, { type: "tool.started", toolCallId, toolName, arguments: args });
    }
    const existing = dshWebMessage(session.id, event, session.tools);
    const entry = dshWebEntries(session.id, [event])[0];
    if (entry) { session.entries.push(entry); session.preparer.invalidate(); }
    if (entry && (event.type === "assistant/message" || event.type === "tool/result")) {
      const raw = event.type === "assistant/message" ? data.message : object(data.message);
      if (typeof object(raw).id === "string") session.persistedMappings.set(String(object(raw).id), entry.entryId);
    }
    if (event.type === "user/message") {
      const source = object(data.source);
      const requestId = typeof source.rpcId === "string" ? source.rpcId : undefined;
      if (requestId) {
        const prior = session.messages.get(requestId);
        if (prior && entry?.entryId !== undefined) prior.entryId = entry.entryId;
        if (entry?.entryId) session.persistedMappings.set(requestId, entry.entryId);
        const queued = session.queue.get(requestId);
        if (queued) {
          session.queue.delete(requestId);
          this.#emit(session, { type: "message.queued", queueId: requestId, text: queued.text, delivery: queued.delivery, state: "delivered" });
        }
      }
      if (existing) this.#emit(session, { type: "message.started", message: existing });
    }
    if (event.type === "turn/start") {
      session.running = true;
      session.turnId = dshWebEntryId(session.id, event.seq);
      session.turnStartedAt = event.time;
      session.source.setAvailability(true, true);
      this.#emit(session, { type: "turn.started", turnId: session.turnId, startedAt: event.time, ...(typeof data.turn === "number" ? { turnIndex: data.turn } : {}) });
    }
    if (event.type === "tool/result") {
      const message = existing;
      const toolCallId = message?.toolCallId ?? String(object(data.message).toolCallId ?? dshWebEntryId(session.id, event.seq));
      const toolName = session.tools.get(toolCallId) ?? "tool";
      this.#emit(session, { type: "tool.finished", toolCallId, toolName, result: message?.content ?? data.message ?? null, isError: message?.isError === true });
      session.tools.delete(toolCallId);
    }
    if (event.type === "turn/end") {
      session.running = false;
      const turnId = session.turnId ?? dshWebEntryId(session.id, event.seq);
      const startedAt = session.turnStartedAt ?? event.time;
      const persistedMessages = [...session.persistedMappings.entries()].map(([messageId, entryId]) => ({ messageId, entryId }));
      // Keep unresolved attempt identities through turn end; the canonical event can arrive later.
      delete session.turnId;
      delete session.turnStartedAt;
      session.source.setAvailability(true, true);
      this.#emit(session, { type: "turn.finished", turnId, startedAt, durationMs: Math.max(0, event.time - startedAt), ...(typeof data.turn === "number" ? { turnIndex: data.turn } : {}), ...(persistedMessages.length ? { persistedMessages } : {}) });
    }
    if (existing) this.#emit(session, { type: "message.finished", message: existing });
    this.#publishMetadata(session);
  }
  #assistantFrame(session: WebSession, frame: Obj): void {
    session.source.transaction(() => {
      this.#applyAssistantFrame(session, frame);
      if (frame.type === "end") this.#reconcileSource(session);
    });
  }
  #applyAssistantFrame(session: WebSession, frame: Obj): void {
    const attempt = String(frame.attemptId ?? "assistant");
    if (session.retiredAttempts.has(attempt)) return;
    if (frame.type === "start") {
      if (session.streamMessages.has(attempt)) return;
      const message: ChatMessage = { messageId: attempt, role: "assistant", content: [], timestamp: Number(frame.time ?? Date.now()) };
      session.streamMessages.set(attempt, message);
      session.streamIndexes.set(attempt, 0);
      this.#emit(session, { type: "message.started", message }); return;
    }
    if (frame.type === "chunk") {
      const expected = session.streamIndexes.get(attempt) ?? 0;
      if (typeof frame.index === "number" && frame.index < expected) return;
      if (typeof frame.index === "number" && frame.index !== expected) {
        const live = session.source.snapshot().live;
        session.source.replaceLive({ ...live, complete: false, messages: live.messages.map(item => item.message.messageId === attempt ? { ...item, contentComplete: false } : item) });
        session.sourceCheckedAt = 0;
      }
      session.streamIndexes.set(attempt, typeof frame.index === "number" ? frame.index + 1 : expected + 1);
      let message = session.streamMessages.get(attempt);
      if (!message) {
        message = { messageId: attempt, role: "assistant", content: [], timestamp: Number(frame.time ?? Date.now()) };
        session.streamMessages.set(attempt, message);
        session.source.upsertMessage({ message, finished: false, contentComplete: false });
      }
      let chunk = object(frame.chunk);
      if (chunk.type === "chunk" && chunk.chunk !== undefined) chunk = object(chunk.chunk);
      if (this.#decoder && (chunk.type === "text-chunks" || chunk.type === "reasoning-chunks" || chunk.type === "tool-call-chunks")) {
        chunk = object(this.#decoder([frame.chunk])[0]?.chunk);
      }
      const text = chunk.type === "text-delta" || chunk.type === "reasoning-delta"
        ? String(chunk.text ?? "") : chunk.type === "tool-call-delta" ? String(chunk.argumentsDelta ?? "") : "";
      if (!text && chunk.type !== "tool-call-delta") return;
      const contentType = frame.reasoning === true || chunk.type === "reasoning-delta" ? "thinking" : chunk.type === "tool-call-delta" ? "tool_call" : "text";
      const previous = message.content.at(-1);
      // Stream chunks are fragments of one block; the phone renders each block separately.
      if ((contentType === "text" || contentType === "thinking") && previous?.type === contentType) previous.text += text;
      else if (contentType === "thinking") message.content.push({ type: "thinking", text });
      else if (contentType === "tool_call") {
        const toolCallId = String(chunk.id ?? attempt);
        const block = message.content.find(block => block.type === "tool_call" && block.toolCallId === toolCallId);
        if (block?.type === "tool_call") {
          block.arguments = String(block.arguments ?? "") + text;
          if (typeof chunk.name === "string") block.toolName = chunk.name;
        } else message.content.push({ type: "tool_call", toolCallId, toolName: String(chunk.name ?? "tool"), arguments: text });
      }
      else message.content.push({ type: "text", text });
      session.source.upsertMessage({ message, finished: false, contentComplete: session.source.snapshot().live.messages.find(item => item.message.messageId === attempt)?.contentComplete ?? false });
      return;
    }
    if (frame.type === "end") {
      session.retiredAttempts.add(attempt);
      if (session.retiredAttempts.size > 256) session.retiredAttempts.delete(session.retiredAttempts.values().next().value!);
      const message = session.streamMessages.get(attempt);
      if (message) session.source.upsertMessage({ message, finished: true,
        contentComplete: session.source.snapshot().live.messages.find(item => item.message.messageId === attempt)?.contentComplete ?? false });
      const outcome = object(frame.outcome);
      if (outcome.kind === "committed" && typeof outcome.seq === "number") {
        session.persistedMappings.set(attempt, dshWebEntryId(session.id, outcome.seq));
        // Completion can precede its canonical event. Retain its body until that commit.
      } else {
        session.streamMessages.delete(attempt);
        const live = session.source.snapshot().live;
        session.source.replaceLive({ ...live, messages: live.messages.filter(item => item.message.messageId !== attempt) });
      }
    }
  }

  #reconcileSource(session: WebSession): void {
    const mappings = [...session.persistedMappings].map(([messageId, entryId]) => ({ messageId, entryId }));
    // 只加载了尾部若干条目时，最旧条目的父条目就是原生历史的已验证边界：显示投影据此
    // 把「更旧的还没读进来」和「这条分支真的缺父」区分开。
    session.source.setHistoryBoundary(session.entries[0]?.parentId ?? null);
    session.source.reconcile(session.entries, session.entries.at(-1)?.entryId ?? null, mappings);
    const ids = new Set(session.entries.map(entry => entry.entryId));
    for (const [id, entryId] of session.persistedMappings) if (ids.has(entryId)) {
      session.streamMessages.delete(id);
      session.streamIndexes.delete(id);
      session.persistedMappings.delete(id);
    }
  }

  #checkSource(session: WebSession): Promise<void> {
    if (session.sourceCheck) return session.sourceCheck.promise;
    if (session.sourceCheckedAt > 0 && Date.now() - session.sourceCheckedAt < 15_000) return Promise.resolve();
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    const timer = setTimeout(() => {
      if (session.sourceCheck?.promise !== promise) return;
      delete session.sourceCheck;
      session.source.setAvailability(false, false);
      reject(new Error("DeepSeek 当前会话状态恢复超时"));
    }, 15_000);
    timer.unref();
    session.sourceCheck = { promise, resolve, reject, timer };
    // Reopening the native follow atomically captures current history and assistant prefix.
    session.unsubscribe();
    this.#followSession(session);
    return promise;
  }

  async #resyncAll(): Promise<void> {
    this.#discovery.titles.reconnect();
    for (const session of this.#sessions.values()) {
      session.unsubscribe(); session.following = false;
      ++session.followGeneration;
      session.source.setAvailability(false, false);
      session.sourceCheckedAt = 0;
      if (session.sourceCheck) { clearTimeout(session.sourceCheck.timer); session.sourceCheck.reject(new Error("native_connection_replaced")); delete session.sourceCheck; }
      session.notifications.upsert({ code: "dsh.recovery", occurrenceId: "follow", scope: {}, severity: "info", lifecycle: "condition", message: "DeepSeek Web 已重连，会话流正在恢复" });
    }
    await this.#discovery.reconnect();
  }
  #metadata(session: WebSession): RuntimeMetadata {
    const selection = this.#selection(session);
    return { runtimeId: publicId(session.id), sessionId: publicId(session.id), name: "DeepSeek Harness Web", ...(session.title ? { sessionName: session.title } : {}), cwd: session.cwd, hostname: localHostname(), status: session.running ? "running" : "idle", sessionGraphSync: true, ...this.#permissionMetadata(session), ...(dshPermissions(session.permissionProfile, session.permissionSandbox, session.permissionApproval) ? { permissions: dshPermissions(session.permissionProfile, session.permissionSandbox, session.permissionApproval) } : {}), sessionLeafId: session.entries.at(-1)?.entryId ?? null, ...(selection === undefined ? {} : { model: this.#modelInfo(session.modelCatalog, selection.provider, selection.model) }), ...(selection?.reasoningEffort === undefined ? {} : { thinkingLevel: selection.reasoningEffort }), ...(session.usage === undefined ? {} : { contextUsage: session.usage }) };
  }
  /**
   * 会话自己的模型选择：`modelSelection` 投影的 `next`（DSH 已回落到 `lastUsed`）。
   * 在该投影到达前才退回部署默认值——新会话在首次请求前就是这种状态。
   */
  #selection(session: WebSession): ModelSelection | undefined {
    if (session.selection !== undefined) return session.selection;
    const fallback = object(session.modelCatalog?.default);
    if (typeof fallback.provider !== "string" || !fallback.provider || typeof fallback.model !== "string" || !fallback.model) return undefined;
    return { provider: fallback.provider, model: fallback.model,
      ...(typeof fallback.reasoningEffort === "string" && fallback.reasoningEffort.length > 0 ? { reasoningEffort: fallback.reasoningEffort } : {}) };
  }
  /**
   * 应用 `modelSelection` 投影。它按会话记录「下次请求用的选择」与「上次请求用的选择」，
   * 是显示模型名与思考档位的唯一事实来源；目录里的 `default` 是部署级默认值，不能代替它
   * （同一 Host 上的会话可以各自选过不同模型）。
   */
  #modelSelectionProjection(session: WebSession, raw: unknown): void {
    const baseline = object(raw); const seq = baseline.asOfSeq;
    const view = object(object(baseline.values).modelSelection);
    const chosen = view.next ?? view.lastUsed;
    if (!Number.isSafeInteger(seq) || Number(seq) < session.selectionSeq) return;
    const value = object(chosen);
    if (typeof value.provider !== "string" || !value.provider || typeof value.model !== "string" || !value.model) return;
    const next: ModelSelection = { provider: value.provider, model: value.model,
      ...(typeof value.reasoningEffort === "string" && value.reasoningEffort.length > 0 ? { reasoningEffort: value.reasoningEffort } : {}) };
    const previous = this.#selection(session);
    session.selectionSeq = Number(seq);
    session.selection = next;
    if (previous !== undefined && previous.provider === next.provider && previous.model === next.model
      && previous.reasoningEffort === next.reasoningEffort) return;
    this.#publishMetadata(session);
    // 思考档位选项来自当前模型的推理能力，换模型后命令清单也要跟着换。
    if (previous?.provider !== next.provider || previous?.model !== next.model) this.#publishCapabilities(session);
  }
  /** 应用 `session/selectModel` 的返回值：它在投影之前就返回规范化选择。 */
  #applySelection(session: WebSession, raw: unknown): void {
    const value = object(raw);
    if (typeof value.provider !== "string" || !value.provider || typeof value.model !== "string" || !value.model) return;
    const next: ModelSelection = { provider: value.provider, model: value.model,
      ...(typeof value.reasoningEffort === "string" && value.reasoningEffort.length > 0 ? { reasoningEffort: value.reasoningEffort } : {}) };
    const previous = this.#selection(session);
    session.selection = next;
    this.#publishMetadata(session);
    if (previous?.provider !== next.provider || previous?.model !== next.model) this.#publishCapabilities(session);
  }
  #permissionMetadata(session: WebSession): Pick<RuntimeMetadata, "permissionManagement"> {
    const management = dshPermissionManagement(dshPermissions(session.permissionProfile, session.permissionSandbox, session.permissionApproval), session.permissionOptions ?? [], session.running || session.permissionBusy || [...this.#approvals.values()].some(item => item.session === session));
    return management ? { permissionManagement: management } : {};
  }
  #titleProjection(id: string, raw: unknown, complete = false): void {
    this.#discovery.titleProjection(id, raw, complete);
    const session = this.#sessions.get(publicId(id));
    const title = this.#discovery.titles.read(id, {});
    if (!session || title === undefined || session.title === (title ?? undefined)) return;
    if (title) session.title = title; else delete session.title;
    this.#publishMetadata(session);
  }
  #permissionProjection(session: WebSession, raw: unknown): void {
    const baseline = object(raw); const seq = baseline.asOfSeq;
    const profile = object(object(baseline.values).permissions).currentValue;
    if (!Number.isSafeInteger(seq) || Number(seq) < session.permissionSeq || typeof profile !== "string") return;
    session.permissionSeq = Number(seq); session.permissionProfile = profile;
    this.#publishMetadata(session);
    this.#publishCapabilities(session);
  }

  /** Only native lifecycle/progress facts settle retry or compaction; ordinary idle never does. */
  #activityEvent(session: WebSession, event: DshWebLogEvent, publish = true, owner?: { turnId: string | undefined }): void {
    if (event.seq <= session.activitySeq) return;
    const data = object(event.data);
    const turnId = owner === undefined ? session.turnId : owner.turnId;
    const turn = turnId === undefined ? {} : { turnId };
    let changed = false;
    if (event.type === "llm/retry" || event.type === "llm/retry-started") {
      session.activity.retry = { phase: "running", ...turn,
        ...(Number.isSafeInteger(data.retry) && Number(data.retry) >= 0 ? { attempt: Number(data.retry) } : {}) };
      changed = true;
    } else if (event.type === "assistant/message" && typeof session.activity.retry === "object" && session.activity.retry.phase === "running") {
      session.activity.retry = { ...session.activity.retry, phase: "idle" };
      changed = true;
    } else if (event.type === "turn/end" && typeof session.activity.retry === "object" && session.activity.retry.phase === "running") {
      session.activity.retry = { ...session.activity.retry, phase: object(data.reason).kind === "error" ? "failed" : "idle" };
      changed = true;
    } else if (event.type === "compaction/start" && typeof data.compactionId === "string") {
      session.compactionId = data.compactionId;
      session.activity.compaction = { phase: "running", ...(data.turn === null ? {} : turn) };
      changed = true;
    } else if (event.type === "compaction/end" && typeof data.compactionId === "string"
      && (session.compactionId === undefined || session.compactionId === data.compactionId)) {
      session.compactionId = data.compactionId;
      session.activity.compaction = { phase: typeof data.error === "string" ? "failed" : "idle", ...(data.turn === null ? {} : turn) };
      changed = true;
    }
    if (!changed) return;
    session.activitySeq = event.seq;
    if (publish) this.#emit(session, structuredClone(session.activity));
  }

  /** Native wire inbox is a complete, durable projection, including other frontends' submissions. */
  #deliveryProjection(session: WebSession, raw: unknown): boolean {
    const baseline = object(raw); const seq = baseline.asOfSeq;
    const inbox = object(object(baseline.values).inbox);
    if (!Number.isSafeInteger(seq) || Number(seq) < session.deliverySeq
      || !Array.isArray(inbox["next-turn"]) || !Array.isArray(inbox["next-step"])) return false;
    const items: AgentDeliveryItem[] = [];
    const nativeQueue: WebSession["queue"] = new Map();
    let complete = true;
    for (const [target, delivery] of [["next-turn", "followUp"], ["next-step", "steer"]] as const) {
      for (const value of inbox[target] as unknown[]) {
        const message = object(value); const source = object(message.source);
        const id = typeof source.rpcId === "string" ? source.rpcId : message.id;
        if (typeof id !== "string" || id.length === 0 || id.length > 256 || typeof message.id !== "string") { complete = false; continue; }
        if (items.length >= 256) { complete = false; break; }
        const text = arrayObjects(message.content).filter(block => block.type === "text" && typeof block.text === "string")
          .map(block => String(block.text)).join("\n") || "非文本消息";
        if (text.length > 4_096) complete = false;
        const item: AgentDeliveryItem = { queueId: id, text: text.slice(0, 4_096), delivery, state: "accepted" };
        items.push(item);
        // Keep the native occurrence id for the existing cancellation command.
        nativeQueue.set(id, { itemId: message.id, text: item.text, delivery });
      }
    }
    if (complete) {
      // In-flight calls have not been admitted yet; their receipts remain device operations.
      const submitting = [...session.queue].filter(([id]) => session.messages.get(id)?.status === "pending");
      session.queue = new Map([...submitting, ...nativeQueue]);
    } else for (const [id, item] of nativeQueue) session.queue.set(id, item);
    session.deliverySeq = Number(seq);
    this.#emit(session, { type: "delivery.snapshot", items, complete });
    return true;
  }

  async #loadDelivery(session: WebSession): Promise<void> {
    const generation = ++session.deliveryGeneration;
    const followGeneration = session.followGeneration;
    try {
      const baseline = await this.#client.request("session/projections", { request: { sessionId: session.id } });
      if (generation !== session.deliveryGeneration || followGeneration !== session.followGeneration
        || this.#sessions.get(publicId(session.id)) !== session || session.closing) return;
      this.#deliveryProjection(session, baseline);
    } catch {
      // No native baseline means no complete inventory; preserve the last known queue.
    }
  }
  #permissionEvent(session: WebSession, event: DshWebLogEvent): void {
    const data = object(event.data);
    if (event.type === "session/title") {
      this.#titleProjection(session.id, { asOfSeq: event.seq, values: { title: data.title } });
      return;
    }
    if (event.type === "sandbox/mode" && event.seq > session.permissionSandboxSeq && ["read-only", "workspace-write", "danger-full-access"].includes(String(data.mode))) {
      session.permissionSandbox = String(data.mode); session.permissionSandboxSeq = event.seq;
    } else if (event.type === "approval/policy" && event.seq > session.permissionApprovalSeq && ["ask", "never"].includes(String(data.policy))) {
      session.permissionApproval = String(data.policy); session.permissionApprovalSeq = event.seq;
    }
    else return;
    this.#publishMetadata(session);
  }
  async #loadPermissions(session: WebSession): Promise<void> {
    const generation = ++session.permissionGeneration;
    try {
      const catalog = await this.#client.request("permissionPresets/catalog", {});
      if (session.closing || generation !== session.permissionGeneration) return;
      const options = dshPermissionOptions(catalog);
      const baseline = await this.#client.request("session/projections", { request: { sessionId: session.id } });
      if (session.closing || generation !== session.permissionGeneration) return;
      session.permissionOptions = options;
      this.#permissionProjection(session, baseline);
      this.#deliveryProjection(session, baseline);
      this.#publishCapabilities(session);
      session.notifications.resolve("dsh.permissions");
    } catch (error) {
      if (!session.closing && generation === session.permissionGeneration && session.permissionProfile) this.#report(`无法刷新 DeepSeek 权限配置：${textOf(error)}`, publicId(session.id), "dsh.permissions");
      // Deployments without native presets retain computer-side management.
    }
  }
  async #loadSkills(session: WebSession): Promise<void> {
    const generation = ++session.skillsGeneration;
    try {
      const value = object(await this.#client.request("skills/list", { request: { sessionId: session.id } }));
      if (generation !== session.skillsGeneration || this.#sessions.get(publicId(session.id)) !== session) return;
      session.skills = arrayObjects(value.skills).flatMap(skill => typeof skill.name === "string" && /^[^\s/]+$/u.test(skill.name)
        ? [{ name: skill.name, description: typeof skill.description === "string" ? skill.description : `DeepSeek skill /${skill.name}` }] : []);
      if (this.#sessions.has(publicId(session.id))) this.#publishCapabilities(session);
      session.notifications.resolve("dsh.skills");
    } catch (error) { if (generation === session.skillsGeneration && this.#sessions.get(publicId(session.id)) === session) this.#report(`无法读取 DeepSeek Web skills：${textOf(error)}`, publicId(session.id), "dsh.skills"); }
  }
  async #loadModelCatalog(session: WebSession): Promise<void> {
    const generation = ++session.modelGeneration;
    try {
      const catalog = object(await this.#client.request("session/modelCatalog", {}));
      if (generation !== session.modelGeneration || this.#sessions.get(publicId(session.id)) !== session) return;
      // 目录只提供模型名与可选档位；会话实际选择来自 `modelSelection` 投影，不能在这里覆盖。
      session.modelCatalog = catalog;
      if (this.#sessions.has(publicId(session.id))) { this.#publishMetadata(session); this.#publishCapabilities(session); }
      session.notifications.resolve("dsh.models");
    } catch (error) { if (generation === session.modelGeneration && this.#sessions.get(publicId(session.id)) === session) this.#report(`无法读取 DeepSeek Web 模型目录：${textOf(error)}`, publicId(session.id), "dsh.models"); }
  }
  #modelInfo(catalog: Obj | undefined, provider: string, id: string): RuntimeMetadata["model"] | undefined {
    for (const group of arrayObjects(catalog?.groups)) {
      const groupId = typeof group.id === "string" ? group.id : typeof group.provider === "string" ? group.provider : "";
      if (groupId !== provider) continue;
      const model = arrayObjects(group.models).find(item => item.id === id || item.model === id);
      if (model) return { provider, id, ...(typeof model.name === "string" && model.name.length > 0 ? { name: model.name } : {}) };
    }
    return { provider, id };
  }
  #modelChoices(session: WebSession): { value: string; label: string }[] {
    return arrayObjects(session.modelCatalog?.groups).flatMap(group => {
      const provider = typeof group.id === "string" ? group.id : typeof group.provider === "string" ? group.provider : "";
      return arrayObjects(group.models).flatMap(model => {
        const id = typeof model.id === "string" ? model.id : typeof model.model === "string" ? model.model : "";
        if (!provider || !id) return [];
        return [{ value: JSON.stringify({ provider, model: id }), label: `${typeof group.name === "string" ? group.name : provider} / ${typeof model.name === "string" ? model.name : id}` }];
      });
    });
  }
  #thinkingChoices(session: WebSession): { value: string; label: string }[] {
    const selection = this.#selection(session);
    if (!selection) return [];
    for (const group of arrayObjects(session.modelCatalog?.groups)) {
      const provider = typeof group.id === "string" ? group.id : group.provider;
      if (provider !== selection.provider) continue;
      const model = arrayObjects(group.models).find(item => item.id === selection.model || item.model === selection.model);
      if (!model) continue;
      const reasoning = object(model.reasoning);
      return arrayObjects(reasoning.efforts).flatMap(effort => typeof effort.id === "string" ? [{ value: effort.id, label: typeof effort.name === "string" ? effort.name : effort.id }] : []);
    }
    return [];
  }
  #capabilities(session?: WebSession): RuntimeCapabilities {
    const modelChoices = session ? this.#modelChoices(session) : [];
    const thinkingChoices = session ? this.#thinkingChoices(session) : [];
    const builtin = [
      // 历史与分支：DSH 的原生日志是线性的，「跳分支」就是原生 `session/fork`（新会话），
      // 所以这张树只负责让手机看清每一轮和当前位置。
      ...(session && session.entries.length > 0 ? [{ name: "tree", description: "浏览这段会话的历史，并从某一轮创建分支", source: "builtin" as const,
        argument: { kind: "tree" as const, required: true, options: dshWebTreeOptions(session.entries) } }] : []),
      ...(session?.permissionOptions?.length && session.permissionProfile ? [{ name: "permission-preset", description: "权限配置", source: "builtin" as const, argument: { kind: "select" as const, required: true, options: session.permissionOptions } }] : []),
      { name: "model", description: "DeepSeek Web /model", source: "builtin" as const, ...(modelChoices.length ? { argument: { kind: "select" as const, required: true, options: modelChoices } } : {}) },
      ...(thinkingChoices.length ? [{ name: "thinking", description: "DeepSeek Web /thinking", source: "builtin" as const, argument: { kind: "select" as const, required: true, options: thinkingChoices } }] : []),
      ...["name", "session", "fork", "clone", "skills", "quit"].map(name => ({ name, description: `DeepSeek Web /${name}`, source: "builtin" as const })),
    ];
    const skills = (session?.skills ?? []).map(skill => ({ name: skill.name, description: skill.description, source: "skill" as const }));
    return { commands: [...builtin, ...skills] };
  }
  /**
   * 发布命令词表（含历史树的整张选项表）。同一份内容只发一次：手机每次 `session.sync`
   * 都会重读这份快照，而树会随每条 durable 事件变化——不去重的话每次同步都要重传一整棵树。
   * 新接入的手机由 `announce()` 强制重发，不靠增量。
   */
  #publishCapabilities(session: WebSession, force = false): void {
    const capabilities = this.#capabilities(session);
    const signature = JSON.stringify(capabilities);
    if (!force && signature === session.capabilitiesSignature) return;
    session.capabilitiesSignature = signature;
    this.#emit(session, { type: "runtime.capabilities", capabilities });
  }
  #publishMetadata(session: WebSession): void { if (!this.#sessions.has(publicId(session.id))) return; const metadata = this.#metadata(session); this.#emit(session, { type: "runtime.status", status: metadata.status }); this.#emit(session, { type: "runtime.metadata", metadata }); this.onMetadataChange?.(); session.notifications.announce(); }
  #detachSession(session: WebSession, reason: string): void {
    if (session.closing) return;
    session.closing = true;
    this.#cancelSessionApprovals(session, "owner_closed");
    session.unsubscribe();
    if (session.sourceCheck) { clearTimeout(session.sourceCheck.timer); session.sourceCheck.reject(new Error(reason)); delete session.sourceCheck; }
    this.#sessions.delete(publicId(session.id));
    this.onOffline?.(reason, [this.#metadata(session)]);
  }
  async #ensureWorkspace(cwd: string): Promise<string> {
    const result = object(await this.#client.request("workspace/create", { request: { path: cwd } }));
    const workspace = object(result.workspace) as WorkspaceView;
    if (typeof workspace.workspaceId !== "string" || workspace.workspaceId.length === 0) {
      throw new Error("DeepSeek Web 没有返回工作区 ID");
    }
    return workspace.workspaceId;
  }
  #emit(session: WebSession, event: RuntimeEvent): void {
    if (event.type !== "command.result" && this.#sessions.get(publicId(session.id)) !== session) return;
    if (!session.source.observe(event)) this.#sink(event, publicId(session.id));
  }
  #report(message: string, runtimeId?: string, code = "dsh.recovery"): void {
    const sessions = runtimeId === undefined ? [...this.#sessions.values()] : [this.#sessions.get(runtimeId)];
    for (const session of sessions) if (session) session.notifications.upsert({ code, occurrenceId: code === "dsh.recovery" ? "follow" : code,
      scope: {}, severity: "warning", lifecycle: "condition", message });
  }
  async stop(): Promise<void> { if (this.#stopping) return this.#stopping; this.#stopping = (async () => { this.#ready = false; clearTimeout(this.#controlRetry); this.#controlUnsubscribe?.(); this.#discovery.stop(); for (const id of this.#approvals.keys()) this.#cancelApproval(id, "owner_closed"); for (const session of this.#sessions.values()) { session.unsubscribe(); if (session.sourceCheck) { clearTimeout(session.sourceCheck.timer); session.sourceCheck.reject(new Error("backend_stopped")); } } this.#sessions.clear(); this.#running.clear(); this.#detached.clear(); await this.#client.stop(); })(); return this.#stopping; }
}

