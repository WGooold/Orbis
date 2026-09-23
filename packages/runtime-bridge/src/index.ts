import { randomUUID } from "node:crypto";
import {
  type InteractionResponse,
  type RuntimeCommand,
  type RuntimeCapabilities,
  type RuntimeEvent,
  type RuntimeMetadata,
  type SessionCatalogEntry,
  type RemoteSessionEntry,
  type SessionBranchCursor,
  type RuntimeCommandStatus,
  type RuntimeTurnTiming,
  type SessionSyncRange,
  type SessionSyncRangeStatus,
} from "@pi-remote/protocol";

export type RuntimeSessionSyncRequest = {
  sessionId: string;
  syncId: string;
  knownLeafId?: string | null;
  targetLeafId?: string | null;
  beforeEntryId?: string | null;
  maxEntries?: number;
  range?: SessionSyncRange;
};

export type RuntimeSessionSync = {
  sessionId: string;
  cursor: SessionBranchCursor;
  mode: "replace" | "append" | "prepend";
  entries: RemoteSessionEntry[];
  turnTimings?: RuntimeTurnTiming[];
  range?: SessionSyncRange;
  targetLeafId?: string | null;
  beforeEntryId?: string | null;
  hasOlder?: boolean;
  complete?: boolean;
  rangeStatus?: SessionSyncRangeStatus;
};

export type RuntimeSlashCommandCompletion = {
  commandId: string;
  ok: boolean;
  status: RuntimeCommandStatus;
  error?: string;
  result?: unknown;
};

export type QueuedMessageCancellation =
  | { ok: true }
  | { ok: false; error: string; status: "not_cancelable" | "already_delivered" };

export interface RuntimePort {
  metadata(): RuntimeMetadata;
  syncSession?(request: RuntimeSessionSyncRequest): RuntimeSessionSync | Promise<RuntimeSessionSync>;
  sessionCatalog?(): SessionCatalogEntry[] | Promise<SessionCatalogEntry[]>;
  isIdle(): boolean;
  sendUserMessage(
    text: string,
    delivery?: "steer" | "followUp",
    messageId?: string,
    attachments?: readonly string[],
  ): void | Promise<void>;
  cancelQueuedMessage?(messageId: string): QueuedMessageCancellation | Promise<QueuedMessageCancellation>;
  executeSlashCommand?(name: string, args: string): Promise<unknown>;
  recordSlashCommandCompletion?(completion: RuntimeSlashCommandCompletion): void;
  takeSlashCommandCompletions?(): RuntimeSlashCommandCompletion[];
  abort(): void;
  capabilities?(): RuntimeCapabilities | Promise<RuntimeCapabilities>;
}

export interface RuntimeBridgeTransport {
  start(
    metadata: RuntimeMetadata,
    handlers: {
      connected: () => void;
      disconnected?: () => void;
      resync: (reason: string) => void;
      command: (commandId: string, runtimeId: string, command: RuntimeCommand) => void;
      error?: (message: string, recoverable: boolean) => void;
    },
  ): Promise<void>;
  publish(event: RuntimeEvent): void;
  close(): void;
}

export interface RuntimeInteractionPort {
  respond(requestId: string, extensionId: string, response: InteractionResponse): boolean | Promise<boolean>;
  /** The transport disappeared; this is recoverable and must not end pending requests. */
  disconnected?(): void;
  /** The owning Pi bridge/session is ending; pending requests may be rejected. */
  closed?(): void;
  resync?(): void;
}

export type SessionStartReason = "startup" | "resume" | "new" | "fork" | "reload";

export type RuntimeBridgeDiagnosticFields = Record<string, string | number | boolean | undefined>;
export type RuntimeBridgeDiagnostic = (event: string, fields?: RuntimeBridgeDiagnosticFields) => void;

type QueuedMessageState = "submitting" | "accepted" | "delivered" | "rejected" | "not_cancelable";

type QueuedMessageResult = {
  ok: boolean;
  error?: string;
  status?: RuntimeCommandStatus;
};

