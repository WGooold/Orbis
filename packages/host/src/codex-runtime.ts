/**
 * Codex 虚拟 runtime（spec §7.4 的 M4 接入）。
 *
 * Codex 没有像 Pi 那样自己往 loopback 上注册——Host 里的这个类**扮演 runtime**：
 * 对手机来说它就是一个普通的本机 agent 进程（`runtime.online` → `runtime.command`
 * → `runtime.event`），只是事件由 app-server 的 thread/turn/item 流映射而来。
 *
 * 映射表（app-server v2 → runtime 协议）：
 * - `thread/list`            → `session.list.result` 的 codex 部分（AgentSessionSummary）
 * - `thread/resume|start`    → 会话激活（一个 runtime 同时只有一个活跃 thread，同 Pi 语义）
 * - `turn/start`             ← `user_message` 命令（带 `clientUserMessageId` = App 的 messageId，
 *                              app-server 在 userMessage item 的 clientId 原样带回——用户气泡
 *                              的唯一上屏事件就是 item/started(UserMessage)，不本地合成回显）；
 *                              `turn/interrupt` ← `stop`
 * - `item/agentMessage/delta` → `message.delta`（text）
 * - `item/started|completed`  → `message.*` + `tool.*` + 条目图（session.snapshot 用）
 * - 命令/文件/权限批准、用户输入和 MCP elicitation → `interaction.requested`；
 *   `interaction.respond` 按各 RPC 的响应类型回传，`serverRequest/resolved` 确认结束。
 *   expiresAt 内没有响应时按各接口的拒绝格式回复，避免挂住 turn。
 * - thread 历史（resume 返回的 turns）→ 条目图回放
 *
 * 唯一性约定：codex 的 itemId 全局唯一（UUID），直接当 entryId / messageId 用，
 * 和 Pi 的会话 id 空间天然不撞（§7.5）。
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { selectSessionSyncSnapshot } from "@pi-remote/protocol";

import type {
  AgentKind,
  AgentSessionSummary,
  ChatMessage,
  RemoteSessionEntry,
  RuntimeCapabilities,
  RuntimeCommand,
  RuntimeCommandStatus,
  RuntimeEvent,
  RuntimeMetadata,
  RuntimePermissions,
  RuntimeModelInfo,
  RuntimeSlashCommand,
  RuntimeSlashCommandOption,
  RuntimeStatus,
} from "@pi-remote/protocol";

import type {
  AgentActivateTarget,
  AgentBackend,
  BackendActivation,
  CommandDispatch,
} from "./agent-backend.js";
import { CODEX_RUNTIME_ID, type CodexAppServer, type CodexCommand, type CodexServerRequest } from "./codex-daemon.js";
import { describeError } from "./describe-error.js";
import { localHostname } from "./sessions.js";
import { codexDecline, object, prepareCodexInteraction, type CodexInteraction } from "./codex-interactions.js";
import { CODEX_PERMISSION_COMMANDS, codexErrorMessage, codexPermissionUpdate, codexPermissions } from "./codex-permissions.js";
import { SessionArchiveError } from "./session-archive.js";

/** 审批窗口。手机在 expiresAt 前不响应就按 decline 处理，防止 turn 挂死。 */
const APPROVAL_TTL_MS = 5 * 60 * 1_000;

/**
 * Codex 后端对外声明的 Slash 命令子集（spec §9.1 / §13.3）。
 *
 * 目标是 Pi 的接口形式：命令词表来自 runtime 自己发布的 `capabilities`，APP 不硬编码
 * agentKind。codex app-server 没有 Pi 那样的一等 slash 命令，所以这里只声明**能一一
 * 映射到 app-server RPC 的那个子集**——声明即承诺（未声明的不出现在手机菜单里）。
 *
 * `/model` 与 `/thinking` 这里的 `argument` 只是**降级形态**（纯文本）。真实选项来自
 * `model/list`，由 `capabilities()` 在运行时替换成 `kind: "select"` + options——
 * APP 只在 select 时才渲染二级菜单，所以缓存没就绪前它们只能手打。
 *
 * `/tree` 与 codex TUI 里「编辑过去的消息」同一套语义：`thread/revert` 原地把历史截断到某一轮
 * 之前，不派生新会话。选项由 `capabilities()` 按当前 thread 动态生成，和 `/model`、`/thinking`
 * 一样是运行时事实。
 *
 * 未纳入（app-server 拿不出或语义不等价）：`copy`/`clone`/`reload`。
 * 它们在 Pi 里是本体会话操作，app-server 侧没有对应 RPC，硬接只会造出假承诺。
 *
 * `/quit` 是例外：app-server 同样没有「关闭 TUI」的 RPC，但它的语义可以由 Host 直接
 * 兑现——结束本机 attach 到本 app-server 的 codex TUI 进程（见 #quitThread）。Pi 的
 * `/quit` 请求进程自己退出，这里等价的是「关掉电脑上那个 TUI 窗口」，手机侧表现一致：
 * 该 runtime 下线。
 */
function permissionPatchMatches(actual: Record<string, unknown>, patch: Record<string, unknown>): boolean {
  return Object.entries(patch).every(([key, value]) => {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return permissionPatchMatches(object(actual[key]), object(value));
    }
    return JSON.stringify(actual[key]) === JSON.stringify(value);
  });
}

const CODEX_SLASH_COMMANDS: readonly RuntimeSlashCommand[] = [
  ...CODEX_PERMISSION_COMMANDS,
  { name: "model", description: "Select the model for this Codex session", source: "builtin", argument: { kind: "text", required: true, hint: "<model-id>" } },
  { name: "thinking", description: "Set the reasoning effort for this Codex session", source: "builtin", argument: { kind: "text", required: true, hint: "<effort>" } },
  { name: "name", description: "Show or set the Codex session display name", source: "builtin", argument: { kind: "text", required: false, hint: "[name]" } },
  { name: "new", description: "Start a new Codex session", source: "builtin" },
  { name: "resume", description: "Resume a different Codex session", source: "builtin", argument: { kind: "text", required: true, hint: "<session-id>" } },
  { name: "fork", description: "Fork this Codex session into a new one", source: "builtin" },
  { name: "compact", description: "Compact the Codex session context", source: "builtin" },
  { name: "tree", description: "Browse this session's history and rewind to a point", source: "builtin", argument: { kind: "tree", required: false, options: [] } },
  { name: "quit", description: "Quit Codex (close the TUI window on the computer)", source: "builtin" },
];

export type CodexRuntimeOptions = {
  server: CodexAppServer;
  runtimeId?: string;
  log?: (line: string) => void;
  /**
   * 事件出口：Host 包一层 per-thread runtimeId（`codex:<threadId>`）后广播给设备
   * （同 loopback 的 onRuntimeEvent）。threadId 未知的罕见事件落到裸 runtimeId 上。
   */
  onEvent: (event: RuntimeEvent, threadId: string | undefined) => void;
  /**
   * 激活后在电脑上开有头终端窗口（官方 TUI attach 到本 app-server，双同步）。
   * 缺省实现是 wt + `codex resume <id> --remote <endpoint>`；测试注入 no-op。
   */
  openHeadWindow?: (input: { sessionId: string; cwd: string; endpoint: string; codexCommand?: CodexCommand }) => void;
  /** rollout 根目录（缺省 `~/.codex/sessions`）；测试注入临时目录。 */
  rolloutRoot?: string;
  /**
   * 有头窗口看门狗的进程轮询注入（测试用）。生产缺省走 PowerShell 的
   * `Get-CimInstance Win32_Process` 按 `--remote <endpoint>` 过滤 codex/node 进程。
   */
  pollTuiProcesses?: (endpoint: string) => Promise<Set<string>>;
  /**
   * `/quit` 结束 TUI 进程的操作（测试注入）。生产缺省走 PowerShell：结束命令行同时
   * 命中 `resume <sessionId>` 与 `--remote <endpoint>` 的 codex/node 进程，以及还没
   * attach、只在 `-EncodedCommand` 里含该命令的等待窗口。返回是否结束了至少一个进程。
   */
  killTuiProcesses?: (input: { sessionId: string; endpoint: string }) => Promise<boolean>;
  /**
   * TUI 切换会话的宽限窗口（毫秒，缺省 300）。app-server 把 thread/started 等通知
   * 广播给所有客户端，Host 自己 activate 的广播可能先于 RPC 响应到达——等一个宽限
   * 窗口再复查，已被收编的就是自己人的广播。测试注入小值。
   */
  tuiSwitchGraceMs?: number;
};

/** 只读 rollout 文件头部找 meta 和第一条用户消息；指令前导很长，128KB 足够覆盖。 */
const ROLLOUT_HEAD_BYTES = 128 * 1_024;

type PendingApproval = {
  serverRequest: CodexServerRequest;
  interaction: CodexInteraction;
  turnId: string | undefined;
  blocking: boolean;
  submitted: { fingerprint: string; commandIds: Set<string> } | undefined;
  timer: NodeJS.Timeout;
};

/** 排队中的消息（turn 进行中收到 followUp/steer）。语义对齐 runtime-bridge 的队列投影。 */
type QueuedTurn = {
  messageId: string;
  text: string;
  delivery: "steer" | "followUp";
};

type PersistedMessageMapping = {
  messageId: string;
  entryId: string;
};

type DynamicSlashCommand = RuntimeSlashCommand & {
  kind: "skill" | "mcp";
  skillPath?: string;
  mcpServer?: string;
  mcpTool?: string;
};

type IntegrationCatalog = {
  commands: DynamicSlashCommand[];
};

/**
 * 一个活跃 thread 的全部状态。Codex 的 app-server 是常驻进程、可同时挂多个
 * thread——对手机来说**每个活跃 thread 就是一条独立的进程**（同 Pi 一会话一进程），
 * 以 `codex:<threadId>` 作为它的 runtimeId。
 */
type ThreadState = {
  id: string;
  cwd: string;
  name: string | undefined;
  /** 条目图（回放给 session.sync）。 */
  entries: RemoteSessionEntry[];
  historyError?: string;
  rolloutPath?: string;
  itemOrder: string[];
  committedItemCount: number;
  completedItems: Map<string, { item: Record<string, unknown>; turnId: string | undefined }>;
  /**
   * entryId → 所属 turn id。
   *
   * app-server 的历史回退只能按 **turn** 边界（`thread/revert` 的 `beforeTurnId`），
   * 而手机历史树上的节点是 **message** 粒度，所以「从这条继续」必须先换算成轮次。
   * 三条回放路径都会写入：turns 骨架（`#replayTurns`）、实时 item 事件（带 turnId）、
   * 磁盘 rollout（`turn_context` / `task_started` 划出边界）。
   */
  entryTurns: Map<string, string>;
  /** 轮次顺序（turn id，按时间）。助手回复要往后保留一轮时靠它找下一轮。 */
  turnOrder: string[];
  turnInProgress: boolean;
  turnId: string | undefined;
  turnStartedAt: number | undefined;
  streamingMessageId: string | undefined;
  /** turn 进行中排队的后续消息（followUp 追加、steer 插队）。 */
  queue: QueuedTurn[];
  /** 当前 turn 中 Runtime 已确认的 live id -> Codex entry id。 */
  persistedMessageMappings: PersistedMessageMapping[];
  /** 活跃 Codex tool 的名称，供没有 item payload 的 progress/output 通知复用。 */
  toolNames: Map<string, string>;
  /** 会话级模型覆盖（`/model` 命令写入，随后每个 turn 带上）。 */
  model: string | undefined;
  /** 会话实际使用的模型供应商（由 thread/start|resume 返回）。 */
  modelProvider: string | undefined;
  /** 会话级 reasoning effort 覆盖（`/thinking` 命令写入，随后每个 turn 带上）。 */
  effort: string | undefined;
  /**
   * app-server `thread/tokenUsage/updated` 报的当前上下文占用（`last.inputTokens` /
   * `modelContextWindow`）。`total.inputTokens` 是线程累计输入量，不能用于上下文窗口
   * 进度。没收到过就没有——APP 侧 contextUsage 为 null 时不显示占用条。
   */
  contextUsage: { tokens: number; window: number } | undefined;
  /**
   * 会话实际使用的模型 id（app-server 的 thread 快照不带 model，只能来自 `/model` 覆盖，
   * 或 `model/list` 里 `isDefault` 那条的 id）。
   */
  modelId: string | undefined;
  /** 模型显示名（`model/list` 的 displayName，如 "GPT-5.5"）；APP 优先用它而不是美化 id。 */
  modelName: string | undefined;
  permissions: RuntimePermissions | undefined;
  approvalItems: Map<string, Record<string, unknown>>;
  lastError: string | undefined;
  waitingForApproval: boolean;
};

