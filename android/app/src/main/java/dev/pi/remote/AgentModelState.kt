package dev.pi.remote

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

/**
 * Host 统一状态模型里的一个领域（ADR-0032）。
 *
 * `value` 对客户端是不透明的领域负载：读的人按 [domain] 去解释，而不是让协议层认识每个领域的内容。
 */
data class AgentStateDomainView(
    val domain: String,
    val modelEpoch: String,
    val revision: Long,
    val availability: String,
    val completeness: String,
    val checkedAt: Long,
    val value: JsonElement? = null,
)

/**
 * 一次模型读取的结果（`agent.state.snapshot`，ADR-0032 issue #10 的客户端一半）。
 *
 * 三条纪律：
 * - **整份替换**：同一个 [key] 上的新快照顶掉旧的，不做字段级合并——半新半旧的模型比没有模型更危险；
 * - **缺席有原因**：[missing] 记下点名要却没有状态的领域（`no_state`）与名字不属于该作用域
 *   （`unknown_domain`），所以「领域表里没有它」永远不等于「它是空的」；
 * - **截断如实说**：[truncated] 为 true 时这份清单被字节预算切过，不能当基线。
 *
 * [modelEpoch] 是模型代次，与通知协议的 `hostEpoch` 是两件事，不得互相代替。
 */
data class AgentStateSnapshotView(
    val key: String,
    val scope: String,
    val requestId: String,
    val modelEpoch: String? = null,
    val domains: Map<String, AgentStateDomainView> = emptyMap(),
    val missing: Map<String, String> = emptyMap(),
    val truncated: Boolean = false,
    val error: String? = null,
)

/** 快照身份：作用域 + 会话/运行时身份。Host 按这个身份回答，客户端也按它存放。 */
internal fun agentStateSnapshotKey(message: JsonObject): String = listOf(
    message.string("scope") ?: "host",
    message.string("runtimeId").orEmpty(),
    message.string("agentKind").orEmpty(),
    message.string("sessionId").orEmpty(),
).joinToString("|")

/**
 * 收下一次模型读取的应答。
 *
 * 解析失败的整条快照按「读取失败」处理，而不是丢掉坏的那一条：Host 的 envelope 缺字段说明两端
 * 对协议的理解已经不一致，此时留下半份模型比什么都不留更糟。
 */
internal fun RemoteState.withAgentStateSnapshot(message: JsonObject): RemoteState {
    val requestId = message.string("requestId") ?: return this
    val key = agentStateSnapshotKey(message)
    val scope = message.string("scope") ?: "host"
    // 应答到达即销账：无论是成功、失败还是坏消息，都不该继续挂在「已发出」里。
    val cleared = copy(agentStateRequests = agentStateRequests - requestId)
    val failure = message.string("error")
    if (failure != null) return cleared.storeSnapshot(key, AgentStateSnapshotView(
        key = key, scope = scope, requestId = requestId, error = failure,
    ))
    val entries = message["domains"]?.jsonArray ?: return cleared
    val domains = LinkedHashMap<String, AgentStateDomainView>()
    for (element in entries) {
        val row = element as? JsonObject
            ?: return cleared.rejectedSnapshot(key, scope, requestId, "模型快照里的领域不是对象")
        val domain = row.string("domain")
        val modelEpoch = row.string("modelEpoch")
        val revision = row["revision"]?.jsonPrimitive?.longOrNull
        val availability = row.string("availability")
        val completeness = row.string("completeness")
        val checkedAt = row["checkedAt"]?.jsonPrimitive?.longOrNull
        if (domain == null || modelEpoch == null || revision == null ||
            availability == null || completeness == null || checkedAt == null
        ) {
            return cleared.rejectedSnapshot(key, scope, requestId, "模型快照里的领域缺少 envelope 字段")
        }
        domains[domain] = AgentStateDomainView(
            domain = domain, modelEpoch = modelEpoch, revision = revision,
            availability = availability, completeness = completeness, checkedAt = checkedAt,
            value = row["value"],
        )
    }
    val missing = LinkedHashMap<String, String>()
    for (element in (message["missing"] as? JsonArray).orEmpty()) {
        val row = element as? JsonObject ?: continue
        val domain = row.string("domain") ?: continue
        missing[domain] = row.string("reason") ?: "unknown"
    }
    return cleared.storeSnapshot(key, AgentStateSnapshotView(
        key = key,
        scope = scope,
        requestId = requestId,
        modelEpoch = message.string("modelEpoch"),
        domains = domains,
        missing = missing,
        truncated = message["truncated"]?.jsonPrimitive?.booleanOrNull == true,
    ))
}

private fun RemoteState.storeSnapshot(key: String, view: AgentStateSnapshotView): RemoteState =
    copy(agentStateSnapshots = agentStateSnapshots + (key to view))

private fun RemoteState.rejectedSnapshot(key: String, scope: String, requestId: String, reason: String): RemoteState =
    storeSnapshot(key, AgentStateSnapshotView(key = key, scope = scope, requestId = requestId, error = reason))

private fun JsonObject.string(key: String): String? = this[key]?.jsonPrimitive?.contentOrNull
