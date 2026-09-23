package dev.pi.remote

import java.util.UUID

internal fun newSessionSyncCommandId(): String = "session-sync:${UUID.randomUUID()}"
internal fun String.isSessionSyncCommandId(): Boolean = startsWith("session-sync:")

internal const val SESSION_SYNC_TASK_LIMIT = 32
private const val MAX_ACTIVE = 2
private const val MAX_CATCHUP = 1
private const val SLOW_AFTER_MS = 8_000L
private const val EXHAUST_AFTER_MS = 150_000L
private const val RETAIN_UNTIL_MS = 300_000L
private val RETRY_DELAY_MS = listOf(30_000L, 30_000L, 60_000L)
internal const val SESSION_SYNC_TIMEOUT_MESSAGE = "同步暂未完成，请重试"

internal data class SessionSyncDispatch(val commandId: String, val task: PendingSessionSync)
internal data class SessionSyncTick(val state: RemoteState, val send: List<SessionSyncDispatch>)

/** Pure clock-driven policy. Mark sends before emitting effects so another tick cannot enqueue
 * the same request twice. A backend acknowledgement is deliberately absent from this policy. */
internal fun advanceSessionSyncTasks(state: RemoteState, now: Long, connectionGeneration: Int? = null): SessionSyncTick {
    var next = state
    val send = mutableListOf<SessionSyncDispatch>()
    for ((id, task) in state.sessionSyncCommands) {
        val runtime = next.runtimes[task.runtimeId]
        val obsolete = runtime?.sessionId != task.sessionId ||
            (connectionGeneration != null && task.connectionGeneration != connectionGeneration) ||
            task.branchGeneration != (next.sessionBranchGenerations[task.runtimeId] ?: 0)
        if (obsolete || (task.exhaustedAt != null && now - task.firstSentAt >= RETAIN_UNTIL_MS)) {
            next = next.releaseHistoryRequest(id).copy(
                sessionSyncCommands = next.sessionSyncCommands - id, pendingCommands = next.pendingCommands - id,
            )
            continue
        }
        if (task.attempts == 0 || task.exhaustedAt != null) continue
        val elapsed = (now - task.firstSentAt).coerceAtLeast(0)
        if (elapsed >= EXHAUST_AFTER_MS) {
            next = next.failSessionSync(id, SESSION_SYNC_TIMEOUT_MESSAGE).copy(
                // Retain bounded correlation for an authentic late response to repair the view.
                sessionSyncCommands = next.sessionSyncCommands + (id to task.copy(exhaustedAt = now, slow = true)),
            )
            continue
        }
        var updated = task.copy(slow = elapsed >= SLOW_AFTER_MS)
        val retryDelay = RETRY_DELAY_MS.getOrNull(task.attempts - 1)
        if (retryDelay != null && now - task.sentAt >= retryDelay) {
            updated = updated.copy(attempts = task.attempts + 1, sentAt = now)
            send += SessionSyncDispatch(id, updated)
        }
        if (updated != task) next = next.copy(sessionSyncCommands = next.sessionSyncCommands + (id to updated))
    }
    var active = next.sessionSyncCommands.values.count { it.attempts > 0 && it.exhaustedAt == null }
    var catchup = next.sessionSyncCommands.values.count { it.attempts > 0 && it.exhaustedAt == null && it.range == "catchup" }
    // Foreground requests get the second slot while a background request continues in its own slot.
    val queued = next.sessionSyncCommands.entries.filter { it.value.attempts == 0 }
        .sortedWith(compareBy<Map.Entry<String, PendingSessionSync>> { it.value.range == "catchup" }
            .thenBy { it.value.runtimeId != next.selectedRuntimeId })
    for ((id, task) in queued) {
        if (active >= MAX_ACTIVE) break
        // Reserve one slot for an already queued background request even under repeated paging.
        if (task.range != "catchup" && active >= MAX_ACTIVE - 1 && catchup == 0 &&
            queued.any { it.value.range == "catchup" && it.value.runtimeId !in next.sessionSyncFailures }) continue
        if (task.range == "catchup" && catchup >= MAX_CATCHUP) continue
        if (task.runtimeId in next.sessionSyncFailures) continue
        val started = task.copy(attempts = 1, firstSentAt = now, sentAt = now)
        next = next.copy(sessionSyncCommands = next.sessionSyncCommands + (id to started))
        send += SessionSyncDispatch(id, started)
        active += 1
        if (task.range == "catchup") catchup += 1
    }
    return SessionSyncTick(next, send)
}

internal fun RemoteState.queueSessionSync(commandId: String, task: PendingSessionSync): RemoteState {
    if (task.runtimeId in sessionSyncFailures || sessionSyncCommands.values.any {
            it.runtimeId == task.runtimeId && it.sessionId == task.sessionId && it.range == task.range
        }) return this
    var next = this
    // Expired correlations are expendable only at this hard capacity bound or on explicit retry.
    for ((id, _) in sessionSyncCommands.filterValues { it.exhaustedAt != null }) {
        if (next.sessionSyncCommands.size < SESSION_SYNC_TASK_LIMIT) break
        next = next.copy(sessionSyncCommands = next.sessionSyncCommands - id, pendingCommands = next.pendingCommands - id)
    }
    if (next.sessionSyncCommands.size >= SESSION_SYNC_TASK_LIMIT) {
        val conversation = next.conversations[task.runtimeId] ?: RuntimeConversation()
        val message = "同步任务已满，请稍后重试"
        return next.copy(
            sessionSyncFailures = next.sessionSyncFailures + (task.runtimeId to message),
            sessionSyncRequests = next.sessionSyncRequests - task.runtimeId,
            conversations = next.conversations + (task.runtimeId to conversation.copy(isChatSyncing = false, chatSyncError = message)),
            sessionHistory = next.sessionHistory.mapValues { (id, history) ->
                if (id == task.runtimeId && history.requestId == null) history.copy(loading = false) else history
            },
        )
    }
    return next.copy(
        sessionSyncCommands = next.sessionSyncCommands + (commandId to task.copy(attempts = 0)),
        pendingCommands = next.pendingCommands + (commandId to task.runtimeId),
    )
}

internal fun RemoteState.cancelForegroundSessionSyncs(exceptRuntimeId: String?): RemoteState {
    val ids = sessionSyncCommands.filterValues { it.runtimeId != exceptRuntimeId && it.range != "catchup" }.keys
    val released = ids.fold(this) { current, id -> current.releaseHistoryRequest(id) }
    return released.copy(sessionSyncCommands = released.sessionSyncCommands - ids, pendingCommands = released.pendingCommands - ids,
        sessionSyncRequests = released.sessionSyncRequests.filterTo(mutableSetOf()) { it == exceptRuntimeId })
}

internal fun RemoteState.retrySessionSync(runtimeId: String): RemoteState {
    val ids = sessionSyncCommands.filterValues { it.runtimeId == runtimeId }.keys
    val released = ids.fold(this) { current, id -> current.releaseHistoryRequest(id) }
    val conversation = released.conversations[runtimeId] ?: RuntimeConversation()
    return released.copy(
        sessionSyncCommands = released.sessionSyncCommands - ids, pendingCommands = released.pendingCommands - ids,
        sessionSyncFailures = released.sessionSyncFailures - runtimeId,
        conversations = released.conversations + (runtimeId to conversation.copy(chatSyncError = null)),
    )
}
