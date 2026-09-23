package dev.pi.remote

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * `/tree` 在手机上的投影模型。
 *
 * 运行时发布的是一张**预序扁平表**（每个节点带 `parentId`、`isOnActivePath`、`isCurrent`），
 * 这里把它还原成树，再按「轮次」组织成可读的行：
 *
 * - 默认只走一条主线（当前分支），主线上的节点连续排列、缩进不随链长增长；
 * - 主线之外的子树折成一行摘要（"尝试另一种实现 · 8 轮对话"），点开才展开；
 * - 用户消息和助手回复是**可选中的节点**，工具调用与设置项落进「细节」，默认收起。
 *
 * 所有遍历都是迭代的：真实会话可能有几万条记录，递归会在深链上爆栈。
 */

/** 历史树页面的筛选档位。 */
internal enum class HistoryTreeFilter(val title: String) {
    DEFAULT("默认"),
    NO_TOOLS("无工具"),
    USER_ONLY("仅用户"),
    LABELED_ONLY("书签"),
    ALL("全部"),
}

internal enum class HistoryNodeKind(val label: String) {
    User("你问"),
    Assistant("助手"),
    Tool("工具"),
    System("设置"),
}

/** 节点上能执行的动作；null 表示这个节点只能预览。 */
internal enum class HistoryNodeAction { EditAndRestart, ContinueFromHere }

internal data class HistoryNode(
    val nodeId: String,
    val kind: HistoryNodeKind,
    val title: String,
    val bookmark: String?,
    val isCurrent: Boolean,
    val isOnActivePath: Boolean,
    val action: HistoryNodeAction?,
)

internal sealed interface HistoryTreeRow {
    val key: String
    val depth: Int
    /** 这一行含当前位置的节点。 */
    val hasCurrent: Boolean
    /** 这一行含预览中的节点，整行高亮。 */
    val containsSelected: Boolean
    val nodeIds: List<String>
}

/** 一轮对话：一条用户消息 + 它的助手回复，工具与设置项收在 [details] 里。 */
internal data class HistoryTurnRow(
    val user: HistoryNode?,
    val replies: List<HistoryNode>,
    val details: List<HistoryNode>,
    /** 细节展开状态只认这个键，跨刷新保持稳定。 */
    val detailsKey: String,
    val detailsExpanded: Boolean,
    /** 展开的分支用它自己的首行承载折叠动作；空表示这一行不负责折叠。 */
    val collapseBranchId: String?,
    val showTurnIndex: Boolean,
    val turnIndex: Int,
    val selectedNodeId: String?,
    override val depth: Int,
) : HistoryTreeRow {
    override val nodeIds: List<String> = buildList {
        user?.let { add(it.nodeId) }
        replies.forEach { add(it.nodeId) }
        details.forEach { add(it.nodeId) }
    }
    override val key: String = "turn:${nodeIds.firstOrNull() ?: "empty"}@$depth"
    override val hasCurrent: Boolean = (listOfNotNull(user) + replies + details).any(HistoryNode::isCurrent)
    override val containsSelected: Boolean = selectedNodeId != null && selectedNodeId in nodeIds
}

/** 折叠的其他分支：一行摘要，点一下展开。 */
internal data class HistoryBranchRow(
    val branchId: String,
    val summary: String,
    val turnCount: Int,
    val nodeCount: Int,
    override val depth: Int,
) : HistoryTreeRow {
    override val key: String get() = "branch:$branchId"
    override val nodeIds: List<String> get() = listOf(branchId)
    override val hasCurrent: Boolean get() = false
    override val containsSelected: Boolean get() = false

    /** "8 轮对话" / "3 条记录"：分支里没有用户消息时退化按记录条数说。 */
    val subtitle: String get() = if (turnCount > 0) "$turnCount 轮对话" else "$nodeCount 条记录"
}

/**
 * 把运行时的树选项投影成页面行。
 *
 * [selectedNodeId] 是预览中的节点：它所在的分支会被强制展开，免得选中的位置藏在折叠里。
 */
