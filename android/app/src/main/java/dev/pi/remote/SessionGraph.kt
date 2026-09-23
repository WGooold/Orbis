package dev.pi.remote

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

@Serializable
data class SessionGraphEntry(
    val entryId: String,
    val parentId: String? = null,
    val type: String,
    val timestamp: String,
    val data: JsonObject = buildJsonObject { },
)

@Serializable
data class SessionBranchCursor(
    val leafId: String? = null,
)

@Serializable
data class SessionGraphSnapshot(
    val sessionId: String,
    val syncId: String,
    val cursor: SessionBranchCursor,
    val mode: String,
    val entries: List<SessionGraphEntry>,
    val range: String? = null,
    val targetLeafId: String? = null,
    val beforeEntryId: String? = null,
    val hasOlder: Boolean? = null,
    val complete: Boolean? = null,
    val rangeStatus: String? = null,
    /** Timing metadata accompanying this page, merged independently of canonical Entries. */
    val turnTimings: List<TurnTiming>? = null,
)

@Serializable
data class SessionGraph(
    val sessionId: String,
    val entries: Map<String, SessionGraphEntry> = emptyMap(),
    /** Last observed leaf, used only as the default branch for offline display. */
    val cursor: SessionBranchCursor = SessionBranchCursor(),
    /** Timing metadata is kept outside the Entry tree and projected by persisted message ID. */
    val turnTimings: Map<String, TurnTiming> = emptyMap(),
)

internal fun SessionGraph.hasCompleteEntryChain(leafId: String?): Boolean {
    var current = leafId
    val visited = mutableSetOf<String>()
    while (current != null) {
        if (!visited.add(current)) return false
        val entry = entries[current] ?: return false
        current = entry.parentId
    }
    return true
}

internal fun SessionGraph.hasCompleteCursor(targetLeafId: String?): Boolean =
    targetLeafId != null && cursor.leafId == targetLeafId && hasCompleteEntryChain(targetLeafId)

internal fun SessionGraph.catchUpFrontier(targetLeafId: String?): String? {
    val frontier = cursor.leafId ?: return null
    if (targetLeafId == null || !entries.containsKey(frontier)) return null
    // A bounded local read can contain the Runtime target without its ancestors. Do not mistake
    // that incomplete target projection for a committed frontier; a persisted frontier normally
    // differs from the target until catch-up reaches it.
    if (frontier == targetLeafId && !hasCompleteEntryChain(frontier)) return null
    return frontier
}

internal fun SessionGraph.isDescendant(leafId: String?, ancestorId: String?): Boolean {
    if (leafId == null || ancestorId == null) return false
    var current = leafId
    val visited = mutableSetOf<String>()
    while (current != null && visited.add(current)) {
        if (current == ancestorId) return true
        current = entries[current]?.parentId ?: return false
    }
    return false
}

@Serializable
data class RuntimeSessionView(
    val runtimeId: String,
    val sessionId: String,
    val leafId: String? = null,
)

/**
 * Applies the Runtime's entry-chain update. Pi is authoritative; Android only
 * stores the received nodes by entry ID and moves the observed cursor.
 */
internal fun SessionGraph.merge(snapshot: SessionGraphSnapshot): SessionGraph {
    require(sessionId == snapshot.sessionId) { "session_mismatch" }
    require(snapshot.mode in setOf("replace", "append", "prepend")) { "unknown_merge_mode" }
    val received = validateCanonicalEntries(snapshot.entries, entries::get)
    val mergedEntries = entries + received
    val timings = turnTimings.toMutableMap()
    snapshot.turnTimings.orEmpty().forEach { timing ->
        timings[timing.turnId] = mergeCanonicalTiming(timings[timing.turnId], timing)
    }
    val observed = snapshot.cursor.leafId?.takeIf(mergedEntries::containsKey)
        ?: snapshot.entries.lastOrNull()?.entryId?.takeIf { snapshot.range == "catchup" }
    val merged = copy(
        entries = mergedEntries,
        // This is the observed/display cursor only. Durable continuity comes from the store.
        cursor = if (snapshot.mode != "prepend" && observed != null &&
            !copy(entries = mergedEntries).isDescendant(cursor.leafId, observed)) {
            SessionBranchCursor(observed)
        } else cursor,
        turnTimings = timings,
    )
    return merged
}

internal data class SessionProjectionResult(
    val messages: List<ChatMessage>,
    val error: String? = null,
    val turnTimings: List<TurnTiming> = emptyList(),
)

