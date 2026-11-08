import Foundation
import Testing
@testable import OrbisCore

// S39 / SC60: notification requires same-source active→completed progression. Initial,
// duplicate, failed, cancelled, idle and older epochs cannot claim a new reply.
@Suite("Default reply completion notifications")
struct ReplyCompletionTests {
    private func event(_ type: String = "session.patch", epoch: String = "source", seq: Int = 1, outcome: String? = nil, turn: String = "t1") -> [String: Any] {
        var value: [String: Any] = ["turnId": turn, "startedAt": 100]
        if let outcome { value["outcome"] = outcome; value["durationMs"] = 50 }
        return ["type": type, "source": ["ready": true, "epoch": epoch, "seq": seq], "live": ["complete": true, "turn": value]]
    }
    @Test func onlyAdvancingSameSourceCompletionNotifiesOnce() {
        let tracker = ReplyCompletionTracker()
        let first = tracker.consume(event(seq: 1, outcome: "completed"), sessionId: "s1")
        let active = tracker.consume(event(seq: 2, turn: "t2"), sessionId: "s1")
        let done = tracker.consume(event(seq: 3, outcome: "completed", turn: "t2"), sessionId: "s1")
        let duplicate = tracker.consume(event(seq: 3, outcome: "completed", turn: "t2"), sessionId: "s1")
        let replay = tracker.consume(event(seq: 4, outcome: "completed", turn: "t2"), sessionId: "s1")
        #expect(!first); #expect(!active); #expect(done); #expect(!duplicate); #expect(!replay)
        for outcome in ["failed", "cancelled", "unknown"] {
            let silent = ReplyCompletionTracker()
            #expect(!silent.consume(event("session.snapshot"), sessionId: "s1"))
            #expect(!silent.consume(event(seq: 2, outcome: outcome), sessionId: "s1"))
        }
    }
    @Test func snapshotEpochChangeDisconnectAndIdleStaySilent() {
        let tracker = ReplyCompletionTracker()
        #expect(!tracker.consume(event("session.snapshot", outcome: "completed"), sessionId: "s1"))
        #expect(!tracker.consume(event(seq: 2, outcome: "completed"), sessionId: "s1"))
        #expect(!tracker.consume(event(seq: 3, turn: "t2"), sessionId: "s1"))
        #expect(!tracker.consume(event(epoch: "replacement", seq: 4, outcome: "completed", turn: "t2"), sessionId: "s1"))
        #expect(!tracker.consume(event(epoch: "replacement", seq: 5, turn: "t3"), sessionId: "s1"))
        tracker.resetActive()
        #expect(!tracker.consume(event(epoch: "replacement", seq: 6, outcome: "completed", turn: "t3"), sessionId: "s1"))
        var idle = event(seq: 7); idle["live"] = ["complete": true, "turn": NSNull()]
        #expect(!tracker.consume(idle, sessionId: "s1"))
        #expect(!tracker.consume(["type": "turn.finished", "outcome": "completed"], sessionId: "s1"))
    }
    @Test func receiptsPersistPerPairingAcrossRestarts() throws {
        let name = "orbis.notification-test." + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        let first = ReplyCompletionTracker(preferences: defaults, owner: "host-a")
        #expect(!first.consume(event("session.snapshot"), sessionId: "s1"))
        #expect(first.consume(event(seq: 2, outcome: "completed"), sessionId: "s1"))
        let restored = ReplyCompletionTracker(preferences: defaults, owner: "host-a")
        #expect(!restored.consume(event("session.snapshot"), sessionId: "s1"))
        #expect(!restored.consume(event(seq: 2, outcome: "completed"), sessionId: "s1"))
        let other = ReplyCompletionTracker(preferences: defaults, owner: "host-b")
        #expect(!other.consume(event("session.snapshot"), sessionId: "s1"))
        #expect(other.consume(event(seq: 2, outcome: "completed"), sessionId: "s1"))
    }
}
