package com.orbising.orbis

/**
 * ADR-0049：手机已发出、还没在源端记录里落地的一条消息。只在本机内存中存在，
 * 不写入历史缓存、applied baseline 或分页状态；落地后立即删除，此后由权威记录负责显示。
 */
sealed interface PendingSendState {
    data object Sending : PendingSendState
    data object Accepted : PendingSendState
    data class Failed(val reason: String) : PendingSendState
    /** 断线或 Runtime 离线时还没定论：命令可能已经送达，核对前不允许重新发送。 */
    data object Unconfirmed : PendingSendState
}

data class PendingSend(
    val messageId: String,
    val commandId: String,
    val sessionId: String,
    val text: String,
    val attachments: List<String>,
    val delivery: String?,
    val createdAt: Long,
    /** 创建时最后一条权威消息；本地行插在它后面，助手流先到时顺序仍是「提问 → 回复」。 */
    val anchorMessageId: String?,
    val state: PendingSendState = PendingSendState.Sending,
    val acceptedAt: Long? = null,
    /** 接受之后观察到 Runtime 忙过，回到 idle 时这一轮已经结束。 */
    val sawBusy: Boolean = false,
    /** 兜底核对开始时的权威状态版本；之后再应用一次权威状态才能下结论。 */
    val settleRevision: Long? = null,
) {
    /** 带 `delivery` 且尚未被接受时，它在队列面板里显示「提交中」。 */
    val showsInQueue: Boolean get() = delivery != null && state == PendingSendState.Sending
}

internal const val PENDING_SEND_ACCEPTED_IDLE_GRACE_MS = 15_000L

internal fun Map<String, PendingSend>.chatRows(sessionId: String?): List<PendingSend> =
    values.filter { it.sessionId == sessionId && !it.showsInQueue }.sortedBy(PendingSend::createdAt)

internal fun Map<String, PendingSend>.queueRows(sessionId: String?): List<PendingSend> =
    values.filter { it.sessionId == sessionId && it.showsInQueue }.sortedBy(PendingSend::createdAt)

/** 聊天里的本地行已经代表这条消息，Host 队列里的同一项不再重复显示。 */
internal fun Map<String, PendingSend>.hidesQueueItem(queueId: String): Boolean =
    get(queueId)?.let { it.delivery == null && !it.showsInQueue } == true

/** `cancelled` 由客户端在断线时合成，或表示回合被取消：都不能证明消息没有送达。 */
internal fun Map<String, PendingSend>.withCommandResult(commandId: String, result: CommandResult, now: Long): Map<String, PendingSend> {
    val item = values.firstOrNull { it.commandId == commandId } ?: return this
    val next = when {
        result.ok -> if (item.state == PendingSendState.Accepted) item
            else item.copy(state = PendingSendState.Accepted, acceptedAt = now, sawBusy = false, settleRevision = null)
        result.status == "cancelled" -> if (item.state == PendingSendState.Sending || item.state == PendingSendState.Accepted)
            item.copy(state = PendingSendState.Unconfirmed, settleRevision = null) else item
        else -> item.copy(state = PendingSendState.Failed(pendingSendFailureText(result.status, result.error)))
    }
    return if (next == item) this else this + (item.messageId to next)
}

/** 传输断开：还没有回执的命令可能已经送达；已被 Host 接受的不受影响。 */
internal fun Map<String, PendingSend>.connectionLost(): Map<String, PendingSend> = mapValues { (_, item) ->
    if (item.state == PendingSendState.Sending) item.copy(state = PendingSendState.Unconfirmed, settleRevision = null) else item
}

/** Runtime 离线：即使 Host 已接受，消息也可能没有进入 agent。 */
internal fun Map<String, PendingSend>.runtimeLost(sessionId: String?): Map<String, PendingSend> = mapValues { (_, item) ->
    if (item.sessionId == sessionId && (item.state == PendingSendState.Sending || item.state == PendingSendState.Accepted))
        item.copy(state = PendingSendState.Unconfirmed, settleRevision = null) else item
}

/** One Session's view of source facts; `status` is null when no Runtime serves the Session. */
internal data class PendingSendObservation(
    val status: String?,
    val queue: Map<String, QueuedMessage>,
    val revision: Long,
    val connected: Boolean,
    val isMaterialized: (String) -> Boolean,
)

/**
 * 用源端事实核对本地行。返回新的集合，以及需要一份新权威状态才能完成兜底核对的 Session。
 * 对账只认 `messageId` / `clientMessageId` / Host alias，不按正文猜。
 */
