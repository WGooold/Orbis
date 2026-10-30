package com.orbising.orbis

import org.junit.Assert.*
import org.junit.Test

class HomePresentationTest {
    @Test fun coldStartWaitsForTheDirectoryAndEveryCompleteCard() {
        val f = HomeLoadingFixture()
        assertTrue(f.state.homeRuntimesLoading)
        f.directory(f.runtime("a"), f.runtime("b"))
        f.beginRead("a"); f.beginRead("b")
        f.facts("a", setOf("identity", "execution")); f.facts("b")
        assertTrue(f.state.homeCards.isEmpty())
        f.facts("a", setOf("interactions"))
        assertEquals(2, f.state.homeCards.size)
        assertFalse(f.state.homeRuntimesUpdating)
    }

    @Test fun emptyStateRequiresAnAuthenticatedDirectory() {
        val f = HomeLoadingFixture()
        f.receive("""{"type":"device.ready","runtimes":[]}""", channel = null)
        assertTrue(f.state.homeRuntimesLoading)
        f.directory()
        assertFalse(f.state.homeRuntimesLoading)
        assertEquals(emptyList<HomeRuntimeCard>(), f.state.homeSnapshot)
    }

    @Test fun refreshPublishesAllVisibleFieldsTogether() {
        val f = HomeLoadingFixture(); f.complete("a", "b")
        val before = f.state.homeCards
        f.beginRead("a"); f.beginRead("b")
        f.facts("a", setOf("identity", "execution"), title = "更新后的完整会话", phase = "running", revision = 2)
        f.facts("b", revision = 2)
        assertEquals(before, f.state.homeCards)
        assertTrue(f.state.homeRuntimesUpdating)
        f.facts("a", setOf("interactions"), revision = 2)
        assertEquals("更新后的完整会话", f.state.homeCards.first { it.runtime.runtimeId == "a" }.title)
        assertFalse(f.state.homeRuntimesUpdating)
    }

    @Test fun duplicateTransportMetadataCannotEraseCommittedIdentity() {
        val f = HomeLoadingFixture(); f.complete("a")
        val before = f.state.homeCards
        f.directory(f.runtime("a"))
        assertEquals(before, f.state.homeCards)
        assertFalse(f.state.homeRuntimesUpdating)
        f.receive("""{"type":"runtime.online","runtime":{"runtimeId":"a","sessionId":"session-a","name":"Agent","cwd":"","status":"unknown"}}""")
        f.receive("""{"type":"runtime.event","runtimeId":"a","sequence":1,"event":{"type":"runtime.metadata","metadata":{"runtimeId":"a","sessionId":"session-a","name":"Agent","cwd":"","status":"unknown"}}}""")
        assertEquals(before, f.state.homeCards)
        assertFalse(f.state.homeRuntimesUpdating)
    }

    @Test fun replacementRetainsTheOldCardButCannotOperateOnTheNewSession() {
        val f = HomeLoadingFixture(); f.complete("a")
        val before = f.state.homeCards.single()
        f.receive("""{"type":"runtime.online","runtime":{"runtimeId":"a","sessionId":"replacement","name":"Agent","cwd":"","status":"unknown"}}""")
        assertEquals(before, f.state.homeCards.single())
        assertFalse(f.state.homeCardIsCurrent(before))
        f.beginRead("a"); f.facts("a", title = "替换完成")
        assertEquals("替换完成", f.state.homeCards.single().title)
        assertTrue(f.state.homeCardIsCurrent(f.state.homeCards.single()))
    }

    @Test fun reconnectAndHostEpochChangeKeepTheCompleteSnapshot() {
        val f = HomeLoadingFixture(); f.complete("a")
        val before = f.state.homeCards
        f.state = f.state.markReconnecting()
        assertEquals(before, f.state.homeCards)
        f.state = f.state.copy(e2eReady = true)
        assertTrue(f.state.homeRuntimesUpdating)
        f.directory(f.runtime("a"), epoch = "new-epoch")
        assertEquals(before, f.state.homeCards)
        f.beginRead("a"); f.facts("a", title = "重新连接完成")
        assertFalse(f.state.homeRuntimesUpdating)
    }

    @Test fun failureAndTimeoutKeepCardsAndRetryCanRecover() {
        val f = HomeLoadingFixture(); f.complete("a", "b")
        val before = f.state.homeCards
        val request = f.beginRead("b")
        f.receive("""{"type":"protocol.error","code":"session_request_failed","requestId":"$request","message":"读取失败"}""")
        assertEquals("读取失败", f.state.homeRuntimesError)
        assertEquals(before, f.state.homeCards)
        val retry = f.beginRead("b")
        assertNull(f.state.homeRuntimesError)
        f.state = f.state.failHomeRead(retry, "会话读取超时，请重试")
        assertEquals("会话读取超时，请重试", f.state.homeRuntimesError)
        f.facts("b", revision = 2)
        assertNull(f.state.homeRuntimesError)
        assertFalse(f.state.homeRuntimesUpdating)
    }

    @Test fun syncStatusFollowsProgressAndFailureWithoutAnotherSource() {
        val f = HomeLoadingFixture()
        assertEquals(HomeSyncStatus.Syncing, f.state.homeSyncStatus)
        f.complete("a")
        assertEquals(HomeSyncStatus.Idle, f.state.homeSyncStatus)
        val request = f.beginRead("a")
        assertEquals(HomeSyncStatus.Syncing, f.state.homeSyncStatus)
        f.state = f.state.failHomeRead(request, "会话读取超时，请重试")
        assertEquals(HomeSyncStatus.Failed("会话读取超时，请重试"), f.state.homeSyncStatus)
        assertFalse(f.state.homeRuntimesLoading)
        f.beginRead("a"); f.facts("a", revision = 2)
        assertEquals(HomeSyncStatus.Idle, f.state.homeSyncStatus)
    }

    @Test fun unknownOrPartialDomainsNeverProduceHalfLoadedCards() {
        val f = HomeLoadingFixture(); f.directory(f.runtime("a")); f.beginRead("a")
        f.facts("a", setOf("identity", "execution"))
        f.facts("a", setOf("interactions"), completeness = "partial", projectionComplete = false)
        assertTrue(f.state.homeCards.isEmpty())
        assertNotNull(f.state.homeRuntimesError)
        f.facts("a", setOf("interactions"), revision = 2, availability = "unknown")
        assertTrue(f.state.homeCards.isEmpty())
        f.facts("a", setOf("interactions"), revision = 3)
        assertEquals(1, f.state.homeCards.size)
    }
}
