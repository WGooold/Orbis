import { createHash, randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  RecoverableSessionSource, SessionSyncPreparer, RUNTIME_CLOSE_CAPABILITY, createToolSummary, type AgentSessionSummary, type ChatMessage,
  type RemoteSessionEntry, type RuntimeCommand, type RuntimeEvent, type RuntimeMetadata, type ToolSummary,
} from "@orbis/protocol";
import { AcpResponseError, AcpUnconfirmedError, record, type AcpConnection, type AcpRequest, type JsonObject } from "./acp-client.js";
import type { AgentActivateContext, AgentActivateTarget, AgentBackend, BackendActivation, CommandDispatch } from "./agent-backend.js";
import type { AgySubmissionFence } from "./agy-submission-fence.js";
import { AgyApprovals, cancelAgyPermission } from "./agy-approval.js";
import { agyOptionCommands, agyOptionMetadata, agyOptions, type AgyOptions, type AgySetting } from "./agy-session-options.js";
import { localHostname } from "./sessions.js";
import { ActivationError } from "./spawner.js";

export const AGY_KIND = "agy" as const;
export const isAgyId = (id: unknown): boolean => typeof id === "string" && id.startsWith("agy:");
const publicId = (id: string) => `agy:${id}`;
const maxProjectionBytes = 16 * 1024 * 1024;
const validId = (id: unknown): id is string => typeof id === "string" && /^[\w.-]{1,120}$/u.test(id);
const validCwd = (cwd: unknown): cwd is string => typeof cwd === "string" && cwd.length <= 4096 && isAbsolute(cwd);
const clippedTitle = (title: unknown) => typeof title === "string" ? title.slice(0, 256) : "";
const epochTime = (value: unknown) => typeof value === "string" ? Math.max(0, Date.parse(value) || 0) : 0;
type Prompt = Extract<RuntimeCommand, { type: "user_message" }>;
type Delivery = NonNullable<Prompt["delivery"]>;
type Queued = { id: string; command: Prompt; delivery: Delivery };
type QueueEvent = Extract<RuntimeEvent, { type: "message.queued" }>;
type Receipt = { fingerprint: string; status: "pending" | "success" | "failure" | "cancelled" | "unconfirmed" };
type Turn = { id: string; startedAt: number; user: ChatMessage; assistant: ChatMessage; stops: Set<string>; commands: Set<string>; bytes: number; sent: boolean; stopping: boolean; overflow: boolean; queued?: Queued; tools: Map<string, ToolSummary> };
type Active = {
  nativeId: string; row: AgentSessionSummary; entries: RemoteSessionEntry[]; source: RecoverableSessionSource;
  preparer: SessionSyncPreparer; receipts: Map<string, Receipt>; turn: Turn | undefined;
  approvals: AgyApprovals; generation: string; closing: boolean; bytes: number; hasLiveTitle: boolean;
  queue: Queued[]; deliveries: Map<string, QueueEvent>;
  options: AgyOptions; configuring: boolean; configRevision: number; context?: RuntimeMetadata["contextUsage"];
};

type Replay = { messages: ChatMessage[]; tools: Map<string, ChatMessage>; bytes: number; overflow: boolean; options?: AgyOptions; title?: string; context?: RuntimeMetadata["contextUsage"] };

function append(entries: RemoteSessionEntry[], message: ChatMessage): string {
  const entryId = `agy-entry:${entries.length + 1}`;
  entries.push({ entryId, parentId: entries.at(-1)?.entryId ?? null, type: "message",
    timestamp: new Date(message.timestamp).toISOString(), data: { message } });
  return entryId;
}

function chunk(update: JsonObject): { role: "user" | "assistant"; type: "text" | "thinking"; text: string } | undefined {
  const content = record(update.content);
  if (content.type !== "text" || typeof content.text !== "string" || !content.text) return;
  if (update.sessionUpdate === "user_message_chunk") return { role: "user", type: "text", text: content.text };
  if (update.sessionUpdate === "agent_message_chunk") return { role: "assistant", type: "text", text: content.text };
  if (update.sessionUpdate === "agent_thought_chunk") return { role: "assistant", type: "thinking", text: content.text };
}

function addText(message: ChatMessage, type: "text" | "thinking", text: string): number {
  const last = message.content.at(-1);
  if (last?.type === type) { last.text += text; return message.content.length - 1; }
  message.content.push({ type, text });
  return message.content.length - 1;
}

export class AgyRuntime implements AgentBackend {
  readonly kind = AGY_KIND;
  readonly archivedCatalogSupported = false;
  readonly #abort = new AbortController();
  readonly #active = new Map<string, Active>();
  readonly #loading = new Map<string, Replay>();
  #admittedActivations = 0;
  readonly #activations = new Map<string, Promise<BackendActivation>>();
  #opening: Promise<void> | undefined;
  #cleanup: Promise<void> | undefined;
  #stopping = false;
  #client: AcpConnection | undefined;
  #reason = "Antigravity CLI 未连接";
  #catalogComplete = false;
  readonly #recentReceipts = new Map<string, Map<string, Receipt>>();
  #lastCatalog = new Map<string, AgentSessionSummary>();
  #listing: Promise<AgentSessionSummary[]> | undefined;
  #sink: (event: RuntimeEvent, runtimeId: string) => void = () => {};
  onReadyChange?: () => void;
  onCatalogChange?: () => void;
  onMetadataChange?: (metadata: RuntimeMetadata) => void;
  onOffline?: (metadata: RuntimeMetadata, reason: string) => void;

