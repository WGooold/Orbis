package dev.pi.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class RelayStunTest {
    @Test fun `official relay uses UDP origin and other deployments retain their host`() {
        assertEquals("74.81.55.191", relayStunHost("wss://orbising.com/relay"))
        assertEquals("relay.example.com", relayStunHost("wss://relay.example.com/relay"))
        assertEquals("orbising.com.example.com", relayStunHost("wss://orbising.com.example.com"))
        assertNull(relayStunHost("not a URL"))
    }
}