function sameAttachments(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === undefined || a.length === 0) return b === undefined || b.length === 0;
  if (b === undefined) return false;
  return a.length === b.length && a.every((path, index) => path === b[index]);
}

type QueuedMessageRecord = {
  text: string;
  /** 只用于 messageId 重发时的冲突判定；拼进正文发生在发送那一刻。 */
  attachments: readonly string[] | undefined;
  delivery: "steer" | "followUp";
  state: QueuedMessageState;
  error?: string;
  completion?: Promise<QueuedMessageResult>;
};

type UserMessageCommandRecord = {
  fingerprint: string;
  completion: Promise<QueuedMessageResult>;
};

/**
 * Coordinates one already-running Pi process with one outbound Relay connection.
 * The bridge never starts a process and never interprets session tree semantics.
 */
export class RuntimeBridge {
  readonly #runtime: RuntimePort;
  readonly #transport: RuntimeBridgeTransport;
  readonly #interactions: RuntimeInteractionPort | undefined;
  readonly #diagnostic: RuntimeBridgeDiagnostic | undefined;
  #started = false;
  #transportReady = false;
  // 忙时的插入消息由扩展自己排队（队列接管，对齐 codex-runtime）。这份账本是终端侧
  // 投影：承载 messageId 幂等/冲突判定与 message.queued 状态发布，不是执行器；
  // delivered/rejected 由扩展出队时经 deliverQueued/failQueued 明确回执。
  readonly #queuedMessages = new Map<string, QueuedMessageRecord>();
  readonly #userMessageCommands = new Map<string, UserMessageCommandRecord>();

