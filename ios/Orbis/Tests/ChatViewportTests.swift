import Foundation
import CoreGraphics
import Testing
@testable import OrbisCore

struct ChatViewportTests {
    // IOS-CHAT-13-R4: an empty transcript can finish native placement without
    // pretending its business paging policy has already observed a message.
    @Test func nativePlacementRequiresRealVisibleMeasurementAndResetsPerMount() {
        var placement = ChatNativeViewportPlacement()
        placement.measured(visibleContent: false, bottomDistance: 0)
        #expect(!placement.isReady)
        for distance: CGFloat in [.infinity, .nan, 1.01, -1.01] {
            placement.measured(visibleContent: true, bottomDistance: distance)
            #expect(!placement.isReady)
        }
        placement.measured(visibleContent: true, bottomDistance: 1)
        #expect(placement.isReady)
        placement.measured(visibleContent: false, bottomDistance: 500)
        #expect(placement.isReady, "A reader's subsequent movement cannot restart initial bottom placement")
        placement = ChatNativeViewportPlacement()
        #expect(!placement.isReady)
    }

    // A partially clipped preceding tool must not outrank the next visible reading
    // row when it expands. A long reply with no later visible row keeps its anchor.
    @Test func readingAnchorPrefersAVisibleBeginningAndFallsBackToATallReply() {
        let sorted = [CGFloat(-120), 160, 300].sorted(by: ChatViewportAnchorPriority.precedes)
        #expect(sorted == [160, 300, -120])
        #expect([CGFloat(-1600)].sorted(by: ChatViewportAnchorPriority.precedes) == [-1600])
        #expect([CGFloat(0), 120].sorted(by: ChatViewportAnchorPriority.precedes) == [0, 120])
    }

    private func facts(_ y: CGFloat, height: CGFloat = 100, index: Int = 0) -> ChatViewportFacts {
        ChatViewportFacts(frame: CGRect(x: 0, y: y, width: 300, height: height),
                          viewportHeight: 600, row: .init(id: "row-\(index)", index: index))
    }

    // CHAT-QUESTION-02: neither each scroll pixel nor an offscreen lazy host should
    // change the reading row. A retired host cannot remove its replacement's report.
    @Test func readingRowChangesOnlyAtVisibleRowBoundaries() {
        #expect(facts(100) == facts(101))
        #expect(facts(-100) != facts(-99))
        #expect(facts(599) != facts(600))
        var reports = ChatViewportReports()
        let old = UUID(), next = UUID(), replacement = UUID()
        reports.update(next, facts: facts(450, index: 3))
        reports.update(old, facts: facts(-1600, height: 2460, index: 2))
        #expect(reports.snapshot().readingRow?.id == "row-2")
        reports.update(replacement, facts: facts(-1500, height: 2460, index: 2))
        reports.update(old, facts: nil)
        #expect(reports.snapshot().readingRow?.id == "row-2")
        reports.update(replacement, facts: facts(-1500, height: 1400, index: 2))
        #expect(reports.snapshot().readingRow?.id == "row-3")
    }

    // IOS-CHAT-04: geometry may cross thresholds, but never takes reading intent away
    // from a disclosure or a programmatic question jump. Only a real gesture may end it.
    @Test func onlyRealInteractionIdleCanRestoreFollowingAtTheOriginalTwentyPointBoundary() {
        var policy = ChatViewportPolicy()
        policy.disclosureBegan(bottomDistance: 100)
        policy.distanceChanged(0, hasMessages: true)
        let reading = policy
        policy.interactionChanged(false, bottomDistance: 0)
        #expect(policy == reading && !policy.following)

        policy.locateQuestion("q", bottomDistance: 0)
        let question = policy
        policy.interactionChanged(false, bottomDistance: 0)
        #expect(policy == question && policy.suppressQuestionPaging)

        policy.interactionChanged(true, bottomDistance: 0)
        let interacting = policy
        policy.interactionChanged(true, bottomDistance: 0)
        #expect(policy == interacting, "tracking/interacting and repeated legacy pan samples are one gesture")
        policy.interactionChanged(false, bottomDistance: 20)
        #expect(policy.following && !policy.hasBrowsed)
        let finished = policy
        policy.interactionChanged(false, bottomDistance: 0)
        #expect(policy == finished)

        policy.interactionChanged(true, bottomDistance: 0)
        policy.interactionChanged(false, bottomDistance: 20.001)
        #expect(policy.mode == .reading && policy.hasBrowsed)
        policy.distanceChanged(0, hasMessages: true)
        #expect(!policy.following)
    }