internal fun historyTreeRows(
    options: List<RuntimeSlashCommandOption>,
    filter: HistoryTreeFilter = HistoryTreeFilter.DEFAULT,
    query: String = "",
    expandedBranches: Set<String> = emptySet(),
    expandedDetails: Set<String> = emptySet(),
    selectedNodeId: String? = null,
): List<HistoryTreeRow> {
    val unique = options.distinctBy(RuntimeSlashCommandOption::value)
    if (unique.isEmpty()) return emptyList()
    val roots = buildHistoryForest(unique)
    computeHistoryStats(roots)
    val tokens = query.trim().lowercase().split(Regex("\\s+")).filter(String::isNotEmpty)
    return if (tokens.isEmpty()) {
        historyTreeBranchRows(
            roots = roots,
            filter = filter,
            expandedBranches = expandedBranches + historyAncestorIds(unique, selectedNodeId),
            expandedDetails = expandedDetails,
            selectedNodeId = selectedNodeId,
        )
    } else {
        historyTreeSearchRows(roots, filter, tokens, selectedNodeId)
    }
}

/** 当前位置的行下标；没有当前位置时退回到预览中的行。列表为空时返回 0。 */
internal fun historyTreeCurrentRowIndex(rows: List<HistoryTreeRow>): Int {
    val current = rows.indexOfFirst(HistoryTreeRow::hasCurrent)
    if (current >= 0) return current
    return rows.indexOfFirst(HistoryTreeRow::containsSelected).coerceAtLeast(0)
}

/**
 * 搜索是**平铺结果**，不保留折叠：搜索时用户要的是"哪几条记录里有这几个字"，
 * 而不是再走一遍树。行的 `depth` 归零，`turnIndex` 退化成命中序号。
 */
private fun historyTreeSearchRows(
    roots: List<HistoryEntry>,
    filter: HistoryTreeFilter,
    tokens: List<String>,
    selectedNodeId: String?,
): List<HistoryTreeRow> {
    val rows = mutableListOf<HistoryTreeRow>()
    val pending = ArrayDeque<HistoryEntry>()
    roots.asReversed().forEach(pending::addLast)
    var index = 0
    while (pending.isNotEmpty()) {
        val entry = pending.removeLast()
        entry.children.asReversed().forEach(pending::addLast)
        if (!entry.keeps(filter)) continue
        if (!tokens.all(entry.searchable::contains)) continue
        index += 1
        val node = entry.toNode()
        val isUser = entry.kind == HistoryNodeKind.User
        rows += HistoryTurnRow(
            user = node.takeIf { isUser },
            replies = if (isUser) emptyList() else listOf(node),
            details = emptyList(),
            detailsKey = entry.id,
            detailsExpanded = false,
            collapseBranchId = null,
            showTurnIndex = false,
            turnIndex = index,
            selectedNodeId = selectedNodeId,
            depth = 0,
        )
    }
    return rows
}

private fun historyTreeBranchRows(
    roots: List<HistoryEntry>,
    filter: HistoryTreeFilter,
    expandedBranches: Set<String>,
    expandedDetails: Set<String>,
    selectedNodeId: String?,
): List<HistoryTreeRow> {
    val rows = mutableListOf<HistoryTreeRow>()
    val steps = ArrayDeque<HistoryStep>()
    steps.addLast(HistorySectionStep(roots, depth = 0, collapseBranchId = null))
    while (steps.isNotEmpty()) {
        when (val step = steps.removeLast()) {
            is HistoryBranchRowStep -> rows += step.row

            // 展开的分支不需要额外的摘要行：它自己的根节点就是首行，并承载折叠动作。
            is HistoryExpandedBranchStep ->
                steps.addLast(HistorySectionStep(listOf(step.root), step.depth, step.root.id))

            is HistoryTurnStep -> {
                val row = step.toRow(filter, expandedDetails, selectedNodeId)
                if (row != null) rows += row
            }

            is HistorySectionStep ->
                pushHistorySection(steps, step, filter, expandedBranches, selectedNodeId)
        }
    }
    return rows
}

