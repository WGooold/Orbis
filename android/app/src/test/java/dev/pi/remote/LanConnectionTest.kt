package dev.pi.remote

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class LanConnectionTest {
    private val psk = ByteArray(32) { (it + 1).toByte() }

    @Test
    fun `paired client discovers LAN and routes encrypted commands and files on the announced path`() {
        val relayServer = MockWebServer()
        val lanServer = MockWebServer()
        val relayHost = HostPeer()
        val lanHost = HostPeer(direct = true)
        val resumedRelay = HostPeer()
        val resumedLan = HostPeer(direct = true)
        relayServer.enqueue(MockResponse().withWebSocketUpgrade(relayHost))
        relayServer.enqueue(MockResponse().withWebSocketUpgrade(resumedRelay))
        lanServer.enqueue(MockResponse().withWebSocketUpgrade(lanHost))
        lanServer.enqueue(MockResponse().withWebSocketUpgrade(resumedLan))
        relayServer.start()
        lanServer.start()
        val http = OkHttpClient()
        val client = RelayClient(http)
        val messages = LinkedBlockingQueue<String>()
        val binaries = LinkedBlockingQueue<ByteArray>()
        val lanSelected = CountDownLatch(1)
        val relaySelected = CountDownLatch(1)
        val closed = AtomicInteger()
        client.onPathChanged = { path, _ ->
            if (path == "lan") lanSelected.countDown()
            if (path == "relay") relaySelected.countDown()
        }
        try {
            client.connect(
                DeviceCredential("ws://127.0.0.1:${relayServer.port}", "phone", "relay-only-secret"),
                onMessage = { text, _ -> messages.add(text) },
                onBinaryMessage = { binaries.add(it) },
                onOpen = {}, onClosed = { closed.incrementAndGet() },
                e2eOptions = E2eConnectOptions("host", "phone", X25519KeyPair.generate(), pskRoot = psk),
            )
            assertTrue("Relay handshake", relayHost.ready.await(3, TimeUnit.SECONDS))
            relayHost.send("""{"type":"host.lan","protocolVersion":$PROTOCOL_VERSION,"endpoints":[{"host":"127.0.0.1","port":${lanServer.port}}]}""")
            assertTrue("LAN must connect and authenticate after receiving the paired Host's endpoints", lanHost.ready.await(3, TimeUnit.SECONDS))
            assertEquals("/v1/lan", lanServer.takeRequest(1, TimeUnit.SECONDS)?.path)
            lanHost.send("""{"type":"device.path","protocolVersion":$PROTOCOL_VERSION,"path":"lan"}""")
            assertTrue(lanSelected.await(3, TimeUnit.SECONDS))
            assertTrue(client.sendDeviceMessage(buildJsonObject { put("type", "session.list"); put("requestId", "lan-command") }))
            assertTrue(lanHost.received.poll(3, TimeUnit.SECONDS)!!.second.toString(Charsets.UTF_8).contains("lan-command"))
            val chunk = ByteArray(20_000) { it.toByte() }
            assertTrue(client.sendUploadChunk("host", "upload", 0, chunk))
            val upload = lanHost.received.poll(3, TimeUnit.SECONDS)!!
            assertEquals("bin", upload.first)
            assertArrayEquals(encodeArtifactChunkFrame("host", "upload", 0, chunk), upload.second)
            lanHost.send("{\"type\":\"lan-response\"}")
            assertEquals("{\"type\":\"lan-response\"}", messages.poll(3, TimeUnit.SECONDS))
            lanHost.sendBytes(chunk)
            assertArrayEquals(chunk, binaries.poll(3, TimeUnit.SECONDS))

            // Losing/reconnecting Relay must leave the authenticated LAN channel and its sequences alive.
            relayHost.socket!!.close(1000, "relay outage")
            assertTrue(resumedRelay.ready.await(5, TimeUnit.SECONDS))
            assertTrue(client.hasE2eChannel())
            assertEquals("lan", client.activePath)
            assertTrue(client.sendDeviceMessage(buildJsonObject { put("type", "still-on-lan") }))
            assertTrue(lanHost.received.poll(3, TimeUnit.SECONDS)!!.second.toString(Charsets.UTF_8).contains("still-on-lan"))
            assertEquals(0, closed.get())

            // LAN loss falls back to the still-live Relay; LAN retries without reconnecting the whole client.
            val lanDown = CountDownLatch(1)
            client.onE2eStateChanged = { lanDown.countDown() }
            lanHost.socket!!.close(1000, "wifi outage")
            assertTrue(lanDown.await(3, TimeUnit.SECONDS))
            resumedRelay.send("""{"type":"device.path","protocolVersion":$PROTOCOL_VERSION,"path":"relay"}""")
            assertTrue(relaySelected.await(3, TimeUnit.SECONDS))
            assertTrue(client.sendDeviceMessage(buildJsonObject { put("type", "relay-fallback") }))
            assertTrue(resumedRelay.received.poll(3, TimeUnit.SECONDS)!!.second.toString(Charsets.UTF_8).contains("relay-fallback"))
            assertTrue(resumedLan.ready.await(7, TimeUnit.SECONDS))
            // A newly authenticated path does not select itself: only the Host's announcement does.
            assertEquals("relay", client.activePath)
            assertEquals(0, closed.get())
        } finally {
            client.disconnect()
            relayHost.socket?.close(1000, "test done")
            lanHost.socket?.close(1000, "test done")
            resumedRelay.socket?.close(1000, "test done")
            resumedLan.socket?.close(1000, "test done")
            relayServer.close()
            lanServer.close()
            http.dispatcher.executorService.shutdownNow()
            http.connectionPool.evictAll()
        }
    }

    @Test
    fun `cached LAN works without Relay and rejects a peer without the pairing key`() {
        val relayServer = MockWebServer()
        val impostorServer = MockWebServer()
        val lanServer = MockWebServer()
        val impostor = HostPeer(direct = true, root = ByteArray(32) { 99 })
        val host = HostPeer(direct = true)
        relayServer.enqueue(MockResponse().setResponseCode(503))
        impostorServer.enqueue(MockResponse().withWebSocketUpgrade(impostor))
        lanServer.enqueue(MockResponse().withWebSocketUpgrade(host))
        relayServer.start()
        impostorServer.start()
        lanServer.start()
        val http = OkHttpClient()
        val client = RelayClient(http)
        val selected = CountDownLatch(1)
        client.onPathChanged = { path, _ -> if (path == "lan") selected.countDown() }
        try {
            client.connect(
                DeviceCredential("ws://127.0.0.1:${relayServer.port}", "phone", "relay-only-secret"),
                onMessage = { _, _ -> }, onOpen = {}, onClosed = {},
                e2eOptions = E2eConnectOptions("host", "phone", X25519KeyPair.generate(), pskRoot = psk,
                    lanEndpoints = listOf(LanEndpoint("127.0.0.1", impostorServer.port), LanEndpoint("127.0.0.1", lanServer.port))),
            )
            assertTrue("LAN must work even if the Relay's first connection fails", host.ready.await(3, TimeUnit.SECONDS))
            assertEquals("Untrusted LAN must never receive HS3", 1L, impostor.ready.count)
            assertTrue(impostor.received.isEmpty())
            host.send("""{"type":"device.path","protocolVersion":$PROTOCOL_VERSION,"path":"lan"}""")
            assertTrue(selected.await(3, TimeUnit.SECONDS))
            assertTrue(client.sendDeviceMessage(buildJsonObject { put("type", "lan-without-relay") }))
            assertTrue(host.received.poll(3, TimeUnit.SECONDS)!!.second.toString(Charsets.UTF_8).contains("lan-without-relay"))
        } finally {
            client.disconnect()
            impostor.socket?.close(1000, "done")
            host.socket?.close(1000, "done")
            relayServer.close()
            impostorServer.close()
            lanServer.close()
            http.dispatcher.executorService.shutdownNow()
            http.connectionPool.evictAll()
        }
    }

    /** Real WS + HS1/2/3 + encryption. The LAN peer rejects relay authentication and plaintext. */
    private inner class HostPeer(private val direct: Boolean = false, private val root: ByteArray = psk) : WebSocketListener() {
        val ready = CountDownLatch(1)
        val received = LinkedBlockingQueue<Pair<String, ByteArray>>()
        @Volatile var socket: WebSocket? = null
        private val keyPair = X25519KeyPair.generate()
        private var keys: SessionKeys? = null
        private var devicePublic: ByteArray? = null
        private var channel: E2eChannel? = null
        private val pieces = EnvelopeReassembler()

        override fun onOpen(webSocket: WebSocket, response: Response) { socket = webSocket }
        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, reason) }

        override fun onMessage(webSocket: WebSocket, text: String) {
            if (text.contains("device.authenticate")) {
                check(!direct) { "Relay credentials must never be sent to LAN" }
                return
            }
            val envelope = pieces.accept(E2eJson.decode<V2Frame>(text, "v2.frame").envelope) ?: return
            if (envelope.hdr.k == "hs") {
                if (keys == null) {
                    val hello = PlaintextEnvelope.read<HandshakeHello>(envelope, "hs")
                    devicePublic = Crypto.fromBase64Url(hello.ePubD, "ePubD")
                    val derived = HandshakeE2e.deriveSessionKeys(
                        Crypto.deriveSharedSecret(keyPair.privateRaw, devicePublic!!), root, keyPair.publicRaw, devicePublic!!,
                    )
                    keys = derived
                    sendFrame(PlaintextEnvelope.build("hs", "host", "host", "phone", HandshakeAcceptBody(
                        "hs2", Crypto.toBase64Url(keyPair.publicRaw),
                        Crypto.toBase64Url(HandshakeE2e.handshakeMacFromHost(derived, keyPair.publicRaw, devicePublic!!)),
                    )))
                } else {
                    val confirm = PlaintextEnvelope.read<HandshakeConfirmBody>(envelope, "hs")
                    check(Crypto.constantTimeEqual(Crypto.fromBase64Url(confirm.macD, "macD"),
                        HandshakeE2e.handshakeMacFromDevice(keys!!, keyPair.publicRaw, devicePublic!!)))
                    channel = E2eChannel(keys!!, E2eChannel.ROLE_HOST)
                    ready.countDown()
                }
            } else {
                val bytes = channel!!.open(envelope) ?: return
                if (!bytes.toString(Charsets.UTF_8).contains("host.lan.request")) received.add(envelope.hdr.k to bytes)
            }
        }

        fun send(text: String) = sendFrame(channel!!.seal("data", "host", "host", "phone", text.toByteArray(), "ctl"))
        fun sendBytes(bytes: ByteArray) = sendFrame(channel!!.seal("bin", "host", "host", "phone", bytes, "bulk"))
        private fun sendFrame(envelope: EnvelopeV2) {
            for (piece in EnvelopePieces.fragment(envelope)) {
                check(socket!!.send(E2eJson.json.encodeToString(V2Frame("v2.frame", PROTOCOL_VERSION, piece))))
            }
        }
    }
}
