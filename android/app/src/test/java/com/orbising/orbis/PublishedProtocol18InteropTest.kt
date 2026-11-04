package com.orbising.orbis

import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.*
import okhttp3.OkHttpClient
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test

/** Optional local integration with the unchanged published Host-18 modules, never its live process.
 * The verification runner supplies an isolated Node peer, with no production state or credentials. */
class PublishedProtocol18InteropTest {
    @Test fun `production Android transport interoperates with frozen Host 18 schema and crypto`() {
        val fixture = System.getenv("ORBIS_LEGACY18_NODE_FIXTURE")
        assumeTrue("Requires an explicitly supplied frozen Host-18 local fixture", fixture != null)
        val process = ProcessBuilder("node", fixture!!).redirectErrorStream(true).start()
        val output = process.inputStream.bufferedReader()
        val http = OkHttpClient(); val client = RelayClient(http)
        val messages = LinkedBlockingQueue<String>(); val chunks = LinkedBlockingQueue<ByteArray>()
        try {
            val hello = Json.parseToJsonElement(output.readLine()).jsonObject
            assertEquals(18, hello["protocol"]!!.jsonPrimitive.int)
            val port = hello["port"]!!.jsonPrimitive.int
            client.connect(DeviceCredential("ws://127.0.0.1:$port", "phone", "fixture-credential"),
                onMessage = { text, channel -> if (channel != null) messages.add(text) },
                onBinaryMessage = { chunks.add(it) }, onOpen = {}, onClosed = {},
                e2eOptions = E2eConnectOptions("host", "phone", X25519KeyPair.generate(), pskRoot = ByteArray(32) { (it + 7).toByte() }))
            val ready = Json.parseToJsonElement(messages.poll(5, TimeUnit.SECONDS)!!).jsonObject
            assertEquals("device.ready", ready["type"]!!.jsonPrimitive.content)
            assertEquals(18, ready["protocolVersion"]!!.jsonPrimitive.int)
            for (request in listOf(
                """{"type":"agent.state.request","protocolVersion":19,"requestId":"model","scope":"host","domains":["identity"]}""",
                """{"type":"notification.sync","protocolVersion":19,"runtimeId":"runtime"}""",
                """{"type":"session.list","protocolVersion":19,"requestId":"sessions"}""",
                """{"type":"artifact.read","protocolVersion":19,"requestId":"read","transferId":"download","offset":0,"length":3}""",
            )) assertTrue(client.sendDeviceMessage(Json.parseToJsonElement(request).jsonObject))
            assertEquals("command-fixed", client.sendUserMessage("runtime", "hello", "message-fixed", commandId = "command-fixed"))
            val receipt = Json.parseToJsonElement(messages.poll(4, TimeUnit.SECONDS)!!).jsonObject
            assertEquals("command-fixed", receipt["event"]!!.jsonObject["commandId"]!!.jsonPrimitive.content)
            assertTrue(receipt["event"]!!.jsonObject["ok"]!!.jsonPrimitive.boolean)
            assertTrue(client.sendUploadChunk("runtime", "upload", 0, byteArrayOf(1, 2, 3)))
            val download = decodeArtifactChunkFrame(chunks.poll(4, TimeUnit.SECONDS)!!)
            assertEquals("download", download.transferId)
            assertArrayEquals(byteArrayOf(1, 2, 3), download.data)
        } finally {
            client.disconnect(); http.dispatcher.executorService.shutdownNow(); http.connectionPool.evictAll()
            runCatching { process.outputStream.write(1); process.outputStream.flush() }
            if (!process.waitFor(5, TimeUnit.SECONDS)) { process.destroyForcibly(); process.waitFor(5, TimeUnit.SECONDS) }
        }
        val lines = output.readText().trim().lines()
        val result = Json.parseToJsonElement(lines.last()).jsonObject
        assertEquals(result.toString(), 0, process.exitValue())
        assertTrue(result.toString(), result["errors"]!!.jsonArray.isEmpty())
        assertEquals(1, result["authenticated"]!!.jsonPrimitive.int)
        assertEquals(1, result["handshakes"]!!.jsonPrimitive.int)
        assertEquals(1, result["uploads"]!!.jsonPrimitive.int)
        assertEquals(5, result["payloads"]!!.jsonArray.size)
    }
}
