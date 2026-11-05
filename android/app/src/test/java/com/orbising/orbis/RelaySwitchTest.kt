package com.orbising.orbis

import kotlinx.coroutines.CompletableDeferred
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.concurrent.CopyOnWriteArrayList

class RelaySwitchTest {
    private class Socket(val mode: RelayTransportMode, val listener: RelaySocketListener) : RelaySocketConnection {
        override var kind: RelayTransportKind? = null
        val sent = CopyOnWriteArrayList<String>()
        @Volatile var cancelled = false
        @Volatile var joined = false
        var closeGate = CompletableDeferred<Unit>().apply { complete(Unit) }
        var businessEnabled = false
        override fun setBusinessReady(ready: Boolean) { businessEnabled = ready }
        override fun start() {}
        fun ready() { kind = if (mode == RelayTransportMode.QUIC) RelayTransportKind.QUIC else RelayTransportKind.WS; listener.onOpen(this) }
        override fun queueSize() = 0L
        override fun send(text: String, lane: RelayLane): Boolean { sent.add(text); return true }
        override fun close(code: Int, reason: String?): Boolean { cancel(); return true }
        override fun cancel() { cancelled = true }
        override suspend fun cancelAndJoin() { cancel(); closeGate.await(); joined = true }
        fun fail() = listener.onFailure(this, IOException("preparation failed"))
        val authentications get() = sent.count { it.contains("device.authenticate") }
    }
    private fun awaitCondition(test: () -> Boolean) {
        val end = System.nanoTime() + 3_000_000_000
        while (!test() && System.nanoTime() < end) Thread.sleep(5)
        assertTrue(test())
    }
    @Test fun preparationFailureRapidChoicesAndRetirementAreIsolated() {
        for (initial in listOf(RelayTransportMode.WS, RelayTransportMode.QUIC)) {
            val sockets = CopyOnWriteArrayList<Socket>()
            val client = RelayClient(socketFactory = { _, mode, listener -> Socket(mode, listener).also { sockets.add(it) } })
            try {
                client.connect(DeviceCredential("wss://relay.invalid", "phone", "test"), onMessage = { _, _ -> },
                    onOpen = {}, onClosed = {}, e2eOptions = E2eConnectOptions("host", "phone", X25519KeyPair.generate(), pskRoot = ByteArray(32) { 1 }), relayMode = initial)
                val old = sockets[0]; old.ready()
                assertEquals(1, old.authentications)
                val next = if (initial == RelayTransportMode.WS) RelayTransportMode.QUIC else RelayTransportMode.WS
                client.setRelayTransportMode(next)
                val failed = sockets[1]
                assertTrue(failed.sent.isEmpty()); assertFalse(old.cancelled)
                failed.fail()
                assertFalse(old.cancelled); assertEquals(old.kind, client.relayTransportKind)
                assertNotNull(client.relaySwitchError)
                client.setRelayTransportMode(next)
                val cancelled = sockets[2]
                client.setRelayTransportMode(next); assertEquals(3, sockets.size)
                client.setRelayTransportMode(RelayTransportMode.AUTO)
                cancelled.ready()
                assertTrue(cancelled.cancelled); assertTrue(cancelled.sent.isEmpty()); assertFalse(old.cancelled)
                client.setRelayTransportMode(next)
                val candidate = sockets[3]
                old.closeGate = CompletableDeferred(); candidate.ready()
                awaitCondition { old.cancelled }
                assertFalse(old.joined); assertTrue(candidate.sent.isEmpty())
                client.setRelayTransportMode(initial)
                val winner = sockets[4]; winner.ready()
                assertTrue(winner.sent.isEmpty())
                old.closeGate.complete(Unit)
                awaitCondition { winner.authentications == 1 }
                assertTrue(old.joined && candidate.cancelled && candidate.sent.isEmpty())
                old.fail(); candidate.fail()
                assertEquals(winner.kind, client.relayTransportKind)
                assertFalse(winner.sent.any { it.contains("opId") })
            } finally { sockets.forEach { it.closeGate.complete(Unit) }; client.disconnect() }
        }
    }
    @Test fun quicWaitsForAuthenticatedBootstrapAndNeverReplaysAcceptedInputAfterSwitch() {
        val sockets = CopyOnWriteArrayList<Socket>()
        val root = ByteArray(32) { 7 }
        val client = RelayClient(socketFactory = { _, mode, listener -> Socket(mode, listener).also { sockets.add(it) } })
        fun frame(envelope: EnvelopeV2) = E2eJson.json.encodeToString(V2Frame("v2.frame", PROTOCOL_VERSION, envelope))
        fun establish(socket: Socket): E2eChannel {
            val hs1 = socket.sent.mapNotNull { runCatching { E2eJson.decode<V2Frame>(it, "v2.frame") }.getOrNull() }.last().envelope
            val hello = PlaintextEnvelope.read<HandshakeHello>(hs1, "hs")
            val key = X25519KeyPair.generate()
            val devicePublic = Crypto.fromBase64Url(hello.ePubD, "ePubD")
            val keys = HandshakeE2e.deriveSessionKeys(Crypto.deriveSharedSecret(key.privateRaw, devicePublic), root, key.publicRaw, devicePublic)
            socket.listener.onMessage(socket, frame(PlaintextEnvelope.build("hs", "host", "host", "phone", HandshakeAcceptBody(
                "hs2", Crypto.toBase64Url(key.publicRaw), Crypto.toBase64Url(HandshakeE2e.handshakeMacFromHost(keys, key.publicRaw, devicePublic))))))
            return E2eChannel(keys, E2eChannel.ROLE_HOST)
        }
        try {
            client.connect(DeviceCredential("wss://relay.invalid", "phone", "test"), onMessage = { _, _ -> },
                onOpen = {}, onClosed = {}, e2eOptions = E2eConnectOptions("host", "phone", X25519KeyPair.generate(), pskRoot = root), relayMode = RelayTransportMode.QUIC)
            val first = sockets[0]; first.ready()
            val host = establish(first)
            assertFalse(client.hasE2eChannel()); assertFalse(first.businessEnabled)
            first.listener.onMessage(first, """{"type":"device.ready","protocolVersion":$PROTOCOL_VERSION}""")
            assertFalse(client.hasE2eChannel())
            assertFalse(client.sendUploadChunk("host", "upload", 0, byteArrayOf(1)))
            assertTrue(client.sendDeviceMessage(buildJsonObject { put("type", "runtime.command"); put("opId", "accepted-once") }))
            assertEquals(2, first.sent.count { it.contains("v2.frame") }) // HS1 and HS3 only
            first.listener.onMessage(first, frame(host.seal("data", "host", "host", "phone", """{"type":"device.ready","protocolVersion":$PROTOCOL_VERSION}""".toByteArray(), "ctl")))
            assertTrue(client.hasE2eChannel()); assertTrue(first.businessEnabled)
            val delivered = first.sent.mapNotNull { runCatching { E2eJson.decode<V2Frame>(it, "v2.frame") }.getOrNull() }
                .filter { it.envelope.hdr.k == "data" }.mapNotNull { host.open(it.envelope)?.toString(Charsets.UTF_8) }
            assertEquals(1, delivered.count { it.contains("accepted-once") })
            client.setRelayTransportMode(RelayTransportMode.WS)
            val next = sockets[1]; next.ready()
            awaitCondition { next.authentications == 1 && next.sent.size >= 2 }
            val nextHost = establish(next)
            val after = next.sent.mapNotNull { runCatching { E2eJson.decode<V2Frame>(it, "v2.frame") }.getOrNull() }
                .filter { it.envelope.hdr.k == "data" }.mapNotNull { nextHost.open(it.envelope)?.toString(Charsets.UTF_8) }
            assertFalse(after.any { it.contains("accepted-once") })
        } finally { client.disconnect() }
    }

    @Test fun activePathFailureDoesNotDiscardAnAlreadyPreparingReplacement() {
        val sockets = CopyOnWriteArrayList<Socket>()
        var closed = 0
        val client = RelayClient(socketFactory = { _, mode, listener -> Socket(mode, listener).also { sockets.add(it) } })
        try {
            client.connect(DeviceCredential("wss://relay.invalid", "phone", "test"), onMessage = { _, _ -> },
                onOpen = {}, onClosed = { closed++ }, e2eOptions = E2eConnectOptions("host", "phone", X25519KeyPair.generate(), pskRoot = ByteArray(32) { 1 }))
            sockets[0].ready()
            client.setRelayTransportMode(RelayTransportMode.QUIC)
            sockets[0].fail()
            assertEquals(0, closed)
            sockets[1].ready()
            awaitCondition { sockets[1].authentications == 1 }
            assertEquals(RelayTransportKind.QUIC, client.relayTransportKind)
        } finally { client.disconnect() }
    }

}
