import Foundation
import Testing
@testable import OrbisCore

@Suite("Host settings and diagnostic state") @MainActor
struct HostStateTests {
    private final class Sent {
        var values: [[String: Any]] = []
        var accepts = true
        var last: [String: Any] { values.last ?? [:] }
    }
    private func pairing(_ id: String = "host-a", device: String = "device-a") -> HostPairing {
        HostPairing(hostId: id, hostName: id, hostPub: "pub", pskRoot: "root",
                    relay: RelayCredential(relayUrl: "wss://example.test", deviceId: device, credential: "test"), lan: [])
    }
    private func setup() -> (HostState, Sent) {
        let state = HostState(), sent = Sent()
        state.send = { if sent.accepts { sent.values.append($0) }; return sent.accepts }
        state.setConnection(pairing(), connected: true)
        return (state, sent)
    }
    private func domain(_ name: String, revision: Int = 1, value: [String: Any] = [:], availability: String = "ready", epoch: String = "model-a") -> [String: Any] {
        ["domain": name, "modelEpoch": epoch, "revision": revision, "availability": availability, "completeness": "complete",
         "source": ["producer": "host", "sourceId": "source", "sourceEpoch": "source-a", "sourceRevision": revision],
         "checkedAt": 100, "value": value, "projectionComplete": true]
    }
    private func snapshot(_ sent: Sent, domains: [[String: Any]], missing: [[String: String]] = [], epoch: String = "model-a") -> [String: Any] {
        ["type": "agent.state.snapshot", "requestId": sent.last["requestId"]!, "scope": "host", "modelEpoch": epoch,
         "domains": domains, "missing": missing, "truncated": false]
    }
    private func providers(enabled: String = "official", kind: String = "codex", additive: Bool = false) -> [String: Any] {
        ["providers": [["agentKind": kind, "availability": "ready", "current": enabled, "modelProvider": "native-provider", "switching": false,
                        "profiles": ["official", "team"].map { id in ["id": id, "name": id, "enabled": id == enabled,
                            "mode": additive ? "additive" : "exclusive", "globalDefault": additive && id == "official", "subscriptionSupported": !additive && id == "official"] as [String: Any] }]]]
    }
    private func installProviders(_ state: HostState, _ sent: Sent, kind: String = "codex", additive: Bool = false) {
        state.consume(snapshot(sent, domains: [domain("providers", value: providers(kind: kind, additive: additive))]))
    }

    @Test func subscriptionQuotaIsScopedToHostProviderAndRequest() throws {
        let (state, sent) = setup()
        state.loadProviders("claude")
        installProviders(state, sent, kind: "claude")
        let provider = try #require(state.providers.first)
        #expect(provider.subscriptionSupported)
        state.querySubscription(provider, expectedHostKey: "stale-host")
        #expect(!state.queryingQuota)
        state.querySubscription(provider, expectedHostKey: state.hostKey!)
        let request = sent.last
        #expect(request["type"] as? String == "provider.subscription")
        #expect(request["id"] as? String == provider.id)
        #expect(state.queryingQuota)
        let payload: [String: Any] = ["checkedAt": 1000, "windows": [
            ["name": "five_hour", "remainingPercent": 82.5, "resetsAt": 2000] as [String: Any],
            ["name": "seven_day", "remainingPercent": NSNull(), "resetsAt": NSNull()] as [String: Any]]]
        var reply: [String: Any] = ["type": "provider.subscription.result", "requestId": "stale", "kind": "claude", "id": provider.id, "quota": payload]
        state.consume(reply)
        #expect(state.quota == nil && state.queryingQuota)
        reply["requestId"] = request["requestId"]
        state.consume(reply)
        #expect(state.quota?.windows.first?.remainingPercent == 82.5)
        #expect(state.quota?.windows.last?.remainingPercent == nil)
        #expect(!state.queryingQuota)
        state.querySubscription(provider, expectedHostKey: state.hostKey!)
        reply["requestId"] = sent.last["requestId"]
        state.setConnection(pairing("host-b"), connected: true)
        state.consume(reply)
        #expect(state.quota == nil && !state.queryingQuota)
    }