/**
 * Reconstructs the branch and display-oriented message projection from the cached Session graph.
 * This intentionally mirrors Pi's parent traversal and compaction boundary, while leaving the
 * Android renderer free to use a mobile layout.
 */
internal fun projectSessionGraph(
    graph: SessionGraph,
    json: Json = Json { ignoreUnknownKeys = true },
): SessionProjectionResult {
    val pathResult = walkSessionGraphPath(
        graph.cursor.leafId,
        (graph.entries.size + 1).coerceAtLeast(1),
        graph.entries::get,
    )
    val path = pathResult.entries
    val projectionError = graph.cursor.leafId?.let {
        pathResult.status.takeUnless { status ->
            status == SessionGraphRangeStatus.COMPLETE || status == SessionGraphRangeStatus.LIMIT_REACHED
        }?.name?.lowercase()
    }
    val latestCompactionIndex = path.indexOfLast { it.type == "compaction" }
    val visible = if (latestCompactionIndex < 0) {
        path
    } else {
        val compaction = path[latestCompactionIndex]
        val firstKeptId = compaction.data["firstKeptEntryId"]?.jsonPrimitive?.contentOrNull
        val firstKeptIndex = firstKeptId?.let { id -> path.indexOfFirst { it.entryId == id } } ?: -1
        buildList {
            add(compaction)
            if (firstKeptIndex in 0 until latestCompactionIndex) {
                addAll(path.subList(firstKeptIndex, latestCompactionIndex))
            }
            addAll(path.subList(latestCompactionIndex + 1, path.size))
        }
    }
    // Unknown entries are not a reason to discard the whole conversation. They are
    // simply non-displayable from Android's point of view.
    val messages = visible.flatMap { entry -> projectEntry(entry, json) }
    val projectedTimings = linkedMapOf<String, TurnTiming>()
    turnTimingsFromSessionEntries(visible).forEach { projectedTimings[it.turnId] = it }
    graph.turnTimings.values.forEach { projectedTimings[it.turnId] = it }
    return SessionProjectionResult(
        messages = messages,
        error = projectionError,
        turnTimings = projectedTimings.values.filter { timing ->
            timing.messageId == null || messages.any { it.messageId == timing.messageId }
        },
    )
}

internal fun projectSessionEntries(
    entries: List<SessionGraphEntry>,
    json: Json = Json { ignoreUnknownKeys = true },
): List<ChatMessage> = entries.flatMap { entry -> projectEntry(entry, json) }

/**
 * First user message text visible in the branch rooted at the current leaf. This is the canonical
 * Session title the sidebar renders for both online and offline Sessions, so callers should treat
 * the result as a stable label rather than a full message body.
 */
internal fun SessionGraph.firstUserMessageTitle(
    json: Json = Json { ignoreUnknownKeys = true },
): String? {
    if (cursor.leafId == null || entries.isEmpty()) return null
    val path = buildSessionPath(entries, cursor.leafId)
    if (path.isEmpty()) return null
    return firstUserMessageTitle(projectSessionEntries(path, json))
}

private const val REMOTE_TURN_TIMING_CUSTOM_TYPE = "pi_remote_turn_timing"

private fun turnTimingsFromSessionEntries(entries: List<SessionGraphEntry>): List<TurnTiming> = buildList {
    val byTurnId = linkedMapOf<String, TurnTiming>()
    for (entry in entries) {
        if (entry.type != "custom" ||
            entry.data["customType"]?.jsonPrimitive?.contentOrNull != REMOTE_TURN_TIMING_CUSTOM_TYPE
        ) continue
        val data = entry.data["data"]?.jsonObject ?: entry.data
        val turnId = data["turnId"]?.jsonPrimitive?.contentOrNull ?: continue
        val startedAt = data["startedAt"]?.jsonPrimitive?.longOrNull ?: continue
        val durationMs = data["durationMs"]?.jsonPrimitive?.longOrNull ?: continue
        if (startedAt < 0L || durationMs < 0L) continue
        byTurnId[turnId] = TurnTiming(
            turnId = turnId,
            startedAt = startedAt,
            durationMs = durationMs,
            turnIndex = data["turnIndex"]?.jsonPrimitive?.intOrNull,
            messageId = data["messageId"]?.jsonPrimitive?.contentOrNull,
        )
    }
    addAll(byTurnId.values)
}

