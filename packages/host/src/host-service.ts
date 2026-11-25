/**
 * Host 主服务：身份 + 配对 + 每台设备的多条 Path + 本机 runtime 路由（spec §7.1 的「桌面侧聚合者」最小形态）。
 *
 * 三个方向各一句话：
 * - 设备 → 本机：`data` 载荷里是 `runtime.command`，按 `runtimeId` 投给 loopback 上注册的进程。
 * - 本机 → 设备：runtime 的 `runtime.event` / 二进制帧包成 `data` 载荷广播给所有就绪设备。
 * - 设备的多条 Path：Relay 常驻做控制面，LAN 与 Relay 并存时由 `DeviceLink` 选，换路后
 *   主动把结果告诉手机（§6.2 / §14 B4）。
 *
 * 会话目录聚合、进程激活能力（`browse` / L1 / L2）见 `sessions.ts` / `spawner.ts`（spec §8）。
 */
import { homedir, hostname } from "node:os";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createProcessToolContentStore, type ToolContentStore } from "@orbis/runtime-bridge";
import { TurnFileChangeService } from "./turn-file-change-service.js";
import { TurnChangeCoordinator } from "./turn-change-coordinator.js";
import { ToolContentService } from "./tool-content-service.js";
import { PiToolContentReader } from "./pi-tool-content-reader.js";
import { AgentToolInventory, type PreparedToolInventory } from "./agent-tool-inventory.js";
import { ToolInventoryIngestion } from "./tool-inventory-ingestion.js";
import { relayHistoryMode, type RelayHistoryMode } from "./history-delivery.js";
import { PushWakeReceipts } from "./push-wake.js";
import { HermesHostConnection, type HermesHostOptions } from "./hermes-host-connection.js";
import type { HermesAgentBackend } from "./hermes-agent-backend.js";
import { AgentDisableConfirmationRequired, AgentLifecycleRegistry, type AgentEnablementController, type AgentEnablementSnapshot, type AgentLifecycleLease, type AgentLifecycleRegistration } from "./agent-enablement.js";
import { LiveActivityPublisher } from "./live-activity.js";
import { sharedViewBackend } from "./shared-session-view.js";
import { KeyedLanes, ProviderLaunchGate, providerGroup } from "./launch-lanes.js";

import {
  E2eError,
  findActiveDeviceRecord,
  isE2eError,
  loadDeviceStore,
  loadOrCreateHostIdentity,
  resolveStateDir,
  revokeDeviceRecord,
  saveDeviceStore,
  upsertDeviceRecord,
  type DeviceRecord,
  type DeviceStore,
  type HostIdentity,
  type PairingQrLanEndpoint,
} from "@orbis/e2e";
import {
  DeviceE2ePayloadSchema,
  DEVICE_FEATURE_MESSAGE_RENDER,
  DEVICE_FEATURE_OPENCODE,
  DEVICE_FEATURE_KIMI_CODE,
  DEVICE_FEATURE_KIMI_CODE_DESKTOP,
  DEVICE_FEATURE_OPENCLAW,
  DEVICE_FEATURE_HERMES,
  DEVICE_FEATURE_COMPACT_BOOTSTRAP,
  DEVICE_FEATURE_CLAUDE_SEND_NOW,
  RUNTIME_CLOSE_FEATURE,
  RUNTIME_CLOSE_CAPABILITY,
  RUNTIME_VIEW_CLOSE_FEATURE,
  RUNTIME_VIEW_CLOSE_CAPABILITY,
  agentTasksAllowQuit,
  type AgentExecutionState,
  type AgentDeliveryItem,
  type AgentCapabilityItem,
  CODEX_UNIFIED_HISTORY,
  HOST_FEATURE_DEVICE_FEATURES,
  HOST_FEATURE_IMPORT_TARGET,
  HOST_FEATURE_WEB_PREVIEW,
  HOST_FEATURE_NATIVE_FILE_PREVIEW,
  HOST_FEATURE_SESSION_SPAWN_AUTO,
  DEVICE_FEATURE_EXPLICIT_TUI,
  AGENT_ENABLEMENT_FEATURE,
  AGENT_ENABLEMENT_REVIEW_FEATURE,
  PROTOCOL_VERSION,
  type AgentDisableReview,
  type AgentKind,
  type HostProviderSummary,
  type AgentSessionSummary,
  type CodexDesktopAttach,
  type CodexLaunchMode,
  type DshDesktopAttach,
  type DeviceE2ePayload,
  type EnvelopeChannel,
  type EnvelopeV2,
  type ExternalImportTarget,
  type OutboundQueueSource,
  type PathKind,
  type HostCatalogBackend,
  type HostCatalogRange,
  type AgentStateRangeRequest,
  type HostManagementState,
  type HostWorkspacesState,
  type HostSharedOperation,
  type RelayToDeviceMessage,
  type RuntimeMetadata,
  type RuntimeEvent,
  type SessionLaunchResult,
  assertToolWireBudget,
  agentKeyId,
} from "@orbis/protocol";

import { AgentStateFacts } from "./agent-state-facts.js";
import { AgentStateRegistry, type StateScope } from "./agent-state-registry.js";
import { buildAgentStateSnapshot, buildAgentStateSnapshotParts } from "./agent-state-snapshot.js";
import { AgentStateSubscriptions } from "./agent-state-subscriptions.js";
import { AgentConversationState } from "./agent-conversation-state.js";
import { DeviceMessageRendering } from "./device-message-rendering.js";
import { MessageFileReferences } from "./message-file-references.js";
import { DeviceViewFacts } from "./device-view-facts.js";
import { RuntimeCommandLifecycle } from "./runtime-command-lifecycle.js";
import {
  DiagnosticJournal, type DiagnosticAppendInput, type DiagnosticPageRequest,
} from "./diagnostic-journal.js";
import { createDiagnosticJournalFileStore } from "./diagnostic-journal-file-store.js";
import { buildDiagnosticsPageMessage } from "./diagnostic-page-message.js";
import { HostStateFacts, providerSwitchingFact } from "./host-state-facts.js";
import { HostDownloadService, hostArtifactIndexPath } from "./artifact-download.js";
import { normalizeDeviceRequest } from "./device-protocol.js";
import { FieldTrafficMeter } from "./field-traffic-meter.js";
import { SessionWireContent } from "./session-wire-content.js";
import { encodeDeviceMessage, omitRuntimeSendNow, projectCompactDeviceMessage, type DeviceMessageProjectionOptions } from "./device-message-projection.js";
import { CompactStateModel } from "./compact-state-model.js";
import { HostUploadService, hostUploadIndexPath } from "./artifact-upload.js";
import type { AgentActivateContext, AgentBackend, BackendActivation, NativeRunningSession } from "./agent-backend.js";
import { AgentLaunchRevoked, ClaudeBackend, PiBackend } from "./agent-backend.js";
import type { KimiRuntime } from "./kimi-runtime.js";
import { isKimiId, kimiKindFromId, KIMI_DESKTOP_KIND, KIMI_KIND, KimiLaunchBlocked, kimiLocalDirectory, type KimiKind } from "./kimi-sessions.js";
import { ClaudeArchiveStore, ClaudeSessionCatalog } from "./claude-catalog.js";
import { ClaudeHookBridge } from "./claude-hook-bridge.js";
import { TerminalClaudeLauncher, type ClaudeLauncher } from "./claude-launcher.js";
import { ClaudeModsBridge } from "./claude-mods-bridge.js";
import { claudeConfigDir } from "./claude-transcript.js";
import { relayHttpBase } from "./config.js";
import { CodexRuntime } from "./codex-runtime.js";
import { CodexHistoryCatalog, codexMode, isCodexHistoryId, isCodexKind, type CodexHistoryRead } from "./codex-history-catalog.js";
import { OpenCodeServiceConnection, type OpenCodeServiceStatus } from "./opencode-service-connection.js";
import { OpenCodeBackend } from "./opencode-backend.js";
import type { DshRuntime } from "./dsh-runtime.js";
import { DSH_DESKTOP_KIND, OPENCODE_KIND, OPENCODE_RUNTIME_PREFIX, policyAgentViews, allowsAgent, allowsAgentIdentity, allowsAgentRequest, allowsRuntime, applyDeviceViewEpoch, deviceAgentView,
  hiddenKinds, negotiatedAgentFeature, projectAgentMessage, projectBackendDomain, type AgentView } from "./device-agent-visibility.js";
import { OpenClawBackend } from "./openclaw-backend.js";
import { loadOpenClawConfig, type OpenClawConfig } from "./openclaw-gateway.js";
import { localOpenClawPort, type OpenClawLocalLauncher } from "./openclaw-local-launch.js";
import { LocalAgentStart } from "./local-agent-start.js";
import { OPENCLAW_PREFIX } from "./openclaw-history.js";
import { describeError } from "./describe-error.js";
import { parseGitBranchRequest, readGitBranch, type GitBranchRequest } from "./git-branch.js";
import { DeviceLink, type ActivePathChange, type PathSink } from "./device-link.js";
import { outboundQueueAdmissionRecord, outboundQueueDiagnosticRecords, outboundQueueSource } from "./outbound-queue-diagnostics.js";
import { DEFAULT_LAN_PORT, HostLanServer, localLanEndpoints, parseLanDiscoveryRequest, type LanDiscoveryRequest } from "./lan-server.js";
import { HostLoopbackServer, type CodexLaunchRequest, type CodexLaunchResult } from "./loopback-server.js";
import { HostPairingService, requestPairingCode, type OpenedPairingWindow } from "./pairing.js";
import { describePath, type PathChange } from "./path.js";
import { SessionSyncTasks } from "./session-sync-tasks.js";
import { readFullSessionEntry } from "./session-entry-read.js";
import { NotificationStore } from "./notification-store.js";
import { HostRelayClient, type HostRelayState, type RelayAuthenticationError } from "./relay-client.js";
import { browseDirectory, listPiSessions } from "./sessions.js";
import { ActivationError, SessionSpawner } from "./spawner.js";
import { ClaudeStartupBlocked } from "./claude-startup.js";
import { SessionArchiveError } from "./session-archive.js";
import { ProviderManager, ProviderError } from "./provider-manager.js";
import { SessionConfigurationStore, SessionConfigurationError, validateSessionConfiguration } from "./session-configuration-store.js";
import { parseVoiceCleanupRequest, runVoiceCleanup, VOICE_CLEANUP_FEATURE, type VoiceCleanupRequest } from "./voice-cleanup.js";
import { parseProviderRequest, providerResult, type ProviderRequest } from "./provider-messages.js";
import type { UsageSnapshot } from "./provider-usage-cache.js";

/**
 * 会话目录（`session.list`）的缓存时长。
 *
 * 目录是只读且变化很慢的数据，而拉一次不便宜（Codex `thread/list` 2.5–6s）。
 * 手机在激活/重连/回前台时都会请求，短 TTL 足以把那些重复请求收敛成一次扫描，
 * 又不至于让用户察觉「刚建的会话不在列表里」——激活路径另走 `#invalidateCatalog`。
 */
const CATALOG_TTL_MS = 5_000;
type DshKind = "dsh" | "dshDesktop";
const DSH_KINDS: readonly DshKind[] = ["dsh", "dshDesktop"];
const KIMI_KINDS: readonly KimiKind[] = [KIMI_KIND, KIMI_DESKTOP_KIND];
const isKimiKind = (kind: AgentKind | undefined): kind is KimiKind => kind === KIMI_KIND || kind === KIMI_DESKTOP_KIND;
const OPENCLAW_KIND = "openclaw" as const;
type DshSlot = {
  runtime?: DshRuntime | undefined; starting?: Promise<DshRuntime | undefined> | undefined; startingExistingOnly: boolean;
  recoveryTimer?: ReturnType<typeof setTimeout> | undefined; recoveryError?: string | undefined;
};
/** LAUNCH-QUEUE-01 lane keys: a launch identity is scoped to its device, a session ID to the Host. */
const launchLane = (deviceId: string, launchId: string): string => JSON.stringify(["launch", deviceId, launchId]);
const sessionLane = (sessionId: string): string => JSON.stringify(["session", sessionId]);
/** The backend a resume addresses, from its explicit kind or namespaced ID; a legacy bare ID stays undefined. */
function resumeAgentKind(target: { sessionId: string; agentKind?: AgentKind | undefined }): AgentKind | undefined {
  const id = target.sessionId, history = isCodexHistoryId(id as unknown);
  return (kimiKindFromId(id) ?? target.agentKind) ?? (id.startsWith(OPENCLAW_PREFIX) ? OPENCLAW_KIND : id.startsWith("hermes:") ? "hermes"
    : history ? "codex" : id.startsWith("codex-desktop:") ? "codexDesktop"
    : id.startsWith("dsh-desktop:") ? "dshDesktop" : id.startsWith("dsh:") ? "dsh" : undefined);
}
function legacyKimiLaunchKind(value: { agentKind?: AgentKind | undefined; sessionId?: string | undefined }, binding?: string): KimiKind | undefined {
  const identity = value.sessionId ? kimiKindFromId(value.sessionId) : undefined;
  if (identity) return identity;
  return value.agentKind === KIMI_KIND && binding?.startsWith("kimi-code:desktop-") ? KIMI_DESKTOP_KIND : undefined;
}
/**
 * 一条 Host→设备的消息该走哪个 channel（票 07）。
 *
 * 分类影响**两件事**，所以分错不再是「少一层隔离」那么轻：
 *
 * - **序号流**：`bulk` 丢帧不连累控制面（票 07）。
 * - **投递顺序**：出站多路复用器（`OutboundChannelMux`）让 `ctl` 插队，`msg` / `bulk` 按水位
 *   让路。把交互帧错分成 `bulk`，它就要排在分片后面——正是「下载一开，什么都点不动」。
 *
 * 判据因此取得很宽：
 *
 * - 会带 graph / 消息 / 会话目录体量的 → `msg`（它们可能是几百 KB 到几 MB）
 * - 其余（状态、命令结果、交互、握手补发）→ `ctl`
 *
 * 分片不走这里：它们是 `bin` 帧，由 `DeviceLink.sendBinary` 直接打上 `bulk`。
 */
export function channelForDeviceMessage(message: {
  type: string;
  event?: { type?: string };
  scope?: string;
  domains?: readonly { domain?: string }[];
  missing?: readonly { domain?: string }[];
  unchanged?: readonly string[] | undefined;
}): EnvelopeChannel {
  // Both initial execution reads and updates must bypass queued chat-history msg frames.
  if (message.type === "agent.state.snapshot" && message.scope === "agent") {
    const domains = [...(message.domains ?? []), ...(message.missing ?? [])].map(entry => entry.domain)
      .concat(message.unchanged ?? []);
    if (domains.length > 0 && domains.every(domain => domain === "execution")) return "ctl";
  }
  if (message.type === "agent.state.snapshot" || message.type === "agent.state.range.page" || message.type === "session.catalog.page" || message.type === "diagnostics.page" || message.type === "transport.fields.page") return "msg";
  if (message.type !== "runtime.event") return "ctl";
  const eventType = message.event?.type ?? "";
  if (eventType === "session.tool.content.page" || eventType === "session.change.detail.page") return "bulk";
  if (eventType === "session.changes.failed") return "ctl";
  if (eventType === "session.tool.read.failed") return "ctl";
  if (
    eventType.startsWith("session.") ||
    eventType.startsWith("message.") ||
    eventType.startsWith("turn.") ||
    eventType.startsWith("tool.")
  ) {
    return "msg";
  }
  return "ctl";
}

/** 水位告警的节流窗口，与 relay 的 `MUX_WARN_INTERVAL_MS` 同一判据。 */
const BULK_WARN_INTERVAL_MS = 10_000;

import type { RelayTransportMode, RelayTransportKind, RelaySocketOptions } from "./relay-socket.js";

export type HostServiceOptions = {
  relayUrl: string;
  relayTransport?: RelayTransportMode;
  relayHistoryMode?: RelayHistoryMode;
  relaySocketOptions?: RelaySocketOptions;
  credential: string;
  /** 只在 `pair` 时用得到：签发设备管道凭据。 */
  adminToken?: string;
  stateDir?: string;
  reconnect?: boolean;
  /** ADR-0090: recommend `auto` to clients using the Linux headless CLI profile. */
  preferAutoSessionSpawn?: boolean;
  /** 关掉本机 loopback 端点（只有测试会这么做：它要的是纯 Relay 路径）。 */
  loopback?: boolean;
  /** 关掉 LAN 端点。关掉后只剩 Relay 一条路径，不影响其他功能。 */
  lan?: boolean;
  /**
   * 是否真的监听 LAN 端口。`orbis pair` 传 `false`：它是个短命进程，去 bind 常驻 Host
   * 已经在用的端口只会失败（或者更糟：被它抢走，然后随进程退出而消失）。
   * 注意它不影响二维码里的 LAN 地址——那部分是枚举出来的，不需要监听。
   */
  lanListen?: boolean;
  /** LAN 监听端口。默认 42130——二维码要能在一个短命进程里写死它（见 `lan-server.ts`）。 */
  lanPort?: number;
  /** 可用路径的 RTT 探测间隔（毫秒）。默认两秒；0 表示不探。测试会调小它。 */
  probeIntervalMs?: number;
  /**
   * `bulk`（artifact 分片）的速率上限，字节/秒。`0`/缺省 = 不限速。
   *
   * 它管的是**平均**带宽（桶空就丢这一片，靠 pull 重传自愈）；「分片不许堵住控制帧」是
   * 出站多路复用器的职责，与这个上限无关——即使限速全开，控制帧也照样插队。
   */
  bulkBytesPerSecond?: number;
  /** Grace period for compact-state bootstrap before replaying the full legacy menu. */
  bootstrapReplayDelayMs?: number;
  /** Pi 会话根目录。测试注入临时目录；缺省 `~/.pi/agent/sessions`。 */
  sessionsRoot?: string;
  /** 进程激活器。测试注入 mock；缺省真 spawner（spec §8）。 */
  spawner?: SessionSpawner;
  /**
   * Codex 后端（spec §7.4，M4）。由调用方负责 app-server 子进程的生命周期
   * （CLI 在 `--codex` 时创建并 stop）；缺省/未传 = 不启用 Codex。
   */
  codexRuntime?: CodexRuntime;
  codexDesktopRuntime?: CodexRuntime;
  /** Connection monitor; a production launcher is injected only when local startup is permitted. */
  opencodeConnection?: OpenCodeServiceConnection | false;
  createOpenCodeConnection?: () => OpenCodeServiceConnection;
  /** 按需启动并连接 Codex 桌面版；返回的 runtime 会被动态挂载到本服务。 */
  ensureCodexDesktop?: () => Promise<CodexRuntime | undefined>;
  /** Codex 桌面版已安装，可在手机新建会话时按需启动；不代表 GUI 当前在线。 */
  codexDesktopLaunchable?: boolean;
  ensureCodexRuntime?: () => Promise<CodexRuntime | undefined>;
  prepareManagedCodex?: (kind: "codex" | "codexDesktop", lease: AgentLifecycleLease) => Promise<boolean>;
  releaseManagedCodex?: (kind: "codex" | "codexDesktop") => Promise<void>;
  /**
   * Codex 桌面版 app-server 此刻的接入分档（ADR-0022），随 `device.ready` 下发。
   * 缺省/返回 `undefined` 时下发 `null`：手机端只能知道「不知道」，不能把它当成未接入。
   */
  codexDesktopStatus?: () => CodexDesktopAttach | undefined;
  /** 终端 shim 通过 loopback 请求官方 Codex TUI 接入 Host app-server。 */
  codexLaunch?: (request: CodexLaunchRequest) => Promise<CodexLaunchResult>;
  dshRuntime?: DshRuntime;
  /** DeepSeek Harness 已安装时可按需启动；连接可用时直接复用，不重复创建。 */
  ensureDshRuntime?: () => Promise<DshRuntime | undefined>;
  /** Reconnect only to an existing authenticated service; automatic recovery must never launch DSH. */
  recoverDshRuntime?: () => Promise<DshRuntime | undefined>;
  /** DeepSeek Harness 已安装且 Host 可启动；与当前是否已连接分开公告。 */
  dshLaunchable?: boolean;
  prepareManagedDsh?: (kind: DshKind, lease: AgentLifecycleLease) => Promise<boolean>;
  releaseManagedDsh?: (kind: DshKind) => void;
  /** DeepSeek Harness Desktop (ADR-0076): a separate entry with its own kind, namespace and connection. */
  dshDesktopRuntime?: DshRuntime;
  /** Local Kimi Web or Desktop adapter. */
  kimiCodeRuntime?: KimiRuntime;
  createKimiCodeRuntime?: (kind: KimiKind) => Promise<KimiRuntime>;
  kimiCodeDesktopSupported?: boolean;
  /** Open Desktop when closed and attach to the backend it owns; never a substitute Web service. */
  ensureDshDesktopRuntime?: () => Promise<DshRuntime | undefined>;
  /** Reconnect only to the Desktop instance Orbis launched; automatic recovery never opens Desktop. */
  recoverDshDesktopRuntime?: () => Promise<DshRuntime | undefined>;
  /** A usable Desktop installation exists. */
  dshDesktopLaunchable?: boolean;
  /** Desktop attach tier (DSH-DESKTOP-01), published only to devices that declared `agent.dshDesktop`. */
  dshDesktopStatus?: () => DshDesktopAttach | undefined;
  /** Orbis's Desktop connection ended; Desktop itself is not stopped (DSH-DESKTOP-07). */
  onDshDesktopOffline?: (reason: string) => void;
  /**
   * Claude Code's transcript directory and phone-opened terminals (ADR-0033). Absent, Claude
   * Sessions appear only while an attached TUI reports in.
   */
  claude?: { configDir?: string; launcher?: ClaudeLauncher };
  /** Explicit isolated fixture, or false to prevent QA from inheriting a user's opt-in. */
  openClaw?: OpenClawConfig | false;
  openClawLauncher?: OpenClawLocalLauncher;
  /** Staged composition: only sources with a registered lifecycle can be edited by paired clients. */
  agentEnablement?: AgentEnablementController;
  prepareLocalAgent?: (kind: "pi" | "claude", lease: AgentLifecycleLease) => Promise<void>;
  hermes?: HermesHostOptions;
  providers?: ProviderManager;
  providerUsage?: (kind: AgentKind, providerId: string) => UsageSnapshot | undefined;
  managementBackends?: () => HostManagementState["backends"];
  log?: (line: string) => void;
  /** 配对成功。调用方负责对外报告；落盘已经由 HostService 完成。 */
  onPaired?: (device: DeviceRecord) => void;
  /** 收到某台设备发来的、已解密的业务载荷，且**没有**被本机业务消化掉。 */
  onData?: (deviceId: string, payload: Buffer) => void;
  /** 单台设备的帧处理失败。坏帧不该放倒整条 Host 连接。 */
  onDeviceError?: (deviceId: string, error: unknown) => void;
  /** 某台设备的生效路径变了（§6.2）。 */
  onPathChange?: (deviceId: string, change: ActivePathChange) => void;
  onStateChange?: (state: HostRelayState) => void;
  onRelayAuthenticationError?: (error: RelayAuthenticationError) => void;
};

export class HostService {
  readonly #options: HostServiceOptions;
  readonly #stateDir: string;
  readonly #identity: HostIdentity;
  readonly #store: DeviceStore;
  readonly #pairing: HostPairingService;
  readonly #links = new Map<string, DeviceLink>();
  readonly #sessionSync: SessionSyncTasks;
  readonly #toolContentService: ToolContentService;
  readonly #fileChanges: TurnFileChangeService;
  readonly #fileChangeTurns: TurnChangeCoordinator;
  readonly #changeSubscribers = new Map<string, { runtimeId: string; agentId: string }>();
  readonly #changesEpoch = randomUUID();
  #changesRevision = 0;
  readonly #piToolContents: PiToolContentReader;
  readonly #toolInventory: AgentToolInventory;
  readonly #toolIngestion: ToolInventoryIngestion;
  #toolContentStore: ToolContentStore | undefined;
  #toolDiagnosticTimer: ReturnType<typeof setInterval> | undefined;
  readonly #toolTraffic = new Map<string, Record<"summaryJsonBytes" | "bodyJsonBytes" | "detailJsonBytes" | "readRequests" | "readFailures" | "gapResponses", number>>();
  #relay: HostRelayClient | undefined;
  #loopback: HostLoopbackServer | undefined;
  #lan: HostLanServer | undefined;
  readonly #spawner: SessionSpawner;
  /**
   * 本机的全部 agent 后端（spec §7.4 的适配器收口）。顺序即 resume 的尝试顺序：
   * Pi 在前（磁盘会话），Codex 在后（thread 空间）。分派只面向 `AgentBackend`
   * 接口，不为单个后端写特判。
   */
  #backends: AgentBackend[];
  #openClaw: OpenClawBackend | undefined;
  #openClawStart: { startup: LocalAgentStart; installed: boolean } | undefined;
  readonly #managedDshLaunchable = new Set<DshKind>();
  readonly #managedCodexLaunchable = new Set<"codex" | "codexDesktop">();
  readonly #managedAgents = new AgentLifecycleRegistry({
    pi: { start: async lease => this.#options.prepareLocalAgent?.("pi", lease), stop: async () => { this.#loopback?.disconnectRuntimes("agent_disabled"); } },
    claude: {
      start: async lease => {
        await this.#options.prepareLocalAgent?.("claude", lease);
        if (lease.isCurrent()) await this.#startClaudeBridge(lease.isCurrent);
      },
      stop: async () => {
        this.#claudeLaunchable = false;
        this.#stopClaudeBridge();
      },
    },
    codex: { start: lease => this.#startManagedCodex("codex", lease), stop: () => this.#stopManagedCodex("codex") },
    codexDesktop: { start: lease => this.#startManagedCodex("codexDesktop", lease), stop: () => this.#stopManagedCodex("codexDesktop") },
    dsh: { start: lease => this.#startManagedDsh("dsh", lease), stop: () => this.#stopManagedDsh("dsh") },
    dshDesktop: { start: lease => this.#startManagedDsh("dshDesktop", lease), stop: () => this.#stopManagedDsh("dshDesktop") },
    kimiCode: { start: lease => this.#startManagedKimi(KIMI_KIND, lease), stop: () => this.#stopManagedKimi(KIMI_KIND) },
    kimiCodeDesktop: { start: lease => this.#startManagedKimi(KIMI_DESKTOP_KIND, lease), stop: () => this.#stopManagedKimi(KIMI_DESKTOP_KIND) },
    hermes: {
      start: async lease => {
        if (!this.#options.hermes || !lease.isCurrent()) return;
        const connection = this.#hermes = this.#makeHermesConnection(this.#options.hermes, lease.isCurrent);
        await connection.discover();
      },
      stop: async () => {
        const connection = this.#hermes;
        this.#hermes = undefined;
        if (connection?.backend) this.#updateHermesBackend(undefined, connection.backend);
        await connection?.close();
      },
    },
    opencode: { start: async lease => this.#startOpenCode(true, lease.isCurrent), stop: async () => this.#stopOpenCode() },
    openclaw: { start: async lease => this.#startOpenClaw(lease.isCurrent), stop: async () => this.#stopManagedOpenClaw() },
  } satisfies Record<AgentKind, AgentLifecycleRegistration>, (kind, phase) => this.#options.log?.(`Agent ${kind} ${phase} failed`));
  #managedPolicy: AgentEnablementSnapshot | undefined;
  #disabledSources = new Set<AgentKind>();
  #unsubscribeEnablement: (() => void) | undefined;
  #hermes: HermesHostConnection | undefined;
  #kimi: Partial<Record<KimiKind, KimiRuntime>> = {};
  /** Keep the per-backend announcement ledger aligned when a viewer detaches. */
  readonly #hermesAnnouncements = new Map<HermesAgentBackend, Set<string>>();
  /** DSH Web and Desktop each own their connection, start and recovery state (ADR-0076 DSH-DESKTOP-03). */
  readonly #dsh: Record<DshKind, DshSlot> = { dsh: { startingExistingOnly: false }, dshDesktop: { startingExistingOnly: false } };
  /** Features each device declared on its current handshake (ADR-0064); absent = released App behaviour. */
  readonly #deviceFeatures = new Map<string, ReadonlySet<string>>();
  /** ADR-0084: project source messages once per representation at the device boundary. */
  readonly #messageFileReferences = new MessageFileReferences();
  readonly #deviceMessageRendering = new DeviceMessageRendering(this.#messageFileReferences);
  /** A new view cannot reuse an old view's known revisions, including on same-host downgrade. */
  readonly #deviceViewEpochs = new Map<string, string>();
  readonly #workspaceViews = new Map<AgentView, HostWorkspacesState>();
  readonly #claudeBridge: ClaudeHookBridge;
  readonly #claudeModsBridge: ClaudeModsBridge;
  readonly #claudeBackend: ClaudeBackend;
  readonly #claudePublishedRuntimes = new Set<string>();
  readonly #claudeRejections = new Map<string, number>();
  #claudeLaunchable = false;
  #claudeModsSweep: ReturnType<typeof setInterval> | undefined;
  readonly #downloads: HostDownloadService;
  readonly #uploads: HostUploadService;
  /**
   * 每个 (runtimeId, channel) 已知的最大事件序号。
   *
   * Host 自己也会产生事件（下载的 `artifact.started` 等），而手机按序号去重
   * （`sequence <= lastSequence` 一律丢弃），所以从 Host 出去的事件序号必须是
   * 严格递增的——不管它来自 Pi 还是来自 Host 自己。
   *
   * 键是 **(runtimeId, channel) 复合**（issue 02）：事件按 `ctl`/`msg` 分道投递，
   * `ctl` 插队是常态，跨道的到达顺序不再代表发送顺序。全局一条流水的话，
   * 后到的 `ctl` 会把先发出的 `msg` 事件的水位线永久抬高——手机从此丢掉所有
   * 更小的 `msg` 序号。按道各记一份之后，插队变得无害。
   */
  readonly #eventSequences = new Map<string, number>();
  // undefined = capability offered but no accepted interest; null = explicitly closed.
  readonly #historyInterests = new Map<string, { runtimeId: string; sessionId: string } | null | undefined>();
  readonly #catalogQueryDevices = new Set<string>();
  /**
   * ADR-0032 的统一状态模型：单写者 Registry + 适配层事实投影。
   *
   * 它只**登记**事实，不参与任何转发、路由或回执判定——事件该发还是照发，手机读到的
   * 仍是原来的消息。协议层接入（issue #10）之前，这里只供 Host 内部与测试读取。
   */
  readonly #agentFacts: AgentStateFacts;
  readonly #liveActivities: LiveActivityPublisher;
  /** DeviceView：只对发起设备可见的回执，和共享事实分开写。 */
  readonly #deviceViewFacts: DeviceViewFacts;
  /** HostState：Host 级共享领域（目前是聚合目录的逐后端完整性）。 */
  readonly #hostStateFacts: HostStateFacts;
  /** 有界诊断记录（ADR-0032 模块 23）：写不进去也不影响被记录的那次操作；落盘见构造函数。 */
  readonly #diagnostics: DiagnosticJournal;

  /** 记一条诊断：记录失败永远不能反过来影响被记录的那次操作。 */
  recordDiagnostic(input: DiagnosticAppendInput): void {
    if (this.#providerFactsClosing) return;
    try {
      this.#diagnostics.append({ ...input, hostId: this.#identity.hostId });
    } catch {
      // 诊断是旁路：它自己的失败只该留在日志里，不该冒泡给业务。
    }
    // 目录投影跟着记录一起刷新，客户端读模型就能看到「有多少记录、缺了多少」。
    this.#publishDiagnostics();
  }

  /** 读一页诊断记录（游标读；缺口语义见 DiagnosticJournal）。 */
  readDiagnostics(request: DiagnosticPageRequest = {}, view: AgentView = 0): ReturnType<DiagnosticJournal["page"]> {
    const page = this.#diagnostics.page(request, row => allowsAgentIdentity(view, row));
    // 读取本身会触发淘汰：顺手让目录投影跟当前窗口对齐。
    this.#publishDiagnostics();
    return page;
  }

  #recordAgentDiagnostic(runtimeId: string, category: string, message: string, severity: "info" | "warning" | "error" = "info", operationId?: string): void {
    const scope = this.#agentFacts.scopeOf(runtimeId);
    this.recordDiagnostic({ scope: scope ? "agent" : "host", agentKind: scope?.kind === "agent" ? scope.key.agentKind : kimiKindFromId(runtimeId) ?? null,
      sessionId: scope?.kind === "agent" ? scope.key.sessionId : isKimiId(runtimeId) ? runtimeId : null, category, severity, message,
      ...(operationId === undefined ? {} : { operationId }) });
  }

  #countToolTraffic(runtimeId: string, field: "summaryJsonBytes" | "bodyJsonBytes" | "detailJsonBytes" | "readRequests" | "readFailures" | "gapResponses", amount: number): void {
    if (!this.#toolTraffic.has(runtimeId) && this.#toolTraffic.size >= 256) this.#flushToolDiagnostics();
    const counts = this.#toolTraffic.get(runtimeId) ?? { summaryJsonBytes: 0, bodyJsonBytes: 0, detailJsonBytes: 0, readRequests: 0, readFailures: 0, gapResponses: 0 };
    counts[field] += amount; this.#toolTraffic.set(runtimeId, counts);
  }

  #flushToolDiagnostics(): void {
    if (!this.#toolTraffic.size) return;
    for (const [runtimeId, counts] of this.#toolTraffic) {
      const scope = this.#agentFacts.scopeOf(runtimeId);
      this.recordDiagnostic({ scope: scope ? "agent" : "host", agentKind: scope?.kind === "agent" ? scope.key.agentKind : null,
        sessionId: scope?.kind === "agent" ? scope.key.sessionId : null, category: "tool.content", severity: "info",
        message: "Tool projection and private read counters", detail: Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, String(value)])) });
    }
    this.#toolTraffic.clear();
    const usage = this.#toolContentStore?.usage;
    if (usage) this.recordDiagnostic({ scope: "host", agentKind: null, sessionId: null, category: "tool.content", severity: "info",
      message: "Producer temporary content usage", detail: Object.fromEntries(Object.entries(usage).map(([key, value]) => [key, String(value)])) });
  }

  #invalidateConversationBaseline(runtimeId: string, event: Extract<RuntimeEvent, { type: "session.snapshot" | "session.patch" }>, reason: string): boolean {
    const scope = this.#agentFacts.scopeOf(runtimeId);
    if (scope?.kind !== "agent") return false;
    this.#conversationState.invalidateBaseline(scope);
    this.recordDiagnostic({ scope: "agent", agentKind: scope.key.agentKind, sessionId: scope.key.sessionId,
      category: "recovery", severity: "warning", message: "Invalidated stale conversation baseline for source reconciliation",
      ...(event.type === "session.snapshot" ? { operationId: event.syncId } : {}),
      detail: { reason, runtimeId, eventType: event.type, sourceEpoch: event.source?.epoch ?? "missing",
        sourceSeq: String(event.source?.seq ?? "missing"),
        ...(event.type === "session.snapshot" ? { range: event.range ?? "missing" } : { baseSeq: String(event.baseSeq) }) } });
    return true;
  }

  #acceptConversation(runtimeId: string, event: Extract<RuntimeEvent, { type: "session.snapshot" | "session.patch" }>,
                      onRejected?: (reason: string) => void, verifiedPreview = false): boolean {
    const scope = this.#agentFacts.scopeOf(runtimeId);
    let reason = "runtime_scope_missing";
    let inventory: PreparedToolInventory | undefined;
    let accepted = false;
    try {
      accepted = scope !== undefined && this.#conversationState.accept(scope, event, (ready, verifiedBaseline) => {
        const facts = this.#agentFacts.prepareConversation(runtimeId, event, ready);
        if (!ready || scope.kind !== "agent" || !event.source || !event.live?.toolInventory) return facts;
        inventory = this.#toolIngestion.prepare(runtimeId, scope.key, event.source, event.live.toolInventory, verifiedBaseline);
        const plans = [inventory, ...(facts ? [facts] : [])];
        return { changes: plans.flatMap(plan => [...plan.changes]), conversationSource: inventory.conversationSource!,
          isCurrent: () => plans.every(plan => plan.isCurrent?.() !== false),
          onCommitted: () => { for (const plan of plans) plan.onCommitted(); } };
      }, code => { reason = code; }, verifiedPreview);
    } catch (error) { reason = error instanceof Error ? error.message : "tool_inventory_rejected"; }
    if (!accepted) onRejected?.(reason);
    if (accepted && inventory?.publication) this.#broadcastDeviceMessage(this.#runtimeEventMessage(runtimeId, inventory.publication));
    if (!accepted) this.recordDiagnostic({ scope: scope ? "agent" : "host",
      agentKind: scope?.kind === "agent" ? scope.key.agentKind : null, sessionId: event.sessionId,
      category: "recovery", severity: "warning", message: "Rejected conversation transaction; source baseline required",
      ...(event.type === "session.snapshot" ? { operationId: event.syncId } : {}),
      detail: { reason, runtimeId, eventType: event.type, sourceEpoch: event.source?.epoch ?? "missing",
        sourceSeq: String(event.source?.seq ?? "missing"), entries: String(event.entries?.length ?? 0),
        ...(event.type === "session.snapshot" ? { range: event.range ?? "missing", selection: event.selection ?? "none" } : { baseSeq: String(event.baseSeq) }) } });
    return accepted;
  }

  #markRuntimeOffline(runtimeId: string, reason: string): void {
    this.#sessionSync.runtimeOffline(runtimeId);
    this.#commandOwners.offline(runtimeId, reason);
    this.#toolInventory.closeRuntime(runtimeId);
    this.#toolIngestion.release(runtimeId);
    this.#toolContentService.releaseRuntime(runtimeId);
    void this.#fileChangeTurns.release(runtimeId).catch(() => undefined);
    this.#piToolContents.releaseRuntime(runtimeId);
    const scope = this.#agentFacts.scopeOf(runtimeId);
    if (scope) this.#conversationState.offline(scope, this.#agentFacts.prepareOffline(runtimeId));
    else this.#agentFacts.runtimeOffline(runtimeId, reason);
    this.#recordAgentDiagnostic(runtimeId, "recovery", "Source disconnected; current baseline requires reconciliation", "warning");
  }

  #registerClaudeRuntime(runtime: RuntimeMetadata): void {
    // Hooks and Mods share one public runtime. Keep Mods' history capability when a
    // permission Hook contributes its waiting status, just as directory snapshots do.
    runtime = this.#claudeBackend.directoryEntries().find(candidate => candidate.runtimeId === runtime.runtimeId) ?? runtime;
    const alreadyPublished = this.#claudePublishedRuntimes.has(runtime.runtimeId);
    const displaced = this.#agentFacts.displacedRuntime(runtime.runtimeId, runtime);
    if (displaced) this.#markRuntimeOffline(displaced.runtimeId, "replaced_by_new_runtime");
    this.#claudePublishedRuntimes.add(runtime.runtimeId);
    this.#agentFacts.observe(runtime.runtimeId, { type: "runtime.metadata", metadata: runtime });
    this.#notifications.attach(runtime.runtimeId, runtime.sessionId);
    if (alreadyPublished) this.#publishRuntimeEvent(runtime.runtimeId, { type: "runtime.metadata", metadata: runtime });
    else this.#broadcastDeviceMessage({ type: "runtime.online", runtime });
    this.refreshHostFacts();
  }

