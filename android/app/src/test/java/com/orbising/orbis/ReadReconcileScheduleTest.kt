package com.orbising.orbis

import org.junit.Assert.*
import org.junit.Test

/** FT-G11: a failed read must not cause every UI tick to retry; an applied push
 * postpones redundant reconciliation, without suppressing explicit reads. */
class ReadReconcileScheduleTest {
    @Test fun `periodic attempts are bounded without a successful reply`() {
        val schedule = ReadReconcileSchedule()
        assertTrue(schedule.claim(0))
        for (tick in listOf(1L, 15_000L, 30_000L, 59_999L)) assertFalse(schedule.claim(tick))
        assertTrue(schedule.claim(60_000))
        assertFalse(schedule.claim(60_001))
    }
    @Test fun `applied changes and explicit attempts advance independent watermarks`() {
        val schedule = ReadReconcileSchedule()
        schedule.started(1_000)
        schedule.confirmed(20_000)
        assertFalse(schedule.claim(61_000))
        assertTrue(schedule.claim(80_000))
        schedule.started(90_000)
        assertFalse(schedule.claim(140_000))
        assertTrue(schedule.claim(150_000))
    }
    /** FT-G12-RESUME-01: restore only the acknowledged current interest. Lost
     * ACKs retry with a fresh identity; close/reset and rejected writes cannot
     * leave an old accepted window active or permanently suppress retry. */
    @Test fun `history interests reject late acknowledgements and retry lost acknowledgements`() {
        val interest = HistoryWindowInterest()
        val sent = mutableListOf<String>()
        fun publish(target: String, now: Long, accepted: Boolean = true) {
            interest.publish(target, now) { id -> sent.add(id); accepted }
        }
        publish("a", 0); val first = sent[0]
        publish("a", 19_999); assertEquals(1, sent.size)
        publish("a", 20_000); val retry = sent[1]
        assertFalse(interest.consume(first, true)); assertFalse(interest.confirms("a"))
        assertTrue(interest.consume(retry, true)); assertTrue(interest.confirms("a"))
        assertFalse(interest.consume(retry, true))
        publish("a", 100_000); assertEquals(2, sent.size)
        publish("closed", 100_001); assertFalse(interest.confirms("a"))
        assertFalse(interest.consume(retry, true))
        assertTrue(interest.consume(sent.last(), false))
        publish("a", 100_002, false); assertFalse(interest.consume(sent.last(), true))
        publish("a", 100_003); val beforeReset = sent.last()
        interest.reset(); assertFalse(interest.consume(beforeReset, true))
        assertFalse(interest.confirms("a"))
    }

    /** A refused close write cannot have changed the Host subscription. Keeping
     * its confirmed target avoids manufacturing a source gap on rapid reopening. */
    @Test fun `refused close keeps the last acknowledged subscription`() {
        val interest = HistoryWindowInterest()
        val sent = mutableListOf<String>()
        interest.publish("a", 0) { sent.add(it); true }
        assertTrue(interest.consume(sent.single(), true))
        interest.publish("closed", 1) { false }
        assertTrue(interest.confirms("a"))
        interest.publish("a", 2) { sent.add(it); true }
        assertEquals(1, sent.size)
    }

}
