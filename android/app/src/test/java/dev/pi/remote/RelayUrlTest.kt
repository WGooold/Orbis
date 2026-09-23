package dev.pi.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RelayUrlTest {
    @Test
    fun `allows encrypted relays and local cleartext relays`() {
        assertTrue(isSupportedRelayUrl("wss://relay.example.com"))
        assertTrue(isSupportedRelayUrl("ws://127.0.0.1:8787"))
        assertTrue(isSupportedRelayUrl("ws://192.168.0.103:8787"))
        assertTrue(isSupportedRelayUrl("ws://10.0.2.2:8787"))
        assertTrue(isSupportedRelayUrl("ws://relay.local:8787"))
    }

    @Test
    fun `rejects public cleartext and non websocket URLs`() {
        assertFalse(isSupportedRelayUrl("ws://relay.example.com"))
        assertFalse(isSupportedRelayUrl("http://127.0.0.1:8787"))
        assertFalse(isSupportedRelayUrl("not a URL"))
    }

    @Test
    fun `maps websocket URLs to their matching HTTP pairing endpoint`() {
        assertEquals("https://relay.example.com", "wss://relay.example.com/".toHttpBase())
        assertEquals("http://192.168.0.103:8787", "ws://192.168.0.103:8787/".toHttpBase())
    }
}
