package com.orbising.orbis

import android.graphics.Bitmap
import androidx.activity.BackEventCompat
import androidx.activity.OnBackPressedDispatcher
import androidx.activity.compose.LocalOnBackPressedDispatcherOwner
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.io.File
import kotlin.math.abs

/** ADR-0058: observable intermediate frames, cancellation and ownership on production components. */
class InteractionMotionInstrumentedTest {
    @get:Rule val compose = createComposeRule()

    @Test fun selectionStartsAtTheTouchAndReversesWithoutMovingTheCard() {
        var selected by mutableStateOf(false)
        compose.mainClock.autoAdvance = false
        compose.setContent { OrbisTheme {
            Box(Modifier.fillMaxSize().padding(30.dp)) {
                NeumorphSurface(Modifier.size(300.dp, 110.dp).testTag("selection"),
                    selectionSelected = selected, selectionMode = selected, onClick = { selected = !selected }) { }
            }
        } }
        compose.mainClock.advanceTimeByFrame()
        val card = compose.onNodeWithTag("selection")
        val bounds = card.fetchSemanticsNode().boundsInRoot
        val before = card.captureToImage().toPixelMap()
        card.performTouchInput { click(Offset(width * 0.08f, height * 0.5f)) }
        compose.mainClock.advanceTimeBy(80)
        val middle = card.captureToImage().toPixelMap()
        fun delta(x: Float): Float {
            val ix = (before.width * x).toInt(); val y = before.height / 2
            val a = before[ix, y]; val b = middle[ix, y]
            return abs(a.red-b.red) + abs(a.green-b.green) + abs(a.blue-b.blue)
        }
        capture("motion-selection-middle")
        assertTrue("The touch side must reveal first: ${delta(0.1f)}", delta(0.1f) > 0.005f)
        assertTrue("The opposite side must still be unselected", delta(0.9f) < 0.005f)
        capture("motion-selection-middle")
        compose.mainClock.advanceTimeBy(400)
        assertEquals(bounds, card.fetchSemanticsNode().boundsInRoot)
        card.performClick()
        compose.mainClock.advanceTimeBy(400)
        val restored = card.captureToImage().toPixelMap()
        assertEquals(before[before.width / 2, before.height / 2], restored[restored.width / 2, restored.height / 2])
    }

    @OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
    @Test fun nativeTextLongPressReplacesThePageHeaderWithoutMovingTheBubble() {
        var rewinds = 0
        compose.setContent { OrbisTheme {
            val actions = remember { MessageActionState() }
            CompositionLocalProvider(LocalMessageActionState provides actions) {
            Column(Modifier.fillMaxSize().padding(20.dp)) {
                MessageActionHeader { androidx.compose.material3.TopAppBar(title = { Text("原状态栏") }) }
                Spacer(Modifier.height(186.dp))
                UserMessageCard("r", ChatMessage("user", "user", listOf(RemoteContent("text", "长按这段文字查看操作")), 1),
                    emptyMap(), {}, {}, onRewind = { rewinds++ }, rewindEnabled = true)
            } }
        } }
        val text = compose.onNodeWithText("长按这段文字查看操作")
        val before = text.fetchSemanticsNode().boundsInRoot
        compose.onNodeWithContentDescription("复制消息").assertDoesNotExist()
        text.performTouchInput { longClick() }
        val copy = compose.onNodeWithContentDescription("复制消息")
        copy.assertIsDisplayed()
        compose.onNodeWithTag("message-action-header").assertIsDisplayed()
        compose.onNodeWithText("原状态栏").assertDoesNotExist()
        assertEquals(before, text.fetchSemanticsNode().boundsInRoot)
        assertTrue(copy.fetchSemanticsNode().boundsInRoot.bottom < before.top)
        capture("motion-message-toolbar")
        copy.performClick()
        compose.onNodeWithContentDescription("已复制").assertIsDisplayed()
        compose.onNodeWithContentDescription("Rewind").performClick()
        compose.runOnIdle { assertEquals(1, rewinds) }
        compose.onNodeWithContentDescription("Rewind").assertDoesNotExist()
    }

