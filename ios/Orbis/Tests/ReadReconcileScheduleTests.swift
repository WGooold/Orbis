import Foundation
import Testing
@testable import OrbisCore

// FT-G11: lost replies stay bounded; committed pushes postpone periodic reads.
@Suite("Directory reconciliation schedule") struct ReadReconcileScheduleTests {
    @Test func boundsAttemptsAndConfirmedChanges() {
        var schedule = ReadReconcileSchedule()
        func time(_ seconds: Double) -> Date { Date(timeIntervalSince1970: seconds) }
        func claim(_ seconds: Double) -> Bool { schedule.claim(time(seconds)) }
        #expect(claim(0))
        #expect(!claim(15))
        #expect(!claim(59))
        #expect(claim(60))
        schedule.confirmed(time(80))
        #expect(!claim(120))
        #expect(claim(140))
        schedule.started(time(150))
        #expect(!claim(209))
        #expect(claim(210))
    }
}
