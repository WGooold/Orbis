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
  /** 本后端名下的会话目录（§7.5）。失败抛错，由上层聚合（单后端失败不拖垮整个列表）。 */
  catalog(archived?: boolean): Promise<AgentSessionSummary[]>;
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
