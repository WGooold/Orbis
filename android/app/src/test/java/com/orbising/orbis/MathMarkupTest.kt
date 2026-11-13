package com.orbising.orbis

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.commonmark.ext.gfm.tables.TableBlock
import org.commonmark.node.Paragraph
import org.junit.Assert.*
import org.junit.Test

/** MATH-01: actual Rhino + CommonMark integration must retain TeX, native spans and cells. */
class MathMarkupTest {
    @Test fun sharedCorpusPreservesAllSourceAndAgreesOnTokenCounts() {
        val stream = javaClass.classLoader!!.getResourceAsStream("math-tests/fixtures.json")!!
        val fixtures = Json.parseToJsonElement(stream.bufferedReader().use { it.readText() }).jsonArray
        for (fixture in fixtures) {
            val value = fixture.jsonObject
            val source = value.getValue("source").jsonPrimitive.content
            val prepared = MathMarkupEngine.protect(source)
            if (prepared == null) { assertEquals(0, value.getValue("count").jsonPrimitive.int); continue }
            assertFalse(prepared.bypass)
            val tokens = Json.parseToJsonElement(prepared.json).jsonObject.getValue("tokens").jsonArray
            assertEquals(value.getValue("name").jsonPrimitive.content, value.getValue("count").jsonPrimitive.int,
                tokens.count { !it.jsonObject.getValue("pending").jsonPrimitive.boolean })
            assertEquals(source, MathMarkupEngine.restore(androidx.compose.ui.text.AnnotatedString(prepared.text), prepared).text)
        }
    }
    @Test fun resourceLimitsKeepReadableUnmodifiedSource() = runBlocking {
        val source = "\\(x\\)".repeat(600)
        val document = MarkdownDocumentCache().resolve(source)
        assertTrue(document.mathHtml.isEmpty())
        assertEquals(source, document.inline.values.single().text)
    }
    @Test fun protectsTablePipesAndRetainsNativeLinkAndEmphasis() = runBlocking {
        val source = "| Name | Formula |\n|---|---|\n| **TLX** | [ref](https://example.test) \\(\\sum w_iR_i/15 + |x|\\) |"
        val document = MarkdownDocumentCache().resolve(source)
        val rows = markdownTableRows(document.blocks.single() as TableBlock)
        assertEquals(2, rows[1].size)
        val value = document.inline.getValue(rows[1][1])
        assertEquals("ref \\(\\sum w_iR_i/15 + |x|\\)", value.text)
        assertEquals("https://example.test", value.getStringAnnotations(0, value.length).single().item)
        assertTrue(document.mathHtml.getValue(rows[1][1]).contains("data-tex=\"\\sum w_iR_i/15 + |x|\""))
        assertTrue(document.mathHtml.getValue(rows[1][1]).contains("<a href=\"https://example.test\">ref</a>"))
    }
    @Test fun multilineAndIncompleteFormulaRecoverExactSource() = runBlocking {
        val cache = MarkdownDocumentCache()
        val source = "\\[\n\\begin{aligned}a&=b\\\\\nc&=d\\end{aligned}\n\\]"
        val document = cache.resolve(source)
        assertEquals(source, document.inline.getValue(document.blocks.single()).text)
        assertTrue(document.mathHtml.values.single().contains("a&amp;=b\\\\\nc&amp;=d"))
        val incomplete = "\\(\\frac{a}\n\nfollowing"
        val pending = cache.resolve(incomplete)
        assertEquals(listOf("\\(\\frac{a}", "following"), pending.blocks.map { pending.inline.getValue(it).text })
        assertTrue(pending.mathHtml.isEmpty())
    }
    @Test fun codeCurrencyAndDollarSourceAreUnchanged() = runBlocking {
        val cache = MarkdownDocumentCache()
        val document = cache.resolve("Price $" + "5 and $" + "10; `\\(x\\)`")
        assertTrue(document.mathHtml.isEmpty())
        val display = "\$\$x^2\$\$"
        val parsed = cache.resolve(display)
        assertEquals(display, parsed.inline.getValue(parsed.blocks.single() as Paragraph).text)
    }
}
