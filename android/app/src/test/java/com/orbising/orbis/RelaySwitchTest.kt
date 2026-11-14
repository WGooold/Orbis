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
                client.setRelayTransportMode(initial)
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
    // NQ-16: Auto is the default policy and switching from QUIC hands off to WS only after ready.
    @Test fun automaticModeDefaultsToWsAndRetiresQuicOnlyAfterWsIsReady() {
        val sockets = CopyOnWriteArrayList<Socket>()
        val client = RelayClient(socketFactory = { _, mode, listener -> Socket(mode, listener).also { sockets.add(it) } })
        try {
            client.connect(DeviceCredential("wss://relay.invalid", "phone", "test"), onMessage = { _, _ -> },
                onOpen = {}, onClosed = {}, e2eOptions = E2eConnectOptions("host", "phone", X25519KeyPair.generate(), pskRoot = ByteArray(32) { 1 }))
            assertEquals(RelayTransportMode.AUTO, client.desiredRelayMode)
            val first = sockets.single(); first.ready()
            assertEquals(RelayTransportKind.WS, client.relayTransportKind)
            client.setRelayTransportMode(RelayTransportMode.QUIC)
            val quic = sockets[1]; quic.ready()
            awaitCondition { quic.authentications == 1 }
            client.setRelayTransportMode(RelayTransportMode.AUTO)
            val automatic = sockets[2]
            assertFalse(quic.cancelled); assertTrue(automatic.sent.isEmpty())
            assertEquals(RelayTransportKind.QUIC, client.relayTransportKind)
            automatic.ready()
            awaitCondition { automatic.authentications == 1 }
            assertTrue(quic.joined)
            assertEquals(RelayTransportKind.WS, client.relayTransportKind)
            assertEquals(RelayTransportMode.AUTO, client.desiredRelayMode)
            client.setRelayTransportMode(RelayTransportMode.WS)
            client.setRelayTransportMode(RelayTransportMode.AUTO)
            assertEquals(3, sockets.size)
            assertFalse(automatic.cancelled)
        } finally { client.disconnect() }
    }

    @Test fun quicWaitsForAuthenticatedBootstrapAndNeverReplaysAcceptedInputAfterSwitch() = checkAuthenticatedBootstrap(RelayTransportMode.QUIC)
    // SC88: WS must obey the same business-version confirmation gate as QUIC.
    @Test fun wsWaitsForAuthenticatedBootstrapAndNeverReplaysAcceptedInputAfterSwitch() = checkAuthenticatedBootstrap(RelayTransportMode.WS)

    private fun checkAuthenticatedBootstrap(mode: RelayTransportMode) {
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
                onOpen = {}, onClosed = {}, e2eOptions = E2eConnectOptions("host", "phone", X25519KeyPair.generate(), pskRoot = root), relayMode = mode)
            val first = sockets[0]; first.ready()
            val host = establish(first)
            assertFalse(client.hasE2eChannel()); assertFalse(first.businessEnabled)
            first.listener.onMessage(first, """{"type":"device.ready","protocolVersion":$PROTOCOL_VERSION}""")
            assertFalse(client.hasE2eChannel())
            assertFalse(client.sendUploadChunk("host", "upload", 0, byteArrayOf(1)))
            assertTrue(client.sendDeviceMessage(buildJsonObject { put("type", "runtime.command"); put("opId", "accepted-once") }))
            assertEquals(3, first.sent.count { it.contains("v2.frame") }) // HS1, HS3, read-only version bootstrap
            val bootstrap = first.sent.mapNotNull { runCatching { E2eJson.decode<V2Frame>(it, "v2.frame") }.getOrNull() }
                .filter { it.envelope.hdr.k == "data" }.mapNotNull { host.open(it.envelope)?.toString(Charsets.UTF_8) }
            assertEquals(1, bootstrap.size)
            assertTrue(bootstrap.single().contains("host.lan.request"))
            assertTrue(bootstrap.single().contains("\"protocolVersion\":19"))
            first.listener.onMessage(first, frame(host.seal("data", "host", "host", "phone", """{"type":"device.ready","protocolVersion":$PROTOCOL_VERSION}""".toByteArray(), "ctl")))
            assertTrue(client.hasE2eChannel()); assertTrue(first.businessEnabled)
            val delivered = first.sent.mapNotNull { runCatching { E2eJson.decode<V2Frame>(it, "v2.frame") }.getOrNull() }
                .filter { it.envelope.hdr.k == "data" }.mapNotNull { host.open(it.envelope)?.toString(Charsets.UTF_8) }
            assertEquals(1, delivered.count { it.contains("accepted-once") })
            client.setRelayTransportMode(if (mode == RelayTransportMode.WS) RelayTransportMode.QUIC else RelayTransportMode.WS)
            val next = sockets[1]; next.ready()
            awaitCondition { next.authentications == 1 && next.sent.size >= 2 }
            val nextHost = establish(next)
            val after = next.sent.mapNotNull { runCatching { E2eJson.decode<V2Frame>(it, "v2.frame") }.getOrNull() }
                .filter { it.envelope.hdr.k == "data" }.mapNotNull { nextHost.open(it.envelope)?.toString(Charsets.UTF_8) }
            assertFalse(after.any { it.contains("accepted-once") })
        } finally { client.disconnect() }
    }

    // SC88: a compatibility rejection can retry a read-only offer with fresh keys,
    // while pending input keeps its identity and is sent once after confirmation.
    @Test fun hostVersionProbeFallsBackBeforeBusinessAndRenegotiatesOnReconnect() {
        val sockets = CopyOnWriteArrayList<Socket>()
        val messages = CopyOnWriteArrayList<String>()
        val root = ByteArray(32) { 7 }
        val client = RelayClient(socketFactory = { _, mode, listener -> Socket(mode, listener).also { sockets.add(it) } })
        fun frame(envelope: EnvelopeV2) = E2eJson.json.encodeToString(V2Frame("v2.frame", PROTOCOL_VERSION, envelope))
        fun establish(socket: Socket): E2eChannel {
            val hs1 = socket.sent.mapNotNull { runCatching { E2eJson.decode<V2Frame>(it, "v2.frame") }.getOrNull() }
                .last { it.envelope.hdr.k == "hs" }.envelope
            val hello = PlaintextEnvelope.read<HandshakeHello>(hs1, "hs")
            val key = X25519KeyPair.generate(); val devicePublic = Crypto.fromBase64Url(hello.ePubD, "ePubD")
            val keys = HandshakeE2e.deriveSessionKeys(Crypto.deriveSharedSecret(key.privateRaw, devicePublic), root, key.publicRaw, devicePublic)
            socket.listener.onMessage(socket, frame(PlaintextEnvelope.build("hs", "host", "host", "phone", HandshakeAcceptBody(
                "hs2", Crypto.toBase64Url(key.publicRaw), Crypto.toBase64Url(HandshakeE2e.handshakeMacFromHost(keys, key.publicRaw, devicePublic))))))
            return E2eChannel(keys, E2eChannel.ROLE_HOST)
        }
        fun data(socket: Socket, host: E2eChannel, from: Int): List<String> = socket.sent.drop(from)
            .mapNotNull { runCatching { E2eJson.decode<V2Frame>(it, "v2.frame") }.getOrNull() }
            .filter { it.envelope.hdr.k == "data" }.mapNotNull { host.open(it.envelope)?.toString(Charsets.UTF_8) }
        fun send(socket: Socket, host: E2eChannel, text: String) =
            socket.listener.onMessage(socket, frame(host.seal("data", "host", "host", "phone", text.toByteArray(), "ctl")))
        try {
            client.connect(DeviceCredential("wss://relay.invalid", "phone", "test"), onMessage = { text, _ -> messages.add(text) },
                onOpen = {}, onClosed = {}, e2eOptions = E2eConnectOptions("host", "phone", X25519KeyPair.generate(), pskRoot = root))
            val socket = sockets.single(); socket.ready(); val first = establish(socket)
            assertTrue(data(socket, first, 0).single().contains("\"protocolVersion\":${PREFERRED_PROTOCOL_VERSIONS.first()}"))
            assertEquals("same-command", client.sendUserMessage("runtime", "synthetic", "same-message", commandId = "same-command"))
            assertFalse(client.hasE2eChannel())
            val retryStart = socket.sent.size
            send(socket, first, """{"type":"protocol.error","code":"protocol_version_mismatch","message":"unsupported offer"}""")
            val retried = establish(socket)
            val offered = data(socket, retried, retryStart)
            assertEquals(1, offered.size)
            assertTrue(offered.single().contains("\"protocolVersion\":${PREFERRED_PROTOCOL_VERSIONS[1]}"))
            val confirmedStart = socket.sent.size
            send(socket, retried, """{"type":"device.ready","protocolVersion":${PREFERRED_PROTOCOL_VERSIONS[1]}}""")
            val delivered = data(socket, retried, confirmedStart)
            assertEquals(1, delivered.count { it.contains("same-command") && it.contains("same-message") })
            assertTrue(client.hasE2eChannel())
            assertFalse(messages.any { it.contains("protocol.error") })
            val reconnectStart = socket.sent.size
            socket.listener.onMessage(socket, """{"type":"host.online","protocolVersion":$PROTOCOL_VERSION,"hostId":"host"}""")
            val renewed = establish(socket)
            assertFalse(client.hasE2eChannel())
            val renewedOffer = data(socket, renewed, reconnectStart)
            assertEquals(1, renewedOffer.size)
            assertTrue(renewedOffer.single().contains("\"protocolVersion\":${PREFERRED_PROTOCOL_VERSIONS.first()}"))
            send(socket, renewed, """{"type":"device.ready","protocolVersion":999}""")
            assertFalse(client.hasE2eChannel())
            assertTrue(messages.last().contains("protocol_version_mismatch"))
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
