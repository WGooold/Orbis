package com.orbising.orbis

import android.content.Context
import androidx.lifecycle.ViewModelStore
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * 用**隔离 Host 测试台**（`docs/testing/isolated-host/README.md`）配对：真 Relay 连接 + 真端到端
 * 握手 + 真落盘，但不碰这台模拟器上与用户电脑的既有配对（状态目录隔离）。
 *
 * 运行方式（先 `relay.ps1 -Action Start`，再 `pair-isolated-host.ps1` 拿载荷）：
 *
 * ```
 * $env:ANDROID_SERIAL='emulator-5554'
 * scripts\windows\android-build.ps1 :app:connectedDebugAndroidTest `
 *   "-Pandroid.testInstrumentationRunnerArguments.class=com.orbising.orbis.IsolatedHostPairingInstrumentedTest" `
 *   "-Pandroid.testInstrumentationRunnerArguments.pairingPayload=<载荷 JSON>"
 * ```
 *
 * 载荷里的 `relayUrl` 必须是**模拟器视角**的地址（本机 Relay 用 `ws://10.0.2.2:8787`）；
 * 隔离 Host 自己仍连 `127.0.0.1`，这一处由测试台脚本按 `-AdvertiseRelayUrl` 改写。
 */
@RunWith(AndroidJUnit4::class)
class IsolatedHostPairingInstrumentedTest {
    @Test
    fun pairsWithTheIsolatedHostRigUsingThePayloadItPrinted() {
        // 载荷里有引号：经 pwsh -File / gradlew.bat 传参会被拆坏，所以也接受 base64（URL-safe，无引号）。
        val arguments = InstrumentationRegistry.getArguments()
        val raw = arguments.getString("pairingPayload")
            ?: arguments.getString("pairingPayloadBase64")?.let { encoded ->
                runCatching {
                    String(android.util.Base64.decode(encoded, android.util.Base64.URL_SAFE or android.util.Base64.NO_WRAP))
                }.getOrNull()
            }
        assumeTrue(
            "需要 pairingPayload=<载荷 JSON> 或 pairingPayloadBase64=<URL-safe base64>",
            raw != null,
        )
        val payload = runCatching { Json.parseToJsonElement(raw!!).jsonObject }.getOrNull()
        assumeTrue("载荷不是合法 JSON 对象", payload != null)
        val relayUrl = payload!!["relayUrl"]?.jsonPrimitive?.content
        val code = payload["code"]?.jsonPrimitive?.content
        val hostId = payload["hostId"]?.jsonPrimitive?.content
        assumeTrue("载荷缺 relayUrl/code/hostId", relayUrl != null && code != null && hostId != null)
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val base = ApplicationProvider.getApplicationContext<Context>()
        // `pairIntoRealStorage=true` 写进 App 的真实存储：后续的跨端恢复验收需要一个真的连得上的
        // Host，而模拟器数据已清空、没有遗留凭据。默认仍是隔离目录（跑完就删）。
        val keepPairing = arguments.getString("pairIntoRealStorage") == "true"
        val app: android.app.Application =
            if (keepPairing) base as android.app.Application else IsolatedTestApplication(base, prefix = "isolated-host")
        val owner = ViewModelStore()
        lateinit var model: RemoteViewModel
        try {
            instrumentation.runOnMainSync {
                model = RemoteViewModel(app)
                owner.put("pairing", model)
                model.pair(relayUrl!!, code!!, raw)
            }

            // 配对成功＝Host 在完成端到端握手后把 state 发过来，所以这条断言覆盖了 Relay 可达、
            // 配对码有效、E2E 材料正确、以及隔离 Host 真的在跑。
            val deadline = System.currentTimeMillis() + 60_000
            while (System.currentTimeMillis() < deadline &&
                model.hosts.value.none { it.hostId == hostId } && model.pairingError.value == null
            ) {
                Thread.sleep(500)
            }
            assertNull("配对失败：${model.pairingError.value}", model.pairingError.value)
            val snapshot = model.hosts.value.firstOrNull { it.hostId == hostId }
            assertTrue(
                "配对后没有看到隔离 Host（看到的：${model.hosts.value.map { it.hostId }}）",
                snapshot != null,
            )
            assertEquals(hostId, snapshot!!.hostId)
            assertTrue("Host 名称应该来自它自己的状态：${snapshot.name}", snapshot.name.isNotBlank())
        } finally {
            instrumentation.runOnMainSync { owner.clear() }
            if (app is IsolatedTestApplication) app.dispose()
        }
    }
}
