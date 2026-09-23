/** DeepSeek Harness backend: ACP owns execution; the matching persistence API owns history. */
import { createHash, randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  selectSessionSyncSnapshot,
  type AgentSessionSummary, type ChatMessage, type InteractionRequest, type RemoteSessionEntry,
  type RuntimeCapabilities, type RuntimeCommand, type RuntimeEvent, type RuntimeMetadata,
} from "@pi-remote/protocol";
import type { AgentActivateTarget, AgentBackend, BackendActivation, CommandDispatch } from "./agent-backend.js";
import { DshAcpClient, record, resolveDshCommand, type DshConnection, type DshRequest, type JsonObject } from "./dsh-client.js";
import { dshEntries, openDshHistory, type DshHistory } from "./dsh-history.js";
import { localHostname } from "./sessions.js";
import { ActivationError } from "./spawner.js";

type Session = {
  id: string; cwd: string; createdAt: number; options: JsonObject[]; entries: RemoteSessionEntry[];
  running: boolean; closing: boolean; cancelRequested: boolean; updates: Promise<void>; streamed: Map<string, ChatMessage>;
  tools: Map<string, { name: string; input: unknown }>; lastSeq: number; usage?: RuntimeMetadata["contextUsage"];
  messages: Map<string, { fingerprint: string; status: "pending" | "success" | "failure" | "cancelled"; error?: string }>;
};
type Approval = { session: Session; request: DshRequest; interaction: InteractionRequest; timer: NodeJS.Timeout };
const objects = (value: unknown): JsonObject[] => Array.isArray(value) ? value.map(record) : [];
const publicId = (id: string): string => `dsh:${id}`;
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
// ACP's provider-default choice can be the empty string; Orbis menu values cannot.
const wireOption = (value: string): string => JSON.stringify(value);

function optionChoices(value: unknown): { value: string; label: string }[] {
  return objects(value).flatMap(item => Array.isArray(item.options) ? optionChoices(item.options)
    : typeof item.value === "string" && typeof item.name === "string" ? [{ value: item.value, label: item.name }] : []);
}

export class DshRuntime implements AgentBackend {
  readonly kind = "dsh" as const;
  readonly #client: DshConnection;
  readonly #history: DshHistory;
  readonly #sessions = new Map<string, Session>();
  readonly #activating = new Map<string, Promise<BackendActivation>>();
  readonly #approvals = new Map<string, Approval>();
  #ready = true;
  #stopping: Promise<void> | undefined;
  #activation: Promise<unknown> = Promise.resolve();
  #sink: (event: RuntimeEvent, runtimeId: string) => void = () => {};
  onMetadataChange: (() => void) | undefined;
  onOffline: ((reason: string, runtimes: RuntimeMetadata[]) => void) | undefined;

