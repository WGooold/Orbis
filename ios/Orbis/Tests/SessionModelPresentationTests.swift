import Foundation
import Testing
@testable import OrbisCore

// SC84: current execution is never inferred from the next selection. Check the
// actual wire shape, old Hosts, missing facts and opaque native command values.
@Suite("Session model configuration parity")
struct SessionModelPresentationTests {
    private func runtime(_ kind: String = "codex") -> RuntimeSummary {
        RuntimeSummary(runtimeId: "r", name: "Agent", cwd: "/repo", status: "running", agentKind: kind,
            model: RuntimeModelInfo(provider: "openai", id: "next", name: "Next model"), thinkingLevel: "high",
            currentTurnConfiguration: RuntimeTurnConfiguration(turnId: "t", model: RuntimeModelInfo(provider: "openai", id: "current", name: "Current model"),
                thinkingLevel: "medium", thinkingKnown: true), executionTurnId: "t")
    }
    // SC86: response IDs, display names and opaque command values are distinct.
    // The four agents must not show a future change just because a turn is running.
    @Test func unchangedConfigurationsDoNotShowFutureSelectionsAcrossAgents() {
        for (kind, provider, id, option) in [
            ("pi", "deepseek", "deepseek-flash", "deepseek/deepseek-flash"),
            ("codex", "openai", "gpt-6.1-sol", "gpt-6.1-sol"),
            ("claude", "claude-code", "claude-opus-5-5", "opus"),
            ("dsh", "deepseek-official", "deepseek-flash", #"{"provider":"deepseek-official","model":"deepseek-flash"}"#)
        ] {
            var value = runtime(kind)
            value.model = RuntimeModelInfo(provider: provider, id: id, name: "Display name")
            value.modelSelection = SessionConfigurationValues(model: option, thinking: "high")
            value.currentTurnConfiguration = RuntimeTurnConfiguration(turnId: "t",
                model: RuntimeModelInfo(provider: provider, id: id, name: nil), thinkingLevel: "high", thinkingKnown: true)
            for status in ["running", "waiting_local_interaction"] {
                value.status = status
                let view = SessionModelPresentation.make(runtime: value, connected: true)
                #expect(view.showsCurrent && view.indicator == nil && view.selectionTitle == nil)
            }
            value.thinkingLevel = "low"
            let changed = SessionModelPresentation.make(runtime: value, connected: true)
            #expect(changed.selectionTitle == (kind == "codex" || kind == "claude" ? "下轮使用" : "后续选择"))
            #expect(changed.indicator != nil)
            value.thinkingLevel = "high"
            #expect(SessionModelPresentation.make(runtime: value, connected: true).selectionTitle == nil)
            value.model = RuntimeModelInfo(provider: "other-provider", id: id, name: "Display name")
            #expect(SessionModelPresentation.make(runtime: value, connected: true).indicator != nil)
            value.model = value.currentTurnConfiguration?.model
            value.currentTurnConfiguration?.thinkingKnown = false
            value.currentTurnConfiguration?.thinkingLevel = nil
            let unknown = SessionModelPresentation.make(runtime: value, connected: true)
            #expect(unknown.indicator == nil && unknown.selectionTitle == "当前所选")
            value.currentTurnConfiguration?.thinkingKnown = true // Native default is not an explicit high.
            #expect(SessionModelPresentation.make(runtime: value, connected: true).selectionTitle == "当前所选")
            value.thinkingLevel = nil
            #expect(SessionModelPresentation.make(runtime: value, connected: true).selectionTitle == nil)
            value.status = "idle"
            #expect(SessionModelPresentation.make(runtime: value, connected: true).selectionTitle == "当前所选")
        }
    }
    @Test func currentAndNextRemainIndependentThroughSaveFailureAndRevert() {
        var value = runtime()
        let confirmed = SessionModelPresentation.make(runtime: value, connected: true)
        #expect(confirmed.model == "Current model" && confirmed.thinking == "medium")
        #expect(confirmed.indicator == "下轮已设" && confirmed.showsCurrent)
        #expect(SessionModelPresentation.make(runtime: value, connected: true, progress: [("Next", "切换中")]).indicator == "保存中")
        #expect(SessionModelPresentation.make(runtime: value, connected: true, progress: [("Next", "未确认")], failed: true).indicator == "未确认")
        #expect(SessionModelPresentation.make(runtime: value, connected: true, failed: true).indicator == "修改失败")
        value.model = value.currentTurnConfiguration?.model; value.thinkingLevel = "medium"
        #expect(SessionModelPresentation.make(runtime: value, connected: true).indicator == nil)
        value.status = "idle"
        #expect(!SessionModelPresentation.make(runtime: value, connected: true).showsCurrent)
    }
    @Test func staleMissingOrDisconnectedTurnFactsNeverBecomeCurrentSelections() {
        var value = runtime()
        for (connected, modelReady, executionReady) in [(false, true, true), (true, false, true), (true, true, false)] {
            let view = SessionModelPresentation.make(runtime: value, connected: connected, modelReady: modelReady, executionReady: executionReady)
            #expect(view.model == "模型未确认" && view.thinking == nil && view.current == nil)
        }
        value.executionTurnId = "new"
        #expect(SessionModelPresentation.make(runtime: value, connected: true).model == "模型未确认")
        value.currentTurnConfiguration = nil // real older Host metadata
        #expect(SessionModelPresentation.make(runtime: value, connected: true).model == "模型未确认")
        #expect(SessionModelPresentation.make(runtime: value, connected: true).selectionTitle == "当前所选")
        value.agentKind = "pi"
        let fallback = SessionModelPresentation.make(runtime: value, connected: true)
        #expect(fallback.model == "所选：Next model" && !fallback.showsCurrent)
        value = runtime("pi")
        #expect(SessionModelPresentation.make(runtime: value, connected: true).indicator == "后续已设")
        value = runtime("claude")
        #expect(SessionModelPresentation.make(runtime: value, connected: true).indicator == "下轮已设")
    }
    @Test func nativeMissingAndExplicitDefaultDepthRoundTripWithoutLosingMeaning() throws {
        for (json, known) in [(#"{"turnId":"t"}"#, false), (#"{"turnId":"t","thinkingLevel":null}"#, true)] {
            let current = try JSONDecoder().decode(RuntimeTurnConfiguration.self, from: Data(json.utf8))
            #expect(current.thinkingKnown == known && current.thinkingLevel == nil)
            #expect(try JSONDecoder().decode(RuntimeTurnConfiguration.self, from: JSONEncoder().encode(current)) == current)
        }
    }
    @Test func projectionBindsModelAndExecutionAndClearsOldHostFacts() throws {
        func domain(_ name: String, _ value: [String: Any]) throws -> HostDomain {
            let raw: [String: Any] = ["domain": name, "modelEpoch": "epoch", "revision": 1, "availability": "ready",
                "completeness": "complete", "checkedAt": 1, "value": value,
                "source": ["producer": "host", "sourceId": "host", "sourceEpoch": "e", "sourceRevision": 1]]
            return try JSONDecoder().decode(HostDomain.self, from: JSONSerialization.data(withJSONObject: raw))
        }
        let domains = try ["execution": domain("execution", ["phase": "running", "turn": ["turnId": "t"]]),
            "model": domain("model", ["provider": "openai", "id": "next", "selection": ["model": "opaque-choice"],
                "currentTurnSupported": true, "currentTurn": ["turnId": "t", "model": ["provider": "openai", "id": "current"], "thinkingLevel": NSNull()]])]
        let projected = try #require(AgentProjection.make(runtime: runtime(), hostId: nil, domains: domains, commands: [], interactions: [], queuedMessages: [])?.runtime)
        #expect(projected.executionTurnId == "t" && projected.currentTurnConfiguration?.thinkingKnown == true)
        #expect(OperationKinds.confirmedValue(projected, setting: "model") == "opaque-choice")
        let old = try domain("model", ["provider": "openai", "id": "legacy"])
        let fallback = try #require(AgentProjection.make(runtime: projected, hostId: nil, domains: ["model": old], commands: [], interactions: [], queuedMessages: [])?.runtime)
        #expect(fallback.currentTurnConfiguration == nil && fallback.modelSelection == nil)
        #expect(SessionModelPresentation.make(runtime: fallback, connected: true).model == "模型未确认")
    }
    @Test func claudeEffortUsesConfigurationLedgerAndOpaqueValues() {
        #expect(OperationKinds.isConfigSetting("effort"))
        let effort = SlashCommand(name: "effort", description: nil, source: "builtin", argument: nil)
        #expect(OperationKinds.depthCommand([effort]) == "effort")
        var value = runtime("claude"); value.modelSelection = SessionConfigurationValues(model: "native-alias", thinking: "max")
        #expect(OperationKinds.confirmedValue(value, setting: "model") == "native-alias")
        #expect(OperationKinds.confirmedValue(value, setting: "effort") == "max")
    }
}
