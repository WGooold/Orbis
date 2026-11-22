import Foundation
import XCTest
@testable import OrbisCore

final class LiveActivityPresentationTests: XCTestCase {
    private let focus = String(repeating: "a", count: 64)
    private let otherFocus = String(repeating: "b", count: 64)
    private let reference = String(repeating: "c", count: 64)
    private func state(_ phase: String = "running", running: Int = 1, pending: Int = 0,
                       outcome: String? = nil, sessions: Int? = nil) -> OrbisLiveActivityState {
        OrbisLiveActivityState(phase: phase, runningCount: running, pendingCount: pending,
            focusKey: focus, agentKind: "claude", startedAt: 1_000, updatedAt: 139_000, outcome: outcome, sessionCount: sessions)
    }
    private func presentation(_ state: OrbisLiveActivityState, stale: Bool = false) -> OrbisLiveActivityPresentation {
        OrbisLiveActivityPresentation(state: state, isStale: stale, language: "zh-Hans", hostId: "host")
    }

    // LIVE-ACTIVITY-02: the clock is absolute and compact; advancing Host
    // freshness does not change it. Request counts do not masquerade as sessions.
    func testStaticClockAndCompactAgentIdentity() throws {
        let one = presentation(state())
        XCTAssertEqual(one.compactAgent?.title, "Claude Code")
        XCTAssertEqual(one.compactAgent?.assetName(dark: true), "AgentClaude")
        let clock = try XCTUnwrap(one.compactText)
        XCTAssertEqual(clock.count, 5)
        XCTAssertTrue(clock.contains(":"))
        XCTAssertEqual(one.startedText, try XCTUnwrap(one.clockText) + " 开始")
        var heartbeat = state(); heartbeat.updatedAt += 600_000
        XCTAssertEqual(presentation(heartbeat).compactText, clock)
        XCTAssertEqual(presentation(heartbeat).startedText, one.startedText)
        let singleWaiting = presentation(state("attention", running: 0, pending: 3, sessions: 1))
        XCTAssertNotNil(singleWaiting.compactAgent)
        XCTAssertNil(presentation(state("attention", running: 0, pending: 3, sessions: 2)).compactAgent)
        let multiple = presentation(state(running: 2048))
        XCTAssertNil(multiple.compactAgent)
        XCTAssertEqual(multiple.compactText, "99+")
        XCTAssertNil(multiple.startedText)
    }

    // Pending and running totals are shown once. Compact leading announces only
    // the source; trailing announces status. Minimal combines them once.
    func testAttentionKeepsDistinctCountsAndRelevance() {
        let p = presentation(state("attention", running: 3, pending: 1, sessions: 4))
        XCTAssertEqual(p.headline, "1 项待处理 · 3 个运行中")
        XCTAssertEqual(p.compactText, "1")
        XCTAssertEqual(p.state.relevanceScore, 100)
        XCTAssertEqual(p.compactStatusAccessibilityLabel, p.headline)
        XCTAssertEqual(p.sourceAccessibilityLabel, p.source.name + ", " + p.headline)
        XCTAssertEqual(state().relevanceScore, 50)
        XCTAssertEqual(state("stale").relevanceScore, 0)
    }

    // Invalid/out-of-date content does not claim a running task. An APNs end
    // keeps its result even if surfaced with an old system staleness flag.
    func testStaleAndTerminalHaveSeparateSemanticsAndSymbols() {
        var unsupported = state(); unsupported.agentKind = "hermes"
        var wrongCounts = state("attention", running: 2048, pending: 1, sessions: 2048)
        for p in [presentation(state(), stale: true), presentation(unsupported), presentation(wrongCounts), presentation(state("stale"))] {
            XCTAssertEqual(p.status, .stale)
            XCTAssertEqual(p.headline, "待更新")
            XCTAssertNil(p.compactText)
            XCTAssertNil(p.startedAt)
        }
        wrongCounts = state(); wrongCounts.startedAt = 140_000
        XCTAssertFalse(wrongCounts.isValid)
        for (outcome, status, symbol) in [("completed", OrbisLiveActivityPresentation.Status.completed, "checkmark.circle.fill"),
                                          ("failed", .failed, "xmark.circle.fill"), ("cancelled", .cancelled, "slash.circle"),
                                          ("unknown", .ended, "minus.circle")] {
            let p = presentation(state("ended", running: 0, outcome: outcome), stale: true)
            XCTAssertEqual(p.status, status)
            XCTAssertEqual(p.statusSymbol, symbol)
            XCTAssertNil(p.startedText)
        }
    }

