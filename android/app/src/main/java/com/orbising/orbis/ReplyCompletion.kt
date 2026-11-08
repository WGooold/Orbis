package com.orbising.orbis

import java.security.MessageDigest

internal data class ConfirmedReplyCompletion(val host: String, val session: String, val epoch: String,
    val turn: String, val runtimeName: String) {
    val identity: String get() = MessageDigest.getInstance("SHA-256").digest(
        listOf(host, session, epoch, turn).joinToString("\u0000").toByteArray(Charsets.UTF_8))
        .joinToString("") { "%02x".format(it) }
}

/** S39 / SC60: only an observed live turn with a source-confirmed completed outcome may notify. */
internal fun confirmedReplyCompletions(previous: RemoteState, next: RemoteState): List<ConfirmedReplyCompletion> {
    val host = next.hostId ?: return emptyList()
    if (previous.hostId != host || previous.deviceId != next.deviceId || !previous.e2eReady || !next.e2eReady ||
        previous.connection != RelayConnection.ONLINE || next.connection != RelayConnection.ONLINE) return emptyList()
    return previous.conversations.mapNotNull { (runtimeId, before) ->
        val runtime = next.runtimes[runtimeId] ?: return@mapNotNull null
        val session = runtime.sessionId ?: return@mapNotNull null
        if (previous.runtimes[runtimeId]?.sessionId != session) return@mapNotNull null
        val after = next.conversations[runtimeId] ?: return@mapNotNull null
        val epoch = before.sourceEpoch ?: return@mapNotNull null
        val turn = before.activeTurnId ?: return@mapNotNull null
        val finished = after.turnTimings[turn] ?: return@mapNotNull null
        if (!before.sourceReady || !after.sourceReady || after.sourceEpoch != epoch || after.sourceSeq <= before.sourceSeq ||
            before.turnTimings[turn]?.durationMs != null || finished.durationMs == null || finished.outcome != "completed") return@mapNotNull null
        ConfirmedReplyCompletion(host, session, epoch, turn, next.runtimeDisplayName(runtime))
    }
}

/** Bounded persistent receipts are shared by all Host connections. */
internal class ReplyCompletionReceipts(initial: Collection<String> = emptyList()) {
    private val seen = LinkedHashSet(initial)
    @Synchronized fun claim(identity: String): Boolean {
        if (!seen.add(identity)) return false
        while (seen.size > 2048) seen.remove(seen.first())
        return true
    }
    @Synchronized fun snapshot(): Set<String> = LinkedHashSet(seen)
}

/** Reconnection snapshots cannot inherit an active turn observed in a previous connection. */
internal class ReplyCompletionObserver {
    private var connection = -1
    private val active = mutableSetOf<String>()
    @Synchronized fun observe(previous: RemoteState, next: RemoteState, generation: Int, allowCompletion: Boolean = true): List<ConfirmedReplyCompletion> {
        if (generation != connection || !previous.e2eReady || !next.e2eReady ||
            previous.connection != RelayConnection.ONLINE || next.connection != RelayConnection.ONLINE) {
            active.clear(); connection = generation
        }
        val completed = if (allowCompletion) confirmedReplyCompletions(previous,next).filter { it.identity in active } else emptyList()
        val stillActive = mutableSetOf<String>()
        val host = next.hostId
        if (host != null && next.e2eReady && next.connection == RelayConnection.ONLINE) {
            for ((runtimeId, conversation) in next.conversations) {
                val runtime = next.runtimes[runtimeId] ?: continue
                val session = runtime.sessionId ?: continue
                val epoch = conversation.sourceEpoch ?: continue
                val turn = conversation.activeTurnId ?: continue
                if (!conversation.sourceReady) continue
                val identity = ConfirmedReplyCompletion(host,session,epoch,turn,next.runtimeDisplayName(runtime)).identity
                val before = previous.conversations[runtimeId]
                if (identity in active || before?.sourceEpoch != epoch || conversation.sourceSeq > before.sourceSeq) stillActive += identity
            }
        }
        active.clear();active += stillActive
        return completed
    }
}
