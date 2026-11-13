import Foundation

/// FT-G11: bound periodic requests by both attempts and actual applied facts.
struct ReadReconcileSchedule {
    private var attemptedAt: Date?
    private var confirmedAt: Date?
    private let interval: TimeInterval = 60

    mutating func started(_ now: Date) { attemptedAt = now }
    mutating func confirmed(_ now: Date) { confirmedAt = now }
    mutating func claim(_ now: Date) -> Bool {
        if let last = [attemptedAt, confirmedAt].compactMap({ $0 }).max(), now.timeIntervalSince(last) < interval { return false }
        attemptedAt = now
        return true
    }
}

/// FT-G12-RESUME-01: an accepted visible interest needs its own source read.
/// Lost acknowledgements can be retried without making every UI update a new read.
struct HistoryWindowInterest {
    private(set) var target: String?
    private(set) var pendingRequestId: String?
    private(set) var confirmedTarget: String?
    private var sentAt: Date?

    mutating func publish(_ target: String, now: Date = Date(), send: (String) -> Bool) {
        guard self.target != target || (pendingRequestId != nil && sentAt.map { now.timeIntervalSince($0) >= 20 } == true) else { return }
        let id = UUID().uuidString
        guard send(id) else { return }
        self.target = target; pendingRequestId = id; sentAt = now; confirmedTarget = nil
    }

    mutating func consume(_ requestId: String, accepted: Bool) -> Bool {
        guard requestId == pendingRequestId else { return false }
        pendingRequestId = nil; sentAt = nil
        confirmedTarget = accepted ? target : nil
        if !accepted { target = nil }
        return true
    }
}
