package dev.pi.remote

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonObject
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/** Addresses come from the pairing QR or the authenticated Host, never from relay plaintext. */
@Serializable
data class LanEndpoint(val host: String, val port: Int) {
    fun url(): String? = runCatching {
        require(port in 1..65535)
        require(host.isNotBlank() && host == host.trim())
        // A LAN can use publicly numbered IPv4 (e.g. campus Wi-Fi). Authentication is HS, not RFC1918.
        HttpUrl.Builder().scheme("http").host(host).port(port).addPathSegments("v1/lan").build().toString()
    }.getOrNull()
}

/** One LAN path, with its own keys, sequences and reassembly. Tries interfaces serially and retries
 * after a network change. It never sends relay credentials or application plaintext to an endpoint. */
internal class LanTransport(
    private val http: OkHttpClient,
    endpoints: List<LanEndpoint>,
    private val hostId: String,
    private val deviceId: String,
    private val pskRoot: ByteArray,
    private val onPlaintext: (String, String?) -> Unit,
    private val onBinary: (ByteArray) -> Unit,
    private val onReady: () -> Unit,
    private val onDown: () -> Unit,
    private val trace: (String) -> Unit,
) {
    private val urls = endpoints.mapNotNull { it.url() }.distinct()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val lock = Any()
    private var attempt: Attempt? = null
    private var closed = false

    val isReady: Boolean get() = synchronized(lock) { attempt?.channel != null && !closed }

    fun start() {
        scope.launch {
            while (isActive && urls.isNotEmpty()) {
                for (url in urls) {
                    if (!isActive) return@launch
                    val next = Attempt()
                    synchronized(lock) {
                        if (closed) return@launch
                        attempt = next
                        trace("lan.connect url=$url")
                        next.socket = http.newWebSocket(Request.Builder().url(url).build(), next)
                    }
                    val ready = withTimeoutOrNull(4_000) { next.ready.await() } == true
                    if (ready) next.down.await()
                    else synchronized(lock) { next.fail("handshake_timeout") }
                    if (ready) break // Prefer the first reachable address again after a disconnect.
                }
                delay(5_000)
            }
        }
    }

    fun sendPayload(payload: JsonObject): Boolean = send("data", payload.toString().toByteArray(Charsets.UTF_8), "ctl")
    fun sendBinary(payload: ByteArray, channel: String): Boolean = send("bin", payload, channel)

    private fun send(kind: String, payload: ByteArray, channel: String): Boolean = synchronized(lock) {
        val current = attempt ?: return false
        val crypto = current.channel ?: return false
        if (closed) return false
        current.sendFrame(crypto.seal(kind, hostId, deviceId, hostId, payload, channel))
    }

    fun close() = synchronized(lock) {
        closed = true
        val old = attempt
        attempt = null // Invalidate callbacks before closing the socket.
        old?.channel = null
        old?.socket?.cancel()
        scope.cancel()
    }

    private inner class Attempt : WebSocketListener() {
        var socket: WebSocket? = null
        var channel: E2eChannel? = null
        val ready = CompletableDeferred<Boolean>()
        val down = CompletableDeferred<Unit>()
        private val handshake = DeviceHandshake(pskRoot)
        private val pieces = EnvelopeReassembler { reason, _ -> trace("lan.piece.rejected reason=$reason") }
        private fun current() = !closed && attempt === this && !down.isCompleted

        override fun onOpen(webSocket: WebSocket, response: Response) = synchronized(lock) {
            if (!current()) return
            sendFrame(PlaintextEnvelope.build("hs", hostId, deviceId, hostId, handshake.start()))
            Unit
        }

        override fun onMessage(webSocket: WebSocket, text: String) = synchronized(lock) {
            if (!current()) return
            runCatching {
                val frame = E2eJson.decode<V2Frame>(text, "v2.frame")
                require(frame.type == "v2.frame" && frame.protocolVersion == PROTOCOL_VERSION)
                val envelope = pieces.accept(frame.envelope) ?: return
                require(envelope.hdr.room == hostId && envelope.hdr.from == hostId && envelope.hdr.to == deviceId)
                when (envelope.hdr.k) {
                    "hs" -> {
                        check(channel == null)
                        val accept = PlaintextEnvelope.read<HandshakeAcceptBody>(envelope, "hs")
                        require(accept.type == "hs2")
                        val confirm = handshake.accept(accept)
                        check(sendFrame(PlaintextEnvelope.build("hs", hostId, deviceId, hostId, confirm)))
                        channel = E2eChannel(handshake.sessionKeys(), E2eChannel.ROLE_DEVICE)
                        ready.complete(true)
                        trace("lan.path ready")
                        onReady()
                    }
                    "data", "bin", "ping" -> {
                        val crypto = checkNotNull(channel)
                        val bytes = crypto.open(envelope) ?: return
                        when (envelope.hdr.k) {
                            "data" -> onPlaintext(bytes.toString(Charsets.UTF_8), envelope.hdr.ch)
                            "bin" -> onBinary(bytes)
                            "ping" -> sendFrame(crypto.seal("ping", hostId, deviceId, hostId, bytes, "ctl"))
                        }
                    }
                    else -> error("Unexpected LAN envelope kind")
                }
            }.onFailure { fail(it.message ?: "invalid_frame") }
            Unit
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) = synchronized(lock) {
            fail("closed:$code")
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = synchronized(lock) {
            fail(t.message ?: "connection_failed")
        }

        fun fail(reason: String) {
            if (!current()) return
            val wasReady = channel != null
            channel = null
            down.complete(Unit)
            ready.complete(false)
            socket?.cancel()
            trace("lan.path down reason=$reason")
            if (wasReady) onDown()
        }

        fun sendFrame(envelope: EnvelopeV2): Boolean {
            for (piece in EnvelopePieces.fragment(envelope)) {
                if (socket?.send(E2eJson.json.encodeToString(V2Frame("v2.frame", PROTOCOL_VERSION, piece))) != true) {
                    fail("write_failed")
                    return false
                }
            }
            return true
        }
    }
}