    // IOS-CHAT-04: bottom pixels stay outside published policy state. The jump button
    // retains the existing strict three-line threshold, even when the tail is lazy-released.
    @Test func distanceSamplesPublishOnlyPositioningOrJumpThresholdChanges() {
        var policy = ChatViewportPolicy()
        let initial = policy
        policy.distanceChanged(.infinity, hasMessages: true)
        policy.distanceChanged(0, hasMessages: false)
        #expect(policy == initial)
        policy.distanceChanged(0, hasMessages: true)
        #expect(policy.hasPositioned)
        policy.interactionChanged(true, bottomDistance: 60)
        #expect(!policy.showJump)
        policy.distanceChanged(60.001, hasMessages: true)
        #expect(policy.showJump)
        let above = policy
        for distance in [CGFloat(61), 62, 100, .infinity] {
            policy.distanceChanged(distance, hasMessages: true)
            #expect(policy == above)
        }
        policy.distanceChanged(60, hasMessages: true)
        #expect(!policy.showJump)
    }

    // CHAT-PAGING-01: release consumes the gesture before the read, so a quick
    // cache hit, a slow network response, and a repeated release cannot replay it.
    @Test func historyPullConsumesEachGestureExactlyOnce() {
        var pan = ChatHistoryPan()
        let pull = CGPoint(x: 5, y: 56)
        func release(_ translation: CGPoint) -> Bool { pan.release(translation: translation) }
        #expect(!release(pull))
        pan.begin(nearTop: true, admitted: false)
        #expect(!release(pull))
        pan.begin(nearTop: true, admitted: true)
        #expect(!release(CGPoint(x: 0, y: 20)))
        pan.begin(nearTop: true, admitted: true)
        #expect(!release(CGPoint(x: 70, y: 56)))
        pan.begin(nearTop: true, admitted: true)
        #expect(release(pull))
        #expect(!release(pull))
        pan.begin(nearTop: false, admitted: true)
        #expect(release(pull))
        pan.begin(nearTop: true, admitted: true)
        pan.cancel()
        #expect(!release(pull))
    }

    // CHAT-PAGING-04: preview and release must use the same threshold and ownership gates.
    @Test func historyPullTracksDistanceAndDisarmsOnReversalOrCancellation() {
        var pan = ChatHistoryPan()
        pan.begin(nearTop: true, admitted: false)
        #expect(pan.progress(translation: .init(x: 0, y: 80)) == 0)
        pan.begin(nearTop: true, admitted: true)
        #expect(pan.progress(translation: .init(x: 0, y: 11)) == 0.25)
        #expect(pan.progress(translation: .init(x: 0, y: 44)) == 1)
        #expect(pan.progress(translation: .init(x: 0, y: 22)) == 0.5)
        #expect(pan.progress(translation: .init(x: 30, y: 22)) == 0)
        #expect(pan.progress(translation: .init(x: 0, y: 44), nearTop: false) == 0)
        let reversed = pan.release(translation: .init(x: 0, y: 22))
        #expect(!reversed)
        #expect(pan.progress(translation: .init(x: 0, y: 44)) == 0)
        pan.begin(nearTop: false, admitted: true)
        #expect(pan.progress(translation: .init(x: 0, y: 12)) == 1)
        let blocked = pan.release(translation: .init(x: 0, y: 12), admitted: false)
        #expect(!blocked)
        pan.begin(nearTop: true, admitted: true)
        pan.cancel()
        let cancelled = pan.release(translation: .init(x: 0, y: 44))
        #expect(!cancelled)
    }

