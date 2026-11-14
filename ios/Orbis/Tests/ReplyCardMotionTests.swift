import Foundation
import CoreGraphics
import Testing
@testable import OrbisCore

struct ReplyCardMotionTests {
    /// IOS-CHAT-05: polling belongs only to an arrived, stationary top page.
    /// Covering/dragging/backgrounding must not affect the separate mounted lease.
    @Test func gitPollingRequiresEveryForegroundPageCondition() {
        for top in [false, true] {
            for stationary in [false, true] {
                for arrived in [false, true] {
                    for scene in [false, true] {
                        let activity = OrbisPageActivity(isTop: top, isStationary: stationary, hasArrived: arrived)
                        #expect(activity.pollsGit(sceneActive: scene) == (top && stationary && arrived && scene))
                    }
                }
            }
        }
    }

    /// Source updates while covered become the arrival baseline. A fresh row
    /// after return still gets exactly one ticket; hidden rows never replay.
    @Test func coveredSourceUpdatesAreConsumedBeforeReturning() {
        let arrivals = ReplyCardArrivals()
        arrivals.observe(rows: [("a", ["a"])], ready: true, following: true, now: 0)
        arrivals.observe(rows: [("a", ["a"]), ("hidden", ["hidden"])], ready: false, following: true, now: 1)
        arrivals.observe(rows: [("a", ["a"]), ("hidden", ["hidden"])], ready: true, following: true, now: 1.05)
        #expect(!arrivals.claim("hidden", now: 1.05))
        arrivals.observe(rows: [("a", ["a"]), ("hidden", ["hidden"]), ("new", ["new"])], ready: true, following: true, now: 1.1)
        #expect(arrivals.claim("new", now: 1.11))
        #expect(!arrivals.claim("new", now: 1.12))
    }

    /// Resetting the same reveal clock to the newest known length settles hidden
    /// data immediately; only a later foreground append starts another reveal.
    @Test func hiddenRevealCatchupHasNoQueuedAnimationToReplay() {
        var clock = RevealClock(known: 4)
        clock.observe(length: 100, at: 1)
        #expect(clock.isAnimating(at: 1.01))
        clock = RevealClock(known: 150)
        #expect(!clock.isAnimating(at: 1.02))
        #expect(clock.progress(149, at: 1.02) == 1)
        clock.observe(length: 151, at: 1.03)
        #expect(clock.progress(149, at: 1.03) == 1)
        #expect(clock.isAnimating(at: 1.04))
    }

    /// IOS-CHAT-05: the hidden input can finish parsing after the page returns.
    /// That delayed completion settles; only the next foreground input reveals.
    @Test @MainActor func delayedHiddenMarkdownCompletionDoesNotReplayAfterReturning() async throws {
        let started = AsyncStream<Void>.makeStream()
        let release = DispatchSemaphore(value: 0)
        let hidden = "hidden input that finishes parsing after returning"
        let worker = MarkdownParsingWorker(cache: MarkdownDocumentCache(), parse: { source in
            if source == hidden {
                started.continuation.yield(())
                #expect(release.wait(timeout: .now() + 30) == .success)
            }
            return PreparedMarkdownDocument(source)
        })
        let preparation = MarkdownPreparation(text: "", interval: 0, resolve: { await worker.resolve($0) })
        var catchUp = OrbisRevealCatchUp()
        catchUp.sourceChanged(hidden, active: false)
        preparation.update(hidden, streaming: true)
        var events = started.stream.makeAsyncIterator()
        _ = await events.next()
        catchUp.visibilityChanged(active: true, source: hidden, preparedSource: nil)
        #expect(catchUp.hiddenSource == hidden)
        release.signal()
        await preparation.waitForPending()
        let first = try #require(preparation.prepared)
        let hiddenReveals = catchUp.allowsReveal(preparedSource: first.text, currentSource: hidden, active: true)
        #expect(!hiddenReveals)
        #expect(catchUp.hiddenSource == nil)
        let foreground = hidden + " foreground append"
        preparation.update(foreground, streaming: true)
        await preparation.waitForPending()
        let foregroundReveals = catchUp.allowsReveal(preparedSource: preparation.prepared?.text, currentSource: foreground, active: true)
        #expect(foregroundReveals)
    }

    @Test func hiddenRevealCatchupWaitsForTheMatchingRewriteOrCoalescedSuccessor() {
        var catchUp = OrbisRevealCatchUp()
        catchUp.sourceChanged("hidden rewrite", active: false)
        catchUp.visibilityChanged(active: true, source: "hidden rewrite", preparedSource: "old document")
        #expect(catchUp.hiddenSource == "hidden rewrite")
        let oldReveals = catchUp.allowsReveal(preparedSource: "old document", currentSource: "hidden rewrite", active: true)
        #expect(!oldReveals)
        let coalescedReveals = catchUp.allowsReveal(preparedSource: "hidden rewrite and new append", currentSource: "latest waiting source", active: true)
        #expect(!coalescedReveals)
        #expect(catchUp.hiddenSource == nil)
        let hiddenRewrite = "hidden-01", visibleRewrite = "visible01"
        #expect(hiddenRewrite.utf16.count == visibleRewrite.utf16.count)
        catchUp.sourceChanged(hiddenRewrite, active: false)
        catchUp.visibilityChanged(active: true, source: visibleRewrite, preparedSource: "old-value")
        let rewriteReveals = catchUp.allowsReveal(preparedSource: visibleRewrite, currentSource: visibleRewrite, active: true)
        #expect(!rewriteReveals)
        #expect(catchUp.hiddenSource == nil)
        // A cache hit may already provide the newest document at visibility change.
        catchUp.sourceChanged("cached hidden", active: false)
        catchUp.visibilityChanged(active: true, source: "cached hidden plus append", preparedSource: "cached hidden plus append")
        #expect(catchUp.hiddenSource == nil)
        let nextReveals = catchUp.allowsReveal(preparedSource: "cached hidden plus append next", currentSource: "cached hidden plus append next", active: true)
        #expect(nextReveals)
    }

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