export class CodexRuntime implements AgentBackend {
  readonly runtimeId: string;
  readonly #options: CodexRuntimeOptions;
  readonly #server: CodexAppServer;
  /** 活跃 thread 表。codex 的 thread/resume 返回完整 turns，激活即拿到历史。 */
  readonly #threads = new Map<string, ThreadState>();
  /** 审批窗口（键 = 独立生成的手机 requestId）。超时按接口对应的拒绝格式回复。 */
  readonly #approvals = new Map<string, PendingApproval & { threadId: string }>();
  readonly #observedSettings = new Map<string, RuntimePermissions>();
  readonly #effectiveSettings = new Map<string, Record<string, unknown>>();
  readonly #permissionUpdates = new Map<string, {
    patch: Record<string, unknown>;
    resolve: () => void;
    reject: (error: Error) => void;
  }>();
  #started = false;
  #eventSink: ((event: RuntimeEvent, threadId: string | undefined) => void) | undefined;
  /**
   * `model/list` 的缓存：app-server 的 thread 快照不带 model，只有这里能问出
   * 默认模型 id / displayName / 默认思考深度。启动时探一次（失败保持 undefined，metadata 就不带 model）。
   * 同时供 `/model`（可选模型）与 `/thinking`（该模型支持的 reasoning effort）的
   * 二级菜单选项——这两项都是 app-server 的运行时事实，不能写死在命令词表里。
   */
  #modelListCache: {
    defaultId: string | undefined;
    byId: Map<string, { provider: string; displayName: string | undefined; defaultReasoningEffort: string | undefined }>;
    /** `/model` 的备选（已滤掉 hidden）。 */
    models: RuntimeSlashCommandOption[];
    /** 模型 id → 该模型支持的 reasoning effort 选项（`/thinking` 用）。 */
    effortsByModel: Map<string, RuntimeSlashCommandOption[]>;
  } | undefined;
  #integrationCatalog = new Map<string, IntegrationCatalog>();
  /**
   * 挂着有头窗口的 thread 集合 +「至少见到过一次 TUI 进程」的标记。
   * 新会话的 TUI 要等首轮 turn 落盘后才由 powershell 轮询拉起，在那之前 codex 进程
   * 还没出现——不能因为「没找到」就误判掉线，所以要先 seen 过一次才允许判定消失。
   *
   * seen 与进程匹配都以**窗口 key**（开窗时 argv 里的原始 sessionId）为单位，而不是
   * threadId：TUI 在窗口里 `/new` 或 `/resume` 切换 thread 后 argv 不变（启动时的
   * 快照），进程级信号从此只能代表「这个窗口还活着」；窗口的当前 thread 由
   * `#windowKeyByThread` 维护（切换检测收到广播后过户）。
   */
  readonly #headWindows = new Set<string>();
  readonly #headWindowSeen = new Set<string>();
  /** threadId → 窗口 key（开窗时的原始 sessionId；TUI 切换 thread 后过户给新 thread）。 */
  readonly #windowKeyByThread = new Map<string, string>();
  /** 窗口 key → 最近一次活动时刻（托管 thread 的任意通知都算）。切换归属的启发式依据。 */
  readonly #windowActivity = new Map<string, number>();
  /** TUI 切换宽限定时器（规避 Host 自己 activate 的广播竞态）；app-server 退出时统一清。 */
  readonly #switchTimers = new Set<NodeJS.Timeout>();
  /** Host 自己的 thread/start|resume|fork 在途计数：>0 时收到的广播先宽限，不当成 TUI 切换。 */
  #activating = 0;
  #watcher: NodeJS.Timeout | undefined;
  /**
   * 元数据（cwd/状态/审批）变了就喊一声：Host 借它重播 runtime.online，
   * 让手机主页面那些 Codex 卡片保持如实。在 #publishMetadataEvent 里触发。
   * 做成实例字段（而非 options）是因为 Host 在 create 之后才挂上它。
   */
  onMetadataChange: (() => void) | undefined;
  onArchiveChange: ((sessionId: string, archived: boolean) => void) | undefined;
  /**
   * app-server 子进程退出时的通知（Host 借它向手机广播 runtime.offline）。
   * 第二个参数是退出前仍活跃的 thread 目录——thread 状态已随进程消失，
   * Host 必须用这份快照逐个广播 offline。同 onMetadataChange：create 之后才挂上。
   */
  onOffline: ((reason: string, runtimes: RuntimeMetadata[]) => void) | undefined;

  constructor(options: CodexRuntimeOptions) {
    this.runtimeId = options.runtimeId ?? CODEX_RUNTIME_ID;
    this.#options = options;
    this.#eventSink = options.onEvent;
    this.#server = options.server;
    options.server.onNotification = (method: string, params: unknown) => {
      void this.#handleNotification(method, params).catch((error: unknown) => {
        options.log?.(`处理 app-server 通知 ${method} 失败：${describeError(error)}`);
      });
    };
    options.server.onServerRequest = (request: CodexServerRequest) => {
      this.#handleServerRequest(request);
    };
    options.server.onDiagnostic = (message) => {
      for (const thread of this.#threads.values()) {
        if (thread.turnInProgress) this.#reportError(thread, message);
      }
    };
    options.server.onExit = (code: number | null) => {
      // 子进程意外退出：取消设备侧进行中的审批和未确认提交，排队
      // 消息与 thread 状态一并作废（内存 thread 已随进程消失）。offline 广播需要
      // 退出前的目录快照，所以在清空之前取好交给上层。
      const runtimes = this.directoryEntries();
      for (const [requestId, approval] of this.#approvals) {
        clearTimeout(approval.timer);
        this.#emit(approval.threadId, { type: "interaction.cancelled", requestId, reason: "disconnected" });
        for (const commandId of approval.submitted?.commandIds ?? []) {
          this.#commandResult(approval.threadId, commandId, false, "Codex 已断开，无法确认批准结果");
        }
      }
      this.#approvals.clear();
      for (const pending of this.#permissionUpdates.values()) pending.reject(new Error("Codex 已断开，无法确认权限设置"));
      this.#permissionUpdates.clear();
      this.#effectiveSettings.clear();
      this.#observedSettings.clear();
      this.#threads.clear();
      this.#headWindows.clear();
      this.#headWindowSeen.clear();
      this.#windowKeyByThread.clear();
      this.#windowActivity.clear();
      for (const timer of this.#switchTimers) clearTimeout(timer);
      this.#switchTimers.clear();
      this.#stopHeadWatcher();
      this.#started = false;
      const reason = `codex app-server 已退出（code=${code ?? "signal"}）`;
      options.log?.(reason);
      this.onOffline?.(reason, runtimes);
    };
  }

  get handlesRequests(): boolean {
    return this.#started;
  }

  /** 是否挂着活跃 thread：Host 的进程目录只在这时收录 Codex（§8.1）。 */
  get hasActiveThread(): boolean {
    return this.#threads.size > 0;
  }

  /** 某 thread 的对外 runtimeId（每个活跃 thread 一条独立进程卡）。 */
  runtimeIdFor(threadId: string): string {
    return `${this.runtimeId}:${threadId}`;
  }

  /** 新建 ThreadState（三处构造点共用，避免漏字段）。 */
  #newThreadState(id: string, cwd: string, overrides?: Partial<Pick<ThreadState, "name" | "model" | "effort">>): ThreadState {
    return {
      id,
      cwd,
      name: overrides?.name,
      entries: [],
      itemOrder: [],
      committedItemCount: 0,
      completedItems: new Map(),
      entryTurns: new Map(),
      turnOrder: [],
      turnInProgress: false,
      turnId: undefined,
      turnStartedAt: undefined,
      streamingMessageId: undefined,
      queue: [],
      persistedMessageMappings: [],
      toolNames: new Map(),
      model: overrides?.model,
      modelProvider: undefined,
      effort: overrides?.effort,
      contextUsage: undefined,
      modelId: undefined,
      modelName: undefined,
      permissions: this.#observedSettings.get(id),
      approvalItems: new Map(),
      lastError: undefined,
      waitingForApproval: false,
    };
  }

  /** 单个 thread 的 runtime 元数据。 */
  threadMetadata(thread: ThreadState): RuntimeMetadata {
    const model = this.#modelInfoFor(thread);
    const thinkingLevel = thread.effort ?? (
      model === undefined ? undefined : this.#modelListCache?.byId.get(model.id)?.defaultReasoningEffort
    );
    const contextUsage = thread.contextUsage === undefined ? undefined : {
      tokens: Math.round(thread.contextUsage.tokens),
      contextWindow: Math.round(thread.contextUsage.window),
      percent: thread.contextUsage.window > 0
        ? (thread.contextUsage.tokens / thread.contextUsage.window) * 100
        : null,
    };
    return {
      runtimeId: this.runtimeIdFor(thread.id),
      name: "Codex",
      cwd: thread.cwd,
      status: this.#statusOf(thread),
      sessionId: thread.id,
      ...(thread.name === undefined ? {} : { sessionName: thread.name }),
      sessionGraphSync: true,
      sessionLeafId: thread.entries.at(-1)?.entryId ?? null,
      ...(model === undefined ? {} : { model }),
      ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
      ...(contextUsage === undefined ? {} : { contextUsage }),
      permissions: thread.permissions ?? { sandbox: "unknown", approvalPolicy: "unknown" },
    };
  }

  /**
   * 这个 thread 的模型信息。优先使用 thread/start|resume 返回的会话模型；
   * 没有显式模型时才回退到 app-server 的默认模型。
   * displayName 优先（"GPT-5.5" 比美化过的 id 更准），没有就交给 APP 美化 id。
   */
  #modelInfoFor(thread: ThreadState): RuntimeModelInfo | undefined {
    const id = thread.model ?? this.#modelListCache?.defaultId;
    if (id === undefined) return undefined;
    const cached = this.#modelListCache?.byId.get(id);
    return {
      provider: thread.modelProvider ?? cached?.provider ?? "openai",
      id,
      ...(cached?.displayName === undefined ? {} : { name: cached.displayName }),
    };
  }

  /** 进程目录条目：每个挂着活跃 thread 的会话一条进程（空壳不进目录，§8.1）。 */
  directoryEntries(): RuntimeMetadata[] {
    if (!this.#started) return [];
    return [...this.#threads.values()].map((thread) => this.threadMetadata(thread));
  }

  /** 标记已就绪（host-service 在 server 握手成功后调用）。 */
  markStarted(): void {
    this.#started = true;
    void this.#loadModelList().catch(() => undefined);
  }

  /**
   * 启动时探一次 `model/list`，缓存默认模型 id 与 displayName。app-server 的 thread
   * 快照不带 model，`thread/list` 也只有 modelProvider——离开这份缓存就没法告诉手机
   * 「你正在用哪个模型」。失败静默（metadata 就不带 model，APP 自然降级）。
   */
  async #loadModelList(): Promise<void> {
    const result = (await this.#server.request("model/list", {})) as { data?: unknown };
    const list = Array.isArray(result.data) ? result.data : [];
    const byId = new Map<string, {
      provider: string;
      displayName: string | undefined;
      defaultReasoningEffort: string | undefined;
    }>();
    const models: RuntimeSlashCommandOption[] = [];
    const effortsByModel = new Map<string, RuntimeSlashCommandOption[]>();
    let defaultId: string | undefined;
    for (const entry of list) {
      if (entry === null || typeof entry !== "object") continue;
      const model = entry as Record<string, unknown>;
      const id = model.id ?? model.model;
      if (typeof id !== "string") continue;
      const displayName = typeof model.displayName === "string" ? model.displayName : undefined;
      const defaultReasoningEffort = typeof model.defaultReasoningEffort === "string"
        ? model.defaultReasoningEffort
        : undefined;
      byId.set(id, { provider: "openai", displayName, defaultReasoningEffort });
      if (model.isDefault === true && defaultId === undefined) defaultId = id;
      // `/model` 的二级菜单：隐藏模型（app-server 明确标 hidden）与子代理专用模型不上桌。
      if (model.hidden !== true) {
        models.push({
          value: id,
          label: displayName ?? id,
          ...(typeof model.description === "string" && model.description.length > 0
            ? { description: model.description }
            : {}),
        });
      }
      // `/thinking` 的可选项取决于模型：每个模型各自声明支持的 reasoning effort。
      effortsByModel.set(id, readReasoningEfforts(model));
    }
    // 没有显式默认就取第一条（model/list 首条通常就是默认）。
    this.#modelListCache = {
      defaultId: defaultId ?? byId.keys().next().value,
      byId,
      models,
      effortsByModel,
    };
    this.#options.log?.(
      `Codex 模型表已缓存：${byId.size} 条，默认=${this.#modelListCache.defaultId ?? "<无>"}`,
    );
    // 已经活跃的 thread 逐个补一份 metadata：拿到模型名后模型标签才有值。
    // capabilities 也要重发——`/model` `/thinking` 的选项来自这份缓存，缓存到位前
    // 那两个命令只能退化成纯文本输入（手机看到的就是「切不出二级菜单」）。
    for (const thread of this.#threads.values()) {
      this.#emit(thread.id, { type: "runtime.metadata", metadata: this.threadMetadata(thread) });
      this.#publishCapabilities(thread);
    }
  }

  /**
   * 广播 `runtime.capabilities`（spec §9.1 / §13.3）。codex 支持的命令是 app-server
   * RPC 能一一兑现的那个子集；APP 只渲染发布出来的命令，未声明即不出现。
   *
   * **必须按 thread 粒度发**：codex 的对外 runtimeId 是 `codex:<threadId>`（每个活跃
   * thread 一条进程），而 APP 把 capabilities 按 runtimeId 存取、且在收到该 runtimeId
   * 的 `runtime.online` 时会因 session 变化清掉「没有提前到达」的那份。挂在裸 `codex`
   * 上会永远对不上号（手机菜单空）。没有活跃 thread 时不发——那时也没有在线进程卡。
   */
  #publishCapabilities(thread: ThreadState): void {
    this.#emit(thread.id, { type: "runtime.capabilities", capabilities: this.capabilities(thread) });
  }

  async #refreshIntegrationCatalog(thread: ThreadState): Promise<void> {
    const commands: DynamicSlashCommand[] = [];
    const seen = new Set(CODEX_SLASH_COMMANDS.map((command) => command.name));
    try {
      const skills = await this.#server.request("skills/list", { cwds: [thread.cwd] }) as { data?: unknown };
      for (const command of skillCommands(skills.data)) {
        if (seen.has(command.name)) continue;
        seen.add(command.name);
        commands.push(command);
      }
    } catch (error) {
      this.#options.log?.(`Codex skills/list 失败：${describeError(error)}`);
    }
    try {
      const mcp = await this.#server.request("mcpServerStatus/list", {
        threadId: thread.id,
        detail: "toolsAndAuthOnly",
      }) as { data?: unknown };
      for (const command of mcpCommands(mcp.data)) {
        if (seen.has(command.name)) continue;
        seen.add(command.name);
        commands.push(command);
      }
    } catch (error) {
      this.#options.log?.(`Codex mcpServerStatus/list 失败：${describeError(error)}`);
    }
    const previous = this.#integrationCatalog.get(thread.cwd);
    const changed = previous === undefined
      ? commands.length > 0
      : JSON.stringify(previous.commands) !== JSON.stringify(commands);
    this.#integrationCatalog.set(thread.cwd, { commands });
    if (changed) this.#publishCapabilities(thread);
  }

  /**
   * 本后端声明的能力。当前只有 Slash 命令词表（`RuntimeCapabilitiesSchema` 的唯一字段）；
   * 文件下载等能力尚未接线，故意缺席（APP 据此自然降级，不按 agentKind 特判）。
   *
   * `/model` 与 `/thinking` 带**选项**（`argument.kind = "select"`）：APP 只在拿到
   * select 选项时才渲染二级菜单，写成 text 的话用户只能手打模型 id（难点也正是
   * 「切不出二级菜单」）。选项来自 `model/list` 缓存：
   * - `/model`：全部非 hidden 模型；
   * - `/thinking`：**当前会话模型**支持的 reasoning effort（每个模型不一样）。
   *
   * 缓存缺席（`model/list` 还没回来或失败）时退回纯文本参数——降级但不报错，
   * 缓存到位后 `#loadModelList` 会重发一份带选项的 capabilities。
   */
  capabilities(thread?: ThreadState): RuntimeCapabilities {
    const cache = this.#modelListCache;
    const activeThread = thread ?? [...this.#threads.values()].at(-1);
    const builtins = CODEX_SLASH_COMMANDS.map((command): RuntimeSlashCommand => {
      // `/tree` 的选项来自当前 thread 的条目图，和 model/list 缓存无关，所以放在缓存早退之前。
      // 没有活跃 thread 时不发选项——那时也没有会话历史可看。
      if (command.name === "tree") {
        return activeThread === undefined
          ? command
          : { ...command, argument: { kind: "tree", required: false, options: codexTreeOptions(activeThread) } };
      }
      if (cache === undefined) return command;
      if (command.name === "model") {
        return { ...command, argument: { kind: "select", required: true, options: cache.models } };
      }
      if (command.name === "thinking") {
        const modelId = thread?.model ?? cache.defaultId;
        const options = modelId === undefined ? undefined : cache.effortsByModel.get(modelId);
        if (options !== undefined && options.length > 0) {
          return { ...command, argument: { kind: "select", required: true, options } };
        }
        return command;
      }
      return command;
    });
    const dynamic = activeThread === undefined ? [] : this.#integrationCatalog.get(activeThread.cwd)?.commands ?? [];
    const names = new Set(builtins.map((command) => command.name));
    return { commands: [...builtins, ...dynamic.filter((command) => !names.has(command.name))] };
  }

  /**
   * app-server 的 WebSocket 端点（`ws://127.0.0.1:<port>`），host-service 开有头
   * 窗口时用它把官方 TUI attach 上来（`codex resume <id> --remote <endpoint>`）。
   * 测试桩没有 server 时为 undefined，开窗自动跳过。
   */
  get endpoint(): string | undefined {
    return this.#server.endpoint;
  }

  /**
   * 替换事件出口（host-service 挂上广播用）。传 `undefined` 暂停外发，
   * 事件本身（条目图、状态）仍在本地累积，不丢。
   */
  setEventSink(sink: ((event: RuntimeEvent, threadId: string | undefined) => void) | undefined): void {
    this.#eventSink = sink;
  }

  #statusOf(thread: ThreadState): RuntimeStatus {
    if (thread.waitingForApproval) return "waiting_local_interaction";
    for (const approval of this.#approvals.values()) {
      if (approval.threadId === thread.id && approval.blocking) return "waiting_local_interaction";
    }
    return thread.turnInProgress ? "running" : "idle";
  }

  // ── AgentBackend 统一端口（spec §7.4 的适配器收口） ─────────────────────────

  get kind(): AgentKind {
    return "codex";
  }

  isReady(): boolean {
    return this.#started;
  }

  /** 裸 `codex` 与 `codex:<threadId>` 都归本后端。 */
  ownsRuntime(runtimeId: string): boolean {
    return runtimeId === this.runtimeId || runtimeId.startsWith(`${this.runtimeId}:`);
  }

  /** 从对外 runtimeId 反解 threadId；裸 `codex` 落到最近激活的 thread（兼容）。 */
  #threadIdOf(runtimeId: string): string | undefined {
    if (runtimeId.startsWith(`${this.runtimeId}:`)) return runtimeId.slice(this.runtimeId.length + 1);
    return [...this.#threads.values()].at(-1)?.id;
  }

  dispatchCommand(runtimeId: string, commandId: string, command: RuntimeCommand): CommandDispatch {
    if (!this.ownsRuntime(runtimeId)) return "offline";
    // 没有任何活跃 thread 时仍要走 handleCommand：不认识的命令照样回
    // unsupported_command（后端在线但做不到 ≠ runtime 掉线）。
    return this.handleCommand(command, commandId, this.#threadIdOf(runtimeId)) ? "handled" : "unsupported";
  }

  // ── 会话目录与激活 ───────────────────────────────────────────────────────────

  async currentProvider(): Promise<string | undefined> {
    try {
      const result = object(await this.#server.request("config/read", { includeLayers: false }, 5_000));
      if (result.config === null || typeof result.config !== "object" || Array.isArray(result.config)) return undefined;
      const config = object(result.config);
      const provider = config.model_provider;
      return provider == null ? "openai" : codexProviderId(provider);
    } catch (error) {
      this.#options.log?.(`读取 Codex 当前 provider 失败：${describeError(error)}`);
      return undefined;
    }
  }

  /** Persistent thread catalog, with a rollout fallback when app-server discovery fails. */
  async catalog(archived = false): Promise<AgentSessionSummary[]> {
    const limit = 200;
    let live: AgentSessionSummary[] = [];
    try {
      const result = (await this.#server.request("thread/list", { limit, modelProviders: [], ...(archived ? { archived: true } : {}) })) as {
        data?: Array<Record<string, unknown>>;
      };
      live = (result.data ?? []).flatMap((thread): AgentSessionSummary[] => {
        const id = thread.id;
        const cwd = thread.cwd;
        const createdAt = toMillis(thread.createdAt);
        const modifiedAt = toMillis(thread.updatedAt);
        const name = codexSessionName(thread.name);
        const modelProvider = codexProviderId(thread.modelProvider);
        if (typeof id !== "string" || typeof cwd !== "string" || createdAt === undefined || modifiedAt === undefined) {
          return [];
        }
        return [{
          sessionId: id,
          cwd,
          hostname: localHostname(),
          ...(name === undefined ? {} : { name }),
          ...(typeof thread.preview === "string" && thread.preview.length > 0
            ? { firstMessage: thread.preview.slice(0, 4_000) }
            : {}),
          createdAt,
          modifiedAt,
          messageCount: Array.isArray(thread.turns) ? thread.turns.length : 0,
          agentKind: "codex",
          archived,
          ...(modelProvider === undefined ? {} : { modelProvider }),
        }];
      });
    } catch (error) {
      // app-server 暂时没就绪（启动中/已退出）不拖垮整个目录：磁盘 rollout 还在。
      this.#options.log?.(`thread/list 失败，目录只含磁盘 rollout：${describeError(error)}`);
    }
    const disk = await this.#diskCatalog(archived);
    const diskById = new Map(disk.map((entry) => [entry.sessionId, entry]));
    const liveIds = new Set(live.map((entry) => entry.sessionId));
    return [
      ...live.map((entry) => {
        const modelProvider = entry.modelProvider ?? diskById.get(entry.sessionId)?.modelProvider;
        return modelProvider === undefined ? entry : { ...entry, modelProvider };
      }),
      ...disk.filter((entry) => !liveIds.has(entry.sessionId)),
    ];
  }

  /** 扫磁盘 rollout 目录。同名会话（fork/重复）取 modifiedAt 最新的那份。 */
  async #diskCatalog(archived = false): Promise<AgentSessionSummary[]> {
    const sessionsRoot = this.#options.rolloutRoot ?? join(homedir(), ".codex", "sessions");
    const root = archived ? join(dirname(sessionsRoot), "archived_sessions") : sessionsRoot;
    let names: string[];
    try {
      // recursive readdir 返回相对路径（分隔符随平台），按文件名匹配、不看目录层级。
      names = (await readdir(root, { recursive: true }))
        .filter((name) => name.endsWith(".jsonl") && name.split(/[\\/]/).pop()?.startsWith("rollout-") === true);
    } catch {
      return []; // 没装 codex / 目录不存在：磁盘目录为空，不是错误。
    }
    const byId = new Map<string, AgentSessionSummary>();
    await Promise.all(names.map(async (name) => {
      const entry = await readRolloutSummary(join(root, name));
      if (entry === undefined) return;
      const existing = byId.get(entry.sessionId);
      if (existing === undefined || existing.modifiedAt < entry.modifiedAt) byId.set(entry.sessionId, entry);
    }));
    // 目录是发给手机的单条 E2E 消息：历史太久会把它撑到兆级（中继可能拒收大帧），
    // 只保留最近的 200 条（与 thread/list 的 limit 语义一致）。
    return [...byId.values()].sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, 200)
      .map((entry) => ({ ...entry, archived }));
  }

  async setArchived(sessionId: string, archived: boolean): Promise<void> {
    const thread = this.#threads.get(sessionId);
    if (thread !== undefined && (this.#statusOf(thread) !== "idle" || thread.queue.length > 0)) {
      throw new SessionArchiveError("session_busy", "请等待 Codex 完成当前任务后再归档");
    }
    // Read the native path, including archived sessions, to make a repeated desired-state request safe.
    const before = await this.#server.request("thread/read", { threadId: sessionId }) as {
      thread?: { path?: string; status?: { type?: string } };
    };
    if (before.thread?.status?.type === "active") {
      throw new SessionArchiveError("session_busy", "请等待 Codex 完成当前任务后再归档");
    }
    const path = before.thread?.path;
    if (path === undefined) throw new SessionArchiveError("session_not_found", "会话尚未保存，无法归档");
    const wasArchived = path.split(/[\\/]/).includes("archived_sessions");
    if (wasArchived !== archived) {
      await this.#server.request(archived ? "thread/archive" : "thread/unarchive", { threadId: sessionId });
    }
    if (archived) this.#deactivateThread(sessionId, "会话已归档");
  }

  /**
   * 激活（resume 已有 thread / 新建 thread）。返回 sessionId 给 `session.activated` 回执。
   * 成功后主动回放该 thread 的历史条目图，手机打开即见全部内容；随后在电脑上开
   * 有头终端窗口（官方 TUI attach 上来，与手机双同步）。
   */
  async activate(target: AgentActivateTarget): Promise<BackendActivation> {
    // 在途计数：activate 的 thread/start|resume 广播可能先于 RPC 响应到达，此刻
    // thread 还没进 #threads。计数 >0 时切换检测先宽限，避免把自家广播当 TUI 切换。
    this.#activating += 1;
    try {
      return await this.#activateInner(target);
    } finally {
      this.#activating -= 1;
    }
  }

  async #activateInner(target: AgentActivateTarget): Promise<BackendActivation> {
    const method = target.type === "resume" ? "thread/resume" : "thread/start";
    const params = target.type === "resume" ? { threadId: target.sessionId } : { cwd: target.cwd };
    const result = (await this.#server.request(method, params)) as {
      thread?: Record<string, unknown>;
      model?: unknown;
      modelProvider?: unknown;
    };
    const threadJson = result.thread;
    const id = threadJson?.id;
    const cwd = threadJson?.cwd;
    if (typeof id !== "string" || typeof cwd !== "string") {
      throw new Error(`app-server 的 ${method} 响应缺少 thread.id/cwd`);
    }
    const thread: ThreadState = this.#newThreadState(id, cwd, {
      name: codexSessionName(threadJson?.name),
      model: typeof result.model === "string" ? result.model : undefined,
    });
    thread.modelProvider = typeof result.modelProvider === "string" ? result.modelProvider : undefined;
    thread.permissions = codexPermissions(result) ?? thread.permissions;
    if (codexPermissions(result)) this.#effectiveSettings.set(id, object(result));
    this.#threads.set(id, thread);
    void this.#checkSandboxReadiness(thread);
    void this.#refreshIntegrationCatalog(thread);
    this.#replayTurns(thread, threadJson);
    // thread/resume 对旧 rollout 只给 turns 骨架（items 全空），app-server v2 拿不出 UI
    // item——磁盘兜底重建条目图给手机端用。TUI 端对旧会话也渲染不出历史（codex 限制），
    // 但仍要开窗：「在线」严格绑定「电脑上有 TUI 窗口在」，不开窗就会变成「没 TUI 却
    // 在线」的假象（关窗即下线靠看门狗轮询）。空窗的代价低于显示/状态不一致。
    if (thread.itemOrder.length === 0) {
      // A new app-server thread gets its rollout path before the first turn, but Codex
      // does not create that file until the first message is sent. An absent path is
      // therefore an expected empty history for `thread/start`; an existing session
      // still treats the same condition as an unreadable history.
      await this.#replayFromRollout(thread, target.type === "new");
    }
    // #publishMetadataEvent 里会一并补发 capabilities（按 thread 粒度），无需重复。
    this.#publishMetadataEvent(thread);
    // 历史由设备的有界 session.sync 请求加载，metadata 不附带无人请求的整图。
    this.#openHeadWindow(id, cwd);
    this.#options.log?.(`Codex 会话已激活：${id}（cwd=${cwd}）`);
    return { sessionId: id, spawnMode: "tui" };
  }

  /**
   * 在电脑上开一个可见终端跑官方 codex TUI（`--remote` attach 到本 app-server）。
   * 实测（2026-09-14）：`--remote` 不绕过本地 session 解析——rollout 首轮对话才落盘，
   * 所以窗口先开、内嵌等待循环轮询 rollout，一落盘立即自动 attach。
   * endpoint 未知（测试桩 / app-server 未就绪）时静默跳过；`PI_REMOTE_CODEX_HEAD=0` 关掉。
   */
  #openHeadWindow(sessionId: string, cwd: string): void {
    const endpoint = this.#server.endpoint;
    if (endpoint === undefined) return;
    const opener = this.#options.openHeadWindow ?? defaultOpenHeadWindow;
    const codexCommand = this.#server.codexCommand;
    opener({ sessionId, cwd, endpoint, ...(codexCommand === undefined ? {} : { codexCommand }) });
    this.#options.log?.(
      `Codex 有头窗口已打开（等 rollout 后 remote attach）：sessionId=${sessionId} cwd=${cwd} endpoint=${endpoint}`,
    );
    // 看门狗只跟「生产开窗」：endpoint 未定义（测试桩 / app-server 未就绪）或
    // 显式关掉 HEAD 时不启。wt.exe 一启动就把窗口交给常驻 WindowsTerminal 进程后
    // 自己立刻退出，没法靠 child.on("exit")——只能轮询真正的 codex/node TUI 进程。
    if (process.env.PI_REMOTE_CODEX_HEAD !== "0") {
      this.#windowKeyByThread.set(sessionId, sessionId);
      this.#windowActivity.set(sessionId, Date.now());
      this.#headWindows.add(sessionId);
      this.#startHeadWatcher();
    }
  }

  #startHeadWatcher(): void {
    if (this.#watcher !== undefined) return;
    this.#watcher = setInterval(() => {
      void this.#checkHeadWindows().catch((error: unknown) => {
        this.#options.log?.(`Codex 有头窗口看门狗出错：${describeError(error)}`);
      });
    }, 5_000);
    this.#watcher.unref?.();
  }

  #stopHeadWatcher(): void {
    if (this.#watcher === undefined) return;
    clearInterval(this.#watcher);
    this.#watcher = undefined;
  }

  /**
   * 轮询本机进程，找出「attach 到本 app-server 的 codex TUI」。wt.exe 把窗口交给
   * 常驻 WindowsTerminal 后自己就退了，所以只认真正的 TUI 进程（codex.exe / 跑 codex.js
   * 的 node.exe）——它们的命令行里有 `--remote <本端点>`。powershell 宿主不算（它即便
   * 在 codex 退出后还会因 -NoExit 留着，不能拿来当「会话还活着」）。
   */
  async #checkHeadWindows(): Promise<void> {
    if (this.#headWindows.size === 0) {
      this.#stopHeadWatcher();
      return;
    }
    const endpoint = this.#server.endpoint;
    if (endpoint === undefined) return;
    const alive = await this.#pollTuiProcesses(endpoint);
    for (const id of [...this.#headWindows]) {
      // 进程匹配按窗口 key（argv 快照），不是 threadId：TUI 切过 thread 后 argv 不变。
      const key = this.#windowKeyByThread.get(id) ?? id;
      if (alive.has(key)) {
        this.#headWindowSeen.add(key);
        continue;
      }
      if (!this.#headWindowSeen.has(key)) continue; // TUI 还没被 powershell 拉起来，先放过
      this.#deactivateThread(id, "Codex TUI 窗口已关闭");
    }
  }

  async #pollTuiProcesses(endpoint: string): Promise<Set<string>> {
    if (this.#options.pollTuiProcesses !== undefined) return this.#options.pollTuiProcesses(endpoint);
    return new Promise((resolve) => {
      // endpoint 是我们自己 freePort 出来的值，不存在注入面。-like 通配。
      const script =
        `Get-CimInstance Win32_Process -Filter "Name='codex.exe' OR Name='node.exe'" ` +
        `-Property ProcessId,CommandLine ` +
        `| Where-Object { $_.CommandLine -like '*${endpoint}*' } ` +
        `| ForEach-Object { $_.CommandLine }`;
      const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
      let out = "";
      child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
      child.on("error", () => resolve(new Set()));
      child.on("exit", () => {
        const ids = new Set<string>();
        for (const line of out.split("\n")) {
          const match = line.match(/resume\s+([0-9a-fA-F-]{30,})/);
          if (match !== null && match[1] !== undefined) ids.add(match[1].toLowerCase());
        }
        resolve(ids);
      });
    });
  }

  /**
   * 单 thread 因 TUI 关闭而下线：从活跃表移除、清掉它的审批（按拒绝回，别挂 turn）、
   * 退出口径广播 offline 让手机删卡。onOffline 复用 app-server 整体退出那条路径——
   * 对 Host 而言都是「这几个 runtimeId 掉线了，逐个广播」。
   */
  #deactivateThread(threadId: string, reason: string): void {
    const thread = this.#threads.get(threadId);
    if (thread === undefined) return;
    const metadata = this.threadMetadata(thread);
    this.#permissionUpdates.get(threadId)?.reject(new Error(reason));
    this.#effectiveSettings.delete(threadId);
    for (const [requestId, approval] of this.#approvals) {
      if (approval.threadId !== threadId) continue;
      clearTimeout(approval.timer);
      if (approval.submitted === undefined) approval.serverRequest.respond(approval.interaction.decline);
      this.#emit(threadId, { type: "interaction.cancelled", requestId, reason: "owner_closed" });
      for (const commandId of approval.submitted?.commandIds ?? []) this.#commandResult(threadId, commandId, false, reason);
      this.#approvals.delete(requestId);
    }
    this.#threads.delete(threadId);
    this.#headWindows.delete(threadId);
    const windowKey = this.#windowKeyByThread.get(threadId);
    this.#windowKeyByThread.delete(threadId);
    if (windowKey === undefined) {
      this.#headWindowSeen.delete(threadId);
    } else {
      this.#headWindowSeen.delete(windowKey);
      this.#windowActivity.delete(windowKey);
    }
    this.#options.log?.(`Codex 会话已下线：${threadId}（${reason}）`);
    this.onMetadataChange?.();
    this.onOffline?.(reason, [metadata]);
  }

  /**
   * thread/resume|start 返回的 turns → 条目图（只回放，不重发流式事件）。
   *
   * 这是**重建**：先清掉既有条目再按 turns 顺序重灌。历史回退（`thread/revert`）之后也走
   * 这里——那次调用拿到的就是截断后的新前缀，不能只往旧条目上追加。
   */
  #replayTurns(thread: ThreadState, threadJson: Record<string, unknown> | undefined): void {
    if (typeof threadJson?.path === "string" && isAbsolute(threadJson.path)) thread.rolloutPath = threadJson.path;
    const turns = threadJson?.turns;
    if (!Array.isArray(turns)) return;
    const previous = new Map(thread.entries.map((entry) => [entry.entryId, entry]));
    thread.entries = [];
    delete thread.historyError;
    thread.itemOrder = [];
    thread.completedItems.clear();
    thread.committedItemCount = 0;
    thread.entryTurns.clear();
    thread.turnOrder = [];
    for (const turn of turns) {
      if (turn === null || typeof turn !== "object") continue;
      const items = (turn as { items?: unknown }).items;
      if (!Array.isArray(items)) continue;
      // turn.id 就是历史回退的边界单位（`thread/revert` 的 beforeTurnId），顺手记下来。
      const turnId = (turn as { id?: unknown }).id;
      const owner = typeof turnId === "string" && turnId.length > 0 ? turnId : undefined;
      if (owner !== undefined && !thread.turnOrder.includes(owner)) thread.turnOrder.push(owner);
      for (const item of items) {
        if (item !== null && typeof item === "object") {
          const record = item as Record<string, unknown>;
          this.#noteItem(thread, record);
          const turnRunning = (turn as { status?: unknown }).status === "inProgress";
          const itemRunning = record.status === "inProgress" || record.status === "in_progress";
          const itemFinished = record.status === "completed" || record.status === "failed" || record.status === "declined";
          if (!itemRunning && (!turnRunning || itemFinished || record.type === "userMessage")) {
            this.#completeItem(thread, record, owner);
          }
        }
      }
    }
    for (const entry of thread.entries) {
      const old = previous.get(entry.entryId);
      if (old !== undefined && !isDeepStrictEqual(old, entry)) thread.historyError = "canonical_entry_conflict";
    }
  }

  /**
   * resume 拿不到 items 时的兑底：直接读磁盘 rollout 重建条目图。
   *
   * 旧格式（≈0.20 之前）的 rollout，app-server 的 thread/resume 只给 turns 骨架
   * （items 全空，`itemsView: "summary"`；thread/turns/items/list 与 thread/read 的 includeTurns 也都空），
   * 但 rollout 文件里每条 `event_msg(item_completed)` 都有完整 item——只是 item.type
   * 是 PascalCase（UserMessage/AgentMessage…），映射前先归一化成 camelCase。
   */
  async #replayFromRollout(thread: ThreadState, allowMissing = false): Promise<void> {
    const root = this.#options.rolloutRoot ?? join(homedir(), ".codex", "sessions");
    let paths: string[];
    try {
      paths = thread.rolloutPath === undefined
        ? (await readdir(root, { recursive: true }))
          .filter((candidate) => candidate.endsWith(".jsonl") && candidate.split(/[\\/]/).pop()?.includes(thread.id) === true)
          .map((name) => join(root, name))
        : [thread.rolloutPath];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && thread.rolloutPath === undefined) return;
      thread.historyError = "rollout_unreadable";
      return;
    }
    const matches: string[] = [];
    for (const path of paths) {
      try {
        const text = await readFile(path, "utf8");
        const first = parseJsonLine(text.split("\n", 1)[0] ?? "");
        const meta = first?.type === "session_meta" ? first.payload as { id?: unknown } | undefined : undefined;
        if (meta?.id === thread.id) matches.push(text);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && allowMissing) return;
        thread.historyError = "rollout_unreadable";
        return;
      }
    }
    // A longer file can be an obsolete pre-revert history. Only the backend's explicit path
    // disambiguates two copies of one Session; directory order and file size cannot.
    if (matches.length > 1) { thread.historyError = "rollout_ambiguous"; return; }
    const text = matches[0];
    if (text === undefined) {
      if (paths.length > 0) thread.historyError = "rollout_session_mismatch";
      return;
    }
    // 同一趟扫描里顺带划出 turn 边界：rollout 的 `turn_context` / `task_started` 都带
    // `turn_id`，item 就归到最近一个边界上。不这么做，磁盘回放出来的条目就没法参与
    // 历史树的「从这里继续」（revert 要的是 turn id）。
    let currentTurnId: string | undefined;
    const lines = text.split("\n");
    for (const [index, line] of lines.entries()) {
      if (line.trim().length === 0) continue;
      const parsed = parseJsonLine(line);
      if (parsed === undefined) {
        // A file can be observed halfway through appending its final line. Never cross a
        // malformed line in the middle and splice unrelated suffixes onto the last good node.
        if (index !== lines.length - 1) thread.historyError = "rollout_invalid";
        break;
      }
      const payload = typeof parsed.payload === "object" && parsed.payload !== null
        ? (parsed.payload as { item?: unknown; turn_id?: unknown })
        : undefined;
      const turnId = typeof payload?.turn_id === "string" && payload.turn_id.length > 0
        ? payload.turn_id
        : undefined;
      if (turnId !== undefined) currentTurnId = turnId;
      if ((payload as { type?: unknown } | undefined)?.type !== "item_completed") continue;
      const item = payload?.item;
      if (item === null || typeof item !== "object") continue;
      this.#completeItem(thread, normalizeItemTypes(item as Record<string, unknown>), currentTurnId);
    }
  }

  // ── 手机命令入口（host-service 的 runtime.command 路由到这里） ────────────────

  /**
   * 处理一条 runtime.command。返回 false 表示不认识（上层回 `unsupported_command`）。
   * `commandId` 用于 `command.result` 回执（APP 用它跟踪在途命令、展示错误）；
   * `threadId` 由 dispatchCommand 从 runtimeId（`codex:<threadId>`）反解。
   * 测试直接调 handleCommand 时可以不带后两个参数。
   */
  handleCommand(command: RuntimeCommand, commandId?: string, threadId?: string): boolean {
    // 未带 threadId（裸 `codex` runtimeId / 直调）：落到最近激活的 thread（单会话时代的语义）。
    const thread = threadId !== undefined
      ? this.#threads.get(threadId)
      : [...this.#threads.values()].at(-1);
    switch (command.type) {
      case "user_message": {
        if (thread === undefined) {
          this.#options.log?.("收到 user_message 但没有活跃 Codex 会话；忽略（手机应先 session.activate）");
          this.#commandResult(threadId, commandId, false, "没有活跃的 Codex 会话，请重新激活");
          return true;
        }
        if (thread.turnInProgress) {
          return this.#enqueueWhileBusy(thread, command, commandId);
        }
        // 空闲：起一个新 turn。用户气泡不再由本地合成回显——app-server 持久化后发出的
        // item/started(UserMessage) 是唯一上屏事件，clientUserMessageId 把 App 的
        // messageId 钉到该 item 上（clientId 原样带回），与 Pi 的 message_start 单事件链同构。
        const messageId = command.messageId ?? `user-${Date.now()}`;
        this.#commandResult(threadId, commandId, true);
        void this.#startTurn(thread, command.text, command.messageId).catch((error) => {
          this.#failTurnStart(thread, messageId, command.text, error);
          this.#commandResult(threadId, commandId, false, describeError(error));
        });
        return true;
      }
      case "user_message.cancel": {
        // 只能撤回还没开跑的排队消息；已在跑的 turn 用 stop 打断（与 Pi 一致）。
        if (thread === undefined) return true;
        const index = thread.queue.findIndex((item) => item.messageId === command.messageId);
        const removed = index < 0 ? undefined : thread.queue.splice(index, 1)[0];
        if (removed === undefined) {
          this.#commandResult(threadId, commandId, false, "消息已送达或不存在", "already_delivered");
          return true;
        }
        this.#emit(thread.id, {
          type: "message.queued",
          queueId: removed.messageId,
          text: removed.text,
          delivery: removed.delivery,
          state: "cancelled",
        });
        this.#commandResult(threadId, commandId, true, undefined, "cancelled");
        return true;
      }
      case "stop": {
        if (thread?.turnId !== undefined) {
          void this.#server.request("turn/interrupt", { threadId: thread.id, turnId: thread.turnId })
            .catch((error) => this.#options.log?.(`turn/interrupt 失败：${describeError(error)}`));
        }
        return true;
      }
      case "interaction.respond": {
        this.#resolveApproval(command, commandId, thread?.id);
        return true;
      }
      case "session.sync": {
        try {
          if (thread === undefined) throw new Error("没有活跃的 Codex 会话");
          this.#publishSnapshot(thread, command);
          this.#publishInteractions(thread.id);
          this.#commandResult(threadId, commandId, true);
        } catch (error) {
          this.#commandResult(threadId, commandId, false, describeError(error));
        }
        return true;
      }
      case "slash.execute": {
        // §9.1：slash 只走这条车道。codex 把能兑现的子集映射到 app-server RPC，
        // 未声明的命令回失败（App 菜单来自 capabilities，正常不会发到这里）。
        return this.#executeSlash(command.name, command.args, thread, threadId, commandId);
      }
      default:
        return false;
    }
  }

  /**
   * turn 进行中收到消息（对齐 runtime-bridge 的队列语义）：
   * - 无 delivery → 拒绝（Pi 空闲即发、忙时必须给 delivery，这里同样不给就退回）；
   * - steer → 打断当前 turn、插队，turn/completed 后立即开跑；
   * - followUp → 排队，轮到时按序开跑。
   * codex 没有向进行中 turn 注入消息的能力，「steer」= interrupt + 下一个跑我的。
   */
  #enqueueWhileBusy(
    thread: ThreadState,
    command: Extract<RuntimeCommand, { type: "user_message" }>,
    commandId: string | undefined,
  ): boolean {
    if (command.delivery === undefined) {
      this.#commandResult(thread.id, commandId, false, "runtime_busy");
      return true;
    }
    const messageId = command.messageId ?? `queued-${Date.now()}`;
    const queued: QueuedTurn = { messageId, text: command.text, delivery: command.delivery };
    if (command.delivery === "steer") {
      // 先插队再打断：turn/completed 里的补跑（#drainQueue）会立刻把它送上。
      thread.queue.unshift(queued);
      if (thread.turnId !== undefined) {
        void this.#server.request("turn/interrupt", { threadId: thread.id, turnId: thread.turnId })
          .catch((error) => this.#options.log?.(`turn/interrupt 失败：${describeError(error)}`));
      }
    } else {
      thread.queue.push(queued);
    }
    this.#emit(thread.id, {
      type: "message.queued",
      queueId: messageId,
      text: command.text,
      delivery: command.delivery,
      state: "accepted",
    });
    this.#commandResult(thread.id, commandId, true);
    return true;
  }

  /** turn 结束后补跑排队消息；startTurn 会重新抬起 turnInProgress，循环自然只跑一条。 */
  #drainQueue(thread: ThreadState): void {
    while (!thread.turnInProgress && thread.queue.length > 0) {
      const next = thread.queue.shift();
      if (next === undefined) return;
      this.#emit(thread.id, {
        type: "message.queued",
        queueId: next.messageId,
        text: next.text,
        delivery: next.delivery,
        state: "delivered",
      });
      void this.#startTurn(thread, next.text, next.messageId).catch((error) => {
        this.#failTurnStart(thread, next.messageId, next.text, error);
      });
    }
  }

  /**
   * `slash.execute` → app-server RPC（spec §9.1 / §13.3）。
   *
   * 只认 `CODEX_SLASH_COMMANDS` 里声明过的命令；其余回 `command.result` 失败，
   * 与 Pi 的 `slash_command_not_available` 同义（未声明即不可用）。命令语义：
   * - `/model <id>`  / `/thinking <effort>`：写会话级覆盖，随后的每个 turn 带上
   *   （app-server 的 `turn/start.model` / `.effort` 是 turn 级覆盖并延续后续 turn）；
   * - `/name [name]`：`thread/name/set`（无参查询不写入；名称来自 thread 快照与更新通知）。
   * - `/new`：`thread/start`，随后按新会话回执；
   * - `/resume <id>`：`thread/resume`；
   * - `/fork`：`thread/fork`（fork 当前 thread）。
   *
   * `thread/start|resume|fork` 会切换当前活跃 thread——这里直接走 `activate` 的同一
   * 套后处理（回放条目图 + 快照 + 开窗），保证与手机点会话的行为一致。
   */
  #executeSlash(
    name: string,
    args: string,
    thread: ThreadState | undefined,
    threadId: string | undefined,
    commandId: string | undefined,
  ): boolean {
    const arg = args.trim();
    const dynamic = thread === undefined
      ? undefined
      : this.#integrationCatalog.get(thread.cwd)?.commands.find((command) => command.name === name);
    if (dynamic !== undefined && thread !== undefined) {
      return this.#executeDynamicSlash(dynamic, arg, thread, threadId, commandId);
    }
    if (!CODEX_SLASH_COMMANDS.some((command) => command.name === name)) return false;
    switch (name) {
      case "sandbox":
      case "network":
      case "approvals":
      case "approval-reviewer": {
        if (thread === undefined) return this.#slashNoSession(threadId, commandId);
        void this.#updatePermissions(thread, name, arg, commandId);
        return true;
      }
      case "model": {
        if (thread === undefined) return this.#slashNoSession(threadId, commandId);
        if (arg.length === 0) {
          this.#commandResult(threadId, commandId, false, "/model 需要 <model-id>", "failure");
          return true;
        }
        // 模型表已缓存时校验一下：APP 的手输路径可能拼错 id，早报错好过等 turn/start 才炸。
        // 缓存缺席（model/list 没回来）就不拦——不能拿「没数据」当「不存在」。
        const known = this.#modelListCache;
        if (known !== undefined && !known.byId.has(arg)) {
          const ids = [...known.byId.keys()].join(", ");
          this.#commandResult(threadId, commandId, false, `未知模型 ${arg}；可用：${ids}`, "failure");
          return true;
        }
        thread.model = arg;
        this.#commandResult(threadId, commandId, true);
        // 换模型后 `/thinking` 的候选 effort 也跟着变（各模型支持的不一样）：
        // 元数据刷新会连同 capabilities 一起重播，手机再打开那个菜单才是对的。
        this.#publishMetadataEvent(thread);
        return true;
      }
      case "thinking": {
        if (thread === undefined) return this.#slashNoSession(threadId, commandId);
        if (arg.length === 0) {
          this.#commandResult(threadId, commandId, false, "/thinking 需要 <effort>", "failure");
          return true;
        }
        // 同上：有缓存就按当前模型支持的 effort 校验。Pi 侧不做校验（app-server 自己会拒），
        // 但早报错能省掉一次往返，也避免用户以为设置成功了。
        const cache = this.#modelListCache;
        const modelId = thread.model ?? cache?.defaultId;
        const allowed = modelId === undefined ? undefined : cache?.effortsByModel.get(modelId);
        if (allowed !== undefined && allowed.length > 0 && !allowed.some((option) => option.value === arg)) {
          const values = allowed.map((option) => option.value).join(", ");
          this.#commandResult(threadId, commandId, false, `未知 effort ${arg}；${modelId} 支持：${values}`, "failure");
          return true;
        }
        thread.effort = arg;
        this.#commandResult(threadId, commandId, true);
        this.#publishMetadataEvent(thread);
        return true;
      }
      case "name": {
        if (thread === undefined) return this.#slashNoSession(threadId, commandId);
        if (arg.length === 0) {
          // 无参查询不修改电脑端名称。
          this.#commandResult(threadId, commandId, true);
          return true;
        }
        void this.#server.request("thread/name/set", { threadId: thread.id, name: arg })
          .then(() => this.#commandResult(threadId, commandId, true))
          .catch((error) => this.#commandResult(threadId, commandId, false, describeError(error), "failure"));
        return true;
      }
      case "new":
      case "resume":
      case "fork": {
        if (name === "resume" && arg.length === 0) {
          this.#commandResult(threadId, commandId, false, "/resume 需要 <session-id>", "failure");
          return true;
        }
        const target: AgentActivateTarget =
          name === "resume"
            ? { type: "resume", sessionId: arg }
            : name === "new"
              ? { type: "new", cwd: thread?.cwd ?? process.cwd() }
              : { type: "resume", sessionId: thread?.id ?? "" };
        const activate = name === "fork"
          ? this.#forkThread(thread)
          : this.activate(target);
        void activate
          .then(() => this.#commandResult(threadId, commandId, true, undefined, "success"))
          .catch((error) => this.#commandResult(threadId, commandId, false, describeError(error), "failure"));
        return true;
      }
      case "compact": {
        if (thread === undefined) return this.#slashNoSession(threadId, commandId);
        void this.#server.request("thread/compact/start", { threadId: thread.id })
          .then(() => this.#commandResult(threadId, commandId, true))
          .catch((error) => this.#commandResult(threadId, commandId, false, describeError(error), "failure"));
        return true;
      }
      case "tree": {
        if (thread === undefined) return this.#slashNoSession(threadId, commandId);
        // 无参 = 只是想看历史：选项已经随 capabilities 发下去了，回个成功即可。
        if (arg.length === 0) {
          this.#commandResult(threadId, commandId, true, undefined, "success");
          return true;
        }
        if (thread.turnInProgress) {
          // 进行中的 turn 不能当回退边界，等它跑完再说。
          this.#commandResult(threadId, commandId, false, "runtime_busy", "failure");
          return true;
        }
        const plan = this.#treeRevertPlan(thread, arg);
        if (plan === undefined) {
          this.#commandResult(threadId, commandId, false, `未知的历史节点 ${arg}`, "failure");
          return true;
        }
        if (plan === null) {
          // 选中的就是当前末端：历史已经停在这一点上，回执成功即可。
          this.#commandResult(threadId, commandId, true, undefined, "success");
          return true;
        }
        void this.#revertThread(thread, plan.beforeTurnId)
          .then(() => {
            // 原地截断，还是同一条会话：手机不需要切任何东西。原文只在用户消息上带。
            this.#commandResult(
              threadId,
              commandId,
              true,
              undefined,
              "success",
              plan.editorText === undefined ? undefined : { editorText: plan.editorText },
            );
          })
          .catch((error) => this.#commandResult(threadId, commandId, false, describeError(error), "failure"));
        return true;
      }
      case "quit": {
        if (thread === undefined) return this.#slashNoSession(threadId, commandId);
        // 先回执再下线：command.result 是 APP 清除在途命令的依据，不能因为随后的
        // runtime.offline 而丢失。
        this.#commandResult(threadId, commandId, true, undefined, "success");
        void this.#quitThread(thread).catch((error: unknown) => {
          this.#options.log?.(`/quit 关闭 Codex TUI 失败：${describeError(error)}`);
        });
        return true;
      }
      default:
        return false;
    }
  }

  async #updatePermissions(thread: ThreadState, name: string, value: string, commandId?: string): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    let registered = false;
    try {
      if (this.#statusOf(thread) !== "idle" || thread.queue.length > 0
        || [...this.#approvals.values()].some((request) => request.threadId === thread.id)) {
        throw new Error("请先完成当前任务和待处理交互，再调整会话权限");
      }
      if (this.#permissionUpdates.has(thread.id)) throw new Error("权限设置正在应用，请等待电脑确认");
      const settings = this.#effectiveSettings.get(thread.id) ?? {};
      const patch = codexPermissionUpdate(name, value, settings);
      // app-server intentionally emits no settings notification for an unchanged value.
      if (permissionPatchMatches({ ...settings, sandboxPolicy: settings.sandboxPolicy ?? settings.sandbox }, patch)) {
        this.#commandResult(thread.id, commandId, true);
        return;
      }
      const confirmed = new Promise<void>((resolve, reject) => {
        this.#permissionUpdates.set(thread.id, { patch, resolve, reject });
        registered = true;
        timer = setTimeout(() => reject(new Error("未收到有效权限确认，请刷新会话检查结果")), 15_000);
        timer.unref();
      });
      this.#commandResult(thread.id, commandId, true, undefined, "pending");
      // The RPC acknowledges a write; only the settings notification establishes effective state.
      await Promise.all([this.#server.request("thread/settings/update", { threadId: thread.id, ...patch }), confirmed]);
      this.#commandResult(thread.id, commandId, true);
      void this.#checkSandboxReadiness(thread);
    } catch (error) {
      this.#commandResult(thread.id, commandId, false, `权限设置未确认：${describeError(error)}`);
    } finally {
      if (timer) clearTimeout(timer);
      if (registered) this.#permissionUpdates.delete(thread.id);
    }
  }

  #executeDynamicSlash(
    command: DynamicSlashCommand,
    arg: string,
    thread: ThreadState,
    threadId: string | undefined,
    commandId: string | undefined,
  ): boolean {
    if (thread.turnInProgress) {
      this.#commandResult(threadId, commandId, false, "runtime_busy", "failure");
      return true;
    }
    if (command.kind === "skill") {
      if (command.skillPath === undefined) {
        this.#commandResult(threadId, commandId, false, "skill path missing", "failure");
        return true;
      }
      const text = arg.length > 0 ? `/${command.name} ${arg}` : `/${command.name}`;
      const messageId = `slash-${Date.now()}`;
      this.#commandResult(threadId, commandId, true);
      const input = [
        { type: "skill", name: command.name, path: command.skillPath },
        ...(arg.length === 0 ? [] : [{ type: "text", text: arg }]),
      ];
      void this.#startTurnWithInput(thread, input, messageId).catch((error) => {
        this.#failTurnStart(thread, messageId, text, error);
        this.#commandResult(threadId, commandId, false, describeError(error), "failure");
      });
      return true;
    }
    if (command.mcpServer === undefined || command.mcpTool === undefined) {
      this.#commandResult(threadId, commandId, false, "mcp tool missing", "failure");
      return true;
    }
    let parsedArgs: unknown = {};
    if (arg.length > 0) {
      try {
        parsedArgs = JSON.parse(arg);
      } catch {
        this.#commandResult(threadId, commandId, false, "MCP 参数必须是 JSON object", "failure");
        return true;
      }
    }
    if (parsedArgs === null || typeof parsedArgs !== "object" || Array.isArray(parsedArgs)) {
      this.#commandResult(threadId, commandId, false, "MCP 参数必须是 JSON object", "failure");
      return true;
    }
    void this.#server.request("mcpServer/tool/call", {
      threadId: thread.id,
      server: command.mcpServer,
      tool: command.mcpTool,
      arguments: parsedArgs,
    })
      .then(() => this.#commandResult(threadId, commandId, true, undefined, "success"))
      .catch((error) => this.#commandResult(threadId, commandId, false, describeError(error), "failure"));
    return true;
  }

  /**
   * 把历史树上的节点换算成 `thread/revert` 的轮次边界——原地改写历史，和 codex 官方 TUI
   * 里「回到过去某条消息」是同一套语义，不会派生新会话。
   *
   * - 用户消息 → `beforeTurnId` = 该消息所在轮：丢掉这一轮及其之后，原文一并回给手机；
   *   用户改完重发就是「编辑这条消息并重新开始」。
   * - 助手回复 → `beforeTurnId` = 该回复所在轮的**下一轮**：那一轮之后的内容被丢掉，
   *   历史恰好留在该回复上，即「从这条回复之后继续」。它本来就是最后一轮时返回 null，
   *   表示无需改动（历史已经停在这一点）。
   *
   * 查不到轮次（条目来自旧 rollout、边界没记录）返回 undefined 让命令失败，不去猜：
   * 猜错会截掉用户还想保留的对话，代价不对称。
   */
  #treeRevertPlan(
    thread: ThreadState,
    entryId: string,
  ): { beforeTurnId: string; editorText?: string } | null | undefined {
    const turnId = thread.entryTurns.get(entryId);
    if (turnId === undefined) return undefined;
    const entry = thread.entries.find((candidate) => candidate.entryId === entryId);
    const message = entry === undefined ? undefined : entryMessage(entry);
    if (message?.role === "user") {
      const text = messageText(message);
      return { beforeTurnId: turnId, ...(text.length === 0 ? {} : { editorText: text }) };
    }
    const index = thread.turnOrder.indexOf(turnId);
    const next = index < 0 ? undefined : thread.turnOrder[index + 1];
    return next === undefined ? null : { beforeTurnId: next };
  }

  /**
   * 原地把 thread 的历史截断到某一轮之前，然后重建条目图并广播。
   *
   * `thread/revert` 的响应里 `turns` 恒为空（协议原文：hydrate retained history through
   * `thread/turns/list`），所以截断后必须自己重新拉一遍。用 `itemsView: "full"` 走
   * app-server 的权威视图，而不是重新解析磁盘 rollout——rollout 什么时候落盘不由我们控制。
   */
  async #revertThread(thread: ThreadState, beforeTurnId: string): Promise<void> {
    await this.#server.request("thread/revert", { threadId: thread.id, beforeTurnId });
    this.#replayTurns(thread, { turns: await this.#listAllTurns(thread.id) });
    // metadata 事件里会一并补发 capabilities：树上少掉的那些节点立刻从手机菜单消失。
    this.#publishMetadataEvent(thread);

  }

  /**
   * fork 当前 thread：app-server 的 `thread/fork`，返回新 thread 并走激活后处理。
   *
   * 只服务 `/fork` 命令（用户主动开一条新线）。历史树的动作**不走这里**——那是原地 revert，
   * 不派生会话。
   */
  async #forkThread(thread: ThreadState | undefined): Promise<BackendActivation> {
    if (thread === undefined) throw new Error("没有活跃的 Codex 会话");
    // thread/fork 的广播同样可能先于响应到达：与 activate 一样纳入在途计数。
    this.#activating += 1;
    try {
      return await this.#forkThreadInner(thread);
    } finally {
      this.#activating -= 1;
    }
  }

  async #forkThreadInner(thread: ThreadState): Promise<BackendActivation> {
    const result = (await this.#server.request("thread/fork", { threadId: thread.id })) as {
      thread?: Record<string, unknown>;
      model?: unknown;
      modelProvider?: unknown;
    };
    const id = result.thread?.id;
    const cwd = result.thread?.cwd;
    if (typeof id !== "string" || typeof cwd !== "string") {
      throw new Error("app-server 的 thread/fork 响应缺少 thread.id/cwd");
    }
    const forked: ThreadState = this.#newThreadState(id, cwd, {
      name: codexSessionName(result.thread?.name),
      model: typeof result.model === "string" ? result.model : thread.model,
      effort: thread.effort,
    });
    forked.modelProvider = typeof result.modelProvider === "string" ? result.modelProvider : thread.modelProvider;
    forked.permissions = codexPermissions(result);
    if (forked.permissions) this.#effectiveSettings.set(forked.id, object(result));
    this.#threads.set(id, forked);
    void this.#refreshIntegrationCatalog(forked);
    this.#replayTurns(forked, result.thread ?? {});
    if (forked.itemOrder.length === 0) await this.#replayFromRollout(forked);
    this.#publishMetadataEvent(forked);

    this.#openHeadWindow(id, cwd);
    return { sessionId: id, spawnMode: "tui" };
  }

  #slashNoSession(threadId: string | undefined, commandId: string | undefined): boolean {
    this.#commandResult(threadId, commandId, false, "没有活跃的 Codex 会话，请重新激活", "failure");
    return true;
  }

  /**
   * `/quit`：结束这台电脑上该 thread 的 Codex TUI 进程，然后按「TUI 窗口已关闭」
   * 下线本 thread（与看门狗发现窗口消失走同一条 #deactivateThread 路径，广播一致）。
   *
   * app-server 没有关闭 TUI 的 RPC（thread/archive|delete 是删会话，不是关窗），
   * 所以只能由 Host 结束进程。找不到进程也照常下线：用户要的是「回到离线」，
   * 而不是「因为查找失败还假装在线」。
   */
  async #quitThread(thread: ThreadState): Promise<void> {
    const endpoint = this.#server.endpoint;
    try {
      if (endpoint === undefined) {
        this.#options.log?.(`/quit：app-server 端点未知，跳过结束进程（thread=${thread.id}）`);
        return;
      }
      // 杀进程按窗口 key（argv 快照）匹配：TUI 切过 thread 后 argv 里还是旧 id。
      const windowKey = this.#windowKeyByThread.get(thread.id) ?? thread.id;
      const killed = await this.#killTuiProcesses(windowKey, endpoint);
      this.#options.log?.(
        `/quit：${killed ? "已结束" : "未找到"} Codex TUI 进程（thread=${thread.id} endpoint=${endpoint}）`,
      );
    } finally {
      this.#deactivateThread(thread.id, "Codex 会话已由手机 /quit 关闭");
    }
  }

  /**
   * 结束本机 attach 到本 app-server 的 Codex TUI 进程。
   *
   * 两类目标（wt 把窗口交给常驻 WindowsTerminal，开窗时那个 wt.exe 早就退了，只能按
   * 命令行认）：
   * - 已 attach 的 TUI：codex.exe / node.exe 命令行同时含 `--remote <endpoint>` 与
   *   `resume <sessionId>`；
   * - 还没 attach 的等待窗口（rollout 未落盘，defaultOpenHeadWindow 里那段轮询）：
   *   powershell 命令行只有 base64 的 `-EncodedCommand`，要解码后再匹配。`/new` 之后
   *   立刻 `/quit` 必须也能关掉它，否则窗口稍后 attach 就成了「手机认为离线、电脑上
   *   却真有 TUI」的幽灵。
   */
  async #killTuiProcesses(sessionId: string, endpoint: string): Promise<boolean> {
    if (this.#options.killTuiProcesses !== undefined) {
      return this.#options.killTuiProcesses({ sessionId, endpoint });
    }
    return new Promise((resolve) => {
      const encoded = Buffer.from(codexTuiKillScript(sessionId, endpoint), "utf16le").toString("base64");
      const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
      let out = "";
      child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
      child.on("error", () => resolve(false));
      child.on("exit", () => resolve(Number.parseInt(out.trim(), 10) > 0));
    });
  }

  #failTurnStart(thread: ThreadState, messageId: string, text: string, error: unknown): void {
    this.#options.log?.(`turn/start 失败：${describeError(error)}`);
    this.#emit(thread.id, {
      type: "message.finished",
      message: { ...userMessage(messageId, text), isError: true },
    });
    thread.turnInProgress = false;
    this.#publishMetadataEvent(thread);
  }

  /**
   * `command.result` 回执：APP 用它跟踪在途命令、展示错误。没有 commandId 就不发。
   *
   * `result` 是命令的返回值（Pi 侧由 RuntimeBridge 原样转发；codex 自己实现这条车道）。
   * 目前只有 `/tree` 用它：回传新会话的 runtimeId 与用户消息原文。
   */
  #commandResult(
    threadId: string | undefined,
    commandId: string | undefined,
    ok: boolean,
    error?: string,
    status?: RuntimeCommandStatus,
    result?: unknown,
  ): void {
    if (commandId === undefined) return;
    this.#emit(threadId, {
      type: "command.result",
      commandId,
      ok,
      ...(status === undefined ? {} : { status }),
      ...(error === undefined ? {} : { error }),
      ...(result === undefined ? {} : { result }),
    });
  }

  async #startTurn(thread: ThreadState, text: string, clientUserMessageId?: string): Promise<void> {
    return this.#startTurnWithInput(thread, [{ type: "text", text }], clientUserMessageId);
  }

  async #startTurnWithInput(thread: ThreadState, input: unknown[], clientUserMessageId?: string): Promise<void> {
    thread.turnInProgress = true;
    this.#publishMetadataEvent(thread);
    await this.#server.request("turn/start", {
      threadId: thread.id,
      input,
      // 把 App 的 messageId 钉到本次 turn 的 userMessage item 上：app-server 会在
      // item/started / item/completed 的 UserMessageThreadItem.clientId 原样带回，
      // 用户气泡的上屏与落盘收敛（persistedMessages）都靠这一个 id。App 没带
      // messageId（测试直调 / 合成 id 场景）时不传，item 仍会以 entry id 正常上屏。
      ...(clientUserMessageId === undefined ? {} : { clientUserMessageId }),
      // 会话级覆盖（`/model`/`/thinking` 写入）：turn/start 的 model/effort 是 turn 级
      // 覆盖并延续后续 turn，所以每个 turn 都带上（未设置时不传，用 app-server 缺省）。
      ...(thread.model === undefined ? {} : { model: thread.model }),
      ...(thread.effort === undefined ? {} : { effort: thread.effort }),
    });
    // turn/start 的响应只代表 turn 被接受；结束由 turn/completed 通知驱动。
  }

  // ── app-server 通知 → runtime 事件 ──────────────────────────────────────────

  /**
   * 非活跃 thread 的通知处理：唯一的正当来源是电脑上的 TUI 切换了会话——`/new` 产生
   * `thread/started` 广播、`/resume` 产生 `thread/status/changed` 广播（实测 0.155.1，
   * app-server 把通知发给**所有**客户端连接）。按 pi 的语义接管：TUI 归属变了 =
   * 旧会话下线、新会话上线，手机跟着 TUI 当前会话走。
   *
   * 宽限重查是有意的：Host 自己 activate/fork（thread/start|resume|fork）同样会收到
   * 广播，且广播可能先于 RPC 响应到达——此刻 thread 还没进 #threads。等一个宽限窗口
   * 再复查（Host 操作还在途就再等一轮），已被收编的就是自己人的广播，忽略。
   */
  #handleUnmanagedNotification(method: string, record: Record<string, unknown>, threadId: string | undefined): void {
    if (method !== "thread/started" && method !== "thread/status/changed") return;
    const nested = record.thread;
    // app-server 会用 **ephemeral 线程**干一次性的活：会话标题生成、/side、review fork、
    // 临时子代理。它们没有 rollout（thread.path 为 null）、也不接受 thread/turns/list——
    // 收编过去就是「手机连到一个拉不出历史的空会话」，而且真会话会被下线（真机上表现为
    // 发完第一条消息后聊天记录加载不出来、只有「运行中」）。这些不是会话，不算 TUI 切会话。
    // TUI 里 /new 出来的新会话是非 ephemeral 的，不受影响。
    if (nested !== null && typeof nested === "object" && (nested as { ephemeral?: unknown }).ephemeral === true) return;
    const id = threadId ?? (nested !== null && typeof nested === "object" && typeof (nested as { id?: unknown }).id === "string"
      ? (nested as { id: string }).id
      : undefined);
    if (id === undefined) return;
    if (this.#threads.has(id)) return;
    if (this.#headWindows.size === 0) return; // 没有 TUI 窗口就没人能切会话
    const graceMs = this.#options.tuiSwitchGraceMs ?? 300;
    const timer = setTimeout(() => {
      this.#switchTimers.delete(timer);
      if (this.#activating > 0) {
        this.#scheduleSwitchAdoption(id, record, 1);
        return;
      }
      void this.#adoptTuiSwitchedThread(id, record).catch((error: unknown) => {
        this.#options.log?.(`接管 TUI 切换的会话失败（thread=${id}）：${describeError(error)}`);
      });
    }, graceMs);
    timer.unref?.();
    this.#switchTimers.add(timer);
  }

  #scheduleSwitchAdoption(threadId: string, record: Record<string, unknown>, depth: number): void {
    if (depth > 3) {
      this.#options.log?.(`TUI 切换检测放弃等待 Host 自身激活收尾（thread=${threadId}）`);
      return;
    }
    const graceMs = this.#options.tuiSwitchGraceMs ?? 300;
    const timer = setTimeout(() => {
      this.#switchTimers.delete(timer);
      if (this.#activating > 0) {
        this.#scheduleSwitchAdoption(threadId, record, depth + 1);
        return;
      }
      void this.#adoptTuiSwitchedThread(threadId, record).catch((error: unknown) => {
        this.#options.log?.(`接管 TUI 切换的会话失败（thread=${threadId}）：${describeError(error)}`);
      });
    }, graceMs);
    timer.unref?.();
    this.#switchTimers.add(timer);
  }

  /**
   * 把 TUI 切过去的 thread 收编为托管会话：旧会话下线（手机删卡）、新会话走一遍
   * 激活后处理（回放历史、广播 metadata/snapshot → Host 重播 runtime.online）。
   * 不重开窗口——窗口就是现在这个，argv 里的窗口 key 原样过户给新 thread，看门狗
   * 与 /quit 继续按这个 key 找进程。
   */
  async #adoptTuiSwitchedThread(threadId: string, record: Record<string, unknown>): Promise<void> {
    // 到点复查：宽限窗口内被 Host 自己的 activate/fork 收编、或窗口全关了，就不算切换。
    if (this.#threads.has(threadId)) return;
    if (this.#headWindows.size === 0) return;
    const victim = this.#victimWindowKey(threadId);
    if (victim === undefined) {
      this.#options.log?.(`收到未托管 thread 的通知（thread=${threadId}），但没有可归属的窗口；忽略`);
      return;
    }
    // cwd：thread/started 广播自带 thread 对象；status/changed 只带 id，问 thread/list。
    const nested = record.thread;
    const snapshot = nested !== null && typeof nested === "object" && typeof (nested as { cwd?: unknown }).cwd === "string"
      ? nested as Record<string, unknown>
      : await this.#threadFromList(threadId);
    const cwd = snapshot?.cwd;
    if (typeof cwd !== "string") {
      this.#options.log?.(`无法确定 TUI 切换目标会话的 cwd（thread=${threadId}）；忽略`);
      return;
    }
    this.#deactivateThread(victim.oldThreadId, "Codex TUI 已切换到其他会话");
    const thread = this.#newThreadState(threadId, cwd, { name: codexSessionName(snapshot?.name) });
    this.#threads.set(threadId, thread);
    void this.#refreshIntegrationCatalog(thread);
    try {
      this.#replayTurns(thread, { ...snapshot, turns: await this.#listAllTurns(threadId) });
    } catch (error) {
      // turns/list 失败不挡收编：条目图还有磁盘 rollout 兜底。
      this.#options.log?.(`拉取切换会话历史失败（thread=${threadId}）：${describeError(error)}`);
    }
    if (thread.itemOrder.length === 0) await this.#replayFromRollout(thread);
    this.#windowKeyByThread.set(threadId, victim.key);
    this.#windowActivity.set(victim.key, Date.now());
    this.#headWindows.add(threadId);
    this.#headWindowSeen.add(victim.key);
    this.#publishMetadataEvent(thread);

    this.#options.log?.(
      `Codex TUI 切换会话：${victim.oldThreadId} → ${threadId}（窗口 key=${victim.key}，cwd=${cwd}）`,
    );
  }

  /**
   * 把一次切换归属到某个窗口：挑「最近有动静」的那个。单窗口时精确；多窗口时是
   * 启发式——广播不携带来源连接，app-server 层面无法区分是哪个窗口切的。
   */
  #victimWindowKey(newThreadId: string): { key: string; oldThreadId: string } | undefined {
    let best: { key: string; oldThreadId: string; at: number } | undefined;
    for (const [oldThreadId, key] of this.#windowKeyByThread) {
      if (!this.#headWindows.has(oldThreadId)) continue;
      if (!this.#threads.has(oldThreadId)) continue;
      if (oldThreadId === newThreadId) continue;
      const at = this.#windowActivity.get(key) ?? 0;
      if (best === undefined || at > best.at) best = { key, oldThreadId, at };
    }
    return best === undefined ? undefined : { key: best.key, oldThreadId: best.oldThreadId };
  }

  /** thread/list 里读取切换目标的目录与名称。 */
  async #threadFromList(threadId: string): Promise<Record<string, unknown> | undefined> {
    try {
      const result = await this.#server.request("thread/list", { limit: 200 }) as {
        data?: Array<Record<string, unknown>>;
      };
      return (result.data ?? []).find((candidate) => candidate?.id === threadId);
    } catch (error) {
      this.#options.log?.(`thread/list 查 cwd 失败（thread=${threadId}）：${describeError(error)}`);
      return undefined;
    }
  }

  /** 全量拉一个 thread 的 turns（itemsView full，分页取尽）。revert 与 TUI 切换收编共用。 */
  async #listAllTurns(threadId: string): Promise<unknown[]> {
    const turns: unknown[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.#server.request("thread/turns/list", {
        threadId,
        itemsView: "full",
        sortDirection: "asc",
        limit: 200,
        ...(cursor === undefined ? {} : { cursor }),
      }) as { data?: unknown; nextCursor?: unknown };
      if (Array.isArray(page.data)) turns.push(...page.data);
      cursor = typeof page.nextCursor === "string" && page.nextCursor.length > 0 ? page.nextCursor : undefined;
    } while (cursor !== undefined);
    return turns;
  }

  async #handleNotification(method: string, params: unknown): Promise<void> {
    const record = (params ?? {}) as Record<string, unknown>;
    if (method === "windowsSandbox/setupCompleted") {
      for (const active of this.#threads.values()) {
        if (record.success === true) {
          if (active.permissions) delete active.permissions.problem;
          active.lastError = undefined;
          this.#publishMetadataEvent(active);
        } else this.#reportError(active, `Windows sandbox setup failed: ${String(record.error ?? "请在电脑端检查沙箱设置")}`);
      }
      return;
    }
    if (method === "configWarning") {
      for (const active of this.#threads.values()) this.#reportError(active, [record.summary, record.details].filter((v) => typeof v === "string").join("\n"));
      return;
    }
    const threadId = record.threadId;
    if (method === "thread/settings/updated" && typeof threadId === "string") {
      const settings = object(record.threadSettings ?? record);
      const permissions = codexPermissions(settings);
      if (permissions !== undefined) {
        this.#observedSettings.set(threadId, permissions);
        this.#effectiveSettings.set(threadId, settings);
        const pending = this.#permissionUpdates.get(threadId);
        if (pending && permissionPatchMatches(settings, pending.patch)) pending.resolve();
      }
    }
    if ((method === "thread/archived" || method === "thread/unarchived") && typeof threadId === "string") {
      const archived = method === "thread/archived";
      if (archived) this.#deactivateThread(threadId, "会话已归档");
      this.onArchiveChange?.(threadId, archived);
      return;
    }
    const thread = typeof threadId === "string" ? this.#threads.get(threadId) : undefined;
    if (thread === undefined) {
      // 非活跃 thread 的通知：唯一正当来源是电脑上的 TUI 切换了会话（/new →
      // thread/started、/resume → thread/status/changed，app-server 广播给所有客户端）。
      // 其余照旧忽略。
      this.#handleUnmanagedNotification(method, record, typeof threadId === "string" ? threadId : undefined);
      return;
    }
    // 该 thread 所属窗口有动静：TUI 切换归属时按「最近有动静」挑窗口用。
    const windowKey = this.#windowKeyByThread.get(thread.id);
    if (windowKey !== undefined) this.#windowActivity.set(windowKey, Date.now());
    if (method === "skills/changed" || method === "mcpServerStatus/updated") {
      void this.#refreshIntegrationCatalog(thread);
      return;
    }
    switch (method) {
      case "thread/name/updated": {
        if (record.threadName !== undefined && record.threadName !== null && typeof record.threadName !== "string") return;
        thread.name = codexSessionName(record.threadName);
        this.#publishMetadataEvent(thread);
        return;
      }
      case "thread/settings/updated": {
        const settings = object(record.threadSettings ?? record);
        const model = settings.model;
        const modelProvider = settings.modelProvider;
        if (typeof model === "string" && model.length > 0) thread.model = model;
        if (typeof modelProvider === "string" && modelProvider.length > 0) thread.modelProvider = modelProvider;
        if (typeof settings.effort === "string") thread.effort = settings.effort;
        if (typeof settings.cwd === "string") thread.cwd = settings.cwd;
        thread.permissions = codexPermissions(settings) ?? thread.permissions;
        this.#publishMetadataEvent(thread);
        return;
      }
      case "serverRequest/resolved": {
        for (const [requestId, approval] of this.#approvals) {
          if (approval.threadId === thread.id && approval.serverRequest.id === record.requestId) this.#finishApproval(requestId);
        }
        return;
      }
      case "thread/status/changed": {
        const status = object(record.status);
        thread.waitingForApproval = Array.isArray(status.activeFlags)
          && status.activeFlags.some((flag) => flag === "waitingOnApproval" || flag === "waitingOnUserInput");
        if (status.type === "idle") thread.turnInProgress = false;
        else if (status.type === "active") thread.turnInProgress = true;
        this.#publishMetadataEvent(thread);
        return;
      }
      case "item/started": {
        const item = record.item;
        if (item === null || typeof item !== "object") return;
        const data = item as Record<string, unknown>;
        if ((data.type === "fileChange" || data.type === "commandExecution") && typeof data.id === "string") {
          thread.approvalItems.set(data.id, data);
        }
        this.#noteItem(thread, data);
        const raw = toolCallMessage(data) ?? itemToMessage(data);
        if (raw === undefined) return;
        // userMessage item（turn/start 带了 clientUserMessageId 时 clientId = App 的
        // messageId）在此处完成唯一一次上屏——本地不再合成回显。
        const message = withClientMessageId(data, raw);
        this.#emit(thread.id, { type: "message.started", message });
        const tool = toolCallInfo(data);
        if (tool !== undefined) {
          thread.toolNames.set(tool.toolCallId, tool.toolName);
          this.#emit(thread.id, {
            type: "tool.started",
            toolCallId: tool.toolCallId,
            toolName: tool.toolName,
            arguments: tool.arguments,
          });
        }
        return;
      }
      case "item/commandExecution/outputDelta":
      case "item/fileChange/outputDelta":
        if (typeof record.itemId !== "string" || typeof record.delta !== "string") return;
        this.#emit(thread.id, {
          type: "tool.updated",
          toolCallId: record.itemId,
          toolName: thread.toolNames.get(record.itemId)
            ?? (method.startsWith("item/fileChange") ? "fileChange" : "commandExecution"),
          partialResult: record.delta,
        });
        return;
      case "item/mcpToolCall/progress":
        if (typeof record.itemId !== "string" || typeof record.message !== "string") return;
        this.#emit(thread.id, {
          type: "tool.updated",
          toolCallId: record.itemId,
          toolName: thread.toolNames.get(record.itemId) ?? "mcpToolCall",
          partialResult: record.message,
        });
        return;
      case "item/agentMessage/delta": {
        const delta = record.delta;
        if (typeof delta !== "string" || typeof record.itemId !== "string") return;
        if (thread.streamingMessageId !== record.itemId) {
          thread.streamingMessageId = record.itemId;
          this.#emit(thread.id, {
            type: "message.started",
            message: assistantMessage(record.itemId),
          });
        }
        this.#emit(thread.id, { type: "message.delta", messageId: record.itemId, contentType: "text", delta });
        return;
      }
      case "item/completed": {
        const item = record.item;
        if (item === null || typeof item !== "object") return;
        const data = item as Record<string, unknown>;
        if (data.type === "agentMessage" && thread.streamingMessageId === data.id) {
          thread.streamingMessageId = undefined;
        }
        // item 通知自带 turnId（`ItemCompletedNotification` 的 required 字段），条目归属由此确定。
        this.#completeItem(thread, data, typeof record.turnId === "string" ? record.turnId : undefined);
        const raw = toolCallMessage(data) ?? itemToMessage(data);
        if (raw !== undefined) {
          const message = withClientMessageId(data, raw);
          if (message !== raw) {
            // clientUserMessageId 已带回：记 live id -> entry id 映射，turn.finished 时
            // App 端 remap 把气泡改名为权威 entry id（与 Pi 的 persistedMessageMappings 一致）。
            thread.persistedMessageMappings.push({ messageId: message.messageId, entryId: raw.messageId });
          }
          this.#emit(thread.id, { type: "message.finished", message });
        }
        const tool = toolCallInfo(data);
        if (tool !== undefined) {
          thread.toolNames.set(tool.toolCallId, tool.toolName);
          this.#emit(thread.id, {
            type: "tool.finished",
            toolCallId: tool.toolCallId,
            toolName: tool.toolName,
            result: tool.result,
            isError: tool.isError,
          });
          thread.toolNames.delete(tool.toolCallId);
        }
        return;
      }
      case "turn/started": {
        thread.lastError = undefined;
        // app-server 把 turn 嵌在 `turn` 下（`{ threadId, turn: { id, startedAt } }`），
        // 不是顶层 turnId——读错了整条 turn 生命周期就静默失效（没有 turn.started/finished，
        // 手机端也就没有「耗时」那一行）。
        const started = turnRecord(record.turn);
        if (started !== undefined) {
          thread.turnId = started.id;
          // app-server 的 startedAt 是秒级 epoch；本端事件用毫秒，统一乘 1000。
          thread.turnStartedAt = started.startedAt === undefined
            ? Date.now()
            : started.startedAt * 1_000;
          this.#emit(thread.id, {
            type: "turn.started",
            turnId: started.id.slice(0, 256),
            startedAt: thread.turnStartedAt,
          });
        }
        thread.turnInProgress = true;
        this.#publishMetadataEvent(thread);
        return;
      }
      case "turn/completed": {
        const completed = turnRecord(record.turn);
        const completedTurn = object(record.turn);
        if (completedTurn.status === "failed") this.#reportError(thread, completedTurn.error);
        for (const [requestId, approval] of this.#approvals) {
          if (approval.threadId === thread.id && approval.turnId === (completed?.id ?? thread.turnId)) this.#finishApproval(requestId, false);
        }
        thread.approvalItems.clear();
        thread.waitingForApproval = false;
        if (thread.turnId !== undefined && thread.turnStartedAt !== undefined) {
          // 时长以 app-server 的 durationMs（毫秒）为准；拿不到才退回本地时钟差。
          const durationMs = completed?.durationMs !== undefined
            ? Math.max(0, Math.round(completed.durationMs))
            : Math.max(0, Date.now() - thread.turnStartedAt);
          this.#emit(thread.id, {
            type: "turn.finished",
            turnId: thread.turnId,
            startedAt: thread.turnStartedAt,
            durationMs,
            ...(thread.persistedMessageMappings.length === 0
              ? {}
              : { persistedMessages: [...thread.persistedMessageMappings] }),
          });
        }
        thread.turnId = undefined;
        thread.turnStartedAt = undefined;
        thread.turnInProgress = false;
        thread.streamingMessageId = undefined;
        thread.persistedMessageMappings = [];
        this.#publishMetadataEvent(thread);
        // turn 结束（含被 steer/interrupt 打断）：补跑排队的下一条消息。
        this.#drainQueue(thread);
        return;
      }
      case "thread/tokenUsage/updated": {
        // 上下文占用只在这条通知里（thread 快照/ turn 通知都没有）。last.inputTokens 是
        // 当前 turn 的上下文输入 token；total.inputTokens 是线程累计输入量，不能拿来和
        // modelContextWindow 比较，否则多轮对话后会显示出远超实际上下文的数值。
        const usage = record.tokenUsage;
        if (usage !== null && typeof usage === "object") {
          const data = usage as Record<string, unknown>;
          const last = data.last;
          const window = data.modelContextWindow;
          const tokens = last !== null && typeof last === "object"
            ? (last as Record<string, unknown>).inputTokens
            : undefined;
          if (typeof tokens === "number" && typeof window === "number" && window > 0) {
            thread.contextUsage = { tokens, window };
            this.#publishMetadataEvent(thread);
          }
        }
        return;
      }
      case "error": {
        this.#reportError(thread, record.error);
        return;
      }
      default:
        return;
    }
  }

  // ── 审批（spec §7.4：不回会挂死 turn） ───────────────────────────────────────

  #handleServerRequest(request: CodexServerRequest): void {
    const params = object(request.params);
    const thread = typeof params.threadId === "string" ? this.#threads.get(params.threadId) : undefined;
    const decline = codexDecline(request.method);
    try {
      if (thread === undefined) throw new Error("交互请求没有归属到已激活的会话");
      if ([...this.#approvals.values()].filter((a) => a.threadId === thread.id).length >= 64) throw new Error("待处理交互过多，请先处理已有请求");
      if ([...this.#approvals.values()].some((a) => a.serverRequest.id === request.id)) return;
      const requestId = randomUUID();
      const timeoutMs = typeof params.autoResolutionMs === "number" && params.autoResolutionMs > 0
        ? Math.min(params.autoResolutionMs, APPROVAL_TTL_MS) : APPROVAL_TTL_MS;
      const interaction = prepareCodexInteraction(request.method, params, {
        runtimeId: this.runtimeIdFor(thread.id), requestId, extensionId: "codex", expiresAt: Date.now() + timeoutMs,
      }, typeof params.itemId === "string" ? thread.approvalItems.get(params.itemId) : undefined);
      const timer = setTimeout(() => {
        const pending = this.#approvals.get(requestId);
        if (pending === undefined) return;
        if (pending.submitted === undefined) {
          try { request.respond(interaction.decline); } catch (error) { this.#options.log?.(describeError(error)); }
        }
        this.#approvals.delete(requestId);
        for (const commandId of pending.submitted?.commandIds ?? []) this.#commandResult(thread.id, commandId, false, "未收到 Codex 的处理确认，请在电脑端检查结果");
        this.#emit(thread.id, { type: "interaction.cancelled", requestId, reason: "timeout" });
        this.#publishMetadataEvent(thread);
      }, timeoutMs);
      timer.unref();
      this.#approvals.set(requestId, { serverRequest: request, interaction, timer, threadId: thread.id,
        turnId: typeof params.turnId === "string" ? params.turnId : undefined,
        blocking: params.isBlocking !== false, submitted: undefined,
      });
      this.#publishMetadataEvent(thread);
      this.#emit(thread.id, { type: "interaction.requested", request: interaction.request });
    } catch (error) {
      if (decline === undefined) request.fail(describeError(error));
      else request.respond(decline);
      this.#options.log?.(`Codex 交互 ${request.method} 未受理：${describeError(error)}`);
      if (thread !== undefined) this.#reportError(thread, `交互未受理：${describeError(error)}`);
    }
  }

  #resolveApproval(command: Extract<RuntimeCommand, { type: "interaction.respond" }>, commandId?: string, threadId?: string): void {
    const approval = this.#approvals.get(command.requestId);
    try {
      if (approval === undefined) throw new Error("批准请求已结束或过期，请刷新会话");
      if (Date.now() >= approval.interaction.request.expiresAt) throw new Error("批准请求已过期，请等待会话更新");
      if (approval.threadId !== threadId || command.extensionId !== "codex") throw new Error("批准请求不属于当前会话");
      const result = approval.interaction.decode(command.response);
      const fingerprint = JSON.stringify(result);
      if (approval.submitted !== undefined && approval.submitted.fingerprint !== fingerprint) throw new Error("请求已提交，正在等待电脑确认");
      if (approval.submitted !== undefined) {
        if (commandId !== undefined) approval.submitted.commandIds.add(commandId);
        this.#commandResult(threadId, commandId, true, undefined, "pending");
        return;
      }
      approval.submitted = { fingerprint, commandIds: new Set(commandId === undefined ? [] : [commandId]) };
      this.#commandResult(threadId, commandId, true, undefined, "pending");
      try { approval.serverRequest.respond(result); }
      catch (error) { approval.submitted = undefined; throw error; }
      this.#publishInteractions(approval.threadId);
    } catch (error) {
      this.#commandResult(threadId, commandId, false, describeError(error));
    }
  }

  #finishApproval(requestId: string, confirmed = true): void {
    const approval = this.#approvals.get(requestId);
    if (approval === undefined) return;
    clearTimeout(approval.timer);
    this.#approvals.delete(requestId);
    this.#emit(approval.threadId, confirmed
      ? { type: "interaction.resolved", requestId, source: approval.submitted ? "remote" : "local" }
      : { type: "interaction.cancelled", requestId, reason: "cancelled" });
    for (const commandId of approval.submitted?.commandIds ?? []) this.#commandResult(approval.threadId, commandId,
      confirmed, confirmed ? undefined : "本轮已结束，但未收到 Codex 的处理确认，请在电脑端检查结果");
    const thread = this.#threads.get(approval.threadId);
    if (thread !== undefined) this.#publishMetadataEvent(thread);
  }

  #publishInteractions(threadId: string): void {
    this.#emit(threadId, { type: "interaction.snapshot", requests: [...this.#approvals.values()]
      .filter((a) => a.threadId === threadId).map((a) => ({ ...a.interaction.request, submitted: a.submitted !== undefined })) });
  }

  #reportError(thread: ThreadState, error: unknown): void {
    const message = codexErrorMessage(error);
    if (thread.lastError === message) return;
    thread.lastError = message;
    if (/沙箱/.test(message)) {
      thread.permissions = { ...(thread.permissions ?? { sandbox: "unknown", approvalPolicy: "unknown" }), problem: message };
      this.#publishMetadataEvent(thread);
    }
    this.#emit(thread.id, { type: "runtime.error", message, recoverable: true });
    this.#options.log?.(`app-server 报错：${message}`);
  }

  async #checkSandboxReadiness(thread: ThreadState): Promise<void> {
    // Checking readiness is read-only. Installation and Windows/UAC setup stay on the computer.
    if (process.platform !== "win32" || this.#server.codexCommand === undefined
      || thread.permissions === undefined || ["dangerFullAccess", "externalSandbox"].includes(thread.permissions.sandbox)) return;
    try {
      const result = object(await this.#server.request("windowsSandbox/readiness", {}));
      if (this.#threads.get(thread.id) !== thread) return;
      if (result.status === "notConfigured" || result.status === "updateRequired") {
        this.#reportError(thread, `Windows sandbox ${result.status === "notConfigured" ? "尚未配置" : "需要更新"}，请在电脑端完成沙箱设置。`);
      }
    } catch (error) {
      this.#options.log?.(`无法检查 Windows 沙箱状态：${describeError(error)}`);
    }
  }

  // ── 条目图与广播 ────────────────────────────────────────────────────────────

  #noteItem(thread: ThreadState, item: Record<string, unknown>): void {
    if (typeof item.id === "string" && !thread.itemOrder.includes(item.id)) thread.itemOrder.push(item.id);
  }

  #completeItem(thread: ThreadState, item: Record<string, unknown>, turnId?: string): void {
    if (typeof item.id !== "string") return;
    this.#noteItem(thread, item);
    if (thread.itemOrder.indexOf(item.id) < thread.committedItemCount) {
      this.#appendEntry(thread, item, turnId);
      return;
    }
    thread.completedItems.set(item.id, { item, turnId });
    // Tools can finish out of order. Keep the source item order, or replay will change parents.
    while (thread.committedItemCount < thread.itemOrder.length) {
      const id = thread.itemOrder[thread.committedItemCount]!;
      const completed = thread.completedItems.get(id);
      if (completed === undefined) break;
      this.#appendEntry(thread, completed.item, completed.turnId);
      thread.completedItems.delete(id);
      thread.committedItemCount++;
    }
  }

  #appendEntry(thread: ThreadState, item: Record<string, unknown>, turnId?: string): void {
    const entryId = item.id;
    if (typeof entryId !== "string") return;
    const regularMessage = itemToMessage(item);
    const tool = toolCallInfo(item);
    const messages = tool === undefined
      ? (regularMessage === undefined ? [] : [{ entryId, message: regularMessage }])
      : [
        { entryId, message: toolCallMessage(item) },
        { entryId: `${entryId}:result`, message: toolResultMessage(item, true) },
      ];
    for (const part of messages) {
      if (part.message === undefined) continue;
      const entries = thread.entries;
      const existing = entries.findIndex((entry) => entry.entryId === part.entryId);
      const entry: RemoteSessionEntry = {
        entryId: part.entryId,
        parentId: existing > 0
          ? entries[existing - 1]?.entryId ?? null
          : existing === 0
            ? null
            : entries.at(-1)?.entryId ?? null,
        type: "message",
        // Codex ThreadItem has no canonical per-item time. Use one deterministic sentinel in
        // both Entry and embedded message; live display events retain their actual receive time.
        timestamp: "1970-01-01T00:00:00.000Z",
        data: { message: { ...part.message, timestamp: 0 } },
      };
      if (existing >= 0) {
        if (!isDeepStrictEqual(entries[existing], entry)) {
          thread.historyError = "canonical_entry_conflict";
          return;
        }
      } else entries.push(entry);
      // 知道这个条目属于哪一轮，历史树上的「从这里继续」才能换算成 revert 的轮次边界。
      if (typeof turnId === "string" && turnId.length > 0) {
        thread.entryTurns.set(part.entryId, turnId);
        if (!thread.turnOrder.includes(turnId)) thread.turnOrder.push(turnId);
      }
    }
  }

  /** 快照。手机发来的 session.sync 带 syncId 时**必须原样回显**（快照按 syncId 关联）。 */
  #publishSnapshot(thread: ThreadState, request: Extract<RuntimeCommand, { type: "session.sync" }>): void {
    if (thread.historyError !== undefined) throw new Error(thread.historyError);
    this.#emit(thread.id, selectSessionSyncSnapshot(
      thread.entries, thread.id, thread.entries.at(-1)?.entryId ?? null, request,
    ));
  }

  /** 状态（idle/running/waiting）变了就广播一份 metadata，手机角标跟着走。 */
  #publishMetadataEvent(thread: ThreadState): void {
    this.#emit(thread.id, { type: "runtime.status", status: this.#statusOf(thread) });
    // app-server 的 thread 快照不带 model/contextUsage，而这些只有本后端知道；APP 的
    // 模型名/上下文占用条正是从 `runtime.metadata` 读的（Pi 由 RuntimeBridge 发，codex
    // 必须自己发，否则那两处永远是空的）。
    this.#emit(thread.id, { type: "runtime.metadata", metadata: this.threadMetadata(thread) });
    // 每次 online/状态刷新都补发能力：APP 在 runtime.online（session 变化）时会清掉
    // 之前那份 capabilities，靠这里重新声明，保证命令菜单一直在（防手滑）。
    this.#publishCapabilities(thread);
    this.onMetadataChange?.();
  }

  /**
   * 把某个 thread 的 announcements（capabilities + metadata）重播给手机。
   *
   * Pi 的 RuntimeBridge 在 transport `connected`/`resync` 时会重发 capabilities，
   * 所以手机重连后菜单还在；codex 是 Host 内部后端、没有那条 transport 钩子，只能在
   * 「设备握手完成」时由 Host 调这里补一次——否则重连后 `runtime.online` 把
   * capabilities 清掉，slash 菜单就再也不出来了。
   */
  announce(threadId: string): void {
    const thread = this.#threads.get(threadId);
    if (thread === undefined) return;
    this.#publishCapabilities(thread);
    this.#emit(thread.id, { type: "runtime.metadata", metadata: this.threadMetadata(thread) });
    this.#publishInteractions(thread.id);
  }

  /** 当前活跃 thread 的 id 列表（Host 握手后逐个 announce 用）。 */
  activeThreadIds(): string[] {
    return [...this.#threads.keys()];
  }

  #emit(threadId: string | undefined, event: RuntimeEvent): void {
    this.#eventSink?.(event, threadId);
  }
}

