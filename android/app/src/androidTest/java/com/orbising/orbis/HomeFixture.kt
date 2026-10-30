package com.orbising.orbis

/** Explicit complete in-memory model facts for UI tests that exercise gestures/navigation. */
internal fun RemoteState.withReadyHomeFixture(): RemoteState {
    val complete = runtimes.mapValues { (_, runtime) -> runtime.copy(agentKind = runtime.agentKind ?: "pi",
        domainAvailability = runtime.domainAvailability + HOME_MODEL_DOMAINS.associateWith { "ready" }) }
    return copy(connection = RelayConnection.ONLINE, homeDirectoryReceived = true, agentModelEpoch = "fixture",
        runtimes = complete, agentStateSnapshots = complete.values.associate { runtime ->
            val key = "agent|${runtime.agentKind}|${runtime.sessionId}"
            key to AgentStateSnapshotView(key, "agent", "fixture-${runtime.runtimeId}", "fixture",
                HOME_MODEL_DOMAINS.associateWith { AgentStateDomainView(it, "fixture", 1, "ready", "complete", 1) })
        }).commitHomePresentation()
}
