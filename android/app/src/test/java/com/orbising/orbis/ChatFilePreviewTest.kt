package com.orbising.orbis

import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.zip.Deflater
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

/** FILE-PREVIEW-03 receiver: the same cases as the iOS `ChatFilePreviewTests`. */
class ChatFilePreviewTest {
    private class Peer(scope: kotlinx.coroutines.CoroutineScope) {
        val sent = CopyOnWriteArrayList<JsonObject>()
        var clock = 0L
        var pressure = false
        val receiver = ChatFilePreview(scope, "host", { sent.add(it) }, { pressure }, { clock }, automaticTick = false)
        val reference = "orbis-message-file:test"
        fun key(name: String = "report.html", block: String = "message:0", session: String = "session") =
            ChatFilePreview.Key(session, block, ChatFilePreview.Source(reference = reference), name)
        val commands get() = sent.filter { it["type"]?.jsonPrimitive?.content == "runtime.command" }
        val command get() = commands.last().getValue("command").jsonObject
        val commandId get() = commands.last().getValue("commandId").jsonPrimitive.content
        val web get() = command["web"]?.jsonObject
        val transfer get() = web!!.getValue("transferId").jsonPrimitive.content
        val reads get() = sent.filter { it["type"]?.jsonPrimitive?.content == "artifact.read" }
        val cancels get() = commands.mapNotNull { message ->
            message.getValue("command").jsonObject.takeIf { it["type"]?.jsonPrimitive?.content == "artifact.cancel" }
                ?.getValue("transferId")?.jsonPrimitive?.content
        }
        fun started(command: String, transfer: String, body: ByteArray, wire: ByteArray? = null, resource: String = "report.html",
                    mime: String = "text/html; charset=utf-8", notModified: Boolean = false, hash: String = digest(body)) = buildJsonObject {
            put("type", "file.preview.started"); put("protocolVersion", PROTOCOL_VERSION); put("runtimeId", "host")
            put("commandId", command); put("transferId", transfer); put("format", "web"); put("referenceId", reference)
            put("artifactId", UUID.randomUUID().toString()); put("size", (wire ?: body).size); put("contentSize", body.size)
            put("encoding", if (wire == null) "identity" else "deflate-raw"); put("mimeType", mime); put("resource", resource)
            put("sha256", hash); if (notModified) put("notModified", true)
        }
        fun chunk(transfer: String, offset: Int, data: ByteArray) = ArtifactChunkFrame("host", transfer, offset.toLong(), data)
    }

    private suspend fun settle(receiver: ChatFilePreview) = withTimeout(2_000) {
        while (receiver.selection.value?.phase == ChatFilePreview.Phase.LOADING) delay(5)
    }
    private fun page(size: Int): ByteArray {
        val random = java.util.Random(7)
        val start = "<!doctype html><script>document.title='x'</script>".toByteArray()
        return (start + ByteArray(size) { (97 + random.nextInt(26)).toByte() }).copyOf(size)
    }
    private fun deflate(data: ByteArray): ByteArray {
        val deflater = Deflater(6, true)
        deflater.setInput(data); deflater.finish()
        val output = ByteArray(data.size + 1024)
        val count = deflater.deflate(output); deflater.end()
        return output.copyOf(count)
    }