    // Same computer, different focus; same session, different computer; and
    // same computer after re-pairing are three different display identities.
    func testTitlesFollowFocusAndNeverCrossPairings() throws {
        let oldKey = String(repeating: "1", count: 64)
        var cache = LiveActivityDisplayCache()
        cache.reconcile([.init(hostId: "host", name: "Rex's MacBook Pro", pairingKey: oldKey, pairingRef: reference)], language: "en")
        cache.merge([.init(focusKey: focus, text: " First task\n "), .init(focusKey: otherFocus, text: "Second task")], hostId: "host", pairingRef: reference)
        let attrs = OrbisLiveActivityAttributes(hostId: "host", pairingRef: reference)
        func show(_ attrs: OrbisLiveActivityAttributes, _ state: OrbisLiveActivityState) -> OrbisLiveActivityPresentation {
            cache.presentation(attributes: attrs, state: state, isStale: false, fallbackLanguage: "en")
        }
        XCTAssertEqual(show(attrs, state()).title, "First task")
        XCTAssertEqual(show(attrs, state()).source.name, "Rex's MacBook Pro")
        XCTAssertNil(show(attrs, state()).badge)
        var next = state(); next.focusKey = otherFocus
        XCTAssertEqual(show(attrs, next).title, "Second task")
        XCTAssertNil(show(.init(hostId: "different-host", pairingRef: reference), state()).title)
        XCTAssertNil(show(.init(hostId: "host", pairingRef: otherFocus), state()).title)
        next.focusKey = nil
        XCTAssertNil(show(attrs, next).title)
        XCTAssertEqual(show(attrs, next).details, "Claude Code")

        let legacy = OrbisLiveActivityAttributes(hostId: "host", pairingKey: oldKey, initialFocusKey: focus, initialTitle: "Legacy title")
        XCTAssertEqual(show(legacy, state()).title, "First task")
        cache.reconcile([.init(hostId: "host", name: "Same host, new pairing", pairingKey: "2", pairingRef: otherFocus)], language: "en")
        cache.merge([.init(focusKey: focus, text: "Late old write")], hostId: "host", pairingRef: reference)
        XCTAssertNil(show(attrs, state()).title)
        XCTAssertNil(show(legacy, state()).title)
        XCTAssertNil(show(.init(hostId: "host", pairingRef: otherFocus), state()).title)
    }

    // Compact Host markers are stable opaque codes, not a prefix of the user's
    // computer name; same-named computers are distinguishable.
    func testMultiComputerMarkersAreStableAndNamesStayInFullView() {
        let inputs: [LiveActivityDisplayCache.Input] = [
            .init(hostId: "one", name: "Mac mini", pairingKey: "1", pairingRef: reference),
            .init(hostId: "two", name: "Mac mini", pairingKey: "2", pairingRef: otherFocus),
            .init(hostId: "three", name: "王小明的MacBook Pro", pairingKey: "3", pairingRef: focus)
        ]
        var cache = LiveActivityDisplayCache(); cache.reconcile(inputs, language: "zh-Hans")
        let badges = cache.hosts.mapValues(\.badge)
        XCTAssertEqual(Set(badges.values.compactMap { $0 }).count, 3)
        XCTAssertTrue(badges.values.compactMap { $0 }.allSatisfy { $0.count <= 6 })
        XCTAssertEqual(cache.hosts["three"]?.source.name, "王小明的MacBook Pro")
        cache.reconcile(Array(inputs.reversed()), language: "zh-Hans")
        XCTAssertEqual(badges, cache.hosts.mapValues(\.badge))
    }

    func testReleasedAndPushStartAttributesAreDecodableWithoutPrivatePayloadFields() throws {
        let released = Data("""
        {"hostId":"host","language":"en","pairingKey":"\(reference)","initialTitle":"Old title","initialFocusKey":"\(focus)"}
        """.utf8)
        XCTAssertEqual(try JSONDecoder().decode(OrbisLiveActivityAttributes.self, from: released).initialTitle, "Old title")
        let start = Data("""
        {"hostId":"host","pairingRef":"\(reference)","launchId":"00000000-0000-4000-8000-000000000001"}
        """.utf8)
        let attrs = try JSONDecoder().decode(OrbisLiveActivityAttributes.self, from: start)
        XCTAssertNil(attrs.language)
        XCTAssertNil(attrs.initialTitle)
        XCTAssertEqual(LiveActivityOpenTarget(url: try XCTUnwrap(attrs.url(focusKey: focus)))?.focusKey, focus)
        let wire = """
        {"version":1,"phase":"running","runningCount":1,"pendingCount":0,"focusKey":null,
        "agentKind":null,"startedAt":null,"updatedAt":139000,"outcome":null}
        """
        let parsed = try JSONDecoder().decode(OrbisLiveActivityState.self, from: Data(wire.utf8))
        XCTAssertTrue(parsed.isValid)
        XCTAssertNil(parsed.sessionCount)
        XCTAssertNil(presentation(parsed).details)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(parsed)) as? [String: Any])
        for field in ["title", "initialTitle", "source"] { XCTAssertNil(object[field]) }
    }

    func testDisplayFileIsBoundedAndDropsRemovedPairings() throws {
        let temp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: temp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: temp) }
        let file = temp.appendingPathComponent("activity-display.json")
        let inputs = (0..<32).map { LiveActivityDisplayCache.Input(hostId: "host-\($0)", name: "Mac",
            pairingKey: reference, pairingRef: reference) }
        var cache = LiveActivityDisplayCache(); cache.reconcile(inputs, language: "en")
        let titles = (0..<64).map { LiveActivityDisplayCache.Title(focusKey: NotificationSource.digest("\($0)"), text: String(repeating: "🧭", count: 160)) }
        for host in inputs { cache.merge(titles, hostId: host.hostId, pairingRef: reference) }
        try cache.write(to: file, prioritizing: "host-31")
        let restored = try XCTUnwrap(LiveActivityDisplayCache.read(from: file))
        XCTAssertEqual(restored.hosts["host-31"]?.titles.first?.text.utf8.count, 256)
        cache.reconcile([], language: "en")
        try cache.write(to: file, prioritizing: nil)
        XCTAssertEqual(LiveActivityDisplayCache.read(from: file)?.hosts.count, 0)
    }
}
