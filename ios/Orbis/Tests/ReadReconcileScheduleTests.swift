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
    // FT-G12-RESUME-01: only an accepted current interest may restore a window;
    // duplicate/late ACKs, refused writes and lost ACKs retain bounded ownership.
    @Test func historyInterestCorrelatesAcknowledgementsAndRetriesLostOnes() {
        var interest = HistoryWindowInterest(), sent: [String] = []
        func publish(_ target: String, _ seconds: Double, accepted: Bool = true) {
            interest.publish(target, now: Date(timeIntervalSince1970: seconds)) { id in sent.append(id); return accepted }
        }
        func consume(_ id: String, accepted: Bool) -> Bool { interest.consume(id, accepted: accepted) }
        publish("a", 0); let first = sent[0]
        publish("a", 19); #expect(sent.count == 1)
        publish("a", 20); let retry = sent[1]
        #expect(!consume(first, accepted: true))
        #expect(interest.confirmedTarget == nil)
        #expect(consume(retry, accepted: true))
        #expect(interest.confirmedTarget == "a")
        #expect(!consume(retry, accepted: true))
        publish("a", 100); #expect(sent.count == 2)
        publish("closed", 101); #expect(interest.confirmedTarget == nil)
        #expect(!consume(retry, accepted: true))
        #expect(consume(sent.last!, accepted: false))
        publish("a", 102, accepted: false); #expect(interest.pendingRequestId == nil)
        publish("a", 103); #expect(interest.pendingRequestId == sent.last)
        interest = HistoryWindowInterest()
        #expect(!consume(sent.last!, accepted: true))
    }

    // A refused close write leaves the Host subscribed to the last acknowledged
    // window. Rapid reopening reuses that live subscription without extra reads.
    @Test func refusedCloseKeepsTheAcknowledgedSubscription() {
        var interest = HistoryWindowInterest(), sent: [String] = []
        interest.publish("a") { sent.append($0); return true }
        let accepted = interest.consume(sent[0], accepted: true)
        #expect(accepted)
        interest.publish("closed") { _ in false }
        #expect(interest.confirmedTarget == "a")
        interest.publish("a") { sent.append($0); return true }
        #expect(sent.count == 1)
        #expect(interest.pendingRequestId == nil)
    }

}
