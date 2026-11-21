import Foundation
import XCTest
@testable import OrbisCore

final class LiveActivityPresentationTests: XCTestCase {
    // SC111: Host identity is retained for every phase, never inferred from the
    // Agent icon or the selected Host, and attention outranks running activities.
    func testHostSourceAndPriorityRemainIndependentFromTaskState() {
        let sources = NotificationSource.make([.init(hostId: "one", name: "Work Mac", pairingKey: "p")], language: "en")
        let p = OrbisLiveActivityPresentation(state: state(), isStale: false, language: "en", hostId: "one", source: sources["one"])
        XCTAssertEqual(p.source.name, "Work Mac")
        XCTAssertTrue(p.sourceAccessibilityLabel.hasPrefix("Work Mac, "))
        XCTAssertEqual(state().relevanceScore, 50)
        var attention = state(); attention.phase = "attention"; attention.pendingCount = 1
        XCTAssertEqual(attention.relevanceScore, 100)
        var stale = state(); stale.phase = "stale"
        XCTAssertEqual(stale.relevanceScore, 0)
        let legacy = OrbisLiveActivityPresentation(state: state(), isStale: true, language: "en", hostId: "one")
        XCTAssertTrue(legacy.source.name.hasPrefix("Computer "))
        XCTAssertTrue(legacy.sourceAccessibilityLabel.contains("Update needed"))
    }
    private let focus = String(repeating: "a", count: 64)
    private func state(_ phase: String = "running", running: Int = 1, pending: Int = 0,
                       outcome: String? = nil) -> OrbisLiveActivityState {
        OrbisLiveActivityState(phase: phase, runningCount: running, pendingCount: pending,
            focusKey: focus, agentKind: "codex", startedAt: 1_000, updatedAt: 139_000, outcome: outcome)
    }
    private func presentation(_ state: OrbisLiveActivityState, stale: Bool = false) -> OrbisLiveActivityPresentation {
        OrbisLiveActivityPresentation(state: state, isStale: stale, language: "zh-Hans")
    }

    // LA-02: the compact single-session state uses confirmed approximate minutes,
    // while a multi-session state replaces time with a count, never both numbers.
    func testSingleAndMultipleCompactValuesUseDifferentSemantics() {
        let single = presentation(state())
        XCTAssertEqual(single.compactText, "约 2 分钟")
        XCTAssertEqual(single.assetName, "AgentCodex")
        XCTAssertNil(single.otherRunningText)
        let multiple = presentation(state(running: 3))
        XCTAssertEqual(multiple.compactText, "3 个")
        XCTAssertEqual(multiple.assetName, "OrbisMark")
        XCTAssertEqual(multiple.otherRunningCount, 2)
        XCTAssertEqual(multiple.otherRunningText, "另有 2 个会话运行中")
    }

    // AGENT-MARK-01: use the OpenCode mark only for a non-stale single session;
    // ActivityKit's aggregate and fallback states still use the Orbis mark.
    func testOpenCodeUsesItsMarkOnDarkActivitySurface() {
        var activity = state()
        activity.agentKind = "opencode"
        XCTAssertEqual(presentation(activity).assetName, "AgentOpenCodeDark")
        XCTAssertTrue(presentation(activity).markUsesOriginalColors)
        XCTAssertEqual(presentation(activity, stale: true).assetName, "OrbisMark")
        activity.runningCount = 2
        XCTAssertEqual(presentation(activity).assetName, "OrbisMark")
        XCTAssertFalse(presentation(activity).markUsesOriginalColors)
    }

    // LA-03: waiting for a person takes visual priority; running sessions remain
    // visible only in the expanded secondary summary.
    func testAttentionWinsCompactCountAndKeepsOtherRunningSessions() {
        let p = presentation(state("attention", running: 3, pending: 1))
        XCTAssertEqual(p.compactText, "1")
        XCTAssertTrue(p.isAttention)
        XCTAssertEqual(p.headline, "1 项待处理")
        XCTAssertEqual(p.otherRunningCount, 3)
        XCTAssertEqual(p.otherRunningText, "另有 3 个会话运行中")
        XCTAssertEqual(p.actionText, "查看请求")
    }

