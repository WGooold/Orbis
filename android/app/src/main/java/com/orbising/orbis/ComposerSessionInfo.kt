package com.orbising.orbis

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.AccountTree
import androidx.compose.material.icons.rounded.Folder
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import java.text.BreakIterator
import java.util.Locale

/** Stable session facts share one quiet header immediately above the message composer. */
@Composable
internal fun ComposerSessionInfo(
    path: String?,
    branch: WorkingBranch?,
    permissions: @Composable () -> Unit,
) {
    // Keep the composition stable when the window/font size changes so an open permissions sheet
    // and its pending application survive switching between side-by-side and stacked placement.
    Layout(
        modifier = Modifier.fillMaxWidth().padding(start = RemoteUi.PagePadding, end = 8.dp, top = 4.dp),
        content = {
            ComposerLocation(path, branch)
            Box { permissions() }
        },
    ) { measurables, constraints ->
        val stacked = constraints.maxWidth < 300.dp.roundToPx() || fontScale > 1.3f
        val permission = measurables[1].measure(constraints.copy(
            minWidth = 0, minHeight = 0,
            maxWidth = if (stacked) constraints.maxWidth else (constraints.maxWidth * 0.48f).toInt(),
        ))
        val locationWidth = if (stacked) constraints.maxWidth else
            (constraints.maxWidth - permission.width - 12.dp.roundToPx()).coerceAtLeast(0)
        val location = measurables[0].measure(constraints.copy(
            minWidth = locationWidth, maxWidth = locationWidth, minHeight = 0,
        ))
        val height = if (stacked) location.height + permission.height else maxOf(location.height, permission.height)
        layout(constraints.maxWidth, height) {
            location.placeRelative(0, if (stacked) 0 else (height - location.height) / 2)
            permission.placeRelative(constraints.maxWidth - permission.width,
                if (stacked) location.height else (height - permission.height) / 2)
        }
    }
}

@Composable
private fun ComposerLocation(path: String?, branch: WorkingBranch?, modifier: Modifier = Modifier) {
    val branchLabel = when {
        branch?.branch != null -> branch.branch
        branch?.commit != null -> "HEAD，${branch.commit}（分离）"
        branch?.loaded == true -> "未获取到 Git 分支"
        else -> "分支信息待同步"
    }
    // A long branch can use at most half the line; the directory must keep a readable tail.
    BoxWithConstraints(modifier) {
        val branchWidth = maxWidth / 2
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            LocationFact(Icons.Rounded.Folder, "运行目录", path?.takeIf(String::isNotBlank) ?: "运行路径待同步",
                Modifier.weight(1f, fill = false), middleEllipsis = true)
            LocationFact(Icons.Rounded.AccountTree, "当前 Git 工作分支", branchLabel, Modifier.widthIn(max = branchWidth))
        }
    }
}

@Composable
private fun LocationFact(icon: ImageVector, description: String, text: String, modifier: Modifier = Modifier,
    middleEllipsis: Boolean = false) {
    Row(modifier, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Icon(icon, contentDescription = description, modifier = Modifier.size(14.dp).orbisIconBaseline(MaterialTheme.typography.labelSmall.fontSize), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        val style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace)
        if (!middleEllipsis) {
            Text(text, modifier = Modifier.weight(1f, fill = false), style = style, color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1, overflow = TextOverflow.Ellipsis)
        } else BoxWithConstraints(Modifier.weight(1f, fill = false)) {
            // A path keeps both ends (as iOS): the folder name at the end is the part that tells sessions apart.
            val measurer = rememberTextMeasurer()
            val width = constraints.maxWidth
            val shown = remember(text, width, style, measurer) {
                middleEllipsized(text, width) { measurer.measure(it, style, maxLines = 1).size.width }
            }
            Text(shown, style = style, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Clip,
                modifier = Modifier.semantics { contentDescription = text })
        }
    }
}

/** Longest `head…tail` of [text] that fits in [maxWidth]; the tail keeps slightly more than the head. */
internal fun middleEllipsized(text: String, maxWidth: Int, width: (String) -> Int): String {
    if (maxWidth <= 0) return ""
    if (width(text) <= maxWidth) return text
    if (width("…") > maxWidth) return ""
    val breaks = BreakIterator.getCharacterInstance(Locale.ROOT).apply { setText(text) }
    val boundaries = mutableListOf(0)
    var next = breaks.next()
    while (next != BreakIterator.DONE) {
        boundaries += next
        next = breaks.next()
    }
    val count = boundaries.size - 1
    var low = 0
    var high = count - 1
    var best = "…"
    while (low <= high) {
        val keep = (low + high) / 2
        val tail = (keep + 1) / 2
        val candidate = text.substring(0, boundaries[keep - tail]) + "…" + text.substring(boundaries[count - tail])
        if (width(candidate) <= maxWidth) { best = candidate; low = keep + 1 } else high = keep - 1
    }
    return best
}
