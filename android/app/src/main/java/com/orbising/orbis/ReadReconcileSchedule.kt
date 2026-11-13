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
