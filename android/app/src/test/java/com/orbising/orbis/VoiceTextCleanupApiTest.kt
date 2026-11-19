package com.orbising.orbis

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import java.util.concurrent.atomic.AtomicInteger

class VoiceTextCleanupApiTest {
    private val config = VoiceCleanupApiConfig("https://example.com/edit", "model", "test-key")

    @Test fun customRequestTreatsTranscriptAsJsonData() {
        val custom = config.copy(custom = VoiceCleanupJsonFormat(
            """{"x-api-key":"{{key}}"}""", """{"input":"{{transcript}}"}""", "/content/0/text",
        ))
        val transcript = "引号 \"\\\n{{model}}"
        val request = VoiceTextCleanupApi.makeRequest(custom, transcript)
        val body = Buffer().also { requireNotNull(request.body).writeTo(it) }.readUtf8()
        assertEquals("POST", request.method)
        assertEquals("test-key", request.header("x-api-key"))
        assertEquals(transcript, Json.parseToJsonElement(body).jsonObject.getValue("input").jsonPrimitive.content)
        assertEquals("保留原意。", VoiceTextCleanupApi.parseResponse(custom, transcript, """{"content":[{"text":"保留原意。"}]}"""))
        assertFalse(VoiceTextCleanupApi.isValid(custom.copy(endpoint = "http://example.com/edit")))
    }

    @Test fun unconfiguredCleanupDoesNotRequestAndRedirectUsesRules() = runBlocking {
        val requests = AtomicInteger()
        val api = VoiceTextCleanupApi(OkHttpClient.Builder().addInterceptor { chain ->
            requests.incrementAndGet()
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1)
                .code(302).message("Found").header("Location", "https://another.example/edit")
                .body("{}".toResponseBody("application/json".toMediaType())).build()
        }.build())
        val input = "嗯，明天见！"
        assertEquals(VoiceTextCleanupResult("明天见！", VoiceCleanupMethod.Rules), api.clean(input, null))
        assertEquals(0, requests.get())
        assertEquals(VoiceTextCleanupResult("明天见！", VoiceCleanupMethod.ApiFallback), api.clean(input, config))
        assertEquals(1, requests.get())
    }
}
