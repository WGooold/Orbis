package dev.pi.remote

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.encodeToString

/** 显式声明 Host 已提交领域；不把旧 runtime 事件翻译成模型或模拟兼容写入。 */
internal fun RemoteState.withModelFixture(
    domain: String,
    value: String,
    revision: Long = 1,
    runtimeId: String? = selectedRuntimeId ?: runtimes.keys.singleOrNull(),
    scope: String = "agent",
    completeness: String = "complete",
    availability: String = "ready",
): RemoteState {
    val runtime = if (scope == "agent") requireNotNull(runtimes[runtimeId]) else null
    val kind = runtime?.agentKind ?: runtime?.sessionId?.let(sessions::get)?.agentKind ?: "pi"
    val epoch = agentModelEpoch ?: "fixture-model"
    val request = "model-fixture:$scope:$domain:$revision"
    val payload = buildJsonObject {
        put("type", "agent.state.snapshot"); put("protocolVersion", PROTOCOL_VERSION)
        put("requestId", request); put("scope", scope); put("modelEpoch", epoch)
        if (runtime != null) {
            put("runtimeId", runtime.runtimeId); put("agentKind", kind); put("sessionId", requireNotNull(runtime.sessionId))
        }
        put("domains", buildJsonArray { add(buildJsonObject {
            put("domain", domain); put("modelEpoch", epoch); put("revision", revision)
            put("availability", availability); put("completeness", completeness); put("checkedAt", 100)
            put("projectionComplete", true)
            put("source", buildJsonObject { put("producer", "adapter"); put("sourceId", "fixture")
                put("sourceEpoch", "fixture-source"); put("sourceRevision", revision) })
            put("value", Json.parseToJsonElement(value))
        }) })
        put("missing", buildJsonArray {}); put("truncated", false)
    }
    val input = copy(agentModelEpoch = epoch, agentStateRequests = agentStateRequests + request)
    return RelayReducer().reduce(input, payload.toString(), channel = "ctl")
}

/** 明确的已提交聊天事务，用共同 live/canonical schema 取代旧消息生命周期测试触发器。 */
internal fun RemoteState.withLiveFixture(
    live: SessionLiveState,
    runtimeId: String = selectedRuntimeId ?: runtimes.keys.single(),
    entries: List<SessionGraphEntry> = emptyList(),
    head: String? = null,
): RemoteState {
    val runtime = requireNotNull(runtimes[runtimeId])
    val session = requireNotNull(runtime.sessionId)
    val conversation = conversations[runtimeId] ?: RuntimeConversation()
    val epoch = conversation.sourceEpoch ?: "fixture-source"
    val base = conversation.sourceSeq.takeIf { it >= 0 } ?: 0
    val input = copy(conversations = conversations + (runtimeId to conversation.copy(sourceEpoch = epoch, sourceSeq = base,
        sourceReady = true)), runtimes = runtimes + (runtimeId to runtime.copy(sessionGraphSync = true)))
    val patch = SessionPatch(sessionId = session, source = SessionSourceEpoch(epoch, base + 1, true), baseSeq = base,
        seq = base + 1, checkpointId = "$epoch:${base + 1}", head = SessionBranchCursor(head), headCompleteness = "complete",
        live = live, entries = entries)
    val payload = """{"type":"runtime.event","runtimeId":"$runtimeId","sequence":${base + 1},"event":${Json { encodeDefaults = true }.encodeToString(patch)}}"""
    return FixtureRelayReducer().reduce(input, payload, channel = "msg")
}
