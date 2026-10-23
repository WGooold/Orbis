package dev.pi.remote

import android.app.Application
import android.net.Uri
import android.os.Build
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.add
import kotlinx.serialization.json.put
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 握手看门狗写的告警（见 [HostConnection.connect] 里那个 8s 看门狗）。
 *
 * 抽成常量是为了**能在握手成功时把它撤掉**：`error` 是一条会弹出模态框的通道，而这条文案
 * 描述的处境（没有加密通道）可能下一秒就不成立了。撤不掉的话，用户会一直盯着一个已经过期的
 * 错误，唯一的出路是手动点「确定」。
 */
internal const val HANDSHAKE_STALLED_ERROR =
    "电脑端 Host 没有打开：这台手机已经连上中继，但电脑一直没有回应端到端加密握手。" +
        "请在电脑上启动 Orbis Host，打开后 APP 会自动重新连上"

/** pull 下载调度器的 tick 间隔：既要及时补超时的洞，又不要空转太频繁。 */
internal const val PULL_TICK_MS = 200L
/** 背压撤掉需求后的复活间隔（见 `runSessionSyncScheduler`）。 */
internal const val SYNC_BUSY_REVIVE_MS = 5_000L

/**
 * 上传任务处于 uploading 却迟迟等不到 Host 的 read 时，重新 advertise（重发 init）的阈值。
 *
 * Host 是拉取方：只要它认得这个 uploadId，read 每 200ms 就该来一个。10s 没有动静，
 * 只可能是 Host 重启/空闲回收把句柄收走了——用任务自带的内容身份重新 advertise 一次，
 * Host 命中同一份 `.part` 回 ready 带续传偏移，传输原地接上。
 */
internal const val UPLOAD_READ_IDLE_MS = 10_000L

/**
 * Shared, app-wide stores. One instance each: every store persists the whole document, so two
 * independent copies racing across Host connections would lose each other's writes.
 */
internal class HostStores(application: Application) {
    val sessionGraph = SessionGraphStore(application)
    val sessionAlias = SessionAliasStore(application)
    val draft = DraftStore(application)
    val downloads = ArtifactDownloadStore(application)
    val uploads = ArtifactUploadStore(application)
    val lastSession = LastSessionStore(application)
    val pathPreference = PathPreferenceStore(application)
    val notifier = InteractionNotifier(application)
}

/** 首屏本地读取的三种结果：有数据 / 完全没有本地缓存（新会话）/ 有缓存但缺一段。 */
internal enum class FirstPageOutcome { LOADED, NO_LOCAL_CACHE, GAP }

/**
 * 只有"有缓存但缺一段"才是真的缺口。
 *
 * 新会话（或缓存被清理过）本来就没有本地数据，等源端首屏即可——把它报成
 * "本地首屏存在缺口"会让每个新 Pi 会话在对话窗口顶部都挂一条错误，
 * 而这既不是用户的错也不是故障。
 */
internal fun firstPageOutcome(loaded: SessionGraph?, hasAnyLocalData: Boolean): FirstPageOutcome =
    when {
        loaded != null -> FirstPageOutcome.LOADED
        !hasAnyLocalData -> FirstPageOutcome.NO_LOCAL_CACHE
        else -> FirstPageOutcome.GAP
    }

