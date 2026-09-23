package dev.pi.remote

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.AccountTree
import androidx.compose.material.icons.rounded.Folder
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

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
        branch?.commit != null -> "HEAD · ${branch.commit}（分离）"
        branch?.loaded == true -> "未获取到 Git 分支"
        else -> "分支信息待同步"
    }
    Column(modifier, verticalArrangement = Arrangement.spacedBy(3.dp)) {
        LocationFact(Icons.Rounded.Folder, "运行目录", path?.takeIf(String::isNotBlank) ?: "运行路径待同步")
        LocationFact(Icons.Rounded.AccountTree, "当前 Git 工作分支", branchLabel)
    }
}

@Composable
private fun LocationFact(icon: ImageVector, description: String, text: String) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Icon(icon, contentDescription = description, modifier = Modifier.size(14.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(text, modifier = Modifier.weight(1f), style = MaterialTheme.typography.labelSmall,
            fontFamily = FontFamily.Monospace, color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}
