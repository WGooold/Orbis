import Foundation
import Testing
@testable import OrbisCore

@Suite("KIMI-08: negotiated Kimi Code")
struct KimiCodeTests {
    @Test func oldHostAndFilteredFallbackDoNotOfferKimi() {
        let old: [String: Any] = ["hostFeatures": ["device.features"], "dshDesktop": NSNull()]
        let filtered: [String: Any] = ["hostFeatures": ["device.features", "agent.kimiCode"]]
        #expect(deviceAgentFeatures(old) == ["agent.dshDesktop"])
        #expect(deviceAgentFeatures(["hostFeatures": ["agent.kimiCode"]]).isEmpty)
        #expect(!hasNegotiatedKimiCode(old))
        #expect(!hasNegotiatedKimiCode(filtered))
        #expect(deviceAgentFeatures(filtered) == ["agent.dshDesktop", "agent.kimiCode"])
        #expect(hasNegotiatedKimiCode(filtered.merging(["dshDesktop": NSNull()]) { _, new in new }))
        #expect(kimiSpawnMode(kimiCodeKind) == "headless")
        #expect(kimiSpawnMode("codex") == "tui")
    }

    @Test func enablementRequiresAnExplicitHostEcho() {
        let offer: [String: Any] = ["hostFeatures": ["device.features", "agent.enablement.v1"], "dshDesktop": NSNull()]
        #expect(deviceAgentFeatures(offer).contains("agent.enablement.v1"))
        #expect(!readyAdmitsAgentEnablement(offer))
        #expect(readyAdmitsAgentEnablement(offer.merging(["deviceFeatures": ["agent.enablement.v1"]]) { _, new in new }))
    }

    // OpenCode requires its own Host advertisement, independently of Kimi and Desktop.
    @Test func declaresOpenCodeOnlyWhenAdvertised() {
        #expect(deviceAgentFeatures(["hostFeatures": ["device.features", "agent.opencode"]]) == ["agent.dshDesktop", "agent.opencode"])
        #expect(deviceAgentFeatures(["hostFeatures": ["agent.opencode"]]).isEmpty)
    }

    @Test func mergedNativeRowSettlesEveryDeclaredIdentityAndNoSameTextNeighbor() throws {
        let message = try JSONDecoder().decode(ChatMessage.self, from: Data(#"{"messageId":"native","role":"user","content":[{"type":"text","text":"same"}],"timestamp":1,"clientMessageId":"a","clientMessageIds":["a","b"]}"#.utf8))
        let session = "kimi-code:fixture:session_inbox"
        let now = Date(timeIntervalSince1970: 1)
        var pending = PendingSendOutbox()
        for id in ["a", "b", "c"] {
            pending.add(PendingSend(messageId: id, commandId: id, sessionId: session, runtimeId: session, text: "same", attachments: [], delivery: nil, createdAt: now, anchorMessageId: nil))
        }
        _ = pending.reconcile(runtimeId: session, sessionId: session, status: "idle", queue: [], revision: 0, connected: true, now: now, isMaterialized: message.materializesClientMessage)
        #expect(pending.items.map(\.messageId) == ["c"])
        #expect(resolvedAgentKind(runtimeId: session, declared: nil, catalogKind: nil) == kimiCodeKind)
    }

    @Test func publishedKimiCatalogRowCanBeDecodedAndCachedButNotSurfacedForAnOldHost() async throws {
        let bytes = Data(#"{"sessions":[{"agentKind":"kimiCode","sessionId":"kimi-code:fixture:session_a","hostname":"fixture","cwd":"/workspace","messageCount":0,"createdAt":1,"modifiedAt":2}],"snapshotId":"snapshot","totalSessions":1,"nextCursor":null,"backends":[],"truncated":false}"#.utf8)
        let value = try JSONDecoder().decode(HostJSON.self, from: bytes)
        let domain = HostDomain(domain: "catalog", modelEpoch: "fixture", revision: 1, availability: "ready", completeness: "complete",
            source: .init(producer: "host", sourceId: "catalog", sourceEpoch: "e", sourceRevision: 1), checkedAt: 1, value: value, projectionComplete: true)
        let range = try #require(HostCatalogRange(domain: domain))
        let worker = SessionDirectoryCatalogWorker()
        let allowed = await worker.resolve(sessions: range.sessions, runtimes: [], messages: [:], archived: [:], kimiCodeSupported: true)
        let old = await worker.resolve(sessions: range.sessions, runtimes: [], messages: [:], archived: [:], kimiCodeSupported: false)
        #expect(allowed.sessions.count == 1)
        #expect(old.sessions.isEmpty)
    }
}
