/**
 * P2P 传输（spec §6.1 第二级 Path，M5）。
 *
 * 角色分工与 Host 侧对称：**Host 恒为 offerer，手机恒为 answerer**——手机发
 * `p2p.request`（走 Relay），Host 回 `p2p.offer`（SDP 里烧好全部 ICE 候选），
 * 手机 answer 回去。DataChannel 开通后手机先发 HS1（与 LAN/Relay 相同的握手，
 * 每条路径独立会话、独立临时密钥，spec §6.2）。
 *
 * 加密分层：WebRTC 自带 DTLS，但它不是我们的安全边界——真正的内容保护仍是
 * Envelope E2E（pskRoot + HS）。DTLS 只是传输层的顺带赠品。
 */
package dev.pi.remote

import android.content.Context
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicBoolean

class P2pTransport(
    context: Context,
    stunServers: List<String>,
    private val hostId: String,
    private val deviceId: String,
    private val pskRoot: ByteArray,
    /** 信令出站（p2p.answer）。由 RelayClient 提供实现——永远走 Relay 帧，不走路内。 */
    private val onSignalOut: (JsonObject) -> Unit,
    /** 解密后的业务明文，合入与 Relay 相同的消息泵。第二个参数是信封上的逻辑 channel。 */
    private val onPlaintext: (String, String?) -> Unit,
    /** 解密后的二进制载荷（`bin` 帧，artifact 分片），合入与 Relay 相同的分片泵。 */
    private val onBinPayload: (ByteArray) -> Unit = {},
    /** 握手完成，这条路径可以承载业务了。 */
    private val onReady: () -> Unit,
    /** 路径断了（DC 关闭 / 连接失败 / 显式 close）。 */
    private val onDown: (reason: String?) -> Unit,
) {
    companion object {
        @Volatile private var factory: PeerConnectionFactory? = null
        @Volatile private var factoryRefcount = 0
        private const val P2P_DISCONNECT_GRACE_MS = 5_000L

        /** PeerConnectionFactory 进程级单例：初始化重、销毁麻烦，引用计数共享。 */
        fun acquireFactory(context: Context): PeerConnectionFactory {
            synchronized(P2pTransport::class.java) {
                val existing = factory
                if (existing != null) {
                    factoryRefcount += 1
                    return existing
                }
                PeerConnectionFactory.initialize(
                    PeerConnectionFactory.InitializationOptions.builder(context.applicationContext)
                        .setEnableInternalTracer(false)
                        .createInitializationOptions(),
                )
                val created = PeerConnectionFactory.builder().createPeerConnectionFactory()
                factory = created
                factoryRefcount = 1
                return created
            }
        }

        fun releaseFactory() {
            synchronized(P2pTransport::class.java) {
                factoryRefcount -= 1
                if (factoryRefcount <= 0) {
                    factory?.dispose()
                    factory = null
                    factoryRefcount = 0
                }
            }
        }
    }

    private val closed = AtomicBoolean(false)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val peerConnection: PeerConnection
    private var dataChannel: DataChannel? = null
    private var disconnectJob: Job? = null

    // 本路径的 E2E 会话（与 Relay 路径完全独立：独立临时密钥、独立序号）。
    private val lock = Any()
    private var handshake: DeviceHandshake? = null
    private var channel: E2eChannel? = null
    /** 入站片的重组缓冲（issue 03）。重握手换序号空间时 clear()。 */
    private val reassembler = EnvelopeReassembler { reason, mid ->
        trace("p2p.piece.rejected reason=$reason mid=$mid")
    }
    private val pending = ArrayDeque<JsonObject>()

    init {
        val pcFactory = acquireFactory(context)
        val created = try {
            val rtcConfig = PeerConnection.RTCConfiguration(stunServers.map { server ->
                PeerConnection.IceServer.builder(server).createIceServer()
            }).apply {
                sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            }
            requireNotNull(pcFactory.createPeerConnection(rtcConfig, Observer())) {
                // 带上 ICE 服务器串：createPeerConnection 返回 null 最常见的原因就是
                // 服务器串格式不对（org.webrtc 要 `stun:host:port`，不是 `stun://host:port`），
                // 而原样抛出的「无法创建 PeerConnection」完全看不出这一点。
                "无法创建 PeerConnection（ICE 服务器=${stunServers.joinToString(",")}）"
            }
        } catch (error: Throwable) {
            // 构造失败必须把 factory 的引用还回去：构造函数抛异常意味着 close() 永远不会被调用，
            // 引用计数会永久泄漏，之后每次重试都复用同一个 factory，失败会一直复现。
            releaseFactory()
            throw error
        }
        peerConnection = created
        trace("p2p.transport created stun=$stunServers")
    }

    /** 收到 Host 的 offer（已带全部候选，非 trickle）。 */
    fun acceptOffer(sdp: String) {
        if (closed.get()) return
        scope.launch {
            runCatching {
                // org.webrtc 的 PC 方法从主线程调；等待结果不能堵主线程，latch await 放 IO。
                withContext(Dispatchers.IO) {
                    val setRemote = SdpObserverLatch("setRemote")
                    peerConnection.setRemoteDescription(setRemote, SessionDescription(SessionDescription.Type.OFFER, sdp))
                    setRemote.awaitCompletion()
                }
                val answer = withContext(Dispatchers.IO) {
                    val create = SdpObserverLatch("createAnswer")
                    peerConnection.createAnswer(create, MediaConstraints())
                    create.awaitDescription()
                }
                withContext(Dispatchers.IO) {
                    val setLocal = SdpObserverLatch("setLocal")
                    peerConnection.setLocalDescription(setLocal, answer)
                    setLocal.awaitCompletion()
                }
                trace("p2p.answer.local set")
            }.onFailure { error ->
                trace("p2p.sdp failed: ${error.message}")
                onDown("sdp:${error.message}")
            }
        }
    }

    // ── ICE ─────────────────────────────────────────────────────────────────

    private inner class Observer : PeerConnection.Observer {
        override fun onIceCandidate(candidate: IceCandidate) = Unit // 非 trickle：候选随 SDP 一起走

        override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) = Unit

        override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) {
            if (state != PeerConnection.IceGatheringState.COMPLETE) return
            val local = peerConnection.localDescription ?: return
            trace("p2p.gather complete, sending answer (${local.description.length}B)")
            onSignalOut(
                buildJsonObject {
                    put("type", "p2p.answer")
                    put("protocolVersion", PROTOCOL_VERSION)
                    put("sdp", local.description)
                },
            )
        }

        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {
            trace("p2p.ice $state")
            when (state) {
                PeerConnection.IceConnectionState.CONNECTED,
                PeerConnection.IceConnectionState.COMPLETED,
                -> disconnectJob?.cancel()
                PeerConnection.IceConnectionState.DISCONNECTED ->
                    scheduleDisconnect("ice:$state")
                PeerConnection.IceConnectionState.FAILED ->
                    onDown("ice:$state")
                else -> Unit
            }
        }

        override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit

        override fun onConnectionChange(newState: PeerConnection.PeerConnectionState) {
            trace("p2p.conn $newState")
            if (newState == PeerConnection.PeerConnectionState.FAILED) onDown("conn:failed")
        }

        override fun onSignalingChange(state: PeerConnection.SignalingState) = Unit

        override fun onDataChannel(dc: DataChannel) {
            trace("p2p.dataChannel '${dc.label()}'")
            dataChannel = dc
            dc.registerObserver(ChannelObserver(dc))
        }

        override fun onRenegotiationNeeded() = Unit

        override fun onAddStream(stream: org.webrtc.MediaStream) = Unit

        override fun onRemoveStream(stream: org.webrtc.MediaStream) = Unit

        override fun onTrack(transceiver: org.webrtc.RtpTransceiver) = Unit
    }

    /**
     * DC 开通 → 发 HS1；收 hs2 → 回 hs3；之后 data 密文互通。
     *
     * **两个回调都跑在 org.webrtc 的 signaling 线程上。** 从回调里直接 `dc.send()` 会重入
     * native 层，libjingle 在该线程上 SIGABRT——栈顶就是 `abort`，release 版连 abort message
     * 都没有，症状是「P2P 一连上、握手刚发出就闪退」，且必然复现。所以两个回调都只做投递，
     * 真正的握手与收帧处理全部搬到 Main（与 `acceptOffer` 对 PC 方法的既有约定一致）。
     */
    private inner class ChannelObserver(private val dc: DataChannel) : DataChannel.Observer {
        override fun onBufferedAmountChange(previous: Long) = Unit

        override fun onStateChange() {
            if (dc.state() != DataChannel.State.OPEN) return
            scope.launch { startHandshakeOnDataChannel(dc) }
        }

        override fun onMessage(buffer: DataChannel.Buffer) {
            if (buffer.binary) return
            val remaining = buffer.data.remaining()
            // `array()` 只对有后备数组的 buffer 可用；direct buffer 会抛 UnsupportedOperationException。
            // 这个回调在 signaling 线程上，抛出去没人接，所以这里必须自兜。
            val text = runCatching {
                val data = buffer.data
                if (data.hasArray()) {
                    String(data.array(), data.arrayOffset(), data.remaining(), Charsets.UTF_8)
                } else {
                    val bytes = ByteArray(data.remaining())
                    data.duplicate().get(bytes)
                    String(bytes, Charsets.UTF_8)
                }
            }.getOrElse {
                trace("p2p.dc.recv extract failed: ${it::class.simpleName}")
                return
            }
            trace("p2p.dc.recv bytes=$remaining")
            val frame = runCatching { E2eJson.decode<V2Frame>(text, "v2.frame") }.getOrNull() ?: return
            if (frame.type != "v2.frame") return
            scope.launch {
                // 一条坏帧（序号空洞 / AEAD 失败 / 缺 ch）**绝不能让进程崩掉**。
                //
                // 一条真实路径：P2P 的 SCTP 单条消息有上限，而我们的信封最大能到 1.34 MB，
                // 于是“发一帧 → 超限被丢 → 对端序号空洞”。序号流一旦断了就无法就地恢复，
                // 所以把整个路径当作故障、交给上层回落到别的路（LAN/中继没有这个上限）。
                // 根因与修法见 docs/adr/0010-write-layer-slicing.md。
                runCatching { handleFrame(frame.envelope) }.onFailure { error ->
                    trace("p2p.frame.failed ${error::class.simpleName}: ${error.message}")
                    onDown("frame:${error.message}")
                }
            }
        }
    }

    /** DC 开通 → 发 HS1。跑在 Main（[ChannelObserver] 投递），不在 signaling 线程上。 */
    private fun startHandshakeOnDataChannel(dc: DataChannel) {
        // 回调是异步投递过来的，可能已经落后于 transport 关闭 / 通道状态变化。
        if (closed.get() || dc.state() != DataChannel.State.OPEN) return
        trace("p2p.dc open → HS1")
        val hs = DeviceHandshake(pskRoot)
        synchronized(lock) {
            handshake = hs
            channel = null
            pending.clear()
        }
        // 新会话 = 新的序号空间：上一条会话留下的半截消息永远凑不齐了。
        reassembler.clear()
        sendFrame(
            PlaintextEnvelope.build(
                "hs",
                room = hostId,
                from = deviceId,
                to = hostId,
                body = hs.start(),
            ),
        )
        trace("p2p.hs1 sent")
    }

    private fun handleFrame(incoming: EnvelopeV2) {
        // 片先拼回整条信封再解密（与 RelayClient 同一条规矩，见 EnvelopePieces.kt）。
        val envelope = reassembler.accept(incoming) ?: return
        when (envelope.hdr.k) {
            "hs" -> {
                trace("p2p.hs2 received")
                val hs = synchronized(lock) { handshake } ?: run {
                    trace("p2p.hs2 without handshake, drop")
                    return
                }
                runCatching {
                    val hs2 = PlaintextEnvelope.read<HandshakeAcceptBody>(envelope, "hs")
                    if (hs2.type != "hs2") {
                        throw Crypto.E2eCryptoException("malformed", "期望 hs2，收到 ${hs2.type}")
                    }
                    val hs3 = hs.accept(hs2)
                    trace("p2p.hs3 built")
                    sendFrame(
                        PlaintextEnvelope.build(
                            "hs",
                            room = hostId,
                            from = deviceId,
                            to = hostId,
                            body = hs3,
                        ),
                    )
                    trace("p2p.hs3 sent")
                    synchronized(lock) {
                        channel = E2eChannel(hs.sessionKeys(), E2eChannel.ROLE_DEVICE)
                    }
                    trace("p2p.handshake confirmed")
                    flushPending()
                    onReady()
                }.onFailure { error ->
                    trace("p2p.handshake failed: ${error.message}")
                    onDown("handshake:${error.message}")
                }
            }
            "ping" -> {
                val echo = synchronized(lock) { channel?.open(envelope) } ?: return
                val reply = synchronized(lock) {
                    channel?.seal("ping", hostId, deviceId, hostId, echo, "ctl")
                } ?: return
                sendFrame(reply)
            }
            "data" -> {
                val plaintext = synchronized(lock) { channel?.open(envelope) } ?: run {
                    trace("p2p.data dropped (before handshake or replay)")
                    return
                }
                onPlaintext(plaintext.toString(Charsets.UTF_8), envelope.hdr.ch)
            }
            // artifact 分片：裸字节直通，不做 UTF-8 解读。
            "bin" -> {
                val payload = synchronized(lock) { channel?.open(envelope) } ?: run {
                    trace("p2p.bin dropped (before handshake or replay)")
                    return
                }
                onBinPayload(payload)
            }
            else -> trace("p2p.unknown frame kind=${envelope.hdr.k}")
        }
    }

    // ── 出站 ────────────────────────────────────────────────────────────────

    /** 业务载荷（E2E 密文）。握手没完成就排队。 */
    fun sendPayload(payload: JsonObject): Boolean {
        if (closed.get()) return false
        val ready = synchronized(lock) { channel != null }
        if (!ready) {
            synchronized(lock) { pending.add(payload) }
            trace("p2p.data queued (handshake pending)")
            return true
        }
        return sealAndSend(payload)
    }

    val isReady: Boolean get() = synchronized(lock) { channel != null }

    /**
     * 业务字节（E2E `bin` 帧）。上传分片走这里。
     *
     * 握手未完成时**不排队**，直接失败：调用方（上传调度器）本来就按 `e2eReady` 暂停，
     * 在这里再攒一份队列只会让「断线期间攒了一堆分片」变成内存问题。
     */
    fun sendBinary(payload: ByteArray, e2eChannel: String): Boolean {
        if (closed.get()) return false
        val envelope = synchronized(lock) {
            val active = channel ?: return false
            active.seal("bin", hostId, deviceId, hostId, payload, e2eChannel)
        }
        return sendFrame(envelope)
    }

    private fun flushPending() {
        val batch: List<JsonObject>
        synchronized(lock) {
            batch = pending.toList()
            pending.clear()
        }
        for (payload in batch) sealAndSend(payload)
    }

    private fun sealAndSend(payload: JsonObject): Boolean {
        val envelope = synchronized(lock) {
            val active = channel ?: return false
            active.seal("data", hostId, deviceId, hostId, payload.toString().toByteArray(Charsets.UTF_8), "ctl")
        }
        return sendFrame(envelope)
    }

    private fun sendFrame(envelope: EnvelopeV2): Boolean {
        val dc = dataChannel ?: return false
        var sent = true
        // 大消息切片（issue 03）：SCTP 单条消息有上限，而信封最大能到 1.34 MB——不切就是
        // 「发一帧 → 超限被丢 → 对端序号空洞 → 整条路径作废」。片只有几 KB，上限不再是问题，
        // 缓冲区满也只是稍后重试。
        for (piece in EnvelopePieces.fragment(envelope)) {
            val frame = V2Frame(type = "v2.frame", protocolVersion = PROTOCOL_VERSION, envelope = piece)
            val bytes = E2eJson.json.encodeToString(frame).toByteArray(Charsets.UTF_8)
            if (!dc.send(DataChannel.Buffer(ByteBuffer.wrap(bytes), false))) {
                trace("p2p.send failed")
                sent = false
                break
            }
        }
        return sent
    }

    fun close() {
        if (!closed.compareAndSet(false, true)) return
        disconnectJob?.cancel()
        scope.launch {
            runCatching { dataChannel?.close() }
            runCatching { peerConnection.close() }
            releaseFactory()
            trace("p2p.closed")
        }
    }

    private fun trace(message: String) {
        Log.i(RELOAD_TRACE_TAG, message)
    }

    private fun scheduleDisconnect(reason: String) {
        if (disconnectJob?.isActive == true) return
        trace("p2p.disconnect pending reason=$reason")
        disconnectJob = scope.launch {
            delay(P2P_DISCONNECT_GRACE_MS)
            if (!closed.get()) onDown(reason)
        }
    }

}

/** SdpObserver 的一次性 latch：等 createAnswer / setLocal 的结果。 */
private class SdpObserverLatch(private val label: String) : SdpObserver {
    private var description: SessionDescription? = null
    private val latch = java.util.concurrent.CountDownLatch(1)

    fun awaitDescription(): SessionDescription {
        awaitCompletion()
        return description ?: throw IllegalStateException("P2P：$label 无结果")
    }

    fun awaitCompletion() {
        if (!latch.await(10, java.util.concurrent.TimeUnit.SECONDS)) {
            throw IllegalStateException("P2P：$label 超时")
        }
        description ?: return
    }

    override fun onCreateSuccess(sdp: SessionDescription) {
        description = sdp
        latch.countDown()
    }

    override fun onSetSuccess() = latch.countDown()

    override fun onCreateFailure(error: String?) {
        Log.i(RELOAD_TRACE_TAG, "p2p.$label failure: ${error ?: "<none>"}")
        latch.countDown()
    }

    override fun onSetFailure(error: String?) {
        Log.i(RELOAD_TRACE_TAG, "p2p.$label failure: ${error ?: "<none>"}")
        latch.countDown()
    }
}