internal class HostConnection(
    private val application: Application,
    private val scope: CoroutineScope,
    initial: HostPairing,
    private val stores: HostStores,
    private val deviceKeyPair: () -> X25519KeyPair,
    /** Reports refreshed LAN endpoints so the pairing store keeps the current address. */
    private val onPairingUpdated: (HostPairing) -> Unit,
) {
    /** The pairing this connection speaks for. LAN endpoints can change; the hostId cannot. */
    @Volatile
    var pairing: HostPairing = initial
        private set

    val hostId: String get() = pairing.hostId
    /**
     * P2P 需要在设备侧构造 WebRTC 的 PeerConnectionFactory，而这要一个 Context。
     *
     * 漏掉这一行不会抛任何异常：`startP2pIfPossible` 的第一件事是 `appContext ?: return`，
     * 于是它每次都静默退出，`p2p.request` 永远发不出去，状态页永远显示中继——
     * 而且 Logcat 里连一行痕迹都没有。所以这里必须注入，不是可选项。
     */
    private val relay = RelayClient().apply { setApplicationContext(application) }
    private val reducer = RelayReducer()
    private val notifier = stores.notifier
    private val sessionCatalogStore = SessionCatalogStore(application, initial.hostId)
    private val sessionGraphStore = stores.sessionGraph
    private val sessionAliasStore = stores.sessionAlias
    private val draftStore = stores.draft
    private val artifactDownloadStore = stores.downloads
    private val artifactUploadStore = stores.uploads
    private val lastSessionStore = stores.lastSession
    private val pathPreferenceStore = stores.pathPreference
    private val pullDownloads = PullDownloads(
        read = { transferId, requestId, offset, length ->
            relay.readArtifact(transferId, requestId, offset, length)
        },
        finish = ::completePull,
    )
    /** 上传数据的锁：`file.upload.read` 的应答在 IO 线程读写源流，与帧消费互斥。 */
    private val uploadLock = Any()
    /** uploadId → 最近一次收到 Host 的 read。超过阈值没动静，说明 Host 已经不认识这个句柄了。 */
    private val uploadLastReadAt = mutableMapOf<String, Long>()
    /** taskId → 最近一次（重新）advertise init 的时刻。 */
    private val uploadLastAdvertiseAt = mutableMapOf<String, Long>()
    private val messageJson = Json { ignoreUnknownKeys = true }
    private val mutableState = MutableStateFlow(
        RemoteState(
            downloads = artifactDownloadStore.load()
                .filter { it.hostId == initial.hostId || it.hostId == null && it.transferRuntimeId == initial.hostId }
                .associateBy(ArtifactDownload::taskId),
            uploads = artifactUploadStore.load().filter { it.hostId == initial.hostId }
                .associateBy(UploadTask::taskId),
        ),
    )
    val state: StateFlow<RemoteState> = mutableState.asStateFlow()

    private val device: DeviceCredential = initial.credential()
    private var reconnectJob: Job? = null
    private var reconnectDelayMs = 500L
    @Volatile private var shouldConnect = true

    /**
     * 已发出 pair 帧、正在等 Host 的 pair-accept。这期间必须独占连接：
     * `connect()` 的第一步就是 `disconnect()`，残留的自动重连（退避可能已涨到几秒）一响就会
     * 把刚建立的配对连接掐掉——配对永远收不到确认，而凭据如果已落盘，APP 就会停在
     * 「已连接但没有加密材料」的半配对状态，用户还回不到配对页。
     */
    @Volatile
    private var pairingAwaitingAccept = false
    @Volatile private var generation = 0
    private val catalogWriteLock = Mutex()
    /** Serializes inbound cache commits and remote scheduling effects. */
    private val relayStateLock = Mutex()
    /** Pure state publication only; neither decrypting queries nor SQLite writes hold it. */
    private val stateWriterLock = Any()
    private val sessionLoads = SessionLoadQueue()
    private val historyPageSize = 30
    private val previewPageSize = 30
    private val notificationSyncJobs = mutableMapOf<String, Job>()

    fun syncNotifications(runtimeId: String) {
        notificationSyncJobs.remove(runtimeId)?.cancel()
        val job = scope.launch(start = CoroutineStart.LAZY) {
            val receipt = mutableState.value.notificationReceipts[runtimeId] ?: 0
            val epoch = mutableState.value.notificationEpoch
            for (pause in listOf(0L, 1_000L, 3_000L)) {
                if (pause > 0) delay(pause)
                val current = mutableState.value
                if (!current.e2eReady || current.notificationEpoch != epoch ||
                    (current.notificationReceipts[runtimeId] ?: 0) != receipt) break
                relay.sendDeviceMessage(buildJsonObject {
                    put("type", "notification.sync"); put("protocolVersion", PROTOCOL_VERSION); put("runtimeId", runtimeId)
                })
            }
        }
        notificationSyncJobs[runtimeId] = job
        job.invokeOnCompletion { if (notificationSyncJobs[runtimeId] === job) notificationSyncJobs.remove(runtimeId) }
        job.start()
    }

    fun dismissNotification(runtimeId: String, notificationId: String) {
        val epoch = mutableState.value.notificationEpoch ?: return
        relay.sendDeviceMessage(buildJsonObject {
            put("type", "notification.dismiss"); put("protocolVersion", PROTOCOL_VERSION)
            put("runtimeId", runtimeId); put("hostEpoch", epoch); put("notificationId", notificationId)
        })
        syncNotifications(runtimeId)
    }

    /** 握手看门狗超时：连上中继后多久还没等到加密通道就认定「电脑没在听」（spec §5）。 */
    private val e2eHandshakeTimeoutMs = 8_000L

    /** 配对看门狗超时：pair 帧发出后多久没等到 pair-accept 就认定这次配对没成。 */
    private val pairingAcceptTimeoutMs = 10_000L

    /** 本次连接已经就「握手没成」提示过一次，避免每次自动重连都弹同一句话。 */
    private var handshakeStalled = false

    /**
     * 「上次会话恢复」是否已经不再介入：用户自己选过（或已经被恢复过一次）之后，
     * 就绝不把人从当前页面拽走。未 settle 时会持续尝试，因为 Runtime 目录可能比
     * 中继的第一份 device.ready 晚到（那份里还没有 Pi runtime）。
     */
    private var restoreSettled = false
    private var restoreAttempts = 0

    /** Local execution handles, keyed by logical ID; first-page/history share one cleanup rule. */
    private val historyJobs = mutableMapOf<String, Job>()
    /** Serializes all text events from one WebSocket connection in arrival order. */
    private var relayEventJob: Job? = null

    init {
        mutableState.value = mutableState.value.copy(
            deviceId = device.deviceId,
            hostId = pairing.hostId,
            hostName = pairing.hostName,
            sessions = sessionCatalogStore.load(device, pairing.hostId)
                .associateBy(SessionCatalogEntry::sessionId),
            sessionAliases = sessionAliasStore.load(device),
        )
        connect(device)
        // 掉线重连 / APP 重启后回到上次打开的会话（spec 第 16 行、§14 B7）。
        // 放在状态流上而不是消息处理里：恢复要在「Runtime 目录已就绪」之后才可能成功，
        // 而目录可能来自中继的第一份 device.ready（此时还没有 Pi runtime）之后才补齐。
        scope.launch {
            mutableState.collect { current ->
                val abandoned = synchronized(historyJobs) {
                    historyJobs.filterKeys { mutableState.value.historyReads[it]?.phase?.active != true }.values.toList()
                }
                abandoned.forEach(Job::cancel)
                if (!restoreSettled &&
                    current.connection == RelayConnection.ONLINE &&
                    current.runtimes.isNotEmpty()
                ) {
                    maybeRestoreLastSession(current)
                }
            }
        }
        // 接收方驱动的下载调度（ADR-0005）：周期性 tick 负责超时重传与补窗。
        scope.launch {
            while (true) {
                delay(PULL_TICK_MS)
                // sync 也可能收尾完整的续传文件：SHA-256 校验和发布不能占用 UI 线程。
                withContext(Dispatchers.IO) {
                    runCatching { tickPullSchedulers() }
                        .onFailure { Log.e(RELOAD_TRACE_TAG, "pull.tick_failed", it) }
                }
                runCatching { reAdvertiseStalledUploads() }
                    .onFailure { Log.e(RELOAD_TRACE_TAG, "upload.reevaluate_failed", it) }
            }
        }
        scope.launch(Dispatchers.IO) {
            while (true) {
                delay(1_000)
                try {
                    relayStateLock.withLock { runSessionSyncScheduler() }
                } catch (error: CancellationException) {
                    throw error
                } catch (error: Exception) {
                    Log.e(RELOAD_TRACE_TAG, "session.sync.scheduler_failed", error)
                }
            }
        }
    }

    // ── 进程激活（spec §8）───────────────────────────────────────────────────
    // 这些消息是设备级 E2E 载荷，与 runtime.command 共用同一条密文 data 通道。

    /** 拉取电脑上的全部会话索引，合并进侧栏目录（连接建立后自动调一次）。 */
    fun refreshSessions() {
        val requestId = UUID.randomUUID().toString()
        sendSessionPayload(
            requestId = requestId,
            payload = buildJsonObject {
                put("type", "session.list")
                // 版本号只走常量：写死字面量会在协议升级时静默失效——Host 的
                // `DeviceE2ePayloadSchema` 只认当前版本，不匹配就整条载荷丢弃（`parseDevicePayload`
                // 返回 undefined），手机侧表现为「请求发出去了、永远没有回音」。
                put("protocolVersion", PROTOCOL_VERSION)
                put("requestId", requestId)
            },
            register = { it.copy(
                sessionListRequests = it.sessionListRequests + requestId,
                sessionListRequestEpochs = it.sessionListRequestEpochs + (requestId to it.sessionListEpoch),
            ) },
            rollback = { it.copy(
                sessionListRequests = it.sessionListRequests - requestId,
                sessionListRequestEpochs = it.sessionListRequestEpochs - requestId,
            ) },
        )
    }

    /** Reads and subscribes to committed Host domains; each connection owns its applied versions. */
    fun refreshHostModel(domains: List<String> = HOST_MODEL_DOMAINS, force: Boolean = false) {
        requestModel("host", domains, force = force)
        requestCatalogPage()
    }

    fun refreshAgentModel(runtimeId: String, force: Boolean = false) {
        val current = mutableState.value
        val runtime = current.runtimes[runtimeId] ?: return
        val sessionId = runtime.sessionId ?: return
        requestModel("agent", AGENT_MODEL_DOMAINS, runtimeId, sessionId,
            runtime.agentKind ?: current.sessions[sessionId]?.agentKind, force)
    }

    private fun requestModel(
        modelScope: String,
        domains: List<String>,
        runtimeId: String? = null,
        sessionId: String? = null,
        agentKind: String? = null,
        force: Boolean = false,
    ) {
        val current = mutableState.value
        if (current.connection != RelayConnection.ONLINE || current.hostId.isNullOrBlank() || !current.e2eReady) return
        val key = listOf(modelScope, agentKind.orEmpty(), sessionId ?: runtimeId.orEmpty()).joinToString("|")
        val now = System.currentTimeMillis()
        val existingReads = current.agentStateReads.filterValues {
            it.scope == modelScope && it.runtimeId == runtimeId && it.sessionId == sessionId
        }
        if (!force && existingReads.values.any { it.domains.containsAll(domains) && now - it.sentAt < 14_000 }) return
        val subscribedDomains = (domains + existingReads.values.flatMap { it.domains }).distinct()
        val requestId = UUID.randomUUID().toString()
        val read = AgentStateRead(key, modelScope, subscribedDomains.toSet(), runtimeId, sessionId, agentKind, sentAt = now)
        updateState { it.copy(agentStateRequests = it.agentStateRequests - existingReads.keys + requestId,
            agentStateReads = it.agentStateReads - existingReads.keys + (requestId to read)) }
        val snapshot = current.agentStateSnapshots[key]
        val sent = relay.sendDeviceMessage(buildJsonObject {
            put("type", "agent.state.request")
            put("protocolVersion", PROTOCOL_VERSION)
            put("requestId", requestId)
            put("scope", modelScope)
            put("subscribe", true)
            runtimeId?.let { put("runtimeId", it) }
            sessionId?.let { put("sessionId", it) }
            agentKind?.let { put("agentKind", it) }
            put("domains", buildJsonArray { subscribedDomains.forEach { add(it) } })
            put("known", buildJsonArray {
                snapshot?.domains?.values?.filter { it.domain in subscribedDomains && (!force || it.domain !in domains) }?.forEach { domain ->
                    add(buildJsonObject { put("domain", domain.domain); put("modelEpoch", domain.modelEpoch); put("revision", domain.revision) })
                }
            })
        })
        if (!sent) updateState { it.copy(agentStateRequests = it.agentStateRequests - requestId,
            agentStateReads = it.agentStateReads - requestId, error = "Model read could not use an authenticated channel") }
    }

    /** Continue a fixed catalog snapshot without mixing versions or pruning omitted pages. */
    private fun requestCatalogPage() {
        val current = mutableState.value
        if (current.connection != RelayConnection.ONLINE || current.hostId.isNullOrBlank() || !current.e2eReady) return
        val range = current.agentCatalogRange ?: return
        if (range.error != null) {
            updateState { it.copy(agentCatalogRange = null, agentCatalogRangeRequest = null) }
            requestModel("host", listOf("catalog"), force = true)
            return
        }
        val cursor = range.nextCursor ?: return
        val now = System.currentTimeMillis()
        if (current.agentCatalogRangeRequest?.let { now - it.sentAt < 15_000 } == true) return
        val request = AgentCatalogRangeRequest(UUID.randomUUID().toString(), cursor, range.modelEpoch,
            range.revision, range.snapshotId, range.sessions.size, now)
        updateState { if (it.agentCatalogRange == range) it.copy(agentCatalogRangeRequest = request) else it }
        if (mutableState.value.agentCatalogRangeRequest != request) return
        val sent = relay.sendDeviceMessage(buildJsonObject {
            put("type", "agent.state.range.request"); put("protocolVersion", PROTOCOL_VERSION)
            put("requestId", request.requestId); put("scope", "host"); put("domain", "catalog")
            put("cursor", cursor); put("limit", 200)
        })
        if (!sent) updateState { if (it.agentCatalogRangeRequest == request) it.copy(agentCatalogRangeRequest = null) else it }
    }

    /**
     * 读一页诊断记录（ADR-0032 模块 23）。目录回答「有多少、缺多少」，这里回答「最近发生了什么」。
     *
     * 页由 Host 从窗口里最旧一条开始给；`cursor` 只在继续读更早的页时带上。
     */
    fun refreshDiagnostics(cursor: String? = null) {
        val current = mutableState.value
        if (current.connection != RelayConnection.ONLINE || current.hostId.isNullOrBlank()) return
        val requestId = UUID.randomUUID().toString()
        updateState { it.copy(diagnosticRequest = DiagnosticRequestView(requestId, System.currentTimeMillis())) }
        val sent = relay.sendDeviceMessage(buildJsonObject {
            put("type", "diagnostics.request")
            put("protocolVersion", PROTOCOL_VERSION)
            put("requestId", requestId)
            // 游标朝更新的方向走，第一页是**最旧**的一批：取满一页（Host 上限 500），
            // 这样窗口不大时一次就追平最新；追不平则由界面如实说「还有更新的没读」。
            put("limit", 500)
            if (cursor != null) put("cursor", cursor)
        })
        if (!sent) updateState {
            it.copy(diagnosticRequest = null, error = "读取记录未发送，当前连接没有端到端加密通道")
        }
    }

    /** Reconcile provider summaries on demand while preserving the connection's other domains. */
    fun refreshProviderModel() = refreshHostModel(listOf("providers"), force = true)

    fun setSessionArchived(sessionId: String, archived: Boolean) {
        val state = mutableState.value
        val entry = state.sessions[sessionId] ?: return
        val agentKind = entry.agentKind ?: return
        if (sessionId in state.sessionArchiveRequests.values) return
        val requestId = UUID.randomUUID().toString()
        sendSessionPayload(
            requestId = requestId,
            payload = buildJsonObject {
                put("type", "session.archive")
                put("protocolVersion", PROTOCOL_VERSION)
                put("requestId", requestId)
                put("agentKind", agentKind)
                put("sessionId", sessionId)
                put("archived", archived)
            },
            register = { it.copy(sessionArchiveRequests = it.sessionArchiveRequests + (requestId to sessionId)) },
            rollback = { it.copy(sessionArchiveRequests = it.sessionArchiveRequests - requestId) },
        )
        scope.launch {
            delay(30_000)
            if (requestId in mutableState.value.sessionArchiveRequests) {
                updateState { it.copy(
                    sessionArchiveRequests = it.sessionArchiveRequests - requestId,
                    error = "归档操作尚未确认，正在刷新会话状态",
                ) }
                if (mutableState.value.connection == RelayConnection.ONLINE) refreshSessions()
            }
        }
    }

    /** 新建会话与下载共用的只读浏览。path 为空返回盘符 / 根。 */
    fun browseSessions(path: String? = null) {
        val requestId = UUID.randomUUID().toString()
        val current = mutableState.value.sessionBrowse
        sendSessionPayload(
            requestId = requestId,
            payload = buildJsonObject {
                put("type", "session.browse")
                put("protocolVersion", PROTOCOL_VERSION)
                put("requestId", requestId)
                if (!path.isNullOrBlank()) put("path", path)
            },
            register = {
                it.copy(
                    sessionBrowse = SessionBrowseState(
                        requestId = requestId,
                        path = path,
                        parent = current?.takeIf { state -> state.path == path }?.parent,
                        entries = current?.takeIf { state -> state.path == path }?.entries ?: emptyList(),
                        isLoading = true,
                    ),
                )
            },
            rollback = { it.copy(sessionBrowse = current) },
        )
        scope.launch {
            delay(15_000)
            updateState { state ->
                val browse = state.sessionBrowse
                if (browse?.requestId == requestId && browse.isLoading) {
                    state.copy(sessionBrowse = browse.copy(isLoading = false, error = "目录读取超时，请重试"))
                } else state
            }
        }
    }

    /** 浏览器下钻到子目录（name 拼到当前 path 上，根层级的 name 本身就是完整路径）。 */
    fun browseInto(name: String) {
        val browse = mutableState.value.sessionBrowse ?: return
        if (browse.isLoading || browse.entries.none { it.name == name && it.isDir }) return
        browseSessions(remoteBrowsePath(browse.path, name))
    }

    fun browseUp() {
        val browse = mutableState.value.sessionBrowse ?: return
        browseSessions(browse.parent?.takeIf(String::isNotBlank))
    }

    fun dismissBrowse() {
        updateState { it.copy(sessionBrowse = null) }
    }

    /** L1：继续已有会话——cwd 与 agentKind 都来自会话记录，手机只需要 sessionId。 */
    fun activateSession(sessionId: String) {
        mutableState.value.codexProviderMismatch(sessionId)?.let { reason ->
            updateState { it.copy(error = reason) }
            return
        }
        if (mutableState.value.sessions[sessionId]?.archived == true) {
            updateState { it.copy(error = "请先恢复这个已归档会话") }
            return
        }
        activateTarget(buildJsonObject {
            put("type", "resume")
            put("sessionId", sessionId)
            mutableState.value.sessions[sessionId]?.agentKind?.let { put("agentKind", it) }
        })
    }

    /** L2：在指定目录新建会话（agentKind = pi | codex）。 */
    fun createSession(agentKind: String, cwd: String, expectedHostId: String?) {
        if (!mutableState.value.canCreateSessionOn(expectedHostId)) {
            updateState { it.copy(error = "目标电脑已变更、未连接或正在创建会话，请返回目录重试") }
            return
        }
        activateTarget(buildJsonObject {
            put("type", "new")
            put("agentKind", agentKind)
            put("cwd", cwd)
        })
    }

    private fun activateTarget(target: JsonObject) {
        restoreSettled = true
        val requestId = UUID.randomUUID().toString()
        sendSessionPayload(
            requestId = requestId,
            payload = buildJsonObject {
                put("type", "session.activate")
                put("protocolVersion", PROTOCOL_VERSION)
                put("requestId", requestId)
                put("target", target)
                // 明确要「有头」。`auto` 会把判定交给电脑侧的启发式（Windows 上看
                // SESSIONNAME），而从服务、计划任务或 IDE 内部启动的 Host 根本没有它，
                // 结果是一律降级成无窗口——那样手机就永远要不到窗口了。电脑侧探不到
                // 开窗入口时会在 session.activated 里如实回执 headless，不假装开过窗。
                put("spawnMode", "tui")
            },
            register = { it.copy(
                sessionActivateRequests = it.sessionActivateRequests + requestId,
                sessionActivateTargets = if (target["type"]?.jsonPrimitive?.contentOrNull == "resume") {
                    target["sessionId"]?.jsonPrimitive?.contentOrNull?.let { id -> mapOf(requestId to id) } ?: emptyMap()
                } else emptyMap(),
                activatedSessionToOpen = null,
            ) },
            rollback = { it.copy(
                sessionActivateRequests = it.sessionActivateRequests - requestId,
                sessionActivateTargets = it.sessionActivateTargets - requestId,
            ) },
        )
    }

    fun loadAgentProviders(kind: String) {
        if (kind !in setOf("pi", "codex", "dsh")) return
        updateState { it.copy(agentProviders = AgentProvidersState(kind = kind, hostId = it.hostId,
            providers = it.agentProviders.providers.takeIf { _ -> it.agentProviders.kind == kind }.orEmpty(), loading = true)) }
        refreshProviderModel()
    }

    fun switchAgentProvider(provider: AgentProvider, expectedHostId: String?) {
        val current = mutableState.value
        if (expectedHostId == null || expectedHostId != current.hostId || current.agentProviders.hostId != expectedHostId || current.agentProviders.loading || provider !in current.agentProviders.providers) {
            updateState { it.copy(agentProviders = it.agentProviders.copy(error = "目标电脑或供应商列表已变化，请刷新后重试")) }
            return
        }
        requestAgentProviders(provider.kind, provider.id, !provider.enabled)
    }

    private fun requestAgentProviders(kind: String, id: String?, enabled: Boolean) {
        val current = mutableState.value
        val hostId = current.hostId
        if (hostId == null || !current.e2eReady || current.connection != RelayConnection.ONLINE) {
            updateState { it.copy(agentProviders = AgentProvidersState(kind = kind, hostId = hostId, error = "请先连接已配对的电脑")) }
            return
        }
        val requestId = UUID.randomUUID().toString()
        updateState { it.copy(agentProviders = AgentProvidersState(kind = kind, hostId = hostId, requestId = requestId, loading = true,
            providers = if (it.agentProviders.kind == kind && it.agentProviders.hostId == hostId) it.agentProviders.providers else emptyList())) }
        val sent = relay.sendDeviceMessage(buildJsonObject {
            put("type", if (id == null) "provider.list" else "provider.switch")
            put("protocolVersion", PROTOCOL_VERSION); put("requestId", requestId); put("kind", kind)
            if (id != null) { put("id", id); put("enabled", enabled) }
        })
        if (!sent) updateState { it.copy(agentProviders = it.agentProviders.copy(requestId = null, loading = false, error = "供应商操作未发送，请重新连接")) }
        scope.launch {
            delay(90_000)
            updateState { state ->
                if (state.agentProviders.requestId == requestId && state.hostId == hostId) state.copy(agentProviders = state.agentProviders.copy(requestId = null, loading = false, error = "操作超时，请刷新以确认实际状态")) else state
            }
        }
    }

    fun clearActivationNotice() {
        updateState { it.copy(sessionActivation = null) }
    }

    private fun sendSessionPayload(
        requestId: String,
        payload: JsonObject,
        register: (RemoteState) -> RemoteState,
        rollback: (RemoteState) -> RemoteState,
    ) {
        val current = mutableState.value
        if (current.connection != RelayConnection.ONLINE || current.hostId.isNullOrBlank()) {
            updateState { it.copy(error = "尚未连接到电脑，连接建立后才能操作会话") }
            return
        }
        // 先登记再发送：响应走独立协程回来，登记必须先于 reducer 可能看到响应。
        updateState(register)
        if (!relay.sendDeviceMessage(payload)) {
            updateState { rollback(it).copy(error = "当前连接没有端到端加密通道，会话操作未发送") }
        }
    }

    /**
     * Stops this connection for good. Store cleanup and the pairing record belong to the hub,
     * which still has to serve the other Host connections.
     */
    fun shutdown() {
        shouldConnect = false
        updateState { state -> state.sessionReads.values.filter { it.phase.active }.fold(state) { next, read ->
            next.finishHistoryRead(read.operationId, SessionReadPhase.CANCELLED)
        } }
        pairingAwaitingAccept = false
        handshakeStalled = false
        generation += 1
        reconnectJob?.cancel()
        relayEventJob?.cancel()
        relayEventJob = null
        relay.disconnect()
        restoreSettled = true
    }

    /**
     * 回到上次打开的会话（spec 第 16 行、§14 B7）。
     *
     * 手机只是遥控器：电脑上的 Pi 进程不受手机掉线影响，重连/重启后就该回到原处接着看，
     * 而不是把用户丢回列表、逼他「重新拉」一次——重新拉会再发一遍 `session.activate`，
     * 在电脑上多起一个**重复的 Pi 进程**（同一会话被两个进程打开）。
     *
     * 先按 sessionId 找（Pi 进程可能换了 runtimeId），再按 runtimeId 兜底。
     */
    private fun maybeRestoreLastSession(current: RemoteState) {
        if (restoreAttempts++ > 200) {
            restoreSettled = true
            return
        }
        val saved = lastSessionStore.load(pairing.hostId) ?: run {
            restoreSettled = true
            return
        }
        if (current.deviceId != null && current.deviceId != saved.deviceId) {
            // 记录属于另一台电脑（理论上 unpair 已清过），直接作废。
            lastSessionStore.clear(pairing.hostId)
            restoreSettled = true
            return
        }
        val runtime = current.runtimes.values.firstOrNull { it.runtimeId == saved.runtimeId }
            ?: saved.sessionId?.let { sessionId ->
                current.runtimes.values.firstOrNull { it.sessionId == sessionId }
            }
        if (runtime != null) {
            selectRuntime(runtime.runtimeId)
            return
        }
        // Runtime 已经不在了：有本地缓存就带用户去看只读历史（§14 B7 的离线阅读）。
        // 先 settle 再跳——否则每次状态更新都会重新加载一遍缓存图。
        val cachedSession = saved.sessionId?.takeIf { current.sessions[it]?.hasHistoryCache == true }
        if (cachedSession != null) {
            restoreSettled = true
            selectOfflineSession(cachedSession)
        }
        // 既没 Runtime 也没缓存：可能只是 Runtime 目录还没补齐，留待下一帧再看（attempts 兜底）。
    }

    /** Runtime is the interaction window; its current session follows its metadata. */
    fun selectRuntime(runtimeId: String?) {
        runtimeId?.let { refreshAgentModel(it) }
        var runtime: RuntimeSummary? = null
        var conversation: RuntimeConversation? = null
        var graph: SessionGraph? = null
        var needsSessionRefresh = false
        updateState { latest ->
            val candidate = runtimeId?.let(latest.runtimes::get)
            val candidateConversation = runtimeId?.let(latest.conversations::get)
            val candidateGraph = candidate?.sessionId?.let(latest.sessionGraphs::get)
            runtime = candidate
            conversation = candidateConversation
            graph = candidateGraph
            needsSessionRefresh = candidate?.sessionGraphSync == true &&
                (candidateConversation?.hasLiveSnapshot != true ||
                    latest.runtimeSessionViews[runtimeId]?.leafId != candidate.sessionLeafId ||
                    candidate.sessionLeafId != null && candidateGraph?.hasCompleteEntryChain(candidate.sessionLeafId) != true ||
                    candidateConversation?.sourceEpoch != null && latest.appliedSessionState(candidate.runtimeId) == null)
            val selected = latest.cancelForegroundSessionSyncs(runtimeId)
            selected.copy(
                sessionActivateTargets = emptyMap(),
                activatedSessionToOpen = null,
                selectedRuntimeId = runtimeId,
                selectedOfflineSessionId = null,
                sessionSyncRequests = if (needsSessionRefresh && runtimeId != null) selected.sessionSyncRequests + runtimeId
                    else selected.sessionSyncRequests,
            )
        }
        // 用户（或被恢复流程）已经选定了去处，恢复逻辑不再介入；同时记下这一处，
        // 供掉线重连/APP 重启后自动回到这里（spec 第 16 行、§14 B7）。
        restoreSettled = true
        val pairedDevice = device
        if (pairedDevice != null) {
            if (runtimeId == null) {
                // 主动退回列表：不要把用户再拽回会话里。
                lastSessionStore.clear(pairing.hostId)
            } else {
                lastSessionStore.save(pairing.hostId, pairedDevice.deviceId, runtimeId, runtime?.sessionId)
            }
        }
        runtime?.takeIf(RuntimeSummary::sessionGraphSync)?.let { selected ->
            val targetChainComplete = selected.sessionLeafId == null || graph?.hasCompleteEntryChain(selected.sessionLeafId) == true
            Log.i(
                RELOAD_TRACE_TAG,
                "session.open runtimeId=${selected.runtimeId} sessionId=${selected.sessionId} " +
                    "live=${conversation?.hasLiveSnapshot == true} graphComplete=$targetChainComplete " +
                    "connection=${mutableState.value.connection} refresh=$needsSessionRefresh",
            )
            if (pairedDevice != null && needsSessionRefresh) {
                scheduleSessionGraphLoad(pairedDevice, listOf(selected))
            }
        }
    }

    /** Ask the Host for the current Git HEAD; no command is sent to the agent itself. */
    fun refreshWorkingBranch(runtimeId: String) {
        val current = mutableState.value
        val runtime = current.runtimes[runtimeId] ?: return
        if (!current.e2eReady) return
        val requestId = UUID.randomUUID().toString()
        val previous = current.workingBranches[runtimeId]?.takeIf {
            it.cwd == runtime.cwd && it.sessionId == runtime.sessionId
        }
        updateState { state ->
            state.copy(workingBranches = state.workingBranches + (runtimeId to WorkingBranch(
                requestId = requestId,
                sessionId = runtime.sessionId,
                cwd = runtime.cwd,
                branch = previous?.branch,
                commit = previous?.commit,
                loaded = previous?.loaded == true,
            )))
        }
        relay.sendDeviceMessage(buildJsonObject {
            put("type", "runtime.git.request")
            put("protocolVersion", PROTOCOL_VERSION)
            put("runtimeId", runtimeId)
            put("requestId", requestId)
        })
    }

    /** Explicit refresh re-enables synchronization after a recoverable failure. */
    fun refreshRuntime(runtimeId: String? = mutableState.value.selectedRuntimeId, explicitRetry: Boolean = false): Boolean {
        val id = runtimeId ?: return false
        refreshAgentModel(id, force = explicitRetry)
        if (!explicitRetry && (id in mutableState.value.sessionSyncFailures ||
                mutableState.value.conversations[id]?.chatSyncError != null)) return false
        if (explicitRetry) updateState { it.retrySessionSync(id) }
        // Deciding whether a refresh is still needed and publishing that decision must be one
        // atomic step, otherwise a loader write landing in between drops the requested refresh.
        var accepted = false
        var refreshed = mutableState.value
        updateState { current ->
            val next = current.requestRuntimeRefresh(id)
            accepted = next !== current
            if (accepted) refreshed = next
            next
        }
        if (!accepted) return false
        val pairedDevice = device ?: return true
        val runtime = refreshed.runtimes[id] ?: return true
        if (refreshed.connection != RelayConnection.ONLINE) return true
        if (runtime.sessionGraphSync) {
            scheduleSessionGraphLoad(pairedDevice, listOf(runtime))
        }
        return true
    }

    /** Branch invalidation shares ownership with snapshot persistence and the regular loader. */
    fun refreshAfterBranchAction(runtimeId: String) {
        scope.launch {
            relayStateLock.withLock {
                updateState { it.requestBranchRefresh(runtimeId) }
                val refreshed = mutableState.value
                val pairedDevice = device ?: return@withLock
                val runtime = refreshed.runtimes[runtimeId] ?: return@withLock
                if (refreshed.connection == RelayConnection.ONLINE && runtimeId in refreshed.sessionSyncRequests) {
                    scheduleSessionGraphLoad(pairedDevice, listOf(runtime))
                }
            }
        }
    }

    /** Opens only an already-cached Session graph as a read-only history view. */
    fun selectOfflineSession(sessionId: String?) {
        val current = mutableState.value
        // 用户（或恢复流程）已经选定了去处，别再被「恢复上次会话」拽走。
        restoreSettled = true
        if (sessionId == null) {
            updateState { it.copy(selectedOfflineSessionId = null) }
            return
        }
        if (current.runtimes.values.any { it.sessionId == sessionId }) {
            updateState { it.copy(error = "该 Session 当前由在线 Runtime 打开，请从 Runtime 列表进入") }
            return
        }
        if (current.sessions[sessionId]?.hasHistoryCache != true) {
            updateState { it.copy(error = "该 Session 没有可用的本地历史缓存") }
            return
        }
        updateState { it.cancelForegroundSessionSyncs(null).copy(
            sessionActivateTargets = emptyMap(),
            activatedSessionToOpen = null,
            selectedRuntimeId = null,
            selectedOfflineSessionId = sessionId,
        ) }
        val pairedDevice = device ?: return
        scope.launch(Dispatchers.IO) {
            loadCachedSessionGraph(pairedDevice, sessionId)
        }
    }

    private fun registerReadWorker(operationId: String, job: Job) {
        synchronized(historyJobs) { historyJobs[operationId] = job }
        job.invokeOnCompletion {
            synchronized(historyJobs) { if (historyJobs[operationId] === job) historyJobs.remove(operationId) }
        }
        // Close the gap when invalidation preceded execution-handle registration.
        if (!mutableState.value.ownsHistoryRead(operationId)) job.cancel()
    }

    fun loadOlderHistory(runtimeId: String? = mutableState.value.selectedRuntimeId): HistoryReadAcceptance {
        val key = runtimeId ?: return HistoryReadAcceptance(rejection = "没有选中的历史窗口")
        val pairedDevice = device ?: return HistoryReadAcceptance(rejection = "设备尚未配对")
        val operationId = UUID.randomUUID().toString()
        var acceptance = HistoryReadAcceptance()
        updateState { state -> state.beginHistoryRead(key, operationId).also { acceptance = it.acceptance }.state }
        if (acceptance.operationId == null || acceptance.merged) return acceptance
        val operation = mutableState.value.historyReads[operationId] ?: return acceptance
        val kind = mutableState.value.runtimes[key]?.agentKind ?: mutableState.value.sessions[operation.sessionId]?.agentKind
        val probe = HistoryLoadProbe.start(kind ?: "offline", operation.sessionId, operation.beforeEntryId, "history",
            leafId = operation.leafId, cacheEpoch = operation.cacheEpoch)
        // Registration precedes execution, so even an immediately completed cache read has an owner.
        val job = scope.launch(Dispatchers.IO, start = CoroutineStart.LAZY) {
            try {
                probe?.mark("worker_started")
                if (device != pairedDevice || !mutableState.value.ownsHistoryRead(operationId)) return@launch
                if (prepareSessionCache(pairedDevice, operation.sessionId, kind)) return@launch
                currentCoroutineContext().ensureActive()
                probe?.mark("cache_read_begin")
                val (page, cacheEpoch) = synchronized(sessionGraphStore) {
                    sessionGraphStore.readBranch(pairedDevice, operation.sessionId,
                        leafId = operation.leafId, beforeEntryId = operation.beforeEntryId, maxEntries = historyPageSize) to
                        sessionGraphStore.cacheEpoch(pairedDevice, operation.sessionId)
                }
                currentCoroutineContext().ensureActive()
                probe?.mark("cache_read_end", "entries=${page.entries.size} status=${page.status}")
                var appliedPhase: HistoryReadPhase? = null
                updateState { state ->
                    val next = if (device == pairedDevice) state.applyLocalHistoryRead(operationId, page, cacheEpoch) else state
                    appliedPhase = next.historyReads[operationId]?.phase
                    next
                }
                when (appliedPhase) {
                    HistoryReadPhase.SUCCEEDED -> probe?.mark("local_completed")
                    HistoryReadPhase.END_REACHED -> probe?.mark("local_exhausted")
                    else -> Unit
                }
                if (!mutableState.value.ownsHistoryRead(operationId)) return@launch
                relayStateLock.withLock {
                    if (!mutableState.value.ownsHistoryRead(operationId)) return@withLock
                    val runtime = mutableState.value.runtimes[key]
                    if (runtime == null || mutableState.value.connection != RelayConnection.ONLINE || !mutableState.value.e2eReady) {
                        updateState { it.finishHistoryRead(operationId, HistoryReadPhase.FAILED, "本地历史存在缺口，请连接后重试") }
                    } else {
                        probe?.mark("remote_requested")
                        requestHistoryRange(pairedDevice, runtime, operation)
                    }
                }
            } catch (error: CancellationException) {
                updateState { it.finishHistoryRead(operationId, HistoryReadPhase.CANCELLED) }
                throw error
            } catch (error: Exception) {
                probe?.mark("cache_read_error", "type=${error::class.simpleName}")
                updateState { it.finishHistoryRead(operationId, HistoryReadPhase.FAILED, "历史缓存读取失败：${error.message}") }
            } finally {
                // A transferred page is owned by its REMOTE phase, not this local worker.
                updateState { state -> if (state.historyReads[operationId]?.phase == HistoryReadPhase.LOCAL)
                    state.finishHistoryRead(operationId, HistoryReadPhase.CANCELLED) else state }
            }
        }
        registerReadWorker(operationId, job)
        job.invokeOnCompletion { cause ->
            probe?.mark("worker_finished", "result=${if (cause == null) "returned" else "cancelled_or_failed"}")
        }
        job.start()
        return acceptance
    }

    private fun requestHistoryRange(
        pairedDevice: DeviceCredential,
        runtime: RuntimeSummary,
        operation: HistoryReadOperation,
    ) {
        if (!mutableState.value.ownsHistoryRead(operation.operationId)) return
        val pending = PendingSessionSync(
            runtime.runtimeId, operation.sessionId, UUID.randomUUID().toString(), range = "history",
            targetLeafId = operation.leafId, beforeEntryId = operation.beforeEntryId, viewLeafId = operation.leafId,
            branchGeneration = operation.branchGeneration, connectionGeneration = generation,
            historyOperationId = operation.operationId,
        )
        sendSessionSync(pairedDevice, newSessionSyncCommandId(), pending)
        updateState { state -> if (state.historyReads[operation.operationId]?.phase == HistoryReadPhase.LOCAL)
            state.finishHistoryRead(operation.operationId, HistoryReadPhase.FAILED, "历史请求未能加入同步队列，请重试") else state }
    }
    private fun startBranchCatchUp(
        pairedDevice: DeviceCredential,
        runtime: RuntimeSummary,
        fixedTarget: String? = runtime.sessionLeafId,
        completedRange: PendingSessionSync? = null,
    ) {
        val sessionId = runtime.sessionId ?: return
        if (runCatching { prepareSessionCache(pairedDevice, sessionId, runtime.agentKind) }.getOrElse {
                reportSessionLoadFailure(runtime.runtimeId, it)
                return
            }) return
        val current = mutableState.value
        if (device != pairedDevice || !shouldConnect || current.runtimes[runtime.runtimeId]?.sessionId != sessionId ||
            runtime.runtimeId in current.sessionSyncFailures) return
        if (sessionRangeFailureKey(runtime.runtimeId, "catchup") in current.sessionRangeFailures) return
        if (current.sessionSyncCommands.values.any { it.runtimeId == runtime.runtimeId && it.range == "catchup" }) return
        var acceptance = SessionReadAcceptance()
        updateState { it.beginSessionRead(runtime.runtimeId, SessionReadKind.CATCHUP,
            UUID.randomUUID().toString(), fixedTarget).also { start -> acceptance = start.acceptance }.state }
        val operationId = acceptance.operationId ?: return
        val operation = mutableState.value.sessionReads[operationId] ?: return
        val targetLeafId = operation.leafId
        if (targetLeafId == null) {
            updateState { it.finishHistoryRead(operationId, SessionReadPhase.SUCCEEDED) }
            return
        }
        val (gap, cacheEpoch) = try {
            synchronized(sessionGraphStore) {
                sessionGraphStore.planCatchUp(pairedDevice, sessionId, targetLeafId) to
                    sessionGraphStore.cacheEpoch(pairedDevice, sessionId)
            }
        } catch (error: Exception) {
            failLocalSessionRead(operationId, error)
            return
        }
        updateState { it.observeCatchupCoverage(operationId, completedRange, gap, cacheEpoch) }
        if (gap == null) {
            if (mutableState.value.sessionReads[operationId]?.phase != SessionReadPhase.SUCCEEDED) return
            val latest = mutableState.value.runtimes[runtime.runtimeId]
            if (latest?.sessionId == sessionId && latest.sessionLeafId != targetLeafId)
                scheduleSessionGraphLoad(pairedDevice, listOf(latest))
            return
        }
        if (!mutableState.value.ownsHistoryRead(operationId)) return
        val pending = PendingSessionSync(
            runtimeId = runtime.runtimeId, sessionId = sessionId, syncId = UUID.randomUUID().toString(),
            range = "catchup", targetLeafId = targetLeafId, knownLeafId = gap.knownLeafId,
            requestTargetLeafId = gap.targetLeafId, viewLeafId = runtime.sessionLeafId,
            branchGeneration = operation.branchGeneration,
            connectionGeneration = generation, historyOperationId = operationId,
        )
        sendSessionSync(pairedDevice, newSessionSyncCommandId(), pending)
    }

    private fun sendSessionSync(pairedDevice: DeviceCredential, commandId: String, pending: PendingSessionSync) {
        val agentKind = mutableState.value.runtimes[pending.runtimeId]?.agentKind
            ?: mutableState.value.sessions[pending.sessionId]?.agentKind
        if (prepareSessionCache(pairedDevice, pending.sessionId, agentKind)) return
        val operationId = pending.historyOperationId ?: UUID.randomUUID().toString()
        updateState { current ->
            if (device != pairedDevice || !shouldConnect || pending.connectionGeneration != generation ||
                current.runtimes[pending.runtimeId]?.sessionId != pending.sessionId ||
                pending.branchGeneration != (current.sessionBranchGenerations[pending.runtimeId] ?: 0)) current
            else {
                val started = if (pending.historyOperationId != null) SessionReadStart(current, SessionReadAcceptance(operationId))
                    else current.beginSessionRead(pending.runtimeId,
                        if (pending.range == "preview") SessionReadKind.SOURCE else SessionReadKind.CATCHUP,
                        operationId, pending.targetLeafId,
                        demandGeneration = pending.demandGeneration ?: (current.sessionSyncDemandGenerations[pending.runtimeId] ?: 0L))
                val id = started.acceptance.operationId
                if (id == null) started.state else started.state.queueSessionSync(commandId, pending.copy(
                    historyOperationId = id,
                    demandGeneration = pending.demandGeneration ?: (current.sessionSyncDemandGenerations[pending.runtimeId] ?: 0),
                ))
            }
        }
        runSessionSyncScheduler()
    }
    private fun launchFirstSessionPage(pairedDevice: DeviceCredential, runtime: RuntimeSummary, operationId: String) {
        val job = scope.launch(Dispatchers.IO, start = CoroutineStart.LAZY) {
            try {
                currentCoroutineContext().ensureActive()
                val loaded = loadLocalGraphForRuntime(pairedDevice, runtime)
                val hasLocal = loaded != null || hasAnyLocalSessionData(pairedDevice, runtime.sessionId)
                currentCoroutineContext().ensureActive()
                updateState { current ->
                    if (device != pairedDevice) current
                    else when (firstPageOutcome(loaded, hasLocal)) {
                        FirstPageOutcome.LOADED -> current.applyFirstSessionPage(operationId, loaded!!)
                        // 新会话没有本地缓存：交给源端首屏，不在对话窗口顶部挂错误。
                        FirstPageOutcome.NO_LOCAL_CACHE -> current.finishHistoryRead(operationId, SessionReadPhase.SUPERSEDED)
                        FirstPageOutcome.GAP -> current.finishHistoryRead(
                            operationId, SessionReadPhase.FAILED, "本地首屏存在缺口，等待源端恢复",
                        )
                    }
                }
            } catch (error: CancellationException) {
                updateState { it.finishHistoryRead(operationId, SessionReadPhase.CANCELLED) }
                throw error
            } catch (error: Exception) {
                failLocalSessionRead(operationId, error)
            } finally {
                updateState { state -> if (state.sessionReads[operationId]?.phase == SessionReadPhase.LOCAL)
                    state.finishHistoryRead(operationId, SessionReadPhase.CANCELLED) else state }
            }
        }
        registerReadWorker(operationId, job)
        job.start()
    }

    private fun failLocalSessionRead(operationId: String, error: Exception) {
        updateState { it.failLocalSessionRead(operationId, "本地 Session 读取失败：${error.message ?: "未知错误"}") }
    }

    private fun reportSessionLoadFailure(runtimeId: String, error: Throwable) {
        updateState { current ->
            val operation = current.sessionReads.values.lastOrNull { it.historyKey == runtimeId && it.phase.active &&
                it.kind in setOf(SessionReadKind.FIRST_PAGE, SessionReadKind.CATCHUP) }
            val started = if (operation != null) SessionReadStart(current, SessionReadAcceptance(operation.operationId))
                else current.beginSessionRead(runtimeId, if (current.selectedRuntimeId == runtimeId) SessionReadKind.FIRST_PAGE
                    else SessionReadKind.CATCHUP, UUID.randomUUID().toString())
            started.acceptance.operationId?.let { started.state.failLocalSessionRead(it,
                "本地 Session 读取失败：${error.message ?: "未知错误"}") } ?: started.state
        }
    }
    fun loadDraft(runtimeId: String): String {
        val pairedDevice = device ?: return ""
        val runtime = mutableState.value.runtimes[runtimeId] ?: return ""
        return draftStore.load(pairedDevice, runtime)
    }

    fun saveDraft(runtimeId: String, value: String) {
        val pairedDevice = device ?: return
        val runtime = mutableState.value.runtimes[runtimeId] ?: return
        draftStore.save(pairedDevice, runtime, value)
    }

    fun clearDraft(runtimeId: String) {
        saveDraft(runtimeId, "")
    }

    fun setSessionAlias(runtimeId: String, value: String) {
        val pairedDevice = device ?: return
        val runtime = mutableState.value.runtimes[runtimeId] ?: return
        val identity = runtime.sessionAliasIdentity()
        val alias = normalizeSessionAlias(value)
        sessionAliasStore.save(pairedDevice, runtime, value)
        updateState { it.copy(sessionAliases = if (alias == null) it.sessionAliases - identity
            else it.sessionAliases + (identity to alias)) }
    }

    /**
     * 发一条消息。
     *
     * [attachments] 是**已经传完**的附件在电脑上的绝对路径。还没传完的留在 composer 上，
     * 不允许随消息发出——否则 agent 会拿到一个不存在的路径。
     */
    fun sendMessage(text: String, delivery: String? = null, attachments: List<String> = emptyList()): String? {
        val runtimeId = mutableState.value.selectedRuntimeId ?: return null
        // 只剩附件没正文时也得发出：协议要求 text 非空，而用户确实想把这个文件交给 Pi。
        val trimmed = text.trim().ifBlank { if (attachments.isEmpty()) "" else "已发送 ${attachments.size} 个附件" }
        if (trimmed.isBlank()) return null
        if (text.trim().startsWith("/")) {
            updateState { it.copy(error = "斜杠命令只能从当前 Pi 提供的菜单中选择") }
            return null
        }
        val messageId = UUID.randomUUID().toString()
        val commandId = relay.sendUserMessage(runtimeId, trimmed, messageId, delivery, attachments)
        trackCommand(commandId, runtimeId, "消息未发送：中继服务器当前离线")
        return commandId
    }

    /**
     * 已经把文件交给 Pi 之后清掉 composer 上的附件：任务本身还留在上传列表里（可查进度/删记录）。
     */
    fun detachUploads(taskIds: Set<String>) {
        if (taskIds.isEmpty()) return
        updateState { it.copy(uploads = it.uploads - taskIds) }
    }

    /**
     * 会话输入栏的附件关联，按 会话 记在 ViewModel 上而不是 Compose 的 remember 里：
     * 退出会话窗口再回来，chip 要原样恢复——上传任务本身不因退出窗口取消，入口也不该消失。
     * 进程级生命周期：App 被杀后任务由持久层标记 paused，重新选文件即续传。
     */
    private val composerAttachments = mutableMapOf<String, MutableSet<String>>()

    fun attachedTaskIds(sessionKey: String): Set<String> =
        composerAttachments[sessionKey]?.toSet() ?: emptySet()

    fun setAttachedTaskIds(sessionKey: String, taskIds: Set<String>) {
        if (taskIds.isEmpty()) composerAttachments.remove(sessionKey)
        else composerAttachments[sessionKey] = taskIds.toMutableSet()
    }

    fun executeSlashCommand(name: String, args: String): String? {
        val runtimeId = mutableState.value.selectedRuntimeId
        if (runtimeId == null) {
            Log.i(RELOAD_TRACE_TAG, "ui.slash.rejected name=$name reason=no_runtime")
            return null
        }
        if (mutableState.value.runtimes[runtimeId]?.domainAvailability?.get("capabilities") != "ready") {
            refreshAgentModel(runtimeId, force = true)
            updateState { it.copy(error = "电脑尚未核对可用命令，请稍后重试") }
            return null
        }
        Log.i(RELOAD_TRACE_TAG, "ui.slash.requested name=$name runtimeId=$runtimeId argsLength=${args.length}")
        val command = mutableState.value.capabilities[runtimeId]?.commands?.find { it.name == name }
        if (command == null) {
            Log.i(RELOAD_TRACE_TAG, "ui.slash.rejected name=$name reason=command_not_available")
            updateState { it.copy(error = "所选命令已不再由当前 Pi 提供，请重新选择") }
            return null
        }
        val normalizedArgs = args.trim()
        if (command.argument == null && normalizedArgs.isNotBlank()) {
            Log.i(RELOAD_TRACE_TAG, "ui.slash.rejected name=$name reason=arguments_not_allowed")
            updateState { it.copy(error = "命令 /$name 不接受参数") }
            return null
        }
        if (command.argument?.required == true && normalizedArgs.isBlank()) {
            Log.i(RELOAD_TRACE_TAG, "ui.slash.rejected name=$name reason=argument_required")
            updateState { it.copy(error = "命令 /$name 需要参数") }
            return null
        }
        val commandId = relay.executeSlashCommand(runtimeId, name, normalizedArgs)
        Log.i(RELOAD_TRACE_TAG, "ui.slash.sent name=$name runtimeId=$runtimeId commandId=${commandId ?: "<not_sent>"}")
        trackCommand(commandId, runtimeId, "命令未发送：中继服务器当前离线")
        return commandId
    }

    fun updatePermissions(settingId: String, value: String): String? {
        val runtimeId = mutableState.value.selectedRuntimeId ?: return null
        if (mutableState.value.runtimes[runtimeId]?.domainAvailability?.get("permissions") != "ready") {
            refreshAgentModel(runtimeId, force = true)
            return null
        }
        val commandId = relay.updatePermissions(runtimeId, settingId, value)
        trackCommand(commandId, runtimeId, "权限设置未发送：中继服务器当前离线")
        return commandId
    }

    fun consumeCommandResult(commandId: String) {
        updateState { it.copy(commandResults = it.commandResults - commandId) }
    }

    fun stopRuntime() {
        val runtimeId = mutableState.value.selectedRuntimeId ?: return
        trackCommand(relay.stop(runtimeId), runtimeId, "停止请求未发送：中继服务器当前离线")
    }

    /**
     * 下载一个 artifact。
     *
     * **下载总是向 Host 请求**（spec §9.4）：文件在电脑磁盘上，Host 常驻，读盘发分片不需要
     * 任何 Pi 进程参与——所以命令的 `runtimeId` 填 [RemoteState.hostId]，Relay 据此路由到
     * Host。`runtimeId` 参数只作来源标记（这条下载是哪个会话里的文件），用于列表分组与回溯。
     */
    fun downloadArtifact(runtimeId: String, artifact: RemoteArtifact) {
        val hostId = mutableState.value.hostId ?: run {
            updateState { it.copy(error = "还没有已配对的电脑，无法下载") }
            return
        }
        artifact.path?.let { path ->
            startFileDownload(runtimeId, hostId, path, artifact.fileName)
            return
        }
        val sessionId = mutableState.value.runtimes[runtimeId]?.sessionId
        val taskId = artifactDownloadTaskId(runtimeId, sessionId, artifact.artifactId)
        val task = mutableState.value.downloads[taskId] ?: ArtifactDownload(
            taskId = taskId,
            runtimeId = runtimeId,
            sessionId = sessionId,
            displayName = artifact.fileName,
            sourceArtifactId = artifact.artifactId,
            artifact = artifact,
        )
        startDownload(task, hostId) { offset -> relay.downloadArtifact(hostId, artifact.artifactId, offset) }
    }

    fun downloadFile(path: String) {
        // 主页面/对话入口都问 Host，不需要先选中哪个 runtime。
        val sourceRuntimeId = mutableState.value.selectedRuntimeId ?: ""
        downloadFile(sourceRuntimeId, path)
    }

    /**
     * 按路径下载一个文件。
     *
     * `runtimeId` 只是来源标记（哪个会话里点的路径）；命令一律发给 Host——能读这个文件的
     * 就是它。未配对 Host 时直接报错，而不是把请求丢给某个 runtime。
     */
    fun downloadFile(runtimeId: String, path: String) {
        if (path.isBlank()) return
        val hostId = mutableState.value.hostId
        if (hostId == null) {
            updateState { it.copy(error = "还没有已配对的电脑，无法下载") }
            return
        }
        startFileDownload(runtimeId, hostId, path.trim())
    }

    fun cancelDownload(taskId: String) {
        val task = mutableState.value.downloads[taskId] ?: return
        if (task.status !in setOf("queued", "downloading", "paused")) return
        val cancelled = artifactDownloadStore.cancel(taskId) ?: return
        val nextTask = artifactDownloadStore.load().firstOrNull { it.taskId == taskId } ?: return
        updateState { it.copy(
            downloads = it.downloads + (taskId to nextTask),
            pendingCommands = task.commandId?.let { id -> it.pendingCommands - id } ?: it.pendingCommands,
            pendingDownloads = task.commandId?.let { id -> it.pendingDownloads - id } ?: it.pendingDownloads,
        ) }
        if (cancelled.transferId != null) {
            // 范围下载由 Host 服务：取消走 E2E 给它。
            val hostId = mutableState.value.hostId ?: cancelled.runtimeId
            relay.cancelArtifact(hostId, cancelled.transferId)
        }
    }

    /**
     * 用户删除下载记录。
     *
     * 回执只包含**被停掉的在途下载**（已下完的任务没有传输要取消、也没有分片要删），所以列表按
     * 请求的 id 撤行，而不是按回执——只看回执会让已完成的记录留在列表里。与 `removeUploads` 同构。
     */
    fun deleteDownloads(taskIds: Set<String>) {
        if (taskIds.isEmpty()) return
        val tasks = mutableState.value.downloads
        val stopped = artifactDownloadStore.delete(taskIds)
        val deletedIds = taskIds.filterTo(mutableSetOf()) { it in tasks }
        if (deletedIds.isEmpty()) return
        val pendingCommandIds = deletedIds.mapNotNull { tasks[it]?.commandId }.toSet()
        updateState { it.copy(
            downloads = it.downloads - deletedIds,
            pendingCommands = it.pendingCommands - pendingCommandIds,
            pendingDownloads = it.pendingDownloads - pendingCommandIds,
        ) }
        val hostId = mutableState.value.hostId
        stopped.forEach { result ->
            val transferId = result.transferId ?: return@forEach
            if (hostId != null) relay.cancelArtifact(hostId, transferId)
        }
    }

    fun retryDownload(taskId: String) {
        val task = mutableState.value.downloads[taskId] ?: return
        // 下载永远问 Host（§9.4）：文件在磁盘上，Host 常驻，与「产生它的那个进程还在不在」无关。
        val hostId = mutableState.value.hostId ?: run {
            updateState { it.copy(error = "还没有已配对的电脑，无法继续下载") }
            return
        }
        when {
            task.sourcePath != null -> startDownload(task, hostId) { offset ->
                relay.downloadFile(hostId, task.sourcePath, offset)
            }
            task.sourceArtifactId != null -> startDownload(task, hostId) { offset ->
                relay.downloadArtifact(hostId, task.sourceArtifactId, offset)
            }
        }
    }

    private fun startFileDownload(
        sourceRuntimeId: String,
        hostId: String,
        path: String,
        displayName: String = downloadDisplayName(path),
    ) {
        val sessionId = mutableState.value.runtimes[sourceRuntimeId]?.sessionId
        val taskId = fileDownloadTaskId(sourceRuntimeId, sessionId, path)
        val task = mutableState.value.downloads[taskId] ?: ArtifactDownload(
            taskId = taskId,
            runtimeId = sourceRuntimeId,
            sessionId = sessionId,
            hostId = hostId,
            displayName = displayName,
            sourcePath = path,
        )
        startDownload(task, hostId) { offset -> relay.downloadFile(hostId, path, offset) }
    }

    private fun startDownload(task: ArtifactDownload, hostId: String, send: (Long) -> String?) {
        if (task.commandId != null && task.status in setOf("queued", "downloading")) return
        val offset = artifactDownloadStore.resumeOffset(task)
        val queued = task.copy(
            hostId = hostId,
            commandId = null,
            transferId = null,
            status = "queued",
            receivedBytes = offset,
            savedLocation = if (offset == 0L) null else task.savedLocation,
            error = null,
        )
        artifactDownloadStore.register(queued)
        updateState { it.copy(downloads = it.downloads + (task.taskId to queued)) }
        val commandId = send(offset)
        if (commandId == null) {
            val failed = queued.copy(status = "failed", error = "文件下载请求未发送：中继服务器当前离线")
            artifactDownloadStore.register(failed)
            updateState { it.copy(downloads = it.downloads + (task.taskId to failed), error = failed.error) }
            return
        }
        val requested = queued.copy(commandId = commandId)
        artifactDownloadStore.register(requested)
        artifactDownloadStore.bindCommand(commandId, task.taskId)
        updateState { it.copy(
            downloads = it.downloads + (task.taskId to requested),
            pendingCommands = it.pendingCommands + (commandId to hostId),
            pendingDownloads = it.pendingDownloads + (commandId to PendingDownload(task.taskId, hostId, offset)),
        ) }
    }

    fun respondConfirm(request: PendingInteraction, approved: Boolean) {
        respond(request) { runtimeId ->
            relay.respond(runtimeId, request, "confirm", booleanValue = approved)
        }
    }

    fun respondValue(request: PendingInteraction, value: String) {
        respond(request) { runtimeId ->
            relay.respond(runtimeId, request, request.kind, stringValue = value)
        }
    }

    fun respondValues(request: PendingInteraction, values: List<String>) {
        respond(request) { runtimeId ->
            relay.respond(runtimeId, request, "multi-select", stringValues = values)
        }
    }

    fun respondQuestionnaire(request: PendingInteraction, answers: List<QuestionnaireAnswer>?) {
        respond(request) { runtimeId -> relay.respondQuestionnaire(runtimeId, request, answers) }
    }

    fun cancelInteraction(request: PendingInteraction) {
        respond(request) { runtimeId -> relay.respond(runtimeId, request, "cancel") }
    }

    fun clearError() {
        updateState { it.copy(error = null) }
    }

    /**
     * 诊断现场。
     *
     * 手机出问题时，logcat 抓不到（没插 USB / 没开开发者），界面上又只有一个笼统的报错，
     * 排障就只能靠猜——这台手机到底配到了谁、加密通道有没有建立、最近发生了什么，
     * 一次摊开，一张截图就能定位。
     */
    fun diagnosticReport(): String {
        val credential = device
        val current = mutableState.value
        val version = runCatching {
            application.packageManager.getPackageInfo(application.packageName, 0).versionName
        }.getOrNull() ?: "<未知>"
        return buildString {
            appendLine("版本 $version")
            appendLine("连接状态 ${current.connection}    加密通道 ${if (current.e2eReady) "已建立" else "未建立"}")
            appendLine("中继地址 ${credential.relayUrl}")
            appendLine("本机 deviceId ${credential.deviceId}")
            appendLine("配对电脑 hostId ${pairing.hostId}    名称 ${pairing.hostName ?: "-"}")
            appendLine("配对电脑 hostPub ${pairing.hostPub.take(12)}")
            appendLine(
                "pskRoot " + pairing.pskRoot.takeIf { it.isNotBlank() }?.let { "有（${it.take(8)}…）" }.orEmpty().ifEmpty { "<缺失>" },
            )
            appendLine("选中 runtime ${current.selectedRuntimeId ?: "-"}    传输路径 ${current.path ?: "-"}")
            current.error?.let { appendLine("当前报错 $it") }
            appendLine("──── 最近事件（新 → 旧）────")
            append(relay.recentTraces().asReversed().joinToString("\n"))
        }
    }

    /** 手机本地排的连接优先级（§6.2），顺序即优先级，第 1 位最优先。 */
    fun pathPreference(): List<String> = pathPreferenceStore.load()

    /**
     * 用户改了连接优先级：先落盘，再立刻下发给 Host。此刻没连上也不报错——
     * E2E 就绪时会重发一次（[sendPathPreference]），所以设置不会丢。
     */
    fun setPathPreference(order: List<String>) {
        pathPreferenceStore.save(order)
        sendPathPreference()
    }

    /**
     * 把当前优先级下发给 Host。这是设备→Host 的 E2E 密文载荷，Relay 看不见也不认识它——
     * 所以它不在共享协议 schema 里（见 Host 侧 path-preference.ts）。
     */
    private fun sendPathPreference() {
        val preference = pathPreferenceStore.load()
        relay.sendDeviceMessage(
            buildJsonObject {
                put("type", "device.pathPreference")
                put("protocolVersion", PROTOCOL_VERSION)
                put("preference", buildJsonArray { preference.forEach { add(it) } })
            },
        )
    }

    private fun respond(request: PendingInteraction, send: (String) -> String?) {
        val runtimeId = mutableState.value.selectedRuntimeId ?: return
        val current = mutableState.value
        val conversation = current.conversations[runtimeId] ?: return
        val pending = conversation.interactions[request.requestId] ?: return
        if (current.runtimes[runtimeId]?.domainAvailability?.get("interactions") != "ready") {
            refreshAgentModel(runtimeId, force = true)
            return
        }
        if (!current.e2eReady || pending.submitted || isInteractionExpired(pending, System.currentTimeMillis()) || pending.responseCommandId in current.pendingCommands) return
        val commandId = send(runtimeId)
        trackCommand(commandId, runtimeId, "交互响应未发送：当前离线，请连接后重试")
        if (commandId != null) {
            updateState { latest ->
                val latestConversation = latest.conversations[runtimeId] ?: return@updateState latest
                val latestRequest = latestConversation.interactions[request.requestId] ?: return@updateState latest
                latest.copy(conversations = latest.conversations + (runtimeId to latestConversation.copy(
                    interactions = latestConversation.interactions + (request.requestId to latestRequest.copy(responseCommandId = commandId, responseError = null)),
                )))
            }
        }
    }

    private fun trackCommand(commandId: String?, runtimeId: String, offlineError: String) {
        updateState { if (commandId == null) it.copy(error = offlineError)
            else it.copy(pendingCommands = it.pendingCommands + (commandId to runtimeId)) }
    }

    private fun connect(
        credential: DeviceCredential,
        e2eOptions: E2eConnectOptions? = defaultE2eOptions(credential),
        pairingMode: Boolean = false,
    ) {
        // 配对进行中只允许配对那一次连接进来：自动重连进来会先 disconnect() 把配对连接掐掉。
        if (pairingAwaitingAccept && !pairingMode) return
        val options = e2eOptions
        if (options == null) {
            // 半配对残留：有中继凭据、却没有配对密钥（历史遗留，或上一次配对中途失败）。
            // 这种连接能连上中继，但永远没有加密通道，进程激活必然被拒。与其把人困在
            // 「已连接」的主界面里反复报同一句话，不如直接退回配对页说明原因。
            shouldConnect = false
            updateState { RemoteState(
                connection = RelayConnection.OFFLINE,
                error = "这台手机上的配对不完整（缺少端到端加密材料）：请重新扫码配对",
            ) }
            return
        }
        reconnectJob?.cancel()
        relayEventJob?.cancel()
        val currentGeneration = ++generation
        var preserveErrorOnClose = false
        var stopReconnectOnClose = false
        // Relay closes immediately after protocol.error; the async reducer may run after onClosed.
        val protocolVersionMismatch = AtomicBoolean(false)
        // 入站帧按 channel 分两条优先级通道（见 `InboundFrameLanes`）。
        //
        // 以前这里是一条**无界** FIFO，文本帧与二进制分片挤在一起按到达顺序消费。分片落盘比网络
        // 慢，队列于是无界积压，一条控制帧要排在这堆分片后面——下载一开，聊天不刷新、消息发不出去、
        // 交互点不动，全部来自这里。按 channel 拆开之后，消费循环每次回到顶部都先清空交互面，
        // 最坏等待从「整条积压」降到「一片落盘」。
        //
        // 二进制分片仍然与文本帧分享同一条消费循环（不是各自的协程）：`artifact.started` 必须
        // 先于依赖它的分片生效。拆开优先级本身就保证了这一点——`started` 走交互面，永远先走。
        val lanes = InboundFrameLanes()
        relayEventJob = scope.launch(Dispatchers.IO) {
            while (currentGeneration == generation) {
                // ① 控制面优先：交互面里只要还有，就一直处理，绝不让分片插到前面。
                var frame: Any? = lanes.takeInteractive()
                if (frame == null) {
                    // ② 交互面空了，才处理一片分片。
                    frame = lanes.takeBulk()
                    if (frame == null) {
                        // ③ 两面都空：挂起等生产者叫醒。
                        if (!lanes.awaitWork()) break
                        continue
                    }
                }
                if (frame is ByteArray) {
                    runCatching { processArtifactChunk(frame) }.onFailure { error ->
                        updateState { it.copy(error = "文件下载失败：${error.message ?: "二进制下载分片无效"}") }
                    }
                    continue
                }
                // 走到这里只可能是交互帧：分片在上面那条分支就 `continue` 了。
                val interactive = frame as InboundFrameLanes.InteractiveFrame
                val payload = interactive.payload
                val interactiveChannel = interactive.channel
                val incomingMessage = runCatching { messageJson.parseToJsonElement(payload).jsonObject }.getOrNull()
                val sessionEvent = runCatching {
                    incomingMessage?.takeIf { it["type"]?.jsonPrimitive?.contentOrNull == "runtime.event" }
                        ?.get("event")?.jsonObject
                }.getOrNull()
                if (sessionEvent?.get("type")?.jsonPrimitive?.contentOrNull == "session.snapshot") {
                    // 单帧失败不能让消费协程死掉（scope 里的未捕获异常会崩进程）。
                    runCatching { handleSessionSnapshotPayload(payload, currentGeneration) }
                        .onFailure { error ->
                            Log.e(RELOAD_TRACE_TAG, "frame.snapshot_failed ${error::class.simpleName}: ${error.message}")
                        }
                } else {
                    var archiveChanged = false
                    var deviceReadyArrived = false
                    relayStateLock.withLock {
                        if (currentGeneration != generation) return@withLock
                        val previous = mutableState.value
                        val committedBatch = if (sessionEvent?.get("type")?.jsonPrimitive?.contentOrNull == "session.patch") {
                            val patch = runCatching { messageJson.decodeFromJsonElement<SessionPatch>(sessionEvent) }.getOrNull()
                            val runtimeId = incomingMessage?.get("runtimeId")?.jsonPrimitive?.contentOrNull
                            val pairedDevice = device
                            if (patch != null && runtimeId != null && pairedDevice != null &&
                                previous.ownsSessionPatch(runtimeId, patch)
                            ) {
                                runCatching {
                                    prepareSessionCache(pairedDevice, patch.sessionId, mutableState.value.runtimes[runtimeId]?.agentKind)
                                    ingestSessionPatch(sessionGraphStore, pairedDevice, runtimeId, patch,
                                        currentState = { mutableState.value },
                                        connectionCurrent = { currentGeneration == generation && device == pairedDevice && shouldConnect })
                                }.getOrElse { error ->
                                    val failure = "Session 历史缓存写入失败：${error.message ?: "未知错误"}"
                                    updateState { latest -> latest.copy(
                                        sessionSyncFailures = latest.sessionSyncFailures + (runtimeId to failure),
                                        conversations = latest.conversations + (runtimeId to
                                            (latest.conversations[runtimeId] ?: RuntimeConversation()).copy(chatSyncError = failure)),
                                    ) }
                                    return@withLock
                                } ?: return@withLock
                            } else null
                        } else null
                        val artifactResult = runCatching { processArtifactPayload(payload) }
                        runCatching { reducer.reduce(previous, payload, committedBatch, channel = interactiveChannel) }
                            .onFailure { error ->
                                // reducer 抛异常过去是**静默吞掉**的：界面会永远停在「正在连接」，
                                // 而现场没有任何线索。宁可吵也不能哑。
                                Log.e(RELOAD_TRACE_TAG, "reducer.failed ${error::class.simpleName}: ${error.message}", error)
                            }
                            .onSuccess { reduced ->
                                val message = incomingMessage
                                val messageType = message?.get("type")?.jsonPrimitive?.contentOrNull
                                val protocolCode = message?.get("code")?.jsonPrimitive?.contentOrNull
                                if (interactiveChannel != null && messageType == "provider.changed") {
                                    val kind = message["kind"]?.jsonPrimitive?.contentOrNull
                                    if (kind == reduced.agentProviders.kind && !reduced.agentProviders.loading) scope.launch { loadAgentProviders(kind) }
                                    if (kind in setOf("pi", "codex", "dsh")) scope.launch { refreshSessions() }
                                }
                                if (interactiveChannel != null && messageType == "provider.result" && message?.get("notice")?.jsonPrimitive?.contentOrNull?.isNotBlank() == true) scope.launch { refreshSessions() }
                                val runtimeError = message?.get("event")?.jsonObject
                                    ?.takeIf { messageType == "runtime.event" }
                                    ?.takeIf { it["type"]?.jsonPrimitive?.contentOrNull == "runtime.error" }
                                archiveChanged = messageType == "session.archive.changed"
                                if (messageType == "protocol.error" || runtimeError != null) {
                                    preserveErrorOnClose = true
                                }
                                if (message?.get("protocolVersion")?.jsonPrimitive?.intOrNull != null &&
                                    message["protocolVersion"]?.jsonPrimitive?.intOrNull != PROTOCOL_VERSION ||
                                    protocolCode in setOf("unauthorized", "invalid_message", "protocol_version_mismatch", "runtime_mismatch") ||
                                    runtimeError?.get("recoverable")?.jsonPrimitive?.contentOrNull == "false"
                                ) {
                                    stopReconnectOnClose = true
                                }
                                var next = reduced
                                val artifactFailure = artifactResult.exceptionOrNull()
                                val persistedDownloads = if (artifactFailure != null) artifactDownloadStore.load().associateBy(ArtifactDownload::taskId) else emptyMap()
                                if (artifactFailure == null) next.downloads
                                    .filter { (taskId, task) -> previous.downloads[taskId] != task }
                                    .values
                                    .forEach(artifactDownloadStore::register)
                                updateState { latest ->
                                    val rebased = if (latest === previous) next
                                        else reducer.reduce(latest, payload, committedBatch, channel = interactiveChannel)
                                    if (artifactFailure == null) rebased else rebased.copy(
                                        downloads = rebased.downloads.mapValues { (taskId, task) -> persistedDownloads[taskId] ?: task },
                                        error = "文件下载失败：${artifactFailure.message ?: "无法保存文件"}",
                                    )
                                }
                                next = mutableState.value
                                // Upload state is published after the reducer, through its own transforms.
                                runCatching { processUploadPayload(payload) }
                                    .onFailure { error -> Log.e(RELOAD_TRACE_TAG, "upload.payload_failed", error) }
                                if (previous.sessions != next.sessions) {
                                    device?.let { pairedDevice ->
                                        scope.launch(Dispatchers.IO) {
                                            catalogWriteLock.withLock {
                                                if (device == pairedDevice) {
                                                    runCatching { saveSessionCatalog(pairedDevice) }
                                                }
                                            }
                                        }
                                    }
                                }
                                device?.let { pairedDevice ->
                                    val graphRuntimes = next.sessionSyncRequests.mapNotNull(next.runtimes::get)
                                    scheduleSessionGraphLoad(pairedDevice, graphRuntimes)
                                }
                                if (messageType == "device.ready" && interactiveChannel != null) deviceReadyArrived = true
                                if (next.connection == RelayConnection.ONLINE) reconnectDelayMs = 500
                                notifyNewInteractions(previous, next)
                            }
                            .onFailure { error ->
                                // 回归套路的入口：reduce 抛异常时只把这一帧丢掉，手机就此和电脑端
                                // 静默分叉（状态、消息都停在旧值）。错误必须留下可定位的痕迹。
                                Log.e(RELOAD_TRACE_TAG, "reduce.failed", error)
                                preserveErrorOnClose = true
                                updateState { current -> current.copy(error = "收到无效的中继服务器消息") }
                            }
                    }
                    // 只有 Host 的加密 device.ready 才触发刷新；Relay 的明文确认不携带会话目录。
                    // Host 已上线：自动拉一次全量会话索引刷新侧栏
                    // （spec §8 L1 的前提——手机得先知道有哪些会话可继续）。重连后也会重新拉。
                    if (deviceReadyArrived && currentGeneration == generation) {
                        val application = application
                        val packageInfo = application.packageManager.getPackageInfo(application.packageName, 0)
                        val appVersion = packageInfo.versionName
                        if (!appVersion.isNullOrBlank()) {
                            relay.sendDeviceMessage(buildJsonObject {
                                put("type", "device.version.report")
                                put("protocolVersion", PROTOCOL_VERSION)
                                put("version", appVersion)
                                put("versionCode", androidx.core.content.pm.PackageInfoCompat.getLongVersionCode(packageInfo).toInt())
                            })
                        }
                    }
                    if (deviceReadyArrived && currentGeneration == generation &&
                        mutableState.value.sessionListRequests.isEmpty()
                    ) {
                        refreshSessions()
                        // 诊断目录只在连接建立时读一次：它是目录，不是需要跟帧的东西。
                        refreshHostModel()
                        mutableState.value.runtimes.keys.forEach { refreshAgentModel(it) }
                        autoResumeDownloads()
                    }
                    if (archiveChanged && currentGeneration == generation && interactiveChannel != null) {
                        refreshSessions()
                    }
                    if (interactiveChannel != null && currentGeneration == generation) {
                        val onlineRuntime = incomingMessage?.get("runtime") as? JsonObject
                        val changedRuntimeId = onlineRuntime?.get("runtimeId")?.jsonPrimitive?.contentOrNull
                            ?: incomingMessage?.get("runtimeId")?.jsonPrimitive?.contentOrNull?.takeIf {
                                sessionEvent?.get("type")?.jsonPrimitive?.contentOrNull == "runtime.metadata"
                            }
                        changedRuntimeId?.let { refreshAgentModel(it) }
                        requestCatalogPage()
                    }
                    // 调度器故障不能拖垮整个帧消费循环：丢帧只该让这一轮重传，不该让 App 崩。
                    runCatching { syncPullSchedulers() }
                        .onFailure { Log.e(RELOAD_TRACE_TAG, "pull.sync_failed", it) }
                }
            }
        }
        updateState { it.copy(connection = RelayConnection.CONNECTING, error = null) }
        relay.onLanEndpointsChanged = { endpoints ->
            if (currentGeneration == generation && pairing.lanEndpoints != endpoints) {
                // LAN addresses move when the Host restarts; a live connection keeps using the old
                // one until it falls back, so the store is the only place that must stay current.
                pairing = pairing.copy(lanEndpoints = endpoints)
                onPairingUpdated(pairing)
            }
        }
        // device.path（spec §14 B4）：Host 宣布当前路径，侧栏状态随它更新。
        relay.onPathChanged = { path, rttMs ->
            scope.launch {
                // WS callbacks race with device.ready/session reducers on IO. Without their lock,
                // a reducer's older snapshot can overwrite LAN with the previous Relay label.
                relayStateLock.withLock {
                    if (currentGeneration != generation) return@launch
                    updateState { it.copy(path = path, pathRttMs = rttMs) }
                }
                sendPathPreference()
            }
        }
        // Transport callbacks share the reducer lock so a late snapshot cannot revert readiness.
        relay.onE2eStateChanged = { ready ->
            scope.launch {
                relayStateLock.withLock {
                    if (currentGeneration != generation) return@launch
                    if (ready) handshakeStalled = false
                    updateState { current ->
                        current.copy(
                            e2eReady = ready,
                            connection = if (!ready && current.connection == RelayConnection.ONLINE) RelayConnection.RECONNECTING else current.connection,
                            error = if (ready && current.error == HANDSHAKE_STALLED_ERROR) null else current.error,
                        )
                    }
                }
                if (ready) {
                    autoResumeDownloads()
                    sendPathPreference()
                    // device.ready can be reduced before the handshake flips e2eReady (device order:
                    // device.ready, then e2e.hs.confirmed). That first path returns early because the
                    // model read needs an encrypted channel, so the committed-model read has to be
                    // retried here instead of waiting for a resumed 15s reconcile tick.
                    refreshHostModel()
                    mutableState.value.runtimes.keys.forEach { runtimeId -> refreshAgentModel(runtimeId) }
                }
            }
        }
        relay.connect(
            credential,
            onMessage = message@{ payload, channel ->
                if (currentGeneration != generation) return@message
                if (payload.contains("protocol_version_mismatch")) {
                    val isMismatch = runCatching {
                        val message = messageJson.parseToJsonElement(payload).jsonObject
                        message["type"]?.jsonPrimitive?.contentOrNull == "protocol.error" &&
                            message["code"]?.jsonPrimitive?.contentOrNull == "protocol_version_mismatch"
                    }.getOrDefault(false)
                    if (isMismatch) {
                        protocolVersionMismatch.set(true)
                        updateState { it.copy(error = PROTOCOL_VERSION_MISMATCH_ERROR) }
                    }
                }
                // 队列关闭/溢出只说明这条连接正在收尾：重连是自动的，而 connection 已经切成
                // RECONNECTING 在界面上表达过了。以前这里往 error 里写「正在重新连接」，可
                // error 是模态框通道——于是一抖动就弹窗，用户点掉又弹，看起来就是「一直提示」。
                // 顺带把 preserveErrorOnClose 也去掉：它保住的正是这条自己刚写进去的噪音。
                if (!lanes.offer(payload, channel)) {
                    Log.i(RELOAD_TRACE_TAG, "relay.frame_dropped cause=event_queue_closed kind=text")
                }
            },
            onBinaryMessage = binary@{ bytes ->
                if (currentGeneration != generation) return@binary
                if (!lanes.offerBulk(bytes)) {
                    Log.i(RELOAD_TRACE_TAG, "relay.frame_dropped cause=event_queue_closed kind=binary")
                }
            },
            onOpen = {
                if (currentGeneration == generation) {
                    updateState { it.copy(connection = RelayConnection.CONNECTING) }
                }
            },
            onClosed = closed@{ reason ->
                lanes.close()
                if (currentGeneration != generation) return@closed
                if (protocolVersionMismatch.get() || reason == "protocol_version_mismatch") {
                    pairingAwaitingAccept = false
                    shouldConnect = false
                    updateState { it.copy(
                        connection = RelayConnection.OFFLINE,
                        deviceId = if (device == null) null else it.deviceId,
                        error = PROTOCOL_VERSION_MISMATCH_ERROR,
                    ) }
                    return@closed
                }
                if (pairingAwaitingAccept) {
                    // 配对连接在 Host 的 pair-accept 到达之前就断了：这次配对没成。
                    // 不落盘、不进主界面，把人留在配对页重试。
                    pairingAwaitingAccept = false
                    shouldConnect = false
                    updateState { it.copy(
                        connection = RelayConnection.OFFLINE,
                        deviceId = null,
                        error = "配对未完成：连接在电脑确认之前断开。请确认电脑上的配对窗口还开着，再扫一次",
                    ) }
                    return@closed
                }
                if (!shouldConnect) return@closed
                updateState { it.copy(path = null, pathRttMs = null) }
                val pausedDownloads = mutableState.value.downloads.mapValues { (_, task) ->
                    if (task.status in setOf("queued", "downloading")) {
                        task.copy(status = "paused", commandId = null, error = "连接已断开，可在重连后继续")
                    } else task
                }
                pausedDownloads.values.forEach(artifactDownloadStore::register)
                if (stopReconnectOnClose) {
                    updateState { it.markReconnecting(preserveError = true).copy(connection = RelayConnection.OFFLINE) }
                    return@closed
                }
                // Transport loss is expected to recover; keep the alert channel for
                // authentication, protocol, and other actionable failures.
                updateState { it.markReconnecting(preserveErrorOnClose) }
                scheduleReconnect()
            },
            // ★ 必须传：这是 E2E 材料（配对会话 / pskRoot 握手）进入连接的**唯一**入口。
            // 漏传的后果是静默且致命的——连接照常建立、device.authenticate 照常成功、中继照样回
            // device.ready（界面显示「已连接」），但 e2e == null，于是**配对帧与 HS1 一个都发不出去**，
            // 电脑侧永远收不到任何东西。Android 侧从 f822ef9 起一直漏了这一行，表现就是
            // 「每次都显示已连接，却永远无法配对/激活」。
            e2eOptions = options,
        )
        // 配对看门狗：配对连接建立后，若电脑迟迟不确认这次配对（pair-accept），必须有人说话。
        // 这段以前是空白——配对帧发出去没人应，APP 就安静地停在「已连接」，用户无从判断该干什么，
        // 排障时也看不到任何线索。真机联调正是卡死在这里。
        if (pairingMode) {
            scope.launch {
                delay(pairingAcceptTimeoutMs)
                if (currentGeneration != generation) return@launch
                if (!pairingAwaitingAccept) return@launch // 已被 pair-accept 解除 = 配对成功
                pairingAwaitingAccept = false
                shouldConnect = false
                relay.disconnect()
                updateState { it.copy(
                    connection = RelayConnection.OFFLINE,
                    deviceId = null,
                    error = "配对没有完成：电脑没有回确认（配对窗口可能已关闭或过期）。" +
                        "请确认电脑上的配对窗口还开着，再扫一次二维码",
                ) }
            }
        }
        // 握手看门狗：中继认了这台手机（ONLINE 来自 Relay 的 device.ready）**不等于**电脑在听。
        // 电脑没回应 HS1 时，「已连接」会一直挂着，而进程激活只会报「没有加密通道」——
        // 用户看不出该干什么。这里在超时后主动点破，并给出唯一有效的出路（重新配对）。
        scope.launch {
            delay(e2eHandshakeTimeoutMs)
            if (currentGeneration != generation) return@launch
            // 配对阶段的连接本来就没有加密通道（通道要等配对成功、重连发 HS1 之后才有），
            // 别在这里误报「电脑没回应握手」。
            if (pairingMode || pairingAwaitingAccept) return@launch
            if (mutableState.value.connection != RelayConnection.ONLINE) return@launch
            if (relay.hasE2eChannel() || handshakeStalled) return@launch
            handshakeStalled = true
            updateState { it.copy(error = HANDSHAKE_STALLED_ERROR) }
        }
    }

    /**
     * Session snapshots cross the canonical store before replacing the stable projection. This
     * suspends the connection's single event consumer so later deltas cannot overtake the snapshot;
     * SQLite work still runs off the main thread because that consumer uses Dispatchers.IO.
     */
    private suspend fun handleSessionSnapshotPayload(payload: String, connectionGeneration: Int) {
        val decoded = runCatching {
            val outer = messageJson.parseToJsonElement(payload).jsonObject
            val event = outer["event"]?.jsonObject ?: error("session_event_missing")
            val snapshot = messageJson.decodeFromJsonElement<SessionGraphSnapshot>(event)
            val runtimeId = outer["runtimeId"]?.jsonPrimitive?.contentOrNull
                ?: error("runtime_id_missing")
            val sequence = outer["sequence"]?.jsonPrimitive?.longOrNull
                ?: error("sequence_missing")
            Triple(runtimeId, snapshot, sequence)
        }.getOrNull() ?: return
        val (runtimeId, snapshot, sequence) = decoded
        updateState { state ->
            val commandId = state.sessionSyncCommands.entries.firstOrNull {
                it.value.runtimeId == runtimeId && it.value.syncId == snapshot.syncId && it.value.sessionId == snapshot.sessionId
            }?.key
            commandId?.let(state::recoverLateHistoryRead) ?: state
        }
        val initial = mutableState.value
        val pendingEntry = initial.sessionSyncCommands.entries.firstOrNull {
            it.value.runtimeId == runtimeId &&
                it.value.syncId == snapshot.syncId &&
                it.value.sessionId == snapshot.sessionId
        } ?: return
        val pendingCommandId = pendingEntry.key
        val pending = pendingEntry.value
        val responseTargetLeafId = snapshot.targetLeafId ?: snapshot.cursor.leafId
        val expectedResponseTarget = pending.requestTargetLeafId ?: pending.targetLeafId
        val pairedDevice = device ?: return
        Log.i(
            RELOAD_TRACE_TAG,
            "session.snapshot.received runtimeId=$runtimeId sessionId=${snapshot.sessionId} " +
                "pendingRange=${pending.range} snapshotRange=${snapshot.range ?: "<none>"} " +
                "syncId=${snapshot.syncId} entries=${snapshot.entries.size} " +
                "selection=${snapshot.selection} " +
                "complete=${snapshot.complete} status=${snapshot.rangeStatus ?: "<none>"} " +
                "recovery=${pending.sourceRecovery} sourceEpoch=${snapshot.source?.epoch} " +
                "sourceSeq=${snapshot.source?.seq} sourceReady=${snapshot.source?.ready} " +
                "inventoryComplete=${snapshot.checkpoint?.inventoryComplete}",
        )
        val probe = HistoryLoadProbe.start(
            initial.runtimes[runtimeId]?.agentKind ?: "unknown", snapshot.sessionId, snapshot.beforeEntryId, pending.range,
        )
        probe?.mark("snapshot_received", "entries=${snapshot.entries.size}")
        relayStateLock.withLock {
            probe?.mark("snapshot_lock_acquired")
            if (connectionGeneration != generation || device != pairedDevice || !shouldConnect) {
                return@withLock
            }
            if (expectedResponseTarget != null && expectedResponseTarget != responseTargetLeafId) {
                updateState { it.failSessionSync(pendingCommandId, "Session 响应目标不匹配，请重试") }
                return@withLock
            }
            // Keep the ownership check and the SQLite transaction in the same critical
            // section as reducer state publication. Runtime metadata handlers use this lock,
            // so a branch/session change cannot happen between validation and persistence.
            probe?.mark("persist_begin")
            val persisted = runCatching {
                persistSessionSnapshot(
                    pairedDevice = pairedDevice,
                    connectionGeneration = connectionGeneration,
                    runtimeId = runtimeId,
                    commandId = pendingCommandId,
                    snapshot = snapshot,
                )
            }
            probe?.mark("persist_end", "result=${if (persisted.isSuccess) "ok" else "failed"}")
            val persistence = persisted.getOrNull()
            val committed = persistence?.let { CommittedSessionBatch(it.entries, it.display) }
            val persistenceError = persisted.exceptionOrNull()
            val current = mutableState.value
            val stillPending = current.sessionSyncCommands.values.any {
                it.runtimeId == runtimeId &&
                    it.syncId == snapshot.syncId &&
                    it.sessionId == snapshot.sessionId
            }
            if (!stillPending) return@withLock
            if (persistence?.stale == true) {
                // The snapshot lost ownership while it was being persisted. It is neither a
                // display projection nor a canonical update; release it and request the
                // Runtime's current target again.
                val activeRuntime = current.runtimes[runtimeId]
                updateState { latest -> latest.copy(
                    pendingCommands = latest.pendingCommands - pendingCommandId,
                    sessionSyncCommands = latest.sessionSyncCommands - pendingCommandId,
                    sessionSyncRequests = if (latest.runtimes[runtimeId]?.sessionGraphSync == true)
                        latest.sessionSyncRequests + runtimeId else latest.sessionSyncRequests - runtimeId,
                    lastSequence = latest.lastSequence + (
                        "$runtimeId\u0000msg" to maxOf(latest.lastSequence["$runtimeId\u0000msg"] ?: -1L, sequence)
                    ),
                ) }
                activeRuntime?.let { scheduleSessionGraphLoad(pairedDevice, listOf(it)) }
                return@withLock
            }
            val persistenceMessage = persistenceError?.let { error ->
                "Session 历史缓存写入失败：${error.message ?: "未知错误"}"
            }
            if (persistenceMessage != null) {
                updateState { latest -> latest.failSessionSync(pendingCommandId, persistenceMessage).copy(
                    lastSequence = latest.lastSequence + (
                        "$runtimeId\u0000msg" to maxOf(latest.lastSequence["$runtimeId\u0000msg"] ?: -1L, sequence)
                    ),
                ) }
                return@withLock
            }
            val previous = current
            var next = current
            updateState { latest ->
                runCatching { reducer.reduce(latest, payload, committed) }
                    .getOrElse { latest.copy(error = "收到无效的 Session 历史快照") }
                    .also { next = it }
            }
            probe?.mark("snapshot_applied", "accepted=${pendingCommandId !in next.sessionSyncCommands} loading=${next.sessionHistory[runtimeId]?.loading} error=${next.conversations[runtimeId]?.chatSyncError != null}")
            // ADR-0037 §4：先落库再回执。Host 只有收到它才会把这次事务当作 committed。
            if (pendingCommandId !in next.sessionSyncCommands) {
                scope.launch(Dispatchers.IO) {
                    runCatching { relay.acknowledgeSessionSnapshot(runtimeId, snapshot.syncId) }
                }
            }
            val runtime = next.runtimes[runtimeId]
            if (runtime != null && runtime.sessionId == pending.sessionId &&
                pending.branchGeneration == (next.sessionBranchGenerations[runtimeId] ?: 0) &&
                snapshot.rangeStatus in setOf(null, "complete", "older_available", "limit_reached")) {
                // Finish the fixed logical target, reusing any suffix a preview/history already
                // committed. Only after coverage reaches it may a newer live tail start a round.
                val fixedTarget = pending.targetLeafId.takeIf { pending.range == "catchup" }
                if (fixedTarget != null && !sessionGraphStore.hasContinuousCoverage(pairedDevice, pending.sessionId, fixedTarget)) {
                    startBranchCatchUp(pairedDevice, runtime, fixedTarget, completedRange = pending)
                } else {
                    startBranchCatchUp(pairedDevice, runtime)
                }
            }
            if (previous.sessions != next.sessions) {
                scope.launch(Dispatchers.IO) {
                    catalogWriteLock.withLock {
                        if (device == pairedDevice) {
                            runCatching {
                                saveSessionCatalog(pairedDevice)
                            }
                        }
                    }
                }
            }
            val graphRuntimes = next.sessionSyncRequests.mapNotNull(next.runtimes::get)
            scheduleSessionGraphLoad(pairedDevice, graphRuntimes)
            if (next.connection == RelayConnection.ONLINE) reconnectDelayMs = 500
            notifyNewInteractions(previous, next)
        }
    }

    private fun saveSessionCatalog(pairedDevice: DeviceCredential) {
        val current = mutableState.value
        val owner = current.hostId?.takeIf(String::isNotBlank) ?: return
        if (current.deviceId != pairedDevice.deviceId) return
        sessionCatalogStore.save(pairedDevice, owner, current.sessions.values)
    }

    private fun notifyNewInteractions(previous: RemoteState, next: RemoteState) {
        val previousIds = previous.conversations.values.flatMap { it.interactions.keys }.toSet()
        for ((runtimeId, conversation) in next.conversations) {
            for (request in conversation.interactions.values) {
                if (request.requestId !in previousIds) {
                    val runtime = next.runtimes[runtimeId]
                    notifier.show(runtime?.let(next::runtimeDisplayName) ?: "Pi 运行实例", request)
                }
            }
        }
    }

    /** Loads the selected cached branch for offline display. */
    private suspend fun loadCachedSessionGraph(pairedDevice: DeviceCredential, sessionId: String) {
        val key = offlineHistoryKey(sessionId)
        var acceptance = SessionReadAcceptance()
        updateState { it.beginSessionRead(key, SessionReadKind.FIRST_PAGE,
            UUID.randomUUID().toString()).also { start -> acceptance = start.acceptance }.state }
        val operationId = acceptance.operationId ?: return
        if (acceptance.merged) return
        registerReadWorker(operationId, currentCoroutineContext()[Job]!!)
        try {
            currentCoroutineContext().ensureActive()
            if (prepareSessionCache(pairedDevice, sessionId, mutableState.value.sessions[sessionId]?.agentKind)) return
            val graph = synchronized(sessionGraphStore) {
                val leafId = sessionGraphStore.latestLeaf(pairedDevice, sessionId)
                val range = sessionGraphStore.readBranch(pairedDevice, sessionId, leafId, maxEntries = previewPageSize)
                if (leafId == null || range.entries.isEmpty()) null else
                    sessionGraphStore.withCacheVersions(pairedDevice, SessionGraph(sessionId,
                        range.entries.associateBy(SessionGraphEntry::entryId), SessionBranchCursor(leafId),
                        sessionGraphStore.readTurnTimings(pairedDevice, sessionId).associateBy(TurnTiming::turnId)))
            }
            currentCoroutineContext().ensureActive()
            updateState { if (device != pairedDevice) it else if (graph == null)
                it.finishHistoryRead(operationId, SessionReadPhase.FAILED, "本地首屏存在缺口，请连接后重试")
                else it.applyFirstSessionPage(operationId, graph) }
        } catch (error: CancellationException) {
            updateState { it.finishHistoryRead(operationId, SessionReadPhase.CANCELLED) }
            throw error
        } catch (error: Exception) {
            failLocalSessionRead(operationId, error)
        } finally {
            updateState { state -> if (state.sessionReads[operationId]?.phase?.active == true)
                state.finishHistoryRead(operationId, SessionReadPhase.CANCELLED) else state }
        }
    }

    private data class PersistedSessionSnapshotResult(
        val entries: List<SessionGraphEntry>,
        /** 盘上那份条目对应的显示投影，与 entries 同源；线上没给显示结果时为 null。 */
        val display: DisplayBatch? = null,
        val stale: Boolean = false,
    )

    private fun persistSessionSnapshot(
        pairedDevice: DeviceCredential,
        connectionGeneration: Int,
        runtimeId: String,
        commandId: String,
        snapshot: SessionGraphSnapshot,
    ): PersistedSessionSnapshotResult {
        prepareSessionCache(pairedDevice, snapshot.sessionId, mutableState.value.runtimes[runtimeId]?.agentKind)
        val committed = ingestSessionSnapshot(
            sessionGraphStore, pairedDevice, runtimeId, commandId, snapshot,
            currentState = { mutableState.value },
            connectionCurrent = { connectionGeneration == generation && device == pairedDevice && shouldConnect &&
                mutableState.value.sessionSyncCommands[commandId]?.connectionGeneration == connectionGeneration },
        )
        return PersistedSessionSnapshotResult(
            committed?.entries.orEmpty(), committed?.display, stale = committed == null,
        )
    }
    /** 本地是否有这个会话的任何痕迹：没有叶也没有缓存代次 → 全新会话。 */
    private fun hasAnyLocalSessionData(pairedDevice: DeviceCredential, sessionId: String?): Boolean {
        if (sessionId == null) return false
        return synchronized(sessionGraphStore) {
            sessionGraphStore.latestLeaf(pairedDevice, sessionId) != null ||
                sessionGraphStore.cacheEpoch(pairedDevice, sessionId) != null
        }
    }

    private fun loadLocalGraphForRuntime(
        pairedDevice: DeviceCredential,
        runtime: RuntimeSummary,
    ): SessionGraph? {
        val sessionId = runtime.sessionId ?: return null
        prepareSessionCache(pairedDevice, sessionId, runtime.agentKind)
        return synchronized(sessionGraphStore) {
            val observedLeaf = sessionGraphStore.latestLeaf(pairedDevice, sessionId)
            var graph = SessionGraph(sessionId, cacheEpoch = sessionGraphStore.cacheEpoch(pairedDevice, sessionId))
            for (leaf in listOfNotNull(runtime.sessionLeafId, observedLeaf).distinct()) {
                val range = sessionGraphStore.readBranch(pairedDevice, sessionId, leaf, maxEntries = previewPageSize)
                graph = graph.merge(SessionGraphSnapshot(sessionId, "local", SessionBranchCursor(leaf), "prepend", range.entries))
            }
            graph = graph.merge(SessionGraphSnapshot(sessionId, "local", SessionBranchCursor(), "prepend", emptyList(),
                turnTimings = sessionGraphStore.readTurnTimings(pairedDevice, sessionId)))
            graph = sessionGraphStore.withCacheVersions(pairedDevice, graph)
            graph.takeIf { it.entries.isNotEmpty() || it.cacheEpoch != null && runtime.sessionLeafId == null }?.let {
                if (it.cursor.leafId == null) it.copy(cursor = SessionBranchCursor(observedLeaf)) else it
            }
        }
    }
    private fun scheduleSessionGraphLoad(pairedDevice: DeviceCredential, runtimes: List<RuntimeSummary>) {
        val requests = runtimes.map { SessionLoadRequest(pairedDevice, it) }
        launchSessionLoads(requests)
    }

    private fun launchSessionLoads(requests: List<SessionLoadRequest>) {
        val worker = sessionLoads.enqueue(requests) ?: return
        scope.launch(Dispatchers.IO) {
            try {
                while (true) {
                    val batch = sessionLoads.take(worker, mutableState.value.selectedRuntimeId) ?: break
                    for (request in batch) {
                        if (request.device != device) continue
                        try {
                            loadSessionGraphsFor(request.device, listOf(request.runtime))
                        } catch (error: CancellationException) {
                            throw error
                        } catch (error: Exception) {
                            reportSessionLoadFailure(request.runtime.runtimeId, error)
                        }
                    }
                }
            } finally {
                val pending = sessionLoads.release(worker)
                if (pending.isNotEmpty() && shouldConnect) launchSessionLoads(pending)
            }
        }
    }

    /** Runs before any old canonical content can be seeded or validated in memory. */
    private fun prepareSessionCache(pairedDevice: DeviceCredential, sessionId: String, agentKind: String?): Boolean {
        // 显示投影版本换代与 Codex 格式重建一样，都要先清掉旧缓存再让内容重新进来。
        val codexRebuilt = sessionGraphStore.prepareSession(pairedDevice, sessionId, agentKind)
        val displayRebuilt = sessionGraphStore.prepareDisplayCache(pairedDevice, sessionId)
        if (device != pairedDevice || !(codexRebuilt || displayRebuilt)) return false
        val current = mutableState.value
        val affected = current.historyReads.values.filter { it.sessionId == sessionId && it.phase.active }.map { it.operationId }
        updateState { state -> if (device != pairedDevice) state else state.afterSessionCacheRebuild(sessionId).reconcileHistoryReads() }
        synchronized(historyJobs) { affected.mapNotNull { historyJobs[it] } }.forEach(Job::cancel)
        scheduleSessionGraphLoad(pairedDevice, mutableState.value.runtimes.values.filter { it.sessionId == sessionId && it.sessionGraphSync })
        return true
    }

    /**
     * Publishes a state transform without losing a concurrent writer's update.
     *
     * The relay frame loop mutates `mutableState` while the background session loader reads a state
     * snapshot, spends seconds decrypting the local tree, and writes its result back. Because that
     * read-modify-write window is seconds wide, a plain assignment silently reverted every frame
     * that landed inside it: the runtime kept reading as `running` after Pi had settled, the cached
     * `sessionLeafId` froze so every catch-up round was rejected as stale (leaving the chat behind a
     * permanent "Session 已产生更新" banner and re-requesting the same preview forever), and streamed
     * output never reached the chat. Callers now evaluate their transform against the state they
     * actually replace. The short writer lock covers pure state transforms only; cache IO remains
     * outside it and submits identity-bearing results for a fresh ownership check.
     */
    private fun updateState(transform: (RemoteState) -> RemoteState) {
        synchronized(stateWriterLock) {
            val current = mutableState.value
            val next = transform(current).openAcknowledgedSession().trackSessionReadDemands(current).reconcileHistoryReads()
            if (next !== current) mutableState.value = next
        }
    }

    /** Atomic registration/ticks precede sends; every effect rechecks its immutable task. */
    /** 背压复活的最小间隔：比消息速率慢得多，链路上只多出可忽略的空请求。 */
    private var syncBusyReviveAt = 0L

    private fun runSessionSyncScheduler() {
        val pairedDevice = device ?: return
        val state = mutableState.value
        if (!shouldConnect || state.connection != RelayConnection.ONLINE || !state.e2eReady) return
        var tick = SessionSyncTick(state, emptyList())
        updateState { current ->
            advanceSessionSyncTasks(current, System.currentTimeMillis(), generation).also { tick = it }.state
        }
        for ((commandId, pending) in tick.send) {
            if (device != pairedDevice || pending.connectionGeneration != generation ||
                mutableState.value.sessionSyncCommands[commandId] != pending) continue
            val sent = runCatching { relay.syncSession(
                runtimeId = pending.runtimeId, sessionId = pending.sessionId, syncId = pending.syncId,
                knownLeafId = pending.knownLeafId, targetLeafId = pending.requestTargetLeafId,
                beforeEntryId = pending.beforeEntryId,
                maxEntries = if (pending.range == "history") historyPageSize else previewPageSize,
                range = pending.range, commandId = commandId,
                knownState = pending.knownState,
            ) }.getOrNull()
            // A temporary lack of path consumes an attempt; the bounded policy owns retry timing.
            Log.i(RELOAD_TRACE_TAG, "session.sync.send syncId=${pending.syncId} range=${pending.range} attempt=${pending.attempts} sent=${sent != null}")
        }
        // 背压用掉重试额度后会撤掉需求（否则每条消息都会再要一次，变成重试风暴）。
        // 撤掉之后就没有人再要了：会话一安静，画面就会停在旧快照上。这里低频复活，
        // 5 秒一次，直到某次同步成功把 streak 清零。
        val now = System.currentTimeMillis()
        if (now >= syncBusyReviveAt) {
            val stalled = state.runtimes.values.filter { runtime ->
                runtime.sessionGraphSync &&
                    (state.sessionSyncBusyStreaks[runtime.runtimeId] ?: 0) >= MAX_SYNC_BUSY_RETRIES
            }
            if (stalled.isNotEmpty()) {
                syncBusyReviveAt = now + SYNC_BUSY_REVIVE_MS
                scheduleSessionGraphLoad(pairedDevice, stalled)
            }
        }
    }
    private suspend fun loadSessionGraphsFor(pairedDevice: DeviceCredential, runtimes: List<RuntimeSummary>) {
        val connectionGeneration = generation
        for (requested in runtimes.sortedBy { it.runtimeId != mutableState.value.selectedRuntimeId }) {
            if (device != pairedDevice || !shouldConnect || generation != connectionGeneration ||
                mutableState.value.connection != RelayConnection.ONLINE) return
            val runtime = mutableState.value.runtimes[requested.runtimeId]?.takeIf { it.sessionId == requested.sessionId }
                ?: continue
            val sessionId = runtime.sessionId ?: continue
            if (runtime.runtimeId != mutableState.value.selectedRuntimeId) {
                val recovery = mutableState.value.requestedSessionRecovery(runtime.runtimeId, generation, UUID.randomUUID().toString())
                if (recovery != null) sendSessionSync(pairedDevice, newSessionSyncCommandId(), recovery)
                else startBranchCatchUp(pairedDevice, runtime)
                continue
            }
            prepareSessionCache(pairedDevice, sessionId, runtime.agentKind)
            val initial = mutableState.value
            // A trusted baseline needs a source check, not another local decrypt/projection pass.
            val conditional = initial.requestedSessionRecovery(runtime.runtimeId, generation, UUID.randomUUID().toString())
                ?.takeIf { it.knownState != null }
            if (conditional != null) {
                sendSessionSync(pairedDevice, newSessionSyncCommandId(), conditional)
                continue
            }
            if (initial.conversations[runtime.runtimeId]?.hasLiveSnapshot != true ||
                initial.runtimeSessionViews[runtime.runtimeId]?.leafId != runtime.sessionLeafId) {
                var acceptance = SessionReadAcceptance()
                updateState { it.beginSessionRead(runtime.runtimeId, SessionReadKind.FIRST_PAGE,
                    UUID.randomUUID().toString()).also { start -> acceptance = start.acceptance }.state }
                val operationId = acceptance.operationId
                if (operationId != null && !acceptance.merged) launchFirstSessionPage(pairedDevice, runtime, operationId)
            }
            // Display completion and source confirmation are independent facts. A local failure
            // neither consumes recovery demand nor prevents an independently owned source check.
            relayStateLock.withLock {
                val current = mutableState.value
                if (device != pairedDevice || generation != connectionGeneration ||
                    current.selectedRuntimeId != runtime.runtimeId || current.runtimes[runtime.runtimeId]?.sessionId != sessionId ||
                    current.syncPreviewBlocked(runtime.runtimeId, runtime.sessionLeafId)) return@withLock
                if (current.sessionSyncCommands.values.any { it.runtimeId == runtime.runtimeId }) return@withLock
                val recovery = current.requestedSessionRecovery(runtime.runtimeId, generation, UUID.randomUUID().toString())
                if (recovery != null) sendSessionSync(pairedDevice, newSessionSyncCommandId(), recovery)
                else if (current.conversations[runtime.runtimeId]?.hasLiveSnapshot == true)
                    startBranchCatchUp(pairedDevice, current.runtimes[runtime.runtimeId] ?: runtime)
            }
        }
    }
    /**
     * 处理上传的入站消息。
     *
     * `requestId` 就是发起时的 `taskId`，所以 `ready`/`failed` 能直接定位任务；
     * `progress`/`finished` 用 `uploadId` 反查。
     */
    /**
     * Host 迟迟不来拉（read）的上传：重新 advertise 一次。
     *
     * 接收方驱动（ADR-0012）之后手机没有上传调度器——数据是 Host 来拉的。任务挂在
     * uploading 却 10 秒没有任何 read，只可能是 Host 的内存里已经没有这个句柄
     * （重启 / 空闲回收）。init 是幂等的续传入口：Host 命中同一份 `.part`，回 ready
     * 带上续传偏移，传输原地接上。限频由 uploadLastAdvertiseAt 把关。
     */
    private fun reAdvertiseStalledUploads() {
        val now = System.currentTimeMillis()
        val tasks = mutableState.value.uploads.values
            .filter { it.status == "uploading" && it.uploadId != null }
        for (task in tasks) {
            val uploadId = task.uploadId ?: continue
            val lastRead = uploadLastReadAt[uploadId] ?: 0L
            val lastAdvertised = uploadLastAdvertiseAt[task.taskId] ?: 0L
            if (now - maxOf(lastRead, lastAdvertised) < UPLOAD_READ_IDLE_MS) continue
            Log.i(RELOAD_TRACE_TAG, "upload.re_advertise taskId=${task.taskId} name=${task.displayName} durable=${task.durableBytes}")
            uploadLastAdvertiseAt[task.taskId] = now
            relay.initUpload(
                requestId = task.taskId,
                runtimeId = task.runtimeId,
                directory = task.directory,
                fileName = task.displayName,
                size = task.size,
                sha256 = task.sha256,
                mimeType = task.mimeType,
            )
        }
    }

    private fun processUploadPayload(payload: String) {
        val message = messageJson.parseToJsonElement(payload).jsonObject
        val messageType = message["type"]?.jsonPrimitive?.contentOrNull ?: return
        if (!messageType.startsWith("file.upload.")) return
        val uploadId = message["uploadId"]?.jsonPrimitive?.contentOrNull
        val taskId = message["requestId"]?.jsonPrimitive?.contentOrNull
        val task = mutableState.value.uploads.values.firstOrNull { candidate ->
            (uploadId != null && candidate.uploadId == uploadId) || (taskId != null && candidate.taskId == taskId)
        } ?: run {
            // 用户可能在 init 与 ready 之间删除任务；拿到迟到的身份后仍要通知 Host 取消。
            if (messageType == "file.upload.ready" && uploadId != null) relay.cancelUpload(uploadId)
            return
        }
        when (messageType) {
            // 接收方驱动（ADR-0012）：Host 按它的持久前缀要一块，手机读源文件应答。
            // 读失败就不回话——Host 的拉取循环超时后会重发同一个 read，天然自愈。
            "file.upload.read" -> {
                val assigned = uploadId ?: return
                val offset = message["offset"]?.jsonPrimitive?.longOrNull ?: return
                val length = message["length"]?.jsonPrimitive?.intOrNull ?: return
                if (length <= 0) return
                uploadLastReadAt[assigned] = System.currentTimeMillis()
                scope.launch(Dispatchers.IO) {
                    val data = runCatching { artifactUploadStore.read(task.taskId, offset, length) }
                        .getOrElse { error ->
                            Log.e(RELOAD_TRACE_TAG, "upload.read_failed taskId=${task.taskId} offset=$offset: ${error.message}")
                            return@launch
                        }
                    Log.i(RELOAD_TRACE_TAG, "upload.read_served uploadId=$assigned offset=$offset bytes=${data.size}")
                    relay.sendUploadChunk(task.runtimeId, assigned, offset, data)
                }
            }
            "file.upload.ready" -> {
                val assigned = uploadId ?: return
                val received = message["receivedBytes"]?.jsonPrimitive?.longOrNull ?: 0
                artifactUploadStore.bindUpload(task.taskId, assigned, received)
                // ready 之后 Host 的第一个 read 应该在 200ms 内到达：从这里起算空闲时钟。
                uploadLastReadAt[assigned] = System.currentTimeMillis()
                publishUpload(task.taskId) { it.copy(uploadId = assigned, status = "uploading", durableBytes = received, sentBytes = received, error = null) }
            }
            "file.upload.progress" -> {
                val received = message["receivedBytes"]?.jsonPrimitive?.longOrNull ?: return
                // 只动内存里的权威进度；落盘留给状态转换，避免每片写一次 JSON。
                artifactUploadStore.noteProgress(task.taskId, received)
                publishUpload(task.taskId) { it.copy(durableBytes = maxOf(it.durableBytes, received)) }
            }
            "file.upload.finished" -> {
                val path = message["path"]?.jsonPrimitive?.contentOrNull ?: return
                artifactUploadStore.complete(task.taskId, path)
                synchronized(uploadLock) {
                    uploadId?.let { uploadLastReadAt.remove(it) }
                }
                uploadLastAdvertiseAt.remove(task.taskId)
                publishUpload(task.taskId) { it.copy(status = "completed", remotePath = path, durableBytes = it.size, sentBytes = it.size, error = null) }
            }
            "file.upload.failed" -> {
                val code = message["code"]?.jsonPrimitive?.contentOrNull
                // 完成是终态：迟到的失败不能把一次成功的上传翻转成失败。
                if (task.status == "completed") return
                // Host 不认识这个 uploadId（Host 重启 / 同文件新 init 顶掉 / 空闲回收）。
                // 任务自带重新发起的全部材料（目录/文件名/大小/sha256），重新 advertise 一次：
                // Host 命中同一份 `.part` 回 ready 带续传偏移，传输原地接上。
                if (code == "unknown_transfer") {
                    Log.i(RELOAD_TRACE_TAG, "upload.unknown_transfer re-advertise taskId=${task.taskId} name=${task.displayName}")
                    uploadLastAdvertiseAt[task.taskId] = System.currentTimeMillis()
                    relay.initUpload(
                        requestId = task.taskId,
                        runtimeId = task.runtimeId,
                        directory = task.directory,
                        fileName = task.displayName,
                        size = task.size,
                        sha256 = task.sha256,
                        mimeType = task.mimeType,
                    )
                    return
                }
                val text = message["message"]?.jsonPrimitive?.contentOrNull ?: "发送失败"
                artifactUploadStore.fail(task.taskId, text)
                synchronized(uploadLock) {
                    uploadId?.let { uploadLastReadAt.remove(it) }
                }
                publishUpload(task.taskId) { it.copy(status = "failed", error = text) }
            }
        }
    }

    private fun publishUpload(taskId: String, transform: (UploadTask) -> UploadTask) {
        updateState { current ->
            val task = current.uploads[taskId] ?: return@updateState current
            current.copy(uploads = current.uploads + (taskId to transform(task)))
        }
    }

    private fun processArtifactPayload(payload: String) {
        val message = messageJson.parseToJsonElement(payload).jsonObject
        val messageType = message["type"]?.jsonPrimitive?.contentOrNull
        if (messageType != "runtime.event") return
        val runtimeId = message["runtimeId"]?.jsonPrimitive?.contentOrNull ?: error("运行实例 ID 无效")
        val event = message["event"]?.jsonObject ?: return
        when (event["type"]?.jsonPrimitive?.contentOrNull) {
            "artifact.started" -> {
                val commandId = event["commandId"]?.jsonPrimitive?.contentOrNull ?: error("下载命令 ID 无效")
                val transferId = event["transferId"]?.jsonPrimitive?.contentOrNull ?: error("下载传输标识无效")
                val artifact = event["artifact"]?.let {
                    messageJson.decodeFromJsonElement<RemoteArtifact>(it)
                } ?: error("下载项元数据无效")
                val currentState = mutableState.value
                val currentTask = currentState.downloads.values.firstOrNull {
                    it.runtimeId == runtimeId &&
                        (it.sourceArtifactId == artifact.artifactId ||
                            it.sourcePath != null && it.sourcePath == artifact.path)
                }
                val isPendingDownload = commandId in currentState.pendingDownloads
                if (!isPendingDownload && currentTask?.status in setOf("failed", "cancelled")) return
                if (!isPendingDownload && currentTask?.transferId != null && currentTask.transferId != transferId) return
                if (!isPendingDownload && currentTask?.commandId != null && currentTask.commandId != commandId) return
                artifactDownloadStore.start(
                    runtimeId,
                    commandId,
                    transferId,
                    event["offset"]?.jsonPrimitive?.longOrNull
                        ?: mutableState.value.pendingDownloads[commandId]?.offset
                        ?: 0,
                    artifact,
                    hostId = hostId,
                )
            }
            "artifact.failed" -> {
                val artifactId = event["artifactId"]?.jsonPrimitive?.contentOrNull
                event["transferId"]?.jsonPrimitive?.contentOrNull?.let { transferId ->
                    if (artifactId != null) {
                        artifactDownloadStore.fail(runtimeId, transferId, artifactId, event["error"]?.jsonPrimitive?.contentOrNull)
                    }
                }
            }
        }
    }

    private fun processArtifactChunk(payload: ByteArray) {
        val frame = decodeArtifactChunkFrame(payload)
        val state = mutableState.value
        val task = state.downloads.values.firstOrNull {
            // The frame runtimeId is the Host serving the download. The task runtimeId is
            // the source session that produced the file, so transferId is the shared identity.
            it.transferId == frame.transferId
        } ?: return
        // 不再要求 status 恰好是 "downloading"：传输的身份由 (runtimeId, transferId) 唯一确定，
        // 而 store 里那条流才是「这次传输是否还活着」的权威。以前这里一旦状态被别的路径短暂改成
        // paused，所有分片就被静默丢弃、一个 ack 都不发，发送方只能等到 ack 超时。
        // 终态（完成/失败/取消）由 store 自己拒绝，不会写坏数据。
        if (task.status !in setOf("downloading", "paused", "queued")) return
        val result = artifactDownloadStore.append(frame.runtimeId, frame.transferId, frame.offset, frame.data)
        if (!result.recognized || result.runtimeId == null) return
        updateState { reducer.reduceArtifactChunk(it, result.runtimeId, frame.transferId,
            frame.offset, frame.data.size, result.receivedOffset) }
        if (!pullDownloads.onChunk(frame.transferId, frame.offset, frame.data.size, result.receivedOffset)) {
            Log.i(RELOAD_TRACE_TAG, "in chunk.dropped transferId=${frame.transferId} reason=no_scheduler")
        }
    }

    /**
     * 把「哪些下载该由 PullScheduler 驱动」与当前状态对齐：新建缺失的、去掉已结束的。
     *
     * 下载只有一种模式（ADR-0005 的范围下载），所以每个活跃任务都归调度器管。
     */
    private fun syncPullSchedulers() {
        val state = mutableState.value
        // 交互流量优先：会话同步在途、或用户消息/turn 在跑时，把下载在途压到 1 个 chunk，
        // 别让分片堆在控制帧前面。下载自己的命令要排除：它的完成信号是 `artifact.*` 而不是
        // `command.result`，拿它当交互判据会把整个下载永久压成 1 MiB。
        val downloadCommandIds = state.downloads.values.mapNotNullTo(mutableSetOf(), ArtifactDownload::commandId)
        val interactive = state.sessionSyncCommands.isNotEmpty() ||
            state.sessionSyncRequests.isNotEmpty() ||
            state.pendingCommands.keys.any { it !in downloadCommandIds } ||
            state.runtimes.values.any { it.status == "running" }
        // E2E 没就绪（断线/重握手）时不发 read：否则断线期间的请求全变成对面收不到的噪音。
        val connected = state.e2eReady && state.connection == RelayConnection.ONLINE
        pullDownloads.sync(state.downloads.values, interactive, connected)
    }


    /**
     * 开始一次上传：算完 sha256、建任务、让 Host 受理。
     *
     * 哈希必须在发起前算完——Host 要拿它当最终校验值，而 `file.upload.init` 就得把哈希报过去。
     */
    /**
     * 把选择器里的一份文件排进上传队列。
     *
     * [onQueued] 在任务登记完成后（主线程）回调 taskId：composer 要立刻把这个任务挂到
     * 附件 chip 上，否则用户看不到「正在上传」这件事。
     */
    fun queueUpload(uri: Uri, runtimeId: String, onQueued: (String) -> Unit = {}) {
        val runtime = mutableState.value.runtimes[runtimeId]
        if (runtime == null) {
            updateState { it.copy(error = "运行实例已离线，无法发送文件") }
            return
        }
        scope.launch {
            val inspected = withContext(Dispatchers.IO) {
                runCatching { ArtifactUploadStore.inspect(application.contentResolver, uri) }
            }.getOrElse { error ->
                updateState { it.copy(error = "无法读取所选文件：${error.message ?: "未知错误"}") }
                return@launch
            }
            if (inspected.size > MAX_UPLOAD_BYTES) {
                updateState { it.copy(error = "文件超过 ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB 上限") }
                return@launch
            }
            if (inspected.size == 0L) {
                updateState { it.copy(error = "所选文件是空的") }
                return@launch
            }
            val task = UploadTask(
                taskId = UUID.randomUUID().toString(),
                runtimeId = runtimeId,
                hostId = hostId,
                sourceUri = uri.toString(),
                displayName = inspected.displayName,
                size = inspected.size,
                sha256 = inspected.sha256,
                // 落盘目录带 sha256 段：发送端不知道电脑上已有什么文件，同名文件若都落进
                // 同一个目录，先到的会被后到的覆盖/续传逻辑纠缠，路径引用就歧义了。
                // 内容相同 = sha256 相同 = 同一目录，恰好与续传语义一致。
                directory = uploadDirectoryFor(runtime.cwd, inspected.sha256),
                mimeType = inspected.mimeType,
            )
            artifactUploadStore.register(task)
            updateState { it.copy(uploads = it.uploads + (task.taskId to task), error = null) }
            onQueued(task.taskId)
            relay.initUpload(
                requestId = task.taskId,
                runtimeId = runtimeId,
                directory = task.directory,
                fileName = task.displayName,
                size = task.size,
                sha256 = task.sha256,
                mimeType = task.mimeType,
            )
        }
    }

    /** 用户删除一条上传记录（不影响已完成的电脑端文件）。 */
    fun removeUploads(taskIds: Set<String>) {
        if (taskIds.isEmpty()) return
        val cancelled = artifactUploadStore.delete(taskIds)
        synchronized(uploadLock) {
            mutableState.value.uploads.values.filter { it.taskId in taskIds }.forEach { task ->
                task.uploadId?.let(uploadLastReadAt::remove)
                uploadLastAdvertiseAt.remove(task.taskId)
            }
        }
        updateState { it.copy(uploads = it.uploads - taskIds) }
        cancelled.forEach(relay::cancelUpload)
    }

    private fun tickPullSchedulers() = syncPullSchedulers()

    /** 设备侧判定完成：同步存储层的成功/失败状态，只有校验发布成功才告诉 Host 收摊。 */
    private fun completePull(transferId: String) {
        val state = mutableState.value
        val task = state.downloads.values.firstOrNull {
            it.transferId == transferId && it.status in setOf("queued", "downloading", "paused")
        } ?: return
        val artifactId = task.artifact?.artifactId ?: return
        val runtimeId = task.transferRuntimeId ?: state.hostId ?: return
        val result = runCatching { artifactDownloadStore.finish(runtimeId, transferId, artifactId) }
        val persisted = artifactDownloadStore.load().firstOrNull { it.taskId == task.taskId }
        updateState { current ->
            val latest = current.downloads[task.taskId] ?: return@updateState current
            if (latest.transferId != transferId || latest.status !in setOf("queued", "downloading", "paused")) {
                return@updateState current
            }
            current.copy(
                downloads = if (persisted == null) current.downloads else current.downloads + (task.taskId to persisted),
                error = result.exceptionOrNull()?.let { "文件下载失败：${it.message ?: "无法保存文件"}" } ?: current.error,
            )
        }
        if (result.getOrNull() != null) relay.doneArtifact(transferId)
    }

    private fun sessionHistoryKey(runtimeId: String): String = runtimeId

    private fun offlineHistoryKey(sessionId: String): String = "offline:$sessionId"

    /** 普通连接的 E2E 选项：用已配对 Host 的 pskRoot 发起握手。没有就降级（连接后收不到问候）。 */
    private fun defaultE2eOptions(credential: DeviceCredential): E2eConnectOptions? {
        val pskRoot = runCatching {
            Crypto.fromBase64UrlFixed(pairing.pskRoot, Crypto.SYMMETRIC_KEY_BYTES, "pskRoot")
        }.getOrNull() ?: return null
        return E2eConnectOptions(
            hostId = pairing.hostId,
            deviceId = credential.deviceId,
            deviceKeyPair = deviceKeyPair(),
            pskRoot = pskRoot,
            lanEndpoints = pairing.lanEndpoints,
        )
    }

    private fun localizedError(error: Throwable, fallback: String): String {
        val message = error.message
        return if (message?.any { it in '\u4e00'..'\u9fff' } == true) message else fallback
    }

    private fun scheduleReconnect() {
        if (pairingAwaitingAccept) return
        if (reconnectJob?.isActive == true) return
        val credential = device ?: return
        reconnectJob = scope.launch {
            delay(reconnectDelayMs)
            reconnectDelayMs = (reconnectDelayMs * 2).coerceAtMost(30_000)
            connect(credential)
        }
    }

    private fun autoResumeDownloads() {
        if (mutableState.value.connection != RelayConnection.ONLINE) return
        val hostId = mutableState.value.hostId ?: return
        val resumable = mutableState.value.downloads.values.filter { task ->
            task.status in setOf("paused", "queued", "downloading") &&
                task.commandId == null &&
                (task.sourcePath != null || task.sourceArtifactId != null)
        }
        for (task in resumable) {
            Log.i(RELOAD_TRACE_TAG, "download.auto_resume taskId=${task.taskId} received=${task.receivedBytes}")
            retryDownload(task.taskId)
        }
    }
}