  constructor(
    runtime: RuntimePort,
    transport: RuntimeBridgeTransport,
    interactions?: RuntimeInteractionPort,
    diagnostic?: RuntimeBridgeDiagnostic,
  ) {
    this.#runtime = runtime;
    this.#transport = transport;
    this.#interactions = interactions;
    this.#diagnostic = diagnostic;
  }

  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    const metadata = this.#runtime.metadata();
    this.#diagnostic?.("bridge.starting", {
      runtimeId: metadata.runtimeId,
      sessionId: metadata.sessionId,
    });
    await this.#transport.start(metadata, {
      connected: () => {
        if (!this.#started) return;
        this.#transportReady = true;
        this.#diagnostic?.("bridge.transport.connected", { runtimeId: metadata.runtimeId });
        this.#publishCompletedSlashCommands();
        this.#publishQueuedMessages();
        void this.#publishCapabilities();
        void this.#publishSessionCatalog();
        this.#interactions?.resync?.();
      },
      disconnected: () => {
        this.#transportReady = false;
        this.#diagnostic?.("bridge.transport.disconnected", { runtimeId: metadata.runtimeId });
      },
      resync: (reason) => {
        this.#diagnostic?.("bridge.transport.resync", { runtimeId: metadata.runtimeId, reason });
        this.#publishQueuedMessages();
        void this.#publishCapabilities();
        void this.#publishSessionCatalog();
        this.#interactions?.resync?.();
      },
      command: (commandId, runtimeId, command) => {
        this.#diagnostic?.("bridge.command.received", {
          commandId,
          runtimeId,
          commandType: command.type,
          ...(command.type === "slash.execute" ? { name: command.name, argsLength: command.args.length } : {}),
        });
        void this.#handleCommand(commandId, runtimeId, command);
      },
      error: (message, recoverable) => {
        this.#diagnostic?.("bridge.transport.error", { message, recoverable });
        this.publish({ type: "runtime.error", message, recoverable });
      },
    });
  }

  sessionStarted(reason?: SessionStartReason): void {
    this.#diagnostic?.("bridge.session.started", { reason });
    void this.#publishCapabilities();
    void this.#publishSessionCatalog();
  }

  /**
   * 队列接管模式下的确定性回执：忙时的插入消息由扩展自己持有（不入 Pi 的 deliverAs
   * 队列），扩展在亲手把它送进 Pi（空闲路径 sendUserMessage）的那一刻调用本方法。
   * 队列所有者 = 消费者 = 回执发出者是同一个主体（对齐 codex-runtime 的 #drainQueue），
   * 不再需要从 Pi 的事件流里按文本反推哪条记录被消费了。
   */
  deliverQueued(queueId: string): void {
    const queued = this.#queuedMessages.get(queueId);
    if (!queued || (queued.state !== "submitting" && queued.state !== "accepted")) return;
    queued.state = "delivered";
    this.#diagnostic?.("bridge.queued.delivered", { queueId });
    this.#publishQueuedMessage(queueId, queued);
  }

  /** 出队投递失败：消息没能进 Pi。明确回 rejected，手机端那行有终点。 */
  failQueued(queueId: string, error: string): void {
    const queued = this.#queuedMessages.get(queueId);
    if (!queued || (queued.state !== "submitting" && queued.state !== "accepted")) return;
    queued.state = "rejected";
    queued.error = error;
    this.#diagnostic?.("bridge.queued.failed", { queueId, error });
    this.#publishQueuedMessage(queueId, queued);
  }

  publish(event: RuntimeEvent): void {
    this.#transport.publish(event);
  }

  setStatus(status: RuntimeMetadata["status"]): void {
    this.publish({ type: "runtime.status", status });
  }

  refreshMetadata(): void {
    try {
      this.publish({ type: "runtime.metadata", metadata: this.#runtime.metadata() });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to refresh runtime metadata";
      this.#diagnostic?.("bridge.metadata.failed", { message });
      this.publish({ type: "runtime.error", message, recoverable: true });
    }
  }

  async refreshCapabilities(): Promise<void> {
    if (!this.#started) return;
    await this.#publishCapabilities();
  }

  async refreshSessionCatalog(): Promise<void> {
    if (!this.#started) return;
    await this.#publishSessionCatalog();
  }

  flushCommandCompletions(): void {
    if (!this.#started || !this.#transportReady) return;
    this.#publishCompletedSlashCommands();
  }

  close(): void {
    if (!this.#started) return;
    this.#diagnostic?.("bridge.closed");
    this.#started = false;
    this.#transportReady = false;
    this.#interactions?.closed?.();
    this.#transport.close();
  }

  #publishQueuedMessages(): void {
    for (const [queueId, queued] of this.#queuedMessages) {
      if (queued.state === "submitting") continue;
      this.publish({
        type: "message.queued",
        queueId,
        text: queued.text,
        delivery: queued.delivery,
        state: queued.state,
        ...(queued.error === undefined ? {} : { error: queued.error }),
      });
    }
  }

  #publishQueuedMessage(queueId: string, queued: QueuedMessageRecord): void {
    if (queued.state === "submitting") return;
    this.publish({
      type: "message.queued",
      queueId,
      text: queued.text,
      delivery: queued.delivery,
      state: queued.state,
      ...(queued.error === undefined ? {} : { error: queued.error }),
    });
  }

  #publishCompletedSlashCommands(): void {
    for (const completion of this.#runtime.takeSlashCommandCompletions?.() ?? []) {
      this.#commandResult(
        completion.commandId,
        completion.ok,
        completion.error,
        completion.result,
        completion.status,
      );
    }
  }

  async #publishCapabilities(): Promise<void> {
    if (!this.#runtime.capabilities) return;
    try {
      this.publish({ type: "runtime.capabilities", capabilities: await this.#runtime.capabilities() });
    } catch (error) {
      this.publish({
        type: "runtime.error",
        message: error instanceof Error ? error.message : "Unable to publish runtime capabilities",
        recoverable: true,
      });
    }
  }

  async #publishSessionCatalog(): Promise<void> {
    if (!this.#runtime.sessionCatalog) return;
    try {
      this.publish({ type: "session.catalog", sessions: await this.#runtime.sessionCatalog() });
    } catch (error) {
      this.#diagnostic?.("bridge.session_catalog.failed", {
        message: error instanceof Error ? error.message : "session_catalog_failed",
      });
      this.publish({
        type: "runtime.error",
        message: error instanceof Error ? error.message : "session_catalog_failed",
        recoverable: true,
      });
    }
  }

  async #handleCommand(commandId: string, runtimeId: string, command: RuntimeCommand): Promise<void> {
    if (runtimeId !== this.#runtime.metadata().runtimeId) {
      this.#diagnostic?.("bridge.command.rejected", { commandId, runtimeId, commandType: command.type, reason: "runtime_mismatch" });
      this.#commandResult(commandId, false, "runtime_mismatch");
      return;
    }

    try {
      if (command.type === "session.sync") {
        this.#diagnostic?.("bridge.session_sync.request", {
          runtimeId,
          commandId,
          sessionId: command.sessionId,
          range: command.range,
          targetLeafId: command.targetLeafId ?? undefined,
          knownLeafId: command.knownLeafId ?? undefined,
          beforeEntryId: command.beforeEntryId ?? undefined,
          maxEntries: command.maxEntries,
        });
        if (!this.#runtime.syncSession) {
          this.publish({
            type: "runtime.error",
            commandId,
            message: "session_graph_sync_not_supported",
            recoverable: true,
          });
          return;
        }
        try {
          const sync = await this.#runtime.syncSession({
            sessionId: command.sessionId,
            syncId: command.syncId,
            ...(command.knownLeafId === undefined ? {} : { knownLeafId: command.knownLeafId }),
            ...(command.targetLeafId === undefined ? {} : { targetLeafId: command.targetLeafId }),
            ...(command.beforeEntryId === undefined ? {} : { beforeEntryId: command.beforeEntryId }),
            ...(command.maxEntries === undefined ? {} : { maxEntries: command.maxEntries }),
            ...(command.range === undefined ? {} : { range: command.range }),
          });
          if (sync.sessionId !== command.sessionId) {
            throw new Error(`Session sync returned ${sync.sessionId} for ${command.sessionId}`);
          }
          this.#diagnostic?.("bridge.session_sync.response", {
            runtimeId,
            commandId,
            sessionId: sync.sessionId,
            range: sync.range,
            targetLeafId: sync.targetLeafId ?? undefined,
            entryCount: sync.entries.length,
            complete: sync.complete,
            rangeStatus: sync.rangeStatus,
          });
          this.publish({
            type: "session.snapshot",
            sessionId: sync.sessionId,
            syncId: command.syncId,
            cursor: sync.cursor,
            mode: sync.mode,
            entries: sync.entries,
            ...(sync.turnTimings === undefined ? {} : { turnTimings: sync.turnTimings }),
            ...(sync.range === undefined ? {} : { range: sync.range }),
            ...(sync.targetLeafId === undefined ? {} : { targetLeafId: sync.targetLeafId }),
            ...(sync.beforeEntryId === undefined ? {} : { beforeEntryId: sync.beforeEntryId }),
            ...(sync.hasOlder === undefined ? {} : { hasOlder: sync.hasOlder }),
            ...(sync.complete === undefined ? {} : { complete: sync.complete }),
            ...(sync.rangeStatus === undefined ? {} : { rangeStatus: sync.rangeStatus }),
          });
        } catch (error) {
          this.publish({
            type: "runtime.error",
            commandId,
            message: error instanceof Error ? error.message : "session_graph_sync_failed",
            recoverable: true,
          });
        }
        return;
      }
      if (command.type === "artifact.cancel") {
        // runtime 手里已经没有任何传输可取消：下载由 Host 独家服务（见下），推送已删。
        this.#commandResult(commandId, false, "download_served_by_host", undefined, "failure");
        return;
      }
      if (command.type === "file.download" || command.type === "artifact.download") {
        // 下载由 Host 独家服务（spec §9.4）：文件在电脑磁盘上、Host 常驻，读盘发分片不需要
        // 任何 Pi 进程参与。命令若被投到某个 runtime，说明寻址错了（应发 hostId）——如实拒绝，
        // 不要把「问错对象」误报成「进程不在线」。
        this.#commandResult(commandId, false, "download_served_by_host", undefined, "failure");
        return;
      }
      if (command.type === "slash.execute") {
        if (!this.#runtime.executeSlashCommand) {
          this.#diagnostic?.("slash.execute.rejected", { commandId, name: command.name, reason: "slash_commands_not_available" });
          this.#commandResult(commandId, false, "slash_commands_not_available");
          return;
        }
        try {
          this.#diagnostic?.("slash.execute.pending", {
            commandId,
            name: command.name,
            argsLength: command.args.length,
          });
          this.#commandResult(commandId, true, undefined, undefined, "pending");
          this.#diagnostic?.("slash.execute.started", { commandId, name: command.name });
          const result = await this.#runtime.executeSlashCommand(command.name, command.args);
          this.#diagnostic?.("slash.execute.handler_resolved", { commandId, name: command.name });
          await this.refreshCapabilities();
          const completion = {
            commandId,
            ok: true,
            status: "success" as const,
            result,
          };
          if (!this.#started) {
            this.#diagnostic?.("slash.execute.completion_buffered", { commandId, name: command.name, status: "success" });
            this.#runtime.recordSlashCommandCompletion?.(completion);
          } else {
            this.#diagnostic?.("slash.execute.completed", { commandId, name: command.name, status: "success" });
            this.#commandResult(commandId, true, undefined, result, "success");
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "slash_command_failed";
          const completion = {
            commandId,
            ok: false,
            status: message === "slash_command_cancelled" || message === "slash command cancelled"
              ? "cancelled" as const
              : "failure" as const,
            error: message,
          };
          if (!this.#started) {
            this.#diagnostic?.("slash.execute.completion_buffered", { commandId, name: command.name, status: completion.status, error: message });
            this.#runtime.recordSlashCommandCompletion?.(completion);
          } else {
            this.#diagnostic?.("slash.execute.failed", { commandId, name: command.name, status: completion.status, error: message });
            this.#commandResult(commandId, false, message, undefined, completion.status);
          }
        }
        return;
      }
      if (command.type === "user_message") {
        const fingerprint = JSON.stringify(command);
        const existingCommand = this.#userMessageCommands.get(commandId);
        if (existingCommand) {
          if (existingCommand.fingerprint !== fingerprint) {
            this.#commandResult(commandId, false, "message_id_conflict", undefined, "message_id_conflict");
            return;
          }
          const result = await existingCommand.completion;
          this.#commandResult(commandId, result.ok, result.error, undefined, result.status);
          return;
        }

        const completion = this.#handleUserMessage(command).catch((error): QueuedMessageResult => ({
          ok: false,
          error: error instanceof Error ? error.message : "message_rejected",
        }));
        this.#userMessageCommands.set(commandId, { fingerprint, completion });
        const result = await completion;
        this.#commandResult(commandId, result.ok, result.error, undefined, result.status);
        return;
      }
      if (command.type === "user_message.cancel") {
        const queued = this.#queuedMessages.get(command.messageId);
        if (!queued) {
          this.#commandResult(commandId, false, "already_delivered", undefined, "already_delivered" as RuntimeCommandStatus);
          return;
        }
        if (queued.state === "delivered") {
          this.#commandResult(commandId, false, "already_delivered", undefined, "already_delivered" as RuntimeCommandStatus);
          return;
        }
        const result = await this.#runtime.cancelQueuedMessage?.(command.messageId) ?? {
          ok: false as const,
          error: "not_cancelable",
          status: "not_cancelable" as const,
        };
        if (result.ok) {
          const current = this.#queuedMessages.get(command.messageId);
          if (!current || current.state === "delivered") {
            this.#commandResult(commandId, false, "already_delivered", undefined, "already_delivered");
            return;
          }
          this.#queuedMessages.delete(command.messageId);
          this.publish({ type: "message.queued", queueId: command.messageId, text: queued.text, delivery: queued.delivery, state: "cancelled" });
          this.#commandResult(commandId, true, undefined, undefined, "cancelled");
        } else if (result.status === "already_delivered") {
          queued.state = "delivered";
          this.publish({ type: "message.queued", queueId: command.messageId, text: queued.text, delivery: queued.delivery, state: "delivered", error: result.error });
          this.#commandResult(commandId, false, result.error, undefined, result.status);
        } else {
          queued.state = "not_cancelable";
          this.publish({ type: "message.queued", queueId: command.messageId, text: queued.text, delivery: queued.delivery, state: "not_cancelable", error: result.error });
          this.#commandResult(commandId, false, result.error, undefined, result.status);
        }
        return;
      }
      if (command.type === "stop") {
        this.#runtime.abort();
        this.#commandResult(commandId, true);
        return;
      }
      if (!this.#interactions) {
        this.#commandResult(commandId, false, "interaction_not_available");
        return;
      }
      const accepted = await this.#interactions.respond(
        command.requestId,
        command.extensionId,
        command.response,
      );
      this.#commandResult(commandId, accepted, accepted ? undefined : "interaction_not_available");
    } catch (error) {
      this.#commandResult(commandId, false, error instanceof Error ? error.message : "command_failed");
    }
  }

  async #handleUserMessage(
    command: Extract<RuntimeCommand, { type: "user_message" }>,
  ): Promise<QueuedMessageResult> {
    const existing = command.messageId === undefined
      ? undefined
      : this.#queuedMessages.get(command.messageId);
    if (existing) {
      if (existing.text !== command.text || existing.delivery !== command.delivery ||
        !sameAttachments(existing.attachments, command.attachments)) {
        return { ok: false, error: "message_id_conflict", status: "message_id_conflict" };
      }
      const result = existing.completion
        ? await existing.completion
        : existing.state === "rejected"
          ? { ok: false, error: existing.error ?? "message_rejected" }
          : { ok: true };
      this.#publishQueuedMessage(command.messageId!, existing);
      return result;
    }

    const isIdle = this.#runtime.isIdle();
    if (!isIdle && command.delivery === undefined) {
      return { ok: false, error: "runtime_busy" };
    }
    // A stale mobile status can race with turn completion. Delivery modes only
    // have queue semantics while Pi is actively running.
    const delivery = isIdle ? undefined : command.delivery;
    const outgoing = command.text;
    const attachments = command.attachments;
    const queueId = command.messageId ?? randomUUID();
    if (delivery === undefined) {
      try {
        if (command.messageId === undefined) await this.#runtime.sendUserMessage(outgoing, delivery, undefined, attachments);
        else await this.#runtime.sendUserMessage(outgoing, delivery, command.messageId, attachments);
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : "message_rejected",
        };
      }
    }

    const queued: QueuedMessageRecord = {
      text: command.text,
      attachments: command.attachments,
      delivery,
      state: "submitting",
    };
    this.#queuedMessages.set(queueId, queued);
    const completion = (async (): Promise<QueuedMessageResult> => {
      try {
        // 队列接管：传给端口的是账本 queueId（而非裸 command.messageId），扩展出队时
        // 用它调 deliverQueued 回执——id 从入队到投递全程同源，不靠文本匹配。
        await this.#runtime.sendUserMessage(outgoing, delivery, queueId, attachments);
        if (queued.state !== "delivered") {
          queued.state = "accepted";
          this.#publishQueuedMessage(queueId, queued);
        }
        return { ok: true };
      } catch (error) {
        if (queued.state === "delivered") return { ok: true };
        queued.state = "rejected";
        queued.error = error instanceof Error ? error.message : "message_rejected";
        this.#publishQueuedMessage(queueId, queued);
        return { ok: false, error: queued.error };
      }
    })();
    queued.completion = completion;
    return completion;
  }

  #commandResult(
    commandId: string,
    ok: boolean,
    error?: string,
    result?: unknown,
    status?: RuntimeCommandStatus,
  ): void {
    this.#diagnostic?.("bridge.command.result", {
      commandId,
      ok,
      ...(status === undefined ? {} : { status }),
      ...(error === undefined ? {} : { error }),
    });
    this.publish({
      type: "command.result",
      commandId,
      ok,
      ...(status === undefined ? {} : { status }),
      ...(error === undefined ? {} : { error }),
      ...(result === undefined ? {} : { result }),
    });
  }
}
