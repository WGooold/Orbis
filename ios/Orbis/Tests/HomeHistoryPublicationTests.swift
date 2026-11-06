import Foundation
import Testing
@testable import OrbisCore

@Suite("Home and history publication")
struct HomeHistoryPublicationTests {
    private func message(_ id: String, text: String) -> ChatMessage {
        ChatMessage(messageId: id, role: "assistant", content: [ChatContent(type: "text", text: text, toolName: nil, artifact: nil)], timestamp: 1, isError: nil)
    }

    // Title fallback/sorting and history projection must leave MainActor available to handle input.
    @Test @MainActor func homeAndHistoryWorkersLeaveMainActorAvailable() async throws {
        let gate = DispatchSemaphore(value: 0)
        let probe: @Sendable () -> Void = {
            #expect(!Thread.isMainThread)
            Task { @MainActor in gate.signal() }
            #expect(gate.wait(timeout: .now() + 3) == .success)
        }
        let home = HomeCardWorker(beforeResolve: probe)
        let runtime = RuntimeSummary(runtimeId: "r", name: "Agent", cwd: "/repo", status: "running", sessionId: "s")
        let user = ChatMessage(messageId: "u", role: "user", content: [ChatContent(type: "text", text: "Fallback question.", toolName: nil, artifact: nil)], timestamp: 1, isError: nil)
        let cards = await home.resolve(runtimes: [runtime], sessions: [:], messages: ["r": [user]], pending: [:])
        #expect(cards.cards.map(\.title) == ["Fallback question."])
        #expect(cards.fallback == ["r"])

        let graph = CachedSessionGraph(sessionId: "s")
        let page = SessionHistoryPage(graph: graph, entries: [], display: [:], turnTimings: [], hasOlder: false,
            complete: true, status: .complete, displayComplete: true)
        let history = SessionChatProjectionWorker(beforeResolve: probe)
        let live = message("live", text: "Arrived during history loading")
        let merged = await history.install(page: page, previousGraph: graph, messages: [live], displayIds: [:], timings: [:], replacing: false)
        #expect(merged.messages == [live])
    }

    // A local page captured before a source correction cannot restore an older canonical row.
    @Test func historyPageKeepsNewerDisplayVersionsAndLiveMessages() async throws {
        func event(_ revision: Int, _ id: String, _ text: String) -> [String: Any] {
            ["source": ["epoch": "source", "seq": revision], "cursor": ["leafId": "e"],
             "entries": [["entryId": "e", "parentId": NSNull(), "type": "message", "timestamp": "2026-11-06T00:00:00Z"]],
             "display": ["projectionVersion": 3, "entries": [["entryId": "e", "message": ["messageId": id, "role": "assistant", "timestamp": 1,
                "content": [["type": "text", "text": text]]]]]]]
        }
        let old = try CachedSessionGraph(sessionId: "s").merging(event(1, "old", "old body"), activate: true)
        let newer = try old.merging(event(2, "new", "corrected body"), activate: true)
        let entry = try #require(old.entries["e"])
        let page = SessionHistoryPage(graph: old, entries: [entry], display: old.display, turnTimings: [], hasOlder: false,
            complete: true, status: .complete, displayComplete: true)
        let live = message("live", text: "new live body")
        let worker = SessionChatProjectionWorker()
        let result = await worker.install(page: page, previousGraph: newer, messages: newer.messages + [live],
            displayIds: ["e": "new"], timings: [:], replacing: false)
        #expect(result.messages.map(\.messageId) == ["new", "live"])
        #expect(result.messages.first?.text == "corrected body")
        #expect(result.displayIds == ["e": "new"])
        #expect(result.graph.displayVersions["e"] == newer.displayVersions["e"])
    }

    // One background publication owns tool materialization, streaming IDs and canonical anchors.
    @Test func chatPublicationPreservesToolOrderAndCanonicalChangeAnchors() async {
        let worker = ChatTranscriptWorker()
        let tool = ToolSummary(tool: ToolIdentity(agent: ToolAgent(hostId: "h", agentKind: "codex", sessionId: "s"), toolCallId: "call"),
            order: 2, toolName: "shell", phase: "finished", isError: nil, inputSummary: nil, resultSummary: nil, errorSummary: nil)
        let answer = message("answer", text: "Answer")
        let result = await worker.publish(identity: "h|r|s|0", input: ChatPublicationInput(messages: [answer], timings: [:],
            tools: [tool], orders: ["answer": 3], unfinished: ["answer"], displayIds: ["entry": "answer"]))
        #expect(result.messages.map(\.messageId) == ["tool-live:call", "answer"])
        #expect(result.streaming == ["answer"])
        #expect(result.changeEntries == ["answer", "entry", "tool-live:call"])
        #expect(result.transcript.changeAnchorsByRow.values.contains { $0.contains("entry") })
    }

    // Metadata-only requests must not republish the lazy transcript during keyboard layout;
    // actual text/timing/anchor changes still invalidate the exact data that the UI renders.
    @Test func transcriptRevisionsReuseUnchangedRowsAndInvalidateRealChanges() async throws {
        let worker = ChatTranscriptWorker()
        var input = ChatPublicationInput(messages: [message("first", text: "Stable"), message("tail", text: "Growing")], timings: [:])
        let first = await worker.publish(identity: "one", input: input)
        input.unfinished = ["tail"]
        let streaming = await worker.publish(identity: "one", input: input)
        #expect(streaming.transcript.contentRevision == first.transcript.contentRevision)
        #expect(streaming.messageToken == first.messageToken)
        #expect(streaming.streaming == ["tail"])
        input = ChatPublicationInput(messages: input.messages + [ChatMessage(messageId: "question", role: "user",
            content: [ChatContent(type: "text", text: "Next", toolName: nil, artifact: nil)], timestamp: 2, isError: nil)], timings: [:])
        let appended = await worker.publish(identity: "one", input: input)
        #expect(appended.transcript.contentRevision != first.transcript.contentRevision)
        #expect(appended.transcript.rows.first?.contentRevision == first.transcript.rows.first?.contentRevision)
        input.displayIds = ["canonical": "tail"]
        let anchors = await worker.publish(identity: "one", input: input)
        #expect(anchors.transcript.contentRevision != appended.transcript.contentRevision)
        #expect(anchors.transcript.changeAnchorsByRow["first"]?.contains("canonical") == true)
        let rewritten = await worker.publish(identity: "one", input: ChatPublicationInput(
            messages: [message("first", text: "Edited"), message("tail", text: "Growing")], timings: [:]))
        #expect(rewritten.transcript.rows.first?.contentRevision != anchors.transcript.rows.first?.contentRevision)
        let timing = SessionTurnTiming(turnId: "turn", startedAt: 1, durationMs: 50, turnIndex: nil, messageId: "tail")
        let timed = await worker.publish(identity: "one", input: ChatPublicationInput(
            messages: rewritten.messages, timings: ["turn": timing]))
        #expect(timed.messageToken == rewritten.messageToken)
        #expect(timed.transcript.contentRevision != rewritten.transcript.contentRevision)
        #expect(timed.transcript.timingsByRow["first"] == [timing])
        let switched = await worker.publish(identity: "two", input: input)
        #expect(switched.transcript.contentRevision != anchors.transcript.contentRevision)
        #expect(switched.transcript.rows.first?.contentRevision != anchors.transcript.rows.first?.contentRevision)
    }
}