    // LA-04: an expired/unsupported/invalid summary must not keep claiming the
    // agent is running, or expose an elapsed counter or actionable approval.
    func testStaleAndInvalidStatesStopMakingRunningClaims() {
        var invalid = state(); invalid.version = 2
        var negative = state(); negative.runningCount = -1
        var invalidTime = state(); invalidTime.startedAt = 140_000
        var invalidFocus = state(); invalidFocus.focusKey = "untrusted"
        var invalidOutcome = state("stale"); invalidOutcome.outcome = "completed"
        var tooMany = state(); tooMany.runningCount = 2049
        for p in [presentation(state(), stale: true), presentation(invalid), presentation(negative),
                  presentation(invalidTime), presentation(invalidFocus), presentation(invalidOutcome),
                  presentation(tooMany), presentation(state("stale"))] {
            XCTAssertTrue(p.isStale)
            XCTAssertFalse(p.isAttention)
            XCTAssertEqual(p.compactText, "—")
            XCTAssertEqual(p.statusText, "状态待更新")
            XCTAssertNil(p.elapsedText)
            XCTAssertNil(p.otherRunningText)
        }
    }

    // LA-05: a generic end is not success, and a completed result remains
    // terminal when ActivityKit marks an old lock-screen card stale.
    func testTerminalOutcomeDoesNotInventSuccess() {
        for (outcome, expected) in [("completed", "已完成"), ("failed", "执行失败"),
                                    ("cancelled", "已取消"), ("unknown", "已结束")] {
            let p = presentation(state("ended", running: 0, outcome: outcome), stale: true)
            XCTAssertTrue(p.isEnded)
            XCTAssertEqual(p.statusText, expected)
            XCTAssertEqual(p.detail, "约 2 分钟")
            XCTAssertNil(p.otherRunningText)
        }
        XCTAssertEqual(presentation(state("ended", running: 0)).statusText, "已结束")
    }

    // LA-06: only the same opaque focus can recover a locally stored title.
    // Focus changes through APNs fall back to a generic title without leaking
    // or mislabelling the previous session.
    func testLocalTitleIsBoundToExactFocus() {
        XCTAssertEqual(OrbisLiveActivityPresentation(state: state(), isStale: false, language: "zh-Hans",
            initialFocusKey: focus, initialTitle: "修复登录问题").title, "修复登录问题")
        XCTAssertEqual(OrbisLiveActivityPresentation(state: state(), isStale: false, language: "zh-Hans",
            initialFocusKey: String(repeating: "b", count: 64), initialTitle: "旧会话").title, "当前任务")
        var noFocus = state(); noFocus.focusKey = nil
        XCTAssertEqual(OrbisLiveActivityPresentation(state: noFocus, isStale: false, language: "en",
            initialTitle: "Old session").title, "Current task")
    }

    // LA-01: the Swift decoder accepts the server's complete nullable schema,
    // and the serialized content cannot contain a local session title.
    func testNullableWireSchemaRoundTripsWithoutPrivateTitle() throws {
        let wire = """
        {"version":1,"phase":"running","runningCount":1,"pendingCount":0,"focusKey":null,
        "agentKind":null,"startedAt":null,"updatedAt":139000,"outcome":null}
        """
        let state = try JSONDecoder().decode(OrbisLiveActivityState.self, from: Data(wire.utf8))
        XCTAssertTrue(state.isValid)
        XCTAssertNil(state.focusKey)
        XCTAssertNil(presentation(state).elapsedText)
        let data = try JSONEncoder().encode(state)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertNil(object["title"])
        XCTAssertNil(object["initialTitle"])
        XCTAssertNil(object["source"])
    }

    // LA-02: cap large compact counts, preserve full expanded counts, and use
    // English singular copy without creating a timer-based duration view.
    func testCompactCountCapAndEnglishSingular() {
        let p = OrbisLiveActivityPresentation(state: state(running: 2048), isStale: false, language: "en")
        XCTAssertEqual(p.compactText, "99+")
        XCTAssertEqual(p.headline, "2048 running")
        let two = OrbisLiveActivityPresentation(state: state(running: 2), isStale: false, language: "en")
        XCTAssertEqual(two.otherRunningText, "1 other session running")
        let one = OrbisLiveActivityPresentation(state: state(), isStale: false, language: "en")
        XCTAssertEqual(one.elapsedText, "~2 min")
    }
}
