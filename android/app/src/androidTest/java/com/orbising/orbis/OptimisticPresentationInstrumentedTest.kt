package com.orbising.orbis

import android.graphics.Bitmap
import android.net.Uri
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/**
 * ADR-0049 §6.4–§6.8 的呈现：结果在回执前出现，拒绝后回到原位（V22、V07、V10–V12）。状态由账本的纯状态函数构造，
 * 与 [HostConnection] 的写法一致；各种类的结算由单元测试覆盖。
 */
class OptimisticPresentationInstrumentedTest {
    @get:Rule val compose = createComposeRule()

    private fun capture(name: String) {
        val bitmap = compose.onRoot().captureToImage().asAndroidBitmap()
        val output = File(InstrumentationRegistry.getInstrumentation().targetContext.getExternalFilesDir(null), "$name.png")
        output.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    @Test fun answeringCollapsesThePanelIntoAnInPlaceSummaryAndARejectionBringsItBack() {
        val request = PendingInteraction("approval", "test", "confirm", "允许执行命令？", null, emptyList(), null)
        var responding by mutableStateOf(setOf("approval"))
        var status by mutableStateOf<Triple<String, Boolean, String?>?>(Triple("已允许", true, null))
        compose.setContent { OrbisTheme {
            InteractionWorkspace(listOf(request), connected = true, pendingCommands = emptySet(), error = null,
                respondConfirm = { _, _ -> }, respondValue = { _, _ -> }, respondValues = { _, _ -> },
                respondQuestionnaire = { _, _ -> }, onCancel = {}, responding = responding, status = status)
        } }
        compose.onNodeWithTag("interaction-status").assertIsDisplayed()
        compose.onNodeWithText("已允许").assertIsDisplayed()
        compose.onNodeWithText("允许执行命令？").assertDoesNotExist()
        capture("optimistic-respond-summary")
        compose.runOnIdle { responding = emptySet(); status = null }
        compose.onNodeWithText("允许执行命令？").assertIsDisplayed()
        compose.onNodeWithTag("interaction-status").assertDoesNotExist()
    }

    @Test fun aDismissedNoticeLeavesAtOnceAndTheOtherStays() {
        val json = Json { encodeDefaults = true }
        fun notice(id: String, message: String) = RuntimeNotice(id, "producer", id, "one", NoticeScope(), "warning", message, "condition", 1, 1, "confirmed")
        val payload = json.encodeToString(NoticeSnapshot("host", "runtime", "session", 1, true, "confirmed",
            listOf(notice("retry", "Reconnecting..."), notice("sandbox", "沙箱需要配置"))))
            .dropLast(1) + ",\"type\":\"notification.snapshot\",\"protocolVersion\":$PROTOCOL_VERSION}"
        val received = RelayReducer().reduce(RemoteState(notificationEpoch = "host", runtimes = mapOf(
            "runtime" to RuntimeSummary("runtime", "Codex", "D:/repo", "idle", "session"))), payload, channel = "ctl")
        val dismissed = received.createDismiss("op", "runtime", "retry", 0).first.dismissWritten("op", 0)
        compose.setContent { OrbisTheme {
            RuntimeNotifications(dismissed.visibleNotificationProjection("runtime")!!, "host", supported = true, onRecheck = null, onDismiss = {})
        } }
        compose.onNodeWithText("Reconnecting...").assertDoesNotExist()
        compose.onNodeWithText("沙箱需要配置").assertIsDisplayed()
    }

    @Test fun switchingShowsTheChosenModelWithItsMarkInTheSameSlot() {
        var label by mutableStateOf("默认模型")
        compose.setContent { OrbisTheme { ChatRuntimeStatus("idle", isChatSyncing = false, modelLabel = label, thinkingLevel = "high") } }
        compose.runOnIdle { label = "快速模型 · 切换中" }
        val node = compose.onNodeWithText("快速模型 · 切换中").assertIsDisplayed().fetchSemanticsNode()
        // V05：沿用原槽位与省略规则（模型标签最宽 132dp）。
        val density = InstrumentationRegistry.getInstrumentation().targetContext.resources.displayMetrics.density
        assertTrue(node.boundsInRoot.width <= 132.dp.value * density + 1f)
        capture("optimistic-model-switching")
    }

    @Test fun archivingMovesTheCardToTheArchiveAtOnce() {
        fun session(id: String) = SessionCatalogEntry(sessionId = id, name = id, cwd = "/repo", agentKind = "codex", archived = false)
        val base = RemoteState(hostId = "host", e2eReady = true, sessions = listOf("one", "two").associateWith(::session))
        var state by mutableStateOf(base)
        val host = HostPairing("host", "Test Host", "test-public", "test-root",
            relayUrl = "wss://relay.example", deviceId = "test-device", credential = "test-only")
        compose.setContent { OrbisTheme {
            SessionDrawer(state, listOf(HostSnapshot(host, state)), {}, {}, {}, { _, _ -> }, { _, _ -> }, { _, _ -> }, onSetArchived = { _, _, _ -> })
        } }
        compose.onNodeWithTag("drawer-session-two").assertIsDisplayed()
        compose.runOnIdle { state = base.createArchive("request", "two", "codex", true, 0).first.ledgerWritten("request", 0) }
        compose.onNodeWithTag("drawer-session-two").assertDoesNotExist()
        compose.onNodeWithTag("drawer-session-one").assertIsDisplayed()
        // 明确拒绝：卡片回到原列表。
        compose.runOnIdle { state = state.copy(ledger = state.ledger.remove("request")) }
        compose.onNodeWithTag("drawer-session-two").assertIsDisplayed()
    }

    /** V10 r27 / ADR-0049 §6.1：附件还在上传时发出的消息，气泡内显示缩略图、文件名与进度，进度随上传推进。 */
    @Test fun aMessageSentWhileUploadingShowsItsAttachmentsInTheBubble() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val image = File(context.cacheDir, "pending-thumbnail.png").apply {
            outputStream().use { out ->
                Bitmap.createBitmap(240, 160, Bitmap.Config.ARGB_8888).apply { eraseColor(0xFF5C8CF2.toInt()) }
                    .compress(Bitmap.CompressFormat.PNG, 100, out)
            }
        }
        val png = UploadTask("up-image", "runtime", "host", Uri.fromFile(image).toString(), "截图.png", 1000, "a".repeat(64),
            "/repo/.orbis-uploads", "image/png", status = "uploading", durableBytes = 300)
        val pdf = UploadTask("up-pdf", "runtime", "host", Uri.fromFile(File(context.cacheDir, "missing.pdf")).toString(), "报告.pdf",
            2000, "b".repeat(64), "/repo/.orbis-uploads", "application/pdf", status = "queued")
        val message = ChatMessage("local", "user", listOf(RemoteContent("text", "看看这两个文件")), 1)
        var uploads by mutableStateOf(listOf(png, pdf))
        compose.setContent { OrbisTheme {
            UserMessageCard("runtime", message, emptyMap(), {}, {}, pending = PendingSendState.Waiting("上传中：截图.png、报告.pdf"), uploads = uploads)
        } }
        compose.onNodeWithTag("pending-attachment-up-image").assertIsDisplayed()
        compose.onNodeWithTag("pending-attachment-up-pdf").assertIsDisplayed()
        compose.onNodeWithContentDescription("截图.png，发送中 30%").assertExists()
        compose.onNodeWithText("上传中：截图.png、报告.pdf").assertIsDisplayed()
        // 只有图片解码出缩略图；PDF 显示文件图标。
        compose.waitUntil(5_000) { compose.onAllNodesWithTag("pending-attachment-thumbnail", useUnmergedTree = true).fetchSemanticsNodes().size == 1 }
        capture("optimistic-upload-waiting-bubble")
        compose.runOnIdle { uploads = listOf(png.copy(durableBytes = 900), pdf) }
        compose.onNodeWithContentDescription("截图.png，发送中 90%").assertExists()
    }

    @Test fun aFailedLaunchOffersRetryAndBackInPlace() {
        val launch = LaunchState("request", "launch:request", mapOf("type" to "new", "agentKind" to "codex", "cwd" to "/repo/app"),
            "app", "/repo/app", "codex", resumed = null, failure = "对应的 agent 后端未就绪")
        val actions = mutableListOf<String>()
        compose.setContent { OrbisTheme { LaunchNotice(launch, onRetry = { actions += "retry" }, onBack = { actions += "back" }) } }
        compose.onNodeWithText("启动失败：对应的 agent 后端未就绪").assertIsDisplayed()
        compose.onNodeWithTag("launch-retry").performClick()
        compose.onNodeWithTag("launch-back").performClick()
        compose.runOnIdle { assertEquals(listOf("retry", "back"), actions) }
        capture("optimistic-launch-failed")
    }
}
