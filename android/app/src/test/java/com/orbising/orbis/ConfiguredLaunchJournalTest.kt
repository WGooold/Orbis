package com.orbising.orbis

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** SC73: slow storage cannot block UI admission or let launch requests overtake durable recovery. */
class ConfiguredLaunchJournalTest {
    private fun record(id: String) = buildJsonObject { put("launchId", id); put("firstMessage", "first input") }

    @Test fun `cold read and blocked commit leave memory access responsive and preserve write order`() = runBlocking {
        val caller = Thread.currentThread()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val readStarted = CountDownLatch(1)
        val releaseRead = CountDownLatch(1)
        val writeStarted = CountDownLatch(1)
        val releaseWrite = CountDownLatch(1)
        val persisted = mutableListOf<JsonObject?>()
        val journal = ConfiguredLaunchJournal(scope, read = {
            assertNotSame(caller, Thread.currentThread())
            readStarted.countDown()
            check(releaseRead.await(5, TimeUnit.SECONDS))
            null
        }, persist = {
            assertNotSame(caller, Thread.currentThread())
            writeStarted.countDown()
            check(releaseWrite.await(5, TimeUnit.SECONDS))
            persisted += it
            true
        })
        try {
            assertTrue(readStarted.await(5, TimeUnit.SECONDS))
            assertFalse(journal.isLoaded)
            assertNull(journal.reserve(record("too-early")))
            releaseRead.countDown()
            journal.awaitLoaded()
            val initial = record("one")
            val created = journal.reserve(initial)!!
            assertTrue(writeStarted.await(5, TimeUnit.SECONDS))
            assertFalse(created.isCompleted)
            assertEquals(initial, journal.snapshot("one"))
            assertNull("Double tap cannot reserve another launch", journal.reserve(record("one")))
            val departed = JsonObject(initial + ("following" to JsonPrimitive(false)))
            val leaving = journal.update("one") { departed }!!
            assertEquals(departed, journal.snapshot("one"))
            assertFalse(leaving.isCompleted)
            journal.close()
            assertNull("Removed connections cannot enqueue new writes", journal.update("one") { null })
            releaseWrite.countDown()
            assertTrue(created.await())
            assertTrue(leaving.await())
            assertEquals(listOf(initial, departed), persisted)
        } finally {
            releaseRead.countDown(); releaseWrite.countDown(); scope.cancel()
        }
    }

