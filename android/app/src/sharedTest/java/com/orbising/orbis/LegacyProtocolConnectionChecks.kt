package com.orbising.orbis

import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test

/** Strict legacy peers, real WebSockets, HS1/2/3, MAC checks, encryption and binary transfer. */
abstract class LegacyProtocolConnectionChecks {
    private val psk = ByteArray(32) { (it + 7).toByte() }

    @Test fun strict18CarriesRequestsAcksAndFileChunks() {
        val peer = StrictPeer(18)
        withConnection(peer) { client, messages, _ ->
            assertTrue(peer.ready.await(4, TimeUnit.SECONDS))
            assertEquals(18, peer.authentication.poll(2, TimeUnit.SECONDS))
            val ready = messages.poll(3, TimeUnit.SECONDS)!!
            assertEquals(RelayConnection.ONLINE, RelayReducer().reduce(RemoteState(), ready, channel = "ctl").connection)
            val requests = listOf(
                """{"type":"agent.state.request","protocolVersion":19,"requestId":"state-fixed","scope":"host","domains":["identity"]}""",
                """{"type":"notification.sync","protocolVersion":19,"runtimeId":"runtime"}""",
                """{"type":"artifact.read","protocolVersion":19,"requestId":"read-fixed","transferId":"download","offset":0,"length":3}""",
                """{"type":"session.list","protocolVersion":19,"requestId":"list-fixed"}""",
            )
            for (text in requests) {
                val payload = Json.parseToJsonElement(text).jsonObject
                assertTrue(client.sendDeviceMessage(payload))
                val received = Json.parseToJsonElement(peer.received.poll(3, TimeUnit.SECONDS)!!.second.toString(Charsets.UTF_8)).jsonObject
                assertEquals(18, received["protocolVersion"]!!.jsonPrimitive.int)
                assertEquals(payload - "protocolVersion", received - "protocolVersion")
            }
            assertEquals("command-fixed", client.sendUserMessage("runtime", "hello", "message-fixed", commandId = "command-fixed"))
            val request = Json.parseToJsonElement(peer.received.poll(3, TimeUnit.SECONDS)!!.second.toString(Charsets.UTF_8)).jsonObject
            assertEquals(18, request["protocolVersion"]!!.jsonPrimitive.int)
            assertEquals("command-fixed", request["commandId"]!!.jsonPrimitive.content)
            assertEquals("message-fixed", request["command"]!!.jsonObject["messageId"]!!.jsonPrimitive.content)
            val ack = client.sendToolCommand("runtime", buildJsonObject {
                put("type", "session.snapshot.ack"); put("syncId", "sync-fixed"); put("result", "applied")
            })
            assertNotNull(ack)
            val receivedAck = Json.parseToJsonElement(peer.received.poll(3, TimeUnit.SECONDS)!!.second.toString(Charsets.UTF_8)).jsonObject
            assertEquals(18, receivedAck["protocolVersion"]!!.jsonPrimitive.int)
            assertEquals(ack, receivedAck["commandId"]!!.jsonPrimitive.content)
            assertEquals("sync-fixed", receivedAck["command"]!!.jsonObject["syncId"]!!.jsonPrimitive.content)
            val chunk = byteArrayOf(3, 2, 1)
            assertTrue(client.sendUploadChunk("runtime", "upload", 0, chunk))
            val uploaded = peer.received.poll(3, TimeUnit.SECONDS)!!
            assertEquals("bin", uploaded.first)
            assertEquals(18.toByte(), uploaded.second[4])
            assertArrayEquals(chunk, decodeArtifactChunkFrame(uploaded.second).data)
            peer.sendChunk(encodeArtifactChunkFrame("runtime", "download", 0, chunk, 18))
            assertTrue(peer.errors.isEmpty())
        }
    }

