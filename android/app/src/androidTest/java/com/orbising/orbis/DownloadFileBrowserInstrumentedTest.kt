// Orbis 测试用途（场景与判定见本文件断言）：
// - 下载 / 文件（S09、S15、S20、S21、M13、V19、FILE-BROWSER-01、FILE-BROWSER-02）
package com.orbising.orbis

import android.graphics.Bitmap
import android.os.SystemClock
import android.view.KeyEvent
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import com.orbising.orbis.LegacyProtocolConnectionChecks.StrictPeer
import java.io.File
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class DownloadFileBrowserInstrumentedTest {
    @get:Rule val compose = createComposeRule()

    // CHAT-PATH-02: a directory has a separate reference action, while tapping its row still navigates.
    @Test fun computerPathPickerCanReferenceDirectoryWithoutNavigatingIntoIt() {
        val state = RemoteState(
            connection = RelayConnection.ONLINE,
            e2eReady = true,
            hostId = "host",
            sessionBrowse = SessionBrowseState(
                requestId = "root",
                path = "D:\\",
                entries = listOf(SessionBrowseEntry("Projects", isDir = true, hasSessions = false)),
                isLoading = false,
                forDownload = true,
            ),
        )
        val navigated = mutableListOf<String>()
        val referenced = mutableListOf<String>()
        compose.setContent {
            OrbisTheme {
                DownloadFileSheet(
                    state = state,
                    onDismiss = {},
                    onBrowse = {},
                    onBrowseInto = { navigated += it },
                    onBrowseUp = {},
                    onDownload = {},
                    onOpen = {},
                    onSelectPath = referenced::add,
                )
            }
        }

        val referenceDirectory = compose.onNodeWithTag("remote-directory-reference-Projects")
        referenceDirectory.assertExists()
        referenceDirectory.performClick()
        referenceDirectory.assertIsSelected()
        compose.onNodeWithText("引用到输入框").assertIsEnabled().performClick()
        compose.runOnIdle {
            assertTrue(navigated.isEmpty())
            assertEquals(listOf("D:\\Projects"), referenced)
        }
    }

    @Test fun downloadPickerJumpsToEnteredPathAndDownloadsMultipleSelectedFiles() {
        val state = mutableStateOf(RemoteState(connection = RelayConnection.ONLINE, e2eReady = true))
        val downloads = mutableListOf<String>()
        val visited = mutableListOf<String?>()
        fun browse(path: String?) {
            visited += path
            val failed = path == "D:\\missing"
            val entries = when (path) {
                null, "" -> listOf(SessionBrowseEntry("D:\\", true, false))
                "D:\\" -> listOf(SessionBrowseEntry("build output", true, false))
                "D:\\missing" -> emptyList()
                else -> listOf(SessionBrowseEntry("应用 v1.apk", false, false), SessionBrowseEntry("notes.txt", false, false))
            }
            state.value = state.value.copy(lastDownloadBrowserPath = if (failed) state.value.lastDownloadBrowserPath else path,
                sessionBrowse = SessionBrowseState(
                requestId = "request-${visited.size}", path = path,
                parent = if (path == "D:\\build output") "D:\\" else null,
                entries = entries, isLoading = false, forDownload = true,
                error = if (failed) "目录不可读" else null,
            ))
        }
        compose.setContent { OrbisTheme { AllDownloadsScreen(
            state = state.value, onBack = {}, onBrowse = ::browse,
            onBrowseInto = { name -> browse(remoteBrowsePath(state.value.sessionBrowse?.path, name)) },
            onBrowseUp = { browse(state.value.sessionBrowse?.parent) },
            onDismissBrowse = { state.value = state.value.copy(sessionBrowse = null) },
            onDownload = downloads::add, onRetry = {}, onCancel = {}, onDelete = {},
            onOpenBrowse = { browse(state.value.lastDownloadBrowserPath) },
        ) } }
        compose.onAllNodes(hasSetTextAction()).onFirst().performTextInput("D:\\quick.txt")
        compose.onNodeWithContentDescription("按路径下载").performClick()
        compose.onNodeWithText("浏览电脑文件").performClick()
        compose.onAllNodes(hasSetTextAction()).onLast().performTextInput("D:\\build output")
        compose.onNodeWithTag("remote-directory-jump").performClick()
        compose.onNodeWithText("应用 v1.apk").performClick()
        compose.onNodeWithText("notes.txt").performClick()
        compose.onNodeWithText("下载所选 2 个文件").assertIsEnabled()
        capture("download-multi-select.png")
        compose.onNodeWithText("下载所选 2 个文件").performClick()
        compose.onNodeWithText("选择电脑上的文件").assertDoesNotExist()
        compose.runOnIdle {
            assertEquals(listOf("D:\\quick.txt", "D:\\build output\\应用 v1.apk", "D:\\build output\\notes.txt"), downloads)
            assertEquals("D:\\build output", visited.last())
            assertEquals("D:\\build output", state.value.lastDownloadBrowserPath)
        }
        compose.onNodeWithText("浏览电脑文件").performClick()
        compose.onNodeWithText("应用 v1.apk").assertExists()
        compose.onNodeWithText("下载到手机").assertIsNotEnabled()
        compose.onNodeWithText("notes.txt").performClick()
        sendBack()
        compose.onNodeWithText("选择电脑上的文件").assertDoesNotExist()
        compose.onNodeWithText("浏览电脑文件").performClick()
        compose.onNodeWithText("notes.txt").assertIsNotSelected()
        compose.onAllNodes(hasSetTextAction()).onLast().performTextReplacement("D:\\missing")
        compose.onNodeWithTag("remote-directory-jump").performClick()
        compose.onNodeWithText("目录不可读").assertIsDisplayed()
        sendBack()
        compose.onNodeWithText("选择电脑上的文件").assertDoesNotExist()
        compose.onNodeWithText("浏览电脑文件").performClick()
        compose.onNodeWithText("应用 v1.apk").assertExists()
        compose.runOnIdle {
            assertEquals(listOf(null, "D:\\build output", "D:\\build output", "D:\\build output", "D:\\missing", "D:\\build output"), visited)
            assertEquals(3, downloads.size)
        }
    }

    /** FILE-BROWSER-02: use a real connection, encrypted reply and preferences, then recreate the connection. */
    @Test fun downloadBrowserRestoresPersistedHostPathAfterConnectionRecreation() {
        val app = IsolatedTestApplication(ApplicationProvider.getApplicationContext(), prefix = "download-resume")
        val scope = CoroutineScope(Dispatchers.Main + SupervisorJob())
        val server = MockWebServer()
        val peer = StrictPeer(PROTOCOL_VERSION)
        val restartedPeer = StrictPeer(PROTOCOL_VERSION)
        var owner: HostConnection? = null
        try {
            server.enqueue(MockResponse().withWebSocketUpgrade(peer))
            server.enqueue(MockResponse().withWebSocketUpgrade(restartedPeer))
            server.start()
            val pairing = HostPairing("host", "Desktop", "pub", Crypto.toBase64Url(StrictPeer.psk()),
                relayUrl = "ws://127.0.0.1:${server.port}", deviceId = "phone", credential = "fixture")

            fun start(): HostConnection = compose.runOnIdle {
                HostConnection(app, scope, pairing, HostStores(app), { X25519KeyPair.generate() }, {}).also { owner = it }
            }.also { connection -> await { connection.state.value.e2eReady && connection.state.value.connection == RelayConnection.ONLINE } }
            fun request(peer: StrictPeer, path: String?): String {
                val until = SystemClock.elapsedRealtime() + 5_000
                while (SystemClock.elapsedRealtime() < until) {
                    val message = peer.received.poll(200, TimeUnit.MILLISECONDS) ?: continue
                    val payload = E2eJson.json.parseToJsonElement(message.second.toString(Charsets.UTF_8)).jsonObject
                    if (payload["type"] != JsonPrimitive("session.browse")) continue
                    assertEquals(path, payload["path"]?.jsonPrimitive?.contentOrNull)
                    assertEquals(if (path == null) setOf("type", "protocolVersion", "requestId") else setOf("type", "protocolVersion", "requestId", "path"), payload.keys)
                    return payload.getValue("requestId").jsonPrimitive.content
                }
                error("No browse request for $path; peer errors=${peer.errors}")
            }
            fun listing(peer: StrictPeer, id: String, path: String, child: String? = null) = peer.sendJson(buildJsonObject {
                put("type", "session.browse.result"); put("requestId", id); put("path", path)
                put("entries", buildJsonArray { if (child != null) add(buildJsonObject {
                    put("name", child); put("isDir", true); put("hasSessions", false)
                }) })
            }.toString())

            val first = start()
            val paths = DownloadBrowserPathStore(app)
            compose.runOnIdle { first.openDownloadBrowser() }
            val root = request(peer, null)
            listing(peer, root, "")
            await { paths.load("host") == "" }
            compose.runOnIdle { first.browseDownloadDirectory("/tmp/../build output") }
            val saved = request(peer, "/tmp/../build output")
            listing(peer, saved, "/build output", child = "reports")
            await { paths.load("host") == "/build output" }
            compose.runOnIdle { first.browseInto("reports", forDownload = true) }
            val child = request(peer, "/build output/reports")
            listing(peer, child, "/build output/reports")
            await { paths.load("host") == "/build output/reports" }
            compose.runOnIdle { first.browseDownloadDirectory("/missing") }
            val failed = request(peer, "/missing")
            peer.sendJson(buildJsonObject {
                put("type", "protocol.error"); put("requestId", failed); put("code", "session_request_failed"); put("message", "目录不可读")
            }.toString())
            await { first.state.value.sessionBrowse?.error != null }
            listing(peer, failed, "/late")
            compose.runOnIdle { first.browseSessions("/new-session") }
            val workspace = request(peer, "/new-session")
            listing(peer, workspace, "/new-session")
            await { first.state.value.sessionBrowse?.isLoading == false }
            assertEquals("/build output/reports", paths.load("host"))
            assertNull(paths.load("another-host"))
            compose.runOnIdle { first.shutdown() }
            val restored = start()
            compose.runOnIdle { restored.openDownloadBrowser() }
            request(restartedPeer, "/build output/reports")
            assertTrue(peer.errors.toString(), peer.errors.isEmpty())
            assertTrue(restartedPeer.errors.toString(), restartedPeer.errors.isEmpty())
        } finally {
            compose.runOnIdle { owner?.shutdown(); scope.cancel() }
            peer.socket?.close(1000, "test done")
            restartedPeer.socket?.close(1000, "test done")
            server.close()
            app.dispose()
        }
    }

    @Test fun longPressKeepsDownloadGeometryAndDeletionRequiresConfirmation() {
        val task = ArtifactDownload("one", "host", displayName = "应用安装包与说明文件.zip",
            sourcePath = "/repo/releases/应用安装包与说明文件.zip", status = "downloading")
        val state = RemoteState(hostId = "host", e2eReady = true, downloads = mapOf(task.taskId to task))
        val deleted = mutableListOf<Set<String>>()
        var paused = 0
        compose.setContent { OrbisTheme { AllDownloadsScreen(
            state = state, onBack = {}, onBrowse = {}, onBrowseInto = {}, onBrowseUp = {},
            onDismissBrowse = {}, onDownload = {}, onRetry = {}, onCancel = { paused++ }, onDelete = deleted::add,
        ) } }
        val card = compose.onNodeWithTag("download-card-one")
        val originalBounds = card.fetchSemanticsNode().boundsInRoot
        val originalTitle = compose.onNodeWithText(task.displayName, useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
        card.performTouchInput { longClick() }
        compose.onNodeWithText("已选择 1 项").assertIsDisplayed()
        assertEquals(originalBounds, card.fetchSemanticsNode().boundsInRoot)
        assertEquals(originalTitle, compose.onNodeWithText(task.displayName, useUnmergedTree = true).fetchSemanticsNode().boundsInRoot)
        card.assertIsSelected()
        capture("download-selection-stable.png")
        compose.onNodeWithContentDescription("删除所选下载").performClick()
        compose.onNodeWithText("删除下载记录与本机文件？").assertIsDisplayed()
        compose.onNodeWithText("取消").performClick()
        card.assertIsSelected()
        compose.runOnIdle { assertTrue(deleted.isEmpty()); assertEquals(0, paused) }
        compose.onNodeWithContentDescription("退出多选").performClick()
        assertEquals(originalBounds, card.fetchSemanticsNode().boundsInRoot)
        card.performClick()
        compose.runOnIdle { assertEquals(1, paused) }
        card.performTouchInput { longClick() }
        compose.onNodeWithContentDescription("删除所选下载").performClick()
        compose.onNodeWithText("删除 1 项").performClick()
        compose.runOnIdle { assertEquals(listOf(setOf("one")), deleted) }
    }

    @Test fun sessionBrowserFiltersFilesWhileFilePickerHandlesLoadingOfflineAndRetry() {
        val state = mutableStateOf(RemoteState(
            connection = RelayConnection.ONLINE, e2eReady = true,
            sessionBrowse = SessionBrowseState("list", "D:\\", entries = listOf(
                SessionBrowseEntry("work", true, true), SessionBrowseEntry("file.zip", false, false),
            ), isLoading = false, forDownload = true),
        ))
        val files = mutableStateOf(false)
        var retries = 0
        compose.setContent { OrbisTheme {
            if (!files.value) {
                RemoteDirectoryBrowser(state.value.sessionBrowse, true, {}, {}, {})
            } else {
                DownloadFileSheet(state.value, {}, { retries++ }, {}, {}, {})
            }
        } }
        compose.onNodeWithText("work").assertIsDisplayed()
        compose.onNodeWithText("file.zip").assertDoesNotExist()
        compose.runOnIdle { files.value = true }
        compose.onNodeWithText("file.zip").performClick()
        compose.onNodeWithText("下载到手机").assertIsEnabled()
        compose.runOnIdle { state.value = state.value.copy(connection = RelayConnection.RECONNECTING, e2eReady = false) }
        compose.onNodeWithText("下载到手机").assertIsNotEnabled()
        compose.onNode(hasSetTextAction() and hasText("D:\\")).assertIsDisplayed()
        compose.runOnIdle { state.value = state.value.copy(connection = RelayConnection.ONLINE, e2eReady = true,
            sessionBrowse = state.value.sessionBrowse!!.copy(isLoading = true)) }
        compose.onNodeWithText("下载到手机").assertIsNotEnabled()
        compose.runOnIdle { state.value = state.value.copy(sessionBrowse = state.value.sessionBrowse!!.copy(
            isLoading = false, error = "没有权限读取目录")) }
        compose.onNodeWithText("没有权限读取目录").assertIsDisplayed()
        compose.onNodeWithText("下载到手机").assertIsNotEnabled()
        val beforeRetry = retries
        compose.onNodeWithText("重新读取").performClick()
        compose.runOnIdle { assertEquals(beforeRetry + 1, retries) }
    }

    private fun capture(name: String) {
        compose.waitForIdle()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.uiAutomation.takeScreenshot()?.let { bitmap ->
            File(instrumentation.targetContext.getExternalFilesDir(null), name).outputStream().use {
                bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
            }
            bitmap.recycle()
        }
    }

    private fun sendBack() {
        InstrumentationRegistry.getInstrumentation().sendKeyDownUpSync(KeyEvent.KEYCODE_BACK)
        compose.waitForIdle()
    }

    private fun await(condition: () -> Boolean) {
        val deadline = SystemClock.elapsedRealtime() + 10_000
        while (!condition() && SystemClock.elapsedRealtime() < deadline) SystemClock.sleep(20)
        assertTrue("Timed out waiting for the directory browser", condition())
    }
}
