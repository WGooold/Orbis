// Orbis 测试用途（场景与判定见本文件断言）：
// - 需要隔离 Host（V20）
package com.orbising.orbis

import android.content.Context
import android.view.Choreographer
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.test.core.app.ActivityScenario
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.lifecycle.ViewModelStore
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * UI-02 capture harness (ADR-0057): pairs with the isolated Host rig, opens a real agent session
 * in the rig's workspace, renders the production chat and logs every frame — list rows (key,
 * offset, height), follow position and the tool / message facts behind them — while a real tool
 * runs. The log is lined up with a screen recording to find what each flicker frame changed.
 *
 * Diagnostic capture only: opt in with `captureTools=true`, `pairingPayloadBase64`, `cwd`;
 * optional `agentKind`, `prompt`, `seconds`. Add `assertStable=true` to verify tool completion
 * and transcript stability. Pairing and session data are isolated and removed after capture.
 */
@RunWith(AndroidJUnit4::class)
class ToolContinuityCaptureInstrumentedTest {
    @Test fun captureRunningToolsFromTheIsolatedHost() {
        val arguments = InstrumentationRegistry.getArguments()
        assumeTrue("Diagnostic capture requires captureTools=true", arguments.getString("captureTools") == "true")
        val raw = arguments.getString("pairingPayloadBase64")?.let {
            String(android.util.Base64.decode(it, android.util.Base64.URL_SAFE or android.util.Base64.NO_WRAP))
        }
        val cwd = arguments.getString("cwd")
        assumeTrue("capture harness: pass pairingPayloadBase64 and cwd", raw != null && cwd != null)
        val payload = Json.parseToJsonElement(raw!!).jsonObject
        val relayUrl = payload["relayUrl"]!!.jsonPrimitive.content
        val code = payload["code"]!!.jsonPrimitive.content
        val hostId = payload["hostId"]!!.jsonPrimitive.content
        val agent = arguments.getString("agentKind") ?: "pi"
        val prompt = arguments.getString("promptBase64")?.let {
            String(android.util.Base64.decode(it, android.util.Base64.URL_SAFE or android.util.Base64.NO_WRAP))
        } ?: arguments.getString("prompt")
            ?: "请用 shell 工具执行：for i in \$(seq 1 150); do echo line \$i; sleep 0.04; done ；完成后再执行：ls -la ；最后只回复 done"
        val seconds = arguments.getString("seconds")?.toLongOrNull() ?: 90L
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val base = ApplicationProvider.getApplicationContext<Context>()
        val app = IsolatedTestApplication(base, prefix = "tool-capture")
        val owner = ViewModelStore()
        lateinit var model: RemoteViewModel
        val frames = StringBuilder()
        val list = LazyListState()
        var sawRealToolActivity = false
        var highestTranscriptCount = 0
        var transcriptShrankDuringTurn = false
        var scenario: ActivityScenario<ComponentActivity>? = null
        try {
            instrumentation.runOnMainSync {
                model = RemoteViewModel(app)
                owner.put("capture", model)
                model.pair(relayUrl, code, raw)
            }
            waitFor(180_000, "host ready") { model.state.value.hostId == hostId && model.state.value.e2eReady }
            // Headless: no terminal window opens on the computer, and the agent ends with the rig's Host.
            instrumentation.runOnMainSync { check(model.createSession(agent, cwd!!, hostId, spawnMode = "headless")) { "session not created" } }
            waitFor(120_000, "runtime online") {
                model.state.value.runtimes.values.any { it.cwd == cwd && it.agentKind == agent && !it.sessionId.isNullOrBlank() }
            }
            val runtimeId = model.state.value.runtimes.values.first { it.cwd == cwd && it.agentKind == agent }.runtimeId
            instrumentation.runOnMainSync { model.openRuntime(hostId, runtimeId) }
            // A plain activity on the real frame clock, like the app: a test clock would only
            // advance while the test waits on it, freezing the chat between checks.
            scenario = ActivityScenario.launch(ComponentActivity::class.java)
            scenario.onActivity { activity ->
                activity.setContent {
                    val state by model.state.collectAsState()
                    OrbisTheme { AgentTheme(agentBrand(agent)) { ChatScreen(state, model, list) } }
                }
            }
            waitFor(60_000, "chat ready") { model.state.value.selectedRuntimeId == runtimeId && model.state.value.runtimes[runtimeId]?.status == "idle" }
            Thread.sleep(2_000)
            // Record from the frame callback, outside composition, so Compose itself never looks busy.
            val recorder = object : Choreographer.FrameCallback {
                var recording = true
                override fun doFrame(time: Long) {
                    val snapshot = model.state.value
                    val conversation = snapshot.conversations[runtimeId]
                    val count = conversation?.messages?.size ?: 0
                    val hasToolActivity = conversation?.tools?.isNotEmpty() == true || conversation?.messages.orEmpty().any { message ->
                        message.content.any { it.type == "tool_call" && it.toolCallId != null }
                    }
                    if (snapshot.runtimes[runtimeId]?.status == "running" && hasToolActivity) {
                        sawRealToolActivity = true
                    }
                    if (snapshot.runtimes[runtimeId]?.status == "running" && count < highestTranscriptCount) {
                        transcriptShrankDuringTurn = true
                    }
                    highestTranscriptCount = maxOf(highestTranscriptCount, count)
                    frames.append(frame(time, snapshot, runtimeId, list)).append('\n')
                    if (recording) Choreographer.getInstance().postFrameCallback(this)
                }
            }
            instrumentation.runOnMainSync {
                Choreographer.getInstance().postFrameCallback(recorder)
                model.sendMessage(prompt)
            }
            val end = System.currentTimeMillis() + seconds * 1_000
            var screenshot = 0
            val directory = File(base.getExternalFilesDir(null), "tool-capture").apply { mkdirs() }
            while (System.currentTimeMillis() < end) {
                Thread.sleep(500)
                if (screenshot < 6 && System.currentTimeMillis() >= end - (seconds - screenshot * 5) * 1_000) {
                    instrumentation.uiAutomation.takeScreenshot()?.let { bitmap ->
                        File(directory, "capture-$agent-${screenshot++}.png").outputStream().use {
                            bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it)
                        }
                    }
                }
            }
            instrumentation.runOnMainSync { recorder.recording = false }
            if (arguments.getString("assertStable") == "true") {
                check(sawRealToolActivity) { "The backend produced no real tool activity in captured frames" }
                check(model.state.value.runtimes[runtimeId]?.status == "idle") { "The real backend did not finish the turn" }
                check(highestTranscriptCount >= 2) { "The real backend produced no visible transcript" }
                check(!transcriptShrankDuringTurn) { "The visible transcript was truncated during the tool turn" }
            }
        } finally {
            val directory = File(base.getExternalFilesDir(null), "tool-capture").apply { mkdirs() }
            File(directory, "frames-$agent.ndjson").writeText(frames.toString())
            scenario?.close()
            instrumentation.runOnMainSync { owner.clear() }
            app.dispose()
        }
    }

    private fun waitFor(timeoutMs: Long, what: String, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (!condition()) {
            check(System.currentTimeMillis() < deadline) { "timed out waiting for $what" }
            Thread.sleep(250)
        }
    }

    private fun frame(time: Long, state: RemoteState, runtimeId: String, list: LazyListState): String {
        val layout = list.layoutInfo
        val conversation = state.conversations[runtimeId]
        val rows = layout.visibleItemsInfo.joinToString(",") { "[\"${it.key}\",${it.offset},${it.size}]" }
        val tools = conversation?.tools?.values.orEmpty().joinToString(",") {
            "[\"${it.toolCallId}\",\"${it.state}\",${it.detail?.length ?: 0}]"
        }
        val messages = conversation?.messages.orEmpty().takeLast(4).joinToString(",") { message ->
            val blocks = message.content.joinToString(",") { "\"${it.type}:${it.toolCallId ?: ""}:${it.text?.length ?: 0}\"" }
            "[\"${message.messageId}\",\"${message.role}\",[$blocks]]"
        }
        val streaming = conversation?.streamingMessageIds.orEmpty().joinToString(",") { "\"$it\"" }
        val sessionId = state.runtimes[runtimeId]?.sessionId
        val graph = sessionId?.let(state.sessionGraphs::get)
        val view = state.runtimeSessionViews[runtimeId]
        val parents = graph?.entries?.values.orEmpty().joinToString(",") {
            "[\"${it.entryId}\",\"${it.parentId}\"]"
        }
        val history = state.sessionHistory[runtimeId]
        val projection = "\"leaf\":\"${view?.leafId}\",\"graphEntries\":${graph?.entries?.size ?: -1},\"cursor\":\"${graph?.cursor?.leafId}\"," +
            "\"epoch\":\"${conversation?.sourceEpoch}\",\"syncing\":${conversation?.isChatSyncing},\"live\":${conversation?.hasLiveSnapshot}," +
            "\"sourceHead\":\"${conversation?.sourceHeadLeafId}\",\"sourceSeq\":${conversation?.sourceSeq},\"parents\":[$parents]," +
            "\"hasOlder\":${history?.hasOlder},\"oldest\":\"${history?.oldestEntryId}\"," +
            "\"revision\":${conversation?.revision},\"count\":${conversation?.messages?.size ?: 0},"
        return "{\"t\":$time,$projection\"first\":${list.firstVisibleItemIndex},\"firstOffset\":${list.firstVisibleItemScrollOffset}," +
            "\"total\":${layout.totalItemsCount},\"viewportEnd\":${layout.viewportEndOffset},\"canForward\":${list.canScrollForward}," +
            "\"status\":\"${state.runtimes[runtimeId]?.status}\",\"rows\":[$rows],\"tools\":[$tools],\"messages\":[$messages],\"streaming\":[$streaming]}"
    }
}