    // SC124 / SC126: the range sent with the reply may arrive first; the rest is pulled through a window that narrows
    // while the chat is busy, and the original page becomes the card's entry once verified.
    @Test fun entryUsesThePushedRangeAndABoundedWindow() = runBlocking {
        val peer = Peer(this)
        val receiver = peer.receiver
        receiver.authenticated(true)
        assertTrue(peer.sent.isEmpty())
        receiver.open(peer.key())
        assertNull(peer.command["maxBytes"]); assertNull(peer.command["previewFormat"])
        assertNull(peer.web!!["resource"]); assertNull(peer.web!!["ifNoneMatch"])
        val transfer = peer.transfer
        val body = page(ChatFilePreview.RANGE_BYTES * 2 + 100)
        assertTrue(receiver.consume(peer.chunk(transfer, 0, body.copyOf(ChatFilePreview.RANGE_BYTES))))
        peer.pressure = true
        assertTrue(receiver.consume(peer.started(peer.commandId, transfer, body)))
        assertEquals(1, peer.reads.size)
        assertEquals(ChatFilePreview.RANGE_BYTES, peer.reads[0].getValue("offset").jsonPrimitive.int)
        assertEquals(ChatFilePreview.Progress(ChatFilePreview.RANGE_BYTES, body.size), receiver.selection.value?.progress)
        peer.pressure = false
        receiver.consume(peer.chunk(transfer, ChatFilePreview.RANGE_BYTES, body.copyOfRange(ChatFilePreview.RANGE_BYTES, 2 * ChatFilePreview.RANGE_BYTES)))
        assertEquals(2, peer.reads.size); assertEquals(100, peer.reads[1].getValue("length").jsonPrimitive.int)
        receiver.consume(peer.chunk(transfer, 2 * ChatFilePreview.RANGE_BYTES, body.copyOfRange(2 * ChatFilePreview.RANGE_BYTES, body.size)))
        settle(receiver)
        val ready = checkNotNull(receiver.selection.value)
        assertEquals(ChatFilePreview.Phase.READY, ready.phase)
        assertArrayEquals(body, ready.entry?.body); assertEquals("report.html", ready.entry?.path); assertNull(ready.document)
        withTimeout(2_000) { while (peer.sent.last()["type"]?.jsonPrimitive?.content != "artifact.done") delay(5) }
        assertEquals(body.size, receiver.knownSize(ChatFilePreview.Source(reference = peer.reference)))
        val sent = peer.sent.size
        assertTrue(receiver.setFullScreen(ready.id, true)); assertTrue(receiver.setFullScreen(ready.id, false))
        receiver.tick(); assertEquals(sent, peer.sent.size)
    }

    // SC126: compressed bodies decode to exactly the declared length and digest; anything else is never shown.
    @Test fun compressedBodiesAreCheckedAfterDecoding() = runBlocking {
        val peer = Peer(this)
        val receiver = peer.receiver
        val body = "<p>row</p>\n".repeat(20_000).toByteArray()
        val wire = deflate(body)
        assertTrue(wire.size < body.size / 10)
        assertArrayEquals(body, ChatFilePreview.inflate(wire, body.size))
        assertNull(ChatFilePreview.inflate(wire, body.size - 1))
        assertNull(ChatFilePreview.inflate(wire, body.size + 1))
        receiver.authenticated(true); receiver.open(peer.key())
        var transfer = peer.transfer
        receiver.consume(peer.started(peer.commandId, transfer, body, wire))
        receiver.consume(peer.chunk(transfer, 0, wire))
        settle(receiver)
        assertArrayEquals(body, receiver.selection.value?.entry?.body)
        receiver.open(peer.key(block = "other"))
        transfer = peer.transfer
        receiver.consume(peer.started(peer.commandId, transfer, body, wire, hash = "0".repeat(64)))
        receiver.consume(peer.chunk(transfer, 0, wire))
        settle(receiver)
        assertEquals(ChatFilePreview.Phase.UNSUPPORTED, receiver.selection.value?.phase)
        assertNull(receiver.selection.value?.entry)
    }

