import Foundation
import XCTest
@testable import OrbisCore

final class LiveActivityProjectionTests: XCTestCase {
    private func fact(_ session: String = "session", kind: String = "codex", phase: String = "running",
                      pending: Int = 0, startedAt: Int64? = 1_000, backgroundAgents: Bool = false) -> LiveActivityRuntimeFact {
        LiveActivityRuntimeFact(sessionId: session, agentKind: kind, phase: phase, pendingCount: pending,
            startedAt: startedAt, backgroundAgents: backgroundAgents, title: "Private title")
    }

    // LA-I02: an empty disconnected or partial directory does not mean tasks
    // completed. Only an authoritative complete idle directory can end an activity,
    // and that fallback cannot claim a successful outcome.
    func testIncompleteOrDisconnectedFactsNeverInventCompletion() throws {
        let active = try XCTUnwrap(LiveActivityProjection.make(hostId: "host", facts: [fact()], complete: true, previous: nil, now: 5_000))
        for facts in [[], [fact(phase: "idle")]] as [[LiveActivityRuntimeFact]] {
            let stale = try XCTUnwrap(LiveActivityProjection.make(hostId: "host", facts: facts, complete: false, previous: active, now: 8_000))
            XCTAssertEqual(stale.phase, "stale")
            XCTAssertEqual(stale.runningCount, active.runningCount)
            XCTAssertNil(stale.outcome)
        }
        let unknown = try XCTUnwrap(LiveActivityProjection.make(hostId: "host", facts: [fact(phase: "unknown")], complete: true, previous: active, now: 8_000))
        XCTAssertEqual(unknown.phase, "stale")
        let ended = try XCTUnwrap(LiveActivityProjection.make(hostId: "host", facts: [], complete: true, previous: active, now: 9_000))
        XCTAssertEqual(ended.phase, "ended")
        XCTAssertEqual(ended.outcome, "unknown")
        XCTAssertNil(LiveActivityProjection.make(hostId: "host", facts: [], complete: false, previous: ended, now: 10_000))
        XCTAssertNil(LiveActivityProjection.make(hostId: "host", facts: [], complete: false, previous: nil, now: 10_000))
    }

    // LA-I03: pending requests take focus priority and waiting sessions are not
    // double counted among the sessions still doing autonomous work. Preserve
    // an existing pending focus, matching the Host's sticky focus selection.
    func testPendingFocusHasPriorityAndWaitingDoesNotCountAsRunning() throws {
        let facts = [fact("running", startedAt: 500),
                     fact("waiting", phase: "waiting_local_interaction", pending: 2),
                     fact("pending-running", pending: 1, startedAt: 2_000)]
        let previous = try XCTUnwrap(LiveActivityProjection.make(hostId: "host", facts: [facts[1]], complete: true, previous: nil, now: 4_000))
        let value = try XCTUnwrap(LiveActivityProjection.make(hostId: "host", facts: facts, complete: true, previous: previous, now: 5_000))
        XCTAssertEqual(value.phase, "attention")
        XCTAssertEqual(value.runningCount, 1)
        XCTAssertEqual(value.pendingCount, 3)
        XCTAssertEqual(value.focusKey, LiveActivityProjection.focusKey(hostId: "host", agentKind: "codex", sessionId: "waiting"))
        let cold = try XCTUnwrap(LiveActivityProjection.make(hostId: "host", facts: facts, complete: true, previous: nil, now: 5_000))
        XCTAssertEqual(cold.focusKey, LiveActivityProjection.focusKey(hostId: "host", agentKind: "codex", sessionId: "pending-running"))
        let phaseOnly = try XCTUnwrap(LiveActivityProjection.make(hostId: "host", facts: [fact(phase: "waiting_local_interaction")], complete: true, previous: nil, now: 5_000))
        XCTAssertEqual(phaseOnly.pendingCount, 1)
        XCTAssertEqual(phaseOnly.runningCount, 0)
    }

    // LA-I08: an ahead-of-phone Host clock removes an unavailable elapsed value,
    // instead of hiding a valid running activity or fabricating a start time.
    func testFutureHostClockKeepsRunningWithoutInventingElapsedTime() throws {
        let state = try XCTUnwrap(LiveActivityProjection.make(hostId: "host", facts: [fact(startedAt: 20_000)],
            complete: true, previous: nil, now: 10_000))
        XCTAssertTrue(state.isValid)
        XCTAssertEqual(state.phase, "running")
        XCTAssertNil(state.startedAt)
    }

    // LA-I04: idle parents with active child agents remain work in progress.
    // Idle command-only facts deliberately carry backgroundAgents=false and do
    // not keep the Live Activity running after an otherwise idle inventory.
    func testBackgroundAgentWorkKeepsActivityButCommandOnlyDoesNot() throws {
        let withAgent = try XCTUnwrap(LiveActivityProjection.make(hostId: "host",
            facts: [fact(kind: "claude", phase: "idle", backgroundAgents: true)], complete: true, previous: nil, now: 5_000))
        XCTAssertEqual(withAgent.phase, "running")
        XCTAssertEqual(withAgent.runningCount, 1)
        let commandOnly = try XCTUnwrap(LiveActivityProjection.make(hostId: "host",
            facts: [fact(kind: "claude", phase: "idle", backgroundAgents: false)], complete: true, previous: withAgent, now: 6_000))
        XCTAssertEqual(commandOnly.phase, "ended")
        XCTAssertEqual(commandOnly.outcome, "unknown")
    }

