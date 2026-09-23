package dev.pi.remote

import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.LinkInteractionListener
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import org.commonmark.ext.gfm.tables.TableBlock
import org.commonmark.ext.gfm.tables.TableCell
import org.commonmark.ext.task.list.items.TaskListItemMarker
import org.commonmark.node.BlockQuote
import org.commonmark.node.BulletList
import org.commonmark.node.FencedCodeBlock
import org.commonmark.node.Heading
import org.commonmark.node.IndentedCodeBlock
import org.commonmark.node.ListItem
import org.commonmark.node.OrderedList
import org.commonmark.node.Paragraph
import org.commonmark.node.ThematicBreak
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MarkdownTest {
    @Test
    fun `table keeps its cells alignment and formatting instead of rendering pipes as a paragraph`() {
        val source = """
            | Name | Status | Artifact |
            | :--- | :---: | ---: |
            | Pi | **Ready** | [report][file] |
            | Codex | a\|b and `x\|y` | /tmp/output.txt |
            | Streaming | partial

            [file]: </tmp/My Report (1).txt> "Download"
        """.trimIndent()
        val blocks = parseMarkdown(source)
        val rows = markdownTableRows(blocks.filterIsInstance<TableBlock>().single())

        assertEquals(
            listOf(
                listOf("Name", "Status", "Artifact"),
                listOf("Pi", "Ready", "report"),
                listOf("Codex", "a|b and x|y", "/tmp/output.txt"),
                listOf("Streaming", "partial", ""),
            ),
            rows.map { row -> row.map { renderMarkdownInline(it).text } },
        )
        assertEquals(
            listOf(TableCell.Alignment.LEFT, TableCell.Alignment.CENTER, TableCell.Alignment.RIGHT),
            rows.first().map { it.alignment },
        )
        assertTrue(renderMarkdownInline(rows[1][1]).spanStyles.any { it.item.fontWeight == FontWeight.Bold })
        assertEquals(listOf("/tmp/My Report (1).txt", "/tmp/output.txt"), markdownDownloadPaths(blocks))
        val linkedCell = renderMarkdownInline(rows[1][2])
        assertEquals("/tmp/My Report (1).txt", linkedCell.getStringAnnotations(MARKDOWN_FILE_LINK_ANNOTATION, 0, linkedCell.length).single().item)
        // The last row need not have a closing pipe, as happens during streamed output.
        assertEquals("Pi", renderMarkdownInline(markdownTableRows(parseMarkdown("Name | Status\n--- | ---\nPi | Ready").single() as TableBlock)[1][0]).text)
    }

    @Test
    fun `nested lists and quotes retain block boundaries task state and ordered start`() {
        val blocks = parseMarkdown("""
            Title
            =====

            7. parent
               - [x] **done**
               - [ ] pending

               > nested quote
               >
               > second paragraph

            8. next

            ---
        """.trimIndent())
        assertEquals("Title", renderMarkdownInline(blocks.first()).text)
        assertTrue(blocks.first() is Heading)
        assertTrue(blocks.last() is ThematicBreak)
        val ordered = blocks.filterIsInstance<OrderedList>().single()
        assertEquals(7, ordered.markerStartNumber)
        val items = markdownChildren(ordered).filterIsInstance<ListItem>()
        assertEquals(2, items.size)
        val parent = markdownChildren(items.first())
        assertEquals("parent", renderMarkdownInline(parent.first()).text)
        val tasks = markdownChildren(parent.filterIsInstance<BulletList>().single())
        assertEquals(listOf(true, false), tasks.map { (it.firstChild as TaskListItemMarker).isChecked })
        assertEquals(listOf("done", "pending"), tasks.map { renderMarkdownInline(it).text.trim() })
        val quote = parent.filterIsInstance<BlockQuote>().single()
        assertEquals(listOf("nested quote", "second paragraph"), markdownChildren(quote).map { renderMarkdownInline(it).text })
    }

    @Test
    fun `code fences never parse their content or close on a shorter or different marker`() {
        val blocks = parseMarkdown("""
            ````markdown
            ```kotlin
            **literal** and [file](/tmp/code.txt)
            ~~~
            ````

            Between blocks.

                indented_code

            ~~~text
            still streaming
        """.trimIndent())
        val code = blocks.first() as FencedCodeBlock
        assertEquals("markdown", code.info)
        assertEquals("```kotlin\n**literal** and [file](/tmp/code.txt)\n~~~", renderMarkdownInline(code).text)
        assertTrue(markdownFileLinkPaths(listOf(code)).isEmpty())
        assertEquals(4, blocks.size)
        assertTrue(blocks[1] is Paragraph)
        assertTrue(blocks[2] is IndentedCodeBlock)
        assertEquals("indented_code", renderMarkdownInline(blocks[2]).text)
        assertEquals("still streaming", renderMarkdownInline(blocks[3]).text)
        assertTrue(parseMarkdown("```\n```").single() is FencedCodeBlock)
    }

    @Test
    fun `nested emphasis escapes and code preserve visible text and overlapping styles`() {
        val rendered = inlineMarkdown("**bold *italic* and [link](https://example.test)** ~~gone~~ `a_b` foo_bar_baz \\*literal\\* &amp;")
        assertEquals("bold italic and link gone a_b foo_bar_baz *literal* &", rendered.text)
        val italicStart = rendered.text.indexOf("italic")
        assertTrue(rendered.spanStyles.any { it.start <= italicStart && it.end >= italicStart + 6 && it.item.fontWeight == FontWeight.Bold })
        assertTrue(rendered.spanStyles.any { it.start == italicStart && it.end == italicStart + 6 && it.item.fontStyle == FontStyle.Italic })
        assertTrue(rendered.spanStyles.any { it.item.textDecoration == TextDecoration.LineThrough })
        assertTrue(rendered.spanStyles.any { rendered.text.substring(it.start, it.end) == "a_b" && it.item.fontFamily == FontFamily.Monospace })
        assertEquals("one\ntwo\nthree four", inlineMarkdown("one  \ntwo<br>three\nfour").text)
        assertEquals("use `ticks` &amp;", inlineMarkdown("``use `ticks` &amp;``").text)
    }

    @Test
    fun `links keep exact file destinations and native click behavior across references and inline formatting`() {
        val source = """
            [**first**](C:\work\first.txt) and [report][file]

            [docs](https://example.test/docs_(v2) "Title") and https://example.test/auto

            ![plot](https://example.test/chart.png) and <person@example.test>

            [file]: </tmp/My Report (1).txt>
        """.trimIndent()
        val clicked = mutableListOf<String>()
        val listener = LinkInteractionListener { link -> clicked += (link as LinkAnnotation.Clickable).tag }
        val rendered = inlineMarkdown(source, listener)
        val expected = listOf(
            "C:\\work\\first.txt", "/tmp/My Report (1).txt", "https://example.test/docs_(v2)",
            "https://example.test/auto", "https://example.test/chart.png", "mailto:person@example.test",
        )
        val links = rendered.getLinkAnnotations(0, rendered.length)
        assertEquals(expected, links.map { (it.item as LinkAnnotation.Clickable).tag })
        links.forEach { it.item.linkInteractionListener?.onClick(it.item) }
        assertEquals(expected, clicked)
        assertEquals(expected, markdownInteractiveLinkTargets(source))
        assertEquals(expected.take(2), markdownFileLinkPaths(source))
        assertEquals(expected.take(2), markdownDownloadPaths(parseMarkdown(source)))
        assertEquals(expected.take(2), rendered.getStringAnnotations(MARKDOWN_FILE_LINK_ANNOTATION, 0, rendered.length).map { it.item })
        assertEquals(expected.drop(2), rendered.getStringAnnotations(MARKDOWN_URL_LINK_ANNOTATION, 0, rendered.length).map { it.item })
        assertEquals("C:\\Program Files\\app.apk", markdownFileLinkPath("<C:\\Program Files\\app.apk>"))
    }

    @Test
    fun `unsupported link schemes remain readable without becoming executable links or downloads`() {
        val source = "[script](javascript:alert%281%29) [data](data:text/html,hello) [network](//example.test/file)"
        val rendered = inlineMarkdown(source)
        assertEquals("script data network", rendered.text)
        assertTrue(rendered.getLinkAnnotations(0, rendered.length).isEmpty())
        assertTrue(markdownDownloadPaths(parseMarkdown(source)).isEmpty())
        assertFalse(markdownFileLinkPath("/tmp/file\n.txt") != null)
    }
}
