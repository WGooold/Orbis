package dev.pi.remote

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.longOrNull

/**
 * 测试夹具：把夹具条目变成「产出方已经解释好」的显示结果。
 *
 * 真正的投影住在协议层（`packages/protocol/src/display-entries.ts`），三个后端共用；App 只消费它的
 * 结果。夹具把 `data.message` 翻成可渲染的一行，既有的会话夹具因此不必逐条手写显示行。
 *
 * 它**不是**投影的替代品：不做压缩裁剪、不做失败判定与回填、不看 `display` 开关、不解释
 * `custom_message`——那些都在协议层各自有测试。App 这边要验的是「消费显示结果」，包括窗口、
 * 锚点、版本与缺行时的行为。
 */
internal fun fixtureDisplayBatch(
    entries: Collection<SessionGraphEntry>,
    windowStart: String? = null,
): DisplayBatch = DisplayBatch(
    projectionVersion = DISPLAY_PROJECTION_VERSION,
    entries = entries.mapNotNull(::fixtureDisplayEntry),
    windowStart = windowStart,
)

internal fun fixtureDisplay(entries: Collection<SessionGraphEntry>): Map<String, DisplayEntry> =
    entries.mapNotNull(::fixtureDisplayEntry).associateBy { it.entryId!! }

/** 夹具投影：等价于「后端把这一页都解释好了」，用于构造既有会话里的历史消息。 */
internal fun fixtureMessages(entries: Collection<SessionGraphEntry>): List<ChatMessage> =
    projectSessionEntries(entries.toList(), fixtureDisplay(entries))

/** 夹具图：条目 + 由条目推出的显示结果，省得每个测试都写两遍。 */
internal fun fixtureGraph(
    sessionId: String,
    entries: Collection<SessionGraphEntry>,
    cursor: SessionBranchCursor = SessionBranchCursor(),
    cacheEpoch: String? = null,
): SessionGraph = SessionGraph(
    sessionId = sessionId,
    entries = entries.associateBy(SessionGraphEntry::entryId),
    cursor = cursor,
    cacheEpoch = cacheEpoch,
    display = fixtureDisplay(entries),
    displayVersion = DISPLAY_PROJECTION_VERSION,
)

/** 换一套条目连显示结果一起换：显示结果与条目同源，只换一半就不是夹具应有的样子。 */
internal fun SessionGraph.withFixtureEntries(entries: Collection<SessionGraphEntry>): SessionGraph = copy(
    entries = entries.associateBy(SessionGraphEntry::entryId),
    display = display + fixtureDisplay(entries),
    displayVersion = DISPLAY_PROJECTION_VERSION,
)

/**
 * 夹具：模拟 SQLite 提交后读回来的这一批（条目 + 盘上那份显示结果）。
 * 单测用内存夹具代替真实存储时，条目与显示结果照样必须同源。
 */
internal fun committedFixtureBatch(
    entries: List<SessionGraphEntry>,
    windowStart: String? = null,
): CommittedSessionBatch = CommittedSessionBatch(
    entries,
    DisplayBatch(DISPLAY_PROJECTION_VERSION, entries.mapNotNull(::fixtureDisplayEntry), windowStart),
)

/** 夹具的一段本地范围：条目与显示结果同源，等价于「盘上这一段连解释一起读回来」。 */
internal fun fixtureRange(
    entries: List<SessionGraphEntry>,
    hasOlder: Boolean,
    complete: Boolean,
    status: SessionGraphRangeStatus = SessionGraphRangeStatus.COMPLETE,
    windowStart: String? = null,
): SessionGraphRange = SessionGraphRange(
    entries, hasOlder, complete, status, fixtureDisplay(entries), windowStart, DISPLAY_PROJECTION_VERSION,
)

/** 夹具图：既有测试习惯先 `associateBy { it.entryId }`，这里也接受现成的条目表。 */
internal fun fixtureGraph(
    sessionId: String,
    entries: Map<String, SessionGraphEntry>,
    cursor: SessionBranchCursor = SessionBranchCursor(),
    cacheEpoch: String? = null,
): SessionGraph = fixtureGraph(sessionId, entries.values, cursor, cacheEpoch)