// ── item → ChatMessage 映射 ───────────────────────────────────────────────────

/**
 * 从 app-server 的 `turn/started` / `turn/completed` 通知里解出 turn 对象。
 * 形状是 `{ threadId, turn: { id, startedAt, durationMs, ... } }`——turn 是**嵌套**的，
 * 顶层没有 turnId（早期按顶层读导致整条生命周期静默失效）。
 */
function turnRecord(value: unknown): { id: string; startedAt: number | undefined; durationMs: number | undefined } | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const turn = value as Record<string, unknown>;
  if (typeof turn.id !== "string") return undefined;
  return {
    id: turn.id,
    startedAt: typeof turn.startedAt === "number" ? turn.startedAt : undefined,
    durationMs: typeof turn.durationMs === "number" ? turn.durationMs : undefined,
  };
}

type CodexToolInfo = {
  toolCallId: string;
  toolName: string;
  arguments: unknown;
  result: unknown;
  isError: boolean;
};

function isToolItem(item: Record<string, unknown>): boolean {
  return item.type === "commandExecution" || item.type === "fileChange" || item.type === "mcpToolCall";
}

function toolNameForItem(item: Record<string, unknown>): string {
  if (item.type === "mcpToolCall") {
    return typeof item.tool === "string"
      ? item.tool
      : typeof item.server === "string"
        ? item.server
        : "mcpToolCall";
  }
  return item.type === "fileChange" ? "fileChange" : "commandExecution";
}

