package dev.pi.remote

import android.app.Application
import android.content.Context
import android.content.SharedPreferences
import android.graphics.Bitmap
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.printToString
import androidx.lifecycle.ViewModelStore
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.net.URL
import java.util.UUID
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test

/** Real RelayClient -> DeviceLink AEAD/slices -> ViewModel -> SQLite -> ChatScreen.
 * The companion server is scripts/session-sync-fixture.mjs; no real pairing is read or replaced. */
class SessionSyncSlowLinkInstrumentedTest {
    @get:Rule val compose = createComposeRule()

    private class IsolatedApplication(base: Context) : Application() {
        private val prefix = "slow-sync-${UUID.randomUUID()}"
        val root = File(base.filesDir, prefix).apply { mkdirs() }
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

    @Test fun piSlowResponsePersistsDisplaysAndReusesCacheAfterRestart() = exercise("pi")
    @Test fun codexSlowResponsePersistsDisplaysAndReusesCacheAfterRestart() = exercise("codex")

    private fun exercise(kind: String) {
        val port = InstrumentationRegistry.getArguments().getString("syncFixturePort")
        assumeTrue("Start the isolated Windows fixture and supply syncFixturePort", port != null)
        val base = ApplicationProvider.getApplicationContext<Context>()
        val originalPreferences = listOf("pi_remote_credentials", "pi_remote_e2e", "pi_remote_last_session")
            .associateWith { base.getSharedPreferences(it, Context.MODE_PRIVATE).all.toMap() }
        val app = IsolatedApplication(base)
        val device = DeviceCredential("ws://10.0.2.2:$port", "sync-fixture-$kind", "sync-fixture-$kind")
        val runtimeId = "$kind:slow-sync"
        val sessionId = "$kind-session"
        CredentialStore(app).save(device)
        E2eIdentityStore(app).savePairedHost(HostIdentity("sync-fixture-host", "test-only",
            Crypto.toBase64Url(ByteArray(32) { 0x73 })))
        val store = SessionGraphStore(app)
        val local = (1..200).map { n -> SessionGraphEntry("e$n", if (n == 1) null else "e${n - 1}",
            "message", "2026-01-01T00:00:00.000Z", buildJsonObject {
                put("message", buildJsonObject { put("role", "user"); put("content", "entry-$n ${"x".repeat(1100)}") }) }) }
        store.upsert(device, sessionId, local, leafId = "e200", agentKind = kind)
        var owner = ViewModelStore()
        lateinit var model: RemoteViewModel
        val displayed = mutableStateOf<RemoteViewModel?>(null)
        fun start() = compose.runOnIdle {
            model = RemoteViewModel(app)
            owner.put("sync", model)
            displayed.value = model
        }
        fun stats() = Json.parseToJsonElement(URL("http://10.0.2.2:$port/stats?device=${device.deviceId}").readText()).jsonObject
        try {
            start()
            compose.setContent {
                displayed.value?.let { vm ->
                    val state by vm.state.collectAsState()
                    PiRemoteTheme { AgentTheme(agentBrand(kind == "codex")) { ChatScreen(state, vm) } }
                }
            }
            compose.waitUntil(15_000) { model.state.value.e2eReady && runtimeId in model.state.value.runtimes }
            compose.runOnIdle { model.selectRuntime(runtimeId) }
            compose.waitUntil(15_000) { model.state.value.sessionSyncCommands.values.any { it.slow } }
            val pending = model.state.value.sessionSyncCommands.entries.single()
            assertEquals(1, pending.value.attempts)
            assertFalse(pending.key in model.state.value.pendingCommands) // ACK arrived first.
            compose.onNodeWithText("聊天记录仍在同步，请稍候…").assertIsDisplayed()
            compose.waitUntil(90_000) {
                model.state.value.conversations[runtimeId]?.messages?.any { it.messageId == "e400" } == true
            }
            compose.onNodeWithText("SYNC_VISIBLE_400").assertIsDisplayed()
            compose.waitUntil(90_000) {
                model.state.value.conversations[runtimeId]?.messages?.any { it.messageId == "e400" } == true &&
                    store.hasContinuousCoverage(device, sessionId, "e400") &&
                    model.state.value.sessionSyncCommands.isEmpty()
            }
            assertTrue(store.hasContinuousCoverage(device, sessionId, "e400"))
            assertEquals(400, store.readBranch(device, sessionId, "e400", maxEntries = 500).entries.size)
            assertEquals("e400", model.state.value.conversations[runtimeId]?.messages?.lastOrNull()?.messageId)
            val evidence = stats()
            val evidenceDir = File(base.getExternalFilesDir(null), "chat-history-sync").apply { mkdirs() }
            File(evidenceDir, "$kind-stats.json").writeText(evidence.toString())
            File(evidenceDir, "$kind-layout.txt").writeText(compose.onRoot().printToString())
            File(evidenceDir, "$kind-chat.png").outputStream().use {
                compose.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it)
            }
            compose.onNodeWithText("SYNC_VISIBLE_400").assertIsDisplayed()
            assertEquals(2, evidence.getValue("requests").jsonPrimitive.int)
            assertEquals(2, evidence.getValue("generated").jsonPrimitive.int)
            assertEquals(200, evidence.getValue("entries").jsonPrimitive.int)
            assertEquals(listOf("preview", "catchup"), evidence.getValue("ranges").jsonArray.map {
                it.jsonObject.getValue("range").jsonPrimitive.content
            })
            assertEquals("e300", evidence.getValue("ranges").jsonArray[1].jsonObject.getValue("target").jsonPrimitive.content)
            assertTrue(evidence.getValue("pieces").jsonPrimitive.int > 2)
            assertTrue(evidence.getValue("peakQueueBytes").jsonPrimitive.int <= 6 * 1024 * 1024)
            compose.runOnIdle { model.loadOlderHistory(runtimeId) }
            compose.waitUntil(15_000) { model.state.value.sessionHistory[runtimeId]?.loading != true }
            assertEquals(2, stats().getValue("requests").jsonPrimitive.int)
            assertEquals((1..400).map { "e$it" }, model.state.value.conversations[runtimeId]?.messages?.map { it.messageId })
            compose.runOnIdle { displayed.value = null; owner.clear(); owner = ViewModelStore() }
            start()
            compose.waitUntil(20_000) {
                model.state.value.conversations[runtimeId]?.messages?.any { it.messageId == "e400" } == true
            }
            assertTrue(model.state.value.sessionSyncCommands.isEmpty())
            assertEquals(2, stats().getValue("requests").jsonPrimitive.int)
            compose.onNodeWithText("SYNC_VISIBLE_400").assertIsDisplayed()
        } finally {
            compose.runOnIdle { displayed.value = null; owner.clear() }
            store.close()
            app.dispose()
            originalPreferences.forEach { (name, values) ->
                assertTrue("Existing pairing/navigation preferences must remain unchanged",
                    values == base.getSharedPreferences(name, Context.MODE_PRIVATE).all)
            }
        }
    }
}
