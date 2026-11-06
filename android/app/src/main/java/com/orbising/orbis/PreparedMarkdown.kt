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
import org.commonmark.ext.gfm.tables.TableCell

/** Immutable after publication. Neither a cache lookup nor drawing parses Markdown. */
internal class PreparedMarkdown(val blocks: List<Node>, val inline: Map<Node, AnnotatedString>)

internal class MarkdownDocumentCache(private val maxCharacters: Int = 2 * 1024 * 1024) {
    private val lock = Any()
    private val worker = Mutex()
    private val documents = LinkedHashMap<String, PreparedMarkdown>(16, .75f, true)
    private var characters = 0

    fun peek(text: String): PreparedMarkdown? = synchronized(lock) { documents[text] }

    suspend fun resolve(text: String): PreparedMarkdown = withContext(Dispatchers.Default) {
        worker.withLock {
            peek(text)?.let { return@withLock it }
            val blocks = parseMarkdown(text)
            val inline = IdentityHashMap<Node, AnnotatedString>()
            markdownDescendants(blocks).forEach { node ->
                if (node is Paragraph || node is Heading || node is TableCell || node is Image)
                    inline[node] = renderMarkdownInline(node)
            }
            val result = PreparedMarkdown(blocks, inline)
            if (text.length <= maxCharacters) {
                synchronized(lock) {
                    documents[text] = result
                    characters += text.length
                    while ((characters > maxCharacters || documents.size > 256) && documents.size > 1) {
                        val oldest = documents.entries.iterator()
                        characters -= oldest.next().key.length
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
