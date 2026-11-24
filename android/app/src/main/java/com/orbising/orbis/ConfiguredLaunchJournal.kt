package com.orbising.orbis

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

/** A landed first sentence can be restored and reconciled, never re-submitted by recovery. */
internal data class ConfiguredFirstMessage(
    val messageId: String, val commandId: String, val text: String, val sessionId: String,
    val runtimeId: String, val agentKind: String, val codexCatalogId: String?, val createdAt: Long,
) {
    fun matches(runtime: RuntimeSummary): Boolean {
        if (runtime.sessionId != sessionId || codexCatalogId != null && runtime.codexCatalogId != codexCatalogId ||
            runtime.agentKind != null && runtime.agentKind != agentKind) return false
        return if (agentKind == "codex" || agentKind == "codexDesktop") {
            runtime.runtimeId == runtimeId || codexCatalogId != null && runtime.agentKind == agentKind
        } else runtime.agentKind == agentKind || runtime.runtimeId == runtimeId
    }

    fun pending(runtime: RuntimeSummary) = PendingSend(messageId, commandId, sessionId, text, emptyList(), null, createdAt, null,
        PendingSendState.Unconfirmed, needsDeliveryEvidence = true, runtimeId = runtime.runtimeId)

    fun diskValue() = JsonObject(mapOf("messageId" to JsonPrimitive(messageId), "commandId" to JsonPrimitive(commandId),
        "text" to JsonPrimitive(text), "sessionId" to JsonPrimitive(sessionId), "runtimeId" to JsonPrimitive(runtimeId),
        "agentKind" to JsonPrimitive(agentKind), "codexCatalogId" to JsonPrimitive(codexCatalogId), "createdAt" to JsonPrimitive(createdAt)))

    companion object {
        fun landed(launch: JsonObject, runtime: RuntimeSummary, now: Long): ConfiguredFirstMessage? {
            val id = launch.string("firstMessageId") ?: return null
            val text = launch.string("firstMessage")?.takeIf(String::isNotBlank) ?: return null
            return ConfiguredFirstMessage(id, launch.string("firstCommandId") ?: id, text, runtime.sessionId ?: return null,
                runtime.runtimeId, launch.string("agentKind") ?: return null, runtime.codexCatalogId, now)
        }

        fun fromDisk(value: JsonObject): ConfiguredFirstMessage? {
            return ConfiguredFirstMessage(
                value.string("messageId") ?: return null, value.string("commandId") ?: return null,
                value.string("text") ?: return null, value.string("sessionId") ?: return null, value.string("runtimeId") ?: return null,
                value.string("agentKind") ?: return null, value.string("codexCatalogId"), value.string("createdAt")?.toLongOrNull() ?: return null)
        }
    }
}

