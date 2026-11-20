package com.orbising.orbis

import org.junit.Assert.assertEquals
import org.junit.Test

class SubscriptionQuotaCountdownTest {
    // QUOTA-RESET-01: reset labels stay concise, minute-accurate, and never report a past reset as time ago.
    @Test fun countdownUsesCompactTwoUnitDurationsAndRoundsUpToTheNextMinute() {
        val now = 1_000L
        assertEquals(
            "重置倒计时 2天 3小时",
            subscriptionQuotaResetCountdown(now + 2 * 24 * 60 * 60 * 1_000L + 3 * 60 * 60 * 1_000L, now),
        )
        assertEquals(
            "重置倒计时 3小时 12分钟",
            subscriptionQuotaResetCountdown(now + 3 * 60 * 60 * 1_000L + 12 * 60 * 1_000L, now),
        )
        assertEquals("重置倒计时 1分钟", subscriptionQuotaResetCountdown(now + 1L, now))
        assertEquals("即将重置", subscriptionQuotaResetCountdown(now, now))
        assertEquals("即将重置", subscriptionQuotaResetCountdown(now - 1, now))
    }

    // QUOTA-RESET-01: the duration and imminent-reset labels remain localized in English.
    @Test fun countdownTranslationsStayCompactInEnglish() {
        assertEquals("Reset in 2d 3h", L10n.format("重置倒计时 {0}", listOf("2d 3h"), AppLanguage.English))
        assertEquals("2d", L10n.format("{0}天", listOf("2"), AppLanguage.English))
        assertEquals("remaining 82%", L10n.format("剩余 {0}", listOf("82%"), AppLanguage.English))
        assertEquals("Resetting soon", L10n.format("即将重置", language = AppLanguage.English))
    }
}
