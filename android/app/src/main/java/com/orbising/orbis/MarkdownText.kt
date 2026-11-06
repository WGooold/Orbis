package com.orbising.orbis

import androidx.compose.foundation.background
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
import androidx.compose.material3.HorizontalDivider
import com.orbising.orbis.OrbisActionIcon as Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.snapshotFlow
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
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.LinkInteractionListener
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import kotlinx.coroutines.flow.conflate
import kotlinx.coroutines.flow.collect
import java.util.concurrent.atomic.AtomicLong
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

internal val LocalMessageTextSelectionEnabled = androidx.compose.runtime.staticCompositionLocalOf { true }

@Composable
private fun MessageTextSelection(content: @Composable () -> Unit) {
    if (LocalMessageTextSelectionEnabled.current) SelectionContainer(content = content)
    else content()
}

private data class MarkdownParseRequest(val text: String, val revision: Long)
private data class DisplayedMarkdown(val document: PreparedMarkdown, val revision: Long)

/** Keep the displayed document while its replacement is prepared off the UI thread. */
@Composable
internal fun rememberMarkdownDocument(
    markdown: String,
    cached: PreparedMarkdown?,
    prepare: suspend (String) -> PreparedMarkdown,
): PreparedMarkdown? {
    val revisions = remember { AtomicLong() }
    val request = remember(markdown) { MarkdownParseRequest(markdown, revisions.getAndIncrement()) }
    var displayed by remember { mutableStateOf<DisplayedMarkdown?>(null) }
    val prepared = cached ?: displayed?.document
    // A cache hit can be displayed before the collector finishes its previous parse. Retain
    // that committed body too, so the next cache miss cannot roll the visible text backwards.
    SideEffect {
        if (cached != null && (displayed?.document !== cached || displayed?.revision != request.revision))
            displayed = DisplayedMarkdown(cached, request.revision)
    }
    val current by rememberUpdatedState(request)
    val currentPrepare by rememberUpdatedState(prepare)
    LaunchedEffect(Unit) {
        snapshotFlow { current }.conflate().collect { input ->
            val resolved = currentPrepare(input.text)
            // Intermediate results can advance a slower stream, but cannot replace a newer
            // version already painted via the cache. Rewrites remain ordered by request too.
            if (input.revision >= (displayed?.revision ?: -1L))
                displayed = DisplayedMarkdown(resolved, input.revision)
        }
    }
    return prepared
}

@Composable
internal fun MarkdownText(markdown: String, downloadFile: (String) -> Unit) {
    val prepared = rememberMarkdownDocument(markdown, markdownDocuments.peek(markdown), markdownDocuments::resolve)
    val blocks = prepared?.blocks.orEmpty()
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
    // One reveal timeline for the whole body, so streamed blocks appear strictly in order (M04).
    val cursor = rememberRevealCursor(LocalStreamingText.current && android.animation.ValueAnimator.areAnimatorsEnabled())
    CompositionLocalProvider(LocalPreparedMarkdown provides prepared, LocalRevealCursor provides cursor, LocalRevealPath provides emptyList()) {
        MarkdownBlocks(blocks, listener)
    }
}

private val LocalPreparedMarkdown = androidx.compose.runtime.staticCompositionLocalOf<PreparedMarkdown?> { null }

