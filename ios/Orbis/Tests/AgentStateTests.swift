// Orbis 测试用途（场景与判定见本文件断言）：
// - Claude 后台子任务（S26、S17、S20、V05、V12、V16、V18、M03、M06、M10、M20）
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
            connect()
            // Parser / projection fixtures explicitly own all domains they exercise.
            state.setInterest(runtime: runtime, owner: "parser-fixture", domains: Set(AgentState.domainNames))
        }
        func connect(_ ready: Bool = true, host: String = "host") {
            state.setConnection(HostPairing(hostId: host, hostName: host, hostPub: "pub", pskRoot: "root",
                relay: RelayCredential(relayUrl: "wss://example.test", deviceId: "device", credential: "credential"), lan: []), connected: ready)
        }
        var request: [String: Any] { sent.last ?? [:] }
        func receive(_ domains: [[String: Any]], epoch: String = "epoch", unchanged: [String] = [], request: [String: Any]? = nil) {
            let read = request ?? self.request
            var payload: [String: Any] = ["type": "agent.state.snapshot", "scope": "agent", "requestId": read["requestId"]!,
                "runtimeId": "runtime", "sessionId": "session", "agentKind": "pi", "modelEpoch": epoch,
                "domains": domains, "missing": [], "truncated": false, "unchanged": unchanged]
            payload["stateFormat"] = read["stateFormat"]
            state.consume(payload)
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

    // FT-G03: verify the actual request lifecycle, not just the domain set helper.
    @Test func viewInterestsShrinkImmediatelyAndOldReadsCannotRestoreThem() {
        let h = Harness()
        h.state.setInterest(runtime: h.runtime, owner: "parser-fixture", domains: [])
        #expect(Set(h.request["domains"] as? [String] ?? []) == AgentState.homeDomains)
        #expect(!AgentState.homeDomains.contains("records"))
        h.state.setInterest(runtime: h.runtime, owner: "chat", domains: AgentState.chatDomains)
        let chatRead = h.request
        #expect(Set(chatRead["domains"] as? [String] ?? []) == AgentState.homeDomains.union(AgentState.chatDomains))
        h.receive([domain("model", ["provider": "p", "id": "cached"])])
        h.state.setInterest(runtime: h.runtime, owner: "inspector", domains: ["records"])
        h.state.setInterest(runtime: h.runtime, owner: "chat", domains: [])
        #expect(Set(h.request["domains"] as? [String] ?? []) == AgentState.homeDomains.union(["records"]))
        #expect(!h.state.owns("model", runtimeId: "runtime"))
        #expect((h.request["known"] as? [[String: Any]])?.contains { $0["domain"] as? String == "model" } == false)
        h.receive([domain("model", ["provider": "p", "id": "stale"], revision: 2)], request: chatRead)
        #expect(h.runtime.model?.id == "cached")
        h.state.setInterest(runtime: h.runtime, owner: "inspector", domains: [])
        #expect(Set(h.request["domains"] as? [String] ?? []) == AgentState.homeDomains)
        h.state.setInterest(runtime: h.runtime, owner: "chat", domains: AgentState.chatDomains)
        #expect((h.request["known"] as? [[String: Any]])?.contains { $0["domain"] as? String == "model" } == true)
    }

    // FT-G04: an old strict Host rejects the format by the original request ID;
    // retry only this read without the extension and never reuse format versions.
    @Test func compactIdentityAndStrictOldHostFallbackKeepIndependentVersions() {
        let h = Harness()
        h.receive([domain("identity", ["runtimeId": "runtime", "sessionId": "session", "name": "Static", "cwd": "/repo", "hostId": "host"])])
        #expect(h.runtime.name == "Static")
        #expect(h.runtime.status == "idle")
        let old = h.request
        h.state.consume(["type": "protocol.error", "code": "invalid_request", "requestId": old["requestId"]!])
        #expect(h.request["stateFormat"] as? String == "compact-v1")
        h.state.consume(["type": "protocol.error", "code": "invalid_request", "requestId": h.request["requestId"]!])
        #expect(h.request["stateFormat"] == nil)
        #expect((h.request["known"] as? [[String: Any]])?.isEmpty == true)
        h.receive([domain("identity", ["runtimeId": "runtime", "sessionId": "session", "name": "Legacy", "cwd": "/repo", "status": "idle"])])
        #expect(h.runtime.name == "Legacy")
        h.receive([domain("identity", ["runtimeId": "runtime", "sessionId": "session", "name": "Stale", "cwd": "/repo"])], request: old)
        #expect(h.runtime.name == "Legacy")
    }

    // FT-G06: patch only an exact baseline, retain committed UI on a gap and
    // recover with a fresh read; no partial domain from the rejected batch applies.
    @Test func collectionDeltasApplyAtomicallyAndRecoverMissingBaselines() {
        let h = Harness()
        h.receive([domain("interactions", ["question": question()])])
        var row = domain("interactions", NSNull(), revision: 2)
        row["delta"] = ["baseRevision": 1, "operations": [["op": "remove", "path": ["question"]]]]
        h.receive([row])
        #expect(h.projection?.interactions.isEmpty == true)
        let sent = h.sent.count
        row["revision"] = 4
        row["delta"] = ["baseRevision": 3, "operations": [["op": "set", "path": ["question"], "value": question()]]]
        h.receive([domain("model", ["provider": "p", "id": "must-not-apply"]), row])
        #expect(h.sent.count == sent + 1)
        #expect(h.runtime.model == nil)
        #expect(h.projection?.interactions.isEmpty == true)
        #expect((h.request["known"] as? [[String: Any]])?.isEmpty == true)
        h.receive([domain("interactions", ["question": question()], revision: 4)])
        #expect(h.projection?.interactions.count == 1)
    }

    @Test func taskInventoryIsProjectedIndependentlyAndUnknownKeepsTheLastTasks() {
        let h = Harness()
        let task: [String: Any] = ["id": "child", "title": "任务", "kind": "Explore", "status": "running"]
        h.receive([domain("execution", ["phase": "idle", "tasks": ["availability": "ready", "items": [task], "truncated": false]])])
        #expect(h.runtime.status == "idle")
        #expect(h.runtime.presentationTitle == "1 个子任务运行中")
        h.receive([domain("execution", ["phase": "idle", "tasks": ["availability": "unknown", "items": [], "truncated": false]], revision: 2)])
        #expect(h.runtime.backgroundTasks?.items.first?.id == "child")
        #expect(h.runtime.backgroundTasks?.availability == "unknown")
        h.receive([domain("execution", ["phase": "idle", "tasks": ["availability": "ready", "items": [], "truncated": false]], revision: 3)])
        #expect(h.runtime.presentationTitle == "空闲")
        #expect(h.runtime.backgroundTasks?.items.isEmpty == true)
        h.receive([domain("execution", ["phase": "idle"], revision: 4)])
        #expect(h.runtime.presentationTitle == "空闲")
        h.receive([domain("execution", NSNull(), revision: 5, availability: "unknown")])
        #expect(h.runtime.status == "unknown")
        #expect(h.runtime.backgroundTasks?.availability == "unknown")
    }

    // S33 / SC52: partial generic tasks must update rows, not replace them with an old snapshot.
    @Test func partialTasksUpdateKnownRowsAndRetainUnseenTasks() {
        let h = Harness()
        let child = ["id": "child", "title": "检查", "kind": "agent", "status": "running"]
        let retained = ["id": "retained", "title": "已有任务", "kind": "agent", "status": "running"]
        h.receive([domain("execution", ["phase": "idle", "tasks": ["availability": "ready", "items": [child, retained], "truncated": false]])])
        let completed = ["id": "child", "title": "检查完成", "kind": "agent", "status": "completed"]
        let next = ["id": "new", "parentId": "child", "title": "等待检查", "kind": "agent", "status": "waiting"]
        h.receive([domain("execution", ["phase": "idle", "tasks": ["availability": "unknown", "items": [completed, next], "truncated": true]], revision: 2)])
        #expect(h.runtime.status == "idle")
        #expect(h.runtime.backgroundTasks?.items.map(\.id) == ["child", "retained", "new"])
        #expect(h.runtime.backgroundTasks?.items.first?.status == "completed")
        #expect(h.runtime.backgroundTasks?.items.first?.title == "检查完成")
        #expect(h.runtime.backgroundTasks?.items.last?.status == "waiting")
        #expect(h.runtime.backgroundTasks?.items.last?.parentId == "child")
        #expect(h.runtime.backgroundTasks?.panelTitle == "子代理 · 3 项 · 清单不完整")
        #expect(h.runtime.backgroundTasks?.allowsQuit == false)
        h.receive([domain("execution", NSNull(), revision: 3, availability: "unknown")])
        #expect(h.runtime.backgroundTasks?.truncated == false)
        #expect(h.runtime.backgroundTasks?.inventoryNotice == "状态待核对，显示最后已知信息")
    }

    @Test func compactionActivityDrivesPresentationWithoutChangingExecutionPhase() {
        let h = Harness()
        h.receive([domain("execution", ["phase": "idle", "compaction": ["phase": "running"]])])
        #expect(h.runtime.status == "idle")
        #expect(runtimeStatusTitle(h.runtime.presentationStatus) == "压缩中")
        h.receive([domain("execution", ["phase": "running", "compaction": ["phase": "running"]], revision: 2)])
        #expect(h.runtime.status == "running")
        #expect(h.runtime.presentationStatus == "compacting")
        h.receive([domain("execution", ["phase": "waiting_local_interaction", "compaction": ["phase": "running"]], revision: 3)])
        #expect(h.runtime.presentationStatus == "waiting_local_interaction")
        h.receive([domain("execution", ["phase": "running", "compaction": ["phase": "idle"]], revision: 4)])
        #expect(h.runtime.presentationStatus == "running")
        h.receive([domain("execution", ["phase": "idle", "compaction": ["phase": "failed"]], revision: 5)])
        #expect(h.runtime.compactionPhase == "failed")
        #expect(h.runtime.presentationStatus == "idle")
        h.receive([domain("execution", ["phase": "running", "compaction": ["phase": "running"]], revision: 6)])
        h.receive([domain("execution", ["phase": "idle", "compaction": "unavailable"], revision: 7)])
        #expect(h.runtime.compactionPhase == nil)
        #expect(h.runtime.presentationStatus == "idle")
        h.receive([domain("execution", ["phase": "running", "compaction": ["phase": "running"]], revision: 8)])
        h.receive([domain("execution", NSNull(), revision: 9, availability: "unknown")])
        #expect(h.runtime.compactionPhase == nil)
        #expect(h.runtime.presentationStatus == "unknown")
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
