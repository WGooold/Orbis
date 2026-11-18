import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { AgentSessionSummary, RuntimeMetadata, SessionConfigurationCatalog } from "@orbis/protocol";
import type { AgentBackend, AgentActivateTarget, AgentActivateContext, BackendActivation, CommandDispatch } from "./agent-backend.js";
import { KimiBusinessError, KimiWebConnector, defaultKimiHome, type KimiWebClient, type KimiWebClientOptions } from "./kimi-web-client.js";
import { KIMI_KIND, KimiLaunchBlocked, KimiSessions, kimiLocalDirectory, kimiSourceKey, type KimiSession } from "./kimi-sessions.js";
import { ActivationError } from "./spawner.js";
import { localHostname } from "./sessions.js";

const SUBSCRIBE_TIMEOUT_MS = 5_000;
const MAX_SUBSCRIPTIONS = 12;
export type KimiFrame = Record<string, unknown>;
export const kimiObject = (value: unknown): KimiFrame => value !== null && typeof value === "object" && !Array.isArray(value) ? value as KimiFrame : {};

type Active = { native: KimiSession; cwd: string; id: string; subscribed: boolean; subscribing?: Promise<void> };
type Connection = { sessions: KimiSessions; socket: WebSocket; generation: number };
type KimiOptions = KimiWebClientOptions & { log?: (message: string) => void };

/** Native REST catalog and WS subscription. The Kimi process and tools remain user-owned. */
export class KimiRuntime implements AgentBackend {
  readonly kind = KIMI_KIND;
  readonly #home: string;
  readonly #connector: KimiWebConnector;
  readonly #active = new Map<string, Active>();
  readonly #requests = new Map<string, (code: number) => void>();
  #connection: Connection | undefined;
  onCatalogChange?: () => void;
  onMetadataChange?: (metadata: RuntimeMetadata) => void;
  onOffline?: (runtime: RuntimeMetadata, reason: string) => void;
  onArchiveChange?: (id: string, archived: boolean) => void;
  onReadyChange?: () => void;

