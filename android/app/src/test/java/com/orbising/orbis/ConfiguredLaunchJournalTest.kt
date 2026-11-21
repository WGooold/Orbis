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
            assertNull(journal.update(null) { record("too-early") })
            releaseRead.countDown()
            journal.awaitLoaded()
            val initial = record("one")
            val created = journal.update(null) { initial }!!
            assertTrue(writeStarted.await(5, TimeUnit.SECONDS))
            assertFalse(created.isCompleted)
            assertEquals(initial, journal.snapshot)
            assertNull("Double tap cannot reserve another launch", journal.update(null) { record("duplicate") })
            val departed = JsonObject(initial + ("following" to JsonPrimitive(false)))
            val leaving = journal.update("one") { departed }!!
            assertEquals(departed, journal.snapshot)
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
            assertFalse(journal.update(null) { initial }!!.await())
            assertEquals("one", journal.launchId)
            assertTrue(journal.update("one") { it }!!.await())
            val cleared = journal.update("one") { null }!!
            val next = record("two")
            val created = journal.update(null) { next }!!
            assertNull(journal.update("one") { null })
            assertTrue(cleared.await()); assertTrue(created.await())
            assertEquals(listOf(initial, null, next), persisted)
            assertEquals(next, journal.snapshot)
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
            assertNull(journal.pendingId)
            assertEquals(RecoveredLaunchDraft("claude", "/project", "unsent original input"), journal.snapshot?.recoveredLaunchDraft())
            assertTrue(journal.reserve(record("new"))!!.await())
            assertEquals("new", journal.pendingId)
            assertNull(journal.update("failed") { null })
            assertNull(journal.reserve(record("duplicate")))
        } finally { scope.cancel() }
    }

    @Test fun `an uncertain launch needs explicit abandonment before a fresh attempt`() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val initial = JsonObject(record("uncertain") + mapOf("agentKind" to JsonPrimitive("codex"), "cwd" to JsonPrimitive("/project")))
        var persisted: JsonObject? = initial
        try {
            val journal = ConfiguredLaunchJournal(scope, read = { persisted }, persist = { persisted = it; true })
            journal.awaitLoaded()
            assertNull(journal.reserve(record("duplicate")))
            assertNull(journal.abandon("stale"))
            assertTrue(journal.abandon("uncertain")!!.await())
            val restarted = ConfiguredLaunchJournal(scope, read = { persisted }, persist = { true })
            restarted.awaitLoaded()
            assertNull(restarted.pendingId)
            assertEquals("first input", restarted.snapshot?.recoveredLaunchDraft()?.text)
            assertTrue(restarted.reserve(record("fresh"))!!.await())
            assertNull(restarted.update("uncertain") { record("wrong-session") })
            assertEquals("fresh", restarted.pendingId)
        } finally { scope.cancel() }
    }

    @Test fun `ending a matching launch with an offline native identity stores only an editable draft`() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            val journal = ConfiguredLaunchJournal(scope, read = { JsonObject(record("ready") + ("sessionId" to JsonPrimitive("native"))) }, persist = { true })
            journal.awaitLoaded()
            assertNull(journal.abandon("different"))
            assertTrue(journal.abandon("ready")!!.await())
            assertNull(journal.pendingId)
        } finally { scope.cancel() }
    }

    @Test fun `restart loads existing identity before admitting a new launch`() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val existing = record("recovered")
        val journal = ConfiguredLaunchJournal(scope, read = { existing }, persist = { true })
        try {
            journal.awaitLoaded()
            assertEquals(existing, journal.snapshot)
            assertNull(journal.update(null) { record("duplicate") })
            assertTrue(journal.update("recovered") { it }!!.await())
        } finally { scope.cancel() }
    }
}
