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
