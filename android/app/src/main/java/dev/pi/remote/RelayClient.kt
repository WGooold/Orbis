package dev.pi.remote

import android.content.Context
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import java.net.URI
import java.util.UUID
import java.util.concurrent.TimeUnit

internal const val PROTOCOL_VERSION = 7
internal const val RELOAD_TRACE_TAG = "PiRemote.ReloadTrace"
private const val TRACE_LOG_LIMIT = 200
/** 超过这个长度就不再整棵解析入站帧（见 `traceIncoming`）：大帧是 E2E 密文分片。 */
private const val TRACE_INCOMING_PARSE_LIMIT = 4096

internal fun isSupportedRelayUrl(value: String): Boolean = runCatching {
    val uri = URI(value.trim())
    when (uri.scheme?.lowercase()) {
        "wss" -> !uri.host.isNullOrBlank()
        "ws" -> !uri.host.isNullOrBlank() && isLocalRelayHost(uri.host)
        else -> false
    }
}.getOrDefault(false)

private fun isLocalRelayHost(host: String): Boolean {
    val normalized = host.lowercase()
    if (normalized == "localhost" || normalized == "::1" || normalized.endsWith(".local")) return true
    val octets = normalized.split('.').mapNotNull(String::toIntOrNull)
    if (octets.size != 4 || octets.any { it !in 0..255 }) return false
    return octets[0] == 10 ||
        octets[0] == 127 ||
        octets[0] == 192 && octets[1] == 168 ||
        octets[0] == 172 && octets[1] in 16..31 ||
        octets[0] == 169 && octets[1] == 254
}

internal fun String.toHttpBase(): String = trim().removeSuffix("/")
    .replaceFirst("wss://", "https://", ignoreCase = true)
    .replaceFirst("ws://", "http://", ignoreCase = true)

@Serializable
data class DeviceCredential(
    val relayUrl: String,
    val deviceId: String,
    val credential: String,
)

@Serializable
private data class PairingResponse(
    val deviceId: String,
    val credential: String,
)

class CredentialStore(context: Context, private val json: Json = Json) {
    private val preferences = context.applicationContext
        .getSharedPreferences("pi_remote_credentials", Context.MODE_PRIVATE)

    fun load(): DeviceCredential? = preferences.getString("device", null)?.let {
        runCatching { json.decodeFromString<DeviceCredential>(it) }.getOrNull()
    }

    fun save(credential: DeviceCredential) {
        preferences.edit().putString("device", json.encodeToString(credential)).apply()
    }

    fun clear() {
        preferences.edit().clear().apply()
    }
}

/**
 * 一次连接的 E2E 选项（spec §5）。
 *
 * 两种模式二选一：
 * - **普通连接**：`pskRoot != null`——连接后立即发起 HS1，握手完成后所有
 *   `runtime.command` 自动装进 `data` 密文帧；
 * - **配对模式**：`pairingSession != null`——连接后发 PAIR_REQUEST，收到
 *   pair-accept 并验证 `mac_h` 后回调 [onPairAccepted]（配对与常驻 Host 是
 *   两个进程/两个连接，验证通过即断开，之后才用 `pskRoot` 走普通连接）。
 */
data class E2eConnectOptions(
    val hostId: String,
    val deviceId: String,
    val deviceKeyPair: X25519KeyPair,
    val pskRoot: ByteArray? = null,
    val pairingSession: DevicePairingSession? = null,
    val onPairAccepted: (() -> Unit)? = null,
    val lanEndpoints: List<LanEndpoint> = emptyList(),
) {
    init {
        require((pskRoot != null) xor (pairingSession != null)) {
            "E2eConnectOptions 必须且只能选择普通连接或配对模式之一"
        }
    }
}

/** 一次连接内的 E2E 会话状态。`lock` 保护序号推进与待发队列（WS 回调线程 ↔ 调用线程）。 */
private class E2eSession(val options: E2eConnectOptions) {
    var handshake: DeviceHandshake? = null
    var channel: E2eChannel? = null
    val pending = ArrayDeque<JsonObject>()
    val lock = Any()
    /** 入站片的重组缓冲（issue 03）。每次重握手都换一套序号空间，所以那时要 clear()。 */
    val reassembler = EnvelopeReassembler { reason, mid ->
        // 这个类拿不到 RelayClient 的 trace()，直接用同一个 tag 写日志。
        Log.i(RELOAD_TRACE_TAG, "e2e.piece.rejected reason=$reason mid=$mid")
    }

    val room: String get() = options.hostId
}

