package com.orbising.orbis

import kotlinx.serialization.Serializable

/**
 * 统一显示投影的客户端一半（ADR-0032 §5）。
 *
 * 原生条目仍是历史权威；这里存的是**产出方解释好**、可以直接渲染的结果。App 不再解释
 * `firstKeptEntryId`、`stopReason`、`toolResult` 这些原生形状：压缩裁剪、角色映射、失败回填、
 * 自定义消息拼装全部由产出方完成（协议层 `display-entries.ts`，三个后端共用）。
 */

/**
 * 投影算法版本。批次带来的版本与本机不同就说明显示语义变了：显示缓存必须整段重建，
 * 不能继续按旧表示渲染。
 */
internal const val DISPLAY_PROJECTION_VERSION = 3

/** 锚点：渲染在显示窗口顶部（历史被改写的位置），而不是它在 canonical 路径里的位置。 */
internal const val DISPLAY_ANCHOR_HEAD = "head"

@Serializable
data class DisplayEntry(
    /** 稳定的显示身份：canonical 条目就是 entryId。 */
    val displayId: String,
    val entryId: String? = null,
    /** 原生类型：只用于诊断与树结构，不参与解释。 */
    val nativeType: String? = null,
    /** message / summary / undisplayable。 */
    val kind: String,
    /** 可直接渲染的消息；undisplayable 时为 null。 */
    val message: ChatMessage? = null,
    /** 为什么不可显示：unknown_native_type / not_rendered / missing_content。 */
    val reason: String? = null,
    /** 见 [DISPLAY_ANCHOR_HEAD]；为空表示按 canonical 路径顺序渲染。 */
    val anchor: String? = null,
)

@Serializable
data class DisplayBatch(
    val projectionVersion: Int,
    val entries: List<DisplayEntry> = emptyList(),
    /** 显示窗口起点：路径上比它更旧的条目已经被历史改写覆盖，不再显示。null = 整条路径都是窗口。 */
    val windowStart: String? = null,
)

/**
 * 按显示窗口裁剪一条路径：窗口起点之后的条目才显示。
 *
 * 找不到窗口起点时整条保留。路径是从叶子往回走的连续链：没走到起点就说明手里的内容全都比它新
 * （更旧的条目此刻根本不在链上）；这时按窗口裁剪反而会误删。
 */
internal fun applyDisplayWindow(path: List<SessionGraphEntry>, windowStart: String?): List<SessionGraphEntry> {
    if (windowStart == null) return path
    val index = path.indexOfFirst { it.entryId == windowStart }
    return if (index <= 0) path else path.drop(index)
}

/**
 * 把一条（已按窗口裁剪过的）路径渲染成消息：按 entryId 取显示结果 → 窗口顶部的条目排在最前。
 *
 * 没有显示结果的条目直接跳过：App 只渲染产出方解释过的结果，不猜原生形状。不可显示的条目
 * 已经在结果里带着原因，这里没有可渲染的消息，自然不出现。
 */
internal fun displayMessages(
    path: List<SessionGraphEntry>,
    display: Map<String, DisplayEntry>,
): List<ChatMessage> {
    val rows = path.mapNotNull { row -> display[row.entryId] }
    // 摘要描述的是比它更旧的那段历史，因此排在它覆盖的内容之前；其余保持路径顺序。
    val head = rows.filter { it.anchor == DISPLAY_ANCHOR_HEAD }
    val body = rows.filter { it.anchor != DISPLAY_ANCHOR_HEAD }
    return (head + body).mapNotNull(DisplayEntry::message)
}

/** 把一批显示结果并进按 entryId 索引的显示缓存；版本不匹配的批次整批拒绝。 */
internal fun mergeDisplayEntries(
    existing: Map<String, DisplayEntry>,
    batch: DisplayBatch?,
): Map<String, DisplayEntry> {
    if (batch == null || batch.projectionVersion != DISPLAY_PROJECTION_VERSION) return existing
    if (batch.entries.isEmpty()) return existing
    return existing + batch.entries.mapNotNull { row -> row.entryId?.let { it to row } }
}