internal fun SessionGraph.projectLeafDeltaProjection(
    oldLeafId: String?,
    newLeafId: String?,
    currentMessages: List<ChatMessage>,
    json: Json = Json { ignoreUnknownKeys = true },
): SessionProjectionResult {
    val fullProjection = projectSessionGraph(copy(cursor = SessionBranchCursor(newLeafId)), json)
    if (currentMessages.isEmpty() || oldLeafId == newLeafId) return fullProjection
    val oldPath = buildSessionPath(entries, oldLeafId)
    val newPath = buildSessionPath(entries, newLeafId)
    if (oldLeafId == null || oldPath.isEmpty() || newPath.isEmpty() ||
        oldPath.any { it.type == "compaction" } || newPath.any { it.type == "compaction" }) {
        return fullProjection
    }
    var common = 0
    while (common < oldPath.size && common < newPath.size &&
        oldPath[common].entryId == newPath[common].entryId) common += 1
    val oldIds = oldPath.map(SessionGraphEntry::entryId).toSet()
    val commonIds = oldPath.take(common).map(SessionGraphEntry::entryId).toSet()
    val commonMessages = currentMessages.filter { it.messageId in commonIds }
    val canonicalSuffix = projectSessionEntries(newPath.drop(common), json)
    // Messages not represented by the old branch are live overlays. Keep them in their existing
    // order, but only after the newly arrived canonical suffix. A row the suffix already carries
    // is the same message under its temporary id, so re-attaching it would render it twice.
    val overlays = currentMessages.filter {
        it.messageId !in oldIds && !(commonMessages + canonicalSuffix).represents(it)
    }
    return fullProjection.copy(
        messages = commonMessages + canonicalSuffix + overlays,
    )
}

internal fun SessionGraph.projectLeafDelta(
    oldLeafId: String?,
    newLeafId: String?,
    currentMessages: List<ChatMessage>,
    json: Json = Json { ignoreUnknownKeys = true },
): List<ChatMessage> = projectLeafDeltaProjection(oldLeafId, newLeafId, currentMessages, json).messages

internal fun buildSessionPath(entries: Map<String, SessionGraphEntry>, leafId: String?): List<SessionGraphEntry> {
    if (leafId == null) return emptyList()
    val path = mutableListOf<SessionGraphEntry>()
    val visited = mutableSetOf<String>()
    var current: String? = leafId
    while (current != null && visited.add(current)) {
        val entry = entries[current] ?: break
        path += entry
        current = entry.parentId
    }
    return path.asReversed()
}

private fun projectEntry(entry: SessionGraphEntry, json: Json): List<ChatMessage> = when (entry.type) {
    "message" -> {
        // The Runtime ships the exact failure text it streamed so a failed turn keeps rendering
        // after a reload instead of projecting to an empty (and therefore invisible) row.
        val failure = entry.data["remoteFailure"]?.jsonPrimitive?.contentOrNull?.takeIf(String::isNotBlank)
        entry.data["message"]?.let { element ->
            runCatching { json.decodeFromJsonElement<PiMessageProjection>(element) }.getOrNull()
                ?.toChatMessage(entry.entryId, failure)
        }?.let(::listOf).orEmpty()
    }
    "custom_message" -> {
        val display = entry.data["display"]?.jsonPrimitive?.contentOrNull?.toBooleanStrictOrNull() ?: false
        if (!display) emptyList() else listOf(
            ChatMessage(
                messageId = entry.entryId,
                role = "custom",
                content = customMessageContent(entry.data["content"]) + customArtifactContent(entry.data["details"], json),
                timestamp = entry.timestamp.toTimestampMillis(),
            ),
        )
    }
    "compaction" -> listOf(specialMessage(entry, "压缩摘要", "summary"))
    "branch_summary" -> entry.data["summary"]?.jsonPrimitive?.contentOrNull
        ?.takeIf(String::isNotEmpty)
        ?.let { listOf(specialMessage(entry, "分支摘要", "summary")) }
        .orEmpty()
    "custom", "thinking_level_change", "model_change", "label", "session_info" -> emptyList()
    else -> emptyList()
}

private fun customArtifactContent(
    element: kotlinx.serialization.json.JsonElement?,
    json: Json,
): List<RemoteContent> {
    val details = element as? JsonObject ?: return emptyList()
    val artifact = details["remoteArtifact"]?.let {
        runCatching { json.decodeFromJsonElement<RemoteArtifact>(it) }.getOrNull()
    } ?: return emptyList()
    return listOf(RemoteContent(type = "artifact", artifact = artifact))
}