class RelayClient(
    private val http: OkHttpClient = OkHttpClient.Builder()
        .pingInterval(30, TimeUnit.SECONDS)
        .build(),
    private val json: Json = Json { ignoreUnknownKeys = true },
) {
    @Volatile private var webSocket: WebSocket? = null
    private val reconnectScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var relayReconnect: Job? = null
    @Volatile private var lan: LanTransport? = null
    @Volatile private var lanEndpoints: List<LanEndpoint> = emptyList()
    var onLanEndpointsChanged: ((List<LanEndpoint>) -> Unit)? = null

    /**
     * 事件轨迹环形缓冲（诊断面板用）。
     *
     * 手机出问题时，logcat 抓不到（没插 USB / 不是开发者），界面又只有一个笼统的报错——
     * 于是排障全靠猜。这里留一份最近事件的现场，能从界面上直接看到。
     */
    private val traceLog = ArrayDeque<String>()
    private val traceStamp = java.text.SimpleDateFormat("HH:mm:ss.SSS", java.util.Locale.US)

    /** 跨线程读（UI 查加密通道状态）与写（WebSocket 读线程/主线程）都用它，故 @Volatile。 */
    @Volatile
    private var e2e: E2eSession? = null

    // ── P2P（M5）───────────────────────────────────────────────────────
    private var appContext: Context? = null
    private var p2p: P2pTransport? = null

    /** 当前生效的出站路径（Host 通过 device.path 单方面宣布，spec §6.2）。null = 未知，默认走 Relay。 */
    @Volatile
    var activePath: String? = null
        private set

    /** 所有路径解密后的明文汇入同一个消息泵。第二个参数是信封上的逻辑 channel。 */
    private var messageSink: ((String, String?) -> Unit)? = null

    /**
     * 二进制载荷泵（`bin` 帧解密后的裸字节，例如 artifact 分片）。
     *
     * 与 [messageSink] 分开是因为两者在收端要做的事不同：文本是 JSON 业务消息，
     * 字节是分片——把它们混成一条通道，分片就会被当 JSON 解读。
     */
    private var binarySink: ((ByteArray) -> Unit)? = null

    /** 路径宣布回调（device.path）：UI 用于显示当前传输路径（spec §14 B4）。 */
    var onPathChanged: ((path: String, rttMs: Long?) -> Unit)? = null

    /**
     * 加密通道状态变化（HS3 发出即 true；断开/重连/重握手即 false）。
     *
     * 和 `connection == ONLINE` 是两回事：ONLINE 只代表中继认了这台手机。UI 与「进程激活」
     * 是否可用，看的是这条通道。
     */
    var onE2eStateChanged: ((ready: Boolean) -> Unit)? = null

    /** 加密通道此刻是否可用（HS 走完、可以收发 data 帧）。 */
    fun hasE2eChannel(): Boolean {
        val state = e2e ?: return false
        return synchronized(state.lock) { state.channel != null } || lan?.isReady == true || p2p?.isReady == true
    }

    /** 最近一次 connect 的凭据：路径回落/重布时重建 P2P 需要。 */
    private var lastDevice: DeviceCredential? = null

    fun setApplicationContext(context: Context) {
        appContext = context.applicationContext
    }

    suspend fun pair(relayUrl: String, code: String, deviceName: String): DeviceCredential = withContext(Dispatchers.IO) {
        requireSupportedRelay(relayUrl)
        val body = buildJsonObject {
            put("code", code.trim())
            put("deviceName", deviceName.trim())
        }.toString().toRequestBody("application/json".toMediaType())
        val request = Request.Builder()
            .url("${relayUrl.toHttpBase()}/v1/pairings")
            .post(body)
            .build()
        http.newCall(request).execute().use { response ->
            if (!response.isSuccessful) error("配对失败（HTTP ${response.code}）")
            val paired = json.decodeFromString<PairingResponse>(response.body?.string().orEmpty())
            DeviceCredential(relayUrl.trimEnd('/'), paired.deviceId, paired.credential)
        }
    }

    suspend fun revoke(device: DeviceCredential) = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url("${device.relayUrl.toHttpBase()}/v1/device")
            .header("Authorization", "Bearer ${device.credential}")
            .delete()
            .build()
        http.newCall(request).execute().use { response ->
            if (!response.isSuccessful && response.code != 401) error("撤销设备失败（HTTP ${response.code}）")
        }
    }

    fun connect(
        device: DeviceCredential,
        /**
         * 一条业务载荷。[channel] 是信封头上的逻辑 channel（`ctl` / `msg` / `bulk`）。
         *
         * 类型是 `String?` 只是因为 `RoutingHeaderV2` 与握手帧共用一份定义（`hs`/`pair`
         * 不带 `ch`）；加密帧缺 `ch` 在 `E2eChannel.open` 就被拒了（ADR-0008），所以走到
         * 这里时它必定有值。
         *
         * 必须把它一起交出来：`hdr.ch` 只在**解密的那一刻**可见，出了这里就只剩业务 JSON。
         * 而接收侧要按它分优先级派发——不然分片会排在控制帧前面，控制面就废了。
         */
        onMessage: (String, String?) -> Unit,
        onBinaryMessage: (ByteArray) -> Unit = {},
        onOpen: () -> Unit,
        onClosed: (String?) -> Unit,
        // 非空必填：以前这里是 `= null`，于是调用方漏传时会静默退化成「没有 E2E 的连接」——
        // 连接照常成功、中继照常回 device.ready，但配对帧/HS1 永远发不出去（Android 侧从
        // f822ef9 起正是如此，整整一个 E2E 层没接上）。改成必填后，漏传是编译错误。
        e2eOptions: E2eConnectOptions,
    ) {
        requireSupportedRelay(device.relayUrl)
        disconnect()
        lastDevice = device
        val request = Request.Builder().url("${device.relayUrl.trimEnd('/')}/v1/device").build()
        trace(
            "socket.connect relay=${device.relayUrl} e2e=" +
                if (e2eOptions.pairingSession != null) "pair" else "hsk",
        )
        val connection = E2eSession(e2eOptions)
        e2e = connection
        messageSink = onMessage
        binarySink = onBinaryMessage
        updateLanEndpoints(e2eOptions.lanEndpoints)
        lateinit var openRelay: () -> Unit
        fun relayDown(reason: String?) {
            webSocket = null
            synchronized(connection.lock) {
                connection.channel = null
                connection.handshake = null
            }
            closeP2p()
            if (activePath != "lan") activePath = null
            notifyE2eState(hasE2eChannel())
            if (lanEndpoints.isNotEmpty() && connection.options.pskRoot != null) {
                // LAN has an independent lifetime: even a failed initial Relay dial must not cancel it.
                relayReconnect?.cancel()
                relayReconnect = reconnectScope.launch {
                    delay(2_000)
                    if (e2e === connection) openRelay()
                }
            } else {
                e2e = null
                messageSink = null
                binarySink = null
                onClosed(reason)
            }
        }
        val listener = object : WebSocketListener() {
            /**
             * 陈旧 socket 的守卫。
             *
             * `connect()` 开头会 `disconnect()` 掉旧 socket，而 OkHttp 的 `onClosed` 是**异步**投递的：
             * 它常常晚于新连接建立（新连接还要做 TLS 握手，比一个 close 往返慢），于是旧 socket 的回调
             * 会把**刚建好的** `e2e` 清成 null —— 新连接 `onOpen` 时看到 `e2e == null`，就只发
             * `device.authenticate`，配对帧 / HS1 一个都发不出去：中继认了这台手机（device.ready →
             * ONLINE），电脑那边却永远收不到任何帧。
             *
             * 所以每个回调都必须先确认「这个 socket 还是当前这个」。
             */
            private fun isCurrent(ws: WebSocket): Boolean = this@RelayClient.webSocket === ws

            override fun onOpen(ws: WebSocket, response: Response) {
                if (!isCurrent(ws)) {
                    trace("socket.open_stale ignored")
                    return
                }
                val authenticated = ws.send(buildJsonObject {
                    put("type", "device.authenticate")
                    put("protocolVersion", PROTOCOL_VERSION)
                    put("credential", device.credential)
                }.toString())
                trace("socket.open authentication.queued=$authenticated")
                // 中继在连接后不会主动问候：手机必须先发 PAIR 或 HS1。
                // （这句话过去写成「Relay v3 …」——版本号写在注释里一样会腐烂，去掉。）
                e2e?.let { state ->
                    val session = state.options.pairingSession
                    if (session != null) {
                        sendV2Frame(
                            PlaintextEnvelope.build(
                                "pair", room = state.room, from = state.options.deviceId, to = state.options.hostId,
                                body = session.request,
                            ),
                        )
                        trace("e2e.pair.request_sent hostId=${state.options.hostId}")
                    } else {
                        startHandshake(state)
                        // 普通（已配对）连接才有 P2P 可言：请求 Host 出 offer。
                        startP2pIfPossible(device, state)
                    }
                } ?: trace("socket.open_no_e2e（没有 E2E 会话，不会发 PAIR/HS1）")
                if (!hasE2eChannel()) onOpen()
            }

            override fun onMessage(ws: WebSocket, text: String) {
                if (!isCurrent(ws)) return
                traceIncoming(text)
                if (!handleE2eText(text, onMessage)) {
                    handleHostLifecycleNotice(text)
                    // 明文消息（protocol.error / device.* 生命周期）没有信封，按控制面处理。
                    onMessage(text, null)
                }
            }

            override fun onMessage(ws: WebSocket, bytes: ByteString) {
                if (!isCurrent(ws)) return
                onBinaryMessage(bytes.toByteArray())
            }

            override fun onClosing(ws: WebSocket, code: Int, reason: String) {
                if (isCurrent(ws)) ws.close(code, reason)
            }

            override fun onClosed(ws: WebSocket, code: Int, reason: String) {
                if (!isCurrent(ws)) {
                    trace("socket.closed_stale ignored code=$code")
                    return
                }
                trace("socket.closed code=$code reason=${reason.ifBlank { "<empty>" }}")
                relayDown(reason)
            }

            override fun onFailure(ws: WebSocket, error: Throwable, response: Response?) {
                if (!isCurrent(ws)) {
                    trace("socket.failure_stale ignored message=${error.message ?: error::class.simpleName}")
                    return
                }
                trace("socket.failure message=${error.message ?: error::class.simpleName}")
                relayDown(error.message)
            }
        }
        openRelay = {
            if (e2e === connection) webSocket = http.newWebSocket(request, listener)
        }
        openRelay()
    }

    private fun updateLanEndpoints(endpoints: List<LanEndpoint>) {
        val state = e2e ?: return
        val psk = state.options.pskRoot ?: return
        val valid = endpoints.filter { it.url() != null }.distinct().take(16)
        if (valid == lanEndpoints) return
        lanEndpoints = valid
        val old = lan
        lan = null
        old?.close()
        onLanEndpointsChanged?.invoke(valid)
        if (valid.isEmpty()) return
        val transport = LanTransport(
            http = http.newBuilder().connectTimeout(3, TimeUnit.SECONDS).pingInterval(10, TimeUnit.SECONDS).build(),
            endpoints = valid, hostId = state.options.hostId, deviceId = state.options.deviceId, pskRoot = psk,
            onPlaintext = { text, channel ->
                if (e2e === state && !handlePathControl(text)) messageSink?.invoke(text, channel)
            },
            onBinary = { bytes -> if (e2e === state) binarySink?.invoke(bytes) },
            onReady = { if (e2e === state) notifyE2eState(true) },
            onDown = {
                if (e2e === state) {
                    if (activePath == "lan") activePath = null
                    notifyE2eState(hasE2eChannel())
                }
            },
            trace = ::trace,
        )
        lan = transport
        transport.start()
    }

    // ── P2P 路径管理（M5）────────────────────────────────────────────────

    private fun startP2pIfPossible(device: DeviceCredential, state: E2eSession) {
        // 下面三处原本都是裸 `?: return`：任何一处成立，P2P 就永远不起来，而症状只是
        // 「状态页一直显示中继」——Logcat 里一个字都没有。所以每一处都必须留下 trace。
        val pskRoot = state.options.pskRoot
        if (pskRoot == null) {
            trace("p2p.disabled（缺少 pskRoot：这是配对材料问题，不是网络问题）")
            return
        }
        val context = appContext
        if (context == null) {
            trace("p2p.disabled（appContext 未注入，设备侧无法构造 PeerConnectionFactory）")
            return
        }
        val stunHost = relayStunHost(device.relayUrl)
        if (stunHost.isNullOrBlank()) {
            trace("p2p.disabled（relay 地址无主机名，内网部署）")
            return
        }
        closeP2p()
        // P2P 是「锦上添花」的路径，它的任何失败都必须止步于此，绝不能牵连中继连接。
        //
        // 这里原本没有 try/catch：构造 P2pTransport 一旦抛异常（例如 org.webrtc 建不出
        // PeerConnection），异常会一路冲穿 OkHttp 的 onOpen 回调 → 中继 socket 被判失败 →
        // 手机陷入「连上就断、断了再连」的死循环。结果是 P2P 一次都没成，中继也跟着陪葬，
        // 而用户只看到「一直在转圈」。降级到中继的前提就是：P2P 出错时中继毫发无伤。
        val transport = try {
            P2pTransport(
                context = context,
                // org.webrtc 的 ICE 服务器串是 `stun:host:port`（单冒号）。
                // 不要照抄 Host 侧的 `stun://host:port`——那是 libdatachannel 的写法，
                // 换到 org.webrtc 上会解析失败，createPeerConnection 直接返回 null。
                stunServers = listOf("stun:$stunHost:3478"),
                hostId = state.options.hostId,
                deviceId = device.deviceId,
                pskRoot = pskRoot,
                onSignalOut = { payload ->
                    // 信令永远走 Relay（信令不能走路内的自己）。
                    val session = e2e ?: return@P2pTransport
                    sendRelayPayload(session, payload)
                },
                onPlaintext = { text, channel ->
                    // Host 的控制消息（device.path / p2p.offer 等）一律走「当前生效路径」：
                    // P2P 生效后它们就从这条 DC 上来，必须先过与中继完全相同的控制面
                    // （中继侧对应 handleE2eEnvelope 的 "data" 分支：`if (handlePathControl(text)) return`），
                    // 否则 reducer 会把 device.path 当成不支持的消息，报「请在电脑端检查协议版本」。
                    if (!handlePathControl(text)) messageSink?.invoke(text, channel)
                },
                onBinPayload = { bytes -> binarySink?.invoke(bytes) },
                onReady = { trace("p2p.path ready") },
                onDown = { reason ->
                    trace("p2p.path down reason=${reason ?: "<none>"}")
                    if (e2e === state) {
                        closeP2p()
                        if (activePath == "p2p") activePath = null
                        notifyE2eState(hasE2eChannel())
                    }
                },
            )
        } catch (error: Throwable) {
            // 故意接 Throwable：这是可选子系统，连 NoClassDefFoundError 都不该掀翻中继。
            trace("p2p.start failed=${error.message ?: error::class.simpleName}（已忽略，继续走中继）")
            return
        }
        p2p = transport
        sendRelayPayload(state, buildJsonObject {
            put("type", "p2p.request")
            put("protocolVersion", PROTOCOL_VERSION)
        })
        trace("p2p.request sent host=${state.options.hostId}")
    }

    private fun closeP2p() {
        p2p?.close()
        p2p = null
    }

    /**
     * 路径控制消息（spec §6.2）：device.path 路径宣布、p2p.offer 信令入站。
     * 返回 true 表示已消化，不进业务消息泵。
     */
    private fun handlePathControl(text: String): Boolean {
        val message = runCatching { json.parseToJsonElement(text).jsonObject }.getOrNull() ?: return false
        when (message["type"]?.jsonPrimitive?.contentOrNull) {
            "host.lan" -> {
                // This method only receives authenticated data envelopes, never Relay plaintext.
                if (message["protocolVersion"]?.jsonPrimitive?.contentOrNull?.toIntOrNull() == PROTOCOL_VERSION) {
                    val endpoints = message["endpoints"]?.let {
                        runCatching { E2eJson.json.decodeFromJsonElement<List<LanEndpoint>>(it) }.getOrNull()
                    }
                    if (endpoints != null) updateLanEndpoints(endpoints)
                }
                return true
            }
            "device.path" -> {
                val path = message["path"]?.jsonPrimitive?.contentOrNull ?: return true
                val rttMs = message["rttMs"]?.jsonPrimitive?.contentOrNull?.toLongOrNull()
                activePath = path
                onPathChanged?.invoke(path, rttMs)
                trace("path.announced path=$path rttMs=${rttMs ?: "<none>"}")
                // Host 宣布 p2p 但我们的传输不在了（进程被回收后重连等）：重新请求一次 offer。
                val state = e2e
                if (path == "p2p" && p2p == null && state != null) {
                    trace("path.p2p re-request offer")
                    startP2pIfPossible(lastDevice ?: return true, state)
                }
                return true
            }
            "p2p.offer" -> {
                val sdp = message["sdp"]?.jsonPrimitive?.contentOrNull
                trace("p2p.offer received sdp=${sdp?.length ?: 0}B hasTransport=${p2p != null}")
                if (sdp != null) p2p?.acceptOffer(sdp)
                return true
            }
            else -> return false
        }
    }

    fun downloadArtifact(runtimeId: String, artifactId: String, offset: Long = 0, mode: String = "pull"): String? = sendCommand(runtimeId, buildJsonObject {
        put("type", "artifact.download")
        put("artifactId", artifactId)
        put("offset", offset)
        put("mode", mode)
    })

    fun downloadFile(runtimeId: String, path: String, offset: Long = 0): String? = sendCommand(runtimeId, buildJsonObject {
        put("type", "file.download")
        put("path", path)
        put("offset", offset)
    })

    /**
     * 范围下载：向 Host 索取 [offset, offset+length)。
     *
     * 走 E2E 载荷（不是 `runtime.command`）：Relay 只按 `hdr.to` 路由，看不到 offset/长度。
     * 进度就是下一个 read 的 offset，所以不再有 `artifact.ack`。
     */
    fun readArtifact(transferId: String, requestId: String, offset: Long, length: Int): Boolean =
        sendDeviceMessage(buildJsonObject {
            put("type", "artifact.read")
            put("protocolVersion", PROTOCOL_VERSION)
            put("transferId", transferId)
            put("requestId", requestId)
            put("offset", offset)
            put("length", length)
        })

    /** 设备已完成并校验通过：让 Host 释放这条传输的上下文（完成判定在接收方）。 */
    fun doneArtifact(transferId: String): Boolean =
        sendDeviceMessage(buildJsonObject {
            put("type", "artifact.done")
            put("protocolVersion", PROTOCOL_VERSION)
            put("transferId", transferId)
        })

    /**
     * 发起一次上传（spec: 手机上传文件到电脑）。
     *
     * 与下载镜像：这也是 Host 级载荷，不走 `runtime.command`——落地的是 Host，
     * 它需要知道 `directory`、`size`、`sha256` 才能受理和续传。
     */
    fun initUpload(
        requestId: String,
        runtimeId: String,
        directory: String,
        fileName: String,
        size: Long,
        sha256: String,
        mimeType: String?,
    ): Boolean = sendDeviceMessage(buildJsonObject {
        put("type", "file.upload.init")
        put("protocolVersion", PROTOCOL_VERSION)
        put("requestId", requestId)
        put("runtimeId", runtimeId)
        put("directory", directory)
        put("fileName", fileName)
        put("size", size)
        put("sha256", sha256)
        if (mimeType != null) put("mimeType", mimeType)
    })

    fun cancelUpload(uploadId: String): Boolean = sendDeviceMessage(buildJsonObject {
        put("type", "file.upload.cancel")
        put("protocolVersion", PROTOCOL_VERSION)
        put("uploadId", uploadId)
    })

    /**
     * 应答一个 `file.upload.read`：送回 Host 要的那一块。
     *
     * 走 `bin` 帧而不是把 base64 塞进 JSON：信封的 `ct` 无论如何都是 base64，
     * 所以 `bin` 的线上体积是 4/3，而 JSON 套 base64 是二次编码（约 1.8 倍）。
     * 返回 false（写被拒/通道未就绪）时不必重试——Host 的拉取循环会重发同一个 read。
     */
    fun sendUploadChunk(runtimeId: String, uploadId: String, offset: Long, data: ByteArray): Boolean {
        val state = e2e ?: return false
        val frame = runCatching { encodeArtifactChunkFrame(runtimeId, uploadId, offset, data) }
            .getOrElse { error ->
                trace("upload.encode_failed ${error.message ?: error::class.simpleName}")
                return false
            }
        // 上传分片固定走 `bulk`（ADR-0008 之后没有"对端不懂 channel"这回事）。
        val channel = "bulk"
        val direct = lan
        if (activePath == "lan" && direct?.isReady == true) return direct.sendBinary(frame, channel)
        val transport = p2p
        trace("upload.chunk offset=$offset bytes=${data.size} path=$activePath p2pReady=${transport?.isReady == true}")
        if (activePath == "p2p" && transport?.isReady == true) {
            val sent = transport.sendBinary(frame, channel)
            // 写被拒不静默：调度器会停在原地重试，但日志里必须看得到原因。
            if (!sent) trace("upload.chunk_rejected offset=$offset bytes=${data.size}")
            return sent
        }
        return synchronized(state.lock) {
            val e2eChannel = state.channel ?: run {
                trace("upload.chunk_rejected offset=$offset reason=no_relay_channel")
                return false
            }
            val envelope = e2eChannel.seal(
                "bin", state.room, state.options.deviceId, state.options.hostId, frame, channel,
            )
            val sent = sendV2Frame(envelope)
            if (!sent) trace("upload.chunk_rejected offset=$offset bytes=${data.size} path=relay")
            sent
        }
    }

    /** 取消一条由 Host 服务的下载（范围下载）：走 E2E，Host 是它的服务方。 */
    fun cancelArtifact(runtimeId: String, transferId: String, reason: String = "user_cancelled"): String? = sendCommand(runtimeId, buildJsonObject {
        put("type", "artifact.cancel")
        put("transferId", transferId)
        put("reason", reason)
    })

    fun syncSession(
        runtimeId: String,
        sessionId: String,
        syncId: String,
        knownLeafId: String?,
        targetLeafId: String? = null,
        beforeEntryId: String? = null,
        maxEntries: Int? = null,
        range: String? = null,
        commandId: String = UUID.randomUUID().toString(),
    ): String? = sendCommand(runtimeId, buildJsonObject {
        put("type", "session.sync")
        put("sessionId", sessionId)
        put("syncId", syncId)
        knownLeafId?.let { put("knownLeafId", it) }
        targetLeafId?.let { put("targetLeafId", it) }
        beforeEntryId?.let { put("beforeEntryId", it) }
        maxEntries?.let { put("maxEntries", it) }
        range?.let { put("range", it) }
    }, commandId)

    fun sendUserMessage(
        runtimeId: String,
        text: String,
        messageId: String,
        delivery: String? = null,
        /** 已落地到电脑的绝对路径。空 = 与从前逐字段相同的消息。 */
        attachments: List<String> = emptyList(),
    ): String? = sendCommand(runtimeId, buildJsonObject {
        put("type", "user_message")
        put("text", text)
        put("messageId", messageId)
        delivery?.let { put("delivery", it) }
        if (attachments.isNotEmpty()) {
            put("attachments", buildJsonArray { attachments.forEach { add(JsonPrimitive(it)) } })
        }
    })

    fun executeSlashCommand(runtimeId: String, name: String, args: String): String? = sendCommand(runtimeId, buildJsonObject {
        put("type", "slash.execute")
        put("name", name)
        put("args", args)
    })

    fun stop(runtimeId: String): String? = sendCommand(runtimeId, buildJsonObject { put("type", "stop") })

    fun respond(
        runtimeId: String,
        request: PendingInteraction,
        responseKind: String,
        booleanValue: Boolean? = null,
        stringValue: String? = null,
        stringValues: List<String>? = null,
    ): String? = sendCommand(runtimeId, buildJsonObject {
        put("type", "interaction.respond")
        put("requestId", request.requestId)
        put("extensionId", request.extensionId)
        put("response", buildJsonObject {
            put("kind", responseKind)
            when {
                booleanValue != null -> put("value", booleanValue)
                stringValues != null -> put("values", buildJsonArray { stringValues.forEach { add(JsonPrimitive(it)) } })
                else -> put("value", stringValue.orEmpty())
            }
        })
    })

    fun respondQuestionnaire(runtimeId: String, request: PendingInteraction, answers: List<QuestionnaireAnswer>?): String? =
        sendCommand(runtimeId, buildJsonObject {
            put("type", "interaction.respond")
            put("requestId", request.requestId)
            put("extensionId", request.extensionId)
            put("response", buildJsonObject {
                put("kind", if (answers == null) "cancel" else "questionnaire")
                if (answers != null) put("answers", buildJsonArray {
                    answers.forEach { answer ->
                        add(buildJsonObject {
                            put("id", answer.id)
                            put("values", buildJsonArray { answer.values.forEach { add(JsonPrimitive(it)) } })
                            answer.other?.let { put("other", it) }
                            answer.notes?.let { put("notes", it) }
                        })
                    }
                })
            })
        })

    fun disconnect() {
        e2e = null
        relayReconnect?.cancel()
        relayReconnect = null
        val oldSocket = webSocket
        webSocket = null
        oldSocket?.cancel()
        val oldLan = lan
        lan = null
        lanEndpoints = emptyList()
        oldLan?.close()
        closeP2p()
        activePath = null
        messageSink = null
        binarySink = null
        notifyE2eState(false)
    }

    /** 通知 UI 加密通道状态。回调可能在 WebSocket 读线程上执行。 */
    private fun notifyE2eState(ready: Boolean) {
        onE2eStateChanged?.invoke(ready)
    }

    // ── E2E 会话（spec §5）───────────────────────────────────────────────────

    /**
     * 发送一条 v2 帧（外层传输封装）。
     *
     * 大消息在这里**切成片**（issue 03）：一次写进 socket 的字节数直接决定水位是否有效，
     * 一条 1.34 MB 的信封会让控制帧等它被链路排空。发送用同一个 `mid` 串起所有片。
     */
    private fun sendV2Frame(envelope: EnvelopeV2): Boolean {
        var sent = true
        for (piece in EnvelopePieces.fragment(envelope)) {
            val frame = V2Frame(type = "v2.frame", protocolVersion = PROTOCOL_VERSION, envelope = piece)
            sent = (webSocket?.send(E2eJson.json.encodeToString(frame)) == true) && sent
        }
        return sent
    }

    /** 发 HS1。每次连接/换路都换一套临时密钥（spec §6.2）。 */
    private fun startHandshake(state: E2eSession) {
        val pskRoot = state.options.pskRoot ?: return
        val handshake = DeviceHandshake(pskRoot)
        synchronized(state.lock) {
            state.handshake = handshake
            state.channel = null
            state.pending.clear()
        }
        // 新会话 = 新的序号空间：上一条会话留下的半截消息永远凑不齐了。
        state.reassembler.clear()
        sendV2Frame(
            PlaintextEnvelope.build(
                "hs", room = state.room, from = state.options.deviceId, to = state.options.hostId,
                body = handshake.start(),
            ),
        )
        trace("e2e.hs.hs1_sent hostId=${state.options.hostId}")
    }

    /**
     * Host 进程生命周期通知（Relay 在 Host 网关上/下线时广播，spec §6.3）。
     *
     * HS1 只在本机 socket.open 时发一次。Host 重启后手机的 WS 还开着、不会再走 onOpen，
     * 新 Host 的握手会话永远 not_ready——所有加密帧被丢弃，而 UI 还显示「已连接」。
     * 所以收到**自己这台电脑**的 `host.online` 要立刻重跑握手（与 socket.open 同一条路）；
     * 别的电脑的通知与己无关，连同 host.offline 一起吞掉，不让 reducer 误清自己的状态。
     */
    private fun handleHostLifecycleNotice(text: String) {
        val state = e2e ?: return
        if (state.options.pairingSession != null) return // 配对连接走 pair 帧，不重握手
        val message = runCatching { E2eJson.json.parseToJsonElement(text).jsonObject }.getOrNull() ?: return
        if (message["type"]?.jsonPrimitive?.contentOrNull !in setOf("host.online", "host.offline")) return
        val hostId = message["hostId"]?.jsonPrimitive?.contentOrNull
        if (hostId != state.options.hostId) return
        if (message["type"]?.jsonPrimitive?.contentOrNull == "host.online") {
            startHandshake(state)
        }
    }

    /**
     * 入站文本先过 E2E：v2 帧在此消化（hs/pair 握手、ping 回声、data 解密），
     * 返回 true 表示已处理；其它（protocol.error 等明文消息）透传给业务层。
     */
    private fun handleE2eText(text: String, onMessage: (String, String?) -> Unit): Boolean {
        val state = e2e ?: return false
        val frame = runCatching { E2eJson.decode<V2Frame>(text, "v2.frame") }.getOrNull()
        if (frame?.type != "v2.frame") return false
        val envelope = frame.envelope
        runCatching { handleE2eEnvelope(state, envelope, onMessage) }
            .onFailure { error ->
                trace("e2e.error kind=${error::class.simpleName} message=${error.message ?: "<none>"}")
            }
        return true
    }

    private fun handleE2eEnvelope(state: E2eSession, incoming: EnvelopeV2, onMessage: (String, String?) -> Unit) {
        // 片先拼回整条信封：解密、序号检查、`ch` 校验都只认完整信封——片层自己什么都不判
        // （见 EnvelopePieces.kt），否则就会存在第二份合法性真相。半截消息在这里直接返回。
        val envelope = state.reassembler.accept(incoming) ?: return
        when (envelope.hdr.k) {
            "pair" -> {
                val session = state.options.pairingSession
                    ?: throw Crypto.E2eCryptoException("malformed", "非配对连接收到 pair 帧")
                val accept = PlaintextEnvelope.read<PairAcceptBody>(envelope, "pair")
                if (accept.type != "pair-accept") {
                    throw Crypto.E2eCryptoException("malformed", "期望 pair-accept，收到 ${accept.type}")
                }
                session.verifyAccept(accept)
                trace("e2e.pair.accepted hostId=${accept.hostId}")
                state.options.onPairAccepted?.invoke()
            }
            "hs" -> {
                val handshake = synchronized(state.lock) { state.handshake }
                    ?: throw Crypto.E2eCryptoException("not_ready", "收到 hs2 但没有进行中的握手")
                val hs2 = PlaintextEnvelope.read<HandshakeAcceptBody>(envelope, "hs")
                if (hs2.type != "hs2") {
                    throw Crypto.E2eCryptoException("malformed", "期望 hs2，收到 ${hs2.type}")
                }
                val hs3 = handshake.accept(hs2)
                sendV2Frame(
                    PlaintextEnvelope.build(
                        "hs", room = state.room, from = state.options.deviceId, to = state.options.hostId,
                        body = hs3,
                    ),
                )
                synchronized(state.lock) {
                    state.channel = E2eChannel(handshake.sessionKeys(), E2eChannel.ROLE_DEVICE)
                }
                trace("e2e.hs.confirmed hostId=${state.options.hostId}")
                notifyE2eState(true)
                flushPending(state)
                sendRelayPayload(state, buildJsonObject {
                    put("type", "host.lan.request")
                    put("protocolVersion", PROTOCOL_VERSION)
                })
            }
            "ping" -> {
                val channel = synchronized(state.lock) { state.channel }
                    ?: throw Crypto.E2eCryptoException("not_ready", "握手尚未完成，收到 ping")
                // open() 返回 null = 重放（n <= last），按幂等丢弃，不是故障。
                val echo = synchronized(state.lock) { channel.open(envelope) } ?: return
                val reply = synchronized(state.lock) {
                    channel.seal(
                        "ping",
                        state.room,
                        state.options.deviceId,
                        state.options.hostId,
                        echo,
                        outboundChannel(),
                    )
                }
                if (reply != null) sendV2Frame(reply)
            }
            "data" -> {
                val channel = synchronized(state.lock) { state.channel }
                    ?: throw Crypto.E2eCryptoException("not_ready", "握手尚未完成，收到 data")
                val plaintext = synchronized(state.lock) { channel.open(envelope) } ?: return
                val text = plaintext.toString(Charsets.UTF_8)
                if (handlePathControl(text)) return
                // 把 `hdr.ch` 一并交出去：接收侧要按它分优先级派发，否则分片会堵住控制帧。
                onMessage(text, envelope.hdr.ch)
            }
            // artifact 分片：裸字节，不经过 JSON 解析，直接交给下载流水线。
            "bin" -> {
                val channel = synchronized(state.lock) { state.channel }
                    ?: throw Crypto.E2eCryptoException("not_ready", "握手尚未完成，收到 bin")
                val bytes = synchronized(state.lock) { channel.open(envelope) } ?: return
                binarySink?.invoke(bytes)
            }
            else -> throw Crypto.E2eCryptoException("malformed", "不认识的帧种类：${envelope.hdr.k}")
        }
    }

    /** 握手完成后把排队中的业务载荷按序发出去。 */
    private fun flushPending(state: E2eSession) {
        val batch: List<JsonObject>
        synchronized(state.lock) {
            batch = state.pending.toList()
            state.pending.clear()
        }
        for (payload in batch) {
            sealAndSend(state, payload)
        }
    }

    private fun sealAndSend(state: E2eSession, payload: JsonObject): Boolean {
        val envelope = synchronized(state.lock) {
            val channel = state.channel ?: return false
            channel.seal(
                "data",
                state.room,
                state.options.deviceId,
                state.options.hostId,
                payload.toString().toByteArray(Charsets.UTF_8),
                outboundChannel(),
            )
        }
        return sendV2Frame(envelope)
    }

    /**
     * 设备出站载荷该打的 channel。
     *
     * 手机发出去的东西只有两类：上传分片（`bulk`，见 `sendUploadChunk`）和其余的**全部**——
     * 命令、确认、探针回声，都归 `ctl`。归 `ctl` 不只是分类好看：对端靠它把我们的命令排在
     * 分片前面，而且分片丢一帧也不会再把命令卡在 `sequence_gap` 上。
     */
    private fun outboundChannel(): String = "ctl"

    /**
     * 设备级 E2E 载荷发送的统一入口，按 activePath 路由（spec §6.2）：
     * - Host 已宣布 LAN 且本端握手完成 → 走 LanTransport；
     * - Host 已宣布 p2p 且本端 DC 握手完成 → 走 P2pTransport（自带握手期排队）；
     * - 否则走 Relay data 帧（握手未完成排队，完成后按序补发）。
     */
    private fun sendE2ePayload(state: E2eSession, payload: JsonObject, traceLabel: String): Boolean {
        val direct = lan
        if (activePath == "lan" && direct?.isReady == true) {
            return direct.sendPayload(payload)
        }
        val transport = p2p
        if (activePath == "p2p" && transport?.isReady == true) {
            val sent = transport.sendPayload(payload)
            trace("out path=p2p $traceLabel sent=$sent")
            return sent
        }
        val queued = synchronized(state.lock) { state.channel == null }
        return if (queued) {
            synchronized(state.lock) { state.pending.add(payload) }
            trace("e2e.data.queued $traceLabel（握手未完成，已排队）")
            true
        } else {
            sealAndSend(state, payload)
        }
    }

    /** 把设备级 E2E 载荷发进 Relay 路径（P2P 信令专用：信令不能走路内的自己）。 */
    private fun sendRelayPayload(state: E2eSession, payload: JsonObject): Boolean {
        val queued = synchronized(state.lock) { state.channel == null }
        return if (queued) {
            synchronized(state.lock) { state.pending.add(payload) }
            trace("e2e.data.queued type=${payload["type"]?.jsonPrimitive?.contentOrNull ?: "<missing>"}（握手未完成，已排队）")
            true
        } else {
            sealAndSend(state, payload)
        }
    }

    fun sendDeviceMessage(payload: kotlinx.serialization.json.JsonObject): Boolean {
        val state = e2e ?: return false
        val label = "type=${payload["type"]?.jsonPrimitive?.contentOrNull ?: "<missing>"} requestId=${payload["requestId"]?.jsonPrimitive?.contentOrNull ?: "<none>"}"
        val sent = sendE2ePayload(state, payload, label)
        if (activePath != "p2p") trace("out path=$activePath $label sent=$sent")
        return sent
    }

    private fun sendCommand(
        runtimeId: String,
        command: kotlinx.serialization.json.JsonObject,
        commandId: String = UUID.randomUUID().toString(),
    ): String? {
        val envelope = buildJsonObject {
            put("type", "runtime.command")
            put("protocolVersion", PROTOCOL_VERSION)
            put("runtimeId", runtimeId)
            put("commandId", commandId)
            put("command", command)
        }
        // 命令只能走 E2E（ADR-0008）：中继不再代传命令，明文那条路已经删掉。
        // 半配对的连接（没有 e2e）连不上任何东西，这里如实失败，不假装已发送。
        val state = e2e
        val sent = if (state != null) {
            sendE2ePayload(state, envelope, "commandId=$commandId")
        } else {
            false
        }
        trace(
            "out type=runtime.command commandId=$commandId runtimeId=$runtimeId " +
                "commandType=${command["type"]?.jsonPrimitive?.contentOrNull ?: "<missing>"} " +
                "name=${command["name"]?.jsonPrimitive?.contentOrNull ?: "<none>"} sent=$sent",
        )
        return commandId.takeIf { sent }
    }

    /**
     * 入站帧的诊断轨迹。
     *
     * `v2.frame` 的正文是端到端密文：一个 1 MiB 分片在线上约 1.4 MB base64。在这里把整棵
     * JSON 解析一遍，只为读出恒为 `"v2.frame"` 的 type，代价是读线程上几十毫秒的分配/解析。
     * WebSocket 读线程是串行的：它被拖住时连 ping/pong 都排不进去，中继 30s 心跳就会把这条
     * 连接判死——表现就是「下载下着下着就断线」。大帧只记长度。
     */
    private fun traceIncoming(payload: String) {
        if (payload.length > TRACE_INCOMING_PARSE_LIMIT) {
            trace("in large_frame bytes=${payload.length}")
            return
        }
        runCatching {
            val message = json.parseToJsonElement(payload).jsonObject
            val type = message["type"]?.jsonPrimitive?.contentOrNull ?: "<missing>"
            val nestedEvent = message["event"]?.let { runCatching { it.jsonObject }.getOrNull() }
            val eventType = nestedEvent?.get("type")?.jsonPrimitive?.contentOrNull
            val details = nestedEvent ?: message
            trace(
                "in type=$type" +
                    "${eventType?.let { " eventType=$it" } ?: ""}" +
                    "${message["runtimeId"]?.jsonPrimitive?.contentOrNull?.let { " runtimeId=$it" } ?: ""}" +
                    "${details["commandId"]?.jsonPrimitive?.contentOrNull?.let { " commandId=$it" } ?: ""}" +
                    "${details["ok"]?.jsonPrimitive?.contentOrNull?.let { " ok=$it" } ?: ""}" +
                    "${details["status"]?.jsonPrimitive?.contentOrNull?.let { " status=$it" } ?: ""}" +
                    "${message["code"]?.jsonPrimitive?.contentOrNull?.let { " code=$it" } ?: ""}",
            )
        }.onFailure { error ->
            trace("in trace_parse_failed message=${error.message ?: error::class.simpleName}")
        }
    }

    private fun trace(message: String) {
        Log.i(RELOAD_TRACE_TAG, message)
        synchronized(traceLog) {
            traceLog.addLast("${traceStamp.format(java.util.Date())} $message")
            while (traceLog.size > TRACE_LOG_LIMIT) traceLog.removeFirst()
        }
    }

    /** 最近的事件轨迹（诊断面板用）。旧的在前面。 */
    fun recentTraces(limit: Int = 80): List<String> = synchronized(traceLog) { traceLog.toList().takeLast(limit) }

    private fun requireSupportedRelay(relayUrl: String) {
        require(isSupportedRelayUrl(relayUrl)) {
            "中继服务器地址必须使用 wss://，或使用本地/局域网 ws:// 地址"
        }
    }
}
