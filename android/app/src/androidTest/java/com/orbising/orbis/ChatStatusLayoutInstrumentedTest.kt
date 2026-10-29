package com.orbising.orbis

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class ChatStatusLayoutInstrumentedTest {
    @get:Rule val compose = createComposeRule()

    @Test fun refreshDoesNotMoveOrRetruncateHeaderText() {
        val syncing = mutableStateOf(false)
        val width = mutableStateOf(220.dp)
        val fontScale = mutableStateOf(1f)
        val model = "A very long model name that needs truncation"
        val labels = listOf("空闲", model, "high")
        compose.setContent {
            OrbisTheme {
                val density = LocalDensity.current
                CompositionLocalProvider(LocalDensity provides Density(density.density, fontScale.value)) {
                    Box(Modifier.width(width.value).testTag("header-status")) {
                        ChatRuntimeStatus("idle", syncing.value, model, "high")
                    }
                }
            }
        }
        for (scale in listOf(1f, 1.5f)) {
            for (availableWidth in listOf(180.dp, 220.dp, 280.dp)) {
                compose.runOnIdle { fontScale.value = scale; width.value = availableWidth }
                val row = compose.onNodeWithTag("header-status").fetchSemanticsNode().boundsInRoot
                val bounds = labels.map { compose.onNodeWithText(it).fetchSemanticsNode().boundsInRoot }
                val layouts = labels.map(::textLayout)
                assertTrue("Long model should exercise ellipsis", layouts[1].isLineEllipsized(0))
                repeat(4) { cycle ->
                    compose.runOnIdle { syncing.value = cycle % 2 == 0 }
                    assertEquals(row, compose.onNodeWithTag("header-status").fetchSemanticsNode().boundsInRoot)
                    labels.forEachIndexed { index, label ->
                        assertEquals("Text moved at $availableWidth / $scale: $label", bounds[index],
                            compose.onNodeWithText(label).fetchSemanticsNode().boundsInRoot)
                        val layout = textLayout(label)
                        assertEquals(1, layout.lineCount)
                        assertEquals(layouts[index].getLineEnd(0, visibleEnd = true), layout.getLineEnd(0, visibleEnd = true))
                        assertEquals(layouts[index].isLineEllipsized(0), layout.isLineEllipsized(0))
                    }
                }
            }
        }
    }

    private fun textLayout(text: String): TextLayoutResult {
        val results = mutableListOf<TextLayoutResult>()
        compose.onNodeWithText(text).performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(results) }
        return results.single()
    }
}
