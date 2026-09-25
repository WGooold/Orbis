/** AgentBackend adapter for an already-running DeepSeek Harness Web session. */
import { createHash, randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  selectSessionSyncSnapshot,
  type AgentSessionSummary, type ChatMessage, type InteractionRequest, type RemoteSessionEntry,
  type RuntimeCapabilities, type RuntimeCommand, type RuntimeEvent, type RuntimeMetadata,
} from "@pi-remote/protocol";
import type { AgentActivateTarget, AgentBackend, BackendActivation, CommandDispatch } from "./agent-backend.js";
import { DshWebClient, type DshWebConnection, type DshWebEvent } from "./dsh-web-client.js";
import { dshErrorText, dshWebEntries, dshWebEntryId, dshWebMessage, type DshStreamDecoder, type DshWebLogEvent } from "./dsh-web-history.js";
import { localHostname } from "./sessions.js";
import { ActivationError } from "./spawner.js";

type Obj = Record<string, unknown>;
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

type Approval = { id: string; session: WebSession; interaction: InteractionRequest; timer: NodeJS.Timeout };
type WebSession = {
  id: string; cwd: string; createdAt: number; title?: string; entries: RemoteSessionEntry[]; skills: { name: string; description: string }[];
  running: boolean; closing: boolean; options: Obj[]; modelCatalog?: Obj; model?: RuntimeMetadata["model"]; thinkingLevel?: string; usage?: RuntimeMetadata["contextUsage"];
  lastSeq: number; turnId?: string; turnStartedAt?: number;
  queue: Map<string, { itemId: string; text: string; delivery: "steer" | "followUp" }>;
  messages: Map<string, { fingerprint: string; status: "pending" | "success" | "failure" | "cancelled"; entryId?: string }>;
  persistedMappings: Map<string, string>;
  unsubscribe: () => void; streamMessages: Map<string, ChatMessage>; tools: Map<string, string>;
};

/**
 * This adapter never starts or stops dsh. `stop()` only closes its own Web
 * transport, leaving the user's browser and Web process untouched.
 */
export class DshWebRuntime implements AgentBackend {
  readonly kind = "dsh" as const;
  readonly #client: DshWebConnection;
  readonly #decoder: DshStreamDecoder | undefined;
  readonly #sessions = new Map<string, WebSession>();
  readonly #activating = new Map<string, Promise<BackendActivation>>();
  readonly #approvals = new Map<string, Approval>();
  #ready = true;
  #stopping: Promise<void> | undefined;
  #sink: (event: RuntimeEvent, runtimeId: string) => void = () => {};
  onMetadataChange: (() => void) | undefined;
  onOffline: ((reason: string, runtimes: RuntimeMetadata[]) => void) | undefined;