    @Test fun explicitVersionRejectionTries19Once() {
        val peer = StrictPeer(19)
        val server = MockWebServer()
        val attempts = LinkedBlockingQueue<Int>()
        val closed = AtomicInteger()
        server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
            override fun onMessage(ws: WebSocket, text: String) {
                val message = Json.parseToJsonElement(text).jsonObject
                if (message["type"]?.jsonPrimitive?.content == "device.authenticate") {
                    attempts.add(message["protocolVersion"]!!.jsonPrimitive.int)
                    ws.send("""{"type":"protocol.error","code":"protocol_version_mismatch","message":"Protocol version mismatch"}""")
                }
            }
        }))
        server.enqueue(MockResponse().withWebSocketUpgrade(peer))
        server.start()
        val http = OkHttpClient()
        val client = RelayClient(http)
        val messages = LinkedBlockingQueue<String>()
        try {
            connect(client, server, messages, closed)
            assertTrue(peer.ready.await(5, TimeUnit.SECONDS))
            assertEquals(18, attempts.poll(1, TimeUnit.SECONDS))
            assertEquals(19, peer.authentication.poll(1, TimeUnit.SECONDS))
            assertEquals(2, server.requestCount)
            assertTrue(client.sendDeviceMessage(buildJsonObject { put("type", "session.list"); put("protocolVersion", 19); put("requestId", "only-once") }))
            assertEquals(19, Json.parseToJsonElement(peer.received.poll(3, TimeUnit.SECONDS)!!.second.toString(Charsets.UTF_8)).jsonObject["protocolVersion"]!!.jsonPrimitive.int)
            assertEquals(0, closed.get())
            assertFalse(messages.any { it.contains("protocol.error") })
            assertTrue(peer.errors.isEmpty())
        } finally { close(client, peer, server, http) }
    }

    @Test fun credentialRejectionDoesNotRetryAnotherVersion() {
        val server = MockWebServer()
        val closed = CountDownLatch(1)
        server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
            override fun onMessage(ws: WebSocket, text: String) {
                if (!text.contains("device.authenticate")) return
                ws.send("""{"type":"protocol.error","code":"unauthorized","message":"Invalid device credential"}""")
                ws.close(1008, "unauthorized")
            }
            override fun onClosing(ws: WebSocket, code: Int, reason: String) { ws.close(code, reason) }
        }))
        server.start()
        val http = OkHttpClient(); val client = RelayClient(http)
        try {
            client.connect(DeviceCredential("ws://127.0.0.1:${server.port}", "phone", "bad"),
                onMessage = { _, _ -> }, onOpen = {}, onClosed = { closed.countDown() },
                e2eOptions = options())
            assertTrue(closed.await(4, TimeUnit.SECONDS))
            assertEquals(1, server.requestCount)
        } finally { client.disconnect(); server.close(); http.dispatcher.executorService.shutdownNow(); http.connectionPool.evictAll() }
    }

    @Test fun strictLan18WorksWithoutRelayAndReceivesNoRelayCredential() {
        val peer = StrictPeer(18, direct = true)
        val relay = MockWebServer(); relay.enqueue(MockResponse().setResponseCode(503)); relay.start()
        val server = MockWebServer(); server.enqueue(MockResponse().withWebSocketUpgrade(peer)); server.start()
        val http = OkHttpClient(); val client = RelayClient(http); val selected = CountDownLatch(1)
        client.onPathChanged = { path, _ -> if (path == "lan") selected.countDown() }
        try {
            client.connect(DeviceCredential("ws://127.0.0.1:${relay.port}", "phone", "relay-secret"),
                onMessage = { _, _ -> }, onOpen = {}, onClosed = {},
                e2eOptions = options(listOf(LanEndpoint("127.0.0.1", server.port))))
            assertTrue(peer.ready.await(4, TimeUnit.SECONDS))
            peer.sendJson("""{"type":"device.path","protocolVersion":18,"path":"lan"}""")
            assertTrue(selected.await(3, TimeUnit.SECONDS))
            assertTrue(client.sendDeviceMessage(buildJsonObject { put("type", "session.list"); put("protocolVersion", 19); put("requestId", "lan-18") }))
            assertEquals(18, Json.parseToJsonElement(peer.received.poll(3, TimeUnit.SECONDS)!!.second.toString(Charsets.UTF_8)).jsonObject["protocolVersion"]!!.jsonPrimitive.int)
            assertTrue(client.sendUploadChunk("runtime", "upload", 0, byteArrayOf(4)))
            assertEquals(18.toByte(), peer.received.poll(3, TimeUnit.SECONDS)!!.second[4])
            assertTrue(peer.authentication.isEmpty())
            assertTrue(peer.errors.isEmpty())
        } finally { close(client, peer, server, http); relay.close() }
    }

    @Test fun strictLan19IsProbedOnlyAfterAnUnconfirmedHs1TimesOut() {
        val ignored = LinkedBlockingQueue<JsonObject>()
        val peer = StrictPeer(19, direct = true)
        val relay = MockWebServer(); relay.enqueue(MockResponse().setResponseCode(503)); relay.start()
        val server = MockWebServer()
        server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
            override fun onMessage(ws: WebSocket, text: String) { ignored.add(Json.parseToJsonElement(text).jsonObject) }
            override fun onClosing(ws: WebSocket, code: Int, reason: String) { ws.close(code, reason) }
        }))
        server.enqueue(MockResponse().withWebSocketUpgrade(peer)); server.start()
        val http = OkHttpClient(); val client = RelayClient(http); val selected = CountDownLatch(1)
        client.onPathChanged = { path, _ -> if (path == "lan") selected.countDown() }
        try {
            client.connect(DeviceCredential("ws://127.0.0.1:${relay.port}", "phone", "relay-secret"),
                onMessage = { _, _ -> }, onOpen = {}, onClosed = {},
                e2eOptions = options(listOf(LanEndpoint("127.0.0.1", server.port))))
            assertTrue("A fresh 19 handshake must follow the unanswered 18 HS1", peer.ready.await(8, TimeUnit.SECONDS))
            assertEquals(2, server.requestCount)
            assertEquals(1, ignored.size)
            val probe = ignored.single()
            assertEquals(18, probe["protocolVersion"]!!.jsonPrimitive.int)
            val envelope = E2eJson.json.decodeFromJsonElement<EnvelopeV2>(probe["envelope"]!!)
            assertEquals("hs1", PlaintextEnvelope.read<HandshakeHello>(envelope, "hs").type)
            peer.sendJson("""{"type":"device.path","protocolVersion":19,"path":"lan"}""")
            assertTrue(selected.await(3, TimeUnit.SECONDS))
            assertTrue(client.sendDeviceMessage(buildJsonObject { put("type", "session.list"); put("protocolVersion", 19); put("requestId", "lan-19") }))
            assertEquals(19, Json.parseToJsonElement(peer.received.poll(3, TimeUnit.SECONDS)!!.second.toString(Charsets.UTF_8)).jsonObject["protocolVersion"]!!.jsonPrimitive.int)
            assertTrue(peer.errors.isEmpty())
        } finally { close(client, peer, server, http); relay.close() }
    }

    private fun options(endpoints: List<LanEndpoint> = emptyList()) = E2eConnectOptions(
        "host", "phone", X25519KeyPair.generate(), pskRoot = psk, lanEndpoints = endpoints)

    private fun connect(client: RelayClient, server: MockWebServer, messages: LinkedBlockingQueue<String>, closed: AtomicInteger) {
        client.connect(DeviceCredential("ws://127.0.0.1:${server.port}", "phone", "relay-secret"),
            onMessage = { text, channel -> if (channel != null) messages.add(text) },
            onOpen = {}, onClosed = { closed.incrementAndGet() }, e2eOptions = options())
    }

    private fun withConnection(peer: StrictPeer, block: (RelayClient, LinkedBlockingQueue<String>, LinkedBlockingQueue<ByteArray>) -> Unit) {
        val server = MockWebServer(); server.enqueue(MockResponse().withWebSocketUpgrade(peer)); server.start()
        val http = OkHttpClient(); val client = RelayClient(http)
        val messages = LinkedBlockingQueue<String>(); val binaries = LinkedBlockingQueue<ByteArray>()
        try {
            client.connect(DeviceCredential("ws://127.0.0.1:${server.port}", "phone", "relay-secret"),
                onMessage = { text, channel -> if (channel != null) messages.add(text) }, onBinaryMessage = { binaries.add(it) },
                onOpen = {}, onClosed = {}, e2eOptions = options())
            block(client, messages, binaries)
            val download = binaries.poll(3, TimeUnit.SECONDS)
            assertNotNull("legacy download chunk must be delivered", download)
            assertArrayEquals(byteArrayOf(3, 2, 1), decodeArtifactChunkFrame(download!!).data)
        } finally { close(client, peer, server, http) }
    }

    private fun close(client: RelayClient, peer: StrictPeer, server: MockWebServer, http: OkHttpClient) {
        client.disconnect(); peer.socket?.close(1000, "test done"); server.close()
        http.dispatcher.executorService.shutdownNow(); http.connectionPool.evictAll()
    }

    private inner class StrictPeer(val version: Int, val direct: Boolean = false) : WebSocketListener() {
        val ready = CountDownLatch(1)
        val authentication = LinkedBlockingQueue<Int>()
        val received = LinkedBlockingQueue<Pair<String, ByteArray>>()
        val errors = LinkedBlockingQueue<String>()
        @Volatile var socket: WebSocket? = null
        private val keyPair = X25519KeyPair.generate()
        private var keys: SessionKeys? = null
        private var devicePublic: ByteArray? = null
        private var channel: E2eChannel? = null
        private val pieces = EnvelopeReassembler()
        override fun onOpen(ws: WebSocket, response: Response) { socket = ws }
        override fun onClosing(ws: WebSocket, code: Int, reason: String) { ws.close(code, reason) }
        override fun onMessage(ws: WebSocket, text: String) {
            try {
                val value = Json.parseToJsonElement(text).jsonObject
                check(value["protocolVersion"]!!.jsonPrimitive.int == version) { "wrong outer version: $text" }
                if (value["type"]!!.jsonPrimitive.content == "device.authenticate") {
                    check(!direct)
                    check(value.keys == setOf("type", "protocolVersion", "credential"))
                    authentication.add(version)
                    ws.send("""{"type":"device.ready","protocolVersion":$version,"deviceId":"phone","notificationEpoch":null,"runtimes":[],"agents":null}""")
                    return
                }
                check(value.keys == setOf("type", "protocolVersion", "envelope"))
                val frame = E2eJson.decode<V2Frame>(text, "v2.frame")
                val envelope = pieces.accept(frame.envelope) ?: return
                if (envelope.hdr.k == "hs") {
                    if (keys == null) {
                        val hello = PlaintextEnvelope.read<HandshakeHello>(envelope, "hs")
                        devicePublic = Crypto.fromBase64Url(hello.ePubD, "ePubD")
                        val derived = HandshakeE2e.deriveSessionKeys(Crypto.deriveSharedSecret(keyPair.privateRaw, devicePublic!!), psk, keyPair.publicRaw, devicePublic!!)
                        keys = derived
                        sendFrame(PlaintextEnvelope.build("hs", "host", "host", "phone", HandshakeAcceptBody("hs2", Crypto.toBase64Url(keyPair.publicRaw),
                            Crypto.toBase64Url(HandshakeE2e.handshakeMacFromHost(derived, keyPair.publicRaw, devicePublic!!)))))
                    } else {
                        val confirm = PlaintextEnvelope.read<HandshakeConfirmBody>(envelope, "hs")
                        check(Crypto.constantTimeEqual(Crypto.fromBase64Url(confirm.macD, "macD"), HandshakeE2e.handshakeMacFromDevice(keys!!, keyPair.publicRaw, devicePublic!!)))
                        channel = E2eChannel(keys!!, E2eChannel.ROLE_HOST)
                        sendJson("""{"type":"device.ready","protocolVersion":$version,"deviceId":"phone","notificationEpoch":null,"runtimes":[],"agents":[]}""")
                        ready.countDown()
                    }
                } else {
                    val bytes = channel!!.open(envelope) ?: return
                    if (envelope.hdr.k == "data") {
                        val payload = Json.parseToJsonElement(bytes.toString(Charsets.UTF_8)).jsonObject
                        if (payload.containsKey("protocolVersion")) check(payload["protocolVersion"]!!.jsonPrimitive.int == version) { "wrong inner version: $payload" }
                        if (payload["type"]!!.jsonPrimitive.content == "host.lan.request") return
                    }
                    if (envelope.hdr.k == "bin") check(bytes[4] == version.toByte())
                    received.add(envelope.hdr.k to bytes)
                }
            } catch (error: Throwable) { errors.add(error.message ?: error.toString()); ws.close(1008, "invalid_message") }
        }
        fun sendJson(text: String) = sendFrame(channel!!.seal("data", "host", "host", "phone", text.toByteArray(), "ctl"))
        fun sendChunk(bytes: ByteArray) = sendFrame(channel!!.seal("bin", "host", "host", "phone", bytes, "bulk"))
        private fun sendFrame(envelope: EnvelopeV2) {
            for (piece in EnvelopePieces.fragment(envelope)) check(socket!!.send(E2eJson.json.encodeToString(V2Frame("v2.frame", version, piece))))
        }
    }
}