function toolArgumentsForItem(item: Record<string, unknown>): unknown {
  switch (item.type) {
    case "commandExecution":
      return { command: item.command, cwd: item.cwd };
    case "fileChange":
      return { changes: item.changes };
    case "mcpToolCall":
      return { server: item.server, tool: item.tool, arguments: item.arguments ?? item.input };
    default:
      return {};
  }
}

function toolResultForItem(item: Record<string, unknown>): unknown {
  const result = item.result ?? item.output ?? item.outputText ?? item.stdout;
  if (result !== undefined) return result;
  return {
    status: item.status,
    ...(item.exitCode === undefined ? {} : { exitCode: item.exitCode }),
    ...(item.stderr === undefined ? {} : { stderr: item.stderr }),
    ...(item.changes === undefined ? {} : { changes: item.changes }),
    ...(item.error === undefined ? {} : { error: item.error }),
  };
}

function toolIsError(item: Record<string, unknown>): boolean {
  if (item.status === "failed" || item.status === "error") return true;
  if (item.error !== undefined && item.error !== null) return true;
  return typeof item.exitCode === "number" && item.exitCode !== 0;
}

function toolCallInfo(item: Record<string, unknown>): CodexToolInfo | undefined {
  const id = item.id;
  if (!isToolItem(item) || typeof id !== "string") return undefined;
  return {
    toolCallId: id,
    toolName: toolNameForItem(item),
    arguments: toolArgumentsForItem(item),
    result: toolResultForItem(item),
    isError: toolIsError(item),
  };
}

