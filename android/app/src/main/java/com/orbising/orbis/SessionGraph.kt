package com.orbising.orbis

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject

@Serializable
data class SessionGraphEntry(
    val entryId: String,
    val parentId: String? = null,
    val type: String,
    val timestamp: String,
    val data: JsonObject = buildJsonObject { },
)

@Serializable
data class SessionBranchCursor(
    val leafId: String? = null,
)

@Serializable
data class SessionSourceEpoch(
    val epoch: String,
    val seq: Long,
    val ready: Boolean,
)

@Serializable
data class SessionAppliedState(
    val epoch: String,
    val seq: Long,
    val head: SessionBranchCursor,
)

@Serializable
data class SessionCheckpoint(
    val checkpointId: String,
    val head: SessionBranchCursor? = null,
    val headCompleteness: String,
    val inventoryComplete: Boolean,
)

@Serializable
data class SessionLiveMessage(
    val message: ChatMessage,
    val finished: Boolean,
    val contentComplete: Boolean,
    val persistedEntryId: String? = null,
)

@Serializable
data class SessionLiveTool(
    val toolCallId: String,
    val toolName: String,
    val state: String,
    val detail: JsonElement? = null,
    val isError: Boolean? = null,
)

@Serializable
data class SessionLiveTurn(
    val turnId: String,
    val startedAt: Long,
    val durationMs: Long? = null,
)

@Serializable
data class SessionLiveState(
    val complete: Boolean,
    val turn: SessionLiveTurn? = null,
    val messages: List<SessionLiveMessage> = emptyList(),
    val tools: List<SessionLiveTool> = emptyList(),
)

@Serializable
data class SessionPatch(
    val type: String = "session.patch",
    val sessionId: String,
    val source: SessionSourceEpoch,
    val baseSeq: Long,
    val seq: Long,
    val checkpointId: String,
    val head: SessionBranchCursor,
    val headCompleteness: String,
    val live: SessionLiveState,
    val entries: List<SessionGraphEntry> = emptyList(),
    /** 产出方对本次提交条目给出的显示投影（顺序与 entries 一致）。 */
    val display: DisplayBatch? = null,
)

/** Cache supplementation only; the version gate, not this page, owns the active head. */
internal fun SessionPatch.canonicalPage(
    entries: List<SessionGraphEntry> = this.entries,
    display: DisplayBatch? = this.display,
) = SessionGraphSnapshot(
    sessionId, checkpointId, SessionBranchCursor(), "prepend", entries, source = source, display = display,
)

/**
 * 合并同一来源版本的多个 patch：条目合并，显示结果也合并。
 *
 * 每个 patch 只带自己那几条的显示结果，滚动缓冲一次提交多批时必须全部带上，否则中间那几批
 * 会永远没有可渲染的结果。
 */
internal fun mergedPatchDisplay(patches: List<SessionPatch>): DisplayBatch? {
    val batches = patches.mapNotNull { it.display }
    if (batches.isEmpty()) return null
    return DisplayBatch(
        projectionVersion = batches.maxOf(DisplayBatch::projectionVersion),
        entries = batches.flatMap(DisplayBatch::entries),
        windowStart = batches.last().windowStart,
    )
}

@Serializable
data class SessionGraphSnapshot(
    val sessionId: String,
    val syncId: String,
    val cursor: SessionBranchCursor,
    val mode: String,
    val entries: List<SessionGraphEntry> = emptyList(),
    val range: String? = null,
    val targetLeafId: String? = null,
    val beforeEntryId: String? = null,
    val hasOlder: Boolean? = null,
    val complete: Boolean? = null,
    val rangeStatus: String? = null,
    /** Timing metadata accompanying this page, merged independently of canonical Entries. */
    val turnTimings: List<TurnTiming>? = null,
    val source: SessionSourceEpoch? = null,
    val checkpoint: SessionCheckpoint? = null,
    val live: SessionLiveState? = null,
    val selection: String? = null,
    /** 产出方对本次范围内条目给出的显示投影（顺序与 entries 一致）。 */
    val display: DisplayBatch? = null,
)

@Serializable
data class SessionGraph(
    val sessionId: String,
    val entries: Map<String, SessionGraphEntry> = emptyMap(),
    /** Last observed leaf, used only as the default branch for offline display. */
    val cursor: SessionBranchCursor = SessionBranchCursor(),
    /** Timing metadata is kept outside the Entry tree and projected by persisted message ID. */
    val turnTimings: Map<String, TurnTiming> = emptyMap(),
    /** Local cache generation, distinct from the conversation's active live watermark. */
    val cacheEpoch: String? = null,
    val entryVersions: Map<String, Long> = emptyMap(),
    val timingVersions: Map<String, Long> = emptyMap(),
    /** 显示投影：产出方解释好的可渲染结果，按 canonical entryId 索引。 */
    val display: Map<String, DisplayEntry> = emptyMap(),
    /** 显示窗口起点；比它更旧的路径条目不再显示。null = 整条路径都是窗口。 */
    val displayWindowStart: String? = null,
    /** 这些显示结果来自哪个投影版本；与本机版本不同就说明显示语义变了。 */
    val displayVersion: Int? = null,
)

