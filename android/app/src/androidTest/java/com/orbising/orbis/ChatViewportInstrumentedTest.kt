package com.orbising.orbis

import android.app.Application
import android.content.Context
import android.content.SharedPreferences
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeDown
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.material3.MaterialTheme
import androidx.lifecycle.ViewModelStore
import androidx.test.core.app.ApplicationProvider
import java.io.File
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class ChatViewportInstrumentedTest {
    @get:Rule val compose = createComposeRule()
    private val json = Json { encodeDefaults = true }
    private var lineHeightPx = 0f
    private fun canonical(message: ChatMessage, parent: String?) = SessionGraphEntry(message.messageId, parent, "message", "1",
        buildJsonObject { put("message", json.encodeToJsonElement(ChatMessage.serializer(), message)) })
    private fun text(id: String, role: String, body: String) = ChatMessage(id, role, listOf(RemoteContent("text", body)), 1)
    private fun tool(id: String) = ChatMessage(id, "assistant", listOf(RemoteContent("tool_call", toolCallId = id,
        toolName = "bash", arguments = buildJsonObject { put("command", "echo test") })), 1)

    private class IsolatedApplication(base: Context) : Application() {
        private val prefix = "viewport-${UUID.randomUUID()}"
        private val root = File(base.filesDir, prefix).apply { mkdirs() }
        private val preferences = mutableSetOf<String>()
        init { attachBaseContext(base) }
        override fun getApplicationContext(): Context = this
        override fun getFilesDir(): File = root
        override fun getCacheDir(): File = File(root, "cache").apply { mkdirs() }
        override fun getNoBackupFilesDir(): File = File(root, "no-backup").apply { mkdirs() }
        override fun getSharedPreferences(name: String, mode: Int): SharedPreferences {
            val isolated = "$prefix-$name"
            preferences += isolated
            return baseContext.getSharedPreferences(isolated, mode)
        }
        fun dispose() {
            preferences.forEach { baseContext.deleteSharedPreferences(it) }
            root.deleteRecursively()
        }
    }

    private fun initial(): RemoteState {
        val user = text("user", "user", "question")
        val assistant = text("assistant", "assistant", (1..70).joinToString("\n\n") { "reading line $it" })
        return RemoteState(selectedRuntimeId = "r", runtimes = mapOf("r" to RuntimeSummary("r", "R", "/", "running", "s",
            sessionGraphSync = true, sessionLeafId = "assistant")),
            conversations = mapOf("r" to RuntimeConversation(messages = listOf(user, assistant, tool("tool-1")),
                streamingMessageIds = setOf("tool-1"), sourceEpoch = "epoch", sourceSeq = 1, sourceHeadLeafId = "assistant",
                hasLiveSnapshot = true, activeTurnId = "turn", turnTimings = mapOf("turn" to TurnTiming("turn", 1)))),
            sessionGraphs = mapOf("s" to fixtureGraph("s", listOf(canonical(user, null), canonical(assistant, "user")))))
    }

    private fun withChat(exercise: (androidx.compose.runtime.MutableState<RemoteState>, LazyListState) -> Unit) {
        val app = IsolatedApplication(ApplicationProvider.getApplicationContext())
        val owner = ViewModelStore()
        val model = RemoteViewModel(app)
        owner.put("viewport", model)
        val displayed = mutableStateOf(initial())
        val scroll = LazyListState()
        lateinit var scope: CoroutineScope
        try {
            compose.setContent {
                scope = rememberCoroutineScope()
                OrbisTheme {
                    lineHeightPx = with(LocalDensity.current) { MaterialTheme.typography.bodyLarge.lineHeight.toPx() }
                    ChatScreen(displayed.value, model, scroll)
                }
            }
            compose.waitForIdle()
            // A real drag opts out of following before placing the reading anchor.
            compose.onNodeWithTag("chat-transcript").performTouchInput { swipeDown() }
            compose.waitForIdle()
            compose.runOnIdle { scope.launch { scroll.scrollToItem(2, 350) } }
            compose.waitForIdle()
            assertEquals(2, scroll.firstVisibleItemIndex)
            assertEquals("layout=${scroll.layoutInfo.visibleItemsInfo.map { Triple(it.index, it.offset, it.size) }} viewport=${scroll.layoutInfo.viewportEndOffset} padding=${scroll.layoutInfo.afterContentPadding}", 350, scroll.firstVisibleItemScrollOffset)
            exercise(displayed, scroll)
        } finally {
            compose.runOnIdle { owner.clear() }
            app.dispose()
        }
    }

    @Test fun repeatedToolCommitsKeepTheReadingPositionInsideALongAssistantCard() = withChat { displayed, scroll ->
        val reducer = FixtureRelayReducer()
        for (number in 1..8) {
            val before = displayed.value
            val call = tool("tool-$number")
            val result = text("tool-$number:result", "tool", "complete output $number").copy(toolCallId = call.messageId)
            val seq = before.conversations.getValue("r").sourceSeq + 1
            val patch = SessionPatch(sessionId = "s", source = SessionSourceEpoch("epoch", seq, true), baseSeq = seq - 1, seq = seq,
                checkpointId = "epoch:$seq", head = SessionBranchCursor(result.messageId), headCompleteness = "complete",
                entries = listOf(canonical(call, before.conversations.getValue("r").sourceHeadLeafId), canonical(result, call.messageId)),
                live = SessionLiveState(true, turn = SessionLiveTurn("turn", 1), messages = listOf(
                    SessionLiveMessage(tool("tool-${number + 1}"), false, true))))
            compose.runOnIdle {
                displayed.value = reducer.reduce(before, """{"type":"runtime.event","runtimeId":"r","sequence":$seq,"event":${json.encodeToString(patch)}}""")
            }
            compose.waitForIdle()
            assertFalse(displayed.value.conversations.getValue("r").isChatSyncing)
            assertEquals(2, scroll.firstVisibleItemIndex)
            assertEquals("layout=${scroll.layoutInfo.visibleItemsInfo.map { Triple(it.index, it.offset, it.size) }} viewport=${scroll.layoutInfo.viewportEndOffset} padding=${scroll.layoutInfo.afterContentPadding}", 350, scroll.firstVisibleItemScrollOffset)
        }
    }

    @Test fun recoveryThroughAnEmptyProjectionRestoresTheOriginalReadingPosition() = withChat { displayed, scroll ->
        val previous = displayed.value
        compose.runOnIdle { displayed.value = previous.copy(conversations = previous.conversations.mapValues { (_, conversation) ->
            conversation.copy(messages = emptyList(), isChatSyncing = true, revision = conversation.revision + 1)
        }) }
        compose.waitForIdle()
        compose.runOnIdle { displayed.value = previous.copy(conversations = previous.conversations.mapValues { (_, conversation) ->
            conversation.copy(revision = conversation.revision + 2)
        }) }
        compose.waitForIdle()
        assertEquals(2, scroll.firstVisibleItemIndex)
        assertEquals("layout=${scroll.layoutInfo.visibleItemsInfo.map { Triple(it.index, it.offset, it.size) }} viewport=${scroll.layoutInfo.viewportEndOffset} padding=${scroll.layoutInfo.afterContentPadding}", 350, scroll.firstVisibleItemScrollOffset)
    }

    @Test fun streamingGrowthInsideTheLastTallCardDoesNotPullTheReader() = withChat { displayed, scroll ->
        compose.runOnIdle {
            val before = displayed.value
            val conversation = before.conversations.getValue("r")
            val messages = conversation.messages.map { message ->
                if (message.messageId == "assistant") message.copy(content = listOf(RemoteContent("text",
                    message.content.first().text + "\n\n" + "new streaming line\n".repeat(30)))) else message
            }
            displayed.value = before.copy(conversations = mapOf("r" to conversation.copy(messages = messages,
                revision = conversation.revision + 1)))
        }
        compose.waitForIdle()
        assertEquals(2, scroll.firstVisibleItemIndex)
        assertEquals("layout=${scroll.layoutInfo.visibleItemsInfo.map { Triple(it.index, it.offset, it.size) }} viewport=${scroll.layoutInfo.viewportEndOffset} padding=${scroll.layoutInfo.afterContentPadding}", 350, scroll.firstVisibleItemScrollOffset)
        compose.onNodeWithContentDescription("回到最新消息").assertIsDisplayed().performClick()
        compose.waitForIdle()
        compose.runOnIdle {
            val before = displayed.value
            val conversation = before.conversations.getValue("r")
            displayed.value = before.copy(conversations = mapOf("r" to conversation.copy(messages = conversation.messages.map {
                if (it.messageId == "assistant") it.copy(content = listOf(RemoteContent("text", it.content.first().text + "\nfollowed tail"))) else it
            }, revision = conversation.revision + 1)))
        }
        compose.waitForIdle()
        val layout = scroll.layoutInfo
        val last = layout.visibleItemsInfo.last()
        org.junit.Assert.assertTrue(chatBottomDistance(last.index, layout.totalItemsCount,
            last.offset + last.size, layout.viewportEndOffset, layout.afterContentPadding) < 2f)
    }

    @Test fun newMessagesAndToolsKeepTheAnchorDuringAnActiveDragInEitherDirection() = withChat { displayed, scroll ->
        val transcript = compose.onNodeWithTag("chat-transcript")
        transcript.performTouchInput { down(center); moveBy(Offset(0f, 60f)) }
        compose.waitForIdle()
        compose.mainClock.autoAdvance = false
        try {
            for (number in 1..6) {
                val index = scroll.firstVisibleItemIndex
                val offset = scroll.firstVisibleItemScrollOffset
                compose.runOnIdle {
                    val before = displayed.value
                    val conversation = before.conversations.getValue("r")
                    displayed.value = before.copy(conversations = mapOf("r" to conversation.copy(
                        messages = conversation.messages.map { message ->
                            if (message.messageId == "assistant") message.copy(content = listOf(RemoteContent("text",
                                message.content.first().text + "\n\nstreamed paragraph $number"))) else message
                        } + text("new-user-$number", "user", "new message $number"),
                        tools = conversation.tools + ("orphan-$number" to ToolActivity("orphan-$number", "bash", "running")),
                        revision = conversation.revision + 1)))
                }
                // Check successive rendered frames, so a one-frame jump followed by a
                // corrective scroll cannot masquerade as a stable final idle position.
                repeat(3) { frame ->
                    compose.mainClock.advanceTimeByFrame()
                    compose.waitForIdle()
                    assertEquals(index, scroll.firstVisibleItemIndex)
                    assertEquals("incoming update $number, frame $frame moved a held viewport", offset, scroll.firstVisibleItemScrollOffset)
                }
                val movement = if (number <= 3) -28f else 28f
                transcript.performTouchInput { moveBy(Offset(0f, movement), delayMillis = 100) }
                compose.mainClock.advanceTimeByFrame()
                compose.waitForIdle()
                assertEquals(index, scroll.firstVisibleItemIndex)
                assertEquals("user motion must remain responsive", offset - movement.toInt(), scroll.firstVisibleItemScrollOffset)
            }
        } finally {
            compose.mainClock.autoAdvance = true
            transcript.performTouchInput { advanceEventTime(200); up() }
        }
        compose.waitForIdle()
        compose.onNodeWithContentDescription("回到最新消息").assertIsDisplayed()
    }

    @Test fun restoringAPageAfterTheReaderMovesDoesNotReplayTheOldAnchor() = withChat { displayed, scroll ->
        compose.runOnIdle { displayed.value = displayed.value.beginSessionRead("r", SessionReadKind.SOURCE, "refresh").state }
        compose.waitForIdle()
        compose.onNodeWithTag("chat-transcript").performTouchInput {
            down(center); moveBy(Offset(0f, -90f), delayMillis = 200); advanceEventTime(200); up()
        }
        compose.waitForIdle()
        val offset = scroll.firstVisibleItemScrollOffset
        assertTrue(offset > 350)
        compose.runOnIdle { displayed.value = displayed.value.finishHistoryRead("refresh", SessionReadPhase.SUCCEEDED) }
        compose.waitForIdle()
        assertEquals(2, scroll.firstVisibleItemIndex)
        assertEquals(offset, scroll.firstVisibleItemScrollOffset)
    }

    @Test fun oneLineResumesFollowingAndThreeLinesRevealTheJumpButton() = withChat { displayed, scroll ->
        val jump = compose.onNodeWithContentDescription("回到最新消息")
        val transcript = compose.onNodeWithTag("chat-transcript")
        fun dragDown(distance: Float) {
            transcript.performTouchInput {
                down(center); moveBy(Offset(0f, distance), delayMillis = 200); advanceEventTime(200); up()
            }
            compose.waitForIdle()
        }
        fun bottomDistance(): Float {
            val layout = scroll.layoutInfo
            val last = layout.visibleItemsInfo.last()
            return chatBottomDistance(last.index, layout.totalItemsCount, last.offset + last.size,
                layout.viewportEndOffset, layout.afterContentPadding)
        }
        jump.performClick()
        compose.waitForIdle()
        dragDown(lineHeightPx * 2.25f)
        assertTrue(bottomDistance() > lineHeightPx && bottomDistance() < lineHeightPx * 3)
        jump.assertDoesNotExist()
        dragDown(lineHeightPx * 2)
        assertTrue(bottomDistance() > lineHeightPx * 3)
        jump.assertIsDisplayed().performClick()
        compose.waitForIdle()
        dragDown(lineHeightPx * 0.75f)
        assertTrue(bottomDistance() < lineHeightPx)
        compose.runOnIdle {
            val before = displayed.value
            val conversation = before.conversations.getValue("r")
            displayed.value = before.copy(conversations = mapOf("r" to conversation.copy(
                messages = conversation.messages + text("threshold-new", "user", "new tail after returning within one line"),
                revision = conversation.revision + 1)))
        }
        compose.waitForIdle()
        assertTrue(bottomDistance() < 2f)
        jump.assertDoesNotExist()
    }

    @Test fun incomingRowsDoNotInterruptOrAccelerateTheReadersFling() = withChat { displayed, scroll ->
        compose.mainClock.autoAdvance = false
        try {
            compose.onNodeWithTag("chat-transcript").performTouchInput {
                down(center)
                moveBy(Offset(0f, -60f), delayMillis = 16)
                moveBy(Offset(0f, -60f), delayMillis = 16)
                up()
            }
            compose.mainClock.advanceTimeByFrame()
            compose.waitForIdle()
            var before = scroll.firstVisibleItemScrollOffset
            compose.mainClock.advanceTimeByFrame()
            compose.waitForIdle()
            var previousDelta = scroll.firstVisibleItemScrollOffset - before
            assertTrue(previousDelta > 0)
            repeat(6) { number ->
                before = scroll.firstVisibleItemScrollOffset
                compose.runOnIdle {
                    val state = displayed.value
                    val conversation = state.conversations.getValue("r")
                    displayed.value = state.copy(conversations = mapOf("r" to conversation.copy(
                        messages = conversation.messages + text("fling-$number", "user", "new message during inertia"),
                        revision = conversation.revision + 1)))
                }
                compose.mainClock.advanceTimeByFrame()
                compose.waitForIdle()
                val delta = scroll.firstVisibleItemScrollOffset - before
                assertEquals(2, scroll.firstVisibleItemIndex)
                assertTrue("A layout update reversed or accelerated the fling: $previousDelta -> $delta", delta in 0..previousDelta + 2)
                assertTrue("A layout restoration cancelled native inertia", scroll.isScrollInProgress)
                previousDelta = delta
            }
        } finally {
            compose.mainClock.autoAdvance = true
        }
        compose.waitForIdle()
    }

    @Test fun toolAndThinkingStayExpandedWhenOutputAndCanonicalResultArrive() {
        val thinking = text("thinking", "assistant", "thinking prefix").copy(content = listOf(RemoteContent("thinking", "thinking prefix")))
        val messages = mutableStateOf(listOf(thinking, tool("call")))
        val results = mutableStateOf(emptyMap<String, ChatMessage>())
        compose.setContent {
            OrbisTheme {
                AssistantTurnCard("r", messages.value, null, 1, emptyMap(), results.value, emptyMap(), {}, {})
            }
        }
        compose.onNodeWithText("bash").performClick()
        compose.runOnIdle { results.value = mapOf("call" to text("call:result", "tool", "canonical result body")) }
        compose.onNodeWithText("canonical result body", substring = true).assertIsDisplayed()
        compose.onNodeWithText("bash").performClick()
        compose.onNodeWithText("思考").performClick()
        compose.runOnIdle { messages.value = listOf(thinking.copy(content = listOf(RemoteContent("thinking", "thinking prefix plus suffix"))), tool("call")) }
        compose.onNodeWithText("thinking prefix plus suffix").assertIsDisplayed()
        compose.onNodeWithContentDescription("收起").assertIsDisplayed()
    }
}
