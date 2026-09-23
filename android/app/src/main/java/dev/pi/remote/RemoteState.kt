package dev.pi.remote

import kotlinx.serialization.Serializable
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
    /** OS hostname of the Pi machine; device identity that needs no user configuration. */
    val hostname: String? = null,
    val sessionName: String? = null,
    /** Active model reported by the Runtime; absent on older Runtime or Relay versions. */
    val model: RuntimeModelInfo? = null,
    /** Current thinking depth (`thinkingLevel` for Pi, reasoning effort for Codex). */
    val thinkingLevel: String? = null,
    /** Context utilization reported by the Runtime; absent on older Runtime or Relay versions. */
    val contextUsage: RuntimeContextUsage? = null,
    val permissions: RuntimePermissions? = null,
) {
    /**
     * 这条 Runtime 是不是 Codex 会话。codex 的对外 runtimeId 形如 `codex:<threadId>`
     * （旧版是固定 `codex`），Pi 是随机 UUID——前缀判定不会撞。
     * 只用于展示层（命令来源徽标、侧栏角标），不参与协议语义。
     */
    val isCodex: Boolean
        get() = runtimeId == CODEX_RUNTIME_ID || runtimeId.startsWith("$CODEX_RUNTIME_ID:")
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
    val toolCallId: String? = null,
    val toolName: String? = null,
    val arguments: JsonElement? = null,
    val artifact: RemoteArtifact? = null,
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

internal fun fileDownloadTaskId(runtimeId: String, path: String): String =
    fileDownloadTaskId(runtimeId, null, path)

internal fun fileDownloadTaskId(runtimeId: String, sessionId: String?, path: String): String = UUID.nameUUIDFromBytes(
    "$runtimeId\u0000${sessionId.orEmpty()}\u0000file\u0000$path".toByteArray(Charsets.UTF_8),
).toString()

internal fun artifactDownloadTaskId(runtimeId: String, artifactId: String): String =
    artifactDownloadTaskId(runtimeId, null, artifactId)

internal fun artifactDownloadTaskId(runtimeId: String, sessionId: String?, artifactId: String): String = UUID.nameUUIDFromBytes(
    "$runtimeId\u0000${sessionId.orEmpty()}\u0000artifact\u0000$artifactId".toByteArray(Charsets.UTF_8),
).toString()

internal fun downloadDisplayName(path: String): String = path.trimEnd('/', '\\')
    .substringAfterLast('/')
    .substringAfterLast('\\')
    .ifBlank { "电脑文件" }

@Serializable
data class ArtifactDownload(
    val taskId: String,
    val runtimeId: String,
    val sessionId: String? = null,
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
    // 不绑 runtimeId：下载由 Host 服务，事件带的 runtimeId 是 hostId，而任务上的 runtimeId
    // 是来源标记（§9.4）。按 artifact 身份匹配即可（artifactId 唯一；路径下载比对源路径）。
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
    val isChatSyncing: Boolean = false,
    val chatSyncError: String? = null,
    /** Runtime-level diagnostics belong to this runtime, not to the app-wide error channel. */
    val runtimeError: String? = null,
    val revision: Long = 0,
    val tools: Map<String, ToolActivity> = emptyMap(),
    val turnTimings: Map<String, TurnTiming> = emptyMap(),
    val activeTurnId: String? = null,
    val queuedMessages: Map<String, QueuedMessage> = emptyMap(),
    val deliveredQueueIds: Set<String> = emptySet(),
    val interactions: Map<String, PendingInteraction> = emptyMap(),
    val waitingLocalInteraction: Boolean = false,
    val interactionNotice: String? = null,
)

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
    val runtimes: Map<String, RuntimeSummary> = emptyMap(),
    val workingBranches: Map<String, WorkingBranch> = emptyMap(),
    /** Last known session identity survives a transient runtime.offline event. */
    val knownRuntimeSessions: Map<String, String?> = emptyMap(),
    val conversations: Map<String, RuntimeConversation> = emptyMap(),
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
    val sessionGraphs: Map<String, SessionGraph> = emptyMap(),
    val runtimeSessionViews: Map<String, RuntimeSessionView> = emptyMap(),
    val sessionSyncCommands: Map<String, PendingSessionSync> = emptyMap(),
    val sessionBranchGenerations: Map<String, Int> = emptyMap(),
    /** Stops automatic reloads after failure, even if unrelated live events update the display. */
    val sessionSyncFailures: Map<String, String> = emptyMap(),
    val sessionSyncRequests: Set<String> = emptySet(),
    val sessionHistory: Map<String, SessionHistoryState> = emptyMap(),
    val downloads: Map<String, ArtifactDownload> = emptyMap(),
    /** 手机发往电脑的上传任务（spec: 手机上传文件到电脑），key = taskId。 */
    val uploads: Map<String, UploadTask> = emptyMap(),
    val pendingDownloads: Map<String, PendingDownload> = emptyMap(),
    val sessionAliases: Map<SessionAliasIdentity, String> = emptyMap(),
    /** Each list request records the archive revision it started under. */
    val sessionListEpoch: Long = 0,
    val sessionListRequestEpochs: Map<String, Long> = emptyMap(),
    /** 进行中的 session.list 请求（spec §8）：requestId 集合，响应/错误到达后移除。 */
    val sessionListRequests: Set<String> = emptySet(),
    /** 新建会话 / 下载共用的电脑文件浏览：null 表示选择器已关闭。 */
    val sessionBrowse: SessionBrowseState? = null,
    /** 进行中的 session.activate 请求（L1 resume / L2 new 共用）。 */
    val sessionActivateRequests: Set<String> = emptySet(),
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
    val error: String? = null,
)

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
 * instead of blanking the composer status on the next metadata refresh.
 */
internal fun RuntimeSummary.carryingComposerStatus(previous: RuntimeSummary?): RuntimeSummary {
    if (previous == null) return this
    return copy(
        model = model ?: previous.model,
        thinkingLevel = thinkingLevel ?: previous.thinkingLevel,
        contextUsage = contextUsage ?: previous.contextUsage,
        permissions = permissions ?: previous.permissions.takeIf { sessionId == previous.sessionId },
    )
}

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
        hostname = incoming.hostname ?: existing.hostname,
        agentKind = incoming.agentKind ?: existing.agentKind,
        archived = incoming.archived ?: existing.archived,
    )
}

/**
 * session.list.result（spec §8）：全量会话索引合并进侧栏目录。磁盘扫描的条目没有
 * hasHistoryCache（那是历史同步的标记），所以只合并不替换；requestId 收尾。
 */
