package com.orbising.orbis

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

/** One visible row of the subagent tree; [rails] marks ancestor branches that continue past this row. */
internal data class BackgroundTaskTreeRow(
    val task: BackgroundTask,
    val depth: Int,
    val rails: List<Boolean>,
    val last: Boolean,
    val hasChildren: Boolean,
)

/**
 * S59 / SC107: Host order is kept among siblings. A parent missing from a partial inventory, a
 * self-reference or a cycle never hides a task — unreached tasks start their own branch. Indent
 * stops at [maxDepth]; deeper tasks stay listed under the deepest shown level.
 */
/**
 * S60 / SC108: agent branches first — a command an agent started stays under it — then the
 * session's own commands. Split by each root's kind, so the tree order inside a branch is kept.
 */
internal fun BackgroundTaskInventory.groupedRows(): Pair<List<BackgroundTaskTreeRow>, List<BackgroundTaskTreeRow>> {
    val agents = ArrayList<BackgroundTaskTreeRow>()
    val commands = ArrayList<BackgroundTaskTreeRow>()
    var target = agents
    for (row in treeRows()) {
        if (row.depth == 0) target = if (row.task.isCommand) commands else agents
        target += row
    }
    return agents to commands
}

internal fun BackgroundTaskInventory.treeRows(maxDepth: Int = 3): List<BackgroundTaskTreeRow> {
    val known = items.mapTo(HashSet()) { it.id }
    val children = items.filter { it.parentId != null && it.parentId != it.id && it.parentId in known }.groupBy { it.parentId }
    val seen = HashSet<String>()
    val rows = ArrayList<BackgroundTaskTreeRow>(items.size)
    fun visit(task: BackgroundTask, depth: Int, rails: List<Boolean>, last: Boolean) {
        if (!seen.add(task.id)) return
        val kids = children[task.id].orEmpty().filter { it.id !in seen }
        val nested = depth < maxDepth
        // Past the cap, children continue this row's branch, so the branch ends at the last of them instead.
        rows += BackgroundTaskTreeRow(task, depth, rails, last && (nested || kids.isEmpty()), nested && kids.isNotEmpty())
        val kidDepth = if (nested) depth + 1 else depth
        val kidRails = if (!nested) rails else if (depth == 0) emptyList() else rails + !last
        kids.forEachIndexed { index, kid -> visit(kid, kidDepth, kidRails, index == kids.lastIndex && (nested || last)) }
    }
    items.filter { it.parentId == null || it.parentId == it.id || it.parentId !in known }.forEach { visit(it, 0, emptyList(), true) }
    items.forEach { visit(it, 0, emptyList(), true) }
    return rows
}

private val TaskWorking = setOf("pending", "running")
private val HeaderInset = 8.dp
private val WellInset = 12.dp
private val TaskIndent = 16.dp
private val DotCenter = 5.dp

internal enum class TaskDotTone { Working, Failed, Quiet }
internal data class TaskDotStyle(val tone: TaskDotTone, val pulsing: Boolean = false, val hollow: Boolean = false)

/**
 * S59 / SC107: liveness follows [RuntimeSummary.presentationStatus] — once an inventory is unconfirmed the
 * summary shows no work (only a partial list with known activity stays live), and a withdrawn snapshot
 * (`unknown`, not partial) shows every last-known row without liveness.
 */
internal val BackgroundTaskInventory.summaryDot: TaskDotStyle get() = when {
    !confirmed && !(truncated && activeCount > 0) -> TaskDotStyle(TaskDotTone.Quiet, hollow = true)
    // S60 / SC108: a running command is live but static; only agents pulse.
    activeCount > 0 -> TaskDotStyle(TaskDotTone.Working, pulsing = items.any { it.status in TaskWorking && !it.isCommand })
    items.any { it.status == "failed" } -> TaskDotStyle(TaskDotTone.Failed)
    else -> TaskDotStyle(TaskDotTone.Quiet)
}

internal fun BackgroundTaskInventory.dotFor(task: BackgroundTask): TaskDotStyle = when {
    availability != "ready" && !truncated -> TaskDotStyle(TaskDotTone.Quiet, hollow = true)
    task.status in TaskWorking -> TaskDotStyle(TaskDotTone.Working, pulsing = !task.isCommand)
    task.status == "waiting" -> TaskDotStyle(TaskDotTone.Working)
    task.status == "failed" -> TaskDotStyle(TaskDotTone.Failed)
    task.status == "completed" -> TaskDotStyle(TaskDotTone.Quiet)
    else -> TaskDotStyle(TaskDotTone.Quiet, hollow = true)
}

@Composable
private fun TaskDotTone.tint(): Color = when (this) {
    TaskDotTone.Working -> LocalOrbisPalette.current.success
    TaskDotTone.Failed -> MaterialTheme.colorScheme.error
    TaskDotTone.Quiet -> LocalOrbisPalette.current.faint
}

@Composable
private fun TaskDot(style: TaskDotStyle) = NeumorphStatusDot(style.tone.tint(), pulsing = style.pulsing, idle = style.hollow)

/**
 * The native task list does not own the main turn's input or stop controls. S59 / SC107: a quiet
 * disclosure line on the composer face; details sit in a recessed well as a parent → child tree.
 */
