package com.orbising.orbis

import kotlinx.serialization.json.*

internal const val AGENT_DIAL_REVIEW_FEATURE = "agent.enablement.review.v1"
internal val DIAL_PROVIDER_GROUPS = listOf("codex", "claude", "dsh", "pi")

/** Legacy Hosts have no enablement directory; only show provider groups they actually announce. */
internal fun legacyAgentDialKinds(supported: Set<String>?, launchable: Set<String>?): List<String>? {
    if (supported == null && launchable == null) return null
    val announced = supported.orEmpty() + launchable.orEmpty()
    return DIAL_PROVIDER_GROUPS.filter(announced::contains)
}

internal fun agentDialProviderGroup(kind: String): String? = when (kind) {
    "codexDesktop" -> "codex"
    in DIAL_PROVIDER_GROUPS -> kind
    else -> null
}

internal fun agentDialVariant(kind: String): String? = when (kind) {
    "codex", "dsh" -> "terminal"
    "codexDesktop", "dshDesktop" -> "desktop"
    else -> null
}

internal fun agentDialInfoHint(statusLabel: String): String? = when (statusLabel) {
    "未安装" -> "在电脑上的 Orbis 里安装，完成后自动接入。"
    "待配置" -> "在电脑上的 Orbis 里填写连接配置。"
    else -> null
}

internal fun agentDialPinReleaseHint(effectiveEnabled: Boolean, activeSessions: Int): String = when {
    !effectiveEnabled -> "松手启用"
    activeSessions > 0 -> "松手后确认停用"
    else -> "松手停用"
}

data class AgentDialReview(val kind: String, val revision: Long, val sessions: List<String>, val total: Int?, val token: String?)
data class AgentDialChoice(val kind: String, val target: Boolean, val previous: Boolean, val review: AgentDialReview? = null, val expectedRevision: Long? = null)
data class AgentDialRequest(val id: String, val choice: AgentDialChoice?, val revision: Long?)
data class AgentDialSnapshot(val revision: Long, val rows: List<AgentEnablementRow>)
data class AgentDialNotice(val kind: String?, val status: String, val id: String, val revision: Long? = null)

/** Intents are not policy; this state belongs to one HostConnection and never survives in durable storage. */
data class AgentDialSync(
    val cached: AgentDialSnapshot? = null,
    val synchronized: Boolean = false,
    val scoped: Boolean = false,
    val queue: List<AgentDialChoice> = emptyList(),
    val inFlight: AgentDialRequest? = null,
    val review: AgentDialReview? = null,
    val notice: AgentDialNotice? = null,
    val lastSync: Long? = null,
) {
    fun pending(kind: String): AgentDialChoice? = inFlight?.choice?.takeIf { it.kind == kind } ?: queue.find { it.kind == kind }
    fun visualEnabled(kind: String, committed: Boolean): Boolean = pending(kind)?.previous ?: committed
    fun disconnected() = copy(synchronized = false, scoped = false, queue = emptyList(), inFlight = null, review = null,
        notice = inFlight?.choice?.let { AgentDialNotice(it.kind, "interrupted", inFlight.id) }
            ?: notice?.takeIf { it.status == "interrupted" })

    fun enqueue(kind: String, target: Boolean, rows: List<AgentEnablementRow>, revision: Long, confirmation: AgentDialReview? = null, expectedRevision: Long? = null): AgentDialSync {
        if (!synchronized || inFlight?.choice?.kind == kind || expectedRevision != null && expectedRevision != revision ||
            review != null && confirmation != review) return this
        val existing = queue.find { it.kind == kind }
        if (existing != null) return if (target == existing.previous) copy(queue = queue.filterNot { it.kind == kind }) else this
        val row = rows.find { it.kind == kind && it.enabled != target } ?: return this
        if (confirmation != null && (target || confirmation != review || confirmation.kind != kind || confirmation.revision != revision)) return this
        val choice = AgentDialChoice(kind, target, row.enabled, confirmation, expectedRevision ?: confirmation?.revision)
        return copy(queue = if (confirmation != null) listOf(choice) + queue else queue + choice, review = null, notice = null)
    }

    fun beginWrite(id: String, rows: List<AgentEnablementRow>, revision: Long): AgentDialSync {
        if (!synchronized || inFlight != null || review != null) return this
        val remaining = queue.dropWhile { change ->
            rows.none { it.kind == change.kind && it.enabled == change.previous } ||
                change.expectedRevision?.let { it != revision } == true
        }
        val next = remaining.firstOrNull()
        return if (next != null) copy(queue = remaining.drop(1), inFlight = AgentDialRequest(id, next, revision))
        else if (queue.isNotEmpty()) copy(queue = remaining, notice = AgentDialNotice(queue.first().kind, "conflict", id))
        else this
    }
}