internal fun SessionGraph.hasCompleteEntryChain(leafId: String?): Boolean {
    var current = leafId
    val visited = mutableSetOf<String>()
    while (current != null) {
        if (!visited.add(current)) return false
        val entry = entries[current] ?: return false
        current = entry.parentId
    }
    return true
}

internal fun SessionGraph.hasCompleteCursor(targetLeafId: String?): Boolean =
    targetLeafId != null && cursor.leafId == targetLeafId && hasCompleteEntryChain(targetLeafId)

internal fun SessionGraph.catchUpFrontier(targetLeafId: String?): String? {
    val frontier = cursor.leafId ?: return null
    if (targetLeafId == null || !entries.containsKey(frontier)) return null
    // A bounded local read can contain the Runtime target without its ancestors. Do not mistake
    // that incomplete target projection for a committed frontier; a persisted frontier normally
    // differs from the target until catch-up reaches it.
    if (frontier == targetLeafId && !hasCompleteEntryChain(frontier)) return null
    return frontier
}

internal fun SessionGraph.isDescendant(leafId: String?, ancestorId: String?): Boolean {
    if (leafId == null || ancestorId == null) return false
    var current = leafId
    val visited = mutableSetOf<String>()
    while (current != null && visited.add(current)) {
        if (current == ancestorId) return true
        current = entries[current]?.parentId ?: return false
    }
    return false
}

@Serializable
data class RuntimeSessionView(
    val runtimeId: String,
    val sessionId: String,
    val leafId: String? = null,
)

/**
 * Applies the Runtime's entry-chain update. Pi is authoritative; Android only
 * stores the received nodes by entry ID and moves the observed cursor.
 */
internal fun SessionGraph.merge(snapshot: SessionGraphSnapshot): SessionGraph {
    require(sessionId == snapshot.sessionId) { "session_mismatch" }
    require(snapshot.mode in setOf("replace", "append", "prepend")) { "unknown_merge_mode" }
    val authority = snapshot.source?.takeIf { it.ready }
    val baseline = if (authority != null && cacheEpoch != authority.epoch) SessionGraph(sessionId) else this
    // Validate the packet itself even when some rows are too old to replace cached values.
    val batch = validateCanonicalEntries(snapshot.entries, { null })
    val effective = batch.values.map { entry ->
        if (authority != null && authority.seq < (baseline.entryVersions[entry.entryId] ?: -1L))
            baseline.entries[entry.entryId] ?: entry else entry
    }
    val received = validateCanonicalEntries(effective, baseline.entries::get, authoritative = authority != null)
    val mergedEntries = baseline.entries + received
    val timings = baseline.turnTimings.toMutableMap()
    snapshot.turnTimings.orEmpty().forEach { timing ->
        if (authority == null || authority.seq >= (baseline.timingVersions[timing.turnId] ?: -1L))
            timings[timing.turnId] = mergeCanonicalTiming(timings[timing.turnId].takeIf { authority == null }, timing)
    }
    val observed = snapshot.cursor.leafId?.takeIf(mergedEntries::containsKey)
        ?: snapshot.entries.lastOrNull()?.entryId?.takeIf { snapshot.range == "catchup" }
    // 显示结果与条目同源：同一批 snapshot 带来的显示行按 entryId 覆盖旧表示。
    // 版本不匹配的批次整批拒绝：本机只认得自己那份语义的显示结果。已有的行仍是本机语义下的
    // 结果，原样保留；版本号记下来，由投影如实报给用户，而不是悄悄按别人的语义渲染。
    val appliesDisplay = snapshot.display != null && snapshot.display.projectionVersion == DISPLAY_PROJECTION_VERSION
    val merged = baseline.copy(
        entries = mergedEntries,
        display = mergeDisplayEntries(baseline.display, snapshot.display),
        displayWindowStart = if (appliesDisplay) snapshot.display?.windowStart else baseline.displayWindowStart,
        displayVersion = snapshot.display?.projectionVersion ?: baseline.displayVersion,
        // This is the observed/display cursor only. Durable continuity comes from the store.
        cursor = if (snapshot.mode != "prepend" && observed != null &&
            !baseline.copy(entries = mergedEntries).isDescendant(baseline.cursor.leafId, observed)) {
            SessionBranchCursor(observed)
        } else baseline.cursor,
        turnTimings = timings,
        cacheEpoch = authority?.epoch ?: baseline.cacheEpoch,
        entryVersions = if (authority == null) baseline.entryVersions else baseline.entryVersions +
            received.keys.associateWith { maxOf(authority.seq, baseline.entryVersions[it] ?: -1L) },
        timingVersions = if (authority == null) baseline.timingVersions else baseline.timingVersions +
            snapshot.turnTimings.orEmpty().associate { it.turnId to maxOf(authority.seq, baseline.timingVersions[it.turnId] ?: -1L) },
    )
    return merged
}

