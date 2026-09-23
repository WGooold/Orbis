package dev.pi.remote

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.CheckBox
import androidx.compose.material.icons.rounded.CheckBoxOutlineBlank
import androidx.compose.material.icons.rounded.ContentCopy
import androidx.compose.material.icons.rounded.Download
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.LinkInteractionListener
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import org.commonmark.ext.gfm.tables.TableBlock
import org.commonmark.ext.gfm.tables.TableCell
import org.commonmark.ext.task.list.items.TaskListItemMarker
import org.commonmark.node.BlockQuote
import org.commonmark.node.BulletList
import org.commonmark.node.FencedCodeBlock
import org.commonmark.node.Heading
import org.commonmark.node.HtmlBlock
import org.commonmark.node.Image
import org.commonmark.node.IndentedCodeBlock
import org.commonmark.node.ListBlock
import org.commonmark.node.ListItem
import org.commonmark.node.Node
import org.commonmark.node.OrderedList
import org.commonmark.node.Paragraph
import org.commonmark.node.ThematicBreak

@Composable
internal fun MarkdownText(markdown: String, downloadFile: (String) -> Unit) {
    val blocks = remember(markdown) { parseMarkdown(markdown) }
    val downloadPaths = remember(blocks) { markdownDownloadPaths(blocks) }
    val uriHandler = LocalUriHandler.current
    val currentDownload = rememberUpdatedState(downloadFile)
    val currentUriHandler = rememberUpdatedState(uriHandler)
    val listener = remember {
        LinkInteractionListener { link ->
            val target = (link as? LinkAnnotation.Clickable)?.tag ?: return@LinkInteractionListener
            if (markdownFileLinkPath(target) != null) {
                currentDownload.value(target)
            } else if (markdownExternalLinkUrl(target) != null) {
                // A device may have no handler for mailto (or even web URLs).
                runCatching { currentUriHandler.value.openUri(target) }
            }
        }
    }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        MarkdownBlocks(blocks, listener)
        downloadPaths.forEach { path ->
            NeumorphSurface(
                onClick = { downloadFile(path) },
                modifier = Modifier.heightIn(min = RemoteUi.TouchTarget),
                shape = RemoteUi.ControlShape,
                shadowScale = 0.45f,
            ) {
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Icon(Icons.Rounded.Download, contentDescription = null, modifier = Modifier.size(15.dp))
                    Text(path, style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
    }
}

@Composable
private fun MarkdownBlocks(
    nodes: List<Node>,
    listener: LinkInteractionListener,
    spacing: Dp = 8.dp,
) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(spacing)) {
        nodes.forEach { node ->
            when (node) {
                is Paragraph -> MarkdownParagraph(node, listener)
                is Heading -> MarkdownParagraph(node, listener, style = when (node.level) {
                    1 -> MaterialTheme.typography.headlineSmall
                    2 -> MaterialTheme.typography.titleLarge
                    3 -> MaterialTheme.typography.titleMedium
                    else -> MaterialTheme.typography.titleSmall
                })
                is BulletList -> MarkdownList(node, listener)
                is OrderedList -> MarkdownList(node, listener)
                is BlockQuote -> {
                    val stripe = MaterialTheme.colorScheme.outline
                    NeumorphSurface(Modifier.fillMaxWidth(), shape = RemoteUi.ControlShape, style = NeumorphStyle.Pressed, shadowScale = 0.4f) {
                        Column(
                            Modifier.padding(12.dp)
                                .drawBehind { drawLine(stripe, Offset.Zero, Offset(0f, size.height), 3.dp.toPx()) }
                                .padding(start = 12.dp),
                        ) {
                            MarkdownBlocks(markdownChildren(node), listener)
                        }
                    }
                }
                is FencedCodeBlock -> MarkdownCode(node.literal.removeSuffix("\n"), node.info)
                is IndentedCodeBlock -> MarkdownCode(node.literal.removeSuffix("\n"))
                is HtmlBlock -> MarkdownCode(node.literal.removeSuffix("\n"), "html")
                is ThematicBreak -> HorizontalDivider()
                is TableBlock -> MarkdownTable(node, listener)
                is TaskListItemMarker -> Unit
                else -> if (node.firstChild != null) MarkdownBlocks(markdownChildren(node), listener)
            }
        }
    }
}

@Composable
private fun MarkdownInline(
    node: Node,
    listener: LinkInteractionListener,
    modifier: Modifier = Modifier,
    style: TextStyle = MaterialTheme.typography.bodyMedium,
    textAlign: TextAlign = TextAlign.Start,
) {
    val linkColor = MaterialTheme.colorScheme.primary
    val text = remember(node, listener, linkColor) { renderMarkdownInline(node, listener, linkColor) }
    Text(text, modifier = modifier, style = style, textAlign = textAlign)
}

@Composable
private fun MarkdownParagraph(
    node: Node,
    listener: LinkInteractionListener,
    style: TextStyle = MaterialTheme.typography.bodyMedium,
) {
    SelectionContainer {
        MarkdownInline(node, listener, Modifier.fillMaxWidth(), style)
    }
    MarkdownImages(node, listener)
}

