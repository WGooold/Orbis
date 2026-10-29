package com.orbising.orbis

import androidx.compose.foundation.layout.Column
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class DeferredDisclosureInstrumentedTest {
    @get:Rule val compose = createComposeRule()

    @Test fun closedDetailsDoNoWorkOnEveryChatEntryAndRetainStateAfterOpening() {
        var generation by mutableIntStateOf(0)
        var expanded by mutableStateOf(false)
        var text by mutableStateOf("Original body")
        var builds = 0
        var measures = 0
        compose.setContent {
            OrbisTheme {
                key(generation) {
                    Column {
                        repeat(30) { index ->
                            OrbisCollapse(expanded && index == 0) {
                                SideEffect { builds++ }
                                var count by remember { mutableIntStateOf(0) }
                                Column(Modifier.layout { measurable, constraints ->
                                    measures++
                                    val child = measurable.measure(constraints)
                                    layout(child.width, child.height) { child.placeRelative(0, 0) }
                                }) {
                                    TextButton(onClick = { count++ }, Modifier.testTag("counter")) { Text("Count $count") }
                                    Text(text, Modifier.testTag("body"))
                                    Text("Long hidden thinking\n".repeat(300))
                                }
                            }
                        }
                    }
                }
            }
        }
        repeat(3) {
            compose.runOnIdle {
                assertEquals(0, builds)
                assertEquals(0, measures)
                generation++
            }
        }
        compose.runOnIdle { expanded = true }
        compose.onNodeWithTag("counter").performClick()
        compose.onNodeWithText("Count 1").assertIsDisplayed()
        compose.runOnIdle {
            assertTrue(builds > 0)
            assertTrue(measures > 0)
            expanded = false
        }
        compose.waitForIdle()
        compose.onNodeWithTag("counter").assertDoesNotExist()
        compose.runOnIdle { text = "Updated body" }
        compose.runOnIdle { expanded = true }
        compose.onNodeWithText("Count 1").assertIsDisplayed()
        compose.onNodeWithText("Updated body").assertIsDisplayed()
    }

    @Test fun initiallyOpenAndRapidReversalSettleAtTheRequestedHeight() {
        var expanded by mutableStateOf(true)
        compose.setContent {
            OrbisTheme { OrbisCollapse(expanded) { Text("Visible body", Modifier.testTag("body")) } }
        }
        compose.onNodeWithTag("body").assertIsDisplayed()
        compose.mainClock.autoAdvance = false
        compose.runOnIdle { expanded = false }
        compose.mainClock.advanceTimeBy(64)
        compose.runOnIdle { expanded = true }
        compose.mainClock.advanceTimeBy(400)
        compose.mainClock.autoAdvance = true
        compose.onNodeWithTag("body").assertIsDisplayed()
    }
}