internal data class SessionProjectionResult(
    val messages: List<ChatMessage>,
    val error: String? = null,
    val turnTimings: List<TurnTiming> = emptyList(),
)

/**
 * Reconstructs the branch and its display rows from the cached Session graph.
 *
 * 历史权威仍在 SessionGraph 这边（分支＝从叶子沿 parentId 回溯），但**解释**归产出方：
 * 这里只把 canonical 路径交给显示投影，按窗口裁剪、按锚点排序，不再解释任何原生形状。
 */
internal fun projectSessionGraph(graph: SessionGraph): SessionProjectionResult {
    val pathResult = walkSessionGraphPath(
        graph.cursor.leafId,
        (graph.entries.size + 1).coerceAtLeast(1),
        graph.entries::get,
    )
    val path = pathResult.entries
    // 版本不匹配时如实说出来：内容为空不是「没有历史」，而是本机认不出对方的显示语义。
    val projectionError = graph.displayVersion?.takeIf { it != DISPLAY_PROJECTION_VERSION }
        ?.let { "显示投影版本不匹配（Host：$it），请更新 App" }
        ?: graph.cursor.leafId?.let {
            pathResult.status.takeUnless { status ->
                status == SessionGraphRangeStatus.COMPLETE || status == SessionGraphRangeStatus.LIMIT_REACHED
            }?.name?.lowercase()
        }
    val visible = applyDisplayWindow(path, graph.displayWindowStart)
    // 没有显示结果的条目不是「丢弃历史」，只是还没有可渲染的解释：身份仍在 graph.entries 里。
    val messages = displayMessages(visible, graph.display)
    return SessionProjectionResult(
        messages = messages,
        error = projectionError,
        turnTimings = graph.turnTimings.values.filter { timing ->
            timing.messageId == null || messages.any { it.messageId == timing.messageId }
        },
    )
}

/** 一段不在完整路径上的条目（有界页）：窗口与锚点照旧由显示状态决定。 */
internal fun projectSessionEntries(
    entries: List<SessionGraphEntry>,
    display: Map<String, DisplayEntry>,
    windowStart: String? = null,
): List<ChatMessage> = displayMessages(applyDisplayWindow(entries, windowStart), display)

/**
 * First user message text visible in the branch rooted at the current leaf. This is the canonical
 * Session title the sidebar renders for both online and offline Sessions, so callers should treat
 * the result as a stable label rather than a full message body.
 */
internal fun SessionGraph.firstUserMessageTitle(): String? {
    if (cursor.leafId == null || entries.isEmpty()) return null
    val path = buildSessionPath(entries, cursor.leafId)
    if (path.isEmpty()) return null
    return firstUserMessageTitle(projectSessionEntries(path, display, displayWindowStart))
}

internal fun SessionGraph.projectLeafDeltaProjection(
    oldLeafId: String?,
    newLeafId: String?,
    currentMessages: List<ChatMessage>,
): SessionProjectionResult {
    val fullProjection = projectSessionGraph(copy(cursor = SessionBranchCursor(newLeafId)))
    if (currentMessages.isEmpty() || oldLeafId == newLeafId) return fullProjection
    val oldPath = buildSessionPath(entries, oldLeafId)
    val newPath = buildSessionPath(entries, newLeafId)
    if (oldLeafId == null || oldPath.isEmpty() || newPath.isEmpty() || displayWindowStart != null ||
        (oldPath + newPath).any { display[it.entryId]?.anchor != null }) {
        return fullProjection
    }
    var common = 0
    while (common < oldPath.size && common < newPath.size &&
        oldPath[common].entryId == newPath[common].entryId) common += 1
    val oldIds = oldPath.map(SessionGraphEntry::entryId).toSet()
    val commonIds = oldPath.take(common).map(SessionGraphEntry::entryId).toSet()
    val commonMessages = currentMessages.filter { it.messageId in commonIds }
    val canonicalSuffix = projectSessionEntries(newPath.drop(common), display, displayWindowStart)
    // Messages not represented by the old branch are live overlays. Keep them in their existing
    // order, but only after the newly arrived canonical suffix. A row the suffix already carries
    // is the same message under its temporary id, so re-attaching it would render it twice.
    val overlays = currentMessages.filter {
        it.messageId !in oldIds && !(commonMessages + canonicalSuffix).represents(it)
    }
    return fullProjection.copy(
        messages = commonMessages + canonicalSuffix + overlays,
    )
}

internal fun SessionGraph.projectLeafDelta(
    oldLeafId: String?,
    newLeafId: String?,
    currentMessages: List<ChatMessage>,
): List<ChatMessage> = projectLeafDeltaProjection(oldLeafId, newLeafId, currentMessages).messages

internal fun buildSessionPath(entries: Map<String, SessionGraphEntry>, leafId: String?): List<SessionGraphEntry> {
    if (leafId == null) return emptyList()
    val path = mutableListOf<SessionGraphEntry>()
    val visited = mutableSetOf<String>()
    var current: String? = leafId
    while (current != null && visited.add(current)) {
        val entry = entries[current] ?: break
        path += entry
        current = entry.parentId
    }
    return path.asReversed()
}

