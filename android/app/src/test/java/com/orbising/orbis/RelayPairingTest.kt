package com.orbising.orbis

import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RelayPairingTest {
    @Test
    fun `expired or consumed pairing code explains how to retry`() = runBlocking {
        val server = MockWebServer()
        server.enqueue(
            MockResponse()
                .setResponseCode(401)
                .setBody("""{"error":"invalid_pairing_code"}"""),
        )
        server.start()

        try {
            val relayUrl = server.url("/").toString().replaceFirst("http://", "ws://")
            val error = runCatching { RelayClient(http = OkHttpClient()).pair(relayUrl, "PAIR1234", "Pixel") }.exceptionOrNull()

            assertEquals(
                "配对码已失效、已被使用或电脑端账号已停用：请确认电脑端可用并重新生成二维码",
                error?.message,
            )
            assertEquals("/v1/pairings", server.takeRequest().path)
        } finally {
            server.shutdown()
        }
    }
}
