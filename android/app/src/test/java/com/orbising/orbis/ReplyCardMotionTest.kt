package com.orbising.orbis

import androidx.compose.ui.unit.IntSize
import org.junit.Assert.*
import org.junit.Test

class ReplyCardMotionTest {
    private fun parts(text: String) = listOf(ReplyCardPart("message:text", text))
    @Test fun liveAppendGrowsWithoutRestartingForSameLineTokensAndFinalAppend() {
        val policy = ReplyCardGrowth()
        assertFalse(policy.update(IntSize(300, 50), parts("A"), true, false))
        assertTrue(policy.update(IntSize(300, 100), parts("AB"), true, false))
        assertTrue(policy.update(IntSize(300, 100), parts("ABC"), true, false))
        assertTrue(policy.update(IntSize(300, 120), parts("ABCD"), false, false))
        assertFalse(policy.update(IntSize(300, 140), parts("ABCDE"), false, false))
    }
    @Test fun disclosureReflowRewriteAndReducedMotionSettleDirectly() {
        for (operation in 0..3) {
            val policy = ReplyCardGrowth()
            policy.update(IntSize(300, 50), parts("ABC"), true, false)
            assertFalse(policy.update(IntSize(if (operation == 1) 200 else 300, 100),
                parts(when (operation) { 0 -> "ABC"; 2 -> "Z"; else -> "ABCD" }), true, operation == 3))
        }
    }
    @Test fun freshCardsEnterButExistingCardsAndReducedMotionDoNot() {
        for (entering in listOf(false, true)) for (reduced in listOf(false, true)) {
            assertEquals(entering && !reduced, ReplyCardGrowth().update(IntSize(300, 80), parts("A"), true, reduced, entering))
        }
    }
    @Test fun onlyNewTailRowsReceiveASingleArrivalTicket() {
        val arrivals = ReplyCardArrivals()
        arrivals.observe(listOf("a" to listOf("a")), true, true, 0)
        assertFalse(arrivals.claim("a", 0))
        arrivals.observe(listOf("a" to listOf("a"), "b" to listOf("b")), true, true, 1000)
        assertTrue(arrivals.claim("b", 1050)); assertFalse(arrivals.claim("b", 1060))
        arrivals.observe(listOf("older" to listOf("older"), "a" to listOf("a"), "b" to listOf("b")), true, true, 2000)
        assertFalse(arrivals.claim("older", 2000))
    }
    @Test fun restoreReadingLazyRemountAndRepartitionDoNotReplayEntry() {
        for (mode in 0..3) {
            val arrivals = ReplyCardArrivals()
            arrivals.observe(listOf("a" to listOf("a", "b")), mode != 0, true, 0)
            arrivals.observe(listOf("a" to listOf("a"), "b" to listOf(if (mode == 3) "b" else "new")), true, mode != 1, 1000)
            assertFalse(arrivals.claim("b", if (mode == 2) 2000 else 1000))
        }
    }
}
