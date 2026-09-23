import { basename } from "node:path";
import { randomUUID } from "node:crypto";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  InteractionBroker,
  PI_REMOTE_BROKER_QUERY,
  type InteractionCoordinator,
} from "@pi-remote/interaction-sdk";
import { RuntimeBridge } from "@pi-remote/runtime-bridge";
import { loadRemoteControlConfig } from "./config.js";
import {
  createPiExtensionRuntimeDiagnostic,
  logPiExtensionRuntimeEvent,
} from "./runtime-log.js";
import {
  PiMessageStream,
  processRuntimeId,
  runtimeContextSnapshot,
  runtimeHostname,
  sessionCatalogFromInfos,
  sessionGraphFromEntries,
} from "./pi-adapter.js";
import { INTERNAL_SLASH_COMMAND, PiSlashCommandAdapter } from "./slash-commands.js";
import {
  RUNTIME_STATUS_RECONCILE_MS,
  statusToReconcile,
  type RuntimeActivity,
} from "./runtime-status.js";
import { formatRemoteTitle, TerminalRemoteIndicator } from "./terminal-status.js";
import { resolveRuntimeTransport } from "./loopback.js";
import type { RelayRuntimeConnectionState } from "./transport.js";
import {
  formatTurnDuration,
  PiTurnTiming,
} from "./turn-timing.js";
import { PiTurnTimingStore } from "./turn-timing-store.js";

/**
 * 进程级单例标记：一个 Pi 进程里只允许一个活跃的扩展实例。
 *
 * 扩展可能经多条通道进入同一个进程（manifest 的 `pi.extensions`、Host spawn 的 `-e`、
 * 用户手配的路径）。它们是不同的模块 URL，各自求值、模块状态互不相通；不挡的话，
 * 两个实例会带着 `Symbol.for` 共享的同一个 runtimeId 各建一条 loopback 连接，
 * 在 Host 的 `#register` 处互相踢掉对方——TUI 标题永远显示 reconnecting。
 */
const ACTIVE_INSTANCE = Symbol.for("@pi-remote/pi-remote-extension-active");

type GlobalScope = { [key: symbol]: unknown };

const markInstanceActive = (): void => {
  (globalThis as GlobalScope)[ACTIVE_INSTANCE] = true;
};