private fun pushHistorySection(
    steps: ArrayDeque<HistoryStep>,
    section: HistorySectionStep,
    filter: HistoryTreeFilter,
    expandedBranches: Set<String>,
    selectedNodeId: String?,
) {
    val spine = historySpine(section.roots)
    if (spine.isEmpty()) return
    val turns = mutableListOf<HistoryTurnBuilder>()
    var current: HistoryTurnBuilder? = null
    for (entry in spine) {
        val turn = when {
            entry.kind == HistoryNodeKind.User -> HistoryTurnBuilder(turns.size + 1).also { turns += it }
            current != null -> current
            else -> HistoryTurnBuilder(turns.size + 1).also { turns += it }
        }
        current = turn
        when {
            entry.detail -> turn.details += entry
            entry.kind == HistoryNodeKind.User -> turn.user = entry
            else -> turn.replies += entry
        }
        val mainChild = pickHistoryMain(entry.children)
        entry.children.forEach { child ->
            // 子树里没有任何可见内容的旁支（例如一条 `model_change`）不是"另一种走法"，
            // 给它在默认视图里占一行摘要只会制造噪音；「全部」档仍然列出来当逃生口。
            if (child !== mainChild && (child.visibleCount > 0 || filter == HistoryTreeFilter.ALL)) {
                turn.branches += child
            }
        }
    }
    // 先压入后面的行，弹出时才是从前往后；折叠标记只落在本节的第一个轮次上。
    turns.asReversed().forEachIndexed { reverseIndex, turn ->
        turn.branches.asReversed().forEach { branch ->
            if (branch.id in expandedBranches) {
                steps.addLast(HistoryExpandedBranchStep(branch, section.depth + 1))
            } else {
                steps.addLast(HistoryBranchRowStep(branch.toBranchRow(section.depth + 1)))
            }
        }
        steps.addLast(
            HistoryTurnStep(
                turn = turn,
                depth = section.depth,
                collapseBranchId = if (reverseIndex == turns.lastIndex) section.collapseBranchId else null,
                showTurnIndex = section.depth == 0,
            ),
        )
    }
}

/**
 * 一条主线：当前分支上的节点优先，没有当前分支（展开的旁支、或当前位置在别处）时走
 * 子树最大的一支。这是纯展示选择，不改动任何运行时状态。
 */
private fun historySpine(roots: List<HistoryEntry>): List<HistoryEntry> {
    val spine = mutableListOf<HistoryEntry>()
    var current: HistoryEntry? = pickHistoryMain(roots)
    while (current != null) {
        spine += current
        current = pickHistoryMain(current.children)
    }
    return spine
}

private fun pickHistoryMain(entries: List<HistoryEntry>): HistoryEntry? =
    entries.sortedWith(compareBy({ if (it.onActivePath) 1 else 0 }, { it.nodeCount })).lastOrNull()

private fun HistoryEntry.keeps(filter: HistoryTreeFilter): Boolean = when (filter) {
    HistoryTreeFilter.DEFAULT, HistoryTreeFilter.ALL -> true
    HistoryTreeFilter.NO_TOOLS -> kind != HistoryNodeKind.Tool
    HistoryTreeFilter.USER_ONLY -> kind == HistoryNodeKind.User
    HistoryTreeFilter.LABELED_ONLY -> bookmark != null
}

private fun HistoryEntry.toNode(): HistoryNode = HistoryNode(
    nodeId = id,
    kind = kind,
    title = title,
    bookmark = bookmark,
    isCurrent = isCurrent,
    isOnActivePath = onActivePath,
    action = action(),
)

private fun HistoryEntry.toBranchRow(depth: Int): HistoryBranchRow = HistoryBranchRow(
    branchId = id,
    summary = firstUserTitle ?: firstVisibleTitle ?: title,
    turnCount = turnCount,
    nodeCount = nodeCount,
    depth = depth,
)

private class HistoryTurnBuilder(val index: Int) {
    var user: HistoryEntry? = null
    val replies = mutableListOf<HistoryEntry>()
    val details = mutableListOf<HistoryEntry>()
    /** 本轮的旁支：本轮里任意一个节点的非主线子节点。 */
    val branches = mutableListOf<HistoryEntry>()

    /** 细节展开状态按本轮第一个节点记，跨刷新保持稳定。 */
    fun key(): String = (user ?: replies.firstOrNull() ?: details.firstOrNull())?.id.orEmpty()
}

private sealed interface HistoryStep

private class HistorySectionStep(
    val roots: List<HistoryEntry>,
    val depth: Int,
    val collapseBranchId: String?,
) : HistoryStep

