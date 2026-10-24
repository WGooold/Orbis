package dev.pi.remote

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
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
    /** 完整的 Host 已提交投影；与 source 清单是否 complete 无关。 */
    val projectionComplete: Boolean = false,
)

data class AgentStateRead(
    val key: String,
    val scope: String,
    val domains: Set<String>,
    val runtimeId: String? = null,
    val sessionId: String? = null,
    val agentKind: String? = null,
    val subscribe: Boolean = true,
    val sentAt: Long = System.currentTimeMillis(),
)

internal val AGENT_MODEL_DOMAINS = listOf(
    "identity", "availability", "execution", "delivery", "interactions", "permissions",
    "model", "context", "capabilities", "resources", "providerBinding", "workspaceRef", "artifacts", "records",
)
internal val HOST_MODEL_DOMAINS = listOf("identity", "backends", "catalog", "providers", "workspaces", "files", "operations", "diagnostics", "connections", "management")

/**
 * 一次模型读取的结果（`agent.state.snapshot`，ADR-0032 issue #10 的客户端一半）。
 *
 * 三条纪律：
 * - **分域替换**：每个领域按自身版本独立替换，刷新供应商不会抹掉诊断或目录基线；
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
    message.string("agentKind").orEmpty(),
    message.string("sessionId") ?: message.string("runtimeId").orEmpty(),
).joinToString("|")

/**
 * 收下一次模型读取的应答。
 *
 * 解析失败的整条快照按「读取失败」处理，而不是丢掉坏的那一条：Host 的 envelope 缺字段说明两端
 * 对协议的理解已经不一致，此时留下半份模型比什么都不留更糟。
 */