private fun reduceSessionListResult(state: RemoteState, message: JsonObject): RemoteState {
    val requestId = message["requestId"]?.jsonPrimitive?.contentOrNull
    if (requestId != null && requestId !in state.sessionListRequests) {
        android.util.Log.w("PiRemote.SessionList", "session.list.result 的 requestId 不在在途集合里，丢弃（requestId=$requestId）")
        return state
    }
    if (requestId != null && (state.sessionListRequestEpochs[requestId] ?: state.sessionListEpoch) < state.sessionListEpoch) {
        return state.copy(
            sessionListRequests = state.sessionListRequests - requestId,
            sessionListRequestEpochs = state.sessionListRequestEpochs - requestId,
        )
    }
    val sessions = runCatching {
        message["sessions"]?.let { sessionMessageJson.decodeFromJsonElement<List<SessionCatalogEntry>>(it) }
    }.onFailure {
        android.util.Log.e("PiRemote.SessionList", "session.list.result 解码失败", it)
    }.getOrNull() ?: return state.copy(
        sessionListRequests = requestId?.let { state.sessionListRequests - it } ?: state.sessionListRequests,
        sessionListRequestEpochs = requestId?.let { state.sessionListRequestEpochs - it } ?: state.sessionListRequestEpochs,
    )
    var merged = state.sessions
    for (entry in sessions) {
        merged = merged + (entry.sessionId to mergeSessionCatalogEntry(merged[entry.sessionId], entry))
    }
    return state.copy(
        sessions = merged,
        sessionListRequests = requestId?.let { state.sessionListRequests - it } ?: state.sessionListRequests,
        sessionListRequestEpochs = requestId?.let { state.sessionListRequestEpochs - it } ?: state.sessionListRequestEpochs,
    )
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
        sessions = state.sessions + (sessionId to (entry ?: SessionCatalogEntry(sessionId)).copy(
            agentKind = agentKind, archived = archived,
        )),
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
    return state.copy(
        sessionActivateRequests = requestId?.let { state.sessionActivateRequests - it } ?: state.sessionActivateRequests,
        sessionActivation = SessionActivationInfo(
            requestId = requestId ?: "",
            agentKind = agentKind,
            sessionId = message["sessionId"]?.jsonPrimitive?.contentOrNull,
            spawnMode = message["spawnMode"]?.jsonPrimitive?.contentOrNull ?: "tui",
        ),
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
        pending.branchGeneration == (sessionBranchGenerations[runtimeId] ?: 0)
}

internal fun RemoteState.failSessionSync(commandId: String, message: String): RemoteState {
    val pending = sessionSyncCommands[commandId] ?: return this
    val conversation = conversations[pending.runtimeId] ?: RuntimeConversation()
    return releaseHistoryRequest(commandId).copy(
        pendingCommands = pendingCommands - commandId,
        sessionSyncCommands = sessionSyncCommands - commandId,
        sessionSyncRequests = sessionSyncRequests - pending.runtimeId,
        sessionSyncFailures = sessionSyncFailures + (pending.runtimeId to message),
        conversations = conversations + (pending.runtimeId to conversation.copy(
            isChatSyncing = false, chatSyncError = message, revision = conversation.revision + 1,
        )),
    )
}

/** The runtime metadata supplies freshness; the local page supplies its immutable contents. */
internal fun RemoteState.seedCachedSessionView(runtimeId: String, graph: SessionGraph): RemoteState {
    val runtime = runtimes[runtimeId] ?: return this
    if (runtime.sessionId != graph.sessionId) return this
    val leaf = runtime.sessionLeafId ?: return this
    if (!graph.entries.containsKey(leaf)) return this
    val conversation = conversations[runtimeId] ?: RuntimeConversation()
    if (conversation.hasLiveSnapshot && conversation.messages.isNotEmpty()) return this
    val projection = projectSessionGraph(graph.copy(cursor = SessionBranchCursor(leaf)), sessionMessageJson)
        .let { if (it.error == "missing_parent") it.copy(error = null) else it }
    val (messages, overlay) = mergeProjectedWithStreaming(projection.messages, conversation)
    val branch = buildSessionPath(graph.entries, leaf)
    return copy(
        conversations = conversations + (runtimeId to conversation.applyProjection(projection, messages, keepLiveTiming = true).copy(
            hasLiveSnapshot = true, isChatSyncing = false, streamingMessageIds = overlay,
            streamingSessionId = graph.sessionId.takeIf { overlay.isNotEmpty() }, revision = conversation.revision + 1,
        )),
        runtimeSessionViews = runtimeSessionViews + (runtimeId to RuntimeSessionView(runtimeId, graph.sessionId, leaf)),
        sessionHistory = sessionHistory + (runtimeId to (sessionHistory[runtimeId]?.takeIf { it.sessionId == graph.sessionId }
            ?: SessionHistoryState(graph.sessionId, leaf, branch.firstOrNull()?.entryId, branch.firstOrNull()?.parentId != null))),
    )
}

private fun RemoteState.isKnownBranchChange(
    sessionId: String?,
    previousLeafId: String?,
    nextLeafId: String?,
): Boolean {
    if (sessionId == null || previousLeafId == null || nextLeafId == null || previousLeafId == nextLeafId) return false
    val graph = sessionGraphs[sessionId] ?: return false
    if (!graph.entries.containsKey(previousLeafId) || !graph.entries.containsKey(nextLeafId)) return false
    if (graph.isDescendant(nextLeafId, previousLeafId)) return false
    val previousPath = buildSessionPath(graph.entries, previousLeafId).map { it.entryId }.toSet()
    val nextPath = buildSessionPath(graph.entries, nextLeafId)
    // Two disconnected fragments cannot prove a branch change; their missing parent may still
    // join them. A common ancestor or a known root does prove the paths have diverged/rewound.
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
    // A refresh response is a replacement projection. Never start one while Pi is producing
    // deltas, because its asynchronous snapshot can race the live message lifecycle events.
    if (runtime.status == "running" || conversation.streamingMessageIds.isNotEmpty()) return this
    val alreadyPending = sessionSyncCommands.values.any { it.runtimeId == runtimeId }
    if (alreadyPending || !runtime.sessionGraphSync) return this
    // A periodic refresh reconciles the Session Graph in the background. Once the conversation
    // already has displayable content, keep that snapshot live while the preview/catch-up request
    // is in flight; invalidating it here makes the UI flash its loading indicator and re-anchor
    // the list on every poll. Only an initial/empty conversation needs the blocking load state.
    val needsDisplayLoad = conversation.hasLiveSnapshot != true || conversation.messages.isEmpty()
    return copy(
        conversations = conversations + (
            runtimeId to conversation.copy(
                hasLiveSnapshot = if (needsDisplayLoad) false else conversation.hasLiveSnapshot,
                isChatSyncing = if (needsDisplayLoad) true else conversation.isChatSyncing,
                chatSyncError = null,
            )
        ),
        sessionSyncRequests = if (runtime.sessionGraphSync) {
            sessionSyncRequests + runtimeId
        } else {
            sessionSyncRequests
        },
    )
}

internal fun shouldStartBranchCatchUpImmediately(
    conversation: RuntimeConversation?,
    hasInMemoryGraph: Boolean,
): Boolean = hasInMemoryGraph && conversation?.hasLiveSnapshot == true

private fun RuntimeSummary.isSyncPending(
    selectedRuntimeId: String?,
    graphs: Map<String, SessionGraph>,
): Boolean = sessionGraphSync &&
    runtimeId == selectedRuntimeId && sessionId != null &&
    (graphs[sessionId]?.hasCompleteCursor(sessionLeafId) != true)

private fun RuntimeSummary.catalogEntry(): SessionCatalogEntry? = sessionId?.let { id ->
    SessionCatalogEntry(
        sessionId = id,
        // Empty means the current runtime is explicitly unnamed, so a cleared title
        // must not be resurrected by the catalog's missing-field merge fallback.
        name = sessionName?.trim().orEmpty(),
        cwd = cwd,
        modifiedAt = 0,
        messageCount = 0,
        // 在线进程合入目录时也要带 agentKind（codex 是固定虚拟 runtimeId，Pi 是 UUID），
        // 否则侧栏在 session.list 刷新前无法给在线 codex 会话画角标。
        agentKind = if (runtimeId == CODEX_RUNTIME_ID || runtimeId.startsWith("$CODEX_RUNTIME_ID:")) "codex" else "pi",
    )
}

/** codex 的固定虚拟 runtimeId（host 侧同值）。Pi 的 runtimeId 是随机 UUID，不会撞。 */
const val CODEX_RUNTIME_ID = "codex"

/** 该侧栏行是不是 codex 会话：目录条目优先，在线 runtime 兜底（session.list 未刷新时条目可能为 null）。 */
internal val CachedSessionRow.isCodex: Boolean
    get() = catalogEntry?.agentKind == "codex" || runtimeId == CODEX_RUNTIME_ID || runtimeId?.startsWith("$CODEX_RUNTIME_ID:") == true

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
    val hostname: String?,
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

/** One top-level tree node in the cached-history sidebar: a Pi host and its directories. */
internal data class CachedHostGroup(
    val hostname: String?,
    val directories: List<CachedDirectoryGroup>,
)

/** All hosts the sidebar can switch to, sorted with named hosts first and the unknown bucket last. */
internal data class SidebarHostList(
    val hosts: List<String?>,
    val defaultSelected: String?,
) {
    fun contains(hostname: String?): Boolean = hosts.contains(hostname)
}

/**
 * Returns the list of distinct hostnames represented by online runtimes and offline cache rows.
 * Named hosts come first in alphabetical order, the unknown-host bucket (null) is always last so
 * the sidebar can surface named hosts first and place "未知主机" at the end of the chip row.
 */
internal fun sidebarHostList(tree: List<CachedHostGroup>): SidebarHostList {
    if (tree.isEmpty()) return SidebarHostList(emptyList(), null)
    val (named, unnamed) = tree.map { it.hostname }.partition { it != null }
    val sortedNamed = named.sortedBy { it }
    val hosts = sortedNamed + unnamed
    val defaultSelected = sortedNamed.firstOrNull() ?: hosts.firstOrNull()
    return SidebarHostList(hosts, defaultSelected)
}

/**
 * Builds the sidebar tree (`host -> directory -> session`). Online runtimes and offline catalog
 * Sessions share one tree, and a Session currently open by an online Runtime takes precedence over
 * any cached entry for the same sessionId. All surfaces resolve the title through
 * sessionDisplayName: local alias, agent name, then a first-user-message preview.
 *
 * 侧栏是**聊天记录的全量目录**：电脑上存在过的会话都要出现，不管手机有没有缓存过它。
 * 只看 `hasHistoryCache` 会把「电脑上有、本机没打开过」的会话藏起来，而那正是用户要
 * 找的东西——没缓存的会话点一下就把会话加载进一个进程（§8.1），不需要先有缓存。
 */
internal fun cachedHistoryTree(state: RemoteState): List<CachedHostGroup> {
    val runtimesBySession = state.runtimes.values
        .filter { it.sessionId != null }
        .sortedBy(state::runtimeDisplayName)
        .groupBy { it.sessionId.orEmpty() }
    val rows = linkedMapOf<String, CachedSessionRow>()
    for ((sessionId, runtimes) in runtimesBySession) {
        val runtime = runtimes.firstOrNull() ?: continue
        val session = state.sessions[sessionId]
        rows[sessionId] = CachedSessionRow(
            sessionId = sessionId,
            runtimeId = runtime.runtimeId,
            isOnline = true,
            cwd = runtime.cwd.ifBlank { session?.cwd.orEmpty() },
            // Runtime metadata may omit the host (for example, Codex). Opening the
            // session must not move it out of its existing sidebar host group.
            hostname = runtime.hostname?.takeIf(String::isNotBlank)
                ?: session?.hostname?.takeIf(String::isNotBlank),
            catalogEntry = session,
            title = state.runtimeDisplayName(runtime),
            messageCount = state.conversations[runtime.runtimeId]?.messages?.size ?: 0,
            modifiedAt = session?.modifiedAt ?: 0L,
        )
    }
    for (session in state.sessions.values) {
        if (rows.containsKey(session.sessionId)) continue
        val hostname = state.runtimes.values
            .filter { it.sessionId == session.sessionId }
            .sortedBy(state::runtimeDisplayName)
            .firstOrNull()
            ?.hostname
            ?.takeIf(String::isNotBlank)
            ?: session.hostname?.takeIf(String::isNotBlank)
        rows[session.sessionId] = CachedSessionRow(
            sessionId = session.sessionId,
            runtimeId = null,
            isOnline = false,
            cwd = session.cwd,
            hostname = hostname,
            catalogEntry = session,
            title = state.sessionDisplayName(session.sessionId),
            messageCount = session.messageCount,
            modifiedAt = session.modifiedAt,
        )
    }
    return rows.values
        .groupBy { it.hostname }
        .toSortedMap(compareBy(nullsLast<String>()) { it })
        .map { (hostname, hostRows) ->
            val directories = hostRows
                .groupBy { it.cwd }
                .values
                .map { directoryRows ->
                    CachedDirectoryGroup(
                        cwd = directoryRows.first().cwd,
                        sessions = directoryRows.sortedWith(
                            compareByDescending<CachedSessionRow> { it.sortKey() }
                                .thenBy { it.sessionId },
                        ),
                    )
                }
                .sortedWith(
                    compareByDescending<CachedDirectoryGroup> { it.modifiedAt }
                        .thenBy { it.cwd },
                )
            CachedHostGroup(hostname, directories)
        }
}

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
        .filter { it.messageId !in projectedIds && !projectedMessages.represents(it) }
    return projectedMessages + retainedOverlays to retainedOverlays.map(ChatMessage::messageId).toSet()
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
        sessionSyncFailures = emptyMap(),
        sessionSyncRequests = emptySet(),
        sessionHistory = sessionHistory.mapValues { (_, history) -> history.copy(loading = false, requestId = null) },
        error = error.takeIf { preserveError },
    )
}