private class HistoryExpandedBranchStep(val root: HistoryEntry, val depth: Int) : HistoryStep

private class HistoryBranchRowStep(val row: HistoryBranchRow) : HistoryStep

private class HistoryTurnStep(
    val turn: HistoryTurnBuilder,
    val depth: Int,
    val collapseBranchId: String?,
    val showTurnIndex: Boolean,
) : HistoryStep {
    fun toRow(
        filter: HistoryTreeFilter,
        expandedDetails: Set<String>,
        selectedNodeId: String?,
    ): HistoryTurnRow? {
        val user = turn.user?.takeIf { it.keeps(filter) }?.toNode()
        val replies = turn.replies.filter { it.keeps(filter) }.map(HistoryEntry::toNode)
        val details = turn.details.filter { it.keeps(filter) }.map(HistoryEntry::toNode)
        // 只有设置项、没有可见对话的轮次是噪音：除「全部」档外一律不占行。
        val showDetails = details.isNotEmpty() && filter == HistoryTreeFilter.ALL
        if (user == null && replies.isEmpty() && !showDetails) return null
        val detailsKey = turn.key()
        return HistoryTurnRow(
            user = user,
            replies = replies,
            details = details,
            detailsKey = detailsKey,
            detailsExpanded = details.isNotEmpty() &&
                (filter == HistoryTreeFilter.ALL || detailsKey in expandedDetails),
            collapseBranchId = collapseBranchId,
            showTurnIndex = showTurnIndex,
            turnIndex = turn.index,
            selectedNodeId = selectedNodeId,
            depth = depth,
        )
    }
}

private class HistoryEntry(val option: RuntimeSlashCommandOption) {
    val children = mutableListOf<HistoryEntry>()
    var nodeCount = 1
    var turnCount = 0
    var firstUserTitle: String? = null

    /** 子树里非细节节点的数量：用来判断一条旁支是不是"另一种走法"。 */
    var visibleCount = 0
    var firstVisibleTitle: String? = null

    val id: String get() = option.value
    val title: String get() = option.label
    val bookmark: String? get() = option.tree?.label
    val isCurrent: Boolean get() = option.tree?.isCurrent == true
    val onActivePath: Boolean get() = option.tree?.isOnActivePath == true
    val kind: HistoryNodeKind = historyNodeKind(option)
    val detail: Boolean = historyEntryIsDetail(option, kind)
    val searchable: String = buildString {
        append(option.value).append(' ')
        append(option.label).append(' ')
        option.description?.let { append(it).append(' ') }
        option.tree?.label?.let { append(it).append(' ') }
        append(kind.label)
    }.lowercase()

    fun action(): HistoryNodeAction? = when {
        isCurrent -> null
        kind == HistoryNodeKind.User -> HistoryNodeAction.EditAndRestart
        kind == HistoryNodeKind.Assistant -> HistoryNodeAction.ContinueFromHere
        else -> null
    }
}

private fun historyNodeKind(option: RuntimeSlashCommandOption): HistoryNodeKind = when (option.tree?.role) {
    "user" -> HistoryNodeKind.User
    "assistant" -> HistoryNodeKind.Assistant
    "toolResult", "bashExecution" -> HistoryNodeKind.Tool
    else -> HistoryNodeKind.System
}

/**
 * 工具调用与设置项（模型、思考级别、标签等）默认收进细节；上下文压缩与分支摘要是
 * 对话级事件，留在节点行上。当前位置永远要有节点行——它是用户要看的锚点。
 */
private fun historyEntryIsDetail(option: RuntimeSlashCommandOption, kind: HistoryNodeKind): Boolean {
    if (option.tree?.isCurrent == true) return false
    return when (kind) {
        HistoryNodeKind.User -> false
        HistoryNodeKind.Assistant -> option.tree?.defaultHidden == true
        HistoryNodeKind.Tool -> true
        HistoryNodeKind.System -> option.tree?.entryType?.let { it in VISIBLE_SYSTEM_ENTRY_TYPES } != true
    }
}

private val VISIBLE_SYSTEM_ENTRY_TYPES = setOf("compaction", "branch_summary", "custom_message")