  constructor(client: DshConnection, history: DshHistory) {
    this.#client = client;
    this.#history = history;
    client.onNotification = (method, params) => this.#notification(method, params);
    client.onRequest = request => this.#permission(request);
    client.onExit = reason => {
      const runtimes = this.directoryEntries();
      this.#ready = false;
      for (const id of this.#approvals.keys()) this.#cancelApproval(id, "disconnected");
      this.#sessions.clear();
      this.onOffline?.(reason, runtimes);
    };
  }

  static async create(): Promise<DshRuntime> {
    const cli = await resolveDshCommand();
    const history = await openDshHistory(cli.prefixArgs[0]!);
    try { return new DshRuntime(await DshAcpClient.create({ cli }), history); }
    catch (error) { await history.close(); throw error; }
  }

  setEventSink(sink: (event: RuntimeEvent, runtimeId: string) => void): void { this.#sink = sink; }
  isReady(): boolean { return this.#ready; }
  ownsRuntime(runtimeId: string): boolean { return this.#sessions.has(runtimeId); }
  directoryEntries(): RuntimeMetadata[] { return [...this.#sessions.values()].map(session => this.#metadata(session)); }
  announce(): void {
    for (const session of this.#sessions.values()) {
      this.#publishMetadata(session);
      this.#emit(session, { type: "runtime.capabilities", capabilities: this.#capabilities(session) });
      this.#emit(session, { type: "interaction.snapshot", requests: [...this.#approvals.values()].filter(item => item.session === session).map(item => item.interaction) });
    }
  }

  async catalog(archived = false): Promise<AgentSessionSummary[]> {
    if (archived) return [];
    const result = new Map<string, AgentSessionSummary>();
    const headers = new Map((await this.#history.list()).map(header => [header.id, header]));
    let cursor: string | undefined;
    const cursors = new Set<string>();
    do {
      const page = record(await this.#client.request("session/list", cursor === undefined ? {} : { cursor }));
      for (const raw of objects(page.sessions)) {
        if (typeof raw.sessionId !== "string" || typeof raw.cwd !== "string") continue;
        result.set(publicId(raw.sessionId), {
          sessionId: publicId(raw.sessionId), agentKind: "dsh", hostname: localHostname(), cwd: raw.cwd,
          createdAt: headers.get(raw.sessionId)?.createdAt ?? 0, modifiedAt: headers.get(raw.sessionId)?.createdAt ?? 0, messageCount: 0,
          ...(typeof raw.title === "string" ? { name: raw.title.slice(0, 256) } : {}),
        });
      }
      cursor = typeof page.nextCursor === "string" ? page.nextCursor : undefined;
      if (cursor && cursors.has(cursor)) throw new Error("DSH 返回重复的会话分页游标");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    // ACP session/list intentionally omits sessions active on its own connection.
    for (const session of this.#sessions.values()) result.set(publicId(session.id), {
      sessionId: publicId(session.id), agentKind: "dsh", hostname: localHostname(), cwd: session.cwd,
      createdAt: session.createdAt, modifiedAt: Number(record(session.entries.at(-1)?.data.message).timestamp) || session.createdAt, messageCount: session.entries.length,
    });
    return [...result.values()];
  }

  async setArchived(): Promise<void> {
    throw new Error("DeepSeek Harness ACP 不支持归档，请在 dsh 中管理会话");
  }

  activate(target: AgentActivateTarget): Promise<BackendActivation> {
    if (!this.#ready) return Promise.reject(new ActivationError("agent_unsupported", "DSH 后端未就绪"));
    if (target.type === "resume") {
      if (!target.sessionId.startsWith("dsh:")) return Promise.reject(new ActivationError("session_not_found", "不属于 DeepSeek Harness 的会话"));
      const active = this.#sessions.get(target.sessionId);
      if (active && !active.closing) return Promise.resolve({ sessionId: target.sessionId, spawnMode: "headless" });
      const prior = this.#activating.get(target.sessionId);
      if (prior) return prior;
      const operation = this.#scheduleActivation(target).finally(() => this.#activating.delete(target.sessionId));
      this.#activating.set(target.sessionId, operation);
      return operation;
    }
    return this.#scheduleActivation(target);
  }

  #scheduleActivation(target: AgentActivateTarget): Promise<BackendActivation> {
    const operation = this.#activation.then(() => this.#activate(target));
    this.#activation = operation.catch(() => {});
    return operation;
  }

  async #activate(target: AgentActivateTarget): Promise<BackendActivation> {
    if (!this.#ready) throw new ActivationError("agent_unsupported", "DSH 后端未就绪");
    if (this.#sessions.size >= 8) throw new ActivationError("spawn_limit_reached", "DSH 活跃会话已达上限（8），请先关闭不用的会话");
    let cwd: string;
    let id: string | undefined;
    if (target.type === "resume") {
      id = target.sessionId.slice(4);
      const entry = (await this.catalog()).find(item => item.sessionId === target.sessionId);
      if (!entry) throw new ActivationError("session_not_found", "找不到这个 DSH 会话");
      cwd = entry.cwd;
    } else cwd = target.cwd;
    if (!isAbsolute(cwd) || !await stat(cwd).then(info => info.isDirectory(), () => false)) {
      throw new ActivationError("cwd_missing", "请选择存在的绝对目录");
    }
    const response = record(await this.#client.request(id === undefined ? "session/new" : "session/resume", {
      cwd, mcpServers: [], ...(id === undefined ? {} : { sessionId: id }),
    }, 60_000));
    id ??= typeof response.sessionId === "string" ? response.sessionId : undefined;
    if (!id) throw new Error("DSH 没有返回会话 ID");
    try {
      if (!this.#ready) throw new Error("DSH 后端正在停止");
      const log = await this.#history.read(id);
      const session: Session = {
        id, cwd, createdAt: log.header.createdAt, options: objects(response.configOptions), entries: dshEntries(log),
        running: false, closing: false, cancelRequested: false, updates: Promise.resolve(), streamed: new Map(), tools: new Map(), messages: new Map(), lastSeq: log.events.at(-1)?.seq ?? -1,
      };
      this.#sessions.set(publicId(id), session);
      this.#publishMetadata(session);
      this.#emit(session, { type: "runtime.capabilities", capabilities: this.#capabilities(session) });
      return { sessionId: publicId(id), spawnMode: "headless" };
    } catch (error) {
      await this.#client.request("session/close", { sessionId: id }).catch(() => {});
      throw error;
    }
  }

  dispatchCommand(runtimeId: string, commandId: string, command: RuntimeCommand): CommandDispatch {
    const session = this.#sessions.get(runtimeId);
    if (!this.#ready || !session) return "offline";
    if (!["user_message", "user_message.cancel", "stop", "session.sync", "slash.execute", "interaction.respond"].includes(command.type)) return "unsupported";
    void this.#command(session, commandId, command).catch(error => this.#emit(session, {
      type: "command.result", commandId, ok: false, status: "failure", error: errorText(error),
    }));
    return "handled";
  }

  async #command(session: Session, commandId: string, command: RuntimeCommand): Promise<void> {
    if (session.closing) throw new Error("DSH 会话正在关闭");
    switch (command.type) {
      case "session.sync": {
        if (command.sessionId !== publicId(session.id)) throw new Error("session_mismatch");
        await this.#refresh(session);
        this.#emit(session, selectSessionSyncSnapshot(session.entries, publicId(session.id), session.entries.at(-1)?.entryId ?? null, command));
        this.#emit(session, { type: "runtime.capabilities", capabilities: this.#capabilities(session) });
        this.#emit(session, { type: "interaction.snapshot", requests: [...this.#approvals.values()].filter(item => item.session === session).map(item => item.interaction) });
        break;
      }
      case "user_message": await this.#prompt(session, commandId, command); return;
      case "user_message.cancel":
        this.#emit(session, { type: "command.result", commandId, ok: false, status: "not_cancelable", error: "DSH 不支持撤回排队消息；请使用停止" }); return;
      case "stop":
        session.cancelRequested = true;
        this.#client.notify("session/cancel", { sessionId: session.id });
        this.#cancelSessionApprovals(session, "cancelled");
        break;
      case "interaction.respond": {
        const pending = this.#approvals.get(command.requestId);
        if (!pending || pending.session !== session || command.extensionId !== "dsh") throw new Error("审批已结束或不属于这个会话");
        if (command.response.kind === "cancel") this.#cancelApproval(command.requestId, "cancelled");
        else {
          const interaction = pending.interaction;
          if (command.response.kind !== "select" || interaction.kind !== "select" || !interaction.options.some(option => option.value === (command.response as { value: string }).value)) throw new Error("无效的 DSH 审批选项");
          pending.request.respond({ outcome: { outcome: "selected", optionId: command.response.value } });
          clearTimeout(pending.timer);
          this.#approvals.delete(command.requestId);
          this.#emit(session, { type: "interaction.resolved", requestId: command.requestId, source: "remote" });
        }
        break;
      }
      case "slash.execute": {
        if (command.name === "quit") {
          session.closing = true;
          session.cancelRequested = true;
          this.#cancelSessionApprovals(session, "owner_closed");
          try { await this.#client.request("session/close", { sessionId: session.id }, 60_000); }
          catch (error) { session.closing = false; throw error; }
          const metadata = this.#metadata(session);
          this.#sessions.delete(publicId(session.id));
          this.onOffline?.("DSH 会话已关闭", [metadata]);
        } else {
          const configId = command.name === "model" ? "model" : command.name === "thinking" ? "reasoning_effort" : undefined;
          const option = session.options.find(item => item.id === configId);
          const choice = option && optionChoices(option.options).find(item => wireOption(item.value) === command.args.trim());
          if (!configId || !choice) throw new Error("不支持的 DSH 命令或选项");
          const result = record(await this.#client.request("session/set_config_option", { sessionId: session.id, configId, value: choice.value }));
          session.options = objects(result.configOptions);
          this.#publishMetadata(session);
          this.#emit(session, { type: "runtime.capabilities", capabilities: this.#capabilities(session) });
        }
        break;
      }
      default: throw new Error("不支持的 DSH 命令");
    }
    this.#emit(session, { type: "command.result", commandId, ok: true, status: "success" });
  }

  async #prompt(session: Session, commandId: string, command: Extract<RuntimeCommand, { type: "user_message" }>): Promise<void> {
    const fingerprint = createHash("sha256").update(JSON.stringify([command.text, command.attachments ?? [], command.delivery])).digest("hex");
    const previous = command.messageId ? session.messages.get(command.messageId) : undefined;
    if (previous) {
      const conflict = previous.fingerprint !== fingerprint;
      this.#emit(session, { type: "command.result", commandId, ok: !conflict && previous.status !== "failure",
        status: conflict ? "message_id_conflict" : previous.status, ...(previous.error ? { error: previous.error } : {}) });
      return;
    }
    if (session.running || command.delivery !== undefined) throw new Error("DSH ACP 不支持插话或排队；请等本轮结束后发送");
    session.running = true;
    session.cancelRequested = false;
    const receipt: { fingerprint: string; status: "pending" | "success" | "failure" | "cancelled"; error?: string } = { fingerprint, status: "pending" };
    if (command.messageId) session.messages.set(command.messageId, receipt);
    const turnId = randomUUID();
    const startedAt = Date.now();
    let priorIds = new Set(session.entries.map(entry => entry.entryId));
    let priorSeq = session.lastSeq;
    let stopReason: unknown;
    let submitted = false;
    const persistedMessages: { messageId: string; entryId: string }[] = [];
    session.streamed.clear();
    session.tools.clear();
    this.#publishMetadata(session);
    this.#emit(session, { type: "turn.started", turnId, startedAt });
    this.#emit(session, { type: "command.result", commandId, ok: true, status: "pending" });
    let failure: unknown;
    try {
      await this.#refresh(session);
      priorIds = new Set(session.entries.map(entry => entry.entryId));
      priorSeq = session.lastSeq;
      if (session.cancelRequested || session.closing || !this.#ready) stopReason = "cancelled";
      else {
        const text = command.text + (command.attachments?.length ? `\n\n附件路径：\n${command.attachments.join("\n")}` : "");
        submitted = true;
        stopReason = record(await this.#client.request("session/prompt", { sessionId: session.id, prompt: [{ type: "text", text }] }, 0)).stopReason;
      }
    } catch (error) { failure = error; }
    try {
      await session.updates;
      // ACP quiescence can precede the persistence plugin's 200 ms batch flush.
      // Wait for the durable turn end, never fabricate canonical entries from wire chunks.
      const settledAt = Date.now();
      const deadline = settledAt + 5_000;
      while (true) {
        const log = await this.#refresh(session);
        if (!submitted || log.events.some(event => event.seq > priorSeq && event.type === "turn/end")) break;
        // Cancellation during admission need not create a turn; allow a batch
        // flush before accepting that no durable turn was created.
        if ((failure || stopReason === "cancelled") && Date.now() - settledAt >= 500) break;
        if (Date.now() >= deadline) throw new Error("DSH 回合已结束，但历史尚未落盘；请重新同步会话");
        await delay(50);
      }
      const fresh = session.entries.filter(entry => !priorIds.has(entry.entryId));
      persistedMessages.push(...fresh.map(entry => ({ messageId: String(record(entry.data.message).messageId), entryId: entry.entryId })));
      const user = fresh.find(entry => record(entry.data.message).role === "user");
      if (user && command.messageId) persistedMessages.push({ messageId: command.messageId, entryId: user.entryId });
      for (const entry of fresh) this.#emit(session, { type: "message.finished", message: entry.data.message as ChatMessage });
    } catch (error) { failure ??= error; }
    finally {
      this.#emit(session, { type: "turn.finished", turnId, startedAt, durationMs: Date.now() - startedAt, persistedMessages });
      session.running = false;
      session.streamed.clear();
      session.tools.clear();
      this.#cancelSessionApprovals(session, "owner_closed");
      this.#publishMetadata(session);
    }
    receipt.status = failure ? "failure" : stopReason === "cancelled" ? "cancelled" : "success";
    if (failure) receipt.error = errorText(failure);
    this.#emit(session, { type: "command.result", commandId, ok: !failure, status: receipt.status, ...(receipt.error ? { error: receipt.error } : {}) });
  }

  #notification(method: string, params: JsonObject): void {
    if (method !== "session/update" || typeof params.sessionId !== "string") return;
    const session = this.#sessions.get(publicId(params.sessionId));
    if (!session) return;
    const update = record(params.update);
    session.updates = session.updates.then(() => {
      const type = update.sessionUpdate;
      if (type === "agent_message_chunk" || type === "agent_thought_chunk") {
        const content = record(update.content);
        if (typeof update.messageId !== "string" || content.type !== "text" || typeof content.text !== "string") return;
        let message = session.streamed.get(update.messageId);
        if (!message) {
          message = { messageId: update.messageId, role: "assistant", content: [], timestamp: 0 };
          session.streamed.set(update.messageId, message);
          this.#emit(session, { type: "message.started", message: { ...message, content: [] } });
        }
        const contentType = type === "agent_thought_chunk" ? "thinking" : "text";
        const index = message.content.length;
        message.content.push({ type: contentType, text: content.text });
        this.#emit(session, { type: "message.delta", messageId: message.messageId, contentType, contentIndex: index, delta: content.text });
      } else if (type === "tool_call" && typeof update.toolCallId === "string") {
        const name = typeof update.title === "string" ? update.title : "tool";
        session.tools.set(update.toolCallId, { name, input: update.rawInput ?? {} });
        this.#emit(session, { type: "tool.started", toolCallId: update.toolCallId, toolName: name, arguments: update.rawInput ?? {} });
      } else if (type === "tool_call_update" && typeof update.toolCallId === "string") {
        const toolName = session.tools.get(update.toolCallId)?.name ?? "tool";
        if (update.status === "completed" || update.status === "failed") this.#emit(session, {
          type: "tool.finished", toolCallId: update.toolCallId, toolName, result: update.content ?? update.rawOutput ?? null, isError: update.status === "failed",
        });
        else this.#emit(session, { type: "tool.updated", toolCallId: update.toolCallId, toolName, partialResult: update.content ?? null });
      } else if (type === "config_option_update") {
        session.options = objects(update.configOptions);
        this.#emit(session, { type: "runtime.capabilities", capabilities: this.#capabilities(session) });
        this.#publishMetadata(session);
      } else if (type === "usage_update" && typeof update.size === "number" && update.size > 0 && typeof update.used === "number" && update.used >= 0) {
        session.usage = { tokens: Math.floor(update.used), contextWindow: Math.floor(update.size), percent: Math.min(100, update.used / update.size * 100) };
        this.#publishMetadata(session);
      }
    }).catch(error => this.#emit(session, { type: "runtime.error", message: errorText(error), recoverable: true }));
  }

  #permission(request: DshRequest): void {
    if (request.method !== "session/request_permission") { request.reject("Unsupported client method"); return; }
    const session = typeof request.params.sessionId === "string" ? this.#sessions.get(publicId(request.params.sessionId)) : undefined;
    const options = objects(request.params.options).filter(item => typeof item.optionId === "string" && typeof item.name === "string");
    if (!session || session.closing || session.cancelRequested || !options.length || this.#approvals.size >= 64) { request.respond({ outcome: { outcome: "cancelled" } }); return; }
    const requestId = randomUUID();
    const call = record(request.params.toolCall);
    const tool = session.tools.get(String(call.toolCallId));
    const title = typeof call.title === "string" ? call.title : tool?.name ?? "DSH 请求执行工具";
    const input = call.rawInput ?? tool?.input;
    const details = input === undefined ? "" : JSON.stringify(input, null, 2);
    const interaction: InteractionRequest = {
      kind: "select", runtimeId: publicId(session.id), requestId, extensionId: "dsh", title: "DeepSeek 工具执行审批",
      description: details ? `${title}\n${details.length > 4000 ? `${details.slice(0, 4000)}\n…（参数已截断，请在工具记录中查看完整内容）` : details}` : title,
      expiresAt: Date.now() + 300_000,
      options: options.map(item => ({ value: String(item.optionId), label: String(item.name) })),
    };
    const timer = setTimeout(() => this.#cancelApproval(requestId, "timeout"), 300_000);
    timer.unref();
    this.#approvals.set(requestId, { session, request, interaction, timer });
    this.#emit(session, { type: "interaction.requested", request: interaction });
  }

  #cancelApproval(id: string, reason: "cancelled" | "timeout" | "disconnected" | "owner_closed"): void {
    const pending = this.#approvals.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#approvals.delete(id);
    pending.request.respond({ outcome: { outcome: "cancelled" } });
    this.#emit(pending.session, { type: "interaction.cancelled", requestId: id, reason });
  }
  #cancelSessionApprovals(session: Session, reason: "cancelled" | "owner_closed"): void {
    for (const [id, pending] of this.#approvals) if (pending.session === session) this.#cancelApproval(id, reason);
  }
  async #refresh(session: Session) {
    const log = await this.#history.read(session.id);
    // Concurrent history requests must not move the announced leaf backwards.
    if ((log.events.at(-1)?.seq ?? -1) >= session.lastSeq) {
      session.entries = dshEntries(log);
      session.lastSeq = log.events.at(-1)?.seq ?? -1;
    }
    return log;
  }
  #emit(session: Session, event: RuntimeEvent): void { this.#sink(event, publicId(session.id)); }
  #publishMetadata(session: Session): void {
    if (!this.#sessions.has(publicId(session.id))) return;
    const metadata = this.#metadata(session);
    this.#emit(session, { type: "runtime.status", status: metadata.status });
    this.#emit(session, { type: "runtime.metadata", metadata });
    this.onMetadataChange?.();
  }
  #metadata(session: Session): RuntimeMetadata {
    const model = session.options.find(option => option.id === "model");
    const thinking = session.options.find(option => option.id === "reasoning_effort");
    return {
      runtimeId: publicId(session.id), sessionId: publicId(session.id), name: "DeepSeek Harness", cwd: session.cwd,
      hostname: localHostname(), status: session.running ? "running" : "idle", sessionGraphSync: true,
      sessionLeafId: session.entries.at(-1)?.entryId ?? null,
      ...(typeof model?.currentValue === "string" ? { model: { provider: "dsh", id: model.currentValue,
        name: optionChoices(model.options).find(choice => choice.value === model.currentValue)?.label ?? model.currentValue } } : {}),
      ...(typeof thinking?.currentValue === "string" ? { thinkingLevel: thinking.currentValue || "default" } : {}),
      ...(session.usage === undefined ? {} : { contextUsage: session.usage }),
    };
  }
  #capabilities(session: Session): RuntimeCapabilities {
    return { commands: [
      ...session.options.filter(option => ["model", "reasoning_effort"].includes(String(option.id)) && optionChoices(option.options).length > 0).map(option => ({
        name: option.id === "model" ? "model" : "thinking", description: String(option.name ?? option.id), source: "builtin" as const,
        argument: { kind: "select" as const, required: true, options: optionChoices(option.options).map(choice => ({ ...choice, value: wireOption(choice.value) })) },
      })),
      { name: "quit", description: "关闭这个 DeepSeek Harness 会话（保留历史）", source: "builtin" },
    ] };
  }
  stop(): Promise<void> {
    return this.#stopping ??= (async () => {
      this.#ready = false;
      await this.#activation;
      for (const id of this.#approvals.keys()) this.#cancelApproval(id, "owner_closed");
      // session/close explicitly drains persistence and child agents before stdin EOF.
      await Promise.allSettled([...this.#sessions.values()].map(async session => {
        session.closing = true;
        session.cancelRequested = true;
        await this.#client.request("session/close", { sessionId: session.id }, 60_000);
      }));
      try { await this.#client.stop(); } finally { await this.#history.close(); }
    })();
  }
}