    // SC106: loading and every accepted change are announced, so launch warnings reconcile without per-site refreshes.
    @Test fun `loading and accepted changes are announced`() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val releaseRead = CountDownLatch(1)
        val journal = ConfiguredLaunchJournal(scope, read = {
            check(releaseRead.await(5, TimeUnit.SECONDS))
            record("saved")
        }, persist = { true })
        try {
            // Resume directly at completion so the original notification race is deterministic.
            val loading = async(Dispatchers.Unconfined, start = CoroutineStart.UNDISPATCHED) {
                journal.awaitLoaded()
                journal.changes.value
            }
            releaseRead.countDown()
            val loaded = loading.await()
            assertTrue("Loading completion is a change", loaded > 0)
            journal.update("saved") { null }!!.await()
            assertTrue(journal.changes.value > loaded)
            val cleared = journal.changes.value
            assertNull(journal.update("saved") { null })
            assertEquals("A rejected update is not a change", cleared, journal.changes.value)
        } finally { releaseRead.countDown(); scope.cancel() }
    }

    @Test fun `failed persistence keeps identity for retry and stale cleanup cannot erase a newer launch`() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val initial = record("one")
        var attempts = 0
        val persisted = mutableListOf<JsonObject?>()
        val journal = ConfiguredLaunchJournal(scope, read = { null }, persist = {
            attempts++
            if (attempts == 1) false else { persisted += it; true }
        })
        try {
            journal.awaitLoaded()
            assertFalse(journal.reserve(initial)!!.await())
            assertNotNull(journal.snapshot("one"))
            assertTrue(journal.update("one") { it }!!.await())
            val cleared = journal.update("one") { null }!!
            val next = record("two")
            val created = journal.reserve(next)!!
            assertNull(journal.update("one") { null })
            assertTrue(cleared.await()); assertTrue(created.await())
            assertEquals(listOf(initial, null, next), persisted)
            assertEquals(next, journal.snapshot("two"))
        } finally { scope.cancel() }
    }

    @Test fun `a rejected launch reopens as a draft and does not block a fresh attempt`() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val failed = buildJsonObject {
            put("launchId", "failed"); put("rejected", true)
            put("agentKind", "claude"); put("cwd", "/project"); put("firstMessage", "unsent original input")
        }
        val journal = ConfiguredLaunchJournal(scope, read = { failed }, persist = { true })
        try {
            journal.awaitLoaded()
            assertTrue(journal.pending.isEmpty())
            assertEquals(RecoveredLaunchDraft("claude", "/project", "unsent original input"), journal.snapshot("failed")?.recoveredLaunchDraft())
            assertTrue(journal.reserve(record("new"))!!.await())
            assertTrue(journal.acceptsResult("new"))
            assertNotNull(journal.snapshot("failed"))
            assertNull(journal.reserve(record("new")))
        } finally { scope.cancel() }
    }

    @Test fun `an uncertain launch and a fresh attempt keep separate durable identities`() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val initial = JsonObject(record("uncertain") + mapOf("agentKind" to JsonPrimitive("codex"), "cwd" to JsonPrimitive("/project")))
        var persisted: JsonObject? = initial
        try {
            val journal = ConfiguredLaunchJournal(scope, read = { persisted }, persist = { persisted = it; true })
            journal.awaitLoaded()
            assertTrue(journal.reserve(record("fresh"))!!.await())
            assertTrue(journal.acceptsResult("uncertain"))
            assertNull(journal.abandon("stale"))
            assertTrue(journal.abandon("uncertain")!!.await())
            assertFalse(journal.acceptsResult("uncertain"))
            assertNull(journal.updatePending("uncertain") { null })
            val restarted = ConfiguredLaunchJournal(scope, read = { persisted }, persist = { true })
            restarted.awaitLoaded()
            assertFalse(restarted.acceptsResult("uncertain"))
            assertEquals("first input", restarted.snapshot("uncertain")?.recoveredLaunchDraft()?.text)
            assertTrue(restarted.acceptsResult("fresh"))
            assertNull(restarted.updatePending("uncertain") { record("wrong-session") })
        } finally { scope.cancel() }
    }

    // LAUNCH-WAIT-02: IO failure leaves the original recovery identity and text;
    // only a durable retry may expose its draft; a different identity may proceed.
    @Test fun `failed abandonment retains only its own pending identity through a concurrent reservation`() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val initial = JsonObject(record("waiting") + mapOf("agentKind" to JsonPrimitive("codex"), "cwd" to JsonPrimitive("/project")))
        var disk = initial
        var failNext = true
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        try {
            val journal = ConfiguredLaunchJournal(scope, read = { disk }, persist = {
                if (failNext) {
                    failNext = false
                    entered.countDown()
                    check(release.await(5, TimeUnit.SECONDS))
                    false
                } else { disk = requireNotNull(it); true }
            })
            journal.awaitLoaded()
            val ending = journal.abandon("waiting")!!
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            assertEquals(initial, journal.snapshot("waiting"))
            assertNull(journal.snapshot("waiting")?.recoveredLaunchDraft())
            val other = journal.reserve(record("other"))!!
            assertTrue(journal.acceptsResult("other"))
            assertNull(journal.abandon("waiting"))
            assertFalse(journal.acceptsResult("waiting"))
            assertNull(journal.updatePending("waiting") { error("A reply must not run during retirement") })
            release.countDown()
            assertFalse(ending.await())
            assertTrue(other.await())
            assertEquals(initial, journal.snapshot("waiting"))
            assertTrue(journal.acceptsResult("waiting"))
            val failedRestart = ConfiguredLaunchJournal(scope, read = { disk }, persist = { true })
            failedRestart.awaitLoaded()
            assertTrue(failedRestart.acceptsResult("waiting"))
            assertTrue(failedRestart.acceptsResult("other"))

            assertTrue(journal.abandon("waiting")!!.await())
            val restarted = ConfiguredLaunchJournal(scope, read = { disk }, persist = { true })
            restarted.awaitLoaded()
            assertFalse(restarted.acceptsResult("waiting"))
            assertTrue(restarted.acceptsResult("other"))
            assertEquals(RecoveredLaunchDraft("codex", "/project", "first input"), restarted.snapshot("waiting")?.recoveredLaunchDraft())
            assertTrue(restarted.reserve(record("fresh"))!!.await())
        } finally { release.countDown(); scope.cancel() }
    }

    // LAUNCH-WAIT-02: definitive failure also requires durability before exposing the same draft.
    @Test fun `failed rejection write cannot publish a draft or retire the original identity`() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val original = record("rejected")
        var failNext = true
        try {
            val journal = ConfiguredLaunchJournal(scope, read = { original }, persist = { (!failNext).also { failNext = false } })
            journal.awaitLoaded()
            assertFalse(journal.reject("rejected", "catalog changed")!!.await())
            assertEquals(listOf(original), journal.pending)
            assertTrue(journal.acceptsResult("rejected"))
            assertTrue(journal.reject("rejected", "catalog changed")!!.await())
            assertTrue(journal.snapshot("rejected")?.isRejectedLaunch == true)
            assertTrue(journal.pending.isEmpty())
        } finally { scope.cancel() }
    }

    // LAUNCH-FIRST-01: a missing history echo can survive another reservation and restart without becoming a pending launch.
    @Test fun `landed first sentence survives another launch and restarts without rearming its send`() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        var disk: JsonObject? = null
        try {
            val journal = ConfiguredLaunchJournal(scope, read = { disk }, persist = { disk = it; true })
            journal.awaitLoaded()
            assertTrue(journal.reserve(record("first"))!!.await())
            val recovery = ConfiguredFirstMessage("message", "command", "keep input", "native", "desktop", "codexDesktop", null, 100)
            val handedOff = journal.handoff("first", recovery)!!
            assertTrue(journal.reserve(record("second"))!!.await())
            assertTrue(handedOff.await())
            val restarted = ConfiguredLaunchJournal(scope, read = { disk }, persist = { true })
            restarted.awaitLoaded()
            assertTrue(restarted.acceptsResult("second"))
            assertFalse(restarted.acceptsResult("first"))
            assertEquals(listOf(recovery), restarted.firstMessages)
            val terminal = RuntimeSummary("other", "Terminal", "/project", "idle", "native", agentKind = "codex")
            val desktop = terminal.copy(runtimeId = "desktop", agentKind = "codexDesktop")
            val state = RemoteState(runtimes = mapOf("other" to terminal, "desktop" to desktop))
            val restored = state.reconcileConfiguredFirstMessages(restarted.firstMessages).first
            assertEquals("desktop", restored.pendingSends.getValue("message").runtimeId)
            assertEquals(PendingSendState.Unconfirmed, restored.pendingSends.getValue("message").state)
            assertTrue(restored.readySends().isEmpty())
            val row = ChatMessage("native-row", "user", listOf(RemoteContent("text", "keep input")), 200, clientMessageId = "message")
            val (matched, ids) = restored.copy(conversations = mapOf("desktop" to RuntimeConversation(messages = listOf(row))))
                .reconcileConfiguredFirstMessages(restarted.firstMessages)
            assertEquals(setOf("message"), ids)
            assertTrue(matched.pendingSends.isEmpty())
        } finally { scope.cancel() }
    }

    @Test fun `ending a matching launch with an offline native identity stores only an editable draft`() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            val journal = ConfiguredLaunchJournal(scope, read = { JsonObject(record("ready") + ("sessionId" to JsonPrimitive("native"))) }, persist = { true })
            journal.awaitLoaded()
            assertNull(journal.abandon("different"))
            assertTrue(journal.abandon("ready")!!.await())
            assertTrue(journal.pending.isEmpty())
        } finally { scope.cancel() }
    }

    @Test fun `restart loads existing identity before admitting a new launch`() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val existing = record("recovered")
        val journal = ConfiguredLaunchJournal(scope, read = { existing }, persist = { true })
        try {
            journal.awaitLoaded()
            assertEquals(existing, journal.snapshot("recovered"))
            assertNull(journal.reserve(record("recovered")))
            assertTrue(journal.update("recovered") { it }!!.await())
        } finally { scope.cancel() }
    }
}
