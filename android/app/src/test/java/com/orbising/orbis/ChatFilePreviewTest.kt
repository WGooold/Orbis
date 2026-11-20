package com.orbising.orbis

import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.*
import org.junit.Test

class ChatFilePreviewTest {
    private class Peer(scope: kotlinx.coroutines.CoroutineScope) {
        val sent = CopyOnWriteArrayList<JsonObject>()
        var clock = 0L
        var pressure = false
        val receiver = ChatFilePreview(scope, "host", { sent.add(it) }, { pressure }, { clock }, automaticTick = false)
        val key = ChatFilePreview.Key("session", "message:0", ChatFilePreview.Source(reference = "orbis-message-file:test"), "report.html")
        val commandId get() = sent.last().getValue("commandId").jsonPrimitive.content
        val reads get() = sent.filter { it["type"]?.jsonPrimitive?.content == "artifact.read" }
        fun offer(command: String, transfer: String, data: ByteArray, hash: String = digest(data),
                  reference: String? = key.source.reference, size: Int = data.size) = buildJsonObject {
            put("type", "file.preview.started"); put("protocolVersion", PROTOCOL_VERSION); put("runtimeId", "host")
            put("commandId", command); put("transferId", transfer); put("format", "html")
            put("referenceId", reference); put("artifactId", UUID.randomUUID().toString()); put("size", size); put("sha256", hash)
        }
    }

    // SC116 / SC118: no prefetch, bound/range only when selected, then verify and reuse.
    @Test fun verifiesOneRangeAtATimeAndReusesFullScreenSnapshot() = runBlocking {
        val peer = Peer(this)
        val receiver = peer.receiver
        receiver.authenticated(true)
        assertTrue(peer.sent.isEmpty())
        receiver.open(peer.key)
        assertEquals(ChatFilePreview.MAX_BYTES, peer.sent.last().getValue("command").jsonObject.getValue("maxBytes").jsonPrimitive.int)
        val transfer = UUID.randomUUID().toString()
        val first = ("<!doctype html><p>" + "x".repeat(ChatFilePreview.RANGE_BYTES)).toByteArray().copyOf(ChatFilePreview.RANGE_BYTES)
        val tail = "</p>".toByteArray()
        val bytes = first + tail
        assertTrue(receiver.consume(peer.offer(peer.commandId, transfer, bytes)))
        peer.pressure = true
        receiver.tick(); assertTrue(peer.reads.isEmpty())
        peer.clock = 400
        receiver.tick(); receiver.tick(); assertEquals(1, peer.reads.size)
        assertEquals(ChatFilePreview.RANGE_BYTES, peer.reads.single().getValue("length").jsonPrimitive.int)
        receiver.consume(ArtifactChunkFrame("foreign", transfer, 0, first)); assertEquals(1, peer.reads.size)
        receiver.consume(ArtifactChunkFrame("host", transfer, 0, first))
        peer.clock = 800
        receiver.tick(); assertEquals(2, peer.reads.size)
        assertEquals(first.size, peer.reads.last().getValue("offset").jsonPrimitive.int)
        receiver.consume(ArtifactChunkFrame("host", transfer, first.size.toLong(), tail))
        withTimeout(2_000) { while (peer.sent.last()["type"]?.jsonPrimitive?.content != "artifact.done") delay(5) }
        val ready = checkNotNull(receiver.selection.value)
        assertEquals(ChatFilePreview.Phase.READY, ready.phase)
        assertArrayEquals(bytes, ready.document)
        val sent = peer.sent.size
        assertTrue(receiver.setFullScreen(ready.id, true)); assertTrue(receiver.setFullScreen(ready.id, false))
        receiver.tick(); assertEquals(sent, peer.sent.size)
    }

    // SC117 / SC120: retired transfers never reach the current preview or ordinary download schedule.
    @Test fun lateOfferAfterClosingOnlyCancelsAndOldHostDoesNotDownload() = runBlocking {
        val peer = Peer(this)
        val receiver = peer.receiver
        receiver.authenticated(false)
        receiver.open(peer.key)
        assertTrue(peer.sent.isEmpty())
        assertEquals(ChatFilePreview.Phase.UNAVAILABLE, receiver.selection.value?.phase)
        receiver.authenticated(true)
        receiver.open(peer.key)
        val command = peer.commandId
        receiver.fileHidden(peer.key, receiver.selection.value!!.id)
        assertEquals(ChatFilePreview.Phase.INTERRUPTED, receiver.selection.value?.phase)
        receiver.open(peer.key.copy(block = "message:1"))
        val second = peer.commandId
        val bytes = "<p>Safe</p>".toByteArray(); val transfer = UUID.randomUUID().toString()
        assertTrue(receiver.consume(peer.offer(command, transfer, bytes)))
        assertEquals(transfer, peer.sent.last()["command"]?.jsonObject?.get("transferId")?.jsonPrimitive?.content)
        assertFalse(receiver.consume(ArtifactChunkFrame("host", transfer, 0, bytes)))
        assertEquals("message:1", receiver.selection.value?.key?.block)
        receiver.resetConnection(); receiver.authenticated(true)
        receiver.consume(peer.offer(second, UUID.randomUUID().toString(), bytes)); receiver.tick()
        assertTrue(peer.reads.isEmpty())
        assertEquals(ChatFilePreview.Phase.INTERRUPTED, receiver.selection.value?.phase)
    }

    // SC118 / SC119: accept neither inconsistent metadata nor bytes with the wrong digest.
    @Test fun rejectsBadIdentityDigestAndBoundsRetries() = runBlocking {
        val peer = Peer(this)
        val receiver = peer.receiver
        val bytes = "<p>Safe</p>".toByteArray()
        receiver.authenticated(true); receiver.open(peer.key)
        receiver.consume(peer.offer(peer.commandId, UUID.randomUUID().toString(), bytes, reference = "wrong"))
        assertEquals(ChatFilePreview.Phase.UNSUPPORTED, receiver.selection.value?.phase)
        assertTrue(peer.reads.isEmpty())
        receiver.open(peer.key)
        val transfer = UUID.randomUUID().toString()
        receiver.consume(peer.offer(peer.commandId, transfer, bytes, hash = "0".repeat(64)))
        receiver.tick()
        receiver.consume(ArtifactChunkFrame("host", transfer, 0, bytes))
        withTimeout(2_000) { while (receiver.selection.value?.phase == ChatFilePreview.Phase.LOADING) delay(5) }
        assertEquals(ChatFilePreview.Phase.UNSUPPORTED, receiver.selection.value?.phase)
        assertNull(receiver.selection.value?.document)
        receiver.open(peer.key)
        receiver.consume(peer.offer(peer.commandId, UUID.randomUUID().toString(), bytes))
        for (ms in listOf(0L, 1500L, 4500L, 9000L)) { peer.clock = ms; receiver.tick() }
        assertEquals(3, peer.reads.drop(1).size)
        assertEquals(ChatFilePreview.Phase.INTERRUPTED, receiver.selection.value?.phase)
        assertTrue(peer.sent.none { it["type"]?.jsonPrimitive?.content == "artifact.done" })
    }
}

private fun digest(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