    @Test fun reminderEntersFromUpperRightAndRetainsItsContentDuringReverseExit() {
        var visible by mutableStateOf(false)
        compose.mainClock.autoAdvance = false
        compose.setContent { OrbisTheme {
            Box(Modifier.fillMaxSize().padding(50.dp)) {
                AnimatedChatQuestionReminder(ChatQuestion("q", "同一个源问题"), visible) { }
            }
        } }
        compose.runOnIdle { visible = true }
        compose.mainClock.advanceTimeBy(64)
        val entering = compose.onNodeWithTag("chat-question-reminder").fetchSemanticsNode().positionInRoot
        capture("motion-reminder-enter")
        compose.mainClock.advanceTimeBy(400)
        val settled = compose.onNodeWithTag("chat-question-reminder").fetchSemanticsNode().positionInRoot
        assertTrue(entering.x > settled.x && entering.y < settled.y)
        compose.runOnIdle { visible = false }
        compose.mainClock.advanceTimeBy(64)
        val leaving = compose.onNodeWithTag("chat-question-reminder").fetchSemanticsNode().positionInRoot
        assertTrue(leaving.x > settled.x && leaving.y < settled.y)
        compose.onNodeWithText("同一个源问题").assertExists()
        capture("motion-reminder-exit")
        compose.mainClock.advanceTimeBy(300)
        compose.onNodeWithTag("chat-question-reminder").assertDoesNotExist()
    }

    @Test fun iconActivationChangesTheGlyphWithoutChangingItsHitTarget() {
        var count = 0
        compose.mainClock.autoAdvance = false
        compose.setContent { OrbisTheme {
            Box(Modifier.padding(30.dp)) { NeumorphIconButton({ count++ }, Icons.Rounded.Settings, "齿轮", Modifier.testTag("gear")) }
        } }
        val gear = compose.onNodeWithTag("gear")
        val bounds = gear.fetchSemanticsNode().boundsInRoot
        val before = gear.captureToImage().asAndroidBitmap()
        gear.performClick(); compose.mainClock.advanceTimeBy(80)
        val middle = gear.captureToImage().asAndroidBitmap()
        assertFalse(before.sameAs(middle))
        assertEquals(bounds, gear.fetchSemanticsNode().boundsInRoot)
        gear.performClick(); compose.mainClock.advanceTimeBy(400)
        compose.runOnIdle { assertEquals(2, count) }
        capture("motion-glyph-settled")
    }

    @Test fun physicalPressShowsFeedbackBeforeDispatchAndCancellationDoesNotClick() {
        var count = 0
        compose.mainClock.autoAdvance = false
        compose.setContent { OrbisTheme {
            Box(Modifier.padding(30.dp)) { NeumorphIconButton({ count++ }, Icons.Rounded.Settings, "按压齿轮", Modifier.testTag("press-gear")) }
        } }
        compose.mainClock.advanceTimeBy(700)
        val gear = compose.onNodeWithTag("press-gear")
        val bounds = gear.fetchSemanticsNode().boundsInRoot
        val resting = gear.captureToImage().asAndroidBitmap()
        gear.performTouchInput { down(center) }
        compose.mainClock.advanceTimeBy(80)
        assertFalse(resting.sameAs(gear.captureToImage().asAndroidBitmap()))
        compose.runOnIdle { assertEquals("Down must not dispatch the action", 0, count) }
        gear.performTouchInput { cancel() }
        compose.mainClock.advanceTimeBy(700)
        compose.runOnIdle { assertEquals(0, count) }
        assertEquals(bounds, gear.fetchSemanticsNode().boundsInRoot)
        gear.performTouchInput { click() }
        compose.mainClock.advanceTimeByFrame()
        compose.mainClock.advanceTimeBy(64)
        compose.runOnIdle { assertEquals("Dispatch must not wait for the rotation", 1, count) }
        assertFalse(resting.sameAs(gear.captureToImage().asAndroidBitmap()))
        capture("motion-fast-press-feedback")
        compose.mainClock.advanceTimeBy(700)
        assertEquals(bounds, gear.fetchSemanticsNode().boundsInRoot)
    }

