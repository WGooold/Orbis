package com.orbising.orbis

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performTouchInput
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class SwipeBackInstrumentedTest {
    @get:Rule val compose = createComposeRule()

    @Test fun navigationWaitsForReleaseAnimation() {
        val home = mutableStateOf(false)
        var backs = 0
        compose.mainClock.autoAdvance = false
        compose.setContent {
            OrbisTheme {
                if (home.value) Text("Home") else SwipeBackLayer(
                    onBack = { backs++; home.value = true },
                    underlay = { Text("Home preview") },
                ) {
                    Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) { Text("Chat") }
                }
            }
        }
        compose.onNodeWithText("Chat").assertIsNotDisplayed()
        compose.mainClock.advanceTimeBy(1_500)
        compose.onNodeWithText("Chat").assertIsDisplayed()
        compose.onRoot().performTouchInput {
            down(Offset(width * 0.1f, height * 0.5f))
            moveTo(Offset(width * 0.65f, height * 0.5f), 400)
            up()
        }
        compose.runOnIdle { assertEquals("Release must not immediately remove the chat", 0, backs) }
        compose.mainClock.advanceTimeBy(80)
        compose.runOnIdle { assertEquals("Navigation must wait for the spring to settle", 0, backs) }
        compose.mainClock.advanceTimeBy(1_500)
        compose.runOnIdle { assertEquals(1, backs) }
        compose.onNodeWithText("Home").assertIsDisplayed()
    }

    @Test fun cancelledDragCanBeFollowedByACompleteSwipe() {
        var backs = 0
        compose.setContent {
            OrbisTheme {
                SwipeBackLayer(onBack = { backs++ }, underlay = { Text("Home preview") }) {
                    Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) { Text("Chat") }
                }
            }
        }
        compose.mainClock.autoAdvance = false
        compose.onRoot().performTouchInput {
            down(Offset(width * 0.1f, height * 0.5f))
            moveTo(Offset(width * 0.25f, height * 0.5f), 400)
            cancel()
        }
        compose.mainClock.advanceTimeBy(1_500)
        compose.runOnIdle { assertEquals(0, backs) }
        compose.onNodeWithText("Chat").assertIsDisplayed()
        compose.onRoot().performTouchInput {
            down(Offset(width * 0.1f, height * 0.5f))
            moveTo(Offset(width * 0.75f, height * 0.5f), 400)
            up()
        }
        compose.mainClock.advanceTimeBy(1_500)
        compose.runOnIdle { assertEquals(1, backs) }
    }
}
