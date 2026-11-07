package com.orbising.orbis

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

        assertEquals("需要重新配对", pairingText(pairing(pskRootPresent = false)))

        // 配对材料完整时，才轮到在线但握手未成的通用提示。
        val handshake = statusAdvice(state, pairing())
        assertTrue(handshake!!.contains("请确认电脑上的 Orbis Host 已打开"))

        // 一切就绪就没有提示。
        assertEquals(null, statusAdvice(state.copy(e2eReady = true), pairing()))
    }

    @Test
    fun `secured LAN stays connected when relay is offline`() {
        val state = RemoteState(connection = RelayConnection.OFFLINE, e2eReady = true, path = "lan")

        assertEquals("已连接", connectionStatusText(state))
        assertEquals(null, statusAdvice(state, pairing()))
    }

    @Test
    fun `connection latency shows host RTT or an unavailable value`() {
        assertEquals("暂不可用", connectionLatencyText(RemoteState(pathRttMs = 42L)))
        assertEquals("暂不可用", connectionLatencyText(RemoteState(e2eReady = true)))
        assertEquals("暂不可用", connectionLatencyText(RemoteState(e2eReady = true, pathRttMs = -1L)))
        assertEquals("0 ms", connectionLatencyText(RemoteState(e2eReady = true, pathRttMs = 0L)))
        assertEquals("42 ms", connectionLatencyText(RemoteState(e2eReady = true, pathRttMs = 42L)))
    }

    /** S28 / SC48：实际协议随 Relay 切换，LAN 不误用备用 Relay 的 QUIC，断线不展示旧值。 */
    @Test
    fun `connection protocol follows the active path and actual adapter`() {
        val state = RemoteState(e2eReady = true, path = "relay", relayTransportKind = RelayTransportKind.WS)
        assertEquals("WS", connectionProtocolText(state))
        assertEquals("QUIC", connectionProtocolText(state.copy(relayTransportKind = RelayTransportKind.QUIC)))
        assertEquals("WS", connectionProtocolText(state.copy(path = "lan", relayTransportKind = RelayTransportKind.QUIC)))
        assertEquals("WS", connectionProtocolText(state.copy(path = "lan", relayTransportKind = null, connection = RelayConnection.OFFLINE)))
        assertEquals("暂不可用", connectionProtocolText(state.copy(e2eReady = false)))
        assertEquals("暂不可用", connectionProtocolText(state.copy(relayTransportKind = null)))
    }

    /** NQ-16 / S29：缺省选 Auto，说明使用 WS，实际连接协议继续单独展示。 */
    @Test
    fun `relay mode descriptions distinguish auto ws and quic`() {
        assertEquals(RelayTransportMode.AUTO, RemoteState().relayTransportMode)
        assertEquals("自动模式使用 WS", relayTransportModeDescription(RelayTransportMode.AUTO))
        assertEquals("强制使用 WS", relayTransportModeDescription(RelayTransportMode.WS))
        assertEquals("强制使用 QUIC；准备失败时保留当前连接并报告错误", relayTransportModeDescription(RelayTransportMode.QUIC))
    }
}