/**
 * 夹具 reducer：真实后端总是把显示结果跟着条目一起发，夹具在入口把这一步补上。
 *
 * 这样既有的状态机测试仍然只关心状态机，而喂进去的输入与线上一致；不经过 /reload 之类的手工
 * 补丁，也不在测试里逐个 JSON 手写显示行。任何解析失败都原样放行，绝不篡改夹具本身。
 */
internal class FixtureRelayReducer(private val delegate: RelayReducer = RelayReducer()) {
    fun reduce(
        state: RemoteState,
        payload: String,
        committed: CommittedSessionBatch? = null,
        channel: String? = null,
    ): RemoteState = delegate.reduce(state, payload.withFixtureDisplay(), committed, channel)

    /** 显式的标准来源快照夹具。仅补共同 source/checkpoint，不解释旧生命周期通知。 */
    fun reduceSourceSnapshot(
        state: RemoteState,
        payload: String,
        committed: CommittedSessionBatch? = null,
        channel: String? = null,
    ): RemoteState {
        val root = fixtureJson.parseToJsonElement(payload) as JsonObject
        val event = root["event"] as JsonObject
        require((event["type"] as? JsonPrimitive)?.contentOrNull == "session.snapshot")
        if (event["source"] != null && event["source"] !is kotlinx.serialization.json.JsonNull)
            return reduce(state, payload, committed, channel)
        val runtimeId = (root["runtimeId"] as JsonPrimitive).content
        val current = state.conversations[runtimeId] ?: RuntimeConversation()
        val sync = state.sessionSyncCommands.values.firstOrNull {
            it.runtimeId == runtimeId && it.syncId == (event["syncId"] as? JsonPrimitive)?.contentOrNull
        }
        val range = sync?.range ?: (event["range"] as? JsonPrimitive)?.contentOrNull ?: "preview"
        val epoch = current.sourceEpoch ?: "fixture-source"
        val seq = if (range == "preview") maxOf(current.sourceSeq + 1, (root["sequence"] as? JsonPrimitive)?.longOrNull ?: 1)
            else current.sourceSeq.coerceAtLeast(0)
        val source = SessionSourceEpoch(epoch, seq, true)
        val cursor = fixtureJson.decodeFromJsonElement<SessionBranchCursor>(event.getValue("cursor"))
        val additions = mutableMapOf<String, JsonElement>("source" to fixtureJson.encodeToJsonElement(SessionSourceEpoch.serializer(), source))
        if (range == "preview") {
            additions["mode"] = JsonPrimitive("replace")
            additions["checkpoint"] = fixtureJson.encodeToJsonElement(SessionCheckpoint.serializer(),
                SessionCheckpoint("$epoch:$seq", cursor, "complete", true))
            additions["live"] = fixtureJson.encodeToJsonElement(SessionLiveState.serializer(), SessionLiveState(true))
        }
        val input = if (range == "preview" || current.sourceEpoch != null) state else state.copy(
            conversations = state.conversations + (runtimeId to current.copy(sourceEpoch = epoch, sourceSeq = seq,
                sourceReady = true, sourceHeadLeafId = state.runtimeSessionViews[runtimeId]?.leafId
                    ?: state.runtimes[runtimeId]?.sessionLeafId)),
            sessionGraphs = state.sessionGraphs.mapValues { (sessionId, graph) ->
                if (sessionId == (event["sessionId"] as? JsonPrimitive)?.contentOrNull) graph.copy(cacheEpoch = epoch) else graph
            },
        )
        return reduce(input, JsonObject(root + ("event" to JsonObject(event + additions))).toString(), committed, channel)
    }

    /** 夹具包一层，但 artifact chunk 这类成员仍然直通，测试不必为了夹具改写调用。 */
    fun reduceArtifactChunk(
        state: RemoteState,
        runtimeId: String,
        transferId: String,
        offset: Long,
        length: Int,
        receivedOffset: Long? = null,
    ): RemoteState = delegate.reduceArtifactChunk(state, runtimeId, transferId, offset, length, receivedOffset)
}

private val fixtureJson = Json { ignoreUnknownKeys = true }

