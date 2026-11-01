import Foundation
import Testing
@testable import OrbisCore

struct ChatQuestionTests {
    private func message(_ id: String, _ role: String = "user", _ text: String = "同一个问题") -> ChatMessage {
        ChatMessage(messageId: id, role: role, content: [ChatContent(type: "text", text: text, toolName: nil, artifact: nil)], timestamp: 1, isError: nil)
    }

    @Test func latestQuestionUsesTranscriptOrderAndNeverAssistantOrToolText() {
        let messages = [message("first"), message("second"), message("assistant", "assistant"), message("tool", "tool")]
        let transcript = ChatTranscript(messages: messages, turnTimings: [:])
        #expect(transcript.latestQuestion(excluding: [])?.messageId == "second")
        #expect(transcript.latestQuestion(excluding: [])?.text == "同一个问题")
        #expect(ChatTranscript(messages: Array(messages.dropFirst(2)), turnTimings: [:]).latestQuestion(excluding: []) == nil)
    }

    @Test func localUnconfirmedAndFailedRowsDoNotReplaceTheSourceQuestion() {
        let transcript = ChatTranscript(messages: [message("source"), message("sending"), message("failed"), message("unconfirmed")], turnTimings: [:])
        #expect(transcript.latestQuestion(excluding: ["sending", "failed", "unconfirmed"])?.messageId == "source")
        #expect(transcript.latestQuestion(excluding: ["source", "sending", "failed", "unconfirmed"]) == nil)
    }

    @Test func prependingHistoryAndReplacingTheBranchKeepOnlyTheCurrentQuestion() {
        let current = message("current")
        let question = ChatTranscript(messages: [current], turnTimings: [:]).latestQuestion(excluding: [])
        #expect(ChatTranscript(messages: [message("old"), current, message("answer", "assistant")], turnTimings: [:]).latestQuestion(excluding: []) == question)
        #expect(ChatTranscript(messages: [message("branch")], turnTimings: [:]).latestQuestion(excluding: [])?.messageId == "branch")
        #expect(ChatTranscript.empty.latestQuestion(excluding: []) == nil)
    }

    @Test func attachmentsAndMultilineUnicodeHaveAnUnmodifiedAccessiblePreview() {
        let text = "解释 👩🏽‍💻 与 e\u{301}\n再比较两种实现"
        #expect(ChatQuestion(message("unicode", "user", text))?.text == text)
        let file = RemoteArtifact(artifactId: "f", fileName: "很长的设计稿.pdf", mimeType: "application/pdf", size: 42, sha256: nil, path: nil)
        let attachment = ChatMessage(messageId: "file", role: "user", content: [ChatContent(type: "artifact", text: nil, toolName: nil, artifact: file)], timestamp: 2, isError: nil)
        #expect(ChatQuestion(attachment)?.text == "附件：很长的设计稿.pdf")
        #expect(ChatQuestion(message("blank", "user", " \n ")) == nil)
    }
}
