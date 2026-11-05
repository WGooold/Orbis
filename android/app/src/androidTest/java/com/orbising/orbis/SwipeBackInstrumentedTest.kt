package com.orbising.orbis

import androidx.compose.foundation.layout.Column
import androidx.compose.material3.Button
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.swipeRight
import org.junit.Rule
import org.junit.Test
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.SideEffect
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
import org.junit.Assert.assertTrue

class SwipeBackInstrumentedTest {
    @get:Rule val compose = createComposeRule()

    @Test fun everyEntrySlidesLeftAndOnlyComposesTheHomeUnderlayOnce() {
        val opened = mutableStateOf(true)
        var underlayBuilds = 0
        var underlayMounted = false
        compose.mainClock.autoAdvance = false
        compose.setContent {
            OrbisTheme {
                if (opened.value) SwipeBackLayer(onBack = {}, underlay = {
                    SideEffect { underlayBuilds++ }
                    DisposableEffect(Unit) {
                        underlayMounted = true
                        onDispose { underlayMounted = false }
                    }
                    Text("Home preview")
                }) {
                    Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) { Text("Chat") }
                } else Text("Home")
            }
        }
        repeat(2) { entry ->
            compose.onNodeWithText("Chat").assertIsNotDisplayed()
            compose.runOnIdle { assertTrue(underlayMounted) }
            compose.mainClock.advanceTimeBy(80)
            val firstX = compose.onNodeWithText("Chat").fetchSemanticsNode().boundsInRoot.left
            val width = compose.onRoot().fetchSemanticsNode().boundsInRoot.width
            assertTrue("The chat must slide in from the right: x=$firstX width=$width", firstX > 0f && firstX < width)
            compose.mainClock.advanceTimeBy(80)
            val nextX = compose.onNodeWithText("Chat").fetchSemanticsNode().boundsInRoot.left
            assertTrue("The entry must move left", nextX < firstX)
            compose.mainClock.advanceTimeBy(1_500)
            compose.onNodeWithText("Chat").assertIsDisplayed()
            assertEquals(0f, compose.onNodeWithText("Chat").fetchSemanticsNode().boundsInRoot.left, 0.5f)
            compose.runOnIdle {
                assertTrue("Keep home mounted while the chat covers it", underlayMounted)
                assertEquals("Animation frames must not recompose the home", entry + 1, underlayBuilds)
            }
            if (entry == 0) {
                compose.runOnIdle { opened.value = false }
                compose.mainClock.advanceTimeByFrame()
                compose.onNodeWithText("Home").assertIsDisplayed()
                compose.runOnIdle { opened.value = true }
                compose.mainClock.advanceTimeByFrame()
            }
        }
    }

    @Test fun rightSwipeInterruptsEntranceBeforeLoadingFinishes() {
        val home = mutableStateOf(false)
        var backs = 0
        compose.mainClock.autoAdvance = false
        compose.setContent {
            OrbisTheme {
                SwipeBackLayer(open = !home.value, onBack = { backs++; home.value = true },
                    underlay = { Text("Home") }) {
                    Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) { Text("Loading chat") }
                }
            }
        }
        compose.mainClock.advanceTimeBy(80)
        val enteringX = compose.onNodeWithText("Loading chat").fetchSemanticsNode().positionInRoot.x
        assertTrue(enteringX > 0f)
        compose.onRoot().performTouchInput {
            down(Offset(width * 0.1f, height * 0.5f))
            moveTo(Offset(width * 0.2f, height * 0.5f), 16)
        }
        compose.mainClock.advanceTimeByFrame()
        // Bounds are clipped to the screen; the drag may already move the label offscreen.
        val draggedX = compose.onNodeWithText("Loading chat").fetchSemanticsNode().positionInRoot.x
        // Input injection advances event time, so compare after acquiring the drag. Holding
        // the finger must stop entry; further movement must move the page to the right.
        compose.mainClock.advanceTimeBy(80)
        assertEquals("Entry must stop under the finger", draggedX,
            compose.onNodeWithText("Loading chat").fetchSemanticsNode().positionInRoot.x, 0.5f)
        compose.onRoot().performTouchInput { moveTo(Offset(width * 0.4f, height * 0.5f), 16) }
        compose.mainClock.advanceTimeByFrame()
        assertTrue("An entering chat must follow the finger immediately",
            compose.onNodeWithText("Loading chat").fetchSemanticsNode().positionInRoot.x > draggedX)
        compose.onRoot().performTouchInput {
            moveTo(Offset(width * 0.85f, height * 0.5f), 160)
            up()
        }
        compose.mainClock.advanceTimeBy(250)
        compose.onNodeWithText("Home").assertIsDisplayed()
        compose.runOnIdle { assertEquals(1, backs) }
    }

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