internal fun parseAgentDialSnapshot(snapshot: JsonObject?): AgentDialSnapshot? {
    val revision = (snapshot?.get("revision") as? JsonPrimitive)?.takeUnless { it.isString }?.longOrNull
        ?.takeIf { it in 0..9_007_199_254_740_991L } ?: return null
    val raw = (snapshot["agents"] as? JsonArray)?.takeIf { it.size <= 128 } ?: return null
    val rows = raw.map { value ->
        val row = value as? JsonObject ?: return null
        val kind = (row["kind"] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull?.takeIf { it.length in 1..64 } ?: return null
        val label = (row["label"] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull?.takeIf { it.length in 1..128 } ?: return null
        val enabled = (row["enabled"] as? JsonPrimitive)?.takeUnless { it.isString }?.booleanOrNull ?: return null
        AgentEnablementRow(kind, label, enabled)
    }
    return AgentDialSnapshot(revision, rows).takeIf { rows.map { it.kind }.toSet().size == rows.size }
}

internal fun parseAgentDialReview(value: JsonObject?): AgentDialReview? {
    val kind = (value?.get("kind") as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull ?: return null
    val revision = (value["revision"] as? JsonPrimitive)?.takeUnless { it.isString }?.longOrNull?.takeIf { it in 0..9_007_199_254_740_991L } ?: return null
    val token = (value["token"] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull?.takeIf { it.matches(Regex("[a-f0-9]{64}")) } ?: return null
    val total = (value["total"] as? JsonPrimitive)?.takeUnless { it.isString }?.intOrNull?.takeIf { it > 0 } ?: return null
    val names = (value["sessions"] as? JsonArray)?.takeIf { it.size <= 24 && it.size <= total }?.map {
        (it as? JsonPrimitive)?.takeIf { name -> name.isString }?.contentOrNull?.takeIf { name -> name.length in 1..256 } ?: return null
    } ?: return null
    return AgentDialReview(kind, revision, names, total, token)
}


internal fun RemoteState.withAgentDialSnapshot(incoming: AgentDialSnapshot, id: String?, result: String?, timestamp: Long): RemoteState {
    if (!agentEnablementAvailable) return this
    val dial = agentDial
    val request = dial.inFlight?.takeIf { it.id == id && (result != null) == (it.choice != null) }
    if (id != null && request == null || result != null && request?.choice == null) return this
    val change = request?.choice
    val staleResult = change != null && (incoming.revision < (agentEnablementRevision ?: -1L) ||
        result == "applied" && incoming.revision != request.revision?.plus(1))
    val fresh = incoming.revision > (agentEnablementRevision ?: -1L)
    val rows = if (fresh) incoming.rows else agentEnablementRows
    val revision = if (fresh) incoming.revision else agentEnablementRevision ?: return this
    val previous = dial.cached?.rows.orEmpty()
    val other = if (fresh || request?.choice == null && request != null) rows.firstOrNull { row ->
        dial.pending(row.kind) == null && previous.any { it.kind == row.kind && it.enabled != row.enabled }
    } else null
    val notice = when {
        change != null && (result == "conflict" || staleResult) -> AgentDialNotice(change.kind, "conflict", request.id)
        change?.target == false && result == "applied" && rows.any { it.kind == change.kind && !it.enabled } ->
            AgentDialNotice(change.kind, "disabled", request.id, revision)
        other != null -> AgentDialNotice(other.kind, if (other.enabled) "externalOn" else "externalOff", "snapshot:$revision")
        request != null && (result == "applied" || dial.notice?.status == "readFailed") -> null
        else -> dial.notice
    }
    return copy(agentEnablementRows = rows, agentEnablementRevision = revision, agentDial = dial.copy(
        cached = AgentDialSnapshot(revision, rows), synchronized = dial.synchronized || request != null && change == null,
        inFlight = if (request != null) null else dial.inFlight, notice = notice, lastSync = if (fresh || request != null) timestamp else dial.lastSync,
        review = dial.review?.takeIf { it.revision == revision }))
}

internal fun RemoteState.withAgentDialRejection(id: String, structured: AgentDialReview?, code: String?): RemoteState {
    val dial = agentDial
    val request = dial.inFlight?.takeIf { it.id == id } ?: return this
    val change = request.choice
    val revision = agentEnablementRevision
    val stale = change != null && revision != request.revision
    val review = when {
        change?.target != false || revision == null || stale -> null
        dial.scoped -> structured?.takeIf { it.kind == change.kind && it.revision == revision }
        code == "agent_disable_confirmation_required" -> AgentDialReview(change.kind, revision, emptyList(), null, null)
        else -> null
    }
    val status = if (change == null) "readFailed" else if (stale) "conflict" else "failed"
    return copy(agentDial = dial.copy(inFlight = null, review = review,
        notice = if (review != null) null else AgentDialNotice(change?.kind, status, id)))
}

internal fun RemoteState.agentDialCanEdit(): Boolean = e2eReady && connection == RelayConnection.ONLINE &&
    agentEnablementAvailable && agentEnablementRevision != null && agentDial.synchronized

internal data class AgentDialStatus(val label: String, val tone: String = "neutral")

internal fun RemoteState.dialSourceStatus(kind: String, row: AgentEnablementRow?, online: Boolean): AgentDialStatus {
    val pending = agentDial.pending(kind)
    if (pending != null) return AgentDialStatus(if (agentDial.inFlight?.choice == pending) "待确认" else "已排队", "accent")
    if (row?.enabled == false) return AgentDialStatus("未启用")
    if (!online) return AgentDialStatus("已断开")
    if (row == null) return AgentDialStatus("正在读取 Agent")
    if (kind == "codexDesktop") {
        val desktop = codexDesktop
        if (desktop?.state == "attached") return AgentDialStatus("已连接", "success")
        if (desktop?.state in listOf("notInstalled", "not_installed")) return AgentDialStatus("未安装", "warning")
        if (desktop?.state in listOf("failed", "error", "incompatible")) return AgentDialStatus("接入失败", "error")
    }
    if (kind == "opencode" && openCodeAvailability?.ready == false) return AgentDialStatus("等待接入", "warning")
    if (kind in supportedAgents.orEmpty()) return AgentDialStatus("已连接", "success")
    if (kind in launchableAgents.orEmpty()) return AgentDialStatus("可启动")
    return AgentDialStatus("等待接入")
}