    // LA-I04: classify the committed inventory through existing kind/status facts;
    // shell and monitor activity alone does not keep the agent activity alive.
    func testBackgroundInventoryRequiresConfirmedActiveAgent() {
        let agent = BackgroundTask(id: "agent", title: "Agent", kind: "agent", status: "running")
        let shell = BackgroundTask(id: "shell", title: "Shell", kind: "shell", status: "running")
        let monitor = BackgroundTask(id: "monitor", title: "Monitor", kind: "monitor", status: "waiting")
        XCTAssertTrue(LiveActivityProjection.hasBackgroundAgents(BackgroundTaskInventory(availability: "ready", items: [agent, shell], truncated: false)))
        XCTAssertFalse(LiveActivityProjection.hasBackgroundAgents(BackgroundTaskInventory(availability: "ready", items: [shell, monitor], truncated: false)))
        XCTAssertFalse(LiveActivityProjection.hasBackgroundAgents(BackgroundTaskInventory(availability: "unknown", items: [agent], truncated: false)))
        XCTAssertFalse(LiveActivityProjection.hasBackgroundAgents(BackgroundTaskInventory(availability: "unknown", items: [agent], truncated: true)))
        XCTAssertFalse(LiveActivityProjection.hasBackgroundAgents(nil))
    }

    // LA-I05: focus IDs use the exact Host JSON.stringify tuple encoding,
    // including UTF-8, unescaped slash characters and quoted session identities.
    func testFocusKeysMatchHostFixturesAndAreScopedByHostAndKind() {
        XCTAssertEqual(LiveActivityProjection.focusKey(hostId: "host-1", agentKind: "codex", sessionId: "session-1"),
            "9b186ae3903a7fca4b329f0c5c8212c19ca73aac965585a0630ce9a6322e63ea")
        XCTAssertEqual(LiveActivityProjection.focusKey(hostId: "主机/1", agentKind: "pi", sessionId: "/项目/你好 \"x\".jsonl"),
            "599019069c649eececa76a57d959f5d1cbd5be6400ad256a6f3168d1e4afca39")
        let initial = LiveActivityProjection.focusKey(hostId: "host", agentKind: "codex", sessionId: "session")
        XCTAssertNotEqual(initial, LiveActivityProjection.focusKey(hostId: "other", agentKind: "codex", sessionId: "session"))
        XCTAssertNotEqual(initial, LiveActivityProjection.focusKey(hostId: "host", agentKind: "claude", sessionId: "session"))
    }

    // LA-I06: catalog ordering does not rotate focus, and the freshness timestamp
    // is not a business state change that would trigger per-frame updates.
    func testFocusAndSemanticEqualityAreStableAcrossDirectoryOrderAndRenewal() throws {
        let facts = [fact("b", startedAt: 1_000), fact("a", startedAt: 1_000), fact("c", startedAt: nil)]
        let initial = try XCTUnwrap(LiveActivityProjection.make(hostId: "host", facts: facts, complete: true, previous: nil, now: 5_000))
        let later = try XCTUnwrap(LiveActivityProjection.make(hostId: "host", facts: Array(facts.reversed()), complete: true, previous: initial, now: 7_000))
        XCTAssertEqual(initial.focusKey, LiveActivityProjection.focusKey(hostId: "host", agentKind: "codex", sessionId: "a"))
        XCTAssertTrue(LiveActivityProjection.sameMeaning(initial, later))
        var pending = later; pending.phase = "attention"; pending.pendingCount = 1
        XCTAssertFalse(LiveActivityProjection.sameMeaning(initial, pending))
    }

    // LA-I07: activity URLs carry only navigation identity. Duplicate fields or
    // action/command parameters cannot turn a tap into a remote approval.
    func testActivityURLsRejectAmbiguousOrActionBearingParameters() throws {
        let pairing = String(repeating: "a", count: 64)
        let focus = String(repeating: "b", count: 64)
        let base = "orbis://activity?hostId=host&pairingKey=\(pairing)&focusKey=\(focus)"
        let parsed = try XCTUnwrap(LiveActivityOpenTarget(url: XCTUnwrap(URL(string: base))))
        XCTAssertEqual(parsed.hostId, "host")
        XCTAssertEqual(parsed.pairingKey, pairing)
        XCTAssertEqual(parsed.focusKey, focus)
        for suffix in ["&hostId=other", "&pairingKey=\(pairing)", "&focusKey=\(focus)", "&action=approve", "&command=run", "#approve"] {
            XCTAssertNil(LiveActivityOpenTarget(url: try XCTUnwrap(URL(string: base + suffix))), suffix)
        }
        for url in ["https://activity?hostId=host&pairingKey=\(pairing)",
                    "orbis://activity/run?hostId=host&pairingKey=\(pairing)",
                    "orbis://activity?hostId=host", "orbis://activity?hostId=host&pairingKey=invalid",
                    "orbis://activity?hostId=host&pairingKey=\(pairing)&focusKey=invalid"] {
            XCTAssertNil(LiveActivityOpenTarget(url: try XCTUnwrap(URL(string: url))), url)
        }
        let foreign = try XCTUnwrap(LiveActivityOpenTarget(url: XCTUnwrap(URL(string: base.replacingOccurrences(of: pairing, with: String(repeating: "c", count: 64))))))
        XCTAssertNotEqual(foreign.pairingKey, pairing, "The caller must compare this full endpoint key before navigation")
    }
}