function toolCallMessage(item: Record<string, unknown>): ChatMessage | undefined {
  const tool = toolCallInfo(item);
  if (tool === undefined) return undefined;
  return {
    messageId: tool.toolCallId,
    role: "assistant",
    content: [{
      type: "tool_call",
      toolCallId: tool.toolCallId,
      toolName: tool.toolName,
      arguments: tool.arguments,
    }],
    timestamp: Date.now(),
  };
}

function toolResultMessage(item: Record<string, unknown>, canonical = false): ChatMessage | undefined {
  const tool = toolCallInfo(item);
  if (tool === undefined) return undefined;
  return {
    messageId: `${tool.toolCallId}:result`,
    role: "tool",
    toolCallId: tool.toolCallId,
    toolName: tool.toolName,
    isError: tool.isError,
    content: [{ type: "text", text: resultText(tool.result, canonical) }],
    timestamp: Date.now(),
  };
}

function resultText(value: unknown, canonical = false): string {
  if (typeof value === "string") return value;
  try {
    const serialized = JSON.stringify(value, canonical ? (_key, child: unknown) => {
      if (child === null || typeof child !== "object" || Array.isArray(child)) return child;
      return Object.fromEntries(Object.entries(child).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
    } : undefined);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return String(value);
  }
}

function skillCommands(value: unknown): DynamicSlashCommand[] {
  if (!Array.isArray(value)) return [];
  const commands: DynamicSlashCommand[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const skills = record.skills;
    if (!Array.isArray(skills)) continue;
    for (const raw of skills) {
      if (raw === null || typeof raw !== "object") continue;
      const skill = raw as Record<string, unknown>;
      const name = typeof skill.name === "string" ? skill.name.trim() : "";
      const path = typeof skill.path === "string" ? skill.path : undefined;
      if (!name || path === undefined || skill.enabled === false || name.includes("/")) continue;
      const iface = skill.interface;
      const interfaceRecord = iface !== null && typeof iface === "object"
        ? iface as Record<string, unknown>
        : undefined;
      const description = typeof interfaceRecord?.shortDescription === "string"
        ? interfaceRecord.shortDescription
        : typeof skill.description === "string"
          ? skill.description
          : undefined;
      commands.push({
        name,
        ...(description === undefined ? {} : { description }),
        source: "skill",
        kind: "skill",
        skillPath: path,
        argument: { kind: "text", required: false, hint: "[arguments]" },
      });
    }
  }
  return commands;
}

function mcpCommands(value: unknown): DynamicSlashCommand[] {
  if (!Array.isArray(value)) return [];
  const commands: DynamicSlashCommand[] = [];
  for (const rawServer of value) {
    if (rawServer === null || typeof rawServer !== "object") continue;
    const server = rawServer as Record<string, unknown>;
    const serverName = typeof server.name === "string" ? server.name.trim() : "";
    if (!serverName || server.tools === null || typeof server.tools !== "object" || Array.isArray(server.tools)) continue;
    for (const [toolName, rawTool] of Object.entries(server.tools as Record<string, unknown>)) {
      if (!toolName || rawTool === null || typeof rawTool !== "object") continue;
      const tool = rawTool as Record<string, unknown>;
      const commandName = `mcp:${serverName}:${toolName}`;
      const description = typeof tool.description === "string" ? tool.description : `Call ${serverName}/${toolName}`;
      commands.push({
        name: commandName,
        description,
        source: "mcp",
        kind: "mcp",
        mcpServer: serverName,
        mcpTool: toolName,
        argument: { kind: "text", required: false, hint: `{"...": ...}` },
      });
    }
  }
  return commands;
}

/**
 * app-server 把 turn/start 的 clientUserMessageId 原样放在 UserMessageThreadItem.clientId
 * 带回。有它时用户气泡用 App 的 messageId（与 Pi 的 message_start 单事件链同构）；
 * 没有（旧版 app-server / 测试直调）就保持 item.id——仍然只有一个事件源，只是
 * 无法把 live id 映射回 entry id。
 */
function withClientMessageId(item: Record<string, unknown>, message: ChatMessage): ChatMessage {
  const clientId = item.clientId;
  if (message.role !== "user" || typeof clientId !== "string" || clientId.length === 0 || clientId === message.messageId) {
    return message;
  }
  return { ...message, messageId: clientId };
}

function codexSessionName(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim().slice(0, 256) || undefined : undefined;
}

/**
 * 当前 thread 的条目图 → 手机历史树要的选项列表（契约与 Pi 的 `sessionTreeOptions` 一致，
 * 所以 APP 不需要按 agentKind 分支）。
 *
 * codex 的 thread 是一条**线性** item 链：每条节点的 parentId 就是它的前一条、所有节点都在
 * 活动路径上、`isCurrent` 只落在最后一条。动作不是 Pi 那种同会话内换分支，而是原地回退
 * （见 `#treeRevertPlan`）——选中的节点只决定"退到哪一轮之前"。
 *
 * role 用 Pi 的词表：工具类统一写成 `toolResult`，APP 的节点分类与动作判定两边才能共用
 * 同一套分支。
 */
function codexTreeOptions(thread: ThreadState): RuntimeSlashCommandOption[] {
  const lastId = thread.entries.at(-1)?.entryId;
  return thread.entries.map((entry): RuntimeSlashCommandOption => {
    const message = entryMessage(entry);
    const toolName = message?.content.flatMap((part) => part.type === "tool_call" ? [part.toolName] : [])[0];
    // 工具调用（commandExecution/fileChange/mcpToolCall）在会话气泡里是 assistant，但在
    // 树上属于"细节"；工具结果（`:result`）与 role=tool 同样处理。
    const isTool = message?.role === "tool" || toolName !== undefined || entry.entryId.endsWith(":result");
    const text = messageText(message);
    const label = text.length > 0
      ? text.slice(0, 160)
      : toolName ?? (isTool ? "工具结果" : "…");
    const role = isTool
      ? "toolResult"
      : message?.role === "user"
        ? "user"
        : message?.role === "assistant"
          ? "assistant"
          : undefined;
    return {
      value: entry.entryId,
      label,
      description: message?.role ?? entry.type,
      tree: {
        parentId: entry.parentId,
        entryType: entry.type,
        ...(role === undefined ? {} : { role }),
        // 工具条目默认收进「细节」；只有思考、没有正文的助手条目同理。
        defaultHidden: isTool || (text.length === 0 && message?.role === "assistant"),
        isCurrent: entry.entryId === lastId,
        isOnActivePath: true,
      },
    };
  });
}

/** 条目里挂的聊天消息；形状不对就当没有（树只丢一条摘要，不影响会话）。 */
function entryMessage(entry: RemoteSessionEntry): ChatMessage | undefined {
  const message = entry.data.message;
  if (message === null || typeof message !== "object") return undefined;
  const candidate = message as ChatMessage;
  return Array.isArray(candidate.content) ? candidate : undefined;
}

/** 消息正文（text 块），压掉换行与连续空白；思考块与工具调用不算正文。 */
function messageText(message: ChatMessage | undefined): string {
  return (message?.content ?? [])
    .flatMap((part) => part.type === "text" ? [part.text] : [])
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
}

function itemToMessage(item: Record<string, unknown>): ChatMessage | undefined {
  const id = item.id;
  const type = item.type;
  if (typeof id !== "string" || typeof type !== "string") return undefined;
  const timestamp = Date.now();
  switch (type) {
    case "userMessage": {
      const text = extractContentText(item);
      return { messageId: id, role: "user", content: [{ type: "text", text }], timestamp };
    }
    case "agentMessage":
      // 旧格式 rollout 的 AgentMessage 把文本放在 content[].type="Text"（大写 T）；
      // app-server v2 的在线 item/completed 用 item.text（字符串）。两种都兜。
      return { messageId: id, role: "assistant", content: [{ type: "text", text: extractContentText(item) }], timestamp };
    case "reasoning":
      // Reasoning item 的摘要在 summary_text[]（字符串数组）；content/text 兜底。
      return { messageId: id, role: "assistant", content: [{ type: "thinking", text: extractReasoningText(item) }], timestamp };
    case "commandExecution": {
      const command = item.command;
      return {
        messageId: id,
        // Tool items are part of the assistant turn in the APP conversation. Keeping them as
        // assistant tool_call blocks lets Android place them at their actual event position;
        // role=tool is reserved for a result paired with an existing tool call.
        role: "assistant",
        content: [{
          type: "tool_call",
          toolCallId: id,
          toolName: "commandExecution",
          arguments: { command, cwd: item.cwd, exitCode: item.exitCode, status: item.status },
        }],
        timestamp,
      };
    }
    case "fileChange":
      return {
        messageId: id,
        role: "assistant",
        content: [{ type: "tool_call", toolCallId: id, toolName: "fileChange", arguments: { status: item.status, changes: item.changes } }],
        timestamp,
      };
    case "mcpToolCall":
      return {
        messageId: id,
        role: "assistant",
        content: [{ type: "tool_call", toolCallId: id, toolName: String(item.server ?? "mcp"), arguments: { tool: item.tool, status: item.status } }],
        timestamp,
      };
    default:
      // webSearch / plan / todoList 等其余 item 类型先不上屏（§12：能力逐步声明）。
      return undefined;
  }
}

/**
 * 从 item.content[] 抽取文本（大小写不敏感地认 type 为 text/Text/output_text）；
 * content 不是数组时退回 item.text（字符串）。覆盖旧 rollout（content[].type="Text"）
 * 与 app-server v2 在线 item（item.text）两种形态。
 */
function extractContentText(item: Record<string, unknown>): string {
  const content = item.content;
  if (Array.isArray(content)) {
    const parts = content
      .filter((part): part is Record<string, unknown> => part !== null && typeof part === "object")
      .filter((part) => {
        const t = part.type;
        return typeof t === "string" && (t.toLowerCase() === "text" || t === "output_text");
      });
    if (parts.length > 0) {
      return parts.map((part) => String(part.text ?? "")).join("\n");
    }
  }
  const text = item.text;
  return typeof text === "string" ? text : "";
}

/** Reasoning item 的摘要：优先 summary_text[]（字符串数组），再退回 content/text。 */
function extractReasoningText(item: Record<string, unknown>): string {
  const summary = item.summary_text;
  if (Array.isArray(summary)) {
    const joined = summary.filter((s): s is string => typeof s === "string").join("\n");
    if (joined.length > 0) return joined;
  }
  return extractContentText(item);
}

function userMessage(messageId: string, text: string): ChatMessage {
  return { messageId, role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function assistantMessage(messageId: string): ChatMessage {
  return { messageId, role: "assistant", content: [{ type: "text", text: "" }], timestamp: Date.now() };
}

function toMillis(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return undefined;
  // app-server 的时间戳是 Unix 秒；容错毫秒级（>1e12 的按毫秒理解）。
  return value > 1e12 ? value : value * 1_000;
}

/**
 * 读一个 rollout 文件的头部，提取目录条目（§7.5）。
 *
 * 文件格式（codex 0.154 实测）：首行 `{"type":"session_meta","payload":{id,cwd,timestamp,…}}`，
 * 之后是 event/response 行；第一条用户消息形如
 * `{"type":"event_msg","payload":{"type":"user_message","message":"…"}}`。
 * 只读头部 128KB：前面是长篇 developer/permissions 指令，用户消息紧随其后。
 */
async function readRolloutSummary(file: string): Promise<AgentSessionSummary | undefined> {
  let head: string;
  let modifiedAt: number;
  try {
    const [statInfo, handle] = await Promise.all([stat(file), open(file, "r")]);
    try {
      const { buffer, bytesRead } = await handle.read(Buffer.alloc(ROLLOUT_HEAD_BYTES), 0, ROLLOUT_HEAD_BYTES, 0);
      head = buffer.toString("utf8", 0, bytesRead);
    } finally {
      await handle.close();
    }
    modifiedAt = Math.round(statInfo.mtimeMs); // 协议要求 int；mtimeMs 在 Windows 上常带小数。
  } catch {
    return undefined; // 并发删除/权限问题：跳过这份文件，不拖垮整个目录。
  }
  const lines = head.split("\n");
  let meta: { id?: unknown; cwd?: unknown; timestamp?: unknown; model_provider?: unknown } | undefined;
  let firstMessage: string | undefined;
  for (const line of lines) {
    if (meta === undefined && line.includes('"session_meta"')) {
      const parsed = parseJsonLine(line);
      const payload = parsed?.type === "session_meta" && typeof parsed.payload === "object" && parsed.payload !== null
        ? (parsed.payload as { id?: unknown; cwd?: unknown; timestamp?: unknown; model_provider?: unknown })
        : undefined;
      if (payload !== undefined) meta = payload;
    }
    if (firstMessage === undefined && line.includes('"user_message"')) {
      const parsed = parseJsonLine(line);
      const payload = parsed?.type === "event_msg" && typeof parsed.payload === "object" && parsed.payload !== null
        ? (parsed.payload as { message?: unknown })
        : undefined;
      const text = payload?.message;
      if (typeof text === "string" && text.trim().length > 0) firstMessage = text;
    }
    if (meta !== undefined && firstMessage !== undefined) break;
  }
  const id = meta?.id;
  const cwd = meta?.cwd;
  if (typeof id !== "string" || typeof cwd !== "string") return undefined;
  // meta.timestamp 解析不出来时用文件 mtime 兜底——schema 里 createdAt 必填。
  const parsedCreatedAt = typeof meta?.timestamp === "string" ? Date.parse(meta.timestamp) : NaN;
  const createdAt = Number.isFinite(parsedCreatedAt) && parsedCreatedAt >= 0 ? parsedCreatedAt : modifiedAt;
  const modelProvider = codexProviderId(meta?.model_provider);
  return {
    sessionId: id,
    cwd,
    hostname: localHostname(),
    // 目录预览只当「这条会话是干嘛的」的提示：200 字符足够，整段 firstMessage
    // 会把 session.list 响应撑大（见 #diskCatalog 的尺寸注释）。
    ...(firstMessage === undefined ? {} : { firstMessage: firstMessage.slice(0, 200) }),
    createdAt,
    modifiedAt,
    messageCount: 0,
    agentKind: "codex",
    ...(modelProvider === undefined ? {} : { modelProvider }),
  };
}

function codexProviderId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 128 ? value : undefined;
}

/**
 * 从一个 `model/list` 条目里读该模型支持的 reasoning effort → `/thinking` 的选项。
 * app-server 的结构是 `supportedReasoningEfforts: [{ reasoningEffort, description }]`；
 * 没有这个字段（老版本 / 非推理模型）时返回空数组，`capabilities` 会退回纯文本参数。
 */
function readReasoningEfforts(model: Record<string, unknown>): RuntimeSlashCommandOption[] {
  const raw = model.supportedReasoningEfforts;
  if (!Array.isArray(raw)) return [];
  const options: RuntimeSlashCommandOption[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const value = record.reasoningEffort ?? record.effort;
    if (typeof value !== "string" || value.length === 0) continue;
    options.push({
      value,
      label: value,
      ...(typeof record.description === "string" && record.description.length > 0
        ? { description: record.description }
        : {}),
    });
  }
  return options;
}

function parseJsonLine(line: string): { type?: unknown; payload?: unknown } | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0 || !trimmed.startsWith("{")) return undefined;
  try {
    return JSON.parse(trimmed) as { type?: unknown; payload?: unknown };
  } catch {
    return undefined; // 头部截断在 JSON 中间是正常情况，跳过该行即可。
  }
}

