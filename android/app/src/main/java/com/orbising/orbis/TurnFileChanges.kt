package com.orbising.orbis

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*
import java.text.BreakIterator
import java.util.Locale
import java.util.UUID

@Serializable data class FileChangeMetadata(
    val fileId: String, val path: String, val oldPath: String? = null, val changeKind: String, val fileKind: String,
    val additions: Long? = null, val deletions: Long? = null, val beforeBytes: Long? = null, val afterBytes: Long? = null,
    val contentVersion: String, val detail: String,
)
@Serializable data class TurnChangeSummary(
    val projectionVersion: Int, val agent: ToolAgent, val reviewTurnId: String, val changeSetId: String,
    val sourceTurnIds: List<String> = emptyList(), val manifestVersion: Long, val anchorEntryId: String?, val startedAt: Long, val finishedAt: Long?,
    val state: String, val outcome: String, val coverage: String, val attribution: String, val reasons: List<String>,
    val fileCount: Long?, val addedFiles: Long?, val modifiedFiles: Long?, val deletedFiles: Long?,
    val additions: Long?, val deletions: Long?, val preview: List<FileChangeMetadata>, val scope: String = "unknown", val revision: Long,
) { val versionKey get() = "$changeSetId:$manifestVersion" }
@Serializable data class ChangeManifestPage(
    val requestId: String, val runtimeId: String, val agent: ToolAgent, val changeSetId: String,
    val manifestVersion: Long, val files: List<FileChangeMetadata>, val totalCount: Long, val nextCursor: String?,
)
@Serializable data class FileChangeDetailPage(
    val requestId: String, val runtimeId: String, val agent: ToolAgent, val changeSetId: String,
    val manifestVersion: Long, val fileId: String, val contentVersion: String, val viewerId: String,
    val readId: String, val text: String, val nextCursor: String?, val eof: Boolean,
)

private fun changeId() = UUID.randomUUID().toString()
internal fun changeFailureText(reason: String?) = when (reason) {
    "expired" -> "轮次差异已超过电脑端保留期限"
    "version-mismatch" -> "差异版本已变化，请关闭后重新打开"
    "scope-mismatch" -> "差异所属会话已变化，请重新打开"
    "binary" -> "二进制文件不提供文本差异"
    "too-large" -> "文件超过文本差异大小上限"
    "unsupported" -> "此文件类型不支持文本差异"
    "not-captured" -> "未捕获完整的轮次前后版本"
    "busy" -> "电脑端正在统计，请稍后重试"
    "invalid-cursor" -> "读取位置已失效，请关闭后重新打开"
    else -> "暂时无法读取轮次差异，请稍后重试"
}
private fun validChangeFile(file: FileChangeMetadata): Boolean = file.fileId.isNotBlank() && file.path.isNotBlank() &&
    file.path.length <= 4096 && file.contentVersion.isNotBlank() &&
    file.changeKind in setOf("added", "modified", "deleted", "renamed", "type-changed", "unknown") &&
    file.fileKind in setOf("text", "binary", "symlink", "directory", "other", "unknown") &&
    file.detail in setOf("available", "binary", "too-large", "unsupported", "not-captured", "busy") &&
    listOfNotNull(file.additions, file.deletions, file.beforeBytes, file.afterBytes).all { it >= 0 }

