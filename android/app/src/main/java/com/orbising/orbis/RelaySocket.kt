package com.orbising.orbis

import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.serialization.json.*
import orbis.mobile.Mobile
import okhttp3.*
import okio.ByteString
import java.util.concurrent.TimeUnit
import java.security.KeyStore
import java.util.Base64
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager
import java.io.IOException

enum class RelayTransportMode { WS, QUIC, AUTO }
enum class RelayTransportKind { WS, QUIC }

internal enum class RelayLane {
    CTL, MSG, BULK, HISTORY, CATCHUP;
    companion object {
        fun fromChannel(channel: String?): RelayLane = when (channel) {
            "msg" -> MSG
            "bulk" -> BULK
            "history" -> HISTORY
            "catchup" -> CATCHUP
            else -> CTL // authentication / pairing / handshake have no crypto channel
        }
    }
}

/** A single pre-auth attempt. Identity is its generation; start never sends credentials.
 * send=true means locally accepted, never a Host acknowledgement. No retry after ready.
 */
internal interface RelaySocketConnection {
    val supportsHistoryStreams: Boolean get() = false
    val kind: RelayTransportKind?
    fun start()
    fun queueSize(): Long
    fun send(text: String, lane: RelayLane = RelayLane.CTL): Boolean
    fun close(code: Int = 1000, reason: String? = null): Boolean
    fun cancel()
    suspend fun cancelAndJoin() { cancel() }
    fun setBusinessReady(ready: Boolean) {}
}

internal interface RelaySocketListener {
    fun onOpen(connection: RelaySocketConnection) {}
    fun onMessage(connection: RelaySocketConnection, text: String) {}
    fun onBinaryMessage(connection: RelaySocketConnection, bytes: ByteArray) {}
    fun onClosed(connection: RelaySocketConnection, code: Int, reason: String) {}
    fun onFailure(connection: RelaySocketConnection, error: Throwable) {}
}

internal class RelayQUICUnavailable(cause: Throwable? = null) :
    IOException("QUIC transport unavailable", cause)

internal const val RELAY_QUIC_ALPN = "orbis-relay-v2"
internal const val RELAY_MAX_FRAME = 2 * 1024 * 1024

internal fun relayQuicPort(text: String): Int? = runCatching {
    if (text.length > 4096) return null
    val root = Json.parseToJsonElement(text).jsonObject
    if (root["version"] != JsonPrimitive(1)) return null
    val quic = root["quic"]?.jsonObject ?: return null
    if (quic["alpn"] != JsonPrimitive(RELAY_QUIC_ALPN)) return null
    val port = quic["port"] as? JsonPrimitive ?: return null
    if (port.isString) return null
    port.intOrNull?.takeIf { it in 1..65535 }
}.getOrNull()

internal interface RelayQuicConnection {
    fun open()
    fun read(lane: RelayLane): ByteArray
    fun write(lane: RelayLane, bytes: ByteArray)
    fun close()
}

private class NativeRelayQuic(host: String, port: Int, five: Boolean) : RelayQuicConnection {
    private val address = if (host.contains(':')) "[$host]:$port" else "$host:$port"
    private val native = if (five) Mobile.newFiveConnection(address, host, roots) else Mobile.newConnection(address, host, roots)
    override fun open() = native.open()
    override fun read(lane: RelayLane): ByteArray = native.readLane(lane.ordinal.toLong())
    override fun write(lane: RelayLane, bytes: ByteArray) = native.writeLane(lane.ordinal.toLong(), bytes)
    override fun close() = native.close()
    companion object {
        private val roots: String by lazy {
            val factory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
            factory.init(null as KeyStore?)
            val trust = factory.trustManagers.filterIsInstance<X509TrustManager>().single()
            trust.acceptedIssuers.joinToString("\n") {
                "-----BEGIN CERTIFICATE-----\n" + Base64.getMimeEncoder(64, byteArrayOf(10)).encodeToString(it.encoded) +
                    "\n-----END CERTIFICATE-----"
            }
        }
    }
}