/** 旧格式 rollout 的 item.type 是 PascalCase（UserMessage…）；归一化成映射表用的 camelCase。 */
function normalizeItemTypes(item: Record<string, unknown>): Record<string, unknown> {
  const type = item.type;
  if (typeof type !== "string" || type.length === 0) return item;
  const camel = type.charAt(0).toLowerCase() + type.slice(1);
  return camel === type ? item : { ...item, type: camel };
}

/**
 * 有头窗口的启动命令（wt + 内嵌脚本的 UTF-16LE base64 `-EncodedCommand`）。
 *
 * 内嵌脚本做三件事：等 rollout 落盘 → `codex resume --remote` attach → **codex 一退出就关窗**。
 *
 * 关窗必须由脚本自己收尾：窗口壳一旦带 `-NoExit`，codex 退出（app-server 重启、TUI 自己崩、
 * 连接断开、轮换端口）之后 powershell 会继续挂在原地，留下一个「什么都没跑」的残壳窗。
 * Host 侧没有任何关窗动作（看门狗只把该 thread 标下线，`/quit` 只杀 TUI 进程），于是每次
 * 重新拉起会话都会和那只残壳并存——用户看到的就是「只拉一个会话却多出一个空窗口」。
 * 只有「连 codex 都找不到」才把窗口留在原地：这类错误一闪就没法排查。
 *
 * wt 会把带空格的 `-Command` 长字符串重拼引号（实测整条命令被当成一个可执行文件名，
 * 0x80070002），所以命令必须走 `-EncodedCommand`（单 token，wt 原样透传）。
 */