@Composable
internal fun BackgroundTasksPanel(tasks: BackgroundTaskInventory) {
    var expanded by remember { mutableStateOf(false) }
    val groups = remember(tasks.items) { tasks.groupedRows() }
    val rotation by animateFloatAsState(if (expanded) 90f else 0f,
        tween(InteractionMotion.duration(InteractionMotion.Collapse)), label = "background-tasks-disclosure")
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Column(Modifier.fillMaxWidth().padding(horizontal = RemoteUi.PagePadding - HeaderInset)) {
        NeumorphSurface(
            Modifier.fillMaxWidth().testTag("background-tasks-toggle")
                .semantics { stateDescription = if (expanded) L10n.tr("已展开") else L10n.tr("已收起") },
            shape = RoundedCornerShape(12.dp), shadowScale = 0.4f, flat = true, onClick = { expanded = !expanded },
        ) {
            Row(Modifier.fillMaxWidth().heightIn(min = RemoteUi.TouchTarget).padding(horizontal = HeaderInset),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TaskDot(tasks.summaryDot)
                Text(tasks.panelTitle, Modifier.weight(1f), style = MaterialTheme.typography.labelMedium, color = muted,
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
                Icon(OrbisSymbols.ChevronRight, null, Modifier.size(16.dp).rotate(rotation), tint = muted)
            }
        }
        OrbisCollapse(expanded = expanded) {
            NeumorphSurface(Modifier.fillMaxWidth().padding(start = HeaderInset, end = HeaderInset, bottom = 8.dp),
                shape = RemoteUi.ControlShape, style = NeumorphStyle.Pressed) {
                LazyColumn(Modifier.fillMaxWidth().heightIn(max = 168.dp), contentPadding = PaddingValues(vertical = 6.dp)) {
                    tasks.inventoryNotice?.let { notice ->
                        item(key = "notice") {
                            Text(notice, Modifier.padding(horizontal = WellInset, vertical = 4.dp),
                                style = MaterialTheme.typography.labelSmall, color = muted)
                        }
                    }
                    // Section names only when both kinds are present; the title already names a single kind.
                    val labelled = groups.first.isNotEmpty() && groups.second.isNotEmpty()
                    if (labelled) item(key = "section:agents") { BackgroundTaskSection(L10n.tr("子代理")) }
                    items(groups.first, key = { "task:${it.task.id}" }) { BackgroundTaskRow(it, tasks.dotFor(it.task)) }
                    if (labelled) item(key = "section:commands") { BackgroundTaskSection(L10n.tr("后台命令")) }
                    items(groups.second, key = { "task:${it.task.id}" }) { BackgroundTaskRow(it, tasks.dotFor(it.task)) }
                }
            }
        }
    }
}

@Composable
private fun BackgroundTaskSection(title: String) {
    Text(title, Modifier.padding(start = WellInset, end = WellInset, top = 6.dp, bottom = 2.dp),
        style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

@Composable
private fun BackgroundTaskRow(row: BackgroundTaskTreeRow, dot: TaskDotStyle) {
    val task = row.task
    val hairline = MaterialTheme.colorScheme.outlineVariant
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val title = task.displayTitle
    Row(
        Modifier.fillMaxWidth().testTag("background-task-${task.id}").semantics(mergeDescendants = true) {}
            .drawBehind {
                val stroke = 1.dp.toPx()
                val mid = size.height / 2
                fun x(level: Int) = (WellInset + TaskIndent * level + DotCenter).toPx()
                row.rails.forEachIndexed { level, continues ->
                    if (continues) drawLine(hairline, Offset(x(level), 0f), Offset(x(level), size.height), stroke)
                }
                if (row.depth > 0) {
                    val branch = x(row.depth - 1)
                    drawLine(hairline, Offset(branch, 0f), Offset(branch, if (row.last) mid else size.height), stroke)
                    drawLine(hairline, Offset(branch, mid), Offset((WellInset + TaskIndent * row.depth).toPx(), mid), stroke)
                }
                if (row.hasChildren) {
                    val own = x(row.depth)
                    drawLine(hairline, Offset(own, mid + DotCenter.toPx()), Offset(own, size.height), stroke)
                }
            }
            .padding(start = WellInset + TaskIndent * row.depth, end = WellInset)
            .heightIn(min = 32.dp).padding(vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        TaskDot(dot)
        Text(title, Modifier.weight(1f), style = MaterialTheme.typography.labelMedium,
            color = if (dot.tone == TaskDotTone.Quiet) muted else MaterialTheme.colorScheme.onSurface,
            maxLines = 1, overflow = TextOverflow.Ellipsis)
        // Unweighted, so the title ellipsizes first; the cap only guards the 48-character kind limit.
        if (task.showsKind) {
            Text(task.kindTitle, Modifier.widthIn(max = 136.dp), style = MaterialTheme.typography.labelSmall,
                color = muted.copy(alpha = 0.72f), maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Text(task.statusTitle, style = MaterialTheme.typography.labelSmall, maxLines = 1, color = when {
            dot.pulsing -> LocalOrbisPalette.current.success
            dot.tone == TaskDotTone.Failed -> MaterialTheme.colorScheme.error
            else -> muted
        })
    }
}
