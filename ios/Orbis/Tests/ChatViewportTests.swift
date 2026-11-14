import Foundation
import CoreGraphics
import Testing
@testable import OrbisCore

struct ChatViewportTests {
    private func facts(_ y: CGFloat, height: CGFloat = 100, first: Bool = false, question: String? = nil) -> ChatViewportFacts {
        ChatViewportFacts(frame: CGRect(x: 0, y: y, width: 300, height: height),
                          viewportHeight: 600, firstRow: first, questionID: question)
    }

    // Ordinary pixel movement must not publish a new preference or invalidate the
    // transcript; all existing visible/top/reminder thresholds still take effect.
    @Test func onlyBoundaryCrossingsChangeViewportFacts() {
        #expect(facts(100) == facts(101))
        #expect(facts(-101) == facts(-102))
        #expect(facts(-100) != facts(-99))
        #expect(facts(599) != facts(600))
        #expect(facts(-41, first: true) != facts(-40, first: true))
        #expect(facts(-40, first: true) == facts(-39, first: true))
        #expect(!facts(-40).firstRowNearTop)
    }

    // The reminder's dead band is wider than visibility. Missing lazy rows and
    // changing source-question IDs must not accidentally count as on-screen.
    @Test func questionDeadBandAndIdentitySurviveLazyRelease() {
        var viewport = facts(200)
        viewport.merge(facts(-108, question: "q"))
        #expect(!viewport.questionOutsideViewport("q"))
        viewport.merge(facts(-109, question: "q"))
        #expect(viewport.questionOutsideViewport("q"))
        viewport.merge(facts(608, question: "q"))
        #expect(!viewport.questionOutsideViewport("q"))
        viewport.merge(facts(609, question: "q"))
        #expect(viewport.questionOutsideViewport("q"))
        viewport.merge(facts(200, question: "q"))
        #expect(!viewport.questionOutsideViewport("q"))
        #expect(viewport.questionOutsideViewport("new-question"))
        #expect(!viewport.questionOutsideViewport(nil))
        #expect(facts(200).questionOutsideViewport("released-question"))
        #expect(!ChatViewportFacts().questionOutsideViewport("q"))
    }

    // Reducing unrelated row reports preserves the first-row and question facts
    // regardless of row order, without carrying a growing frame dictionary.
    @Test func mergingRowsPreservesPagingAndQuestionFacts() {
        let reports = [facts(-39, first: true), facts(300), facts(700, question: "q")]
        func merge(_ rows: [ChatViewportFacts]) -> ChatViewportFacts {
            rows.reduce(into: ChatViewportFacts()) { $0.merge($1) }
        }
        let viewport = merge(reports)
        #expect(viewport == merge(Array(reports.reversed())))
        #expect(viewport.firstRowNearTop && viewport.hasVisibleRows)
        #expect(viewport.questionOutsideViewport("q"))
    }

    // IOS-CHAT-04: geometry may cross thresholds, but never takes reading intent away
    // from a disclosure or a programmatic question jump. Only a real gesture may end it.
    @Test func onlyRealInteractionIdleCanRestoreFollowingAtTheOriginalTwentyPointBoundary() {
        var policy = ChatViewportPolicy()
        policy.disclosureBegan(bottomDistance: 100)
        policy.distanceChanged(0, hasMessages: true, firstRowNearTop: false)
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
        policy.distanceChanged(0, hasMessages: true, firstRowNearTop: false)
        #expect(!policy.following)
    }

    // IOS-CHAT-04: bottom pixels stay outside published policy state. The jump button
    // retains the existing strict three-line threshold, even when the tail is lazy-released.
    @Test func distanceSamplesPublishOnlyPositioningOrJumpThresholdChanges() {
        var policy = ChatViewportPolicy()
        let initial = policy
        policy.distanceChanged(.infinity, hasMessages: true, firstRowNearTop: false)
        policy.distanceChanged(0, hasMessages: false, firstRowNearTop: false)
        #expect(policy == initial)
        policy.distanceChanged(0, hasMessages: true, firstRowNearTop: false)
        #expect(policy.hasPositioned && policy.topArmed)
        policy.interactionChanged(true, bottomDistance: 60)
        #expect(!policy.showJump)
        policy.distanceChanged(60.001, hasMessages: true, firstRowNearTop: false)
        #expect(policy.showJump)
        let above = policy
        for distance in [CGFloat(61), 62, 100, .infinity] {
            policy.distanceChanged(distance, hasMessages: true, firstRowNearTop: false)
            #expect(policy == above)
        }
        policy.distanceChanged(60, hasMessages: true, firstRowNearTop: false)
        #expect(!policy.showJump)
    }

