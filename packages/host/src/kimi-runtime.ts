import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { KimiInteractions } from "./kimi-interactions.js";
import { KimiInput, KimiPromptJournal } from "./kimi-input.js";
import WebSocket from "ws";
import type { AgentKey, AgentSessionSummary, RemoteSessionEntry, RuntimeCommand, RuntimeEvent, RuntimeMetadata, SessionConfigurationCatalog } from "@orbis/protocol";
import { ToolActivityProducer, ToolContentReadError, type ToolContentReader, type ToolContentStore } from "@orbis/runtime-bridge";
import { KimiConversation, kimiObject, type KimiFrame } from "./kimi-conversation.js";
import type { AgentBackend, AgentActivateTarget, AgentActivateContext, BackendActivation, CommandDispatch, NativeRunningSession } from "./agent-backend.js";
import { KimiBusinessError, KimiWebConnector, KimiWebError, assertKimiMayStart, defaultKimiHome, type KimiWebClient, type KimiWebClientOptions } from "./kimi-web-client.js";
import { createKimiLauncher, type KimiLauncher } from "./kimi-launch.js";
import { KIMI_DESKTOP_KIND, KIMI_KIND, KimiLaunchBlocked, KimiSessions, kimiDesktopSessionEvent, kimiLocalDirectory, kimiNativeSessionId, kimiSourceKey, type KimiSession } from "./kimi-sessions.js";
import { ActivationError } from "./spawner.js";
import { localHostname } from "./sessions.js";
import { exitViewCapability, matchesViewExit } from "./shared-session-view.js";

const SUBSCRIBE_TIMEOUT_MS = 5_000;
// Leave time to return a retryable result before the mobile draft's 20 s configuration deadline.
const NATIVE_START_TIMEOUT_MS = 15_000;
const MAX_SUBSCRIPTIONS = 12;
type Active = { native: KimiSession; cwd: string; id: string; subscribed: boolean; viewGeneration: string; subscribing?: Promise<void>; closing?: Promise<void>;
  compacting?: boolean; input?: KimiInput; interactions?: KimiInteractions; conversation?: KimiConversation; toolProducer?: ToolActivityProducer; thinking?: string };
type Connection = { sessions: KimiSessions; socket: WebSocket; generation: number };
type KimiOptions = KimiWebClientOptions & { stateDir: string; log?: (message: string) => void; launcher?: KimiLauncher };

export function createLocalKimiRuntime(options: Omit<KimiOptions, "launcher"> & { homeDir: string }): KimiRuntime {
  const launcher = createKimiLauncher(options);
  return new KimiRuntime({ ...options, ...(launcher ? { launcher } : {}) });
}

/** Native Kimi session adapter. Passive discovery cannot open the CLI or application. */
export class KimiRuntime implements AgentBackend {
  readonly kind: typeof KIMI_KIND | typeof KIMI_DESKTOP_KIND;
  readonly #home: string;
  readonly #desktop: boolean;
  readonly #journal: KimiPromptJournal;
  readonly #connector: KimiWebConnector;
  readonly #options: KimiOptions;
  readonly #startRequests = new Set<() => boolean>();
  #lifetime: AbortController | undefined;
  #starting: Promise<void> | undefined;
  #checkingLauncher: Promise<void> | undefined;
  #launchCandidate: boolean | undefined;
  #startFailure: KimiWebError | undefined;
  readonly #active = new Map<string, Active>();
  readonly #hidden = new Map<string, { idle: boolean }>();
  readonly #discovering = new Map<string, Connection>();
  #presenceTimer: ReturnType<typeof setInterval> | undefined;
  readonly #requests = new Map<string, (code: number) => void>();
  #connection: Connection | undefined;
  #toolStore: ToolContentStore | undefined;
  #hostId = "local";
  #sink: (event: RuntimeEvent, runtimeId: string) => void = () => undefined;
  onCatalogChange?: () => void;
  onMetadataChange?: (metadata: RuntimeMetadata) => void;
  onOffline?: (runtime: RuntimeMetadata, reason: string) => void;
  onArchiveChange?: (id: string, archived: boolean) => void;
  onReadyChange?: () => void;