/** No text, snippets or detail requests belong to this metadata replica. */
data class ChangeManifest(
    val summary: TurnChangeSummary, val files: List<FileChangeMetadata> = summary.preview,
    val loaded: Boolean = false, val nextCursor: String? = null, val requestId: String? = null, val error: String? = null,
) {
    val complete get() = loaded && nextCursor == null || !loaded && summary.fileCount == files.size.toLong()
    fun request(): ChangeManifest = if (requestId != null || complete) this else copy(requestId = changeId(), error = null)
    fun command(runtime: String) = requestId?.let { request -> buildJsonObject {
        put("type", "session.changes.read"); put("runtimeId", runtime); put("requestId", request)
        put("agent", toolJson.encodeToJsonElement(summary.agent)); put("changeSetId", summary.changeSetId)
        put("manifestVersion", summary.manifestVersion); put("cursor", nextCursor?.let(::JsonPrimitive) ?: JsonNull); put("maxItems", 100)
    } }
    fun page(value: ChangeManifestPage): ChangeManifest {
        if (requestId != value.requestId) return this
        val incoming = (if (loaded) files else emptyList()) + value.files
        if (value.agent != summary.agent || value.changeSetId != summary.changeSetId || value.manifestVersion != summary.manifestVersion ||
            value.totalCount != summary.fileCount || value.files.size > 100 || value.files.any { !validChangeFile(it) } ||
            incoming.map { it.fileId }.distinct().size != incoming.size || incoming.size > 20_000 || incoming.size > value.totalCount ||
            value.nextCursor != null && (value.nextCursor == nextCursor || value.files.isEmpty()) ||
            value.nextCursor == null && incoming.size.toLong() != value.totalCount) return copy(requestId = null, error = "文件清单版本或分页无效")
        return copy(files = incoming, loaded = true, nextCursor = value.nextCursor, requestId = null, error = null)
    }
}

data class ChangeSummaryRequest(val requestId: String, val agent: ToolAgent, val entries: List<String>, val turns: List<String>, val cursor: String? = null) {
    fun command(runtime: String) = buildJsonObject {
        put("type", "session.changes.list"); put("runtimeId", runtime); put("requestId", requestId)
        put("agent", toolJson.encodeToJsonElement(agent)); put("entryIds", JsonArray(entries.map(::JsonPrimitive)))
        put("turnIds", JsonArray(turns.map(::JsonPrimitive))); put("cursor", cursor?.let(::JsonPrimitive) ?: JsonNull)
    }
}

data class TurnChangesState(
    val summaries: Map<String, TurnChangeSummary> = emptyMap(), val manifests: Map<String, ChangeManifest> = emptyMap(),
    val request: ChangeSummaryRequest? = null, val error: String? = null,
) {
    fun merge(values: List<TurnChangeSummary>): TurnChangesState {
        var next = this
        values.forEach { summary ->
            val old = next.summaries[summary.changeSetId]
            if (summary.projectionVersion != 1 || summary.manifestVersion < 0 || summary.revision < 0 || summary.preview.size > 4 ||
                summary.preview.any { !validChangeFile(it) } || summary.preview.map { it.fileId }.distinct().size != summary.preview.size ||
                summary.fileCount != null && summary.fileCount < summary.preview.size || old != null && (old.manifestVersion > summary.manifestVersion || old.revision >= summary.revision)) return@forEach
            val previousManifest = next.manifests[summary.versionKey]
            val manifest = when {
                previousManifest == null || previousManifest.summary.state != "ready" -> ChangeManifest(summary)
                previousManifest.loaded -> previousManifest.copy(summary = summary)
                else -> previousManifest.copy(summary = summary, files = summary.preview)
            }
            next = next.copy(summaries = (next.summaries + (summary.changeSetId to summary)).entries.toList().takeLast(256).associate { it.toPair() },
                manifests = (next.manifests + (summary.versionKey to manifest)).entries.toList().takeLast(256).associate { it.toPair() })
        }
        return next
    }
}

data class FileDiffCache(
    val file: FileChangeMetadata, val text: String = "", val nextCursor: String? = null, val readId: String? = null,
    val loaded: Boolean = false, val eof: Boolean = false, val requestId: String? = null, val error: String? = null,
    val scrollIndex: Int = 0, val scrollOffset: Int = 0,
) {
    fun request(): FileDiffCache = if (requestId != null || eof) this else if (file.detail != "available")
        copy(error = changeFailureText(file.detail)) else copy(requestId = changeId(), error = null)
}