internal fun Map<String, PendingSend>.reconcile(
    now: Long,
    observe: (sessionId: String) -> PendingSendObservation,
): Pair<Map<String, PendingSend>, Set<String>> {
    if (isEmpty()) return this to emptySet()
    val observations = values.map(PendingSend::sessionId).distinct().associateWith(observe)
    val needsSync = mutableSetOf<String>()
    val next = LinkedHashMap<String, PendingSend>()
    for (original in values) {
        val seen = observations.getValue(original.sessionId)
        if (seen.isMaterialized(original.messageId)) continue
        val host = seen.queue[original.messageId]
        if (host != null) {
            // 队列面板里的消息从此由 Host 队列项负责显示、撤回和交付。
            if (original.delivery != null) continue
            next[original.messageId] = when {
                host.state == "cancelled" || host.state == "rejected" -> original.copy(settleRevision = null,
                    state = PendingSendState.Failed(host.error ?: if (host.state == "cancelled") "消息已被撤回" else "电脑端拒绝了这条消息"))
                original.state == PendingSendState.Sending || original.state == PendingSendState.Unconfirmed ->
                    original.copy(state = PendingSendState.Accepted, acceptedAt = original.acceptedAt ?: now, settleRevision = null)
                else -> original.copy(settleRevision = null)
            }
            continue
        }
        var item = original
        val waiting = item.state == PendingSendState.Accepted || item.state == PendingSendState.Unconfirmed
        if (seen.status != null && seen.status != "idle" && waiting) item = item.copy(sawBusy = true)
        val idle = seen.connected && seen.status == "idle"
        val eligible = when (item.state) {
            PendingSendState.Accepted -> idle && (item.sawBusy || now - (item.acceptedAt ?: now) >= PENDING_SEND_ACCEPTED_IDLE_GRACE_MS)
            PendingSendState.Unconfirmed -> idle
            else -> false
        }
        val started = item.settleRevision
        when {
            !eligible -> next[item.messageId] = item.copy(settleRevision = null)
            started == null -> {
                next[item.messageId] = item.copy(settleRevision = seen.revision)
                needsSync += item.sessionId
            }
            seen.revision <= started -> next[item.messageId] = item
            // 源端为准：已接受但无法对应的行退场；未确认的行变为可重发的失败。
            item.state == PendingSendState.Accepted -> Unit
            else -> next[item.messageId] = item.copy(state = PendingSendState.Failed("未能确认送达，可以重新发送"), settleRevision = null)
        }
    }
    return (if (next == this) this else next) to needsSync
}

/** 本地行插在锚点之后；锚点已不在列表里时放在末尾。 */
internal fun mergePendingSends(messages: List<ChatMessage>, pending: List<PendingSend>): List<ChatMessage> {
    if (pending.isEmpty()) return messages
    val result = messages.toMutableList()
    val insertedAfter = mutableMapOf<String, Int>()
    for (send in pending) {
        val row = ChatMessage(send.messageId, "user", listOf(RemoteContent("text", send.text)), send.createdAt)
        val anchor = send.anchorMessageId
        val index = anchor?.let { id -> insertedAfter[id] ?: result.indexOfFirst { it.messageId == id }.takeIf { it >= 0 } }
        if (anchor != null && index != null) {
            result.add(index + 1, row)
            for ((key, value) in insertedAfter.toMap()) if (key != anchor && value > index) insertedAfter[key] = value + 1
            insertedAfter[anchor] = index + 1
        } else {
            result += row
        }
    }
    return result
}

internal fun pendingSendFailureText(status: String?, error: String?): String = when {
    status == "message_id_conflict" -> "消息身份冲突，请重新发送"
    error == "runtime_busy" -> "会话正在运行，请选择插入或完成后发送"
    error == "claude_steer_unsupported" -> "Claude Code 不支持插入当前任务"
    !error.isNullOrEmpty() -> error
    else -> "电脑端没有接受这条消息"
}

/**
 * 用当前 [RemoteState] 的源端事实核对本地行。返回新状态，以及兜底核对需要同步的 Runtime。
 * Session 当前没有在线 Runtime 时只能等待它重新上线。
 */
internal fun RemoteState.reconcilePendingSends(now: Long): Pair<RemoteState, Set<String>> {
    if (pendingSends.isEmpty()) return this to emptySet()
    val connected = e2eReady && connection == RelayConnection.ONLINE
    val (next, sessions) = pendingSends.reconcile(now) { sessionId ->
        val runtimeId = runtimes.entries.firstOrNull { it.value.sessionId == sessionId }?.key
        val conversation = runtimeId?.let(conversations::get)
        PendingSendObservation(
            status = runtimeId?.let { runtimes[it]?.status },
            queue = conversation?.queuedMessages.orEmpty(),
            revision = sessionRevisions[sessionId] ?: 0L,
            connected = connected,
            isMaterialized = { id -> conversation?.messages?.any { it.messageId == id || it.clientMessageId == id } == true },
        )
    }
    val syncs = sessions.mapNotNullTo(mutableSetOf()) { sessionId -> runtimes.entries.firstOrNull { it.value.sessionId == sessionId }?.key }
    return (if (next === pendingSends) this else copy(pendingSends = next)) to syncs
}

/** 队列面板：Host 队列项，加上带 `delivery` 且仍在提交中的本地行。 */
internal fun RemoteState.queuePanelItems(runtimeId: String): List<QueuedMessage> {
    val host = conversations[runtimeId]?.queuedMessages.orEmpty().values.filterNot { pendingSends.hidesQueueItem(it.queueId) }
    val local = pendingSends.queueRows(runtimes[runtimeId]?.sessionId)
        .filter { send -> host.none { it.queueId == send.messageId } }
        .map { QueuedMessage(it.messageId, it.text, it.delivery ?: "followUp", "submitting") }
    return host + local
}
