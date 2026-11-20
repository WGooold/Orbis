import Foundation
import Testing
@testable import OrbisCore

@Suite("Subscription quota reset countdown")
struct SubscriptionQuotaCountdownTests {
    // QUOTA-RESET-01: countdown precision is useful without recreating a long absolute date string.
    @Test func displaysRemainingDaysHoursAndMinutes() {
        let now = Date(timeIntervalSince1970: 0)
        let twoDaysThreeHours = Int64((2 * 24 + 3) * 60 * 60 * 1_000)
        let threeHoursTwelveMinutes = Int64((3 * 60 + 12) * 60 * 1_000)

        #expect(subscriptionQuotaResetCountdown(resetsAt: twoDaysThreeHours, now: now) == "重置倒计时 2天 3小时")
        #expect(subscriptionQuotaResetCountdown(resetsAt: threeHoursTwelveMinutes, now: now) == "重置倒计时 3小时 12分钟")
        #expect(subscriptionQuotaResetCountdown(resetsAt: 1, now: now) == "重置倒计时 1分钟")
    }

    // QUOTA-RESET-01: a passed reset boundary is presented as imminent, not as time ago.
    @Test func expiredResetIsShownAsImminent() {
        let now = Date(timeIntervalSince1970: 10)
        #expect(subscriptionQuotaResetCountdown(resetsAt: 10_000, now: now) == "即将重置")
        #expect(subscriptionQuotaResetCountdown(resetsAt: 9_999, now: now) == "即将重置")
    }
}
