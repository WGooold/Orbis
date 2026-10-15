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

/**
 * 诊断目录在界面上的口径。
 *
 * 文案与色调都在这里定，Compose 只负责画：状态页上的每一句话都应当是**模型说过的话**，
 * 而不是界面自己猜的——「还没读」「电脑没报」「读失败」是三件不同的事，不能都画成「0 条」。
 */
internal data class DiagnosticDirectoryView(val text: String, val detail: String? = null, val tone: StatusTone = StatusTone.Neutral)

/**
 * 把 Host 作用域的诊断目录翻译成一句人话。
 *
 * 有缺口时必须说出来：淘汰过、落盘失败过、被字节预算截断过，都意味着这份目录不是全部历史。
 */
internal fun RemoteState.diagnosticDirectoryView(): DiagnosticDirectoryView {
    val snapshot = agentStateSnapshots.values.firstOrNull { it.scope == "host" }
        ?: return DiagnosticDirectoryView("尚未读取", "连接建立后会自动读一次")
    snapshot.error?.let { return DiagnosticDirectoryView("读取失败：" + it, null, StatusTone.Bad) }
    snapshot.missing["diagnostics"]?.let { reason ->
        val text = if (reason == "unknown_domain") "这台电脑不认识这个领域" else "电脑没有报这个领域"
        return DiagnosticDirectoryView(text, "缺席原因：" + reason, StatusTone.Warn)
    }
    val domain = snapshot.domains["diagnostics"]
        ?: return DiagnosticDirectoryView("清单里没有这个领域", "缺席没有给原因，不能当成 0 条", StatusTone.Warn)
    if (domain.availability != "ready") {
        return DiagnosticDirectoryView("电脑尚未核对", "availability=" + domain.availability, StatusTone.Warn)
    }
    val value = domain.value as? JsonObject
        ?: return DiagnosticDirectoryView("目录格式无法识别", "负载不是对象", StatusTone.Bad)
    val records = value.long("records")
        ?: return DiagnosticDirectoryView("目录缺少条数", "负载里没有 records", StatusTone.Bad)
    val dropped = value.long("dropped") ?: 0
    val persistFailures = value.long("persistFailures") ?: 0
    val notes = buildList {
        if (dropped > 0) add("已淘汰 " + dropped + " 条")
        if (persistFailures > 0) add("落盘失败 " + persistFailures + " 次")
        if (snapshot.truncated) add("清单被截断")
        if (isEmpty() && domain.completeness != "complete") add("清单不完整")
    }
    val text = if (notes.isEmpty()) records.toString() + " 条记录" else records.toString() + " 条记录（" + notes.joinToString("，") + "）"
    return DiagnosticDirectoryView(text, null, if (notes.isEmpty()) StatusTone.Good else StatusTone.Warn)
}

private fun JsonObject.long(key: String): Long? = this[key]?.jsonPrimitive?.longOrNull

