package dev.pi.remote

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class QrPairingTest {
    @Test
    fun `accepts a local relay pairing payload`() {
        val result = parsePairingQrPayload(
            """{"version":1,"relayUrl":"ws://192.168.0.103:8787","code":"Y9JD6NDP"}""",
        )

        assertEquals("ws://192.168.0.103:8787", result?.relayUrl)
        assertEquals("Y9JD6NDP", result?.code)
    }

    @Test
    fun `LAN addresses survive pairing and identity persistence including publicly numbered campus networks`() {
        val key = Crypto.toBase64Url(ByteArray(32) { 1 })
        val qr = parsePairingQrV2("""{
            "v":2,"relayUrl":"wss://relay.example.com","code":"PAIR1234",
            "hostId":"host","hostName":"computer","hostPub":"$key","psk":"$key","exp":9999999999999,
            "lan":[{"host":"113.54.199.142","port":42130},{"host":"192.168.1.2","port":42130},
                   {"host":"bad/path","port":42130},{"host":"192.168.1.2","port":0}]
        }""")!!
        val saved = HostIdentity(qr.hostId, qr.hostPub, key, lanEndpoints = qr.lan)
        val restored = Json.decodeFromString<HostIdentity>(Json.encodeToString(saved))
        assertEquals(listOf(LanEndpoint("113.54.199.142", 42130), LanEndpoint("192.168.1.2", 42130)), restored.lanEndpoints)
        // Already-paired phones can still load their identity and then ask the Host for addresses.
        assertEquals(emptyList<LanEndpoint>(), Json.decodeFromString<HostIdentity>(
            """{"hostId":"host","hostPub":"$key","pskRoot":"$key"}""",
        ).lanEndpoints)
    }

    @Test
    fun `rejects malformed or public cleartext pairing payloads`() {
        assertNull(parsePairingQrPayload("not-json"))
        assertNull(parsePairingQrPayload(
            """{"version":2,"relayUrl":"ws://192.168.0.103:8787","code":"Y9JD6NDP"}""",
        ))
        assertNull(parsePairingQrPayload(
            """{"version":1,"relayUrl":"ws://relay.example.com:8787","code":"Y9JD6NDP"}""",
        ))
        assertNull(parsePairingQrPayload(
            """{"version":1,"relayUrl":"ws://192.168.0.103:8787","code":"bad code"}""",
        ))
    }
}
