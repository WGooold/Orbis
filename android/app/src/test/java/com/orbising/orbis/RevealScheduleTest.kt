package com.orbising.orbis

import kotlin.random.Random
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** ADR-0053 §1 / M04: one cursor per message, characters start strictly in order. */
class RevealScheduleTest {
    @Test fun aNewBatchQueuesBehindTheUnrevealedTail() {
        val schedule = RevealSchedule()
        schedule.observe(0, 0)
        schedule.observe(10, 0)
        schedule.observe(20, 50)
        val tail = schedule.startTime(9)!!
        val head = schedule.startTime(10)!!
        assertEquals(tail + RevealSchedule.STAGGER_MS, head, 1e-9)
        // The next batch has not started while the previous one is still revealing.
        assertEquals(0f, schedule.progress(10, 60))
        assertEquals(0f, schedule.progress(9, 60))
    }

    @Test fun progressNeverIncreasesAlongTheTextAndEveryCharacterStartsWithinTheDelay() {
        val random = Random(51)
        val schedule = RevealSchedule()
        schedule.observe(0, 0)
        val arrival = ArrayList<Long>()
        var now = 0L
        repeat(60) {
            now += random.nextLong(16, 120)
            repeat(random.nextInt(1, 40)) { arrival += now }
            schedule.observe(arrival.size, now)
            for (offset in arrival.indices) {
                val start = schedule.startTime(offset) ?: continue
                assertTrue(start - arrival[offset] <= RevealSchedule.MAX_DELAY_MS + 1e-9)
                schedule.startTime(offset - 1)?.let { assertTrue(start >= it - 1e-9) }
            }
            var sample = now
            while (sample < now + 120) {
                val values = arrival.indices.map { schedule.progress(it, sample) }
                // The animating region is one contiguous stretch right behind the settled text.
                assertTrue(values.zipWithNext().all { (a, b) -> a >= b })
                sample += 16
            }
        }
    }

    @Test fun aLargeBatchCompressesItsSpacingButStaysInOrder() {
        val schedule = RevealSchedule()
        schedule.observe(0, 1_000)
        schedule.observe(500, 1_000)
        assertTrue(schedule.startTime(499)!! <= 1_000 + RevealSchedule.MAX_DELAY_MS + 1e-9)
        assertTrue(schedule.startTime(250)!! >= schedule.startTime(249)!!)
        assertTrue(schedule.isAnimating(1_200))
        assertFalse(schedule.isAnimating(1_000 + RevealSchedule.MAX_DELAY_MS + RevealSchedule.DURATION_MS + 1))
    }

    @Test fun onlyTheTrailingCharactersAnimateWhenTheCapIsReached() {
        val schedule = RevealSchedule(RevealSchedule.MAX_ACTIVE)
        schedule.observe(0, 0)
        schedule.observe(1_000, 0)
        assertEquals(1_000 - RevealSchedule.MAX_ACTIVE, schedule.settledBelow)
        assertEquals(1f, schedule.progress(1_000 - RevealSchedule.MAX_ACTIVE - 1, 0))
        assertEquals(0f, schedule.progress(999, 0))
    }

    @Test fun baselineTextIsSettledAndUnobservedTextStaysHidden() {
        val schedule = RevealSchedule()
        assertEquals(1f, schedule.progress(3, 0))
        schedule.observe(5, 0)
        assertTrue((0 until 5).all { schedule.progress(it, 0) == 1f })
        assertEquals(0f, schedule.progress(5, 100_000))
    }

    @Test fun rewrittenOrShortenedTextSettlesWithoutReplaying() {
        val schedule = RevealSchedule()
        schedule.observe(0, 0)
        schedule.observe(40, 0)
        schedule.observe(30, 50)
        assertEquals(30, schedule.known)
        assertTrue((0 until 30).all { schedule.progress(it, 50) == 1f })
        assertFalse(schedule.isAnimating(50))
    }

    @Test fun resetMakesTheNextObservationTheBaseline() {
        val schedule = RevealSchedule()
        schedule.observe(0, 0)
        schedule.observe(10, 0)
        schedule.reset()
        schedule.observe(25, 10)
        assertFalse(schedule.isAnimating(10))
        assertEquals(1f, schedule.progress(24, 10))
    }
}
