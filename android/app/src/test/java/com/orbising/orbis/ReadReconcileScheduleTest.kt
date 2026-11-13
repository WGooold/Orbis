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
}
