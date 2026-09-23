package dev.pi.remote

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull

/** One validation rule for SQLite and the bounded in-memory canonical tree. Missing parents are
 * allowed; an existing identity can never be rewritten by a display mode or arrival order. */
internal fun validateCanonicalEntries(
    incoming: Collection<SessionGraphEntry>,
    lookup: (String) -> SessionGraphEntry?,
    parentOf: (String) -> String? = { lookup(it)?.parentId },
): Map<String, SessionGraphEntry> {
    val received = linkedMapOf<String, SessionGraphEntry>()
    for (entry in incoming) {
        require(entry.entryId.isNotBlank()) { "entry_id_required" }
        require(entry.parentId != entry.entryId) { "self_parent" }
        require(entry.type.isNotBlank()) { "entry_type_required" }
        require(entry.timestamp.isNotBlank()) { "entry_timestamp_required" }
        val duplicate = received.putIfAbsent(entry.entryId, entry)
        require(duplicate == null || duplicate == entry) { "entry_conflict" }
        val existing = lookup(entry.entryId)
        require(existing == null || existing == entry) { "entry_conflict" }
    }
    val checked = mutableSetOf<String>()
    for (id in received.keys) {
        val visiting = mutableSetOf<String>()
        var current: String? = id
        while (current != null && current !in checked) {
            require(visiting.add(current)) { "cycle_detected" }
            current = if (received.containsKey(current)) received[current]?.parentId else parentOf(current)
        }
        checked.addAll(visiting)
    }
    return received
}

/** Null fields may be filled in, but a later response cannot retract or replace known facts. */
internal fun mergeCanonicalTiming(existing: TurnTiming?, incoming: TurnTiming): TurnTiming {
    require(incoming.turnId.isNotBlank() && incoming.startedAt >= 0L) { "turn_timing_invalid" }
    require(incoming.durationMs == null || incoming.durationMs >= 0L) { "turn_duration_invalid" }
    if (existing == null) return incoming
    require(existing.turnId == incoming.turnId && existing.startedAt == incoming.startedAt) { "turn_timing_conflict" }
    fun <T> fact(old: T?, new: T?): T? {
        require(old == null || new == null || old == new) { "turn_timing_conflict" }
        return old ?: new
    }
    return existing.copy(
        durationMs = fact(existing.durationMs, incoming.durationMs),
        turnIndex = fact(existing.turnIndex, incoming.turnIndex),
        messageId = fact(existing.messageId, incoming.messageId),
    )
}

/** Only the old, identified Codex projection is convertible. Callers archive the original row
 * inside the same transaction; Pi Entries and actual parent/content disagreements are untouched. */
internal fun migrateLegacyCodexEntry(entry: SessionGraphEntry): SessionGraphEntry {
    require(entry.type == "message" && entry.data.keys == setOf("message")) { "legacy_codex_shape_unknown" }
    val message = entry.data["message"] as? JsonObject ?: error("legacy_codex_shape_unknown")
    require((message["messageId"] as? JsonPrimitive)?.contentOrNull == entry.entryId) { "legacy_codex_shape_unknown" }
    require((message["timestamp"] as? JsonPrimitive)?.longOrNull != null) { "legacy_codex_shape_unknown" }
    val fields = message.toMutableMap()
    fields["timestamp"] = JsonPrimitive(0L)
    return entry.copy(timestamp = "1970-01-01T00:00:00.000Z", data = JsonObject(mapOf("message" to JsonObject(fields))))
}

data class SessionSyncGap(val knownLeafId: String?, val targetLeafId: String)