private fun JsonObject.string(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull
private const val LAUNCH_RECORDS_KEY = "records"

/** Each local record independently fences replies and release of its first send. */
internal class ConfiguredLaunchJournal(
    scope: CoroutineScope,
    read: () -> JsonObject?,
    private val persist: (JsonObject?) -> Boolean,
    dispatcher: CoroutineDispatcher = Dispatchers.IO,
) {
    private data class Write(val id: String, val record: JsonObject?, val result: CompletableDeferred<Boolean>, val retiring: Boolean)
    private val lock = Any()
    private val writes = Channel<Write>(Channel.UNLIMITED)
    private val initialized = CompletableDeferred<Unit>()
    @Volatile private var records: Map<String, JsonObject> = emptyMap()
    private val retiring = mutableSetOf<String>()
    val isLoaded: Boolean get() = initialized.isCompleted && !initialized.isCancelled
    val pending: List<JsonObject> get() = synchronized(lock) {
        records.values.reversed().filter { it.string("launchId")?.let(::acceptsResult) == true }
    }
    val firstMessages: List<ConfiguredFirstMessage> get() = records.values.mapNotNull { record ->
        (record["landedFirstMessage"] as? JsonObject)?.let(ConfiguredFirstMessage::fromDisk)
    }
    fun snapshot(id: String): JsonObject? = records[id]
    fun launchIdForFirstMessage(id: String): String? = records.entries.firstOrNull { it.value.string("firstMessageId") == id }?.key
    fun acceptsResult(id: String): Boolean = synchronized(lock) {
        val record = records[id] ?: return@synchronized false
        id !in retiring && !record.isLaunchDraft && record["landedFirstMessage"] == null
    }
    private val changeCount = MutableStateFlow(0L)
    val changes: StateFlow<Long> = changeCount.asStateFlow()

    init {
        scope.launch(dispatcher) {
            try {
                val saved = read()
                var baseline = (saved?.get(LAUNCH_RECORDS_KEY) as? JsonObject)?.mapNotNull { (id, value) ->
                    (value as? JsonObject)?.takeIf { it.string("launchId") == id }?.let { id to it }
                }?.toMap() ?: saved?.string("launchId")?.let { mapOf(it to saved) }.orEmpty()
                records = baseline
                changeCount.update { it + 1 }
                initialized.complete(Unit)
                for (write in writes) {
                    val next = baseline.withRecord(write.id, write.record)
                    val persisted = runCatching { persist(encode(next)) }.getOrDefault(false)
                    // Strict retirement is conditional on its own write. Other
                    // identities never include a failed retirement in their writes.
                    if (persisted || !write.retiring) baseline = next
                    finish(write, persisted)
                }
            } finally {
                initialized.cancel()
                writes.close()
                while (true) finish(writes.tryReceive().getOrNull() ?: break, false)
            }
        }
    }
    suspend fun awaitLoaded() = initialized.await()
    fun close() { writes.close() }

    fun reserve(record: JsonObject): Deferred<Boolean>? = synchronized(lock) {
        val id = record.string("launchId") ?: return@synchronized null
        if (!isLoaded || id in records) return@synchronized null
        enqueue(id, record)
    }
    fun abandon(id: String): Deferred<Boolean>? = synchronized(lock) {
        val record = records[id] ?: return@synchronized null
        if (id in retiring || record["landedFirstMessage"] != null) return@synchronized null
        if (record.isLaunchDraft) CompletableDeferred(true)
        else enqueue(id, JsonObject(record + ("abandoned" to JsonPrimitive(true))), retiringRecord = true)
    }
    fun reject(id: String, error: String): Deferred<Boolean>? = synchronized(lock) {
        val record = records[id] ?: return@synchronized null
        if (!acceptsResult(id) || record["sessionId"] != null) return@synchronized null
        enqueue(id, JsonObject(record + mapOf("rejected" to JsonPrimitive(true), "error" to JsonPrimitive(error))), retiringRecord = true)
    }
    fun update(id: String, transform: (JsonObject) -> JsonObject?): Deferred<Boolean>? = synchronized(lock) {
        val record = records[id] ?: return@synchronized null
        if (!isLoaded || id in retiring) return@synchronized null
        enqueue(id, transform(record))
    }
    fun updatePending(id: String, transform: (JsonObject) -> JsonObject?): Deferred<Boolean>? = synchronized(lock) {
        if (!acceptsResult(id)) return@synchronized null
        update(id, transform)
    }
    fun handoff(id: String, message: ConfiguredFirstMessage?): Deferred<Boolean>? = updatePending(id) {
        message?.let { JsonObject(mapOf("launchId" to JsonPrimitive(id), "landedFirstMessage" to it.diskValue())) }
    }
    fun forgetFirstMessages(ids: Set<String>) = synchronized(lock) {
        if (ids.isEmpty()) return@synchronized
        for ((id, record) in records) {
            val messageId = (record["landedFirstMessage"] as? JsonObject)?.string("messageId")
            if (messageId in ids) update(id) { null }
        }
    }
    private fun enqueue(id: String, record: JsonObject?, retiringRecord: Boolean = false): Deferred<Boolean>? {
        val result = CompletableDeferred<Boolean>()
        if (writes.trySend(Write(id, record, result, retiringRecord)).isFailure) return null
        if (retiringRecord) retiring += id
        else {
            records = records.withRecord(id, record)
            changeCount.update { it + 1 }
        }
        return result
    }
    private fun finish(write: Write, persisted: Boolean) {
        if (write.retiring) synchronized(lock) {
            if (persisted) records = records.withRecord(write.id, write.record)
            retiring -= write.id
            changeCount.update { it + 1 }
        }
        write.result.complete(persisted)
    }
    private fun encode(records: Map<String, JsonObject>): JsonObject? = when (records.size) {
        0 -> null
        1 -> records.values.single()
        else -> JsonObject(mapOf(LAUNCH_RECORDS_KEY to JsonObject(records)))
    }
    private fun Map<String, JsonObject>.withRecord(id: String, record: JsonObject?): Map<String, JsonObject> =
        if (record == null) this - id else this + (id to record)
}

internal val JsonObject.isRejectedLaunch: Boolean get() = this["rejected"]?.jsonPrimitive?.booleanOrNull == true
internal val JsonObject.isLaunchDraft: Boolean get() = isRejectedLaunch || this["abandoned"]?.jsonPrimitive?.booleanOrNull == true

internal data class RecoveredLaunchDraft(val agentKind: String, val cwd: String, val text: String)

internal fun JsonObject.recoveredLaunchDraft(): RecoveredLaunchDraft? {
    if (!isLaunchDraft) return null
    val agent = this["agentKind"]?.jsonPrimitive?.contentOrNull ?: return null
    val cwd = this["cwd"]?.jsonPrimitive?.contentOrNull ?: return null
    return RecoveredLaunchDraft(agent, cwd, this["firstMessage"]?.jsonPrimitive?.contentOrNull.orEmpty())
}
