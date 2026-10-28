package com.orbising.orbis

import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import java.util.UUID

@Serializable data class ToolAgent(val hostId: String, val agentKind: String, val sessionId: String)
@Serializable data class ToolIdentity(val agent: ToolAgent, val toolCallId: String)
@Serializable data class ToolSummaryText(val text: String, val omitted: Boolean, val originalBytes: Long)
@Serializable data class ToolPart(val part: String, val format: String, val availability: String, val readCapability: String)
@Serializable data class ToolSummary(
    val projectionVersion: Int = 1, val tool: ToolIdentity, val toolName: String, val phase: String,
    val order: Long, val isError: Boolean? = null, val turnId: String? = null, val messageId: String? = null,
    val entryId: String? = null, val exitCode: Int? = null, val durationMs: Long? = null,
    val inputSummary: ToolSummaryText? = null, val resultSummary: ToolSummaryText? = null,
    val errorSummary: ToolSummaryText? = null, val contents: List<ToolPart> = emptyList(),
)
@Serializable data class ToolSource(val epoch: String, val seq: Long)
@Serializable data class ToolVersion(val epoch: String, val revision: Long)
@Serializable data class ToolInventoryReference(val projectionVersion: Int, val agent: ToolAgent, val version: ToolVersion,
    val source: ToolSource, val totalCount: Int, val summaryBytes: Long)
@Serializable data class ToolInventorySnapshot(val snapshotId: String, val agent: ToolAgent, val version: ToolVersion,
    val source: ToolSource, val totalCount: Int?)
@Serializable data class ToolInventoryPage(val requestId: String, val runtimeId: String, val snapshot: ToolInventorySnapshot,
    val startIndex: Int, val endIndex: Int, val tools: List<ToolSummary>, val nextCursor: String?)
@Serializable data class ToolInventoryPatch(val runtimeId: String, val agent: ToolAgent, val version: ToolVersion,
    val source: ToolSource, val baseRevision: Long, val upserts: List<ToolSummary>, val removes: List<String>)
@Serializable data class ToolLocator(val projectionVersion: Int = 1, val tool: ToolIdentity, val part: String)
@Serializable data class ToolReadIdentity(val readId: String, val contentEpoch: String, val throughOffset: Long)
@Serializable data class ToolGap(val fromOffset: Long, val throughOffset: Long, val reason: String)
@Serializable data class ToolContentPage(val requestId: String, val runtimeId: String, val locator: ToolLocator,
    val read: ToolReadIdentity, val format: String, val representation: String, val fromOffset: Long,
    val throughOffset: Long, val availableFromOffset: Long, val availableThroughOffset: Long,
    val observedThroughOffset: Long, val contentFinal: Boolean, val text: String, val nextCursor: Long?,
    val gaps: List<ToolGap>)

internal val toolJson = Json { ignoreUnknownKeys = true; encodeDefaults = true }
private fun JsonElement.withoutNulls(): JsonElement = when (this) {
    is JsonObject -> JsonObject(filterValues { it != JsonNull }.mapValues { it.value.withoutNulls() })
    is JsonArray -> JsonArray(map { it.withoutNulls() })
    else -> this
}
private fun toolBytes(tool: ToolSummary) = toolJson.encodeToJsonElement(tool).withoutNulls().toString().toByteArray(Charsets.UTF_8).size
private val toolOrder = compareBy<ToolSummary> { it.order }.thenBy { it.tool.toolCallId }
private fun validToolId(value: String) = value.isNotBlank() && value.toByteArray(Charsets.UTF_8).size <= 256
private fun validToolSummary(value: ToolSummary): Boolean = value.projectionVersion == 1 && value.order >= 0 &&
    validToolId(value.tool.toolCallId) && validToolId(value.toolName) && value.phase in setOf("started", "running", "finished", "cancelled") &&
    value.contents.size <= 3 && value.contents.map { it.part }.distinct().size == value.contents.size &&
    value.contents.all { it.part in setOf("arguments", "output", "result") && it.format in setOf("text", "json", "media-references") &&
        it.availability in setOf("absent", "pending", "readable", "temporarily-unavailable", "unrecoverable") &&
        it.readCapability in setOf("range", "whole-source", "none") && (it.availability != "readable" || it.readCapability != "none") } && toolBytes(value) <= 4096

internal fun toolReadFailureText(reason: String?) = when (reason) {
    "busy" -> "电脑端读取繁忙，请稍后重试"
    "content_expired", "snapshot_expired" -> "内容读取已过期，请关闭并重新打开详情"
    "content_version_invalid" -> "内容版本已变化，请关闭并重新打开详情"
    "content_range_unavailable", "invalid_utf8_offset" -> "请求范围不可读取"
    "scope_mismatch" -> "详情所属会话已变化，请重新打开"
    "cancelled" -> "详情读取已取消"
    else -> "来源暂时无法提供这部分内容"
}

