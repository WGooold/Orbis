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
import org.junit.Rule
import org.junit.Test

class ChatViewportInstrumentedTest {
    @get:Rule val compose = createComposeRule()
    private val json = Json { encodeDefaults = true }
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
                OrbisTheme { ChatScreen(displayed.value, model, scroll) }
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