/** 给 session.snapshot / session.patch 补一个夹具显示批次；已经有 display 或没有条目就原样返回。 */
internal fun String.withFixtureDisplay(): String {
    val root = runCatching { fixtureJson.parseToJsonElement(this) as? JsonObject }.getOrNull() ?: return this
    val event = root["event"] as? JsonObject ?: return this
    // 夹具用 encodeDefaults 序列化时会写出显式的 `"display":null`：那也是「没有显示结果」。
    val existing = event["display"]
    if (existing != null && existing !is kotlinx.serialization.json.JsonNull) return this
    // 夹具里有两种包法：event 自带 type，以及外层 type 覆盖 runtime.event（快照测试的写法）。
    val type = (event["type"] as? JsonPrimitive)?.contentOrNull ?: (root["type"] as? JsonPrimitive)?.contentOrNull
    if (type !in setOf("session.snapshot", "session.patch")) return this
    val entries = event["entries"] as? JsonArray ?: return this
    val parsed = runCatching { fixtureJson.decodeFromJsonElement<List<SessionGraphEntry>>(entries) }.getOrNull()
        ?: return this
    if (parsed.isEmpty()) return this
    val display = fixtureJson.encodeToJsonElement(DisplayBatch.serializer(), fixtureDisplayBatch(parsed))
    return JsonObject(root + ("event" to JsonObject(event + ("display" to display)))).toString()
}

/** 夹具条目 → 一行可渲染消息：只认 `data.message`，其余当作没有显示结果。 */
private fun fixtureDisplayEntry(entry: SessionGraphEntry): DisplayEntry? {
    // 压缩/分支摘要：产出方一定会给一行摘要，摘要在窗口顶部。
    if (entry.type == "compaction" || entry.type == "branch_summary") {
        val summary = (entry.data["summary"] as? JsonPrimitive)?.contentOrNull.orEmpty()
        if (entry.type == "branch_summary" && summary.isEmpty()) return null
        val label = if (entry.type == "compaction") "压缩摘要" else "分支摘要"
        return DisplayEntry(
            displayId = entry.entryId, entryId = entry.entryId, nativeType = entry.type, kind = "summary",
            message = ChatMessage(entry.entryId, "system", listOf(RemoteContent("text", "$label：$summary")), 0L),
            anchor = DISPLAY_ANCHOR_HEAD.takeIf { entry.type == "compaction" },
        )
    }
    val message = entry.data["message"] as? JsonObject ?: return null
    val role = (message["role"] as? JsonPrimitive)?.contentOrNull ?: return null
    val mapped = when (role) {
        "user" -> "user"
        "assistant" -> "assistant"
        "toolResult", "tool" -> "tool"
        "custom" -> "custom"
        "bashExecution" -> "system"
        else -> return null
    }
    return DisplayEntry(
        displayId = entry.entryId,
        entryId = entry.entryId,
        nativeType = entry.type,
        kind = "message",
        message = ChatMessage(
            messageId = entry.entryId,
            role = mapped,
            content = fixtureContent(message["content"]),
            timestamp = (message["timestamp"] as? JsonPrimitive)?.longOrNull ?: 0L,
            toolCallId = (message["toolCallId"] as? JsonPrimitive)?.contentOrNull,
            toolName = (message["toolName"] as? JsonPrimitive)?.contentOrNull,
        ),
    )
}

/** 夹具正文：字符串，或 text / thinking / toolCall 块。未知块不猜。 */
private fun fixtureContent(element: JsonElement?): List<RemoteContent> = when (element) {
    is JsonPrimitive -> listOf(RemoteContent("text", element.contentOrNull.orEmpty()))
    is JsonArray -> element.mapNotNull { raw ->
        val block = raw as? JsonObject ?: return@mapNotNull null
        when ((block["type"] as? JsonPrimitive)?.contentOrNull) {
            "text" -> RemoteContent("text", (block["text"] as? JsonPrimitive)?.contentOrNull.orEmpty())
            "thinking" -> RemoteContent(
                "thinking", ((block["thinking"] ?: block["text"]) as? JsonPrimitive)?.contentOrNull.orEmpty(),
            )
            "toolCall", "tool_call" -> RemoteContent(
                type = "tool_call",
                toolCallId = ((block["toolCallId"] ?: block["id"]) as? JsonPrimitive)?.contentOrNull,
                toolName = ((block["toolName"] ?: block["name"]) as? JsonPrimitive)?.contentOrNull,
                arguments = block["arguments"],
            )
            else -> null
        }
    }
    else -> emptyList()
}