/** Fixed-version inventory is independent of the chat source sequence and detail cache. */
data class ToolInventoryReplica(
    val reference: ToolInventoryReference? = null,
    val tools: List<ToolSummary> = emptyList(),
    val target: ToolInventoryReference? = null,
    val snapshot: ToolInventorySnapshot? = null,
    val incoming: List<ToolSummary> = emptyList(),
    val bytes: Long = 0,
    val requestId: String? = null,
    val cursor: String? = null,
    val buffered: List<ToolInventoryPatch> = emptyList(),
    val retired: Set<String> = emptySet(),
    val error: String? = null,
) {
    fun covers(ref: ToolInventoryReference) = target == null && reference == ref
    fun require(ref: ToolInventoryReference): ToolInventoryReplica {
        if (covers(ref) || target == ref) return this
        if (target != null && target.source.epoch == ref.source.epoch) return this
        if (ref.projectionVersion != 1 || !validToolId(ref.version.epoch) || ref.version.revision < 1 ||
            !validToolId(ref.source.epoch) || ref.source.seq < 0 || ref.version.epoch in retired || ref.totalCount !in 0..4096 ||
            ref.summaryBytes !in 0..8_388_608) return copy(error = "工具清单版本或大小无效")
        val old = target ?: reference
        if (old != null && old.version.epoch == ref.version.epoch && ref.version.revision < old.version.revision) return this
        val dead = if (old != null && old.version.epoch != ref.version.epoch) retired + old.version.epoch else retired
        if (dead.size > 64) return copy(error = "工具清单代次超限")
        return copy(target = ref, snapshot = null, incoming = emptyList(), bytes = 0, cursor = null,
            requestId = UUID.randomUUID().toString(), buffered = emptyList(), retired = dead, error = null)
    }
    fun command(runtimeId: String): JsonObject? {
        val target = target ?: return null
        val request = requestId ?: return null
        return buildJsonObject {
            put("type", if (snapshot == null) "session.tools.open" else "session.tools.read")
            put("runtimeId", runtimeId); put("requestId", request)
            if (snapshot == null) put("reference", toolJson.encodeToJsonElement(target)) else {
                put("snapshot", toolJson.encodeToJsonElement(snapshot)); put("cursor", cursor?.let(::JsonPrimitive) ?: JsonNull); put("maxItems", 128)
            }
        }
    }
    fun opened(request: String, value: ToolInventorySnapshot): ToolInventoryReplica {
        val ref = target ?: return this
        if (requestId != request) return this
        if (value.agent != ref.agent || value.source != ref.source || value.version != ref.version || value.totalCount != ref.totalCount) return failed("工具清单身份不匹配")
        return copy(snapshot = value, requestId = UUID.randomUUID().toString())
    }
    fun page(page: ToolInventoryPage): ToolInventoryReplica {
        if (page.requestId != requestId || page.snapshot.snapshotId != snapshot?.snapshotId) return this
        val ref = target ?: return this
        val ids = (incoming + page.tools).map { it.tool.toolCallId }
        val nextBytes = bytes + page.tools.sumOf { toolBytes(it).toLong() }
        if (page.snapshot != snapshot || page.startIndex != incoming.size || page.endIndex != incoming.size + page.tools.size ||
            page.tools.size > 128 || page.tools.any { it.tool.agent != ref.agent || !validToolSummary(it) } ||
            ids.distinct().size != ids.size || ids.size > 4096 || nextBytes > 8_388_608 ||
            page.nextCursor != null && (page.nextCursor == cursor || page.tools.isEmpty())) return failed("工具清单分页无效")
        val all = incoming + page.tools
        if (all != all.sortedWith(toolOrder)) return failed("工具清单顺序无效")
        if (page.nextCursor != null) return copy(incoming = all, bytes = nextBytes, cursor = page.nextCursor, requestId = UUID.randomUUID().toString())
        if (all.size != ref.totalCount || nextBytes != ref.summaryBytes) return failed("工具清单未完整接收")
        return copy(reference = ref, tools = all, target = null, snapshot = null, incoming = emptyList(),
            bytes = 0, cursor = null, requestId = null, error = null)
    }
    fun patch(patch: ToolInventoryPatch): ToolInventoryReplica {
        val latest = buffered.lastOrNull()?.let { ToolInventoryReference(1, it.agent, it.version, it.source, 0, 0) } ?: target ?: reference ?: return this
        if (patch.version.epoch in retired || patch.version.epoch == latest.version.epoch && patch.version.revision <= latest.version.revision) return this
        if (patch.agent != latest.agent || patch.version.epoch != latest.version.epoch || patch.source.epoch != latest.source.epoch ||
            patch.baseRevision != latest.version.revision || patch.version.revision != patch.baseRevision + 1 || patch.source.seq <= latest.source.seq ||
            patch.upserts.size + patch.removes.size > 128) return failed("工具清单需要重新读取")
        if (target != null) {
            if (buffered.size >= 64 || (buffered + patch).sumOf { toolJson.encodeToString(it).toByteArray().size } > 1_048_576) return failed("工具清单更新缓冲已满")
            return copy(buffered = buffered + patch)
        }
        val map = tools.associateBy { it.tool.toolCallId }.toMutableMap()
        val touched = patch.upserts.map { it.tool.toolCallId } + patch.removes
        if (touched.isEmpty() || touched.distinct().size != touched.size || patch.removes.any { it !in map } || patch.upserts.any { it.tool.agent != patch.agent || !validToolSummary(it) }) return failed("工具清单更新无效")
        patch.removes.forEach(map::remove); patch.upserts.forEach { map[it.tool.toolCallId] = it }
        if (map.size > 4096 || map.values.sumOf(::toolBytes) > 8_388_608) return failed("工具清单超过预算")
        return copy(reference = reference!!.copy(version = patch.version, source = patch.source, totalCount = map.size,
            summaryBytes = map.values.sumOf { toolBytes(it).toLong() }), tools = map.values.sortedWith(toolOrder))
    }
    fun failed(reason: String) = copy(target = null, snapshot = null, incoming = emptyList(), bytes = 0,
        requestId = null, buffered = emptyList(), error = reason)
}

