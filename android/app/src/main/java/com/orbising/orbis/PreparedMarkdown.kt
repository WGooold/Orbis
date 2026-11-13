package com.orbising.orbis

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.LinkInteractionListener
import androidx.compose.ui.text.SpanStyle
import java.util.IdentityHashMap
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.commonmark.node.Heading
import org.commonmark.node.Image
import org.commonmark.node.Node
import org.commonmark.node.Paragraph
import org.commonmark.node.Text
import org.commonmark.node.FencedCodeBlock
import org.commonmark.node.IndentedCodeBlock
import org.commonmark.node.HtmlBlock
import org.commonmark.ext.gfm.tables.TableCell

/** Immutable after publication. Neither a cache lookup nor drawing parses Markdown. */
internal class PreparedMarkdown(val blocks: List<Node>, val inline: Map<Node, AnnotatedString>, val mathHtml: Map<Node, String> = emptyMap())

internal class MarkdownDocumentCache(private val maxCharacters: Int = 2 * 1024 * 1024) {
    private val lock = Any()
    private val worker = Mutex()
    private val documents = LinkedHashMap<String, PreparedMarkdown>(16, .75f, true)
    private var characters = 0

    fun peek(text: String): PreparedMarkdown? = synchronized(lock) { documents[text] }

    suspend fun resolve(text: String): PreparedMarkdown = withContext(Dispatchers.Default) {
        worker.withLock {
            peek(text)?.let { return@withLock it }
            val math = MathMarkupEngine.protect(text)
            val blocks = if (math?.bypass == true) listOf(Paragraph().also { it.appendChild(Text(text)) })
                else parseMarkdown(math?.text ?: text)
            val inline = IdentityHashMap<Node, AnnotatedString>()
            val mathHtml = IdentityHashMap<Node, String>()
            markdownDescendants(blocks).forEach { node ->
                // Parser context wins over a speculative scan; internal markers never reach code.
                if (math != null) when (node) {
                    is FencedCodeBlock -> node.literal = MathMarkupEngine.restore(AnnotatedString(node.literal), math).text
                    is IndentedCodeBlock -> node.literal = MathMarkupEngine.restore(AnnotatedString(node.literal), math).text
                    is HtmlBlock -> node.literal = MathMarkupEngine.restore(AnnotatedString(node.literal), math).text
                }
                if (node is Paragraph || node is Heading || node is TableCell || node is Image) {
                    val value = renderMarkdownInline(node)
                    if (math != null) {
                        if (mathHtml.size < 32) MathMarkupEngine.html(value, math)?.let { mathHtml[node] = it }
                        inline[node] = MathMarkupEngine.restore(value, math)
                    } else inline[node] = value
                }
            }
            val result = PreparedMarkdown(blocks, inline, mathHtml)
            val cost = text.length + mathHtml.values.sumOf { it.length }
            if (cost <= maxCharacters) {
                synchronized(lock) {
                    documents[text] = result
                    characters += cost
                    while ((characters > maxCharacters || documents.size > 256) && documents.size > 1) {
                        val oldest = documents.entries.iterator()
                        val entry = oldest.next()
                        characters -= entry.key.length + entry.value.mathHtml.values.sumOf { it.length }
                        oldest.remove()
                    }
                }
            }
            result
        }
    }
}

internal val markdownDocuments = MarkdownDocumentCache()

/** Attach current UI actions and theme to already parsed spans; never retain a screen closure. */
internal fun bindMarkdownInline(template: AnnotatedString, listener: LinkInteractionListener, color: Color): AnnotatedString {
    val result = AnnotatedString.Builder(template.text)
    template.spanStyles.forEach { result.addStyle(it.item, it.start, it.end) }
    template.paragraphStyles.forEach { result.addStyle(it.item, it.start, it.end) }
    template.getStringAnnotations(0, template.length).forEach { link ->
        result.addStringAnnotation(link.tag, link.item, link.start, link.end)
        result.addStyle(SpanStyle(color = color), link.start, link.end)
        result.addLink(LinkAnnotation.Clickable(link.item, linkInteractionListener = listener), link.start, link.end)
    }
    return result.toAnnotatedString()
}
