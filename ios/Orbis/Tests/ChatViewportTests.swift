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