    // SC125 / SC126: files are fetched only when the page asks, once per path, at most four at a time,
    // and reopening revalidates by digest instead of downloading again.
    @Test fun pageFilesAreFetchedOnDemandAndRevalidated() = runBlocking {
        val peer = Peer(this)
        val receiver = peer.receiver
        receiver.authenticated(true); receiver.open(peer.key())
        val entry = page(400)
        val css = "p{color:red}".toByteArray()
        var transfer = peer.transfer
        receiver.consume(peer.started(peer.commandId, transfer, entry))
        receiver.consume(peer.chunk(transfer, 0, entry))
        settle(receiver)
        val id = receiver.selection.value!!.id
        val results = CopyOnWriteArrayList<ByteArray?>()
        receiver.resource(id, "/report.html") { results += it?.body }
        assertArrayEquals(entry, results.last())
        val before = peer.commands.size
        receiver.resource(id, "/style.css") { results += it?.body }
        receiver.resource(id, "style.css") { results += it?.body }
        assertEquals(before + 1, peer.commands.size); assertEquals("style.css", peer.web!!.getValue("resource").jsonPrimitive.content)
        transfer = peer.transfer
        receiver.consume(peer.started(peer.commandId, transfer, css, resource = "style.css", mime = "text/css; charset=utf-8"))
        receiver.consume(peer.chunk(transfer, 0, css))
        withTimeout(2_000) { while (results.size < 3) delay(5) }
        assertTrue(results.drop(1).all { it.contentEquals(css) })
        repeat(6) { receiver.resource(id, "image$it.png") { results += it?.body } }
        assertEquals(before + 1 + ChatFilePreview.CONCURRENT_FETCHES, peer.commands.size)

        receiver.open(peer.key())
        assertEquals(digest(entry), peer.web!!.getValue("ifNoneMatch").jsonPrimitive.content)
        val reads = peer.reads.size
        receiver.consume(peer.started(peer.commandId, peer.transfer, entry, notModified = true))
        assertEquals(ChatFilePreview.Phase.READY, receiver.selection.value?.phase)
        assertArrayEquals(entry, receiver.selection.value?.entry?.body)
        var cached: ByteArray? = null
        receiver.resource(receiver.selection.value!!.id, "style.css") { cached = it?.body }
        assertEquals(digest(css), peer.web!!.getValue("ifNoneMatch").jsonPrimitive.content)
        receiver.consume(peer.started(peer.commandId, peer.transfer, css, resource = "style.css", mime = "text/css; charset=utf-8", notModified = true))
        assertArrayEquals(css, cached); assertEquals(reads, peer.reads.size)
    }

    // SC127: closing cancels every response the page owns, including ones the Host has not acknowledged;
    // late replies are cancelled again and late ranges never reach a card or a download.
    @Test fun closingCancelsOwnedTransfersAndIgnoresLateData() = runBlocking {
        val peer = Peer(this)
        val receiver = peer.receiver
        receiver.authenticated(true); receiver.open(peer.key())
        val retired = peer.commandId
        val transfer = peer.transfer
        receiver.close()
        assertEquals(listOf(transfer), peer.cancels)
        receiver.open(peer.key(block = "message:1"))
        val body = page(200)
        assertTrue(receiver.consume(peer.started(retired, transfer, body)))
        assertEquals(listOf(transfer, transfer), peer.cancels)
        assertTrue(receiver.consume(peer.chunk(transfer, 0, body)))
        assertEquals("message:1", receiver.selection.value?.key?.block)
        assertEquals(ChatFilePreview.Phase.LOADING, receiver.selection.value?.phase)
        assertFalse(receiver.consume(peer.chunk(UUID.randomUUID().toString(), 0, body)))
    }

    // SC117: loading stops when the card leaves the viewport or the link drops; a verified page stays readable.
    @Test fun loadingStopsButAVerifiedPageSurvivesReconnection() = runBlocking {
        val peer = Peer(this)
        val receiver = peer.receiver
        receiver.authenticated(true); receiver.open(peer.key())
        val loading = receiver.selection.value!!
        receiver.fileHidden(loading.key, loading.id)
        assertEquals(ChatFilePreview.Phase.INTERRUPTED, receiver.selection.value?.phase); assertEquals(1, peer.cancels.size)
        receiver.open(peer.key())
        val body = page(300)
        val transfer = peer.transfer
        receiver.consume(peer.started(peer.commandId, transfer, body))
        receiver.consume(peer.chunk(transfer, 0, body))
        settle(receiver)
        val ready = receiver.selection.value!!
        var pending: Boolean? = null
        receiver.resource(ready.id, "slow.css") { pending = it == null }
        receiver.fileHidden(ready.key, ready.id)
        receiver.resetConnection()
        assertEquals(true, pending)
        assertEquals(ChatFilePreview.Phase.READY, receiver.selection.value?.phase)
        assertArrayEquals(body, receiver.selection.value?.entry?.body)
        receiver.open(peer.key(block = "next"))
        receiver.resetConnection()
        assertEquals(ChatFilePreview.Phase.INTERRUPTED, receiver.selection.value?.phase)
    }

