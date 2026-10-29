import Foundation
import Testing
@testable import OrbisCore

@Suite("Android aligned Agent model") @MainActor
struct AgentStateTests {
    @MainActor private final class Harness {
        let state = AgentState()
        var sent: [[String: Any]] = []
        var runtime = RuntimeSummary(runtimeId: "runtime", name: "Agent", cwd: "/repo", status: "idle", sessionId: "session", agentKind: "pi")
        var projection: AgentProjection?
        init() {
            state.send = { [weak self] in self?.sent.append($0); return true }
            state.didProject = { [weak self] _, _, domains in
                guard let self, let projected = AgentProjection.make(runtime: self.runtime, hostId: "host", domains: domains,
                    commands: self.projection?.commands ?? [], interactions: self.projection?.interactions ?? [], queuedMessages: self.projection?.queuedMessages ?? []) else { return false }
                self.runtime = projected.runtime; self.projection = projected; return true
            }
            connect(); state.subscribe(runtime: runtime)
        }
        func connect(_ ready: Bool = true, host: String = "host") {
            state.setConnection(HostPairing(hostId: host, hostName: host, hostPub: "pub", pskRoot: "root",
                relay: RelayCredential(relayUrl: "wss://example.test", deviceId: "device", credential: "credential"), lan: []), connected: ready)
        }
        var request: [String: Any] { sent.last ?? [:] }
        func receive(_ domains: [[String: Any]], epoch: String = "epoch", unchanged: [String] = [], request: [String: Any]? = nil) {
            let read = request ?? self.request
            state.consume(["type": "agent.state.snapshot", "scope": "agent", "requestId": read["requestId"]!,
                "runtimeId": "runtime", "sessionId": "session", "agentKind": "pi", "modelEpoch": epoch,
                "domains": domains, "missing": [], "truncated": false, "unchanged": unchanged])
        }
    }
    private func domain(_ name: String, _ value: Any, revision: Int = 1, complete: Bool = true, availability: String = "ready") -> [String: Any] {
        ["domain": name, "modelEpoch": "epoch", "revision": revision, "availability": availability,
         "completeness": complete ? "complete" : "partial", "checkedAt": 100,
         "source": ["producer": "host", "sourceId": "host", "sourceEpoch": "native", "sourceRevision": revision], "value": value]
    }
    private func question(_ id: String = "question") -> [String: Any] {
        ["requestId": id, "extensionId": "extension", "kind": "select", "title": "Choose", "expiresAt": 9999999999999,
         "options": [["value": "yes", "label": "Yes"]]]
    }

    @Test func independentDomainsRestoreStatusModelContextAndOpaqueCapabilities() throws {
        let h = Harness()
        h.receive([domain("execution", ["phase": "waiting_local_interaction"])])
        h.receive([domain("model", ["provider": "p", "id": "m", "thinkingLevel": "high"]),
                   domain("context", ["tokens": 100, "contextWindow": 1000, "percent": 10]),
                   domain("permissions", ["management": ["summary": "Host policy", "details": "Opaque", "tone": "restricted", "settings": []]]),
                   domain("capabilities", ["model": ["name": "model", "source": "builtin", "argument": ["kind": "select", "required": true,
                        "options": [["value": "opaque", "label": "Choice"]]]]])])
        #expect(h.runtime.status == "waiting_local_interaction")
        #expect(h.runtime.model?.id == "m")
        #expect(h.runtime.thinkingLevel == "high")
        #expect(h.runtime.contextUsage?.percent == 10)
        #expect(h.runtime.permissionManagement?.summary == "Host policy")
        #expect(h.projection?.commands.first?.argument?.options?.first?.value == "opaque")
        let count = h.sent.count; h.state.subscribe(runtime: h.runtime)
        #expect(h.sent.count == count)
    }

    @Test func staleVersionsMalformedBatchesAndWrongSubscriptionsCannotMutateFacts() {
        let h = Harness()
        h.receive([domain("execution", ["phase": "running"], revision: 3)])
        h.receive([domain("execution", ["phase": "idle"], revision: 2)])
        h.receive([domain("execution", ["phase": "idle"], revision: 3)])
        #expect(h.runtime.status == "running")
        h.receive([domain("execution", ["phase": "idle"], revision: 4), domain("model", ["id": "invalid"])])
        #expect(h.runtime.status == "running")
        #expect(h.state.snapshots["runtime"]?.domains["execution"]?.revision == 3)
        #expect(h.state.snapshots["runtime"]?.error != nil)
        h.receive([domain("execution", ["phase": "idle"], revision: 5)], request: ["requestId": "old"])
        #expect(h.runtime.status == "running")
        h.state.remove(runtimeId: "runtime")
        h.receive([domain("execution", ["phase": "idle"], revision: 5)])
        #expect(h.state.snapshots.isEmpty)
    }

