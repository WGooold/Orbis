import Foundation
import Testing
@testable import OrbisCore

@Suite("Visible catalog query reads") @MainActor
struct CatalogViewReadsTests {
    @MainActor private final class Harness {
        var sent: [[String: Any]] = []
        var applied: [CatalogQueryResult] = []
        var time = Date(timeIntervalSince1970: 0)
        lazy var reads = CatalogViewReads(send: { [unowned self] in sent.append($0); return true },
            publish: { [unowned self] value, _ in applied.append(value) }, now: { [unowned self] in time })
        var last: [String: Any] { sent.last! }
        func enable() {
            reads.connect()
            reads.consume(["type": "session.catalog.capabilities", "format": "v1", "requestId": last["requestId"]!])
        }
    }
    private func page(_ request: [String: Any], ids: [String], offset: Int = 0, next: String? = "next", total: Int = 2,
                      error: String? = nil) -> [String: Any] {
        var raw: [String: Any] = ["modelEpoch": "epoch", "revision": 1, "snapshotId": "snapshot", "offset": offset,
            "totalSessions": total, "sessions": ids.map { ["sessionId": $0, "cwd": "/repo", "createdAt": 1,
                "modifiedAt": 2, "messageCount": 1, "agentKind": "pi"] as [String: Any] },
            "nextCursor": next as Any? ?? NSNull(), "complete": true, "truncated": false]
        raw["error"] = error
        return ["type": "session.catalog.page", "requestId": request["requestId"]!, "format": "v1", "query": request["query"]!,
            "page": raw, "directoryCount": 1, "previewsComplete": true, "providers": ["outside-first-page"], "unknownProvider": false, "providersTruncated": false]
    }

    // SC-01/04: responses cannot create viewport demand, or cross a closed/replaced view.
    @Test func pagesRequireVisibleDemandAndRejectOldQueries() {
        let h = Harness(); h.enable()
        #expect(h.sent.count == 1)
        h.reads.setView(CatalogQuery(text: "needle"))
        let first = h.last
        h.reads.consume(page(first, ids: ["one"]))
        #expect(h.sent.count == 2)
        #expect(h.applied.last?.providers == ["outside-first-page"])
        h.reads.needMore(); let second = h.last
        #expect(second["cursor"] as? String == "next")
        h.reads.needMore(); #expect(h.sent.count == 3)
        h.reads.setView(nil); h.reads.consume(page(second, ids: ["two"], offset: 1, next: nil))
        #expect(h.applied.last?.range.sessions.map(\.sessionId) == ["one"])
        h.reads.setView(CatalogQuery(text: "different")); #expect(h.last["cursor"] is NSNull)
        h.reads.consume(page(first, ids: ["late"]))
        #expect(h.applied.last?.range.sessions.map(\.sessionId) == ["one"])
        h.reads.disconnect()
    }

    // SC-06: one same-identity retry after 20s + 5s, then the original deadline terminates it.
    @Test func retriesKeepIdentityAndCannotExtendTheDeadline() {
        let h = Harness(); h.enable(); h.reads.setView(CatalogQuery()); let request = h.last
        h.time = Date(timeIntervalSince1970: 20); h.reads.tick(); #expect(h.sent.count == 2)
        h.time = Date(timeIntervalSince1970: 25); h.reads.tick()
        #expect(h.last["requestId"] as? String == request["requestId"] as? String)
        #expect(h.sent.count == 3)
        h.time = Date(timeIntervalSince1970: 45); h.reads.tick(); #expect(h.applied.last?.error == "timeout")
        h.time = Date(timeIntervalSince1970: 90); h.reads.tick(); h.reads.needMore(); #expect(h.sent.count == 3)
        h.reads.retryFailed(); #expect(h.sent.count == 4)
        h.reads.disconnect()
    }

    @Test func changedSnapshotRecoversOnceAndDuplicatesNeverCommit() {
        let h = Harness(); h.enable(); h.reads.setView(CatalogQuery())
        h.reads.consume(page(h.last, ids: [], error: "snapshot_changed")); #expect(h.sent.count == 3)
        h.reads.consume(page(h.last, ids: [], error: "snapshot_changed")); #expect(h.sent.count == 3)
        #expect(h.applied.last?.error == "snapshot_changed")
        h.reads.retryFailed(); h.reads.consume(page(h.last, ids: ["one"]))
        h.reads.needMore(); h.reads.consume(page(h.last, ids: ["one"], offset: 1, next: nil))
        #expect(h.applied.last?.error == "invalid_page")
        #expect(h.applied.last?.range.sessions.map(\.sessionId) == ["one"])
        h.reads.disconnect()
    }

    @Test func rejectedCapabilityDoesNotDisableLegacyPagingOrReportQueryFailure() {
        let h = Harness(); h.reads.connect(); h.reads.setView(CatalogQuery(text: "global"))
        h.reads.consume(["type": "protocol.error", "requestId": h.last["requestId"]!, "code": "unsupported"])
        h.reads.needMore()
        #expect(!h.reads.supported); #expect(h.sent.count == 1); #expect(h.applied.isEmpty)
        h.reads.disconnect()
    }

    @Test func continuationsReuseFacetsAndOnlyNewSourceVersionsInvalidatePages() {
        let h = Harness(); h.enable(); h.reads.setView(CatalogQuery())
        h.reads.consume(page(h.last, ids: ["one"]))
        h.reads.sourceChanged(epoch: "epoch", revision: 1); #expect(h.sent.count == 2)
        h.reads.needMore()
        var second = page(h.last, ids: ["two"], offset: 1, next: nil)
        second["providers"] = nil; second["unknownProvider"] = nil; second["providersTruncated"] = nil
        h.reads.consume(second); h.reads.needMore()
        #expect(h.sent.count == 3); #expect(h.applied.last?.range.sessions.map(\.sessionId) == ["one", "two"])
        #expect(h.applied.last?.providers == ["outside-first-page"])
        h.reads.sourceChanged(epoch: "epoch", revision: 2); #expect(h.sent.count == 4)
        #expect(h.last["cursor"] is NSNull)
        h.reads.connect(); #expect(!h.reads.supported)
        #expect(h.last["type"] as? String == "session.catalog.capabilities.request")
        h.reads.disconnect()
    }
}
