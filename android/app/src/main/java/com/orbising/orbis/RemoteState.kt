package com.orbising.orbis

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import java.util.UUID

internal const val PROTOCOL_VERSION_MISMATCH_ERROR =
    "Orbis 协议版本不兼容，请将手机 App 和电脑 Host 更新到最新版本"

/**
 * Host 为「P2P 走不通、继续走中继」发的 protocol.error 码。
 *
 * 这些不是失败请求：它们描述的是尽力而为的支线路径没起来，业务已经在中继上正常跑。
 * reducer 看到它们直接丢弃，不当模态错误弹给用户。
 */
internal val P2P_FALLBACK_ERROR_CODES = setOf("p2p_cooling_down", "p2p_unavailable")

/** 协议 14 已以模型/聊天事务替换这些一次性业务通知，迟到帧不能另建写入者。 */
internal val MODEL_OWNED_LEGACY_EVENTS = setOf(
    "runtime.status", "runtime.capabilities", "message.queued", "interaction.requested", "interaction.snapshot",
    "interaction.resolved", "interaction.cancelled", "local_interaction.required", "message.started", "message.delta",
    "message.finished", "turn.started", "turn.finished", "tool.started", "tool.updated", "tool.finished",
    // 这三类是**模型来源事实**：Host 已经把它们记进统一模型，手机按领域读 agent.state。
    // 旧 Host 仍在发的时候只推进序号、不写状态；否则每收到一条就弹「无法安全处理此运行时事件」。
    "delivery.snapshot", "execution.activity", "notification.source",
)

@Serializable
data class RuntimeModelInfo(
    val provider: String,
    val id: String,
    /** Human-readable model name when the provider catalogue has one. */
    val name: String? = null,
) {
    /** Compact label for the composer status; falls back to the raw id for uncatalogued models. */
    val displayName: String get() = name?.takeIf(String::isNotBlank) ?: id
}

/**
 * Host 到 Codex 桌面版 app-server 的接入状态（ADR-0022）。
 *
 * 它只描述那条 proxy 连接：`attached` 时桌面会话才会出现在目录里，其余分档只是
 * 那条后端不可用，终端 Codex 不受影响。[reason] 由 Host 给出，含可照做的下一步。
 */
@Serializable
data class CodexDesktopAttach(
    val state: String,
    val reason: String,
)

@Serializable
data class RuntimeContextUsage(
    /** Estimated tokens in the active context; null while Pi cannot estimate them yet. */
    val tokens: Long? = null,
    val contextWindow: Long? = null,
    /** Context utilization as a percentage, or null when the token estimate is unknown. */
    val percent: Double? = null,
)

@Serializable
data class RuntimeSummary(
    val runtimeId: String,
    val name: String,
    val cwd: String,
    val status: String,
    val sessionId: String? = null,
    val sessionGraphSync: Boolean = false,
    val sessionLeafId: String? = null,
    /** Optional OS hostname for display; the authenticated pairing owns this Runtime. */
    val hostname: String? = null,
    val sessionName: String? = null,
    /** Active model reported by the Runtime; absent on older Runtime or Relay versions. */
    val model: RuntimeModelInfo? = null,
    /** Current thinking depth (`thinkingLevel` for Pi, reasoning effort for Codex). */
    val thinkingLevel: String? = null,
    /** Context utilization reported by the Runtime; absent on older Runtime or Relay versions. */
    val contextUsage: RuntimeContextUsage? = null,
    val permissions: RuntimePermissions? = null,
    val permissionManagement: RuntimePermissionManagement? = null,
    /** Host 模型的会话身份；不从 runtime 路由前缀推断。 */
    val agentKind: String? = null,
    /** 镜像可用性供界面区分最后已知值与当前已确认事实。 */
    val domainAvailability: Map<String, String> = emptyMap(),
) {
    /**
     * 这条 Runtime 是不是 Codex 会话。codex 的对外 runtimeId 形如 `codex:<threadId>`
     * （旧版是固定 `codex`），Pi 是随机 UUID——前缀判定不会撞。
     * 只用于展示层（命令来源徽标、侧栏角标），不参与协议语义。
     */
    val isCodex: Boolean
        get() = agentKind in setOf("codex", "codexDesktop")
}

@Serializable
data class RemoteArtifact(
    val artifactId: String,
    val fileName: String,
    val mimeType: String,
    val size: Long,
    // Empty is tolerated only for legacy persisted tasks; every new protocol artifact is validated before use.
    val sha256: String = "",
    val path: String? = null,
)

@Serializable
data class RemoteContent(
    val type: String,
    val text: String? = null,
    /** ADR-0038 §5：这条载荷被线路投影截断过；`originalBytes` 是截断前的字节数。 */
    val truncated: Boolean = false,
    val originalBytes: Long? = null,
    val toolCallId: String? = null,
    val toolName: String? = null,
    val arguments: JsonElement? = null,
    val artifact: RemoteArtifact? = null,
    val summary: ToolSummary? = null,
)

@Serializable
data class ChatMessage(
    val messageId: String,
    val role: String,
    val content: List<RemoteContent>,
    val timestamp: Long,
    val toolCallId: String? = null,
    val toolName: String? = null,
    val isError: Boolean? = null,
    val toolSummary: ToolSummary? = null,
)

@Serializable
data class InteractionOption(
    val value: String,
    val label: String,
    val description: String? = null,
)

data class PendingInteraction(
    val requestId: String,
    val extensionId: String,
    val kind: String,
    val title: String,
    val description: String?,
    val options: List<InteractionOption>,
    val placeholder: String?,
    val toolName: String? = null,
    val argumentSummary: String? = null,
    val externalUrl: String? = null,
    val submitted: Boolean = false,
    val confirmLabel: String? = null,
    val cancelLabel: String? = null,
    val initialValue: String? = null,
    val minLength: Int? = null,
    val maxLength: Int? = null,
    val minSelections: Int? = null,
    val maxSelections: Int? = null,
    val secret: Boolean = false,
    val expiresAt: Long = Long.MAX_VALUE,
    val questions: List<QuestionnaireQuestion> = emptyList(),
    val responseCommandId: String? = null,
    val responseError: String? = null,
)

data class ToolActivity(
    val toolCallId: String,
    val toolName: String,
    val state: String,
    val detail: String? = null,
    val isError: Boolean = false,
    val summary: ToolSummary? = null,
)

@Serializable
data class TurnTiming(
    val turnId: String,
    val startedAt: Long,
    val durationMs: Long? = null,
    val turnIndex: Int? = null,
    val messageId: String? = null,
)

data class QueuedMessage(
    val queueId: String,
    val text: String,
    val delivery: String,
    val state: String = "accepted",
    val error: String? = null,
)

@Serializable
data class RuntimeSlashCommandTreeNode(
    val parentId: String?,
    val entryType: String,
    val role: String? = null,
    val label: String? = null,
    val defaultHidden: Boolean,
    val isCurrent: Boolean,
    val isOnActivePath: Boolean,
)

@Serializable
data class RuntimeSlashCommandOption(
    val value: String,
    val label: String,
    val description: String? = null,
    val tree: RuntimeSlashCommandTreeNode? = null,
)

@Serializable
data class RuntimeSlashCommandArgument(
    val kind: String,
    val required: Boolean,
    val hint: String? = null,
    val options: List<RuntimeSlashCommandOption> = emptyList(),
)

@Serializable
data class RuntimeSlashCommand(
    val name: String,
    val description: String? = null,
    val source: String,
    val argument: RuntimeSlashCommandArgument? = null,
)

@Serializable
data class RuntimeCapabilities(
    val commands: List<RuntimeSlashCommand> = emptyList(),
)

data class CommandResult(
    val ok: Boolean,
    val status: String = "success",
    val result: JsonElement? = null,
    val error: String? = null,
)

internal fun artifactTransferKey(runtimeId: String, transferId: String): String = "$runtimeId\u0000$transferId"

// 下载任务只认 Host + 文件身份，与会话无关：同一个文件从哪个会话点开都是同一条任务。
internal fun fileDownloadTaskId(hostId: String, path: String): String = UUID.nameUUIDFromBytes(
    "$hostId\u0000file\u0000$path".toByteArray(Charsets.UTF_8),
).toString()

internal fun artifactDownloadTaskId(hostId: String, artifactId: String): String = UUID.nameUUIDFromBytes(
    "$hostId\u0000artifact\u0000$artifactId".toByteArray(Charsets.UTF_8),
).toString()

internal fun downloadDisplayName(path: String): String = path.trimEnd('/', '\\')
    .substringAfterLast('/')
    .substringAfterLast('\\')
    .ifBlank { "电脑文件" }

@Serializable
data class ArtifactDownload(
    val taskId: String,
    /** 服务这条下载的 Host（命令路由）；下载不归属任何会话。 */
    val runtimeId: String,
    /** The paired Host that serves this transfer; null only for records written before multi-Host. */
    val hostId: String? = null,
    val displayName: String,
    val commandId: String? = null,
    val transferId: String? = null,
    val sourcePath: String? = null,
    val sourceArtifactId: String? = null,
    val artifact: RemoteArtifact? = null,
    val status: String = "queued",
    val receivedBytes: Long = 0,
    val savedLocation: String? = null,
    val error: String? = null,
    /** 服务这条下载的 Host runtimeId（`artifact.started` 带的那个）。完成时要拿它对账 store。 */
    val transferRuntimeId: String? = null,
    /** `"pull"` = 接收方驱动的范围下载（ADR-0005）；`null`/其他 = 旧流式 + ACK。 */
    val createdAt: Long = System.currentTimeMillis(),
)

data class PendingDownload(
    val taskId: String,
    val runtimeId: String,
    val offset: Long,
)

data class ArtifactAppendResult(
    val runtimeId: String?,
    val recognized: Boolean,
    val receivedOffset: Long,
)

internal fun findDownloadTaskId(
    downloads: Collection<ArtifactDownload>,
    runtimeId: String,
    artifact: RemoteArtifact,
): String? = downloads.firstOrNull { task ->
    // 下载由 Host 服务，事件带的 runtimeId 是 hostId；旧记录的 runtimeId 可能还是会话，
    // 所以按 artifact 身份匹配（artifactId 唯一；路径下载比对源路径）。
    (runtimeId == task.runtimeId || task.transferId == null) &&
        task.status in setOf("queued", "downloading", "paused") &&
        (task.sourceArtifactId == artifact.artifactId ||
            task.sourcePath != null && task.sourcePath == artifact.path)
}?.taskId

data class RuntimeConversation(
    val messages: List<ChatMessage> = emptyList(),
    /** Temporary messages are isolated to this runtime/session/branch until graph sync persists them. */
    val streamingMessageIds: Set<String> = emptySet(),
    /**
     * Messages whose final form already arrived. A stream is over at that point, so any later
     * delta for the same id is stale: appending it would drift the row away from the canonical
     * text and stop it from being reconciled with its persisted entry.
     */
    val finishedMessageIds: Set<String> = emptySet(),
    val streamingSessionId: String? = null,
    val hasLiveSnapshot: Boolean = false,
    /** Source-side checkpoint identity. It is independent from relay message sequence. */
    val sourceEpoch: String? = null,
    val sourceSeq: Long = -1L,
    /** Canonical source head observed with the current checkpoint. */
    val sourceHeadLeafId: String? = null,
    /** False means the current source epoch is being reconciled and its projection is unknown. */
    val sourceReady: Boolean = true,
    /** Epochs superseded by an accepted checkpoint; delayed responses from these epochs are stale. */
    val retiredSourceEpochs: Set<String> = emptySet(),
    /** Out-of-order source patches are retained only until a bounded checkpoint recovery. */
    val sourcePatchBuffer: Map<Long, SessionPatch> = emptyMap(),
    /** Incomplete source snapshots are retried with a pause instead of a response/request loop. */
    val sourceRecoveryRetryAt: Long = 0,
    /** Explicit retry must obtain a full baseline even if a previous one is still displayable. */
    val forceSourceSnapshot: Boolean = false,
    val isChatSyncing: Boolean = false,
    val chatSyncError: String? = null,
    val revision: Long = 0,
    val tools: Map<String, ToolActivity> = emptyMap(),
    val turnTimings: Map<String, TurnTiming> = emptyMap(),
    val activeTurnId: String? = null,
    val queuedMessages: Map<String, QueuedMessage> = emptyMap(),
    val deliveredQueueIds: Set<String> = emptySet(),
    val interactions: Map<String, PendingInteraction> = emptyMap(),
    val waitingLocalInteraction: Boolean = false,
    val interactionNotices: Map<String, String> = emptyMap(),
    val systemNotice: String? = null,
) {
    val interactionNotice: String? get() = interactionNotices.values.distinct().takeIf { it.isNotEmpty() }?.joinToString("\n")
}

enum class RelayConnection { OFFLINE, CONNECTING, ONLINE, RECONNECTING }

/** 一次目录浏览的快照（spec §8.1）。path 为 null 表示根（Windows 下是盘符列表）。 */
data class SessionBrowseState(
    val requestId: String,
    val path: String? = null,
    val parent: String? = null,
    val entries: List<SessionBrowseEntry> = emptyList(),
    val isLoading: Boolean = true,
    val error: String? = null,
)

@Serializable
data class SessionBrowseEntry(
    val name: String,
    val isDir: Boolean,
    val hasSessions: Boolean,
)

/** session.activated 的结果（spec §8：只证明进程已拉起，上线由 runtime.online 对账）。 */
data class SessionActivationInfo(
    val requestId: String,
    val agentKind: String,
    val sessionId: String?,
    val spawnMode: String,
    val at: Long = System.currentTimeMillis(),
)

data class RemoteState(
    val notificationEpoch: String? = null,
    val notificationProjections: Map<String, NoticeProjection> = emptyMap(),
    val notificationReceipts: Map<String, Long> = emptyMap(),
    val connection: RelayConnection = RelayConnection.OFFLINE,
    val sessions: Map<String, SessionCatalogEntry> = emptyMap(),
    val deviceId: String? = null,
    /**
     * 已配对 Host 在 runtime 空间里的身份（spec §9.4）。
     *
     * 下载/推送的语义是「和 Host 交互」：文件在电脑磁盘上，Host 常驻，读盘发分片不需要任何
     * Pi 进程参与。APP 下载时就把命令的 `runtimeId` 填成它——Relay 据此路由到 Host。
     * null = 还没有已配对的 Host（旧凭据或未配对）。
     */
    val hostId: String? = null,
    /** Display label from the pairing identity; never a Session ownership or routing key. */
    val hostName: String? = null,
    val runtimes: Map<String, RuntimeSummary> = emptyMap(),
    val workingBranches: Map<String, WorkingBranch> = emptyMap(),
    /** Last known session identity survives a transient runtime.offline event. */
    val knownRuntimeSessions: Map<String, String?> = emptyMap(),
    val conversations: Map<String, RuntimeConversation> = emptyMap(),
    val toolInventories: Map<String, ToolInventoryReplica> = emptyMap(),
    val pendingToolConversations: Map<String, List<PendingToolConversation>> = emptyMap(),
    val toolDetail: ToolDetailView? = null,
    val lastSequence: Map<String, Long> = emptyMap(),
    val pendingCommands: Map<String, String> = emptyMap(),
    val commandResults: Map<String, CommandResult> = emptyMap(),
    val capabilities: Map<String, RuntimeCapabilities> = emptyMap(),
    /**
     * 这台电脑支持的 agent 种类（[device.ready] 的 `agents`）。
     *
     * **null = 未知**，此时不对新建会话的选项做限制：Relay 那份种子 `device.ready` 里没有
     * 这一项（它不知道电脑装没装 codex），旧版 Host 也不会发；只有 Host 发的才是权威答案。
     */
     val supportedAgents: Set<String>? = null,
    /** Agent kinds that can be started on demand, including an installed but currently closed desktop GUI. */
    val launchableAgents: Set<String>? = null,
    /**
     * Codex 桌面版 app-server 的接入状态；null = 未知或这台电脑没跑这条后端。
     * 它比 [launchableAgents] 多回答一个问题：桌面版装了但没打开、还是打开了却接入失败。
     */
    val codexDesktop: CodexDesktopAttach? = null,
    /** Native backend modelProvider keys, keyed by agentKind; never Host-managed profile ids. */
    val currentProviders: Map<String, String> = emptyMap(),
    val agentProviders: AgentProvidersState = AgentProvidersState(),
    /**
     * Host 统一状态模型的最近一次读取（ADR-0032 issue #10），key = 作用域 + 会话/运行时身份。
     *
     * 存的是 Host **已经提交**的投影：客户端不再自己拼这些事实，缺就用 [AgentStateSnapshotView.missing]
     * 说的原因解释缺席，而不是把「没读到」渲染成「没有」。
     */
    val agentStateSnapshots: Map<String, AgentStateSnapshotView> = emptyMap(),
    /** 已发出、还没应答的模型读取请求；应答到达即移除（好坏都销账）。 */
    val agentStateRequests: Set<String> = emptySet(),
    val agentStateReads: Map<String, AgentStateRead> = emptyMap(),
    val agentCatalogRange: AgentCatalogRange? = null,
    val agentCatalogRangeRequest: AgentCatalogRangeRequest? = null,
    /** 只能由经过认证的 device.ready 建立或替换。 */
    val agentModelEpoch: String? = null,
    val retiredAgentModelEpochs: Set<String> = emptySet(),
    /** 诊断记录的最后一页（模块 23）。只留一页：状态页要看的是最近发生了什么。 */
    val diagnosticPage: DiagnosticPageView? = null,
    /** 已发出、还没回来的记录读取；带时间戳，超过窗口就如实说「没有回音」。 */
    val diagnosticRequest: DiagnosticRequestView? = null,
    val sessionGraphs: Map<String, SessionGraph> = emptyMap(),
    val runtimeSessionViews: Map<String, RuntimeSessionView> = emptyMap(),
    val sessionSyncCommands: Map<String, PendingSessionSync> = emptyMap(),
    val sessionBranchGenerations: Map<String, Int> = emptyMap(),
    /** Stops automatic reloads after failure, even if unrelated live events update the display. */
    val sessionSyncFailures: Map<String, String> = emptyMap(),
    /** 每个运行时连续被背压拒绝的次数（ADR-0036 §3）。 */
    val sessionSyncBusyStreaks: Map<String, Int> = emptyMap(),
    /** 失败冷却（调度节拍）：到 SYNC_FAILURE_COOLDOWN_TICKS 就放行（ADR-0036 §8）。 */
    val sessionSyncFailureCooldowns: Map<String, Int> = emptyMap(),
    /**
     * 尝试层的"这个目标不必再试"集合（`runtimeId\u0000targetLeafId`）。
     *
     * ADR-0037 §5：确定性失败只挡它自己的目标，不许停掉整个会话；
     * 与只用于显示的 `sessionSyncFailures` 分开存储。
     */
    val sessionSyncBlockedTargets: Set<String> = emptySet(),
    /** ADR-0038 §8：按需取回的未截断条目，按 entryId 缓存。 */
    val fullEntries: Map<String, SessionGraphEntry> = emptyMap(),
    val sessionSyncRequests: Set<String> = emptySet(),
    val sessionSyncDemandGenerations: Map<String, Long> = emptyMap(),
    val sessionHistory: Map<String, SessionHistoryState> = emptyMap(),
    /** Logical reads and bounded terminal outcomes; one owner for all read kinds. */
    val sessionReads: Map<String, SessionReadOperation> = emptyMap(),
    /** Range failures do not invalidate the source baseline or block valid cache queries. */
    val sessionRangeFailures: Map<String, String> = emptyMap(),
    val downloads: Map<String, ArtifactDownload> = emptyMap(),
    /** 手机发往电脑的上传任务（spec: 手机上传文件到电脑），key = taskId。 */
    val uploads: Map<String, UploadTask> = emptyMap(),
    val pendingDownloads: Map<String, PendingDownload> = emptyMap(),
    /** Each list request records the archive revision it started under. */
    val sessionListEpoch: Long = 0,
    val sessionListRequestEpochs: Map<String, Long> = emptyMap(),
    /** 进行中的 session.list 请求（spec §8）：requestId 集合，响应/错误到达后移除。 */
    val sessionListRequests: Set<String> = emptySet(),
    /** 新建会话 / 下载共用的电脑文件浏览：null 表示选择器已关闭。 */
    val sessionBrowse: SessionBrowseState? = null,
    /** 进行中的 session.activate 请求（L1 resume / L2 new 共用）。 */
    val sessionActivateRequests: Set<String> = emptySet(),
    /** Only explicit resume requests may navigate when their acknowledged Session comes online. */
    val sessionActivateTargets: Map<String, String> = emptyMap(),
    val activatedSessionToOpen: String? = null,
    /** requestId -> sessionId; clear only on a result, failure, timeout, or reconnect. */
    val sessionArchiveRequests: Map<String, String> = emptyMap(),
    /** 最近一次成功激活（进程已拉起），UI 用于 snackbar 提示；展示完可清除。 */
    val sessionActivation: SessionActivationInfo? = null,
    /** Offline history is a read-only view; online interaction is always selected by Runtime. */
    val selectedOfflineSessionId: String? = null,
    val selectedRuntimeId: String? = null,
    /** 当前生效的传输路径（device.path 宣布，spec §14 B4）：lan / p2p / relay。 */
    val path: String? = null,
    val pathRttMs: Long? = null,
    /**
     * 端到端加密通道是否已建立（spec §5 的 HS1/HS2/HS3 走完）。
     *
     * `connection == ONLINE` 只说明**中继**认了这台手机（Relay 收到 device.authenticate 就回
     * device.ready，与电脑在不在、握手成不成无关），所以「已连接」不等于「能干活」。
     * 进程激活要求 data 通道可用，判定依据必须是这个字段，而不是 connection。
     */
    val e2eReady: Boolean = false,
    /**
     * 共享错误通道。**它不再弹模态框**：界面把 `errorNeedsAction` 分成两层显示。
     */
    val error: String? = null,
    /**
     * 这条错误需不需要用户在**电脑端**动手。
     *
     * - `false`（默认）：偶发/可自愈的噪音（同步失败、校验失败、协议抖动）。顶部横幅显示几秒后自动消失。
     * - `true`：版本不兼容、事件无法解析这类"手机这边做什么都没用"的问题。横幅一直留着，直到用户关掉。
     *
     * 模态确认框只留给"用户必须做选择"的操作（配对、删除、权限），错误本身不再占用它。
     */
    val errorNeedsAction: Boolean = false,
) {
    /** Read-only history observation compatibility; there is no second mutable registry. */
    val historyReads: Map<String, SessionReadOperation> get() = sessionReads
}