internal fun RemoteState.withAgentStateSnapshot(
    message: JsonObject,
    json: Json,
    parseInteraction: (Json, JsonObject, PendingInteraction?) -> PendingInteraction?,
): RemoteState {
    val requestId = message.string("requestId") ?: return this
    val read = agentStateReads[requestId]
    // 只收本连接登记的请求或订阅；旧连接的迟到消息不能建立代次或写回镜像。
    if (read == null && requestId !in agentStateRequests) return this
    val key = agentStateSnapshotKey(message)
    val scope = message.string("scope") ?: "host"
    if (read != null && (read.scope != scope || read.sessionId != message.string("sessionId") ||
            read.runtimeId != message.string("runtimeId") || read.agentKind != null && read.agentKind != message.string("agentKind"))) return this
    // 应答到达即销账：无论是成功、失败还是坏消息，都不该继续挂在「已发出」里。
    val cleared = copy(agentStateRequests = agentStateRequests - requestId,
        agentStateReads = if (read?.subscribe == true) agentStateReads else agentStateReads - requestId)
    val failure = message.string("error")
    if (failure != null) return cleared.storeSnapshot(key, AgentStateSnapshotView(
        key = key, scope = scope, requestId = requestId, error = failure,
    ))
    val epoch = message.string("modelEpoch") ?: return cleared.rejectedSnapshot(key, scope, requestId, "模型快照缺少代次")
    if (agentModelEpoch != null && epoch != agentModelEpoch || epoch in retiredAgentModelEpochs) return cleared
    val entries = message["domains"] as? JsonArray ?: return cleared.rejectedSnapshot(key, scope, requestId, "模型快照缺少领域清单")
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
        if (domain == null || modelEpoch == null || modelEpoch != epoch || revision == null || revision < 0 ||
            availability == null || availability !in setOf("ready", "unknown", "unavailable") ||
            completeness == null || completeness !in setOf("complete", "partial", "unknown") || checkedAt == null || checkedAt < 0 ||
            domain in domains || read != null && domain !in read.domains
        ) {
            return cleared.rejectedSnapshot(key, scope, requestId, "模型快照里的领域缺少 envelope 字段")
        }
        domains[domain] = AgentStateDomainView(
            domain = domain, modelEpoch = modelEpoch, revision = revision,
            availability = availability, completeness = completeness, checkedAt = checkedAt,
            value = row["value"],
            projectionComplete = row["projectionComplete"]?.jsonPrimitive?.booleanOrNull == true,
        )
    }
    val missing = LinkedHashMap<String, String>()
    for (element in (message["missing"] as? JsonArray).orEmpty()) {
        val row = element as? JsonObject ?: continue
        val domain = row.string("domain") ?: continue
        missing[domain] = row.string("reason") ?: "unknown"
    }
    val previous = agentStateSnapshots[key]?.takeIf { it.modelEpoch == epoch }
    val merged = previous?.domains.orEmpty().toMutableMap()
    val changed = linkedMapOf<String, AgentStateDomainView>()
    for ((domain, incoming) in domains) {
        val old = merged[domain]
        if (old != null && incoming.revision < old.revision) continue
        // 同版本只能更新核对时点，不能用乱序消息改内容或可用性。
        if (old != null && incoming.revision == old.revision &&
            (incoming.value != old.value || incoming.availability != old.availability || incoming.completeness != old.completeness)) continue
        merged[domain] = incoming
        changed[domain] = incoming
    }
    val mergedMissing = previous?.missing.orEmpty().toMutableMap().apply {
        domains.keys.forEach(::remove)
        putAll(missing)
    }
    val base = cleared.copy(agentModelEpoch = epoch)
    val ranged = changed["catalog"]?.takeIf { scope == "host" }?.let { base.beginCatalogRange(it, json) } ?: base
    // host.offline 会清空在线显示字段，但保留同代次的已应用领域和版本。
    // Host 确认 unchanged 后必须重新投影这些缓存值，否则重连后字段会一直是未知。
    // 使用当前镜像的版本；迟到的 unchanged 不能覆盖已经接受的更新。
    val confirmed = changed.toMutableMap()
    for (element in (message["unchanged"] as? JsonArray).orEmpty()) {
        val name = (element as? JsonPrimitive)?.contentOrNull ?: continue
        if (name in domains || read != null && name !in read.domains) continue
        merged[name]?.let { confirmed[name] = it }
    }
    val projected = if (scope == "agent") ranged.applyAgentDomainProjection(message.string("runtimeId"), message.string("sessionId"), confirmed, json, parseInteraction)
        else if (scope == "host") ranged.applyHostDomainProjection(confirmed, json) else ranged
    if (projected.error?.startsWith("Host 模型领域格式无效：") == true && projected.error != base.error) {
        return cleared.rejectedSnapshot(key, scope, requestId, projected.error)
    }
    return projected.storeSnapshot(key, AgentStateSnapshotView(
        key = key,
        scope = scope,
        requestId = requestId,
        modelEpoch = epoch,
        domains = merged,
        missing = mergedMissing,
        truncated = message["truncated"]?.jsonPrimitive?.booleanOrNull == true,
    ))
}

private fun RemoteState.storeSnapshot(key: String, view: AgentStateSnapshotView): RemoteState {
    val stored = if (view.error != null) view.copy(modelEpoch = agentStateSnapshots[key]?.modelEpoch,
        domains = agentStateSnapshots[key]?.domains.orEmpty(), missing = agentStateSnapshots[key]?.missing.orEmpty()) else view
    return copy(agentStateSnapshots = agentStateSnapshots + (key to stored))
}

private fun RemoteState.rejectedSnapshot(key: String, scope: String, requestId: String, reason: String): RemoteState =
    storeSnapshot(key, AgentStateSnapshotView(key = key, scope = scope, requestId = requestId, error = reason))

/** Host 作用域的那份快照：目录与记录目录都从同一次读取拿。 */
private fun RemoteState.hostScopeSnapshot(): AgentStateSnapshotView? =
    agentStateSnapshots.values.firstOrNull { it.scope == "host" }

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
    val snapshot = hostScopeSnapshot()
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