    @Test func historyAcceptanceDoesNotRetireTheUsersNativeGesture() {
        var policy = ChatViewportPolicy()
        policy.interactionChanged(true, bottomDistance: 100)
        policy.olderPageAccepted(bottomDistance: 100)
        #expect(policy.awaitingOlderPage && policy.mode == .interacting)
        policy.interactionChanged(false, bottomDistance: 20)
        #expect(!policy.following, "A short page must not jump to its newly added tail")
        policy.olderPageFinished()
        #expect(!policy.awaitingOlderPage)
    }

    // IOS-CHAT-04: both native adapters call owns immediately before scrollTo. A
    // superseded request cannot regain authority through an idle or A→B→A target reuse.
    @Test func explicitScrollRequestsAreFencedBySequenceContextAndInteraction() throws {
        var policy = ChatViewportPolicy()
        policy.jumpToLatest()
        let first = try #require(policy.request)
        #expect(policy.owns(first) && first.target == .latest)
        policy.jumpToLatest()
        let second = try #require(policy.request)
        #expect(second.sequence > first.sequence && !policy.owns(first) && policy.owns(second))
        policy.interactionChanged(true, bottomDistance: 100)
        #expect(!policy.owns(second))
        policy.locateQuestion("same-question", bottomDistance: 100)
        let located = try #require(policy.request)
        #expect(located.interactionGeneration > second.interactionGeneration && policy.owns(located))
        policy.interactionChanged(false, bottomDistance: 0)
        #expect(policy.owns(located) && !policy.following)
        policy.disclosureBegan(bottomDistance: 0)
        #expect(!policy.owns(located))
        policy.locateQuestion("same-question", bottomDistance: 100)
        let oldContext = try #require(policy.request)
        policy.resetContext()
        policy.resetContext()
        policy.locateQuestion("same-question", bottomDistance: 100)
        let reused = try #require(policy.request)
        #expect(reused.contextGeneration > oldContext.contextGeneration)
        #expect(!policy.owns(oldContext) && policy.owns(reused))
    }

    // IOS-CHAT-16: retiring the gesture that a new explicit intent superseded must
    // preserve that intent, even before its target is reached. A later gesture
    // must still cancel it. Both targets share the same ownership contract.
    @Test func explicitIntentSurvivesOldGestureIdleButYieldsToANewGesture() throws {
        for target: ChatViewportPolicy.Target in [.latest, .question("question"), .page(-510)] {
            var policy = ChatViewportPolicy()
            policy.interactionChanged(true, bottomDistance: 800)
            switch target {
            case .latest: policy.jumpToLatest()
            case .question(let id): policy.locateQuestion(id, bottomDistance: 800)
            case .page: policy.turnPage(towardEarlier: true, viewportHeight: 600, bottomDistance: 800)
            }
            let request = try #require(policy.request)
            let intent = policy
            policy.interactionChanged(false, bottomDistance: 800)
            policy.interactionChanged(false, bottomDistance: 0)
            #expect(policy == intent && policy.owns(request))
            #expect(policy.following == (target == .latest))

            policy.interactionChanged(true, bottomDistance: 800)
            #expect(!policy.owns(request) && policy.request == nil)
            #expect(policy.mode == .interacting)
            policy.interactionChanged(false, bottomDistance: 800)
            #expect(!policy.following && policy.mode == .reading)
        }
    }

    // IOS-CHAT-04: source/branch reset clears only viewport policy and emits no jump.
    // In particular it cannot carry an automatic edge or pending old-page gate forward.
    @Test func contextResetRetiresReadingAndPagingWithoutCreatingAScrollRequest() {
        var policy = ChatViewportPolicy()
        policy.distanceChanged(100, hasMessages: true)
        policy.interactionChanged(true, bottomDistance: 100)
        policy.directionChanged(towardEarlier: true)
        policy.questionChanged(outside: true)
        policy.locateQuestion("q", bottomDistance: 100)
        policy.olderPageAccepted(bottomDistance: 100)
        policy.resetContext()
        #expect(policy.following && !policy.hasPositioned && !policy.hasBrowsed)
        #expect(!policy.showJump && !policy.showQuestionReminder && !policy.lastScrollTowardEarlier)
        #expect(!policy.suppressQuestionPaging && !policy.awaitingOlderPage)
        #expect(policy.request == nil)
    }
}