data class PendingSessionSync(
    val runtimeId: String,
    val sessionId: String,
    val syncId: String,
    val range: String = "catchup",
    val targetLeafId: String? = null,
    val beforeEntryId: String? = null,
    val knownLeafId: String? = null,
    val sentAt: Long = System.currentTimeMillis(),
    val branchGeneration: Int = 0,
    /** Live/view anchor when this task was created; targetLeafId is the fixed logical target. */
    val viewLeafId: String? = targetLeafId,
    /** Target actually sent on the wire; a catch-up hole may be an ancestor of targetLeafId. */
    val requestTargetLeafId: String? = targetLeafId,
    val connectionGeneration: Int = 0,
    val firstSentAt: Long = sentAt,
    /** Zero means queued but not sent; retries preserve commandId, syncId and range boundaries. */
    val attempts: Int = 1,
    val slow: Boolean = false,
    val exhaustedAt: Long? = null,
    val notBefore: Long = 0,
    /** This request establishes a source baseline, independently of the display loading state. */
    val sourceRecovery: Boolean = false,
    /** A recovery becomes obsolete for epoch switching once a different baseline is installed. */
    val sourceRecoveryEpoch: String? = null,
    /** Fixed at task creation so retry never changes its immutable request parameters. */
    val knownState: SessionAppliedState? = null,
    /** Client-local read identity; applies to preview/history/catchup, never sent on the wire. */
    val historyOperationId: String? = null,
    /** Immutable refresh demand captured at task creation. */
    val demandGeneration: Long? = null,
    /** 协调者回过 `session.sync.pending` 的次数（ADR-0037 §3）；用于给"重新计时"设上限。 */
    val pendingNotices: Int = 0,
    /** 收到 pending 后待调度器把耗尽窗口重新计时（reducer 没有时钟，由 tick 消费）。 */
    val awaitingWindowReset: Boolean = false,
)

data class SessionHistoryState(
    val sessionId: String,
    val leafId: String?,
    val oldestEntryId: String?,
    val hasOlder: Boolean,
    val loading: Boolean = false,
    val requestId: String? = null,
)

/**
 * Model and context utilization are optional metadata fields. A Runtime or Relay that predates them
 * omits both, and Pi itself omits a model when none is selected, so keep the last known values
 * instead of blanking the composer status on the next metadata refresh. Permission metadata is
 * retained only for the same Session, so switching Sessions never carries an old permission scope.
 */
internal fun RuntimeSummary.carryingComposerStatus(previous: RuntimeSummary?): RuntimeSummary {
    // 目录/metadata 只提供聊天路由；业务字段由已提交的模型领域写入。
    val sameSession = previous?.takeIf { it.sessionId == sessionId }
    return copy(
        status = sameSession?.status ?: "unknown",
        model = sameSession?.model,
        thinkingLevel = sameSession?.thinkingLevel,
        contextUsage = sameSession?.contextUsage,
        permissions = null,
        permissionManagement = sameSession?.permissionManagement,
        agentKind = sameSession?.agentKind,
        domainAvailability = sameSession?.domainAvailability.orEmpty(),
    )
}

/** Any Runtime on this computer is waiting for an answer (shown on the computer switcher). */
internal fun RemoteState.hasAnyPendingInteraction(): Boolean = runtimes.keys.any(::hasPendingInteraction)

internal fun RemoteState.hasPendingInteraction(runtimeId: String): Boolean =
    runtimes[runtimeId]?.status == "waiting_local_interaction" ||
        conversations[runtimeId]?.interactions?.isNotEmpty() == true

/** 顶层 decoder：供类外的 session.* 帮助函数使用（RelayReducer 的 json 成员不可见）。 */
private val sessionMessageJson = Json { ignoreUnknownKeys = true }

private fun mergeSessionCatalogEntry(
    existing: SessionCatalogEntry?,
    incoming: SessionCatalogEntry,
): SessionCatalogEntry {
    if (existing == null) return incoming
    return existing.copy(
        name = incoming.name ?: existing.name,
        cwd = incoming.cwd.ifBlank { existing.cwd },
        firstMessage = incoming.firstMessage ?: existing.firstMessage,
        createdAt = if (incoming.createdAt > 0) incoming.createdAt else existing.createdAt,
        modifiedAt = maxOf(existing.modifiedAt, incoming.modifiedAt),
        messageCount = maxOf(existing.messageCount, incoming.messageCount),
        hasHistoryCache = existing.hasHistoryCache || incoming.hasHistoryCache,
        hostname = incoming.hostname?.takeIf(String::isNotBlank) ?: existing.hostname,
        agentKind = incoming.agentKind ?: existing.agentKind,
        archived = incoming.archived ?: existing.archived,
        modelProvider = incoming.modelProvider?.takeIf(String::isNotBlank) ?: existing.modelProvider,
    )
}

/**
 * session.list.result（spec §8）：全量会话索引合并进侧栏目录。磁盘扫描的条目没有
 * hasHistoryCache（那是历史同步的标记），所以只合并不替换；requestId 收尾。
 */
private fun reduceSessionListResult(state: RemoteState, message: JsonObject): RemoteState {
    val requestId = message["requestId"]?.jsonPrimitive?.contentOrNull ?: return state
    if (requestId !in state.sessionListRequests) return state
    // Directory contents are mirrored from HostState.catalog; this is a device read receipt.
    return state.copy(sessionListRequests = state.sessionListRequests - requestId,
        sessionListRequestEpochs = state.sessionListRequestEpochs - requestId)
}

private fun reduceSessionArchiveChanged(state: RemoteState, message: JsonObject): RemoteState {
    val sessionId = message["sessionId"]?.jsonPrimitive?.contentOrNull ?: return state
    val agentKind = message["agentKind"]?.jsonPrimitive?.contentOrNull ?: return state
    val archived = message["archived"]?.jsonPrimitive?.booleanOrNull ?: return state
    val requestId = message["requestId"]?.jsonPrimitive?.contentOrNull
    val entry = state.sessions[sessionId]
    if (entry?.agentKind != null && entry.agentKind != agentKind) return state
    val changed = entry?.archived != archived
    return state.copy(
        sessionArchiveRequests = state.sessionArchiveRequests - listOfNotNull(requestId),
        sessionListEpoch = if (changed) state.sessionListEpoch + 1 else state.sessionListEpoch,
    )
}

/** session.browse.result（spec §8.1）：只认当前浏览会话的 requestId，避免旧响应覆盖新导航。 */
private fun reduceSessionBrowseResult(state: RemoteState, message: JsonObject): RemoteState {
    val requestId = message["requestId"]?.jsonPrimitive?.contentOrNull
    val browse = state.sessionBrowse ?: return state
    if (requestId != browse.requestId) return state
    val path = message["path"]?.jsonPrimitive?.contentOrNull
    val parent = message["parent"]?.jsonPrimitive?.contentOrNull
    val entries = runCatching {
        message["entries"]?.let { sessionMessageJson.decodeFromJsonElement<List<SessionBrowseEntry>>(it) }
    }.getOrNull() ?: emptyList()
    return state.copy(
        sessionBrowse = browse.copy(
            path = path ?: "",
            parent = parent,
            entries = entries.sortedWith(
                compareByDescending<SessionBrowseEntry> { it.isDir }
                    .thenByDescending { it.hasSessions }
                    .thenBy(SessionBrowseEntry::name),
            ),
            isLoading = false,
            error = null,
        ),
    )
}

/** session.activated（spec §8）：只证明进程已拉起；会话真正上线由 runtime.online 对账。 */
private fun reduceSessionActivated(state: RemoteState, message: JsonObject): RemoteState {
    val requestId = message["requestId"]?.jsonPrimitive?.contentOrNull
    if (requestId != null && requestId !in state.sessionActivateRequests) return state
    val agentKind = message["agentKind"]?.jsonPrimitive?.contentOrNull ?: return state
    val target = requestId?.let(state.sessionActivateTargets::get)
    val acknowledged = message["sessionId"]?.jsonPrimitive?.contentOrNull
    return state.copy(
        sessionActivateRequests = requestId?.let { state.sessionActivateRequests - it } ?: state.sessionActivateRequests,
        sessionActivateTargets = requestId?.let { state.sessionActivateTargets - it } ?: state.sessionActivateTargets,
        activatedSessionToOpen = target?.takeIf { it == acknowledged } ?: state.activatedSessionToOpen,
        sessionActivation = SessionActivationInfo(
            requestId = requestId ?: "",
            agentKind = agentKind,
            sessionId = message["sessionId"]?.jsonPrimitive?.contentOrNull,
            spawnMode = message["spawnMode"]?.jsonPrimitive?.contentOrNull ?: "tui",
        ),
    )
}

/** A resume acknowledgement and runtime.online may arrive in either order. */
internal fun RemoteState.openAcknowledgedSession(): RemoteState {
    val target = activatedSessionToOpen ?: return this
    val runtime = runtimes.values.firstOrNull { it.sessionId == target } ?: return this
    val selected = cancelForegroundSessionSyncs(runtime.runtimeId)
    return selected.copy(
        activatedSessionToOpen = null,
        selectedRuntimeId = runtime.runtimeId,
        selectedOfflineSessionId = null,
        sessionSyncRequests = if (runtime.sessionGraphSync) selected.sessionSyncRequests + runtime.runtimeId else selected.sessionSyncRequests,
    )
}

/**
 * Releases the foreground paging state for a history command that will never produce a session
 * snapshot. Without this, a failed or superseded history request leaves `loading` stuck and the
 * user can never page older entries again.
 */
internal fun RemoteState.releaseHistoryRequest(commandId: String?): RemoteState {
    if (commandId == null) return this
    val entry = sessionHistory.entries.firstOrNull { it.value.requestId == commandId } ?: return this
    return copy(
        sessionHistory = sessionHistory + (
            entry.key to entry.value.copy(loading = false, requestId = null)
        ),
    )
}

internal fun RemoteState.ownsSessionSnapshot(
    commandId: String,
    runtimeId: String,
    sessionId: String,
    syncId: String,
    targetLeafId: String?,
    range: String? = null,
    beforeEntryId: String? = null,
): Boolean {
    val pending = sessionSyncCommands[commandId] ?: return false
    val runtime = runtimes[runtimeId] ?: return false
    return pending.runtimeId == runtimeId &&
        pending.sessionId == sessionId &&
        pending.syncId == syncId &&
        pending.attempts > 0 &&
        (range == null || pending.range == range) &&
        (pending.requestTargetLeafId == null || pending.requestTargetLeafId == targetLeafId) &&
        pending.beforeEntryId == beforeEntryId &&
        runtime.sessionId == sessionId &&
        pending.branchGeneration == (sessionBranchGenerations[runtimeId] ?: 0) &&
        (pending.historyOperationId == null || ownsHistoryRead(pending.historyOperationId))
}

internal fun syncTargetKey(runtimeId: String, targetLeafId: String?): String = "$runtimeId\u0000${targetLeafId ?: ""}"

/** 确定性失败：重试同一目标没有意义，但不得影响该会话的其它目标。 */
internal fun isDeterministicSessionSyncFailure(code: String?): Boolean = when (code?.lowercase()) {
    "session_entry_too_large", "session_sync_response_too_large", "session_known_state_range_mismatch",
    "session_mismatch", "unsupported_command", "session_sync_device_rejected" -> true
    else -> false
}

/** Host 的背压信号：链路或队列忙，**不是**失败。 */
internal fun isTransientSessionSyncFailure(code: String?): Boolean {
    val value = code?.lowercase() ?: return false
    return "session_sync_busy" in value || "session_sync_path_unavailable" in value
}

/** 背压后的立即重试上限；超过就交给下一次自然事件，避免重试风暴。 */
internal const val MAX_SYNC_BUSY_RETRIES = 3

/**
 * 尝试层闸门（ADR-0037 §5）：只有短时冷却或"该目标被确定性失败挡住"会阻止 preview。
 * `sessionSyncFailures` 只用于显示，不再参与这里。
 */
internal fun RemoteState.syncPreviewBlocked(runtimeId: String, targetLeafId: String?): Boolean =
    sessionSyncFailureCooldowns.containsKey(runtimeId) ||
        syncTargetKey(runtimeId, targetLeafId) in sessionSyncBlockedTargets

internal fun RemoteState.syncPreviewBlocked(task: PendingSessionSync): Boolean =
    task.range == "preview" && syncPreviewBlocked(task.runtimeId, task.requestTargetLeafId ?: task.targetLeafId)

internal fun RemoteState.failSessionSync(
    commandId: String,
    message: String,
    transient: Boolean = false,
    code: String? = null,
): RemoteState {
    val pending = sessionSyncCommands[commandId] ?: return this
    val conversation = conversations[pending.runtimeId] ?: RuntimeConversation()
    if (transient && pending.range == "preview") {
        // 背压：撤掉这次请求，但**不记失败**（记了就会永久挡住 preview）。
        // 只有 preview 走这里：历史翻页是用户动作，失败必须立刻可见可重试。
        val streak = (sessionSyncBusyStreaks[pending.runtimeId] ?: 0) + 1
        val graphSync = runtimes[pending.runtimeId]?.sessionGraphSync == true
        val released = finishRemoteHistoryRead(commandId, HistoryReadPhase.SUPERSEDED).releaseHistoryRequest(commandId)
        return released.copy(
            pendingCommands = released.pendingCommands - commandId,
            sessionSyncCommands = released.sessionSyncCommands - commandId,
            sessionSyncBusyStreaks = released.sessionSyncBusyStreaks + (pending.runtimeId to streak),
            sessionSyncRequests = if (graphSync && streak <= MAX_SYNC_BUSY_RETRIES)
                released.sessionSyncRequests + pending.runtimeId else released.sessionSyncRequests - pending.runtimeId,
            conversations = released.conversations + (pending.runtimeId to (
                released.conversations[pending.runtimeId] ?: RuntimeConversation()
            ).copy(isChatSyncing = false, chatSyncError = null)),
        )
    }
    val released = finishRemoteHistoryRead(commandId, HistoryReadPhase.FAILED, message).releaseHistoryRequest(commandId)
    val deterministic = isDeterministicSessionSyncFailure(code)
    val blockTarget = syncTargetKey(pending.runtimeId, pending.requestTargetLeafId ?: pending.targetLeafId)
    if (pending.range != "preview") return released.copy(
        pendingCommands = released.pendingCommands - commandId,
        sessionSyncCommands = released.sessionSyncCommands - commandId,
        sessionRangeFailures = released.sessionRangeFailures + (sessionRangeFailureKey(pending.runtimeId, pending.range) to message),
    )
    return released.copy(
        pendingCommands = pendingCommands - commandId,
        sessionSyncCommands = sessionSyncCommands - commandId,
        sessionSyncRequests = if (pending.demandGeneration != null &&
            pending.demandGeneration != (sessionSyncDemandGenerations[pending.runtimeId] ?: 0L)) sessionSyncRequests
            else sessionSyncRequests - pending.runtimeId,
        sessionSyncFailures = sessionSyncFailures + (pending.runtimeId to message),
        sessionSyncFailureCooldowns = if (deterministic) sessionSyncFailureCooldowns - pending.runtimeId
            else sessionSyncFailureCooldowns + (pending.runtimeId to 0),
        sessionSyncBlockedTargets = if (deterministic) sessionSyncBlockedTargets + blockTarget else sessionSyncBlockedTargets,
        conversations = conversations + (pending.runtimeId to conversation.copy(
            isChatSyncing = false, chatSyncError = message, revision = conversation.revision + 1,
        )),
    )
}

/** The runtime metadata supplies freshness; the local page supplies its immutable contents. */
internal fun RemoteState.seedCachedSessionView(runtimeId: String, graph: SessionGraph, cachedFirstPage: Boolean = false): RemoteState {
    val runtime = runtimes[runtimeId] ?: return this
    if (runtime.sessionId != graph.sessionId) return this
    val conversation = conversations[runtimeId] ?: RuntimeConversation()
    if (conversation.sourceEpoch != null && !conversation.sourceReady && !cachedFirstPage) return this
    val previousView = runtimeSessionViews[runtimeId]?.takeIf { it.sessionId == graph.sessionId }
    val leaf = if (conversation.sourceEpoch != null && conversation.sourceReady &&
        (!cachedFirstPage || !conversation.forceSourceSnapshot)) conversation.sourceHeadLeafId
        else if (cachedFirstPage) listOfNotNull(previousView?.leafId, runtime.sessionLeafId,
            conversation.sourceHeadLeafId, graph.cursor.leafId).firstOrNull { it in graph.entries }
        else runtime.sessionLeafId
    if (leaf != null && !graph.entries.containsKey(leaf)) return this
    if (conversation.hasLiveSnapshot && previousView != null && previousView.leafId == leaf &&
        !conversation.isChatSyncing
    ) return this
    val branchChanged = conversation.sourceEpoch == null && previousView != null && graph.isKnownBranchChange(previousView.leafId, leaf)
    val source = if (branchChanged) RuntimeConversation(revision = conversation.revision) else conversation
    val sameBranch = previousView != null &&
        (previousView.leafId == leaf || graph.isDescendant(leaf, previousView.leafId))
    val baseMessages = source.messages.filterNot { it.messageId in source.streamingMessageIds }
    val projection = (if (sameBranch) {
        mergeTemporaryOlderMessages(
            graph.projectLeafDeltaProjection(
                previousView?.leafId, leaf, canonicalRowsForDeltaProjection(baseMessages, graph),
            ),
            graph, baseMessages,
        )
    } else projectSessionGraph(graph.copy(cursor = SessionBranchCursor(leaf))))
        .let { if (it.error == "missing_parent") it.copy(error = null) else it }
    val (messages, overlay) = mergeProjectedWithStreaming(projection.messages, source)
    val branch = buildSessionPath(graph.entries, leaf)
    val invalidated = if (branchChanged) sessionSyncCommands.filterValues { it.runtimeId == runtimeId }.keys else emptySet()
    val history = sessionHistory[runtimeId]?.takeIf { sameBranch && it.sessionId == graph.sessionId }
    return copy(
        pendingCommands = pendingCommands - invalidated,
        sessionSyncCommands = sessionSyncCommands - invalidated,
        sessionBranchGenerations = if (branchChanged) sessionBranchGenerations +
            (runtimeId to ((sessionBranchGenerations[runtimeId] ?: 0) + 1)) else sessionBranchGenerations,
        conversations = conversations + (runtimeId to source.applyProjection(projection, messages, keepLiveTiming = !branchChanged).copy(
            // Cached rows can render the old head, but cannot complete source recovery.
            hasLiveSnapshot = true, isChatSyncing = source.sourceEpoch != null && source.isChatSyncing, streamingMessageIds = overlay,
            chatSyncError = if (cachedFirstPage) conversation.chatSyncError else projection.error,
            streamingSessionId = graph.sessionId.takeIf { overlay.isNotEmpty() }, revision = conversation.revision + 1,
        )),
        runtimeSessionViews = runtimeSessionViews + (runtimeId to RuntimeSessionView(runtimeId, graph.sessionId, leaf)),
        sessionHistory = sessionHistory + (runtimeId to (history?.copy(leafId = leaf)
            ?: SessionHistoryState(graph.sessionId, leaf, branch.firstOrNull()?.entryId, branch.firstOrNull()?.parentId != null))),
    ).reconcileHistoryReads()
}

private fun RemoteState.isKnownBranchChange(
    sessionId: String?,
    previousLeafId: String?,
    nextLeafId: String?,
): Boolean {
    if (sessionId == null) return false
    return (sessionGraphs[sessionId] ?: SessionGraph(sessionId)).isKnownBranchChange(previousLeafId, nextLeafId)
}

private fun SessionGraph.isKnownBranchChange(previousLeafId: String?, nextLeafId: String?): Boolean {
    if (previousLeafId == null || previousLeafId == nextLeafId) return false
    if (nextLeafId == null) return true
    if (!entries.containsKey(nextLeafId)) return false
    if (isDescendant(nextLeafId, previousLeafId)) return false
    val previousPath = buildSessionPath(entries, previousLeafId).map { it.entryId }.toSet()
    val nextPath = buildSessionPath(entries, nextLeafId)
    // Two disconnected fragments cannot prove a branch change; their missing parent may still
    // join them. A complete target chain proves divergence even if the old leaf left the window.
    return nextPath.firstOrNull()?.parentId == null || nextPath.any { it.entryId in previousPath }
}