  constructor(client: DshWebConnection, decoder?: DshStreamDecoder) {
    this.#client = client;
    this.#decoder = decoder;
    client.onEvent = event => this.#event(event);
    client.onReconnect = () => { void this.#resyncAll().catch(error => this.#report(textOf(error))); };
    client.onExit = reason => {
      if (!this.#ready) return;
      this.#ready = false;
      for (const id of this.#approvals.keys()) this.#cancelApproval(id, "disconnected");
      const runtimes = this.directoryEntries();
      this.onOffline?.(reason, runtimes);
    };
  }

  static async create(options: Parameters<typeof DshWebClient.connect>[0] = {}, decoder?: DshStreamDecoder): Promise<DshWebRuntime> {
    return new DshWebRuntime(await DshWebClient.connect(options), decoder);
  }
  setEventSink(sink: (event: RuntimeEvent, runtimeId: string) => void): void { this.#sink = sink; }
  announce(): void {
    for (const session of this.#sessions.values()) {
      this.#publishMetadata(session);
      this.#emit(session, { type: "runtime.capabilities", capabilities: this.#capabilities(session) });
      this.#emit(session, { type: "interaction.snapshot", requests: [...this.#approvals.values()].filter(item => item.session === session).map(item => item.interaction) });
    }
  }
  isReady(): boolean { return this.#ready; }
  ownsRuntime(runtimeId: string): boolean { return this.#sessions.has(runtimeId); }
  directoryEntries(): RuntimeMetadata[] { return [...this.#sessions.values()].map(session => this.#metadata(session)); }
  currentProvider(): Promise<string | undefined> { return Promise.resolve("deepseek-web"); }
  assertProviderSwitchReady(): void {
    if ([...this.#sessions.values()].some(session => session.running || session.closing) || this.#approvals.size > 0) throw new Error("DeepSeek Web 正在工作或等待审批，请结束任务后切换供应商");
  }

  async catalog(archived = false): Promise<AgentSessionSummary[]> {
    if (archived) return [];
    const result = await this.#client.request<Obj>("session/list", { _request: {} });
    const items = Array.isArray(result.items) ? result.items : Array.isArray(result.sessions) ? result.sessions : [];
    return items.flatMap(raw => {
      const item = object(raw); const id = typeof item.sessionId === "string" ? item.sessionId : typeof item.id === "string" ? item.id : undefined;
      const cwd = typeof item.cwd === "string" ? item.cwd : undefined;
      if (!id || !cwd) return [];
      const local = this.#sessions.get(publicId(id));
      return [{ sessionId: publicId(id), agentKind: "dsh" as const, hostname: localHostname(), cwd,
        createdAt: local?.createdAt ?? Number(item.createdAt ?? item.updatedAt ?? Date.now()), modifiedAt: Number(item.updatedAt ?? item.createdAt ?? Date.now()),
        messageCount: local?.entries.length ?? 0, ...(typeof item.title === "string" ? { name: item.title.slice(0, 256) } : {}) }];
    });
  }

  async setArchived(sessionId: string, archived: boolean): Promise<void> {
    if (!sessionId.startsWith("dsh:")) throw new Error("不属于 DeepSeek Harness 的会话");
    await this.#client.request(archived ? "workspace/archiveSession" : "workspace/unarchiveSession", { request: { sessionId: sessionId.slice(4) } });
  }

  activate(target: AgentActivateTarget): Promise<BackendActivation> {
    if (!this.#ready) return Promise.reject(new ActivationError("agent_unsupported", "DeepSeek Web 未连接"));
    if (target.type === "resume") {
      if (!target.sessionId.startsWith("dsh:")) return Promise.reject(new ActivationError("session_not_found", "不属于 DeepSeek Harness 的会话"));
      const current = this.#sessions.get(target.sessionId);
      if (current && !current.closing) return Promise.resolve({ sessionId: target.sessionId, spawnMode: "headless" });
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
    let id: string; let cwd: string; let createdAt = Date.now();
    if (target.type === "new") {
      cwd = target.cwd;
      if (!isAbsolute(cwd) || !(await stat(cwd).then(info => info.isDirectory(), () => false))) throw new ActivationError("cwd_missing", "请选择存在的绝对目录");
      const created = object(await this.#client.request("session/create", { request: { cwd } }));
      id = typeof created.sessionId === "string" ? created.sessionId : "";
      if (!id) throw new Error("DeepSeek Web 没有返回会话 ID");
    } else {
      id = target.sessionId.slice(4);
      const item = (await this.catalog()).find(value => value.sessionId === target.sessionId);
      if (!item) throw new ActivationError("session_not_found", "找不到这个 DeepSeek Web 会话");
      cwd = item.cwd; createdAt = item.createdAt;
      await this.#client.request("session/create", { request: { sessionId: id } });
    }
    const runtimeId = publicId(id);
    const previous = this.#sessions.get(runtimeId); if (previous) previous.unsubscribe();
    const session: WebSession = { id, cwd, createdAt, entries: [], skills: [], running: false, closing: false, options: [], lastSeq: -1,
      queue: new Map(), messages: new Map(), persistedMappings: new Map(), streamMessages: new Map(), tools: new Map(), unsubscribe: () => {} };
    // Ask for a generous opening tail. The Web protocol has no resume cursor;
    // reconnects therefore replay this bounded page before live events continue.
    session.unsubscribe = this.#client.subscribe("session/follow", { request: { address: { kind: "session", sessionId: id }, maxMessages: 2_000, assistantStream: true } }, frame => this.#follow(session, frame), error => this.#report(textOf(error), runtimeId));
    this.#sessions.set(runtimeId, session);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    this.#publishMetadata(session);
    this.#emit(session, { type: "runtime.capabilities", capabilities: this.#capabilities(session) });
    void this.#loadSkills(session);
    void this.#loadModelCatalog(session);
    return { sessionId: runtimeId, spawnMode: "headless" };
  }

  dispatchCommand(runtimeId: string, commandId: string, command: RuntimeCommand): CommandDispatch {
    const session = this.#sessions.get(runtimeId); if (!this.#ready || !session) return "offline";
    if (!["user_message", "user_message.cancel", "stop", "session.sync", "slash.execute", "interaction.respond"].includes(command.type)) return "unsupported";
    void this.#command(session, commandId, command).catch(error => this.#emit(session, { type: "command.result", commandId, ok: false, status: "failure", error: dshErrorText(error) }));
    return "handled";
  }
  async #command(session: WebSession, commandId: string, command: RuntimeCommand): Promise<void> {
    if (session.closing) throw new Error("DSH Web 会话正在关闭");
    switch (command.type) {
      case "session.sync": {
        if (command.sessionId !== publicId(session.id)) throw new Error("session_mismatch");
        await this.#refreshPage(session, command.maxEntries,
          command.range === "history" ? webEntrySeqOrUndefined(command.beforeEntryId) : undefined);
        this.#emit(session, selectSessionSyncSnapshot(session.entries, command.sessionId, session.entries.at(-1)?.entryId ?? null, command));
        this.#emit(session, { type: "runtime.capabilities", capabilities: this.#capabilities(session) });
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
      case "slash.execute": await this.#slash(session, command.args, command.name, commandId); break;
      default: throw new Error("不支持的 DSH Web 命令");
    }
    this.#emit(session, { type: "command.result", commandId, ok: true, status: "success" });
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

  async #slash(session: WebSession, args: string, name: string, commandId: string): Promise<void> {
    if (name === "quit") { await this.#client.request("workspace/archiveSession", { request: { sessionId: session.id } }); session.closing = true; session.unsubscribe(); this.#sessions.delete(publicId(session.id)); this.onOffline?.("DeepSeek Web 会话已归档", [this.#metadata(session)]); return; }
    if (name === "name") { const title = args.trim(); if (!title) throw new Error("会话名称不能为空"); await this.#client.request("session/rename", { request: { sessionId: session.id, title } }); session.title = title; this.#publishMetadata(session); return; }
    if (name === "fork" || name === "clone") {
      const parsed = args.trim() === "" ? undefined : Number(args.trim());
      if (parsed !== undefined && !Number.isSafeInteger(parsed)) throw new Error("分支位置必须是有效事件序号");
      const result = object(await this.#client.request("session/fork", { request: { sessionId: session.id, ...(parsed === undefined ? {} : { atSeq: parsed }) } }));
      if (typeof result.sessionId === "string") this.#emit(session, { type: "runtime.error", message: `已创建分支 dsh:${result.sessionId}`, recoverable: true }); return;
    }
    if (name === "session") { this.#emit(session, { type: "session.snapshot", sessionId: publicId(session.id), syncId: commandId, cursor: { leafId: session.entries.at(-1)?.entryId ?? null }, mode: "replace", entries: session.entries, complete: true }); return; }
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
      await this.#client.request("session/selectModel", { request: { sessionId: session.id, provider: model.provider, model: model.model, ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}) } });
      session.model = this.#modelInfo(catalog, model.provider, model.model);
      if (model.reasoningEffort) session.thinkingLevel = model.reasoningEffort;
      this.#publishMetadata(session); this.#emit(session, { type: "runtime.capabilities", capabilities: this.#capabilities(session) }); return;
    }
    if (name === "thinking") {
      const selected = args.trim();
      if (!session.model) throw new Error("请先选择模型");
      let effort = selected;
      try { const parsed = JSON.parse(selected) as unknown; if (typeof parsed === "string") effort = parsed; } catch { /* Plain effort id. */ }
      const available = this.#thinkingChoices(session).some(choice => choice.value === effort);
      if (!available) throw new Error("找不到思考级别");
      await this.#client.request("session/selectModel", { request: { sessionId: session.id, provider: session.model.provider, model: session.model.id, reasoningEffort: effort } });
      session.thinkingLevel = effort; this.#publishMetadata(session); return;
    }
    throw new Error(`不支持的 DSH Web 命令：/${name}`);
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
    const pending = this.#approvals.get(command.requestId); if (!pending || pending.session !== session || command.extensionId !== "dsh") throw new Error("审批已结束或不属于这个会话");
    clearTimeout(pending.timer); this.#approvals.delete(command.requestId);
    if (command.response.kind === "cancel") await this.#client.respondEvent(pending.id, { kind: "rejected", error: { name: "AbortError", message: "cancelled" } });
    else await this.#client.respondEvent(pending.id, { kind: "result", value: command.response.kind === "select" ? command.response.value : command.response });
    this.#emit(session, { type: "interaction.resolved", requestId: command.requestId, source: "remote" });
  }

  #event(event: DshWebEvent): void {
    if (event.type === "cancel") { this.#cancelApproval(event.eventId, "cancelled"); return; }
    if (event.type !== "waterfall") return;
    if (event.event !== "approval/request" && event.event !== "permission/request") { void this.#client.respondEvent(event.eventId, { kind: "next" }).catch(() => {}); return; }
    const agentId = event.agentId.replace(/^dsh:/, "");
    const session = this.#sessions.get(publicId(agentId)); if (!session || session.closing) { void this.#client.respondEvent(event.eventId, { kind: "next" }).catch(() => {}); return; }
    const request = object(event.request); const rawOptions = Array.isArray(request.options) ? request.options : Array.isArray(request.choices) ? request.choices : [];
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
    const interaction: InteractionRequest = { kind: "select", runtimeId: publicId(session.id), requestId, extensionId: "dsh", title: String(request.title ?? request.toolName ?? "DeepSeek 工具执行审批"), description: String(request.description ?? request.reason ?? "请确认 DeepSeek Harness 是否执行此操作"), expiresAt: Date.now() + 300_000, options: options.length ? options : [{ value: "allow", label: "允许" }, { value: "reject", label: "拒绝" }] };
    // The Gateway replays still-pending waterfall requests after a carrier
    // reconnect. Keep the original UI request and timer instead of emitting a
    // duplicate prompt; the client's event generation has already been updated.
    if (this.#approvals.has(requestId)) return;
    const timer = setTimeout(() => this.#cancelApproval(requestId, "timeout"), 300_000); timer.unref();
    this.#approvals.set(requestId, { id: event.eventId, session, interaction, timer }); this.#emit(session, { type: "interaction.requested", request: interaction });
  }
  #cancelApproval(id: string, reason: "cancelled" | "timeout" | "disconnected" | "owner_closed"): void { const pending = this.#approvals.get(id); if (!pending) return; clearTimeout(pending.timer); this.#approvals.delete(id); void this.#client.respondEvent(pending.id, { kind: "rejected", error: { name: "AbortError", message: reason } }).catch(() => {}); this.#emit(pending.session, { type: "interaction.cancelled", requestId: id, reason }); }
  #cancelSessionApprovals(session: WebSession, reason: "cancelled" | "owner_closed"): void { for (const [id, item] of this.#approvals) if (item.session === session) this.#cancelApproval(id, reason); }

  #follow(session: WebSession, value: unknown): void {
    const frame = object(value);
    if (frame.type === "snapshot") {
      const header = object(frame.header); const events = arrayObjects(frame.records).map(record => { const event = object(record.event); return { seq: Number(event.seq), time: Number(event.time), type: String(event.type), data: event.data }; });
      this.#rememberTools(session, events);
      const snapshotEntries = dshWebEntries(session.id, events);
      // `session/follow` always opens with a bounded tail page. On a WebSocket
      // reconnect the same session object already owns its older prefix; replacing
      // it with that tail would make a transient carrier disconnect erase history
      // from the phone. Durable Session events are append-only, so merge by the
      // stable Web entry id and retain the existing order.
      if (session.entries.length === 0) session.entries = snapshotEntries;
      else {
        const entries = new Map(session.entries.map(entry => [entry.entryId, entry]));
        for (const entry of snapshotEntries) if (!entries.has(entry.entryId)) entries.set(entry.entryId, entry);
        session.entries = [...entries.values()].sort((left, right) => webEntrySeq(left.entryId) - webEntrySeq(right.entryId));
      }
      session.lastSeq = Math.max(session.lastSeq, Number(frame.cursor ?? -1)); session.createdAt = Number(header.createdAt ?? session.createdAt); session.cwd = typeof header.cwd === "string" ? header.cwd : session.cwd;
      this.#syncSnapshotTurnState(session, events);
      this.#publishMetadata(session); return;
    }
    if (frame.type === "event") { const event = object(frame.event); this.#applyEvent(session, { seq: Number(event.seq), time: Number(event.time), type: String(event.type), data: event.data }); return; }
    if (frame.type === "assistant-stream") this.#assistantFrame(session, object(frame.frame));
  }
  async #refreshPage(session: WebSession, maxMessages = 2_000, beforeSeq?: number): Promise<void> {
    // Empty Sessions have a valid `-1` cursor. Sending 0 makes the Web
    // controller reject the page because it is past that Session's log.
    const throughSeq = session.lastSeq < 0 ? -1 : session.lastSeq;
    const result = object(await this.#client.request("session/page", { request: {
      address: { kind: "session", sessionId: session.id },
      throughSeq, ...(beforeSeq === undefined ? {} : { beforeSeq }),
      maxMessages: Math.min(2_000, Math.max(1, maxMessages)),
    } }));
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
  #applyEvent(session: WebSession, event: { seq: number; time: number; type: string; data: unknown }): void {
    if (!Number.isSafeInteger(event.seq) || event.seq <= session.lastSeq) return; session.lastSeq = event.seq;
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
    const entry = dshWebEntries(session.id, [event])[0]; if (entry) session.entries.push({ ...entry, parentId: session.entries.at(-1)?.entryId ?? null });
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
      session.persistedMappings.clear();
      delete session.turnId;
      delete session.turnStartedAt;
      this.#emit(session, { type: "turn.finished", turnId, startedAt, durationMs: Math.max(0, event.time - startedAt), ...(typeof data.turn === "number" ? { turnIndex: data.turn } : {}), ...(persistedMessages.length ? { persistedMessages } : {}) });
    }
    if (existing) this.#emit(session, { type: "message.finished", message: existing });
    this.#publishMetadata(session);
  }
  #assistantFrame(session: WebSession, frame: Obj): void {
    const attempt = String(frame.attemptId ?? "assistant");
    if (frame.type === "start") { const message: ChatMessage = { messageId: attempt, role: "assistant", content: [], timestamp: Number(frame.time ?? Date.now()) }; session.streamMessages.set(attempt, message); this.#emit(session, { type: "message.started", message }); return; }
    if (frame.type === "chunk") {
      let message = session.streamMessages.get(attempt);
      if (!message) {
        message = { messageId: attempt, role: "assistant", content: [], timestamp: Number(frame.time ?? Date.now()) };
        session.streamMessages.set(attempt, message);
        this.#emit(session, { type: "message.started", message });
      }
      let chunk = object(frame.chunk);
      if (chunk.type === "chunk" && chunk.chunk !== undefined) chunk = object(chunk.chunk);
      if (this.#decoder && (chunk.type === "text-chunks" || chunk.type === "reasoning-chunks" || chunk.type === "tool-call-chunks")) {
        chunk = object(this.#decoder([frame.chunk])[0]?.chunk);
      }
      const text = chunk.type === "text-delta" || chunk.type === "reasoning-delta"
        ? String(chunk.text ?? "") : chunk.type === "tool-call-delta" ? String(chunk.argumentsDelta ?? "") : "";
      if (!text) return;
      const contentType = frame.reasoning === true || chunk.type === "reasoning-delta" ? "thinking" : chunk.type === "tool-call-delta" ? "tool_call" : "text";
      const index = message.content.length;
      if (contentType === "thinking") message.content.push({ type: "thinking", text });
      else if (contentType === "tool_call") message.content.push({ type: "tool_call", toolCallId: String(chunk.id ?? attempt), toolName: String(chunk.name ?? "tool"), arguments: text });
      else message.content.push({ type: "text", text });
      this.#emit(session, { type: "message.delta", messageId: attempt, contentType, contentIndex: index, delta: text }); return;
    }
    if (frame.type === "end") { session.streamMessages.delete(attempt); }
  }

  async #resyncAll(): Promise<void> { for (const session of this.#sessions.values()) this.#emit(session, { type: "runtime.error", message: "DeepSeek Web 已重连，会话流正在恢复", recoverable: true }); }
  #metadata(session: WebSession): RuntimeMetadata { return { runtimeId: publicId(session.id), sessionId: publicId(session.id), name: session.title ?? "DeepSeek Harness Web", cwd: session.cwd, hostname: localHostname(), status: session.running ? "running" : "idle", sessionGraphSync: true, sessionLeafId: session.entries.at(-1)?.entryId ?? null, ...(session.model === undefined ? {} : { model: session.model }), ...(session.thinkingLevel === undefined ? {} : { thinkingLevel: session.thinkingLevel }), ...(session.usage === undefined ? {} : { contextUsage: session.usage }) }; }
  async #loadSkills(session: WebSession): Promise<void> {
    try {
      const value = object(await this.#client.request("skills/list", { request: { sessionId: session.id } }));
      session.skills = arrayObjects(value.skills).flatMap(skill => typeof skill.name === "string" && /^[^\s/]+$/u.test(skill.name)
        ? [{ name: skill.name, description: typeof skill.description === "string" ? skill.description : `DeepSeek skill /${skill.name}` }] : []);
      if (this.#sessions.has(publicId(session.id))) this.#emit(session, { type: "runtime.capabilities", capabilities: this.#capabilities(session) });
    } catch (error) { this.#report(`无法读取 DeepSeek Web skills：${textOf(error)}`, publicId(session.id)); }
  }
  async #loadModelCatalog(session: WebSession): Promise<void> {
    try {
      const catalog = object(await this.#client.request("session/modelCatalog", {}));
      session.modelCatalog = catalog;
      const current = object(catalog.default);
      if (typeof current.provider === "string" && typeof current.model === "string") {
        session.model = this.#modelInfo(catalog, current.provider, current.model);
        if (typeof current.reasoningEffort === "string") session.thinkingLevel = current.reasoningEffort;
      }
      if (this.#sessions.has(publicId(session.id))) { this.#publishMetadata(session); this.#emit(session, { type: "runtime.capabilities", capabilities: this.#capabilities(session) }); }
    } catch (error) { this.#report(`无法读取 DeepSeek Web 模型目录：${textOf(error)}`, publicId(session.id)); }
  }
  #modelInfo(catalog: Obj, provider: string, id: string): RuntimeMetadata["model"] | undefined {
    for (const group of arrayObjects(catalog.groups)) {
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
    const modelId = session.model?.id;
    if (!modelId) return [];
    for (const group of arrayObjects(session.modelCatalog?.groups)) {
      const model = arrayObjects(group.models).find(item => item.id === modelId || item.model === modelId);
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
      { name: "model", description: "DeepSeek Web /model", source: "builtin" as const, ...(modelChoices.length ? { argument: { kind: "select" as const, required: true, options: modelChoices } } : {}) },
      ...(thinkingChoices.length ? [{ name: "thinking", description: "DeepSeek Web /thinking", source: "builtin" as const, argument: { kind: "select" as const, required: true, options: thinkingChoices } }] : []),
      ...["name", "session", "fork", "clone", "skills", "quit"].map(name => ({ name, description: `DeepSeek Web /${name}`, source: "builtin" as const })),
    ];
    const skills = (session?.skills ?? []).map(skill => ({ name: skill.name, description: skill.description, source: "skill" as const }));
    return { commands: [...builtin, ...skills] };
  }
  #publishMetadata(session: WebSession): void { if (!this.#sessions.has(publicId(session.id))) return; const metadata = this.#metadata(session); this.#emit(session, { type: "runtime.status", status: metadata.status }); this.#emit(session, { type: "runtime.metadata", metadata }); this.onMetadataChange?.(); }
  #emit(session: WebSession, event: RuntimeEvent): void { this.#sink(event, publicId(session.id)); }
  #report(message: string, runtimeId?: string): void { if (runtimeId) { const session = this.#sessions.get(runtimeId); if (session) this.#emit(session, { type: "runtime.error", message, recoverable: true }); } }
  async stop(): Promise<void> { if (this.#stopping) return this.#stopping; this.#stopping = (async () => { this.#ready = false; for (const id of this.#approvals.keys()) this.#cancelApproval(id, "owner_closed"); for (const session of this.#sessions.values()) session.unsubscribe(); this.#sessions.clear(); await this.#client.stop(); })(); return this.#stopping; }
}
