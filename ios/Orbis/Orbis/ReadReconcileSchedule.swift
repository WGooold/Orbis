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