/** 一个后端的供应商摘要（模块 20–22）。秘密不在模型里：这里只有 id 与布尔状态。 */
data class ProviderSummaryView(
    val agentKind: String,
    val current: String?,
    /** true 表示 Host 自己正在为这个后端切换；null 表示未核对（不是「没在切换」）。 */
    val switching: Boolean?,
    val usageUnknown: Boolean,
    /** 可选供应商个数；null 表示这次读取**没有拿到清单**（不是「一个可选都没有」）。 */
    val profileCount: Int? = null,
)

/** 供应商切换状态在界面上的口径。 */
internal data class ProviderSwitchingView(
    val text: String,
    val detail: String? = null,
    val tone: StatusTone = StatusTone.Neutral,
    /** 可选供应商清单的口径；null 表示这一行不该出现（还没读到过供应商摘要）。 */
    val profiles: String? = null,
)

internal data class ModelStatusFact(val label: String, val value: String)

/** 所有已支持 Host/Agent 领域均可见；缺席/待核对不伪装为空或已完成。 */
internal fun RemoteState.modelStatusFacts(): List<ModelStatusFact> = buildList {
    for (snapshot in agentStateSnapshots.values.sortedBy { it.key }) {
        val label = if (snapshot.scope == "host") "电脑" else snapshot.key.substringAfterLast('|')
        snapshot.error?.let { add(ModelStatusFact(label, "读取失败：$it")) }
        for ((name, domain) in snapshot.domains.toSortedMap()) {
            val status = when (domain.availability) { "ready" -> "已核对"; "unavailable" -> "不支持"; else -> "待核对" }
            add(ModelStatusFact("$label · $name", "$status · v${domain.revision} · ${domain.completeness}"))
        }
        for ((name, reason) in snapshot.missing) add(ModelStatusFact("$label · $name", "尚无状态：$reason"))
    }
}

internal fun RemoteState.providerPublicFacts(): List<ModelStatusFact> = buildList {
    val domain = hostScopeSnapshot()?.domains?.get("providers") ?: return@buildList
    val rows = ((domain.value as? JsonObject)?.get("providers") as? JsonArray).orEmpty()
    for (row in rows.filterIsInstance<JsonObject>()) {
        val kind = row.string("agentKind") ?: continue
        for ((key, title) in listOf("usage" to "用量", "authentication" to "认证", "health" to "健康", "routing" to "路由")) {
            val fact = row[key] as? JsonObject
            val available = fact?.string("availability") ?: "unknown"
            val detail = fact?.get("detail")?.takeUnless { it is JsonNull }?.toString()?.trim('"')
            val summary = if (available != "ready") "未核对" else detail ?: fact.toString()
            add(ModelStatusFact("$kind · $title", summary.take(800)))
        }
    }
}

/**
 * 把 Host 的供应商摘要翻成一句人话，重点是**切换进行中**。
 *
 * 手机以前只知道「我自己发起的那次切换」，带外（桌面端）的切换它看不见；模型里这条事实补的正是这一格。
 * ~switching == null~ 是未核对，所以文案说的是「Host 未报告进行中的切换」——陈述它报了什么，
 * 而不是替它断言「现在没有切换」。
 */
