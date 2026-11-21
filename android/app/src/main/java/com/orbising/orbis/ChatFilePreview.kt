package com.orbising.orbis

import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.security.MessageDigest
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put

/** FILE-PREVIEW-01. No download records or conversation sequence positions are owned here. */
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
        const val FEATURE = "file.preview-v1"
        const val MAX_BYTES = 2 * 1024 * 1024
        const val NATIVE_FEATURE = "file.preview-v2"
        const val RANGE_BYTES = 128 * 1024
        fun format(name: String): String? = FilePreviewFormat.fromName(name)?.wire
    }

    data class Source(val reference: String? = null, val artifactId: String? = null)
    data class Key(val session: String, val block: String, val source: Source, val name: String)
    enum class Phase { LOADING, READY, UNAVAILABLE, UNSUPPORTED, TOO_LARGE, INTERRUPTED }
    data class Selection(val key: Key, val id: String, val phase: Phase = Phase.LOADING,
        val document: ByteArray? = null, val fullScreen: Boolean = false)

    private data class Range(val id: String, val length: Int, val sentAt: Long, val retries: Int)
    private class Request(val id: String, val key: Key, val format: FilePreviewFormat, val started: Long) {
        val commandId get() = "preview:$id"
        var transfer: String? = null
        var range: Range? = null
        var total: Int = 0
        var offset: Int = 0
        var hash = ""
        var parts = ArrayList<ByteArray>()
        var verifying = false
        var deferReadUntil = 0L
    }

    // A short lock protects identity and ownership across the UI, inbound lane and timer.
    // No send, parsing, copies of file bodies or hashing while holding it.
    private val lock = Any()
    private var request: Request? = null
    private val retired = LinkedHashMap<String, Long>()
    private var supported = false
    private var nativeSupported = false
    private var timer: Job? = null
    private var verifier: Job? = null
    private val mutable = MutableStateFlow<Selection?>(null)
    val selection = mutable.asStateFlow()

    fun resetConnection() {
        synchronized(lock) {
            supported = false; nativeSupported = false
            val wasLoading = request != null
            stopLocked(retire = false)
            retired.clear()
            val current = mutable.value
            if (wasLoading) mutable.value = current?.copy(phase = Phase.INTERRUPTED, document = null, fullScreen = false)
            else if (current?.phase == Phase.READY) mutable.value = null
        }
    }

    fun authenticated(supportsPreview: Boolean, supportsNativePreview: Boolean = false) {
        val cancellation = synchronized(lock) {
            supported = supportsPreview; nativeSupported = supportsNativePreview
            val current = mutable.value
            val format = current?.key?.name?.let(FilePreviewFormat::fromName)
            if (current != null && format != null && !supports(format) && current.phase in setOf(Phase.LOADING, Phase.READY)) {
                failLocked(Phase.UNAVAILABLE)
            } else null
        }
        cancel(cancellation)
    }

    private fun supports(format: FilePreviewFormat) = if (format.web) supported else nativeSupported

    fun open(key: Key) {
        val format = FilePreviewFormat.fromName(key.name) ?: return
        if ((key.source.reference == null) == (key.source.artifactId == null)) return
        val id = UUID.randomUUID().toString()
        val next = synchronized(lock) {
            val cancel = stopLocked()
            val active = if (supports(format)) Request(id, key, format, now()) else null
            request = active
            mutable.value = Selection(key, id, if (active != null) Phase.LOADING else Phase.UNAVAILABLE)
            active to cancel
        }
        cancel(next.second)
        val active = next.first ?: return
        if (!sendCommand(active.commandId) {
                if (key.source.reference != null) { put("type", "file.download"); put("path", key.source.reference) }
                else { put("type", "artifact.download"); put("artifactId", key.source.artifactId!!) }
                put("maxBytes", if (format.web) MAX_BYTES else format.budget)
                if (!format.web) put("previewFormat", format.wire)
            }) {
            fail(active, Phase.INTERRUPTED)
            return
        }
        synchronized(lock) {
            if (automaticTick && request === active) timer = scope.launch(Dispatchers.Default) {
                while (isActive) { delay(100); tick(active) }
            }
        }
    }

    fun close(key: Key? = null) {
        val cancellation = synchronized(lock) {
            if (key != null && mutable.value?.key != key) return
            val transfer = stopLocked()
            mutable.value = null
            transfer
        }
        cancel(cancellation)
    }

    fun closeSession(session: String) {
        val cancellation = synchronized(lock) {
            if (mutable.value?.key?.session != session) return
            val transfer = stopLocked()
            mutable.value = null
            transfer
        }
        cancel(cancellation)
    }

    fun fileHidden(key: Key, id: String) {
        val cancellation = synchronized(lock) {
            if (mutable.value?.key != key || mutable.value?.id != id || mutable.value?.phase != Phase.LOADING) return
            failLocked(Phase.INTERRUPTED)
        }
        cancel(cancellation)
    }

    fun setFullScreen(id: String, open: Boolean): Boolean = synchronized(lock) {
        val current = mutable.value?.takeIf { it.id == id && it.phase == Phase.READY } ?: return false
        mutable.value = current.copy(fullScreen = open)
        true
    }

    fun renderFailed(id: String) {
        synchronized(lock) {
            val current = mutable.value?.takeIf { it.id == id && it.phase == Phase.READY } ?: return
            mutable.value = current.copy(phase = Phase.UNSUPPORTED, document = null, fullScreen = false)
        }
    }

    private fun stopLocked(retire: Boolean = true): String? {
        timer?.cancel(); timer = null
        verifier?.cancel(); verifier = null
        val active = request ?: return null
        request = null
        if (retire) {
            val time = now()
            retired.entries.removeAll { it.value <= time }
            if (retired.size >= 16) retired.remove(retired.keys.first())
            retired[active.commandId] = time + if (active.format.web) 40_000 else 100_000
        }
        return active.transfer
    }

    private fun failLocked(phase: Phase): String? {
        val cancellation = stopLocked()
        mutable.value = mutable.value?.copy(phase = phase, document = null, fullScreen = false)
        return cancellation
    }

    private fun fail(active: Request, phase: Phase) {
        val cancellation = synchronized(lock) { if (request !== active) return; failLocked(phase) }
        cancel(cancellation)
    }

    private fun control(type: String, body: JsonObjectBuilder.() -> Unit): Boolean = send(buildJsonObject {
        put("type", type); put("protocolVersion", PROTOCOL_VERSION); body()
    })

    private fun sendCommand(id: String, body: JsonObjectBuilder.() -> Unit): Boolean = control("runtime.command") {
        put("runtimeId", hostId); put("commandId", id); put("command", buildJsonObject(body))
    }

    private fun cancel(transfer: String?) {
        if (transfer != null) sendCommand("preview-cancel:${UUID.randomUUID()}") {
            put("type", "artifact.cancel"); put("transferId", transfer)
        }
    }

    fun tick() { synchronized(lock) { request }?.let(::tick) }

    private data class Read(val transfer: String, val range: Range, val offset: Int)
    private fun tick(active: Request) {
        var cancellation: String? = null
        val time = now()
        val interactive = pressure()
        val read = synchronized(lock) {
            if (request !== active) return
            val transfer = active.transfer
            val last = active.range
            val expired = time - active.started >= (if (active.format.web) 30_000 else 90_000) || transfer == null && time - active.started >= 7_000
            val retryDue = last != null && time - last.sentAt >= 1_500L * (last.retries + 1)
            if (expired || retryDue && last!!.retries >= 2) {
                cancellation = failLocked(Phase.INTERRUPTED)
                null
            } else if (transfer == null || active.verifying ||
                (last != null && !retryDue) || (last == null && interactive && time < active.deferReadUntil)) null
            else {
                val range = Range(UUID.randomUUID().toString(), minOf(RANGE_BYTES, active.total - active.offset), time, (last?.retries ?: -1) + 1)
                active.range = range
                Read(transfer, range, active.offset)
            }
        }
        cancel(cancellation)
        if (read == null || !synchronized(lock) { request === active && active.range == read.range }) return
        if (!control("artifact.read") {
                put("transferId", read.transfer); put("requestId", read.range.id); put("offset", read.offset); put("length", read.range.length)
            }) fail(active, Phase.INTERRUPTED)
    }

    fun consume(reply: JsonObject): Boolean {
        fun text(key: String) = (reply[key] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
        val type = text("type")
        val commandId = text("commandId")
        val transfer = text("transferId")
        val cancellation = synchronized(lock) {
            val active = request
            when {
                type == "artifact.read.failed" && active?.transfer != null && transfer == active.transfer -> {
                    if (active.range?.id == text("requestId")) failLocked(Phase.INTERRUPTED) else null
                }
                type == "protocol.error" && commandId != null && (commandId.startsWith("preview:") || commandId.startsWith("preview-cancel:")) -> {
                    if (active?.commandId == commandId) failLocked(Phase.UNAVAILABLE) else null
                }
                type == "file.preview.started" || type == "file.preview.failed" -> {
                    if (supportedProtocolVersion(reply["protocolVersion"]) == null || text("runtimeId") != hostId || commandId == null) return true
                    if (active?.commandId != commandId) {
                        if (type == "file.preview.started" && (retired[commandId] ?: 0) > now()) transfer?.takeIf(::isPreviewUuid) else null
                    } else if (type == "file.preview.failed") {
                        failLocked(when (text("reason")) {
                            "too_large" -> Phase.TOO_LARGE
                            "unsupported" -> Phase.UNSUPPORTED
                            "unavailable", "invalid_request" -> Phase.UNAVAILABLE
                            else -> Phase.INTERRUPTED
                        })
                    } else if (transfer == null || !isPreviewUuid(transfer)) failLocked(Phase.UNSUPPORTED)
                    else if (active.transfer != null) transfer.takeIf { it != active.transfer }
                    else {
                        active.transfer = transfer
                        val size = (reply["size"] as? JsonPrimitive)?.takeUnless { it.isString }?.intOrNull
                        val hash = text("sha256")
                        val source = active.key.source
                        val artifact = text("artifactId")
                        val matches = artifact != null && isPreviewUuid(artifact) &&
                            if (source.reference != null) text("referenceId") == source.reference
                            else artifact == source.artifactId && "referenceId" !in reply
                        if (!matches || text("format") != active.format.wire || size == null || size !in 1..active.format.budget ||
                            hash == null || !digestPattern.matches(hash)) failLocked(Phase.UNSUPPORTED)
                        else {
                            active.total = size; active.hash = hash; active.deferReadUntil = now() + 350
                            null
                        }
                    }
                }
                else -> return false
            }
        }
        cancel(cancellation)
        return true
    }

    fun consume(frame: ArtifactChunkFrame): Boolean {
        synchronized(lock) {
            val active = request?.takeIf { it.transfer == frame.transferId } ?: return false
            val range = active.range
            if (active.verifying || range == null || frame.runtimeId != hostId || frame.offset != active.offset.toLong() ||
                frame.data.size != range.length) return true
            active.parts.add(frame.data); active.offset += range.length; active.range = null
            active.deferReadUntil = now() + 350
            if (active.offset == active.total) verifyLocked(active)
            return true
        }
    }

    private fun verifyLocked(active: Request) {
        active.verifying = true
        val parts = active.parts
        val total = active.total
        val hash = active.hash
        val transfer = checkNotNull(active.transfer)
        active.parts = ArrayList()
        verifier = scope.launch(Dispatchers.Default) {
            val document = runCatching {
                val data = ByteArray(total)
                val digest = MessageDigest.getInstance("SHA-256")
                var offset = 0
                for (part in parts) {
                    if (!isActive) return@launch
                    part.copyInto(data, offset); digest.update(part); offset += part.size
                }
                check(digest.digest().joinToString("") { "%02x".format(it) } == hash)
                check(active.format.matches(data))
                data
            }.getOrNull()
            if (document == null) { fail(active, Phase.UNSUPPORTED); return@launch }
            synchronized(lock) {
                if (request !== active) return@launch
                timer?.cancel(); timer = null; verifier = null; request = null
                mutable.value = mutable.value?.copy(document = document, phase = Phase.READY, fullScreen = active.format == FilePreviewFormat.MP4)
            }
            control("artifact.done") { put("transferId", transfer) }
        }
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

internal enum class FilePreviewFormat(val wire: String, val budget: Int) {
    HTML("html", 1024 * 1024), SVG("svg", 1024 * 1024), JPEG("jpeg", 8 * 1024 * 1024), PNG("png", 8 * 1024 * 1024),
    PDF("pdf", 12 * 1024 * 1024), TEXT("text", 256 * 1024), MP4("mp4", 16 * 1024 * 1024);

    val web get() = this == HTML || this == SVG
    fun matches(bytes: ByteArray): Boolean = when (this) {
        HTML, SVG -> bytes.hasPrefix("<!doctype html>".encodeToByteArray()) && validPreviewText(bytes)
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
