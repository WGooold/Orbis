package com.orbising.orbis

internal sealed interface LastSessionRestoreTarget {
    data class Runtime(val runtimeId: String) : LastSessionRestoreTarget
    data class History(val sessionId: String) : LastSessionRestoreTarget
}

/** MH-02: cached history is a provisional view while the running directory arrives. */
internal class LastSessionRestorer {
    var settled = false
        private set
    private var restoredHistorySessionId: String? = null

    fun cancel() {
        settled = true
        restoredHistorySessionId = null
    }

    fun next(state: RemoteState, saved: LastSession?): LastSessionRestoreTarget? {
        if (settled) return null
        if (saved == null || state.deviceId != null && state.deviceId != saved.deviceId) {
            cancel()
            return null
        }
        if (state.connection != RelayConnection.ONLINE) return null
        if (state.selectedRuntimeId != null || state.selectedOfflineSessionId != restoredHistorySessionId) {
            cancel()
            return null
        }
        val runtime = saved.sessionId?.let { sessionId ->
            state.runtimes.values.firstOrNull { it.sessionId == sessionId }
        } ?: state.runtimes[saved.runtimeId]?.takeIf {
            saved.sessionId == null || it.sessionId == null || it.sessionId == saved.sessionId
        }
        if (runtime != null) {
            cancel()
            return LastSessionRestoreTarget.Runtime(runtime.runtimeId)
        }
        if (restoredHistorySessionId != null) return null
        val sessionId = saved.sessionId?.takeIf { state.sessions[it]?.hasHistoryCache == true } ?: return null
        restoredHistorySessionId = sessionId
        return LastSessionRestoreTarget.History(sessionId)
    }
}
