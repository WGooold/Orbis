import Foundation
import Testing
@testable import OrbisCore

@Suite("Subscription quota reset countdown")
struct SubscriptionQuotaCountdownTests {
    // QUOTA-RESET-01: countdown precision is useful without recreating a long absolute date string.
    @Test func displaysRemainingDaysHoursAndMinutes() {
        let now = Date(timeIntervalSince1970: 0)
        let twoDaysThreeHours: Int64 = 183_600_000 // 51 hours in milliseconds.
        let threeHoursTwelveMinutes: Int64 = 11_520_000 // 192 minutes in milliseconds.

        let twoDaysResult = subscriptionQuotaResetCountdown(resetsAt: twoDaysThreeHours, now: now)
        let threeHoursResult = subscriptionQuotaResetCountdown(resetsAt: threeHoursTwelveMinutes, now: now)
        let oneMinuteResult = subscriptionQuotaResetCountdown(resetsAt: 1, now: now)

        #expect(twoDaysResult == "重置倒计时 2天 3小时")
        #expect(threeHoursResult == "重置倒计时 3小时 12分钟")
        #expect(oneMinuteResult == "重置倒计时 1分钟")
    }

    // QUOTA-RESET-01: a passed reset boundary is presented as imminent, not as time ago.
    @Test func expiredResetIsShownAsImminent() {
        let now = Date(timeIntervalSince1970: 10)
        let atBoundary = subscriptionQuotaResetCountdown(resetsAt: 10_000, now: now)
        let pastBoundary = subscriptionQuotaResetCountdown(resetsAt: 9_999, now: now)

        #expect(atBoundary == "即将重置")
        #expect(pastBoundary == "即将重置")
    }
}