    @Test func partialInventoriesMergeWhileCompleteHostProjectionsRemove() {
        let h = Harness()
        h.receive([domain("interactions", ["question": question()])])
        #expect(h.projection?.interactions.first?.runtimeId == "runtime")
        h.receive([domain("interactions", [:], revision: 2, complete: false)])
        #expect(h.projection?.interactions.count == 1)
        var full = domain("interactions", [:], revision: 3, complete: false); full["projectionComplete"] = true
        h.receive([full])
        #expect(h.projection?.interactions.isEmpty == true)
        h.receive([domain("interactions", ["question": question()], revision: 1)])
        #expect(h.projection?.interactions.isEmpty == true)
    }

    @Test func queueStateAndExplicitNullsAreRestoredWithoutGuessing() {
        let h = Harness()
        h.receive([domain("delivery", ["queue": ["queueId": "queue", "text": "hello", "delivery": "steer", "state": "accepted"]]),
            domain("model", ["provider": "p", "id": "m"])])
        #expect(h.projection?.queuedMessages.first?.state == "accepted")
        h.receive([domain("delivery", ["queue": ["queueId": "queue", "text": "hello", "delivery": "steer", "state": "delivered"]], revision: 2),
            domain("model", NSNull(), revision: 2)])
        #expect(h.projection?.queuedMessages.isEmpty == true)
        #expect(h.runtime.model == nil)
    }

    @Test func reconnectReprojectsUnchangedBaselineAndHostSwitchIsolatesVersions() throws {
        let h = Harness()
        h.receive([domain("execution", ["phase": "running"])])
        let old = h.request
        h.connect(false); h.connect(); h.state.subscribe(runtime: h.runtime)
        #expect((h.request["known"] as? [[String: Any]])?.first?["domain"] as? String == "execution")
        h.runtime.status = "unknown"
        h.receive([], unchanged: ["execution"])
        #expect(h.runtime.status == "running")
        h.receive([domain("execution", ["phase": "idle"], revision: 2)], request: old)
        #expect(h.runtime.status == "running")
        h.connect(host: "other-host")
        #expect(h.state.snapshots.isEmpty)
    }

    @Test func authenticatedReadyReplacesModelEpochWithoutAPathDisconnect() {
        let h = Harness()
        h.receive([domain("execution", ["phase": "running"])])
        let old = h.request
        #expect(h.state.beginEpoch("new-epoch"))
        h.state.subscribe(runtime: h.runtime)
        #expect((h.request["known"] as? [[String: Any]])?.isEmpty == true)
        var fresh = domain("execution", ["phase": "idle"]); fresh["modelEpoch"] = "new-epoch"
        h.receive([fresh], epoch: "new-epoch")
        #expect(h.runtime.status == "idle")
        h.receive([domain("execution", ["phase": "running"], revision: 100)], request: old)
        #expect(h.runtime.status == "idle")
        #expect(!h.state.beginEpoch("epoch"))
    }

    @Test func interactionShapesAndAnswersAreValidatedWithoutRelyingOnTheView() throws {
        let h = Harness()
        h.receive([domain("interactions", ["question": question()])])
        let request = try #require(h.projection?.interactions.first)
        #expect(request.acceptsResponse(["kind": "select", "value": "yes"]))
        #expect(request.acceptsResponse(["kind": "cancel"]))
        #expect(!request.acceptsResponse(["kind": "select", "value": "unknown"]))
        #expect(!request.acceptsResponse(["kind": "confirm", "value": true]))
        #expect(!request.acceptsResponse(["kind": "select", "value": "yes", "extra": true]))
        var invalid = question(); invalid["options"] = []
        h.receive([domain("execution", ["phase": "running"]), domain("interactions", ["question": invalid], revision: 2)])
        #expect(h.runtime.status == "idle")
        #expect(h.projection?.interactions.first == request)
    }

    @Test func questionnairesEnforceKnownValuesSelectionCardinalityAndOptionalText() throws {
        let h = Harness()
        var raw = question(); raw["kind"] = "questionnaire"; raw["options"] = nil
        raw["questions"] = [["id": "one", "question": "Choose", "options": [["value": "yes", "label": "Yes"]],
                             "multiSelect": false, "allowOther": true, "allowNotes": false]]
        h.receive([domain("interactions", ["question": raw])])
        let request = try #require(h.projection?.interactions.first)
        #expect(request.acceptsResponse(["kind": "questionnaire", "answers": [["id": "one", "values": ["yes"]]]]))
        #expect(request.acceptsResponse(["kind": "questionnaire", "answers": [["id": "one", "values": [], "other": "custom"]]]))
        #expect(!request.acceptsResponse(["kind": "questionnaire", "answers": [["id": "one", "values": ["yes"], "other": "custom"]]]))
        #expect(!request.acceptsResponse(["kind": "questionnaire", "answers": [["id": "one", "values": ["yes"], "notes": "not allowed"]]]))
        #expect(!request.acceptsResponse(["kind": "questionnaire", "answers": [["id": "unknown", "values": ["yes"]]]]))
        #expect(!request.acceptsResponse(["kind": "questionnaire", "answers": []]))
    }
}
