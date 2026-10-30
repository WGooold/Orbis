package com.orbising.orbis

import kotlinx.serialization.json.*

/** Authenticated, deliberately staggered model replies; no pairing or network storage. */
internal class HomeLoadingFixture {
    private val reducer = RelayReducer()
    private var nextRead = 0
    var state = RemoteState(hostId = "home-test", connection = RelayConnection.ONLINE, e2eReady = true)

    fun runtime(id: String, session: String = "session-$id") = RuntimeSummary(id, "Agent", "", "unknown", sessionId = session)
    fun receive(payload: String, channel: String? = "ctl") { state = reducer.reduce(state, payload, channel = channel) }
    fun directory(vararg runtimes: RuntimeSummary, epoch: String = "home-epoch") {
        receive(buildJsonObject {
            put("type", "device.ready"); put("modelEpoch", epoch)
            put("runtimes", buildJsonArray { runtimes.forEach { add(Json.encodeToJsonElement(it)) } })
        }.toString())
    }
    fun beginRead(id: String): String {
        val runtime = state.runtimes.getValue(id)
        val request = "home-read-${++nextRead}"
        val key = "agent|pi|${runtime.sessionId}"
        val previous = state.agentStateReads.filterValues { it.runtimeId == id }.keys
        state = state.copy(agentStateRequests = state.agentStateRequests - previous + request,
            agentStateReads = state.agentStateReads - previous + (request to AgentStateRead(key, "agent", HOME_MODEL_DOMAINS,
                id, runtime.sessionId, "pi")))
        return request
    }
    fun facts(id: String, names: Set<String> = HOME_MODEL_DOMAINS, title: String = "完整会话 $id",
              phase: String = "idle", revision: Int = 1, availability: String = "ready",
              completeness: String = "complete", projectionComplete: Boolean = true) {
        val read = state.agentStateReads.entries.first { it.value.runtimeId == id }
        val runtime = state.runtimes.getValue(id)
        val epoch = state.agentModelEpoch!!
        receive(buildJsonObject {
            put("type", "agent.state.snapshot"); put("scope", "agent"); put("requestId", read.key)
            put("runtimeId", id); put("sessionId", runtime.sessionId); put("agentKind", "pi"); put("modelEpoch", epoch)
            put("domains", buildJsonArray { names.forEach { name -> add(buildJsonObject {
                put("domain", name); put("modelEpoch", epoch); put("revision", revision); put("checkedAt", 1)
                put("availability", availability); put("completeness", completeness); put("projectionComplete", projectionComplete)
                put("value", when (name) {
                    "identity" -> Json.encodeToJsonElement(runtime.copy(name = "Pi", cwd = "/repo", sessionName = title, agentKind = "pi"))
                    "execution" -> buildJsonObject { put("phase", phase) }
                    else -> buildJsonObject { }
                })
            }) } })
            put("missing", JsonArray(emptyList())); put("truncated", false)
        }.toString())
    }
    fun complete(vararg ids: String) {
        directory(*ids.map { runtime(it) }.toTypedArray())
        ids.forEach { beginRead(it); facts(it) }
    }
}
