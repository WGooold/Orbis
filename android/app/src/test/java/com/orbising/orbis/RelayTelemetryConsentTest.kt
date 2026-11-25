package com.orbising.orbis

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RelayTelemetryConsentTest {
    @Test fun readsAndWritesConsentUsingPairedCredentialAndRelayPrefix() = runBlocking {
        val server = MockWebServer()
        server.start()
        try {
            val relayUrl = server.url("/relay/").toString().replaceFirst("http://", "ws://").trimEnd('/')
            val device = DeviceCredential(relayUrl, "device-1", "credential-secret")
            val client = RelayClient()

            server.enqueue(MockResponse().setBody("{\"enabled\":true}").addHeader("Content-Type", "application/json"))
            assertTrue(client.telemetryConsent(device) == true)
            val get = server.takeRequest()
            assertEquals("GET", get.method)
            assertEquals("/relay/v1/device/telemetry-consent", get.path)
            assertEquals("Bearer credential-secret", get.getHeader("Authorization"))

            server.enqueue(MockResponse().setBody("{\"enabled\":false}").addHeader("Content-Type", "application/json"))
            assertFalse(client.setTelemetryConsent(device, false)!!)
            val put = server.takeRequest()
            assertEquals("PUT", put.method)
            assertEquals("/relay/v1/device/telemetry-consent", put.path)
            assertEquals("Bearer credential-secret", put.getHeader("Authorization"))
            assertEquals("{\"enabled\":false}", put.body.readUtf8())
        } finally { server.shutdown() }
    }

    @Test fun recognizesRelaysThatDoNotImplementTheSetting() = runBlocking {
        val server = MockWebServer()
        server.start()
        try {
            val relayUrl = server.url("/").toString().replaceFirst("http://", "ws://").trimEnd('/')
            server.enqueue(MockResponse().setResponseCode(404))
            assertNull(RelayClient().telemetryConsent(DeviceCredential(relayUrl, "device-1", "credential-secret")))
        } finally { server.shutdown() }
    }
}
