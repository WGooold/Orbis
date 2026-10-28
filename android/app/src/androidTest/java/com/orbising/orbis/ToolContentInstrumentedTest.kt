package com.orbising.orbis

import android.content.Context
import android.net.Uri
import androidx.lifecycle.ViewModelStore
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.URL

/** Real Android connection, encryption, reducer and SQLite; synthetic native sources only. */
@RunWith(AndroidJUnit4::class)
class ToolContentInstrumentedTest {
    @Test fun fourKindsPageSummariesAndReadDetailsOnlyOnDemand() {
        val port = InstrumentationRegistry.getArguments().getString("toolFixturePort")
        assumeTrue("需要 toolFixturePort", port != null)
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val base = ApplicationProvider.getApplicationContext<Context>()
        fun waitFor(label: String, timeout: Long = 30_000, predicate: () -> Boolean) {
            val deadline = System.currentTimeMillis() + timeout
            while (!predicate() && System.currentTimeMillis() < deadline) Thread.sleep(100)
            assertTrue(label, predicate())
        }
        for (kind in listOf("pi", "codex", "codexDesktop", "dsh")) {
            val app = IsolatedTestApplication(base, prefix = "tool-content-$kind")
            val owner = ViewModelStore()
            val deviceId = "tool-fixture-$kind"
            CredentialStore(app).save(DeviceCredential("ws://10.0.2.2:$port", deviceId, deviceId))
            E2eIdentityStore(app).savePairedHost(HostIdentity("tool-fixture-host", "test-only", Crypto.toBase64Url(ByteArray(32) { 0x73 })))
            val model = RemoteViewModel(app)
            owner.put("model", model)
            val runtimeId = "$kind:tools"
            fun stats() = Json.parseToJsonElement(URL("http://10.0.2.2:$port/stats?device=$deviceId").readText()).jsonObject
            try {
                instrumentation.runOnMainSync { model.selectRuntime(runtimeId) }
                waitFor("$kind complete 200-item inventory: ${model.state.value}", 60_000) {
                    val state = model.state.value
                    state.toolInventories[runtimeId]?.tools?.size == 200 && state.pendingToolConversations.isEmpty() &&
                        state.conversations[runtimeId]?.sourceReady == true
                }
                assertTrue(stats().getValue("inventoryPages").jsonPrimitive.int > 1)
                assertEquals(0, stats().getValue("detailRequests").jsonPrimitive.int)
                val before = model.state.value.conversations.getValue(runtimeId)
                assertEquals((0..199).map { "tool-$it" }, model.state.value.toolInventories.getValue(runtimeId).tools.map { it.tool.toolCallId })
                val tool = model.state.value.toolInventories.getValue(runtimeId).tools.first()
                instrumentation.runOnMainSync { model.openToolDetail(runtimeId, tool) }
                waitFor("$kind first private page") { model.state.value.toolDetail?.text?.startsWith("TOOL_PRIVATE_BEGIN") == true }
                assertEquals(32 * 1024, model.state.value.toolDetail!!.text.toByteArray().size)
                assertEquals(before, model.state.value.conversations.getValue(runtimeId))
                assertEquals(1, stats().getValue("detailRequests").jsonPrimitive.int)
                instrumentation.runOnMainSync { model.readToolDetail() }
                waitFor("$kind second private page") { model.state.value.toolDetail?.offset == 65_536L }
                assertEquals(2, stats().getValue("detailRequests").jsonPrimitive.int)
                assertEquals(before, model.state.value.conversations.getValue(runtimeId))
                if (kind == "pi") {
                    val export = File(app.filesDir, "tool-export.txt")
                    val detail = model.state.value.toolDetail!!
                    instrumentation.runOnMainSync { model.exportToolDetail(Uri.fromFile(export), detail) }
                    waitFor("fixed 10 MiB export completes without filling 2 MiB viewer", 120_000) {
                        model.state.value.toolDetail?.let { it.exportComplete || it.error != null } == true
                    }
                    assertNull(model.state.value.toolDetail?.error)
                    assertTrue(model.state.value.toolDetail!!.exportComplete)
                    assertEquals(10 * 1024 * 1024L + "TOOL_PRIVATE_BEGIN\n".length, export.length())
                    assertTrue(model.state.value.toolDetail!!.text.isEmpty())
                    assertEquals(before, model.state.value.conversations.getValue(runtimeId))
                    val cancelled = File(app.filesDir, "cancelled-export.txt")
                    instrumentation.runOnMainSync { model.exportToolDetail(Uri.fromFile(cancelled), detail) }
                    waitFor("export starts before cancellation") { (model.state.value.toolDetail?.exportedBytes ?: 0) > 0 }
                    instrumentation.runOnMainSync { model.closeToolDetail() }
                    waitFor("cancelled export removes the incomplete document") { !cancelled.exists() }
                    Thread.sleep(200)
                    val cancelledRequests = stats().getValue("detailRequests").jsonPrimitive.int
                    Thread.sleep(1000)
                    assertEquals(cancelledRequests, stats().getValue("detailRequests").jsonPrimitive.int)
                    assertEquals(before, model.state.value.conversations.getValue(runtimeId))
                }
                instrumentation.runOnMainSync { model.closeToolDetail() }
                waitFor("$kind private lease cancellation") { stats().getValue("cancels").jsonPrimitive.int > 0 }
                val stopped = stats().getValue("detailRequests").jsonPrimitive.int
                Thread.sleep(1000)
                assertEquals(stopped, stats().getValue("detailRequests").jsonPrimitive.int)
                assertTrue(stats().getValue("peakDetailQueue").jsonPrimitive.int <= 256 * 1024)
            } finally {
                instrumentation.runOnMainSync { owner.clear() }
                app.dispose()
            }
        }
    }