    // IOS-CHAT-04: top entry is a consumed viewport edge, including rejected/busy
    // entries. A page finishing while still at top cannot launch the next page by itself.
    @Test func topPagingRequiresANewEdgeAfterCompletionOrBlockedEntry() {
        var policy = ChatViewportPolicy()
        let top = facts(0, first: true), away = facts(-41, first: true)
        policy.distanceChanged(0, hasMessages: true, firstRowNearTop: true)
        let initialTop = policy.viewportChanged(top, questionID: nil, canPage: true)
        #expect(!initialTop)
        let leavingInitialTop = policy.viewportChanged(away, questionID: nil, canPage: true)
        #expect(!leavingInitialTop)
        let firstEntry = policy.viewportChanged(top, questionID: nil, canPage: true)
        #expect(firstEntry)
        policy.olderPageAccepted(bottomDistance: 100)
        #expect(policy.awaitingOlderPage && !policy.following)
        let whileLoading = policy.viewportChanged(top, questionID: nil, canPage: false)
        #expect(!whileLoading)
        policy.olderPageFinished()
        let afterCompletion = policy.viewportChanged(top, questionID: nil, canPage: true)
        #expect(!afterCompletion)

        _ = policy.viewportChanged(away, questionID: nil, canPage: true)
        let blockedEntry = policy.viewportChanged(top, questionID: nil, canPage: false)
        #expect(!blockedEntry)
        let unblockedAtSameTop = policy.viewportChanged(top, questionID: nil, canPage: true)
        #expect(!unblockedAtSameTop)
        _ = policy.viewportChanged(away, questionID: nil, canPage: true)
        let nextEntry = policy.viewportChanged(top, questionID: nil, canPage: true)
        #expect(nextEntry)
        let repeatedEntry = policy.viewportChanged(top, questionID: nil, canPage: true)
        #expect(!repeatedEntry)
        // An explicit retry/button accepted by the business owner is independent of the
        // automatic edge. The policy does not invent a history operation identity.
        policy.olderPageAccepted(bottomDistance: 100)
        #expect(policy.awaitingOlderPage)
        policy.interactionChanged(true, bottomDistance: 100)
        policy.olderPageAccepted(bottomDistance: 100)
        #expect(policy.mode == .interacting)
        policy.interactionChanged(false, bottomDistance: 20)
        #expect(policy.following, "A history read does not retire the user's ongoing native gesture")
    }

    // IOS-CHAT-04: locating a question may itself expose the history boundary. Source
    // changes and old-page completion cannot turn that explicit location into auto paging.
    @Test func questionPagingSuppressionSurvivesGeometryPublicationAndPageCompletion() {
        var policy = ChatViewportPolicy()
        let top = facts(0, first: true), away = facts(-41, first: true)
        policy.distanceChanged(100, hasMessages: true, firstRowNearTop: false)
        policy.locateQuestion("q", bottomDistance: 100)
        let request = policy.request
        policy.olderPageFinished()
        policy.questionChanged(outside: true)
        policy.distanceChanged(200, hasMessages: true, firstRowNearTop: false)
        policy.interactionChanged(false, bottomDistance: 0)
        _ = policy.viewportChanged(away, questionID: "new-source-question", canPage: true)
        let suppressedEntry = policy.viewportChanged(top, questionID: "new-source-question", canPage: true)
        #expect(!suppressedEntry)
        #expect(policy.suppressQuestionPaging && policy.request == request && !policy.following)
        policy.interactionChanged(true, bottomDistance: 100)
        #expect(!policy.suppressQuestionPaging && policy.request == nil)
        _ = policy.viewportChanged(away, questionID: nil, canPage: true)
        let afterInteraction = policy.viewportChanged(top, questionID: nil, canPage: true)
        #expect(afterInteraction)
        policy.locateQuestion("q", bottomDistance: 100)
        policy.jumpToLatest()
        #expect(!policy.suppressQuestionPaging && policy.following)
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

    // IOS-CHAT-04: source/branch reset clears only viewport policy and emits no jump.
    // In particular it cannot carry an automatic edge or pending old-page gate forward.
    @Test func contextResetRetiresReadingAndPagingWithoutCreatingAScrollRequest() {
        var policy = ChatViewportPolicy()
        policy.distanceChanged(100, hasMessages: true, firstRowNearTop: false)
        policy.interactionChanged(true, bottomDistance: 100)
        policy.directionChanged(towardEarlier: true)
        policy.questionChanged(outside: true)
        policy.locateQuestion("q", bottomDistance: 100)
        policy.olderPageAccepted(bottomDistance: 100)
        policy.resetContext()
        #expect(policy.following && !policy.hasPositioned && !policy.hasBrowsed)
        #expect(!policy.showJump && !policy.showQuestionReminder && !policy.lastScrollTowardEarlier)
        #expect(!policy.suppressQuestionPaging && !policy.awaitingOlderPage && !policy.topArmed)
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