  constructor(options: KimiOptions) {
    this.#options = options;
    this.#desktop = options.source === "desktop";
    this.kind = this.#desktop ? KIMI_DESKTOP_KIND : KIMI_KIND;
    this.#home = options.homeDir ?? defaultKimiHome();
    this.#journal = new KimiPromptJournal(join(options.stateDir, "kimi-prompt-journal.json"));
    this.#connector = new KimiWebConnector({ ...options, homeDir: this.#home,
      onStatus: status => {
        options.log?.(`${this.#desktop ? "Kimi Code Desktop" : "Kimi Code Web"}: ${status.state}${status.reason ? ` · ${status.reason}` : ""}`);
        if (status.state !== "connected") {
          if (this.#connection) this.#disconnected(status.reason ?? "Kimi Code 已断开");
          else if (status.state !== "connecting") this.onReadyChange?.();
        }
      },
      onMissing: () => this.#refreshLaunchCandidate(),
      onConnected: (client, socket, generation) => this.#connected(client, socket, generation),
      onFrame: (frame, generation) => this.#frame(frame, generation),
    });
  }

  setEventSink(sink: (event: RuntimeEvent, runtimeId: string) => void): void { this.#sink = sink; }
  setToolContentStore(store: ToolContentStore, hostId: string): void { this.#toolStore = store; this.#hostId = hostId; }
  readonly toolContents: ToolContentReader = {
    read: (owner, request, signal) => this.#active.get(request.runtimeId)?.toolProducer?.read(owner, request, signal)
      ?? Promise.reject(new ToolContentReadError("content_unavailable")),
    cancel: async (owner, id) => { await this.#toolStore?.cancel(owner, id); },
  };
  async readSessionEntry(runtimeId: string, sessionId: string, entryId: string): Promise<RemoteSessionEntry | undefined> {
    return runtimeId === sessionId ? this.#active.get(runtimeId)?.conversation?.entry(entryId) : undefined;
  }
  announce(): void {
    for (const item of this.#active.values()) if (item.subscribed) {
      this.#sink({ type: "runtime.capabilities", capabilities: { commands: [exitViewCapability(item.viewGeneration)] } }, item.id);
      item.interactions?.announce();
    }
  }

  start(): void {
    this.#lifetime ??= new AbortController();
    this.#connector.start();
  }
  async stop(): Promise<void> {
    this.#lifetime?.abort();
    this.#lifetime = undefined;
    this.#disconnected("Kimi Code 已断开");
    this.#active.clear();
    this.#hidden.clear();
    await Promise.all([this.#connector.stop(), this.#starting?.catch(() => {})]);
  }
  get connectionState() {
    const state = this.#connector.status.state;
    if (this.isReady()) return "connected";
    if (this.#starting) return "starting";
    if (state === "not_running") return this.#startFailure?.reason ?? (this.#launchCandidate === false ? "not_installed" : state);
    return state === "connected" ? "connecting" : state;
  }
  get reason(): string | null {
    return this.connectionState === "not_installed" ? (this.#desktop ? "未找到 Kimi Code 桌面版" : "未找到 Kimi Code CLI")
      : this.#connector.status.state === "not_running" && this.#startFailure ? this.#startFailure.message : this.#connector.status.reason;
  }
  canLaunch(): boolean {
    return this.isReady() || this.#starting !== undefined || (this.#launchCandidate === true && this.#connector.status.state === "not_running");
  }
  async #sourceKey(): Promise<string> {
    const homeKey = await kimiSourceKey(this.#home);
    return this.#desktop ? `desktop-${homeKey}` : homeKey;
  }
  async assertResumeSource(id: string): Promise<void> {
    const key = await this.#sourceKey().catch(() => { throw new ActivationError("session_not_found", "找不到此 Kimi Code 会话的数据源"); });
    kimiNativeSessionId(id, key);
  }
  #refreshLaunchCandidate(): void {
    const launcher = this.#options.launcher, lifetime = this.#lifetime;
    if (!launcher || !lifetime || this.#checkingLauncher) return;
    this.#checkingLauncher = launcher.available().then(found => {
      if (this.#lifetime !== lifetime || found === this.#launchCandidate) return;
      this.#launchCandidate = found;
      if (found && this.#startFailure?.reason === "not_installed") this.#startFailure = undefined;
      this.onReadyChange?.();
    }).catch(() => { /* An installation check failure does not prove the program is absent. */ })
      .finally(() => { this.#checkingLauncher = undefined; });
  }

  /** One launch shared by Host UI and explicitly requested, authorized device operations. */
  async ensureReady(current = (): boolean => true): Promise<void> {
    const lifetime = this.#lifetime;
    const admitted = () => lifetime !== undefined && this.#lifetime === lifetime && current();
    const revoked = () => new KimiWebError("unavailable", "Kimi Code 启动已取消");
    if (!lifetime || !admitted()) throw revoked();
    if (this.isReady()) return;
    this.#startRequests.add(admitted);
    try {
      if (!this.#starting) {
        this.#startFailure = undefined;
        const deadline = AbortSignal.timeout(NATIVE_START_TIMEOUT_MS);
        this.#starting = this.#connectOrStart(AbortSignal.any([lifetime.signal, deadline]), () => {
          lifetime.signal.throwIfAborted();
          if (![...this.#startRequests].some(isCurrent => isCurrent())) throw revoked();
        }).catch(error => {
          const failure = lifetime.signal.aborted ? revoked() : deadline.aborted
            ? new KimiWebError("unavailable", "Kimi Code 启动后未能完成接入，请稍后重试")
            : error instanceof KimiWebError ? error : new KimiWebError("unavailable", "Kimi Code 启动失败");
          if (this.#lifetime === lifetime && [...this.#startRequests].some(isCurrent => isCurrent())) this.#startFailure = failure;
          throw failure;
        }).finally(() => {
          this.#starting = undefined;
          if (this.#lifetime === lifetime) this.onReadyChange?.();
        });
        this.onReadyChange?.();
      }
      await this.#starting;
      if (!admitted()) throw revoked();
    } finally { this.#startRequests.delete(admitted); }
  }

  async #connectOrStart(signal: AbortSignal, checkCurrent: () => void): Promise<void> {
    const statusError = () => {
      const { state, reason } = this.#connector.status;
      return new KimiWebError(state === "ambiguous" || state === "unauthorized" || state === "unsupported" || state === "unsafe" || state === "not_running" ? state : "unavailable",
        reason ?? "Kimi Code 尚未连接");
    };
    const probe = async () => {
      signal.throwIfAborted();
      // A user launch deadline does not shut down background discovery of user-owned instances.
      let abort!: () => void;
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
      });
      try { await Promise.race([this.#connector.probe(), cancelled]); return this.isReady(); }
      finally { signal.removeEventListener("abort", abort); }
    };
    if (await probe()) return;
    const launcher = this.#options.launcher;
    if (!launcher || this.#connector.status.state !== "not_running") throw statusError();
    checkCurrent();
    await launcher.start({ signal,
      shouldStart: async () => {
        checkCurrent();
        if (await probe()) return false;
        if (this.#connector.status.state !== "not_running") throw statusError();
        await assertKimiMayStart({ ...this.#options, homeDir: this.#home });
        checkCurrent();
        return true;
      },
      waitForConnection: async checkChild => {
        while (true) {
          signal.throwIfAborted();
          if (await probe() && this.#connector.client) return this.#connector.client.instance.pid;
          const state = this.#connector.status.state;
          if (state !== "not_running" && state !== "unavailable") throw statusError();
          checkChild?.();
          await delay(250, undefined, { signal });
        }
      },
    });
    if (!this.isReady()) throw statusError();
  }
  isReady(): boolean { return this.#connection?.socket.readyState === WebSocket.OPEN; }
  ownsRuntime(id: string): boolean { return this.#active.has(id); }
  directoryEntries(): RuntimeMetadata[] { return [...this.#active.values()].filter(item => item.subscribed).map(item => this.#metadata(item)); }
  #metadata(item: Active): RuntimeMetadata {
    const model = item.native.agent_config.model;
    return { runtimeId: item.id, sessionId: item.id, cwd: item.cwd, name: this.#desktop ? "Kimi Code Desktop" : "Kimi Code", status: item.native.main_turn_active ? "running" : "idle",
      hostname: localHostname() ?? "localhost", sessionGraphSync: true,
      ...(item.native.title ? { sessionName: item.native.title.slice(0, 256) } : {}),
      ...(model && model.length <= 256 ? { model: { provider: "Kimi Code", id: model } } : {}),
      ...(item.thinking ? { thinkingLevel: item.thinking } : {}) };
  }
  async #connected(client: KimiWebClient, socket: WebSocket, generation: number): Promise<void> {
    const key = await this.#sourceKey();
    await this.#journal.load();
    if (this.#connector.client !== client || socket.readyState !== WebSocket.OPEN) return;
    const connection = { sessions: new KimiSessions(client, key, this.kind, client.sessionContract), socket, generation };
    this.#connection = connection;
    this.#startFailure = undefined;
    this.onReadyChange?.();
    this.onCatalogChange?.();
    for (const item of this.#active.values()) {
      if (!item.id.startsWith(connection.sessions.publicId(""))) { this.#active.delete(item.id); continue; }
      void this.#resume(connection, item.native.id).catch(() => { /* Keep the exact identity available for explicit retry. */ });
    }
    const discover = () => {
      void connection.sessions.runningSessions().then(sessions => {
        if (this.#connection !== connection) return;
        for (const session of sessions.slice(0, MAX_SUBSCRIPTIONS)) this.#discoverWork(connection, connection.sessions.nativeId(session.sessionId));
      }).catch(() => { /* A failed/partial read does not prove a hidden session idle. */ });
    };
    discover();
    this.#presenceTimer = setInterval(discover, 15_000);
    this.#presenceTimer.unref();
  }
  #disconnected(reason: string): void {
    if (!this.#connection) return;
    this.#connection = undefined;
    clearInterval(this.#presenceTimer); this.#presenceTimer = undefined;
    for (const complete of this.#requests.values()) complete(-1);
    this.#requests.clear();
    for (const item of this.#active.values()) {
      this.#clearConversation(item);
      if (item.subscribed) this.onOffline?.(this.#metadata(item), reason);
      item.subscribed = false;
      delete item.subscribing;
      delete item.closing;
    }
    this.onReadyChange?.();
    this.onCatalogChange?.();
  }
  #requireConnection(): Connection {
    if (!this.#connection || !this.isReady()) throw new ActivationError("agent_unsupported", this.reason ??
      (this.#desktop ? "Kimi Code 桌面版尚未连接" : "Kimi Code Web 尚未连接"));
    return this.#connection;
  }
  #assertConnection(connection: Connection): void {
    if (this.#connection !== connection || !this.isReady()) throw new Error("Kimi Code 连接已改变，结果待核对");
  }

  async readRunningSessions(): Promise<NativeRunningSession[]> {
    const connection = this.#requireConnection();
    const sessions = await connection.sessions.runningSessions();
    this.#assertConnection(connection);
    return sessions;
  }

  async catalog(archived = false): Promise<AgentSessionSummary[]> { return (await this.catalogCoverage(archived)).sessions; }
  async catalogCoverage(archived = false): Promise<{ sessions: AgentSessionSummary[]; complete: boolean }> {
    const connection = this.#requireConnection();
    const result = await connection.sessions.catalog(archived);
    this.#assertConnection(connection);
    return result;
  }
  async setArchived(id: string, archived: boolean): Promise<void> {
    const connection = this.#requireConnection();
    await connection.sessions.setArchived(id, archived);
    this.#assertConnection(connection);
    this.onCatalogChange?.();
  }
  async sessionConfiguration(cwd: string): Promise<SessionConfigurationCatalog> {
    const connection = this.#requireConnection();
    await kimiLocalDirectory(cwd);
    this.#assertConnection(connection);
    return { binding: connection.sessions.publicId("local"), defaults: {}, models: [], permissions: [] };
  }
  async recoverLaunch(marker: string, cwd: string, binding: string): Promise<string | undefined> {
    const connection = this.#requireConnection();
    if (binding !== connection.sessions.publicId("local")) return undefined;
    const found = await connection.sessions.findLaunch(marker, cwd);
    this.#assertConnection(connection);
    return found;
  }

  async activate(target: AgentActivateTarget, context?: AgentActivateContext): Promise<BackendActivation> {
    if (context?.spawnMode === "tui") throw new KimiLaunchBlocked("agent_unsupported", "Kimi Code 不支持通过 Orbis 启动终端会话");
    const connection = this.#requireConnection();
    if (target.type === "resume") return this.#resume(connection, connection.sessions.nativeId(target.sessionId), false, context?.requireCurrent);
    if (!context?.nativeLaunchMarker || context.configuration?.model !== undefined || context.configuration?.thinking !== undefined
      || Object.keys(context.configuration?.permissions ?? {}).length > 0) {
      throw new KimiLaunchBlocked("agent_unsupported", "请使用 Kimi Code 的原生模型配置和可恢复的启动请求");
    }
    if (this.#active.size >= MAX_SUBSCRIPTIONS) throw new KimiLaunchBlocked("spawn_limit_reached", "Kimi Code 会话接入已达上限");
    const native = await connection.sessions.create(target.cwd, context.nativeLaunchMarker, context.requireCurrent);
    const activation = { sessionId: connection.sessions.publicId(native.id), spawnMode: "headless" as const };
    await context.onCreated?.(activation);
    this.#assertConnection(connection);
    return this.#resume(connection, native.id, true);
  }

  async #resume(connection: Connection, nativeId: string, requireModel = false, requireCurrent?: () => void, runningOnly = false): Promise<BackendActivation> {
    const id = connection.sessions.publicId(nativeId);
    const closing = this.#active.get(id)?.closing;
    if (closing) await closing;
    let native: KimiSession;
    try { native = await connection.sessions.read(nativeId); }
    catch (error) {
      if (error instanceof KimiBusinessError && error.code === 40401) throw new ActivationError("session_not_found", "Kimi Code 原生会话不存在");
      throw error;
    }
    if (native.id !== nativeId || native.archived) throw new ActivationError("session_not_found", "请先恢复已归档的 Kimi Code 会话");
    const cwd = await connection.sessions.requireLocal(native);
    requireCurrent?.();
    this.#assertConnection(connection);
    let item = this.#active.get(id);
    if (runningOnly && (item || !native.main_turn_active || this.#hidden.get(id)?.idle === false)) throw new Error("kimi_work_not_current");
    if (item?.closing) {
      await item.closing;
      return this.#resume(connection, nativeId, requireModel, requireCurrent, runningOnly);
    }
    if (!item) {
      if (this.#active.size >= MAX_SUBSCRIPTIONS) throw new ActivationError("spawn_limit_reached", "Kimi Code 会话接入已达上限");
      item = { native, cwd, id, subscribed: false, viewGeneration: randomUUID() }; this.#active.set(id, item);
    } else {
      item.native = connection.sessions.contract === "desktop-2.8.1" && item.subscribed
        ? { ...native, agent_config: item.native.agent_config } : native;
      item.cwd = cwd;
    }
    if (!item.subscribed) {
      const active = item;
      const pending = active.subscribing ??= this.#subscribe(connection, active);
      try { await pending; }
      catch (error) { if (this.#connection === connection && this.#active.get(id) === active) this.#active.delete(id); throw error; }
      finally { if (active.subscribing === pending) delete active.subscribing; }
    }
    this.#assertConnection(connection);
    if (this.#active.get(id) !== item || !item.subscribed) throw new Error("Kimi Code 未确认会话订阅");
    const conversation = item.conversation;
    if (!conversation) throw new Error("Kimi Code 未确认会话订阅");
    await conversation.waitForBaseline();
    this.#assertConnection(connection);
    if (this.#active.get(id) !== item || item.conversation !== conversation || item.closing) throw new Error("Kimi Code 会话已变化");
    this.#hidden.delete(id);
    if (requireModel && !item.native.agent_config.model) throw new Error("Kimi Code 会话尚未确认可用模型");
    return { sessionId: id, spawnMode: "headless" };
  }

  #subscribe(connection: Connection, item: Active): Promise<void> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const finish = (code: number) => {
        clearTimeout(timer); this.#requests.delete(requestId);
        if (code !== 0 || this.#connection !== connection || this.#active.get(item.id) !== item) {
          reject(code > 0 ? new KimiBusinessError(code) : new Error("Kimi Code 会话订阅未确认")); return;
        }
        item.viewGeneration = randomUUID();
        item.subscribed = true;
        this.onMetadataChange?.(this.#metadata(item));
        const agent = (): AgentKey => ({ hostId: this.#hostId, agentKind: this.kind, sessionId: item.id });
        const conversation = item.conversation = new KimiConversation({ agent, nativeId: item.native.id,
          client: connection.sessions.client, emit: event => this.#sink(event, item.id),
          onUserItem: (_turn, ids) => item.input?.observePromptIds(ids),
          clientMessageIds: ids => this.#journal.aliases(item.id, ids),
          onTurnEnded: turn => item.input?.observeEnd(turn), onInvalidated: () => item.input?.invalidate() });
        item.input = new KimiInput({ sessionId: item.id, nativeId: item.native.id, sessions: connection.sessions, journal: this.#journal, conversation,
          idle: () => !item.native.main_turn_active && !item.compacting, emit: event => this.#sink(event, item.id) });
        item.interactions = new KimiInteractions({ runtimeId: item.id, nativeId: item.native.id, client: connection.sessions.client,
          emit: event => this.#sink(event, item.id), resubscribe: () => { if (this.#connection === connection) connection.socket.terminate(); },
          verifyLocal: async () => {
            const current = await connection.sessions.read(item.native.id);
            if (current.id !== item.native.id || current.archived) throw new Error();
            await connection.sessions.requireLocal(current);
            this.#assertConnection(connection);
          },
        });
        item.input.requestPoll();
        conversation.invalidate(); // publish an explicit epoch boundary before any native baseline
        item.toolProducer = new ToolActivityProducer({ agent, runtimeId: () => item.id,
          source: () => ({ epoch: conversation.epoch, ready: conversation.ready && this.#connection === connection }),
          native: locator => conversation.toolPart(locator), ...(this.#toolStore ? { store: this.#toolStore } : {}) });
        this.announce();
        resolve();
      };
      const timer = setTimeout(() => { finish(-1); connection.socket.terminate(); }, SUBSCRIBE_TIMEOUT_MS);
      timer.unref();
      this.#requests.set(requestId, finish);
      connection.socket.send(JSON.stringify({ type: "subscribe", request_id: requestId, session_id: item.native.id, agent_ids: ["main"] }),
        error => { if (error) finish(-1); });
    });
  }

  #discoverWork(connection: Connection, nativeId: string): void {
    if (this.#connection !== connection || !/^session_[A-Za-z0-9_-]{1,70}$/u.test(nativeId)) return;
    const id = connection.sessions.publicId(nativeId);
    if (this.#active.has(id) || this.#hidden.get(id)?.idle === false || this.#discovering.get(id) === connection ||
        this.#active.size + this.#discovering.size >= MAX_SUBSCRIPTIONS) return;
    this.#discovering.set(id, connection);
    void this.#resume(connection, nativeId, false, undefined, true).catch(() => { /* Recheck on the next positive observation. */ })
      .finally(() => { if (this.#discovering.get(id) === connection) this.#discovering.delete(id); });
  }

  #unsubscribe(connection: Connection, item: Active): Promise<void> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const finish = (code: number) => {
        clearTimeout(timer); this.#requests.delete(requestId);
        if (code === 0 && this.#connection === connection) resolve();
        else reject(code > 0 ? new KimiBusinessError(code) : new Error("Kimi Code 未确认退订"));
      };
      const timer = setTimeout(() => finish(-1), SUBSCRIBE_TIMEOUT_MS); timer.unref();
      this.#requests.set(requestId, finish);
      connection.socket.send(JSON.stringify({ type: "unsubscribe", request_id: requestId, session_id: item.native.id }),
        error => { if (error) finish(-1); });
    });
  }

  async #exitView(connection: Connection, item: Active, commandId: string): Promise<void> {
    try {
      await this.#unsubscribe(connection, item);
    } catch (error) {
      if (this.#active.get(item.id) === item && this.#connection === connection) this.#sink({ type: "command.result", commandId,
        ok: false, status: error instanceof KimiBusinessError ? "failure" : "unconfirmed", error: "Kimi Code 未确认退订" }, item.id);
      return;
    }
    if (this.#active.get(item.id) !== item || this.#connection !== connection) return;
    this.#hidden.set(item.id, { idle: !item.native.main_turn_active && !item.conversation?.runningTurn });
    this.#sink({ type: "command.result", commandId, ok: true, status: "success" }, item.id);
    this.#clearConversation(item);
    this.#active.delete(item.id);
    this.onOffline?.(this.#metadata(item), "view_closed");
  }

  #frame(frame: KimiFrame, generation: number): void {
    const connection = this.#connection;
    if (!connection || generation !== connection.generation) return;
    if (frame.type === "response" && typeof frame.request_id === "string" && typeof frame.code === "number") {
      this.#requests.get(frame.request_id)?.(frame.code); return;
    }
    if (connection.sessions.contract === "desktop-2.8.1" && frame.type === "session") {
      const event = kimiDesktopSessionEvent.safeParse(frame);
      if (!event.success) return;
      const { change, session } = event.data;
      if (session.host_id || (session.environment_id !== undefined && session.environment_id !== "local")) return;
      const id = connection.sessions.publicId(session.id);
      if (change === "archived" || change === "restored" || change === "deleted") {
        this.#sessionLifecycle(id, change);
      } else if (session.environment_id === "local") {
        const running = session.activity === "turn";
        const hidden = this.#hidden.get(id);
        if (hidden && !running) hidden.idle = true;
        if (running) this.#discoverWork(connection, session.id);
        const item = this.#active.get(id);
        if (item) {
          item.native = { ...item.native, title: session.title, main_turn_active: running };
          if (item.subscribed) this.onMetadataChange?.(this.#metadata(item));
        }
      }
      this.onCatalogChange?.(); return;
    }
    if (frame.type === "event.session.archived" || frame.type === "event.session.deleted" || frame.type === "event.session.restored") {
      const native = kimiObject(frame.payload).sessionId;
      if (typeof native === "string") {
        this.#sessionLifecycle(connection.sessions.publicId(native), frame.type === "event.session.archived" ? "archived"
          : frame.type === "event.session.restored" ? "restored" : "deleted");
      }
      this.onCatalogChange?.(); return;
    }
    if (frame.type === "event.session.created" || frame.type === "session.meta.updated" || frame.type === "event.session.work_changed") this.onCatalogChange?.();
    if (typeof frame.session_id !== "string") return;
    const id = connection.sessions.publicId(frame.session_id);
    const item = this.#active.get(id);
    if (frame.type === "event.session.work_changed") {
      const running = kimiObject(frame.payload).main_turn_active;
      const hidden = this.#hidden.get(id);
      if (hidden && running === false) hidden.idle = true;
      if (running === true) this.#discoverWork(connection, frame.session_id);
      if (item && typeof running === "boolean") item.native = { ...item.native, main_turn_active: running };
    }
    if (!item?.subscribed) return;
    if (frame.type === "agent" && frame.agent_id === "main") {
      item.compacting = frame.compacting === true;
      item.input?.requestPoll();
      const model = typeof frame.model === "string" ? frame.model : "";
      item.native = { ...item.native, main_turn_active: frame.status === "running", agent_config: { model } };
      if (typeof frame.thinking === "string" && frame.thinking.length > 0 && frame.thinking.length <= 64) item.thinking = frame.thinking; else delete item.thinking;
      this.onMetadataChange?.(this.#metadata(item));
    } else if (frame.type === "session.meta.updated") {
      const title = kimiObject(frame.payload).title;
      if (typeof title === "string") { item.native = { ...item.native, title }; this.onMetadataChange?.(this.#metadata(item)); }
    }
    if (frame.type === "interaction") item.interactions?.frame(frame);
    if (frame.agent_id === "main") {
      if (frame.type === "turns" || frame.type === "turns.failed") item.interactions?.finishReplay();
      const ready = item.conversation?.ready;
      item.conversation?.frame(frame);
      if (frame.type === "turns") item.input?.requestPoll();
      if (ready && !item.conversation?.ready && frame.type !== "turns.failed") connection.socket.terminate();
    }
  }

  #sessionLifecycle(id: string, change: "archived" | "restored" | "deleted"): void {
    if (change !== "restored") {
      this.#hidden.delete(id);
      const item = this.#active.get(id);
      if (item) {
        this.#clearConversation(item);
        this.#active.delete(id);
        if (item.subscribed) this.onOffline?.(this.#metadata(item), "Kimi Code 会话已关闭");
      }
    }
    if (change !== "deleted") this.onArchiveChange?.(id, change === "archived");
  }

  #clearConversation(item: Active): void {
    item.interactions?.close(); delete item.interactions;
    item.input?.close(); delete item.input;
    item.conversation?.invalidate(); delete item.conversation;
    void item.toolProducer?.dispose().catch(() => undefined); delete item.toolProducer;
  }

  dispatchCommand(runtimeId: string, commandId: string, command: RuntimeCommand): CommandDispatch {
    const item = this.#active.get(runtimeId);
    if (!this.isReady() || !item?.subscribed || !item.conversation) return "offline";
    if (command.type === "session.close") {
      if (item.closing || !matchesViewExit(command, item.id, item.viewGeneration)) return "unsupported";
      const pending = this.#exitView(this.#connection!, item, commandId);
      item.closing = pending;
      void pending.finally(() => { if (item.closing === pending) delete item.closing; });
      return "handled";
    }
    if (item.closing && command.type !== "session.sync") return "offline";
    if (command.type === "user_message" && item.input) { void item.input.send(commandId, command); return "handled"; }
    if (command.type === "interaction.respond" && item.interactions) { void item.interactions.respond(commandId, command); return "handled"; }
    if (command.type === "stop" && item.input) { void item.input.stop(commandId); return "handled"; }
    if (command.type !== "session.sync") return "unsupported";
    item.input?.announce();
    item.interactions?.announce();
    const conversation = item.conversation;
    void conversation.sync(command).then(event => {
      if (this.#active.get(runtimeId)?.conversation === conversation) this.#sink(event, runtimeId);
    }).catch(() => this.#sink({ type: "command.result", commandId, ok: false, error: "kimi_history_unavailable" }, runtimeId));
    return "handled";
  }
}
