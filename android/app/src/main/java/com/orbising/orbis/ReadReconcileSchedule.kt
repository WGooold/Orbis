package com.orbising.orbis

/** FT-G11: failed attempts and successful publications both bound periodic IO.
 * Explicit reads and source-gap recovery retain their own operation owners. */
internal class ReadReconcileSchedule(private val intervalMs: Long = 60_000) {
    private var attemptedAt: Long? = null
    private var confirmedAt: Long? = null

    @Synchronized fun started(now: Long) { attemptedAt = now }
    @Synchronized fun confirmed(now: Long) { confirmedAt = now }
    @Synchronized fun claim(now: Long): Boolean {
        val last = listOfNotNull(attemptedAt, confirmedAt).maxOrNull()
        if (last != null && now - last < intervalMs) return false
        attemptedAt = now
        return true
    }
}

/** FT-G12-RESUME-01: correlate acknowledgements with the current subscription,
 * serialize publishers, and retry a lost acknowledgement at a bounded interval. */
internal class HistoryWindowInterest {
    private var target: String? = null
    private var pendingRequestId: String? = null
    private var sentAt: Long? = null
    private var confirmed: String? = null

    @Synchronized fun publish(target: String, now: Long, send: (String) -> Boolean) {
        if (this.target == target && (pendingRequestId == null || sentAt?.let { now - it >= 20_000 } != true)) return
        val id = java.util.UUID.randomUUID().toString()
        if (!send(id)) return
        this.target = target; pendingRequestId = id; sentAt = now; confirmed = null
    }

    @Synchronized fun consume(requestId: String?, accepted: Boolean): Boolean {
        if (requestId == null || requestId != pendingRequestId) return false
        pendingRequestId = null; sentAt = null
        confirmed = if (accepted) target else null
        if (!accepted) target = null
        return true
    }

    @Synchronized fun confirms(target: String): Boolean = confirmed == target
    @Synchronized fun reset() { target = null; pendingRequestId = null; sentAt = null; confirmed = null }
}