    @Test fun discreteLabelsKeepOnlyTheLiveAccessibilityValueDuringTheirFade() {
        var label by mutableStateOf("正在同步")
        compose.mainClock.autoAdvance = false
        compose.setContent { OrbisTheme { MotionText(label, Modifier.testTag("status-slot").width(180.dp)) } }
        compose.mainClock.advanceTimeBy(300)
        val slot = compose.onNodeWithTag("status-slot")
        val before = slot.fetchSemanticsNode().boundsInRoot
        compose.runOnIdle { label = "同步完成" }
        compose.mainClock.advanceTimeBy(64)
        compose.onNodeWithText("同步完成").assertExists()
        compose.onNodeWithText("正在同步").assertDoesNotExist()
        assertEquals(before, slot.fetchSemanticsNode().boundsInRoot)
        capture("motion-discrete-label-middle")
        compose.mainClock.advanceTimeBy(240)
        compose.onNodeWithText("同步完成").assertExists()
    }

    @Test fun predictiveBackOnBothEdgesCancelsOrCommitsOnlyOnePage() {
        lateinit var dispatcher: OnBackPressedDispatcher
        var open by mutableStateOf(true)
        var backs = 0
        compose.mainClock.autoAdvance = false
        compose.setContent { OrbisTheme {
            dispatcher = LocalOnBackPressedDispatcherOwner.current!!.onBackPressedDispatcher
            OrbisPageHost(open = open, onBack = { backs++; open = false }, underlay = { Text("真实来源") }) {
                Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).testTag("page")) { Text("当前页") }
            }
        } }
        compose.mainClock.advanceTimeBy(1500)
        val before = compose.onNodeWithTag("page").fetchSemanticsNode().boundsInRoot
        fun event(progress: Float, edge: Int) = BackEventCompat(0f, 400f, progress, edge)
        compose.runOnIdle { dispatcher.dispatchOnBackStarted(event(0f, BackEventCompat.EDGE_RIGHT)) }
        compose.mainClock.advanceTimeByFrame()
        compose.runOnIdle { dispatcher.dispatchOnBackProgressed(event(0.65f, BackEventCompat.EDGE_RIGHT)) }
        compose.mainClock.advanceTimeByFrame()
        val middle = compose.onNodeWithTag("page").fetchSemanticsNode().boundsInRoot
        assertTrue(middle.width < before.width && middle.height < before.height)
        assertTrue(middle.left > before.left && middle.right < before.right)
        assertTrue(middle.center.x < before.center.x)
        capture("motion-edge-right-cancel")
        compose.runOnIdle { dispatcher.dispatchOnBackCancelled() }
        compose.mainClock.advanceTimeBy(1500)
        assertEquals(before, compose.onNodeWithTag("page").fetchSemanticsNode().boundsInRoot)
        compose.runOnIdle { assertEquals(0, backs); dispatcher.dispatchOnBackStarted(event(0f, BackEventCompat.EDGE_LEFT)) }
        compose.mainClock.advanceTimeByFrame()
        compose.runOnIdle { dispatcher.dispatchOnBackProgressed(event(0.65f, BackEventCompat.EDGE_LEFT)) }
        compose.mainClock.advanceTimeByFrame()
        val left = compose.onNodeWithTag("page").fetchSemanticsNode().boundsInRoot
        assertTrue(left.center.x > before.center.x && left.right < before.right && left.left > before.left)
        capture("motion-edge-left-commit")
        compose.runOnIdle { dispatcher.onBackPressed() }
        compose.mainClock.advanceTimeBy(80)
        val exiting = compose.onNodeWithTag("page").fetchSemanticsNode().boundsInRoot
        assertTrue(exiting.left > left.left)
        compose.runOnIdle { assertEquals(0, backs) }
        capture("motion-edge-commit-slide")
        compose.mainClock.advanceTimeBy(400)
        compose.onNodeWithText("真实来源").assertIsDisplayed()
        compose.runOnIdle { assertEquals(1, backs) }
    }

    @Test fun menuChangesItsContainerBeforeSlidingToTheChildAndBack() {
        var open by mutableStateOf(false)
        var page by mutableStateOf(emptyList<String>())
        compose.mainClock.autoAdvance = false
        compose.setContent { OrbisTheme {
            Box(Modifier.padding(40.dp)) {
                NeumorphTextButton("打开菜单", { open = true })
                NeumorphMenu(open, { open = false }, page = page, onBack = { page = emptyList() }) { shown ->
                    if (shown.isEmpty()) {
                        NeumorphMenuItem({ Text("进入二级") }, { page = listOf("computers") })
                        repeat(3) { Text("根选项 $it", Modifier.padding(12.dp)) }
                    } else {
                        NeumorphMenuItem({ Text("返回一级") }, { page = emptyList() })
                        Text("二级电脑", Modifier.padding(12.dp))
                    }
                }
            }
        } }
        compose.onNodeWithText("打开菜单").performClick()
        compose.mainClock.advanceTimeBy(400)
        val root = compose.onNodeWithText("进入二级").fetchSemanticsNode().positionInRoot
        compose.onNodeWithText("进入二级").performClick()
        compose.mainClock.advanceTimeBy(80)
        capture("motion-menu-shape")
        compose.mainClock.advanceTimeBy(160)
        val entering = compose.onNodeWithText("返回一级").fetchSemanticsNode().positionInRoot
        capture("motion-menu-child-enter")
        compose.mainClock.advanceTimeBy(400)
        val settled = compose.onNodeWithText("返回一级").fetchSemanticsNode().positionInRoot
        assertTrue(entering.x > settled.x)
        assertEquals(root.x, settled.x, 1f)
        compose.onNodeWithText("返回一级").performClick()
        compose.mainClock.advanceTimeBy(500)
        compose.onNodeWithText("进入二级").assertIsDisplayed()
        compose.onNodeWithText("二级电脑").assertDoesNotExist()
    }

    @Test fun sendFlightUsesTheAcceptedIdentityAndNeverLandsQueuedOrReadingMessages() {
        lateinit var flight: MessageSendFlightState
        var active by mutableStateOf(true)
        var keyboardSpace by mutableStateOf(0.dp)
        compose.mainClock.autoAdvance = false
        compose.setContent { OrbisTheme {
            val scope = rememberCoroutineScope()
            flight = remember { MessageSendFlightState(scope) }
            Box(Modifier.fillMaxSize().padding(bottom = keyboardSpace)) {
                MessageSendFlightHost(flight, active) {
                    Box(Modifier.fillMaxSize().padding(20.dp)) {
                        Text("已受理的同一条输入", Modifier.align(Alignment.TopEnd).padding(top = 100.dp)
                            .messageSendFlightTarget("accepted").testTag("landing"))
                        Text("输入框", Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(64.dp)
                            .onGloballyPositioned { flight.composer = it.boundsInWindow() })
                    }
                }
            }
        } }
        compose.mainClock.advanceTimeByFrame()
        val bounds = compose.onNodeWithTag("landing").fetchSemanticsNode().boundsInRoot
        fun send(id: String, queued: Boolean = false) = PendingSend(id, "command-$id", "session", "已受理的同一条输入",
            emptyList(), if (queued) "followUp" else null, 1, null)
        compose.runOnIdle { flight.launch(send("accepted"), following = true); flight.launch(send("accepted"), following = true) }
        compose.mainClock.advanceTimeBy(96)
        compose.runOnIdle {
            assertEquals(1, flight.flights.size)
            val item = flight.flights.single()
            assertTrue(item.landsOnRow)
            assertEquals(flight.targets["accepted"], item.target)
            assertTrue(item.progress.value > 0f && item.progress.value < 0.5f)
        }
        capture("motion-send-right-then-up")
        compose.mainClock.advanceTimeBy(400)
        compose.runOnIdle { assertTrue(flight.flights.isEmpty()) }
        assertEquals(bounds, compose.onNodeWithTag("landing").fetchSemanticsNode().boundsInRoot)
        compose.runOnIdle { flight.launch(send("accepted"), following = true) }
        compose.mainClock.advanceTimeBy(64)
        compose.runOnIdle { assertTrue(flight.flights.single().landsOnRow); keyboardSpace = 160.dp }
        compose.mainClock.advanceTimeByFrame()
        compose.runOnIdle { assertTrue(flight.flights.isEmpty()); assertTrue(flight.targets.containsKey("accepted")) }
        compose.onNodeWithTag("landing").assertIsDisplayed()
        compose.runOnIdle {
            flight.launch(send("accepted"), following = false)
            flight.launch(send("queued", true), following = true)
            flight.launch(send("third"), following = true)
            flight.launch(send("fourth"), following = true)
        }
        compose.mainClock.advanceTimeBy(64)
        compose.runOnIdle { assertEquals(3, flight.flights.size); assertTrue(flight.flights.none { it.landsOnRow }) }
        capture("motion-send-fallback-and-cap")
        compose.runOnIdle { active = false }
        compose.mainClock.advanceTimeByFrame()
        compose.runOnIdle { assertTrue(flight.flights.isEmpty()) }
        assertEquals(bounds, compose.onNodeWithTag("landing").fetchSemanticsNode().boundsInRoot)
    }


    @Test fun newSessionCardRisesBeforeHandingOffExactlyOnce() {
        var completed = 0
        compose.mainClock.autoAdvance = false
        val launch = LaunchState("request", "launch:request", mapOf("type" to "new"), "新项目", "/repo", "pi", null)
        compose.setContent { OrbisTheme {
            Box(Modifier.fillMaxSize().padding(24.dp)) { NewSessionMotionCard(launch) { completed++ } }
        } }
        compose.mainClock.advanceTimeByFrame()
        compose.mainClock.advanceTimeBy(112)
        val middle = compose.onNodeWithTag("new-session-card").fetchSemanticsNode().boundsInRoot
        compose.runOnIdle { assertEquals(0, completed) }
        capture("motion-new-session-middle")
        compose.mainClock.advanceTimeBy(300)
        val end = compose.onNodeWithTag("new-session-card").fetchSemanticsNode().boundsInRoot
        assertTrue(middle.top > end.top)
        compose.runOnIdle { assertEquals(1, completed) }
        compose.mainClock.advanceTimeBy(500)
        compose.runOnIdle { assertEquals(1, completed) }
    }

    private fun capture(name: String) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        // captureToImage waits for Compose's drawing frame. UiAutomation can return the previous
        // surface buffer while the test clock is paused; keep each popup root separately as well.
        val roots = compose.onAllNodes(isRoot())
        repeat(roots.fetchSemanticsNodes().size) { index ->
            File(context.getExternalFilesDir(null), "$name-root-$index.png").outputStream().use {
                roots[index].captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it)
            }
        }
        // Popup windows are separate surfaces; wait for two display callbacks after Compose
        // has laid out the paused phase, then capture the whole window including the popup.
        val drawn = java.util.concurrent.CountDownLatch(1)
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            android.view.Choreographer.getInstance().postFrameCallback {
                android.view.Choreographer.getInstance().postFrameCallback { drawn.countDown() }
            }
        }
        check(drawn.await(2, java.util.concurrent.TimeUnit.SECONDS)) { "display frame did not commit" }
        File(context.getExternalFilesDir(null), "$name-display.png").outputStream().use {
            InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot().compress(Bitmap.CompressFormat.PNG, 100, it)
        }
    }
}
