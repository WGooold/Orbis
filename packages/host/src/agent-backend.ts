/**
 * Host 的 agent 后端统一端口（spec §7.4 的适配器收口）。
 *
 * **目标形态以 Pi 为准**：Pi 会话对手机暴露的每个能力（目录、激活、命令、事件流）
 * 就是这份接口的形状——它不是新发明，`runtime-bridge` 的 `RuntimePort` 本来就是
 * Pi 侧的事实契约。其它 agent（目前是 Codex）各自实现同一个接口，Host 的分派
 * 逻辑只面向接口，不再为单个后端写 `if (codex)` 特判。
 *
 * 归属与顺序约定：
 * - 会话 id 空间互不相交（Pi 自增 id vs Codex UUID，§7.5），resume 按 backends
 *   数组顺序（Pi → Codex）逐个尝试；`ActivationError("session_not_found")` 表示
 *   「不归我管」，交给下一个后端，全部不认领才是真的找不到。
 * - 命令路由按 runtimeId 归属（`ownsRuntime`）一次命中：认领了却不认识命令回
 *   `unsupported_command`，不认领任何后端才回 `runtime_offline`（§8：手机据此
 *   区分「该重拉进程」和「这个后端做不到」）。
 */
import type { AgentKind, AgentSessionSummary, RuntimeCommand, RuntimeMetadata, SpawnMode } from "@pi-remote/protocol";

import { ActivationError, type SessionSpawner } from "./spawner.js";
import { defaultPiSessionsRoot, listPiSessions } from "./sessions.js";
import { piArchiveRoot, SessionArchiveError, setPiSessionArchived } from "./session-archive.js";
import type { ClaudeHookBridge } from "./claude-hook-bridge.js";
import type { ClaudeModsBridge } from "./claude-mods-bridge.js";

export type AgentActivateTarget =
  | { type: "new"; cwd: string }
  | { type: "resume"; sessionId: string };

export type BackendActivation = {
  sessionId?: string;
  spawnMode: "tui" | "headless";
  pid?: number;
};

/** 分派一条已认领命令的三种结果：处理成功 / 后端不认识 / runtime 掉线。 */
export type CommandDispatch = "handled" | "unsupported" | "offline";

export type AgentActivateContext = {
  deviceId?: string;
  spawnMode?: SpawnMode;
};

export interface AgentBackend {
  readonly kind: AgentKind;
  /** 后端进程就绪、能承接请求。未就绪的后端不进 agents 快照、不拉目录、不认领命令。 */
  isReady(): boolean;
  /** 该 runtimeId 是否归本后端（命令路由的归属判定，一次命中）。 */
  ownsRuntime(runtimeId: string): boolean;
  /** Reconcile a backend-owned notification inventory without issuing a chat command. */
  syncNotifications?(runtimeId: string): void;
  /** 本后端名下的会话目录（§7.5）。失败抛错，由上层聚合（单后端失败不拖垮整个列表）。 */
  catalog(archived?: boolean): Promise<AgentSessionSummary[]>;
  /** Effective configured provider, independent of any open session. Unknown on failure. */
  currentProvider?(): Promise<string | undefined>;
  setArchived(sessionId: string, archived: boolean): Promise<void>;
  /**
   * 激活一个会话。不归本后端的会话抛 `ActivationError("session_not_found")`，
   * 其余错误（cwd_missing / spawn_failed 等）原样上抛。
   */
  activate(target: AgentActivateTarget, context?: AgentActivateContext): Promise<BackendActivation>;
  /** 分派一条命令（runtimeId 已确认归本后端）。 */
  dispatchCommand(runtimeId: string, commandId: string, command: RuntimeCommand): CommandDispatch;
  /**
   * 进程目录里的条目（§8.1）。没有活跃会话时返回空数组——空壳（cwd=主目录的
   * 占位进程）不进目录，那正是「主页面多出一条用户目录」假进程的成因。
   * 常驻进程可以同时挂多个会话（如 Codex 的 app-server）：一个会话一条进程卡。
   */
  directoryEntries?(): RuntimeMetadata[];
}

export type PiBackendOptions = {
  spawner: SessionSpawner;
  /** 把命令投给 loopback 上注册的 Pi 进程。false = 进程不在线/没注册。 */
  sendCommand: (runtimeId: string, commandId: string, command: RuntimeCommand) => boolean;
  /** loopback 当前注册的 runtimeId 列表（归属判定用；动态读，不快照）。 */
  runtimeIds: () => readonly string[];
  sessionIsOnline?: (sessionId: string) => boolean;
  sessionsRoot?: string;
  log?: (line: string) => void;
};