/** Owns the pre-auth candidates; only the selected transport can call onOpen. */
internal class RelaySocket(
    private val http: OkHttpClient,
    private val originalRequest: Request,
    private val listener: RelaySocketListener,
    private val discoveryOverride: ((Request) -> Int?)? = null,
    private val quicFactory: ((String, Int) -> RelayQuicConnection)? = null,
    private val wsFactory: (Request, WebSocketListener) -> WebSocket = http::newWebSocket,
    private val mode: RelayTransportMode = RelayTransportMode.AUTO,
) : RelaySocketConnection {
    private enum class State { NEW, DISCOVERING, QUIC_CONNECTING, QUIC, WS_CONNECTING, WS, CLOSED }
    private val lock = Any()
    private val deliveryLock = Any()
    private var businessGate = CompletableDeferred<Unit>()
    private var state = State.NEW
    private var closing = false
    @Volatile private var fiveStreams = false
    override val supportsHistoryStreams: Boolean get() = kind == RelayTransportKind.QUIC && fiveStreams
    private val activeLanes get() = if (fiveStreams) RelayLane.entries else listOf(RelayLane.CTL, RelayLane.MSG, RelayLane.BULK)
    private var ws: WebSocket? = null
    private var wsStarted = false
    private val wsStopped = CompletableDeferred<Unit>()
    private var quic: RelayQuicConnection? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val writes = RelayLane.entries.associateWith { Channel<ByteArray>(64) }
    private var queued = 0L
    @Volatile private var discoveryCall: Call? = null
    override val kind: RelayTransportKind?
        get() = synchronized(lock) {
            when (state) {
                State.QUIC -> RelayTransportKind.QUIC
                State.WS -> RelayTransportKind.WS
                else -> null
            }
        }

    // Called only after RelayClient has installed this identity as its current socket.
    override fun start() {
        synchronized(lock) { if (state != State.NEW) return; state = State.DISCOVERING }
        if (mode != RelayTransportMode.QUIC) { openWS(); return }
        scope.launch {
            val port = if (originalRequest.url.isHttps) runCatching {
                if (discoveryOverride != null) discoveryOverride.invoke(originalRequest) else discover(http, originalRequest)
            }.getOrNull() else null
            if (port == null) { fallback(); return@launch }
            val candidate = try { quicFactory?.invoke(originalRequest.url.host, port) ?: NativeRelayQuic(originalRequest.url.host, port, fiveStreams) }
                catch (error: Exception) { fallback(error); return@launch }
                catch (error: LinkageError) { fallback(error); return@launch }
            synchronized(lock) {
                if (state == State.CLOSED) { candidate.close(); return@launch }
                quic = candidate; state = State.QUIC_CONNECTING
            }
            try { candidate.open() } catch (error: Exception) {
                // Close the pending QUIC connection before giving WS ownership.
                candidate.close()
                synchronized(lock) { if (quic === candidate) quic = null }
                fallback(error); return@launch
            }
            synchronized(lock) {
                if (state == State.CLOSED) { candidate.close(); return@launch }
                state = State.QUIC
            }
            for (lane in activeLanes) scope.launch {
                try { for (bytes in writes.getValue(lane)) {
                    try { candidate.write(lane, bytes) } finally { synchronized(lock) { queued = (queued - bytes.size).coerceAtLeast(0) } }
                } } catch (error: Exception) { fail(error) }
            }
            try {
                if (synchronized(lock) { state != State.QUIC }) return@launch
                listener.onOpen(this@RelaySocket)
                for (lane in activeLanes) scope.launch {
                    try { while (isActive) {
                        if (lane != RelayLane.CTL) synchronized(lock) { businessGate }.await()
                        val bytes = candidate.read(lane)
                        synchronized(deliveryLock) {
                            if (synchronized(lock) { state == State.QUIC }) listener.onMessage(this@RelaySocket, bytes.toString(Charsets.UTF_8))
                        }
                    } } catch (error: Exception) { fail(error) }
                }
            } catch (error: Exception) { fail(error) }
        }
    }

    private fun fallback(error: Throwable? = null) {
        if (mode == RelayTransportMode.QUIC) { fail(RelayQUICUnavailable(error)); return }
        openWS()
    }

    private fun openWS() {
        synchronized(lock) {
            if (state == State.CLOSED || state == State.QUIC || state == State.WS_CONNECTING || state == State.WS) return
            state = State.WS_CONNECTING
            quic?.close(); quic = null
            wsStarted = true
        }
        val socket = wsFactory(originalRequest, object : WebSocketListener() {
                private fun current(socket: WebSocket): Boolean = synchronized(lock) {
                    state != State.CLOSED && (ws == null || ws === socket)
                }
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    synchronized(lock) {
                        if (!current(webSocket)) { webSocket.cancel(); return }
                        ws = webSocket; state = State.WS
                    }
                    listener.onOpen(this@RelaySocket)
                }
                override fun onMessage(webSocket: WebSocket, text: String) {
                    if (current(webSocket)) listener.onMessage(this@RelaySocket, text)
                }
                override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                    if (current(webSocket)) listener.onBinaryMessage(this@RelaySocket, bytes.toByteArray())
                }
                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    if (current(webSocket)) close(code, reason)
                }
                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    wsStopped.complete(Unit)
                    if (current(webSocket) && dispose()) listener.onClosed(this@RelaySocket, code, reason)
                }
                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    wsStopped.complete(Unit)
                    if (current(webSocket)) fail(t)
                }
            })
        synchronized(lock) {
            if (state == State.CLOSED) socket.cancel() else ws = socket
        }
    }

    private fun fail(error: Throwable) {
        if (dispose()) listener.onFailure(this, error)
    }

    private fun dispose(): Boolean {
        synchronized(lock) {
            if (state == State.CLOSED) return false
            state = State.CLOSED
            discoveryCall?.cancel(); discoveryCall = null
            quic?.close(); quic = null
            ws?.cancel(); ws = null
            writes.values.forEach { it.cancel() }; queued = 0
            scope.cancel()
            return true
        }
    }

    override fun queueSize(): Long = synchronized(lock) { ws?.queueSize() ?: queued }
    override fun send(text: String, lane: RelayLane): Boolean = synchronized(lock) {
        if (closing) return false
        if (state == State.WS) return ws?.send(text) ?: false
        if (state != State.QUIC || lane !in activeLanes) return false
        val bytes = text.toByteArray(Charsets.UTF_8)
        if (bytes.isEmpty() || bytes.size > RELAY_MAX_FRAME || queued + bytes.size > RELAY_MAX_FRAME) return false
        queued += bytes.size
        if (writes.getValue(lane).trySend(bytes).isSuccess) true else { queued -= bytes.size; false }
    }
    override fun close(code: Int, reason: String?): Boolean {
        synchronized(lock) {
            if (state == State.CLOSED || closing) return false
            if (state == State.WS) { closing = true; return ws?.close(code, reason) ?: false }
        }
        if (dispose()) { listener.onClosed(this, code, reason.orEmpty()); return true }
        return false
    }
    override fun cancel() { dispose() }
    override suspend fun cancelAndJoin() {
        cancel()
        scope.coroutineContext[Job]?.join()
        if (synchronized(lock) { wsStarted }) wsStopped.await()
    }
    override fun setBusinessReady(ready: Boolean) {
        synchronized(lock) {
            if (ready) businessGate.complete(Unit)
            else if (businessGate.isCompleted) businessGate = CompletableDeferred()
        }
    }

    private fun discover(http: OkHttpClient, request: Request): Int? {
        val endpoint = request.url.newBuilder()
            .encodedPath(request.url.encodedPath.removeSuffix("/v1/device") + "/v1/transports")
            .query(null).fragment(null).build()
        val client = http.newBuilder().followRedirects(false).followSslRedirects(false)
            .callTimeout(1, TimeUnit.SECONDS).build()
        val call = client.newCall(Request.Builder().url(endpoint).build())
        synchronized(lock) { if (state == State.CLOSED) return null; discoveryCall = call }
        return try {
            call.execute().use { response ->
                if (response.code != 200) return null
                val source = response.body?.source() ?: return null
                if (source.request(4097)) return null
                val text = source.readUtf8()
                fiveStreams = runCatching { Json.parseToJsonElement(text).jsonObject["quic"]?.jsonObject?.get("historyAlpn") == JsonPrimitive("orbis-relay-v3") }.getOrDefault(false)
                relayQuicPort(text)
            }
        } finally { discoveryCall = null }
    }
}