    // SC120 / SC127: a Host without the path keeps the card a download; failures map to their reason;
    // a stalled range is retried a bounded number of times.
    @Test fun capabilityFailureReasonsAndBoundedRetry() = runBlocking {
        val peer = Peer(this)
        val receiver = peer.receiver
        receiver.authenticated(false, true)
        assertFalse(receiver.offersPreview("report.html")); assertTrue(receiver.offersPreview("notes.txt"))
        receiver.open(peer.key())
        assertTrue(peer.sent.isEmpty()); assertEquals(ChatFilePreview.Phase.UNAVAILABLE, receiver.selection.value?.phase)
        receiver.authenticated(true)
        receiver.open(peer.key())
        receiver.consume(buildJsonObject {
            put("type", "file.preview.failed"); put("protocolVersion", PROTOCOL_VERSION); put("runtimeId", "host")
            put("commandId", peer.commandId); put("reason", "too_large")
        })
        assertEquals(ChatFilePreview.Phase.TOO_LARGE, receiver.selection.value?.phase)
        receiver.open(peer.key())
        val transfer = peer.transfer
        val body = page(ChatFilePreview.RANGE_BYTES + 10)
        receiver.consume(peer.started(peer.commandId, transfer, body))
        receiver.consume(peer.chunk(transfer, 0, body.copyOf(ChatFilePreview.RANGE_BYTES)))
        assertEquals(1, peer.reads.size)
        for (seconds in listOf(3L, 9L, 21L, 45L, 93L)) { peer.clock = seconds * 1000; receiver.tick() }
        assertEquals(4, peer.reads.size)
        assertEquals(ChatFilePreview.Phase.INTERRUPTED, receiver.selection.value?.phase)
        assertFalse(peer.sent.any { it["type"]?.jsonPrimitive?.content == "artifact.done" })
    }

    // SC122 / SC120: native limits require their own capability and video opens only after verification.
    @Test fun nativePreviewNeedsV2AndChecksContentBeforeOpeningVideo() = runBlocking {
        val peer = Peer(this)
        val receiver = peer.receiver
        val key = peer.key("clip.MP4", block = "clip")
        receiver.authenticated(true, false)
        receiver.open(key)
        assertTrue(peer.sent.isEmpty())
        receiver.authenticated(true, true)
        receiver.open(key)
        assertEquals("mp4", peer.command.getValue("previewFormat").jsonPrimitive.content)
        assertEquals(16 * 1024 * 1024, peer.command.getValue("maxBytes").jsonPrimitive.int); assertNull(peer.web)
        fun ready(bytes: ByteArray, transfer: String) = buildJsonObject {
            put("type", "file.preview.started"); put("protocolVersion", PROTOCOL_VERSION); put("runtimeId", "host")
            put("commandId", peer.commandId); put("transferId", transfer); put("format", "mp4"); put("referenceId", peer.reference)
            put("artifactId", UUID.randomUUID().toString()); put("size", bytes.size); put("sha256", digest(bytes))
        }
        val fake = "fakeMp4Bytes".toByteArray()
        val first = UUID.randomUUID().toString()
        receiver.consume(ready(fake, first))
        assertEquals(1, peer.reads.size); assertEquals(0, peer.reads[0].getValue("offset").jsonPrimitive.int)
        receiver.consume(peer.chunk(first, 0, fake))
        settle(receiver)
        assertEquals(ChatFilePreview.Phase.UNSUPPORTED, receiver.selection.value?.phase)
        receiver.open(key)
        val bytes = byteArrayOf(0, 0, 0, 12) + "ftypisom".toByteArray()
        val second = UUID.randomUUID().toString()
        receiver.consume(ready(bytes, second))
        receiver.consume(peer.chunk(second, 0, bytes))
        settle(receiver)
        assertEquals(ChatFilePreview.Phase.READY, receiver.selection.value?.phase)
        assertTrue(receiver.selection.value!!.fullScreen)
        assertArrayEquals(bytes, receiver.selection.value?.document)
    }

    // The WebView guard keeps a doctype first so the page stays in standards mode.
    @Test fun guardScriptFollowsTheDoctype() {
        val guarded = String(PreviewWebOwner.guarded("<!DOCTYPE html><html><p>x</p></html>".toByteArray()))
        assertTrue(guarded.startsWith("<!DOCTYPE html><script>"))
        assertTrue(String(PreviewWebOwner.guarded("<p>x</p>".toByteArray())).startsWith("<script>"))
    }
}

private fun digest(data: ByteArray) = MessageDigest.getInstance("SHA-256").digest(data).joinToString("") { "%02x".format(it) }
