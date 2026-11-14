// Orbis 测试用途（场景与判定见本文件断言）：
// - 复制反馈 / M05（M05、V16、SC23、MOT-08）
import Foundation
import Combine
import Testing
@testable import OrbisCore

@Suite("Copy success lifetime (M05)") @MainActor
struct CopyFeedbackTests {
    /// Intentionally ignores cancellation so late completions exercise the production guard.
    private actor Timer {
        var durations: [UInt64] = []
        private var sleepers: [Int: CheckedContinuation<Void, Never>] = [:]

        func sleep(_ nanoseconds: UInt64) async {
            let index = durations.count
            durations.append(nanoseconds)
            await withCheckedContinuation { sleepers[index] = $0 }
        }

        func finish(_ index: Int) { sleepers.removeValue(forKey: index)?.resume() }
        func finishAll() {
            let pending = sleepers.values
            sleepers.removeAll()
            for continuation in pending { continuation.resume() }
        }
    }

    private func settle() async {
        for _ in 0..<100 { await Task.yield() }
    }

    @Test func copyRunsBeforeFeedbackAndExpiresUsingTheSharedTwoPointFiveSecondDelay() async {
        let timer = Timer()
        let feedback = OrbisCopyFeedback { await timer.sleep($0) }
        var contents = ""
        feedback.perform {
            #expect(!feedback.copied)
            contents = "copied content"
        }
        #expect(feedback.copied)
        await settle()
        #expect(await timer.durations == [2_500_000_000])
        await timer.finish(0)
        await settle()
        #expect(!feedback.copied)
        #expect(contents == "copied content")
        await timer.finishAll()
    }

    @Test func lateCompletionOfTheFirstCopyCannotClearTheSecondCopy() async {
        let timer = Timer()
        let feedback = OrbisCopyFeedback { await timer.sleep($0) }
        var copies = 0
        feedback.perform { copies += 1 }
        await settle()
        feedback.perform { copies += 1 }
        await settle()
        #expect(await timer.durations == [2_500_000_000, 2_500_000_000])
        await timer.finish(0)
        await settle()
        #expect(feedback.copied)
        #expect(copies == 2)
        await timer.finish(1)
        await settle()
        #expect(!feedback.copied)
        await timer.finishAll()
    }

    @Test func clearingForDepartureOrDisableCancelsTheOldOwnerBeforeReentry() async {
        let timer = Timer()
        let feedback = OrbisCopyFeedback { await timer.sleep($0) }
        feedback.perform {}
        await settle()
        feedback.clear()
        #expect(!feedback.copied)
        feedback.perform {}
        await settle()
        await timer.finish(0)
        await settle()
        #expect(feedback.copied)
        feedback.clear()
        await timer.finish(1)
        await settle()
        #expect(!feedback.copied)
        await timer.finishAll()
    }

    // PERF-10: a lazy list clears every copy button it removes; idle ones must not publish.
    @Test func clearingIdleFeedbackPublishesNothing() async {
        let timer = Timer()
        let feedback = OrbisCopyFeedback { await timer.sleep($0) }
        var publications = 0
        let observation = feedback.objectWillChange.sink { publications += 1 }
        defer { observation.cancel() }
        feedback.clear()
        #expect(publications == 0)
        feedback.perform {}
        feedback.clear()
        #expect(publications == 2 && !feedback.copied)
        await timer.finishAll()
    }

    @Test func pendingResetDoesNotKeepADiscardedCopyOwnerAlive() async {
        let timer = Timer()
        var feedback: OrbisCopyFeedback? = OrbisCopyFeedback { await timer.sleep($0) }
        weak var discarded = feedback
        feedback?.perform {}
        await settle()
        feedback = nil
        #expect(discarded == nil)
        await timer.finishAll()
        await settle()
    }
}
