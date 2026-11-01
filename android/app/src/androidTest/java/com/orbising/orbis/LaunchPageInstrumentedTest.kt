package com.orbising.orbis

import android.graphics.Bitmap
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.lifecycle.ViewModelStore
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Rule
import org.junit.Test

/**
 * ADR-0049 §6.8 / V12 r27：新建 / 恢复会话立即进入聊天页（启动页）。启动中写的消息立即出现并标明在等会话启动；
 * 恢复已有会话时先显示本地缓存的历史（V13）。状态按 [HostConnection] 的同一组纯函数构造。
 */
class LaunchPageInstrumentedTest {
    @get:Rule val compose = createComposeRule()

    private fun capture(name: String) {
        val bitmap = compose.onRoot().captureToImage().asAndroidBitmap()
        val output = File(InstrumentationRegistry.getInstrumentation().targetContext.getExternalFilesDir(null), "$name.png")
        output.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private fun withChat(name: String, state: RemoteState, exercise: (MutableState<RemoteState>) -> Unit) {
        val app = IsolatedTestApplication(ApplicationProvider.getApplicationContext(), name)
        val owner = ViewModelStore()
        val model = RemoteViewModel(app)
        owner.put(name, model)
        val displayed = mutableStateOf(state)
        try {
            compose.setContent { OrbisTheme { ChatScreen(displayed.value, model) } }
            compose.waitForIdle()
            exercise(displayed)
        } finally {
            compose.runOnIdle { owner.clear() }
            app.dispose()
        }
    }

    private fun entry(id: String, parent: String?, role: String, text: String) = SessionGraphEntry(id, parent, "message",
        "2026-01-01T00:00:00.000Z", buildJsonObject {
            put("message", buildJsonObject { put("role", role); put("content", text) })
        })

    @Test fun aMessageWrittenWhileANewSessionStartsShowsAtOnceOnTheLaunchPage() {
        val launched = RemoteState(hostId = "launch-host", e2eReady = true)
            .createLaunch("request", mapOf("type" to "new", "agentKind" to "pi", "cwd" to "/repo/app"), "app", 0).first
            .ledgerWritten("request", 0)
        val launch = launched.ledger.operation("request")!!
        val state = launched.createWaitingSend("command", "message", "launch:request", "launch:request", "启动中就发出的消息", null,
            emptyList(), emptyList(), 0, configs = listOf(launch)).first
        withChat("launch-new", state) {
            compose.onNodeWithText("启动中就发出的消息").assertIsDisplayed()
            compose.onNodeWithText("等待会话启动").assertIsDisplayed()
            compose.onAllNodesWithText("启动中", substring = true).onFirst().assertExists()
            capture("launch-page-waiting-send")
        }
    }

    /** 启动页上正在输入时会话上线：输入框保持焦点，键盘不收起（与 iOS 的焦点交接一致）。 */
    @Test fun typingOnTheLaunchPageKeepsTheComposerFocusedWhenTheSessionComesOnline() {
        val launched = RemoteState(hostId = "launch-host", e2eReady = true)
            .createLaunch("request", mapOf("type" to "new", "agentKind" to "pi", "cwd" to "/repo/app"), "app", 0).first
            .ledgerWritten("request", 0)
        val landed = launched.copy(launching = null, selectedRuntimeId = "rt-new", ledger = launched.ledger.remove("request"),
            runtimes = mapOf("rt-new" to RuntimeSummary("rt-new", "app", "/repo/app", "idle", "s-new", agentKind = "pi")))
        withChat("launch-focus", launched) { displayed ->
            val composer = compose.onAllNodes(hasSetTextAction()).onFirst()
            composer.performClick()
            composer.performTextInput("启动中输入")
            composer.assertIsFocused()
            compose.runOnIdle { displayed.value = landed }
            compose.waitForIdle()
            compose.onAllNodes(hasSetTextAction()).onFirst().assertIsFocused()
        }
    }

    @Test fun resumingShowsTheCachedHistoryWhileTheSessionStarts() {
        // 本机缓存与线上同样带显示投影：历史按产出方解释好的显示条目渲染。
        val cached = listOf(ChatMessage("u1", "user", listOf(RemoteContent("text", "上次的问题")), 1),
            ChatMessage("a1", "assistant", listOf(RemoteContent("text", "上次的回答（本地缓存）")), 2))
        val graph = SessionGraph("old-session", listOf(
            entry("u1", null, "user", "上次的问题"),
            entry("a1", "u1", "assistant", "上次的回答（本地缓存）"),
        ).associateBy(SessionGraphEntry::entryId), SessionBranchCursor("a1"),
            display = cached.associate { it.messageId to DisplayEntry(it.messageId, it.messageId, "message", "message", message = it) })
        val base = RemoteState(hostId = "launch-host", e2eReady = true,
            sessions = mapOf("old-session" to SessionCatalogEntry("old-session", name = "旧会话", cwd = "/repo", agentKind = "pi", hasHistoryCache = true)),
            sessionGraphs = mapOf("old-session" to graph))
        val launched = base.createLaunch("request", mapOf("type" to "resume", "sessionId" to "old-session", "agentKind" to "pi"), "旧会话", 0).first
            .ledgerWritten("request", 0)
        val state = launched.createWaitingSend("command", "message", "launch:request", "old-session", "接着上次说", null,
            emptyList(), emptyList(), 0, configs = listOf(launched.ledger.operation("request")!!)).first
        withChat("launch-resume", state) {
            compose.onNodeWithText("上次的回答（本地缓存）").assertIsDisplayed()
            compose.onNodeWithText("上次的问题").assertIsDisplayed()
            compose.onNodeWithText("接着上次说").assertIsDisplayed()
            compose.onNodeWithText("等待会话启动").assertIsDisplayed()
            capture("launch-page-resume-cached")
        }
    }
}