@Composable
private fun MarkdownBlocks(
    nodes: List<Node>,
    listener: LinkInteractionListener,
    spacing: Dp = 8.dp,
) {
    val parent = LocalRevealPath.current
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(spacing)) {
        nodes.forEachIndexed { index, node ->
            CompositionLocalProvider(LocalRevealPath provides parent + index) {
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
                    NeumorphSurface(Modifier.fillMaxWidth(), shape = RemoteUi.ControlShape, style = NeumorphStyle.Pressed, shadowScale = 0.4f, contentInset = 12.dp) {
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
    val document = LocalPreparedMarkdown.current
    val text = remember(node, document, listener, linkColor) {
        document?.inline?.get(node)?.let { bindMarkdownInline(it, listener, linkColor) } ?: AnnotatedString("")
    }
    StreamingMarkdownText(text, modifier = modifier, style = style, textAlign = textAlign)
}

@Composable
private fun MarkdownParagraph(
    node: Node,
    listener: LinkInteractionListener,
    style: TextStyle = MaterialTheme.typography.bodyMedium,
) {
    MessageTextSelection {
        MarkdownInline(node, listener, Modifier.fillMaxWidth(), style)
    }
    MarkdownImages(node, listener)
}

@Composable
private fun MarkdownImages(node: Node, listener: LinkInteractionListener) {
    val prepared = LocalPreparedMarkdown.current
    val images = remember(node, prepared) {
        markdownDescendants(markdownChildren(node)).filterIsInstance<Image>()
            .filter { markdownHttpLinkUrl(it.destination) != null }.toList()
    }
    images.forEach { image ->
        val description = remember(image, prepared) { prepared?.inline?.get(image)?.text.orEmpty() }
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
        Text(if (failed) L10n.tr("图片无法加载") else "", Modifier.height(20.dp), style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
private fun MarkdownList(list: ListBlock, listener: LinkInteractionListener) {
    val items = remember(list) { markdownChildren(list).filterIsInstance<ListItem>() }
    val parent = LocalRevealPath.current
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(if (list.isTight) 3.dp else 8.dp)) {
        items.forEachIndexed { index, item ->
            val children = remember(item) { markdownChildren(item) }
            val task = children.filterIsInstance<TaskListItemMarker>().firstOrNull()
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                if (task != null) {
                    // A task marker reports the message's state; it is not a locally editable checkbox.
                    Icon(
                        if (task.isChecked) Icons.Rounded.CheckBox else Icons.Rounded.CheckBoxOutlineBlank,
                        contentDescription = if (task.isChecked) L10n.tr("已完成") else L10n.tr("未完成"),
                        modifier = Modifier.size(20.dp),
                        tint = MaterialTheme.colorScheme.primary,
                    )
                } else {
                    val marker = if (list is OrderedList) "${(list.markerStartNumber ?: 1) + index}." else "•"
                    Text(marker, modifier = Modifier.widthIn(min = 20.dp), style = MaterialTheme.typography.bodyMedium)
                }
                Column(Modifier.weight(1f)) {
                    CompositionLocalProvider(LocalRevealPath provides parent + index) {
                        MarkdownBlocks(children.filterNot { it is TaskListItemMarker }, listener, if (list.isTight) 3.dp else 8.dp)
                    }
                }
            }
        }
    }
}

@Composable
private fun MarkdownCode(code: String, info: String = "") {
    NeumorphSurface(shape = RemoteUi.ControlShape, style = NeumorphStyle.Pressed) {
        Column(Modifier.fillMaxWidth()) {
            Row(Modifier.fillMaxWidth().padding(start = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(info.substringBefore(' ').ifBlank { L10n.tr("代码") }, Modifier.weight(1f), style = MaterialTheme.typography.labelSmall)
                CopyIconButton(L10n.tr("复制代码")) { code }
            }
            // Keep scrolling outside selection so selecting text doesn't swallow horizontal drags.
            Box(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(10.dp)) {
                MessageTextSelection {
                    StreamingMarkdownText(AnnotatedString(code), Modifier,
                        MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace), TextAlign.Start)
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
    // Tables appear whole, as on iOS; their cells do not join the reveal timeline.
    NeumorphSurface(Modifier.fillMaxWidth(), shape = RemoteUi.ControlShape, style = NeumorphStyle.Pressed, shadowScale = 0.4f) {
    CompositionLocalProvider(LocalRevealCursor provides null) {
    BoxWithConstraints(Modifier.fillMaxWidth().padding(6.dp)) {
        // Columns keep a shared width across rows. Wide tables scroll instead of being squeezed
        // into unreadable cells; long cell content wraps without truncation.
        val cellWidth = (maxWidth / columns).coerceIn(120.dp, 260.dp)
        Box(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())) {
            MessageTextSelection {
                Column {
                    rows.forEachIndexed { rowIndex, cells ->
                        Row(Modifier.height(IntrinsicSize.Min)) {
                            cells.forEach { cell ->
                                Column(
                                    Modifier.width(cellWidth).fillMaxHeight()
                                        .background(rememberNeumorphColors().layer(if (cell.isHeader || rowIndex % 2 == 0) 0 else 1))
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
}