@Composable
private fun MarkdownImages(node: Node, listener: LinkInteractionListener) {
    val images = remember(node) {
        markdownDescendants(markdownChildren(node)).filterIsInstance<Image>()
            .filter { markdownHttpLinkUrl(it.destination) != null }.toList()
    }
    images.forEach { image ->
        val description = remember(image) { renderMarkdownInline(image).text }
        var failed by remember(image.destination) { mutableStateOf(false) }
        // AsyncImage can participate in table-cell intrinsic sizing; SubcomposeAsyncImage cannot.
        NeumorphSurface(
            modifier = Modifier.fillMaxWidth(),
            shape = RemoteUi.ControlShape,
            style = NeumorphStyle.Pressed,
            shadowScale = 0.4f,
            onClick = { listener.onClick(LinkAnnotation.Clickable(image.destination, linkInteractionListener = listener)) },
        ) {
            AsyncImage(
                model = image.destination,
                contentDescription = description,
                modifier = Modifier.fillMaxWidth().heightIn(min = 80.dp, max = 360.dp).padding(8.dp),
                contentScale = ContentScale.Fit,
                onError = { failed = true },
                onSuccess = { failed = false },
            )
        }
        if (failed) Text("图片无法加载，点击链接查看", style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
private fun MarkdownList(list: ListBlock, listener: LinkInteractionListener) {
    val items = remember(list) { markdownChildren(list).filterIsInstance<ListItem>() }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(if (list.isTight) 3.dp else 8.dp)) {
        items.forEachIndexed { index, item ->
            val children = remember(item) { markdownChildren(item) }
            val task = children.filterIsInstance<TaskListItemMarker>().firstOrNull()
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                if (task != null) {
                    // A task marker reports the message's state; it is not a locally editable checkbox.
                    Icon(
                        if (task.isChecked) Icons.Rounded.CheckBox else Icons.Rounded.CheckBoxOutlineBlank,
                        contentDescription = if (task.isChecked) "已完成" else "未完成",
                        modifier = Modifier.size(20.dp),
                        tint = MaterialTheme.colorScheme.primary,
                    )
                } else {
                    val marker = if (list is OrderedList) "${(list.markerStartNumber ?: 1) + index}." else "•"
                    Text(marker, modifier = Modifier.widthIn(min = 20.dp), style = MaterialTheme.typography.bodyMedium)
                }
                Column(Modifier.weight(1f)) {
                    MarkdownBlocks(children.filterNot { it is TaskListItemMarker }, listener, if (list.isTight) 3.dp else 8.dp)
                }
            }
        }
    }
}

@Composable
private fun MarkdownCode(code: String, info: String = "") {
    val clipboard = LocalClipboardManager.current
    NeumorphSurface(shape = RemoteUi.ControlShape, style = NeumorphStyle.Pressed) {
        Column(Modifier.fillMaxWidth()) {
            Row(Modifier.fillMaxWidth().padding(start = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(info.substringBefore(' ').ifBlank { "代码" }, Modifier.weight(1f), style = MaterialTheme.typography.labelSmall)
                NeumorphIconButton(
                    onClick = { clipboard.setText(AnnotatedString(code)) },
                    icon = Icons.Rounded.ContentCopy,
                    contentDescription = "复制代码",
                    size = 32.dp,
                )
            }
            // Keep scrolling outside selection so selecting text doesn't swallow horizontal drags.
            Box(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(10.dp)) {
                SelectionContainer {
                    Text(code, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }
}

@Composable
private fun MarkdownTable(table: TableBlock, listener: LinkInteractionListener) {
    val rows = remember(table) { markdownTableRows(table) }
    val columns = rows.firstOrNull()?.size ?: return
    if (columns == 0) return
    NeumorphSurface(Modifier.fillMaxWidth(), shape = RemoteUi.ControlShape, style = NeumorphStyle.Pressed, shadowScale = 0.4f) {
    BoxWithConstraints(Modifier.fillMaxWidth().padding(6.dp)) {
        // Columns keep a shared width across rows. Wide tables scroll instead of being squeezed
        // into unreadable cells; long cell content wraps without truncation.
        val cellWidth = (maxWidth / columns).coerceIn(120.dp, 260.dp)
        Box(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())) {
            SelectionContainer {
                Column {
                    rows.forEach { cells ->
                        Row(Modifier.height(IntrinsicSize.Min)) {
                            cells.forEach { cell ->
                                Column(
                                    Modifier.width(cellWidth).fillMaxHeight()
                                        .background(if (cell.isHeader) MaterialTheme.colorScheme.surfaceVariant else MaterialTheme.colorScheme.surface)
                                        .border(0.5.dp, MaterialTheme.colorScheme.outlineVariant)
                                        .padding(10.dp),
                                ) {
                                    MarkdownInline(
                                        cell, listener, Modifier.fillMaxWidth(),
                                        style = MaterialTheme.typography.bodyMedium.let {
                                            if (cell.isHeader) it.copy(fontWeight = FontWeight.Bold) else it
                                        },
                                        textAlign = when (cell.alignment) {
                                            TableCell.Alignment.CENTER -> TextAlign.Center
                                            TableCell.Alignment.RIGHT -> TextAlign.End
                                            else -> TextAlign.Start
                                        },
                                    )
                                    MarkdownImages(cell, listener)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    }
}
