package dev.pi.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class StatusScreenTest {

    private fun pairing(hostId: String? = "host-1", pskRootPresent: Boolean = true) = PairingStatus(
        relayUrl = "wss://relay.example.com",
        deviceId = "device-1",
        hostId = hostId,
        hostPublicKeyFingerprint = "abc123",
        pskRootPresent = pskRootPresent,
    )

    /**
     * 半配对（有 hostId、缺 pskRoot）的手机会连上中继，只是永远建不起加密通道。这最容易被误诊成
     * "电脑没在听"——状态页必须优先给出"重新配对"，而不是通用的握手超时文案。
     */
    @Test
    fun `incomplete pairing outranks the handshake-stall advice`() {
        val state = RemoteState(
            connection = RelayConnection.ONLINE,
            deviceId = "device-1",
            hostId = "host-1",
            e2eReady = false,
        )

        val advice = statusAdvice(state, pairing(pskRootPresent = false))
        assertTrue(advice!!.contains("配对不完整"))

        assertEquals("缺少加密材料", pairingText(pairing(pskRootPresent = false)))

        // 配对材料完整时，才轮到在线但握手未成的通用提示。
        val handshake = statusAdvice(state, pairing())
        assertTrue(handshake!!.contains("端到端加密握手"))

        // 一切就绪就没有提示。
        assertEquals(null, statusAdvice(state.copy(e2eReady = true), pairing()))
    }
}
