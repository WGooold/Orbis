package dev.pi.remote

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * 三种显示形态的设备侧核对（issue #12 验收）：压缩后重载、失败回合、带产物的自定义消息。
 *
 * 会话由 `scripts/session-sync-fixture.mjs --rich` 提供：真加密链路 + 真 SQLite + 真投影，
 * 条目是原生形状，解释完全来自协议层的显示投影（App 不认识这些形状）。
 *
 * 运行（先起 `node scripts/session-sync-fixture.mjs <dir> --rich`，拿端口）：
 * ```
 * $env:ANDROID_SERIAL='emulator-5554'
 * scripts\windows\android-build.ps1 :app:connectedDebugAndroidTest `
 *   "-Pandroid.testInstrumentationRunnerArguments.class=dev.pi.remote.DisplayScenariosInstrumentedTest" `
 *   "-Pandroid.testInstrumentationRunnerArguments.syncFixturePort=<port>"
 * ```
 */
@RunWith(AndroidJUnit4::class)
class DisplayScenariosInstrumentedTest {
    @Test
    fun compactionFailureAndArtifactRenderFromTheHostProjection() {
        val port = InstrumentationRegistry.getArguments().getString("syncFixturePort")
        assumeTrue("需要 -Pandroid.testInstrumentationRunnerArguments.syncFixturePort=<port>", port != null)
        val base = ApplicationProvider.getApplicationContext<Context>()
        val app = IsolatedTestApplication(base, prefix = "display-scenarios")
        val device = DeviceCredential("ws://10.0.2.2:$port", "sync-fixture-pi", "sync-fixture-pi")
        val runtimeId = "pi:slow-sync"
        val sessionId = "pi-session"
        CredentialStore(app).save(device)
        E2eIdentityStore(app).savePairedHost(
            HostIdentity("sync-fixture-host", "test-only", Crypto.toBase64Url(ByteArray(32) { 0x73 })),
        )
        val store = SessionGraphStore(app)
        val model = RemoteViewModel(app)
        try {
            InstrumentationRegistry.getInstrumentation().runOnMainSync { model.selectRuntime(runtimeId) }
            val deadline = System.currentTimeMillis() + 60_000
            fun messages() = model.state.value.conversations[runtimeId]?.messages.orEmpty()
            while (System.currentTimeMillis() < deadline &&
                messages().none { it.messageId == "r7" }
            ) {
                Thread.sleep(500)
            }

            val rendered = messages()
            val texts = rendered.map { message -> message.content.mapNotNull { it.text }.joinToString("\n") }

            // 1. 压缩：被裁掉的旧条目不再渲染，摘要渲染在窗口顶部（anchor=head），保留段与之后照旧。
            assertFalse("压缩裁掉的条目不应渲染：$texts", texts.any { it.contains("旧问题") })
            assertTrue("摘要应渲染在窗口顶部：$texts", texts.first().startsWith("压缩摘要："))
            assertTrue(texts.any { it.contains("保留的问题") })
            assertTrue(texts.any { it.contains("压缩之后的问题") })

            // 2. 失败回合：失败文案来自产出方（remoteFailure），不是 App 自己拼的。
            val failed = rendered.single { it.messageId == "r6" }
            assertEquals(true, failed.isError)
            assertTrue(
                "失败行应带产出方给的文案：${failed.content}",
                failed.content.any { it.type == "text" && it.text?.contains("SCENARIO_FAILURE_TEXT") == true },
            )

            // 3. 带产物的自定义消息：产物块由产出方拼进显示结果。
            val artifactRow = rendered.single { it.messageId == "r7" }
            assertEquals("custom", artifactRow.role)
            assertTrue(
                "自定义消息应带产物块：${artifactRow.content}",
                artifactRow.content.any { it.type == "artifact" && it.artifact?.fileName == "report.pdf" },
            )

            // 4. 落盘：7 条 canonical 条目都在，显示行只有窗口内的 5 条，窗口起点是保留段的第一条。
            val range = store.readBranch(device, sessionId, "r7", maxEntries = 50)
            assertEquals(7, range.entries.size)
            assertEquals(5, range.display.size)
            assertEquals("r3", range.displayWindowStart)
        } finally {
            InstrumentationRegistry.getInstrumentation().runOnMainSync { }
            app.dispose()
        }
    }
}