/** Pi 后端：会话目录在磁盘（`~/.pi/agent/sessions`），进程在 loopback 上注册。 */
export class PiBackend implements AgentBackend {
  readonly kind = "pi" as const;
  readonly #options: PiBackendOptions;

  constructor(options: PiBackendOptions) {
    this.#options = options;
  }

  /** Pi 的激活能力（spawner）永远在；命令能否送达由 sendCommand 运行时回答。 */
  isReady(): boolean {
    return true;
  }

  ownsRuntime(runtimeId: string): boolean {
    return this.#options.runtimeIds().includes(runtimeId);
  }

  async catalog(archived = false): Promise<AgentSessionSummary[]> {
    const root = this.#options.sessionsRoot ?? defaultPiSessionsRoot();
    const scan = await listPiSessions({ root: archived ? piArchiveRoot(root) : root });
    return scan.sessions.map((entry) => ({ ...entry, archived }));
  }

  async setArchived(sessionId: string, archived: boolean): Promise<void> {
    await setPiSessionArchived(sessionId, archived, {
      ...(this.#options.sessionsRoot === undefined ? {} : { root: this.#options.sessionsRoot }),
      assertIdle: () => {
        if (this.#options.sessionIsOnline?.(sessionId) ||
            this.#options.spawner.running.some((agent) => agent.sessionId === sessionId)) {
          throw new SessionArchiveError("session_busy", "请先退出这个 Pi 会话，再进行归档或恢复");
        }
      },
    });
  }

  async activate(target: AgentActivateTarget, context?: AgentActivateContext): Promise<BackendActivation> {
    if (target.type === "resume") {
      // 从磁盘找会话文件与 cwd（§8.2）。找不到 = 不归 Pi 管（可能是 codex 的 thread）。
      const scan = await listPiSessions(
        this.#options.sessionsRoot === undefined ? {} : { root: this.#options.sessionsRoot },
      );
      const sessionFile = scan.files.get(target.sessionId);
      const entry = scan.sessions.find((candidate) => candidate.sessionId === target.sessionId);
      if (sessionFile === undefined || entry === undefined) {
        throw new ActivationError("session_not_found", `Pi 会话目录里没有 ${target.sessionId}`);
      }
      const spawned = await this.#options.spawner.activate({
        deviceId: context?.deviceId ?? "",
        target: { type: "resume", sessionId: target.sessionId, cwd: entry.cwd, sessionFile },
        ...(context?.spawnMode === undefined ? {} : { spawnMode: context.spawnMode }),
      });
      return {
        ...(spawned.sessionId === undefined ? {} : { sessionId: spawned.sessionId }),
        spawnMode: spawned.spawnMode,
        pid: spawned.pid,
      };
    }
    const spawned = await this.#options.spawner.activate({
      deviceId: context?.deviceId ?? "",
      target: { type: "new", agentKind: "pi", cwd: target.cwd },
      ...(context?.spawnMode === undefined ? {} : { spawnMode: context.spawnMode }),
    });
    return {
      ...(spawned.sessionId === undefined ? {} : { sessionId: spawned.sessionId }),
      spawnMode: spawned.spawnMode,
      pid: spawned.pid,
    };
  }

  dispatchCommand(runtimeId: string, commandId: string, command: RuntimeCommand): CommandDispatch {
    if (!this.ownsRuntime(runtimeId)) return "offline";
    return this.#options.sendCommand(runtimeId, commandId, command) ? "handled" : "offline";
  }
}

export type ClaudeBackendOptions = {
  bridge: ClaudeHookBridge;
  modsBridge: ClaudeModsBridge;
  runtimeIds: () => readonly string[];
  onCommandResult?: (runtimeId: string, event: Extract<import("@pi-remote/protocol").RuntimeEvent, { type: "command.result" }>) => void;
};

/** Backend for the native Claude Code TUI Hook bridge. */
export class ClaudeBackend implements AgentBackend {
  readonly kind = "claude" as const;
  readonly #options: ClaudeBackendOptions;