  /** A refused bridge is retried by the TUI every poll; record each distinct refusal once per ten minutes. */
  #recordClaudeRejection(reason: string, hello: { sessionId?: unknown; claudeVersion?: unknown; instanceId?: unknown }): void {
    const key = `${reason}|${typeof hello.instanceId === "string" ? hello.instanceId : ""}`;
    const now = Date.now();
    if ((this.#claudeRejections.get(key) ?? 0) > now - 600_000) return;
    this.#claudeRejections.set(key, now);
    while (this.#claudeRejections.size > 64) this.#claudeRejections.delete(this.#claudeRejections.keys().next().value!);
    this.#options.log?.(`拒绝 Claude Code 连接：${reason}`);
    this.recordDiagnostic({ scope: "host", agentKind: "claude",
      sessionId: typeof hello.sessionId === "string" ? hello.sessionId.slice(0, 256) : null,
      category: "backend.transport", severity: "warning", message: "Claude Code bridge refused",
      detail: { reason: reason.slice(0, 256), ...(typeof hello.claudeVersion === "string" ? { claudeVersion: hello.claudeVersion.slice(0, 64) } : {}) } });
  }

  #unregisterClaudeRuntime(runtimeId: string, reason: string): void {
    if (this.#claudeBridge.runtimeIds().includes(runtimeId) || this.#claudeModsBridge.runtimeIds().includes(runtimeId)) return;
    if (!this.#claudePublishedRuntimes.delete(runtimeId) && this.#agentFacts.scopeOf(runtimeId) === undefined) return;
    this.#markRuntimeOffline(runtimeId, reason);
    this.#notifications.offline(runtimeId);
    this.#broadcastDeviceMessage({ type: "runtime.offline", runtimeId, reason });
    this.refreshHostFacts();
  }

  /**
   * 设备视图的传输摘要（模块 24/33）：只发布这台设备自己未完成的上传和 Host 确认的持久前缀。
   * 手机本地前缀仍由 App 权威；这里不做 IO，值来自上传服务的内存状态。
   */
  #syncDeviceTransfers(deviceId: string): void {
    if (this.#serviceClosed) return;
    this.#deviceViewFacts.transfers(deviceId, this.#uploads.transfers(deviceId));
  }

  /** 读诊断目录投影（模块 23 的读取侧）；记录本身走 `readDiagnostics` 的游标分页。 */
  readHostDiagnostics(): ReturnType<HostStateFacts["readDiagnostics"]> {
    return this.#hostStateFacts.readDiagnostics();
  }

  /** 读当前的供应商投影（模块 20–22）；供 Host 内部与测试断言。 */
  readHostProviders(): ReturnType<HostStateFacts["readProviders"]> {
    return this.#hostStateFacts.readProviders();
  }

  /**
   * 现读一次各后端的供应商事实并写进 Host 模型（ADR-0032 模块 20–22）。
   *
   * **只有这里写 `HostState.providers`**：这个领域的写入是整值替换，而会话列表那条路径只认识
   * 「当前 provider」——让它写就会把这里读到的清单冲成 null。客户端点名 `providers` 域时、
   * 以及供应商切换/保存之后调用；读不到的那个后端如实记 null，不拿上一次的清单冒充这次读到。
   */
  refreshProviderFacts(): Promise<void> {
    if (this.#providerFactsClosing) return Promise.resolve();
    const work = this.#refreshProviderFacts();
    this.#providerFactsPending.add(work);
    void work.then(() => this.#providerFactsPending.delete(work), () => this.#providerFactsPending.delete(work));
    return work;
  }

  async #refreshProviderFacts(): Promise<void> {
    const manager = this.#options.providers;
    if (!manager && !this.#backends.some(backend => backend.currentProvider !== undefined)) {
      this.#hostStateFacts.unknown("providers"); return;
    }
    const generation = ++this.#providerFactsGeneration;
    const modelEpoch = this.#agentStateRegistry.currentModelEpoch();
    const kinds: AgentKind[] = ["pi", "codex", "dsh", "claude"];
    if (this.#backends.some(backend => backend.kind === "codexDesktop")) kinds.push("codexDesktop");
    const providers = await Promise.all(kinds.filter(kind => !this.#disabledSources.has(kind) || (kind === "codex" && !this.#disabledSources.has("codexDesktop"))).map(async (kind) => {
      const switching = providerSwitchingFact(this.#providerChanging, kind);
      const empty = { agentKind: kind, availability: "unknown" as const, current: null, profiles: null, authenticated: null, switching,
        usage: { availability: "unknown" as const, detail: null } };
      let summary: HostProviderSummary = empty;
      try {
        if (manager && kind !== "codexDesktop") summary = await manager.publicState(kind, { switching,
          ...(this.#options.providerUsage === undefined ? {} : { usage: this.#options.providerUsage }) });
      } catch (error) {
        if (this.#providerFactsClosing) return empty;
        const detail = describeError(error);
        this.#options.log?.(`读取 ${kind} 供应商清单失败：${detail}`);
        this.recordDiagnostic({
          scope: "host", agentKind: kind, sessionId: null, category: "provider", severity: "warning",
          message: `读取 ${kind} 供应商清单失败`, detail: { reason: detail.slice(0, 256) },
        });
        const previous = this.#hostStateFacts.readProviders()?.providers.find(provider => provider.agentKind === kind);
        summary = previous ? { ...previous, availability: "unknown" as const, switching } : empty;
      }
      // ADR-0032 §8：profile id 与原生会话 provider 分开；终端和桌面分别核对各自 app-server。
      if (kind === "codex" || kind === "codexDesktop") {
        const backend = this.#disabledSources.has(kind) ? undefined : this.#backends.find(candidate => candidate.kind === kind && candidate.isReady());
        let modelProvider: string | undefined;
        try { modelProvider = await backend?.currentProvider?.(); }
        catch (error) { this.#options.log?.(`读取 ${kind} 当前 provider 失败：${describeError(error)}`); }
        summary = { ...summary, modelProvider: backend && this.#backends.includes(backend) && backend.isReady() ? modelProvider ?? null : null };
      }
      return summary;
    }));
    if (!this.#providerFactsClosing && generation === this.#providerFactsGeneration && modelEpoch === this.#agentStateRegistry.currentModelEpoch()) {
      this.#hostStateFacts.providers({ providers });
      this.#hostStateFacts.catalogProviders(providers.flatMap((row: HostProviderSummary) => row.modelProvider ? [{ agentKind: row.agentKind, provider: row.modelProvider }] : []));
    }
  }

  /** Rebuild public service projections without IO. Clients read exactly this committed Host model. */
  refreshHostFacts(): void {
    if (this.#serviceClosed) return;
    const facts = this.#hostStateFacts;
    if (!facts) return;
    const runtimes = this.#runtimesSnapshot();
    for (const [id, operation] of this.#sharedOperations) {
      if (operation.state !== "accepted" && operation.state !== "running" && operation.updatedAt < Date.now() - 300_000) this.#sharedOperations.delete(id);
    }
    facts.identity({ hostId: this.#identity.hostId, hostName: this.#identity.hostName, protocolVersion: PROTOCOL_VERSION });
    const agents = this.#agentsSnapshot(); const launchableAgents = this.#launchableAgentsSnapshot();
    const kinds: AgentKind[] = ["pi", "codex", "codexDesktop", "dsh", "claude", "dshDesktop", ...(this.#openCodeBackend ? [OPENCODE_KIND] as const : []), ...KIMI_KINDS.filter(kind => this.#kimi[kind] !== undefined || this.#managedPolicy && !this.#disabledSources.has(kind) && (kind !== KIMI_DESKTOP_KIND || this.#options.kimiCodeDesktopSupported === true)), ...(this.#openClaw ? [OPENCLAW_KIND] : [])];
    if (this.#hermes?.installed) kinds.push("hermes");
    const openCodeReason = this.#opencodeConnection?.starting ? "starting" : this.#opencodeConnection?.status.state === "unavailable" ? this.#opencodeConnection.status.reason : "event_stream_unavailable";
    facts.backends({ backends: kinds.filter(kind => !this.#disabledSources.has(kind)).map(kind => {
      const backend = this.#backends.find(candidate => candidate.kind === kind);
      return { kind, ready: backend?.isReady() ?? false, launchable: launchableAgents.includes(kind),
        runtimeCount: runtimes.filter(runtime => backend?.ownsRuntime(runtime.runtimeId)).length,
        reason: backend?.isReady() ? null : kind === OPENCODE_KIND ? openCodeReason : kind === "hermes" && this.#hermes?.starting ? "starting" : backend === undefined ? "backend_not_attached"
          : isKimiKind(kind) ? this.#kimi[kind]?.reason ?? "backend_not_ready"
          : kind === OPENCLAW_KIND ? this.#openClawStart?.startup.starting ? "starting" : this.#openClaw?.pairingEpoch ? "pairing_required" : "backend_not_ready"
          : "backend_not_ready" };
    }), agents, launchableAgents, codexDesktop: this.#codexDesktopSnapshot(), dshDesktop: this.#dshDesktopSnapshot() });
    const catalog = this.#hostStateFacts.read();
    const candidates = [...(this.#catalogCache?.sessions ?? []), ...runtimes];
    const views = policyAgentViews(this.#disabledSources);
    for (const view of this.#workspaceViews.keys()) if (!views.includes(view)) this.#workspaceViews.delete(view);
    for (const view of views) {
      const grouped = new Map<string, Set<string>>();
      for (const session of candidates) {
        if (!session.cwd || !allowsAgentIdentity(view, session)) continue;
        const keys = grouped.get(session.cwd) ?? new Set<string>();
        keys.add(session.sessionId ?? "runtime:" + ("runtimeId" in session ? session.runtimeId : "")); grouped.set(session.cwd, keys);
      }
      const complete = catalog?.backends.filter(row => allowsAgent(view, row.kind)).every(row => row.complete) === true && !catalog.truncated;
      const value = { workspaces: [...grouped].slice(0, 256).map(([cwd, sessions]) => ({
        workspaceId: createHash("sha256").update(cwd).digest("hex"), cwd, sessionCount: sessions.size,
        git: this.#workspaceGit.get(cwd) ?? { availability: "unknown" as const, branch: null, head: null, repoRoot: null },
      })), truncated: grouped.size > 256 || !complete };
      if (view === 0) {
        facts.workspaces(value);
        for (const cwd of this.#workspaceGit.keys()) if (!grouped.has(cwd)) this.#workspaceGit.delete(cwd);
      } else this.#workspaceViews.set(view, facts.workspaceValue(value, this.#workspaceViews.get(view)));
    }
    facts.files(this.#downloads.inventory());
    const links = [...this.#links.values()];
    facts.connections({ pairedDevices: this.devices.filter(device => !device.revoked).length, connectedDevices: links.filter(link => link.active !== undefined).length,
      paths: (["lan", "relay"] as const).map(kind => ({ kind,
        attachedDevices: links.filter(link => link.paths.includes(kind)).length,
        activeDevices: links.filter(link => link.active === kind).length })), relayState: this.relayState, sequenceChannels: this.#eventSequences.size });
    facts.operations({ activationsPending: this.#activationsPending,
      commandsPending: [...this.#commandOwners.values()].filter(owner => !owner.terminal && owner.at >= Date.now() - 300_000).length,
      sync: this.#sessionSync.aggregateStats(), transfers: { uploads: this.#uploads.activeUploads, downloads: this.#downloads.activeDownloads }, retentionMs: 300_000,
      items: [...this.#sharedOperations.values()], truncated: this.#sharedOperationsTruncatedAt > Date.now() - 300_000 });
    facts.management({ lifecycle: this.#modelLifecycle, platform: process.platform, nodeVersion: process.version,
      backends: this.#options.managementBackends?.() ?? kinds.filter(kind => kind !== OPENCLAW_KIND).map(kind => ({ kind, installed: null, version: null })) });
  }

  /** Desktop and mobile share the same committed model and snapshot serializer. */
  readHostState(domains?: readonly string[]): ReturnType<typeof buildAgentStateSnapshot> {
    this.refreshHostFacts();
    return buildAgentStateSnapshot({ registry: this.#agentStateRegistry, requestId: "desktop:host-state", scope: { kind: "host" },
      ...(domains === undefined ? {} : { domains }) });
  }

  /** The first range read reconciles the source; cursor continuations read one committed immutable inventory. */
  async readHostRange(request: Pick<AgentStateRangeRequest, "cursor" | "limit"> = {}, hide?: readonly AgentKind[], unifiedCodex = false): Promise<HostCatalogRange> {
    if (!request.cursor && !this.#serviceClosed) await this.#catalogWithCache();
    return this.#hostStateFacts.catalogRange(request, hide, unifiedCodex);
  }

  #beginSharedOperation(kind: HostSharedOperation["kind"], agentKind: AgentKind | null = null, sessionId: string | null = null): string | undefined {
    if (this.#sharedOperations.size >= 256) {
      const retired = [...this.#sharedOperations.values()].find(operation => operation.state !== "accepted" && operation.state !== "running");
      if (retired) this.#sharedOperations.delete(retired.operationId);
      this.#sharedOperationsTruncatedAt = Date.now();
      if (!retired) { this.refreshHostFacts(); return undefined; }
    }
    const operationId = randomUUID(); const now = Date.now();
    this.#sharedOperations.set(operationId, { operationId, kind, state: "accepted", agentKind, sessionId, startedAt: now, updatedAt: now });
    this.refreshHostFacts();
    return operationId;
  }

  #settleSharedOperation(operationId: string | undefined, state: HostSharedOperation["state"]): void {
    if (operationId === undefined) return;
    const operation = this.#sharedOperations.get(operationId);
    if (operation === undefined) return;
    this.#sharedOperations.set(operationId, { ...operation, state, updatedAt: Date.now() });
    this.refreshHostFacts();
  }

  #publishDiagnostics(): void {
    if (this.#serviceClosed) return;
    const stats = this.#diagnostics.stats();
    this.#hostStateFacts.diagnostics({
      records: stats.records,
      dropped: stats.dropped,
      persistFailures: stats.persistFailures,
      oldestAt: stats.oldestAt,
      newestAt: stats.newestAt,
    });
    for (const runtime of new Set([...(this.#agentStateSubscriptions?.interestedRuntimes("records") ?? []), ...(this.#compactStateSubscriptions?.interestedRuntimes("records") ?? [])]))
      this.#agentFacts.refreshRecords(runtime);
  }
  /** 单写者本身：设备读模型时按作用域直接读它，而不是让每个领域各自暴露读取接口。 */
  readonly #agentStateRegistry: AgentStateRegistry;
  readonly #agentStateSubscriptions: AgentStateSubscriptions;
  readonly #compactState: CompactStateModel;
  readonly #compactStateSubscriptions: AgentStateSubscriptions;
  readonly #conversationState: AgentConversationState;
  readonly #notifications = new NotificationStore(runtimeId => {
    // 通知投影变化时同步模型里的引用摘要（ADR-0032 模块 18/19）；它只是引用，不复制权威。
    this.#agentFacts?.refreshNotifications(runtimeId);
    for (const deviceId of this.#links.keys()) this.#sendNotificationSnapshot(deviceId, runtimeId);
  });
  readonly #commandOwners = new RuntimeCommandLifecycle({
    onUnconfirmed: (record, event) => this.#publishRuntimeEvent(record.runtimeId, event),
  });
  readonly #interactionIds = new Map<string, Set<string>>();
  readonly #bootstrapReplayTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #notificationChecks = new Map<string, number>();
  #persistChain: Promise<void> = Promise.resolve();
  /**
   * 会话目录的短 TTL 缓存与「正在扫」占位（见 `#catalogWithCache`）。
   * 目录变化很慢、拉取很贵，而手机端会反复请求——不收敛就会互相堆叠。
   */
  #catalogCache: { at: number; sessions: AgentSessionSummary[] } | undefined;
  #catalogRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  #catalogRefreshFirstAt = 0;
  #catalogInFlight: { epoch: number; promise: Promise<AgentSessionSummary[]> } | undefined;
  #catalogEpoch = 0;
  /** LAUNCH-QUEUE-01: launches serialize per launch identity, activations and archives per session. */
  readonly #sessionLanes = new KeyedLanes();
  readonly #providerGate = new ProviderLaunchGate();
  #providerMutation: Promise<void> = Promise.resolve();
  readonly #gitReads = new Map<string, ReturnType<typeof readGitBranch>>();
  #providerChanging: AgentKind | undefined;
  #providerFactsGeneration = 0;
  #providerFactsClosing = false;
  #serviceClosed = false;
  #opencodeConnection: OpenCodeServiceConnection | undefined;
  #openCodeBackend: OpenCodeBackend | undefined;
  readonly #openCodePublishedRuntimes = new Set<string>();
  #unsubscribeOpenCodeStatus: (() => void) | undefined;
  readonly #providerFactsPending = new Set<Promise<void>>();
  #modelLifecycle: HostManagementState["lifecycle"] = "stopped";
  #activationsPending = 0;
  readonly #workspaceGit = new Map<string, HostWorkspacesState["workspaces"][number]["git"]>();
  readonly #fieldTraffic = new FieldTrafficMeter();
  readonly #sessionWireContent = new SessionWireContent();
  readonly #richSessionWireContent = new SessionWireContent();
  readonly #sharedOperations = new Map<string, HostSharedOperation>();
  #sharedOperationsTruncatedAt = 0;
  readonly #desktopOwnedIds = new Set<string>();
  readonly #codexHistory: CodexHistoryCatalog;
  readonly #sessionConfigurations: SessionConfigurationStore;
  readonly #kimiConfigurations: Record<KimiKind, SessionConfigurationStore>;
  /** Pre-split shared Kimi ledger; read-only recovery fallback for old mobile launch journals. */
  readonly #legacyKimiConfigurations: SessionConfigurationStore;
  // Published Hosts strictly decode their launch journal. New Agent records cannot poison it on rollback.
  readonly #openClawLaunches: SessionConfigurationStore;
  readonly #openCodeConfigurations: SessionConfigurationStore;
  readonly #hermesConfigurations: SessionConfigurationStore;
  #desktopLedgerWrite: Promise<void> = Promise.resolve();

  private constructor(
    options: HostServiceOptions,
    stateDir: string,
    identity: HostIdentity,
    store: DeviceStore,
  ) {
    this.#options = { ...options, relayHistoryMode: relayHistoryMode(options.relayHistoryMode) };
    this.#stateDir = stateDir;
    this.#sessionConfigurations = new SessionConfigurationStore(join(stateDir, "session-configuration.json"));
    // Released Hosts parse every launch entry strictly; never mix new kinds into their file.
    // Keep the original ledger as the Web store so saved preferences and receipts survive upgrades.
    const legacyKimiWebLedger = new SessionConfigurationStore(join(stateDir, "kimi-session-configuration.json"));
    this.#kimiConfigurations = {
      [KIMI_KIND]: legacyKimiWebLedger,
      [KIMI_DESKTOP_KIND]: new SessionConfigurationStore(join(stateDir, "kimi-desktop-session-configuration.json")),
    };
    this.#legacyKimiConfigurations = legacyKimiWebLedger;
    this.#openClawLaunches = new SessionConfigurationStore(join(stateDir, "openclaw-session-configuration.json"));
    this.#openCodeConfigurations = new SessionConfigurationStore(join(stateDir, "opencode-session-configuration.json"));
    this.#hermesConfigurations = new SessionConfigurationStore(join(stateDir, "hermes-session-configuration.json"));
    // 记录要跨重启保留：重启后「上一轮为什么连不上」仍然读得到，否则排查只能靠现场的这一次。
    this.#diagnostics = new DiagnosticJournal({ persistence: createDiagnosticJournalFileStore(stateDir) });
    this.#identity = identity;
    this.#codexHistory = new CodexHistoryCatalog(identity.hostId);
    this.#store = store;
    this.#toolContentService = new ToolContentService({
      observe: (runtimeId, event, bytes, gaps) => {
        this.#countToolTraffic(runtimeId, event === "request" ? "readRequests" : event === "failure" ? "readFailures" : "detailJsonBytes", event === "page" ? bytes : 1);
        if (gaps) this.#countToolTraffic(runtimeId, "gapResponses", 1);
      },
      scope: runtimeId => { const scope = this.#agentFacts.scopeOf(runtimeId); return scope?.kind === "agent" ? scope.key : undefined; },
      reader: runtimeId => this.#backends.find(backend => backend.isReady() && backend.ownsRuntime(runtimeId))?.toolContents,
      send: (deviceId, runtimeId, event) => {
        const message = this.#runtimeEventMessage(runtimeId, event);
        assertToolWireBudget(message);
        const payload = this.#encodeMeasured(message), link = this.#links.get(deviceId);
        if (!link || !allowsRuntime(this.#agentView(deviceId), runtimeId)) return false;
        return event.type === "session.tool.content.page"
          ? link.sendToolContent(payload, outboundQueueSource(message, payload.byteLength))
          : link.send(payload, "ctl", outboundQueueSource(message, payload.byteLength));
      },
    });
    this.#pairing = new HostPairingService(identity);
    this.#spawner = options.spawner ?? new SessionSpawner({ stateDir, ...(options.log === undefined ? {} : { log: options.log }) });
    this.#downloads = new HostDownloadService({
      resolveMessageReference: (id, deviceId) => this.#messageFileReferences.resolve(id, deviceId),
      resolvePreviewReference: (id, deviceId) => this.#messageFileReferences.resolveIdentity(id, deviceId),
      indexPath: hostArtifactIndexPath(stateDir),
      publishEvent: (deviceId, runtimeId, event) => {
        this.#sendToDevice(deviceId, {
          type: "runtime.event",
          protocolVersion: PROTOCOL_VERSION,
          runtimeId,
          sequence: this.#nextEventSequence(runtimeId, channelForDeviceMessage({ type: "runtime.event", event })),
          event,
        });
      },
      publishBinary: (deviceId, frame) => {
        this.#links.get(deviceId)?.sendBinary(frame);
      },
      publishMessage: (deviceId, message) => {
        this.#sendToDevice(deviceId, message);
      },
      ...(options.log === undefined ? {} : { log: options.log }),
    });
    void this.#downloads.load().then(() => this.refreshHostFacts());
    this.#sessionSync = new SessionSyncTasks({
      link: (deviceId) => this.#links.get(deviceId),
      dispatch: (runtimeId, commandId, command) => {
        const scope = this.#agentFacts.scopeOf(runtimeId);
        const forwarded = { ...command };
        // Window limits belong to the Host/device transaction; deployed adapters retain their strict command schema.
        delete forwarded.historyWindow;
        if (!scope || !this.#conversationState.hasBaseline(scope)) delete forwarded.knownState;
        const recovered = scope ? this.#conversationState.recover(scope, forwarded) : undefined;
        if (recovered) {
          queueMicrotask(() => this.#publishRuntimeEvent(runtimeId, recovered));
          return "handled";
        }
        for (const backend of this.#backends) {
          if (backend.isReady() && backend.ownsRuntime(runtimeId)) return backend.dispatchCommand(runtimeId, commandId, forwarded);
        }
        return "offline";
      },
      needsBaseline: runtimeId => {
        const scope = this.#agentFacts.scopeOf(runtimeId);
        return !scope || !this.#conversationState.hasBaseline(scope);
      },
      encodeEvent: (runtimeId, event, deviceId) => {
        if (!this.#allowsDeviceRuntime(deviceId, runtimeId)) throw new Error("agent_feature_required");
        return this.#encodeForDevice(deviceId, this.#runtimeEventMessage(runtimeId, event));
      },
      acceptSnapshot: (runtimeId, event, verifiedPreview) => {
        let rejectionReason: string | undefined;
        const accepted = this.#acceptConversation(runtimeId, event, reason => { rejectionReason = reason; }, verifiedPreview);
        if (accepted) return true;
        if (rejectionReason === "range_epoch_mismatch" && event.range !== "preview" &&
            this.#invalidateConversationBaseline(runtimeId, event, rejectionReason)) return "baseline-required";
        return false;
      },
      sendEvent: (deviceId, runtimeId, event) => this.#sendToDevice(deviceId, this.#runtimeEventMessage(runtimeId, event)),
      error: (deviceId, commandId, code, message) => {
        const link = this.#links.get(deviceId);
        const stats = this.#sessionSync.stats(deviceId);
        const rejection = code === "session_sync_busy_or_unavailable" ? link?.sessionSyncRejection : undefined;
        this.recordDiagnostic({ scope: "host", agentKind: null, sessionId: null, category: "session.sync", severity: "warning",
          operationId: commandId, message: code, detail: {
            deviceId, path: link?.active ?? "none", records: String(stats.records), pending: String(stats.pending),
            active: String(stats.active), reservedBytes: String(stats.reservedBytes), syncQueueBytes: String(link?.sessionSyncQueuedBytes ?? 0),
            ...(rejection === undefined ? {} : { reason: rejection.reason, deliveries: String(rejection.deliveries),
              nonBulkQueueBytes: String(rejection.nonBulkQueuedBytes), bulkQueueBytes: String(rejection.bulkQueuedBytes), wireBytes: String(rejection.wireBytes) }),
          } });
        this.#sendToDevice(deviceId, { type: "protocol.error", code, message: message ?? code, commandId });
      },
      ...(options.log === undefined ? {} : { log: options.log }),
    });
    // 后端装配：Pi 恒有；Codex 由调用方注入（CLI 在 --codex 时创建 app-server）。
    // Codex 的事件出口 / 元数据重播 / 离线广播都在这里挂上——对 Host 其余部分而言
    // 它只是 #backends 里多了一个 AgentBackend。
    this.#claudeBridge = new ClaudeHookBridge({
      hasRemoteDevice: () => [...this.#links.values()].some(link => link.active !== undefined),
      baseStatus: runtimeId => this.#claudeModsBridge.statusOf(runtimeId),
      hasSession: runtimeId => this.#claudeModsBridge.isOnline(runtimeId),
      acceptEditsApprovalGeneration: runtimeId => this.#claudeModsBridge.acceptEditsApprovalGeneration(runtimeId),
      onRuntimeOnline: runtime => this.#registerClaudeRuntime(runtime),
      onRuntimeOffline: (runtimeId, reason) => this.#unregisterClaudeRuntime(runtimeId, reason),
      onEvent: (runtimeId, event) => this.#publishRuntimeEvent(runtimeId, event),
    });
    this.#claudeModsBridge = new ClaudeModsBridge({
      hostId: () => this.#identity.hostId,
      beforeFileChangeTurn: (runtimeId, turnId, signal) => this.#fileChangeTurns.begin(runtimeId, turnId, true, true, true, signal),
      onFileChangeBoundaryLost: (runtimeId, turnId) => this.#fileChanges.markUnreliable(runtimeId, "capture-barrier-disconnected", turnId),
      afterFileChangeTurn: (runtimeId, turnId, outcome) => this.#fileChangeTurns.finish(runtimeId, { turnId, outcome, force: true }),
      onFileChangeAnchor: (runtimeId, turnId, entryId) => this.#fileChanges.observeAnchor(runtimeId, turnId, entryId),
      onRuntimeOnline: runtime => this.#registerClaudeRuntime(runtime),
      // A Hook can keep the runtime online for an interaction while the Mods poller reconnects.
      // Only remove the public runtime after both sources have gone offline. A raced question
      // needs this plugin connection to return its phone answer, so it ends here.
      onRuntimeOffline: (runtimeId, reason) => {
        this.#claudeBridge.cancelRaced(runtimeId);
        this.#unregisterClaudeRuntime(runtimeId, reason);
      },
      onEvent: (runtimeId, event) => this.#publishRuntimeEvent(runtimeId, event),
      onRejected: (reason, hello) => this.#recordClaudeRejection(reason, hello),
      // Native outcomes close the phone's copy of a Hook the TUI already answered.
      onToolFinished: (runtimeId, toolName, input, agentId, toolCallId) => this.#claudeBridge.resolveLocally(runtimeId, toolName, input, agentId, toolCallId),
      onTaskTurnFinished: (runtimeId, agentId) => this.#claudeBridge.resolveLocally(runtimeId, undefined, undefined, agentId),
      onTurnFinished: runtimeId => this.#claudeBridge.resolveLocally(runtimeId),
      onLocalInteractions: runtimeId => this.#claudeBridge.deferToLocal(runtimeId),
      pendingInteractions: runtimeId => this.#claudeBridge.blockingRequestCount(runtimeId),
      onQuestionRequested: (_runtimeId, question) => this.#claudeBridge.raceQuestion(question),
      questionAnswers: runtimeId => this.#claudeBridge.questionAnswers(runtimeId),
    });
    const claudeOptions = options.claude;
    const claudeConfig = claudeConfigDir(claudeOptions?.configDir ?? process.env.CLAUDE_CONFIG_DIR);
    this.#claudeBackend = new ClaudeBackend({ bridge: this.#claudeBridge, modsBridge: this.#claudeModsBridge,
      runtimeIds: () => [...new Set([...this.#claudeBridge.runtimeIds(), ...this.#claudeModsBridge.runtimeIds()])],
      ...(claudeOptions === undefined ? {} : {
        configDirs: () => [claudeConfig],
        catalog: new ClaudeSessionCatalog(),
        archive: new ClaudeArchiveStore(join(stateDir, "claude-archive.json")),
        launcher: claudeOptions.launcher ?? new TerminalClaudeLauncher({ stateDir, configDir: claudeConfig }),
      }),
      onCommandResult: (runtimeId, event) => this.#publishRuntimeEvent(runtimeId, event),
      onEvent: (runtimeId, event) => this.#publishRuntimeEvent(runtimeId, event),
      ...(options.log === undefined ? {} : { log: options.log }) });
    this.#piToolContents = new PiToolContentReader({
      send: (runtimeId, commandId, command) => this.#loopback?.sendCommand(runtimeId, commandId, command) ?? false,
      scope: runtimeId => { const scope = this.#agentFacts.scopeOf(runtimeId); return scope?.kind === "agent" ? scope.key : undefined; },
    });
    const backends: AgentBackend[] = [
      new PiBackend({
        toolContents: this.#piToolContents,
        spawner: this.#spawner,
        sendCommand: (runtimeId, commandId, command) =>
          this.#loopback?.sendCommand(runtimeId, commandId, command) ?? false,
        runtimeIds: () => this.localRuntimes.map((runtime) => runtime.runtimeId),
        runtimeMetadata: () => this.localRuntimes,
        sessionIsOnline: (sessionId) => this.localRuntimes.some((runtime) => runtime.sessionId === sessionId),
        ...(options.sessionsRoot === undefined ? {} : { sessionsRoot: options.sessionsRoot }),
        ...(options.log === undefined ? {} : { log: options.log }),
      }),
      this.#claudeBackend,
    ];
    this.#backends = backends;
    this.#hermes = options.hermes && !options.agentEnablement ? this.#makeHermesConnection(options.hermes) : undefined;
    // 共享同一个单写者：Agent 事实与设备视图回执都写进这一份模型。
    const agentStateRegistry = new AgentStateRegistry({ maxValueBytes: 4 * 1024 * 1024 });
    const agentStateOptions = {
      registry: agentStateRegistry,
      hostId: this.#identity.hostId,
      ...(options.log === undefined ? {} : { log: options.log }),
    };
    this.#agentFacts = new AgentStateFacts({
      ...agentStateOptions,
      kindOf: (runtimeId) => this.#backends.find((backend) => backend.ownsRuntime(runtimeId))?.kind,
      notifications: (runtimeId) => this.#notifications.summary(runtimeId),
      records: () => {
        const domain = this.#agentStateRegistry?.read({ kind: "host" }, "diagnostics");
        return domain ? { modelEpoch: domain.modelEpoch, revision: domain.revision } : undefined;
      },
    });
    this.#deviceViewFacts = new DeviceViewFacts(agentStateOptions);
    // Created after the device view so a transfer change can publish its device projection directly.
    this.#uploads = new HostUploadService({
      indexPath: hostUploadIndexPath(stateDir),
      publishMessage: (deviceId, message) => {
        this.#sendToDevice(deviceId, message);
      },
      onTransferChange: (deviceId) => this.#syncDeviceTransfers(deviceId),
      ...(options.log === undefined ? {} : { log: options.log }),
    });
    void this.#uploads.load();
    this.#hostStateFacts = new HostStateFacts({ registry: agentStateRegistry });
    // 启动时就把目录投影对齐：重启后读模型应当看得到上一次运行留下的记录数，而不是等下一次写入。
    this.#publishDiagnostics();
    this.#agentStateRegistry = agentStateRegistry;
    this.#liveActivities = new LiveActivityPublisher({ registry: agentStateRegistry,
      hostId: this.#identity.hostId, relayUrl: options.relayUrl, credential: options.credential,
      ...(options.log === undefined ? {} : { log: options.log }) });
    this.#conversationState = new AgentConversationState(agentStateRegistry);
    this.#toolInventory = new AgentToolInventory(agentStateRegistry);
    const changeScope = (runtimeId: string) => { const scope = this.#agentFacts.scopeOf(runtimeId); return scope?.kind === "agent" ? scope.key : undefined; };
    this.#fileChanges = new TurnFileChangeService({
      directory: join(stateDir, "turn-file-changes"), scope: changeScope,
      send: (deviceId, runtimeId, event) => {
        const link = this.#links.get(deviceId); if (!link || !allowsRuntime(this.#agentView(deviceId), runtimeId)) return false;
        const message = this.#runtimeEventMessage(runtimeId, event), payload = this.#encodeMeasured(message);
        return event.type === "session.change.detail.page"
          ? link.sendToolContent(payload, outboundQueueSource(message, payload.byteLength))
          : link.send(payload, channelForDeviceMessage(message), outboundQueueSource(message, payload.byteLength));
      },
      publish: (runtimeId, summary) => {
        this.#agentStateRegistry.commitValue({ kind: "agent", key: summary.agent }, "changes", {
          source: { producer: "host", sourceId: "turn-file-changes", sourceEpoch: this.#changesEpoch, sourceRevision: ++this.#changesRevision },
          availability: "ready", completeness: "complete",
          value: { latestChangeSetId: summary.changeSetId, reviewTurnId: summary.reviewTurnId,
            manifestVersion: summary.manifestVersion, state: summary.state },
        });
        for (const [deviceId, selected] of this.#changeSubscribers) {
          if (selected.runtimeId === runtimeId && selected.agentId === agentKeyId(summary.agent))
            this.#sendToDevice(deviceId, this.#runtimeEventMessage(runtimeId, { type: "session.changes.updated", summary }));
        }
      },
    });
    this.#fileChangeTurns = new TurnChangeCoordinator(this.#fileChanges, changeScope,
      runtimeId => this.#runtimesSnapshot().find(runtime => runtime.runtimeId === runtimeId));
    this.#toolIngestion = new ToolInventoryIngestion(this.#toolInventory);
    const project = (deviceId: string, scope: StateScope, domain: string, value: unknown) => this.#projectHostDomain(deviceId, scope, domain, value);
    this.#agentStateSubscriptions = new AgentStateSubscriptions(agentStateRegistry, (deviceId, message) => this.#sendToDevice(deviceId, message), project);
    this.#compactState = new CompactStateModel(agentStateRegistry, value => new Map(policyAgentViews(this.#disabledSources).filter(view => view !== 0).map(view =>
      [view, this.#projectCatalog(view, value)])));
    this.#compactStateSubscriptions = new AgentStateSubscriptions(this.#compactState.registry, (deviceId, message) => this.#sendToDevice(deviceId, message), project);
    for (const codex of [options.codexRuntime, options.codexDesktopRuntime]) {
      if (codex !== undefined) this.#attachCodexBackend(codex);
    }
    if (options.dshRuntime !== undefined) this.#attachDshBackend(options.dshRuntime);
    if (options.dshDesktopRuntime !== undefined) this.#attachDshBackend(options.dshDesktopRuntime);
    if (!options.agentEnablement && options.kimiCodeRuntime !== undefined) {
      this.#kimi[options.kimiCodeRuntime.kind] = options.kimiCodeRuntime;
      this.#attachKimiBackend(options.kimiCodeRuntime);
    }
    if (!options.agentEnablement) this.#startOpenCode(false);
    this.refreshHostFacts();
  }

  async #startManagedKimi(kind: KimiKind, lease: AgentLifecycleLease): Promise<void> {
    if (kind === KIMI_DESKTOP_KIND && !this.#options.kimiCodeDesktopSupported && this.#options.kimiCodeRuntime?.kind !== KIMI_DESKTOP_KIND) return;
    const factory = this.#options.createKimiCodeRuntime;
    if (!factory) return;
    const runtime = await factory(kind);
    if (runtime.kind !== kind) { await runtime.stop(); throw new Error("Kimi Code runtime source does not match its Agent kind"); }
    if (!lease.isCurrent()) { await runtime.stop(); return; }
    this.#kimi[kind] = runtime;
    this.#attachKimiBackend(runtime, lease.isCurrent);
    runtime.start();
  }

  async #stopManagedKimi(kind: KimiKind): Promise<void> {
    const runtime = this.#kimi[kind];
    if (!runtime) return;
    delete this.#kimi[kind];
    this.#backends = this.#backends.filter(item => item !== runtime);
    for (const entry of runtime.directoryEntries()) {
      this.#notifications.end(entry.runtimeId);
      this.#markRuntimeOffline(entry.runtimeId, "agent_disabled");
    }
    await runtime.stop();
    this.#invalidateCatalog();
    this.#broadcastDeviceReady();
  }

  #attachKimiBackend(runtime: KimiRuntime, current = (): boolean => true): void {
    this.#backends.push(runtime);
    if (this.#toolContentStore) runtime.setToolContentStore(this.#toolContentStore, this.#identity.hostId);
    runtime.setEventSink((event, id) => { if (current()) this.#publishRuntimeEvent(id, event); });
    runtime.onCatalogChange = () => { if (current()) this.#invalidateCatalog(); };
    runtime.onReadyChange = () => {
      this.#desktopPresence.delete(runtime);
      if (current()) this.#broadcastDeviceReady();
    };
    runtime.onMetadataChange = metadata => {
      if (!current()) return;
      const { runtimeId, sessionId } = metadata;
      if (!this.#notifications.has(runtimeId) || this.#notifications.needsAttach(runtimeId)) this.#notifications.attach(runtimeId, sessionId);
      this.#publishRuntimeEvent(runtimeId, { type: "runtime.metadata", metadata });
      this.#broadcastDeviceMessage({ type: "runtime.online", runtime: metadata });
    };
    runtime.onArchiveChange = (sessionId, archived) => {
      if (!current()) return;
      this.#invalidateCatalog();
      this.#broadcastDeviceMessage({ type: "session.archive.changed", agentKind: runtime.kind, sessionId, archived });
    };
    runtime.onOffline = (metadata, reason) => {
      if (!current()) return;
      this.#notifications.end(metadata.runtimeId);
      this.#markRuntimeOffline(metadata.runtimeId, reason);
      this.#broadcastDeviceMessage({ type: "runtime.offline", runtimeId: metadata.runtimeId, reason });
    };
  }

  #makeHermesConnection(options: HermesHostOptions, current = (): boolean => true): HermesHostConnection {
    const scopedOptions: HermesHostOptions = { ...options, onRuntimeOffline: (runtimeId, reason) => {
      if (!current() || this.#providerFactsClosing) return;
      options.onRuntimeOffline?.(runtimeId, reason);
      const backend = this.#hermes?.backend;
      this.#hermesAnnouncements.get(backend as HermesAgentBackend)?.delete(runtimeId);
      this.#markRuntimeOffline(runtimeId, reason);
      this.#notifications.end(runtimeId);
      this.#broadcastDeviceMessage({ type: "runtime.offline", runtimeId, reason });
    } };
    return new HermesHostConnection(scopedOptions, this.hostId, (backend, retired) => {
      if (current()) this.#updateHermesBackend(backend, retired);
    }, () => { if (current()) this.refreshHostFacts(); });
  }

  /** Wire a Codex runtime once. Desktop runtimes can be attached after relay startup. */
  #updateHermesBackend(backend?: HermesAgentBackend, retired?: HermesAgentBackend): void {
    if (this.#providerFactsClosing) return;
    if (retired) {
      this.#hermesAnnouncements.delete(retired);
      this.#backends = this.#backends.filter(item => item !== retired);
      for (const { runtimeId } of retired.directoryEntries()) {
        this.#markRuntimeOffline(runtimeId, "hermes_gateway_disconnected");
        this.#notifications.end(runtimeId);
        this.#broadcastDeviceMessage({ type: "runtime.offline", runtimeId, reason: "hermes_gateway_disconnected" });
      }
    }
    if (backend && !this.#backends.includes(backend)) {
      this.#backends.push(backend);
      const announced = new Set<string>();
      this.#hermesAnnouncements.set(backend, announced);
      backend.setEventSink((event, runtimeId) => {
        if (this.#providerFactsClosing || this.#hermes?.backend !== backend) return;
        if (event.type === "runtime.metadata" && !announced.has(runtimeId)) {
          announced.add(runtimeId);
          this.#agentFacts.observe(runtimeId, event);
          this.#broadcastDeviceMessage({ type: "runtime.online", runtime: event.metadata });
        }
        this.#publishRuntimeEvent(runtimeId, event);
      });
    }
    this.#invalidateCatalog();
    this.#broadcastDeviceReady();
  }

  async #ensureHermes(current = this.#sourceCurrent("hermes"), localOnly = false): Promise<HermesAgentBackend> {
    try {
      const connection = this.#hermes;
      const admitted = () => current() && !this.#disabledSources.has("hermes") && this.#hermes === connection;
      if (connection && admitted()) {
        const backend = await connection.ensure(admitted, localOnly);
        if (admitted()) return backend;
      }
    } catch { /* Native details may contain private paths; do not relay them. */ }
    throw new ActivationError("agent_unsupported", "Hermes Gateway 不可用，请核对本机 CLI，或远程 SSH 配置与 Gateway 状态");
  }

  #attachCodexBackend(codex: CodexRuntime): void {
    if (this.#backends.includes(codex)) return;
    if (this.#toolContentStore) codex.setToolContentStore(this.#toolContentStore, this.#identity.hostId);
    codex.beforeFileChangeTurn = runtimeId => this.#fileChangeTurns.begin(runtimeId).catch(() => undefined);
    codex.fileChangeTurnFailed = runtimeId => this.#fileChangeTurns.finish(runtimeId, { outcome: "failed", force: true }).catch(() => undefined);
    codex.onFileChangeEvidence = (runtimeId, evidence) => { void this.#fileChangeTurns.observeNative(runtimeId, evidence).catch(() => undefined); };
    codex.fileChangeTurnUnconfirmed = async runtimeId => { this.#fileChanges.markUnreliable(runtimeId, "turn-start-unconfirmed"); };
    codex.seedDesktopThreads(this.#desktopOwnedIds);
    codex.setEventSink((event, threadId) => {
      const runtimeId = threadId === undefined ? codex.runtimeId : codex.runtimeIdFor(threadId);
      if (this.#backends.includes(codex)) this.#publishRuntimeEvent(runtimeId, event, codex);
    });
    codex.onCatalogChange = () => this.#invalidateCatalog();
    codex.onMetadataChange = () => {
      for (const runtime of codex.directoryEntries()) {
        if (!this.#notifications.has(runtime.runtimeId) || this.#notifications.needsAttach(runtime.runtimeId)) this.#notifications.attach(runtime.runtimeId, runtime.sessionId);
        this.#broadcastDeviceMessage({ type: "runtime.online", runtime });
      }
    };
    codex.onOffline = (reason, runtimes) => {
      if (codex.kind === "codexDesktop") {
        this.#invalidateCatalog();
        this.#broadcastDeviceReady();
      }
      for (const runtime of runtimes) {
        this.#notifications.end(runtime.runtimeId);
        this.#markRuntimeOffline(runtime.runtimeId, reason);
        this.#broadcastDeviceMessage({ type: "runtime.offline", runtimeId: runtime.runtimeId, reason });
      }
    };
    codex.onArchiveChange = (sessionId, archived) => {
      this.#invalidateCatalog();
      this.#publishCodexArchive(codex, codex.nativeHistoryId(sessionId), archived);
    };
    if (codex.kind === "codexDesktop") codex.onDesktopThread = id => this.#recordDesktopThread(id);
    this.#backends.push(codex);
  }

  #attachDshBackend(dsh: DshRuntime): void {
    if (this.#backends.includes(dsh)) return;
    const kind = dsh.kind;
    if (this.#toolContentStore) dsh.setToolContentStore(this.#toolContentStore, this.#identity.hostId);
    dsh.onDiagnostic = event => this.recordDiagnostic({ scope: "host", agentKind: kind, sessionId: null,
      category: "backend.transport", severity: event.event === "reconnected" ? "info" : event.event === "failed" ? "error" : "warning",
      message: `${kind === "dsh" ? "DSH Web" : "DSH Desktop"} ${event.event}`, detail: { ...(event.code === undefined ? {} : { code: event.code }),
        ...(event.reason === undefined ? {} : { reason: event.reason }),
        ...(event.maxFrameBytes === undefined ? {} : { maxFrameBytes: String(event.maxFrameBytes) }) } });
    dsh.onFileChangeEvent = (runtimeId, event) => {
      if (event.type === "turn.started") void this.#fileChangeTurns.started(runtimeId, event.turnId).catch(() => undefined);
      else if (event.type === "turn.finished") void this.#fileChangeTurns.finish(runtimeId, {
        turnId: event.turnId, reliable: false,
        ...(event.persistedMessageId ? { anchorEntryId: event.persistedMessageId } : {}),
      }).catch(() => undefined);
    };
    dsh.setEventSink((event, runtimeId) => this.#publishRuntimeEvent(runtimeId, event));
    dsh.onCatalogChange = () => this.#invalidateCatalog();
    dsh.onArchiveChange = (sessionId, archived) => {
      this.#invalidateCatalog();
      this.#broadcastDeviceMessage({ type: "session.archive.changed", agentKind: kind, sessionId, archived });
    };
    dsh.onMetadataChange = () => {
      for (const runtime of dsh.directoryEntries()) {
        if (!this.#notifications.has(runtime.runtimeId) || this.#notifications.needsAttach(runtime.runtimeId)) this.#notifications.attach(runtime.runtimeId, runtime.sessionId);
        this.#broadcastDeviceMessage({ type: "runtime.online", runtime });
      }
    };
    dsh.onOffline = (reason, runtimes) => {
      this.#invalidateCatalog();
      for (const runtime of runtimes) {
        this.#notifications.end(runtime.runtimeId);
        this.#markRuntimeOffline(runtime.runtimeId, reason);
        this.#broadcastDeviceMessage({ type: "runtime.offline", runtimeId: runtime.runtimeId, reason });
      }
      // A single Session leaving (archived, removed, quit) reports here too while the connection stays ready.
      if (kind === "dshDesktop" && !dsh.isReady()) this.#options.onDshDesktopOffline?.(reason);
      this.#broadcastDeviceReady();
    };
    this.#backends.push(dsh);
    this.#dsh[kind].runtime = dsh;
  }

  #startOpenCode(start: boolean, current = (): boolean => true): void {
    if (this.#options.opencodeConnection === false || !current()) return;
    const connection = this.#options.createOpenCodeConnection?.() ?? this.#options.opencodeConnection ?? new OpenCodeServiceConnection();
    this.#opencodeConnection = connection;
    const admitted = () => current() && this.#opencodeConnection === connection && !this.#providerFactsClosing;
    let launchable = connection.launchable;
    this.#unsubscribeOpenCodeStatus = connection.subscribe(() => {
      if (!admitted()) return;
      if (launchable !== connection.launchable) {
        launchable = connection.launchable;
        this.#broadcastDeviceReady(OPENCODE_KIND);
      } else this.refreshHostFacts();
      this.#invalidateCatalog();
    });
    const backend = this.#openCodeBackend = new OpenCodeBackend({
      connection,
      hostId: this.#identity.hostId,
      onRuntimeOnline: runtime => { if (admitted()) this.#registerOpenCodeRuntime(runtime); },
      onRuntimeOffline: (runtimeId, reason) => this.#unregisterOpenCodeRuntime(runtimeId, reason),
      onEvent: (runtimeId, event) => { if (admitted()) this.#publishRuntimeEvent(runtimeId, event); },
      onCatalogChange: () => { if (admitted()) this.#invalidateCatalog(); },
      onAvailabilityChange: () => { if (admitted()) this.#broadcastDeviceReady(OPENCODE_KIND); },
    });
    this.#backends.push(backend);
    if (start) { backend.start(); void connection.start(); }
  }

  async #stopOpenCode(): Promise<void> {
    const backend = this.#openCodeBackend, connection = this.#opencodeConnection;
    this.#openCodeBackend = this.#opencodeConnection = undefined;
    this.#unsubscribeOpenCodeStatus?.(); this.#unsubscribeOpenCodeStatus = undefined;
    if (backend) this.#backends = this.#backends.filter(item => item !== backend);
    backend?.close();
    connection?.close();
    this.#invalidateCatalog();
    await connection?.drainStartup();
  }

  #registerOpenCodeRuntime(runtime: RuntimeMetadata): void {
    const alreadyPublished = this.#openCodePublishedRuntimes.has(runtime.runtimeId);
    const displaced = this.#agentFacts.displacedRuntime(runtime.runtimeId, runtime);
    if (displaced) this.#markRuntimeOffline(displaced.runtimeId, "replaced_by_new_runtime");
    this.#openCodePublishedRuntimes.add(runtime.runtimeId);
    this.#agentFacts.observe(runtime.runtimeId, { type: "runtime.metadata", metadata: runtime });
    if (!alreadyPublished) this.#notifications.attach(runtime.runtimeId, runtime.sessionId);
    if (alreadyPublished) this.#publishRuntimeEvent(runtime.runtimeId, { type: "runtime.metadata", metadata: runtime });
    else this.#broadcastDeviceMessage({ type: "runtime.online", runtime });
    this.refreshHostFacts();
  }

  #unregisterOpenCodeRuntime(runtimeId: string, reason: string): void {
    if (!this.#openCodePublishedRuntimes.delete(runtimeId) && this.#agentFacts.scopeOf(runtimeId) === undefined) return;
    this.#notifications.end(runtimeId);
    this.#markRuntimeOffline(runtimeId, reason);
    this.#broadcastDeviceMessage({ type: "runtime.offline", runtimeId, reason });
    this.refreshHostFacts();
  }

  /** Attach a newly connected DeepSeek backend and publish the changed capability. */
  async attachDshRuntime(runtime: DshRuntime, current = (): boolean => !this.#disabledSources.has(runtime.kind)): Promise<void> {
    if (!current()) return;
    const existing = this.#backends.find(backend => backend.kind === runtime.kind);
    if (existing === runtime) return;
    if (existing !== undefined) {
      const previous = existing as DshRuntime;
      this.detachDshRuntime(previous);
      await previous.stop().catch(error => this.#options.log?.(`关闭旧的 DeepSeek 接入失败：${describeError(error)}`));
    }
    if (!current()) return;
    this.#attachDshBackend(runtime);
    try { await runtime.start(); }
    catch (error) { this.#options.log?.(`DeepSeek 会话发现暂时失败，将自动重试：${describeError(error)}`); }
    this.#invalidateCatalog();
    this.#broadcastDeviceReady();
  }

  /** Detach only Orbis's DSH client; the user's Web service or Desktop app stays alive. */
  detachDshRuntime(runtime: DshRuntime): void {
    const index = this.#backends.indexOf(runtime);
    if (index < 0 || (runtime.kind !== "dsh" && runtime.kind !== "dshDesktop")) return;
    runtime.setEventSink(() => {});
    runtime.onDiagnostic = undefined;
    runtime.onFileChangeEvent = undefined;
    runtime.onCatalogChange = undefined;
    runtime.onArchiveChange = undefined;
    runtime.onMetadataChange = undefined;
    runtime.onOffline = undefined;
    this.#backends.splice(index, 1);
    if (this.#dsh[runtime.kind].runtime === runtime) this.#dsh[runtime.kind].runtime = undefined;
    this.#invalidateCatalog();
    this.#broadcastDeviceReady();
  }

  /** Attach the terminal Codex backend once its app-server is ready, so Relay connectivity never waits for it. */
  attachCodexRuntime(runtime: CodexRuntime): void {
    if (runtime.kind !== "codex" || this.#disabledSources.has("codex")) return;
    const existing = this.#backends.find(backend => backend.kind === "codex");
    if (existing !== undefined && existing !== runtime) this.detachCodexRuntime(existing as CodexRuntime);
    this.#options.codexRuntime = runtime;
    this.#attachCodexBackend(runtime);
    runtime.markStarted();
    this.#options.log?.(`Codex 后端已就绪（runtimeId=${runtime.runtimeId}）`);
    this.#invalidateCatalog();
    this.#broadcastDeviceReady();
  }

  /** Remove the terminal Codex backend (paused or being replaced). Terminal sessions go offline. */
  detachCodexRuntime(runtime: CodexRuntime): void {
    const index = this.#backends.indexOf(runtime);
    if (index < 0 || runtime.kind !== "codex") return;
    runtime.setEventSink(() => {});
    runtime.onMetadataChange = undefined;
    runtime.onCatalogChange = undefined;
    runtime.onOffline = undefined;
    runtime.onArchiveChange = undefined;
    this.#backends.splice(index, 1);
    if (this.#options.codexRuntime === runtime) delete this.#options.codexRuntime;
    this.#invalidateCatalog();
    this.#broadcastDeviceReady();
  }

  /** Attach a newly connected desktop proxy and immediately publish its capability. */
  attachCodexDesktopRuntime(runtime: CodexRuntime): void {
    if (this.#disabledSources.has("codexDesktop")) return;
    const existing = this.#backends.find(backend => backend.kind === "codexDesktop");
    if (existing !== undefined && existing !== runtime) this.detachCodexDesktopRuntime(existing as CodexRuntime);
    this.#attachCodexBackend(runtime);
    runtime.markStarted();
    this.#invalidateCatalog();
    this.#broadcastDeviceReady();
  }

  /** Remove a closed desktop proxy. Terminal Codex remains untouched. */
  detachCodexDesktopRuntime(runtime: CodexRuntime): void {
    const index = this.#backends.indexOf(runtime);
    if (index < 0 || runtime.kind !== "codexDesktop") return;
    runtime.setEventSink(() => {});
    runtime.onMetadataChange = undefined;
    runtime.onCatalogChange = undefined;
    runtime.onOffline = undefined;
    runtime.onArchiveChange = undefined;
    runtime.onDesktopThread = undefined;
    this.#backends.splice(index, 1);
    this.#invalidateCatalog();
    this.#broadcastDeviceReady();
  }

  static async create(options: HostServiceOptions): Promise<HostService> {
    const stateDir = resolveStateDir(options.stateDir);
    // 身份文件读不出来时 loadOrCreate 会直接抛错：换了身份等于所有设备失效，
    // 那必须让用户看到，而不是悄悄重建。
    const identity = await loadOrCreateHostIdentity({ dir: stateDir });
    const store = await loadDeviceStore(stateDir);
    const service = new HostService(options, stateDir, identity, store);
    try {
      const ids: unknown = JSON.parse(await readFile(join(stateDir, "codex-desktop-threads.json"), "utf8"));
      if (Array.isArray(ids)) {
        for (const id of ids) if (typeof id === "string" && id.length > 0 && id.length <= 128 && !id.includes(":")) service.#desktopOwnedIds.add(id);
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) options.log?.(`读取 Codex 桌面会话归属失败：${describeError(error)}`);
    }
    options.codexRuntime?.seedDesktopThreads(service.#desktopOwnedIds);
    options.codexDesktopRuntime?.seedDesktopThreads(service.#desktopOwnedIds);
    return service;
  }

  get hostId(): string {
    return this.#identity.hostId;
  }

  get devices(): readonly DeviceRecord[] {
    return this.#store.devices;
  }

  get pairing(): HostPairingService {
    return this.#pairing;
  }

  get kimiCodeConnectionState() { return this.#kimi[KIMI_KIND]?.connectionState ?? (this.#managedPolicy && !this.#disabledSources.has(KIMI_KIND) ? "unavailable" : "disabled"); }
  get kimiCodeDesktopConnectionState() { return this.#kimi[KIMI_DESKTOP_KIND]?.connectionState ?? (this.#managedPolicy && !this.#disabledSources.has(KIMI_DESKTOP_KIND) ? "unavailable" : "disabled"); }
  async startKimiCode(kind: KimiKind = KIMI_KIND): Promise<void> {
    await this.#ensureKimiReady(kind, this.#sourceCurrent(kind));
  }

  async startLocalAgent(kind: "opencode" | "openclaw" | "hermes"): Promise<void> {
    await this.#ensureSharedAgent(kind, this.#sourceCurrent(kind), true);
  }

  /** Resolve the newest active native OpenCode session in the exact project chosen for a TUI handoff. */
  async latestOpenCodeSession(cwd: string): Promise<AgentSessionSummary | undefined> {
    if (!isAbsolute(cwd)) throw new Error("OpenCode 工作区必须是绝对路径");
    const backend = this.#openCodeBackend;
    if (!backend?.isReady() || this.#disabledSources.has(OPENCODE_KIND)) throw new Error("OpenCode 共享服务尚未就绪");
    const directory = normalize(cwd);
    const key = (value: string) => process.platform === "win32" ? normalize(value).toLocaleLowerCase("en-US") : normalize(value);
    return (await backend.catalog(false)).find(session => key(session.cwd) === key(directory));
  }

  async #ensureSharedAgent(kind: "opencode" | "openclaw" | "hermes", current: () => boolean, localOnly = false): Promise<void> {
    if (!current() || this.#disabledSources.has(kind)) throw new AgentLaunchRevoked();
    try {
      if (kind === "hermes") { await this.#ensureHermes(current, localOnly); return; }
      if (kind === OPENCODE_KIND) {
        const connection = this.#opencodeConnection, backend = this.#openCodeBackend;
        if (!connection || !backend) throw new Error("请先在 Host 中启用 OpenCode 接入");
        await connection.ensure(() => current() && this.#opencodeConnection === connection, () => backend.isReady());
        return;
      }
      const backend = this.#openClaw, startup = this.#openClawStart?.startup, launcher = this.#options.openClawLauncher;
      if (!backend) throw new Error("请先在 Host 中配置 OpenClaw Gateway");
      if (localOnly && localOpenClawPort(backend.url) === undefined) throw new Error("远程 OpenClaw Gateway 只接入已有服务");
      if (backend.isReady()) return;
      if (!launcher || !startup) throw new Error("OpenClaw Gateway 未连接，请检查已配置的地址和认证");
      const admitted = () => current() && this.#openClaw === backend && !this.#disabledSources.has(kind);
      await startup.run(admitted, () => { if (this.#openClaw === backend) this.#broadcastDeviceReady(); }, async guard => {
        await launcher.start(backend.url, guard, { ready: () => backend.isReady(), pairingEpoch: () => backend.pairingEpoch,
          retry: () => backend.retryLocal(guard.check) });
        if (!backend.isReady()) throw new Error("OpenClaw Gateway 尚未完成接入");
      });
    } catch (error) { throw new ActivationError("agent_unsupported", describeError(error)); }
  }

  async #ensureKimiReady(kind: KimiKind, current: () => boolean, sessionId?: string): Promise<void> {
    if (!current()) throw new AgentLaunchRevoked();
    const runtime = this.#kimi[kind];
    if (!runtime || this.#disabledSources.has(kind)) throw new ActivationError("agent_unsupported", "请先在 Host 中启用对应的 Kimi Code 接入");
    if (runtime.isReady()) return;
    if (sessionId !== undefined) await runtime.assertResumeSource(sessionId);
    try { await runtime.ensureReady(() => current() && this.#kimi[kind] === runtime); }
    catch (error) { throw new ActivationError("agent_unsupported", describeError(error)); }
  }

  get relayState(): HostRelayState {
    return this.#relay?.state ?? "closed";
  }

  get opencodeServiceStatus(): OpenCodeServiceStatus { return this.#opencodeConnection?.status ?? { state: "closed" }; }

  /** 本机 loopback 端点。未启用或未启动时为 `undefined`。 */
  get loopback(): HostLoopbackServer | undefined {
    return this.#loopback;
  }

  /** LAN 端点。未启用或未起来时为 `undefined`（此时只剩 Relay 一条路径）。 */
  get lan(): HostLanServer | undefined {
    return this.#lan;
  }

  /** 写进二维码的 LAN 地址表。地址在配对时枚举，端口走配置——见 `lan-server.ts`。 */
  get lanEndpoints(): readonly PairingQrLanEndpoint[] {
    if (this.#options.lan === false) return [];
    // 监听已经起来时用**实际**端口：配了 0（让系统分配）的话，配置里的那个 0 写进二维码毫无意义。
    return localLanEndpoints(this.#lan?.port ?? this.#lanPort);
  }

  /** 当前已接入 Host 的本机 runtime（Pi 进程）。 */
  get localRuntimes(): readonly RuntimeMetadata[] {
    return this.#disabledSources.has("pi") ? [] : this.#loopback?.runtimes ?? [];
  }

  async assertProviderSwitchReady(kind: AgentKind): Promise<void> {
    try {
      // LAUNCH-QUEUE-01: a running launch still reads this group's provider; refuse instead of waiting behind it.
      if (this.#providerGate.busy(providerGroup(kind))) throw new ProviderError("有会话正在启动，请等启动完成后再切换供应商");
      if (kind === "codex") {
        this.#options.codexRuntime?.assertProviderSwitchReady();
        for (const backend of this.#backends) {
          if (backend.kind === "codexDesktop" && backend.isReady()) (backend as CodexRuntime).assertProviderSwitchReady();
        }
      }
      if (kind === "dsh") await this.#dsh.dsh.runtime?.assertProviderSwitchReady();
      if (kind === "claude" && [...new Set([...this.#claudeBridge.runtimeIds(), ...this.#claudeModsBridge.runtimeIds()])].some(id =>
        this.#claudeModsBridge.statusOf(id) === "running" || this.#claudeBridge.pendingRequests(id).length > 0)) {
        throw new ProviderError("Claude Code 正在工作或等待权限确认，请完成后再切换供应商");
      }
    } catch (error) { throw new ProviderError(error instanceof Error ? error.message : "Agent 正在工作"); }
  }

  async reloadProviderConfiguration(kind: AgentKind, env: NodeJS.ProcessEnv, live = false): Promise<void> {
    if (kind === "codex" && !this.#disabledSources.has("codex")) await this.#options.codexRuntime?.reloadProviderConfiguration(this.#sourceCurrent("codex"));
    if (kind === "dsh" && !this.#disabledSources.has("dsh")) await this.#dsh.dsh.runtime?.reloadProviderConfiguration(env, live);
    this.#invalidateCatalog();
  }

  changeProvider<T>(kind: AgentKind, operation: () => Promise<T>, mode: "switch" | "save" = "switch"): Promise<T> {
    const current = this.#providerCurrent(kind);
    const requireCurrent = () => { if (!current()) throw new ProviderError("此 Agent 未启用"); };
    const operationId = this.#beginSharedOperation("provider.change", kind);
    // Changes stay ordered among themselves; the gate only holds back new launches of this provider group.
    const result = this.#providerMutation.then(() => this.#providerGate.exclusive(providerGroup(kind), async () => {
      this.#providerChanging = kind;
      this.#settleSharedOperation(operationId, "running");
      void this.refreshProviderFacts();
      try {
        requireCurrent();
        const desktopReady = this.#backends.some(backend => backend.kind === "codexDesktop" && backend.isReady());
        // DSH saves defer readiness to ProviderManager: only an actual activation
        // needs idle; editing the active provider is validated by live reload.
        if (!(kind === "dsh" && mode === "save") && !(kind === "codex" && this.#options.providers?.proxyTakeoverActive && !desktopReady)) {
          await this.assertProviderSwitchReady(kind);
        }
        requireCurrent();
        const value = await operation();
        this.#settleSharedOperation(operationId, "succeeded");
        return value;
      } catch (error) {
        this.#settleSharedOperation(operationId, "failed");
        // 失败是运维事实：什么时候、想动哪个后端、为什么没成。记录只有原因摘要，
        // 不含配置内容或凭据——诊断记录永远不装秘密（ADR-0032 模块 23）。
        this.recordDiagnostic({
          scope: "host",
          agentKind: kind,
          sessionId: null,
          category: "provider",
          severity: "error",
          message: (mode === "switch" ? "切换 " : "保存 ") + kind + " 供应商失败",
          detail: { reason: describeError(error).slice(0, 256) },
        });
        throw error;
      }
      finally { this.#providerChanging = undefined; void this.refreshProviderFacts(); }
    }));
    this.#providerMutation = result.then(() => {}, () => {});
    return result;
  }

  announceProviderChange(kind: AgentKind, exceptDeviceId?: string): void {
    for (const id of this.#links.keys()) if (id !== exceptDeviceId) {
      this.#sendJsonToDevice(id, { type: "provider.changed", protocolVersion: PROTOCOL_VERSION, kind }, "ctl");
    }
  }

  /**
   * 读统一状态模型（ADR-0032）。同步返回已提交的当前投影——不查后端、不占本机资源。
   *
   * 作用域解析不出来时**明确回错**：空快照会被客户端读成「什么都没有」，而事实是
   * 「这台电脑不知道这个会话」。
   */
  async #handleAgentStateRequest(deviceId: string, request: Extract<DeviceE2ePayload, { type: "agent.state.request" }>): Promise<void> {
    const compact = request.stateFormat === "compact-v1" || request.stateFormat === "compact-v2";
    // Cancel the fallback replay timer synchronously before any async work so slow
    // cold connections never emit redundant legacy bootstrap events mid-handshake.
    if (compact) this.#cancelBootstrapReplay(deviceId);
    const authenticatedLink = this.#links.get(deviceId);
    const view = this.#agentView(deviceId), epoch = this.#deviceViewEpochs.get(deviceId);
    this.refreshHostFacts();
    // 点名要供应商摘要就先现读一次：模型里那份是「上次有人读时」的，不能当成刚核对过。
    if (request.domains?.includes("providers") === true) await this.refreshProviderFacts();
    const identity = {
      ...(request.runtimeId === undefined ? {} : { runtimeId: request.runtimeId }),
      ...(request.agentKind === undefined ? {} : { agentKind: request.agentKind }),
      ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
    };
    const scope = this.#resolveAgentStateScope(deviceId, request);
    if (scope?.kind === "host" && (request.domains === undefined || request.domains.includes("catalog"))) await this.readHostRange();
    if (this.#serviceClosed || authenticatedLink !== this.#links.get(deviceId) || !authenticatedLink?.active || epoch !== this.#deviceViewEpochs.get(deviceId) || view !== this.#agentView(deviceId)) return;
    if (scope?.kind === "agent" && !allowsAgentIdentity(view, scope.key)) { this.#rejectAgentFeature(deviceId, request); return; }
    if (scope === undefined) {
      this.#sendJsonToDevice(deviceId, {
        type: "agent.state.snapshot", protocolVersion: PROTOCOL_VERSION, requestId: request.requestId,
        scope: request.scope ?? "agent", ...identity, modelEpoch: null, domains: [], missing: [], truncated: false,
        error: "这台电脑没有该会话的状态：它可能不在线，或这个后端还没有接入统一模型。",
      }, "ctl");
      return;
    }
    if (scope.kind === "agent" && request.runtimeId !== undefined && this.#agentFacts.needsReconcile(request.runtimeId, request.domains)) {
      const runtimeId = request.runtimeId;
      // Recover unconfirmed requested facts only. Ordinary reads use the committed
      // model; backend watchers continue native reconciliation independently.
      this.#loopback?.sendResync(runtimeId, "model_reconcile");
      for (const backend of this.#backends) if (backend instanceof CodexRuntime && backend.ownsRuntime(runtimeId)) {
        // announce takes a native thread ID; desktop session IDs carry a public namespace.
        const threadId = backend.activeThreadIds().find(id => backend.runtimeIdFor(id) === runtimeId);
        if (threadId !== undefined) backend.announce(threadId);
      }
      for (const kind of DSH_KINDS) if (this.#dsh[kind].runtime?.ownsRuntime(runtimeId)) this.#dsh[kind].runtime!.announce();
      for (const runtime of Object.values(this.#kimi)) if (runtime?.ownsRuntime(runtimeId)) runtime.announce();
      if (this.#claudeBackend.ownsRuntime(runtimeId)) this.#claudeBackend.announce(runtimeId);
    }
    if (request.runtimeId && request.domains?.includes("records")) this.#agentFacts.refreshRecords(request.runtimeId);
    const registry = compact ? this.#compactState.ensure(scope) : this.#agentStateRegistry;
    const subscriptions = compact ? this.#compactStateSubscriptions : this.#agentStateSubscriptions;
    if (request.subscribe !== undefined) (compact ? this.#agentStateSubscriptions : this.#compactStateSubscriptions).register(deviceId, scope, { ...request, subscribe: false });
    if (!subscriptions.register(deviceId, scope, request)) {
      this.#sendToDevice(deviceId, { type: "protocol.error", code: "model_subscription_limit", message: "模型订阅已达上限" });
      return;
    }
    const known = epoch === undefined ? request.known : request.known?.filter(item => item.modelEpoch === epoch)
      .map(item => ({ ...item, modelEpoch: registry.currentModelEpoch() }));
    for (const part of buildAgentStateSnapshotParts({
      registry,
      requestId: request.requestId,
      scope,
      identity,
      stateFormat: request.stateFormat,
      ...(compact && !this.#unifiedCodex(deviceId) ? { catalogBaseline: (epoch: string, revision: number) => this.#compactState.catalogBaseline(epoch, revision, view) } : {}),
      projectValue: (domain, value) => this.#projectHostDomain(deviceId, scope, domain, value),
      ...(request.domains === undefined ? {} : { domains: request.domains }),
      ...(known === undefined ? {} : { known }),
    })) {
      this.#sendToDevice(deviceId, part);
    }
  }

  #agentView(deviceId: string): AgentView { return deviceAgentView(this.#deviceFeatures.get(deviceId), this.#disabledSources); }

  #allowsDeviceRuntime(deviceId: string, runtimeId: string): boolean {
    const view = this.#agentView(deviceId);
    const scope = this.#agentFacts.scopeOf(runtimeId);
    return (scope?.kind !== "agent" || allowsAgent(view, scope.key.agentKind)) && allowsRuntime(view, runtimeId);
  }

  /** Capture the source generation before starting an async operation. A later
   * re-enable must not resume an operation from the previous generation. */
  #sourceCurrent(kind: AgentKind): () => boolean {
    const policy = this.#options.agentEnablement;
    const lease = policy?.lease(kind);
    return () => !this.#providerFactsClosing && !this.#serviceClosed && (policy === undefined || lease?.isCurrent() === true);
  }

  #providerCurrent(kind: AgentKind): () => boolean {
    const current = this.#sourceCurrent(kind);
    const desktopKind = kind === "codex" ? "codexDesktop" : kind === "dsh" ? "dshDesktop" : undefined;
    if (!desktopKind) return current;
    const desktop = this.#sourceCurrent(desktopKind);
    return () => current() || desktop();
  }

  #allowsDeviceRequest(deviceId: string, message: object): boolean {
    const view = this.#agentView(deviceId);
    const request = message as DeviceE2ePayload;
    const unified = this.#unifiedCodex(deviceId);
    if (request.type === "session.catalog.query" && unified && request.query.agentKind === "codex") return true;
    if (request.type === "session.archive" && isCodexHistoryId(request.sessionId)) return unified && request.agentKind === "codex";
    if (request.type === "session.activate") {
      if (request.target.type === "resume" && isCodexHistoryId(request.target.sessionId)) return unified && request.target.agentKind === "codex";
      if (request.codexLaunchMode !== undefined) {
        // A new Codex activation can carry the launch mode as a separate dimension,
        // but its legacy route kind must still select the same backend. Resumes of
        // canonical catalog IDs use the branch above and may choose either mode.
        return unified && request.target.type === "new" && isCodexKind(request.target.agentKind)
          && request.codexLaunchMode === codexMode(request.target.agentKind) && allowsAgentRequest(view, message);
      }
    }
    const { runtimeId } = message as { runtimeId?: unknown };
    return (typeof runtimeId !== "string" || this.#allowsDeviceRuntime(deviceId, runtimeId)) && allowsAgentRequest(view, message);
  }

  #resetAgentView(deviceId: string): void {
    this.#deviceViewEpochs.set(deviceId, randomUUID());
    this.#agentStateSubscriptions.clearDevice(deviceId);
    this.#compactStateSubscriptions.clearDevice(deviceId);
    this.#sessionSync.clearDevice(deviceId);
    this.#historyInterests.delete(deviceId);
    this.#fieldTraffic.release(deviceId);
    this.#toolContentService.releaseDevice(deviceId); this.#toolInventory.closeOwner(deviceId);
  }

  #unifiedCodex(deviceId: string): boolean { return this.#deviceFeatures.get(deviceId)?.has(CODEX_UNIFIED_HISTORY) === true; }

  #codexRuntimeIdentity(value: unknown): unknown {
    if (value === null || typeof value !== "object") return value;
    const row = value as Partial<RuntimeMetadata>;
    if (!row.runtimeId || !row.sessionId) return value;
    const backend = this.#codexRuntimes().find(runtime => runtime.ownsRuntime(row.runtimeId!));
    if (!backend) return value;
    const threadId = backend.catalogIdentityFor({ runtimeId: row.runtimeId, sessionId: row.sessionId });
    if (threadId === undefined) return value;
    return { ...value, codexCatalogId: this.#codexHistory.id(backend.historyStore, threadId) };
  }

  #codexMessageIdentity(message: object): object {
    const envelope = message as RelayToDeviceMessage;
    if (envelope.type === "runtime.online") return { ...envelope, runtime: this.#codexRuntimeIdentity(envelope.runtime) };
    if (envelope.type === "device.ready") return { ...envelope, runtimes: envelope.runtimes.map(runtime => this.#codexRuntimeIdentity(runtime)) };
    if (envelope.type === "runtime.event" && envelope.event.type === "runtime.metadata") return {
      ...envelope, event: { ...envelope.event, metadata: this.#codexRuntimeIdentity(envelope.event.metadata) },
    };
    return message;
  }

  #codexRuntimes(store?: string): CodexRuntime[] {
    return this.#backends.filter((backend): backend is CodexRuntime => backend instanceof CodexRuntime && backend.isReady()
      && !this.#disabledSources.has(backend.kind) && (store === undefined || backend.historyStore === store));
  }

  #publishCodexArchive(backend: CodexRuntime, threadId: string, archived: boolean, requester?: { deviceId: string; requestId: string }): void {
    for (const deviceId of this.#links.keys()) {
      const unified = this.#unifiedCodex(deviceId);
      const message = { type: "session.archive.changed" as const, agentKind: unified ? "codex" as const : backend.kind,
        sessionId: unified ? this.#codexHistory.id(backend.historyStore, threadId) : backend.legacySessionIdFor(threadId), archived,
        ...(requester?.deviceId === deviceId ? { requestId: requester.requestId } : {}) };
      this.#sendToDevice(deviceId, message);
    }
  }

  #projectCatalog(view: AgentView, value: unknown, unified = false): unknown {
    return value && typeof value === "object" ? this.#hostStateFacts.hiddenCatalog(value as Record<string, unknown>, hiddenKinds(view), unified) : value;
  }

  #projectHostDomain(deviceId: string, scope: StateScope, domain: string, value: unknown): unknown {
    if (scope.kind === "agent" && domain === "capabilities" && value && typeof value === "object") {
      const entries = Object.entries(value);
      const visible = entries.filter(([name]) => this.#allowsCloseCapability(deviceId, name));
      if (entries.length !== visible.length) return Object.fromEntries(visible);
    }
    if (scope.kind === "agent" && domain === "identity") {
      const identity = !this.#deviceFeatures.get(deviceId)?.has(DEVICE_FEATURE_CLAUDE_SEND_NOW) ? omitRuntimeSendNow(value) : value;
      return this.#unifiedCodex(deviceId) ? this.#codexRuntimeIdentity(identity) : identity;
    }
    const view = this.#agentView(deviceId);
    if (scope.kind === "host" && domain === "catalog") return this.#projectCatalog(view, value, this.#unifiedCodex(deviceId));
    if (!view) return value;
    if (scope.kind === "host") {
      if (domain === "workspaces") return this.#workspaceViews.get(view) ?? { workspaces: [], truncated: true };
      if (domain === "diagnostics") {
        const stats = this.#diagnostics.stats(row => allowsAgentIdentity(view, row));
        return { ...value as object, ...stats };
      }
      return projectBackendDomain(view, domain, value);
    }
    if (scope.kind === "device" && domain === "operations" && value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).filter(([, row]) => row && typeof row === "object" && allowsAgentIdentity(view, row)));
    }
    return value;
  }

  #visibleTo(deviceId: string, message: object): object | undefined {
    const runtimeId = (message as { runtimeId?: string }).runtimeId;
    if (runtimeId && !this.#allowsDeviceRuntime(deviceId, runtimeId)) return undefined;
    const view = this.#agentView(deviceId);
    const category = message as { type?: string; kind?: AgentKind };
    const unified = this.#unifiedCodex(deviceId);
    const canonicalArchive = unified && category.type === "session.archive.changed" && isCodexHistoryId((message as { sessionId?: string }).sessionId);
    const unifiedList = unified && category.type === "session.list.result";
    const sharedCodexProvider = category.type?.startsWith("provider.") && category.kind === "codex" && allowsAgent(view, "codexDesktop");
    const visible = sharedCodexProvider || canonicalArchive || unifiedList ? message : projectAgentMessage(view, message);
    if (visible === undefined) return undefined;
    // Policy visibility never changes the set of parsers negotiated by this device.
    const ready = message as { type?: string; deviceFeatures?: string[] };
    const projected = (this.#managedPolicy || this.#unifiedCodex(deviceId) || this.#deviceFeatures.get(deviceId)?.has(RUNTIME_CLOSE_FEATURE)) && ready.type === "device.ready" ? {
      ...visible,
      ...(ready.deviceFeatures ? { deviceFeatures: ready.deviceFeatures } : {}),
      ...(this.#disabledSources.has("dshDesktop") && this.#deviceFeatures.get(deviceId)?.has(negotiatedAgentFeature("dshDesktop")!) ? { dshDesktop: null } : {}),
    } : visible;
    return applyDeviceViewEpoch(this.#unifiedCodex(deviceId) ? this.#codexMessageIdentity(projected) : projected,
      this.#deviceViewEpochs.get(deviceId));
  }

  #rejectAgentFeature(deviceId: string, message: { requestId?: unknown; commandId?: unknown }): void {
    this.#sendToDevice(deviceId, { type: "protocol.error", code: "agent_feature_required", message: "当前客户端未协商此 Agent 功能",
      ...(typeof message.requestId === "string" ? { requestId: message.requestId } : {}),
      ...(typeof message.commandId === "string" ? { commandId: message.commandId } : {}) });
  }

  #resolveAgentStateScope(
    deviceId: string,
    request: {
      readonly scope?: "host" | "agent" | "device" | undefined;
      readonly runtimeId?: string | undefined;
      readonly agentKind?: AgentKind | undefined;
      readonly sessionId?: string | undefined;
    },
  ): StateScope | undefined {
    if (request.scope === "host") return { kind: "host" };
    // 设备视图按发起设备取，客户端不需要（也不能）指定别的设备。
    if (request.scope === "device") return { kind: "device", key: { hostId: this.#identity.hostId, deviceId } };
    if (request.runtimeId !== undefined) return this.#agentFacts.scopeOf(request.runtimeId);
    if (request.sessionId !== undefined) {
      // 没有 agentKind 就拼不出会话身份：宁可不答，也不猜一个后端。
      if (request.agentKind === undefined) return undefined;
      return { kind: "agent", key: { hostId: this.#identity.hostId, agentKind: request.agentKind, sessionId: request.sessionId } };
    }
    if (request.scope === undefined) return { kind: "host" };
    return undefined;
  }

  async #handleProviderRequest(deviceId: string, request: ProviderRequest): Promise<void> {
    const send = (message: object): void => this.#sendJsonToDevice(deviceId, message, "ctl");
    const current = this.#providerCurrent(request.kind);
    const requireCurrent = () => { if (!current()) throw new ProviderError("此 Agent 未启用"); };
    try {
      requireCurrent();
      const manager = this.#options.providers;
      if (!manager) throw new ProviderError("此 Host 尚未启用供应商管理，请升级并重启 Host");
      if (request.type === "provider.subscription") {
        const quota = await manager.querySubscription(request.kind, request.id!);
        requireCurrent();
        send({ type: "provider.subscription.result", protocolVersion: PROTOCOL_VERSION, requestId: request.requestId, kind: request.kind, id: request.id, quota });
        return;
      }
      const providers = request.type === "provider.list" ? await manager.list(request.kind)
        : await this.changeProvider(request.kind, () => manager.switch(request.kind, request.id!, request.enabled));
      requireCurrent();
      send(providerResult(request, providers, request.kind === "codex" && manager.proxyTakeoverActive));
      if (request.type === "provider.switch") this.announceProviderChange(request.kind, deviceId);
      // 这次真的读了清单：把完整摘要写进模型。会话列表那条路径不再写这个领域，所以不会互相覆盖。
      void this.refreshProviderFacts();
    } catch (error) {
      send({ type: request.type === "provider.subscription" ? "provider.subscription.result" : "provider.result", protocolVersion: PROTOCOL_VERSION, requestId: request.requestId, kind: request.kind, ...(request.id ? { id: request.id } : {}),
        error: error instanceof ProviderError ? error.message : "供应商操作失败，请在 Host 检查配置与文件权限" });
    }
  }

  /**
   * 设备重连后补发的 runtime 目录：loopback 上的 Pi 进程 + 各后端的目录条目。
   *
   * Codex 只有**挂着活跃 thread** 才算一条进程（`directoryEntry` 自己把关）：
   * app-server 是常驻的，但没跑会话时它没有 cwd 可言（拿 homedir 占位就是
   * 「主页面多出一条用户目录」的假进程）。会话激活时 onMetadataChange 会重播
   * runtime.online 把它补进目录。
   */
  #runtimesSnapshot(): RuntimeMetadata[] {
    const runtimes = [...this.localRuntimes];
    for (const backend of this.#backends) {
      if (this.#disabledSources.has(backend.kind)) continue;
      runtimes.push(...(backend.directoryEntries?.() ?? []));
    }
    return runtimes;
  }

  /**
   * 这台电脑支持的 agent 种类，随 `device.ready` 下发给手机（§8.4）。
   *
   * 这里只列**现在已经就绪**的后端。能由 Host 按需启动 / 接入的 Agent 另由
   * `#launchableAgentsSnapshot` 公告，手机不把它们误画成已连接。
   */
  #agentsSnapshot(): AgentKind[] {
    return this.#backends.filter((backend) => !this.#disabledSources.has(backend.kind) && backend.isReady()).map((backend) => backend.kind);
  }

  #launchableAgentsSnapshot(): AgentKind[] {
    // Claude Code runs only in its official TUI: launchable where the Host can open a terminal.
    const agents = this.#agentsSnapshot().filter(kind => kind !== "claude" || this.#claudeLaunchable);
    if (this.#managedCodexLaunchable.has("codex") && !agents.includes("codex")) agents.push("codex");
    if ((this.#managedPolicy ? this.#managedCodexLaunchable.has("codexDesktop") : this.#options.codexDesktopLaunchable === true) && !agents.includes("codexDesktop")) agents.push("codexDesktop");
    if ((this.#managedPolicy ? this.#managedDshLaunchable.has("dsh") : this.#options.dshLaunchable === true) && !agents.includes("dsh")) agents.push("dsh");
    for (const kind of KIMI_KINDS) if (this.#kimi[kind]?.canLaunch() && !agents.includes(kind)) agents.push(kind);
    if (this.#opencodeConnection?.launchable && !agents.includes(OPENCODE_KIND)) agents.push(OPENCODE_KIND);
    if ((this.#openClawStart?.installed || this.#openClawStart?.startup.starting) && !agents.includes(OPENCLAW_KIND)) agents.push(OPENCLAW_KIND);
    // A Desktop whose version cannot be attached is not offered as launchable (DSH-DESKTOP-01).
    if (this.#hermes?.installed && !agents.includes("hermes")) agents.push("hermes");
    const desktop = this.#dshDesktopSnapshot()?.state;
    if ((this.#managedPolicy ? this.#managedDshLaunchable.has("dshDesktop") : this.#options.dshDesktopLaunchable === true) && !agents.includes("dshDesktop")
      && desktop !== "unsupported" && desktop !== "notInstalled" && desktop !== "incompatible") agents.push("dshDesktop");
    return agents.filter(kind => !this.#disabledSources.has(kind));
  }

  /** Recover existing native work without creating a Session, starting a Web service or opening Desktop. */
  recoverDshRuntime(kind: DshKind = "dsh"): Promise<DshRuntime | undefined> {
    return this.#ensureDshRuntime(true, kind);
  }

  /**
   * HOST-PREP-05: the desktop's DSH prestart, run after the Relay is online. It shares the slot with
   * recovery and App requests, so a single Web service connection is started however they interleave.
   */
  prepareDshRuntime(): Promise<DshRuntime | undefined> {
    return this.#ensureDshRuntime(false, "dsh");
  }

  #scheduleDshRecovery(kind: DshKind = "dsh"): void {
    const slot = this.#dsh[kind];
    const lease = this.#managedPolicy ? this.#managedAgents.lease(kind) : undefined;
    if (this.#managedPolicy && !lease) return;
    if (!(kind === "dsh" ? this.#options.recoverDshRuntime : this.#options.recoverDshDesktopRuntime) || this.#providerFactsClosing || this.#serviceClosed) return;
    void this.recoverDshRuntime(kind).then(() => { slot.recoveryError = undefined; }, error => {
      const message = describeError(error);
      if (!this.#providerFactsClosing && message !== slot.recoveryError) {
        slot.recoveryError = message;
        this.#options.log?.(`${kind === "dsh" ? "DeepSeek" : "DeepSeek Desktop"} 自动接入暂时失败，将重试：${message}`);
      }
    }).finally(() => {
      if (this.#providerFactsClosing || this.#serviceClosed || lease?.isCurrent() === false) return;
      slot.recoveryTimer = setTimeout(() => { slot.recoveryTimer = undefined; this.#scheduleDshRecovery(kind); }, 2_000);
      slot.recoveryTimer.unref();
    });
  }

  async #ensureDshRuntime(existingOnly = false, kind: DshKind = "dsh"): Promise<DshRuntime | undefined> {
    const lease = this.#managedPolicy ? this.#managedAgents.lease(kind) : undefined;
    const currentPolicy = () => !this.#providerFactsClosing && !this.#serviceClosed && (!this.#managedPolicy || lease?.isCurrent() === true);
    if (!currentPolicy()) return undefined;
    const slot = this.#dsh[kind];
    const current = this.#backends.find(backend => backend.kind === kind && backend.isReady());
    if (current !== undefined) return current as DshRuntime;
    if (slot.starting) {
      const passive = slot.startingExistingOnly;
      if (!existingOnly && passive) {
        // A failed read-only probe is not a failed App operation. Retry through the
        // explicit launch path, but never repeat a launch or native Session operation.
        const runtime = await slot.starting.catch(() => undefined);
        return currentPolicy() ? runtime ?? this.#ensureDshRuntime(false, kind) : undefined;
      }
      return slot.starting;
    }
    const connect = kind === "dsh"
      ? existingOnly ? this.#options.recoverDshRuntime : this.#options.ensureDshRuntime
      : existingOnly ? this.#options.recoverDshDesktopRuntime : this.#options.ensureDshDesktopRuntime;
    if (!connect) return undefined;
    const pending = (async () => {
      const runtime = await connect();
      if (runtime !== undefined) {
        if (!currentPolicy()) { await runtime.stop(); return undefined; }
        await this.attachDshRuntime(runtime, currentPolicy);
        if (!currentPolicy()) {
          this.detachDshRuntime(runtime);
          await runtime.stop();
          return undefined;
        }
      }
      return runtime;
    })().finally(() => { if (slot.starting === pending) slot.starting = undefined; });
    slot.startingExistingOnly = existingOnly;
    slot.starting = pending;
    return pending;
  }

  #dshDesktopSnapshot(): DshDesktopAttach | null {
    return this.#disabledSources.has("dshDesktop") ? null : this.#options.dshDesktopStatus?.() ?? null;
  }

  /** Desktop attach tier changed: devices that understand it see the new tier and launchability. */
  announceDshDesktopStatus(): void {
    this.#broadcastDeviceReady();
  }

  #codexDesktopSnapshot(): CodexDesktopAttach | null {
    return this.#disabledSources.has("codexDesktop") ? null : this.#options.codexDesktopStatus?.() ?? null;
  }

  /** Re-send the authoritative capability list after a desktop GUI state change. */
  #broadcastDeviceReady(kind?: AgentKind): void {
    this.refreshHostFacts();
    for (const deviceId of this.#links.keys()) {
      if (kind !== undefined && !allowsAgent(this.#agentView(deviceId), kind)) continue;
      this.#sendToDevice(deviceId, { type: "device.ready", ...this.#deviceReadyPayload(deviceId) });
    }
  }

  /**
   * 握手完成或接入分档变化时重播的同一份权威载荷。
   *
   * 放在一处是因为这三项都只能由 Host 回答（能力、可拉起、桌面接入），而手机把
   * `device.ready` 当整体快照覆盖——分开发就会互相抹掉。
   */
  #deviceReadyPayload(deviceId: string): Omit<Extract<RelayToDeviceMessage, { type: "device.ready" }>, "type"> {
    const features = this.#deviceFeatures.get(deviceId);
    return {
      protocolVersion: PROTOCOL_VERSION,
      deviceId,
      notificationEpoch: this.#notifications.hostEpoch,
      modelEpoch: this.#agentStateRegistry.currentModelEpoch(),
      runtimes: this.#runtimesSnapshot(),
      agents: this.#agentsSnapshot(),
      launchableAgents: this.#launchableAgentsSnapshot(),
      codexDesktop: this.#codexDesktopSnapshot(),
      dshDesktop: this.#dshDesktopSnapshot(),
      hostFeatures: [
        HOST_FEATURE_DEVICE_FEATURES,
        ...(this.#managedPolicy || this.#codexRuntimes().length || this.#options.ensureCodexRuntime || this.#options.ensureCodexDesktop ? [CODEX_UNIFIED_HISTORY] : []),
        ...(this.#managedPolicy ? [AGENT_ENABLEMENT_FEATURE, AGENT_ENABLEMENT_REVIEW_FEATURE] : []),
        HOST_FEATURE_IMPORT_TARGET,
        HOST_FEATURE_WEB_PREVIEW,
        HOST_FEATURE_NATIVE_FILE_PREVIEW,
        ...(this.#options.preferAutoSessionSpawn === true ? [HOST_FEATURE_SESSION_SPAWN_AUTO] : []),
        DEVICE_FEATURE_EXPLICIT_TUI,
        DEVICE_FEATURE_MESSAGE_RENDER,
        DEVICE_FEATURE_OPENCLAW,
        DEVICE_FEATURE_HERMES,
        DEVICE_FEATURE_OPENCODE,
        DEVICE_FEATURE_COMPACT_BOOTSTRAP,
        DEVICE_FEATURE_CLAUDE_SEND_NOW,
        RUNTIME_CLOSE_FEATURE,
        RUNTIME_VIEW_CLOSE_FEATURE,
        ...(this.#kimi[KIMI_KIND] || this.#options.createKimiCodeRuntime ? [DEVICE_FEATURE_KIMI_CODE] : []),
        ...(this.#kimi[KIMI_DESKTOP_KIND] || this.#options.createKimiCodeRuntime && this.#options.kimiCodeDesktopSupported === true ? [DEVICE_FEATURE_KIMI_CODE_DESKTOP] : []),
        ...(this.#options.providers ? [VOICE_CLEANUP_FEATURE] : []),
      ],
      sessionConfiguration: 1,
        ...(features && (features.has(DEVICE_FEATURE_OPENCLAW) || features.has(DEVICE_FEATURE_KIMI_CODE) || features.has(DEVICE_FEATURE_KIMI_CODE_DESKTOP) || features.has(RUNTIME_CLOSE_FEATURE) || this.#unifiedCodex(deviceId) || this.#managedPolicy && features.has(AGENT_ENABLEMENT_FEATURE)) ? { deviceFeatures: [...features] } : {}),
    };
  }

  #cancelBootstrapReplay(deviceId: string): void {
    const old = this.#bootstrapReplayTimers.get(deviceId);
    if (old === undefined) return;
    clearTimeout(old);
    this.#bootstrapReplayTimers.delete(deviceId);
  }

  /** Give compact clients time to request their scoped model after device.ready;
   * strict old clients still receive the full menu after the bounded grace period. */
  #scheduleBootstrapReplay(deviceId: string, kind: PathKind): void {
    this.#cancelBootstrapReplay(deviceId);
    if (this.#deviceFeatures.get(deviceId)?.has(DEVICE_FEATURE_COMPACT_BOOTSTRAP)) return;
    const timer = setTimeout(() => {
      if (this.#bootstrapReplayTimers.get(deviceId) !== timer) return;
      this.#bootstrapReplayTimers.delete(deviceId);
      const link = this.#links.get(deviceId);
      if (!link?.active || link.protocolVersion(kind) === undefined) return;
      for (const backend of this.#backends) if (backend instanceof CodexRuntime && backend.isReady())
        for (const threadId of backend.activeThreadIds()) backend.announce(threadId);
      for (const kind of DSH_KINDS) this.#dsh[kind].runtime?.announce();
      this.#claudeBackend.announce();
      for (const { runtimeId, event } of this.#loopback?.runtimeCapabilities() ?? []) {
        if (this.#compactStateSubscriptions.owns(deviceId, runtimeId, "capabilities")) continue;
        this.#sendToDeviceOn(deviceId, kind, { type: "runtime.event", protocolVersion: PROTOCOL_VERSION, runtimeId,
          sequence: this.#nextEventSequence(runtimeId, channelForDeviceMessage({ type: "runtime.event", event })), event });
      }
    }, Math.max(0, Math.min(1_000, this.#options.bootstrapReplayDelayMs ?? 1_000)));
    this.#bootstrapReplayTimers.set(deviceId, timer);
  }

  /** 接入分档变了（探测结果、握手成功、接入失败）：让已配对的手机马上看到。 */
  announceCodexDesktopStatus(): void {
    this.#broadcastDeviceReady();
  }

  /** 某台设备此刻生效的路径（§14 B4 要显示的那个事实）。 */
  activePathOf(deviceId: string): PathKind | undefined {
    return this.#links.get(deviceId)?.active;
  }

  get relayTransportKind(): RelayTransportKind | undefined { return this.#relay?.transportKind; }
  get relayTransportMode(): RelayTransportMode { return this.#relay?.transportMode ?? this.#options.relayTransport ?? "auto"; }

  async setRelayTransportMode(mode: RelayTransportMode): Promise<void> {
    if (this.#relay === undefined) throw new Error("Host Relay has not started");
    await this.#relay.setTransportMode(mode);
  }

  async start(): Promise<void> {
    if (this.#options.agentEnablement) {
      this.#setManagedPolicy(await this.#options.agentEnablement.read());
      this.#unsubscribeEnablement = this.#options.agentEnablement.subscribe(snapshot => this.#applyManagedPolicy(snapshot));
    }
    void this.#hermes?.discover().catch(() => undefined);
    if (!this.#managedPolicy) void this.#startClaudeBridge();
    this.#modelLifecycle = "starting";
    this.refreshHostFacts();
    // Host 在 Relay 眼里就是一个普通 runtime，直接复用 v1 的身份空间。
    const runtime: RuntimeMetadata = {
      runtimeId: this.#identity.hostId,
      name: this.#identity.hostName,
      cwd: homedir(),
      status: "idle",
    };
    const relay = new HostRelayClient({
      relayUrl: this.#options.relayUrl,
      ...(this.#options.relayTransport === undefined ? {} : { transportMode: this.#options.relayTransport }),
      ...(this.#options.relaySocketOptions === undefined ? {} : { socketOptions: this.#options.relaySocketOptions }),
      credential: this.#options.credential,
      runtime,
      onFrame: (envelope) => {
        this.#handleFrame(envelope, "relay");
      },
      onAuthenticationError: error => this.#options.onRelayAuthenticationError?.(error),
      ...(this.#options.reconnect === undefined ? {} : { reconnect: this.#options.reconnect }),
      onStateChange: (state) => {
        this.#liveActivities.setConnected(state === "connected");
        if (state === "connected") {
          // 重连后必须把出口重新挂回去：`detach` 连出口一起摘掉，而出口只在链路**第一次**
          // 建立时挂上（见 #requireLink）。少了这一步，凡是断线前见过面的设备都会永久失去
          // 中继出口——手机发来的 HS1 会因为「这条路没有出口」被静默丢掉，用户看到的是
          // 「已连上中继，但电脑没有回应端到端加密握手」。挂出口 ≠ 这条路可用：
          // 可用与否仍由设备重新握手成功（MarkAvailable）决定。
          for (const link of this.#links.values()) this.#attachRelaySink(link);
        } else {
          // Relay 断了：把它从每台设备的候选路径里摘掉，让还在的 LAN 立刻接手。
          // 不摘的话生效路径会停在一个死掉的 socket 上，出站推送全部静默失败。
          for (const link of this.#links.values()) link.detach("relay");
        }
        this.#options.onStateChange?.(state);
        this.recordDiagnostic({ scope: "host", agentKind: null, sessionId: null, category: "transport",
          severity: state === "connected" ? "info" : "warning", message: `Relay connection: ${state}` });
        this.refreshHostFacts();
      },
      onProtocolError: (code, message, transferId, targetDeviceId) => {
        // 目标设备不在中继上：把它名下的下载以确定原因收场。这条回绝不带 transferId
        // （v2 分片是端到端加密的，中继取不到），只能靠中继交回的 `hdr.to` 定位。
        if (code === "device_offline" && targetDeviceId !== undefined) {
          const failed = this.#downloads.failDeviceTransfers(targetDeviceId, code);
          // 这里**不能**动这条路本身（detach/摘可用性）：detach 会连同该路径的 E2E 会话
          // 一起清掉，而 APP 侧只会在 socket 重开或收到 host.online 时重新握手——它以为
          // 自己连着，于是 Host 后续广播全部静默丢掉，手机就冻在「运行中」。
          // 只标记对端缺席：停掉这条路的 RTT 探针（否则每两秒换回一条回绝），
          // 日志每段离线只报一次；手机在中继上重新发来任何帧即解除。
          const freshAbsence = this.#links.get(targetDeviceId)?.markPeerAbsent("relay") ?? false;
          if (failed > 0 || freshAbsence) {
            this.#options.log?.(`设备 ${targetDeviceId} 不在中继上${failed > 0 ? `：终止 ${failed} 条下载` : ""}`);
          }
          return;
        }
        // 中继明确回绝了一次转发（例如它不认识某种帧、或目标设备不在线）。
        // 这类回绝只到得了这里，不落日志就等于消失——协议对不齐时最难查的就是它。
        this.#options.log?.(`中继回绝了转发：${code} ${message}`);
        // 带 transferId 的回绝是下载流的：中继已经丢了这条路，Host 直接收场即可。
        if (transferId !== undefined) this.#downloads.failTransferFromRelay(transferId, code);
      },
    });
    this.#relay = relay;

    // LAN 端点先起：端口被占基本只有一个原因——这台机器上已经有一个 Host 在跑。
    // 这种情况必须在做任何副作用之前就失败（写 loopback 发现文件、连中继、抢 runtime 身份），
    // 否则两个 Host 会用同一个中继身份互相踢，手机端表现为状态卡住、聊天不更新。
    if (this.#options.lan !== false && this.#options.lanListen !== false) {
      await this.#startLan();
    }
    await this.#fileChanges.initialize();
    this.#toolContentStore ??= await createProcessToolContentStore(join(this.#stateDir, "temporary-content"), "host");
    this.#toolDiagnosticTimer ??= setInterval(() => this.#flushToolDiagnostics(), 30_000);
    this.#toolDiagnosticTimer.unref();
    for (const backend of this.#backends) backend.setToolContentStore?.(this.#toolContentStore, this.#identity.hostId);

    if (this.#options.loopback !== false) {
      const loopback = new HostLoopbackServer({
        stateDir: this.#stateDir,
        hostId: this.#identity.hostId,
        ...(this.#options.log === undefined ? {} : { log: this.#options.log }),
        ...(this.#options.codexLaunch === undefined ? {} : { onCodexLaunch: this.#options.codexLaunch }),
        admitRuntime: () => !this.#disabledSources.has("pi") && !this.#providerFactsClosing,
        onClaudeHook: async (input, signal) => this.#disabledSources.has("claude") || this.#providerFactsClosing ? {} : this.#claudeBridge.accept(input, signal),
        onClaudeModsHello: input => this.#disabledSources.has("claude") || this.#providerFactsClosing ? { ok: false, error: "bridge_offline" } : this.#claudeModsBridge.hello(input),
        onClaudeModsPoll: input => this.#disabledSources.has("claude") || this.#providerFactsClosing ? { ok: false, error: "bridge_offline" } : this.#claudeModsBridge.pollRequest(input),
        onClaudeModsEvent: (input, signal) => this.#disabledSources.has("claude") || this.#providerFactsClosing ? "offline" : this.#claudeModsBridge.receiveRequestWithBoundaries(input, signal),
        onFileChangeBoundary: (input, signal) => this.#acceptFileChangeBoundary(input, signal),
        onRuntimeOnline: (metadata) => {
          const displaced = this.#agentFacts.displacedRuntime(metadata.runtimeId, metadata);
          if (displaced) this.#markRuntimeOffline(displaced.runtimeId, "replaced_by_new_runtime");
          this.#agentFacts.observe(metadata.runtimeId, { type: "runtime.metadata", metadata });
          this.#notifications.attach(metadata.runtimeId, metadata.sessionId);
          this.#broadcastDeviceMessage({
            type: "runtime.online",
            runtime: metadata,
          });
        },
        onRuntimeOffline: (runtimeId, reason) => {
          this.#markRuntimeOffline(runtimeId, reason);
          this.#notifications.offline(runtimeId);
          this.#broadcastDeviceMessage({ type: "runtime.offline", runtimeId, reason });
        },
        onRuntimeEvent: (runtimeId, _piSequence, event) => {
          // 顺手记下 artifact 的元数据（含 path）：这是 Host 之后能替 runtime 服务下载的依据。
          if (event.type === "artifact.started") this.#downloads.noteArtifact(runtimeId, event.artifact);
          this.#publishRuntimeEvent(runtimeId, event);
        },
        onRuntimeFrame: (_runtimeId, frame) => {
          // artifact 分片是裸字节。以前它被当成 `data` 载荷发出去，手机按 UTF-8 解读再拿去
          // 解析 JSON，于是「下载」等于「界面报一句收到无效的中继服务器消息」。
          this.#broadcastBinary(frame, _runtimeId);
        },
      });
      this.#loopback = loopback;
      await loopback.start();
    }

    if (this.#options.codexRuntime !== undefined && !this.#disabledSources.has("codex")) {
      // Codex 后端就绪（app-server 子进程由调用方管理生命周期）。启动时还没有活跃
      // thread，不广播 runtime.online——目录里不该有一条 cwd=homedir 的「空壳 Codex」；
      // 会话激活后 onMetadataChange 会补上。
      this.#options.codexRuntime.markStarted();
      this.#options.log?.(`Codex 后端已就绪（runtimeId=${this.#options.codexRuntime.runtimeId}）`);
    }
    if (this.#options.codexDesktopRuntime !== undefined && !this.#disabledSources.has("codexDesktop")) {
      this.#options.codexDesktopRuntime.markStarted();
      this.#options.log?.(`Codex 桌面后端已就绪（runtimeId=${this.#options.codexDesktopRuntime.runtimeId}）`);
    }

    await relay.start();
    this.#modelLifecycle = "running";
    for (const runtime of Object.values(this.#kimi)) runtime?.start();
    if (this.#managedPolicy) void this.#managedAgents.reconcile(this.#managedPolicy, true);
    else {
      void this.#startOpenClaw();
      this.#openCodeBackend?.start();
      void this.#opencodeConnection?.start();
    }
    // HOST-PREP-05: DeepSeek session discovery (a Web handshake or a Desktop attach) no longer holds the
    // Relay: phones connect first and DeepSeek sessions follow. Recovery for a kind starts only after its
    // prestarted backend settled, so it cannot open a second connection beside one still starting.
    if (!this.#managedPolicy) for (const kind of DSH_KINDS) void this.#startDshBackend(kind).finally(() => this.#scheduleDshRecovery(kind));
    this.refreshHostFacts();
    void this.refreshProviderFacts();
  }

  async #startClaudeBridge(current = (): boolean => true): Promise<void> {
    this.#claudeModsSweep ??= setInterval(() => { this.#claudeModsBridge.expireStale(); }, 5_000);
    this.#claudeModsSweep.unref();
    const launchable = await this.#claudeBackend.launchable();
    if (!current() || this.#providerFactsClosing || launchable === this.#claudeLaunchable) return;
    this.#claudeLaunchable = launchable;
    this.#broadcastDeviceReady();
  }

  #stopClaudeBridge(): void {
    if (this.#claudeModsSweep !== undefined) clearInterval(this.#claudeModsSweep);
    this.#claudeModsSweep = undefined;
    this.#claudeModsBridge.close();
    this.#claudeBridge.close();
  }

  async #startManagedCodex(kind: "codex" | "codexDesktop", lease: AgentLifecycleLease): Promise<void> {
    const launchable = await this.#options.prepareManagedCodex?.(kind, lease);
    if (!lease.isCurrent()) return;
    if (launchable) this.#managedCodexLaunchable.add(kind);
    this.#broadcastDeviceReady();
  }

  async #stopManagedCodex(kind: "codex" | "codexDesktop"): Promise<void> {
    this.#managedCodexLaunchable.delete(kind);
    const runtime = this.#backends.find(item => item.kind === kind);
    if (runtime instanceof CodexRuntime) {
      for (const entry of runtime.directoryEntries()) {
        this.#notifications.end(entry.runtimeId);
        this.#markRuntimeOffline(entry.runtimeId, "agent_disabled");
      }
      if (kind === "codex") this.detachCodexRuntime(runtime);
      else this.detachCodexDesktopRuntime(runtime);
    }
    await this.#options.releaseManagedCodex?.(kind);
  }

  async #ensureManagedCodex(kind: "codex" | "codexDesktop"): Promise<CodexRuntime | undefined> {
    const lease = this.#managedPolicy ? this.#managedAgents.lease(kind) : undefined;
    if (this.#managedPolicy && !lease) return undefined;
    const runtime = await (kind === "codex" ? this.#options.ensureCodexRuntime?.() : this.#options.ensureCodexDesktop?.());
    if (lease?.isCurrent() === false || this.#providerFactsClosing) return undefined;
    if (runtime && !this.#backends.includes(runtime)) {
      if (kind === "codex") this.attachCodexRuntime(runtime);
      else this.attachCodexDesktopRuntime(runtime);
    }
    return runtime;
  }

  async #startManagedDsh(kind: DshKind, lease: AgentLifecycleLease): Promise<void> {
    const launchable = await this.#options.prepareManagedDsh?.(kind, lease);
    if (!lease.isCurrent()) return;
    if (launchable) this.#managedDshLaunchable.add(kind);
    await this.#startDshBackend(kind);
    if (!lease.isCurrent()) return;
    this.#scheduleDshRecovery(kind);
    this.#broadcastDeviceReady();
  }

  async #stopManagedDsh(kind: DshKind): Promise<void> {
    this.#managedDshLaunchable.delete(kind);
    const slot = this.#dsh[kind];
    clearTimeout(slot.recoveryTimer); slot.recoveryTimer = undefined;
    this.#options.releaseManagedDsh?.(kind);
    // Relinquish the slot now. The old connect closure still self-disposes on its revoked lease.
    slot.starting = undefined;
    const runtime = slot.runtime;
    if (!runtime) return;
    for (const entry of runtime.directoryEntries()) {
      this.#notifications.end(entry.runtimeId);
      this.#markRuntimeOffline(entry.runtimeId, "agent_disabled");
    }
    this.detachDshRuntime(runtime);
    await runtime.stop();
  }

  readonly #agentReviewKey = randomBytes(32);

  readonly #desktopPresenceInFlight = new Set<AgentBackend>();
  #desktopHermesAttaching = false;
  #desktopPresenceCheckedAt = -Infinity;
  readonly #desktopPresence = new Map<AgentBackend, { rows: NativeRunningSession[]; expiresAt: number }>();

  /** Driven by the desktop only. A read never activates a mobile session or starts a Gateway. */
  refreshRunningAgentSessions(): void {
    if (this.#providerFactsClosing || this.#serviceClosed ||
        performance.now() - this.#desktopPresenceCheckedAt < 10_000) return;
    this.#desktopPresenceCheckedAt = performance.now();
    const current = (backend: AgentBackend) => !this.#providerFactsClosing && !this.#serviceClosed &&
      this.#backends.includes(backend) && !this.#disabledSources.has(backend.kind) && backend.isReady();
    const refresh = async (backend: AgentBackend) => {
      if (!backend.readRunningSessions || !current(backend) || this.#desktopPresenceInFlight.has(backend)) return;
      this.#desktopPresenceInFlight.add(backend);
      try {
        const rows = await backend.readRunningSessions();
        if (current(backend)) this.#desktopPresence.set(backend, { rows, expiresAt: performance.now() + 20_000 });
      } catch { /* Unsupported or temporarily unavailable: only show bounded, confirmed observations. */ }
      finally { this.#desktopPresenceInFlight.delete(backend); }
    };
    for (const backend of this.#desktopPresence.keys()) if (!current(backend)) this.#desktopPresence.delete(backend);
    const hermes = this.#hermes;
    for (const backend of this.#backends) void refresh(backend);
    if (hermes?.installed && !hermes.backend?.isReady() && !this.#disabledSources.has("hermes") && !this.#desktopHermesAttaching) {
      this.#desktopHermesAttaching = true;
      void hermes.attachExisting().then(refresh, () => {}).finally(() => { this.#desktopHermesAttaching = false; });
    }
  }

  runningAgentSessions(): Record<string, { sessions: string[]; total: number }> {
    const rows = new Map<AgentKind, Map<string, string>>();
    const attached = new Map<AgentKind, Set<string>>();
    const backends = this.#backends.filter(backend => !this.#disabledSources.has(backend.kind) && backend.isReady());
    const sources = backends.map(backend => [backend.kind,
      backend.kind === "pi" ? this.localRuntimes : backend.directoryEntries?.() ?? []] as const);
    for (const [kind, entries] of sources) {
      const identities = attached.get(kind) ?? new Set<string>();
      const runtimes = rows.get(kind) ?? new Map<string, string>();
      for (const entry of entries) {
        const id = entry.sessionId ?? entry.runtimeId;
        identities.add(id);
        if (entry.status !== "idle") runtimes.set(id, entry.sessionName?.trim() || entry.name.trim());
      }
      attached.set(kind, identities);
      rows.set(kind, runtimes);
    }
    for (const backend of backends) {
      const observed = this.#desktopPresence.get(backend);
      if (!observed || observed.expiresAt <= performance.now()) continue;
      const runtimes = rows.get(backend.kind)!;
      for (const entry of observed.rows) {
        // The attached source has the current execution state, even when it says idle.
        if (!attached.get(backend.kind)?.has(entry.sessionId)) runtimes.set(entry.sessionId, entry.name?.trim() ?? "");
      }
    }
    return Object.fromEntries([...rows].filter(([, entries]) => entries.size).map(([kind, entries]) => [kind, {
      sessions: [...entries.values()].slice(0, 24).map(name => (name || "未命名会话").slice(0, 256)),
      total: entries.size,
    }]));
  }

  verifyAgentDisable(kind: AgentKind, revision: number, token?: string, audience = "desktop"): void {
    const review = this.reviewAgentDisable(kind, revision, audience);
    if (review && review.token !== token) throw new AgentDisableConfirmationRequired(review);
  }

  reviewAgentDisable(kind: AgentKind, revision: number, audience: string): AgentDisableReview | undefined {
    const backends = this.#backends.filter(item => item.kind === kind);
    const runtimes = kind === "pi" ? this.localRuntimes : backends.flatMap(item => item.directoryEntries?.() ?? []);
    const byRuntime = new Map(runtimes.map(runtime => [runtime.runtimeId, runtime]));
    const commands = new Map<string, string[]>();
    for (const owner of this.#commandOwners.values()) {
      if (!owner.terminal && (byRuntime.has(owner.runtimeId) || backends.some(item => item.ownsRuntime(owner.runtimeId)))) {
        const bucket = commands.get(owner.runtimeId) ?? [];
        bucket.push(JSON.stringify([owner.commandId, owner.at])); commands.set(owner.runtimeId, bucket);
      }
    }
    const affected = [...new Set([...runtimes.filter(runtime => runtime.status !== "idle").map(runtime => runtime.runtimeId), ...commands.keys()])].sort();
    if (!affected.length) return;
    const label = (runtime?: RuntimeMetadata): string => (runtime?.sessionName?.trim() || runtime?.name.trim() || "未命名会话").slice(0, 256);
    const fingerprint = affected.map(id => {
      const runtime = byRuntime.get(id);
      const key = this.#agentFacts.scopeOf(id);
      const execution = key ? this.#agentStateRegistry.read<AgentExecutionState>(key, "execution")?.value : undefined;
      return [id, runtime?.sessionId, runtime?.status, label(runtime), execution?.turn?.turnId, execution?.waitingFor, commands.get(id)?.sort()];
    });
    const token = createHmac("sha256", this.#agentReviewKey).update(JSON.stringify([audience, kind, revision, fingerprint])).digest("hex");
    return { kind, revision, token, sessions: affected.slice(0, 24).map(id => label(byRuntime.get(id))), total: affected.length };
  }

  #setManagedPolicy(snapshot: AgentEnablementSnapshot): void {
    this.#managedPolicy = snapshot;
    this.#disabledSources = new Set(snapshot.agents.filter(row => !row.enabled).map(row => row.kind));
  }

  #applyManagedPolicy(snapshot: AgentEnablementSnapshot): void {
    if (this.#providerFactsClosing || this.#serviceClosed) return;
    const next = snapshot;
    if (this.#managedPolicy && next.revision <= this.#managedPolicy.revision) return;
    const changed = next.agents.filter(row => row.enabled !== this.#managedPolicy?.agents.find(old => old.kind === row.kind)?.enabled);
    this.#setManagedPolicy(next);
    if (this.#modelLifecycle === "running") void this.#managedAgents.reconcile(next, true);
    if (changed.length > 0) {
      for (const deviceId of this.#links.keys()) {
        const features = this.#deviceFeatures.get(deviceId);
        if (changed.some(({ kind }) => { const feature = negotiatedAgentFeature(kind); return !feature || features?.has(feature); })) this.#resetAgentView(deviceId);
      }
      this.#invalidateCatalog();
      this.#broadcastDeviceReady();
      void this.refreshProviderFacts();
    }
    for (const [id, features] of this.#deviceFeatures) {
      if (features.has(AGENT_ENABLEMENT_FEATURE)) this.#sendToDevice(id, { type: "agent.enablement.snapshot", snapshot: this.#enablementForDevice(id, next) });
    }
  }

  #enablementForDevice(deviceId: string, snapshot: AgentEnablementSnapshot) {
    const features = this.#deviceFeatures.get(deviceId);
    return { ...snapshot, agents: snapshot.agents.filter(row => {
      const feature = negotiatedAgentFeature(row.kind);
      return feature === undefined || features?.has(feature) === true;
    }) };
  }

  async #handleAgentEnablement(deviceId: string, message: Extract<DeviceE2ePayload, { type: "agent.enablement.read" | "agent.enablement.write" }>): Promise<void> {
    const controller = this.#options.agentEnablement;
    const link = this.#links.get(deviceId);
    const features = this.#deviceFeatures.get(deviceId);
    const active = (): boolean => !this.#providerFactsClosing && !this.#serviceClosed && !!link?.active && link === this.#links.get(deviceId) && features === this.#deviceFeatures.get(deviceId);
    const { requestId } = message;
    if (!controller || !this.#managedPolicy || !features?.has(AGENT_ENABLEMENT_FEATURE) || !active()) {
      this.#rejectAgentFeature(deviceId, { requestId }); return;
    }
    const scoped = features.has(AGENT_ENABLEMENT_REVIEW_FEATURE);
    try {
      if (message.type === "agent.enablement.read") {
        const snapshot = await controller.read();
        if (active()) this.#sendToDevice(deviceId, { type: "agent.enablement.snapshot", requestId, snapshot: this.#enablementForDevice(deviceId, snapshot) });
        return;
      }
      const { kind, enabled, expectedRevision, confirmDisable, review } = message;
      if (!this.#managedPolicy.agents.some(row => row.kind === kind)) { this.#rejectAgentFeature(deviceId, { requestId }); return; }
      const kindFeature = kind === KIMI_KIND ? DEVICE_FEATURE_KIMI_CODE : kind === KIMI_DESKTOP_KIND ? DEVICE_FEATURE_KIMI_CODE_DESKTOP : undefined;
      if (kindFeature !== undefined && !features.has(kindFeature)) { this.#rejectAgentFeature(deviceId, { requestId }); return; }
      if (review !== undefined && !scoped) { this.#rejectAgentFeature(deviceId, { requestId }); return; }
      const result = await controller.set({ kind, enabled, expectedRevision, ...(confirmDisable ? { confirmDisable } : {}), ...(review ? { review } : {}) },
        active, (source, revision, token) => this.verifyAgentDisable(source, revision, token, `paired:${deviceId}`), scoped);
      const snapshot = result.snapshot;
      if (active()) this.#sendToDevice(deviceId, { type: "agent.enablement.result", requestId, status: result.status, snapshot: this.#enablementForDevice(deviceId, snapshot) });
    } catch (error) {
      if (active() && scoped && error instanceof AgentDisableConfirmationRequired) {
        this.#sendToDevice(deviceId, { type: "agent.enablement.review", requestId, review: error.review });
        return;
      }
      if (active()) this.#sendToDevice(deviceId, { type: "protocol.error", requestId,
        code: error instanceof AgentDisableConfirmationRequired ? "agent_disable_confirmation_required" : "agent_enablement_unavailable",
        message: error instanceof AgentDisableConfirmationRequired ? "请确认停用正在工作的 Agent" : "无法读取或保存 Agent 设置" });
    }
  }

  async #stopManagedOpenClaw(): Promise<void> {
    const backend = this.#openClaw;
    const startup = this.#openClawStart?.startup;
    startup?.cancel();
    this.#openClawStart = undefined;
    if (!backend) return;
    this.#openClaw = undefined;
    this.#backends = this.#backends.filter(item => item !== backend);
    for (const runtime of backend.directoryEntries()) {
      this.#notifications.end(runtime.runtimeId);
      this.#markRuntimeOffline(runtime.runtimeId, "agent_disabled");
    }
    try { await Promise.all([backend.stop(), startup?.close()]); }
    finally { this.#invalidateCatalog(); this.#broadcastDeviceReady(); }
  }

  async #startOpenClaw(current = (): boolean => true): Promise<void> {
    if (this.#options.openClaw === false || this.#openClaw || this.#providerFactsClosing) return;
    try {
      const config = this.#options.openClaw ?? await loadOpenClawConfig(this.#stateDir);
      if (!config || !current() || this.#providerFactsClosing) return;
      const backend = await OpenClawBackend.create(config, this.#stateDir, this.hostId, {
        ready: () => {
          this.#desktopPresence.delete(backend);
          if (current()) { this.#invalidateCatalog(); this.#broadcastDeviceReady(); }
        },
        catalog: () => { if (current()) this.#invalidateCatalog(); },
        online: runtime => {
          if (!current()) return;
          this.#agentFacts.observe(runtime.runtimeId, { type: "runtime.metadata", metadata: runtime });
          this.#notifications.attach(runtime.runtimeId, runtime.sessionId);
          this.#broadcastDeviceMessage({ type: "runtime.online", runtime });
        },
        offline: (runtimeId, reason) => {
          if (!current()) return;
          this.#notifications.end(runtimeId); this.#markRuntimeOffline(runtimeId, reason);
          this.#broadcastDeviceMessage({ type: "runtime.offline", runtimeId, reason });
        },
        event: (runtimeId, event) => { if (current()) this.#publishRuntimeEvent(runtimeId, event); },
        ...(this.#options.log ? { log: this.#options.log } : {}),
      });
      if (!current() || this.#providerFactsClosing) { await backend.stop(); return; }
      this.#openClaw = backend;
      this.#backends.push(backend);
      backend.start();
      const launcher = this.#options.openClawLauncher;
      if (launcher && localOpenClawPort(config.url) !== undefined) {
        const launch: { startup: LocalAgentStart; installed: boolean } = { startup: new LocalAgentStart(), installed: false };
        this.#openClawStart = launch;
        void launcher.available(config.url).then(installed => {
          if (!current() || this.#openClawStart !== launch || this.#providerFactsClosing) return;
          launch.installed = installed;
          this.#broadcastDeviceReady();
        }).catch(() => undefined);
      }
    } catch {
      this.#options.log?.("OpenClaw Gateway setup failed; check Orbis state file permissions and the configured loopback endpoint");
    }
  }

  async #startDshBackend(kind: DshKind): Promise<void> {
    const runtime = this.#dsh[kind].runtime;
    if (runtime === undefined || this.#providerFactsClosing || this.#serviceClosed) return;
    try { await runtime.start(); }
    catch (error) {
      this.#options.log?.(`${kind === "dsh" ? "DeepSeek Web" : "DeepSeek Desktop"} 会话发现暂时失败，将自动重试：${describeError(error)}`);
      return;
    }
    if (this.#providerFactsClosing || this.#serviceClosed) return;
    this.#invalidateCatalog();
    this.#broadcastDeviceReady();
  }

  async stop(): Promise<void> {
    // Close publication gates before the first await: pending provider reads can
    // settle while file-change captures and comparisons are being drained.
    this.#providerFactsClosing = true;
    const stoppedOpenCode = !this.#managedPolicy ? this.#stopOpenCode() : undefined;
    clearTimeout(this.#catalogRefreshTimer); this.#catalogRefreshTimer = undefined;
    this.#providerFactsGeneration++;
    this.#modelLifecycle = "stopping";
    this.#unsubscribeEnablement?.();
    this.#unsubscribeEnablement = undefined;
    if (this.#managedPolicy) await this.#managedAgents.reconcile(this.#managedPolicy, false);
    else await this.#stopManagedOpenClaw();
    await stoppedOpenCode;
    if (!this.#managedPolicy) await Promise.all(Object.values(this.#kimi).map(runtime => runtime?.stop()));
    if (!this.#managedPolicy) await this.#hermes?.close().catch(() => undefined);
    await this.#liveActivities.close();
    for (const kind of DSH_KINDS) { clearTimeout(this.#dsh[kind].recoveryTimer); this.#dsh[kind].recoveryTimer = undefined; }
    this.#commandOwners.close();
    for (const timer of this.#bootstrapReplayTimers.values()) clearTimeout(timer);
    this.#bootstrapReplayTimers.clear();
    this.refreshHostFacts();
    clearInterval(this.#toolDiagnosticTimer); this.#toolDiagnosticTimer = undefined; this.#flushToolDiagnostics();
    // HOST-PREP-05: a DeepSeek start still in flight (a Web service lock may take a minute) does not hold
    // the pause. Its pending attach sees #providerFactsClosing and stops the runtime it receives.
    this.#toolContentService.close();
    await this.#fileChangeTurns.close();
    await this.#fileChanges.close();
    this.#changeSubscribers.clear();
    this.#toolIngestion.clear(); this.#toolInventory.dispose();
    this.#piToolContents.close();
    this.#notifications.close();
    if (!this.#managedPolicy) this.#stopClaudeBridge();
    await this.#desktopLedgerWrite;
    this.#sessionSync.close();
    this.#agentStateSubscriptions.close();
    this.#compactStateSubscriptions.close(); this.#compactState.close();
    this.#pairing.close();
    await this.#lan?.stop();
    this.#lan = undefined;
    for (const link of this.#links.values()) link.close();
    this.#links.clear();
    this.#historyInterests.clear();
    this.#catalogQueryDevices.clear();
    await this.#loopback?.stop();
    this.#loopback = undefined;
    await this.#relay?.stop();
    this.#relay = undefined;
    await this.#persistChain;
    // 上传索引与 `.part` 句柄同样是脱离调用栈的写。进程退出前不等它们，下次启动就少一截
    // 可续传的状态——用户要重传的不是几个分片，是整个文件。
    await this.#uploads.flush();
    await this.#toolContentStore?.dispose(); this.#toolContentStore = undefined;
    await Promise.allSettled([...this.#providerFactsPending]);
    this.#modelLifecycle = "stopped";
    this.refreshHostFacts();
    this.#serviceClosed = true;
  }

  /**
   * LAN 起不来（端口被占、没有可用网卡）不是致命错误：Relay 一条路也能跑完整套功能，
   * 只是慢。所以这里降级并说清楚原因，而不是让整个 Host 启动失败。
   */
  async #startLan(): Promise<void> {
    const lan = new HostLanServer({
      port: this.#lanPort,
      resolveDevice: (deviceId) => findActiveDeviceRecord(this.#store, deviceId),
      onEnvelope: (deviceId, envelope, sink, protocolVersion) => {
        try {
          const link = this.#requireLink(deviceId);
          link.attach("lan", sink);
          link.handle("lan", envelope, protocolVersion);
        } catch (error) {
          this.#options.onDeviceError?.(deviceId, error);
          this.#options.log?.(`LAN 上处理 ${deviceId} 的帧失败：${describeError(error)}`);
        }
      },
      onDeviceOffline: (deviceId) => {
        this.#links.get(deviceId)?.detach("lan");
      },
      ...(this.#options.log === undefined ? {} : { log: this.#options.log }),
    });
    try {
      await lan.start();
    } catch (error) {
      // 端口被占：这台机器上几乎可以肯定已经有一个 Host 在跑。此时静默降级去连中继
      // 是最坏的选择——两个 Host 抢同一个 runtime 身份，中继会把对方踢掉，手机那边
      // 看到的是状态时断时续、聊天不更新，而日志里只剩一串 relay reconnecting。
      if (isAddressInUse(error)) {
        throw new Error(
          `LAN 端口 ${this.#lanPort} 已被占用（通常表示已经有一个 Host 在运行）：` +
          "先停掉那个进程再启动本进程，否则两个 Host 会抢同一个中继身份。",
        );
      }
      this.#options.log?.(`LAN 端点未启动（${describeError(error)}），本次只走中继`);
      return;
    }
    this.#lan = lan;
    const endpoints = lan.endpoints.map((entry) => `${entry.host}:${entry.port}`).join(", ");
    this.#options.log?.(endpoints.length > 0 ? `LAN 端点已监听：${endpoints}` : "LAN 端点已监听（未找到非回环网卡）");
  }

  /**
   * 打开配对窗口：先向 Relay 换一个配对码，再和密码学材料拼成同一个二维码。
   *
   * LAN 地址一并写进二维码——那是**唯一**能把「电脑在局域网里的地址」带到手机上的通道。
   */
  async openPairingWindow(input?: {
    lan?: readonly PairingQrLanEndpoint[];
    /** 本地窗口时长（秒）。Relay 配对码自身 300s 过期，默认应不超过它。 */
    ttlSeconds?: number;
  }): Promise<OpenedPairingWindow> {
    const adminToken = this.#options.adminToken ?? this.#options.credential;
    const { code } = await requestPairingCode({ httpBase: relayHttpBase(this.#options.relayUrl), adminToken });
    const lan = input?.lan ?? this.lanEndpoints;
    return this.#pairing.open({
      relayUrl: this.#options.relayUrl,
      code,
      ...(input?.ttlSeconds === undefined ? {} : { ttlSeconds: input.ttlSeconds }),
      ...(lan.length === 0 ? {} : { lan }),
    });
  }

  /** 把一条业务载荷加密后发给某台设备（走它当前生效的路径）。 */
  sendData(deviceId: string, payload: Uint8Array, channel: EnvelopeChannel): void {
    this.#requireLink(deviceId).send(payload, channel);
  }

  revokeDevice(deviceId: string): boolean {
    const changed = revokeDeviceRecord(this.#store, deviceId);
    if (!changed) return false;
    this.#toolContentService.releaseDevice(deviceId); this.#toolInventory.closeOwner(deviceId);
    this.#fileChanges.releaseDevice(deviceId); this.#changeSubscribers.delete(deviceId);
    this.#downloads.releaseDevice(deviceId);
    this.#uploads.releaseDevice(deviceId, "artifact_transport_disconnected");
    this.#uploads.forgetImportAttachments(deviceId);
    this.#sessionSync.clearDevice(deviceId);
    this.#notifications.releaseDevice(deviceId);
    this.#deviceViewFacts.forget(deviceId);
    this.#messageFileReferences.releaseDevice(deviceId);
    this.#links.get(deviceId)?.close();
    this.#links.delete(deviceId);
    this.#deviceFeatures.delete(deviceId); this.#deviceViewEpochs.delete(deviceId);
    this.#historyInterests.delete(deviceId);
    this.#catalogQueryDevices.delete(deviceId);
    this.#fieldTraffic.release(deviceId);
    this.#agentStateSubscriptions.clearDevice(deviceId);
    this.#compactStateSubscriptions.clearDevice(deviceId);
    this.#persist();
    this.refreshHostFacts();
    return true;
  }

  renameDevice(deviceId: string, label: string): boolean {
    const device = this.#store.devices.find(entry => entry.deviceId === deviceId && !entry.revoked);
    if (!device) return false;
    device.label = label;
    this.#persist();
    return true;
  }

  get #lanPort(): number {
    return this.#options.lanPort ?? DEFAULT_LAN_PORT;
  }

  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * 一条入站帧。`path` 是它**从哪条路来**的：握手应答必须原路返回，
   * 而对端的 `hdr.from` 只是索引，不是身份（身份由 §5.3 的 MAC 证明）。
   */
  #handleFrame(envelope: EnvelopeV2, path: PathKind): void {
    const deviceId = envelope.hdr.from;
    try {
      if (envelope.hdr.k === "pair") {
        // 配对只能走中继：LAN 端点只接受**已配对**设备，扫码时它还不是。
        const { accept, device } = this.#pairing.acceptFrame(envelope);
        upsertDeviceRecord(this.#store, device);
        this.#persist();
        this.#relay?.send(accept);
        this.#options.log?.(`已配对设备 ${device.deviceId}`);
        this.#options.onPaired?.(device);
        return;
      }
      // `handle` 只在这条路径**没有出口**时返回 false（出口在 relay 重连后必须重挂，
      // 见 #attachRelaySink）。这种事默认是无声的，而它恰好是「手机在等 HS2、Host 这边
      // 一点痕迹都没有」的成因，所以必须留一行日志。
      const link = this.#requireLink(deviceId);
      if (!link.handle(path, envelope)) {
        this.#options.log?.(`${path} 路径没有出口，丢弃来自 ${deviceId} 的 ${envelope.hdr.k} 帧`);
      }
    } catch (error) {
      // 一条坏帧只影响它自己那台设备：其他设备的通道必须继续可用。
      this.#options.onDeviceError?.(deviceId, error);
      this.#options.log?.(
        `处理来自 ${deviceId} 的帧失败：${isE2eError(error) ? `${error.code} ` : ""}${describeError(error)}`,
      );
      if (envelope.hdr.k === "hs") this.#links.get(deviceId)?.detach(path);
    }
  }

  /**
   * 设备发来的明文载荷。
   *
   * 它装的是两样东西：v1 里设备本来发给 Relay 的那套消息（`runtime.command`），和
   * M3 的进程激活请求（`session.list` / `session.browse` / `session.activate`，spec §8）。
   * 认不出来的载荷交给上层（`onData`），不静默吞掉，方便接后端功能时排查。
   */
  #handleDevicePayload(deviceId: string, payload: Buffer, frame: "data" | "bin" = "data", path: PathKind = "relay"): void {
    if (frame === "bin") {
      this.#uploads.handleData(deviceId, payload);
      return;
    }
    const wire = normalizeDeviceRequest(payload);
    if (wire === undefined) {
      let raw: unknown;
      try { raw = JSON.parse(payload.toString("utf8")); } catch { /* Opaque extension payload. */ }
      if (raw && typeof raw === "object" && !Array.isArray(raw) && "protocolVersion" in raw) {
        const ids = raw as { commandId?: unknown; requestId?: unknown };
        this.#sendToDeviceOn(deviceId, path, { type: "protocol.error", code: "protocol_version_mismatch", message: "仅支持已实现的协议 18 / 19",
          ...(typeof ids.commandId === "string" && ids.commandId.length > 0 && ids.commandId.length <= 256 ? { commandId: ids.commandId } : {}),
          ...(typeof ids.requestId === "string" && ids.requestId.length > 0 && ids.requestId.length <= 128 ? { requestId: ids.requestId } : {}),
        });
        return;
      }
    }
    const message = parseDevicePayload(wire?.payload ?? payload);
    if (message !== undefined && wire !== undefined) {
      const link = this.#links.get(deviceId);
      if (!link?.bindProtocolVersion(path, wire.version)) {
        this.#sendToDeviceOn(deviceId, path, { type: "protocol.error", code: "protocol_version_mismatch", message: "会话业务协议不能中途更换",
          ...("commandId" in message && typeof message.commandId === "string" ? { commandId: message.commandId } : {}),
          ...("requestId" in message && typeof message.requestId === "string" ? { requestId: message.requestId } : {}),
        });
        return;
      }
    }
    if (message === undefined) {
      // Authenticated malformed/future requests still need a correlated endpoint for their local wait.
      try {
        const raw: unknown = JSON.parse(payload.toString("utf8"));
        if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
          const value = raw as Record<string, unknown>;
          const commandId = typeof value.commandId === "string" && value.commandId.length > 0 && value.commandId.length <= 256 ? value.commandId : undefined;
          const requestId = typeof value.requestId === "string" && value.requestId.length > 0 && value.requestId.length <= 128 ? value.requestId : undefined;
          if (value.type === "runtime.command" && commandId) {
            this.#sendToDeviceOn(deviceId, path, { type: "protocol.error", code: "invalid_command", commandId, message: "输入格式无效或当前版本不支持" }); return;
          }
          if (typeof value.type === "string" && requestId) {
            this.#sendToDeviceOn(deviceId, path, { type: "protocol.error", code: "invalid_request", requestId, message: "请求格式无效或当前版本不支持" }); return;
          }
        }
      } catch { /* Unstructured extension data keeps its existing explicit owner. */ }
      this.#options.onData?.(deviceId, payload);
      return;
    }
    if (message.type === "device.features") {
      const before = this.#agentView(deviceId);
      const previous = this.#deviceFeatures.get(deviceId);
      const hadRender = previous?.has(DEVICE_FEATURE_MESSAGE_RENDER) ?? false;
      const closeChanged = [RUNTIME_CLOSE_FEATURE, RUNTIME_VIEW_CLOSE_FEATURE].some(feature =>
        !!previous?.has(feature) !== message.features.includes(feature));
      const codexViewChanged = this.#unifiedCodex(deviceId) !== message.features.includes(CODEX_UNIFIED_HISTORY);
      const managementChanged = !!this.#managedPolicy && (!!previous?.has(AGENT_ENABLEMENT_FEATURE) !== message.features.includes(AGENT_ENABLEMENT_FEATURE) ||
        !!previous?.has(AGENT_ENABLEMENT_REVIEW_FEATURE) !== message.features.includes(AGENT_ENABLEMENT_REVIEW_FEATURE) ||
        !!previous?.has(DEVICE_FEATURE_OPENCLAW) !== message.features.includes(DEVICE_FEATURE_OPENCLAW));
      this.#deviceFeatures.set(deviceId, new Set(message.features.filter(feature =>
        (feature !== DEVICE_FEATURE_KIMI_CODE || this.#kimi[KIMI_KIND] !== undefined || this.#options.createKimiCodeRuntime !== undefined) &&
        (feature !== DEVICE_FEATURE_KIMI_CODE_DESKTOP || this.#kimi[KIMI_DESKTOP_KIND] !== undefined || this.#options.createKimiCodeRuntime !== undefined && this.#options.kimiCodeDesktopSupported === true))));
      const hadClaudeSendNow = previous?.has(DEVICE_FEATURE_CLAUDE_SEND_NOW) ?? false;
      if (message.features.includes(DEVICE_FEATURE_COMPACT_BOOTSTRAP)) this.#cancelBootstrapReplay(deviceId);
      const after = this.#agentView(deviceId);
      if (before === after && !managementChanged && !codexViewChanged && !closeChanged && hadRender === message.features.includes(DEVICE_FEATURE_MESSAGE_RENDER) && hadClaudeSendNow === message.features.includes(DEVICE_FEATURE_CLAUDE_SEND_NOW)) return;
      if (codexViewChanged) this.#invalidateCatalog();
      this.#resetAgentView(deviceId);
      this.#sendToDevice(deviceId, { type: "device.ready", ...this.#deviceReadyPayload(deviceId) });
      for (const runtime of this.#runtimesSnapshot()) {
        if (!allowsAgentIdentity(before, runtime) && allowsAgentIdentity(after, runtime)) {
          this.#sendToDevice(deviceId, this.#notifications.snapshot(runtime.runtimeId, deviceId));
        }
      }
      if (allowsAgent(after, DSH_DESKTOP_KIND)) this.#dsh.dshDesktop.runtime?.announce();
      for (const kind of KIMI_KINDS) if (allowsAgent(after, kind)) this.#kimi[kind]?.announce();
      return;
    }
    if (message.type === "agent.enablement.read" || message.type === "agent.enablement.write") {
      void this.#handleAgentEnablement(deviceId, message);
      return;
    }
    if (!((message.type === "provider.list" || message.type === "provider.switch" || message.type === "provider.subscription")
      ? this.#providerCurrent(message.kind)() : this.#allowsDeviceRequest(deviceId, message))) { this.#rejectAgentFeature(deviceId, message as { requestId?: unknown; commandId?: unknown }); return; }
    if (message.type === "device.version.report") {
      const device = findActiveDeviceRecord(this.#store, deviceId);
      if (device !== undefined && (device.appVersion !== message.version || device.appVersionCode !== message.versionCode)) {
        device.appVersion = message.version;
        device.appVersionCode = message.versionCode;
        this.#persist();
      }
      return;
    }
    if (message.type === "session.configuration.read" || message.type === "session.configuration.save"
      || message.type === "session.launch" || message.type === "session.launch.read") {
      if (message.type === "session.launch" || message.type === "session.launch.read") {
        // LAUNCH-QUEUE-01: a read or duplicate waits for the same launch identity
        // (it must not report absence or recover while the create runs), never for other launches.
        const epoch = this.#deviceViewEpochs.get(deviceId);
        void this.#sessionLanes.run([launchLane(deviceId, message.launchId)], async () => {
          if (!this.#providerFactsClosing && epoch === this.#deviceViewEpochs.get(deviceId)) await this.#handleSessionConfiguration(deviceId, message);
        }).catch(error => this.#options.onDeviceError?.(deviceId, error));
      } else void this.#handleSessionConfiguration(deviceId, message);
      return;
    }
    if (message.type === "session.catalog.capabilities.request") {
      this.#catalogQueryDevices.add(deviceId);
      this.#sendToDevice(deviceId, { type: "session.catalog.capabilities", protocolVersion: PROTOCOL_VERSION,
        requestId: message.requestId, format: "v1" }); return;
    }
    if (message.type === "session.catalog.query") {
      if (!this.#catalogQueryDevices.has(deviceId)) return;
      const link = this.#links.get(deviceId), epoch = this.#deviceViewEpochs.get(deviceId);
      void (message.cursor ? Promise.resolve() : (async () => {
        if (message.query.agentKind === "hermes") await this.#hermes?.attachExisting().catch(() => undefined);
        await this.#catalogWithCache();
      })()).then(() => {
        if (this.#serviceClosed || this.#links.get(deviceId) !== link || !link?.active || epoch !== this.#deviceViewEpochs.get(deviceId)) return;
        const response = { ...this.#hostStateFacts.catalogQuery(message, hiddenKinds(this.#agentView(deviceId)), this.#unifiedCodex(deviceId)), protocolVersion: PROTOCOL_VERSION };
        if (encodeDeviceMessage(response).byteLength > 64 * 1024) {
          this.#sendToDevice(deviceId, { type: "protocol.error",
            requestId: message.requestId, code: "catalog_page_too_large", message: "目录页超出传输上限" }); return;
        }
        this.#sendToDevice(deviceId, response);
      }).catch(error => {
        if (error instanceof ActivationError) this.#sendToDevice(deviceId, { type: "protocol.error", requestId: message.requestId, code: error.code, message: error.message });
        else this.#options.onDeviceError?.(deviceId, error);
      });
      return;
    }
    if (message.type === "session.history.capabilities.request") {
      if (!this.#historyInterests.has(deviceId)) this.#historyInterests.set(deviceId, undefined);
      this.#sendToDevice(deviceId, { type: "session.history.capabilities", protocolVersion: PROTOCOL_VERSION,
        requestId: message.requestId, format: "v1", maxPageBytes: 65536 });
      return;
    }
    if (message.type === "session.history.interest") {
      const scope = message.runtimeId === null ? undefined : this.#agentFacts.scopeOf(message.runtimeId);
      const accepted = this.#historyInterests.has(deviceId) && (message.runtimeId === null ||
        scope?.kind === "agent" && scope.key.sessionId === message.sessionId);
      if (accepted) this.#historyInterests.set(deviceId, message.runtimeId === null ? null :
        { runtimeId: message.runtimeId, sessionId: message.sessionId! });
      else if (this.#historyInterests.has(deviceId)) this.#historyInterests.set(deviceId, undefined);
      this.#sendToDevice(deviceId, { type: "session.history.interest.result", protocolVersion: PROTOCOL_VERSION,
        requestId: message.requestId, accepted });
      return;
    }
    if (message.type === "transport.fields.read") {
      this.#sendToDevice(deviceId, this.#fieldTraffic.page(deviceId, message, kind => allowsAgent(this.#agentView(deviceId), kind))); return;
    }
    if (message.type === "agent.menu.options.read") {
      const scope = this.#agentFacts.scopeOf(message.runtimeId);
      if (scope) this.#compactState.ensure(scope);
      this.#sendToDevice(deviceId, this.#compactState.menuOptions.read(scope && this.#agentStateRegistry.read(scope, "capabilities")?.availability === "ready" ? JSON.stringify(scope) : undefined, message));
      return;
    }
    if (message.type === "voice.cleanup.provider.request") {
      const manager = this.#options.providers;
      const reply = (result: object): void => this.#sendJsonToDevice(deviceId, {
        type: "voice.cleanup.provider.result", protocolVersion: PROTOCOL_VERSION, requestId: message.requestId, ...result,
      }, "ctl");
      if (!manager) reply({ error: "unavailable" });
      else void runVoiceCleanup(manager, message).then(reply, () => reply({ error: "unavailable" }));
      return;
    }
    if (message.type === "provider.list" || message.type === "provider.switch" || message.type === "provider.subscription") {
      void this.#handleProviderRequest(deviceId, message);
      return;
    }
    if (message.type === "runtime.git.request") {
      void this.#handleGitBranchRequest(deviceId, message).catch((error: unknown) => {
        this.#options.onDeviceError?.(deviceId, error);
      });
      return;
    }
    if (message.type === "host.lan.request") {
      // Refresh addresses for already-paired phones and DHCP changes, only after E2E authentication.
      // Pairing-only processes do not advertise a listener they haven't started.
      const response = { type: "host.lan", protocolVersion: PROTOCOL_VERSION, endpoints: this.#lan?.endpoints ?? [] };
      this.#sendJsonToDevice(deviceId, response, "ctl");
      return;
    }
    // ── 接收方驱动的范围下载（ADR-0005）：设备发 read 索取一段，Host 按范围应答。
    if (message.type === "artifact.read") {
      void this.#downloads.handleRead(deviceId, message);
      return;
    }
    if (message.type === "artifact.done") {
      this.#downloads.handleDone(deviceId, message.transferId);
      return;
    }
    // ── 上传（spec: 手机上传文件到电脑）：接收方驱动（ADR-0012），落地、校验、拉取都在这里。
    if (message.type === "file.upload.init") {
      if (isKimiId(message.runtimeId)) { this.#sendToDevice(deviceId, { type: "protocol.error", requestId: message.requestId,
        code: "unsupported_command", message: "Kimi Code 不提供文件上传" }); return; }
      if (message.runtimeId.startsWith(OPENCLAW_PREFIX)) {
        this.#sendToDeviceOn(deviceId, path, { type: "file.upload.failed", protocolVersion: PROTOCOL_VERSION,
          requestId: message.requestId, code: "unsupported_command", message: "OpenClaw 会话不支持附件" });
        return;
      }
      const target = message.importTarget;
      if (target === undefined) {
        void this.#uploads.handleInit(deviceId, message);
      } else {
        const isCurrent = this.#externalImportFence(deviceId, message.runtimeId, target);
        const directory = join(target.cwd, ".orbis-uploads", message.sha256);
        if (!isAbsolute(target.cwd) || !isAbsolute(message.directory) || normalize(message.directory) !== directory || !isCurrent()) {
          this.#sendToDevice(deviceId, { type: "file.upload.failed", protocolVersion: PROTOCOL_VERSION,
            requestId: message.requestId, code: "import_target_changed", message: "所选会话已不可用" });
          return;
        }
        void this.#uploads.handleInit(deviceId, { ...message, directory }, isCurrent);
      }
      return;
    }
    if (message.type === "external-import.result.read") {
      if (!findActiveDeviceRecord(this.#store, deviceId)) return;
      const { runtimeId, commandId, importTarget } = message;
      const receipt = this.#commandOwners.importReceipt(deviceId, runtimeId, commandId, importTarget);
      const status = receipt === undefined ? "unknown" : receipt.type === "runtime.error" ? "unconfirmed"
        : receipt.status === "pending" ? "pending" : receipt.status === "unconfirmed" || receipt.status === "message_id_conflict" ? "unconfirmed"
        : receipt.ok && (receipt.status === undefined || receipt.status === "success") ? "accepted" : "failed";
      this.#sendToDeviceOn(deviceId, path, { type: "external-import.result", protocolVersion: PROTOCOL_VERSION,
        runtimeId, commandId, importTarget, status });
      return;
    }
    if (message.type === "file.upload.cancel") {
      void this.#uploads.handleCancel(deviceId, message.uploadId);
      return;
    }
    if (message.type === "session.activate" || message.type === "session.archive") {
      // LAUNCH-QUEUE-01: a resume and an archive of the same session stay ordered with its file moves,
      // including the gap before a spawned Pi registers. A new session shares no resource with other work.
      const epoch = this.#deviceViewEpochs.get(deviceId), link = this.#links.get(deviceId);
      const hermes = message.type === "session.activate" && message.target.agentKind === "hermes";
      const sessionId = message.type === "session.archive" ? message.sessionId
        : message.target.type === "resume" ? message.target.sessionId : undefined;
      void this.#sessionLanes.run(sessionId === undefined ? [] : [sessionLane(sessionId)], async () => {
        if (epoch !== this.#deviceViewEpochs.get(deviceId) || !this.#allowsDeviceRequest(deviceId, message)) return;
        if (hermes ? this.#providerFactsClosing || link !== this.#links.get(deviceId) || !link?.active
          : this.#links.get(deviceId)?.active === undefined) return;
        if (message.type === "session.archive") { await this.#handleSessionRequest(deviceId, message); return; }
        const target = message.target;
        const kind = target.type === "new" ? target.agentKind : resumeAgentKind(target);
        const release = await this.#providerGate.enter(kind === undefined ? undefined : providerGroup(kind));
        try { await this.#handleSessionRequest(deviceId, message); } finally { release(); }
      }).catch(error => this.#options.onDeviceError?.(deviceId, error));
      return;
    }
    if (message.type === "session.list" || message.type === "session.browse") {
      // 会话目录在磁盘上，天然是异步的；不阻塞帧处理循环，失败自己回报设备。
      void this.#handleSessionRequest(deviceId, message);
      return;
    }
    if (message.type === "agent.state.request") {
      // 默认读已提交的投影（同步、不占后端）；点了 providers 域才会先现读一次，因此整体是异步的，
      // 与 session.list 一样不阻塞帧处理循环。
      void this.#handleAgentStateRequest(deviceId, message);
      return;
    }
    if (message.type === "agent.state.range.request") {
      const authenticatedLink = this.#links.get(deviceId);
      const epoch = this.#deviceViewEpochs.get(deviceId);
      void this.readHostRange(message, hiddenKinds(this.#agentView(deviceId)), this.#unifiedCodex(deviceId)).then(page => {
        if (this.#serviceClosed || authenticatedLink !== this.#links.get(deviceId) || !authenticatedLink?.active || epoch !== this.#deviceViewEpochs.get(deviceId)) return;
        this.#sendToDevice(deviceId, { type: "agent.state.range.page", protocolVersion: PROTOCOL_VERSION,
          requestId: message.requestId, scope: "host", domain: "catalog", page });
      }).catch(error => { this.#options.onDeviceError?.(deviceId, error); });
      return;
    }
    if (message.type === "diagnostics.request") {
      // 记录在内存 + 盘上，不查后端：同步读一页就回。
      const page = this.readDiagnostics({
        ...(message.cursor === undefined ? {} : { cursor: message.cursor }),
        ...(message.limit === undefined ? {} : { limit: message.limit }),
        ...(message.category === undefined ? {} : { category: message.category }),
        ...(message.severity === undefined ? {} : { severity: message.severity }),
        ...(message.sessionId === undefined ? {} : { sessionId: message.sessionId }),
        ...(message.agentKind === undefined ? {} : { agentKind: message.agentKind }),
      }, this.#agentView(deviceId));
      this.#sendToDevice(deviceId, buildDiagnosticsPageMessage(message, page));
      return;
    }
    if (message.type === "notification.sync" || message.type === "notification.dismiss") {
      if (!this.#notifications.has(message.runtimeId) && !this.#runtimesSnapshot().some(item => item.runtimeId === message.runtimeId)) return;
      if (message.type === "notification.dismiss" && message.hostEpoch === this.#notifications.hostEpoch) {
        this.#notifications.dismiss(message.runtimeId, deviceId, message.notificationId);
      }
      // Notification recovery does not depend on agent command availability.
      this.#sendNotificationSnapshot(deviceId, message.runtimeId);
      const at = Date.now();
      if (at - (this.#notificationChecks.get(message.runtimeId) ?? 0) >= 10_000) {
        if (this.#notificationChecks.size >= 2048) this.#notificationChecks.delete(this.#notificationChecks.keys().next().value!);
        this.#notificationChecks.set(message.runtimeId, at);
        this.#loopback?.sendResync(message.runtimeId, "notification_sync");
        for (const backend of this.#backends) if (backend.isReady() && backend.ownsRuntime(message.runtimeId)) backend.syncNotifications?.(message.runtimeId);
      }
      return;
    }
    if (message.type !== "runtime.command") {
      this.#options.onData?.(deviceId, payload);
      return;
    }
    const command = message.command;
    if (isKimiId(message.runtimeId) && (command.type === "file.download" || command.type.startsWith("artifact.") || command.type.startsWith("session.change"))) {
      this.#sendToDevice(deviceId, { type: "protocol.error", commandId: message.commandId, code: "unsupported_command", message: "Kimi Code 不提供文件操作" }); return;
    }
    if (message.importTarget && (command.type !== "user_message" || command.messageId === undefined || command.delivery === "steer"
      || message.commandId.length > 256)) {
      this.#sendToDevice(deviceId, { type: "protocol.error", code: "invalid_command", commandId: message.commandId,
        message: "导入内容只支持发送普通消息或排队" });
      return;
    }
    if (this.#providerChanging && ["user_message", "slash.execute", "permissions.update", "session.close"].includes(command.type) && this.#backends.some(backend => backend.kind === this.#providerChanging && backend.ownsRuntime(message.runtimeId))) {
      this.#sendToDevice(deviceId, { type: "protocol.error", code: "provider_switching", commandId: message.commandId, message: "正在切换供应商，请稍后重新打开会话" });
      return;
    }
    // 下载只归 Host 管理。暂停后删除、超时或重连后的重复取消是幂等操作；
    // 即使传输已经释放，也不能把 hostId 当成 runtimeId 再转交给 agent。
    if (command.type === "artifact.cancel") {
      this.#downloads.handleTransferControl(deviceId, message.runtimeId, command);
      return;
    }
    if (command.type === "file.download" || command.type === "artifact.download") {
      if ((command.maxBytes !== undefined || command.previewFormat !== undefined || command.web !== undefined) && message.runtimeId !== this.hostId) {
        this.#sendToDeviceOn(deviceId, path, { type: "protocol.error", code: "invalid_command", commandId: message.commandId,
          message: "预览必须请求文件所在的电脑" });
        return;
      }
      if (message.runtimeId.startsWith(OPENCLAW_PREFIX)) {
        this.#sendToDeviceOn(deviceId, path, { type: "protocol.error", code: "unsupported_command",
          commandId: message.commandId, message: "OpenClaw 会话不支持文件传输" });
        return;
      }
      // 下载完全由 Host 服务（spec §9.4 的 Host→APP 模型）：文件就在这台机器的磁盘上，
      // Host 常驻，读盘发分片不需要任何 Pi 进程参与。**不再回落到 runtime**——手机发的
      // 就是对 Host 的请求，Host 服务不了就如实回报失败，而不是把它转给某个进程再报
      // runtime_offline（那会把「Host 读不到这个文件」误说成「进程不在线」）。
      void this.#downloads.offerDownload(deviceId, message.runtimeId, message.commandId, command);
      return;
    }
    this.#routeRuntimeCommand(deviceId, message);
  }

  /** Read only the directory registered by the target runtime; the phone cannot supply a path. */
  async #handleGitBranchRequest(deviceId: string, request: GitBranchRequest): Promise<void> {
    const runtime = this.#runtimesSnapshot().find((entry) => entry.runtimeId === request.runtimeId);
    if (runtime === undefined) return;
    // A Gateway-reported cwd is for display and grouping, not Host-side filesystem authority.
    if (runtime.runtimeId.startsWith(OPENCLAW_PREFIX)) {
      this.#sendJsonToDevice(deviceId, { type: "runtime.git", protocolVersion: PROTOCOL_VERSION, requestId: request.requestId,
        runtimeId: runtime.runtimeId, sessionId: runtime.sessionId ?? null, cwd: runtime.cwd,
        branch: null, commit: null }, "ctl");
      return;
    }
    let pending = this.#gitReads.get(runtime.cwd);
    if (pending === undefined) {
      pending = readGitBranch(runtime.cwd);
      this.#gitReads.set(runtime.cwd, pending);
    }
    let identity: Awaited<ReturnType<typeof readGitBranch>>;
    try {
      identity = await pending;
    } finally {
      if (this.#gitReads.get(runtime.cwd) === pending) this.#gitReads.delete(runtime.cwd);
    }
    const current = this.#runtimesSnapshot().find((entry) => entry.runtimeId === request.runtimeId);
    if (current?.cwd !== runtime.cwd || current.sessionId !== runtime.sessionId) return;
    this.#workspaceGit.set(runtime.cwd, { availability: identity.branch !== null || identity.commit !== null ? "ready" : "unknown",
      branch: identity.branch, head: identity.commit, repoRoot: null });
    this.refreshHostFacts();
    this.#sendJsonToDevice(deviceId, {
      type: "runtime.git",
      protocolVersion: PROTOCOL_VERSION,
      requestId: request.requestId,
      runtimeId: runtime.runtimeId,
      sessionId: runtime.sessionId ?? null,
      cwd: runtime.cwd,
      ...identity,
    }, "ctl");
  }

  /**
   * 把一条 `runtime.command` 投给它指名道姓的后端（spec §7.4 的统一分派）。
   *
   * 归属一次命中：`ownsRuntime` 认领了但命令不认识 → `unsupported_command`；
   * 没有任何后端认领（或认领后进程已掉线）→ `runtime_offline`——手机据此区分
   * 「该重拉进程」和「这个后端做不到」（§8）。
   */
  #routeRuntimeCommand(
    deviceId: string,
    message: Extract<DeviceE2ePayload, { type: "runtime.command" }>,
  ): void {
    const importTarget = message.importTarget;
    const importFence = importTarget === undefined ? undefined : this.#externalImportFence(deviceId, message.runtimeId, importTarget,
      message.command.type === "user_message" && message.command.delivery === "followUp");
    if (message.command.type === "slash.execute" && message.command.optionCatalogId !== undefined) {
      const scope = this.#agentFacts.scopeOf(message.runtimeId);
      if (!scope || this.#agentStateRegistry.read(scope, "capabilities")?.availability !== "ready"
        || !this.#compactState.menuOptions.valid(JSON.stringify(scope), message.command.name, message.command.optionCatalogId, message.command.args)) {
        this.#sendToDevice(deviceId, this.#runtimeEventMessage(message.runtimeId, { type: "command.result", commandId: message.commandId,
          ok: false, status: "failure", error: "stale_menu_options" }));
        return;
      }
      const command = { ...message.command }; delete command.optionCatalogId;
      message = { ...message, command };
    }
    const { runtimeId, commandId, command } = message;
    if (command.type === "user_message") {
      const rejectTarget = () => this.#sendToDevice(deviceId, { type: "protocol.error", code: "import_target_changed", commandId,
        message: "所选会话已不可用" });
      if (importFence && !importFence()) { rejectTarget(); return; }
      const sessionId = importTarget?.sessionId ?? this.#runtimesSnapshot().find(item => item.runtimeId === runtimeId)?.sessionId;
      if (sessionId !== undefined) {
        // A configured launch may publish runtime.online before native settings are confirmed.
        const epoch = this.#deviceViewEpochs.get(deviceId);
      const kimiKind = kimiKindFromId(sessionId);
      void (kimiKind ? this.#kimiConfigurations[kimiKind] : sessionId.startsWith(OPENCLAW_PREFIX) ? this.#openClawLaunches
          : runtimeId.startsWith(OPENCODE_RUNTIME_PREFIX) ? this.#openCodeConfigurations : this.#sessionConfigurations).blocks(sessionId).then(async blocked => {
          const attachmentsVerified = !importTarget || blocked || await this.#uploads.ownsImportAttachments(deviceId, importTarget, command.attachments ?? []);
          if (epoch !== this.#deviceViewEpochs.get(deviceId) || !allowsRuntime(this.#agentView(deviceId), runtimeId)) return;
          if (importFence && !importFence()) rejectTarget();
          else if (blocked) this.#sendToDevice(deviceId, this.#runtimeEventMessage(runtimeId, { type: "command.result", commandId,
            ok: false, status: "failure", error: "会话启动配置尚未确认，消息未发送" }));
          else if (!attachmentsVerified) this.#sendToDevice(deviceId, { type: "protocol.error", code: "import_attachments_unverified", commandId,
            message: "请重新上传导入附件" });
          else this.#dispatchRuntimeInput(deviceId, runtimeId, commandId, command, importTarget);
        }).catch(() => this.#sendToDevice(deviceId, this.#runtimeEventMessage(runtimeId,
          { type: "command.result", commandId, ok: false, status: "unconfirmed", error: "启动配置记录无法核对，消息未发送" })));
        return;
      }
    }
    if (command.type === "session.changes.list" || command.type === "session.changes.read"
      || command.type === "session.change.detail.read" || command.type === "session.change.detail.cancel") {
      if (command.type === "session.changes.list") {
        const scope = this.#agentFacts.scopeOf(runtimeId);
        if (scope?.kind === "agent" && command.runtimeId === runtimeId && agentKeyId(command.agent) === agentKeyId(scope.key))
          this.#changeSubscribers.set(deviceId, { runtimeId, agentId: agentKeyId(scope.key) });
      }
      void this.#fileChanges.request(deviceId, runtimeId, command).catch(() => {
        if (command.type !== "session.change.detail.cancel") this.#sendToDevice(deviceId, this.#runtimeEventMessage(runtimeId,
          { type: "session.changes.failed", requestId: command.requestId, runtimeId, reason: "unavailable" }));
      });
      return;
    }
    if (command.type === "session.tools.open" || command.type === "session.tools.read") {
      const scope = this.#agentFacts.scopeOf(runtimeId);
      const agent = command.type === "session.tools.open" ? command.reference.agent : command.snapshot.agent;
      try {
        if (command.runtimeId !== runtimeId || scope?.kind !== "agent" || agentKeyId(agent) !== agentKeyId(scope.key)) throw new Error("scope_mismatch");
        let event: RuntimeEvent;
        if (command.type === "session.tools.open") {
          if (!isDeepStrictEqual(this.#toolInventory.reference(agent), command.reference)) throw new Error("snapshot_expired");
          event = { type: "session.tools.opened", requestId: command.requestId, runtimeId,
            snapshot: this.#toolInventory.openSnapshot(deviceId, agent, runtimeId) };
        } else event = this.#toolInventory.read(deviceId, command);
        const response = this.#runtimeEventMessage(runtimeId, event); assertToolWireBudget(response);
        this.#sendToDevice(deviceId, response);
      } catch (error) {
        const code = error instanceof Error ? error.message : "snapshot_expired";
        this.#sendToDevice(deviceId, this.#runtimeEventMessage(runtimeId, { type: "session.tool.read.failed",
          runtimeId, requestId: command.requestId, reason: code === "busy" ? "busy" : code === "scope_mismatch" ? "scope_mismatch" : "snapshot_expired",
          gaps: [], ...(code === "busy" ? { retryAfterMs: 250 } : {}) }));
      }
      return;
    }
    if (command.type === "session.tool.content.read") {
      void this.#toolContentService.read(deviceId, runtimeId, command); return;
    }
    if (command.type === "session.tool.content.cancel") {
      if (command.runtimeId === runtimeId) this.#toolContentService.cancel(deviceId, runtimeId, command.viewerId, command.readId);
      return;
    }
    if (command.type === "session.sync") {
      this.#sessionSync.request(deviceId, runtimeId, commandId, command);
      this.refreshHostFacts();
      return;
    }
    // ADR-0037 §4：提交回执由协调者自己消费，不进后端。
    if (command.type === "session.snapshot.ack") {
      this.#sessionSync.acknowledge(deviceId, command.syncId, command.result);
      return;
    }
    // ADR-0038 §8：按需取回未截断的条目。只回请求设备；超过单条线路上限按确定性失败拒绝。
    if (command.type === "session.entry.request") {
      void this.#readSessionEntry(deviceId, runtimeId, command);
      return;
    }
    this.#dispatchRuntimeInput(deviceId, runtimeId, commandId, command);
  }

  /** IMPORT-06: the authenticated device and exact session/project must still own this route. */
  #externalImportFence(deviceId: string, runtimeId: string, target: ExternalImportTarget, allowRunning = true): () => boolean {
    const link = this.#links.get(deviceId);
    const pairing = findActiveDeviceRecord(this.#store, deviceId);
    return () => {
      if (this.#serviceClosed || !link?.active || this.#links.get(deviceId) !== link || !pairing
        || findActiveDeviceRecord(this.#store, deviceId) !== pairing) return false;
      const matches = this.#runtimesSnapshot().filter(runtime => runtime.runtimeId === runtimeId || runtime.sessionId === target.sessionId);
      const runtime = matches[0];
      return matches.length === 1 && runtime?.runtimeId === runtimeId && runtime.sessionId === target.sessionId
        && runtime.cwd === target.cwd && (runtime.status === "idle" || allowRunning && runtime.status === "running")
        && this.#backends.filter(backend => backend.isReady() && backend.ownsRuntime(runtimeId)).length === 1
        && !this.#backends.some(backend => backend.kind === this.#providerChanging && backend.ownsRuntime(runtimeId));
    };
  }

  async #readSessionEntry(deviceId: string, runtimeId: string, command: Extract<import("@orbis/protocol").RuntimeCommand, { type: "session.entry.request" }>): Promise<void> {
    const scope = this.#agentFacts.scopeOf(runtimeId), link = this.#links.get(deviceId);
    if (scope?.kind !== "agent" || scope.key.sessionId !== command.sessionId) {
      this.#sendToDevice(deviceId, this.#runtimeEventMessage(runtimeId, { type: "session.entry.result",
        requestId: command.requestId, entryId: command.entryId, error: "session_mismatch" }));
      return;
    }
    const backend = this.#backends.find(candidate => candidate.ownsRuntime(runtimeId));
    const event = await readFullSessionEntry(command.requestId, command.entryId, this.#conversationState.entry(scope, command.entryId),
      backend?.readSessionEntry ? () => backend.readSessionEntry!(runtimeId, command.sessionId, command.entryId) : undefined);
    // Native reads may finish after a reconnect or runtime replacement. Only the requesting owner receives them.
    const current = this.#agentFacts.scopeOf(runtimeId);
    if (this.#serviceClosed || this.#links.get(deviceId) !== link || !link?.active) return;
    this.#sendToDevice(deviceId, this.#runtimeEventMessage(runtimeId,
      current?.kind === "agent" && agentKeyId(current.key) === agentKeyId(scope.key) ? event : {
        type: "session.entry.result", requestId: command.requestId, entryId: command.entryId, error: "session_mismatch",
      }));
  }

  #dispatchRuntimeInput(deviceId: string, runtimeId: string, commandId: string, command: import("@orbis/protocol").RuntimeCommand,
    importTarget?: ExternalImportTarget): void {
    const inputScope = this.#agentFacts.scopeOf(runtimeId);
    const admission = this.#commandOwners.begin(deviceId, runtimeId, commandId, command,
      inputScope?.kind === "agent" ? agentKeyId(inputScope.key) : runtimeId, importTarget);
    if (admission.kind === "reject") {
      this.#sendToDevice(deviceId, { type: "protocol.error", code: admission.error, commandId,
        message: admission.error === "host_busy" ? "Host 命令任务过多，请稍后重试" : admission.error === "message_id_conflict" ? "消息身份已由另一个命令使用，请核对原消息" : "命令身份与已有请求冲突" });
      return;
    }
    if (admission.kind === "replay") {
      this.#sendToDevice(deviceId, this.#runtimeEventMessage(runtimeId, admission.record.receipt));
      return;
    }
    this.#deviceViewFacts.accepted(deviceId, {
      operationId: commandId,
      runtimeId,
      ...(command.type === "interaction.respond" ? { requestId: command.requestId } : {}),
    });
    this.refreshHostFacts();
    try {
      let closeKind: AgentKind | undefined;
      let viewOnly = false;
      if (command.type === "session.close") {
        const reject = (error: string) => this.#publishRuntimeEvent(runtimeId, { type: "command.result", commandId, ok: false, status: "failure", error });
        if (!this.#deviceFeatures.get(deviceId)?.has(RUNTIME_CLOSE_FEATURE)) { reject("unsupported_command"); return; }
        const scope = inputScope;
        const available = scope && this.#agentStateRegistry.read<{ runtimeId: string; connected: boolean }>(scope, "availability");
        if (scope?.kind !== "agent" || scope.key.sessionId !== command.sessionId || available?.availability !== "ready"
            || available.value?.runtimeId !== runtimeId || !available.value.connected) {
          reject("会话已变化，请重新确认关闭。"); return;
        }
        closeKind = scope.key.agentKind;
        viewOnly = sharedViewBackend(closeKind);
        if (viewOnly && !this.#deviceFeatures.get(deviceId)?.has(RUNTIME_VIEW_CLOSE_FEATURE)) { reject("unsupported_command"); return; }
        const menu = this.#agentStateRegistry.read<Record<string, AgentCapabilityItem>>(scope, "capabilities");
        const capability = menu?.value?.[viewOnly ? RUNTIME_VIEW_CLOSE_CAPABILITY : closeKind === "claude" ? RUNTIME_CLOSE_CAPABILITY : "quit"];
        if (menu?.availability !== "ready" || capability?.source !== "builtin" || capability.argumentRequired === true
            || viewOnly && !command.closeGeneration
            || capability.closeGeneration !== command.closeGeneration) {
          reject("会话已变化，请重新确认关闭。"); return;
        }
        if (!command.confirmed) {
          const fact = this.#agentStateRegistry.read<AgentExecutionState>(scope, "execution");
          const execution = fact?.value;
          const tasks = execution?.tasks;
          const delivery = this.#agentStateRegistry.read<Record<string, AgentDeliveryItem>>(scope, "delivery")?.value;
          if (fact?.availability !== "ready" || execution?.phase !== "idle" || execution.waitingFor.length > 0
              || (execution.retry !== "unavailable" && execution.retry.phase === "running")
              || (execution.compaction !== "unavailable" && execution.compaction.phase === "running")
              || (tasks && (tasks.items.length > 0 || tasks.truncated) && !agentTasksAllowQuit(tasks))
              || Object.values(delivery ?? {}).some(item => ["accepted", "not_cancelable", "unconfirmed"].includes(item.state))) {
            reject("会话活动已变化，请重新确认关闭。"); return;
          }
        }
      }
      for (const backend of this.#backends) {
        if (!backend.isReady() || !backend.ownsRuntime(runtimeId)) continue;
        if (closeKind !== undefined && closeKind !== backend.kind) continue;
        // Only legacy backends use a slash command. Shared viewers validate the exact attachment again.
        const result = backend.dispatchCommand(runtimeId, commandId, command.type === "session.close" && closeKind !== "claude" && !viewOnly
          ? { type: "slash.execute", name: "quit", args: "" } : command);
        if (result === "handled") return;
        const error = result === "offline" ? "runtime_offline" : "unsupported_command";
        this.#commandOwners.receive(runtimeId, { type: "command.result", commandId, ok: false, status: "failure", error });
        this.#deviceViewFacts.settled(deviceId, { operationId: commandId, runtimeId, state: "failure", detail: error });
        this.#sendToDevice(deviceId, { type: "protocol.error", code: error, commandId,
          message: result === "offline" ? `runtime ${runtimeId} 当前没有在本机运行` : `${backend.kind} 后端不支持命令 ${command.type}` });
        return;
      }
      this.#commandOwners.receive(runtimeId, { type: "command.result", commandId, ok: false, status: "failure", error: "runtime_offline" });
      this.#deviceViewFacts.settled(deviceId, { operationId: commandId, runtimeId, state: "failure", detail: "runtime_offline" });
      this.#sendToDevice(deviceId, { type: "protocol.error", code: "runtime_offline", commandId, message: `runtime ${runtimeId} 当前没有在本机运行` });
    } catch (error) {
      this.#publishRuntimeEvent(runtimeId, { type: "command.result", commandId, ok: false, status: "unconfirmed", error: describeError(error) });
    }
  }

  /** `session.activated` 回执：激活结果统一从 `BackendActivation` 摊平成协议字段。 */
  #sendActivated(deviceId: string, requestId: string, agentKind: AgentKind, activated: BackendActivation, catalogId?: string): void {
    this.#sendToDevice(deviceId, {
      type: "session.activated",
      requestId,
      agentKind,
      ...(activated.sessionId === undefined ? {} : { sessionId: activated.sessionId }),
      ...(catalogId === undefined ? {} : { codexCatalogId: catalogId }),
      spawnMode: activated.spawnMode,
      ...(activated.pid === undefined ? {} : { pid: activated.pid }),
    });
  }

  /**
   * 拉全部后端的会话目录，带**短 TTL 缓存**和**并发合并**。
   *
   * 目录是只读且变化很慢的数据，但拉一次并不便宜：Codex 侧 `thread/list` 实测
   * 2.5–6s（codex CLI 内部要扫全部 rollout），Pi 侧要扫盘。手机在激活会话、
   * 重连、回前台时都会请求；不收敛的话这些请求会互相叠加，把每一台设备都拖进
   * 几十秒的等待——用户看到的就是「新建的会话几十秒后才出现在手机上」。
   *
   * 两条收敛路径：
   * - **并发合并**：`#catalogInFlight` 存在时直接复用同一个 Promise，同一瞬间的
   *   多个请求只扫一次盘。
   * - **TTL 缓存**：`CATALOG_TTL_MS` 内的请求直接回上次结果。
   *
   * 激活会话（`session.activate`）会显式 `#invalidateCatalog()`——新建/恢复会话
   * 后必须让手机立刻看到新条目，缓存不能挡住这条路径。
   */
  async #catalogWithCache(): Promise<{ sessions: AgentSessionSummary[]; cached: boolean }> {
    const now = Date.now();
    if (this.#catalogCache !== undefined && now - this.#catalogCache.at < CATALOG_TTL_MS) {
      return { sessions: this.#catalogCache.sessions, cached: true };
    }
    const epoch = this.#catalogEpoch;
    if (this.#catalogInFlight !== undefined) {
      const flight = this.#catalogInFlight;
      const sessions = await flight.promise;
      if (flight.epoch !== this.#catalogEpoch) {
        if (this.#catalogInFlight === flight) this.#catalogInFlight = undefined;
        return this.#catalogWithCache();
      }
      return { sessions, cached: true };
    }
    const task = this.#collectCatalogs(epoch);
    const flight = { epoch, promise: task };
    this.#catalogInFlight = flight;
    try {
      const sessions = await task;
      if (epoch !== this.#catalogEpoch) {
        if (this.#catalogInFlight === flight) this.#catalogInFlight = undefined;
        return this.#catalogWithCache();
      }
      this.#catalogCache = { at: Date.now(), sessions };
      this.refreshHostFacts();
      this.refreshHostFacts();
      return { sessions, cached: false };
    } finally {
      if (this.#catalogInFlight === flight) this.#catalogInFlight = undefined;
    }
  }

  /** 实际扫一遍所有后端（`#catalogWithCache` 的唯一慢路径）。 */
  async #collectCatalogs(epoch: number): Promise<AgentSessionSummary[]> {
    // Query ready backends concurrently so one slow backend does not stall the whole catalog.
    // 逐后端记结果：拉取失败或后端没就绪，在模型里都不能退化成「它没有会话」（ADR-0032 模块 03）。
    const unified = [...this.#deviceFeatures.values()].some(features => features.has(CODEX_UNIFIED_HISTORY));
    const results = await Promise.all(this.#backends.filter(backend => !this.#disabledSources.has(backend.kind)).map(async (backend): Promise<{
      sessions: AgentSessionSummary[];
      summary: HostCatalogBackend;
      history?: CodexHistoryRead;
    }> => {
      if (!backend.isReady()) {
        return { sessions: [], summary: { kind: backend.kind, ready: false, sessions: 0, complete: false, elapsedMs: 0 } };
      }
      const started = Date.now();
      try {
        if (unified && backend instanceof CodexRuntime) {
          const { kind, historyStore } = backend;
          const [active, archived] = await Promise.all([backend.catalogViews(false, true), backend.catalogViews(true, true)]);
          const sessions = [...new Map([...active.legacy, ...archived.legacy].map(row => [row.sessionId, row])).values()];
          return { sessions, summary: { kind, ready: true, sessions: sessions.length, complete: true, elapsedMs: Date.now() - started },
            history: { kind, store: historyStore, active: active.unified, archived: archived.unified } };
        }
        const load = (archived: boolean) => backend.catalogCoverage?.(archived)
          ?? (archived ? backend.catalog(true) : backend.catalog()).then(sessions => ({ sessions, complete: true }));
        const [active, archived] = await Promise.all([
          load(false),
          backend.archivedCatalogSupported === false ? Promise.resolve({ sessions: [], complete: true }) : load(true),
        ]);
        const catalog = [...new Map([...active.sessions, ...archived.sessions].map((entry) => [entry.sessionId, entry])).values()];
        this.#options.log?.(`[debug] session.list：${backend.kind} 返回 ${catalog.length} 条（${Date.now() - started}ms）`);
        const complete = typeof backend.catalogComplete === "function" ? backend.catalogComplete() : backend.catalogComplete !== false;
        const reasons = [
          ...(backend.archivedCatalogSupported === false ? ["archived_catalog_unsupported"] : []),
          ...(!complete ? ["catalog_limit_reached"] : []),
        ];
        return {
          sessions: catalog,
          summary: {
            kind: backend.kind, ready: true, sessions: catalog.length,
            complete: active.complete && archived.complete && reasons.length === 0,
            elapsedMs: Date.now() - started, ...(reasons.length ? { error: reasons.join(",") } : {}),
          },
        };
      } catch (error) {
        const detail = describeError(error).slice(0, 500);
        this.#options.log?.(`拉取 ${backend.kind} 会话目录失败，本次跳过该后端：${detail}`);
        this.recordDiagnostic({
          scope: "host", agentKind: backend.kind, sessionId: null, category: "catalog", severity: "error",
          message: `拉取 ${backend.kind} 会话目录失败`, detail: { agentKind: backend.kind, reason: detail.slice(0, 256) },
        });
        return {
          sessions: [],
          summary: { kind: backend.kind, ready: true, sessions: 0, complete: false, elapsedMs: Date.now() - started, error: detail },
        };
      }
    }));
    const sessions = results.flatMap(result => result.sessions);
    const backends = results.map(result => result.summary);
    const desktopIds = this.#desktopOwnedIds;
    const visible = sessions.filter(entry => entry.agentKind !== "codex" || !desktopIds.has(entry.sessionId));

    if (epoch === this.#catalogEpoch && !this.#serviceClosed) {
      const enabled = new Set(this.#launchableAgentsSnapshot().filter(isCodexKind));
      const history = results.flatMap(result => result.history ? [result.history] : []);
      for (const row of backends) if (isCodexKind(row.kind)) enabled.add(row.kind);
      const unifiedCode = unified ? {
        ...this.#codexHistory.update(history, enabled), ready: history.length > 0,
      } : undefined;
      const currentProviders = this.#hostStateFacts.readProviders()?.providers.flatMap(row => row.modelProvider ? [{ agentKind: row.agentKind, provider: row.modelProvider }] : []);
      this.#hostStateFacts.catalog({ totalSessions: visible.length, truncated: false, backends,
        sessions: visible.map(entry => ({ ...entry, hostname: hostname() })), currentProviders: currentProviders ?? this.#hostStateFacts.read()?.currentProviders ?? [] }, unifiedCode);
    }
    return visible;
  }

  #recordDesktopThread(id: string): void {
    if (this.#desktopOwnedIds.has(id)) return;
    this.#desktopOwnedIds.add(id);
    this.#options.codexRuntime?.seedDesktopThreads([id]);
    this.#invalidateCatalog();
    const path = join(this.#stateDir, "codex-desktop-threads.json");
    const body = JSON.stringify([...this.#desktopOwnedIds]);
    this.#desktopLedgerWrite = this.#desktopLedgerWrite.then(async () => {
      await writeFile(`${path}.tmp`, body, "utf8");
      await rename(`${path}.tmp`, path);
    }).catch(error => this.#options.log?.(`保存 Codex 桌面会话归属失败：${describeError(error)}`));
  }

  /** 激活或归档操作后失效目录缓存：状态变化必须马上出现在手机侧栏。 */
  #invalidateCatalog(): void {
    this.#catalogEpoch += 1;
    this.#catalogCache = undefined;
    // FT-G11: source invalidation must publish without waiting for a periodic
    // phone read. Coalesce bursts, bounded by the first invalidation's deadline.
    if (this.#serviceClosed || this.#providerFactsClosing ||
        !(this.#compactStateSubscriptions?.interestedInCatalog() || this.#agentStateSubscriptions?.interestedInCatalog())) return;
    const now = Date.now();
    if (this.#catalogRefreshTimer === undefined) this.#catalogRefreshFirstAt = now;
    clearTimeout(this.#catalogRefreshTimer);
    this.#catalogRefreshTimer = setTimeout(() => {
      this.#catalogRefreshTimer = undefined;
      if (this.#serviceClosed || this.#providerFactsClosing ||
          !(this.#compactStateSubscriptions.interestedInCatalog() || this.#agentStateSubscriptions.interestedInCatalog())) return;
      void this.#catalogWithCache().catch(error => this.#options.log?.(`目录聚合失败：${describeError(error)}`));
    }, Math.max(0, Math.min(250, this.#catalogRefreshFirstAt + 1_000 - now)));
    this.#catalogRefreshTimer.unref();
  }

  async #configuredBackend(kind: AgentKind, current = this.#sourceCurrent(kind)): Promise<AgentBackend> {
    if (!current()) throw new AgentLaunchRevoked();
    if (kind === "hermes") {
      const backend = await this.#hermes?.attachExisting().catch(() => undefined);
      if (!current()) throw new AgentLaunchRevoked();
      if (backend?.isReady()) return backend;
      throw new SessionConfigurationError("configuration_unavailable", "Hermes Gateway 未连接");
    }
    let backend = this.#backends.find(item => item.kind === kind);
    if (isKimiKind(kind) && !backend?.isReady()) await this.#ensureKimiReady(kind, current);
    if ((kind === "dsh" || kind === "dshDesktop") && !backend?.isReady()) await this.#ensureDshRuntime(false, kind);
    if ((kind === "codex" || kind === "codexDesktop") && !backend?.isReady()) await this.#ensureManagedCodex(kind);
    if (!current()) throw new AgentLaunchRevoked();
    backend = this.#backends.find(item => item.kind === kind);
    if (!backend?.isReady() || !backend.sessionConfiguration) throw new SessionConfigurationError("configuration_unavailable", "当前后端尚未提供新建配置，请检查电脑端连接");
    return backend;
  }

  async #handleSessionConfiguration(deviceId: string, message: Extract<DeviceE2ePayload, {
    type: "session.configuration.read" | "session.configuration.save" | "session.launch" | "session.launch.read"
  }>): Promise<void> {
    const epoch = this.#deviceViewEpochs.get(deviceId), link = this.#links.get(deviceId);
    const kind = "agentKind" in message ? message.agentKind : undefined;
    if (message.type === "session.launch" && message.codexLaunchMode !== undefined &&
      (!this.#unifiedCodex(deviceId) || !isCodexKind(kind) || message.codexLaunchMode !== codexMode(kind))) {
      this.#rejectAgentFeature(deviceId, message); return;
    }
    const sourceCurrent = kind === undefined ? () => true : this.#sourceCurrent(kind);
    const current = () => sourceCurrent() && link?.active !== undefined && link === this.#links.get(deviceId) && epoch === this.#deviceViewEpochs.get(deviceId);
    if (!current() || !allowsAgentRequest(this.#agentView(deviceId), message)) { this.#rejectAgentFeature(deviceId, message); return; }
    let ledger = isKimiKind(kind) ? this.#kimiConfigurations[kind] : kind === OPENCLAW_KIND ? this.#openClawLaunches
      : kind === "hermes" ? this.#hermesConfigurations : kind === OPENCODE_KIND ? this.#openCodeConfigurations : this.#sessionConfigurations;
    const sendLaunch = async (launchId: string) => {
      const observed = await ledger.result(deviceId, launchId, message.requestId);
      if (!current()) return;
      const result = observed && allowsAgentIdentity(this.#agentView(deviceId), observed) ? observed : undefined;
      this.#sendToDevice(deviceId, result ?? { type: "session.launch.result", requestId: message.requestId,
        launchId, phase: "absent" });
    };
    let releaseProvider: (() => void) | undefined;
    try {
      if (message.type === "session.launch.read") {
        // The caller's launch lane orders this read after the original create. Search each
        // negotiated Kimi ledger before choosing an empty fallback; Web and Desktop can both
        // be enabled, so selecting the first source is not sufficient.
        let fallbackKimiLedger: SessionConfigurationStore | undefined;
        let matchedKimiLedger = false;
        for (const kimiKind of KIMI_KINDS) {
          if (!allowsAgent(this.#agentView(deviceId), kimiKind)) continue;
          const candidate = this.#kimiConfigurations[kimiKind];
          fallbackKimiLedger ??= candidate;
          if (await candidate.result(deviceId, message.launchId, message.requestId)) { ledger = candidate; matchedKimiLedger = true; break; }
        }
        if (!matchedKimiLedger && fallbackKimiLedger) ledger = fallbackKimiLedger;
        if (!matchedKimiLedger && !(await ledger.result(deviceId, message.launchId, message.requestId))) {
          const legacy = await this.#legacyKimiConfigurations.result(deviceId, message.launchId, message.requestId);
          const legacyKind = legacy?.sessionId ? kimiKindFromId(legacy.sessionId) : undefined;
          if (legacy && legacyKind && allowsAgent(this.#agentView(deviceId), legacyKind)) ledger = this.#legacyKimiConfigurations;
        }
        if (allowsAgent(this.#agentView(deviceId), OPENCLAW_KIND) && !(await ledger.result(deviceId, message.launchId, message.requestId))) ledger = this.#openClawLaunches;
        if (!current()) return;
        if (allowsAgent(this.#agentView(deviceId), "hermes") && !(await ledger.result(deviceId, message.launchId, message.requestId))) ledger = this.#hermesConfigurations;
        if (!current()) return;
        if (allowsAgent(this.#agentView(deviceId), OPENCODE_KIND) && !(await ledger.result(deviceId, message.launchId, message.requestId))) ledger = this.#openCodeConfigurations;
        if (!current()) return;
        await this.#recoverSessionLaunch(ledger, deviceId, message.launchId, current);
        await sendLaunch(message.launchId); return;
      }
      if (message.type === "session.launch") {
        if (isKimiKind(kind)) {
          const otherKinds = KIMI_KINDS.filter(otherKind => otherKind !== kind);
          const conflict = await Promise.all([...otherKinds.map(otherKind => this.#kimiConfigurations[otherKind]), this.#sessionConfigurations, this.#legacyKimiConfigurations]
            .map(other => other.result(deviceId, message.launchId, message.requestId)));
          if (conflict.some(Boolean)) {
            this.#sendToDevice(deviceId, { type: "protocol.error", requestId: message.requestId,
              code: "launch_id_conflict", message: "启动身份与已有配置冲突，请先核对原启动" }); return;
          }
        }
        const prior = await ledger.result(deviceId, message.launchId, message.requestId);
        if (prior) {
          // begin validates the immutable fingerprint even for a completed/recovered operation.
          await ledger.begin(deviceId, message);
          if (!current()) return;
          await this.#recoverSessionLaunch(ledger, deviceId, message.launchId, current);
          await sendLaunch(message.launchId); return;
        }
        // LAUNCH-QUEUE-01: held until native creation settles, so a provider change cannot rewrite its settings mid-start.
        releaseProvider = await this.#providerGate.enter(providerGroup(message.agentKind));
      }
        if (isKimiKind(kind) && message.type !== "session.configuration.save" && !this.#kimi[kind]?.isReady()) {
        // A selected draft or explicit new session may start its Kimi source; passive reads may not.
        await kimiLocalDirectory(message.cwd);
        try { await this.#ensureKimiReady(kind, current); }
        catch (error) { throw new SessionConfigurationError("configuration_unavailable", describeError(error)); }
      }
      if ((kind === OPENCODE_KIND || kind === OPENCLAW_KIND || kind === "hermes") && message.type !== "session.configuration.save" &&
          !this.#backends.some(backend => backend.kind === kind && backend.isReady())) {
        if (!isAbsolute(message.cwd) || !await stat(message.cwd).then(info => info.isDirectory(), () => false))
          throw new SessionConfigurationError("configuration_unavailable", "请选择电脑上存在的绝对工作目录");
        try { await this.#ensureSharedAgent(kind, current); }
        catch (error) { throw new SessionConfigurationError("configuration_unavailable", describeError(error)); }
      }
      const backend = await this.#configuredBackend(message.agentKind, current);
      const catalog = await backend.sessionConfiguration!(message.cwd);
      if (!current()) return;
      if (message.type === "session.configuration.read") {
        const saved = await ledger.read(message.agentKind, message.cwd, catalog.binding);
        if (!current()) return;
        const values = { ...catalog.defaults, ...saved.values,
          permissions: { ...catalog.defaults.permissions, ...saved.values.permissions } };
        const model = catalog.models.find(item => item.value === values.model);
        if (!model) { delete values.model; delete values.thinking; Object.assign(values, {
          ...(catalog.models.some(item => item.value === catalog.defaults.model) ? { model: catalog.defaults.model! } : {}),
          ...(catalog.defaults.thinking === undefined ? {} : { thinking: catalog.defaults.thinking }),
        }); }
        const chosen = catalog.models.find(item => item.value === values.model);
        if (values.thinking !== undefined && !chosen?.thinking.some(item => item.value === values.thinking)) {
          delete values.thinking;
          if (chosen?.defaultThinking !== undefined) values.thinking = chosen.defaultThinking;
        }
        values.permissions = Object.fromEntries(Object.entries(values.permissions).filter(([id, value]) =>
          catalog.permissions.some(setting => setting.id === id && !setting.disabledReason && setting.options.some(option => option.value === value))));
        this.#sendToDevice(deviceId, { type: "session.configuration.result", requestId: message.requestId,
          agentKind: message.agentKind, cwd: message.cwd, binding: catalog.binding, revision: saved.revision, values, catalog });
        return;
      }
      if (catalog.binding !== message.binding) throw new SessionConfigurationError("configuration_stale", "供应商或模型清单已变化，请刷新启动配置");
      validateSessionConfiguration(catalog, message.values);
      if (message.type === "session.configuration.save") {
        if (backend.kind === OPENCLAW_KIND) throw new SessionConfigurationError("configuration_unavailable", "请在 OpenClaw 中配置模型与权限");
        const saved = await ledger.save(message.agentKind, message.cwd, message.binding, message.revision, message.values);
        if (!current()) return;
        this.#sendToDevice(deviceId, { type: "session.configuration.result", requestId: message.requestId,
          agentKind: message.agentKind, cwd: message.cwd, binding: message.binding, ...saved, catalog }); return;
      }
      const begun = await ledger.begin(deviceId, message);
      if (!begun.execute) { await sendLaunch(message.launchId); return; }
      await sendLaunch(message.launchId);
      try {
        const requireCurrent = () => { if (!current()) throw new AgentLaunchRevoked(); };
        requireCurrent();
        const activated = await backend.activate({ type: "new", cwd: message.cwd }, {
          deviceId, launchId: message.launchId, requireCurrent, spawnMode: backend.kind === OPENCLAW_KIND ? "headless" : message.spawnMode ?? (isKimiKind(backend.kind) ? "auto" : "tui"), configuration: message.values,
          legacyCodexSpawn: message.spawnMode === undefined || !this.#deviceFeatures.get(deviceId)?.has(DEVICE_FEATURE_EXPLICIT_TUI),
          ...(begun.record.nativeLaunchMarker === undefined ? {} : { nativeLaunchMarker: begun.record.nativeLaunchMarker }),
          ...(begun.record.expectedSessionId === undefined ? {} : { expectedSessionId: begun.record.expectedSessionId }),
          onCreated: async result => {
            await ledger.update(deviceId, message.launchId, { phase: "configuring",
              ...(result.sessionId === undefined ? {} : { sessionId: result.sessionId }), spawnMode: result.spawnMode });
            await sendLaunch(message.launchId);
          },
        });
        if (!activated.sessionId) throw new Error("后端未确认新会话身份，已停止发送首句");
        await ledger.update(deviceId, message.launchId, { phase: "ready", sessionId: activated.sessionId, spawnMode: activated.spawnMode });
        this.#invalidateCatalog();
      } catch (error) {
        // Native create may already have happened. Unknown is retained and never automatically re-created.
        await ledger.update(deviceId, message.launchId, {
          phase: error instanceof ClaudeStartupBlocked || error instanceof KimiLaunchBlocked || error instanceof AgentLaunchRevoked ? "failed" : "unknown", error: describeError(error).slice(0, 2000) });
      }
      await sendLaunch(message.launchId);
    } catch (error) {
      if (!current()) return;
      if (message.type === "session.launch") {
        // All native effects are inside the inner try. A rejected preflight has
        // no native side effect, while a stored operation remains recoverable.
        try {
          const record = await ledger.result(deviceId, message.launchId, message.requestId);
          if (record && !(error instanceof SessionConfigurationError && error.code === "launch_id_conflict")) {
            this.#sendToDevice(deviceId, record); return;
          }
          if (!record) {
            await ledger.reject(deviceId, message, describeError(error).slice(0, 2000));
            await sendLaunch(message.launchId); return;
          }
        } catch { /* Storage is unreadable; never claim authoritative absence. */ }
      }
      this.#sendToDevice(deviceId, { type: "protocol.error", requestId: message.requestId,
        code: error instanceof SessionConfigurationError ? error.code : "session_configuration_failed", message: describeError(error) });
    } finally { releaseProvider?.(); }
  }

  async #recoverSessionLaunch(ledger: SessionConfigurationStore, deviceId: string, launchId: string, current: () => boolean): Promise<void> {
    let prior = await ledger.result(deviceId, launchId, launchId);
    if (prior && isKimiKind(prior.agentKind)) {
      const launch = await ledger.launchMarker(deviceId, launchId);
      const legacyKind = legacyKimiLaunchKind(prior, launch?.binding);
      if (legacyKind) prior = { ...prior, agentKind: legacyKind };
    }
    if (!current() || !prior || !allowsAgentIdentity(this.#agentView(deviceId), prior)) return;
    // LAUNCH-QUEUE-01: recovery may reopen the session with this provider group's settings.
    const release = prior.agentKind === undefined ? undefined : await this.#providerGate.enter(providerGroup(prior.agentKind));
    try { await this.#recoverAdmittedLaunch(ledger, deviceId, launchId, current, prior); } finally { release?.(); }
  }

  async #recoverAdmittedLaunch(ledger: SessionConfigurationStore, deviceId: string, launchId: string, current: () => boolean,
    prior: SessionLaunchResult): Promise<void> {
    if (prior.phase === "unknown" && !prior.sessionId && prior.agentKind) {
      const sourceCurrent = this.#sourceCurrent(prior.agentKind);
      const admitted = () => sourceCurrent() && current();
      if (isKimiKind(prior.agentKind)) {
        try {
          const backend = await this.#configuredBackend(prior.agentKind, admitted);
          const launch = await ledger.launchMarker(deviceId, launchId);
          const sessionId = admitted() && launch && await backend.recoverLaunch?.(launch.marker, launch.cwd, launch.binding);
          if (sessionId && admitted()) await ledger.update(deviceId, launchId, { sessionId, phase: "configuring", spawnMode: "headless" });
        } catch { /* Native absence/unavailability is not permission to repeat the create. */ }
      } else if (prior.agentKind === OPENCLAW_KIND) {
        const backend = await this.#configuredBackend(prior.agentKind, admitted).catch(() => undefined);
        if (backend instanceof OpenClawBackend && prior.cwd && current()) {
          const sessionId = await backend.recoverLaunch(deviceId, launchId, prior.cwd).catch(() => undefined);
          if (sessionId && current()) await ledger.update(deviceId, launchId, { sessionId, phase: "configuring", spawnMode: "headless" });
        }
      } else {
        const backend = await this.#configuredBackend(prior.agentKind, admitted);
        const expectedSessionId = await ledger.expectedSessionId(deviceId, launchId);
        // Legacy unknown records without a reserved identity cannot safely adopt an arbitrary hello.
        const found = expectedSessionId === undefined ? undefined : backend.findLaunch?.(launchId, expectedSessionId);
        if (found?.sessionId && admitted()) await ledger.update(deviceId, launchId,
          { sessionId: found.sessionId, phase: "configuring", spawnMode: "tui" });
      }
    }
    let record = await ledger.recover(deviceId, launchId);
    if (record && isKimiKind(record.agentKind)) {
      const launch = await ledger.launchMarker(deviceId, launchId);
      const legacyKind = legacyKimiLaunchKind(record, launch?.binding);
      if (legacyKind) record = { ...record, agentKind: legacyKind };
    }
    if (!current() || !record?.sessionId) return;
    try {
      const sourceCurrent = this.#sourceCurrent(record.agentKind);
      const admitted = () => current() && sourceCurrent();
      const requireCurrent = () => { if (!admitted()) throw new AgentLaunchRevoked(); };
      const backend = await this.#configuredBackend(record.agentKind, admitted);
      const online = backend.directoryEntries?.().some(item => item.sessionId === record.sessionId);
      let spawnMode = record.spawnMode;
      if (record.phase !== "ready" || !online) {
        if (record.phase !== "ready") {
          const catalog = await backend.sessionConfiguration!(record.cwd);
          if (catalog.binding !== record.binding) throw new Error("后端配置来源已变化，请核对原会话；不会重新创建");
          validateSessionConfiguration(catalog, record.values);
        }
        if (!current()) return;
        const sessionId = record.sessionId;
        // Same session lane as session.activate/archive: a reopen never races an archive file move.
        const result = await this.#sessionLanes.run([sessionLane(sessionId)], () => backend.activate({ type: "resume", sessionId }, {
          deviceId, requireCurrent, spawnMode: record.spawnMode ?? "tui", legacyCodexSpawn: true,
          ...(record.phase === "ready" ? {} : { configuration: record.values }),
        }));
        if (result.sessionId !== record.sessionId) throw new Error("恢复返回了不同会话身份，已停止发送");
        spawnMode = result.spawnMode;
      }
      await ledger.update(deviceId, launchId, { phase: "ready", spawnMode, error: undefined });
      this.#invalidateCatalog();
    } catch (error) {
      // A failed process reattach does not invalidate historically confirmed
      // configuration or authorize reapplying the launch snapshot over later edits.
      await ledger.update(deviceId, launchId, { phase: record.phase === "ready" ? "ready" : "unknown", error: describeError(error).slice(0, 2000) });
    }
  }

  async #codexHistoryRoute(sessionId: string) {
    await this.#catalogWithCache();
    const route = this.#codexHistory.route(sessionId);
    if (!route) throw new ActivationError("session_not_found", "找不到这个 Codex 历史会话，请刷新目录");
    return route;
  }

  async #resumeCodexHistory(deviceId: string, requestId: string, id: string, mode: CodexLaunchMode | undefined,
    context: AgentActivateContext, requireLaunch: (kind: AgentKind) => () => void): Promise<void> {
    const route = await this.#codexHistoryRoute(id);
    if (route.archived) throw new ActivationError("session_not_found", "请先恢复这个已归档会话");
    const candidates = this.#codexRuntimes(route.store);
    const live = candidates.filter(runtime => runtime.servingActivation(route.threadId));
    if (live.length > 1) throw new SessionArchiveError("session_busy", "无法确认 Codex 当前运行连接");
    const selected = mode ? candidates.find(runtime => codexMode(runtime.kind) === mode)
      : live[0] ?? (candidates.length === 1 ? candidates[0] : undefined);
    if (!selected) throw new ActivationError("agent_unsupported", candidates.length > 1 && mode === undefined
      ? "请选择 Codex 启动方式" : "所选 Codex 启动方式无法读取该会话");
    const current = requireLaunch(selected.kind);
    const requireCurrent = () => {
      current();
      if (!this.#unifiedCodex(deviceId) || !this.#codexRuntimes(route.store).includes(selected)) throw new AgentLaunchRevoked();
    };
    requireCurrent();
    if (live[0] === selected) {
      this.#sendActivated(deviceId, requestId, selected.kind, selected.servingActivation(route.threadId)!, id);
      return;
    }
    // Never end another connection to satisfy a mode choice. A loaded peer may
    // still be holding the writer even when its UI/turn looks idle.
    if (live.length || !(await Promise.all(candidates.filter(peer => peer !== selected)
      .map(peer => peer.confirmsNotLoaded(route.threadId)))).every(Boolean)) {
      throw new SessionArchiveError("session_busy", "Codex 会话仍在另一种启动方式中打开");
    }
    await selected.assertResumableHistory(route.threadId);
    requireCurrent();
    // The native writer lock remains the final authority if a writer arrived
    // between the observation and resume (including clients outside Orbis).
    const activated = await selected.activateNative({ type: "resume", sessionId: route.threadId }, { ...context, requireCurrent });
    this.#invalidateCatalog();
    this.#sendActivated(deviceId, requestId, selected.kind, activated, id);
  }

  /** §8 的四个请求。所有失败都走 `protocol.error` 并带回 `requestId`，不静默吞。 */
  async #handleSessionRequest(
    deviceId: string,
    message: Extract<DeviceE2ePayload, { type: "session.list" | "session.browse" | "session.activate" | "session.archive" }>,
  ): Promise<void> {
    const requestId = message.requestId;
    if (!this.#allowsDeviceRequest(deviceId, message)) { this.#rejectAgentFeature(deviceId, message); return; }
    const sharedOperationId = message.type === "session.activate" ? this.#beginSharedOperation("session.activate",
      message.target.agentKind ?? null, message.target.type === "resume" ? message.target.sessionId : null)
      : message.type === "session.archive" ? this.#beginSharedOperation("session.archive", message.agentKind, message.sessionId) : undefined;
    this.#settleSharedOperation(sharedOperationId, "running");
    let sharedOperationFailed = false;
    let failureCode: string | undefined;
    // ADR-0049 §7.6：归档 / 启动按 requestId 写设备私有回执，手机断线重连后能据此核对乐观显示。
    // 它们是 Host 级请求，回执的 runtimeId 填 Host 身份（见 AgentOperationItemSchema）。
    const receipted = message.type === "session.archive" || message.type === "session.activate";
    const operationRuntimeId = message.type === "session.archive" ? message.sessionId : message.type === "session.activate"
      ? message.target.type === "resume" ? message.target.sessionId : message.target.agentKind === DSH_DESKTOP_KIND ? "dsh-desktop:launch"
        : isKimiKind(message.target.agentKind) ? `kimi-code:${message.target.agentKind}:launch` : message.target.agentKind === OPENCLAW_KIND ? "openclaw:launch" : message.target.agentKind === "hermes" ? "hermes:launch"
        : message.target.agentKind === OPENCODE_KIND ? `${OPENCODE_RUNTIME_PREFIX}launch` : this.#identity.hostId
      : this.#identity.hostId;
    // Scope receipts for gated runtimes before a device reconnects with an older build.
    const receiptRuntimeId = allowsRuntime(deviceAgentView(), operationRuntimeId) ? this.#identity.hostId : operationRuntimeId;
    if (receipted) this.#deviceViewFacts.accepted(deviceId, { operationId: requestId, runtimeId: receiptRuntimeId, requestId });
    if (message.type === "session.activate") { this.#activationsPending++; this.refreshHostFacts(); }
    this.#options.log?.(`[debug] 收到 ${message.type}（requestId=${requestId}）`);
    try {
      if (message.type === "session.archive" && isCodexHistoryId(message.sessionId)) {
        const link = this.#links.get(deviceId), epoch = this.#deviceViewEpochs.get(deviceId);
        const route = await this.#codexHistoryRoute(message.sessionId);
        const candidates = this.#codexRuntimes(route.store);
        const live = candidates.filter(runtime => runtime.servingActivation(route.threadId));
        const selected = live[0] ?? candidates[0];
        if (!selected) throw new ActivationError("agent_unsupported", "没有可读取该历史的 Codex 连接");
        if (live.length > 1 || !(await Promise.all(candidates.filter(peer => peer !== selected)
          .map(peer => peer.confirmsNotLoaded(route.threadId)))).every(Boolean)) {
          throw new SessionArchiveError("session_busy", "无法确认 Codex 会话可以归档");
        }
        const current = this.#sourceCurrent(selected.kind);
        const requireCurrent = () => {
          if (!current() || this.#links.get(deviceId) !== link || !link?.active || this.#deviceViewEpochs.get(deviceId) !== epoch
            || !this.#unifiedCodex(deviceId) || !this.#codexRuntimes(route.store).includes(selected)) throw new AgentLaunchRevoked();
        };
        requireCurrent();
        try { await selected.setNativeArchived(route.threadId, message.archived, requireCurrent); }
        finally { this.#invalidateCatalog(); }
        this.#publishCodexArchive(selected, route.threadId, message.archived, { deviceId, requestId });
        return;
      }
      if (message.type === "session.archive") {
        const backend = this.#backends.find((candidate) => candidate.kind === message.agentKind && candidate.isReady());
        if (backend === undefined) throw new ActivationError("agent_unsupported", "对应的 agent 后端未就绪");
        try {
          await backend.setArchived(message.sessionId, message.archived);
        } finally {
          // Even a failed native call can unload a thread or leave a completed file move.
          this.#invalidateCatalog();
        }
        if (backend instanceof CodexRuntime) this.#publishCodexArchive(backend, backend.nativeHistoryId(message.sessionId), message.archived, { deviceId, requestId });
        else this.#broadcastDeviceMessage({
          type: "session.archive.changed", requestId,
          agentKind: message.agentKind, sessionId: message.sessionId, archived: message.archived,
        });
        return;
      }
      if (message.type === "session.list") {
        // 各后端各拉各的目录（Pi 扫盘、Codex 问 app-server），单后端失败不拖垮列表。
        // 扫盘条目只知道「来自本机」：补上主机名，手机侧栏才能把「电脑上有、手机还没
        // 缓存过」的会话归到这台主机下，而不是落进未知主机分组（§8.1）。
        //
        // 目录是**只读且变化很慢**的东西，而单次拉取并不便宜（Codex 侧 `thread/list`
        // 实测 2.5–6s，Pi 侧全盘扫）。手机在每次激活/重连/回前台都会请求一遍，
        // 不收敛的话这些请求会互相堆叠、把每一台设备都拖进几十秒的等待。
        // 这里按 TTL 缓存 + 合并并发请求：同一时刻的多个 `session.list` 共享同一次扫描。
        const [{ sessions, cached }, providers] = await Promise.all([
          this.#catalogWithCache(),
          Promise.all(this.#backends.filter((backend) => backend.isReady() && allowsAgent(this.#agentView(deviceId), backend.kind)).map(async (backend) => {
            try {
              const provider = await backend.currentProvider?.();
              return provider === undefined ? [] : [{ agentKind: backend.kind, provider }];
            } catch (error) {
              const detail = describeError(error);
              this.#options.log?.(`读取 ${backend.kind} 当前 provider 失败：${detail}`);
              this.recordDiagnostic({
                scope: "host", agentKind: backend.kind, sessionId: null, category: "provider", severity: "warning",
                message: `读取 ${backend.kind} 当前 provider 失败`, detail: { reason: detail.slice(0, 256) },
              });
              return [];
            }
          })),
        ]);
        // 这里**不再**写 HostState.providers：会话列表只认识「当前 provider」，而这个领域是
        // 整值替换——让它写一次，就会把真正读过清单的那条路径（供应商读取/切换后）写下的
        // profiles 与 authenticated 冲成 null。模型里的供应商摘要由 refreshProviderFacts() 独占写入；
        // 手机要用的 current 仍然在这条消息的返回值里（currentProviders），不受影响。
        const localHostname = hostname();
        const currentProviders = providers.flat();
        this.#hostStateFacts.catalogProviders(currentProviders);
        const view = this.#unifiedCodex(deviceId) ? this.#hostStateFacts.catalogView(hiddenKinds(this.#agentView(deviceId)), true) : { sessions, currentProviders };
        const payload = {
          type: "session.list.result" as const,
          requestId,
          sessions: (view.sessions ?? []).filter(row => this.#unifiedCodex(deviceId) || allowsAgentIdentity(this.#agentView(deviceId), row))
            .slice(0, 2_000).map(entry => ({ ...entry, hostname: localHostname })),
          currentProviders: (view.currentProviders ?? []).slice(0, 2),
        };
        this.refreshHostFacts();
        this.#options.log?.(
          `[debug] 回 session.list.result：${payload.sessions.length} 条，${JSON.stringify(payload).length} 字节${cached ? "（命中缓存）" : ""}`,
        );
        this.#sendToDevice(deviceId, payload);
        return;
      }
      if (message.type === "session.browse") {
        // hasSessions 需要 cwd 集合：跳过逐文件读取，只扫每目录最新一个。
        const piCurrent = this.#sourceCurrent("pi");
        const pi = piCurrent() ? await listPiSessions({ summaries: false, ...(this.#options.sessionsRoot === undefined ? {} : { root: this.#options.sessionsRoot }) }) : undefined;
        let result = await browseDirectory(message.path, piCurrent() ? pi?.cwds ?? new Set() : new Set());
        if (pi && !piCurrent()) result = { ...result, entries: result.entries.map(entry => ({ ...entry, hasSessions: false })) };
        this.#sendToDevice(deviceId, {
          type: "session.browse.result",
          requestId,
          path: result.path,
          ...(result.parent === undefined ? {} : { parent: result.parent }),
          entries: result.entries,
        });
        return;
      }
      // session.activate。会话 id 空间互不相交（§7.5）：
      // - new 按 agentKind 点名后端，没这个后端就是 agent_unsupported；
      // - resume 按装配顺序（Pi → Codex）逐个问，session_not_found = 不归它管。
      const target = message.target;
      const link = this.#links.get(deviceId), epoch = this.#deviceViewEpochs.get(deviceId);
      const requireLaunch = (kind: AgentKind) => {
        const sourceCurrent = this.#sourceCurrent(kind);
        return () => { if (!sourceCurrent() || !link?.active || link !== this.#links.get(deviceId) || epoch !== this.#deviceViewEpochs.get(deviceId)) throw new AgentLaunchRevoked(); };
      };
      if (target.type === "new" && isKimiKind(target.agentKind)) throw new ActivationError("agent_unsupported", "请使用可恢复的 Kimi Code 启动请求");
      const legacyDesktopId = target.type === "resume" && target.sessionId.startsWith("kimi-code:desktop-");
      if (target.type === "resume" && isKimiId(target.sessionId) && target.agentKind !== undefined && target.agentKind !== kimiKindFromId(target.sessionId)
        && !(legacyDesktopId && target.agentKind === KIMI_KIND))
        throw new ActivationError("session_not_found", "会话与 Agent 类型不一致");
      const context = {
        deviceId,
        legacyCodexSpawn: message.spawnMode === undefined || !this.#deviceFeatures.get(deviceId)?.has(DEVICE_FEATURE_EXPLICIT_TUI),
        ...(message.spawnMode !== undefined ? { spawnMode: message.spawnMode }
          : target.type === "resume" && isKimiId(target.sessionId) ? { spawnMode: "headless" as const } : {}),
      };
      if (target.type === "resume" && isCodexHistoryId(target.sessionId)) {
        await this.#resumeCodexHistory(deviceId, requestId, target.sessionId, message.codexLaunchMode, context, requireLaunch);
        return;
      }
      if (target.type === "new") {
        const requireCurrent = requireLaunch(target.agentKind);
        requireCurrent();
        if (target.agentKind === OPENCLAW_KIND) throw new ActivationError("agent_unsupported", "请使用支持可恢复启动的 App 创建 OpenClaw 会话");
        if ((target.agentKind === "hermes" || target.agentKind === OPENCODE_KIND) && !this.#backends.some(backend => backend.kind === target.agentKind && backend.isReady())) {
          if (!isAbsolute(target.cwd) || !await stat(target.cwd).then(info => info.isDirectory(), () => false)) throw new ActivationError("cwd_missing", "请选择电脑上存在的绝对工作目录");
          const current = this.#sourceCurrent(target.agentKind);
          await this.#ensureSharedAgent(target.agentKind, () => current() && !!link?.active && link === this.#links.get(deviceId) && epoch === this.#deviceViewEpochs.get(deviceId));
        }
        let backend = this.#backends.find((candidate) => candidate.kind === target.agentKind);
        if ((backend === undefined || !backend.isReady()) && target.agentKind === "codex") backend = await this.#ensureManagedCodex("codex");
        if ((backend === undefined || !backend.isReady()) && target.agentKind === "codexDesktop") {
          try {
            const runtime = await this.#ensureManagedCodex("codexDesktop");
            if (runtime !== undefined) {
              backend = this.#backends.find((candidate) => candidate.kind === target.agentKind);
            }
          } catch (error) { throw new ActivationError("agent_unsupported", `Codex 桌面版启动或接入失败：${describeError(error)}`); }
        }
        if ((backend === undefined || !backend.isReady()) && (target.agentKind === "dsh" || target.agentKind === "dshDesktop")) {
          const kind = target.agentKind;
          try {
            await this.#ensureDshRuntime(false, kind);
            backend = this.#backends.find(candidate => candidate.kind === kind);
          } catch (error) {
            // Desktop failures are already short states (DSH-DESKTOP-09), shown on the phone as they are.
            throw new ActivationError("agent_unsupported", kind === "dsh" ? `DeepSeek Harness 启动或接入失败：${describeError(error)}` : describeError(error));
          }
        }
        if (backend === undefined) {
          throw new ActivationError(
            "agent_unsupported",
            target.agentKind === "codex"
              ? "Codex 后端未启用：请用 `orbis host --codex` 启动"
              : target.agentKind === "codexDesktop"
                ? "Codex 桌面版未安装，或 Host 无法启动并接入它"
              : target.agentKind === "dsh" ? "DeepSeek Harness 未安装，或 Host 无法启动并接入它"
              : target.agentKind === "dshDesktop" ? this.#options.dshDesktopStatus?.()?.reason ?? "DeepSeek 桌面版不可用"
              : "未知的 agent 类型",
          );
        }
        if (!backend.isReady()) {
          throw new ActivationError("agent_unsupported", `${backend.kind} 后端未就绪`);
        }
        requireCurrent();
        const activated = await backend.activate({ type: "new", cwd: target.cwd }, { ...context, requireCurrent });
        // 新建会话会改变目录（Codex 多一条活跃 thread、Pi 多一个会话文件）：
        // 让缓存立刻失效，否则手机在这 5s 内重新拉目录还是旧列表。
        this.#invalidateCatalog();
        this.#sendActivated(deviceId, requestId, backend.kind, activated);
        return;
      }
      const resumeKind = resumeAgentKind(target);
      if (isKimiKind(resumeKind) && !this.#kimi[resumeKind]?.isReady()) {
        const current = this.#sourceCurrent(resumeKind);
        await this.#ensureKimiReady(resumeKind, () => current() && link?.active !== undefined && link === this.#links.get(deviceId) && epoch === this.#deviceViewEpochs.get(deviceId), target.sessionId);
      }
      if ((resumeKind === "hermes" || resumeKind === OPENCODE_KIND || resumeKind === OPENCLAW_KIND) &&
          !this.#backends.some(backend => backend.kind === resumeKind && backend.isReady())) {
        if (resumeKind === OPENCLAW_KIND && this.#openClaw && !this.#openClaw.matchesSessionSource(target.sessionId))
          throw new ActivationError("session_not_found", "此会话不属于当前 OpenClaw Gateway");
        const current = this.#sourceCurrent(resumeKind);
        await this.#ensureSharedAgent(resumeKind, () => current() && !!link?.active && link === this.#links.get(deviceId) && epoch === this.#deviceViewEpochs.get(deviceId));
      }
      if (resumeKind === "codex" && this.#backends.every(backend => backend.kind !== "codex" || !backend.isReady())) await this.#ensureManagedCodex("codex");
      if (resumeKind === "codexDesktop" && this.#backends.every(backend => backend.kind !== "codexDesktop" || !backend.isReady())) {
        try {
          const runtime = await this.#ensureManagedCodex("codexDesktop");
          if (!runtime?.isReady()) throw new Error("Codex 桌面版没有完成 app-server 握手");
        } catch (error) { throw new ActivationError("agent_unsupported", `Codex 桌面版启动或接入失败：${describeError(error)}`); }
      }
      if ((resumeKind === "dsh" || resumeKind === "dshDesktop") && this.#backends.every(backend => backend.kind !== resumeKind || !backend.isReady())) {
        const product = resumeKind === "dsh" ? "DeepSeek Harness" : "DeepSeek 桌面版";
        try {
          const runtime = await this.#ensureDshRuntime(false, resumeKind);
          if (!runtime?.isReady()) throw new Error(`${product} 没有完成握手`);
        }
        catch (error) {
          throw new ActivationError("agent_unsupported", resumeKind === "dsh" ? `${product} 启动或接入失败：${describeError(error)}` : describeError(error));
        }
      }
      for (const backend of this.#backends) {
        if (!backend.isReady() || !allowsAgent(this.#agentView(deviceId), backend.kind)) continue;
        if (resumeKind !== undefined && backend.kind !== resumeKind) continue;
        if (resumeKind === undefined && (backend.kind === "codexDesktop" || backend.kind === "dshDesktop" || isKimiKind(backend.kind) || backend.kind === OPENCLAW_KIND || backend.kind === "hermes" || backend.kind === OPENCODE_KIND)) continue;
        try {
          const requireCurrent = requireLaunch(backend.kind);
          requireCurrent();
          const activated = await backend.activate({ type: "resume", sessionId: target.sessionId }, { ...context, requireCurrent });
          // 恢复会话会把它带进活跃 thread 目录（Codex），同样要失效缓存。
          this.#invalidateCatalog();
          this.#sendActivated(deviceId, requestId, backend.kind, activated);
          return;
        } catch (error) {
          if (error instanceof ActivationError && error.code === "session_not_found") continue;
          throw error;
        }
      }
      throw new ActivationError("session_not_found", `找不到会话 ${target.sessionId}（可能已被删除）`);
    } catch (error) {
      sharedOperationFailed = true;
      const code = error instanceof ActivationError || error instanceof SessionArchiveError ? error.code : "session_request_failed";
      failureCode = code;
      this.#sendToDevice(deviceId, {
        type: "protocol.error",
        code,
        message: describeError(error),
        requestId,
      });
      this.#options.log?.(`设备 ${deviceId} 的会话请求失败（${message.type}）：${describeError(error)}`);
    } finally {
      this.#settleSharedOperation(sharedOperationId, sharedOperationFailed ? "failed" : "succeeded");
      if (receipted) this.#deviceViewFacts.settled(deviceId, {
        operationId: requestId, runtimeId: receiptRuntimeId, requestId,
        state: sharedOperationFailed ? "failure" : "success", ...(failureCode === undefined ? {} : { detail: failureCode }),
      });
      if (message.type === "session.activate") { this.#activationsPending--; this.refreshHostFacts(); }
    }
  }

  /**
   * 一条通道刚刚握手完成。**每一次**握手完成都要补一份 runtime 目录，两次动作顺序重要：
   *
   * 1. 先补目录。手机重开时它只是重新握了一次手，断开期间错过的 `runtime.online` /
   *    `offline` 一个都没收到，手里没有任何进程；不补的话它会一直停在旧状态上。
   * 2. 然后才宣布生效路径，让手机把输入切到这条路上（§14 B4）。
   *
   * 注意这不属于「路径变了」（见 `#handlePathChange`）：同一条路上的重新握手不会改变生效
   * 路径，而对端恰恰是那时候最需要目录——把它挂在路径变更上，手机重开就永远补不到。
   */
  #handleSessionReady(deviceId: string, kind: PathKind, active: PathKind, change: PathChange): void {
    // Features belong to the App process on the other end; a new handshake may be a different (older) build.
    const previousView = this.#agentView(deviceId);
    const previousUnifiedCodex = this.#unifiedCodex(deviceId);
    this.#deviceFeatures.delete(deviceId);
    if (previousUnifiedCodex || previousView !== this.#agentView(deviceId)) this.#deviceViewEpochs.set(deviceId, randomUUID());
    this.#fieldTraffic.release(deviceId);
    this.#toolContentService.releaseDevice(deviceId); this.#toolInventory.closeOwner(deviceId);
    this.#fileChanges.releaseDevice(deviceId); this.#changeSubscribers.delete(deviceId);
    this.#agentStateSubscriptions.clearDevice(deviceId);
    this.#compactStateSubscriptions.clearDevice(deviceId);
    this.#sessionSync.clearDevice(deviceId);
    this.#historyInterests.delete(deviceId);
    this.#catalogQueryDevices.delete(deviceId);
    this.#syncDeviceTransfers(deviceId);
    if (change.changed) {
      this.#options.log?.(`设备 ${deviceId} 的路径 ${describePath(change.from)} → ${describePath(change.to)}`);
      this.#options.onPathChange?.(deviceId, {
        from: change.from,
        to: change.to,
        rttMs: undefined,
      });
    }
    // 两条都走**刚握手完成的这条路**，不走选路：Host 手里那条「生效路径」可能早就死了
    // （手机换了网、或干脆被杀掉，中继不会替它转告），而这条路刚刚证明过自己能通。
    this.#sendToDeviceOn(deviceId, kind, {
      type: "device.ready",
      ...this.#deviceReadyPayload(deviceId),
    });
    for (const runtime of this.#runtimesSnapshot()) {
      this.#sendToDeviceOn(deviceId, kind, this.#notifications.snapshot(runtime.runtimeId, deviceId));
    }
    const rttMs = this.#links.get(deviceId)?.activeRttMs;
    this.#sendToDeviceOn(deviceId, kind, {
      type: "device.path",
      protocolVersion: PROTOCOL_VERSION,
      path: active,
      ...(rttMs === undefined ? {} : { rttMs: Math.round(rttMs) }),
    });
    // Let compact model reads triggered by device.ready establish their subscription
    // first; the legacy replay is bounded and filtered per device at expiry.
    this.#scheduleBootstrapReplay(deviceId, kind);
    for (const runtime of this.#loopback?.runtimes ?? []) {
      // 手机重开时，Pi 的 loopback transport 通常没有断过，因此 Pi 不会自动收到
      // `RuntimeBridge` 的 transport.connected/resync 回调。主动请求一次权威交互快照，
      // 否则手机只能恢复目录和状态角标，却永远拿不到已经在电脑端 Pending 的问题详情。
      this.#loopback?.sendResync(runtime.runtimeId, "device_reconnected");
    }
  }

  /**
   * 生效路径变了（换路，或某条路没了）。
   *
   * 这里**不补** runtime 目录——那件事属于「握手完成」（见 `#handleSessionReady`）。
   */
  #handlePathChange(deviceId: string, change: ActivePathChange): void {
    this.#toolContentService.releaseDevice(deviceId); this.#toolInventory.closeOwner(deviceId);
    this.#fileChanges.releaseDevice(deviceId); this.#changeSubscribers.delete(deviceId);
    this.refreshHostFacts();
    this.#options.log?.(
      `设备 ${deviceId} 的路径 ${describePath(change.from)} → ${describePath(change.to)}`
        + (change.rttMs === undefined ? "" : `（${Math.round(change.rttMs)} ms）`),
    );
    if (change.to === undefined) {
      this.#sessionSync.clearDevice(deviceId);
      return;
    }
    this.#sendToDevice(deviceId, {
      type: "device.path",
      protocolVersion: PROTOCOL_VERSION,
      path: change.to,
      ...(change.rttMs === undefined ? {} : { rttMs: Math.round(change.rttMs) }),
    });
    this.#options.onPathChange?.(deviceId, change);
  }

  #isCodexRuntime(runtimeId: string): boolean {
    const scope = this.#agentFacts.scopeOf(runtimeId);
    return scope?.kind === "agent" && (scope.key.agentKind === "codex" || scope.key.agentKind === "codexDesktop");
  }

  #encodeForDevice(deviceId: string, message: object): Buffer {
    const outgoing = message as Partial<Extract<RelayToDeviceMessage, { type: "runtime.event" }>>;
    const { runtimeId } = outgoing;
    if (outgoing.type === "runtime.event" && outgoing.event?.type === "runtime.capabilities") {
      const { event } = outgoing;
      message = { ...message, event: { ...event, capabilities: { commands: event.capabilities.commands.filter(command => this.#allowsCloseCapability(deviceId, command.name)) } } };
    }
    const scope = runtimeId === undefined ? undefined : this.#agentFacts.scopeOf(runtimeId);
    const codex = runtimeId !== undefined && this.#isCodexRuntime(runtimeId);
    const rich = this.#deviceFeatures.get(deviceId)?.has(DEVICE_FEATURE_MESSAGE_RENDER) === true;
    const identity = scope?.kind === "agent" ? this.#agentStateRegistry.read(scope, "identity")?.value as { cwd?: string } | undefined : undefined;
    // A remote Gateway's cwd is a label, not permission to open the same path on this Host.
    const cwd = runtimeId?.startsWith(OPENCLAW_PREFIX) || runtimeId?.startsWith("hermes:") ? undefined : identity?.cwd;
    const backend = codex && rich && scope?.kind === "agent" ? this.#backends.find(candidate => candidate.kind === scope.key.agentKind) as CodexRuntime | undefined : undefined;
    const rendered = this.#deviceMessageRendering.project(deviceId, message, { rich, codex, ...(cwd === undefined ? {} : { cwd }),
      ...(backend && runtimeId ? { generatedImagePath: (id: string) => backend.generatedImagePath?.(runtimeId, id) } : {}) });
    const claudeSendNow = this.#deviceFeatures.get(deviceId)?.has(DEVICE_FEATURE_CLAUDE_SEND_NOW) === true;
    return this.#encodeMeasured(this.#compactStateSubscriptions.supportsSharedContent(deviceId)
      ? (rich ? this.#richSessionWireContent : this.#sessionWireContent).project(projectCompactDeviceMessage(rendered), rich ? deviceId : undefined)
      : rendered, { claudeSendNow });
  }

  #allowsCloseCapability(deviceId: string, name: string): boolean {
    const features = this.#deviceFeatures.get(deviceId);
    if (name === RUNTIME_VIEW_CLOSE_CAPABILITY) return features?.has(RUNTIME_CLOSE_FEATURE) === true && features.has(RUNTIME_VIEW_CLOSE_FEATURE);
    if (name === RUNTIME_CLOSE_CAPABILITY) return features?.has(RUNTIME_CLOSE_FEATURE) === true;
    return true;
  }

  readTransportFields(): ReturnType<FieldTrafficMeter["snapshot"]> { return this.#fieldTraffic.snapshot(); }

  #encodeMeasured(message: object, options?: DeviceMessageProjectionOptions): Buffer {
    const payload = encodeDeviceMessage(message, options);
    this.#measurePayload(payload, message); return payload;
  }

  #measurePayload(payload: Uint8Array, message: object): void {
    const object = message as Record<string, unknown>;
    const event = object.event as Record<string, unknown> | undefined;
    const runtime = typeof object.runtimeId === "string" ? this.#agentFacts.scopeOf(object.runtimeId) : undefined;
    const type = String(event?.type ?? object.type ?? "unknown");
    const reason = object.type === "device.ready" ? "bootstrap" : object.update === true ? "change" :
      type.includes(".page") || event?.range === "history" || event?.range === "catchup" ? "range" :
        event?.selection === "snapshot" ? "recovery" : Array.isArray(object.unchanged) && object.unchanged.length ? "reconcile" :
          type.includes("snapshot") || type.includes("result") ? "read" : "producer";
    this.#fieldTraffic.record(payload, { backend: runtime?.kind === "agent" ? runtime.key.agentKind : kimiKindFromId(object.runtimeId) ?? "host", messageType: type, reason });
  }

  #sendToDevice(deviceId: string, message: RelayToDeviceMessage): void {
    this.#sendJsonToDevice(deviceId, message, channelForDeviceMessage(message));
  }

  #sendJsonToDevice(deviceId: string, original: object, channel: EnvelopeChannel): void {
    const link = this.#links.get(deviceId);
    if (link === undefined) return;
    const message = this.#visibleTo(deviceId, original);
    if (message === undefined) return;
    try {
      // `send` 走当前生效路径；没有可用路径时返回 false，此时消息就是发不出去，
      // 也不该假装发出去了——上层会靠重连后的 `device.ready` 重新对齐。
      const payload = this.#encodeForDevice(deviceId, message);
      link.send(payload, channel, outboundQueueSource(message, payload.byteLength));
    } catch (error) {
      this.#options.onDeviceError?.(deviceId, error);
    }
  }

  /** 指定路径上的发送（握手刚完成时用，理由见 `DeviceLink.sendOn`）。 */
  #sendToDeviceOn(deviceId: string, kind: PathKind, original: RelayToDeviceMessage): void {
    const link = this.#links.get(deviceId);
    if (link === undefined) return;
    const message = this.#visibleTo(deviceId, original) as RelayToDeviceMessage | undefined;
    if (message === undefined) return;
    try {
      const payload = this.#encodeForDevice(deviceId, message);
      link.sendOn(kind, payload, channelForDeviceMessage(message), outboundQueueSource(message, payload.byteLength));
    } catch (error) {
      this.#options.onDeviceError?.(deviceId, error);
    }
  }

  async #acceptFileChangeBoundary(input: unknown, signal?: AbortSignal): Promise<boolean> {
    if (!input || typeof input !== "object") return false;
    const value = input as Record<string, unknown>;
    const validId = (id: unknown): id is string => typeof id === "string" && id.length > 0 && id.length <= 256;
    if (!validId(value.runtimeId) || !validId(value.sessionId) || !validId(value.reviewTurnId)) return false;
    const runtime = this.#loopback?.runtimes.find(runtime => runtime.runtimeId === value.runtimeId);
    if (!runtime || runtime.sessionId !== value.sessionId) return false;
    if (value.phase === "begin") {
      await this.#fileChangeTurns.begin(value.runtimeId, value.reviewTurnId, true, true, true, signal);
      return true;
    }
    if (value.phase !== "finish" || !Array.isArray(value.sourceTurnIds) || value.sourceTurnIds.length > 128
      || !value.sourceTurnIds.every(validId) || value.anchorEntryId !== undefined && !validId(value.anchorEntryId)) return false;
    if (!this.#fileChangeTurns.hasTurn(value.runtimeId, value.reviewTurnId))
      await this.#fileChangeTurns.begin(value.runtimeId, value.reviewTurnId, true, false, false);
    for (const turnId of value.sourceTurnIds) await this.#fileChangeTurns.started(value.runtimeId, turnId);
    const outcome = value.outcome === "completed" || value.outcome === "failed" || value.outcome === "cancelled" ? value.outcome : "unknown";
    const disconnected = (): void => this.#fileChanges.markUnreliable(value.runtimeId as string, "capture-barrier-disconnected", value.reviewTurnId as string);
    signal?.addEventListener("abort", disconnected, { once: true });
    try {
      await this.#fileChangeTurns.finish(value.runtimeId, { turnId: value.reviewTurnId, outcome, force: true, reliable: !signal?.aborted,
        ...(value.anchorEntryId ? { anchorEntryId: value.anchorEntryId as string } : {}) });
      if (signal?.aborted) disconnected();
    } finally { signal?.removeEventListener("abort", disconnected); }
    return true;
  }

  #runtimeEventMessage(runtimeId: string, event: RuntimeEvent): Extract<RelayToDeviceMessage, { type: "runtime.event" }> {
    return { type: "runtime.event", protocolVersion: PROTOCOL_VERSION, runtimeId,
      sequence: this.#nextEventSequence(runtimeId, channelForDeviceMessage({ type: "runtime.event", event })), event };
  }

  #isCurrentCodexSource(runtimeId: string, event: Extract<RuntimeEvent, { type: "session.patch" | "session.snapshot" }>,
    producer?: CodexRuntime): boolean {
    if (!producer || !event.source || this.#backends.find(backend => backend.isReady() && backend.ownsRuntime(runtimeId)) !== producer) return false;
    const current = producer.conversationSource(runtimeId, event.sessionId);
    return current?.epoch === event.source.epoch && current.seq === event.source.seq && current.ready === event.source.ready;
  }

  #publishRuntimeEvent(runtimeId: string, event: RuntimeEvent, codex?: CodexRuntime): void {
    if (this.#isCodexRuntime(runtimeId)) this.#deviceMessageRendering.observe(runtimeId, event);
    if (!isKimiId(runtimeId) && !runtimeId.startsWith(OPENCLAW_PREFIX)) this.#fileChangeTurns.observe(runtimeId, event);
    if (event.type === "tool.activity") return;
    if (event.type === "session.tools.produced") {
      this.#countToolTraffic(runtimeId, "summaryJsonBytes", Buffer.byteLength(JSON.stringify(event.page), "utf8"));
      const scope = this.#agentFacts.scopeOf(runtimeId);
      if (scope?.kind !== "agent" || !this.#toolIngestion.accept(runtimeId, scope.key, event)) {
        this.#recordAgentDiagnostic(runtimeId, "recovery", "Rejected producer tool inventory page", "warning");
      }
      return;
    }
    if (this.#piToolContents.accept(runtimeId, event)) return;
    if (event.type === "runtime.metadata") {
      const displaced = this.#agentFacts.displacedRuntime(runtimeId, event.metadata);
      if (displaced) this.#markRuntimeOffline(displaced.runtimeId, "replaced_by_new_runtime");
    }
    if (event.type === "session.snapshot") {
      this.#sessionSync.handleEvent(runtimeId, event, event.range === "preview" && this.#isCurrentCodexSource(runtimeId, event, codex));
      return;
    }
    if (event.type === "session.patch") {
      this.#countToolTraffic(runtimeId, "bodyJsonBytes", Buffer.byteLength(JSON.stringify(event.live?.messages ?? []), "utf8"));
      let rejectionReason: string | undefined;
      if (!this.#acceptConversation(runtimeId, event, reason => { rejectionReason = reason; })) {
        if (rejectionReason?.startsWith("registry_source_epoch_limit:") &&
          this.#isCurrentCodexSource(runtimeId, event, codex)) {
          // Don't serve the old cached preview after a confirmed native boundary.
          // Forward only the existing unknown boundary, never a rejected ready patch.
          const scope = this.#agentFacts.scopeOf(runtimeId);
          if (scope && this.#conversationState.hasBaseline(scope)) this.#invalidateConversationBaseline(runtimeId, event, rejectionReason);
          if (!event.source.ready) this.#broadcastDeviceMessage(this.#runtimeEventMessage(runtimeId, event));
          return;
        }
        if (["patch_baseline_mismatch", "handshake_base_mismatch", "unknown_patch_base_mismatch", "unknown_epoch_base_mismatch"]
            .includes(rejectionReason ?? "")) this.#invalidateConversationBaseline(runtimeId, event, rejectionReason!);
        this.#loopback?.sendResync(runtimeId, "model_baseline_required");
        return;
      }
    }
    // 先把事实记进统一模型，再走原来的转发路径；记录失败不影响转发（见 AgentStateFacts.observe）。
    if (event.type !== "session.patch") this.#agentFacts.observe(runtimeId, event);
    if (event.type === "runtime.metadata" || event.type === "runtime.status") this.refreshHostFacts();
    if (this.#sessionSync.handleEvent(runtimeId, event)) return;
    if (event.type === "runtime.metadata" && (!this.#notifications.has(runtimeId) || this.#notifications.needsAttach(runtimeId))) {
      this.#notifications.attach(runtimeId, event.metadata.sessionId);
    }
    if (event.type === "notification.source") {
      if (!this.#notifications.apply(runtimeId, event)) this.#options.log?.(`通知来源尚未核对或被拒绝 (${runtimeId})`);
      return;
    }
    if (event.type === "interaction.requested") {
      this.#recordAgentDiagnostic(runtimeId, "interaction", "Interaction requested");
      const ids = this.#interactionIds.get(runtimeId) ?? new Set<string>();
      if (ids.size < 64) ids.add(event.request.requestId); this.#interactionIds.set(runtimeId, ids);
      const scope = this.#agentFacts.scopeOf(runtimeId);
      this.#wakeDevices("approval-requested", createHash("sha256").update(`approval:${runtimeId}:${event.request.requestId}`).digest("hex"),
        runtimeId, scope?.kind === "agent" ? scope.key.sessionId : undefined);
    }
    if (event.type === "session.patch" && event.live?.turn?.outcome === "completed") {
      const turnId = event.live.turn.turnId;
      if (turnId) this.#wakeDevices("task-completed", createHash("sha256").update(`completed:${runtimeId}:${event.sessionId}:${turnId}`).digest("hex"), runtimeId, event.sessionId);
    }
    if (event.type === "interaction.snapshot") this.#interactionIds.set(runtimeId, new Set(event.requests.map(item => item.requestId)));
    if (event.type === "interaction.resolved" || event.type === "interaction.cancelled") {
      this.#recordAgentDiagnostic(runtimeId, "interaction", event.type === "interaction.resolved" ? "Interaction resolved" : "Interaction cancelled");
      const wasPending = this.#interactionIds.get(runtimeId)?.delete(event.requestId);
      this.#notifications.interactionTerminated(runtimeId, event.requestId);
      // App responses already have an in-place ledger summary (ADR-0049 §6.5).
      // Consume the terminal identity even when no additional banner is needed.
      if (wasPending && !(event.type === "interaction.resolved" && event.source === "remote")) {
        const reason = event.type === "interaction.cancelled" ? event.reason : undefined;
        this.#notifications.outcome(runtimeId, { code: "interaction.result", occurrenceId: event.requestId,
          scope: { requestId: event.requestId }, lifecycle: "outcome",
          severity: reason === undefined || reason === "cancelled" ? "info" : "warning",
          message: reason === undefined ? "交互已在电脑端完成" : {
            cancelled: "交互请求已取消",
            timeout: "交互请求已超时",
            disconnected: "交互请求因连接断开而取消",
            owner_closed: "电脑端已结束此交互",
          }[reason],
          // Disconnect and owner close keep the legacy cancellation lifetime.
          displayMs: reason === "timeout" ? 30_000 : 8_000,
        });
      }
    }
    if (event.type === "command.result" || (event.type === "runtime.error" && event.commandId !== undefined)) {
      const owner = this.#commandOwners.receive(runtimeId, event);
      if (owner !== undefined) {
        // Keep the device-scoped fallback for legacy clients and absent request cards; details stay in the receipt.
        if (owner.requestId !== undefined && (event.type === "runtime.error" || !event.ok && event.status !== "pending")) {
          const uncertain = event.type === "command.result" && (event.status === "unconfirmed" || event.status === "cancelled");
          this.#notifications.outcome(runtimeId, { code: uncertain ? "interaction.submit" : "interaction.submit.rejected",
            occurrenceId: event.commandId!, scope: { requestId: owner.requestId, commandId: event.commandId! }, lifecycle: "outcome",
            severity: uncertain ? "warning" : "error", message: uncertain ? "回答结果未确认" : "提交失败" }, owner.deviceId);
        }
        this.#deviceViewFacts.settled(owner.deviceId, {
          operationId: event.commandId!,
          runtimeId,
          state: event.type === "runtime.error" ? "failure" : event.status === "pending" ? "pending" : event.status === "unconfirmed" ? "unconfirmed" : event.ok ? "success" : event.status ?? "failure",
          ...(owner.requestId === undefined ? {} : { requestId: owner.requestId }),
          ...(event.type === "runtime.error" ? { detail: event.message }
            : event.error === undefined ? {} : { detail: event.error }),
        });
        this.refreshHostFacts();
        this.#sendToDevice(owner.deviceId, this.#runtimeEventMessage(runtimeId, event)); return;
      }
      return;
    }
    // All current remote notices have one authority. Uncorrelated legacy errors cannot revive them.
    if (event.type === "runtime.error") { this.#options.log?.(`未关联 runtime.error (${runtimeId}): ${event.message}`); return; }
    this.#broadcastDeviceMessage(this.#runtimeEventMessage(runtimeId, event));
  }

  readonly #pushWakeReceipts = new PushWakeReceipts();
  #wakeDevices(category: "task-completed" | "approval-requested", eventId: string, runtimeId: string, sessionId?: string): void {
    if ((runtimeId.startsWith(OPENCLAW_PREFIX) || runtimeId.startsWith("hermes:")) || !this.#pushWakeReceipts.observe(category, eventId)) return;
    // APNS-L19: capture each phone's interest at the semantic edge. Defer the
    // reachability probe until the event has been queued for its E2E recipients.
    const recipients = this.#store.devices.filter(device => !device.revoked && this.#allowsDeviceRuntime(device.deviceId, runtimeId)).map(device => ({ device,
      link: this.#links.get(device.deviceId), interest: this.#historyInterests.get(device.deviceId) }));
    queueMicrotask(() => {
      void Promise.all(recipients.map(async ({ device, link, interest }) => {
        const watching = interest === undefined || interest !== null && interest.runtimeId === runtimeId && interest.sessionId === sessionId;
        if (watching && await link?.confirmNotificationReachability()) return undefined;
        // Unpair/replacement may race the probe. Never revive an old recipient.
        return this.#allowsDeviceRuntime(device.deviceId, runtimeId) && this.#store.devices.some(current => current.deviceId === device.deviceId && !current.revoked && current.pskRoot === device.pskRoot)
          ? device.deviceId : undefined;
      })).then(ids => this.#sendPushWake(category, eventId, ids.filter((id): id is string => id !== undefined)))
        .catch(error => this.#options.log?.(`APNs routing failed: ${describeError(error)}`));
    });
  }

  #sendPushWake(category: "task-completed" | "approval-requested", eventId: string, deviceIds: string[]): void {
    if (deviceIds.length === 0 || this.#relay?.state !== "connected") return;
    const url = `${relayHttpBase(this.#options.relayUrl)}/v1/push/wake`;
    if (!url.startsWith("https://")) return;
    void fetch(url, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(5_000),
      headers: { authorization: `Bearer ${this.#options.credential}`, "content-type": "application/json" },
      body: JSON.stringify({ hostId: this.#identity.hostId, deviceIds, category, eventId }),
    }).then(async response => {
      if (!response.ok) this.#options.log?.(`APNs wake request rejected (${response.status})`);
    }).catch(error => this.#options.log?.(`APNs wake request failed: ${describeError(error)}`));
  }

  #sendNotificationSnapshot(deviceId: string, runtimeId: string): void {
    this.#sendToDevice(deviceId, this.#notifications.snapshot(runtimeId, deviceId));
  }

  #broadcastDeviceMessage(message: RelayToDeviceMessage): void {
    if (message.type === "runtime.offline") this.#deviceMessageRendering.releaseRuntime(message.runtimeId);
    if (message.type === "runtime.online" || message.type === "runtime.offline") this.refreshHostFacts();
    // Negotiated devices receive catalog identity alongside the unchanged wire
    // identity, not instead of it. A broadcast cannot share those bytes.
    if (message.type === "runtime.online" || message.type === "runtime.event" && message.event.type === "runtime.metadata") {
      for (const id of this.#links.keys()) this.#sendToDevice(id, message);
      return;
    }
    const visible = (id: string) => this.#visibleTo(id, message) !== undefined;
    const chatEvent = message.type === "runtime.event" && ["session.patch", "session.snapshot", "message.started", "message.delta",
      "message.finished", "turn.started", "turn.finished", "tool.started", "tool.updated", "tool.finished"].includes(message.event.type);
    if (message.type === "runtime.event" && chatEvent) {
      const scope = this.#agentFacts.scopeOf(message.runtimeId);
      const sessionId = "sessionId" in message.event ? message.event.sessionId : scope?.kind === "agent" ? scope.key.sessionId : undefined;
      for (const [deviceId, link] of this.#links) {
        const interest = this.#historyInterests.get(deviceId);
        if (interest !== undefined &&
            (!interest || interest.runtimeId !== message.runtimeId || interest.sessionId !== sessionId)) continue;
        if (!visible(deviceId)) continue;
        try { const payload = this.#encodeForDevice(deviceId, message); link.send(payload, channelForDeviceMessage(message), outboundQueueSource(message, payload.byteLength)); }
        catch (error) { this.#options.onDeviceError?.(deviceId, error); }
      }
      return;
    }
    if (message.type === "runtime.event" && message.event.type === "runtime.capabilities") {
      for (const deviceId of this.#links.keys()) {
        if (this.#compactStateSubscriptions.owns(deviceId, message.runtimeId, "capabilities")) continue;
        this.#sendToDevice(deviceId, message);
      }
      return;
    }
    const payload = encodeDeviceMessage(message);
    this.#broadcastPayload(payload, channelForDeviceMessage(message), outboundQueueSource(message, payload.byteLength),
      visible);
  }

  /** 广播给所有握好手的设备。单台设备封帧失败不影响其他设备。 */
  #broadcastPayload(payload: Uint8Array, channel: EnvelopeChannel, source: OutboundQueueSource, admits?: (deviceId: string) => boolean): void {
    for (const [deviceId, link] of this.#links) {
      if (admits !== undefined && !admits(deviceId)) continue;
      try {
        this.#measurePayload(payload, { type: source.type, runtimeId: source.runtimeId,
          ...(source.eventType ? { event: { type: source.eventType } } : {}) });
        if (!link.send(payload, channel, source)) continue;
      } catch (error) {
        this.#options.onDeviceError?.(deviceId, error);
      }
    }
  }

  /** 同上，但封成 `bin` 帧（裸字节载荷，例如 artifact 分片）。 */
  #broadcastBinary(payload: Uint8Array, runtimeId: string): void {
    for (const [deviceId, link] of this.#links) {
      if (!this.#allowsDeviceRuntime(deviceId, runtimeId)) continue;
      try {
        if (!link.sendBinary(payload)) continue;
      } catch (error) {
        this.#options.onDeviceError?.(deviceId, error);
      }
    }
  }

  /**
   * Host 是发给手机的**事件序号的唯一权威**：按 (runtimeId, channel) 取号。
   *
   * Pi 自己在 loopback 上带的 `sequence` 只服务本机链路，这里**不采用**——
   * 它是全局一条流水（见 pi-extension 的 `nextRuntimeSequence`），与分道投递
   * 的现实不匹配，采纳它就是把 issue 02 的跨道倒挂原样搬给手机。
   *
   * 首次见到某个 (runtimeId, channel) 时用当前时间起步——它必然高于上一次
   * 会话里的任何序号：手机的 `lastSequence` 活在 APP 进程内存里，Host 重启
   * 不能指望手机那边清零。
   */
  #nextEventSequence(runtimeId: string, channel: EnvelopeChannel): number {
    const key = `${runtimeId}\u0000${channel}`;
    const known = this.#eventSequences.get(key);
    const next = known === undefined ? Date.now() : known + 1;
    this.#eventSequences.set(key, next);
    return next;
  }

  #requireLink(deviceId: string): DeviceLink {
    const existing = this.#links.get(deviceId);
    if (existing !== undefined) return existing;
    const record = findActiveDeviceRecord(this.#store, deviceId);
    if (record === undefined) {
      throw new E2eError("mac_mismatch", `设备 ${deviceId} 未配对或已被撤销`);
    }
    // 每台设备一条链路，节流状态跟着闭包走：慢链路的大下载里水位告警会持续触发，
    // 不节流就是每个 pump tick 一行日志（真机实测一次 84MB 下载刷出 1.89 GB）。
    let lastBulkWarnAt = 0;
    const link = new DeviceLink({
      compatible: true,
      hostId: this.#identity.hostId,
      device: record,
      relayHistoryMode: this.#options.relayHistoryMode ?? "shared",
      onQueueDiagnostic: (path, sample) => {
        for (const input of outboundQueueDiagnosticRecords(deviceId, path, sample)) this.recordDiagnostic(input);
      },
      onQueueAdmissionRejected: (path, rejection) => {
        this.recordDiagnostic(outboundQueueAdmissionRecord(deviceId, path, rejection));
        this.#options.log?.(
          `[queue] ${path}/${rejection.channel} 出站队列达到上限（${rejection.queuedBytes}/${rejection.queueLimitBytes} 字节，` +
          `请求 ${rejection.requestedBytes} 字节）：摘除路径并等待重新握手`,
        );
      },
      ...(this.#options.probeIntervalMs === undefined ? {} : { probeIntervalMs: this.#options.probeIntervalMs }),
      ...(this.#options.bulkBytesPerSecond === undefined
        ? {}
        : { bulkBytesPerSecond: this.#options.bulkBytesPerSecond }),
      ...(this.#options.log === undefined
        ? {}
        : { onBulkQueuedTooLong: (kind: PathKind, queuedMs: number, queuedBytes: number) => {
          const now = Date.now();
          if (now - lastBulkWarnAt < BULK_WARN_INTERVAL_MS) return;
          lastBulkWarnAt = now;
          this.#options.log?.(
            `[bulk] ${kind} 路径上分片排队 ${Math.round(queuedMs / 1000)}s（队列 ${queuedBytes} 字节）：链路积压，分片被水位压住；控制帧不受影响（插队走 ctl）`,
          );
        } }),
      ...(this.#options.log === undefined
        ? {}
        : { onStaleFrame: (kind: PathKind, info: { channel: string; n: number; last: number }) => {
          this.#options.log?.(
            `[e2e] ${kind} 路径丢弃过期帧：ch=${info.channel} n=${info.n}（本端水位线 ${info.last}）。` +
              `多为发送端在该 channel 上的序号回退——若成批出现，检查两端会话状态是否错位`,
          );
        } }),
      onPayload: (payload, frame, path) => {
        this.#handleDevicePayload(deviceId, payload, frame, path);
      },
      onActivePathChange: (change) => {
        this.#handlePathChange(deviceId, change);
      },
      onActiveRttUpdated: (path, rttMs) => {
        this.#sendToDevice(deviceId, {
          type: "device.path", protocolVersion: PROTOCOL_VERSION, path, rttMs: Math.round(rttMs),
        });
      },
      onSessionReady: (kind, active, change) => {
        this.#handleSessionReady(deviceId, kind, active, change);
      },
      // 底层写入重试耗尽：那几帧真的没出去，而它们的序号已经消耗。重发只会换一个新序号、
      // 接收侧的洞永远补不上，所以把这条路径摘掉、让选路回落。
      onPathWriteAbandoned: (kind, error) => {
        this.recordDiagnostic({ scope: "host", agentKind: null, sessionId: null, category: "transport",
          severity: "warning", message: `Path write abandoned: ${kind}` });
        this.#options.log?.(
          `${kind} 路径上的写入重试耗尽（${describeError(error)}）：摘掉这条路径，让选路回落`,
        );
        this.#links.get(deviceId)?.detach(kind);
      },
      onError: (error) => {
        this.#options.onDeviceError?.(deviceId, error);
      },
    });
    this.#links.set(deviceId, link);
    this.#attachRelaySink(link);
    return link;
  }

  /**
   * 给一条链路挂上中继出口。
   *
   * Relay 是常驻的控制面：任何设备随时都有一条 Relay 出口可用（前提是那条连接还在）。
   * 注意「挂上出口」不等于「这条路可用」——可用与否由该路径自己握手成功来决定。
   *
   * 出口必须在**每次** relay 连上之后重挂，不能只在链路创建时挂一次：relay 掉线时
   * `detach("relay")` 会把出口连同该路径的会话一起摘掉（这是对的，旧 socket 的会话
   * 不能复用），而链路本身留在地图里不会重建。只挂一次的表现是——relay 抖动一次之后，
   * 那台设备的中继入站帧全部石沉大海。
   */
  #attachRelaySink(link: DeviceLink): void {
    const sink: PathSink = (envelope) => {
      this.#relay?.send(envelope);
    };
    // 中继 socket 的待发字节数：出站多路复用器靠它决定分片什么时候才能写进去。
    sink.backlog = () => this.#relay?.bufferedAmount ?? 0;
    sink.channelBacklog = (channel) => this.#relay?.bufferedAmountFor(channel) ?? 0;
    sink.supportsHistoryStreams = () => this.#relay?.supportsHistoryStreams === true;
    link.attach("relay", sink);
  }

  #persist(): void {
    const snapshot: DeviceStore = { version: 1, devices: [...this.#store.devices] };
    this.#persistChain = this.#persistChain.then(() => saveDeviceStore(this.#stateDir, snapshot));
  }
}

function isAddressInUse(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    (error as { code?: unknown }).code === "EADDRINUSE";
}

function parseDevicePayload(payload: Buffer): DeviceE2ePayload | LanDiscoveryRequest | GitBranchRequest | ProviderRequest | VoiceCleanupRequest | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
  const result = DeviceE2ePayloadSchema.safeParse(parsed);
  if (result.success) return result.data;
  return parseLanDiscoveryRequest(parsed) ?? parseGitBranchRequest(parsed) ?? parseProviderRequest(parsed) ?? parseVoiceCleanupRequest(parsed);
}
