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

/** Memory-only admission with ordered durable writes. No disk-owning lock reaches the UI. */
internal class ConfiguredLaunchJournal(
    scope: CoroutineScope,
    read: () -> JsonObject?,
    private val persist: (JsonObject?) -> Boolean,
    dispatcher: CoroutineDispatcher = Dispatchers.IO,
) {
    private data class Write(val value: JsonObject?, val result: CompletableDeferred<Boolean>)
    private val lock = Any()
    private val writes = Channel<Write>(Channel.UNLIMITED)
    private val initialized = CompletableDeferred<Unit>()
    @Volatile var snapshot: JsonObject? = null
        private set
    val isLoaded: Boolean get() = initialized.isCompleted && !initialized.isCancelled
    val launchId: String? get() = snapshot?.get("launchId")?.jsonPrimitive?.contentOrNull
    val pending: JsonObject? get() = snapshot?.takeUnless { it.isLaunchDraft }
    val pendingId: String? get() = pending?.get("launchId")?.jsonPrimitive?.contentOrNull
    private val changeCount = MutableStateFlow(0L)
    /** SC106: advances on load completion and each accepted change, so dependent warnings can reconcile. */
    val changes: StateFlow<Long> = changeCount.asStateFlow()

    init {
        scope.launch(dispatcher) {
            try {
                snapshot = read()
                // Awaiters must observe both the recovered snapshot and its load notification.
                changeCount.update { it + 1 }
                initialized.complete(Unit)
                for (write in writes) {
                    // A failed write retains the in-memory identity for an explicit retry.
                    write.result.complete(runCatching { persist(write.value) }.getOrDefault(false))
                }
            } finally {
                initialized.cancel()
                writes.close()
                while (true) (writes.tryReceive().getOrNull() ?: break).result.complete(false)
            }
        }
    }

    suspend fun awaitLoaded() = initialized.await()

    /** Graceful store closure drains accepted writes; connection replacement reuses this store. */
    fun close() { writes.close() }

    /** A failed or explicitly abandoned launch is only a draft; it does not reserve the launch slot. */
    fun reserve(value: JsonObject): Deferred<Boolean>? = synchronized(lock) {
        if (pending != null) return@synchronized null
        update(launchId) { value }
    }

    /** Store the draft under the old ID, but never accept launch results for it again. */
    fun abandon(id: String): Deferred<Boolean>? = synchronized(lock) {
        val saved = snapshot?.takeIf { launchId == id } ?: return@synchronized null
        update(id) { JsonObject(saved + ("abandoned" to JsonPrimitive(true))) }
    }

    /** Identity fencing prevents a late result/cleanup from replacing a newer launch. */
    fun update(expectedId: String?, transform: (JsonObject?) -> JsonObject?): Deferred<Boolean>? = synchronized(lock) {
        if (!isLoaded || launchId != expectedId) return@synchronized null
        val next = transform(snapshot)
        val result = CompletableDeferred<Boolean>()
        if (writes.trySend(Write(next, result)).isFailure) return@synchronized null
        snapshot = next
        changeCount.update { it + 1 }
        result
    }
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