private fun buildHistoryForest(options: List<RuntimeSlashCommandOption>): List<HistoryEntry> {
    val byId = HashMap<String, HistoryEntry>(options.size)
    for (option in options) byId.putIfAbsent(option.value, HistoryEntry(option))
    val roots = mutableListOf<HistoryEntry>()
    for (option in options) {
        val entry = byId[option.value] ?: continue
        // 自指或指向表外节点的都当根，避免把一条坏链变成环。
        val parentId = option.tree?.parentId
        val parent = parentId?.takeIf { it != option.value }?.let(byId::get)
        if (parent == null) roots += entry else parent.children += entry
    }
    return roots
}

/** 自底向上统计子树规模：分支摘要要说"几轮对话"，得先知道子树里有多少条用户消息。 */
private fun computeHistoryStats(roots: List<HistoryEntry>) {
    val pending = ArrayDeque<Pair<HistoryEntry, Boolean>>()
    val seen = HashSet<HistoryEntry>()
    roots.forEach { pending.addLast(it to false) }
    while (pending.isNotEmpty()) {
        val (entry, aggregated) = pending.removeLast()
        if (!aggregated) {
            if (!seen.add(entry)) continue
            pending.addLast(entry to true)
            entry.children.forEach { pending.addLast(it to false) }
            continue
        }
        var nodes = 1
        var turns = if (entry.kind == HistoryNodeKind.User) 1 else 0
        var title = if (entry.kind == HistoryNodeKind.User) entry.title else null
        var visible = if (entry.detail) 0 else 1
        var visibleTitle = entry.title.takeIf { !entry.detail }
        for (child in entry.children) {
            nodes += child.nodeCount
            turns += child.turnCount
            visible += child.visibleCount
            if (title == null) title = child.firstUserTitle
            if (visibleTitle == null) visibleTitle = child.firstVisibleTitle
        }
        entry.nodeCount = nodes
        entry.turnCount = turns
        entry.visibleCount = visible
        entry.firstUserTitle = title
        entry.firstVisibleTitle = visibleTitle
    }
}

/** 选中节点的祖先链：用来把藏住选中位置的分支强制展开。 */
private fun historyAncestorIds(options: List<RuntimeSlashCommandOption>, nodeId: String?): Set<String> {
    if (nodeId == null) return emptySet()
    val parentById = HashMap<String, String?>(options.size)
    for (option in options) parentById[option.value] = option.tree?.parentId
    if (nodeId !in parentById) return emptySet()
    val ancestors = HashSet<String>()
    var current = parentById[nodeId]
    while (current != null && ancestors.add(current)) {
        current = parentById[current]
    }
    return ancestors
}

/** 节点在本地缓存里的原文；「编辑这条消息并重新开始」在运行时没回传原文时用它兜底。 */
internal fun SessionGraph.historyNodeText(nodeId: String): String? =
    entries[nodeId]
        ?.let { entry -> projectSessionEntries(listOf(entry)).firstOrNull() }
        ?.content
        ?.mapNotNull { it.text }
        ?.joinToString("\n")
        ?.trim()
        ?.takeIf(String::isNotEmpty)

/**
 * `/tree` 成功执行时后端回传的原文。只有落到用户消息才有：两边都会把历史回退到那条消息
 * 之前，并把它的正文交回来，手机据此回填输入框（Pi 走 `navigateTree`，codex 走
 * `thread/revert`）。
 */
internal fun historyEditorText(result: JsonElement?): String? =
    ((result as? JsonObject)?.get("editorText") as? JsonPrimitive)
        ?.contentOrNull
        ?.takeIf(String::isNotBlank)

/** 历史树页面唯一会改动电脑端会话的两个动作。 */
internal sealed interface HistoryTreeAction {
    val nodeId: String

    /** 落到助手回复：分支停在这条回复之后，接着往下聊。 */
    data class ContinueFrom(override val nodeId: String) : HistoryTreeAction

    /**
     * 落到用户消息：分支移到它的父节点，原文回到输入框，用户改完重发就是新分支。
     * [fallbackText] 是本地缓存里的原文；运行时回传的 editorText 优先。
     */
    data class EditAndRestart(override val nodeId: String, val fallbackText: String?) : HistoryTreeAction
}
