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
 * The companion server is scripts/session-sync-fixture.mjs; no real pairing is read or replaced.
 * Its snapshots exercise legacy canonical ranges, including the Codex runtime namespace.
 * It does not emit ADR-0024 source checkpoints/live patches or test their loss/reordering recovery. */
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
            try {
                compose.waitUntil(15_000) { model.state.value.e2eReady && runtimeId in model.state.value.runtimes }
            } catch (error: AssertionError) {
                val state = model.state.value
                throw AssertionError("Fixture readiness failed: connection=${state.connection}, " +
                    "e2eReady=${state.e2eReady}, runtimeKeys=${state.runtimes.keys}, " +
                    "error=${state.error}, protocolVersion=$PROTOCOL_VERSION", error)
            }
            compose.runOnIdle { model.selectRuntime(runtimeId) }
            compose.waitUntil(15_000) { model.state.value.sessionSyncCommands.values.any { it.slow } }
            val pending = model.state.value.sessionSyncCommands.entries.single()
            assertEquals(1, pending.value.attempts)
            assertFalse(pending.key in model.state.value.pendingCommands) // ACK arrived first.
            // The spinner state is observable through the reducer even when the notice is
            // below the viewport on a small device; assert the state rather than a clipped node.
            assertTrue(model.state.value.conversations[runtimeId]?.isChatSyncing == true)
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
            // A 30-entry preview contains e371..e400. The missing e201..e370 prefix
            // takes six bounded catchups; none may resend the already cached tail.
            assertEquals(7, evidence.getValue("requests").jsonPrimitive.int)
            assertEquals(7, evidence.getValue("generated").jsonPrimitive.int)
            assertEquals(200, evidence.getValue("entries").jsonPrimitive.int)
            val ranges = evidence.getValue("ranges").jsonArray.map { it.jsonObject }
            assertEquals(listOf("preview") + List(6) { "catchup" }, ranges.map {
                it.getValue("range").jsonPrimitive.content
            })
            assertEquals(listOf(30, 30, 30, 30, 30, 30, 20), ranges.map {
                it.getValue("entries").jsonPrimitive.int
            })
            assertFalse(ranges.first().containsKey("target")) // Preview reads the current source head.
            assertFalse(ranges.first().containsKey("known"))
            assertEquals(List(6) { "e370" }, ranges.drop(1).map {
                it.getValue("target").jsonPrimitive.content
            })
            assertEquals(listOf("e200", "e230", "e260", "e290", "e320", "e350"), ranges.drop(1).map {
                it.getValue("known").jsonPrimitive.content
            })
            assertEquals(7, evidence.getValue("ids").jsonArray.map { it.jsonPrimitive.content }.distinct().size)
            assertTrue(evidence.getValue("pieces").jsonPrimitive.int > 2)
            assertTrue(evidence.getValue("peakQueueBytes").jsonPrimitive.int <= 6 * 1024 * 1024)
            var localHistoryPages = 0
            while (model.state.value.sessionHistory[runtimeId]?.hasOlder == true) {
                assertTrue("Cached paging must reach the root within fourteen 30-entry pages", localHistoryPages < 14)
                val before = model.state.value.sessionHistory.getValue(runtimeId).oldestEntryId!!
                val oldest = maxOf(1, before.removePrefix("e").toInt() - 30)
                compose.runOnIdle { model.loadOlderHistory(runtimeId) }
                compose.waitUntil(15_000) {
                    model.state.value.sessionHistory[runtimeId]?.let {
                        !it.loading && it.oldestEntryId == "e$oldest"
                    } == true
                }
                assertEquals((oldest..400).map { "e$it" },
                    model.state.value.conversations[runtimeId]?.messages?.map { it.messageId })
                assertEquals(7, stats().getValue("requests").jsonPrimitive.int)
                assertTrue(store.hasContinuousCoverage(device, sessionId, "e400"))
                localHistoryPages += 1
            }
            assertTrue("Older cached rows must require explicit bounded paging", localHistoryPages > 0)
            assertEquals((1..400).map { "e$it" }, model.state.value.conversations[runtimeId]?.messages?.map { it.messageId })
            compose.runOnIdle { displayed.value = null; owner.clear(); owner = ViewModelStore() }
            start()
            compose.waitUntil(20_000) {
                val state = model.state.value
                state.e2eReady && state.selectedRuntimeId == runtimeId &&
                    state.conversations[runtimeId]?.messages?.lastOrNull()?.messageId == "e400" &&
                    runtimeId !in state.sessionSyncRequests && state.sessionSyncCommands.isEmpty()
            }
            // Cached coverage avoids catchup after restart, but recovery still requests
            // one fresh preview. Persisted rows must not suppress source reconciliation.
            val restarted = stats()
            File(evidenceDir, "$kind-restart-stats.json").writeText(restarted.toString())
            assertEquals(8, restarted.getValue("requests").jsonPrimitive.int)
            assertEquals(8, restarted.getValue("generated").jsonPrimitive.int)
            assertEquals(230, restarted.getValue("entries").jsonPrimitive.int)
            val restartedRanges = restarted.getValue("ranges").jsonArray
            assertEquals(evidence.getValue("ranges").jsonArray.toList(), restartedRanges.take(7))
            assertEquals("preview", restartedRanges.last().jsonObject.getValue("range").jsonPrimitive.content)
            assertEquals(30, restartedRanges.last().jsonObject.getValue("entries").jsonPrimitive.int)
            assertFalse(restartedRanges.last().jsonObject.containsKey("target"))
            assertEquals((371..400).map { "e$it" }, model.state.value.conversations[runtimeId]?.messages?.map { it.messageId })
            assertTrue(store.hasContinuousCoverage(device, sessionId, "e400"))
            assertEquals(400, store.readBranch(device, sessionId, "e400", maxEntries = 500).entries.size)
            compose.runOnIdle { model.loadOlderHistory(runtimeId) }
            compose.waitUntil(15_000) {
                model.state.value.sessionHistory[runtimeId]?.let { !it.loading && it.oldestEntryId == "e341" } == true
            }
            assertEquals((341..400).map { "e$it" }, model.state.value.conversations[runtimeId]?.messages?.map { it.messageId })
            assertEquals(8, stats().getValue("requests").jsonPrimitive.int)
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