    @Test func quotaFailureCanRetryAndProviderChangesClearResults() throws {
        let (state, sent) = setup()
        installProviders(state, sent)
        let provider = try #require(state.providers.first)
        state.querySubscription(provider, expectedHostKey: state.hostKey!)
        state.consume(["type": "provider.subscription.result", "requestId": sent.last["requestId"]!, "kind": "codex", "id": provider.id, "error": "登录过期"])
        #expect(state.quotaError == "登录过期")
        #expect(state.canChangeProvider)
        state.querySubscription(provider, expectedHostKey: state.hostKey!)
        #expect(state.queryingQuota && state.quotaError == nil)
        let request = sent.last
        state.consume(["type": "provider.changed", "kind": "codex"])
        state.consume(["type": "provider.subscription.result", "requestId": request["requestId"]!, "kind": "codex", "id": provider.id, "error": "stale error"])
        #expect(!state.queryingQuota && state.quotaError == nil)
        let malformed = Data("{\"checkedAt\":1,\"windows\":[{\"name\":\"five_hour\",\"remainingPercent\":101},{\"name\":\"seven_day\",\"remainingPercent\":null}]}".utf8)
        #expect(try !JSONDecoder().decode(SubscriptionQuota.self, from: malformed).valid)
    }

    @Test func domainsMergeAcrossSplitResponsesAndRefreshRetainsSubscription() throws {
        let (state, sent) = setup()
        let original = snapshot(sent, domains: [domain("diagnostics", value: ["records": 12])])
        state.consume(original)
        installProviders(state, sent)
        #expect(state.domains["diagnostics"]?.value["records"].integer == 12)
        #expect(state.currentProviders["codex"] == "native-provider")
        #expect(!state.providersLoading)
        state.loadProviders("pi")
        #expect(Set(sent.last["domains"] as? [String] ?? []) == Set(HostState.domainNames))
        #expect((sent.last["known"] as? [[String: Any]])?.contains { $0["domain"] as? String == "diagnostics" } == true)
        state.consume(original) // The previous request is no longer an active subscription.
        #expect(state.providersLoading)
        var response = snapshot(sent, domains: [domain("providers", revision: 2, value: providers(kind: "pi", additive: true))])
        response["unchanged"] = ["diagnostics"]
        state.consume(response)
        #expect(state.domains["diagnostics"]?.revision == 1)
        #expect(state.providers.count == 2)
    }

    @Test func malformedSnapshotIsAtomicAndSameRevisionCannotChangeFacts() {
        let (state, sent) = setup()
        installProviders(state, sent)
        var malformed = domain("diagnostics")
        malformed["checkedAt"] = nil
        state.consume(snapshot(sent, domains: [domain("providers", revision: 2, value: providers(enabled: "team")), malformed]))
        #expect(state.modelError != nil)
        #expect(state.providers.first(where: \.enabled)?.id == "official")
        state.consume(snapshot(sent, domains: [domain("providers", value: providers(enabled: "team"))]))
        #expect(state.providers.first(where: \.enabled)?.id == "official")
        state.consume(snapshot(sent, domains: [domain("providers", revision: 3, value: providers(enabled: "team"))]))
        state.consume(snapshot(sent, domains: [domain("providers", revision: 2, value: providers())]))
        #expect(state.providers.first(where: \.enabled)?.id == "team")
        state.consume(snapshot(sent, domains: [domain("providers", revision: 100, value: providers(), epoch: "retired")], epoch: "retired"))
        #expect(state.domains["providers"]?.revision == 3)
    }

    @Test func missingUnknownAndEmptyCatalogHaveDifferentMeaning() {
        let (state, sent) = setup()
        installProviders(state, sent)
        #expect(state.canChangeProvider)
        state.consume(snapshot(sent, domains: [], missing: [["domain": "providers", "reason": "no_state"]]))
        #expect(state.providerCatalogProblem == "电脑尚未报告这个状态领域")
        #expect(!state.canChangeProvider)
        state.consume(snapshot(sent, domains: [domain("providers", revision: 2, value: providers(), availability: "unknown")]))
        #expect(state.providerCatalogProblem == "电脑尚未核对")
        var empty = providers()
        empty["providers"] = [["agentKind": "codex", "profiles": [], "switching": false]]
        state.consume(snapshot(sent, domains: [domain("providers", revision: 3, value: empty)]))
        #expect(state.providerCatalogProblem == nil)
        #expect(state.providers.isEmpty)
        #expect(state.currentProviders.isEmpty)
    }