internal fun RemoteState.providerSwitchingView(): ProviderSwitchingView {
    val snapshot = hostScopeSnapshot() ?: return ProviderSwitchingView("尚未读取", "连接建立后会自动读一次")
    snapshot.error?.let { return ProviderSwitchingView("读取失败：" + it, null, StatusTone.Bad) }
    snapshot.missing["providers"]?.let { reason ->
        val text = if (reason == "unknown_domain") "这台电脑不认识这个领域" else "电脑没有报这个领域"
        return ProviderSwitchingView(text, "缺席原因：" + reason, StatusTone.Warn)
    }
    val domain = snapshot.domains["providers"]
        ?: return ProviderSwitchingView("清单里没有这个领域", "缺席没有给原因，不能当成没有切换", StatusTone.Warn)
    if (domain.availability != "ready") {
        return ProviderSwitchingView("电脑尚未核对", "availability=" + domain.availability, StatusTone.Warn)
    }
    val value = domain.value as? JsonObject
        ?: return ProviderSwitchingView("供应商摘要格式无法识别", "负载不是对象", StatusTone.Bad)
    val rows = value["providers"] as? JsonArray
        ?: return ProviderSwitchingView("供应商摘要缺少清单", "负载里没有 providers", StatusTone.Bad)
    val summaries = ArrayList<ProviderSummaryView>(rows.size)
    for (element in rows) {
        val row = element as? JsonObject
            ?: return ProviderSwitchingView("供应商摘要格式无法识别", "条目不是对象", StatusTone.Bad)
        val kind = row.string("agentKind")
            ?: return ProviderSwitchingView("供应商摘要缺少字段", "条目没有 agentKind", StatusTone.Bad)
        val usage = row["usage"] as? JsonObject
        summaries += ProviderSummaryView(
            agentKind = kind,
            current = row.string(if (kind == "codex" || kind == "codexDesktop") "modelProvider" else "current"),
            switching = row["switching"]?.jsonPrimitive?.booleanOrNull,
            usageUnknown = usage?.string("availability") != "ready",
            // profiles 为 null 是「这次没读到清单」，空数组才是「一个可选都没有」——两者不能混。
            profileCount = (row["profiles"] as? JsonArray)?.size,
        )
    }
    if (summaries.isEmpty()) {
        return ProviderSwitchingView("电脑没有报任何供应商", null, StatusTone.Warn)
    }
    val detail = summaries.joinToString("、") { summary ->
        summary.agentKind + ": " + (summary.current ?: if (summary.agentKind in setOf("codex", "codexDesktop")) "未核对" else "未配置")
    }
    val profiles = summaries.joinToString("、") { summary ->
        summary.agentKind + ": " + (summary.profileCount?.let { count -> count.toString() + " 个可选" } ?: "清单未读到")
    }
    val switching = summaries.filter { it.switching == true }.map { it.agentKind }
    if (switching.isNotEmpty()) {
        return ProviderSwitchingView("正在切换：" + switching.joinToString("、"), detail, StatusTone.Warn, profiles)
    }
    return ProviderSwitchingView("Host 未报告进行中的切换", detail, StatusTone.Neutral, profiles)
}


/** 目录里一个后端的读取结果（模块 03）。失败或未就绪**不是**「这个后端没有会话」。 */
data class CatalogBackendView(
    val kind: String,
    val ready: Boolean,
    val sessions: Long,
    val complete: Boolean,
    val error: String? = null,
)

/** Host 聚合目录的逐后端完整性。 */
data class CatalogView(
    val totalSessions: Long,
    val truncated: Boolean,
    val backends: List<CatalogBackendView>,
    val checkedAt: Long,
)

/** 目录完整性在界面上的口径。 */
internal data class CatalogSummaryView(val text: String, val detail: String? = null, val tone: StatusTone = StatusTone.Neutral)

/**
 * 把 Host 的目录完整性翻译成一句人话。
 *
 * 这一行回答的是 App 以前答不出来的问题：**这份会话列表是不是读全了**。某个后端没就绪或读取失败时，
 * 缺席的会话不能显示成「没有」，所以这里必须说出来是哪个后端、为什么。
 */
