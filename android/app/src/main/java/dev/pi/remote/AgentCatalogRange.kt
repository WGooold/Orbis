package dev.pi.remote

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

/** Fixed catalog version, accumulated independently from the committed first-window value. */
data class AgentCatalogRange(
    val modelEpoch: String,
    val revision: Long,
    val snapshotId: String,
    val value: JsonObject,
    val sessions: List<SessionCatalogEntry>,
    val nextCursor: String?,
    val totalSessions: Int,
    val complete: Boolean,
    val truncated: Boolean,
    val seenCursors: Set<String> = emptySet(),
    val error: String? = null,
)

data class AgentCatalogRangeRequest(
    val requestId: String,
    val cursor: String,
    val modelEpoch: String,
    val revision: Long,
    val snapshotId: String,
    val offset: Int,
    val sentAt: Long = System.currentTimeMillis(),
)

internal fun RemoteState.beginCatalogRange(domain: AgentStateDomainView, json: Json): RemoteState {
    if (domain.availability != "ready") return copy(agentCatalogRange = null, agentCatalogRangeRequest = null)
    val value = domain.value as? JsonObject ?: return this
    val snapshotId = value.text("snapshotId") ?: return copy(agentCatalogRange = null, agentCatalogRangeRequest = null)
    val rows = value["sessions"] as? JsonArray ?: return this
    val sessions = runCatching { json.decodeFromJsonElement<List<SessionCatalogEntry>>(rows) }.getOrNull() ?: return this
    val total = value["totalSessions"]?.jsonPrimitive?.intOrNull ?: sessions.size
    val cursor = value.text("nextCursor")
    val old = agentCatalogRange
    if (old?.modelEpoch == domain.modelEpoch && old.revision == domain.revision && old.snapshotId == snapshotId)
        return this
    return copy(agentCatalogRange = AgentCatalogRange(domain.modelEpoch, domain.revision, snapshotId, value, sessions,
        cursor, total, domain.completeness == "complete", value["truncated"]?.jsonPrimitive?.booleanOrNull == true),
        agentCatalogRangeRequest = null)
}

internal fun RemoteState.withAgentCatalogRangePage(message: JsonObject, json: Json): RemoteState {
    val pending = agentCatalogRangeRequest ?: return this
    if (message.text("requestId") != pending.requestId || message.text("scope") != "host" || message.text("domain") != "catalog") return this
    val range = agentCatalogRange ?: return copy(agentCatalogRangeRequest = null)
    if (range.modelEpoch != pending.modelEpoch || range.revision != pending.revision || range.snapshotId != pending.snapshotId ||
        range.nextCursor != pending.cursor || range.sessions.size != pending.offset) return copy(agentCatalogRangeRequest = null)
    val cleared = copy(agentCatalogRangeRequest = null)
    fun rejected(reason: String) = cleared.copy(agentCatalogRange = range.copy(nextCursor = null, error = reason))
    val page = message["page"] as? JsonObject ?: return rejected("invalid_page")
    page.text("error")?.let { return rejected(it) }
    if (page.text("modelEpoch") != pending.modelEpoch || page["revision"]?.jsonPrimitive?.longOrNull != pending.revision ||
        page.text("snapshotId") != pending.snapshotId || page["offset"]?.jsonPrimitive?.intOrNull != pending.offset ||
        page["totalSessions"]?.jsonPrimitive?.intOrNull != range.totalSessions || agentModelEpoch != pending.modelEpoch)
        return rejected("snapshot_changed")
    val rows = page["sessions"] as? JsonArray ?: return rejected("invalid_page")
    val entries = runCatching { json.decodeFromJsonElement<List<SessionCatalogEntry>>(rows) }.getOrNull()
        ?: return rejected("invalid_page")
    val next = page.text("nextCursor")
    val complete = page["complete"]?.jsonPrimitive?.booleanOrNull ?: return rejected("invalid_page")
    val truncated = page["truncated"]?.jsonPrimitive?.booleanOrNull ?: return rejected("invalid_page")
    val combined = range.sessions + entries
    if (entries.size > 200 || combined.size > range.totalSessions || combined.map { it.sessionId }.distinct().size != combined.size ||
        next != null && (entries.isEmpty() || next == pending.cursor || next in range.seenCursors) ||
        next == null && !truncated && combined.size != range.totalSessions)
        return rejected("invalid_page")
    val updated = range.copy(sessions = combined, nextCursor = next, complete = complete,
        truncated = truncated, seenCursors = range.seenCursors + pending.cursor)
    val value = JsonObject(range.value + mapOf("sessions" to JsonArray(combined.map {
        json.encodeToJsonElement(SessionCatalogEntry.serializer(), it)
    }), "nextCursor" to (next?.let(::JsonPrimitive) ?: JsonNull), "truncated" to JsonPrimitive(truncated)))
    val domain = AgentStateDomainView("catalog", range.modelEpoch, range.revision, "ready",
        if (complete) "complete" else "partial", 0, value, projectionComplete = true)
    return cleared.copy(agentCatalogRange = updated).applyHostDomainProjection(mapOf("catalog" to domain), json)
}

private fun JsonObject.text(key: String): String? = (get(key) as? JsonPrimitive)?.contentOrNull
