package dev.pi.remote

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.LinkInteractionListener
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import org.commonmark.ext.autolink.AutolinkExtension
import org.commonmark.ext.gfm.strikethrough.Strikethrough
import org.commonmark.ext.gfm.strikethrough.StrikethroughExtension
import org.commonmark.ext.gfm.tables.TableBlock
import org.commonmark.ext.gfm.tables.TableCell
import org.commonmark.ext.gfm.tables.TableRow
import org.commonmark.ext.gfm.tables.TablesExtension
import org.commonmark.ext.task.list.items.TaskListItemMarker
import org.commonmark.ext.task.list.items.TaskListItemsExtension
import org.commonmark.node.Code
import org.commonmark.node.Emphasis
import org.commonmark.node.FencedCodeBlock
import org.commonmark.node.HardLineBreak
import org.commonmark.node.HtmlBlock
import org.commonmark.node.HtmlInline
import org.commonmark.node.Image
import org.commonmark.node.IndentedCodeBlock
import org.commonmark.node.Link
import org.commonmark.node.Node
import org.commonmark.node.SoftLineBreak
import org.commonmark.node.StrongEmphasis
import org.commonmark.node.Text
import org.commonmark.parser.Parser

// Parse the whole message once: reference definitions may follow the blocks that use them.
// The same tree drives both the Compose renderer and link/download discovery.
private val markdownParser = Parser.builder().extensions(
    listOf(
        TablesExtension.create(),
        StrikethroughExtension.create(),
        TaskListItemsExtension.create(),
        AutolinkExtension.create(),
    ),
).build()

internal fun parseMarkdown(markdown: String): List<Node> = markdownChildren(markdownParser.parse(markdown))

internal fun markdownChildren(node: Node): List<Node> = generateSequence(node.firstChild) { it.next }.toList()

internal fun markdownDescendants(nodes: List<Node>): Sequence<Node> = sequence {
    for (node in nodes) {
        yield(node)
        yieldAll(markdownDescendants(markdownChildren(node)))
    }
}

internal fun markdownTableRows(table: TableBlock): List<List<TableCell>> =
    markdownDescendants(markdownChildren(table)).filterIsInstance<TableRow>()
        .map { row -> markdownChildren(row).filterIsInstance<TableCell>() }.toList()

internal const val MARKDOWN_FILE_LINK_ANNOTATION = "computer-file-link"
internal const val MARKDOWN_URL_LINK_ANNOTATION = "url-link"

internal fun markdownFileLinkPath(value: String): String? {
    val candidate = value.trim().removeSurrounding("<", ">")
    if (candidate.isBlank() || candidate.any { it.code < 0x20 || it.code == 0x7f }) return null
    if (markdownHttpLinkUrl(candidate) != null) return null
    // Protocol-relative web URLs must not become downloads from the computer's filesystem.
    return candidate.takeIf {
        (it.startsWith("/") && !it.startsWith("//")) || it.matches(Regex("^[A-Za-z]:[\\\\/].+"))
    }
}

internal fun markdownHttpLinkUrl(value: String): String? {
    val candidate = value.trim().removeSurrounding("<", ">")
    return candidate.takeIf { it.matches(Regex("""https?://[^\s<>]+""", RegexOption.IGNORE_CASE)) }
}

internal fun markdownExternalLinkUrl(value: String): String? = markdownHttpLinkUrl(value)
    ?: value.takeIf { it.matches(Regex("""mailto:[^\s<>]+""", RegexOption.IGNORE_CASE)) }

private fun markdownLinkTarget(node: Node): String? {
    val destination = when (node) {
        is Link -> node.destination
        is Image -> node.destination
        else -> return null
    }
    return markdownFileLinkPath(destination) ?: markdownExternalLinkUrl(destination)
}

internal fun markdownFileLinkPaths(markdown: String): List<String> =
    markdownFileLinkPaths(parseMarkdown(markdown))

internal fun markdownFileLinkPaths(nodes: List<Node>): List<String> = markdownDescendants(nodes)
    .mapNotNull(::markdownLinkTarget).mapNotNull(::markdownFileLinkPath).distinct().toList()

internal fun markdownInteractiveLinkTargets(markdown: String): List<String> =
    markdownDescendants(parseMarkdown(markdown)).mapNotNull(::markdownLinkTarget).distinct().toList()

internal fun markdownDownloadPaths(nodes: List<Node>): List<String> {
    val linked = markdownFileLinkPaths(nodes)
    // Only inspect visible text; don't mistake URL destinations or table separators for paths.
    val detected = markdownDescendants(nodes).filter {
        it is org.commonmark.node.Paragraph || it is org.commonmark.node.Heading || it is TableCell ||
            it is FencedCodeBlock || it is IndentedCodeBlock || it is HtmlBlock
    }.flatMap { detectableFilePaths(renderMarkdownInline(it).text) }.toList()
    return (linked + detected.filterNot { path -> linked.any { it.startsWith(path) } }).distinct()
}

internal fun inlineMarkdown(
    markdown: String,
    linkInteractionListener: LinkInteractionListener? = null,
): AnnotatedString = buildAnnotatedString {
    parseMarkdown(markdown).forEachIndexed { index, node ->
        if (index > 0) append("\n\n")
        append(renderMarkdownInline(node, linkInteractionListener))
    }
}

/** Nested spans are applied to the same text range instead of reparsing substrings with regexes. */
internal fun renderMarkdownInline(
    node: Node,
    linkInteractionListener: LinkInteractionListener? = null,
    linkColor: Color = Color.Unspecified,
): AnnotatedString = buildAnnotatedString {
    fun appendNode(current: Node) {
        fun children() = markdownChildren(current).forEach { appendNode(it) }
        fun linked(destination: String, image: Boolean = false) {
            val start = length
            children()
            if (image && length == start) append("图片")
            val filePath = markdownFileLinkPath(destination)
            val target = filePath ?: markdownExternalLinkUrl(destination)
            if (target != null && start < length) {
                addStyle(SpanStyle(color = linkColor, textDecoration = TextDecoration.Underline), start, length)
                addLink(LinkAnnotation.Clickable(target, linkInteractionListener = linkInteractionListener), start, length)
                addStringAnnotation(
                    if (filePath != null) MARKDOWN_FILE_LINK_ANNOTATION else MARKDOWN_URL_LINK_ANNOTATION,
                    target, start, length,
                )
            }
        }
        when (current) {
            is Text -> append(current.literal)
            is Code -> withStyle(SpanStyle(fontFamily = FontFamily.Monospace, background = Color(0x14808080))) {
                append(current.literal)
            }
            is Emphasis -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { children() }
            is StrongEmphasis -> withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { children() }
            is Strikethrough -> withStyle(SpanStyle(textDecoration = TextDecoration.LineThrough)) { children() }
            is Link -> linked(current.destination)
            is Image -> linked(current.destination, image = true)
            is SoftLineBreak -> append(" ")
            is HardLineBreak -> append('\n')
            is HtmlInline -> if (current.literal.matches(Regex("""<br\s*/?>""", RegexOption.IGNORE_CASE))) {
                append('\n')
            } else {
                append(current.literal)
            }
            is FencedCodeBlock -> append(current.literal.removeSuffix("\n"))
            is IndentedCodeBlock -> append(current.literal.removeSuffix("\n"))
            is HtmlBlock -> append(current.literal.removeSuffix("\n"))
            is TaskListItemMarker -> Unit
            else -> markdownChildren(current).forEachIndexed { index, child ->
                if (index > 0 && child is org.commonmark.node.Block) append('\n')
                appendNode(child)
            }
        }
    }
    appendNode(node)
}
