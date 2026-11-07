import Foundation
import Testing
@testable import OrbisCore

/// FT-G05: the real selector loader commits complete catalogs only and isolates
/// request IDs, cancellation, source replacement, gaps and timeouts.
@Suite("FT-G05 option catalog paging")
struct MenuOptionsTests {
    private func command() -> SlashCommand {
        SlashCommand(name: "tree", description: nil, source: "builtin", argument: .init(kind: "tree", required: true, hint: nil,
            options: nil, optionCatalog: MenuOptionCatalog(id: "catalog", count: 2)))
    }
    private func page(_ request: [String: Any], _ values: [String], cursor: String? = nil, error: String? = nil) -> [String: Any] {
        var result: [String: Any] = ["type": "agent.menu.options.page", "requestId": request["requestId"]!, "runtimeId": request["runtimeId"]!,
            "commandName": request["commandName"]!, "catalogId": request["catalogId"]!, "totalCount": 2,
            "options": values.map { ["value": $0, "label": $0] }, "nextCursor": cursor as Any? ?? NSNull()]
        result["error"] = error; return result
    }
    @Test func completeCatalogPagesAreAtomicAndUseExactValues() throws {
        var loader = MenuOptionsLoader(); let started = loader.start(runtimeId: "r", command: command()); let first = try #require(started)
        let partial = loader.consume(page(first, ["native:1"], cursor: "next")); let part = try #require(partial)
        #expect(part.options == nil)
        let late = loader.consume(page(first, ["late"])); #expect(late == nil)
        let next = try #require(part.next); let completed = loader.consume(page(next, ["native:2"])); let done = try #require(completed)
        #expect(done.options?.map(\.value) == ["native:1", "native:2"])
        var cached = command(); cached.argument?.options = done.options
        let cachedRead = loader.start(runtimeId: "r", command: cached); #expect(cachedRead == nil)
    }
    @Test func cancellationTimeoutAndChangedCatalogCannotApplyPartialOptions() throws {
        var loader = MenuOptionsLoader(); let started = loader.start(runtimeId: "r", command: command()); let first = try #require(started)
        loader.cancel(); let cancelled = loader.consume(page(first, ["native:1", "native:2"])); #expect(cancelled == nil)
        let restarted = loader.start(runtimeId: "other", command: command()); let second = try #require(restarted)
        let previous = loader.consume(page(first, ["native:1", "native:2"])); #expect(previous == nil)
        let expired = loader.expire(second["requestId"] as! String); #expect(expired)
        let afterTimeout = loader.consume(page(second, ["native:1", "native:2"])); #expect(afterTimeout == nil)
        let thirdRead = loader.start(runtimeId: "r", command: command()); let third = try #require(thirdRead)
        let incomplete = loader.consume(page(third, ["only-one"])); #expect(incomplete?.error != nil)
        let fourthRead = loader.start(runtimeId: "r", command: command()); let fourth = try #require(fourthRead)
        let changed = loader.consume(page(fourth, [], error: "catalog_changed")); #expect(changed?.error == "catalog_changed")
    }
}