data class FileChangeViewer(
    val runtimeId: String, val summary: TurnChangeSummary, val selectedFileId: String,
    val viewerId: String = changeId(), val cache: Map<String, FileDiffCache> = emptyMap(),
) {
    val current get() = cache[selectedFileId]
    fun select(file: FileChangeMetadata): FileChangeViewer {
        val cleared = cache.mapValues { (_, value) -> value.copy(requestId = null, readId = null) }
        var retained = cleared
        // Retain visited ranges, bounded independently of chat and metadata caches.
        while (retained.values.sumOf { it.text.toByteArray(Charsets.UTF_8).size.toLong() } > 8L * 1024 * 1024 && retained.size > 1) {
            val oldest = retained.keys.firstOrNull { it != file.fileId } ?: break
            retained = retained - oldest
        }
        val next = (retained[file.fileId] ?: FileDiffCache(file)).let { if (!it.loaded) it.request() else it }
        return copy(selectedFileId = file.fileId, viewerId = changeId(), cache = retained + (file.fileId to next))
    }
    fun request(): FileChangeViewer = current?.let { copy(cache = cache + (selectedFileId to it.request())) } ?: this
    fun command(): JsonObject? = current?.let { detail -> detail.requestId?.let { request -> buildJsonObject {
        put("type", "session.change.detail.read"); put("runtimeId", runtimeId); put("requestId", request)
        put("agent", toolJson.encodeToJsonElement(summary.agent)); put("changeSetId", summary.changeSetId)
        put("manifestVersion", summary.manifestVersion); put("fileId", detail.file.fileId); put("contentVersion", detail.file.contentVersion)
        put("viewerId", viewerId); put("readId", detail.readId?.let(::JsonPrimitive) ?: JsonNull)
        put("cursor", detail.nextCursor?.let(::JsonPrimitive) ?: JsonNull); put("maxBytes", 48 * 1024)
    } } }
    fun cancelCommand() = buildJsonObject {
        put("type", "session.change.detail.cancel"); put("runtimeId", runtimeId); put("requestId", changeId())
        put("viewerId", viewerId); put("readId", current?.readId?.let(::JsonPrimitive) ?: JsonNull)
    }
    fun page(page: FileChangeDetailPage): FileChangeViewer {
        val detail = current ?: return this
        if (page.requestId != detail.requestId || page.viewerId != viewerId) return this
        val count = page.text.toByteArray(Charsets.UTF_8).size
        val valid = page.runtimeId == runtimeId && page.agent == summary.agent && page.changeSetId == summary.changeSetId &&
            page.manifestVersion == summary.manifestVersion && page.fileId == selectedFileId && page.contentVersion == detail.file.contentVersion &&
            page.readId.isNotBlank() && (detail.readId == null || detail.readId == page.readId) && count <= 48 * 1024 &&
            page.eof == (page.nextCursor == null) && (page.eof || count > 0 && page.nextCursor != detail.nextCursor)
        val next = when {
            !valid -> detail.copy(requestId = null, error = "差异范围或版本无效")
            detail.text.toByteArray(Charsets.UTF_8).size + count > 2 * 1024 * 1024 -> detail.copy(requestId = null, error = "已读取差异达到 2 MiB 显示上限")
            else -> detail.copy(text = detail.text + page.text, nextCursor = page.nextCursor, readId = page.readId,
                loaded = true, eof = page.eof, requestId = null, error = null)
        }
        var retained = cache + (selectedFileId to next)
        while (retained.values.sumOf { it.text.toByteArray(Charsets.UTF_8).size.toLong() } > 8L * 1024 * 1024 && retained.size > 1) {
            val oldest = retained.keys.firstOrNull { it != selectedFileId } ?: break
            retained = retained - oldest
        }
        return copy(cache = retained)
    }
    fun failed(id: String?, reason: String, reopenExpiredLease: Boolean = false): FileChangeViewer {
        val detail = current?.takeIf { id != null && it.requestId == id } ?: return this
        // A lease can disappear after a Host restart while the immutable snapshot is
        // still retained. Reopen at the same cursor once; the retry has no readId,
        // so a second expired response reports actual unavailable content.
        if (reopenExpiredLease && detail.readId != null) return copy(cache = cache + (selectedFileId to
            detail.copy(requestId = changeId(), readId = null, error = null)))
        return copy(cache = cache + (selectedFileId to detail.copy(requestId = null, error = reason)))
    }
}

