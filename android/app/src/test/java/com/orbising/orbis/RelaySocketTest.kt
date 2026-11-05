package com.orbising.orbis

import okhttp3.*
import okio.ByteString
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class RelaySocketTest {
    private val request = Request.Builder().url("wss://relay.example/relay/v1/device").build()
    private class FakeQuic(val openAction: () -> Unit = {}) : RelayQuicConnection {
        val closed = CountDownLatch(1)
        val messages = LinkedBlockingQueue<String>()
        val sent = LinkedBlockingQueue<String>()
        override fun open() = openAction()
        override fun read(lane: RelayLane): ByteArray {
            if (lane != RelayLane.CTL) { closed.await(); throw IOException("closed") }
            val text = messages.take()
            if (text == "CLOSED") throw IOException("disconnected")
            return text.toByteArray()
        }
        override fun write(lane: RelayLane, bytes: ByteArray) { sent.add(bytes.toString(Charsets.UTF_8)) }
        override fun close() { closed.countDown(); messages.offer("CLOSED") }
    }
    private class FakeWS(private val req: Request) : WebSocket {
        val sent = LinkedBlockingQueue<String>()
        var cancelled = false
        override fun request() = req
        override fun queueSize() = 0L
        override fun send(text: String) = sent.offer(text)
        override fun send(bytes: ByteString) = false
        override fun close(code: Int, reason: String?) = true
        override fun cancel() { cancelled = true }
    }
    private fun response() = Response.Builder().request(request).code(101).message("ready").protocol(Protocol.HTTP_1_1).build()

    @Test fun validatesDiscoveryStrictly() {
        assertEquals(24443, relayQuicPort("""{"version":1,"quic":{"port":24443,"alpn":"orbis-relay-v2"}}"""))
        for (port in listOf("0", "65536", "1.5", "true", "\"443\"")) {
            assertNull(relayQuicPort("""{"version":1,"quic":{"port":$port,"alpn":"orbis-relay-v2"}}"""))
        }
        assertNull(relayQuicPort("""{"version":true,"quic":{"port":443,"alpn":"orbis-relay-v2"}}"""))
        assertNull(relayQuicPort("""{"version":1,"quic":null}"""))
        assertNull(relayQuicPort("{"))
    }

    @Test fun quicOwnsAuthenticationAndNeverReplaysAfterReady() {
        val quic = FakeQuic()
        val opened = CountDownLatch(1); val failed = CountDownLatch(1)
        val fallbacks = AtomicInteger()
        val socket = RelaySocket(OkHttpClient(), request, object : RelaySocketListener {
            override fun onOpen(connection: RelaySocketConnection) {
                assertTrue(connection.send("""{"type":"device.authenticate"}""")); opened.countDown()
            }
            override fun onFailure(connection: RelaySocketConnection, error: Throwable) { failed.countDown() }
        }, { 443 }, { _, _ -> quic }, { _, _ -> fallbacks.incrementAndGet(); error("unexpected fallback") })
        try {
            assertFalse(socket.send("{}"))
            socket.start()
            assertTrue(opened.await(3, TimeUnit.SECONDS))
            assertEquals("""{"type":"device.authenticate"}""", quic.sent.poll(3, TimeUnit.SECONDS))
            quic.messages.offer("CLOSED")
            assertTrue(failed.await(3, TimeUnit.SECONDS))
            assertEquals(0, fallbacks.get())
            assertFalse(socket.send("{}"))
        } finally { socket.cancel() }
    }

    @Test fun closesFailedCandidateBeforeWsAuthenticationWithWrapperIdentity() {
        val quic = FakeQuic { throw IOException("UDP unavailable") }
        val ready = CountDownLatch(1)
        val ws = FakeWS(request)
        var observed: RelaySocketConnection? = null
        val socket = RelaySocket(OkHttpClient(), request, object : RelaySocketListener {
            override fun onOpen(connection: RelaySocketConnection) {
                observed = connection; assertTrue(connection.send("{}")); ready.countDown()
            }
        }, { 443 }, { _, _ -> quic }, { _, callback ->
            assertEquals(0, quic.closed.count)
            callback.onOpen(ws, response()); ws
        })
        try {
            socket.start()
            assertTrue(ready.await(3, TimeUnit.SECONDS))
            assertSame(socket, observed)
            assertEquals("{}", ws.sent.poll(1, TimeUnit.SECONDS))
            assertTrue(quic.sent.isEmpty())
        } finally { socket.cancel() }
        assertTrue(ws.cancelled)
    }

    @Test fun cancellationRejectsLateReadyAndDoesNotStartFallback() {
        val entered = CountDownLatch(1); val release = CountDownLatch(1)
        val quic = FakeQuic { entered.countDown(); release.await(3, TimeUnit.SECONDS) }
        val callbacks = AtomicInteger()
        val socket = RelaySocket(OkHttpClient(), request, object : RelaySocketListener {
            override fun onOpen(connection: RelaySocketConnection) { callbacks.incrementAndGet() }
        }, { 443 }, { _, _ -> quic }, { _, _ -> callbacks.incrementAndGet(); FakeWS(request) })
        try {
            socket.start(); assertTrue(entered.await(3, TimeUnit.SECONDS))
            socket.cancel(); release.countDown()
            assertTrue(quic.closed.await(1, TimeUnit.SECONDS))
            assertFalse(socket.send("{}"))
            assertEquals(0, callbacks.get())
        } finally { release.countDown(); socket.cancel() }
    }

    @Test fun plainLocalWsSkipsDiscoveryAndNativeLibrary() {
        val ready = CountDownLatch(1)
        val local = Request.Builder().url("ws://127.0.0.1:8787/v1/device").build()
        val socket = RelaySocket(OkHttpClient(), local, object : RelaySocketListener {
            override fun onOpen(connection: RelaySocketConnection) { ready.countDown() }
        }, { error("must not discover insecure endpoint") }, { _, _ -> error("must not load native") }, { req, callback ->
            FakeWS(req).also { callback.onOpen(it, response()) }
        })
        try { socket.start(); assertTrue(ready.await(3, TimeUnit.SECONDS)) } finally { socket.cancel() }
    }

    @Test fun forcedWsSkipsSecureDiscoveryAndQUICAndReportsActualKind() {
        val ready = CountDownLatch(1)
        val ws = FakeWS(request)
        val socket = RelaySocket(OkHttpClient(), request, object : RelaySocketListener {
            override fun onOpen(connection: RelaySocketConnection) {
                assertEquals(RelayTransportKind.WS, connection.kind)
                assertTrue(connection.send("{\"type\":\"device.authenticate\"}"))
                ready.countDown()
            }
        }, { error("forced WS must skip discovery") }, { _, _ -> error("forced WS must skip QUIC") }, { _, callback ->
            callback.onOpen(ws, response()); ws
        }, mode = RelayTransportMode.WS)
        try {
            assertNull(socket.kind)
            socket.start(); socket.start()
            assertTrue(ready.await(3, TimeUnit.SECONDS))
            assertEquals(1, ws.sent.size)
        } finally { socket.cancel() }
        assertNull(socket.kind)
        assertTrue(ws.cancelled)
    }

    @Test fun forcedQuicRejectsMissingDiscoveryInsecureEndpointAndNativeFailureWithoutWs() {
        for (scenario in 0..3) {
            val failed = CountDownLatch(1)
            val ready = AtomicInteger(); val fallback = AtomicInteger()
            var failure: Throwable? = null
            val quic = FakeQuic { throw IOException("UDP unavailable") }
            val socket = RelaySocket(OkHttpClient(), if (scenario == 0)
                Request.Builder().url("ws://127.0.0.1:8787/v1/device").build() else request,
                object : RelaySocketListener {
                    override fun onOpen(connection: RelaySocketConnection) { ready.incrementAndGet() }
                    override fun onFailure(connection: RelaySocketConnection, error: Throwable) {
                        failure = error; failed.countDown()
                    }
                }, { if (scenario == 1) null else 443 }, { _, _ ->
                    if (scenario == 3) throw UnsatisfiedLinkError("missing native library") else quic
                }, { _, _ -> fallback.incrementAndGet(); FakeWS(request) }, mode = RelayTransportMode.QUIC)
            try {
                socket.start()
                assertTrue("scenario $scenario", failed.await(3, TimeUnit.SECONDS))
                assertTrue(failure is RelayQUICUnavailable)
                assertEquals(0, ready.get()); assertEquals(0, fallback.get())
                assertNull(socket.kind); assertFalse(socket.send("{}"))
                if (scenario == 2) assertEquals(0, quic.closed.count)
            } finally { socket.cancel() }
        }
    }

    @Test fun forcedQuicPreparesWithoutAuthenticationAndKeepsLaneFIFO() {
        val quic = FakeQuic(); val ready = CountDownLatch(1)
        val socket = RelaySocket(OkHttpClient(), request, object : RelaySocketListener {
            override fun onOpen(connection: RelaySocketConnection) { ready.countDown() }
        }, { 443 }, { _, _ -> quic }, { _, _ -> error("no fallback") }, mode = RelayTransportMode.QUIC)
        try {
            socket.start(); assertTrue(ready.await(3, TimeUnit.SECONDS))
            assertEquals(RelayTransportKind.QUIC, socket.kind)
            assertTrue(quic.sent.isEmpty())
            // Each lane preserves the existing crypto sequence order.
            for (i in 0..5) assertTrue(socket.send("{\"i\":$i}", RelayLane.BULK))
            for (i in 0..5) assertEquals("{\"i\":$i}", quic.sent.poll(3, TimeUnit.SECONDS))
        } finally { socket.cancel() }
    }

    @Test fun cancelledWsCannotDeliverLateFramesOrCloseTheReplacement() {
        lateinit var callback: WebSocketListener
        val ready = CountDownLatch(1); val events = AtomicInteger()
        val ws = FakeWS(request)
        val socket = RelaySocket(OkHttpClient(), request, object : RelaySocketListener {
            override fun onOpen(connection: RelaySocketConnection) { events.incrementAndGet(); ready.countDown() }
            override fun onMessage(connection: RelaySocketConnection, text: String) { events.incrementAndGet() }
            override fun onBinaryMessage(connection: RelaySocketConnection, bytes: ByteArray) { events.incrementAndGet() }
            override fun onClosed(connection: RelaySocketConnection, code: Int, reason: String) { events.incrementAndGet() }
            override fun onFailure(connection: RelaySocketConnection, error: Throwable) { events.incrementAndGet() }
        }, wsFactory = { _, listener -> callback = listener; listener.onOpen(ws, response()); ws }, mode = RelayTransportMode.WS)
        socket.start(); assertTrue(ready.await(3, TimeUnit.SECONDS)); socket.cancel()
        callback.onMessage(ws, "{}"); callback.onClosed(ws, 1001, "late")
        callback.onFailure(ws, IOException("late"), null); callback.onOpen(ws, response())
        assertEquals(1, events.get()); assertFalse(socket.send("{}"))
    }
}