private fun RuntimeSummary.sessionView(runtimeId: String): RuntimeSessionView? = sessionId?.let { id ->
    RuntimeSessionView(
        runtimeId = runtimeId,
        sessionId = id,
        leafId = sessionLeafId,
    )
}


internal fun initialSessionSyncRange(
    conversation: RuntimeConversation?,
    knownLeafId: String?,
): String = if (conversation?.hasLiveSnapshot != true || knownLeafId == null) {
    "preview"
} else {
    "catchup"
}

/**
 * Invalidates only the selected Runtime's display snapshot. The next loader pass requests a
 * fresh preview while preserving the current messages until the replacement arrives.
 */
internal fun RemoteState.requestRuntimeRefresh(runtimeId: String): RemoteState {
    if (selectedRuntimeId != runtimeId || runtimeId in sessionSyncFailures ||
        conversations[runtimeId]?.chatSyncError != null) return this
    val runtime = runtimes[runtimeId] ?: return this
    val conversation = conversations[runtimeId] ?: RuntimeConversation()
    // A refresh response is a persisted projection, while the current turn is a separate live
    // overlay. They can be reconciled while the Runtime is running: seedCachedSessionView keeps
    // the active turn/live rows and projects the snapshot underneath them. Blocking here made a
    // dropped event during a running turn unrecoverable until the turn became idle.
    if (!runtime.sessionGraphSync) return this
    // A periodic refresh reconciles the Session Graph in the background. Once the conversation
    // already has displayable content, keep that snapshot live while the preview/catch-up request
    // is in flight; invalidating it here makes the UI flash its loading indicator and re-anchor
    // the list on every poll. Only a conversation without a snapshot needs a blocking load state.
    val needsDisplayLoad = conversation.hasLiveSnapshot != true
    return copy(
        conversations = conversations + (
            runtimeId to conversation.copy(
                hasLiveSnapshot = if (needsDisplayLoad) false else conversation.hasLiveSnapshot,
                isChatSyncing = if (needsDisplayLoad) true else conversation.isChatSyncing,
                chatSyncError = null,
            )
        ),
        sessionSyncDemandGenerations = sessionSyncDemandGenerations +
            (runtimeId to ((sessionSyncDemandGenerations[runtimeId] ?: 0) + 1)),
        sessionSyncRequests = sessionSyncRequests + runtimeId,
    )
}

/**
 * Starts the display refresh owned by a successful history/tree action.
 *
 * The action's metadata precedes its command result. Invalidate the old tasks and display together,
 * then let the shared loader project that current leaf from cache or request its missing range.
 */
internal fun RemoteState.requestBranchRefresh(runtimeId: String): RemoteState {
    if (selectedRuntimeId != runtimeId) return this
    val runtime = runtimes[runtimeId] ?: return this
    if (!runtime.sessionGraphSync || runtime.sessionId == null) return this
    val staleCommands = sessionSyncCommands.filterValues { it.runtimeId == runtimeId }.keys
    val generation = (sessionBranchGenerations[runtimeId] ?: 0) + 1
    val conversation = conversations[runtimeId] ?: RuntimeConversation()
    // A newer turn may have started before Compose consumes the action's result. Keep its live
    // overlay while replacing only the persisted branch underneath it.
    val live = conversation.takeIf { runtime.status == "running" }
    return copy(
        pendingCommands = pendingCommands - staleCommands,
        sessionSyncCommands = sessionSyncCommands - staleCommands,
        sessionSyncFailures = sessionSyncFailures - runtimeId,
        sessionRangeFailures = sessionRangeFailures.filterKeys { !it.startsWith("$runtimeId\u0000") },
        sessionSyncRequests = sessionSyncRequests + runtimeId,
        sessionBranchGenerations = sessionBranchGenerations + (runtimeId to generation),
        runtimeSessionViews = runtimeSessionViews - runtimeId,
        sessionHistory = sessionHistory - runtimeId,
        // Do not let rows from the old branch remain attached to the new projection while the
        // authoritative snapshot is in flight. The existing chat refresh/anchor machinery will
        // position the replacement at the new leaf when it settles.
        conversations = conversations + (runtimeId to RuntimeConversation(
            sourceEpoch = conversation.sourceEpoch,
            sourceSeq = conversation.sourceSeq,
            sourceReady = conversation.sourceReady,
            sourceHeadLeafId = conversation.sourceHeadLeafId,
            retiredSourceEpochs = conversation.retiredSourceEpochs,
            messages = live?.messages.orEmpty().filter { it.messageId in live?.streamingMessageIds.orEmpty() },
            streamingMessageIds = live?.streamingMessageIds.orEmpty(),
            streamingSessionId = live?.streamingSessionId,
            turnTimings = live?.turnTimings.orEmpty().filterValues { it.durationMs == null },
            activeTurnId = live?.activeTurnId,
            tools = live?.tools.orEmpty().filterValues { it.state != "finished" },
            isChatSyncing = true,
            interactions = conversation.interactions,
            waitingLocalInteraction = conversation.waitingLocalInteraction,
            revision = conversation.revision + 1,
        )),
    ).reconcileHistoryReads()
}

internal fun shouldStartBranchCatchUpImmediately(
    conversation: RuntimeConversation?,
    hasInMemoryGraph: Boolean,
): Boolean = hasInMemoryGraph && conversation?.hasLiveSnapshot == true

private fun RuntimeSummary.isSyncPending(
    selectedRuntimeId: String?,
    graphs: Map<String, SessionGraph>,
): Boolean = sessionGraphSync &&
    runtimeId == selectedRuntimeId && sessionId != null && sessionLeafId != null &&
    (graphs[sessionId]?.hasCompleteEntryChain(sessionLeafId) != true)

private fun previousViewNeedsRefresh(state: RemoteState, runtime: RuntimeSummary): Boolean =
    state.runtimeSessionViews[runtime.runtimeId]?.let { view ->
        view.sessionId != runtime.sessionId || view.leafId != runtime.sessionLeafId
    } ?: true

private fun RuntimeSummary.catalogEntry(): SessionCatalogEntry? = sessionId?.let { id ->
    SessionCatalogEntry(
        sessionId = id,
        // Empty means the current runtime is explicitly unnamed, so a cleared title
        // must not be resurrected by the catalog's missing-field merge fallback.
        name = sessionName?.trim().orEmpty(),
        cwd = cwd,
        hostname = hostname,
        modifiedAt = 0,
        messageCount = 0,
        // 在线进程合入目录时也要带 agentKind（codex 是固定虚拟 runtimeId，Pi 是 UUID），
        // 否则侧栏在 session.list 刷新前无法给在线 codex 会话画角标。
        agentKind = agentKind,
    )
}

/** codex 的固定虚拟 runtimeId（host 侧同值）。Pi 的 runtimeId 是随机 UUID，不会撞。 */
const val CODEX_RUNTIME_ID = "codex"

internal val CachedSessionRow.agentKind: String get() = catalogEntry?.agentKind ?: "unknown"

/** 该侧栏行是不是 codex 会话：目录条目优先，在线 runtime 兜底（session.list 未刷新时条目可能为 null）。 */
internal val CachedSessionRow.isCodex: Boolean
    get() = catalogEntry?.agentKind in setOf("codex", "codexDesktop")

internal val CachedSessionRow.isArchived: Boolean
    get() = catalogEntry?.archived == true

private fun mergeSessionCatalog(
    sessions: Map<String, SessionCatalogEntry>,
    incoming: Collection<SessionCatalogEntry>,
): Map<String, SessionCatalogEntry> = incoming.fold(sessions) { current, entry ->
    current + (entry.sessionId to mergeSessionCatalogEntry(current[entry.sessionId], entry))
}

/** One sidebar row inside a directory group: a Session (online or offline) and its resolved title. */
internal data class CachedSessionRow(
    val sessionId: String,
    /** Online row carries the current Runtime id; offline row keeps this null. */
    val runtimeId: String?,
    val isOnline: Boolean,
    val cwd: String,
    val hostname: String,
    /** Cached catalog entry, kept so the sidebar can fall back to the legacy `firstMessage`. */
    val catalogEntry: SessionCatalogEntry?,
    val title: String,
    val messageCount: Int,
    val modifiedAt: Long,
)

/** One directory node in the cached-history tree. */
internal data class CachedDirectoryGroup(
    val cwd: String,
    val sessions: List<CachedSessionRow>,
) {
    val modifiedAt: Long
        get() = sessions.maxOfOrNull(CachedSessionRow::modifiedAt) ?: 0L
}

/** The paired Host owns the entire authenticated directory and its device-scoped cache. */
internal data class CachedHostGroup(
    val hostId: String,
    val hostname: String,
    val directories: List<CachedDirectoryGroup>,
)

internal data class SessionHost(val hostId: String, val name: String)

/**
 * Host identity comes only from pairing. Legacy hostname metadata may supply a display label,
 * but missing, stale or conflicting labels cannot create another Host or change ownership.
 */
internal val RemoteState.sessionHost: SessionHost?
    get() {
        val id = hostId?.takeIf(String::isNotBlank) ?: return null
        val label = hostName?.takeIf(String::isNotBlank)
            ?: (sessions.values.map { it.hostname } + runtimes.values.map { it.hostname })
                .mapNotNull { it?.takeIf(String::isNotBlank) }.distinct().singleOrNull()
            ?: "已配对电脑"
        return SessionHost(id, label)
    }

internal val RemoteState.canOperateSessions: Boolean
    get() = !hostId.isNullOrBlank() && connection == RelayConnection.ONLINE && e2eReady

internal fun RemoteState.canCreateSessionOn(expectedHostId: String?): Boolean =
    canOperateSessions && expectedHostId == hostId && sessionActivateRequests.isEmpty()

/**
 * Builds the sidebar tree (`host -> directory -> session`). Online runtimes and offline catalog
 * Sessions share one tree, and a Session currently open by an online Runtime takes precedence over
 * any cached entry for the same sessionId. All surfaces resolve the title through
 * sessionDisplayName: agent-provided name, then a first-user-message preview.
 *
 * 侧栏是**聊天记录的全量目录**：电脑上存在过的会话都要出现，不管手机有没有缓存过它。
 * 只看 `hasHistoryCache` 会把「电脑上有、本机没打开过」的会话藏起来，而那正是用户要
 * 找的东西——没缓存的会话点一下就把会话加载进一个进程（§8.1），不需要先有缓存。
 */
internal fun cachedHistoryTree(state: RemoteState): List<CachedHostGroup> {
    val host = state.sessionHost ?: return emptyList()
    val runtimesBySession = state.runtimes.values
        .filter { it.sessionId != null }
        .sortedBy(state::runtimeDisplayName)
        .groupBy { it.sessionId.orEmpty() }
    val rows = linkedMapOf<String, CachedSessionRow>()
    for ((sessionId, runtimes) in runtimesBySession) {
        val runtime = runtimes.firstOrNull() ?: continue
        // An online Session merged into the catalog before its identity domain arrived has no
        // agentKind yet; the runtime's committed identity fills it (Claude has no catalog row then).
        val session = (state.sessions[sessionId] ?: runtime.catalogEntry())
            ?.let { entry -> if (entry.agentKind == null && runtime.agentKind != null) entry.copy(agentKind = runtime.agentKind) else entry }
        rows[sessionId] = CachedSessionRow(
            sessionId = sessionId,
            runtimeId = runtime.runtimeId,
            isOnline = true,
            cwd = runtime.cwd.ifBlank { session?.cwd.orEmpty() },
            hostname = host.name,
            catalogEntry = session,
            title = state.runtimeDisplayName(runtime),
            messageCount = state.conversations[runtime.runtimeId]?.messages?.size ?: 0,
            modifiedAt = session?.modifiedAt ?: 0L,
        )
    }
    for (session in state.sessions.values) {
        if (rows.containsKey(session.sessionId)) continue
        rows[session.sessionId] = CachedSessionRow(
            sessionId = session.sessionId,
            runtimeId = null,
            isOnline = false,
            cwd = session.cwd,
            hostname = host.name,
            catalogEntry = session,
            title = state.sessionDisplayName(session.sessionId),
            messageCount = session.messageCount,
            modifiedAt = session.modifiedAt,
        )
    }
    val directories = rows.values
        .groupBy { it.cwd }
        .values
        .map { directoryRows ->
            CachedDirectoryGroup(
                cwd = directoryRows.first().cwd,
                sessions = directoryRows.sortedWith(
                    compareByDescending<CachedSessionRow> { it.sortKey() }
                        .thenBy { it.sessionId },
                )
            )
        }
        .sortedWith(
            compareByDescending<CachedDirectoryGroup> { it.modifiedAt }
                .thenBy { it.cwd },
        )
    return listOf(CachedHostGroup(host.hostId, host.name, directories))
}

/**
 * The sidebar tree for every paired computer. Ownership stays in the group's `hostId`, so a
 * Session ID that exists on two computers resolves to two distinct rows instead of collapsing.
 */
internal fun cachedHistoryTree(states: List<RemoteState>): List<CachedHostGroup> =
    states.flatMap(::cachedHistoryTree)

/**
 * Newest-first sort key for a row. Online Sessions are treated as freshest (current time) so they
 * surface at the top of a directory even when the catalog has not seen their first message yet;
 * cached entries fall back to the catalog's `modifiedAt` and finally the sessionId hash.
 */
private fun CachedSessionRow.sortKey(): Long = when {
    isOnline && catalogEntry == null -> Long.MAX_VALUE
    else -> catalogEntry?.modifiedAt ?: sessionId.hashCode().toLong()
}

private fun RuntimeConversation.withoutActiveTurn(): RuntimeConversation {
    // Directory and ctl status are hints; only a source transaction can finish a replicated turn.
    if (sourceEpoch != null) return this
    val activeId = activeTurnId ?: return this
    return copy(
        turnTimings = turnTimings - activeId,
        activeTurnId = null,
    )
}

private fun completedTurnTimingsFor(
    turnTimings: Map<String, TurnTiming>,
    messages: List<ChatMessage>,
): Map<String, TurnTiming> {
    val messageIds = messages.map(ChatMessage::messageId).toSet()
    return turnTimings.filterValues { timing ->
        timing.durationMs != null && (timing.messageId == null || timing.messageId in messageIds)
    }
}

private fun RuntimeConversation.applyProjection(
    projection: SessionProjectionResult,
    messages: List<ChatMessage> = projection.messages,
    keepLiveTiming: Boolean = false,
): RuntimeConversation {
    val projectedTimings = projection.turnTimings.associateBy(TurnTiming::turnId)
    val liveTimings = if (keepLiveTiming) {
        turnTimings.filterValues { it.durationMs == null }
    } else {
        emptyMap()
    }
    val completed = completedTurnTimingsFor(
        turnTimings.filterValues { it.durationMs != null } + projectedTimings,
        messages,
    )
    return copy(
        messages = messages,
        turnTimings = liveTimings + completed,
        activeTurnId = activeTurnId?.takeIf {
            liveTimings[it] != null && projectedTimings[it]?.durationMs == null
        },
        // A stream that is no longer displayed cannot receive deltas, so keep the marker set
        // bounded by the rows that are still on screen.
        finishedMessageIds = finishedMessageIds.filterTo(mutableSetOf()) { id ->
            messages.any { it.messageId == id }
        },
        tools = reconcileToolActivity(messages),
    )
}

/**
 * Tool cards below the conversation are only a live fallback for tool calls the projection does not
 * show yet. A projection is authoritative for persisted messages, so a finished tool whose id is no
 * longer anywhere in the branch (for example behind a compaction boundary or a replaced range) would
 * otherwise keep a stale result card pinned to the bottom of the chat forever.
 */
private fun RuntimeConversation.reconcileToolActivity(messages: List<ChatMessage>): Map<String, ToolActivity> {
    if (tools.isEmpty()) return tools
    val represented = messages.flatMap { message ->
        message.content.mapNotNull(RemoteContent::toolCallId)
    }.toSet()
    return tools.filterValues { activity ->
        activity.state != "finished" || activity.toolCallId in represented
    }
}

/**
 * The leaf-delta projection may only see rows the canonical tree already carries. Every other
 * displayed row is an ephemeral preview/history page, and [mergeTemporaryOlderMessages] re-anchors
 * those *above* the window. Feeding them to the projection instead classifies them as live overlays
 * and appends them after the newest canonical message, so an old paged-in message keeps jumping to
 * the bottom on every leaf advance until the app is restarted.
 */
private fun canonicalRowsForDeltaProjection(
    messages: List<ChatMessage>,
    graph: SessionGraph,
): List<ChatMessage> = messages.filter { graph.entries.containsKey(it.messageId) }

/**
 * Forward projections are built from the canonical tree, which is only a bounded window of the
 * branch. Temporary preview/history messages displayed above that window are deliberately never
 * written into the canonical tree, so a forward projection would drop the older messages the user
 * already paged in. Re-attach those messages, in order, ahead of the projected branch.
 */
private fun mergeTemporaryOlderMessages(
    projection: SessionProjectionResult,
    graph: SessionGraph,
    currentMessages: List<ChatMessage>,
): SessionProjectionResult {
    if (currentMessages.isEmpty()) return projection
    val projectedIds = projection.messages.mapTo(mutableSetOf(), ChatMessage::messageId)
    val olderTemporary = currentMessages.filter { message ->
        message.messageId !in projectedIds &&
            !graph.entries.containsKey(message.messageId) &&
            !projection.messages.represents(message)
    }
    if (olderTemporary.isEmpty()) return projection
    return projection.copy(messages = olderTemporary + projection.messages)
}

private fun RuntimeConversation.bindActiveTurn(message: ChatMessage): RuntimeConversation {
    if (message.role != "assistant") return this
    val activeId = activeTurnId ?: return this
    val timing = turnTimings[activeId] ?: return this
    if (timing.durationMs != null || timing.messageId != null) return this
    return copy(turnTimings = turnTimings + (activeId to timing.copy(messageId = message.messageId)))
}

private fun remapMessageId(messages: List<ChatMessage>, from: String, to: String): List<ChatMessage> {
    if (from == to) return messages
    // The entry id is canonical. A duplicate remap can arrive after the canonical row was already
    // projected; never replace or delete that row with a stale live representation. This also
    // makes the operation idempotent when the same turn.finished is replayed.
    if (messages.any { it.messageId == to }) {
        return messages.filterNot { it.messageId == from }
    }
    return messages.mapNotNull { message ->
        when (message.messageId) {
            from -> message.copy(messageId = to)
            to -> null
            else -> message
        }
    }
}

/** One `live id -> Pi entry id` pair reported by the Runtime when a turn is persisted. */
internal data class MessageIdRemap(val liveId: String, val entryId: String)

/**
 * Reads the authoritative id mapping the Runtime sends with `turn.finished`. Pi allocates an entry id
 * only once a message is appended, so only the Runtime can publish which streamed row became which
 * entry; without it a device would have to guess by matching message text.
 */
