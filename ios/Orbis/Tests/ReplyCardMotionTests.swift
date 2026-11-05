import Foundation
import CoreGraphics
import Testing
@testable import OrbisCore

struct ReplyCardMotionTests {
    @Test func heightRetargetsContinuouslyAndSameTargetRewriteCanSnap() {
        var height = ReplyCardHeight()
        height.retarget(80, at: 0, animated: false, duration: 0.18)
        height.retarget(140, at: 1, animated: true, duration: 0.18)
        let middle = height.value(at: 1.06)!
        #expect(middle > 80 && middle < 140)
        height.retarget(200, at: 1.06, animated: true, duration: 0.18)
        #expect(height.value(at: 1.06) == middle)
        height.retarget(200, at: 1.07, animated: true, duration: 0.18)
        #expect(height.value(at: 1.25) == 200)
        height.retarget(300, at: 2, animated: true, duration: 0.18)
        height.retarget(300, at: 2.02, animated: false, duration: 0.18)
        #expect(height.value(at: 2.02) == 300)
        #expect(!height.isAnimating(at: 2.02))
        height.retarget(40, at: 3, animated: false, duration: 0.18)
        #expect(height.value(at: 3) == 40)
    }
    private func parts(_ text: String) -> [ReplyCardPart] { [.init(id: "message:text", text: text)] }
    @Test func onlyAppendedLiveContentGrowsAndSameLineTokensKeepTheTransition() {
        var policy = ReplyCardGrowth()
        let initial = policy.update(size: .init(width: 300, height: 50), parts: parts("A"), live: true, reduced: false)
        let growth = policy.update(size: .init(width: 300, height: 100), parts: parts("AB"), live: true, reduced: false)
        let sameLine = policy.update(size: .init(width: 300, height: 100), parts: parts("ABC"), live: true, reduced: false)
        // A final append can arrive in the same snapshot that ends streaming.
        let finalAppend = policy.update(size: .init(width: 300, height: 120), parts: parts("ABCD"), live: false, reduced: false)
        let history = policy.update(size: .init(width: 300, height: 140), parts: parts("ABCDE"), live: false, reduced: false)
        #expect([initial, growth, sameLine, finalAppend, history] == [false, true, true, true, false])
    }
    @Test func disclosureReflowRewriteAndReducedMotionSettleDirectly() {
        for operation in 0...3 {
            var policy = ReplyCardGrowth()
            _ = policy.update(size: .init(width: 300, height: 50), parts: parts("ABC"), live: true, reduced: false)
            let animated = policy.update(size: .init(width: operation == 1 ? 200 : 300, height: 100),
                parts: parts(operation == 0 ? "ABC" : operation == 2 ? "Z" : "ABCD"), live: true, reduced: operation == 3)
            #expect(!animated)
        }
    }
    @Test func freshCardsEnterButExistingCardsAndReducedMotionDoNot() {
        for entering in [false, true] {
            for reduced in [false, true] {
                var policy = ReplyCardGrowth()
                let animated = policy.update(size: .init(width: 300, height: 80), parts: parts("A"), live: true,
                    reduced: reduced, entering: entering)
                #expect(animated == (entering && !reduced))
            }
        }
    }
    @Test func arrivalsAreOnlyForNewTailRowsAndConsumedOnce() {
        let arrivals = ReplyCardArrivals()
        arrivals.observe(rows: [("a", ["a"])], ready: true, following: true, now: 0)
        #expect(!arrivals.claim("a", now: 0))
        arrivals.observe(rows: [("a", ["a"]), ("b", ["b"])], ready: true, following: true, now: 1)
        #expect(arrivals.claim("b", now: 1.05))
        #expect(!arrivals.claim("b", now: 1.06))
        arrivals.observe(rows: [("older", ["older"]), ("a", ["a"]), ("b", ["b"])], ready: true, following: true, now: 2)
        #expect(!arrivals.claim("older", now: 2))
    }
    @Test func restoreReadingLazyRemountAndRepartitionNeverReplayArrival() {
        for mode in 0...3 {
            let arrivals = ReplyCardArrivals()
            arrivals.observe(rows: [("a", ["a", "b"])], ready: mode != 0, following: true, now: 0)
            arrivals.observe(rows: [("a", ["a"]), ("b", [mode == 3 ? "b" : "new"])], ready: true,
                following: mode != 1, now: 1)
            #expect(!arrivals.claim("b", now: mode == 2 ? 2 : 1))
        }
    }
}
