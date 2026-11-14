package com.orbising.orbis

import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.*
import okhttp3.OkHttpClient
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test

/** SC88: actual Android sockets/crypto against unchanged published Host codecs.
 * The shared, parameterized runner supplies isolated release modules and evidence
 * paths. It never connects to a live Host or reads production user state. */
class PublishedHostNegotiationTest {
    @Test fun installedCompatibleHostKeepsTasksOverRelay18() = verify("relay", "compatible", 18)
    @Test fun installedCompatibleHostKeepsTasksOverRelay19() = verify("relay", "compatible", 19)
    @Test fun installedCompatibleHostKeepsTasksOverLan() = verify("lan", "compatible", 19)
    @Test fun strictReleased18KeepsCommandsAndFilesOverRelay19() = verify("relay", "strict18", 19)
    @Test fun strictReleased18FallsBackOnLan() = verify("lan", "strict18", 18)
    @Test fun strict19PositiveControl() = verify("relay", "strict19", 19)
    @Test fun sameClientRenegotiatesAfterHostUpgradeAndRollback() = verify("relay", "strict18", 18, reconnect = true)

    private fun verify(path: String, host: String, outer: Int, reconnect: Boolean = false) {
        val fixture = System.getenv("ORBIS_NEGOTIATION_NODE_FIXTURE")
        assumeTrue("Requires the isolated published-Host negotiation fixture", fixture != null)
        val process = ProcessBuilder("node", fixture!!, "--path", path, "--host", host, "--outer", outer.toString())
            .redirectErrorStream(true).start()
        val output = process.inputStream.bufferedReader()
        val http = OkHttpClient(); val client = RelayClient(http)
        val messages = LinkedBlockingQueue<String>(); val chunks = LinkedBlockingQueue<ByteArray>()
        fun take(type: String): String {
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(12)
            while (System.nanoTime() < deadline) {
                val text = messages.poll(100, TimeUnit.MILLISECONDS) ?: continue
                val parsed = Json.parseToJsonElement(text).jsonObject
                assertNotEquals(text, "protocol.error", parsed["type"]?.jsonPrimitive?.content)
                if (parsed["type"]?.jsonPrimitive?.content == type) return text
            }
            error("Missing $type from $host/$path/$outer")
        }
        fun instruction(command: String) { process.outputStream.write((command + "\n").toByteArray()); process.outputStream.flush() }
        try {
            val hello = Json.parseToJsonElement(output.readLine()).jsonObject
            val port = hello["port"]!!.jsonPrimitive.int
            client.connect(DeviceCredential("ws://127.0.0.1:$port", "phone", "synthetic-credential"),
                onMessage = { text, channel -> if (channel != null) messages.add(text) },
                onBinaryMessage = { chunks.add(it) }, onOpen = {}, onClosed = {},
                e2eOptions = E2eConnectOptions("host", "phone", X25519KeyPair.generate(), pskRoot = ByteArray(32) { (it + 7).toByte() },
                    lanEndpoints = if (path == "lan") listOf(LanEndpoint("127.0.0.1", port)) else emptyList()))
            val versions = if (reconnect) listOf(18, 19, 18) else listOf(if (host == "strict18") 18 else 19)
            for ((generation, version) in versions.withIndex()) {
                if (generation > 0) instruction("reconnect")
                assertEquals(version, Json.parseToJsonElement(take("device.ready")).jsonObject["protocolVersion"]!!.jsonPrimitive.int)
                for (kind in listOf("pi", "claude", "codex", "codexDesktop", "dsh")) {
                    val id = "tasks-$generation-$kind"
                    assertTrue(client.sendDeviceMessage(buildJsonObject {
                        put("type", "agent.state.request"); put("protocolVersion", PROTOCOL_VERSION); put("requestId", id)
                        put("scope", "agent"); put("runtimeId", "runtime"); put("sessionId", "session"); put("agentKind", kind)
                        put("domains", JsonArray(listOf(JsonPrimitive("execution"))))
                    }))
                    val snapshot = take("agent.state.snapshot")
                    val state = RemoteState(hostId = "host", runtimes = mapOf("runtime" to
                        RuntimeSummary("runtime", kind, "/synthetic", "running", sessionId = "session", agentKind = kind)), agentStateRequests = setOf(id))
                    val tasks = RelayReducer().reduce(state, snapshot, channel = "ctl").runtimes["runtime"]?.backgroundTasks
                    if (version == 18) assertNull(tasks) else {
                        assertEquals(snapshot, true, tasks?.visible)
                        assertEquals("child", tasks?.items?.single()?.id)
                    }
                }
                val id = "command-$generation"
                assertEquals(id, client.sendUserMessage("runtime", "synthetic", "message-$generation", commandId = id))
                assertEquals(id, Json.parseToJsonElement(take("runtime.event")).jsonObject["event"]!!.jsonObject["commandId"]!!.jsonPrimitive.content)
                assertTrue(client.sendUploadChunk("runtime", "upload", 0, byteArrayOf(1, 2, 3)))
                val bytes = chunks.poll(4, TimeUnit.SECONDS)!!
                assertEquals(version.toByte(), bytes[4])
                assertArrayEquals(byteArrayOf(1, 2, 3), decodeArtifactChunkFrame(bytes).data)
            }
        } finally {
            client.disconnect(); http.dispatcher.executorService.shutdownNow(); http.connectionPool.evictAll()
            runCatching { instruction("stop"); process.outputStream.close() }
            if (!process.waitFor(5, TimeUnit.SECONDS)) { process.destroyForcibly(); process.waitFor(5, TimeUnit.SECONDS) }
        }
        val result = Json.parseToJsonElement(output.readText().trim().lines().last()).jsonObject
        assertEquals(result.toString(), 0, process.exitValue())
        assertTrue(result.toString(), result["errors"]!!.jsonArray.isEmpty())
        val commands = result["commands"]!!.jsonArray
        assertEquals(if (reconnect) 3 else 1, commands.size)
        assertEquals(commands.size, commands.map { it.jsonObject["id"] }.toSet().size)
    }
}