    @Test func providerChangeWaitsForMatchingResultAndAuthoritativeRefresh() throws {
        let (state, sent) = setup()
        installProviders(state, sent)
        let team = try #require(state.providers.first { $0.id == "team" })
        let key = try #require(state.hostKey)
        state.changeProvider(team, expectedHostKey: key)
        let operation = sent.last
        #expect(operation["type"] as? String == "provider.switch")
        #expect(operation["enabled"] as? Bool == true)
        #expect(state.changingProvider)
        state.consume(["type": "provider.result", "requestId": operation["requestId"]!, "kind": "pi"])
        #expect(state.changingProvider)
        // A subscription update may arrive before this device's operation result.
        let subscription = try #require(sent.values.first { $0["type"] as? String == "agent.state.request" })
        let response: [String: Any] = ["type": "agent.state.snapshot", "requestId": subscription["requestId"]!, "scope": "host", "modelEpoch": "model-a",
            "domains": [domain("providers", revision: 2, value: providers(enabled: "team"))], "missing": [], "truncated": false]
        state.consume(response)
        #expect(state.changingProvider)
        state.consume(["type": "provider.result", "requestId": operation["requestId"]!, "kind": "codex", "notice": "请重新打开会话"])
        #expect(!state.changingProvider)
        #expect(state.providerNotice == "请重新打开会话")
        #expect(sent.last["type"] as? String == "agent.state.request")
        #expect(state.providersLoading)
    }