internal fun RemoteState.catalogSummaryView(): CatalogSummaryView {
    val snapshot = hostScopeSnapshot() ?: return CatalogSummaryView("尚未读取", "连接建立后会自动读一次")
    snapshot.error?.let { return CatalogSummaryView("读取失败：" + it, null, StatusTone.Bad) }
    snapshot.missing["catalog"]?.let { reason ->
        val text = if (reason == "unknown_domain") "这台电脑不认识这个领域" else "电脑没有报这个领域"
        return CatalogSummaryView(text, "缺席原因：" + reason, StatusTone.Warn)
    }
    val domain = snapshot.domains["catalog"]
        ?: return CatalogSummaryView("清单里没有这个领域", "缺席没有给原因，不能当成完整目录", StatusTone.Warn)
    if (domain.availability != "ready") {
        return CatalogSummaryView("电脑尚未核对", "availability=" + domain.availability, StatusTone.Warn)
    }
    val value = domain.value as? JsonObject
        ?: return CatalogSummaryView("目录格式无法识别", "负载不是对象", StatusTone.Bad)
    val total = value.long("totalSessions")
        ?: return CatalogSummaryView("目录缺少总数", "负载里没有 totalSessions", StatusTone.Bad)
    val rows = value["backends"] as? JsonArray
        ?: return CatalogSummaryView("目录缺少后端清单", "负载里没有 backends", StatusTone.Bad)
    val backends = ArrayList<CatalogBackendView>(rows.size)
    for (element in rows) {
        val row = element as? JsonObject
            ?: return CatalogSummaryView("目录格式无法识别", "后端条目不是对象", StatusTone.Bad)
        val kind = row.string("kind")
        val sessions = row.long("sessions")
        val complete = row["complete"]?.jsonPrimitive?.booleanOrNull
        val ready = row["ready"]?.jsonPrimitive?.booleanOrNull
        if (kind == null || sessions == null || complete == null || ready == null) {
            return CatalogSummaryView("目录缺少字段", "后端条目缺少 kind/sessions/ready/complete", StatusTone.Bad)
        }
        backends += CatalogBackendView(kind, ready, sessions, complete, row.string("error"))
    }
    val truncated = value["truncated"]?.jsonPrimitive?.booleanOrNull == true
    val range = agentCatalogRange?.takeIf { it.modelEpoch == domain.modelEpoch && it.revision == domain.revision }
    if (range?.error != null) return CatalogSummaryView("$total 个会话（部分）", "目录分页失败：${range.error}", StatusTone.Warn)
    if (range?.nextCursor != null || value.string("nextCursor") != null && range == null)
        return CatalogSummaryView("$total 个会话（读取中）", "已读取 ${range?.sessions?.size ?: (value["sessions"] as? JsonArray)?.size ?: 0} 个", StatusTone.Warn)
    val gaps = backends.filter { !it.complete }
    if (gaps.isEmpty() && !truncated && domain.completeness == "complete") {
        return CatalogSummaryView("$total 个会话（" + backends.size + " 个后端都读全）", null, StatusTone.Good)
    }
    val reason = gaps.joinToString("，") { gap ->
        val why = when {
            gap.error != null -> "读取失败：" + gap.error
            !gap.ready -> "未就绪"
            else -> "没读全"
        }
        gap.kind + " " + why
    }.ifEmpty { if (truncated) "结果被上限截断" else "清单不完整" }
    return CatalogSummaryView("$total 个会话（部分）", reason, StatusTone.Warn)
}


/** 一条诊断记录（模块 23）。记录是运维事实：只有身份、类别、严重度与短文本，没有正文。 */
data class DiagnosticRecordView(
    val recordId: String,
    val category: String,
    val severity: String,
    val message: String,
    val at: Long,
)

/** 一次记录读取。只保留最后一页：状态页要看的是「最近发生了什么」，不是整本历史。 */
data class DiagnosticPageView(
    val requestId: String,
    val records: List<DiagnosticRecordView>,
    val nextCursor: String? = null,
    val truncated: Boolean = false,
    val error: String? = null,
)

/** 已发出、还没回来的记录读取请求。带时间戳是为了能说「上次读取没有回音」，而不是永远转圈。 */
data class DiagnosticRequestView(val requestId: String, val sentAt: Long)

/** 记录读取在界面上的口径。 */
internal data class DiagnosticRecordsView(val text: String, val detail: String? = null, val tone: StatusTone = StatusTone.Neutral)