/** Reduced separately: file review never participates in the chat applied baseline. */
internal fun reduceTurnChanges(state: RemoteState, envelope: JsonObject): RemoteState? {
    if (envelope["type"]?.jsonPrimitive?.contentOrNull != "runtime.event") return null
    val runtime = envelope["runtimeId"]?.jsonPrimitive?.contentOrNull ?: return null
    val event = envelope["event"] as? JsonObject ?: return null
    val type = event["type"]?.jsonPrimitive?.contentOrNull ?: return null
    if (!type.startsWith("session.changes.") && !type.startsWith("session.change.detail.")) return null
    if (envelope["protocolVersion"]?.jsonPrimitive?.intOrNull?.let { it != PROTOCOL_VERSION } == true)
        return state.copy(error = PROTOCOL_VERSION_MISMATCH_ERROR, errorNeedsAction = true)
    val runtimeInfo = state.runtimes[runtime] ?: return state
    val agent = ToolAgent(state.hostId ?: return state, runtimeInfo.agentKind ?: return state, runtimeInfo.sessionId ?: return state)
    val old = state.turnChanges[runtime] ?: TurnChangesState()
    fun publish(value: TurnChangesState) = state.copy(turnChanges = state.turnChanges + (runtime to value))
    return runCatching {
        if (event["runtimeId"] != null && event["runtimeId"]?.jsonPrimitive?.contentOrNull != runtime) return state
        when (type) {
            "session.changes.updated" -> {
                val summary = toolJson.decodeFromJsonElement<TurnChangeSummary>(event.getValue("summary"))
                if (summary.agent != agent) state else publish(old.merge(listOf(summary)))
            }
            "session.changes.summaries" -> {
                val request = old.request ?: return state
                if (event["requestId"]?.jsonPrimitive?.contentOrNull != request.requestId ||
                    toolJson.decodeFromJsonElement<ToolAgent>(event.getValue("agent")) != agent) return state
                val values = toolJson.decodeFromJsonElement<List<TurnChangeSummary>>(event.getValue("summaries"))
                if (values.size > 128 || values.any { it.agent != agent || it.anchorEntryId !in request.entries && it.reviewTurnId !in request.turns && it.sourceTurnIds.none(request.turns::contains) }) return state
                val cursor = event["nextCursor"]?.jsonPrimitive?.contentOrNull
                if (cursor != null && (cursor == request.cursor || values.isEmpty())) return state
                publish(old.copy(request = cursor?.let { request.copy(requestId = changeId(), cursor = it) }, error = null).merge(values))
            }
            "session.changes.page" -> {
                val page = toolJson.decodeFromJsonElement<ChangeManifestPage>(event)
                if (page.agent != agent) return state
                val key = "${page.changeSetId}:${page.manifestVersion}"
                val manifest = old.manifests[key] ?: return state
                publish(old.copy(manifests = old.manifests + (key to manifest.page(page))))
            }
            "session.change.detail.page" -> {
                val page = toolJson.decodeFromJsonElement<FileChangeDetailPage>(event)
                if (page.agent != agent) state else state.copy(changeViewer = state.changeViewer?.page(page))
            }
            "session.changes.failed" -> {
                val id = event["requestId"]?.jsonPrimitive?.contentOrNull
                val rawReason = event["reason"]?.jsonPrimitive?.contentOrNull
                val reason = changeFailureText(rawReason)
                val next = old.copy(request = old.request?.takeUnless { it.requestId == id },
                    error = if (old.request?.requestId == id) reason else old.error,
                    manifests = old.manifests.mapValues { (_, manifest) -> if (manifest.requestId == id) manifest.copy(requestId = null, error = reason) else manifest })
                publish(next).copy(changeViewer = state.changeViewer?.takeIf { it.runtimeId == runtime }
                    ?.failed(id, reason, reopenExpiredLease = rawReason == "expired") ?: state.changeViewer)
            }
            else -> state
        }
    }.getOrElse { state }
}

