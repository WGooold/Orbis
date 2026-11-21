package com.orbising.orbis

import android.graphics.Bitmap
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.security.MessageDigest
import java.util.UUID
import java.util.zip.DataFormatException
import java.util.zip.Inflater
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put

/**
 * FILE-PREVIEW-01/02/03. No download records or conversation sequence positions are owned here.
 *
 * Web pages (FILE-PREVIEW-03) render the original files in an offline WebView: the entry is fetched when the user
 * opens the card, and each other file only when that WebView asks for it. Every response is one bounded transfer
 * whose first range arrives with the Host's reply; the rest is pulled through a small window shared by the page.
 */
internal class ChatFilePreview(
    private val scope: CoroutineScope,
    private val hostId: String,
    // Outbound transport never queues preview traffic behind an unfinished handshake.
    private val send: (JsonObject) -> Boolean,
    private val pressure: () -> Boolean,
    private val now: () -> Long = { android.os.SystemClock.elapsedRealtime() },
    private val automaticTick: Boolean = true,
) {
    companion object {
        const val FEATURE = "file.preview-web-v1"
        const val NATIVE_FEATURE = "file.preview-v2"
        const val RANGE_BYTES = 128 * 1024
        /** Requested but undelivered bytes for the open preview; the chat's own sync traffic narrows it. */
        const val WINDOW_BYTES = 4 * RANGE_BYTES
        const val INTERACTIVE_WINDOW_BYTES = RANGE_BYTES
        const val CONCURRENT_FETCHES = 4
        /** Per opened page: encoded bytes fetched and files requested. Beyond these the WebView receives 404s. */
        const val PAGE_BYTES = 32 * 1024 * 1024
        const val PAGE_RESOURCES = 256
        /** Verified web bodies kept for revalidation by digest while this connection lives. */
        const val CACHE_BYTES = 24 * 1024 * 1024
        const val WEB_ENTRY_BYTES = 4 * 1024 * 1024
        const val WEB_RESOURCE_BYTES = 8 * 1024 * 1024
        fun format(name: String): String? = FilePreviewFormat.fromName(name)?.wire

        /** Raw DEFLATE with an exact decoded length; anything longer or shorter is rejected. */
        fun inflate(data: ByteArray, expected: Int): ByteArray? {
            if (expected <= 0 || data.isEmpty()) return null
            val inflater = Inflater(true)
            return try {
                // `nowrap` streams may need one trailing byte to report completion.
                inflater.setInput(data + 0)
                val output = ByteArray(expected + 1)
                var count = 0
                while (!inflater.finished() && count < output.size) {
                    val read = inflater.inflate(output, count, output.size - count)
                    if (read == 0 && (inflater.needsInput() || inflater.needsDictionary())) break
                    count += read
                }
                if (count == expected && inflater.finished()) output.copyOf(expected) else null
            } catch (_: DataFormatException) { null } finally { inflater.end() }
        }
    }

    data class Source(val reference: String? = null, val artifactId: String? = null) {
        val identity get() = reference?.let { "r:$it" } ?: "a:$artifactId"
    }
    data class Key(val session: String, val block: String, val source: Source, val name: String)
    enum class Phase { LOADING, READY, UNAVAILABLE, UNSUPPORTED, TOO_LARGE, INTERRUPTED }
    data class Progress(val received: Int, val total: Int)
    /** A verified, decoded body. `path` is relative to the page's site root. */
    class WebResource(val path: String, val mimeType: String, val body: ByteArray, val sha256: String)
    /** Optimistic until a Host answers, so cards do not change shape while the connection starts. */
    data class Availability(val web: Boolean = true, val native: Boolean = true)
    data class Selection(val key: Key, val id: String, val phase: Phase = Phase.LOADING,
        /** Native formats: the verified file. Web pages keep their entry in [entry]. */
        val document: ByteArray? = null, val fullScreen: Boolean = false, val progress: Progress? = null,
        val entry: WebResource? = null,
        /** The inline card shows this still image of the rendered page instead of a live WebView. */
        val snapshot: Bitmap? = null)

    private class Range(val id: String, val length: Int, val sentAt: Long, val retries: Int)
    private class Fetch(var transfer: String?, val resource: String?, val known: WebResource?, val issued: Long) {
        val command = "preview:${UUID.randomUUID()}"
        var accepted = false
        var verifying = false
        var size = 0
        var contentSize = 0
        var hash = ""
        var encoding = "identity"
        var mimeType = ""
        var path = ""
        val parts = HashMap<Int, ByteArray>()
        var next = 0
        var delivered = 0
        val outstanding = HashMap<Int, Range>()
    }
    private class Active(val id: String, val key: Key, val format: FilePreviewFormat, now: Long) {
        val page = UUID.randomUUID().toString()
        val fetches = ArrayList<Fetch>()
        val queued = ArrayDeque<String>()
        val waiting = HashMap<String, MutableList<(WebResource?) -> Unit>>()
        val resources = HashMap<String, WebResource>()
        var fetchedBytes = 0
        var requested = 0
        var lastChunk = now
    }
    /** Work decided under the lock and performed after it: wire sends and callbacks never run while holding it. */
    private class Effects {
        val sends = ArrayList<Pair<JsonObject, Fetch?>>()
        val calls = ArrayList<() -> Unit>()
    }

    private val lock = Any()
    private var active: Active? = null
    private val retired = LinkedHashMap<String, Long>()
    private val retiredTransfers = LinkedHashMap<String, Long>()
    private val cache = LinkedHashMap<String, WebResource>(16, 0.75f, true)
    private val sizes = HashMap<String, Int>()
    private var timer: Job? = null
    private val mutable = MutableStateFlow<Selection?>(null)
    private val availabilityState = MutableStateFlow(Availability())
    val selection = mutable.asStateFlow()
    /** The last authenticated Host's capabilities. Cards without a supported path only offer the download. */
    val availability = availabilityState.asStateFlow()

    private inline fun <T> locked(block: Effects.() -> T): T {
        val effects = Effects()
        val result = synchronized(lock) { effects.block() }
        perform(effects)
        return result
    }
    private fun perform(effects: Effects) {
        for ((message, fetch) in effects.sends) {
            if (!send(message) && fetch != null) locked { activeFor(fetch)?.let { finishLocked(it, fetch, null, Phase.INTERRUPTED) } }
        }
        for (call in effects.calls) call()
    }
    private fun activeFor(fetch: Fetch): Active? = active?.takeIf { it.fetches.any { owned -> owned === fetch } }

    fun offersPreview(name: String): Boolean {
        val format = FilePreviewFormat.fromName(name) ?: return false
        return if (format.web) availabilityState.value.web else availabilityState.value.native
    }
    /** Decoded size from an earlier response for this file, shown on the collapsed card. */
    fun knownSize(source: Source): Int? = synchronized(lock) { sizes[source.identity] }

    /** Loading stops; a verified page stays readable from memory, and only its pending files end. */
    fun resetConnection() = locked {
        val opened = active
        if (mutable.value?.phase == Phase.LOADING) failLocked(Phase.INTERRUPTED)
        else if (opened != null) for (fetch in opened.fetches.toList()) finishLocked(opened, fetch, null, Phase.INTERRUPTED)
        retired.clear(); retiredTransfers.clear()
    }

    fun authenticated(supportsPreview: Boolean, supportsNativePreview: Boolean = false) = locked {
        availabilityState.value = Availability(supportsPreview, supportsNativePreview)
        val current = mutable.value
        val format = current?.key?.name?.let(FilePreviewFormat::fromName)
        if (current != null && format != null && !(if (format.web) supportsPreview else supportsNativePreview) &&
            current.phase in setOf(Phase.LOADING, Phase.READY)) failLocked(Phase.UNAVAILABLE)
    }

    fun open(key: Key) {
        val format = FilePreviewFormat.fromName(key.name) ?: return
        if ((key.source.reference == null) == (key.source.artifactId == null)) return
        locked {
            stopLocked()
            val id = UUID.randomUUID().toString()
            if (!offersPreview(key.name)) { mutable.value = Selection(key, id, Phase.UNAVAILABLE); return@locked }
            val opened = Active(id, key, format, now())
            active = opened
            mutable.value = Selection(key, id)
            val fetch = Fetch(if (format.web) UUID.randomUUID().toString() else null, null,
                if (format.web) cache[cacheKey(opened, null)] else null, now())
            issueLocked(opened, fetch)
            if (automaticTick) timer = scope.launch(Dispatchers.Default) {
                while (isActive) { delay(100); tick() }
            }
        }
    }

    fun close(key: Key? = null) = locked {
        if (key != null && mutable.value?.key != key) return@locked
        stopLocked()
        mutable.value = null
    }

    fun closeSession(session: String) = locked {
        if (mutable.value?.key?.session != session) return@locked
        stopLocked()
        mutable.value = null
    }

    /** Loading stops when the card leaves the viewport; a verified page stays until it is collapsed. */
    fun fileHidden(key: Key, id: String) = locked {
        val current = mutable.value
        if (current?.key == key && current.id == id && current.phase == Phase.LOADING) failLocked(Phase.INTERRUPTED)
    }

    fun setFullScreen(id: String, open: Boolean): Boolean = synchronized(lock) {
        val current = mutable.value?.takeIf { it.id == id && it.phase == Phase.READY } ?: return false
        mutable.value = current.copy(fullScreen = open)
        true
    }

    fun setSnapshot(id: String, image: Bitmap) {
        synchronized(lock) {
            val current = mutable.value?.takeIf { it.id == id && it.phase == Phase.READY } ?: return
            mutable.value = current.copy(snapshot = image)
        }
    }

    fun renderFailed(id: String) = locked {
        if (mutable.value?.let { it.id == id && it.phase == Phase.READY } == true) failLocked(Phase.UNSUPPORTED)
    }

    /**
     * FILE-PREVIEW-03. One file the opened page asked for, by decoded path below its site root.
     * Completion runs once, on the caller's or the inbound thread; `null` means the page receives a 404.
     */
    fun resource(id: String, path: String, completion: (WebResource?) -> Unit) = locked {
        val wanted = path.trimStart('/')
        val entry = mutable.value?.takeIf { it.id == id }?.entry
        val opened = active?.takeIf { it.id == id }
        when {
            entry == null -> calls += { completion(null) }
            wanted == entry.path -> calls += { completion(entry) }
            opened == null -> calls += { completion(null) }
            opened.resources[wanted] != null -> { val hit = opened.resources.getValue(wanted); calls += { completion(hit) } }
            opened.waiting[wanted] != null -> opened.waiting.getValue(wanted) += completion
            wanted.isEmpty() || wanted.toByteArray().size > 1024 || opened.requested >= PAGE_RESOURCES || opened.fetchedBytes >= PAGE_BYTES ->
                calls += { completion(null) }
            else -> {
                opened.requested += 1
                opened.waiting[wanted] = mutableListOf(completion)
                opened.queued.addLast(wanted)
                pumpLocked(opened)
            }
        }
    }

    private fun cacheKey(opened: Active, path: String?) = "${opened.key.source.identity}\n${path.orEmpty()}"
    private fun rememberLocked(resource: WebResource, key: String) {
        cache[key] = resource
        var total = cache.values.sumOf { it.body.size }
        val iterator = cache.entries.iterator()
        while (total > CACHE_BYTES && iterator.hasNext()) { total -= iterator.next().value.body.size; iterator.remove() }
    }

    private fun Effects.pumpLocked(opened: Active) {
        while (active === opened && opened.fetches.size < CONCURRENT_FETCHES && opened.queued.isNotEmpty()) {
            val path = opened.queued.removeFirst()
            issueLocked(opened, Fetch(UUID.randomUUID().toString(), path, cache[cacheKey(opened, path)], now()))
        }
    }

    private fun Effects.issueLocked(opened: Active, fetch: Fetch) {
        opened.fetches += fetch
        command(fetch.command, fetch) {
            val source = opened.key.source
            if (source.reference != null) { put("type", "file.download"); put("path", source.reference) }
            else { put("type", "artifact.download"); put("artifactId", source.artifactId!!) }
            if (!opened.format.web) { put("maxBytes", opened.format.budget); put("previewFormat", opened.format.wire) }
            else put("web", buildJsonObject {
                put("page", opened.page); put("transferId", fetch.transfer!!)
                fetch.resource?.let { put("resource", it) }
                fetch.known?.let { put("ifNoneMatch", it.sha256) }
            })
        }
    }

    private fun Effects.command(id: String, fetch: Fetch?, body: JsonObjectBuilder.() -> Unit) {
        sends += buildJsonObject {
            put("type", "runtime.command"); put("protocolVersion", PROTOCOL_VERSION)
            put("runtimeId", hostId); put("commandId", id); put("command", buildJsonObject(body))
        } to fetch
    }
    private fun Effects.control(type: String, fetch: Fetch?, body: JsonObjectBuilder.() -> Unit) {
        sends += buildJsonObject { put("type", type); put("protocolVersion", PROTOCOL_VERSION); body() } to fetch
    }
    private fun Effects.cancel(transfer: String) = command("preview-cancel:${UUID.randomUUID()}", null) {
        put("type", "artifact.cancel"); put("transferId", transfer)
    }
    private fun retire(map: LinkedHashMap<String, Long>, key: String) {
        val time = now()
        map.entries.removeAll { it.value <= time }
        while (map.size >= 64) map.remove(map.keys.first())
        map[key] = time + 30_000
    }

    private fun Effects.failLocked(phase: Phase) {
        stopLocked()
        mutable.value = mutable.value?.copy(phase = phase, document = null, entry = null, snapshot = null, fullScreen = false, progress = null)
    }

    private fun Effects.stopLocked() {
        timer?.cancel(); timer = null
        val opened = active ?: return
        active = null // Revoke ownership before sending best-effort cancellations.
        for (fetch in opened.fetches) {
            retire(retired, fetch.command)
            val transfer = fetch.transfer ?: continue
            retire(retiredTransfers, transfer.lowercase())
            if (fetch.accepted || opened.format.web) cancel(transfer)
        }
        val waiting = opened.waiting.values.flatten()
        opened.waiting.clear(); opened.queued.clear(); opened.fetches.clear()
        for (completion in waiting) calls += { completion(null) }
    }

    /** Fill the shared window, oldest response first, so the page's earliest request finishes first. */
    private fun Effects.scheduleLocked(opened: Active) {
        val window = if (pressure()) INTERACTIVE_WINDOW_BYTES else WINDOW_BYTES
        var inFlight = opened.fetches.sumOf { fetch -> fetch.outstanding.values.sumOf { it.length } }
        for (fetch in opened.fetches) {
            if (!fetch.accepted || fetch.verifying) continue
            while (active === opened && fetch.next < fetch.size && inFlight < window) {
                val length = minOf(RANGE_BYTES, fetch.size - fetch.next)
                val range = Range(UUID.randomUUID().toString(), length, now(), 0)
                fetch.outstanding[fetch.next] = range
                read(fetch, fetch.next, range)
                fetch.next += length; inFlight += length
            }
        }
    }
    private fun Effects.read(fetch: Fetch, offset: Int, range: Range) = control("artifact.read", fetch) {
        put("transferId", fetch.transfer!!); put("requestId", range.id); put("offset", offset); put("length", range.length)
    }

    fun tick() = locked {
        val opened = active ?: return@locked
        val time = now()
        for (fetch in opened.fetches.toList()) {
            if (active !== opened) return@locked
            if (fetch.verifying) continue
            if (!fetch.accepted) {
                if (time - fetch.issued >= 15_000) finishLocked(opened, fetch, null, Phase.INTERRUPTED)
                continue
            }
            // Retransmit only the oldest range, and only when the whole page has stalled.
            val offset = fetch.outstanding.keys.minOrNull() ?: continue
            val range = fetch.outstanding.getValue(offset)
            if (time - maxOf(range.sentAt, opened.lastChunk) < 3_000L shl minOf(range.retries, 3)) continue
            if (range.retries >= 3) { finishLocked(opened, fetch, null, Phase.INTERRUPTED); continue }
            val retry = Range(UUID.randomUUID().toString(), range.length, time, range.retries + 1)
            fetch.outstanding[offset] = retry
            read(fetch, offset, retry)
        }
        if (active === opened) scheduleLocked(opened)
    }

    fun consume(reply: JsonObject): Boolean {
        fun text(key: String) = (reply[key] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
        fun number(key: String) = (reply[key] as? JsonPrimitive)?.takeUnless { it.isString }?.intOrNull
        val type = text("type")
        val commandId = text("commandId")
        val transfer = text("transferId")?.lowercase()
        return locked {
            val opened = active
            when {
                type == "artifact.read.failed" && transfer != null -> {
                    if (transfer in retiredTransfers) return@locked true
                    val fetch = opened?.fetches?.firstOrNull { it.transfer?.lowercase() == transfer } ?: return@locked false
                    if (fetch.outstanding.values.any { it.id == text("requestId") }) finishLocked(opened, fetch, null, Phase.INTERRUPTED)
                    true
                }
                type == "protocol.error" && commandId != null && (commandId.startsWith("preview:") || commandId.startsWith("preview-cancel:")) -> {
                    opened?.fetches?.firstOrNull { it.command == commandId }?.let { finishLocked(opened, it, null, Phase.UNAVAILABLE) }
                    true
                }
                type == "file.preview.started" || type == "file.preview.failed" -> {
                    if (supportedProtocolVersion(reply["protocolVersion"]) == null || text("runtimeId") != hostId || commandId == null) return@locked true
                    val fetch = opened?.fetches?.firstOrNull { it.command == commandId }
                    if (opened == null || fetch == null) {
                        val notModified = (reply["notModified"] as? JsonPrimitive)?.booleanOrNull == true
                        if (type == "file.preview.started" && (retired[commandId] ?: 0) > now() && !notModified &&
                            transfer != null && isPreviewUuid(transfer)) cancel(transfer)
                    } else if (type == "file.preview.failed") {
                        finishLocked(opened, fetch, null, when (text("reason")) {
                            "too_large" -> Phase.TOO_LARGE
                            "unsupported" -> Phase.UNSUPPORTED
                            "unavailable", "invalid_request" -> Phase.UNAVAILABLE
                            else -> Phase.INTERRUPTED
                        })
                    } else acceptLocked(opened, fetch, reply, ::text, ::number)
                    true
                }
                else -> false
            }
        }
    }

    private fun Effects.acceptLocked(opened: Active, fetch: Fetch, reply: JsonObject, text: (String) -> String?, number: (String) -> Int?) {
        val transfer = text("transferId")
        if (transfer == null || !isPreviewUuid(transfer) || (fetch.transfer != null && !fetch.transfer.equals(transfer, ignoreCase = true))) {
            finishLocked(opened, fetch, null, Phase.UNSUPPORTED); return
        }
        if (fetch.accepted) return
        val web = opened.format.web
        val limit = if (!web) opened.format.budget else if (fetch.resource == null) WEB_ENTRY_BYTES else WEB_RESOURCE_BYTES
        val size = number("size")
        val hash = text("sha256")
        val source = opened.key.source
        val artifact = text("artifactId")
        val matches = artifact != null && isPreviewUuid(artifact) &&
            if (source.reference != null) text("referenceId") == source.reference
            else artifact == source.artifactId && "referenceId" !in reply
        if (!matches || text("format") != (if (web) "web" else opened.format.wire) || size == null || size !in 1..limit ||
            hash == null || !digestPattern.matches(hash)) { finishLocked(opened, fetch, null, Phase.UNSUPPORTED); return }
        fetch.transfer = transfer; fetch.accepted = true; fetch.size = size; fetch.hash = hash; fetch.contentSize = size
        if (web) {
            val content = number("contentSize")
            val encoding = text("encoding")
            val mime = text("mimeType")
            val path = text("resource")
            if (content == null || content !in size..limit || (encoding != "identity" && encoding != "deflate-raw") ||
                (encoding == "identity" && content != size) || mime == null || mime.toByteArray().size !in 1..128 ||
                path.isNullOrEmpty() || (fetch.resource != null && fetch.resource != path)) {
                finishLocked(opened, fetch, null, Phase.UNSUPPORTED); return
            }
            fetch.contentSize = content; fetch.encoding = encoding; fetch.mimeType = mime; fetch.path = path
            if ((reply["notModified"] as? JsonPrimitive)?.booleanOrNull == true) {
                val known = fetch.known
                if (known == null || known.sha256 != hash) { finishLocked(opened, fetch, null, Phase.UNSUPPORTED); return }
                fetch.size = 0
                finishLocked(opened, fetch, WebResource(path, mime, known.body, hash), null)
                return
            }
        }
        if (fetch.resource == null) sizes[source.identity] = fetch.contentSize
        val first = minOf(RANGE_BYTES, fetch.size)
        if (web && fetch.parts[0]?.size == first) {
            // The range sent with the reply arrived first.
            fetch.delivered = first; opened.fetchedBytes += first
        } else if (web) {
            // It is on its way; account for it as requested rather than asking again.
            fetch.parts.clear()
            fetch.outstanding[0] = Range("pushed", first, now(), 0)
        }
        fetch.next = if (web) first else 0
        progressLocked(opened, fetch)
        if (fetch.delivered == fetch.size) verifyLocked(opened, fetch) else scheduleLocked(opened)
    }

    fun consume(frame: ArtifactChunkFrame): Boolean = locked {
        val transfer = frame.transferId.lowercase()
        if (transfer in retiredTransfers) return@locked true
        val opened = active ?: return@locked false
        val fetch = opened.fetches.firstOrNull { it.transfer?.lowercase() == transfer } ?: return@locked false
        if (frame.runtimeId != hostId || fetch.verifying) return@locked true
        val offset = frame.offset.toInt()
        if (!fetch.accepted) {
            // Only the range sent with a web reply can precede that reply.
            if (offset == 0 && opened.format.web && frame.data.size in 1..RANGE_BYTES && fetch.parts[0] == null) {
                fetch.parts[0] = frame.data; opened.lastChunk = now()
            }
            return@locked true
        }
        val range = fetch.outstanding[offset]
        if (range == null || range.length != frame.data.size) return@locked true
        fetch.outstanding.remove(offset)
        fetch.parts[offset] = frame.data
        while (true) { fetch.delivered += fetch.parts[fetch.delivered]?.size ?: break }
        opened.lastChunk = now()
        opened.fetchedBytes += frame.data.size
        progressLocked(opened, fetch)
        if (fetch.delivered == fetch.size) verifyLocked(opened, fetch)
        scheduleLocked(opened)
        true
    }

    private fun progressLocked(opened: Active, fetch: Fetch) {
        val current = mutable.value
        if (fetch.resource != null || current?.id != opened.id || current.phase != Phase.LOADING) return
        mutable.value = current.copy(progress = Progress(fetch.delivered, fetch.size))
    }

    private fun Effects.verifyLocked(opened: Active, fetch: Fetch) {
        fetch.verifying = true
        val parts = fetch.parts.toSortedMap().values.toList()
        fetch.parts.clear()
        val size = fetch.size
        val content = fetch.contentSize
        val expected = fetch.hash
        val deflated = fetch.encoding == "deflate-raw"
        val format = opened.format
        val checksBytes = fetch.resource == null
        calls += {
            scope.launch(Dispatchers.Default) {
                val body = runCatching {
                    val received = ByteArray(size)
                    var offset = 0
                    for (part in parts) { if (!isActive) return@launch; part.copyInto(received, offset); offset += part.size }
                    val decoded = checkNotNull(if (deflated) inflate(received, content) else received)
                    check(decoded.size == content)
                    check(MessageDigest.getInstance("SHA-256").digest(decoded).joinToString("") { "%02x".format(it) } == expected)
                    check(!checksBytes || format.matches(decoded))
                    decoded
                }.getOrNull()
                locked {
                    val owner = activeFor(fetch) ?: return@locked
                    if (body == null) { finishLocked(owner, fetch, null, Phase.UNSUPPORTED); return@locked }
                    control("artifact.done", null) { put("transferId", fetch.transfer!!) }
                    finishLocked(owner, fetch, WebResource(fetch.path, fetch.mimeType, body, expected), null)
                }
            }
        }
    }

    private fun Effects.finishLocked(opened: Active, fetch: Fetch, result: WebResource?, failure: Phase?) {
        if (active !== opened || !opened.fetches.remove(fetch)) return
        val transfer = fetch.transfer
        if (result == null && transfer != null && (fetch.accepted || opened.format.web)) {
            retire(retiredTransfers, transfer.lowercase())
            cancel(transfer)
        }
        if (result != null && opened.format.web) rememberLocked(result, cacheKey(opened, fetch.resource))
        val path = fetch.resource
        if (path == null) {
            // The opened file itself decides the card's state.
            if (result == null) { failLocked(failure ?: Phase.INTERRUPTED); return }
            val current = mutable.value?.takeIf { it.id == opened.id } ?: return
            timer?.cancel(); timer = null
            if (opened.format.web) {
                opened.resources[result.path] = result
                if (automaticTick) timer = scope.launch(Dispatchers.Default) {
                    // A ready page keeps a timer only for the files its WebView is still loading.
                    while (isActive && synchronized(lock) { active === opened }) { delay(250); tick() }
                }
                mutable.value = current.copy(phase = Phase.READY, entry = result, progress = null)
            } else {
                active = null
                mutable.value = current.copy(phase = Phase.READY, document = result.body, progress = null,
                    fullScreen = opened.format == FilePreviewFormat.MP4)
            }
            return
        }
        if (result != null) opened.resources[path] = result
        val completions = opened.waiting.remove(path).orEmpty()
        for (completion in completions) calls += { completion(result) }
        pumpLocked(opened)
        scheduleLocked(opened)
    }
}

private val digestPattern = Regex("[0-9a-f]{64}")
private val previewUuidPattern = Regex("[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}")
private fun isPreviewUuid(value: String) = previewUuidPattern.matches(value)

internal fun announcesFilePreview(ready: JsonObject?, deviceId: String, feature: String = ChatFilePreview.FEATURE): Boolean = ready != null &&
    ready["type"] == JsonPrimitive("device.ready") && ready["deviceId"] == JsonPrimitive(deviceId) &&
    supportedProtocolVersion(ready["protocolVersion"]) != null &&
    (ready["hostFeatures"] as? JsonArray)?.contains(JsonPrimitive(feature)) == true

internal fun nativeFilePreviewCommand(payload: JsonObject) = (payload["command"] as? JsonObject)?.containsKey("previewFormat") == true
internal fun webFilePreviewCommand(payload: JsonObject) = (payload["command"] as? JsonObject)?.containsKey("web") == true

internal enum class FilePreviewFormat(val wire: String, val budget: Int) {
    HTML("html", ChatFilePreview.WEB_ENTRY_BYTES), SVG("svg", ChatFilePreview.WEB_ENTRY_BYTES), JPEG("jpeg", 8 * 1024 * 1024),
    PNG("png", 8 * 1024 * 1024), PDF("pdf", 12 * 1024 * 1024), TEXT("text", 256 * 1024), MP4("mp4", 16 * 1024 * 1024);

    val web get() = this == HTML || this == SVG
    fun matches(bytes: ByteArray): Boolean = when (this) {
        HTML, SVG -> bytes.isNotEmpty()
        TEXT -> validPreviewText(bytes)
        JPEG -> bytes.hasPrefix(byteArrayOf(0xff.toByte(), 0xd8.toByte(), 0xff.toByte()))
        PNG -> bytes.hasPrefix(byteArrayOf(137.toByte(), 80, 78, 71, 13, 10, 26, 10))
        PDF -> bytes.hasPrefix("%PDF-".encodeToByteArray())
        MP4 -> bytes.size >= 12 && bytes.hasPrefix("ftyp".encodeToByteArray(), 4)
    }

    companion object {
        fun fromName(name: String) = when (name.substringAfterLast('.', "").lowercase()) {
            "html", "htm" -> HTML
            "svg" -> SVG
            "jpeg", "jpg" -> JPEG
            "png" -> PNG
            "pdf" -> PDF
            "md", "txt", "log", "json", "csv" -> TEXT
            "mp4" -> MP4
            else -> null
        }
    }
}

private fun ByteArray.hasPrefix(prefix: ByteArray, offset: Int = 0) =
    size - offset >= prefix.size && prefix.indices.all { this[offset + it] == prefix[it] }

private fun validPreviewText(bytes: ByteArray) = bytes.none { it == 0.toByte() } && runCatching {
    Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes))
}.isSuccess
