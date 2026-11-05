package com.orbising.orbis

import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.yield
import org.junit.Assert.*
import org.junit.Test

class HostCacheStartupTest {
    @Test fun `disk hydration leaves caller responsive and captures Pi titles before publication`() = runBlocking {
        val caller = Thread.currentThread()
        val dispatcher = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        try {
            val pending = async {
                loadHostCache(dispatcher) {
                    assertNotSame(caller, Thread.currentThread())
                    entered.countDown()
                    check(release.await(5, TimeUnit.SECONDS))
                    RemoteState(sessions = mapOf("s" to SessionCatalogEntry("s", agentKind = "pi", name = "Saved title")))
                }
            }
            yield()
            assertTrue(withContext(Dispatchers.IO) { entered.await(5, TimeUnit.SECONDS) })
            assertFalse(pending.isCompleted)
            release.countDown()
            assertEquals("Saved title", pending.await().sessions["s"]?.cachedDisplayName)
        } finally { release.countDown(); dispatcher.close() }
    }

    @Test fun `cancelled startup never publishes a late disk result or starts the connection`() = runBlocking {
        val dispatcher = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        var connected = false
        try {
            val pending = async {
                loadHostCache(dispatcher) {
                    entered.countDown()
                    check(release.await(5, TimeUnit.SECONDS))
                    RemoteState()
                }
                connected = true
            }
            yield()
            assertTrue(withContext(Dispatchers.IO) { entered.await(5, TimeUnit.SECONDS) })
            pending.cancel()
            release.countDown()
            pending.join()
            assertFalse(connected)
        } finally { release.countDown(); dispatcher.close() }
    }
}