    @Test fun toolProjectionMigrationRollsBackAndReopensWithoutRawResults() {
        val app = IsolatedTestApplication(ApplicationProvider.getApplicationContext(), prefix = "tool-migration")
        val store = SessionGraphStore(app)
        val device = DeviceCredential("wss://tool-migration.invalid", "device", "test")
        val summary = ToolSummary(tool = ToolIdentity(ToolAgent("host", "pi", "s"), "call"),
            toolName = "shell", phase = "finished", order = 0,
            contents = listOf(ToolPart("result", "json", "readable", "whole-source")))
        fun entry(id: String, raw: Boolean) = SessionGraphEntry(id, null, "message", "1", buildJsonObject {
            put("message", toolJson.encodeToJsonElement(ChatMessage(id, "tool", if (raw) listOf(RemoteContent("text", text = "OLD_PRIVATE_OUTPUT")) else emptyList(),
                1, toolCallId = "call", toolName = "shell", toolSummary = if (raw) null else summary)))
        })
        val old = listOf(entry("result", true), entry("obsolete", true))
        val fresh = listOf(entry("result", false))
        fun display(entries: List<SessionGraphEntry>) = DisplayBatch(DISPLAY_PROJECTION_VERSION,
            entries.map { DisplayEntry(it.entryId, it.entryId, "message", "message",
                message = toolJson.decodeFromJsonElement<ChatMessage>(it.data.getValue("message"))) })
        try {
            CredentialStore(app).save(device)
            E2eIdentityStore(app).savePairedHost(HostIdentity("host", "test", Crypto.toBase64Url(ByteArray(32) { 0x73 })))
            store.upsert(device, "s", old, "obsolete", source = SessionSourceEpoch("old-projection", 4, true),
                activateSource = true, display = display(old).copy(projectionVersion = 2))
            var checks = 0
            assertTrue(runCatching { store.upsert(device, "s", fresh, "result", source = SessionSourceEpoch("new-projection", 1, true),
                activateSource = true, display = display(fresh), writeGuard = { ++checks < 3 }) }.isFailure)
            assertEquals("old-projection", store.cacheEpoch(device, "s"))
            assertEquals(old, store.readEntries(device, "s", old.map { it.entryId }))
            store.upsert(device, "s", fresh, "result", source = SessionSourceEpoch("new-projection", 1, true),
                activateSource = true, display = display(fresh))
            store.close()
            val range = store.readBranch(device, "s", "result")
            assertEquals(fresh, range.entries)
            assertEquals(DISPLAY_PROJECTION_VERSION, range.displayVersion)
            assertEquals(summary, range.display.getValue("result").message?.toolSummary)
            assertFalse(store.contains(device, "s", "obsolete"))
            assertTrue(store.hasContinuousCoverage(device, "s", "result"))
            assertEquals(device, CredentialStore(app).load())
            assertEquals("host", E2eIdentityStore(app).loadPairedHost()?.hostId)
        } finally { store.close(); app.dispose() }
    }
}