class RelayReducer(
    private val json: Json = Json { ignoreUnknownKeys = true },
) {
    /**
     * `persistedSessionEntries` is supplied by RemoteViewModel after the batch has been written
     * and read back from SessionGraphStore. Tests and the cache-failure fallback leave it null,
     * which intentionally uses the wire entries directly for a live preview.
     */
    fun reduce(
        state: RemoteState,
        payload: String,
        persistedSessionEntries: List<SessionGraphEntry>? = null,
        channel: String? = null,
    ): RemoteState {
        val message = json.parseToJsonElement(payload).jsonObject
        val messageType = message.string("type")
        if (messageType !in setOf(
                "device.ready", "runtime.online", "runtime.offline", "runtime.event", "runtime.git",
                "protocol.error",
                "artifact.read.failed",
                // 上传的入站消息：状态由 ViewModel 的上传处理器维护，reducer 只需不把它当非法消息。
                "file.upload.ready", "file.upload.read", "file.upload.progress", "file.upload.finished", "file.upload.failed",
                "session.list.result", "session.browse.result", "session.activated", "session.archive.changed",
                "host.online", "host.offline",
            )) {
            return state.copy(error = "收到不支持的中继服务器消息，请在电脑端检查协议版本")
        }
        val protocolVersion = message["protocolVersion"]?.jsonPrimitive?.intOrNull
        // 用常量而不是字面量：写死版本号会在协议升级时**静默**把每条消息都变成错误，
        // 现象是界面永远停在「正在连接」+ 弹「不兼容的协议版本」，而链路其实是通的。
        if (protocolVersion != null && protocolVersion != PROTOCOL_VERSION) {
            return state.copy(error = "收到不兼容的协议版本，请升级 Orbis")
        }
        return when (messageType) {
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
                val sessionChanged = runtimes.keys.associateWith { runtimeId ->
                    val previousRuntime = state.runtimes[runtimeId]
                    val hasPrevious = previousRuntime != null ||
                        state.knownRuntimeSessions.containsKey(runtimeId)
                    val previousSessionId = previousRuntime?.sessionId
                        ?: state.knownRuntimeSessions[runtimeId]
                    !hasPrevious || previousSessionId != runtimes[runtimeId]?.sessionId
                }
                val branchChanged = runtimes.keys.associateWith { runtimeId ->
                    if (sessionChanged[runtimeId] == true) false else {
                        val runtime = runtimes[runtimeId]
                        val previousLeaf = state.runtimes[runtimeId]?.sessionLeafId
                            ?: state.runtimeSessionViews[runtimeId]?.leafId
                        state.isKnownBranchChange(
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
                    val keepPreviousView = previousView != null &&
                        previousView.sessionId == incomingView.sessionId &&
                        runtime.sessionLeafId != null &&
                        state.sessionGraphs[incomingView.sessionId]?.hasCompleteCursor(runtime.sessionLeafId) != true
                    runtimeViews[runtime.runtimeId] = if (keepPreviousView) previousView else incomingView
                }
                val conversations = runtimes.mapValues { (runtimeId, runtime) ->
                    val previous = state.conversations[runtimeId]
                    val hasPreviousRuntime = state.runtimes.containsKey(runtimeId) ||
                        state.knownRuntimeSessions.containsKey(runtimeId)
                    val preservePreOnlineInteraction = !hasPreviousRuntime && previous != null &&
                        previous.interactions.isNotEmpty()
                    val displayNeedsPreview = runtime.runtimeId == state.selectedRuntimeId &&
                        previous?.hasLiveSnapshot != true
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
                    sessions = sessions,
                    runtimes = runtimes,
                    supportedAgents = supportedAgents,
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
                        conversation.withoutActiveTurn()
                    },
                    lastSequence = state.lastSequence.filterKeys { key ->
                        runtimes.keys.any { runtime -> key == runtime || key.startsWith("$runtime\u0000") }
                    },
                    capabilities = state.capabilities.filterKeys(runtimes::containsKey),
                    pendingDownloads = state.pendingDownloads.filterValues { it.runtimeId in runtimes },
                    sessionSyncCommands = emptyMap(),
                    sessionSyncFailures = emptyMap(),
                    // Graph history is lazy: only the selected Runtime requests it.
                    sessionSyncRequests = state.sessionSyncRequests + runtimes.values
                        .filter { runtime ->
                            runtime.sessionGraphSync && (
                                runtime.isSyncPending(state.selectedRuntimeId, state.sessionGraphs) ||
                                    runtime.runtimeId == state.selectedRuntimeId &&
                                    state.conversations[runtime.runtimeId]?.hasLiveSnapshot != true
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
                val branchChanged = !sessionChanged && state.isKnownBranchChange(
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
                    state.conversations[runtime.runtimeId]?.hasLiveSnapshot != true
                val shouldSync = runtime.isSyncPending(state.selectedRuntimeId, state.sessionGraphs) || displayNeedsPreview
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
                val runtimeView = runtime.sessionView(runtime.runtimeId)
                val sessions = runtimeCatalog?.let { entry ->
                    state.sessions + (entry.sessionId to mergeSessionCatalogEntry(state.sessions[entry.sessionId], entry))
                } ?: state.sessions
                state.copy(
                    sessions = sessions,
                    sessionBranchGenerations = if (sessionChanged || branchChanged) {
                        state.sessionBranchGenerations + (runtime.runtimeId to ((state.sessionBranchGenerations[runtime.runtimeId] ?: 0) + 1))
                    } else state.sessionBranchGenerations,
                    runtimes = state.runtimes + (runtime.runtimeId to runtime.carryingComposerStatus(previousRuntime)),
                    runtimeSessionViews = runtimeView?.let {
                        val previousView = state.runtimeSessionViews[runtime.runtimeId]
                        val keepPreviousView = previousView != null &&
                            previousView.sessionId == it.sessionId &&
                            runtime.sessionLeafId != null &&
                            state.sessionGraphs[it.sessionId]?.hasCompleteCursor(runtime.sessionLeafId) != true
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
                    runtimes = emptyMap(),
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
                    sessionSyncRequests = state.sessionSyncRequests - runtimeId,
                )
            }
            "runtime.event" -> reduceRuntimeEvent(state, message, persistedSessionEntries, channel)
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
                val commandId = message.string("commandId")
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
                if (sessionSync != null && commandId != null) return state.failSessionSync(commandId, syncError).copy(error = syncError)
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
        persistedSessionEntries: List<SessionGraphEntry>? = null,
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
        if (sequence <= (state.lastSequence[sequenceKey] ?: -1) && !snapshotStillOwned) return state
        val supportedEvents = setOf(
            "runtime.status", "runtime.metadata", "runtime.capabilities", "session.catalog", "message.queued", "session.snapshot", "message.started", "message.delta",
            "message.finished", "turn.started", "turn.finished", "tool.started", "tool.updated", "tool.finished", "artifact.started",
            "artifact.failed", "interaction.requested", "interaction.snapshot",
            "interaction.resolved", "interaction.cancelled", "local_interaction.required", "command.result", "runtime.error",
        )
        if (eventType !in supportedEvents) {
            return state.copy(error = "手机无法安全处理此运行时事件，请在电脑端处理")
        }
        val conversation = state.conversations[runtimeId] ?: RuntimeConversation()
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
        var nextDownloads = state.downloads
        var nextPendingDownloads = state.pendingDownloads

        when (eventType) {
            "runtime.status" -> {
                val status = event.string("status") ?: return state
                state.runtimes[runtimeId]?.let { runtime ->
                    nextRuntimes = state.runtimes + (runtimeId to runtime.copy(status = status))
                }
                if (status != "waiting_local_interaction") {
                    nextConversation = if (status == "idle") {
                        conversation.withoutActiveTurn().copy(waitingLocalInteraction = false)
                    } else {
                        conversation.copy(waitingLocalInteraction = false)
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
                val targetKnown = metadata.sessionLeafId != null &&
                    graphForMetadata?.entries?.containsKey(metadata.sessionLeafId) == true
                // A new leaf is not enough to prove a branch switch: normal turn completion
                // advances the leaf before the catch-up response arrives. Only a leaf already
                // present in the canonical graph can prove that it is a different branch.
                val branchChanged = !sessionChanged && state.isKnownBranchChange(
                    metadata.sessionId, previousLeaf, metadata.sessionLeafId,
                )
                nextRuntimes = state.runtimes + (runtimeId to metadata.carryingComposerStatus(previousRuntime))
                if (sessionChanged || branchChanged) {
                    nextBranchGenerations = nextBranchGenerations + (runtimeId to ((nextBranchGenerations[runtimeId] ?: 0) + 1))
                    nextSessionSyncFailures = nextSessionSyncFailures - runtimeId
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
                metadata.sessionView(runtimeId)?.let { incomingView ->
                    val view = if (!sessionChanged && !branchChanged && !targetKnown &&
                        previousView?.sessionId == incomingView.sessionId &&
                        previousView.leafId != incomingView.leafId
                    ) previousView else incomingView
                    nextRuntimeSessionViews = nextRuntimeSessionViews + (runtimeId to view)
                    val graph = state.sessionGraphs[view.sessionId]
                    if (graph != null && graph.hasCompleteEntryChain(view.leafId)) {
                        val oldLeaf = previousView?.takeIf { it.sessionId == view.sessionId }?.leafId
                        val contextChanged = sessionChanged || branchChanged
                        val sourceConversation = if (contextChanged) nextConversation else conversation
                        val baseMessages = sourceConversation.messages.filterNot {
                            it.messageId in sourceConversation.streamingMessageIds
                        }
                        val projection = if (contextChanged) {
                            projectSessionGraph(graph.copy(cursor = SessionBranchCursor(view.leafId)), json)
                        } else {
                            val deltaProjection = graph.projectLeafDeltaProjection(
                                oldLeaf,
                                view.leafId,
                                canonicalRowsForDeltaProjection(baseMessages, graph),
                                json,
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
                                chatSyncError = projection.error,
                                revision = sourceConversation.revision + 1,
                            )
                    }
                }
                metadata.catalogEntry()?.let { entry ->
                    nextSessions = nextSessions + (
                        entry.sessionId to mergeSessionCatalogEntry(nextSessions[entry.sessionId], entry)
                    )
                }
                if (metadata.sessionGraphSync && state.selectedRuntimeId == runtimeId &&
                    (state.sessionGraphs[metadata.sessionId]?.hasCompleteCursor(metadata.sessionLeafId) != true)
                ) {
                    nextSessionSyncRequests = nextSessionSyncRequests + runtimeId
                }
            }
            "session.catalog" -> {
                val entries = event["sessions"]?.let {
                    json.decodeFromJsonElement<List<SessionCatalogEntry>>(it)
                } ?: return state
                nextSessions = mergeSessionCatalog(state.sessions, entries)
            }
            "turn.started" -> {
                val turnId = event.string("turnId") ?: return state
                val startedAt = event["startedAt"]?.jsonPrimitive?.longOrNull
                    ?.takeIf { it >= 0 } ?: return state
                val turnIndex = event["turnIndex"]?.jsonPrimitive?.intOrNull
                if (turnId in conversation.turnTimings) {
                    return state.copy(lastSequence = state.lastSequence + (sequenceKey to sequence))
                }
                val retainedTimings = conversation.activeTurnId?.let { conversation.turnTimings - it }
                    ?: conversation.turnTimings
                nextConversation = conversation.copy(
                    turnTimings = retainedTimings + (turnId to TurnTiming(turnId, startedAt, turnIndex = turnIndex)),
                    activeTurnId = turnId,
                    runtimeError = null,
                    revision = conversation.revision + 1,
                )
            }
            "turn.finished" -> {
                val turnId = event.string("turnId") ?: return state
                val startedAt = event["startedAt"]?.jsonPrimitive?.longOrNull
                    ?.takeIf { it >= 0 } ?: return state
                val durationMs = event["durationMs"]?.jsonPrimitive?.longOrNull
                    ?.takeIf { it >= 0 } ?: return state
                val current = conversation.turnTimings[turnId]
                val liveMessageId = event.string("messageId")
                if (current == null || current.startedAt != startedAt || current.durationMs != null ||
                    current.messageId != null && liveMessageId != null && current.messageId != liveMessageId
                ) {
                    return state.copy(lastSequence = state.lastSequence + (sequenceKey to sequence))
                }
                val currentMessageId = current.messageId ?: liveMessageId
                val persistedMessageId = event.string("persistedMessageId")
                // The Runtime publishes the exact live-id -> entry-id mapping for every message this
                // turn persisted, so streamed rows converge on their canonical id by themselves. The
                // single `persistedMessageId` pair remains for Runtimes that predate that mapping.
                val remaps = (event.persistedMessageRemaps() +
                    listOfNotNull(
                        currentMessageId?.let { live ->
                            persistedMessageId?.let { entry -> MessageIdRemap(live, entry) }
                        },
                    )).distinctBy(MessageIdRemap::liveId)
                val anchorMessageId = remaps.firstOrNull { it.liveId == currentMessageId }?.entryId
                    ?: currentMessageId
                var messages = conversation.messages
                var streamingMessageIds = conversation.streamingMessageIds
                var finishedMessageIds = conversation.finishedMessageIds
                for (remap in remaps) {
                    messages = remapMessageId(messages, remap.liveId, remap.entryId)
                    streamingMessageIds = streamingMessageIds - remap.liveId + remap.entryId
                    finishedMessageIds = finishedMessageIds - remap.liveId + remap.entryId
                }
                nextConversation = conversation.copy(
                    messages = messages,
                    streamingMessageIds = streamingMessageIds,
                    finishedMessageIds = finishedMessageIds,
                    turnTimings = conversation.turnTimings + (turnId to current.copy(
                        durationMs = durationMs,
                        messageId = anchorMessageId,
                    )),
                    activeTurnId = conversation.activeTurnId.takeUnless { it == turnId },
                    revision = conversation.revision + 1,
                )
            }
            "runtime.capabilities" -> {
                val capabilities = event["capabilities"]?.let {
                    json.decodeFromJsonElement<RuntimeCapabilities>(it)
                } ?: return state
                nextCapabilities = state.capabilities + (runtimeId to capabilities)
            }
            "message.queued" -> {
                val queueId = event.string("queueId") ?: return state
                val text = event.string("text") ?: return state
                val delivery = event.string("delivery") ?: return state
                val messageState = event.string("state") ?: return state
                if (delivery !in setOf("steer", "followUp") ||
                    messageState !in setOf("accepted", "delivered", "cancelled", "rejected", "not_cancelable")
                ) return state.copy(error = "手机无法安全处理此排队消息，请在电脑端处理")
                if (queueId !in conversation.deliveredQueueIds) {
                    val existing = conversation.queuedMessages[queueId]
                    if (existing != null && (existing.text != text || existing.delivery != delivery)) {
                        nextError = "收到不一致的排队消息状态，请在电脑端检查 Pi"
                    } else if (canAdvanceQueuedMessageState(existing?.state, messageState)) {
                        nextConversation = if (messageState == "delivered") {
                            // Delivered is a terminal notification, not a pending row. Keep the
                            // ID only as a tombstone so a replayed accepted event cannot restore it.
                            conversation.copy(
                                queuedMessages = conversation.queuedMessages - queueId,
                                deliveredQueueIds = conversation.deliveredQueueIds + queueId,
                                revision = conversation.revision + 1,
                            )
                        } else {
                            conversation.copy(
                                queuedMessages = conversation.queuedMessages + (
                                    queueId to QueuedMessage(queueId, text, delivery, messageState, event.string("error"))
                                ),
                                revision = conversation.revision + 1,
                            )
                        }
                    } else {
                        nextConversation = conversation.copy(revision = conversation.revision + 1)
                    }
                } else {
                    nextConversation = conversation.copy(revision = conversation.revision + 1)
                }
            }
            "session.snapshot" -> {
                val snapshot = runCatching { json.decodeFromJsonElement<SessionGraphSnapshot>(event) }.getOrNull()
                    ?: return state.copy(error = "收到无效的 Session graph 快照")
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
                val liveLeafId = state.runtimes[runtimeId]?.sessionLeafId
                val isHistory = pending.range == "history"
                val commandId = state.sessionSyncCommands.entries.first { it.value === pending }.key
                val staleTarget = !state.ownsSessionSnapshot(commandId, runtimeId, snapshot.sessionId,
                    snapshot.syncId, responseTargetLeafId, snapshot.range, snapshot.beforeEntryId)
                // A preview can resolve a newer live leaf only if metadata has not advanced since
                // it was requested. A catch-up target can be an old ancestor/cache hole.
                if (pending.range == "preview" && !staleTarget && targetLeafId != null &&
                    (pending.viewLeafId == null || liveLeafId == pending.viewLeafId)) {
                    nextRuntimes[runtimeId]?.let { runtime ->
                        nextRuntimes = nextRuntimes + (runtimeId to runtime.copy(sessionLeafId = targetLeafId))
                    }
                }
                // Every successful range joins the same canonical graph. Projection state remains
                // separate from the realtime overlay below.
                val isCatchUp = pending.range == "catchup" && !isHistory
                val currentGraph = state.sessionGraphs[snapshot.sessionId] ?: SessionGraph(snapshot.sessionId)
                val snapshotForProjection = snapshot.copy(
                    entries = persistedSessionEntries ?: snapshot.entries,
                    cursor = SessionBranchCursor(targetLeafId),
                    targetLeafId = targetLeafId,
                )
                val mergedGraph = if (staleTarget) currentGraph else {
                    runCatching { currentGraph.merge(snapshotForProjection) }.getOrElse { error ->
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
                    isHistory -> state.sessionSyncRequests
                    else -> state.sessionSyncRequests - runtimeId
                }
                val graphForProjection = if (staleTarget) mergedGraph.copy(cursor = currentGraph.cursor) else mergedGraph
                if (!staleTarget) {
                    nextSessionSyncFailures = nextSessionSyncFailures - runtimeId
                    nextSessionGraphs = state.sessionGraphs + (snapshot.sessionId to graphForProjection)
                    nextSessions = nextSessions + (
                        snapshot.sessionId to (nextSessions[snapshot.sessionId] ?: SessionCatalogEntry(snapshot.sessionId))
                            .withHistoryCache(state.runtimes[runtimeId]?.hostname)
                    )
                }
                val currentViewLeaf = state.runtimeSessionViews[runtimeId]
                    ?.takeIf { it.sessionId == snapshot.sessionId }?.leafId
                val hasRenderableCurrentView = currentViewLeaf != null && currentGraph.entries.containsKey(currentViewLeaf)
                val hasRenderableTarget = targetLeafId != null && mergedGraph.entries.containsKey(targetLeafId)
                val retainAdvancedView = pending.viewLeafId != null && liveLeafId != pending.viewLeafId &&
                    currentViewLeaf == liveLeafId && currentViewLeaf != targetLeafId
                val targetIsOlder = currentViewLeaf != targetLeafId && mergedGraph.isDescendant(currentViewLeaf, targetLeafId)
                val shouldMoveView = !staleTarget && !isHistory && targetLeafId != null &&
                    !retainAdvancedView && !targetIsOlder &&
                    (snapshot.complete != false || !hasRenderableCurrentView || hasRenderableTarget)
                val viewLeafId = when {
                    isHistory -> state.runtimeSessionViews[runtimeId]
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
                if (!staleTarget && (shouldMoveView || isHistory)) {
                    // The canonical tree is only a bounded window. A forward response cannot know
                    // about the older temporary pages the user already paged in, so its boundary
                    // must not rewind the history state back to the window edge (which made the
                    // UI re-request the same page forever). Appending to the branch never
                    // invalidates its ancestors, so only the paging target leaf is refreshed.
                    val continuedHistory = existingHistory?.takeIf {
                        !isHistory && it.sessionId == snapshot.sessionId && it.oldestEntryId != null
                    }
                    val nextHistory = if (continuedHistory != null) {
                        // Filling a gap can expose an older cached prefix in the projection.
                        // Move the boundary back only along a proven ancestor chain; keeping the
                        // preview boundary would prepend already-visible rows on the next page.
                        val expandedStart = branch.firstOrNull()?.takeIf { start ->
                            graphForProjection.isDescendant(continuedHistory.oldestEntryId, start.entryId)
                        }
                        continuedHistory.copy(
                            leafId = viewLeafId ?: continuedHistory.leafId,
                            oldestEntryId = expandedStart?.entryId ?: continuedHistory.oldestEntryId,
                            hasOlder = expandedStart?.let { it.parentId != null } ?: continuedHistory.hasOlder,
                        )
                    } else if (branch.isNotEmpty()) {
                        SessionHistoryState(
                            sessionId = snapshot.sessionId,
                            leafId = viewLeafId,
                            oldestEntryId = branch.firstOrNull()?.entryId ?: existingHistory?.oldestEntryId,
                            hasOlder = snapshot.hasOlder ?: branch.firstOrNull()?.parentId != null,
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
                if (!staleTarget && viewLeafId != null && canProject) {
                    val oldLeaf = state.runtimeSessionViews[runtimeId]
                        ?.takeIf { it.sessionId == snapshot.sessionId }?.leafId
                    val baseMessages = conversation.messages.filterNot {
                        it.messageId in conversation.streamingMessageIds
                    }
                    val projection = if (isHistory) {
                        // History entries are older than the existing boundary. Keep the current
                        // conversation even when the in-memory window lacks its older ancestors.
                        val full = if (graphForProjection.hasCompleteEntryChain(viewLeafId)) {
                            projectSessionGraph(
                                graphForProjection.copy(cursor = SessionBranchCursor(viewLeafId)),
                                json,
                            )
                        } else {
                            SessionProjectionResult(projectSessionEntries(snapshotForProjection.entries, json))
                        }
                        val projectedIds = full.messages.map(ChatMessage::messageId).toSet()
                        full.copy(
                            messages = full.messages + baseMessages.filterNot {
                                it.messageId in projectedIds
                            },
                            turnTimings = (full.turnTimings + conversation.turnTimings.values +
                            snapshotForProjection.turnTimings.orEmpty())
                                .associateBy(TurnTiming::turnId).values.toList(),
                        )
                    } else {
                        val deltaProjection = graphForProjection.projectLeafDeltaProjection(
                            oldLeafId = oldLeaf,
                            newLeafId = viewLeafId,
                            currentMessages = canonicalRowsForDeltaProjection(baseMessages, graphForProjection),
                            json = json,
                        )
                        // Only a same-branch append may re-attach temporary older messages;
                        // a rewrite or rewind must be free to replace the displayed branch.
                        if (oldLeaf == null || graphForProjection.isDescendant(viewLeafId, oldLeaf)) {
                            mergeTemporaryOlderMessages(deltaProjection, graphForProjection, baseMessages)
                        } else {
                            deltaProjection
                        }
                    }
                    val (displayedMessages, overlayIds) = mergeProjectedWithStreaming(projection.messages, conversation)
                    nextConversation = conversation
                        .applyProjection(projection, displayedMessages, keepLiveTiming = isHistory)
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
                } else if (staleTarget) {
                    nextConversation = conversation.copy(
                        isChatSyncing = false,
                        chatSyncError = "Session 已产生更新，正在重新加载最新范围",
                        revision = conversation.revision + 1,
                    )
                }
            }
            "artifact.started" -> {
                val artifact = event["artifact"]?.let {
                    json.decodeFromJsonElement<RemoteArtifact>(it)
                } ?: return state.copy(error = "手机无法安全处理此下载项，请在电脑端处理")
                if (artifact.size < 0 || !isSafeArtifactFileName(artifact.fileName) || !isValidSha256(artifact.sha256)) {
                    return state.copy(error = "手机无法安全处理此下载项，请在电脑端处理")
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
            "message.started" -> {
                val chatMessage = event["message"]?.let {
                    json.decodeFromJsonElement<ChatMessage>(it)
                } ?: return state
                val queueId = event.string("queueId")
                val nextQueued = conversation.queuedMessages.toMutableMap().apply {
                    queueId?.let(::remove)
                }
                val runtime = state.runtimes[runtimeId]
                nextConversation = conversation.copy(
                    messages = conversation.messages.filterNot { it.messageId == chatMessage.messageId } + chatMessage,
                    streamingMessageIds = conversation.streamingMessageIds + chatMessage.messageId,
                    streamingSessionId = runtime?.sessionId,
                    queuedMessages = nextQueued,
                    deliveredQueueIds = queueId?.let { conversation.deliveredQueueIds + it } ?: conversation.deliveredQueueIds,
                    revision = conversation.revision + 1,
                ).bindActiveTurn(chatMessage)
            }
            "message.delta" -> {
                val messageId = event.string("messageId") ?: return state
                val delta = event.string("delta") ?: return state
                // The final message already replaced this row; a late delta would only drift it
                // away from the canonical text and stop it from reconciling with its entry.
                if (messageId in conversation.finishedMessageIds) {
                    return state.copy(lastSequence = state.lastSequence + (sequenceKey to sequence))
                }
                val contentType = event.string("contentType") ?: "text"
                val existing = conversation.messages.firstOrNull { it.messageId == messageId }
                val alreadyStreaming = messageId in conversation.streamingMessageIds
                // A delta can arrive without its message.started when a connection is repaired or
                // when an older Runtime omits the start event. Rebuilding a temporary assistant
                // row keeps the live response visible instead of silently dropping the stream.
                val messages = when {
                    existing != null -> conversation.messages.map { chat ->
                        if (chat.messageId == messageId) chat.appendDelta(contentType, delta) else chat
                    }
                    else -> conversation.messages + ChatMessage(
                        messageId = messageId,
                        role = "assistant",
                        content = listOf(RemoteContent(
                            type = contentType,
                            text = delta,
                        )),
                        timestamp = 0,
                    )
                }
                nextConversation = conversation.copy(
                    messages = messages,
                    streamingMessageIds = if (existing == null || alreadyStreaming) {
                        conversation.streamingMessageIds + messageId
                    } else {
                        conversation.streamingMessageIds
                    },
                    streamingSessionId = conversation.streamingSessionId
                        ?: state.runtimes[runtimeId]?.sessionId,
                    revision = conversation.revision + 1,
                )
            }
            "message.finished" -> {
                val finished = event["message"]?.let {
                    json.decodeFromJsonElement<ChatMessage>(it)
                } ?: return state
                val existing = conversation.messages.indexOfFirst { it.messageId == finished.messageId }
                val messages = conversation.messages.toMutableList().apply {
                    if (existing >= 0) set(existing, finished) else add(finished)
                }
                val queueId = event.string("queueId")
                val nextQueued = conversation.queuedMessages.toMutableMap().apply {
                    queueId?.let(::remove)
                }
                nextConversation = conversation.copy(
                    messages = messages,
                    streamingMessageIds = conversation.streamingMessageIds + finished.messageId,
                    finishedMessageIds = conversation.finishedMessageIds + finished.messageId,
                    queuedMessages = nextQueued,
                    deliveredQueueIds = queueId?.let { conversation.deliveredQueueIds + it } ?: conversation.deliveredQueueIds,
                    revision = conversation.revision + 1,
                ).bindActiveTurn(finished)
            }
            "tool.started", "tool.updated", "tool.finished" -> {
                val toolCallId = event.string("toolCallId") ?: return state
                val toolName = event.string("toolName") ?: "工具"
                val type = event.string("type").orEmpty()
                val activity = ToolActivity(
                    toolCallId = toolCallId,
                    toolName = toolName,
                    state = type.removePrefix("tool."),
                    detail = (event["partialResult"] ?: event["result"])?.toString(),
                    isError = event["isError"]?.jsonPrimitive?.booleanOrNull == true,
                )
                nextConversation = conversation.copy(
                    tools = conversation.tools + (toolCallId to activity),
                    revision = conversation.revision + 1,
                )
            }
            "interaction.requested" -> {
                val request = event["request"]?.jsonObject
                val requestId = request?.string("requestId")
                val interaction = request?.let {
                    parsePendingInteraction(json, it, requestId?.let(conversation.interactions::get))
                }
                nextConversation = if (interaction != null) {
                    conversation.copy(
                        interactions = conversation.interactions + (interaction.requestId to interaction),
                        interactionNotice = null,
                    )
                } else {
                    conversation.copy(
                        interactionNotice = "手机无法安全渲染此交互，请在电脑端处理。",
                    )
                }
            }
            "interaction.snapshot" -> {
                val requests = event["requests"] as? JsonArray
                val interactions = requests?.mapNotNull { element ->
                    (element as? JsonObject)?.let { request ->
                        val requestId = request.string("requestId")
                        parsePendingInteraction(json, request, requestId?.let(conversation.interactions::get))
                    }
                }
                val validSnapshot = requests != null && interactions != null && interactions.size == requests.size
                nextConversation = if (validSnapshot) {
                    val retained = interactions.orEmpty().map { it.requestId }.toSet()
                    nextPendingCommands = nextPendingCommands - conversation.interactions.values
                        .filter { it.requestId !in retained }.mapNotNull { it.responseCommandId }.toSet()
                    conversation.copy(
                        interactions = interactions.orEmpty().associateBy(PendingInteraction::requestId),
                        interactionNotice = null,
                    )
                } else {
                    conversation.copy(
                        interactionNotice = "手机无法安全恢复此交互，请在电脑端处理。",
                    )
                }
            }
            "interaction.resolved", "interaction.cancelled" -> {
                val requestId = event.string("requestId")
                if (requestId != null) {
                    conversation.interactions[requestId]?.responseCommandId?.let {
                        nextPendingCommands = nextPendingCommands - it
                    }
                    val notice = if (event.string("type") == "interaction.resolved") {
                        when (event.string("source")) {
                            "local" -> "交互已在电脑端完成"
                            else -> "交互已完成"
                        }
                    } else {
                        interactionCancellationText(event.string("reason"))
                    }
                    nextConversation = conversation.copy(
                        interactions = conversation.interactions - requestId,
                        interactionNotice = notice,
                    )
                }
            }
            "local_interaction.required" -> {
                nextConversation = conversation.copy(waitingLocalInteraction = true)
            }
            "command.result" -> {
                val commandId = event.string("commandId")
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
                        val acknowledged = if (succeeded) state.copy(pendingCommands = state.pendingCommands - commandId)
                            else state.failSessionSync(commandId, commandErrorText(event.string("error")))
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
                                interactions = conversation.interactions - responseInteraction.key,
                                interactionNotice = null,
                            )
                        } else {
                            conversation.copy(
                                interactions = conversation.interactions + (
                                    responseInteraction.key to responseInteraction.value.copy(responseCommandId = null, submitted = false,
                                        responseError = commandErrorText(event.string("error")))
                                ),
                                interactionNotice = event.string("error") ?: "回答未送达，请重新提交。",
                            )
                        }
                    }
                }
                if (!succeeded && status !in setOf("pending", "cancelled")) {
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
                // Runtime diagnostics are scoped by the envelope runtimeId. Keeping them
                // in RemoteState.error made an error from one Codex window pop over every
                // other window through the root AlertDialog.
                nextConversation = conversation.copy(
                    runtimeError = runtimeError,
                    revision = conversation.revision + 1,
                )
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
            // 不再写死版本号：协议升到 4 之后这句话还在说 v3，把排查方向直接带偏——而
            // `invalid_message` 其实也可能来自「帧结构非法」（两端同版本照样会发生，比如
            // `hdr` 里混进了 null），版本号到底是多少得由常量说了算。
            "invalid_message" ->
                "Relay 拒绝了协议消息，请确认手机端与电脑端都是最新版（protocol v$PROTOCOL_VERSION）"
            "runtime_mismatch" -> "Relay 拒绝了运行实例身份，请重启电脑端 Pi"
            "runtime_offline" -> chinese ?: "目标运行实例已离线"
            "p2p_unavailable" -> chinese ?: "电脑端未启用 P2P，继续走中继"
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
        "slash_commands_not_available" -> "当前 Pi 未提供斜杠命令"
        "slash_command_not_available" -> "所选命令已不可用，请重新打开菜单"
        "slash_command_argument_required" -> "所选命令需要参数"
        "slash_command_arguments_not_allowed" -> "所选命令不接受参数"
        "slash_command_argument_not_available" -> "所选参数已不可用，请重新选择"
        "slash_command_cancelled", "slash command cancelled" -> "命令已取消"
        "not_cancelable" -> "Pi 当前版本无法按队列项取消，消息仍会保留"
        "already_delivered" -> "消息已经送入上下文，无法取消"
        "runtime_busy" -> "Pi 正在运行任务，暂时无法执行此命令"
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
            code.startsWith("EACCES:") || code.startsWith("EPERM:") -> "Pi 进程无权读取电脑端文件"
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
