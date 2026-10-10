package dev.pi.remote

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.decodeFromJsonElement

@Serializable
data class NoticeScope(val turnId: String? = null, val requestId: String? = null,
    val operationId: String? = null, val commandId: String? = null)

@Serializable
data class RuntimeNotice(
    val notificationId: String, val producerEpoch: String, val code: String, val occurrenceId: String,
    val scope: NoticeScope, val severity: String, val message: String, val lifecycle: String,
    val createdAt: Long, val updatedAt: Long, val verification: String,
    val displayMs: Long? = null, val expiresAt: Long? = null,
)

@Serializable
data class NoticeSnapshot(
    val hostEpoch: String, val runtimeId: String, val sessionId: String?, val revision: Long,
    val complete: Boolean, val verification: String, val notifications: List<RuntimeNotice>,
)

data class NoticeProjection(val hostEpoch: String, val revision: Long, val sessionId: String?,
    val verification: String, val items: List<RuntimeNotice>, val complete: Boolean = true)

/** Independent of transport sequence and Session history versions. Only complete inventories replace. */
internal fun RemoteState.withNotificationSnapshot(message: JsonObject, json: Json): RemoteState {
    val snapshot = runCatching { json.decodeFromJsonElement<NoticeSnapshot>(message) }.getOrNull() ?: return this
    if (snapshot.hostEpoch != notificationEpoch || snapshot.revision < 0 || snapshot.notifications.size > 64 ||
        message.toString().toByteArray(Charsets.UTF_8).size > 256 * 1024) return this
    val expectedSession = runtimes[snapshot.runtimeId]?.sessionId ?: knownRuntimeSessions[snapshot.runtimeId]
    if (snapshot.runtimeId !in runtimes && snapshot.runtimeId !in knownRuntimeSessions) return this
    if (snapshot.sessionId != expectedSession && !(snapshot.sessionId == null && snapshot.notifications.isEmpty())) return this
    if (snapshot.verification !in setOf("confirmed", "unknown") || snapshot.notifications.any {
        listOf(it.notificationId, it.producerEpoch, it.code, it.occurrenceId).any { id -> id.isBlank() || id.length > 256 } ||
            listOfNotNull(it.scope.turnId, it.scope.requestId, it.scope.operationId, it.scope.commandId).any { id -> id.isBlank() || id.length > 256 } ||
            it.message.isBlank() || it.message.toByteArray(Charsets.UTF_8).size > 4096 ||
            it.createdAt < 0 || it.updatedAt < it.createdAt || (it.expiresAt != null && it.expiresAt < it.createdAt) ||
            (it.displayMs != null && it.displayMs !in 1000..300000) ||
            it.lifecycle !in setOf("condition", "outcome") || it.severity !in setOf("info", "warning", "error") ||
            it.verification !in setOf("confirmed", "unknown") || (it.lifecycle == "condition" && (it.expiresAt != null || it.displayMs != null))
    } || snapshot.notifications.map { it.notificationId }.distinct().size != snapshot.notifications.size) return this
    val previous = notificationProjections[snapshot.runtimeId]
    if (previous?.hostEpoch == snapshot.hostEpoch && previous.revision > snapshot.revision) return this
    val receipts = notificationReceipts + (snapshot.runtimeId to ((notificationReceipts[snapshot.runtimeId] ?: 0) + 1))
    if (previous?.hostEpoch == snapshot.hostEpoch && previous.revision == snapshot.revision) return copy(notificationReceipts = receipts)
    val projection = if (snapshot.complete) NoticeProjection(snapshot.hostEpoch, snapshot.revision,
        snapshot.sessionId, snapshot.verification, snapshot.notifications)
    else NoticeProjection(snapshot.hostEpoch, snapshot.revision, snapshot.sessionId, "unknown",
        previous?.takeIf { it.sessionId == snapshot.sessionId }?.items.orEmpty(), false)
    var projections = notificationProjections
    var boundedReceipts = receipts
    if (snapshot.runtimeId !in projections && projections.size >= 2048) {
        val retired = projections.keys.firstOrNull { it !in runtimes } ?: return this
        projections = projections - retired; boundedReceipts = boundedReceipts - retired
    }
    return copy(notificationProjections = projections + (snapshot.runtimeId to projection), notificationReceipts = boundedReceipts)
}