  constructor(options: KimiOptions) {
    this.#home = options.homeDir ?? defaultKimiHome();
    this.#connector = new KimiWebConnector({ ...options, homeDir: this.#home,
      onStatus: status => {
        options.log?.(`Kimi Code Web: ${status.state}${status.reason ? ` · ${status.reason}` : ""}`);
        if (status.state !== "connected") this.#disconnected(status.reason ?? "Kimi Code 已断开");
      },
      onConnected: (client, socket, generation) => {
        void this.#connected(client, socket, generation).catch(() => socket.terminate());
      },
      onFrame: (frame, generation) => this.#frame(frame, generation),
    });
  }

  start(): void { this.#connector.start(); }
  async stop(): Promise<void> {
    this.#disconnected("Kimi Code 已断开");
    this.#active.clear();
    await this.#connector.stop();
  }
  get reason(): string | null { return this.#connector.status.reason; }
  isReady(): boolean { return this.#connection?.socket.readyState === WebSocket.OPEN; }
  ownsRuntime(id: string): boolean { return this.#active.has(id); }
  directoryEntries(): RuntimeMetadata[] { return [...this.#active.values()].filter(item => item.subscribed).map(item => this.#metadata(item)); }
  #metadata(item: Active): RuntimeMetadata {
    const model = item.native.agent_config.model;
    return { runtimeId: item.id, sessionId: item.id, cwd: item.cwd, name: "Kimi Code", status: item.native.main_turn_active ? "running" : "idle",
      hostname: localHostname() ?? "localhost", sessionGraphSync: true,
      ...(item.native.title ? { sessionName: item.native.title.slice(0, 256) } : {}),
      ...(model && model.length <= 256 ? { model: { provider: "Kimi Code", id: model } } : {}) };
  }
  async #connected(client: KimiWebClient, socket: WebSocket, generation: number): Promise<void> {
    const key = await kimiSourceKey(this.#home);
    if (this.#connector.client !== client || socket.readyState !== WebSocket.OPEN) return;
    const connection = { sessions: new KimiSessions(client, key), socket, generation };
    this.#connection = connection;
    this.onReadyChange?.();
    this.onCatalogChange?.();
    for (const item of this.#active.values()) {
      if (!item.id.startsWith(connection.sessions.publicId(""))) { this.#active.delete(item.id); continue; }
      void this.#resume(connection, item.native.id).catch(() => { /* Keep the exact identity available for explicit retry. */ });
    }
  }
  #disconnected(reason: string): void {
    if (!this.#connection) return;
    this.#connection = undefined;
    for (const complete of this.#requests.values()) complete(-1);
    this.#requests.clear();
    for (const item of this.#active.values()) {
      if (item.subscribed) this.onOffline?.(this.#metadata(item), reason);
      item.subscribed = false;
      delete item.subscribing;
    }
    this.onReadyChange?.();
    this.onCatalogChange?.();
  }
  #requireConnection(): Connection {
    if (!this.#connection || !this.isReady()) throw new ActivationError("agent_unsupported", this.reason ?? "Kimi Code Web 尚未连接");
    return this.#connection;
  }
  #assertConnection(connection: Connection): void {
    if (this.#connection !== connection || !this.isReady()) throw new Error("Kimi Code 连接已改变，结果待核对");
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
    if (context?.spawnMode === "tui") throw new KimiLaunchBlocked("agent_unsupported", "Kimi Code 只能接入已运行的原生 Web 服务");
    const connection = this.#requireConnection();
    if (target.type === "resume") return this.#resume(connection, connection.sessions.nativeId(target.sessionId));
    if (!context?.nativeLaunchMarker || context.configuration?.model !== undefined || context.configuration?.thinking !== undefined
      || Object.keys(context.configuration?.permissions ?? {}).length > 0) {
      throw new KimiLaunchBlocked("agent_unsupported", "请使用 Kimi Code 的原生模型配置和可恢复的启动请求");
    }
    if (this.#active.size >= MAX_SUBSCRIPTIONS) throw new KimiLaunchBlocked("spawn_limit_reached", "Kimi Code 会话接入已达上限");
    const native = await connection.sessions.create(target.cwd, context.nativeLaunchMarker);
    const activation = { sessionId: connection.sessions.publicId(native.id), spawnMode: "headless" as const };
    await context.onCreated?.(activation);
    this.#assertConnection(connection);
    const ready = await this.#resume(connection, native.id);
    if (!native.agent_config.model && !this.#active.get(activation.sessionId)?.native.agent_config.model) {
      throw new Error("Kimi Code 已创建会话，但尚未确认可用模型；不会发送首句");
    }
    return ready;
  }

  async #resume(connection: Connection, nativeId: string): Promise<BackendActivation> {
    let native: KimiSession;
    try { native = await connection.sessions.read(nativeId); }
    catch (error) {
      if (error instanceof KimiBusinessError && error.code === 40401) throw new ActivationError("session_not_found", "Kimi Code 原生会话不存在");
      throw error;
    }
    if (native.id !== nativeId || native.archived) throw new ActivationError("session_not_found", "请先恢复已归档的 Kimi Code 会话");
    const cwd = await connection.sessions.requireLocal(native);
    this.#assertConnection(connection);
    const id = connection.sessions.publicId(nativeId);
    let item = this.#active.get(id);
    if (!item) {
      if (this.#active.size >= MAX_SUBSCRIPTIONS) throw new ActivationError("spawn_limit_reached", "Kimi Code 会话接入已达上限");
      item = { native, cwd, id, subscribed: false }; this.#active.set(id, item);
    } else { item.native = native; item.cwd = cwd; }
    if (!item.subscribed) {
      const active = item;
      const pending = active.subscribing ??= this.#subscribe(connection, active);
      try { await pending; }
      catch (error) { if (this.#connection === connection && this.#active.get(id) === active) this.#active.delete(id); throw error; }
      finally { if (active.subscribing === pending) delete active.subscribing; }
    }
    this.#assertConnection(connection);
    if (this.#active.get(id) !== item || !item.subscribed) throw new Error("Kimi Code 未确认会话订阅");
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
        item.subscribed = true;
        this.onMetadataChange?.(this.#metadata(item));
        resolve();
      };
      const timer = setTimeout(() => { finish(-1); connection.socket.terminate(); }, SUBSCRIBE_TIMEOUT_MS);
      timer.unref();
      this.#requests.set(requestId, finish);
      connection.socket.send(JSON.stringify({ type: "subscribe", request_id: requestId, session_id: item.native.id, agent_ids: ["main"] }),
        error => { if (error) finish(-1); });
    });
  }

  #frame(frame: KimiFrame, generation: number): void {
    const connection = this.#connection;
    if (!connection || generation !== connection.generation) return;
    if (frame.type === "response" && typeof frame.request_id === "string" && typeof frame.code === "number") {
      this.#requests.get(frame.request_id)?.(frame.code); return;
    }
    if (frame.type === "event.session.archived" || frame.type === "event.session.deleted" || frame.type === "event.session.restored") {
      const native = kimiObject(frame.payload).sessionId;
      if (typeof native === "string") {
        const id = connection.sessions.publicId(native);
        const item = this.#active.get(id);
        if (item && frame.type !== "event.session.restored") {
          this.#active.delete(id);
          if (item.subscribed) this.onOffline?.(this.#metadata(item), "Kimi Code 会话已关闭");
        }
        if (frame.type !== "event.session.deleted") this.onArchiveChange?.(id, frame.type === "event.session.archived");
      }
      this.onCatalogChange?.(); return;
    }
    if (frame.type === "event.session.created" || frame.type === "session.meta.updated" || frame.type === "event.session.work_changed") this.onCatalogChange?.();
    if (typeof frame.session_id !== "string") return;
    const item = this.#active.get(connection.sessions.publicId(frame.session_id));
    if (!item?.subscribed) return;
    if (frame.type === "agent" && frame.agent_id === "main") {
      const model = typeof frame.model === "string" ? frame.model : "";
      item.native = { ...item.native, main_turn_active: frame.status === "running", agent_config: { model } };
      this.onMetadataChange?.(this.#metadata(item));
    } else if (frame.type === "session.meta.updated") {
      const title = kimiObject(frame.payload).title;
      if (typeof title === "string") { item.native = { ...item.native, title }; this.onMetadataChange?.(this.#metadata(item)); }
    }
  }

  dispatchCommand(): CommandDispatch { return "unsupported"; }
}