  constructor(private readonly connect: (signal: AbortSignal) => Promise<AcpConnection>, private readonly hostId = "local", private readonly fence?: AgySubmissionFence) {}
  get catalogComplete(): boolean { return this.#catalogComplete; }
  get reason(): string { return this.#opening ? "starting" : this.#reason; }
  isReady(): boolean { return this.#client !== undefined && !this.#stopping; }
  ownsRuntime(id: string): boolean { return this.#active.has(id); }
  setEventSink(sink: (event: RuntimeEvent, runtimeId: string) => void): void { this.#sink = sink; }

  start(): Promise<void> {
    if (this.#stopping || this.#client) return Promise.resolve();
    if (this.#opening) return this.#opening;
    this.#opening = this.#open().finally(() => {
      this.#opening = undefined;
      if (!this.#stopping) this.onReadyChange?.();
    });
    this.onReadyChange?.();
    return this.#opening;
  }

  async #open(): Promise<void> {
    let client: AcpConnection | undefined;
    try {
      await this.#cleanup;
      if (this.#stopping) return;
      client = await this.connect(this.#abort.signal);
      const abort = () => { void client?.stop().catch(() => {}); };
      this.#abort.signal.addEventListener("abort", abort, { once: true });
      // initialize is also available before login. A read-only list verifies readiness.
      const readiness = record(await client.request("session/list", {}, 5_000).finally(() => this.#abort.signal.removeEventListener("abort", abort)));
      if (client.connected === false || !Array.isArray(readiness.sessions)) throw new Error("Invalid ACP session list");
      if (this.#stopping) { await client.stop(); return; }
      const connected = client;
      client.onNotification = (method, params) => { if (!this.#stopping && this.#client === connected) this.#update(method, params); };
      client.onRequest = rpc => { if (!this.#stopping && this.#client === connected) this.#request(rpc); else this.#cancelRequest(rpc); };
      client.onExit = () => {
        if (this.#client !== connected) return;
        this.#cleanup = connected.stop();
        void this.#cleanup.catch(() => {});
        this.#disconnect();
      };
      this.#client = client;
      this.#reason = "";
    } catch (error) {
      await client?.stop().catch(() => {});
      this.#reason = error instanceof AcpResponseError ? "Antigravity CLI 未确认认证或会话目录"
        : error instanceof Error ? error.message.slice(0, 256) : "Antigravity CLI 不可用";
    }
  }

  /** Fence work synchronously when the Host revokes this generation. */
  revoke(): void {
    this.#stopping = true;
    this.#abort.abort();
  }

  async stop(): Promise<void> {
    this.revoke();
    await this.#opening;
    const client = this.#client;
    this.#disconnect();
    await (client?.stop() ?? this.#cleanup);
  }

  #disconnect(): void {
    this.#client = undefined;
    this.#reason = "Antigravity CLI 已断开";
    this.#catalogComplete = false;
    this.#loading.clear();
    for (const session of this.#active.values()) {
      session.approvals.clear("disconnected");
      if (session.turn) this.#finish(session, "unconfirmed");
      this.#declineQueue(session);
      session.source.flushPending();
      this.onOffline?.(this.#metadata(session), this.#reason);
    }
    this.#active.clear();
    this.onCatalogChange?.();
    if (!this.#stopping) this.onReadyChange?.();
  }

  async catalog(archived = false): Promise<AgentSessionSummary[]> {
    if (archived) return [];
    const client = this.#client;
    if (!client || this.#stopping) throw new Error(this.#reason || "Antigravity CLI 已断开");
    return this.#listing ??= this.#list(client).finally(() => { this.#listing = undefined; });
  }

  async #list(client: AcpConnection): Promise<AgentSessionSummary[]> {
    const sessions = new Map<string, AgentSessionSummary>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let complete = true;
    const deadline = performance.now() + 10_000;
    try {
      do {
        const budget = Math.min(5_000, Math.floor(deadline - performance.now()));
        if (budget <= 0) { complete = false; break; }
        const page = record(await client.request("session/list", cursor ? { cursor } : {}, budget));
        if (client !== this.#client || !Array.isArray(page.sessions) || page.sessions.length > 2_000) throw new Error("无效的 Antigravity 会话目录");
        for (const item of page.sessions) {
          const row = record(item);
          if (!validId(row.sessionId) || !validCwd(row.cwd)) { complete = false; continue; }
          const sessionId = publicId(row.sessionId);
          if (sessions.has(sessionId) && sessions.get(sessionId)?.cwd !== row.cwd) { complete = false; continue; }
          const name = clippedTitle(row.title);
          sessions.set(sessionId, { sessionId, cwd: row.cwd, agentKind: AGY_KIND, hostname: localHostname(),
            ...(name ? { name } : {}), createdAt: 0, modifiedAt: epochTime(row.updatedAt), messageCount: 0 });
        }
        if (page.nextCursor != null && typeof page.nextCursor !== "string") complete = false;
        cursor = typeof page.nextCursor === "string" && page.nextCursor ? page.nextCursor : undefined;
        if (cursor && (cursor.length > 4096 || cursors.has(cursor) || cursors.size >= 32 || sessions.size >= 8_000)) {
          complete = false; break;
        }
        if (cursor) cursors.add(cursor);
      } while (cursor);
    } catch { complete = false; }
    if (client !== this.#client) throw new Error("Antigravity CLI 连接已变化");
    if (!complete) for (const [id, row] of this.#lastCatalog) if (!sessions.has(id) && sessions.size < 10_000) sessions.set(id, row);
    this.#catalogComplete = complete;
    this.#lastCatalog = sessions;
    const result = new Map(sessions);
    for (const [id, session] of this.#active) {
      const name = session.hasLiveTitle ? session.row.name : sessions.get(id)?.name ?? session.row.name;
      result.set(id, { ...session.row, ...(name === undefined ? {} : { name }) });
    }
    return [...result.values()];
  }

  async setArchived(): Promise<void> { throw new Error("Antigravity CLI ACP 不支持归档"); }
  async sessionConfiguration(cwd: string) {
    await this.#checkDirectory(cwd);
    return { binding: "agy-acp-v1:isolated", defaults: {}, models: [], permissions: [] };
  }
  syncNotifications(runtimeId: string): void {
    const session = this.#active.get(runtimeId);
    if (session) this.#send(session, { type: "interaction.snapshot", requests: session.approvals.requests() });
  }

  async #checkDirectory(cwd: string): Promise<void> {
    if (!validCwd(cwd) || !await stat(cwd).then(s => s.isDirectory(), () => false)) throw new ActivationError("cwd_missing", "工作目录不可用");
  }
  directoryEntries(): RuntimeMetadata[] { return [...this.#active.values()].map(session => this.#metadata(session)); }
  async readSessionEntry(runtimeId: string, sessionId: string, entryId: string) {
    return runtimeId === sessionId ? this.#active.get(runtimeId)?.source.entry(entryId) : undefined;
  }

  activate(target: AgentActivateTarget, context?: AgentActivateContext): Promise<BackendActivation> {
    if (target.type === "new") return this.#admitActivation(target, context);
    if (!isAgyId(target.sessionId)) return Promise.reject(new ActivationError("session_not_found", "不属于 Antigravity CLI 的会话"));
    const prior = this.#activations.get(target.sessionId);
    if (prior) return prior;
    const operation = this.#admitActivation(target, context).finally(() => this.#activations.delete(target.sessionId));
    this.#activations.set(target.sessionId, operation);
    return operation;
  }

  async #admitActivation(target: AgentActivateTarget, context?: AgentActivateContext): Promise<BackendActivation> {
    if (this.#admittedActivations >= 8 || (this.#active.size + this.#admittedActivations >= 64 && !(target.type === "resume" && this.#active.has(target.sessionId))))
      throw new ActivationError("spawn_failed", "Antigravity session limit reached");
    this.#admittedActivations++;
    try { return await this.#activate(target, context); }
    finally { this.#admittedActivations--; }
  }

  async #activate(target: AgentActivateTarget, context?: AgentActivateContext): Promise<BackendActivation> {
    const client = this.#client;
    if (!client || this.#stopping) throw new ActivationError("agent_unsupported", this.#reason);
    if (context?.configuration && Object.keys(context.configuration).length) throw new ActivationError("agent_unsupported", "Antigravity ACP 未提供新建前的模型或权限目录");
    const requireCurrent = () => {
      context?.requireCurrent?.();
      if (client !== this.#client || this.#stopping) throw new ActivationError("spawn_failed", "Antigravity CLI 连接已变化");
    };
    requireCurrent();
    let nativeId: string;
    let row: AgentSessionSummary;
    const replay: Replay = { messages: [], tools: new Map(), bytes: 0, overflow: false };
    if (target.type === "resume") {
      const active = this.#active.get(target.sessionId);
      if (active?.closing) throw new ActivationError("spawn_failed", "Antigravity 会话正在关闭");
      if (active) return { sessionId: target.sessionId, spawnMode: "headless" };
      const existing = (await this.catalog()).find(item => item.sessionId === target.sessionId);
      if (!existing) throw new ActivationError(this.#catalogComplete ? "session_not_found" : "spawn_failed", "未确认 Antigravity 会话");
      row = existing;
      nativeId = row.sessionId.slice(4);
      await this.#checkDirectory(row.cwd);
      requireCurrent();
      this.#loading.set(nativeId, replay);
      try {
        const loaded = record(await client.request("session/load", { sessionId: nativeId, cwd: row.cwd, mcpServers: [] }, 120_000));
        const options = agyOptions(loaded.configOptions);
        if (options) replay.options = options;
      } catch { throw new ActivationError("spawn_failed", "无法加载 Antigravity 会话"); }
      finally { this.#loading.delete(nativeId); }
      if (replay.overflow) {
        if (client.supportsClose) await client.request("session/close", { sessionId: nativeId }).catch(() => {});
        throw new ActivationError("spawn_failed", "Antigravity 会话历史超过接入上限");
      }
    } else {
      const cwd = target.cwd;
      await this.#checkDirectory(cwd);
      requireCurrent();
      const result = record(await client.request("session/new", { cwd, mcpServers: [] }).catch(() => {
        throw new ActivationError("spawn_failed", "Antigravity 会话创建未确认");
      }));
      if (!validId(result.sessionId)) throw new ActivationError("spawn_failed", "Antigravity 未返回有效的会话身份");
      nativeId = result.sessionId;
      if (this.#active.has(publicId(nativeId))) throw new ActivationError("spawn_failed", "Duplicate Antigravity session identity");
      const options = agyOptions(result.configOptions);
      if (options) replay.options = options;
      row = { sessionId: publicId(nativeId), cwd, agentKind: AGY_KIND, hostname: localHostname(), createdAt: Date.now(), modifiedAt: Date.now(), messageCount: 0 };
    }
    const result = { sessionId: row.sessionId, spawnMode: "headless" as const };
    try {
      await context?.onCreated?.(result);
      requireCurrent();
    } catch (error) {
      // The native identity is kept for later explicit recovery. Release just
      // this unpublished attachment, not the session history or another owner.
      if (client === this.#client && !this.#stopping && client.supportsClose) {
        await client.request("session/close", { sessionId: nativeId }, 5_000).catch(() => {});
      }
      throw error;
    }
    const id = result.sessionId;
    const source = new RecoverableSessionSource(id, event => this.#sink(event, id), { coalesceMs: 40 });
    const entries: RemoteSessionEntry[] = [];
    for (const message of replay.messages) append(entries, message);
    const approvals = new AgyApprovals(id, event => this.#sink(event, id));
    const receipts = this.#recentReceipts.get(id) ?? new Map<string, Receipt>();
    this.#recentReceipts.delete(id);
    this.#recentReceipts.set(id, receipts);
    if (this.#recentReceipts.size > 128) {
      const inactive = [...this.#recentReceipts.keys()].find(key => key !== id && !this.#active.has(key));
      if (inactive) this.#recentReceipts.delete(inactive);
    }
    const session: Active = { nativeId, row: { ...row, ...(replay.title === undefined ? {} : { name: replay.title }), messageCount: entries.length }, entries, source, preparer: new SessionSyncPreparer(), receipts, turn: undefined, queue: [], deliveries: new Map(),
      approvals, generation: randomUUID(), closing: false, bytes: replay.bytes, hasLiveTitle: replay.title !== undefined, options: replay.options ?? {},
      configuring: false, configRevision: 0, context: replay.context };
    this.#active.set(id, session);
    source.transaction(() => { source.reconcile(entries, entries.at(-1)?.entryId ?? null); source.setAvailability(true, true); });
    this.#publish(session);
    this.#capabilities(session, client);
    this.onCatalogChange?.();
    return result;
  }

  #cancelRequest(rpc: AcpRequest): void {
    if (rpc.method === "session/request_permission") cancelAgyPermission(rpc);
    else if (rpc.method === "elicitation/create") rpc.respond({ action: "decline" });
    else rpc.reject("Unsupported ACP client method");
  }

  #request(rpc: AcpRequest): void {
    const session = validId(rpc.params.sessionId) ? this.#active.get(publicId(rpc.params.sessionId)) : undefined;
    if ((rpc.method !== "session/request_permission" && rpc.method !== "elicitation/create") || !session?.turn || session.turn.stopping || session.closing) {
      this.#cancelRequest(rpc); return;
    }
    session.approvals.add(rpc);
  }

  async #close(session: Active, client: AcpConnection, commandId: string): Promise<void> {
    session.closing = true;
    session.approvals.clear("owner_closed");
    try {
      await client.request("session/close", { sessionId: session.nativeId });
      if (this.#client !== client || this.#active.get(session.row.sessionId) !== session) throw new AcpUnconfirmedError("Connection changed");
      if (session.turn) this.#finish(session, "unconfirmed");
      this.#declineQueue(session);
      this.#result(session, commandId, "success");
      session.source.flushPending();
      this.#active.delete(session.row.sessionId);
      this.onOffline?.(this.#metadata(session), "session_closed");
      this.onCatalogChange?.();
    } catch (error) {
      this.#result(session, commandId, error instanceof AcpUnconfirmedError ? "unconfirmed" : "failure", "session_close_unconfirmed");
    } finally { session.closing = false; }
  }

  #metadata(session: Active): RuntimeMetadata {
    return { runtimeId: session.row.sessionId, sessionId: session.row.sessionId, name: "Antigravity CLI", cwd: session.row.cwd,
      hostname: session.row.hostname, ...(session.row.name === undefined ? {} : { sessionName: session.row.name }),
      status: session.turn ? "running" : "idle", sessionGraphSync: true, sessionLeafId: session.entries.at(-1)?.entryId ?? null,
      ...agyOptionMetadata(session.options), ...(session.context ? { contextUsage: session.context } : {}),
      currentTurnConfigurationSupported: false, steerSupported: true };
  }
  #capabilities(session: Active, client: AcpConnection): void {
    const commands = agyOptionCommands(session.options);
    if (client.supportsClose) commands.push({ name: RUNTIME_CLOSE_CAPABILITY, source: "builtin", closeGeneration: session.generation });
    this.#send(session, { type: "runtime.capabilities", capabilities: { commands } });
  }

  async #setOption(session: Active, client: AcpConnection, commandId: string, name: AgySetting, value: string): Promise<void> {
    const option = session.options[name];
    if (!option?.choices.some(item => item.value === value) || session.turn || session.configuring || session.queue.length) {
      this.#result(session, commandId, "failure", "configuration_unavailable"); return;
    }
    if (option.current === value) { this.#result(session, commandId, "success"); return; }
    session.configuring = true;
    const revision = session.configRevision;
    try {
      const response = record(await client.request("session/set_config_option", { sessionId: session.nativeId, configId: option.id, value }));
      if (this.#client !== client || this.#active.get(session.row.sessionId) !== session) throw new AcpUnconfirmedError("Connection changed");
      const next = agyOptions(response.configOptions);
      if (next && revision === session.configRevision) this.#applyOptions(session, client, next);
      if (session.options[name]?.current !== value || session.options[name]?.id !== option.id) throw new AcpUnconfirmedError("Configuration did not reconcile");
      this.#result(session, commandId, "success");
    } catch (error) {
      this.#result(session, commandId, error instanceof AcpUnconfirmedError ? "unconfirmed" : "failure", "configuration_unconfirmed");
    } finally { session.configuring = false; }
  }

  #applyOptions(session: Active, client: AcpConnection, options: AgyOptions): void {
    session.configRevision++;
    session.options = options;
    this.#publish(session);
    this.#capabilities(session, client);
  }

  #send(session: Active, event: RuntimeEvent): void { this.#sink(event, session.row.sessionId); }
  #publish(session: Active): void { this.onMetadataChange?.(this.#metadata(session)); }
  #result(session: Active, commandId: string, status: Receipt["status"] | "not_cancelable" | "message_id_conflict" | "already_delivered", error?: string): void {
    this.#send(session, { type: "command.result", commandId, status,
      ok: ["pending", "success", "cancelled", "already_delivered"].includes(status), ...(error ? { error } : {}) });
  }

  dispatchCommand(runtimeId: string, commandId: string, command: RuntimeCommand): CommandDispatch {
    const session = this.#active.get(runtimeId), client = this.#client;
    if (!session || !client || this.#stopping) return "offline";
    if (session.closing && command.type !== "session.sync") { this.#result(session, commandId, "failure", "session_closing"); return "handled"; }
    switch (command.type) {
      case "slash.execute":
        if (command.name !== "model" && command.name !== "thinking") return "unsupported";
        void this.#setOption(session, client, commandId, command.name, command.args);
        break;
      case "session.close":
        if (session.configuring) { this.#result(session, commandId, "failure", "configuration_pending"); break; }
        if (!client.supportsClose || command.sessionId !== runtimeId || command.closeGeneration !== session.generation) return "unsupported";
        void this.#close(session, client, commandId);
        break;
      case "interaction.respond":
        try {
          const ok = session.approvals.respond(command);
          this.#result(session, commandId, ok ? "success" : "failure", ok ? undefined : "interaction_changed");
        } catch { this.#result(session, commandId, "unconfirmed", "interaction_unconfirmed"); }
        break;
      case "user_message.cancel": {
        const index = session.queue.findIndex(item => item.id === command.messageId);
        const item = index < 0 ? undefined : session.queue.splice(index, 1)[0];
        if (!item) { this.#result(session, commandId, "not_cancelable"); break; }
        const receipt = session.receipts.get(item.id);
        if (receipt) receipt.status = "cancelled";
        this.#delivery(session, item, "cancelled");
        this.#result(session, commandId, "cancelled");
        break;
      }
      case "session.sync":
        if (command.sessionId !== runtimeId) { this.#result(session, commandId, "failure", "session_mismatch"); break; }
        session.source.flushPending();
        this.#send(session, session.preparer.select({ entries: session.entries, sessionId: runtimeId,
          leafId: session.entries.at(-1)?.entryId ?? null, request: command, source: session.source.published() }));
        this.#capabilities(session, client);
        this.#send(session, { type: "delivery.snapshot", items: [...session.deliveries.values()].map(({ queueId, text, delivery, state, error }) => ({ queueId, text, delivery, state, ...(error ? { error } : {}) })), complete: session.deliveries.size < 96 });
        this.syncNotifications(runtimeId);
        this.#result(session, commandId, "success"); break;
      case "user_message": this.#submit(session, client, commandId, command); break;
      case "stop":
        if (!session.turn) this.#result(session, commandId, "not_cancelable");
        else {
          try {
            this.#cancelTurn(session, client);
            if (session.turn.stops.size < 64) {
              session.turn.stops.add(commandId);
              this.#result(session, commandId, "pending");
            } else this.#result(session, commandId, "not_cancelable");
          } catch { this.#result(session, commandId, "unconfirmed"); }
        }
        break;
      default: return "unsupported";
    }
    return "handled";
  }

  #cancelTurn(session: Active, client: AcpConnection): void {
    const turn = session.turn;
    if (!turn || turn.stopping) return;
    if (turn.sent) client.notify("session/cancel", { sessionId: session.nativeId });
    turn.stopping = true;
    session.approvals.clear("cancelled");
  }

  #delivery(session: Active, item: Queued, state: QueueEvent["state"], error?: string): void {
    const event = { type: "message.queued" as const, queueId: item.id, text: item.command.text.slice(0, 4096), delivery: item.delivery, state,
      ...(error ? { error } : {}) };
    session.deliveries.set(item.id, event);
    if (session.deliveries.size > 96) {
      const oldestSettled = [...session.deliveries].find(([, value]) => value.state !== "accepted" && value.state !== "unconfirmed");
      if (oldestSettled) session.deliveries.delete(oldestSettled[0]);
      else session.deliveries.delete(session.deliveries.keys().next().value!);
    }
    this.#send(session, event);
  }

  #declineQueue(session: Active): void {
    for (const item of session.queue.splice(0)) {
      const receipt = session.receipts.get(item.id);
      if (receipt) receipt.status = "failure";
      this.#delivery(session, item, "rejected", "Antigravity queued message was not sent");
    }
  }

  #submit(session: Active, client: AcpConnection, commandId: string, command: Prompt): void {
    if (!command.text.trim() || command.attachments?.some(path => !validCwd(path))) {
      this.#result(session, commandId, "failure", "Invalid Antigravity message"); return;
    }
    const userId = command.messageId ?? randomUUID();
    const fingerprint = createHash("sha256").update(JSON.stringify([command.text, command.attachments ?? [], command.delivery ?? null])).digest("base64url");
    const previous = session.receipts.get(userId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) { this.#result(session, commandId, "message_id_conflict"); return; }
      const delivery = session.deliveries.get(userId);
      if (delivery?.state === "accepted") { this.#send(session, delivery); this.#result(session, commandId, "success"); return; }
      if (previous.status === "pending" && session.turn?.user.messageId === userId && session.turn.commands.size < 64) session.turn.commands.add(commandId);
      this.#result(session, commandId, previous.status === "success" ? "already_delivered" : previous.status);
      return;
    }
    if (session.configuring || !command.delivery && (session.turn || session.queue.length)) {
      this.#result(session, commandId, "failure", "runtime_busy"); return;
    }
    if (session.receipts.size >= 2_048 || session.bytes >= maxProjectionBytes || session.entries.length >= 20_000 || session.queue.length >= 16) {
      this.#result(session, commandId, "failure", "Antigravity session projection limit reached"); return;
    }
    session.receipts.set(userId, { fingerprint, status: "pending" });
    if (command.delivery && (session.turn || session.queue.length)) {
      const item: Queued = { id: userId, command, delivery: command.delivery };
      // Same immediate-send semantics as Codex CLI: cancel then dispatch a new turn,
      // never a second simultaneous session/prompt or a guessed acknowledgement.
      if (command.delivery === "steer") {
        try { this.#cancelTurn(session, client); }
        catch { session.receipts.delete(userId); this.#result(session, commandId, "failure", "interrupt_unconfirmed"); return; }
        session.queue.unshift(item);
      } else session.queue.push(item);
      this.#delivery(session, item, "accepted");
      this.#result(session, commandId, "success");
      return;
    }
    void this.#prompt(session, client, userId, command, commandId);
  }

  async #prompt(session: Active, client: AcpConnection, userId: string, command: Prompt, commandId?: string, queued?: Queued): Promise<void> {
    const startedAt = Date.now();
    const turn: Turn = { id: randomUUID(), startedAt, stops: new Set(), commands: new Set(commandId === undefined ? [] : [commandId]),
      ...(queued ? { queued } : {}),
      bytes: Buffer.byteLength(command.text), sent: false, stopping: false, overflow: false, tools: new Map(),
      user: { messageId: userId, role: "user", content: [{ type: "text", text: command.text }], timestamp: startedAt },
      assistant: { messageId: randomUUID(), role: "assistant", content: [], timestamp: startedAt } };
    session.turn = turn;
    if (commandId !== undefined) this.#result(session, commandId, "pending");
    this.#live(session, turn.user);
    const started = { type: "turn.started" as const, turnId: turn.id, startedAt };
    session.source.observe(started);
    this.#send(session, started);
    this.#publish(session);
    let status: Receipt["status"];
    try {
      if (this.fence && !await this.fence(session.nativeId, userId)) throw new AcpUnconfirmedError("Antigravity message identity already submitted");
      if (client !== this.#client || session.turn !== turn || this.#stopping) return;
      if (turn.stopping || session.closing) { this.#finish(session, "cancelled"); return; }
      turn.sent = true;
      // Orbis has already staged these as Host paths. Do not read the local file or add unnegotiated ACP client FS tools.
      const text = command.attachments?.length ? `${command.text}\n\nAttachments (local paths): ${JSON.stringify(command.attachments)}` : command.text;
      const result = record(await client.request("session/prompt", { sessionId: session.nativeId, prompt: [{ type: "text", text }] }, 30 * 60_000));
      status = turn.overflow ? "unconfirmed" : result.stopReason === "cancelled" ? "cancelled"
        : ["end_turn", "max_tokens", "max_turn_requests", "refusal"].includes(String(result.stopReason)) ? "success" : "unconfirmed";
    } catch (error) { status = error instanceof AcpUnconfirmedError ? "unconfirmed" : "failure"; }
    if (session.turn === turn) this.#finish(session, status);
  }

  #live(session: Active, message: ChatMessage): void {
    session.source.upsertMessage({ message: { ...message, content: message.content.map(block => ({ ...block })) }, finished: false, contentComplete: false });
  }

  #finish(session: Active, status: Receipt["status"]): void {
    const turn = session.turn!;
    session.approvals.clear("cancelled");
    const receipt = session.receipts.get(turn.user.messageId);
    if (receipt) receipt.status = status;
    for (const id of turn.commands) this.#result(session, id, status, status === "failure" ? "Antigravity CLI 未完成回合" : undefined);
    const persistedMessages: { messageId: string; entryId: string }[] = [];
    const confirmed = status === "success" || status === "cancelled" && turn.assistant.content.length > 0;
    if (turn.queued) this.#delivery(session, turn.queued, confirmed ? "delivered" : status === "unconfirmed" ? "unconfirmed" : status === "cancelled" ? "cancelled" : "rejected");
    if (confirmed) for (const message of [turn.user, turn.assistant]) if (message.content.length) {
      persistedMessages.push({ messageId: message.messageId, entryId: append(session.entries, message) });
      this.#send(session, { type: "message.finished", message });
    }
    for (const toolSummary of turn.tools.values()) {
      session.source.discardLiveMessage(toolSummary.tool.toolCallId);
      if (confirmed && toolSummary.phase === "finished") {
        const message: ChatMessage = { messageId: toolSummary.tool.toolCallId, role: "tool", timestamp: Date.now(), content: [], toolSummary };
        persistedMessages.push({ messageId: message.messageId, entryId: append(session.entries, message) });
      }
    }
    session.turn = undefined;
    const finished: RuntimeEvent = { type: "turn.finished", turnId: turn.id, startedAt: turn.startedAt,
      durationMs: Math.max(0, Date.now() - turn.startedAt), outcome: status === "success" ? "completed"
        : status === "cancelled" ? "cancelled" : status === "failure" ? "failed" : "unknown", persistedMessages };
    this.#send(session, finished);
    session.source.transaction(() => {
      session.source.observe(finished);
      session.source.discardLiveMessage(turn.user.messageId);
      session.source.discardLiveMessage(turn.assistant.messageId);
      session.source.reconcile(session.entries, session.entries.at(-1)?.entryId ?? null, persistedMessages);
    });
    for (const id of turn.stops) this.#result(session, id, status === "cancelled" ? "success" : status === "unconfirmed" ? "unconfirmed" : "not_cancelable");
    if (confirmed) { session.bytes += turn.bytes; session.row.modifiedAt = Date.now(); session.row.messageCount = session.entries.length; this.onCatalogChange?.(); }
    if (this.isReady()) this.#publish(session);
    if (status === "unconfirmed" || status === "failure") this.#declineQueue(session);
    else queueMicrotask(() => {
      const client = this.#client;
      if (!client || session.turn || session.closing || this.#active.get(session.row.sessionId) !== session) return;
      if (session.bytes >= maxProjectionBytes || session.entries.length >= 20_000) { this.#declineQueue(session); return; }
      const item = session.queue.shift();
      if (item) void this.#prompt(session, client, item.id, item.command, undefined, item);
    });
  }

  #toolSummary(sessionId: string, nativeId: string, update: JsonObject, order: number, previous?: ToolSummary, turnId?: string): ToolSummary {
    const name = typeof update.title === "string" ? update.title.trim().slice(0, 160) : "";
    const phase = update.status === "completed" || update.status === "failed" ? "finished"
      : update.status === "in_progress" ? "running" : previous?.phase ?? "started";
    return createToolSummary({ tool: { agent: { hostId: this.hostId, agentKind: AGY_KIND, sessionId },
      toolCallId: `agy-tool:${createHash("sha256").update(JSON.stringify([sessionId, nativeId])).digest("hex")}` },
      toolName: name || previous?.toolName || "Antigravity CLI", phase, ...(turnId ? { turnId } : {}), order: previous?.order ?? order, contents: [],
      ...(phase === "finished" ? { isError: update.status === "failed" } : {}) });
  }

  #tool(sessionId: string, update: JsonObject, active: Active | undefined, replay: Replay | undefined): void {
    if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return;
    if (typeof update.toolCallId !== "string" || !update.toolCallId || update.toolCallId.length > 512) return;
    const key = update.toolCallId;
    if (replay && !replay.overflow) {
      const previous = replay.tools.get(key);
      if (!previous && (replay.tools.size >= 2_000 || replay.messages.length >= 20_000)) { replay.overflow = true; return; }
      if (!previous && update.sessionUpdate !== "tool_call") return;
      if (previous?.toolSummary?.phase === "finished") return;
      const summary = this.#toolSummary(sessionId, key, update, replay.tools.size, previous?.toolSummary);
      if (previous) previous.toolSummary = summary;
      else {
        const message: ChatMessage = { messageId: summary.tool.toolCallId, role: "tool", timestamp: 0, content: [], toolSummary: summary };
        replay.messages.push(message);
        replay.tools.set(key, message);
      }
      return;
    }
    const turn = active?.turn;
    if (!active || !turn || turn.overflow) return;
    const previous = turn.tools.get(key);
    if ((!previous && (turn.tools.size >= 128 || update.sessionUpdate !== "tool_call")) || previous?.phase === "finished") return;
    const summary = this.#toolSummary(sessionId, key, update, turn.tools.size, previous, turn.id);
    turn.tools.set(key, summary);
    const message: ChatMessage = { messageId: summary.tool.toolCallId, role: "tool", timestamp: Date.now(), content: [], toolSummary: summary };
    active.source.upsertMessage({ message, finished: summary.phase === "finished", contentComplete: summary.phase === "finished" });
  }

  #update(method: string, params: JsonObject): void {
    if (method !== "session/update" || !validId(params.sessionId)) return;
    const update = record(params.update);
    const piece = chunk(update);
    const replay = this.#loading.get(params.sessionId);
    const active = this.#active.get(publicId(params.sessionId));
    if (!piece) {
      switch (update.sessionUpdate) {
        case "config_option_update": {
          const options = agyOptions(update.configOptions);
          if (options && replay) replay.options = options;
          if (options && active && this.#client) this.#applyOptions(active, this.#client, options);
          break;
        }
        case "session_info_update": {
          if (update.title !== null && typeof update.title !== "string") break;
          if (active) active.hasLiveTitle = true;
          const title = clippedTitle(update.title);
          if (replay) replay.title = title;
          if (active && title !== active.row.name) {
            active.row.name = title;
            this.#publish(active);
            this.onCatalogChange?.();
          }
          break;
        }
        case "usage_update": {
          const { size, used } = update;
          if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0 || typeof used !== "number" || !Number.isSafeInteger(used) || used < 0) break;
          const context = { tokens: used, contextWindow: size, percent: Math.min(100, used * 100 / size) };
          if (replay) replay.context = context;
          if (active && (active.context?.tokens !== used || active.context.contextWindow !== size)) { active.context = context; this.#publish(active); }
          break;
        }
        default: this.#tool(publicId(params.sessionId), update, active, replay);
      }
      return;
    }
    if (replay) {
      if (replay.overflow) return;
      replay.bytes += Buffer.byteLength(piece.text);
      if (replay.bytes > maxProjectionBytes || replay.messages.length >= 20_000) { replay.overflow = true; return; }
      let message = replay.messages.at(-1);
      if (!message || message.role !== piece.role) {
        message = { messageId: `agy-replay:${replay.messages.length + 1}`, role: piece.role, timestamp: 0, content: [] };
        replay.messages.push(message);
      }
      if (message.content.length >= 256 && message.content.at(-1)?.type !== piece.type) { replay.overflow = true; return; }
      addText(message, piece.type, piece.text);
      return;
    }
    const session = active;
    const turn = session?.turn;
    if (!session || !turn || piece.role !== "assistant" || turn.overflow) return;
    turn.bytes += Buffer.byteLength(piece.text);
    if (session.bytes + turn.bytes > maxProjectionBytes || turn.assistant.content.length >= 256 && turn.assistant.content.at(-1)?.type !== piece.type) {
      turn.overflow = true;
      turn.stopping = true;
      session.approvals.clear("cancelled");
      try { this.#client?.notify("session/cancel", { sessionId: session.nativeId }); } catch { /* The close handler settles the pending turn. */ }
      return;
    }
    if (!turn.assistant.content.length) this.#send(session, { type: "message.started", message: { ...turn.assistant, content: [] } });
    const index = addText(turn.assistant, piece.type, piece.text);
    this.#send(session, { type: "message.delta", messageId: turn.assistant.messageId, contentType: piece.type, contentIndex: index, delta: piece.text });
    this.#live(session, turn.assistant);
  }
}
