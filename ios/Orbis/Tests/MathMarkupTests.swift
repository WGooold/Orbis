import Foundation
import Testing
@testable import OrbisCore

/// MATH-01: real JavaScriptCore + AttributedString parsing, including protected table pipes.
struct MathMarkupTests {
    @Test func sharedCorpusAndResourceLimit() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../shared/math-tests/fixtures.json").standardizedFileURL
        let fixtures = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [[String: Any]])
        for fixture in fixtures {
            let source = try #require(fixture["source"] as? String), count = try #require(fixture["count"] as? Int)
            if let prepared = MathMarkupEngine.shared.protect(source) {
                #expect(!prepared.bypass, "\(prepared.value["bypassReason"] ?? "no reason")")
                let tokens = try #require(prepared.value["tokens"] as? [[String: Any]])
                #expect(tokens.filter { $0["pending"] as? Bool == false }.count == count)
                #expect(prepared.restore(prepared.text) == source)
            } else { #expect(count == 0) }
        }
        let source = String(repeating: #"\(x\)"#, count: 600)
        let doc = PreparedMarkdownDocument(source)
        #expect(doc.mathHTML.isEmpty)
        guard case .text(let value) = doc.rows[0].kind else { Issue.record("Expected source fallback"); return }
        #expect(String(value.characters) == source)
    }
    @Test func sourceRestorationAndTableBoundaries() throws {
        let source = #"""
        | Name | Formula |
        |---|---|
        | **TLX** | [ref](https://example.test) \(\sum w_iR_i/15 + |x|\) |
        """#
        let document = PreparedMarkdownDocument(source)
        guard case .table(let table) = try #require(document.rows.first).kind else {
            Issue.record("Expected native table"); return
        }
        #expect(table.rows[1].count == 2)
        #expect(String(table.inlineRows[1][1].characters) == #"ref \(\sum w_iR_i/15 + |x|\)"#)
        #expect(table.mathRows[1][1]?.contains(#"data-tex="\sum w_iR_i/15 + |x|""#) == true)
        #expect(table.inlineRows[1][1].runs.contains { $0.link?.absoluteString == "https://example.test" })
    }
    @Test func multilinePendingCodeAndCurrency() throws {
        let source = #"""
        \[
        \begin{aligned}a&=b\\
        c&=d\end{aligned}
        \]
        """#
        let prepared = PreparedMarkdownDocument(source)
        guard case .text(let value) = try #require(prepared.rows.first).kind else { Issue.record("Expected text"); return }
        #expect(String(value.characters) == source)
        #expect(prepared.mathHTML.values.first?.contains(#"a&amp;=b\\"# + "\nc&amp;=d") == true)
        #expect(PreparedMarkdownDocument(#"Price $5 and $10; `\(x\)`"#).mathHTML.isEmpty)
        let pending = PreparedMarkdownDocument(#"\(\frac{a}"# + "\n\nfollowing")
        #expect(pending.mathHTML.isEmpty)
        #expect(pending.rows.count == 2, "\(pending.mathHTML.count) fragments rendered")
        guard case .text(let raw) = pending.rows[0].kind else { Issue.record("Expected source fallback"); return }
        #expect(String(raw.characters) == #"\(\frac{a}"#)
    }
}
