import Foundation
import Testing
@testable import OrbisCore

@Suite("Normalized message rendering")
struct MessageRenderingTests {
    // A Host-issued inline action must stay clickable through Markdown preparation, while reply copy keeps only its label.
    @Test func inlineReferenceKeepsUnicodeLabelAndOmitsOpaqueTargetFromCopy() throws {
        let target = "orbis-message-file:" + String(repeating: "a", count: 64)
        let source = #"🙂 Read [报告\[最终\].md:18–20](<"# + target + ">) first. [second](<" + target + ">)"
        let row = try #require(PreparedMarkdownDocument(source).rows.first)
        guard case .text(let text) = row.kind else { Issue.record("Expected an inline Markdown row"); return }
        #expect(String(text.characters) == "🙂 Read 报告[最终].md:18–20 first. second")
        #expect(text.runs.compactMap { messageFileReferenceId($0.link?.absoluteString) } == [target, target])
        #expect(copyableMessageText(source) == String(text.characters))
        #expect(messageFileReferenceId(target + "\n") == nil)
    }

    // Legacy text, supported file cards and unknown future blocks all decode in the same reply without granting unknown actions.
    @Test func unreadableRenderPayloadKeepsFallbackWithoutBecomingInteractive() throws {
        let target = "orbis-message-file:" + String(repeating: "b", count: 64)
        let blocks: [[String: Any]] = [
            ["type": "text", "text": "before"],
            ["type": "render", "renderKind": "video", "text": "Attachment unavailable", "file": ["fileName": "ignored", "referenceId": target]],
            ["type": "render", "renderKind": "file_reference", "text": "报告.md", "file": ["fileName": "报告.md", "referenceId": target, "line": 7]],
            ["type": "render", "renderKind": "file_reference", "text": "missing.md", "file": false],
        ]
        let contents = try JSONDecoder().decode([ChatContent].self, from: JSONSerialization.data(withJSONObject: blocks))
        #expect(contents.map(\.fileAction) == [nil, nil, target, nil])
        #expect(contents.map(\.visibleText) == ["before", "Attachment unavailable", "报告.md", "missing.md"])
        #expect(contents[2].file?.line == 7)
    }
}
