package com.orbising.orbis

internal data class SessionLoadRequest(val device: DeviceCredential, val runtime: RuntimeSummary)

/** Claim and release are atomic with enqueue: a request cannot land behind an exiting worker. */
internal class SessionLoadQueue {
    private val pending = linkedMapOf<Pair<String, String>, SessionLoadRequest>()
    private var owner: Long? = null
    private var nextOwner = 0L

    @Synchronized fun enqueue(requests: List<SessionLoadRequest>): Long? {
        requests.forEach { pending[it.device.deviceId to it.runtime.runtimeId] = it }
        if (pending.isEmpty() || owner != null) return null
        return (++nextOwner).also { owner = it }
    }

    @Synchronized fun take(worker: Long, selectedRuntimeId: String?): List<SessionLoadRequest>? {
        if (owner != worker) return null
        if (pending.isEmpty()) {
            owner = null
            return null
        }
        return pending.values.sortedBy { it.runtime.runtimeId != selectedRuntimeId }.also { pending.clear() }
    }

    @Synchronized fun release(worker: Long): List<SessionLoadRequest> {
        if (owner != worker) return emptyList()
        owner = null
        return pending.values.toList().also { pending.clear() }
    }
}