export function codexHeadWindowLaunch(input: {
  cwd: string;
  sessionId: string;
  endpoint: string;
  codexCommand?: CodexCommand;
}): { command: string; args: string[] } {
  const quote = (value: string): string => `'${value.replace(/'/g, "''")}'`;
  const codexInvocation = input.codexCommand === undefined
    ? "codex"
    : `& ${[input.codexCommand.command, ...input.codexCommand.prefixArgs].map(quote).join(" ")}`;
  const script = [
    `if (${input.codexCommand === undefined ? "-not (Get-Command codex -ErrorAction SilentlyContinue)" : "$false"}) {`,
    `Write-Host '找不到 codex 命令（PATH 里没有），无法 attach 本会话。' -ForegroundColor Red;`,
    `Read-Host '按回车关闭窗口';`,
    `exit 0`,
    `};`,
    `do { Start-Sleep -Milliseconds 500 }`,
    `until (Get-ChildItem "$env:USERPROFILE\\.codex\\sessions" -Recurse -Filter '*${input.sessionId}*' -ErrorAction SilentlyContinue)`,
    `; ${codexInvocation} resume ${quote(input.sessionId)} --remote ${quote(input.endpoint)}`,
    // codex 退出（正常退出 / 崩 / 连接断）= 这条会话不在电脑上了，窗口不该留。
    // 必须显式 `exit 0`：WT 的 closeOnExit 缺省只在退出码为 0 时关窗格，
    // 拿 codex 的退出码（`exit` 不带参数会沿用 $LASTEXITCODE）会留下一个死窗格。
    `; exit 0`,
  ].join(" ");
  return {
    command: "wt.exe",
    args: [
      "-d",
      input.cwd,
      "powershell",
      "-NoProfile",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
  };
}

/** 缺省开窗实现：wt 里跑 {@link codexHeadWindowLaunch} 那条命令。 */
function defaultOpenHeadWindow(input: { sessionId: string; cwd: string; endpoint: string }): void {
  if (process.env.PI_REMOTE_CODEX_HEAD === "0") return;
  const launch = codexHeadWindowLaunch(input);
  try {
    const child = spawn(launch.command, launch.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    // 开窗失败只影响本机可见性，不该回滚已经成功的激活。
  }
}

/**
 * 生成关闭 Codex TUI 的 PowerShell 脚本（输出被结束的进程数）。
 *
 * sessionId 来自手机，必须按字面量匹配：用 `.Contains()` 而非 `-like`，避免 `[`/`*`
 * 被当成通配符；嵌进单引号字符串前把 `'` 双写。等待窗口只有 base64 的
 * `-EncodedCommand`，把它解码成 UTF-16 文本后再匹配同一对 `resume <id>` + `--remote`。
 */
function codexTuiKillScript(sessionId: string, endpoint: string): string {
  const quote = (value: string) => value.replace(/'/g, "''");
  const target = quote(`resume ${sessionId}`);
  const remote = quote(endpoint);
  return [
    `$target = '${target}'`,
    `$remote = '${remote}'`,
    `$killed = 0`,
    `Get-CimInstance Win32_Process -Filter "Name='codex.exe' OR Name='node.exe'" -Property ProcessId,CommandLine |`,
    `  Where-Object { $_.CommandLine -and $_.CommandLine.Contains($remote) -and $_.CommandLine.Contains($target) } |`,
    `  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $killed++ }`,
    `Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -Property ProcessId,CommandLine |`,
    `  Where-Object { $_.ProcessId -ne $PID } |`,
    `  ForEach-Object {`,
    `    $m = [regex]::Match([string]$_.CommandLine, '-EncodedCommand\\s+(\\S+)')`,
    `    if ($m.Success) {`,
    `      try {`,
    `        $decoded = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($m.Groups[1].Value))`,
    `        if ($decoded.Contains($target) -and $decoded.Contains($remote)) { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $killed++ }`,
    `      } catch {}`,
    `    }`,
    `  }`,
    `Write-Output $killed`,
  ].join("\n");
}