export default function piRemoteControl(pi: ExtensionAPI): void {
  // 幂等守卫：已有活跃实例（manifest + `-e` 叠加、或双注册）时本次求值直接让位。
  // no-op 的实例不注册任何 handler，不会干扰活跃实例的生命周期。
  if ((globalThis as GlobalScope)[ACTIVE_INSTANCE] === true) {
    logPiExtensionRuntimeEvent("extension_duplicate_load_ignored", {
      entryPoint: import.meta.url,
    });
    return;
  }
  markInstanceActive();

  // This runs once for every extension load, including a successful /reload.
  // import.meta.url identifies the exact entry file that Pi evaluated.
  logPiExtensionRuntimeEvent("extension_loaded", {
    entryPoint: import.meta.url,
  });

  let bridge: RuntimeBridge | undefined;
  let broker: InteractionBroker | undefined;
  let currentContext: ExtensionContext | undefined;
  let slashCommandAdapter: PiSlashCommandAdapter | undefined;
  let activeSessionToken: symbol | undefined;
  let messageStream = new PiMessageStream();
  let connectionState: RelayRuntimeConnectionState = "closed";
  let runtimeActivity: RuntimeActivity = "idle";
  let liveTurnTimer: ReturnType<typeof setInterval> | undefined;
  let liveTurnStartedAt: number | undefined;
  let turnTimingStore: PiTurnTimingStore | undefined;
  // 队列接管（对齐 codex-runtime 的 #drainQueue）：忙时的插入消息由扩展持有，
  // agent_settled（Pi 彻底空闲）时出队投递。每个会话在 session_start 里重绑。
  let drainQueuedSends: () => Promise<void> = async () => {};
  const stopLiveTurn = (ctx: ExtensionContext | undefined = currentContext): void => {
    if (liveTurnTimer !== undefined) clearInterval(liveTurnTimer);
    liveTurnTimer = undefined;
    liveTurnStartedAt = undefined;
    ctx?.ui.setWorkingMessage(undefined);
  };
  const updateLiveTurn = (ctx: ExtensionContext): void => {
    if (liveTurnStartedAt === undefined) return;
    const durationMs = Math.max(0, Date.now() - liveTurnStartedAt);
    ctx.ui.setWorkingMessage(`耗时 ${formatTurnDuration(durationMs)} · 进行中`);
  };
  const startLiveTurn = (ctx: ExtensionContext, startedAt: number): void => {
    stopLiveTurn(ctx);
    liveTurnStartedAt = startedAt;
    updateLiveTurn(ctx);
    liveTurnTimer = setInterval(() => updateLiveTurn(ctx), 1_000);
  };
  const turnTiming = new PiTurnTiming();
  const terminalIndicator = new TerminalRemoteIndicator((frame) => {
    const ctx = currentContext;
    if (!ctx) return;
    const cwd = basename(ctx.sessionManager.getCwd() || ctx.cwd) || "Pi";
    const sessionName = ctx.sessionManager.getSessionName();
    const baseTitle = sessionName ? `π - ${sessionName} - ${cwd}` : `π - ${cwd}`;
    ctx.ui.setTitle(formatRemoteTitle(baseTitle, frame));
  });
  const updateTerminalIndicator = (): void => {
    if (connectionState === "closed") {
      terminalIndicator.clear();
    } else if (connectionState === "error") {
      terminalIndicator.set("error");
    } else if (connectionState === "connecting" || connectionState === "reconnecting") {
      terminalIndicator.set(connectionState);
    } else if (runtimeActivity === "running") {
      terminalIndicator.set("running");
    } else if (runtimeActivity === "waiting") {
      terminalIndicator.set("waiting");
    } else {
      terminalIndicator.set("connected");
    }
  };
  /**
   * 运行状态的唯一发布口。
   *
   * 手机端角标读的是 `runtime.status`，而它是纯增量事件：链路上丢掉一帧（重连、换路径、
   * 重建握手都在丢），角标就停在旧值，之后没有任何事件会去补发它。所以状态只能由一个
   * 统一的出口发布，配合下面的修复节拍收敛。
   */
  const publishRuntimeStatus = (status: RuntimeActivity): void => {
    // A remote/local interaction owns the turn while it is active. Lifecycle events
    // that arrive around it must not overwrite the waiting state with "running".
    const effectiveStatus: RuntimeActivity = broker?.hasActiveInteractions && status !== "waiting"
      ? "waiting"
      : status;
    const changed = runtimeActivity !== effectiveStatus;
    runtimeActivity = effectiveStatus;
    // 内部用短名 `waiting`，线上状态是 `waiting_local_interaction`。
    bridge?.setStatus(effectiveStatus === "waiting" ? "waiting_local_interaction" : effectiveStatus);
    updateTerminalIndicator();
    // 只在变化时记录：手机上「运行中」卡住时，这里能区分「电脑端就没发对」与「发了没到」。
    if (changed) {
      void logPiExtensionRuntimeEvent(
        "runtime.status.published",
        { status: effectiveStatus, idle: currentContext?.isIdle() ?? true },
        currentContext?.cwd === undefined ? {} : { cwd: currentContext.cwd },
      );
    }
  };
  /**
   * 状态修复节拍。
   *
   * `runtime.status` 丢一帧后，手机只能在重连时靠 metadata 快照自愈；如果链路一直活着，
   * 角标就会一直停在旧值——「compact 完一直显示运行中」正是这个形状。这里按固定节拍重报
   * 权威状态，让角标最晚一个节拍收敛。
   */
  let statusReconcileTimer: ReturnType<typeof setInterval> | undefined;
  const stopStatusReconcile = (): void => {
    if (statusReconcileTimer !== undefined) clearInterval(statusReconcileTimer);
    statusReconcileTimer = undefined;
  };
  const startStatusReconcile = (): void => {
    stopStatusReconcile();
    const timer = setInterval(() => {
      const status = statusToReconcile(runtimeActivity, currentContext?.isIdle() ?? true);
      if (status !== undefined) bridge?.setStatus(status);
    }, RUNTIME_STATUS_RECONCILE_MS);
    timer.unref?.();
    statusReconcileTimer = timer;
  };
  pi.registerCommand(INTERNAL_SLASH_COMMAND, {
    description: "Internal Orbis slash command dispatcher",
    handler: async (args, ctx) => {
      await slashCommandAdapter?.handleInternalCommand(args, ctx);
    },
  });

  const closeCurrentSession = (cancelPending = false): void => {
    stopStatusReconcile();
    broker?.close();
    bridge?.close();
    slashCommandAdapter?.close({ cancelPending });
    stopLiveTurn();
    bridge = undefined;
    slashCommandAdapter = undefined;
    broker = undefined;
    turnTiming.reset();
    turnTimingStore = undefined;
    drainQueuedSends = async () => {};
  };

  // Keep this process-lifetime listener across session replacement. The broker itself is replaced per session.
  pi.events.on(PI_REMOTE_BROKER_QUERY, (data) => {
    if (!broker || !data || typeof data !== "object") return;
    const query = data as { broker?: InteractionCoordinator };
    query.broker ??= broker;
  });

  pi.on("session_start", async (event, ctx) => {
    logPiExtensionRuntimeEvent(event.reason === "reload" ? "extension_reloaded" : "session_started", {
      reason: event.reason,
      sessionId: ctx.sessionManager.getSessionId(),
      cwd: ctx.cwd,
      previousSessionFile: event.previousSessionFile,
    }, { cwd: ctx.cwd });
    closeCurrentSession();
    const sessionToken = Symbol("pi-remote-session");
    activeSessionToken = sessionToken;
    // 时序防御：若 reload 是「先求值新实例 → 再 shutdown 旧实例」，新实例会被上面的
    // 幂等守卫 no-op，而旧实例的 shutdown 会清掉标记；活跃实例在这里重新断言，
    // 否则标记缺口会让后续任何一次求值误激活出第二个 bridge（回到互踢）。
    markInstanceActive();
    currentContext = ctx;
    runtimeActivity = ctx.isIdle() ? "idle" : "running";
    connectionState = "connecting";
    updateTerminalIndicator();
    let config;
    try {
      config = await loadRemoteControlConfig();
    } catch (error) {
      ctx.ui.notify(
        `Orbis is disabled: ${error instanceof Error ? error.message : "invalid configuration"}`,
        "error",
      );
      connectionState = "closed";
      updateTerminalIndicator();
      return;
    }
    if (!config || activeSessionToken !== sessionToken) {
      connectionState = "closed";
      updateTerminalIndicator();
      return;
    }
    // Capture only immutable session data. `ctx` becomes stale after this session
    // is replaced by /reload, while the old command may still log completion.
    const sessionLog = createPiExtensionRuntimeDiagnostic(ctx.cwd);
    messageStream = new PiMessageStream();
    // 队列接管：忙时的插入消息不交给 Pi 的 deliverAs 队列（它不提供消费回执，
    // Host 只能靠文本匹配猜），由扩展持有、messageId 全程钉在元素上，
    // agent_settled 时亲手出队投递——delivered 是确定性事件。
    // steer = 打断当前 turn + 插队（与 codex-runtime 语义一致）。
    type QueuedSend = {
      messageId: string;
      content: Array<{ type: "text"; text: string }>;
      delivery: "steer" | "followUp";
    };
    const queuedSends: QueuedSend[] = [];
    const runtimeId = processRuntimeId();
    slashCommandAdapter = new PiSlashCommandAdapter(pi, () => currentContext, {
      completionScopeId: runtimeId,
      diagnostic: sessionLog,
    });
    const sessionSlashCommandAdapter = slashCommandAdapter;
    // 唯一的通道：本机 Host 的 loopback（见 resolveRuntimeTransport 的注释）。
    // Host 没起来时它只等待、不连接中继。
    const transport = await resolveRuntimeTransport({
      onConnectionStateChange: (state) => {
        connectionState = state;
        updateTerminalIndicator();
      },
      log: (line) => sessionLog("runtime_transport_selected", { detail: line }),
    });
    broker = new InteractionBroker(
      runtimeId,
      (remoteEvent) => bridge?.publish(remoteEvent),
      (active) => publishRuntimeStatus(active ? "waiting" : (currentContext?.isIdle() ? "idle" : "running")),
    );
    const sessionBridge = new RuntimeBridge({
      metadata: () => {
        const host = runtimeHostname();
        const sessionName = pi.getSessionName()?.trim() || undefined;
        return {
          runtimeId,
          // Legacy display name for older Relay/APP versions. The APP now identifies a Runtime
          // by its hostname and working directory.
          name: basename(ctx.cwd) || "Pi runtime",
          cwd: ctx.cwd,
          status: broker?.hasActiveInteractions
            ? "waiting_local_interaction"
            : ctx.isIdle() ? "idle" : "running",
          sessionId: ctx.sessionManager.getSessionId(),
          sessionGraphSync: true,
          sessionLeafId: ctx.sessionManager.getLeafId(),
          ...(host === undefined ? {} : { hostname: host }),
          ...(sessionName === undefined ? {} : { sessionName }),
          // Model and context utilization power the APP composer status. They are re-read on every
          // metadata refresh, so a model switch or a finished turn updates them without a new event.
          ...runtimeContextSnapshot(ctx),
        };
      },
      syncSession: (request) => sessionGraphFromEntries(
        ctx.sessionManager.getEntries(),
        ctx.sessionManager.getSessionId(),
        ctx.sessionManager.getLeafId(),
        request,
        turnTimingStore?.list(),
      ),
      sessionCatalog: async () => sessionCatalogFromInfos(await SessionManager.listAll()),
      // 有效忙 = Pi 在跑 || 扩展队列还有压着的消息。否则队列里还有 followUp 时，
      // 手机再来一条无 delivery 的消息会走空闲路径插队，顺序就乱了。
      isIdle: () => (currentContext?.isIdle() ?? true) && queuedSends.length === 0,
      sendUserMessage: async (text, delivery, messageId, attachments) => {
        // 附件作为独立的 text part 跟在用户正文后面：用户消息正文保持原样，
        // agent 仍能拿到每个文件的电脑端路径（路径由上传端保证唯一）。
        const content = [{ type: "text" as const, text }];
        for (const path of attachments ?? []) {
          content.push({ type: "text" as const, text: `[附件] ${path}` });
        }
        // 空闲直通（bridge 只在有效空闲时才允许无 delivery 到这里），立即开新 turn。
        if (delivery === undefined) {
          await pi.sendUserMessage(content);
          return;
        }
        // 忙时接管：不入 Pi 的队列，出队时用 queueId 调 deliverQueued 回执。
        const entry: QueuedSend = { messageId: messageId ?? randomUUID(), content, delivery };
        if (entry.delivery === "steer") {
          queuedSends.unshift(entry);
          // steer = 打断当前回合，agent_settled 后 drain 会立刻把它送上。
          currentContext?.abort();
        } else {
          queuedSends.push(entry);
        }
        // 竞态兜底：bridge 判忙到入队之间 Pi 可能刚好空了（或队列里本就压着消息
        // 而此时 Pi 空闲）——不会再有 agent_settled 来触发 drain，这里补一发。
        // Pi 忙时它是 no-op（isIdle false），由 agent_settled 接手。
        if (currentContext?.isIdle() ?? true) void drainQueuedSends();
      },
      cancelQueuedMessage: (messageId) => {
        // 队列在扩展手里，取消是真实的：还在队列里就移除（bridge 负责发 cancelled）；
        // 已出队/不存在则不可取消。
        const index = queuedSends.findIndex((entry) => entry.messageId === messageId);
        if (index < 0) return { ok: false as const, error: "not_cancelable", status: "not_cancelable" as const };
        queuedSends.splice(index, 1);
        return { ok: true as const };
      },
      abort: () => currentContext?.abort(),
      capabilities: async () => ({
        commands: await sessionSlashCommandAdapter.commands(),
      }),
      executeSlashCommand: (name, args) => sessionSlashCommandAdapter.execute(name, args),
      recordSlashCommandCompletion: (completion) => sessionSlashCommandAdapter.recordCompletion(completion),
      takeSlashCommandCompletions: () => sessionSlashCommandAdapter.takeCompletions(),
    }, transport, {
      respond: (requestId, extensionId, response) => broker?.respond(requestId, extensionId, response) ?? false,
      disconnected: () => broker?.disconnected(),
      closed: () => broker?.closed(),
      resync: () => broker?.resync(),
    }, sessionLog);
    bridge = sessionBridge;
    // 出队投递：先发 delivered 回执、再送进 Pi（与 codex #drainQueue 同序）——
    // 手机先撤掉排队行，随后 message.started 的气泡自然上屏。循环条件里
    // isIdle 会在第一次投递后变 false，天然一次只放行一条。
    drainQueuedSends = async () => {
      while (queuedSends.length > 0 && (currentContext?.isIdle() ?? true)) {
        const next = queuedSends.shift();
        if (!next) break;
        sessionBridge.deliverQueued(next.messageId);
        try {
          await pi.sendUserMessage(next.content);
        } catch (error) {
          sessionBridge.failQueued(next.messageId, error instanceof Error ? error.message : "message_rejected");
          break;
        }
      }
    };
    turnTimingStore = new PiTurnTimingStore(
      ctx.sessionManager.getSessionFile(),
      ctx.sessionManager.getSessionId(),
    );
    await turnTimingStore.load();
    if (event.reason === "fork" && event.previousSessionFile !== undefined) {
      const previousTimingStore = new PiTurnTimingStore(event.previousSessionFile);
      await previousTimingStore.load();
      await turnTimingStore.import(previousTimingStore.list()).catch(() => {});
    }
    sessionSlashCommandAdapter.onCompletionAvailable(() => sessionBridge.flushCommandCompletions());
    await sessionBridge.start();
    if (activeSessionToken !== sessionToken) {
      sessionBridge.close();
      return;
    }
    startStatusReconcile();
    if (activeSessionToken !== sessionToken) {
      sessionBridge.close();
      return;
    }
    sessionBridge.sessionStarted(event.reason);
  });

  pi.on("session_info_changed", async () => {
    updateTerminalIndicator();
    bridge?.refreshMetadata();
    await bridge?.refreshCapabilities();
    await bridge?.refreshSessionCatalog();
  });

  // Desktop tree navigation also changes the phone's active path and selected position.
  pi.on("session_tree", async () => {
    bridge?.refreshMetadata();
    await bridge?.refreshCapabilities();
  });

  // Compaction rewrites the active branch, so the context percentage and tree are stale
  // until the next turn. Refresh them as soon as Pi reports the outcome.
  pi.on("session_compact", async () => {
    bridge?.refreshMetadata();
    publishRuntimeStatus(currentContext?.isIdle() === false ? "running" : "idle");
    await bridge?.refreshCapabilities();
  });

  pi.on("session_compact_failed", async () => {
    bridge?.refreshMetadata();
    publishRuntimeStatus(currentContext?.isIdle() === false ? "running" : "idle");
  });

  pi.on("session_shutdown", async (event) => {
    logPiExtensionRuntimeEvent("session_shutdown", {
      reason: event.reason,
      sessionId: currentContext?.sessionManager.getSessionId(),
      targetSessionFile: event.targetSessionFile,
    }, currentContext?.cwd === undefined ? {} : { cwd: currentContext.cwd });
    activeSessionToken = undefined;
    closeCurrentSession(event.reason === "quit");
    // 让位：shutdown 之后进程内没有活跃实例了，后续求值（reload/换会话）可以重新接管。
    (globalThis as GlobalScope)[ACTIVE_INSTANCE] = false;
    terminalIndicator.clear();
    connectionState = "closed";
    currentContext = undefined;
  });

  pi.on("agent_start", async () => {
    publishRuntimeStatus("running");
  });

  pi.on("agent_settled", async (_event, ctx) => {
    stopLiveTurn(ctx);
    // Pi's turn_end is the authoritative completion event. Clear the local
    // correlation state here as a fallback for aborted turns with no end event.
    turnTiming.reset();
    publishRuntimeStatus("idle");
    // Pi 彻底空闲（没有重试/压缩/排队续跑会再发生）→ 亲手投递队列里压着的消息。
    // 与 codex 的 turn/completed → #drainQueue 边界同构。
    await drainQueuedSends();
    await bridge?.refreshCapabilities();
  });

  pi.on("turn_start", async (event, ctx) => {
    const started = turnTiming.start(event.turnIndex, event.timestamp);
    startLiveTurn(ctx, started.startedAt);
    bridge?.publish(started);
  });

  pi.on("turn_end", async (event, ctx) => {
    const messageId = messageStream.messageIdFor(event.message);
    const branch = ctx.sessionManager.getBranch();
    // Pi appends each message as it ends and fires `turn_end` once everything this turn produced is
    // persisted, so this is the first point where every entry of the turn can be paired with the
    // temporary id streamed for it. Publishing the whole mapping keeps the APP from guessing which
    // persisted row corresponds to which streamed row.
    const persistedMessages = messageStream.persistedMessageMappings(branch);
    const persistedMessageId = persistedMessages.find((mapping) => mapping.messageId === messageId)?.entryId
      ?? [...branch].reverse().find((candidate) =>
        candidate.type === "message" && candidate.message === event.message
      )?.id ?? [...branch].reverse().find((candidate) =>
        candidate.type === "message" && candidate.message.role === "assistant"
      )?.id;
    const finished = turnTiming.finish(event.turnIndex, messageId, persistedMessageId, persistedMessages);
    if (finished) {
      stopLiveTurn(ctx);
      const persistedTimingMessageId = persistedMessageId ?? messageId;
      void turnTimingStore?.record({
        turnId: finished.turnId,
        startedAt: finished.startedAt,
        durationMs: finished.durationMs,
        ...(finished.turnIndex === undefined ? {} : { turnIndex: finished.turnIndex }),
        ...(persistedTimingMessageId === undefined ? {} : { messageId: persistedTimingMessageId }),
      }).catch(() => {});
      bridge?.publish(finished);
    }
    // Turn completion persists the latest branch entries and can move the leaf.
    bridge?.refreshMetadata();
  });

  pi.on("message_start", async (event, ctx) => {
    const entry = [...ctx.sessionManager.getBranch()].reverse().find((candidate) =>
      candidate.type === "message" && candidate.message === event.message
    );
    bridge?.publish(messageStream.started(event.message, entry?.id));
  });

  pi.on("message_update", async (event) => {
    const update = messageStream.updated(event.assistantMessageEvent, event.message);
    if (update) bridge?.publish(update);
  });

  pi.on("message_end", async (event) => {
    bridge?.publish(messageStream.finished(event.message));
  });

  pi.on("model_select", async () => {
    bridge?.refreshMetadata();
    await bridge?.refreshCapabilities();
  });

  pi.on("thinking_level_select", async () => {
    bridge?.refreshMetadata();
    await bridge?.refreshCapabilities();
  });

  pi.on("tool_execution_start", async (event) => {
    bridge?.publish({
      type: "tool.started",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      arguments: event.args,
    });
  });

  pi.on("tool_execution_update", async (event) => {
    bridge?.publish({
      type: "tool.updated",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      partialResult: event.partialResult,
    });
  });

  pi.on("tool_execution_end", async (event) => {
    bridge?.publish({
      type: "tool.finished",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      result: event.result,
      isError: event.isError,
    });
  });

  pi.on("ui_prompt_start", async (event) => {
    if (broker?.hasActiveInteractions) return;
    publishRuntimeStatus("waiting");
    bridge?.publish({
      type: "local_interaction.required",
      kind: event.kind,
      ...(event.title === undefined ? {} : { title: event.title }),
    });
  });

  pi.on("ui_prompt_end", async () => {
    publishRuntimeStatus(currentContext?.isIdle() === false ? "running" : "idle");
  });

  pi.registerCommand("remote-status", {
    description: "Show whether this Pi runtime is connected to remote control",
    handler: async (_args, ctx) => {
      ctx.ui.notify(bridge ? "Orbis is enabled for this runtime" : "Orbis is disabled", "info");
    },
  });
}

export { loadRemoteControlConfig } from "./config.js";
export {
  REMOTE_TURN_STARTED_CUSTOM_TYPE,
  REMOTE_TURN_TIMING_CUSTOM_TYPE,
  PiMessageStream,
  sessionCatalogFromInfos,
  sessionGraphFromEntries,
  turnTimingsFromEntries,
} from "./pi-adapter.js";
export { RelayRuntimeTransport } from "./transport.js";
export { LoopbackHostTransport, readLoopbackDescriptor } from "./loopback.js";
export { PiSlashCommandAdapter } from "./slash-commands.js";
