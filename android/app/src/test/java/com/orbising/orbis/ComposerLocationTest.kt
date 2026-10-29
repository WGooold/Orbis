package com.orbising.orbis

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ComposerLocationTest {
    private val width = { text: String -> text.length * 10 }

    @Test fun `a path that fits is unchanged and a long one keeps both ends`() {
        assertEquals("/Projects/orbis", middleEllipsized("/Projects/orbis", 150, width))
        val shown = middleEllipsized("/Users/wgooold/Documents/orbis", 150, width)
        assertEquals(15, shown.length)
        assertTrue(shown.startsWith("/Users") && shown.endsWith("orbis") && "…" in shown)
        assertEquals("", middleEllipsized("/Users/wgooold", 5, width))
    }

    @Test fun `narrow widths never throw or return text wider than the available space`() {
        for (available in -1..100) {
            val shown = middleEllipsized("/Users/wgooold/Documents/orbis", available, width)
            assertTrue("$available: $shown", width(shown) <= available.coerceAtLeast(0))
        }
        assertEquals("…s", middleEllipsized("/Projects/orbis", 20, width))
    }

    @Test fun `ellipsis preserves complete unicode characters`() {
        val text = "📁/Cafe\u0301/项目/📦"
        for (available in 1..text.length) {
            val shown = middleEllipsized(text, available) { it.codePointCount(0, it.length) }
            assertTrue(shown.isEmpty() || !Character.isHighSurrogate(shown.last()))
            assertTrue(shown.isEmpty() || !Character.isLowSurrogate(shown.first()))
            assertTrue(!shown.contains("e…") && !shown.contains("…\u0301"))
        }
    }
}