private fun JsonObject.persistedMessageRemaps(): List<MessageIdRemap> {
    val rows = this["persistedMessages"] as? JsonArray ?: return emptyList()
    return rows.mapNotNull { element ->
        val row = element as? JsonObject ?: return@mapNotNull null
        val liveId = row["messageId"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
        val entryId = row["entryId"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
        MessageIdRemap(liveId, entryId)
    }
}

/**
 * Reconciles live lifecycle rows with the authoritative Session projection. Pi emits a temporary
 * message before SessionManager appends its entry, so matching by message id alone would leave a
 * live row behind after the turn's graph sync. The Runtime publishes the live-id -> entry-id
 * mapping in `turn.finished`, and once that arrives `remapMessageId` makes the ids match here;
 * rows the projection does not carry yet (an in-flight response) stay visible as overlays.
 *
 * `represents` is the narrow net for the window before that mapping arrives: it only absorbs a row
 * that is already byte-identical to a projected message. It deliberately tolerates no partial
 * text — a prefix rule would also fuse two consecutive replies where the later one happens to
 * begin with the earlier one, which is how a duplicated bubble appears in the first place.
 */
internal fun mergeProjectedWithStreaming(
    projectedMessages: List<ChatMessage>,
    conversation: RuntimeConversation,
): Pair<List<ChatMessage>, Set<String>> {
    val projectedIds = projectedMessages.mapTo(mutableSetOf(), ChatMessage::messageId)
    val retainedOverlays = conversation.messages
        .filter { it.messageId in conversation.streamingMessageIds }
        .filter {
            it.messageId !in projectedIds &&
                // An unfinished stream has no stable canonical body. Text equality is not an
                // identity signal here: a partial reply can equal an older persisted message.
                // Only a message that reached its terminal event may use the narrow fallback.
                (conversation.sourceEpoch != null || it.messageId !in conversation.finishedMessageIds || !projectedMessages.represents(it))
        }
    return projectedMessages + retainedOverlays to retainedOverlays.map(ChatMessage::messageId).toSet()
}

/** Apply a complete source checkpoint after the canonical projection has been built. */
private fun RuntimeConversation.applySourceLiveCheckpoint(
    source: SessionSourceEpoch,
    live: SessionLiveState,
    replaceInventory: Boolean = live.complete,
): RuntimeConversation {
    val canonicalIds = messages.mapTo(mutableSetOf(), ChatMessage::messageId)
    val incomingById = live.messages.associateBy { it.message.messageId }
    val previousOverlayIds = streamingMessageIds
    val retained = messages.filter { message ->
        message.messageId !in previousOverlayIds || !replaceInventory || message.messageId in incomingById
    }.toMutableList()
    val overlayIds = if (replaceInventory) mutableSetOf() else previousOverlayIds.toMutableSet()
    val finished = if (replaceInventory) mutableSetOf() else finishedMessageIds.toMutableSet()
    for (item in live.messages) {
        val liveId = item.message.messageId
        val canonicalId = item.persistedEntryId
        if (canonicalId != null && canonicalId in canonicalIds) {
            // Canonical projection wins over a stale or partial live representation.
            retained.removeAll { it.messageId == liveId }
            overlayIds.remove(liveId)
            finished.remove(liveId)
            continue
        }
        val index = retained.indexOfFirst { it.messageId == liveId }
        if (index >= 0) retained[index] = item.message
        else retained += item.message
        overlayIds += liveId
        if (item.finished) finished += liveId else finished -= liveId
    }
    val displayed = retained
    val checkpointTurn = live.turn
    val retainedTimings = if (replaceInventory) {
        turnTimings.filterValues { it.durationMs != null }
    } else {
        turnTimings
    }.toMutableMap()
    if (checkpointTurn != null) {
        retainedTimings[checkpointTurn.turnId] = TurnTiming(
            checkpointTurn.turnId, checkpointTurn.startedAt, checkpointTurn.durationMs,
        )
    }
    val checkpointTools = live.tools.associate { tool ->
        tool.toolCallId to ToolActivity(
            toolCallId = tool.toolCallId,
            toolName = tool.toolName,
            state = tool.state,
            detail = tool.detail?.toString(),
            isError = tool.isError == true,
            summary = tool.summary,
        )
    }
    val mergedTools = if (replaceInventory) checkpointTools else tools + checkpointTools
    return copy(
        messages = displayed,
        streamingMessageIds = overlayIds.filter { id -> displayed.any { it.messageId == id } }.toSet(),
        finishedMessageIds = finished,
        streamingSessionId = source.epoch.takeIf { overlayIds.isNotEmpty() },
        sourceEpoch = source.epoch,
        sourceSeq = source.seq,
        sourceReady = source.ready,
        hasLiveSnapshot = true,
        turnTimings = retainedTimings,
        activeTurnId = checkpointTurn?.takeIf { it.durationMs == null }?.turnId
            ?: activeTurnId.takeIf { !replaceInventory },
        tools = mergedTools,
    )
}

/** Checkpoints and patches publish the same complete source state through this entry point. */
private fun RuntimeConversation.applyCompleteSourceState(
    sessionId: String,
    source: SessionSourceEpoch,
    head: SessionBranchCursor,
    live: SessionLiveState,
    graph: SessionGraph,
): RuntimeConversation {
    val headAvailable = head.leafId == null || head.leafId in graph.entries
    val projection = if (!headAvailable) SessionProjectionResult(emptyList())
        else projectSessionGraph(graph.copy(cursor = head))
    // A proven forward append keeps older paged ancestors just like an unchanged head. A rewind
    // or another branch must still remove rows outside its authoritative path.
    val sameBranch = sourceHeadLeafId == head.leafId || graph.isDescendant(head.leafId, sourceHeadLeafId)
    val canonical = if (sourceEpoch == source.epoch && sameBranch && headAvailable) {
        mergeTemporaryOlderMessages(projection, graph, messages.filterNot { it.messageId in streamingMessageIds })
    } else projection
    return applyProjection(canonical, keepLiveTiming = false)
        .copy(streamingMessageIds = emptySet(), finishedMessageIds = emptySet())
        .applySourceLiveCheckpoint(source, live, replaceInventory = true)
        .copy(
            sourceHeadLeafId = head.leafId,
            streamingSessionId = sessionId.takeIf { live.messages.isNotEmpty() },
            hasLiveSnapshot = headAvailable,
            isChatSyncing = !headAvailable,
            chatSyncError = null,
            sourceRecoveryRetryAt = 0,
            systemNotice = null,
            revision = revision + 1,
        )
}

private fun boundedSourcePatches(patches: Map<Long, SessionPatch>): Map<Long, SessionPatch> {
    // Patches currently carry complete live bodies. A count limit alone permits unbounded text.
    var remainingChars = 512 * 1024
    val retained = linkedMapOf<Long, SessionPatch>()
    for ((seq, patch) in patches.toSortedMap()) {
        val size = sessionMessageJson.encodeToString(SessionPatch.serializer(), patch).length
        if (retained.size >= 64 || size > remainingChars) break
        retained[seq] = patch
        remainingChars -= size
    }
    return retained
}

private fun RuntimeConversation.replaySourcePatches(sessionId: String, graph: SessionGraph): RuntimeConversation {
    var current = copy(sourcePatchBuffer = sourcePatchBuffer.filterValues {
        it.source.epoch == sourceEpoch && it.seq > sourceSeq
    })
    while (current.sourceReady) {
        val patch = current.sourcePatchBuffer.values.firstOrNull { it.baseSeq == current.sourceSeq } ?: break
        if (patch.source.seq != patch.seq || patch.seq <= patch.baseSeq || !patch.source.ready ||
            patch.headCompleteness != "complete" || !patch.live.complete) break
        current = current.applyCompleteSourceState(sessionId, patch.source, patch.head, patch.live, graph)
            .copy(sourcePatchBuffer = current.sourcePatchBuffer.filterKeys { it > patch.seq })
    }
    return current.copy(isChatSyncing = !current.sourceReady || !current.hasLiveSnapshot || current.sourcePatchBuffer.isNotEmpty())
}

/**
 * True when the branch already carries this live or temporary row: same role, identical content and
 * not older than the row itself when both timestamps are usable. A missing timestamp cannot be
 * used to establish ordering, so identity and finalized content are sufficient in that case.
 *
 * The ordering check matters even with identical text: a user who sends the same short message
 * twice ("继续") produces two genuinely different rows, and only the newer one can be the twin of a
 * row that is still waiting for its id mapping.
 */
internal fun List<ChatMessage>.represents(row: ChatMessage): Boolean = any { candidate ->
    candidate.role == row.role &&
        candidate.content == row.content &&
        (
            candidate.timestamp >= row.timestamp ||
                candidate.timestamp <= 0L ||
                row.timestamp <= 0L
            )
}

private fun canAdvanceQueuedMessageState(current: String?, incoming: String): Boolean = when {
    current == null || current == incoming -> true
    current == "accepted" && incoming in setOf("delivered", "rejected", "cancelled", "not_cancelable") -> true
    else -> false
}

internal fun RemoteState.markReconnecting(preserveError: Boolean = false): RemoteState {
    // A response command may be in flight when the phone disappears. Its outcome is
    // unknown, so keep the request and let the next interaction.snapshot reconcile it.
    val interactionCommandIds = conversations.values
        .flatMap { conversation -> conversation.interactions.values.mapNotNull(PendingInteraction::responseCommandId) }
        .toSet()
    val interrupted = pendingCommands.keys - interactionCommandIds
    val pausedDownloads = downloads.mapValues { (_, task) ->
        if (task.status in setOf("queued", "downloading")) {
            task.copy(status = "paused", commandId = null, error = "连接已断开，可在重连后继续")
        } else task
    }
    return copy(
        connection = RelayConnection.RECONNECTING,
        toolInventories = emptyMap(), pendingToolConversations = emptyMap(),
        toolDetail = toolDetail?.copy(requestId = null, read = null, follow = false, error = "连接已断开，仅显示已缓存内容"),
        currentProviders = emptyMap(),
        // 断开即没有加密通道：这条信息比 connection 更贴近「能不能干活」。
        e2eReady = false,
        conversations = conversations.mapValues { (_, conversation) ->
            conversation.withoutActiveTurn().copy(
                interactions = conversation.interactions.mapValues { (_, interaction) ->
                    interaction.copy(responseCommandId = null)
                },
            )
        },
        downloads = pausedDownloads,
        pendingCommands = emptyMap(),
        pendingDownloads = emptyMap(),
        commandResults = (commandResults - interactionCommandIds) + interrupted.filterNot { it.isSessionSyncCommandId() }.associateWith {
            CommandResult(ok = false, status = "cancelled")
        },
        sessionSyncCommands = emptyMap(),
        sessionSyncFailures = emptyMap(), sessionSyncBusyStreaks = emptyMap(), sessionSyncFailureCooldowns = emptyMap(), sessionSyncBlockedTargets = emptySet(),
        sessionRangeFailures = emptyMap(),
        sessionSyncRequests = emptySet(),
        sessionHistory = sessionHistory.mapValues { (_, history) -> history.copy(loading = false, requestId = null) },
        error = error.takeIf { preserveError },
    ).reconcileHistoryReads()
}

class RelayReducer(
    private val json: Json = Json { ignoreUnknownKeys = true },
) {
    /**
     * `committed` is supplied by the connection layer after the batch has been written to and read
     * back from SessionGraphStore: the projection's input is what the store holds, not what the wire
     * just carried. Tests and the cache-failure fallback leave it null, which intentionally uses the
     * wire entries directly for a live preview.
     */
    fun reduce(
        state: RemoteState,
        payload: String,
        committed: CommittedSessionBatch? = null,
        channel: String? = null,
    ): RemoteState {
        reduceToolEnvelope(state, payload, committed, channel)?.let { return it }
        val event = runCatching { json.parseToJsonElement(payload).jsonObject["event"]?.jsonObject }.getOrNull()
        val syncId = event?.takeIf { it.string("type") == "session.snapshot" }?.string("syncId")
        val commandId = syncId?.let { id -> state.sessionSyncCommands.entries.firstOrNull { it.value.syncId == id }?.key }
        val input = commandId?.let(state::recoverLateHistoryRead) ?: state
        var reduced = reducePayload(input, materializeToolPayload(input, payload), committed, channel)
        val ownershipChanged = input.runtimes.keys.filter { runtime ->
            input.runtimes[runtime]?.sessionId != reduced.runtimes[runtime]?.sessionId ||
                input.runtimes[runtime]?.agentKind != reduced.runtimes[runtime]?.agentKind
        }.toSet()
        if (ownershipChanged.isNotEmpty()) reduced = reduced.copy(toolInventories = reduced.toolInventories - ownershipChanged,
            pendingToolConversations = reduced.pendingToolConversations - ownershipChanged,
            toolDetail = reduced.toolDetail?.takeUnless { it.runtimeId in ownershipChanged })
        val changedTargets = reduced.runtimes.keys.filterTo(mutableSetOf()) { key ->
            val old = input.runtimes[key]
            val next = reduced.runtimes[key]
            old?.sessionId != next?.sessionId || old?.sessionLeafId != next?.sessionLeafId
        }
        val runtimeId = runCatching { json.parseToJsonElement(payload).jsonObject.string("runtimeId") }.getOrNull()
        if (event?.string("type") == "session.patch" && runtimeId != null && runtimeId in reduced.sessionSyncRequests &&
            reduced.conversations[runtimeId]?.sourcePatchBuffer != input.conversations[runtimeId]?.sourcePatchBuffer) changedTargets += runtimeId
        val response = event?.takeIf { it.string("type") == "session.snapshot" }?.let {
            runCatching { json.decodeFromJsonElement<SessionGraphSnapshot>(it) }.getOrNull()
        }
        val completed = if (event?.string("type") in setOf("session.snapshot", "session.patch"))
            reduced.confirmSourceRead(input, commandId, response) else reduced
        return completed.trackSessionReadDemands(input, changedTargets, setOfNotNull(commandId)).reconcileHistoryReads()
    }

    private fun materializeToolPayload(state: RemoteState, payload: String): String {
        val envelope = runCatching { json.parseToJsonElement(payload).jsonObject }.getOrNull() ?: return payload
        val event = envelope["event"] as? JsonObject ?: return payload
        if (event.string("type") !in setOf("session.snapshot", "session.patch")) return payload
        val runtimeId = envelope.string("runtimeId") ?: return payload
        val live = event["live"]?.let { runCatching { json.decodeFromJsonElement<SessionLiveState>(it) }.getOrNull() } ?: return payload
        val ref = live.toolInventory ?: return payload
        val replica = state.toolInventories[runtimeId]?.takeIf { it.covers(ref) } ?: return payload
        val represented = live.messages.flatMap { it.message.content }.mapNotNull { it.toolCallId }.toSet()
        val tools = replica.tools.map { summary -> SessionLiveTool(summary.tool.toolCallId, summary.toolName,
            if (summary.phase in setOf("finished", "cancelled")) "finished" else summary.phase, summary = summary, isError = summary.isError) }
        val synthetic = replica.tools.filter { it.tool.toolCallId !in represented }.map { summary ->
            SessionLiveMessage(ChatMessage("tool-live:${summary.tool.toolCallId}", "assistant", listOf(
                RemoteContent(type = "tool_call", toolCallId = summary.tool.toolCallId, toolName = summary.toolName, summary = summary)),
                live.turn?.startedAt ?: 0), summary.phase in setOf("finished", "cancelled"), true, order = summary.order)
        }
        val projected = live.copy(messages = (live.messages + synthetic).sortedBy { it.order ?: Long.MAX_VALUE }, tools = tools)
        return JsonObject(envelope + ("event" to JsonObject(event + ("live" to json.encodeToJsonElement(projected))))).toString()
    }

    /** ADR-0045 §5：工具依赖完整验证前，保留旧聊天基线；详情从不参与 applied。 */
    private fun reduceToolEnvelope(state: RemoteState, payload: String, committed: CommittedSessionBatch?, channel: String?): RemoteState? {
        val envelope = runCatching { json.parseToJsonElement(payload).jsonObject }.getOrNull() ?: return null
        if (envelope.string("type") != "runtime.event") return null
        val runtimeId = envelope.string("runtimeId") ?: return null
        val event = envelope["event"]?.jsonObject ?: return null
        val type = event.string("type")
        val old = state.toolInventories[runtimeId] ?: ToolInventoryReplica()
        if (type == "session.snapshot" || type == "session.patch") {
            val ref = (event["live"] as? JsonObject)?.get("toolInventory")?.takeIf { it != JsonNull }
                ?.let { runCatching { json.decodeFromJsonElement<ToolInventoryReference>(it) }.getOrNull() } ?: return null
            val session = state.runtimes[runtimeId]?.sessionId ?: state.knownRuntimeSessions[runtimeId]
            if (ref.agent.hostId != state.hostId || ref.agent.sessionId != session ||
                ref.agent.agentKind != state.runtimes[runtimeId]?.agentKind) return state
            if (old.covers(ref)) return null
            val queue = state.pendingToolConversations[runtimeId].orEmpty()
            val item = PendingToolConversation(payload, committed, channel, ref)
            val pending = if (queue.any { it.payload == payload }) queue else queue + item
            if (pending.size > 64 || pending.sumOf { it.payload.toByteArray().size } > 1_048_576 ||
                state.pendingToolConversations.values.flatten().sumOf { it.payload.toByteArray().size } + payload.toByteArray().size > 8_388_608 ||
                state.toolInventories.size >= 64 && runtimeId !in state.toolInventories) return state.copy(
                pendingToolConversations = state.pendingToolConversations - runtimeId,
                sessionSyncRequests = state.sessionSyncRequests + runtimeId)
            return state.copy(toolInventories = state.toolInventories + (runtimeId to old.require(ref)),
                pendingToolConversations = state.pendingToolConversations + (runtimeId to pending))
        }
        if (type == "session.tool.content.page") {
            val page = runCatching { json.decodeFromJsonElement<ToolContentPage>(event) }.getOrNull() ?: return state
            if (page.runtimeId != runtimeId) return state
            return state.copy(toolDetail = state.toolDetail?.page(page))
        }
        if (type?.startsWith("session.tools.") == true || type == "session.tool.read.failed") {
            if (event.string("runtimeId") != runtimeId) return state
        }
        if (type == "session.tool.read.failed" && event.string("requestId") == state.toolDetail?.requestId) {
            return state.copy(toolDetail = state.toolDetail?.copy(requestId = null, follow = false,
                error = toolReadFailureText(event.string("reason"))))
        }
        val replica = when (type) {
            "session.tools.opened" -> runCatching { old.opened(event.string("requestId") ?: "", json.decodeFromJsonElement<ToolInventorySnapshot>(event.getValue("snapshot"))) }.getOrElse { old.failed("工具清单无效") }
            "session.tools.page" -> runCatching { old.page(json.decodeFromJsonElement<ToolInventoryPage>(event)) }.getOrElse { old.failed("工具清单页无效") }
            "session.tools.patch" -> runCatching { old.patch(json.decodeFromJsonElement<ToolInventoryPatch>(event)) }.getOrElse { old.failed("工具清单更新无效") }
            "session.tools.changed" -> return state // The corresponding chat checkpoint supplies the exact reference.
            "session.tool.read.failed" -> if (event.string("requestId") == old.requestId) old.failed(event.string("reason") ?: "snapshot_expired") else return state
            "tool.activity" -> return state
            else -> return null
        }
        var next = state.copy(toolInventories = state.toolInventories + (runtimeId to replica))
        if (replica.error != null) return next.copy(pendingToolConversations = next.pendingToolConversations - runtimeId,
            sessionSyncRequests = next.sessionSyncRequests + runtimeId)
        if (replica.target == null) {
            val pending = next.pendingToolConversations[runtimeId].orEmpty()
            next = next.copy(pendingToolConversations = next.pendingToolConversations - runtimeId)
            var current = replica
            for (item in pending) {
                while (!current.covers(item.reference) && current.buffered.isNotEmpty()) {
                    val patch = current.buffered.first()
                    val remaining = current.buffered.drop(1)
                    current = current.copy(buffered = emptyList()).patch(patch).copy(buffered = remaining)
                }
                next = next.copy(toolInventories = next.toolInventories + (runtimeId to current))
                if (current.covers(item.reference)) next = reduce(next, item.payload, item.committed, item.channel)
                else {
                    next = next.copy(sessionSyncRequests = next.sessionSyncRequests + runtimeId)
                    break
                }
            }
            while (current.buffered.isNotEmpty() && current.error == null) {
                val patch = current.buffered.first(); val remaining = current.buffered.drop(1)
                current = current.copy(buffered = emptyList()).patch(patch).copy(buffered = remaining)
            }
            next = next.copy(toolInventories = next.toolInventories + (runtimeId to current))
        }
        return next
    }

    private fun reducePayload(
        state: RemoteState,
        payload: String,
        committed: CommittedSessionBatch?,
        channel: String?,
    ): RemoteState {
        val message = json.parseToJsonElement(payload).jsonObject
        val messageType = message.string("type")
        if (messageType !in setOf(
                "device.ready", "runtime.online", "runtime.offline", "runtime.event", "runtime.git", "notification.snapshot",
                "protocol.error", "provider.result", "provider.changed", "agent.state.snapshot", "agent.state.range.page", "diagnostics.page",
                "artifact.read.failed",
                // 上传的入站消息：状态由 ViewModel 的上传处理器维护，reducer 只需不把它当非法消息。
                "file.upload.ready", "file.upload.read", "file.upload.progress", "file.upload.finished", "file.upload.failed",
                "session.list.result", "session.browse.result", "session.activated", "session.archive.changed",
                "host.online", "host.offline",
            )) {
            return state.copy(error = "收到不支持的中继服务器消息，请在电脑端检查协议版本", errorNeedsAction = true)
        }
        val protocolVersion = message["protocolVersion"]?.jsonPrimitive?.intOrNull
        // 用常量而不是字面量：写死版本号会在协议升级时**静默**把每条消息都变成错误，
        // 现象是界面永远停在「正在连接」+ 弹「不兼容的协议版本」，而链路其实是通的。
        if (protocolVersion != null && protocolVersion != PROTOCOL_VERSION) {
            return state.copy(error = PROTOCOL_VERSION_MISMATCH_ERROR, errorNeedsAction = true)
        }
        return when (messageType) {
            "notification.snapshot" -> if (channel != null) state.withNotificationSnapshot(message, json) else state
            "provider.result" -> if (channel != null) state.withProviderResult(message) else state
            "provider.changed" -> state
            "agent.state.snapshot" -> if (channel != null)
                state.withAgentStateSnapshot(message, json, ::parsePendingInteraction) else state
            "agent.state.range.page" -> if (channel != null) state.withAgentCatalogRangePage(message, json) else state
            "diagnostics.page" -> state.withDiagnosticsPage(message)
            "runtime.git" -> state.withWorkingBranch(message)
            "device.ready" -> {
                // Relay's plaintext authentication receipt always carries an empty directory:
                // it knows no agent sessions. Only an authenticated Host envelope may replace
                // windows and their conversations, including when Relay reconnects behind LAN.
                if (channel == null) {
                    return state.copy(
                        connection = RelayConnection.ONLINE,
                        deviceId = message.string("deviceId"),
                    )
                }
                val runtimes = message["runtimes"]?.let {
                    json.decodeFromJsonElement<List<RuntimeSummary>>(it)
                }.orEmpty().associateBy(RuntimeSummary::runtimeId)
                // 「这台电脑支持哪些 agent」只有 Host 说得准。中继那条种子 device.ready 发的是
                // 显式 `null`（它不知道装没装 codex）；任何一种"不知道"都保持原判（未知 = 不限制）。
                val supportedAgents = message["agents"]
                    ?.takeIf { it !is JsonNull }
                    ?.let { element -> json.decodeFromJsonElement<List<String>>(element).toSet() }
                    ?: state.supportedAgents
                val launchableAgents = message["launchableAgents"]
                    ?.takeIf { it !is JsonNull }
                    ?.let { element -> json.decodeFromJsonElement<List<String>>(element).toSet() }
                    ?: state.launchableAgents
                    ?: supportedAgents
                // 只有 Host 那条经过端到端加密的 device.ready 会走到这里（中继的明文种子在
                // 上面直接 return 了），所以缺这项就是“不知道”，清回 null 而不是保留旧值。
                val codexDesktop = message["codexDesktop"]
                    ?.takeIf { it !is JsonNull }
                    ?.let { element -> json.decodeFromJsonElement<CodexDesktopAttach>(element) }
                val sessionChanged = runtimes.keys.associateWith { runtimeId ->
                    val previousRuntime = state.runtimes[runtimeId]
                    val hasPrevious = previousRuntime != null ||
                        state.knownRuntimeSessions.containsKey(runtimeId)
                    val previousSessionId = previousRuntime?.sessionId
                        ?: state.knownRuntimeSessions[runtimeId]
                    !hasPrevious || previousSessionId != runtimes[runtimeId]?.sessionId
                }
                val branchChanged = runtimes.keys.associateWith { runtimeId ->
                    if (sessionChanged[runtimeId] == true || state.conversations[runtimeId]?.sourceEpoch != null) false else {
                        val runtime = runtimes[runtimeId]
                        val previousLeaf = state.runtimes[runtimeId]?.sessionLeafId
                            ?: state.runtimeSessionViews[runtimeId]?.leafId
                        runtime?.sessionGraphSync == true && state.isKnownBranchChange(
                            sessionId = runtime?.sessionId,
                            previousLeafId = previousLeaf,
                            nextLeafId = runtime?.sessionLeafId,
                        )
                    }
                }
                var sessions = state.sessions
                for (runtime in runtimes.values) {
                    runtime.catalogEntry()?.let { entry ->
                        sessions = sessions + (entry.sessionId to mergeSessionCatalogEntry(sessions[entry.sessionId], entry))
                    }
                }
                val runtimeViews = state.runtimeSessionViews
                    .filterKeys(runtimes::containsKey)
                    .toMutableMap()
                for (runtime in runtimes.values) {
                    val incomingView = runtime.sessionView(runtime.runtimeId) ?: continue
                    val previousView = state.runtimeSessionViews[runtime.runtimeId]
                    if (sessionChanged[runtime.runtimeId] != true &&
                        state.conversations[runtime.runtimeId]?.sourceEpoch != null) continue
                    val keepPreviousView = previousView != null &&
                        previousView.sessionId == incomingView.sessionId &&
                        previousView.leafId != incomingView.leafId && branchChanged[runtime.runtimeId] != true
                    runtimeViews[runtime.runtimeId] = if (keepPreviousView) previousView else incomingView
                }
                val conversations = runtimes.mapValues { (runtimeId, runtime) ->
                    val previous = state.conversations[runtimeId]
                    val hasPreviousRuntime = state.runtimes.containsKey(runtimeId) ||
                        state.knownRuntimeSessions.containsKey(runtimeId)
                    val preservePreOnlineInteraction = !hasPreviousRuntime && previous != null &&
                        previous.interactions.isNotEmpty()
                    val displayNeedsPreview = runtime.runtimeId == state.selectedRuntimeId &&
                        (previous?.hasLiveSnapshot != true || previousViewNeedsRefresh(state, runtime))
                    val shouldSync = runtime.isSyncPending(state.selectedRuntimeId, state.sessionGraphs) || displayNeedsPreview
                    if (sessionChanged[runtimeId] == true || branchChanged[runtimeId] == true) {
                        // `interaction.requested` / `interaction.snapshot` may cross the wire just
                        // before the first directory announcement. The directory is authoritative
                        // for the session/chat projection, but it is not an interaction snapshot;
                        // dropping this small pending set makes the card show "待确认" only via
                        // status while the detail dialog has nothing to render. Do not carry it
                        // across a real session/branch replacement.
                        RuntimeConversation(
                            isChatSyncing = shouldSync,
                            interactions = if (preservePreOnlineInteraction) previous?.interactions.orEmpty() else emptyMap(),
                            waitingLocalInteraction = if (preservePreOnlineInteraction) previous?.waitingLocalInteraction == true else false,
                        )
                    } else {
                        (previous ?: RuntimeConversation()).copy(
                            isChatSyncing = shouldSync && runtime.runtimeId !in state.sessionSyncFailures,
                            chatSyncError = state.sessionSyncFailures[runtime.runtimeId],
                        )
                    }
                }
                state.copy(
                    connection = RelayConnection.ONLINE,
                    deviceId = message.string("deviceId"),
                    notificationEpoch = message.string("notificationEpoch") ?: state.notificationEpoch,
                    sessions = sessions,
                    runtimes = runtimes.mapValues { (id, runtime) -> runtime.carryingComposerStatus(
                        state.runtimes[id].takeIf { state.agentModelEpoch == message.string("modelEpoch") }) },
                    agentModelEpoch = message.string("modelEpoch"),
                    toolInventories = state.toolInventories.takeIf { state.agentModelEpoch == message.string("modelEpoch") }.orEmpty(),
                    pendingToolConversations = emptyMap(),
                    toolDetail = state.toolDetail?.takeIf { state.agentModelEpoch == message.string("modelEpoch") },
                    retiredAgentModelEpochs = state.retiredAgentModelEpochs + listOfNotNull(state.agentModelEpoch?.takeIf { it != message.string("modelEpoch") }),
                    agentStateSnapshots = state.agentStateSnapshots.takeIf { state.agentModelEpoch == message.string("modelEpoch") }.orEmpty(),
                    agentStateRequests = emptySet(),
                    agentStateReads = emptyMap(),
                    agentCatalogRange = state.agentCatalogRange?.takeIf { state.agentModelEpoch == message.string("modelEpoch") },
                    agentCatalogRangeRequest = null,
                    supportedAgents = state.supportedAgents.takeIf { state.agentModelEpoch == message.string("modelEpoch") },
                    launchableAgents = state.launchableAgents.takeIf { state.agentModelEpoch == message.string("modelEpoch") },
                    codexDesktop = state.codexDesktop.takeIf { state.agentModelEpoch == message.string("modelEpoch") },
                    sessionListRequests = emptySet(),
                    sessionListRequestEpochs = emptyMap(),
                    sessionArchiveRequests = emptyMap(),
                    runtimeSessionViews = runtimeViews,
                    knownRuntimeSessions = state.knownRuntimeSessions + runtimes.mapValues { it.value.sessionId },
                    sessionHistory = state.sessionHistory
                        .filterKeys { runtimeId ->
                            branchChanged[runtimeId] != true
                        }
                        // The reconnect drops every outstanding session command, so an in-flight
                        // history request can never be answered. Release its spinner while keeping
                        // the older-history boundary the user already paged to.
                        .mapValues { (key, history) ->
                            if (key in runtimes) {
                                history.copy(loading = false, requestId = null)
                            } else {
                                history
                            }
                        },
                    conversations = conversations.mapValues { (_, conversation) ->
                        conversation.withoutActiveTurn().let { current ->
                            if (state.agentModelEpoch == message.string("modelEpoch")) current else current.copy(
                                interactions = emptyMap(), queuedMessages = emptyMap(), deliveredQueueIds = emptySet(),
                                waitingLocalInteraction = false, interactionNotices = emptyMap())
                        }
                    },
                    lastSequence = state.lastSequence.filterKeys { key ->
                        runtimes.keys.any { runtime -> key == runtime || key.startsWith("$runtime\u0000") }
                    },
                    capabilities = state.capabilities.filterKeys(runtimes::containsKey)
                        .takeIf { state.agentModelEpoch == message.string("modelEpoch") }.orEmpty(),
                    pendingDownloads = state.pendingDownloads.filterValues { it.runtimeId in runtimes },
                    sessionSyncCommands = emptyMap(),
                    sessionSyncFailures = emptyMap(), sessionSyncBusyStreaks = emptyMap(), sessionSyncFailureCooldowns = emptyMap(), sessionSyncBlockedTargets = emptySet(),
                    sessionRangeFailures = emptyMap(),
                    // Graph history is lazy: only the selected Runtime requests it.
                    sessionSyncRequests = state.sessionSyncRequests + runtimes.values
                        .filter { runtime ->
                            runtime.sessionGraphSync && (
                                runtime.isSyncPending(state.selectedRuntimeId, state.sessionGraphs) ||
                                    runtime.runtimeId == state.selectedRuntimeId && state.conversations[runtime.runtimeId]?.sourceEpoch != null ||
                                    runtime.runtimeId == state.selectedRuntimeId &&
                                    (state.conversations[runtime.runtimeId]?.hasLiveSnapshot != true || previousViewNeedsRefresh(state, runtime))
                            )
                        }
                        .map { it.runtimeId }
                        .toSet(),
                    error = null,
                )
            }
            "runtime.online" -> {
                val runtime = message["runtime"]?.let {
                    json.decodeFromJsonElement<RuntimeSummary>(it)
                } ?: return state
                val previousRuntime = state.runtimes[runtime.runtimeId]
                val hasPreviousRuntime = previousRuntime != null ||
                    state.knownRuntimeSessions.containsKey(runtime.runtimeId)
                val previousSessionId = previousRuntime?.sessionId
                    ?: state.knownRuntimeSessions[runtime.runtimeId]
                val capabilitiesArrivedBeforeOnline = !hasPreviousRuntime &&
                    state.capabilities.containsKey(runtime.runtimeId)
                val sessionChanged = !hasPreviousRuntime || previousSessionId != runtime.sessionId
                val previousLeaf = previousRuntime?.sessionLeafId
                    ?: state.runtimeSessionViews[runtime.runtimeId]?.leafId
                val versioned = !sessionChanged && state.conversations[runtime.runtimeId]?.sourceEpoch != null
                val branchChanged = !versioned && !sessionChanged && runtime.sessionGraphSync && state.isKnownBranchChange(
                    sessionId = runtime.sessionId,
                    previousLeafId = previousLeaf,
                    nextLeafId = runtime.sessionLeafId,
                )
                val invalidatedSessionSyncCommands = if (sessionChanged || branchChanged) {
                    state.sessionSyncCommands.filterValues { it.runtimeId == runtime.runtimeId }.keys
                } else {
                    emptySet()
                }
                val displayNeedsPreview = runtime.runtimeId == state.selectedRuntimeId &&
                    (state.conversations[runtime.runtimeId]?.hasLiveSnapshot != true || previousViewNeedsRefresh(state, runtime))
                val shouldSync = runtime.isSyncPending(state.selectedRuntimeId, state.sessionGraphs) || displayNeedsPreview ||
                    versioned && runtime.runtimeId == state.selectedRuntimeId
                val conversation = if (sessionChanged || branchChanged) {
                    val preservePreOnlineInteraction = !hasPreviousRuntime &&
                        state.conversations[runtime.runtimeId]?.interactions?.isNotEmpty() == true
                    // Keep an interaction that arrived before the first runtime.online. This is
                    // deliberately narrower than keeping the conversation: a new session/branch
                    // must not inherit old chat messages or old requests.
                    RuntimeConversation(
                        isChatSyncing = shouldSync,
                        interactions = if (preservePreOnlineInteraction) {
                            state.conversations[runtime.runtimeId]?.interactions.orEmpty()
                        } else {
                            emptyMap()
                        },
                        waitingLocalInteraction = preservePreOnlineInteraction &&
                            state.conversations[runtime.runtimeId]?.waitingLocalInteraction == true,
                    )
                } else {
                    (state.conversations[runtime.runtimeId] ?: RuntimeConversation())
                        .withoutActiveTurn()
                        .copy(
                            isChatSyncing = shouldSync && runtime.runtimeId !in state.sessionSyncFailures,
                            chatSyncError = state.sessionSyncFailures[runtime.runtimeId],
                        )
                }
                val runtimeCatalog = runtime.catalogEntry()
                val runtimeView = runtime.sessionView(runtime.runtimeId).takeUnless { versioned }
                val sessions = runtimeCatalog?.let { entry ->
                    state.sessions + (entry.sessionId to mergeSessionCatalogEntry(state.sessions[entry.sessionId], entry))
                } ?: state.sessions
                state.copy(
                    sessions = sessions,
                    sessionBranchGenerations = if (sessionChanged || branchChanged) {
                        state.sessionBranchGenerations + (runtime.runtimeId to ((state.sessionBranchGenerations[runtime.runtimeId] ?: 0) + 1))
                    } else state.sessionBranchGenerations,
                    runtimes = state.runtimes + (runtime.runtimeId to runtime.carryingComposerStatus(previousRuntime)
                        ),
                    runtimeSessionViews = runtimeView?.let {
                        val previousView = state.runtimeSessionViews[runtime.runtimeId]
                        val keepPreviousView = previousView != null &&
                            previousView.sessionId == it.sessionId &&
                            previousView.leafId != it.leafId && !branchChanged
                        state.runtimeSessionViews + (runtime.runtimeId to if (keepPreviousView) previousView else it)
                    } ?: state.runtimeSessionViews,
                    knownRuntimeSessions = state.knownRuntimeSessions + (runtime.runtimeId to runtime.sessionId),
                    conversations = state.conversations + (runtime.runtimeId to conversation),
                    lastSequence = if (sessionChanged && !capabilitiesArrivedBeforeOnline) {
                        state.lastSequence.filterKeys { key ->
                            key != runtime.runtimeId && !key.startsWith("${runtime.runtimeId}\u0000")
                        }
                    } else {
                        state.lastSequence
                    },
                    // Runtime events and runtime.online travel through different sockets. Preserve
                    // either a same-session manifest or one that arrived just before online.
                    capabilities = if (sessionChanged && !capabilitiesArrivedBeforeOnline) {
                        state.capabilities - runtime.runtimeId
                    } else {
                        state.capabilities
                    },
                    pendingDownloads = if (sessionChanged) {
                        state.pendingDownloads.filterValues { it.runtimeId != runtime.runtimeId }
                    } else {
                        state.pendingDownloads
                    },
                    pendingCommands = state.pendingCommands - invalidatedSessionSyncCommands,
                    sessionSyncCommands = state.sessionSyncCommands - invalidatedSessionSyncCommands,
                    sessionSyncFailures = if (sessionChanged || branchChanged) state.sessionSyncFailures - runtime.runtimeId
                        else state.sessionSyncFailures,
                    // A reconnect that lands on the same branch keeps the older-history paging
                    // progress. Only a real session or branch change starts a fresh window.
                    sessionRangeFailures = if (sessionChanged || branchChanged) state.sessionRangeFailures.filterKeys {
                        !it.startsWith("${runtime.runtimeId}\u0000")
                    } else state.sessionRangeFailures,
                    sessionHistory = if (sessionChanged || branchChanged) {
                        state.sessionHistory - runtime.runtimeId
                    } else {
                        state.sessionHistory
                    },
                    sessionSyncRequests = if (runtime.sessionGraphSync && shouldSync) {
                        state.sessionSyncRequests + runtime.runtimeId
                    } else {
                        state.sessionSyncRequests - runtime.runtimeId
                    },
                )
            }
            "host.offline" -> {
                // 电脑端 Host 进程没了（Relay 按 hostId 过滤后才转发到这）。加密通道随之失效，
                // 手机侧要把「能不能干活」打回原形；host.online → 重握手 → device.ready 会把
                // 目录和会话状态重新对齐，这里不用猜着恢复。
                val interrupted = state.pendingCommands.keys
                state.copy(
                    e2eReady = false,
                    currentProviders = emptyMap(),
                    sessionActivateRequests = emptySet(),
                    sessionActivateTargets = emptyMap(),
                    activatedSessionToOpen = null,
                    runtimes = emptyMap(),
                    codexDesktop = null,
                    pendingCommands = emptyMap(),
                    commandResults = state.commandResults + interrupted.filterNot { it.isSessionSyncCommandId() }.associateWith {
                        CommandResult(ok = false, status = "cancelled")
                    },
                )
            }
            "host.online" -> state // 重握手由 RelayClient 处理；状态等 device.ready 对齐
            "runtime.offline" -> {
                val runtimeId = message.string("runtimeId") ?: return state
                val interrupted = state.pendingCommands.filterValues { it == runtimeId }.keys
                state.copy(
                    toolInventories = state.toolInventories - runtimeId,
                    pendingToolConversations = state.pendingToolConversations - runtimeId,
                    toolDetail = state.toolDetail?.let { if (it.runtimeId == runtimeId) it.copy(requestId = null, read = null,
                        follow = false, error = "运行实例已离线，仅显示已缓存内容") else it },
                    runtimes = state.runtimes - runtimeId,
                    workingBranches = state.workingBranches - runtimeId,
                    selectedRuntimeId = state.selectedRuntimeId.takeUnless { it == runtimeId },
                    selectedOfflineSessionId = state.selectedOfflineSessionId,
                    pendingCommands = state.pendingCommands.filterValues { it != runtimeId },
                    commandResults = state.commandResults + interrupted.filterNot { it.isSessionSyncCommandId() }.associateWith { CommandResult(ok = false, status = "cancelled") },
                    capabilities = state.capabilities - runtimeId,
                    pendingDownloads = state.pendingDownloads.filterValues { it.runtimeId != runtimeId },
                    // 下载由 Host 服务（§9.4）：任务上的 runtimeId 只是「文件来自哪个会话」的来源标记，
                    // 不是服务方。某个源进程掉线不该暂停一条正在由 Host 供片的传输——那会让手机
                    // 停止接收/确认分片（status 变了），Host 等到 ack 超时后报 artifact_ack_timeout。
                    // 只有真正的「待发起/未建立传输」状态（queued、无 transferId）才随源进程离线暂停。
                    downloads = state.downloads.mapValues { (_, task) ->
                        if (task.runtimeId == runtimeId && task.transferId == null &&
                            task.status in setOf("queued", "downloading")
                        ) {
                            task.copy(status = "paused", commandId = null, error = "运行实例已离线，可在重连后继续")
                        } else task
                    },
                    conversations = state.conversations + (runtimeId to (state.conversations[runtimeId] ?: RuntimeConversation())
                        .withoutActiveTurn()
                        .copy(
                            isChatSyncing = false,
                            chatSyncError = "运行实例已离线",
                        )),
                    sessionSyncCommands = state.sessionSyncCommands.filterValues { it.runtimeId != runtimeId },
                    sessionRangeFailures = state.sessionRangeFailures.filterKeys { !it.startsWith("$runtimeId\u0000") },
                    sessionSyncRequests = state.sessionSyncRequests - runtimeId,
                )
            }
            "runtime.event" -> reduceRuntimeEvent(state, message, committed, channel)
            "session.list.result" -> reduceSessionListResult(state, message)
            "session.archive.changed" -> reduceSessionArchiveChanged(state, message)
            "session.browse.result" -> reduceSessionBrowseResult(state, message)
            "session.activated" -> reduceSessionActivated(state, message)
            // Host 明确拒绝了一次范围请求（越界/读盘失败/身份变了）：这条 pull 传输以确定原因收场。
            // 调度器的超时重传不再介入——它是「这条路走不通」，不是「这一片丢了」。
            "artifact.read.failed" -> {
                val transferId = message.string("transferId")
                val entry = transferId?.let { id ->
                    state.downloads.entries.firstOrNull { it.value.transferId == id }
                } ?: return state
                if (entry.value.status in setOf("completed", "cancelled", "failed")) return state
                state.copy(downloads = state.downloads + (entry.key to entry.value.copy(
                    status = "failed",
                    commandId = null,
                    error = "下载失败：电脑无法读取这个文件",
                )))
            }
            "protocol.error" -> {
                // P2P 是尽力而为的支线：打洞失败 / Host 未启用都已自动回落中继，业务照常。
                // 这两条当模态错误弹出来，只会让每次跨网抖动的连续失败计数达标都变成一次要用户
                // 点「确定」的噪音，所以静默丢弃；路径现状在连接状态页仍有体现。
                if (message.string("code") in P2P_FALLBACK_ERROR_CODES) return state
                val commandId = message.string("commandId")
                if (commandId?.startsWith("session-sync-ack:") == true) return state
                val requestId = message.string("requestId")
                val syncError = protocolErrorText(message.string("code"), message.string("message"))
                // 先按 requestId 归位进程激活类请求（spec §8：错误带回 requestId）。
                val listCleared = requestId?.takeIf { it in state.sessionListRequests }
                val activateCleared = requestId?.takeIf { it in state.sessionActivateRequests }
                val archiveCleared = requestId?.takeIf { it in state.sessionArchiveRequests }
                val browseCleared = requestId?.takeIf { state.sessionBrowse?.requestId == it }
                if (listCleared != null || activateCleared != null || browseCleared != null || archiveCleared != null) {
                    return state.copy(
                        sessionArchiveRequests = state.sessionArchiveRequests - listOfNotNull(archiveCleared),
                        sessionListRequests = listCleared?.let { state.sessionListRequests - it } ?: state.sessionListRequests,
                        sessionListRequestEpochs = listCleared?.let { state.sessionListRequestEpochs - it } ?: state.sessionListRequestEpochs,
                        sessionActivateRequests = activateCleared?.let { state.sessionActivateRequests - it } ?: state.sessionActivateRequests,
                    sessionActivateTargets = activateCleared?.let { state.sessionActivateTargets - it } ?: state.sessionActivateTargets,
                        sessionBrowse = if (browseCleared != null) {
                            state.sessionBrowse?.copy(isLoading = false, error = syncError)
                        } else {
                            state.sessionBrowse
                        },
                        error = if (browseCleared != null) state.error else syncError,
                    )
                }
                val sessionSync = commandId?.let(state.sessionSyncCommands::get)
                if (sessionSync == null && commandId?.isSessionSyncCommandId() == true) return state
                if (sessionSync != null && commandId != null) {
                    val transient = isTransientSessionSyncFailure(message.string("code"))
                    val failed = state.failSessionSync(
                        commandId, syncError, transient = transient, code = message.string("code"),
                    )
                    return if (sessionSync.range == "preview") failed.copy(error = syncError) else failed
                }
                val isHistorySync = sessionSync?.range == "history"
                // A failed history request must release its foreground paging state, and it must
                // not cancel a forward catch-up that is still needed for the live frontier.
                val releasedHistory = state.releaseHistoryRequest(commandId)
                state.copy(
                    pendingCommands = commandId?.let { state.pendingCommands - it } ?: state.pendingCommands,
                    commandResults = commandId?.let { state.commandResults + (it to CommandResult(ok = false, status = "failure")) } ?: state.commandResults,
                    sessionSyncCommands = commandId?.let { state.sessionSyncCommands - it } ?: state.sessionSyncCommands,
                    sessionSyncRequests = if (isHistorySync) {
                        state.sessionSyncRequests
                    } else {
                        sessionSync?.runtimeId?.let { state.sessionSyncRequests - it } ?: state.sessionSyncRequests
                    },
                    sessionHistory = releasedHistory.sessionHistory,
                    conversations = sessionSync?.runtimeId?.let { runtimeId ->
                        state.conversations[runtimeId]?.let { conversation ->
                            state.conversations + (runtimeId to conversation.copy(
                                isChatSyncing = false,
                                chatSyncError = syncError,
                            ))
                        }
                    } ?: state.conversations,
                    error = syncError,
                )
            }
            else -> state
        }
    }

    /**
     * 事件水位线的记账键：`channel` 已知时按 (runtimeId, channel) 各记一份。
     *
     * 事件按 `ctl`/`msg` 分道投递（host 的 `channelForDeviceMessage`），插队是常态，
     * 跨道的到达顺序不再代表发送顺序——全局一条水位线会让后到的 `ctl` 把先发出的
     * `msg` 事件永久压死（issue 02）。`channel` 未知时（测试/非事件消息）退化为
     * `runtimeId` 单键。
     */
    private fun sequenceKey(runtimeId: String, channel: String?): String =
        if (channel.isNullOrBlank()) runtimeId else "$runtimeId\u0000$channel"

    private fun reduceRuntimeEvent(
        state: RemoteState,
        envelope: JsonObject,
        committed: CommittedSessionBatch? = null,
        channel: String? = null,
    ): RemoteState {
        val runtimeId = envelope.string("runtimeId") ?: return state
        val sequence = envelope["sequence"]?.jsonPrimitive?.longOrNull ?: return state
        val event = envelope["event"]?.jsonObject ?: return state
        val eventType = event.string("type")
        // 水位线的记账键：事件按 ctl/msg 分道投递（host 的 channelForDeviceMessage），
        // ctl 插队是常态，跨道的到达顺序不再代表发送顺序——高水位线必须按道各记一份，
        // 否则后到的 ctl 会把先发出的 msg 事件永久压死（issue 02）。
        val sequenceKey = sequenceKey(runtimeId, channel)
        val snapshotStillOwned = eventType == "session.snapshot" &&
            state.sessionSyncCommands.values.any {
                it.runtimeId == runtimeId &&
                    it.sessionId == event.string("sessionId") &&
                    it.syncId == event.string("syncId")
            }
        if (sequence <= (state.lastSequence[sequenceKey] ?: -1) && !snapshotStillOwned && eventType != "session.patch") return state
        val supportedEvents = setOf(
            "runtime.status", "runtime.metadata", "runtime.capabilities", "session.catalog", "message.queued", "session.snapshot", "session.sync.pending", "session.entry.result", "session.patch", "message.started", "message.delta",
            "message.finished", "turn.started", "turn.finished", "tool.started", "tool.updated", "tool.finished", "artifact.started",
            "artifact.failed", "interaction.requested", "interaction.snapshot",
            "interaction.resolved", "interaction.cancelled", "local_interaction.required", "command.result", "runtime.error",
        )
        if (eventType !in supportedEvents && eventType !in MODEL_OWNED_LEGACY_EVENTS) {
            return state.copy(error = "手机无法安全处理此运行时事件，请在电脑端处理", errorNeedsAction = true)
        }
        val conversation = state.conversations[runtimeId] ?: RuntimeConversation()
        if (eventType in MODEL_OWNED_LEGACY_EVENTS) {
            return state.copy(lastSequence = state.lastSequence + (sequenceKey to sequence))
        }
        if (conversation.sourceEpoch != null && eventType in setOf(
                "message.started", "message.delta", "message.finished", "turn.started", "turn.finished",
                "tool.started", "tool.updated", "tool.finished",
            )) {
            // Once source replication is established, legacy notifications cannot bypass its
            // version gate (especially a delayed delta or finish from a reverted turn).
            return state.copy(lastSequence = state.lastSequence + (sequenceKey to sequence))
        }
        var nextConversation = conversation
        var nextRuntimes = state.runtimes
        var nextSessions = state.sessions
        var nextCapabilities = state.capabilities
        var nextError = state.error
        var nextPendingCommands = state.pendingCommands
        var nextCommandResults = state.commandResults
        var nextSessionGraphs = state.sessionGraphs
        var nextRuntimeSessionViews = state.runtimeSessionViews
        var nextSessionSyncCommands = state.sessionSyncCommands
        var nextSessionSyncFailures = state.sessionSyncFailures
        var nextBranchGenerations = state.sessionBranchGenerations
        var nextSessionSyncRequests = state.sessionSyncRequests
        var nextSessionHistory = state.sessionHistory
        var nextHistoryReads = state.historyReads
        var nextRangeFailures = state.sessionRangeFailures
        var nextDownloads = state.downloads
        var nextPendingDownloads = state.pendingDownloads

        when (eventType) {
            // ADR-0038 §8：按需取回的未截断条目，只用于查看/复制，不参与 canonical 投影。
            "session.entry.result" -> {
                val entryId = event.string("entryId")
                val entry = event["entry"]?.let { runCatching { json.decodeFromJsonElement<SessionGraphEntry>(it) }.getOrNull() }
                if (entryId == null || entry == null) {
                    return state.copy(lastSequence = state.lastSequence + (sequenceKey to sequence))
                }
                return state.copy(
                    fullEntries = state.fullEntries + (entryId to entry),
                    lastSequence = state.lastSequence + (sequenceKey to sequence),
                )
            }
            // ADR-0037 §3：协调者说"还在处理"就不再是静默。设备把耗尽窗口交给调度器重新计时，
            // 而不是等 150s 后把整场同步判成会话级失败。
            "session.sync.pending" -> {
                val commandId = event.string("commandId")
                val task = commandId?.let(state.sessionSyncCommands::get)
                    ?: return state.copy(lastSequence = state.lastSequence + (sequenceKey to sequence))
                nextSessionSyncCommands = state.sessionSyncCommands + (commandId to task.copy(
                    pendingNotices = task.pendingNotices + 1,
                    awaitingWindowReset = true,
                    slow = true,
                ))
            }
            "session.patch" -> {
                val patch = runCatching { json.decodeFromJsonElement<SessionPatch>(event) }.getOrNull()
                    ?: return state.copy(error = "收到无效的 Session 状态 patch", errorNeedsAction = true)
                if (patch.source.seq != patch.seq || patch.baseSeq >= patch.seq) {
                    return state.copy(
                        sessionSyncRequests = state.sessionSyncRequests + runtimeId,
                        conversations = state.conversations + (runtimeId to conversation.copy(isChatSyncing = true)),
                        lastSequence = state.lastSequence + (sequenceKey to maxOf(state.lastSequence[sequenceKey] ?: -1L, sequence)),
                    )
                }
                val activeSessionId = state.runtimes[runtimeId]?.sessionId
                    ?: state.knownRuntimeSessions[runtimeId]
                if (activeSessionId != null && activeSessionId != patch.sessionId) {
                    return state
                }
                if (runtimeId in state.sessionSyncFailures) return state.copy(
                    lastSequence = state.lastSequence + (sequenceKey to sequence),
                )
                val cachePatches = contiguousSourcePatches(patch.source.epoch, conversation.sourceSeq,
                    (conversation.sourcePatchBuffer + (patch.seq to patch)).values)
                val graph = if (cachePatches.isNotEmpty() && patch.source.epoch !in conversation.retiredSourceEpochs && patch.source.ready &&
                    conversation.sourceReady && patch.source.epoch == conversation.sourceEpoch && patch.seq > conversation.sourceSeq
                ) {
                    runCatching {
                        (state.sessionGraphs[patch.sessionId] ?: SessionGraph(patch.sessionId))
                            .merge(cachePatches.last().canonicalPage(
                                committed?.entries ?: mergedPatchEntries(emptyList(), cachePatches),
                                committed?.display ?: mergedPatchDisplay(cachePatches),
                            ))
                    }.getOrElse { error ->
                        val failure = "Session 历史缓存写入失败：${error.message ?: "无效条目"}"
                        return state.copy(
                            sessionSyncFailures = state.sessionSyncFailures + (runtimeId to failure),
                            conversations = state.conversations + (runtimeId to conversation.copy(chatSyncError = failure)),
                        )
                    }.also { nextSessionGraphs = nextSessionGraphs + (patch.sessionId to it) }
                } else state.sessionGraphs[patch.sessionId] ?: SessionGraph(patch.sessionId)
                fun requestRecovery(next: RuntimeConversation): Unit {
                    nextConversation = next.copy(isChatSyncing = true, chatSyncError = null)
                    nextSessionSyncRequests = state.sessionSyncRequests + runtimeId
                }
                val currentEpoch = conversation.sourceEpoch
                if (patch.source.epoch in conversation.retiredSourceEpochs) {
                    // An epoch that was already replaced can arrive after a newer checkpoint.
                    // Keep the current projection intact and recover the active epoch instead of
                    // allowing the delayed patch to reopen the old branch.
                    requestRecovery(conversation)
                } else if (currentEpoch == null || currentEpoch != patch.source.epoch) {
                    if (patch.source.ready) {
                        // A ready patch cannot establish a new epoch's canonical head. Keep the
                        // current projection until a checkpoint explicitly performs the epoch
                        // handshake; this also prevents a delayed ready patch from reviving an
                        // old source after a restart.
                        requestRecovery(conversation.copy(sourcePatchBuffer = boundedSourcePatches(
                            conversation.sourcePatchBuffer.filterValues { it.source.epoch == patch.source.epoch } + (patch.seq to patch),
                        )))
                    } else {
                        // `ready=false` is the source's explicit unknown boundary. Isolate the
                        // old projection and use the next ready checkpoint as the handshake.
                        requestRecovery(conversation.copy(
                            messages = emptyList(),
                            streamingMessageIds = emptySet(),
                            finishedMessageIds = emptySet(),
                            streamingSessionId = null,
                            hasLiveSnapshot = false,
                            activeTurnId = null,
                            turnTimings = emptyMap(),
                            tools = emptyMap(),
                            sourceEpoch = patch.source.epoch,
                            sourceSeq = -1L,
                            sourceHeadLeafId = null,
                            sourceReady = false,
                            retiredSourceEpochs = conversation.sourceEpoch?.let {
                                conversation.retiredSourceEpochs + it
                            } ?: conversation.retiredSourceEpochs,
                            sourcePatchBuffer = emptyMap(),
                            revision = conversation.revision + 1,
                        ))
                    }
                } else if (patch.source.seq <= conversation.sourceSeq) {
                    nextConversation = conversation
                } else {
                    val buffered = boundedSourcePatches(conversation.sourcePatchBuffer + (patch.seq to patch))
                    val applied = conversation.copy(sourcePatchBuffer = buffered).replaySourcePatches(
                        patch.sessionId, graph,
                    )
                    // Overflow also requires recovery even if retaining the earliest contiguous
                    // prefix temporarily emptied the bounded buffer.
                    if (applied.isChatSyncing || patch.seq > applied.sourceSeq && patch.seq !in buffered) {
                        requestRecovery(applied)
                    } else {
                        nextConversation = applied
                        nextSessionSyncRequests = nextSessionSyncRequests - runtimeId
                    }
                    if (applied.sourceSeq > conversation.sourceSeq) {
                        nextRuntimeSessionViews = nextRuntimeSessionViews + (runtimeId to
                            RuntimeSessionView(runtimeId, patch.sessionId, applied.sourceHeadLeafId))
                        nextRuntimes[runtimeId]?.let { runtime ->
                            nextRuntimes = nextRuntimes + (runtimeId to runtime.copy(sessionLeafId = applied.sourceHeadLeafId))
                        }
                    }
                }
            }
            "runtime.metadata" -> {
                val metadata = event["metadata"]?.let {
                    json.decodeFromJsonElement<RuntimeSummary>(it)
                } ?: return state
                if (metadata.runtimeId != runtimeId) return state
                val previousRuntime = state.runtimes[runtimeId]
                val previousView = state.runtimeSessionViews[runtimeId]
                val sessionChanged = previousRuntime != null && previousRuntime.sessionId != metadata.sessionId
                val previousLeaf = previousRuntime?.sessionLeafId
                    ?: previousView?.leafId
                val graphForMetadata = state.sessionGraphs[metadata.sessionId]
                val targetKnown = metadata.sessionLeafId == null ||
                    graphForMetadata?.hasCompleteEntryChain(metadata.sessionLeafId) == true
                // A new leaf is not enough to prove a branch switch: normal turn completion
                // advances the leaf before the catch-up response arrives. A known ancestry
                // must prove the divergence before the previous branch is invalidated.
                val versioned = conversation.sourceEpoch != null && !sessionChanged
                val branchChanged = !versioned && !sessionChanged && metadata.sessionGraphSync && state.isKnownBranchChange(
                    metadata.sessionId, previousLeaf, metadata.sessionLeafId,
                )
                nextRuntimes = state.runtimes + (runtimeId to metadata.carryingComposerStatus(previousRuntime)
                    )
                if (sessionChanged || branchChanged) {
                    nextBranchGenerations = nextBranchGenerations + (runtimeId to ((nextBranchGenerations[runtimeId] ?: 0) + 1))
                    nextSessionSyncFailures = nextSessionSyncFailures - runtimeId
                    nextRangeFailures = nextRangeFailures.filterKeys { !it.startsWith("$runtimeId\u0000") }
                    val invalidatedSessionCommands = state.sessionSyncCommands
                        .filterValues { it.runtimeId == runtimeId }
                        .keys
                    nextSessionSyncCommands = state.sessionSyncCommands
                        .filterValues { it.runtimeId != runtimeId }
                    nextPendingCommands = nextPendingCommands - invalidatedSessionCommands
                    nextSessionSyncRequests = state.sessionSyncRequests - runtimeId
                    nextSessionHistory = state.sessionHistory - runtimeId
                    nextRuntimeSessionViews = state.runtimeSessionViews - runtimeId
                    nextSessions = state.sessions
                    nextConversation = RuntimeConversation(
                        isChatSyncing = metadata.isSyncPending(state.selectedRuntimeId, state.sessionGraphs),
                    )
                }
                metadata.sessionView(runtimeId)?.takeUnless { versioned }?.let { incomingView ->
                    val view = if (!sessionChanged && !branchChanged && !targetKnown &&
                        previousView?.sessionId == incomingView.sessionId &&
                        previousView.leafId != incomingView.leafId
                    ) previousView else incomingView
                    nextRuntimeSessionViews = nextRuntimeSessionViews + (runtimeId to view)
                    val graph = state.sessionGraphs[view.sessionId]
                        ?: SessionGraph(view.sessionId).takeIf { view.leafId == null && metadata.sessionGraphSync }
                    if (graph != null && graph.hasCompleteEntryChain(view.leafId)) {
                        val oldLeaf = previousView?.takeIf { it.sessionId == view.sessionId }?.leafId
                        val contextChanged = sessionChanged || branchChanged
                        val sourceConversation = if (contextChanged) nextConversation else conversation
                        val baseMessages = sourceConversation.messages.filterNot {
                            it.messageId in sourceConversation.streamingMessageIds
                        }
                        val projection = if (contextChanged) {
                            projectSessionGraph(graph.copy(cursor = SessionBranchCursor(view.leafId)))
                        } else {
                            val deltaProjection = graph.projectLeafDeltaProjection(
                                oldLeaf,
                                view.leafId,
                                canonicalRowsForDeltaProjection(baseMessages, graph),
                            )
                            // Only a same-branch append may re-attach temporary older messages;
                            // a rewrite or rewind must be free to replace the displayed branch.
                            if (oldLeaf == null || graph.isDescendant(view.leafId, oldLeaf)) {
                                mergeTemporaryOlderMessages(deltaProjection, graph, baseMessages)
                            } else {
                                deltaProjection
                            }
                        }
                        val (displayedMessages, overlayIds) = if (contextChanged) {
                            projection.messages to emptySet()
                        } else {
                            mergeProjectedWithStreaming(projection.messages, sourceConversation)
                        }
                        nextConversation = sourceConversation
                            .applyProjection(projection, displayedMessages, keepLiveTiming = !contextChanged)
                            .copy(
                                streamingMessageIds = overlayIds,
                                streamingSessionId = view.sessionId.takeIf { overlayIds.isNotEmpty() },
                                hasLiveSnapshot = true,
                                isChatSyncing = false,
                                chatSyncError = projection.error,
                                revision = sourceConversation.revision + 1,
                            )
                        val branch = buildSessionPath(graph.entries, view.leafId)
                        val history = nextSessionHistory[runtimeId]?.takeIf { it.sessionId == view.sessionId }
                        nextSessionHistory = nextSessionHistory + (runtimeId to
                            (history?.copy(leafId = view.leafId) ?: SessionHistoryState(
                                view.sessionId, view.leafId, branch.firstOrNull()?.entryId,
                                branch.firstOrNull()?.parentId != null,
                            )))
                        // Metadata projection completed from the local graph. Drop the queued
                        // loader request so a directory/metadata refresh cannot replay the same
                        // cache read after the display is already current.
                        nextSessionSyncRequests = nextSessionSyncRequests - runtimeId
                    }
                }
                metadata.catalogEntry()?.let { entry ->
                    nextSessions = nextSessions + (
                        entry.sessionId to mergeSessionCatalogEntry(nextSessions[entry.sessionId], entry)
                    )
                }
                if (metadata.isSyncPending(state.selectedRuntimeId, state.sessionGraphs)) {
                    nextSessionSyncRequests = nextSessionSyncRequests + runtimeId
                }
                if (versioned && metadata.sessionLeafId != conversation.sourceHeadLeafId) {
                    nextSessionSyncRequests = nextSessionSyncRequests + runtimeId
                }
            }
            "session.snapshot" -> {
                val snapshot = runCatching { json.decodeFromJsonElement<SessionGraphSnapshot>(event) }.getOrElse {
                    return state.copy(error = "收到无效的 Session graph 快照", errorNeedsAction = true)
                }
                val pending = state.sessionSyncCommands.values.firstOrNull {
                    it.runtimeId == runtimeId && it.syncId == snapshot.syncId
                }
                if (pending == null || pending.sessionId != snapshot.sessionId) {
                    return state.copy(
                        lastSequence = state.lastSequence + (
                            sequenceKey to maxOf(state.lastSequence[sequenceKey] ?: -1L, sequence)
                        ),
                    )
                }
                // A Session snapshot is correlated by syncId, but that alone is not enough:
                // the Runtime may have switched Sessions after the request was sent. Drop the
                // response before merging it, otherwise an old Session can enter the new
                // Runtime's in-memory graph and be mistaken for current history.
                val activeSessionId = state.runtimes[runtimeId]?.sessionId
                    ?: state.knownRuntimeSessions[runtimeId]
                if (activeSessionId != null && activeSessionId != snapshot.sessionId) {
                    val staleCommandIds = state.sessionSyncCommands
                        .filterValues { it.runtimeId == runtimeId && it.syncId == snapshot.syncId }
                        .keys
                    val activeRuntime = state.runtimes[runtimeId]
                    return state.copy(
                        pendingCommands = state.pendingCommands - staleCommandIds,
                        sessionSyncCommands = state.sessionSyncCommands - staleCommandIds,
                        sessionSyncRequests = if (activeRuntime?.sessionGraphSync == true &&
                            activeRuntime.sessionId != null
                        ) state.sessionSyncRequests + runtimeId else state.sessionSyncRequests - runtimeId,
                        lastSequence = state.lastSequence + (
                            sequenceKey to maxOf(state.lastSequence[sequenceKey] ?: -1L, sequence)
                        ),
                    )
                }
                val responseTargetLeafId = snapshot.targetLeafId ?: snapshot.cursor.leafId
                val targetLeafId = if (pending.range == "catchup") pending.targetLeafId ?: responseTargetLeafId
                    else responseTargetLeafId
                val selectionError = runCatching { pending.validatePreviewSelection(snapshot) }.exceptionOrNull()
                if (selectionError != null) {
                    val id = state.sessionSyncCommands.entries.first { it.value === pending }.key
                    return state.failSessionSync(id, "Session 同步响应无效：${selectionError.message}")
                }
                if (snapshot.selection == "unchanged") {
                    val id = state.sessionSyncCommands.entries.first { it.value === pending }.key
                    return state.completeUnchangedSessionSync(id, snapshot, sequenceKey, sequence)
                }
                val liveLeafId = state.runtimes[runtimeId]?.sessionLeafId
                val isHistory = pending.range == "history"
                if (pending.range in setOf("history", "catchup") &&
                    (snapshot.rangeStatus != null && snapshot.rangeStatus !in setOf("complete", "older_available", "limit_reached") ||
                        // hasOlder describes backwards history paging. A bounded forward
                        // catchup can legitimately have complete=false and hasOlder=false.
                        isHistory && snapshot.hasOlder == false && snapshot.complete == false)) {
                    val id = state.sessionSyncCommands.entries.first { it.value === pending }.key
                    return state.failSessionSync(id, "Session 范围加载失败：${snapshot.rangeStatus ?: "incomplete_range"}")
                }
                // Fixed ranges fill cache only; preview and patch own current source state.
                val isCanonicalPage = pending.range != "preview"
                val incomingSource = snapshot.source.takeUnless { isCanonicalPage }
                val incomingCheckpoint = snapshot.checkpoint.takeUnless { isCanonicalPage }
                val cacheGate = conversation.snapshotSourceGate(snapshot, pending.range, pending.sourceRecovery, pending.sourceRecoveryEpoch)
                val sourceRetired = incomingSource != null && incomingSource.epoch in conversation.retiredSourceEpochs
                val sourceEpochChanged = incomingSource != null && conversation.sourceEpoch != null &&
                    conversation.sourceEpoch != incomingSource.epoch
                if (sourceEpochChanged) nextRangeFailures = nextRangeFailures.filterKeys { !it.startsWith("$runtimeId\u0000") }
                val sourceSameEpoch = incomingSource == null || conversation.sourceEpoch == null ||
                    conversation.sourceEpoch == incomingSource.epoch
                val sourceStale = incomingSource != null && sourceSameEpoch &&
                    conversation.sourceEpoch == incomingSource.epoch && incomingSource.seq < conversation.sourceSeq
                // A conditional response captured before a newer patch is already superseded.
                // Finish its task without introducing an error that would block future recovery.
                if (snapshot.selection in setOf("state", "delta") &&
                    (sourceStale || sourceRetired || sourceEpochChanged || !conversation.sourceReady)) {
                    val id = state.sessionSyncCommands.entries.first { it.value === pending }.key
                    return state.completeUnchangedSessionSync(id, snapshot, sequenceKey, sequence)
                }
                val sourceReadyCheckpoint = incomingSource != null && incomingCheckpoint?.head != null && !sourceStale &&
                    incomingSource.ready && incomingCheckpoint.headCompleteness == "complete" &&
                    incomingCheckpoint.inventoryComplete && snapshot.live?.complete == true
                // `ready=false` is the source's explicit unknown boundary. A partial live
                // inventory is still useful and must merge without deleting objects omitted from
                // that inventory.
                val sourceBlocked = incomingSource != null && !sourceStale && !sourceRetired && !incomingSource.ready
                val commandId = state.sessionSyncCommands.entries.first { it.value === pending }.key
                val epochSwitchRejected = cacheGate.epochSwitchRejected
                if (epochSwitchRejected) {
                    // A ready response from an unrelated epoch is not a recovery handshake. It
                    // may be a delayed snapshot from before a source restart, so preserve the
                    // current projection and force a fresh checkpoint request. The retry is the
                    // explicit recovery boundary that permits the next epoch to be installed.
                    val rejectedCommandIds = state.sessionSyncCommands
                        .filterValues { it.runtimeId == runtimeId && it.syncId == snapshot.syncId }
                        .keys
                    val released = state.releaseHistoryRequest(commandId)
                    return released.copy(
                        pendingCommands = released.pendingCommands - rejectedCommandIds,
                        sessionSyncCommands = released.sessionSyncCommands - rejectedCommandIds,
                        sessionSyncRequests = released.sessionSyncRequests + runtimeId,
                        conversations = released.conversations + (
                            runtimeId to conversation.copy(
                                isChatSyncing = true,
                                chatSyncError = null,
                                sourceRecoveryRetryAt = System.currentTimeMillis() + 2_000,
                                revision = conversation.revision + 1,
                            )
                        ),
                        lastSequence = released.lastSequence + (
                            sequenceKey to maxOf(released.lastSequence[sequenceKey] ?: -1L, sequence)
                        ),
                    )
                }
                val staleTarget = !state.ownsSessionSnapshot(commandId, runtimeId, snapshot.sessionId,
                    snapshot.syncId, responseTargetLeafId, snapshot.range, snapshot.beforeEntryId) ||
                    sourceStale || sourceRetired || cacheGate.stale
                // A preview can resolve a newer live leaf only if metadata has not advanced since
                // it was requested. A catch-up target can be an old ancestor/cache hole.
                if (pending.range == "preview" && !isCanonicalPage && !staleTarget && targetLeafId != null &&
                    (pending.viewLeafId == null || liveLeafId == pending.viewLeafId)) {
                    nextRuntimes[runtimeId]?.let { runtime ->
                        nextRuntimes = nextRuntimes + (runtimeId to runtime.copy(sessionLeafId = targetLeafId))
                    }
                }
                // Every successful range joins the same canonical graph. Projection state remains
                // separate from the realtime overlay below.
                val isCatchUp = pending.range == "catchup" && !isHistory
                // Cache generation changes invalidate old edges, not the native Entry identity.
                val currentGraph = state.sessionGraphs[snapshot.sessionId] ?: SessionGraph(snapshot.sessionId)
                val projectionConversation = if (sourceEpochChanged && !sourceRetired) conversation.copy(
                    messages = emptyList(),
                    streamingMessageIds = emptySet(),
                    finishedMessageIds = emptySet(),
                    streamingSessionId = null,
                    hasLiveSnapshot = false,
                    activeTurnId = null,
                    turnTimings = emptyMap(),
                    tools = emptyMap(),
                    sourceHeadLeafId = null,
                    retiredSourceEpochs = conversation.sourceEpoch?.let {
                        conversation.retiredSourceEpochs + it
                    } ?: conversation.retiredSourceEpochs,
                ) else conversation
                val snapshotForProjection = snapshot.copy(
                    entries = committed?.entries ?: snapshot.entries,
                    display = committed?.display ?: snapshot.display,
                    cursor = SessionBranchCursor(targetLeafId),
                    targetLeafId = targetLeafId,
                )
                val mergedGraph = if (staleTarget || sourceBlocked || !cacheGate.cacheAllowed) currentGraph else {
                    runCatching {
                        val base = currentGraph.merge(snapshotForProjection)
                        if (isCanonicalPage || !sourceReadyCheckpoint) base else
                            contiguousSourcePatches(incomingSource.epoch, incomingSource.seq, conversation.sourcePatchBuffer.values)
                                .fold(base) { graph, patch -> graph.merge(patch.canonicalPage()) }
                    }.getOrElse { error ->
                        return@reduceRuntimeEvent state.failSessionSync(commandId,
                            "Session 历史同步失败：${error.message}").copy(
                            lastSequence = state.lastSequence + (sequenceKey to sequence),
                        )
                    }
                }
                val completedSessionCommandIds = state.sessionSyncCommands
                    .filterValues { it.syncId == snapshot.syncId }
                    .keys
                nextSessionSyncCommands = state.sessionSyncCommands.filterValues { it.syncId != snapshot.syncId }
                nextPendingCommands = state.pendingCommands - completedSessionCommandIds
                nextSessionSyncRequests = when {
                    staleTarget -> state.sessionSyncRequests + runtimeId
                    // A history response must not consume a separate pending catch-up task.
                    isCanonicalPage -> state.sessionSyncRequests
                    else -> state.sessionSyncRequests - runtimeId
                }
                val graphForProjection = if (staleTarget) mergedGraph.copy(cursor = currentGraph.cursor) else mergedGraph
                if (!staleTarget && isHistory && snapshotForProjection.entries.any { !graphForProjection.hasDisplayFor(it) }) {
                    return@reduceRuntimeEvent state.failSessionSync(commandId, "历史页缺少显示结果，请更新并重启电脑端会话后重试")
                }
                if (!staleTarget) {
                    if (!isCanonicalPage) nextSessionSyncFailures = nextSessionSyncFailures - runtimeId
                    nextSessionGraphs = state.sessionGraphs + (snapshot.sessionId to graphForProjection)
                    nextSessions = nextSessions + (
                        snapshot.sessionId to (nextSessions[snapshot.sessionId] ?: SessionCatalogEntry(snapshot.sessionId))
                            .withHistoryCache(state.runtimes[runtimeId]?.hostname)
                    )
                }
                val currentViewLeaf = if (sourceEpochChanged) null else state.runtimeSessionViews[runtimeId]
                    ?.takeIf { it.sessionId == snapshot.sessionId }?.leafId
                val hasRenderableCurrentView = currentViewLeaf != null && currentGraph.entries.containsKey(currentViewLeaf)
                val hasRenderableTarget = targetLeafId != null && mergedGraph.entries.containsKey(targetLeafId)
                val retainAdvancedView = pending.viewLeafId != null && liveLeafId != pending.viewLeafId &&
                    currentViewLeaf == liveLeafId && currentViewLeaf != targetLeafId
                val targetIsOlder = currentViewLeaf != targetLeafId && mergedGraph.isDescendant(currentViewLeaf, targetLeafId)
                val shouldMoveView = !staleTarget && !sourceBlocked && !isCanonicalPage &&
                    (isCanonicalPage || sourceReadyCheckpoint) && targetLeafId != null &&
                    !retainAdvancedView && !targetIsOlder &&
                    (snapshot.complete != false || !hasRenderableCurrentView || hasRenderableTarget)
                val viewLeafId = when {
                    isCanonicalPage && conversation.sourceEpoch != null -> conversation.sourceHeadLeafId
                    isCanonicalPage -> state.runtimeSessionViews[runtimeId]
                        ?.takeIf { it.sessionId == snapshot.sessionId }?.leafId ?: targetLeafId
                    shouldMoveView -> targetLeafId
                    else -> state.runtimeSessionViews[runtimeId]
                        ?.takeIf { it.sessionId == snapshot.sessionId }?.leafId
                }
                if (shouldMoveView && viewLeafId != null) {
                    nextRuntimeSessionViews = state.runtimeSessionViews + (
                        runtimeId to RuntimeSessionView(runtimeId, snapshot.sessionId, viewLeafId)
                    )
                }
                val branch = viewLeafId?.let { buildSessionPath(graphForProjection.entries, it) }.orEmpty()
                val existingHistory = state.sessionHistory[runtimeId]
                if (!staleTarget && (shouldMoveView || isHistory || isCatchUp)) {
                    // The canonical tree is only a bounded window. A forward response cannot know
                    // about the older temporary pages the user already paged in, so its boundary
                    // must not rewind the history state back to the window edge (which made the
                    // UI re-request the same page forever). Appending to the branch never
                    // invalidates its ancestors, so only the paging target leaf is refreshed.
                    val continuedHistory = existingHistory?.takeIf {
                        !sourceEpochChanged && currentGraph.cacheEpoch == mergedGraph.cacheEpoch &&
                            !isHistory && it.sessionId == snapshot.sessionId && it.oldestEntryId != null
                    }
                    val nextHistory = if (continuedHistory != null) {
                        // Filling a gap can expose an older cached prefix in the projection.
                        // Move the boundary back only along a proven ancestor chain; keeping the
                        // preview boundary would prepend already-visible rows on the next page.
                        val expandedStart = branch.firstOrNull()?.takeIf { start ->
                            // A reflexive check would "expand" to the entry already at the boundary.
                            start.entryId != continuedHistory.oldestEntryId &&
                                graphForProjection.isDescendant(continuedHistory.oldestEntryId, start.entryId)
                        }
                        continuedHistory.copy(
                            // A forward catch-up advances the paging window to the page's target even
                            // when the displayed branch stays where the user is reading.
                            leafId = (if (isCatchUp) targetLeafId else viewLeafId) ?: continuedHistory.leafId,
                            oldestEntryId = expandedStart?.entryId ?: continuedHistory.oldestEntryId,
                            hasOlder = expandedStart?.let { it.parentId != null } ?: continuedHistory.hasOlder,
                        )
                    } else if (branch.isNotEmpty()) {
                        SessionHistoryState(
                            sessionId = snapshot.sessionId,
                            leafId = if (isCatchUp) targetLeafId else viewLeafId,
                            oldestEntryId = branch.firstOrNull()?.entryId ?: existingHistory?.oldestEntryId,
                            hasOlder = snapshot.hasOlder ?: (branch.firstOrNull()?.parentId != null),
                            loading = false,
                        )
                    } else if (isHistory) {
                        (existingHistory ?: SessionHistoryState(
                            sessionId = snapshot.sessionId,
                            leafId = viewLeafId,
                            oldestEntryId = null,
                            hasOlder = false,
                        )).copy(
                            loading = false,
                            requestId = null,
                            oldestEntryId = snapshotForProjection.entries.firstOrNull()?.entryId
                                ?: existingHistory?.oldestEntryId,
                            hasOlder = snapshot.hasOlder ?: false,
                        )
                    } else {
                        null
                    }
                    if (nextHistory != null) {
                        nextSessionHistory = state.sessionHistory + (runtimeId to nextHistory)
                    }
                }
                val canProject = !isCatchUp || snapshot.complete != false ||
                    graphForProjection.hasCompleteEntryChain(viewLeafId)
                val emptyPreview = pending.range == "preview" && !isCanonicalPage && (isCanonicalPage || sourceReadyCheckpoint) && targetLeafId == null &&
                    snapshot.entries.isEmpty() && snapshot.complete == true &&
                    snapshot.rangeStatus in setOf(null, "complete") && liveLeafId == pending.viewLeafId
                if (!staleTarget && sourceBlocked) {
                    // A not-ready source checkpoint is an explicit unknown boundary. Keep the
                    // canonical graph in the cache, but atomically hide the previous epoch's
                    // head, live messages, tools, and timing until a complete ready checkpoint.
                    nextConversation = projectionConversation.copy(
                        messages = emptyList(),
                        streamingMessageIds = emptySet(),
                        finishedMessageIds = emptySet(),
                        streamingSessionId = null,
                        hasLiveSnapshot = false,
                        sourceEpoch = incomingSource?.epoch ?: conversation.sourceEpoch,
                        sourceSeq = incomingSource?.seq ?: conversation.sourceSeq,
                        sourceHeadLeafId = null,
                        sourceReady = false,
                        activeTurnId = null,
                        turnTimings = emptyMap(),
                        tools = emptyMap(),
                        isChatSyncing = true,
                        chatSyncError = null,
                        revision = conversation.revision + 1,
                    )
                } else if (!staleTarget && emptyPreview) {
                    nextRuntimes[runtimeId]?.let { runtime ->
                        nextRuntimes = nextRuntimes + (runtimeId to runtime.copy(sessionLeafId = null))
                    }
                    nextRuntimeSessionViews = nextRuntimeSessionViews +
                        (runtimeId to RuntimeSessionView(runtimeId, snapshot.sessionId, null))
                    nextSessionHistory = nextSessionHistory +
                        (runtimeId to SessionHistoryState(snapshot.sessionId, null, null, false))
                    val (messages, overlayIds) = mergeProjectedWithStreaming(emptyList(), projectionConversation)
                    nextConversation = projectionConversation.applyProjection(SessionProjectionResult(emptyList()), messages, keepLiveTiming = true)
                        .copy(hasLiveSnapshot = true, isChatSyncing = false, chatSyncError = null,
                            streamingMessageIds = overlayIds,
                            streamingSessionId = snapshot.sessionId.takeIf { overlayIds.isNotEmpty() },
                            revision = conversation.revision + 1)
                } else if (!staleTarget && viewLeafId != null && canProject &&
                    (isCanonicalPage || sourceReadyCheckpoint)) {
                    val oldLeaf = if (sourceEpochChanged) null else state.runtimeSessionViews[runtimeId]
                        ?.takeIf { it.sessionId == snapshot.sessionId }?.leafId
                    val baseMessages = projectionConversation.messages.filterNot {
                        it.messageId in projectionConversation.streamingMessageIds
                    }
                    val projection = if (isCanonicalPage) {
                        // History entries are older than the existing boundary. Keep the current
                        // conversation even when the in-memory window lacks its older ancestors.
                        val full = if (conversation.sourceEpoch != null || graphForProjection.hasCompleteEntryChain(viewLeafId)) {
                            projectSessionGraph(graphForProjection.copy(cursor = SessionBranchCursor(viewLeafId)))
                        } else {
                            SessionProjectionResult(projectSessionEntries(
                                snapshotForProjection.entries,
                                graphForProjection.display,
                                graphForProjection.displayWindowStart,
                            ))
                        }
                        val projectedIds = full.messages.map(ChatMessage::messageId).toSet()
                        full.copy(
                            messages = full.messages + baseMessages.filterNot {
                                it.messageId in projectedIds
                            },
                            turnTimings = (full.turnTimings + projectionConversation.turnTimings.values +
                            snapshotForProjection.turnTimings.orEmpty())
                                .associateBy(TurnTiming::turnId).values.toList(),
                        )
                    } else {
                        val deltaProjection = graphForProjection.projectLeafDeltaProjection(
                            oldLeafId = oldLeaf,
                            newLeafId = viewLeafId,
                            currentMessages = canonicalRowsForDeltaProjection(baseMessages, graphForProjection),
                        )
                        // Only a same-branch append may re-attach temporary older messages;
                        // a rewrite or rewind must be free to replace the displayed branch.
                        if (oldLeaf == null || graphForProjection.isDescendant(viewLeafId, oldLeaf)) {
                            mergeTemporaryOlderMessages(deltaProjection, graphForProjection, baseMessages)
                        } else {
                            deltaProjection
                        }
                    }
                    val (displayedMessages, overlayIds) = mergeProjectedWithStreaming(projection.messages, projectionConversation)
                    nextConversation = projectionConversation
                        // A running sync is a canonical-history refresh, not proof that the
                        // active turn ended. Preserve unfinished timing until the source live
                        // checkpoint below confirms its terminal state; otherwise a late
                        // turn.finished loses its identity mapping and cannot converge.
                        .applyProjection(
                            projection,
                            displayedMessages,
                            // Running/waiting sync keeps the live turn until the source
                            // checkpoint proves it finished; an idle refresh may clear stale
                            // timing from a previously lost completion event.
                            keepLiveTiming = isCanonicalPage || !sourceEpochChanged &&
                                (conversation.sourceEpoch != null || state.runtimes[runtimeId]?.status != "idle"),
                        )
                        .copy(
                            streamingMessageIds = overlayIds,
                            streamingSessionId = snapshot.sessionId.takeIf { overlayIds.isNotEmpty() },
                            hasLiveSnapshot = true,
                            isChatSyncing = false,
                            chatSyncError = snapshot.rangeStatus?.takeIf {
                                it in setOf("leaf_not_found", "range_start_not_found", "missing_parent", "cycle_detected")
                            }?.let { "Session 范围加载失败：$it" },
                            revision = conversation.revision + 1,
                        )
                    if (isCanonicalPage && conversation.sourceEpoch != null) {
                        nextConversation = nextConversation.copy(
                            tools = conversation.tools,
                            activeTurnId = conversation.activeTurnId,
                            turnTimings = conversation.turnTimings,
                            streamingMessageIds = conversation.streamingMessageIds,
                            finishedMessageIds = conversation.finishedMessageIds,
                            streamingSessionId = conversation.streamingSessionId,
                            hasLiveSnapshot = conversation.sourceReady &&
                                (conversation.sourceHeadLeafId == null || conversation.sourceHeadLeafId in graphForProjection.entries),
                            isChatSyncing = conversation.isChatSyncing,
                        )
                    }
                } else if (staleTarget) {
                    nextConversation = projectionConversation.copy(
                        isChatSyncing = if (conversation.sourceEpoch != null) conversation.isChatSyncing else false,
                        chatSyncError = "Session 已产生更新，正在重新加载最新范围",
                        revision = conversation.revision + 1,
                    )
                }
                if (!staleTarget && sourceReadyCheckpoint && snapshot.live != null &&
                    (sourceEpochChanged || nextConversation.sourceEpoch == null ||
                        nextConversation.sourceEpoch == incomingSource?.epoch)
                ) {
                    val head = incomingCheckpoint?.head ?: SessionBranchCursor(targetLeafId)
                    nextConversation = nextConversation.applyCompleteSourceState(
                        snapshot.sessionId, incomingSource!!, head, snapshot.live, graphForProjection,
                    ).copy(forceSourceSnapshot = false, sourcePatchBuffer = conversation.sourcePatchBuffer.filterValues {
                        it.source.epoch == incomingSource.epoch && it.seq > incomingSource.seq
                    }).replaySourcePatches(snapshot.sessionId, graphForProjection)
                    nextRuntimeSessionViews = nextRuntimeSessionViews + (runtimeId to
                        RuntimeSessionView(runtimeId, snapshot.sessionId, nextConversation.sourceHeadLeafId))
                    nextRuntimes[runtimeId]?.let { runtime ->
                        nextRuntimes = nextRuntimes + (runtimeId to runtime.copy(sessionLeafId = nextConversation.sourceHeadLeafId))
                    }
                    nextSessionSyncRequests = if (nextConversation.isChatSyncing) nextSessionSyncRequests + runtimeId
                        else nextSessionSyncRequests - runtimeId
                } else if (!staleTarget && incomingSource != null && !sourceStale &&
                    incomingSource.ready && snapshot.live != null
                ) {
                    // Partial checkpoints update known rows and watermarks while preserving
                    // live rows/tools that were outside the returned inventory.
                    val knownHead = nextConversation.sourceHeadLeafId
                    val confirmedSeq = nextConversation.sourceSeq
                    val confirmedReady = nextConversation.sourceReady
                    nextConversation = nextConversation.applySourceLiveCheckpoint(
                        incomingSource, snapshot.live, replaceInventory = false,
                    ).copy(
                        sourceHeadLeafId = knownHead,
                        sourceSeq = confirmedSeq,
                        sourceReady = confirmedReady && nextConversation.sourceEpoch == incomingSource.epoch,
                        hasLiveSnapshot = nextConversation.hasLiveSnapshot,
                        isChatSyncing = true,
                        revision = nextConversation.revision + 1,
                    )
                    nextSessionSyncRequests = nextSessionSyncRequests + runtimeId
                }
                if (!staleTarget && incomingSource != null && !sourceReadyCheckpoint && !sourceBlocked) {
                    nextConversation = nextConversation.copy(isChatSyncing = true, sourceRecoveryRetryAt = System.currentTimeMillis() + 2_000)
                    nextSessionSyncRequests = nextSessionSyncRequests + runtimeId
                }
                if (!staleTarget && sourceBlocked) {
                    nextConversation = nextConversation.copy(sourceRecoveryRetryAt = System.currentTimeMillis() + 2_000)
                    nextSessionSyncRequests = nextSessionSyncRequests + runtimeId
                }
                val rangeFailure = snapshot.rangeStatus?.takeIf {
                    it !in setOf("complete", "older_available", "limit_reached")
                }
                if (isCanonicalPage) {
                    // A range outcome belongs to this operation, not to current-state recovery.
                    nextConversation = nextConversation.copy(chatSyncError = conversation.chatSyncError)
                    if (!staleTarget) {
                        val key = sessionRangeFailureKey(runtimeId, pending.range)
                        nextRangeFailures = if (rangeFailure == null) nextRangeFailures - key
                            else nextRangeFailures + (key to "Session 范围加载失败：$rangeFailure")
                    }
                }
                if (isHistory || isCanonicalPage && (staleTarget || rangeFailure != null)) {
                    val phase = when {
                        staleTarget -> HistoryReadPhase.SUPERSEDED
                        rangeFailure != null -> HistoryReadPhase.FAILED
                        snapshot.hasOlder == false -> HistoryReadPhase.END_REACHED
                        else -> HistoryReadPhase.SUCCEEDED
                    }
                    nextHistoryReads = state.finishRemoteHistoryRead(commandId, phase,
                        rangeFailure?.let { "Session 范围加载失败：$it" }).historyReads
                }
            }
            "artifact.started" -> {
                val artifact = event["artifact"]?.let {
                    json.decodeFromJsonElement<RemoteArtifact>(it)
                } ?: return state.copy(error = "手机无法安全处理此下载项，请在电脑端处理", errorNeedsAction = true)
                if (artifact.size < 0 || !isSafeArtifactFileName(artifact.fileName) || !isValidSha256(artifact.sha256)) {
                    return state.copy(error = "手机无法安全处理此下载项，请在电脑端处理", errorNeedsAction = true)
                }
                val commandId = event.string("commandId")
                val transferId = event.string("transferId")
                    ?: return state.copy(error = "下载传输标识无效，请重新下载")
                val pending = commandId?.let(state.pendingDownloads::get)
                val offset = event["offset"]?.jsonPrimitive?.longOrNull ?: pending?.offset ?: 0
                if (offset !in 0..artifact.size) {
                    return state.copy(error = "下载起点校验失败，请重新下载")
                }
                if (pending != null && pending.offset != offset) {
                    return state.copy(error = "下载起点校验失败，请重新下载")
                }
                val taskId = pending?.taskId
                    ?: findDownloadTaskId(state.downloads.values, runtimeId, artifact)
                    ?: artifactDownloadTaskId(runtimeId, artifact.artifactId)
                val existing = state.downloads[taskId]
                if (existing != null && pending == null && existing.transferId != null &&
                    existing.transferId != transferId && existing.status in setOf("queued", "downloading", "paused", "completed", "failed", "cancelled")
                ) return state
                if (existing != null && existing.status in setOf("failed", "cancelled") && pending == null) return state
                if (existing != null && existing.transferId == transferId &&
                    existing.status in setOf("downloading", "completed") &&
                    existing.receivedBytes >= offset
                ) return state
                if (commandId != null) nextPendingDownloads = state.pendingDownloads - commandId
                val startOffset = maxOf(offset, existing?.receivedBytes ?: 0)
                nextDownloads = state.downloads + (
                    taskId to (existing ?: ArtifactDownload(
                        taskId = taskId,
                        runtimeId = runtimeId,
                        displayName = artifact.fileName,
                        sourcePath = artifact.path,
                        sourceArtifactId = artifact.artifactId,
                    )).copy(
                        commandId = commandId,
                        transferId = transferId,
                        artifact = artifact,
                        status = "downloading",
                        receivedBytes = startOffset,
                        error = null,
                        // 下载由 Host 服务，事件里的 runtimeId 就是 hostId；完成时用它寻址（§9.4）。
                        transferRuntimeId = runtimeId,
                    )
                )
            }
            "artifact.failed" -> {
                val artifactId = event.string("artifactId") ?: return state
                val transferId = event.string("transferId") ?: return state
                val entry = state.downloads.entries.firstOrNull {
                    it.value.transferId == transferId &&
                        it.value.artifact?.artifactId == artifactId
                }
                if (entry != null && entry.value.status !in setOf("paused", "completed", "failed")) {
                    nextDownloads = state.downloads + (
                        entry.key to entry.value.copy(status = "failed", commandId = null, error = event.string("error"))
                    )
                }
            }
            "command.result" -> {
                val commandId = event.string("commandId")
                // 提交回执的 result 不是会话状态；旧 Host 回 unsupported_command 也在这里被静默掉。
                if (commandId?.startsWith("session-sync-ack:") == true) {
                    return state.copy(lastSequence = state.lastSequence + (sequenceKey to sequence))
                }
                val succeeded = event["ok"]?.jsonPrimitive?.booleanOrNull == true
                val status = event.string("status") ?: if (succeeded) "success" else "failure"
                if (commandId?.isSessionSyncCommandId() == true && commandId !in state.sessionSyncCommands) {
                    return state.copy(lastSequence = state.lastSequence + (sequenceKey to sequence))
                }
                if (commandId != null && status == "pending") {
                    nextPendingCommands = state.pendingCommands + (commandId to runtimeId)
                }
                if (commandId != null && status != "pending") {
                    val isSessionSyncCommand = commandId in state.sessionSyncCommands
                    if (isSessionSyncCommand) {
                        // The backend can acknowledge before msg-channel fragments arrive. Only
                        // the committed snapshot completes a successful logical sync task.
                        val acknowledged = if (succeeded) state.copy(
                            pendingCommands = state.pendingCommands - commandId,
                            sessionSyncBusyStreaks = state.sessionSyncBusyStreaks - runtimeId,
                        )
                            else state.failSessionSync(
                                commandId,
                                commandErrorText(event.string("error")),
                                transient = isTransientSessionSyncFailure(event.string("error")),
                                code = event.string("error"),
                            )
                        return acknowledged.copy(lastSequence = state.lastSequence + (sequenceKey to sequence))
                    }
                    nextSessionSyncCommands = state.sessionSyncCommands - commandId
                    nextPendingCommands = state.pendingCommands - commandId
                    val pendingDownload = nextPendingDownloads[commandId]
                    nextPendingDownloads = nextPendingDownloads - commandId
                    if (!succeeded && pendingDownload != null) {
                        state.downloads[pendingDownload.taskId]?.let { task ->
                            nextDownloads = nextDownloads + (
                                pendingDownload.taskId to task.copy(
                                    status = "failed",
                                    commandId = null,
                                    error = commandErrorText(event.string("error")),
                                )
                            )
                        }
                    }
                    nextCommandResults = state.commandResults + (
                        commandId to CommandResult(
                            ok = succeeded,
                            status = status,
                            result = event["result"],
                            error = if (succeeded) null else commandErrorText(event.string("error")),
                        )
                    )
                    if (isSessionSyncCommand) {
                        nextConversation = conversation.copy(
                            isChatSyncing = false,
                            chatSyncError = if (succeeded) null else commandErrorText(event.string("error")),
                        )
                    }
                    val responseInteraction = conversation.interactions.entries.firstOrNull {
                        it.value.responseCommandId == commandId
                    }
                    if (responseInteraction != null) {
                        nextConversation = if (succeeded) {
                            conversation.copy(
                                interactions = conversation.interactions + (responseInteraction.key to responseInteraction.value.copy(
                                    submitted = true, responseCommandId = null, responseError = null)),
                            )
                        } else {
                            conversation.copy(
                                interactions = conversation.interactions + (
                                    responseInteraction.key to responseInteraction.value.copy(responseCommandId = null, submitted = false,
                                        responseError = commandErrorText(event.string("error")))
                                ),
                                // Remote submission feedback comes from the device-scoped Host outcome.
                                interactionNotices = conversation.interactionNotices,
                            )
                        }
                    }
                }
                val isInteractionResponse = conversation.interactions.values.any { it.responseCommandId == commandId }
                if (!succeeded && !isInteractionResponse && status !in setOf("pending", "cancelled")) {
                    nextError = commandErrorText(event.string("error"))
                }
            }
            "runtime.error" -> {
                val runtimeError = event.string("message")?.takeIf(String::isNotBlank)
                    ?: "运行实例发生错误"
                val commandId = event.string("commandId")
                if (commandId?.isSessionSyncCommandId() == true && commandId !in state.sessionSyncCommands) {
                    return state.copy(lastSequence = state.lastSequence + (sequenceKey to sequence))
                }
                val sessionSyncFailed = commandId?.let { state.sessionSyncCommands[it]?.runtimeId == runtimeId } == true
                if (sessionSyncFailed) {
                    return state.failSessionSync(requireNotNull(commandId), runtimeError).copy(
                        lastSequence = state.lastSequence + (sequenceKey to sequence),
                    )
                }
                // Remote banners have one authority: the Host notification inventory.
                // Correlated synchronization failures above still belong to their task.
            }
        }

        return state.copy(
            runtimes = nextRuntimes,
            capabilities = nextCapabilities,
            downloads = nextDownloads,
            sessions = nextSessions,
            conversations = state.conversations + (runtimeId to nextConversation),
            lastSequence = state.lastSequence + (
                sequenceKey to maxOf(state.lastSequence[sequenceKey] ?: -1L, sequence)
            ),
            pendingCommands = nextPendingCommands,
            commandResults = nextCommandResults,
            sessionGraphs = nextSessionGraphs,
            runtimeSessionViews = nextRuntimeSessionViews,
            sessionSyncCommands = nextSessionSyncCommands,
            sessionSyncFailures = nextSessionSyncFailures,
            sessionBranchGenerations = nextBranchGenerations,
            sessionSyncRequests = nextSessionSyncRequests,
            sessionHistory = nextSessionHistory,
            sessionReads = nextHistoryReads,
            sessionRangeFailures = nextRangeFailures,
            pendingDownloads = nextPendingDownloads,
            error = nextError,
        )
    }

    internal fun reduceArtifactChunk(
        state: RemoteState,
        runtimeId: String,
        transferId: String,
        offset: Long,
        length: Int,
        receivedOffset: Long? = null,
    ): RemoteState {
        val entry = state.downloads.entries.firstOrNull {
            // Downloads are served by Host; runtimeId is therefore the transport route, not
            // necessarily the source runtime stored on the task. transferId is globally unique.
            it.value.transferId == transferId
        } ?: return state
        val download = entry.value
        val artifactSize = download.artifact?.size ?: return state
        if (download.status != "downloading") return state
        if (offset < 0 || length <= 0 || offset > artifactSize || length.toLong() > artifactSize - offset) {
            return state.copy(error = "下载数据校验失败，请重新下载")
        }
        if (offset != download.receivedBytes) return state
        val nextOffset = receivedOffset ?: (offset + length)
        if (nextOffset < offset + length || nextOffset > artifactSize) return state
        return state.copy(
            downloads = state.downloads + (
                entry.key to download.copy(receivedBytes = maxOf(download.receivedBytes, nextOffset))
            ),
        )
    }

    private fun isValidSha256(value: String): Boolean = value.matches(Regex("^[a-f0-9]{64}$"))

    private fun isSafeArtifactFileName(fileName: String): Boolean = fileName.isNotBlank() &&
    fileName != "." && fileName != ".." &&
    !fileName.contains('/') && !fileName.contains('\\') &&
    fileName.none { it.code < 0x20 || it.code == 0x7f }

    private fun ChatMessage.appendDelta(contentType: String, delta: String): ChatMessage {
        // A tool call's streamed arguments must never be concatenated onto the assistant prose: the
        // finalized message replaces this row with a real `tool_call` block. Keeping the fragments in
        // their own block makes the live row render as a collapsed tool call instead of appending
        // argument JSON to the visible answer.
        val index = content.indexOfLast { it.type == contentType }
        if (index < 0) return copy(content = content + RemoteContent(type = contentType, text = delta))
        val next = content.toMutableList()
        val current = next[index]
        next[index] = current.copy(text = current.text.orEmpty() + delta)
        return copy(content = next)
    }

    private fun interactionCancellationText(reason: String?): String = when (reason) {
        "timeout" -> "交互请求已超时"
        "disconnected" -> "交互请求因连接断开而取消"
        "owner_closed" -> "电脑端已结束此交互"
        else -> "交互请求已取消"
    }

    /**
     * 电脑端回绝一条请求时的说法。
     *
     * 这些错误**全部**来自 Host（走 E2E 密文里的 `protocol.error`），只有前四个 code 是
     * Host 替 Relay 转述的。过去一律渲染成「中继服务器协议错误 [code]」，把「电脑端没启用
     * Codex 后端」这种能自己修的事说成了中继协议问题，排查方向直接跑偏；现在按 code 分派，
     * 拿不到专用文案时也如实说「电脑端拒绝了请求」。
     */
    private fun protocolErrorText(code: String?, message: String?): String {
        // `message` 有两个来源：中继只发英文短句（The selected runtime is offline），
        // 电脑端 Host 发的是带细节的中文（目录不存在：D:\…、runtime xxx 当前没有在本机运行）。
        // 所以中文原文优先——它比通用映射更有用；英文原文不如映射表里我们自己写的文案一致。
        val detail = message?.takeIf(String::isNotBlank)
        val chinese = detail?.takeIf { it.containsCjk() }
        return when (code) {
            "unauthorized" -> "Relay 拒绝了设备凭据，请重新扫码配对"
            "protocol_version_mismatch" -> PROTOCOL_VERSION_MISMATCH_ERROR
            // 不再写死版本号：协议升到 4 之后这句话还在说 v3，把排查方向直接带偏——而
            // `invalid_message` 其实也可能来自「帧结构非法」（两端同版本照样会发生，比如
            // `hdr` 里混进了 null），版本号到底是多少得由常量说了算。
            "invalid_message" ->
                "Relay 拒绝了协议消息，请确认手机端与电脑端都是最新版（protocol v$PROTOCOL_VERSION）"
            "runtime_mismatch" -> "Relay 拒绝了运行实例身份，请重启电脑端 Orbis Host"
            "runtime_offline" -> chinese ?: "目标运行实例已离线"
            "unsupported_command" -> chinese ?: "电脑端不支持该命令"
            // 会话/进程类失败（§8）：电脑端自己的问题，别挂到中继头上。
            "agent_unsupported", "spawn_failed", "spawn_limit_reached",
            "cwd_missing", "session_not_found", "session_request_failed",
            -> chinese ?: "电脑端无法完成该会话请求"
            null, "" -> "电脑端拒绝了请求，但没有说明原因"
            else -> detail?.let { "电脑端拒绝了请求（$code）：$it" } ?: "电脑端拒绝了请求（$code）"
        }
    }

    private fun commandErrorText(code: String?): String = when (code) {
        "runtime_mismatch" -> "命令发送到了错误的运行实例"
        "interaction_not_available" -> "交互请求已失效或不可用"
        "runtime_offline" -> "目标运行实例已离线"
        "slash_commands_not_available" -> "当前会话未提供斜杠命令"
        "slash_command_not_available" -> "所选命令已不可用，请重新打开菜单"
        "slash_command_argument_required" -> "所选命令需要参数"
        "slash_command_arguments_not_allowed" -> "所选命令不接受参数"
        "slash_command_argument_not_available" -> "所选参数已不可用，请重新选择"
        "slash_command_cancelled", "slash command cancelled" -> "命令已取消"
        "not_cancelable" -> "当前 Agent 版本无法按队列项取消，消息仍会保留"
        "already_delivered" -> "消息已经送入上下文，无法取消"
        "runtime_busy" -> "当前会话正在运行任务，暂时无法执行此命令"
        "model_not_available" -> "所选模型已不可用"
        "thinking_level_not_available" -> "所选思考级别已不可用"
        "session_not_available" -> "所选 Session 已不可用"
        "assistant_message_not_available" -> "当前没有可复制的助手消息"
        "file_not_available" -> "电脑端文件不可用"
        "file_not_a_file" -> "所选路径不是普通文件"
        "file_size_invalid" -> "电脑端文件大小无效"
        "artifact_changed" -> "电脑端文件已发生变化，请重新下载"
        "artifact_chunk_invalid", "artifact_size_mismatch" -> "文件传输数据不完整"
        null, "" -> "命令执行失败"
        else -> when {
            code.startsWith("ENOENT:") -> "电脑端文件不存在或已被删除"
            code.startsWith("EACCES:") || code.startsWith("EPERM:") -> "Orbis Host 无权读取电脑端文件"
            else -> "命令执行失败：$code"
        }
    }

    private fun parsePendingInteraction(
        json: Json,
        request: JsonObject,
        previous: PendingInteraction?,
    ): PendingInteraction? {
        val requestId = request.string("requestId") ?: return null
        val extensionId = request.string("extensionId") ?: return null
        val kind = request.string("kind") ?: return null
        val title = request.string("title") ?: return null
        if (kind !in setOf("confirm", "select", "multi-select", "input", "questionnaire")) return null
        val interaction = runCatching {
            PendingInteraction(
                requestId = requestId,
                extensionId = extensionId,
                kind = kind,
                title = title,
                description = request.string("description"),
                options = request["options"]?.let {
                    json.decodeFromJsonElement<List<InteractionOption>>(it)
                }.orEmpty(),
                placeholder = request.string("placeholder"),
                toolName = request.string("toolName"),
                argumentSummary = request.string("argumentSummary"),
                externalUrl = request.string("externalUrl")?.takeIf { it.startsWith("https://") || it.startsWith("http://") },
                submitted = request["submitted"]?.jsonPrimitive?.booleanOrNull == true,
                confirmLabel = request.string("confirmLabel"),
                cancelLabel = request.string("cancelLabel"),
                initialValue = request.string("initialValue"),
                minLength = request["minLength"]?.jsonPrimitive?.intOrNull,
                maxLength = request["maxLength"]?.jsonPrimitive?.intOrNull,
                minSelections = request["minSelections"]?.jsonPrimitive?.intOrNull,
                maxSelections = request["maxSelections"]?.jsonPrimitive?.intOrNull,
                secret = request["secret"]?.jsonPrimitive?.booleanOrNull == true,
                expiresAt = request["expiresAt"]?.jsonPrimitive?.longOrNull ?: Long.MAX_VALUE,
                questions = request["questions"]?.let {
                    json.decodeFromJsonElement<List<QuestionnaireQuestion>>(it)
                }.orEmpty(),
                responseCommandId = previous?.responseCommandId,
            )
        }.getOrNull() ?: return null
        val validShape = when (kind) {
            "questionnaire" -> interaction.questions.isNotEmpty() &&
                interaction.questions.map { it.id }.distinct().size == interaction.questions.size &&
                interaction.questions.all { question ->
                    question.id.isNotBlank() && (question.options.isNotEmpty() || question.allowOther) &&
                        question.options.map { it.value }.distinct().size == question.options.size
                }
            "select" -> interaction.options.isNotEmpty()
            "multi-select" -> interaction.options.isNotEmpty() &&
                (interaction.minSelections == null || interaction.maxSelections == null ||
                    interaction.minSelections <= interaction.maxSelections)
            "input" -> interaction.minLength == null || interaction.maxLength == null ||
                interaction.minLength <= interaction.maxLength
            else -> true
        }
        return interaction.takeIf { validShape }
    }

    /** 原文里有没有中日韩文字：用来区分「中继的英文短句」和「电脑端的具体中文说明」。 */
private fun String.containsCjk(): Boolean = any { character ->
    character.code in 0x3000..0x9FFF ||
        character.code in 0xF900..0xFAFF ||
        character.code in 0xFF00..0xFFEF
}

private fun JsonObject.string(key: String): String? = this[key]?.jsonPrimitive?.contentOrNull
}
