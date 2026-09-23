package dev.pi.remote

import android.app.Application
import android.net.Uri
import android.os.Build
import android.util.Log
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
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

/**
 * 握手看门狗写的告警（见 [RemoteViewModel.connect] 里那个 8s 看门狗）。
 *
 * 抽成常量是为了**能在握手成功时把它撤掉**：`error` 是一条会弹出模态框的通道，而这条文案
 * 描述的处境（没有加密通道）可能下一秒就不成立了。撤不掉的话，用户会一直盯着一个已经过期的
 * 错误，唯一的出路是手动点「确定」。
 */
internal const val HANDSHAKE_STALLED_ERROR =
    "已连上中继，但电脑没有回应端到端加密握手：这台手机在电脑上的配对多半已经失效。" +
        "请点右上角「取消配对」，再扫电脑上的新二维码重新配对"

/** pull 下载调度器的 tick 间隔：既要及时补超时的洞，又不要空转太频繁。 */
internal const val PULL_TICK_MS = 200L

/**
 * 上传任务处于 uploading 却迟迟等不到 Host 的 read 时，重新 advertise（重发 init）的阈值。
 *
 * Host 是拉取方：只要它认得这个 uploadId，read 每 200ms 就该来一个。10s 没有动静，
 * 只可能是 Host 重启/空闲回收把句柄收走了——用任务自带的内容身份重新 advertise 一次，
 * Host 命中同一份 `.part` 回 ready 带续传偏移，传输原地接上。
 */
internal const val UPLOAD_READ_IDLE_MS = 10_000L

/**
 * 状态页只读的配对现场（spec §5）。这些值来自凭据与 E2E 身份库，只在配对/解配时变化，
 * 按需读取即可，不进入 RemoteState 的实时事件流。pskRoot 只暴露「存在与否」，不显示内容。
 */
data class PairingStatus(
    val relayUrl: String?,
    val deviceId: String?,
    val hostId: String?,
    val hostPublicKeyFingerprint: String?,
    val pskRootPresent: Boolean,
)