data class PendingToolConversation(val payload: String, val committed: CommittedSessionBatch?, val channel: String?, val reference: ToolInventoryReference)

data class ToolDetailView(
    val runtimeId: String, val summary: ToolSummary, val part: String, val viewerId: String = UUID.randomUUID().toString(),
    val read: ToolReadIdentity? = null, val text: String = "", val offset: Long = 0,
    val nextCursor: Long? = null, val observed: Long = 0, val contentFinal: Boolean = false,
    val gaps: List<ToolGap> = emptyList(), val requestId: String? = null, val follow: Boolean = false,
    val error: String? = null, val requestOffset: Long = 0,
    val contentEpoch: String? = null,
    val exporting: Boolean = false, val exportedBytes: Long = 0, val exportComplete: Boolean = false,
) {
    val locator get() = ToolLocator(tool = summary.tool, part = part)
    fun request(fresh: Boolean = false): ToolDetailView = copy(requestId = UUID.randomUUID().toString(),
        requestOffset = nextCursor ?: offset, read = if (fresh) null else read, error = null)
    fun command(): JsonObject? = requestId?.let { id -> buildJsonObject {
        put("type", "session.tool.content.read"); put("runtimeId", runtimeId); put("requestId", id); put("viewerId", viewerId)
        put("locator", toolJson.encodeToJsonElement(locator)); put("read", read?.let { toolJson.encodeToJsonElement(it) } ?: JsonNull)
        put("offset", requestOffset); put("maxBytes", 32 * 1024)
    } }
    fun page(page: ToolContentPage): ToolDetailView {
        if (page.requestId != requestId) return this
        val count = page.text.toByteArray(Charsets.UTF_8).size
        var gapCursor = 0L
        val validGaps = page.gaps.all { gap ->
            if (gapCursor == page.availableFromOffset) gapCursor = page.availableThroughOffset
            val valid = gap.fromOffset == gapCursor && gap.fromOffset >= 0 && gap.fromOffset < gap.throughOffset &&
                gap.throughOffset <= page.observedThroughOffset && gap.reason in setOf("quota", "expired", "source-missing") &&
                (gap.throughOffset <= page.availableFromOffset || gap.fromOffset >= page.availableThroughOffset)
            gapCursor = gap.throughOffset; valid
        }
        if (gapCursor == page.availableFromOffset) gapCursor = page.availableThroughOffset
        if (page.runtimeId != runtimeId || page.locator != locator || page.fromOffset != requestOffset ||
            !validToolId(page.read.readId) || !validToolId(page.read.contentEpoch) || page.fromOffset < 0 || page.availableFromOffset < 0 ||
            page.format !in setOf("text", "json", "media-references") || !validGaps || gapCursor != page.observedThroughOffset ||
            page.throughOffset - page.fromOffset != count.toLong() || count > 32 * 1024 ||
            read != null && read != page.read || contentEpoch != null && contentEpoch != page.read.contentEpoch || page.representation != "utf8-fragment" ||
            page.read.throughOffset > page.availableThroughOffset || page.availableThroughOffset > page.observedThroughOffset ||
            page.fromOffset < page.availableFromOffset || page.throughOffset > page.read.throughOffset ||
            page.nextCursor != (page.throughOffset.takeIf { it < page.read.throughOffset }) ||
            page.nextCursor != null && count == 0 || page.gaps.size > 32) return copy(requestId = null, follow = false, error = "详情范围或版本无效")
        if (text.toByteArray().size + count > 2 * 1024 * 1024) return copy(requestId = null, follow = false, error = "已读取内容达到 2 MiB 缓存上限，可清空已读内容后继续")
        return copy(read = page.read, contentEpoch = page.read.contentEpoch, text = text + page.text, offset = page.throughOffset, nextCursor = page.nextCursor,
            observed = page.observedThroughOffset, contentFinal = page.contentFinal, gaps = page.gaps, requestId = null, error = null)
    }
}