private fun customMessageContent(element: kotlinx.serialization.json.JsonElement?): List<RemoteContent> = when (element) {
    is kotlinx.serialization.json.JsonPrimitive -> listOf(RemoteContent(type = "text", text = element.contentOrNull.orEmpty()))
    is kotlinx.serialization.json.JsonArray -> element.flatMap { raw ->
        val obj = raw as? JsonObject ?: return@flatMap emptyList()
        when (obj["type"]?.jsonPrimitive?.contentOrNull) {
            "text" -> listOf(RemoteContent(type = "text", text = obj["text"]?.jsonPrimitive?.contentOrNull.orEmpty()))
            else -> emptyList()
        }
    }
    else -> emptyList()
}

@Serializable
private data class PiMessageProjection(
    val role: String? = null,
    val content: kotlinx.serialization.json.JsonElement? = null,
    val timestamp: Long? = null,
    val toolCallId: String? = null,
    val toolName: String? = null,
    val isError: Boolean? = null,
    val stopReason: String? = null,
    val errorMessage: String? = null,
    val display: Boolean? = null,
    val command: String? = null,
    val output: String? = null,
)

private fun PiMessageProjection.toChatMessage(messageId: String, failure: String? = null): ChatMessage? {
    if (role == "custom" && display == false) return null
    if (role !in setOf("user", "assistant", "toolResult", "custom", "bashExecution")) return null
    val blocks = if (role == "bashExecution") {
        val shellOutput = buildString {
            command?.takeIf(String::isNotBlank)?.let { append("$ ").append(it) }
            output?.takeIf(String::isNotBlank)?.let {
                if (isNotEmpty()) append('\n')
                append(it)
            }
        }
        listOf(RemoteContent(type = "text", text = shellOutput))
    } else when {
        content == null -> emptyList()
        content is kotlinx.serialization.json.JsonPrimitive -> listOf(RemoteContent(type = "text", text = content.jsonPrimitive.contentOrNull.orEmpty()))
        content is kotlinx.serialization.json.JsonArray -> content.jsonArray.flatMap { raw ->
            val obj = raw as? JsonObject ?: return@flatMap emptyList()
            when (obj["type"]?.jsonPrimitive?.contentOrNull) {
                "text" -> listOf(RemoteContent(type = "text", text = obj["text"]?.jsonPrimitive?.contentOrNull.orEmpty()))
                "thinking" -> listOf(RemoteContent(type = "thinking", text = obj["thinking"]?.jsonPrimitive?.contentOrNull.orEmpty()))
                "toolCall" -> listOf(RemoteContent(
                    type = "tool_call",
                    toolCallId = obj["id"]?.jsonPrimitive?.contentOrNull,
                    toolName = obj["name"]?.jsonPrimitive?.contentOrNull,
                    arguments = obj["arguments"],
                ))
                else -> emptyList()
            }
        }
        else -> emptyList()
    }
    val failed = failure != null || isError == true || stopReason == "error" || stopReason == "aborted"
    // Older cached entries predate `remoteFailure`; fall back to the provider message so a failure
    // is never invisible, even if the text then differs from what the live stream showed.
    val failureLine = failure ?: errorMessage?.trim()?.takeIf { failed && it.isNotEmpty() }
    val content = if (failureLine != null && blocks.none { it.type == "text" && it.text == failureLine }) {
        blocks + RemoteContent(type = "text", text = failureLine)
    } else {
        blocks
    }
    return ChatMessage(
        messageId = messageId,
        role = when (role) {
            "user", "assistant" -> role
            "toolResult" -> "tool"
            "custom" -> "custom"
            "bashExecution" -> "system"
            else -> return null
        },
        content = content,
        timestamp = timestamp ?: 0,
        toolCallId = toolCallId,
        toolName = toolName,
        isError = failed,
    )
}

private fun specialMessage(entry: SessionGraphEntry, label: String, field: String): ChatMessage = ChatMessage(
    messageId = entry.entryId,
    role = "system",
    content = listOf(RemoteContent(type = "text", text = "$label：${entry.data[field]?.jsonPrimitive?.contentOrNull.orEmpty()}")),
    timestamp = entry.timestamp.toTimestampMillis(),
)

private fun String.toTimestampMillis(): Long = runCatching { java.time.Instant.parse(this).toEpochMilli() }.getOrDefault(0L)