internal data class UnifiedDiffLine(val text: String, val kind: String, val oldLine: Int? = null, val newLine: Int? = null, val continuation: Boolean = false)
private val unifiedHunk = Regex("^@@ -(\\d+)(?:,\\d+)? \\+(\\d+)(?:,\\d+)? @@.*$")
/** Reparse bounded cached UTF-8 text; incomplete chunks never become invented line endings. */
internal fun unifiedDiffLines(text: String, eof: Boolean): List<UnifiedDiffLine> {
    var old = 0; var new = 0; var inHunk = false
    return buildList {
        val all = text.split('\n')
        all.forEachIndexed { index, raw ->
            if (index == all.lastIndex && raw.isEmpty()) return@forEachIndexed
            val line = raw.removeSuffix("\r")
            val hunk = if (eof || index < all.lastIndex) unifiedHunk.matchEntire(line) else null
            if (hunk != null) { old = hunk.groupValues[1].toIntOrNull() ?: 0; new = hunk.groupValues[2].toIntOrNull() ?: 0; inHunk = true; add(UnifiedDiffLine(line, "hunk")); return@forEachIndexed }
            val kind = if (!inHunk) "header" else when (line.firstOrNull()) { '+' -> "addition"; '-' -> "deletion"; ' ' -> "context"; else -> "header" }
            val oldLine = if (kind == "deletion" || kind == "context") old++ else null
            val newLine = if (kind == "addition" || kind == "context") new++ else null
            var from = 0
            do {
                var until = minOf(from + 2048, line.length)
                if (until < line.length && until > from && Character.isHighSurrogate(line[until - 1])) until--
                add(UnifiedDiffLine(line.substring(from, until), kind, oldLine, newLine, from != 0)); from = until
            } while (from < line.length)
        }
    }
}

/** Preserve compound extensions and grapheme boundaries when the available width is small. */
internal fun changeFileNameParts(name: String): Pair<String, String> {
    val suffixes = listOf(".d.ts", ".d.mts", ".d.cts", ".tar.gz", ".tar.bz2", ".tar.xz", ".test.tsx", ".test.ts", ".spec.ts", ".module.css")
    val suffix = suffixes.firstOrNull { name.endsWith(it, ignoreCase = true) && name.length > it.length }
    return if (suffix != null) name.dropLast(suffix.length) to name.takeLast(suffix.length) else fileNameParts(name)
}
internal fun elideChangeFileName(path: String, fits: (String) -> Boolean): String {
    // Directory prefixes must never consume the recognizable start of the filename.
    // The composable keeps the original path in its accessibility semantics.
    val name = path.substringAfterLast('/').substringAfterLast('\\')
    if (fits(name)) return name
    val (base, extension) = changeFileNameParts(name)
    val iterator = BreakIterator.getCharacterInstance(Locale.ROOT).apply { setText(base) }
    val boundaries = mutableListOf(0)
    var boundary = iterator.next()
    while (boundary != BreakIterator.DONE) { boundaries += boundary; boundary = iterator.next() }
    if (extension.isEmpty()) {
        val count = boundaries.lastIndex
        if (count < 3) return name
        fun middle(kept: Int): String {
            val leading = (kept + 1) / 2
            val trailing = kept / 2
            return base.substring(0, boundaries[leading]) + "…" + base.substring(boundaries[count - trailing])
        }
        if (!fits(middle(2))) return name
        var low = 2; var high = count - 1
        while (low < high) {
            val mid = (low + high + 1) / 2
            if (fits(middle(mid))) low = mid else high = mid - 1
        }
        return middle(low)
    }
    var low = 0; var high = boundaries.lastIndex
    while (low < high) {
        val mid = (low + high + 1) / 2
        if (fits(base.substring(0, boundaries[mid]) + "…" + extension)) low = mid else high = mid - 1
    }
    // Let the native text wrap if a prefix plus the intact extension cannot fit.
    return if (low == 0) name else base.substring(0, boundaries[low]) + "…" + extension
}