  constructor(options: ClaudeBackendOptions) { this.#options = options; }
  isReady(): boolean { return this.#options.runtimeIds().length > 0; }
  ownsRuntime(runtimeId: string): boolean { return runtimeId.startsWith("claude:") && this.#options.runtimeIds().includes(runtimeId); }
  async catalog(): Promise<AgentSessionSummary[]> { return []; }
  async setArchived(): Promise<void> { throw new ActivationError("session_not_found", "Claude Code 会话目录尚未接入"); }
  async activate(): Promise<BackendActivation> { throw new ActivationError("agent_unsupported", "Claude Code 只能接入已运行且已加载 bridge 的官方 TUI"); }
  dispatchCommand(runtimeId: string, commandId: string, command: RuntimeCommand): CommandDispatch {
    if (!this.ownsRuntime(runtimeId)) return "offline";
    if (command.type === "interaction.respond") {
      const result = this.#options.bridge.respond(command.requestId, this.#options.bridge.generation, command.response);
      if (result === "accepted") {
        this.#options.onCommandResult?.(runtimeId, { type: "command.result", commandId, ok: true, status: "success" });
        return "handled";
      }
      if (result === "duplicate") {
        this.#options.onCommandResult?.(runtimeId, { type: "command.result", commandId, ok: true, status: "already_delivered" });
        return "handled";
      }
      const error = result === "unknown" ? "interaction_not_found" :
        result === "stale" ? "stale_generation" : "interaction_conflict";
      this.#options.onCommandResult?.(runtimeId, { type: "command.result", commandId, ok: false, status: "failure", error });
      // The runtime is still online and this backend owns it. A rejected response
      // is a command failure, not an offline or unsupported-runtime condition.
      return "handled";
    }

    if (command.type === "user_message") {
      if (!this.#options.modsBridge.isOnline(runtimeId)) return "unsupported";
      // Claude Mods currently only provides a submit-after-idle API. Do not
      // disguise Pi-style steer, or silently drop files the API cannot attach.
      if (command.delivery === "steer" || (command.attachments !== undefined && command.attachments.length > 0)) {
        this.#options.onCommandResult?.(runtimeId, { type: "command.result", commandId, ok: false,
          status: "failure", error: command.delivery === "steer" ? "claude_steer_unsupported" : "claude_attachments_unsupported" });
        return "handled";
      }
      const result = this.#options.modsBridge.sendCommand(runtimeId, commandId,
        { type: "user_message", text: command.text, ...(command.messageId === undefined ? {} : { messageId: command.messageId }) });
      return this.#reportModsCommandResult(runtimeId, commandId, result);
    }
    if (command.type === "stop") {
      if (!this.#options.modsBridge.isOnline(runtimeId)) return "unsupported";
      const result = this.#options.modsBridge.sendCommand(runtimeId, commandId, { type: "stop" });
      return this.#reportModsCommandResult(runtimeId, commandId, result);
    }
    if (command.type === "user_message.cancel") {
      this.#options.onCommandResult?.(runtimeId, { type: "command.result", commandId, ok: false,
        status: "not_cancelable", error: "claude_prompt_submit_not_cancelable" });
      return "handled";
    }
    return "unsupported";
  }
  directoryEntries(): RuntimeMetadata[] {
    const byId = new Map(this.#options.bridge.runtimeMetadata().map(runtime => [runtime.runtimeId, runtime]));
    for (const runtime of this.#options.modsBridge.runtimeMetadata()) {
      byId.set(runtime.runtimeId, { ...runtime, status: this.#options.bridge.runtimeMetadata().find(item => item.runtimeId === runtime.runtimeId)?.status ?? runtime.status });
    }
    return [...byId.values()];
  }

  #reportModsCommandResult(runtimeId: string, commandId: string,
    result: ReturnType<ClaudeModsBridge["sendCommand"]>): CommandDispatch {
    if (result === "offline") return "offline";
    if (result === "accepted") {
      this.#options.onCommandResult?.(runtimeId, { type: "command.result", commandId, ok: true, status: "pending" });
      return "handled";
    }
    const error = result === "queue_full" ? "claude_command_queue_full" :
      result === "id_conflict" ? "command_id_conflict" :
        result === "not_cancelable" ? "claude_turn_not_running" : "claude_bridge_offline";
    this.#options.onCommandResult?.(runtimeId, { type: "command.result", commandId, ok: false,
      status: result === "not_cancelable" ? "not_cancelable" : "failure", error });
    return "handled";
  }
}
