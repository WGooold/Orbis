import Foundation
import Testing
@testable import OrbisCore

struct ChatQuestionTests {
    private func message(_ id: String, _ role: String = "user", _ text: String = "同一个问题") -> ChatMessage {
        ChatMessage(messageId: id, role: role, content: [ChatContent(type: "text", text: text, toolName: nil, artifact: nil)], timestamp: 1, isError: nil)
    }

    // CHAT-QUESTION-02: stable row order wins over timestamps; never look forward
    // to a question below the current answer, or pick a locally pending user row.
    @Test func readingIndexResolvesFromEachRowAndSkipsPendingQuestions() {
        let transcript = ChatTranscript(messages: [message("intro", "assistant"), message("first"),
            message("answer1", "assistant"), message("pending"), message("answer2", "assistant"),
            message("second"), message("answer3", "assistant")], turnTimings: [:], excludedQuestions: ["pending"])
        #expect(transcript.question(at: "intro") == nil)
        #expect(transcript.question(at: "answer1")?.messageId == "first")
        #expect(transcript.question(at: "pending")?.messageId == "first")
        #expect(transcript.question(at: "answer2")?.messageId == "first")
        #expect(transcript.question(at: "answer3")?.messageId == "second")
        #expect(transcript.question(at: "second")?.messageId == "second")
        #expect(transcript.question(at: "stale-branch") == nil)
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