    @Test func providerActionsRejectOldHostStaleListAndExclusiveRemoval() throws {
        let (state, sent) = setup()
        installProviders(state, sent)
        let team = try #require(state.providers.first { $0.id == "team" })
        let key = try #require(state.hostKey)
        let before = sent.values.count
        state.changeProvider(try #require(state.providers.first { $0.enabled }), expectedHostKey: key)
        #expect(sent.values.count == before)
        state.loadProviders("codex"); installProviders(state, sent)
        state.consume(snapshot(sent, domains: [domain("providers", revision: 2, value: providers(enabled: "team"))]))
        state.changeProvider(team, expectedHostKey: key)
        #expect(!state.changingProvider)
        state.setConnection(pairing("host-b"), connected: true)
        state.changeProvider(team, expectedHostKey: key)
        #expect(!state.changingProvider)
        #expect(state.domains.isEmpty)
        state.consume(snapshot(sent, domains: [domain("providers", value: providers())]))
        #expect(state.providerError != nil)
    }

    @Test func piDefaultRemovalUsesSameGuardAndExplicitDisable() throws {
        let (state, sent) = setup()
        state.loadProviders("pi"); installProviders(state, sent, kind: "pi", additive: true)
        let current = try #require(state.providers.first { $0.enabled })
        #expect(current.confirmation.contains("全局默认供应商"))
        state.changeProvider(current, expectedHostKey: try #require(state.hostKey))
        #expect(sent.last["enabled"] as? Bool == false)
        #expect(state.changingProvider)
        state.setConnection(pairing(), connected: false)
        #expect(!state.changingProvider)
        #expect(state.providerError?.contains("确认操作结果") == true)
        #expect(!state.canChangeProvider)
    }

    private func installRemovableProviders(_ state: HostState, _ sent: Sent) {
        state.loadProviders("pi")
        let profiles: [[String: Any]] = ["official", "team"].map {
            ["id": $0, "name": $0, "enabled": true, "mode": "additive", "globalDefault": $0 == "official"]
        }
        state.consume(snapshot(sent, domains: [domain("providers", value: ["providers": [
            ["agentKind": "pi", "availability": "ready", "switching": false, "profiles": profiles]
        ]])]))
    }

    @Test func batchRemovalWaitsForEachMatchingReceiptAndKeepsCardsUntilRefresh() throws {
        let (state, sent) = setup()
        installRemovableProviders(state, sent)
        let cards = state.providers
        state.removeProviders(cards, expectedHostKey: try #require(state.hostKey))
        let first = sent.last
        #expect(first["id"] as? String == "official")
        #expect(first["enabled"] as? Bool == false)
        state.consume(["type": "provider.result", "requestId": "stale", "kind": "pi"])
        state.consume(["type": "provider.result", "requestId": first["requestId"]!, "kind": "codex"])
        #expect(sent.last["requestId"] as? String == first["requestId"] as? String)
        state.consume(["type": "provider.result", "requestId": first["requestId"]!, "kind": "pi"])
        let second = sent.last
        #expect(second["id"] as? String == "team")
        #expect(second["enabled"] as? Bool == false)
        #expect(state.changingProvider)
        #expect(state.providers == cards)
        state.consume(["type": "provider.result", "requestId": first["requestId"]!, "kind": "pi"])
        #expect(state.changingProvider)
        state.consume(["type": "provider.result", "requestId": second["requestId"]!, "kind": "pi", "notice": "已更新"])
        #expect(!state.changingProvider)
        #expect(state.providerNotice == "已移除 2 个供应商。已更新")
        #expect(sent.last["type"] as? String == "agent.state.request")
        #expect(state.providers == cards)
    }

    @Test func batchRemovalStopsOnFailureDisconnectAndStaleSelection() throws {
        for disconnect in [false, true] {
            let (state, sent) = setup()
            installRemovableProviders(state, sent)
            state.removeProviders(state.providers, expectedHostKey: try #require(state.hostKey))
            let first = sent.last
            if disconnect { state.setConnection(pairing(), connected: false) }
            else { state.consume(["type": "provider.result", "requestId": first["requestId"]!, "kind": "pi", "error": "busy"]) }
            state.consume(["type": "provider.result", "requestId": first["requestId"]!, "kind": "pi"])
            #expect(!state.changingProvider)
            #expect(state.providerError?.contains("批量移除已停止") == true)
            #expect(sent.values.filter { $0["type"] as? String == "provider.switch" }.count == 1)
        }
        let (state, sent) = setup()
        state.loadProviders("pi"); installProviders(state, sent, kind: "pi", additive: true)
        state.removeProviders(state.providers, expectedHostKey: try #require(state.hostKey))
        #expect(!state.changingProvider) // The disabled provider cannot be removed.
        #expect(sent.values.allSatisfy { $0["type"] as? String != "provider.switch" })
    }

    @Test func diagnosticPagesAreCorrelatedHostScopedAndExposeWindowGaps() throws {
        let (state, sent) = setup()
        state.readDiagnostics()
        let id = try #require(sent.last["requestId"] as? String)
        func page(_ id: String, host: String = "host-a") -> [String: Any] {
            ["type": "diagnostics.page", "requestId": id, "page": ["records": [
                ["recordId": "r1", "hostId": host, "category": "provider", "severity": "warning", "message": "配置读取失败", "at": 100]
            ], "nextCursor": "next-page", "truncated": true]]
        }
        state.consume(page("old-request"))
        #expect(state.diagnosticsLoading)
        state.consume(page(id))
        #expect(!state.diagnosticsLoading)
        #expect(state.diagnosticPage?.truncated == true)
        state.readDiagnostics(cursor: state.diagnosticPage?.nextCursor)
        #expect(sent.last["cursor"] as? String == "next-page")
        state.consume(page(try #require(sent.last["requestId"] as? String), host: "host-b"))
        #expect(state.diagnosticsError != nil)
        #expect(state.diagnosticPage?.records.first?.hostId == "host-a")
    }

    @Test func failedSendsAndProtocolErrorsLeaveRecoverablePageState() throws {
        let (state, sent) = setup()
        installProviders(state, sent)
        sent.accepts = false
        state.changeProvider(try #require(state.providers.last), expectedHostKey: try #require(state.hostKey))
        #expect(!state.changingProvider)
        #expect(state.providerError?.contains("未发送") == true)
        state.readDiagnostics()
        #expect(!state.diagnosticsLoading)
        #expect(state.diagnosticsError != nil)
        sent.accepts = true
        state.readDiagnostics()
        state.consume(["type": "protocol.error", "requestId": sent.last["requestId"]!, "message": "读取失败"])
        #expect(!state.diagnosticsLoading)
        #expect(state.diagnosticsError == "读取失败")
        state.setConnection(pairing(), connected: false)
    }

    private func session(_ id: String) -> [String: Any] {
        ["sessionId": id, "cwd": "/repo", "createdAt": 1, "modifiedAt": 2, "messageCount": 1, "agentKind": "pi"]
    }
    private func catalog(_ state: HostState, _ sent: Sent, revision: Int = 1, snapshotId: String = "catalog") {
        let request = sent.values.last { $0["type"] as? String == "agent.state.request" }!
        state.consume(["type": "agent.state.snapshot", "requestId": request["requestId"]!, "scope": "host", "modelEpoch": "model-a",
            "domains": [domain("catalog", revision: revision, value: ["totalSessions": 2, "sessions": [session("first")],
                "snapshotId": snapshotId, "nextCursor": "cursor-" + snapshotId, "truncated": false,
                "backends": [["kind": "pi", "ready": true, "complete": true, "sessions": 2]]])], "missing": [], "truncated": false])
    }
    private func catalogPage(_ request: [String: Any], snapshot: String = "catalog", revision: Int = 1,
                             offset: Int = 1, sessions: [[String: Any]], cursor: String? = nil) -> [String: Any] {
        ["type": "agent.state.range.page", "requestId": request["requestId"]!, "scope": "host", "domain": "catalog",
         "page": ["modelEpoch": "model-a", "revision": revision, "snapshotId": snapshot, "offset": offset,
                  "totalSessions": 2, "sessions": sessions, "nextCursor": cursor as Any? ?? NSNull(), "complete": true, "truncated": false]]
    }

    @Test func catalogPagesAccumulateFixedSnapshotBeforeAllowingPruning() throws {
        let (state, sent) = setup()
        var inventories: [([SessionSummary], Set<String>)] = []
        state.didChangeCatalog = { inventories.append(($0, $1)) }
        catalog(state, sent)
        #expect(inventories.last?.0.map(\.sessionId) == ["first"])
        #expect(inventories.last?.1.isEmpty == true)
        #expect(state.problem(for: "catalog")?.contains("1 / 2") == true)
        let request = sent.last
        #expect(request["type"] as? String == "agent.state.range.request")
        #expect(request["limit"] as? Int == 200)
        state.consume(catalogPage(request, sessions: [session("second")]))
        #expect(inventories.last?.0.map(\.sessionId) == ["first", "second"])
        #expect(inventories.last?.1 == ["pi"])
        #expect(state.catalogRange?.nextCursor == nil)
        #expect(state.problem(for: "catalog") == nil)
        #expect(state.domains["catalog"]?.value["sessions"].array.count == 1) // Applied first-window baseline stays immutable.
    }

    @Test func catalogRetiresOldCursorsAndRejectsDuplicateOrIncompletePages() throws {
        let (state, sent) = setup()
        catalog(state, sent)
        let stale = sent.last
        catalog(state, sent, revision: 2, snapshotId: "new")
        let current = sent.last
        state.consume(catalogPage(stale, sessions: [session("old")]))
        #expect(state.catalogRange?.sessions.map(\.sessionId) == ["first"])
        #expect(state.catalogRange?.error == nil)
        state.consume(catalogPage(current, snapshot: "new", revision: 2, sessions: [session("first")]))
        #expect(state.catalogRange?.error == "invalid_page")
        #expect(state.catalogRange?.sessions.map(\.sessionId) == ["first"])
        state.refresh(["catalog"])
        catalog(state, sent, revision: 3, snapshotId: "third")
        state.consume(catalogPage(sent.last, snapshot: "third", revision: 3, sessions: []))
        #expect(state.catalogRange?.error == "invalid_page")
    }

    @Test func scopeErrorsAndDiagnosticFailuresAreCorrelated() {
        let (state, sent) = setup()
        var agent = snapshot(sent, domains: [domain("identity")]); agent["scope"] = "agent"
        #expect(!state.consume(agent))
        state.readDiagnostics()
        state.consume(["type": "diagnostics.page", "requestId": sent.last["requestId"]!, "error": "source_unavailable"])
        #expect(state.diagnosticsError == "source_unavailable")
        #expect(!state.diagnosticsLoading)
    }

    @Test func invalidCatalogDoesNotAdvanceBaselineAndRefreshCanRetryAFailedCursor() {
        let (state, sent) = setup()
        catalog(state, sent)
        state.consume(catalogPage(sent.last, sessions: [session("first")]))
        #expect(state.catalogRange?.error == "invalid_page")
        state.refresh(["catalog"]); catalog(state, sent)
        #expect(state.catalogRange?.error == nil)
        #expect(sent.last["type"] as? String == "agent.state.range.request")
        let request = sent.values.last { $0["type"] as? String == "agent.state.request" }!
        state.consume(["type": "agent.state.snapshot", "requestId": request["requestId"]!, "scope": "host", "modelEpoch": "model-a",
            "domains": [domain("catalog", revision: 2, value: ["totalSessions": 0, "sessions": [session("bad")], "truncated": false])], "missing": [], "truncated": false])
        #expect(state.domains["catalog"]?.revision == 1)
        #expect(state.modelError != nil)
    }

    @Test func hostModelGenerationCanChangeOnAnAuthenticatedReady() {
        let (state, sent) = setup()
        installProviders(state, sent)
        let old = snapshot(sent, domains: [domain("providers", revision: 99, value: providers())])
        #expect(state.beginEpoch("next"))
        state.consume(snapshot(sent, domains: [domain("providers", value: providers(enabled: "team"), epoch: "next")], epoch: "next"))
        state.consume(old)
        #expect(state.domains["providers"]?.modelEpoch == "next")
        #expect(state.providers.first(where: \.enabled)?.id == "team")
        #expect(!state.beginEpoch("model-a"))
    }
}