/** ADR-0054 / M14: the same layer carries settings and downloads; a page over a page keeps it alive. */
class SwipeBackPagesInstrumentedTest {
    @get:Rule val compose = createComposeRule()

    @Test fun switchingPagesOnTheLayerReplaysTheEntrance() {
        val page = mutableStateOf<String?>(null)
        compose.setContent {
            OrbisTheme {
                SwipeBackLayer(onBack = { page.value = null }, underlay = { Text("Home preview") }, open = page.value != null, contentKey = page.value) {
                    Text("Page ${page.value}", Modifier.testTag("page"))
                }
            }
        }
        compose.mainClock.autoAdvance = false
        compose.runOnIdle { page.value = "settings" }
        compose.mainClock.advanceTimeByFrame()
        compose.mainClock.advanceTimeBy(32)
        val entering = compose.onNodeWithTag("page", useUnmergedTree = true).fetchSemanticsNode().positionInRoot.x
        assertTrue("page enters from the right", entering > 0f)
        compose.mainClock.advanceTimeBy(1_000)
        assertEquals(0f, compose.onNodeWithTag("page", useUnmergedTree = true).fetchSemanticsNode().positionInRoot.x, 1f)
        compose.runOnIdle { page.value = "downloads" }
        compose.mainClock.advanceTimeByFrame()
        compose.mainClock.advanceTimeBy(32)
        assertTrue("a different page replays the entrance",
            compose.onNodeWithTag("page", useUnmergedTree = true).fetchSemanticsNode().positionInRoot.x > 0f)
        compose.mainClock.autoAdvance = true
    }

    @Test fun swipingBackFromAPageOverAPageKeepsTheSourceState() {
        val downloads = mutableStateOf(false)
        var sourceBuilds = 0
        var sourceDisposed = false
        compose.setContent {
            OrbisTheme {
                SwipeBackLayer(onBack = { downloads.value = false }, open = downloads.value, underlay = {
                    var draft by remember { mutableStateOf("") }
                    DisposableEffect(Unit) { sourceBuilds++; onDispose { sourceDisposed = true } }
                    Column {
                        Text("Draft: $draft", Modifier.testTag("draft"))
                        Button(onClick = { draft += "x" }, Modifier.testTag("type")) { Text("Type") }
                    }
                }) {
                    Box(Modifier.fillMaxSize().testTag("downloads")) { Text("Downloads") }
                }
            }
        }
        compose.onNodeWithTag("type").performClick()
        compose.onNodeWithTag("type").performClick()
        compose.runOnIdle { downloads.value = true }
        compose.onNodeWithTag("downloads").assertIsDisplayed()
        compose.onNodeWithTag("downloads").performTouchInput {
            swipeRight(startX = width * 0.15f, endX = width * 0.9f, durationMillis = 400)
        }
        compose.waitUntil(3_000) { !downloads.value }
        compose.onNodeWithText("Draft: xx").assertIsDisplayed()
        assertEquals(1, sourceBuilds)
        assertTrue(!sourceDisposed)
    }
}
