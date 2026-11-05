import Foundation
import Testing
@testable import OrbisCore

/// ADR-0046 §4 / M04: one cursor per message, characters start strictly in order.
struct RevealClockTests {
    private func startTime(_ clock: RevealClock, _ offset: Int) -> TimeInterval? {
        clock.segments.last(where: { $0.start <= offset && offset < $0.end })?.startTime(offset)
    }

    @Test func aNewBatchQueuesBehindTheUnrevealedTail() {
        var clock = RevealClock(known: 0)
        clock.observe(length: 10, at: 0)
        clock.observe(length: 20, at: 0.05)
        let tail = startTime(clock, 9)!, head = startTime(clock, 10)!
        #expect(head >= tail)
        #expect(abs(head - (tail + RevealClock.stagger)) < 1e-9)
        // The next batch has not started while the previous one is still revealing.
        #expect(clock.progress(10, at: 0.06) == 0)
        #expect(clock.progress(9, at: 0.06) == 0)
    }

    @Test func progressNeverIncreasesAlongTheTextAndEveryCharacterStartsWithinTheDelay() {
        var clock = RevealClock(known: 0)
        var arrival: [TimeInterval] = []
        var now: TimeInterval = 0
        var generator = SystemRandomNumberGenerator()
        for _ in 0..<60 {
            now += Double.random(in: 0.016...0.12, using: &generator)
            let count = Int.random(in: 1...40, using: &generator)
            arrival += Array(repeating: now, count: count)
            clock.observe(length: arrival.count, at: now)
            for offset in 0..<arrival.count {
                guard let start = startTime(clock, offset) else { continue }
                #expect(start - arrival[offset] <= RevealClock.maxDelay + 1e-9)
                if offset > 0, let previous = startTime(clock, offset - 1) { #expect(start >= previous - 1e-9) }
            }
            var sample = now
            while sample < now + 0.12 {
                let values = (0..<arrival.count).map { clock.progress($0, at: sample) }
                // The animating region is one contiguous stretch right behind the settled text.
                #expect(zip(values, values.dropFirst()).allSatisfy { $0 >= $1 })
                sample += 0.016
            }
        }
    }

    @Test func aLargeBatchCompressesItsSpacingButStaysInOrder() {
        var clock = RevealClock(known: 0)
        clock.observe(length: 500, at: 1)
        #expect(startTime(clock, 499)! <= 1 + RevealClock.maxDelay + 1e-9)
        #expect(startTime(clock, 250)! >= startTime(clock, 249)!)
        #expect(clock.isAnimating(at: 1.2))
        #expect(!clock.isAnimating(at: 1 + RevealClock.maxDelay + RevealClock.duration + 0.01))
    }

    @Test func baselineTextIsSettledAndUnobservedTextStaysHidden() {
        let clock = RevealClock(known: 5)
        #expect((0..<5).allSatisfy { clock.progress($0, at: 0) == 1 })
        #expect(clock.progress(5, at: 100) == 0)
    }

    @Test func rewrittenOrShortenedTextSettlesWithoutReplaying() {
        var clock = RevealClock(known: 0)
        clock.observe(length: 40, at: 0)
        clock.observe(length: 30, at: 0.05)
        #expect(clock.known == 30)
        #expect((0..<30).allSatisfy { clock.progress($0, at: 0.05) == 1 })
        #expect(!clock.isAnimating(at: 0.05))
    }

    @Test func settledSegmentsAdvanceTheSettledOffset() {
        var clock = RevealClock(known: 0)
        clock.observe(length: 3, at: 0)
        clock.observe(length: 6, at: 1)
        #expect(clock.settledBelow == 3)
        #expect(clock.progress(4, at: 1) == 0)
    }
}