private final class ToolFormattingProbe: @unchecked Sendable {
    private let lock = NSLock()
    private var calls = 0
    var count: Int { lock.lock(); defer { lock.unlock() }; return calls }
    func prepare(_ content: ChatContent, _ result: ChatMessage?) -> PreparedChatToolText {
        #expect(!Thread.isMainThread)
        let gate = DispatchSemaphore(value: 0)
        Task { @MainActor in gate.signal() }
        #expect(gate.wait(timeout: .now() + 3) == .success)
        lock.lock(); calls += 1; lock.unlock()
        return PreparedChatToolText(content: content, result: result)
    }
}

struct ChatToolPreparationTests {
    // PERF-11: formatting a large legacy tool payload cannot occupy MainActor;
    // unrelated reply updates reuse it, but arguments/results/owner changes cannot.
    @Test @MainActor func formattingRunsOffMainAndInvalidatesOnlyForItsInputs() async throws {
        let probe = ToolFormattingProbe()
        let worker = ChatTranscriptWorker(prepareToolText: { probe.prepare($0, $1) })
        func call(_ argument: String) -> ChatMessage {
            let content = ChatContent(type: "tool_call", text: nil, toolName: "read", artifact: nil,
                toolCallId: "tool", arguments: .object(["payload": .string(argument), "line": .integer(9_007_199_254_740_993)]))
            return ChatMessage(messageId: "call", role: "assistant", content: [content], timestamp: 0, isError: nil)
        }
        func result(_ text: String) -> ChatMessage {
            ChatMessage(messageId: "result", role: "tool",
                content: [ChatContent(type: "text", text: text, toolName: nil, artifact: nil)],
                timestamp: 1, isError: nil, toolCallId: "tool")
        }
        let argument = String(repeating: "长工具参数 👩🏽‍💻 /repo\n", count: 4000)
        let first = await worker.resolve(identity: "host-a", messages: [call(argument), result("first")], timings: [:])
        let prepared = try #require(first.toolTextByRow[first.rows[0].id]?["tool"])
        #expect(prepared.arguments?.contains("9007199254740993") == true)
        #expect(prepared.arguments == toolArgumentsText(call(argument).content[0]))
        #expect(prepared.result == "first" && probe.count == 1)
        let unrelated = ChatMessage(messageId: "new", role: "assistant",
            content: [ChatContent(type: "text", text: "More reply", toolName: nil, artifact: nil)], timestamp: 2, isError: nil)
        let unchanged = await worker.resolve(identity: "host-a", messages: [call(argument), result("first"), unrelated], timings: [:])
        #expect(unchanged.toolTextByRow[first.rows[0].id]?["tool"]?.result == "first")
        #expect(probe.count == 1)
        let changed = await worker.resolve(identity: "host-a", messages: [call(argument), result("second")], timings: [:])
        #expect(changed.toolTextByRow[first.rows[0].id]?["tool"]?.result == "second")
        #expect(probe.count == 2)
        let rewritten = await worker.resolve(identity: "host-a", messages: [call("new argument"), result("second")], timings: [:])
        #expect(rewritten.toolTextByRow[first.rows[0].id]?["tool"]?.arguments?.contains("new argument") == true)
        #expect(probe.count == 3)
        _ = await worker.resolve(identity: "host-b", messages: [call("new argument"), result("second")], timings: [:])
        #expect(probe.count == 4)
    }

    // Older adapters may omit a tool-call ID. Match the existing grouped display
    // identity so they also use prepared text instead of formatting while scrolling.
    @Test func missingCallIdentityUsesTheSameDisplayKey() {
        let block = ChatContent(type: "toolCall", text: "unstructured input", toolName: "read", artifact: nil)
        let message = ChatMessage(messageId: "legacy", role: "assistant", content: [block], timestamp: 0, isError: nil)
        let transcript = ChatTranscript(messages: [message], turnTimings: [:])
        let key = assistantCardContent([message]).tools[0].id
        #expect(transcript.toolTextByRow[transcript.rows[0].id]?[key]?.arguments == "unstructured input")
    }
}