class RemoteViewModel(application: Application) : AndroidViewModel(application) {
    private val credentials = CredentialStore(application)
    private val e2eIdentityStore = E2eIdentityStore(application)
    /**
     * P2P 需要在设备侧构造 WebRTC 的 PeerConnectionFactory，而这要一个 Context。
     *
     * 漏掉这一行不会抛任何异常：`startP2pIfPossible` 的第一件事是 `appContext ?: return`，
     * 于是它每次都静默退出，`p2p.request` 永远发不出去，状态页永远显示中继——
     * 而且 Logcat 里连一行痕迹都没有。所以这里必须注入，不是可选项。
     */
    private val relay = RelayClient().apply { setApplicationContext(application) }
    private val reducer = RelayReducer()
    private val notifier = InteractionNotifier(application)
    private val sessionCatalogStore = SessionCatalogStore(application)
    private val sessionGraphStore = SessionGraphStore(application)
    private val sessionAliasStore = SessionAliasStore(application)
    private val draftStore = DraftStore(application)
    private val artifactDownloadStore = ArtifactDownloadStore(application)
    private val artifactUploadStore = ArtifactUploadStore(application)
    private val lastSessionStore = LastSessionStore(application)
    private val pathPreferenceStore = PathPreferenceStore(application)
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
            downloads = artifactDownloadStore.load().associateBy(ArtifactDownload::taskId),
            uploads = artifactUploadStore.load().associateBy(UploadTask::taskId),
        ),
    )
    val state: StateFlow<RemoteState> = mutableState.asStateFlow()

    private var device: DeviceCredential? = credentials.load()
    private var reconnectJob: Job? = null
    private var reconnectDelayMs = 500L
    private var shouldConnect = true

    /**
     * 已发出 pair 帧、正在等 Host 的 pair-accept。这期间必须独占连接：
     * `connect()` 的第一步就是 `disconnect()`，残留的自动重连（退避可能已涨到几秒）一响就会
     * 把刚建立的配对连接掐掉——配对永远收不到确认，而凭据如果已落盘，APP 就会停在
     * 「已连接但没有加密材料」的半配对状态，用户还回不到配对页。
     */
    @Volatile
    private var pairingAwaitingAccept = false
    private var generation = 0
    private val catalogWriteLock = Mutex()
    /** Serializes state publication and the bounded Session snapshot transaction. */
    private val relayStateLock = Mutex()
    private val sessionSyncLoadLock = Mutex()
    private val pendingSessionLoadRuntimes = linkedMapOf<String, RuntimeSummary>()
    private var sessionLoadWorker: Job? = null
    private val historyPageSize = 100
    private val previewPageSize = 100

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

    private val historyJobs = mutableMapOf<String, Job>()
    /** Serializes all text events from one WebSocket connection in arrival order. */
    private var relayEventJob: Job? = null

    init {
        device?.let { pairedDevice ->
            mutableState.value = mutableState.value.copy(
                deviceId = pairedDevice.deviceId,
                hostId = e2eIdentityStore.loadPairedHost()?.hostId,
                sessions = sessionCatalogStore.load(pairedDevice).associateBy(SessionCatalogEntry::sessionId),
                sessionAliases = sessionAliasStore.load(pairedDevice),
            )
            connect(pairedDevice)
        }
        // 掉线重连 / APP 重启后回到上次打开的会话（spec 第 16 行、§14 B7）。
        // 放在状态流上而不是消息处理里：恢复要在「Runtime 目录已就绪」之后才可能成功，
        // 而目录可能来自中继的第一份 device.ready（此时还没有 Pi runtime）之后才补齐。
        viewModelScope.launch {
            mutableState.collect { current ->
                if (!restoreSettled &&
                    current.connection == RelayConnection.ONLINE &&
                    current.runtimes.isNotEmpty()
                ) {
                    maybeRestoreLastSession(current)
                }
            }
        }
        // 接收方驱动的下载调度（ADR-0005）：周期性 tick 负责超时重传与补窗。
        viewModelScope.launch {
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
        viewModelScope.launch(Dispatchers.IO) {
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

    /**
     * 扫码配对（v2 二维码，spec §4）：HTTP 换凭据 → 连上 Relay 发 PAIR_REQUEST →
     * 验证 `mac_h` 后保存 pskRoot 并断开。之后由普通重连发起 HS1 与常驻 Host 建立加密会话
     * （配对进程是短命的，不承载业务）。
     */
    fun pair(relayUrl: String, code: String, qrRaw: String? = null) {
        viewModelScope.launch {
            // 配对要独占连接：先把残留的自动重连停掉，否则它的退避定时器一响就会掐掉配对连接。
            reconnectJob?.cancel()
            reconnectJob = null
            relayEventJob?.cancel()
            relayEventJob = null
            relay.disconnect()
            pairingAwaitingAccept = false
            handshakeStalled = false
            mutableState.value = mutableState.value.copy(connection = RelayConnection.CONNECTING, error = null)
            val qr = qrRaw?.let { parsePairingQrV2(it) }
            if (qr == null) {
                mutableState.value = mutableState.value.copy(
                    connection = RelayConnection.OFFLINE,
                    error = "二维码缺少端到端加密材料或格式无效：请在电脑上重新执行 pi-remote pair，扫描新二维码",
                )
                return@launch
            }
            if (qr.exp * 1000 < System.currentTimeMillis()) {
                mutableState.value = mutableState.value.copy(
                    connection = RelayConnection.OFFLINE,
                    error = "配对二维码已过期，请在电脑上重新生成（配对窗口只有几分钟）",
                )
                return@launch
            }
            runCatching { relay.pair(relayUrl.trim(), code, Build.MODEL) }
                .onSuccess { paired ->
                    // 这里**不落盘、不进主界面**：要等 Host 的 pair-accept 回来（mac_h 校验通过）
                    // 才算配对成功。提前落盘会让失败后 APP 停在「已连接但无加密材料」的状态。
                    shouldConnect = true
                    reconnectDelayMs = 500L
                    pairingAwaitingAccept = true
                    startPairingConnect(paired, qr)
                }
                .onFailure { error ->
                    mutableState.value = mutableState.value.copy(
                        connection = RelayConnection.OFFLINE,
                        error = localizedError(error, "配对失败，请检查中继服务器地址、配对码和网络连接"),
                    )
                }
        }
    }

    /** 配对模式连接：发 PAIR_REQUEST，验证通过后保存 pskRoot 并主动断开（触发普通重连）。 */
    private fun startPairingConnect(paired: DeviceCredential, qr: PairingQrV2) {
        val keyPair = e2eIdentityStore.loadOrCreateDeviceKeyPair()
        val session = runCatching {
            DevicePairingSession.create(
                hostPublicRaw = Crypto.fromBase64UrlFixed(qr.hostPub, Crypto.X25519_KEY_BYTES, "hostPub"),
                psk = Crypto.fromBase64UrlFixed(qr.psk, Crypto.SYMMETRIC_KEY_BYTES, "psk"),
                deviceId = paired.deviceId,
                deviceKeyPair = keyPair,
            )
        }.getOrElse { error ->
            // 材料没解析出来就没连过网：把独占标志和自动重连一并复位，别卡死在配对态。
            pairingAwaitingAccept = false
            shouldConnect = false
            mutableState.value = mutableState.value.copy(
                connection = RelayConnection.OFFLINE,
                error = localizedError(error, "配对材料无效，请重新扫码"),
            )
            return
        }
        connect(
            paired,
            E2eConnectOptions(
                hostId = qr.hostId,
                deviceId = paired.deviceId,
                deviceKeyPair = keyPair,
                pairingSession = session,
                onPairAccepted = {
                    // 走到这里 = 对手确实持有 qr.hostPub 对应的私钥。此时才落盘、才进主界面。
                    pairingAwaitingAccept = false
                    e2eIdentityStore.savePairedHost(
                        HostIdentity(hostId = qr.hostId, hostPub = qr.hostPub, pskRoot = Crypto.toBase64Url(session.pskRoot), lanEndpoints = qr.lan),
                    )
                    credentials.save(paired)
                    device = paired
                    shouldConnect = true
                    reconnectDelayMs = 500L
                    mutableState.value = mutableState.value.copy(
                        deviceId = paired.deviceId,
                        sessions = sessionCatalogStore.load(paired).associateBy(SessionCatalogEntry::sessionId),
                        sessionAliases = sessionAliasStore.load(paired),
                    )
                    // 主动断开配对会话，紧接着由普通重连发起 HS1，与常驻 Host 建立加密会话。
                    // 这里**不能**指望「断开 → onClosed → 自动重连」那条链：这次 close 是主动发起的，
                    // 它的回调会被 RelayClient 的陈旧 socket 守卫忽略（那正是防止旧 socket 掐掉新会话的那道闸）。
                    viewModelScope.launch {
                        relay.disconnect()
                        scheduleReconnect()
                    }
                },
            ),
            pairing = true,
        )
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
        viewModelScope.launch {
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
        viewModelScope.launch {
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
        mutableState.value = mutableState.value.copy(sessionBrowse = null)
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
        })
    }

    /** L2：在指定目录新建会话（agentKind = pi | codex）。 */
    fun createSession(agentKind: String, cwd: String) {
        activateTarget(buildJsonObject {
            put("type", "new")
            put("agentKind", agentKind)
            put("cwd", cwd)
        })
    }

    private fun activateTarget(target: JsonObject) {
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
            register = { it.copy(sessionActivateRequests = it.sessionActivateRequests + requestId) },
            rollback = { it.copy(sessionActivateRequests = it.sessionActivateRequests - requestId) },
        )
    }

    fun clearActivationNotice() {
        mutableState.value = mutableState.value.copy(sessionActivation = null)
    }

    private fun sendSessionPayload(
        requestId: String,
        payload: JsonObject,
        register: (RemoteState) -> RemoteState,
        rollback: (RemoteState) -> RemoteState,
    ) {
        if (mutableState.value.connection != RelayConnection.ONLINE) {
            mutableState.value = mutableState.value.copy(error = "尚未连接到电脑，连接建立后才能操作会话")
            return
        }
        // 先登记再发送：响应走独立协程回来，登记必须先于 reducer 可能看到响应。
        mutableState.value = register(mutableState.value)
        if (!relay.sendDeviceMessage(payload)) {
            mutableState.value = rollback(mutableState.value)
                .copy(error = "当前连接没有端到端加密通道，会话操作未发送")
        }
    }

    fun unpair() {
        val pairedDevice = device
        shouldConnect = false
        pairingAwaitingAccept = false
        handshakeStalled = false
        generation += 1
        reconnectJob?.cancel()
        relayEventJob?.cancel()
        relayEventJob = null
        relay.disconnect()
        artifactDownloadStore.clear()
        lastSessionStore.clear()
        restoreSettled = true
        pairedDevice?.let(draftStore::clear)
        credentials.clear()
        e2eIdentityStore.clear()
        pairedDevice?.let(sessionAliasStore::clear)
        device = null
        mutableState.value = RemoteState()
        if (pairedDevice != null) {
            viewModelScope.launch {
                runCatching { withContext(Dispatchers.IO) { sessionCatalogStore.clear() } }
                runCatching { withContext(Dispatchers.IO) { sessionGraphStore.clear() } }
                runCatching { relay.revoke(pairedDevice) }
            }
        }
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
        val saved = lastSessionStore.load() ?: run {
            restoreSettled = true
            return
        }
        if (current.deviceId != null && current.deviceId != saved.deviceId) {
            // 记录属于另一台电脑（理论上 unpair 已清过），直接作废。
            lastSessionStore.clear()
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
        val current = mutableState.value
        val runtime = runtimeId?.let(current.runtimes::get)
        val conversation = runtimeId?.let(current.conversations::get)
        val graph = runtime?.sessionId?.let(current.sessionGraphs::get)
        // The loader verifies this runtime's current leaf against SQLite before seeding a page.
        val needsSessionRefresh = runtime?.sessionGraphSync == true &&
            (conversation?.hasLiveSnapshot != true || conversation.messages.isEmpty() ||
                graph?.hasCompleteCursor(runtime.sessionLeafId) != true)
        val selectedState = current.cancelForegroundSessionSyncs(runtimeId).copy(
            selectedRuntimeId = runtimeId,
            selectedOfflineSessionId = null,
            sessionSyncRequests = if (needsSessionRefresh) {
                current.sessionSyncRequests + runtimeId
            } else {
                current.sessionSyncRequests
            },
        )
        mutableState.value = selectedState
        // 用户（或被恢复流程）已经选定了去处，恢复逻辑不再介入；同时记下这一处，
        // 供掉线重连/APP 重启后自动回到这里（spec 第 16 行、§14 B7）。
        restoreSettled = true
        val pairedDevice = device
        if (pairedDevice != null) {
            if (runtimeId == null) {
                // 主动退回列表：不要把用户再拽回会话里。
                lastSessionStore.clear()
            } else {
                lastSessionStore.save(pairedDevice.deviceId, runtimeId, runtime?.sessionId)
            }
        }
        runtime?.takeIf(RuntimeSummary::sessionGraphSync)?.let { selected ->
            val targetChainComplete = graph?.hasCompleteCursor(selected.sessionLeafId) == true
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

    /** Opens only an already-cached Session graph as a read-only history view. */
    fun selectOfflineSession(sessionId: String?) {
        val current = mutableState.value
        // 用户（或恢复流程）已经选定了去处，别再被「恢复上次会话」拽走。
        restoreSettled = true
        if (sessionId == null) {
            mutableState.value = current.copy(selectedOfflineSessionId = null)
            return
        }
        if (current.runtimes.values.any { it.sessionId == sessionId }) {
            mutableState.value = current.copy(error = "该 Session 当前由在线 Runtime 打开，请从 Runtime 列表进入")
            return
        }
        if (current.sessions[sessionId]?.hasHistoryCache != true) {
            mutableState.value = current.copy(error = "该 Session 没有可用的本地历史缓存")
            return
        }
        mutableState.value = current.cancelForegroundSessionSyncs(null).copy(
            selectedRuntimeId = null,
            selectedOfflineSessionId = sessionId,
        )
        val pairedDevice = device ?: return
        viewModelScope.launch(Dispatchers.IO) {
            loadCachedSessionGraph(pairedDevice, sessionId, null)
        }
    }

    fun loadOlderHistory(runtimeId: String? = mutableState.value.selectedRuntimeId) {
        val id = runtimeId ?: return
        val current = mutableState.value
        if (id in current.sessionSyncFailures || current.conversations[id]?.chatSyncError != null) return
        val runtime = current.runtimes[id]
        val offlineSessionId = id.removePrefix("offline:").takeIf { id.startsWith("offline:") }
        val sessionId = runtime?.sessionId ?: offlineSessionId ?: return
        val view = current.runtimeSessionViews[id]
            ?.takeIf { it.sessionId == sessionId }
            ?: RuntimeSessionView(id, sessionId, runtime?.sessionLeafId ?: current.sessionGraphs[sessionId]?.cursor?.leafId)
        val history = current.sessionHistory[id]
            ?: historyState(sessionId, view.leafId, current.sessionGraphs[sessionId])
        val beforeEntryId = history.oldestEntryId ?: return
        if (!history.hasOlder || history.loading || historyJobs[id]?.isActive == true) return
        mutableState.value = current.copy(
            sessionHistory = current.sessionHistory + (id to history.copy(loading = true)),
        )
        val pairedDevice = device
        if (pairedDevice == null) {
            mutableState.value = mutableState.value.copy(
                sessionHistory = mutableState.value.sessionHistory + (id to history.copy(loading = false)),
            )
            return
        }
        val requestGeneration = generation
        val branchGeneration = current.sessionBranchGenerations[id] ?: 0
        val job = viewModelScope.launch(Dispatchers.IO) {
            relayStateLock.withLock {
                if (requestGeneration != generation || branchGeneration != (mutableState.value.sessionBranchGenerations[id] ?: 0)) return@launch
                val local = runCatching {
                    sessionGraphStore.readBranch(
                        device = pairedDevice,
                        sessionId = sessionId,
                        leafId = view.leafId,
                        beforeEntryId = beforeEntryId,
                        maxEntries = historyPageSize,
                    )
                }.getOrNull()
                if (device != pairedDevice || !shouldConnect ||
                    !isHistoryRequestCurrent(id, sessionId, view.leafId, beforeEntryId)
                ) return@launch
                if (local != null && local.status in setOf(
                        SessionGraphRangeStatus.COMPLETE,
                        SessionGraphRangeStatus.OLDER_AVAILABLE,
                        SessionGraphRangeStatus.MISSING_PARENT,
                    ) && local.entries.isNotEmpty()
                ) {
                    val latest = mutableState.value
                    val graph = latest.sessionGraphs[sessionId] ?: SessionGraph(sessionId)
                    val mergedEntries = LinkedHashMap<String, SessionGraphEntry>()
                    graph.entries.forEach { (entryId, entry) -> mergedEntries[entryId] = entry }
                    local.entries.forEach { entry -> mergedEntries.putIfAbsent(entry.entryId, entry) }
                    // Paging changes the visible range without moving the observed leaf.
                    val mergedGraph = graph.copy(entries = mergedEntries)
                    val conversation = latest.conversations[id]
                    val projection = if (mergedGraph.hasCompleteEntryChain(view.leafId)) {
                        projectSessionGraph(
                            mergedGraph.copy(cursor = SessionBranchCursor(view.leafId)),
                            messageJson,
                        )
                    } else {
                        // Project a cached fragment while retaining the rest of the current display.
                        SessionProjectionResult(projectSessionEntries(local.entries, messageJson))
                    }
                    val nextConversations = if (conversation == null) {
                        latest.conversations
                    } else {
                        val olderIds = projection.messages.map(ChatMessage::messageId).toSet()
                        latest.conversations + (
                            id to conversation.copy(
                                messages = projection.messages + conversation.messages.filterNot {
                                    it.messageId in olderIds
                                },
                                turnTimings = if (projection.turnTimings.isEmpty()) {
                                    conversation.turnTimings
                                } else {
                                    projection.turnTimings.associateBy(TurnTiming::turnId)
                                },
                                revision = conversation.revision + 1,
                            )
                        )
                    }
                    val next = latest.copy(
                        sessionGraphs = latest.sessionGraphs + (sessionId to mergedGraph),
                        conversations = nextConversations,
                        sessionHistory = latest.sessionHistory + (
                            id to history.copy(
                                oldestEntryId = local.entries.firstOrNull()?.entryId ?: beforeEntryId,
                                hasOlder = local.hasOlder,
                                loading = false,
                            )
                        ),
                    )
                    mutableState.value = next
                    return@launch
                }
                if (local?.status == SessionGraphRangeStatus.COMPLETE) {
                    mutableState.value = mutableState.value.copy(
                        sessionHistory = mutableState.value.sessionHistory + (
                            id to history.copy(hasOlder = false, loading = false)
                        ),
                    )
                    return@launch
                }
                if (runtime != null && isHistoryRequestCurrent(id, sessionId, view.leafId, beforeEntryId)) {
                    requestHistoryRange(pairedDevice, runtime, sessionId, view.leafId, beforeEntryId, id)
                } else if (device == pairedDevice && shouldConnect) {
                    mutableState.value = mutableState.value.copy(
                        sessionHistory = mutableState.value.sessionHistory + (
                            id to history.copy(hasOlder = false, loading = false)
                        ),
                    )
                }
                }
        }
        historyJobs[id] = job
        job.invokeOnCompletion {
            if (historyJobs[id] === job) historyJobs.remove(id)
            val latest = mutableState.value
            val latestHistory = latest.sessionHistory[id]
            if (latestHistory?.loading == true && latestHistory.requestId == null) {
                mutableState.value = latest.copy(
                    sessionHistory = latest.sessionHistory + (id to latestHistory.copy(loading = false)),
                )
            }
        }
    }

    private fun requestHistoryRange(
        pairedDevice: DeviceCredential,
        runtime: RuntimeSummary,
        sessionId: String,
        leafId: String?,
        beforeEntryId: String,
        historyKey: String,
    ) {
        val current = mutableState.value
        if (!isHistoryRequestCurrent(historyKey, sessionId, leafId, beforeEntryId)) return
        val pending = PendingSessionSync(
            runtime.runtimeId, sessionId, UUID.randomUUID().toString(), range = "history",
            targetLeafId = leafId, beforeEntryId = beforeEntryId, viewLeafId = leafId,
            branchGeneration = current.sessionBranchGenerations[runtime.runtimeId] ?: 0,
            connectionGeneration = generation,
        )
        sendSessionSync(pairedDevice, newSessionSyncCommandId(), pending)
    }
    private fun startBranchCatchUp(
        pairedDevice: DeviceCredential,
        runtime: RuntimeSummary,
        fixedTarget: String? = runtime.sessionLeafId,
    ) {
        val sessionId = runtime.sessionId ?: return
        val targetLeafId = fixedTarget ?: return
        val current = mutableState.value
        if (device != pairedDevice || !shouldConnect || current.runtimes[runtime.runtimeId]?.sessionId != sessionId ||
            runtime.runtimeId in current.sessionSyncFailures || current.conversations[runtime.runtimeId]?.chatSyncError != null) return
        if (current.sessionSyncCommands.values.any { it.runtimeId == runtime.runtimeId && it.range == "catchup" }) return
        val gap = try {
            sessionGraphStore.planCatchUp(pairedDevice, sessionId, targetLeafId)
        } catch (error: Throwable) {
            reportSessionLoadFailure(runtime.runtimeId, error)
            return
        } ?: return
        val commandId = newSessionSyncCommandId()
        val pending = PendingSessionSync(
            runtimeId = runtime.runtimeId, sessionId = sessionId, syncId = UUID.randomUUID().toString(),
            range = "catchup", targetLeafId = targetLeafId, knownLeafId = gap.knownLeafId,
            requestTargetLeafId = gap.targetLeafId, viewLeafId = runtime.sessionLeafId,
            branchGeneration = current.sessionBranchGenerations[runtime.runtimeId] ?: 0,
            connectionGeneration = generation,
        )
        sendSessionSync(pairedDevice, commandId, pending)
    }

    private fun sendSessionSync(pairedDevice: DeviceCredential, commandId: String, pending: PendingSessionSync) {
        updateState { current ->
            if (device != pairedDevice || !shouldConnect || pending.connectionGeneration != generation ||
                current.runtimes[pending.runtimeId]?.sessionId != pending.sessionId ||
                pending.branchGeneration != (current.sessionBranchGenerations[pending.runtimeId] ?: 0)) current
            else {
                val next = current.queueSessionSync(commandId, pending)
                if (commandId !in next.sessionSyncCommands || pending.range != "history") next
                else next.copy(sessionHistory = next.sessionHistory + (pending.runtimeId to
                    (next.sessionHistory[pending.runtimeId] ?: SessionHistoryState(pending.sessionId, pending.targetLeafId, pending.beforeEntryId, true))
                        .copy(loading = true, requestId = commandId)))
            }
        }
        runSessionSyncScheduler()
    }
    private fun reportSessionLoadFailure(runtimeId: String, error: Throwable) {
        updateState { current ->
            val conversation = current.conversations[runtimeId] ?: RuntimeConversation()
            current.copy(
                sessionSyncRequests = current.sessionSyncRequests - runtimeId,
                conversations = current.conversations + (runtimeId to conversation.copy(
                    isChatSyncing = false, chatSyncError = "Session 历史缓存读取失败：${error.message}",
                )),
            )
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
        mutableState.value = mutableState.value.copy(
            sessionAliases = if (alias == null) {
                mutableState.value.sessionAliases - identity
            } else {
                mutableState.value.sessionAliases + (identity to alias)
            },
        )
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
            mutableState.value = mutableState.value.copy(error = "斜杠命令只能从当前 Pi 提供的菜单中选择")
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
        Log.i(RELOAD_TRACE_TAG, "ui.slash.requested name=$name runtimeId=$runtimeId argsLength=${args.length}")
        val command = mutableState.value.capabilities[runtimeId]?.commands?.find { it.name == name }
        if (command == null) {
            Log.i(RELOAD_TRACE_TAG, "ui.slash.rejected name=$name reason=command_not_available")
            mutableState.value = mutableState.value.copy(error = "所选命令已不再由当前 Pi 提供，请重新选择")
            return null
        }
        val normalizedArgs = args.trim()
        if (command.argument == null && normalizedArgs.isNotBlank()) {
            Log.i(RELOAD_TRACE_TAG, "ui.slash.rejected name=$name reason=arguments_not_allowed")
            mutableState.value = mutableState.value.copy(error = "命令 /$name 不接受参数")
            return null
        }
        if (command.argument?.required == true && normalizedArgs.isBlank()) {
            Log.i(RELOAD_TRACE_TAG, "ui.slash.rejected name=$name reason=argument_required")
            mutableState.value = mutableState.value.copy(error = "命令 /$name 需要参数")
            return null
        }
        val commandId = relay.executeSlashCommand(runtimeId, name, normalizedArgs)
        Log.i(RELOAD_TRACE_TAG, "ui.slash.sent name=$name runtimeId=$runtimeId commandId=${commandId ?: "<not_sent>"}")
        trackCommand(commandId, runtimeId, "命令未发送：中继服务器当前离线")
        return commandId
    }

    fun consumeCommandResult(commandId: String) {
        mutableState.value = mutableState.value.copy(
            commandResults = mutableState.value.commandResults - commandId,
        )
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
            mutableState.value = mutableState.value.copy(error = "还没有已配对的电脑，无法下载")
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
            mutableState.value = mutableState.value.copy(error = "还没有已配对的电脑，无法下载")
            return
        }
        startFileDownload(runtimeId, hostId, path.trim())
    }

    fun cancelDownload(taskId: String) {
        val task = mutableState.value.downloads[taskId] ?: return
        if (task.status !in setOf("queued", "downloading", "paused")) return
        val cancelled = artifactDownloadStore.cancel(taskId) ?: return
        val nextTask = artifactDownloadStore.load().firstOrNull { it.taskId == taskId } ?: return
        mutableState.value = mutableState.value.copy(
            downloads = mutableState.value.downloads + (taskId to nextTask),
            pendingCommands = task.commandId?.let { mutableState.value.pendingCommands - it } ?: mutableState.value.pendingCommands,
            pendingDownloads = task.commandId?.let { mutableState.value.pendingDownloads - it } ?: mutableState.value.pendingDownloads,
        )
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
        mutableState.value = mutableState.value.copy(
            downloads = tasks - deletedIds,
            pendingCommands = mutableState.value.pendingCommands - pendingCommandIds,
            pendingDownloads = mutableState.value.pendingDownloads - pendingCommandIds,
        )
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
            mutableState.value = mutableState.value.copy(error = "还没有已配对的电脑，无法继续下载")
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
            displayName = displayName,
            sourcePath = path,
        )
        startDownload(task, hostId) { offset -> relay.downloadFile(hostId, path, offset) }
    }

    private fun startDownload(task: ArtifactDownload, hostId: String, send: (Long) -> String?) {
        if (task.commandId != null && task.status in setOf("queued", "downloading")) return
        val offset = artifactDownloadStore.resumeOffset(task)
        val queued = task.copy(
            commandId = null,
            transferId = null,
            status = "queued",
            receivedBytes = offset,
            savedLocation = if (offset == 0L) null else task.savedLocation,
            error = null,
        )
        artifactDownloadStore.register(queued)
        mutableState.value = mutableState.value.copy(
            downloads = mutableState.value.downloads + (task.taskId to queued),
        )
        val commandId = send(offset)
        if (commandId == null) {
            val failed = queued.copy(status = "failed", error = "文件下载请求未发送：中继服务器当前离线")
            artifactDownloadStore.register(failed)
            mutableState.value = mutableState.value.copy(
                downloads = mutableState.value.downloads + (task.taskId to failed),
                error = failed.error,
            )
            return
        }
        val requested = queued.copy(commandId = commandId)
        artifactDownloadStore.register(requested)
        artifactDownloadStore.bindCommand(commandId, task.taskId)
        mutableState.value = mutableState.value.copy(
            downloads = mutableState.value.downloads + (task.taskId to requested),
            // 路由标识是 hostId：下载由 Host 服务（§9.4）。这样某个 Pi 进程掉线时
            // runtime.offline 的「中断同 runtime 的 pending 命令」就不会误伤这条下载。
            pendingCommands = mutableState.value.pendingCommands + (commandId to hostId),
            pendingDownloads = mutableState.value.pendingDownloads + (
                commandId to PendingDownload(task.taskId, hostId, offset)
            ),
        )
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
        mutableState.value = mutableState.value.copy(error = null)
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
        val host = runCatching { e2eIdentityStore.loadPairedHost() }.getOrNull()
        val current = mutableState.value
        val version = runCatching {
            val application = getApplication<Application>()
            application.packageManager.getPackageInfo(application.packageName, 0).versionName
        }.getOrNull() ?: "<未知>"
        return buildString {
            appendLine("版本 $version")
            appendLine("连接状态 ${current.connection}    加密通道 ${if (current.e2eReady) "已建立" else "未建立"}")
            appendLine("中继地址 ${credential?.relayUrl ?: "<无凭据>"}")
            appendLine("本机 deviceId ${credential?.deviceId ?: "<无凭据>"}")
            appendLine("配对电脑 hostId ${host?.hostId ?: "<未配对>"}")
            appendLine("配对电脑 hostPub ${host?.hostPub?.take(12) ?: "-"}")
            appendLine(
                "pskRoot " + (host?.pskRoot?.takeIf { it.isNotBlank() }?.let { "有（${it.take(8)}…）" } ?: "<缺失>"),
            )
            appendLine("选中 runtime ${current.selectedRuntimeId ?: "-"}    传输路径 ${current.path ?: "-"}")
            current.error?.let { appendLine("当前报错 $it") }
            appendLine("──── 最近事件（新 → 旧）────")
            append(relay.recentTraces().asReversed().joinToString("\n"))
        }
    }

    /**
     * 连接状态页读取的配对事实。与诊断文本不同，这里返回结构化字段，供状态页分行展示；
     * 读的是凭据与已配对 Host 身份，不触发任何网络或状态变更。
     */
    fun pairingStatus(): PairingStatus {
        val credential = device
        val host = runCatching { e2eIdentityStore.loadPairedHost() }.getOrNull()
        return PairingStatus(
            relayUrl = credential?.relayUrl,
            deviceId = credential?.deviceId,
            hostId = host?.hostId,
            hostPublicKeyFingerprint = host?.hostPub?.take(12),
            pskRootPresent = !host?.pskRoot.isNullOrBlank(),
        )
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
        if (!current.e2eReady || pending.submitted || isInteractionExpired(pending, System.currentTimeMillis()) || pending.responseCommandId in current.pendingCommands) return
        val commandId = send(runtimeId)
        trackCommand(commandId, runtimeId, "交互响应未发送：当前离线，请连接后重试")
        if (commandId != null) {
            val latest = mutableState.value
            val latestConversation = latest.conversations[runtimeId] ?: return
            val latestRequest = latestConversation.interactions[request.requestId] ?: return
            mutableState.value = latest.copy(conversations = latest.conversations + (runtimeId to latestConversation.copy(
                interactions = latestConversation.interactions + (request.requestId to latestRequest.copy(responseCommandId = commandId, responseError = null)),
            )))
        }
    }

    private fun trackCommand(commandId: String?, runtimeId: String, offlineError: String) {
        mutableState.value = if (commandId == null) {
            mutableState.value.copy(error = offlineError)
        } else {
            mutableState.value.copy(
                pendingCommands = mutableState.value.pendingCommands + (commandId to runtimeId),
            )
        }
    }

    private fun connect(
        credential: DeviceCredential,
        e2eOptions: E2eConnectOptions? = defaultE2eOptions(credential),
        pairing: Boolean = false,
    ) {
        // 配对进行中只允许配对那一次连接进来：自动重连进来会先 disconnect() 把配对连接掐掉。
        if (pairingAwaitingAccept && !pairing) return
        val options = e2eOptions
        if (options == null) {
            // 半配对残留：有中继凭据、却没有配对密钥（历史遗留，或上一次配对中途失败）。
            // 这种连接能连上中继，但永远没有加密通道，进程激活必然被拒。与其把人困在
            // 「已连接」的主界面里反复报同一句话，不如直接退回配对页说明原因。
            shouldConnect = false
            mutableState.value = RemoteState(
                connection = RelayConnection.OFFLINE,
                error = "这台手机上的配对不完整（缺少端到端加密材料）：请重新扫码配对",
            )
            return
        }
        reconnectJob?.cancel()
        relayEventJob?.cancel()
        val currentGeneration = ++generation
        var preserveErrorOnClose = false
        var stopReconnectOnClose = false
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
        relayEventJob = viewModelScope.launch(Dispatchers.IO) {
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
                        mutableState.value = mutableState.value.copy(
                            error = "文件下载失败：${error.message ?: "二进制下载分片无效"}",
                        )
                    }
                    continue
                }
                // 走到这里只可能是交互帧：分片在上面那条分支就 `continue` 了。
                val interactive = frame as InboundFrameLanes.InteractiveFrame
                val payload = interactive.payload
                val interactiveChannel = interactive.channel
                if (isSessionSnapshotPayload(payload)) {
                    // 单帧失败不能让消费协程死掉（viewModelScope 里的未捕获异常会崩进程）。
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
                        val artifactResult = runCatching { processArtifactPayload(payload) }
                        runCatching { reducer.reduce(previous, payload, channel = interactiveChannel) }
                            .onFailure { error ->
                                // reducer 抛异常过去是**静默吞掉**的：界面会永远停在「正在连接」，
                                // 而现场没有任何线索。宁可吵也不能哑。
                                Log.e(RELOAD_TRACE_TAG, "reducer.failed ${error::class.simpleName}: ${error.message}", error)
                            }
                            .onSuccess { reduced ->
                                val message = runCatching { messageJson.parseToJsonElement(payload).jsonObject }.getOrNull()
                                val messageType = message?.get("type")?.jsonPrimitive?.contentOrNull
                                val protocolCode = message?.get("code")?.jsonPrimitive?.contentOrNull
                                val runtimeError = message?.get("event")?.jsonObject
                                    ?.takeIf { messageType == "runtime.event" }
                                    ?.takeIf { it["type"]?.jsonPrimitive?.contentOrNull == "runtime.error" }
                                archiveChanged = messageType == "session.archive.changed"
                                if (messageType == "protocol.error" || runtimeError != null) {
                                    preserveErrorOnClose = true
                                }
                                if (message?.get("protocolVersion")?.jsonPrimitive?.intOrNull != null &&
                                    message["protocolVersion"]?.jsonPrimitive?.intOrNull != PROTOCOL_VERSION ||
                                    protocolCode in setOf("unauthorized", "invalid_message", "runtime_mismatch") ||
                                    runtimeError?.get("recoverable")?.jsonPrimitive?.contentOrNull == "false"
                                ) {
                                    stopReconnectOnClose = true
                                }
                                var next = reduced
                                artifactResult.exceptionOrNull()?.let { error ->
                                    val persisted = artifactDownloadStore.load().associateBy(ArtifactDownload::taskId)
                                    next = next.copy(
                                        downloads = next.downloads.mapValues { (taskId, task) -> persisted[taskId] ?: task },
                                        error = "文件下载失败：${error.message ?: "无法保存文件"}",
                                    )
                                } ?: next.downloads
                                    .filter { (taskId, task) -> previous.downloads[taskId] != task }
                                    .values
                                    .forEach(artifactDownloadStore::register)
                                mutableState.value = next
                                // 上传的入站消息（ready/progress/finished/failed）不经过 reducer：它们改的是
                                // 上传任务与调度器。**必须放在 reducer 落地之后**——processUploadPayload 的
                                // updateState 会被下面的 `mutableState.value = next` 覆盖（next 基于「处理前」
                                // 的 previous 快照算出），ready 的 uploading+uploadId 一落地就被冲掉，
                                // 调度器永远创建不出来，分片一片都不发（2026-09-17 真机 0% 卡死的根因）。
                                runCatching { processUploadPayload(payload) }
                                    .onFailure { error -> Log.e(RELOAD_TRACE_TAG, "upload.payload_failed", error) }
                                if (previous.sessions != next.sessions) {
                                    device?.let { pairedDevice ->
                                        viewModelScope.launch(Dispatchers.IO) {
                                            catalogWriteLock.withLock {
                                                if (device == pairedDevice) {
                                                    runCatching { sessionCatalogStore.save(pairedDevice, mutableState.value.sessions.values) }
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
                    if (deviceReadyArrived && currentGeneration == generation &&
                        mutableState.value.sessionListRequests.isEmpty()
                    ) {
                        refreshSessions()
                        autoResumeDownloads()
                    }
                    if (archiveChanged && currentGeneration == generation && interactiveChannel != null) {
                        refreshSessions()
                    }
                    // 调度器故障不能拖垮整个帧消费循环：丢帧只该让这一轮重传，不该让 App 崩。
                    runCatching { syncPullSchedulers() }
                        .onFailure { Log.e(RELOAD_TRACE_TAG, "pull.sync_failed", it) }
                }
            }
        }
        mutableState.value = mutableState.value.copy(connection = RelayConnection.CONNECTING, error = null)
        relay.onLanEndpointsChanged = { endpoints ->
            if (currentGeneration == generation) {
                e2eIdentityStore.loadPairedHost()?.takeIf { it.hostId == options.hostId }?.let {
                    e2eIdentityStore.savePairedHost(it.copy(lanEndpoints = endpoints))
                }
            }
        }
        // device.path（spec §14 B4）：Host 宣布当前路径，侧栏状态随它更新。
        relay.onPathChanged = { path, rttMs ->
            viewModelScope.launch {
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
            viewModelScope.launch {
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
                }
            }
        }
        relay.connect(
            credential,
            onMessage = message@{ payload, channel ->
                if (currentGeneration != generation) return@message
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
                    mutableState.value = mutableState.value.copy(connection = RelayConnection.CONNECTING)
                }
            },
            onClosed = closed@{ reason ->
                lanes.close()
                if (pairingAwaitingAccept) {
                    // 配对连接在 Host 的 pair-accept 到达之前就断了：这次配对没成。
                    // 不落盘、不进主界面，把人留在配对页重试。
                    pairingAwaitingAccept = false
                    shouldConnect = false
                    mutableState.value = mutableState.value.copy(
                        connection = RelayConnection.OFFLINE,
                        deviceId = null,
                        error = "配对未完成：连接在电脑确认之前断开。请确认电脑上的配对窗口还开着，再扫一次",
                    )
                    return@closed
                }
                if (currentGeneration != generation || !shouldConnect) return@closed
                mutableState.value = mutableState.value.copy(path = null, pathRttMs = null)
                val pausedDownloads = mutableState.value.downloads.mapValues { (_, task) ->
                    if (task.status in setOf("queued", "downloading")) {
                        task.copy(status = "paused", commandId = null, error = "连接已断开，可在重连后继续")
                    } else task
                }
                pausedDownloads.values.forEach(artifactDownloadStore::register)
                if (stopReconnectOnClose) {
                    mutableState.value = mutableState.value.copy(
                        connection = RelayConnection.OFFLINE,
                        error = mutableState.value.error,
                    )
                    return@closed
                }
                // Transport loss is expected to recover; keep the alert channel for
                // authentication, protocol, and other actionable failures.
                mutableState.value = mutableState.value.markReconnecting(preserveErrorOnClose)
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
        if (pairing) {
            viewModelScope.launch {
                delay(pairingAcceptTimeoutMs)
                if (currentGeneration != generation) return@launch
                if (!pairingAwaitingAccept) return@launch // 已被 pair-accept 解除 = 配对成功
                pairingAwaitingAccept = false
                shouldConnect = false
                relay.disconnect()
                mutableState.value = mutableState.value.copy(
                    connection = RelayConnection.OFFLINE,
                    deviceId = null,
                    error = "配对没有完成：电脑没有回确认（配对窗口可能已关闭或过期）。" +
                        "请确认电脑上的配对窗口还开着，再扫一次二维码",
                )
            }
        }
        // 握手看门狗：中继认了这台手机（ONLINE 来自 Relay 的 device.ready）**不等于**电脑在听。
        // 电脑没回应 HS1 时，「已连接」会一直挂着，而进程激活只会报「没有加密通道」——
        // 用户看不出该干什么。这里在超时后主动点破，并给出唯一有效的出路（重新配对）。
        viewModelScope.launch {
            delay(e2eHandshakeTimeoutMs)
            if (currentGeneration != generation) return@launch
            // 配对阶段的连接本来就没有加密通道（通道要等配对成功、重连发 HS1 之后才有），
            // 别在这里误报「电脑没回应握手」。
            if (pairing || pairingAwaitingAccept) return@launch
            if (mutableState.value.connection != RelayConnection.ONLINE) return@launch
            if (relay.hasE2eChannel() || handshakeStalled) return@launch
            handshakeStalled = true
            mutableState.value = mutableState.value.copy(error = HANDSHAKE_STALLED_ERROR)
        }
    }

    private fun isSessionSnapshotPayload(payload: String): Boolean = runCatching {
        val message = messageJson.parseToJsonElement(payload).jsonObject
        message["type"]?.jsonPrimitive?.contentOrNull == "runtime.event" &&
            message["event"]?.jsonObject?.get("type")?.jsonPrimitive?.contentOrNull == "session.snapshot"
    }.getOrDefault(false)

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
                "complete=${snapshot.complete} status=${snapshot.rangeStatus ?: "<none>"}",
        )
        relayStateLock.withLock {
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
            val persisted = runCatching {
                persistSessionSnapshot(
                    pairedDevice = pairedDevice,
                    connectionGeneration = connectionGeneration,
                    runtimeId = runtimeId,
                    commandId = pendingCommandId,
                    snapshot = snapshot,
                )
            }
            val persistence = persisted.getOrNull()
            val persistedEntries = persistence?.entries
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
                val next = current.copy(
                    pendingCommands = current.pendingCommands - pendingCommandId,
                    sessionSyncCommands = current.sessionSyncCommands - pendingCommandId,
                    sessionSyncRequests = if (activeRuntime?.sessionGraphSync == true) {
                        current.sessionSyncRequests + runtimeId
                    } else {
                        current.sessionSyncRequests - runtimeId
                    },
                    lastSequence = current.lastSequence + (
                        "$runtimeId\u0000msg" to maxOf(current.lastSequence["$runtimeId\u0000msg"] ?: -1L, sequence)
                    ),
                )
                mutableState.value = next
                activeRuntime?.let { scheduleSessionGraphLoad(pairedDevice, listOf(it)) }
                return@withLock
            }
            val persistenceMessage = persistenceError?.let { error ->
                "Session 历史缓存写入失败：${error.message ?: "未知错误"}"
            }
            if (persistenceMessage != null) {
                mutableState.value = current.failSessionSync(pendingCommandId, persistenceMessage).copy(
                    lastSequence = current.lastSequence + (
                        "$runtimeId\u0000msg" to maxOf(current.lastSequence["$runtimeId\u0000msg"] ?: -1L, sequence)
                    ),
                )
                return@withLock
            }
            val previous = current
            var next = runCatching {
                reducer.reduce(current, payload, persistedEntries)
            }.getOrElse {
                current.copy(error = "收到无效的 Session 历史快照")
            }
            mutableState.value = next
            val runtime = next.runtimes[runtimeId]
            if (runtime != null && runtime.sessionId == pending.sessionId &&
                pending.branchGeneration == (next.sessionBranchGenerations[runtimeId] ?: 0) &&
                snapshot.rangeStatus in setOf(null, "complete", "older_available", "limit_reached")) {
                // Finish the fixed logical target, reusing any suffix a preview/history already
                // committed. Only after coverage reaches it may a newer live tail start a round.
                val fixedTarget = pending.targetLeafId.takeIf { pending.range == "catchup" }
                if (fixedTarget != null && !sessionGraphStore.hasContinuousCoverage(pairedDevice, pending.sessionId, fixedTarget)) {
                    if (snapshot.entries.isNotEmpty()) startBranchCatchUp(pairedDevice, runtime, fixedTarget)
                } else {
                    startBranchCatchUp(pairedDevice, runtime)
                }
            }
            if (previous.sessions != next.sessions) {
                viewModelScope.launch(Dispatchers.IO) {
                    catalogWriteLock.withLock {
                        if (device == pairedDevice) {
                            runCatching {
                                sessionCatalogStore.save(pairedDevice, mutableState.value.sessions.values)
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
    private fun loadCachedSessionGraph(
        pairedDevice: DeviceCredential,
        sessionId: String,
        runtimeId: String?,
    ) {
        sessionGraphStore.prepareSession(pairedDevice, sessionId, mutableState.value.sessions[sessionId]?.agentKind)
        val existingGraph = mutableState.value.sessionGraphs[sessionId]
        if (runtimeId != null && existingGraph != null) return
        if (runtimeId == null && mutableState.value.selectedOfflineSessionId != sessionId) return
        var graph = sessionGraphStore.latestLeaf(pairedDevice, sessionId)?.let { leafId ->
            sessionGraphStore.readBranch(
                device = pairedDevice,
                sessionId = sessionId,
                leafId = leafId,
                maxEntries = previewPageSize,
            ).entries.takeIf { it.isNotEmpty() }?.let { entries ->
                SessionGraph(
                    sessionId,
                    entries.associateBy(SessionGraphEntry::entryId),
                    SessionBranchCursor(leafId),
                    sessionGraphStore.readTurnTimings(pairedDevice, sessionId).associateBy(TurnTiming::turnId),
                )
            }
        }
        val loadedGraph = graph ?: existingGraph ?: return
        val current = mutableState.value
        val mergedGraph = if (existingGraph == null || loadedGraph === existingGraph) {
            loadedGraph
        } else {
            loadedGraph.copy(
                entries = LinkedHashMap<String, SessionGraphEntry>().apply {
                    existingGraph.entries.forEach { (entryId, entry) -> put(entryId, entry) }
                    loadedGraph.entries.forEach { (entryId, entry) ->
                        val previous = putIfAbsent(entryId, entry)
                        require(previous == null || previous == entry) { "entry_conflict" }
                    }
                },
                turnTimings = existingGraph.turnTimings + loadedGraph.turnTimings,
            )
        }
        val conversations = if (runtimeId == null) current.conversations else {
            val projected = projectSessionGraph(mergedGraph, messageJson)
            current.conversations + (
                runtimeId to (current.conversations[runtimeId] ?: RuntimeConversation()).copy(
                    messages = projected.messages,
                    turnTimings = projected.turnTimings.associateBy(TurnTiming::turnId),
                    hasLiveSnapshot = false,
                    isChatSyncing = false,
                    chatSyncError = projected.error,
                    revision = (current.conversations[runtimeId]?.revision ?: 0) + 1,
                )
            )
        }
        val session = current.sessions[sessionId]
        if (runtimeId == null && mutableState.value.selectedOfflineSessionId != sessionId) return
        val updatedConversation = runtimeId?.let { key -> conversations[key]?.let { key to it } }
        updateState { target ->
            if (runtimeId == null && target.selectedOfflineSessionId != sessionId) return@updateState target
            target.copy(
                sessions = if (session == null) target.sessions else target.sessions + (
                    sessionId to session.copy(hasHistoryCache = true)
                ),
                sessionGraphs = target.sessionGraphs + (sessionId to mergedGraph),
                conversations = updatedConversation
                    ?.let { (key, conversation) -> target.conversations + (key to conversation) }
                    ?: target.conversations,
                sessionHistory = target.sessionHistory + (
                    (runtimeId?.let(::sessionHistoryKey) ?: offlineHistoryKey(sessionId)) to
                        historyState(sessionId, mergedGraph.cursor.leafId, mergedGraph)
                ),
            )
        }
    }

    private data class PersistedSessionSnapshotResult(
        val entries: List<SessionGraphEntry>,
        val stale: Boolean = false,
    )

    private fun persistSessionSnapshot(
        pairedDevice: DeviceCredential,
        connectionGeneration: Int,
        runtimeId: String,
        commandId: String,
        snapshot: SessionGraphSnapshot,
    ): PersistedSessionSnapshotResult {
        val entries = ingestSessionSnapshot(
            sessionGraphStore, pairedDevice, runtimeId, commandId, snapshot,
            currentState = { mutableState.value },
            connectionCurrent = { connectionGeneration == generation && device == pairedDevice && shouldConnect &&
                mutableState.value.sessionSyncCommands[commandId]?.connectionGeneration == connectionGeneration },
        )
        return PersistedSessionSnapshotResult(entries.orEmpty(), stale = entries == null)
    }
    private fun loadLocalGraphForRuntime(
        pairedDevice: DeviceCredential,
        runtime: RuntimeSummary,
        initial: RemoteState,
    ): SessionGraph? {
        val sessionId = runtime.sessionId ?: return null
        sessionGraphStore.prepareSession(pairedDevice, sessionId, runtime.agentKind)
        val observedLeaf = sessionGraphStore.latestLeaf(pairedDevice, sessionId)
        var graph = initial.sessionGraphs[sessionId] ?: SessionGraph(sessionId)
        for (leaf in listOfNotNull(runtime.sessionLeafId, observedLeaf).distinct()) {
            val range = sessionGraphStore.readBranch(pairedDevice, sessionId, leaf, maxEntries = previewPageSize)
            graph = graph.merge(SessionGraphSnapshot(sessionId, "local", SessionBranchCursor(leaf), "prepend", range.entries))
        }
        graph = graph.merge(SessionGraphSnapshot(sessionId, "local", SessionBranchCursor(), "prepend", emptyList(),
            turnTimings = sessionGraphStore.readTurnTimings(pairedDevice, sessionId)))
        return graph.takeIf { it.entries.isNotEmpty() }?.let {
            if (it.cursor.leafId == null) it.copy(cursor = SessionBranchCursor(observedLeaf)) else it
        }
    }
    private fun historyState(
        sessionId: String,
        leafId: String?,
        graph: SessionGraph?,
        loading: Boolean = false,
        requestId: String? = null,
    ): SessionHistoryState {
        val branch = graph?.let { buildSessionPath(it.entries, leafId) }.orEmpty()
        return SessionHistoryState(
            sessionId = sessionId,
            leafId = leafId,
            oldestEntryId = branch.firstOrNull()?.entryId,
            hasOlder = branch.firstOrNull()?.parentId != null,
            loading = loading,
            requestId = requestId,
        )
    }

    private fun scheduleSessionGraphLoad(
        pairedDevice: DeviceCredential,
        runtimes: List<RuntimeSummary>,
    ) {
        if (runtimes.isEmpty()) return
        // Coalesce load requests. Each load spends seconds decrypting the local tree, so launching
        // one coroutine per request let a busy runtime starve the newly selected one: its load
        // queued behind a stream of refreshes and the chat stayed blank with a sync spinner.
        runtimes.forEach { pendingSessionLoadRuntimes[it.runtimeId] = it }
        if (sessionLoadWorker?.isActive == true) return
        sessionLoadWorker = viewModelScope.launch(Dispatchers.IO) {
            while (true) {
                val batch = sessionSyncLoadLock.withLock {
                    if (pendingSessionLoadRuntimes.isEmpty()) return@withLock null
                    pendingSessionLoadRuntimes.values.toList().also { pendingSessionLoadRuntimes.clear() }
                } ?: break
                try {
                    loadSessionGraphsFor(pairedDevice, batch)
                } catch (error: Throwable) {
                    Log.i(RELOAD_TRACE_TAG, "session.load.failed error=${error.message}")
                }
            }
        }
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
     * actually replace, retrying when a frame wins the race instead of overwriting it.
     */
    private fun updateState(transform: (RemoteState) -> RemoteState) {
        while (true) {
            val current = mutableState.value
            val next = transform(current)
            if (next === current) return
            if (mutableState.compareAndSet(current, next)) return
        }
    }

    /** Runs under relayStateLock, shared with registration, snapshot commit and cancellation. */
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
            ) }.getOrNull()
            // A temporary lack of path consumes an attempt; the bounded policy owns retry timing.
            Log.i(RELOAD_TRACE_TAG, "session.sync.send syncId=${pending.syncId} range=${pending.range} attempt=${pending.attempts} sent=${sent != null}")
        }
    }
    private suspend fun loadSessionGraphsFor(pairedDevice: DeviceCredential, runtimes: List<RuntimeSummary>) {
        val connectionGeneration = generation
        for (requested in runtimes.sortedBy { it.runtimeId != mutableState.value.selectedRuntimeId }) {
            relayStateLock.withLock {
                if (device != pairedDevice || !shouldConnect || generation != connectionGeneration ||
                    mutableState.value.connection != RelayConnection.ONLINE) return
                val initial = mutableState.value
                val runtime = initial.runtimes[requested.runtimeId]?.takeIf { it.sessionId == requested.sessionId }
                    ?: return@withLock
                val sessionId = runtime.sessionId ?: return@withLock
                if (runtime.runtimeId in initial.sessionSyncFailures || initial.conversations[runtime.runtimeId]?.chatSyncError != null) return@withLock
                try {
                    val loaded = loadLocalGraphForRuntime(pairedDevice, runtime, initial)
                    if (loaded != null) updateState { current ->
                        if (device != pairedDevice || generation != connectionGeneration ||
                            current.runtimes[runtime.runtimeId]?.sessionId != sessionId ||
                            current.sessionBranchGenerations[runtime.runtimeId] != initial.sessionBranchGenerations[runtime.runtimeId]) current
                        else {
                            val graph = (current.sessionGraphs[sessionId] ?: SessionGraph(sessionId)).merge(
                                SessionGraphSnapshot(sessionId, "local", loaded.cursor, "prepend", loaded.entries.values.toList(),
                                    turnTimings = loaded.turnTimings.values.toList()),
                            ).let { merged -> if (merged.cursor.leafId == null) merged.copy(cursor = loaded.cursor) else merged }
                            current.copy(
                                sessionGraphs = current.sessionGraphs + (sessionId to graph),
                                sessions = current.sessions + (sessionId to (current.sessions[sessionId]
                                    ?: SessionCatalogEntry(sessionId)).withHistoryCache(runtime.hostname)),
                            ).seedCachedSessionView(runtime.runtimeId, graph)
                        }
                    }
                    val current = mutableState.value
                    if (current.sessionSyncCommands.values.any { it.runtimeId == runtime.runtimeId }) return@withLock
                    val conversation = current.conversations[runtime.runtimeId]
                    if (conversation?.hasLiveSnapshot == true) {
                        startBranchCatchUp(pairedDevice, runtime)
                    } else if (runtime.runtimeId == current.selectedRuntimeId) {
                        val pending = PendingSessionSync(
                            runtime.runtimeId, sessionId, UUID.randomUUID().toString(), range = "preview",
                            targetLeafId = null, viewLeafId = runtime.sessionLeafId,
                            branchGeneration = current.sessionBranchGenerations[runtime.runtimeId] ?: 0,
                            connectionGeneration = generation,
                        )
                        sendSessionSync(pairedDevice, newSessionSyncCommandId(), pending)
                    }
                } catch (error: Throwable) {
                    reportSessionLoadFailure(runtime.runtimeId, error)
                }
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
                viewModelScope.launch(Dispatchers.IO) {
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
        val previous = mutableState.value
        val reduced = reducer.reduceArtifactChunk(
            previous,
            result.runtimeId,
            frame.transferId,
            frame.offset,
            frame.data.size,
            result.receivedOffset,
        )
        mutableState.value = reduced.downloads[task.taskId]?.let { updated ->
            reduced.copy(downloads = reduced.downloads + (task.taskId to updated))
        } ?: reduced
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
        viewModelScope.launch {
            val inspected = withContext(Dispatchers.IO) {
                runCatching { ArtifactUploadStore.inspect(getApplication<Application>().contentResolver, uri) }
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

    private fun isHistoryRequestCurrent(
        historyKey: String,
        sessionId: String,
        leafId: String?,
        beforeEntryId: String,
    ): Boolean {
        val current = mutableState.value
        val history = current.sessionHistory[historyKey] ?: return false
        if (history.sessionId != sessionId || history.leafId != leafId ||
            history.oldestEntryId != beforeEntryId || !history.loading
        ) return false
        if (historyKey == offlineHistoryKey(sessionId)) {
            return current.selectedOfflineSessionId == sessionId
        }
        val runtime = current.runtimes[historyKey] ?: return false
        // Older entries are anchored to the display leaf, not the live frontier. Requiring the
        // runtime leaf to still equal the view leaf made paging fail as soon as the session
        // appended anything while the request was in flight.
        return current.selectedRuntimeId == historyKey &&
            runtime.sessionId == sessionId
    }

    private fun sessionHistoryKey(runtimeId: String): String = runtimeId

    private fun offlineHistoryKey(sessionId: String): String = "offline:$sessionId"

    /** 普通连接的 E2E 选项：用已配对 Host 的 pskRoot 发起握手。没有就降级（连接后收不到问候）。 */
    private fun defaultE2eOptions(credential: DeviceCredential): E2eConnectOptions? {
        val host = e2eIdentityStore.loadPairedHost() ?: return null
        val pskRoot = runCatching {
            Crypto.fromBase64UrlFixed(host.pskRoot, Crypto.SYMMETRIC_KEY_BYTES, "pskRoot")
        }.getOrNull() ?: return null
        return E2eConnectOptions(
            hostId = host.hostId,
            deviceId = credential.deviceId,
            deviceKeyPair = e2eIdentityStore.loadOrCreateDeviceKeyPair(),
            pskRoot = pskRoot,
            lanEndpoints = host.lanEndpoints,
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
        reconnectJob = viewModelScope.launch {
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

    override fun onCleared() {
        shouldConnect = false
        // Download metadata and partial files are deliberately durable across ViewModel and
        // process recreation. They are removed only by an explicit unpair operation.
        relayEventJob?.cancel()
        relayEventJob = null
        relay.disconnect()
        sessionGraphStore.close()
        super.onCleared()
    }
}
