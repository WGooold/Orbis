package com.orbising.orbis

import android.os.SystemClock
import android.util.Log
import java.security.MessageDigest
import java.util.UUID

/** Opt-in, content-free timings for the real-device history reload probe.
 * Enable with `adb shell setprop log.tag.OrbisHistory DEBUG`; remove after diagnosis.
 */
internal class HistoryLoadProbe private constructor(private val id: String) {
    private val startedAt = SystemClock.elapsedRealtime()

    fun mark(stage: String, details: String = "") {
        Log.d(TAG, "[DEBUG-history] trace=$id stage=$stage elapsedMs=${SystemClock.elapsedRealtime() - startedAt} $details")
    }

    companion object {
        private const val TAG = "OrbisHistory"

        fun start(kind: String, sessionId: String, boundary: String?, range: String,
                  leafId: String? = null, cacheEpoch: String? = null): HistoryLoadProbe? {
            if (!Log.isLoggable(TAG, Log.DEBUG)) return null
            return HistoryLoadProbe(UUID.randomUUID().toString()).also {
                it.mark("start", "kind=$kind session=${key(sessionId)} boundary=${key(boundary.orEmpty())} range=$range " +
                    "leaf=${key(leafId.orEmpty())} epoch=${key(cacheEpoch.orEmpty())}")
            }
        }

        private fun key(value: String): String = MessageDigest.getInstance("SHA-256")
            .digest(value.toByteArray(Charsets.UTF_8)).take(8)
            .joinToString("") { "%02x".format(it.toInt() and 0xff) }
    }
}
