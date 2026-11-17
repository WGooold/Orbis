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