/** 等多久算「没有回音」。超过就如实说，不继续显示读取中。 */
private const val DIAGNOSTIC_REQUEST_TIMEOUT_MS = 15_000L

/**
 * 收下一记录页。
 *
 * 只接受我们自己那次请求的应答：并发或迟到的页会把现场搅乱。记录的字段缺一个就整页拒绝——
 * 与快照同一条纪律，宁可说「读取失败」，也不留半页看着像真的的记录。
 */
internal fun RemoteState.withDiagnosticsPage(message: JsonObject): RemoteState {
    val requestId = message.string("requestId") ?: return this
    if (diagnosticRequest?.requestId != requestId) return this
    val cleared = copy(diagnosticRequest = null)
    val failure = message.string("error")
    if (failure != null) return cleared.copy(diagnosticPage = DiagnosticPageView(requestId, emptyList(), error = failure))
    val page = message["page"] as? JsonObject ?: return cleared
    val rows = page["records"]?.jsonArray ?: return cleared
    val records = ArrayList<DiagnosticRecordView>(rows.size)
    for (element in rows) {
        val row = element as? JsonObject
            ?: return cleared.copy(diagnosticPage = DiagnosticPageView(requestId, emptyList(), error = "记录不是对象"))
        val recordId = row.string("recordId")
        val category = row.string("category")
        val severity = row.string("severity")
        val text = row.string("message")
        val at = row["at"]?.jsonPrimitive?.longOrNull
        if (recordId == null || category == null || severity == null || text == null || at == null) {
            return cleared.copy(diagnosticPage = DiagnosticPageView(requestId, emptyList(), error = "记录缺少字段"))
        }
        records += DiagnosticRecordView(recordId, category, severity, text, at)
    }
    return cleared.copy(diagnosticPage = DiagnosticPageView(
        requestId = requestId,
        records = records,
        nextCursor = page.string("nextCursor"),
        truncated = page["truncated"]?.jsonPrimitive?.booleanOrNull == true,
    ))
}

/**
 * 把记录页翻译成一句人话。
 *
 * Host 的页是从窗口里**最旧**一条开始、朝**更新**方向给的，所以列表末尾那条是「这一页里最新的一条」——
 * 只有当 `nextCursor` 为空（已经追平最新）时，它才真的是「最近一条」。有更新的没读、有缺口、
 * 以及「上次读取没有回音」都必须说出来。
 */
internal fun RemoteState.diagnosticRecordsView(now: Long = System.currentTimeMillis()): DiagnosticRecordsView {
    val pending = diagnosticRequest
    val waiting = pending != null && now - pending.sentAt < DIAGNOSTIC_REQUEST_TIMEOUT_MS
    val page = diagnosticPage
    if (page == null) {
        if (waiting) return DiagnosticRecordsView("读取中…")
        if (pending != null) return DiagnosticRecordsView("上次读取没有回音", null, StatusTone.Warn)
        return DiagnosticRecordsView("尚未读取", "点下面的按钮读一页")
    }
    page.error?.let { return DiagnosticRecordsView("读取失败：" + it, null, StatusTone.Bad) }
    val newest = page.records.lastOrNull()
        ?: return DiagnosticRecordsView(if (page.truncated) "没有记录（有缺口）" else "没有记录", null, if (page.truncated) StatusTone.Warn else StatusTone.Neutral)
    val notes = buildList {
        // 游标朝更新的方向走：不为 null 表示「比这一页更新的还没读」。
        if (page.nextCursor != null) add("还有更新的没读")
        if (page.truncated) add("有缺口")
        if (!waiting && pending != null) add("上次读取没有回音")
    }
    val text = newest.message + if (notes.isEmpty()) "" else "（" + notes.joinToString("，") + "）"
    val tone = when (newest.severity) {
        "error" -> StatusTone.Bad
        "warning" -> StatusTone.Warn
        else -> StatusTone.Good
    }
    return DiagnosticRecordsView(text, newest.category, tone)
}


