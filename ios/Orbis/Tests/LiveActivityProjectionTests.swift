import Foundation
import XCTest
@testable import OrbisCore

final class LiveActivityProjectionTests: XCTestCase {
    private func fact(_ session: String = "session", kind: String = "codex", phase: String = "running",
                      pending: Int = 0, startedAt: Int64? = 1_000, backgroundAgents: Bool = false) -> LiveActivityRuntimeFact {
        LiveActivityRuntimeFact(sessionId: session, agentKind: kind, phase: phase, pendingCount: pending,
            startedAt: startedAt, backgroundAgents: backgroundAgents, title: "Private title")
    }

    // LIVE-ACTIVITY-02: the released Relay fallback can seed a live state
    // only. Unknown, disconnected and idle inputs cannot write stale or end.
    func testLegacySeedNeverMakesAnEndOrStaleState() {
        for (facts, complete) in [([fact()], false), ([fact(phase: "unknown")], true),
                                  ([fact(phase: "idle")], true), ([], true)] {
            XCTAssertNil(LiveActivityProjection.seed(hostId: "host", facts: facts, complete: complete, now: 5_000))
        }
    }

    // LIVE-ACTIVITY-02: Kimi/Pi, Hermes/OpenCode and Claude/Hermes are the
    // original confirmed mixed-session reproductions. Unsupported phases and
    // pending counts from an excluded Agent must not block or skew the seed.
    func testUnsupportedAgentsCannotWinFocusOrContributeToCounts() throws {
        for (excluded, supported) in [("kimiCode", "pi"), ("hermes", "opencode"), ("hermes", "claude"), ("openclaw", "pi")] {
            let focus = LiveActivityProjection.focusKey(hostId: "host", agentKind: supported, sessionId: "supported")
            for phase in ["running", "waiting_local_interaction", "unknown"] {
                let active = try XCTUnwrap(LiveActivityProjection.seed(hostId: "host", facts: [
                    fact("excluded", kind: excluded, phase: phase, pending: phase == "waiting_local_interaction" ? 2 : 0),
                    fact("supported", kind: supported)
                ], complete: true, now: 5_000))
                XCTAssertTrue(active.isValid)
                XCTAssertEqual(active.phase, "running")
                XCTAssertEqual(active.runningCount, 1)
                XCTAssertEqual(active.agentKind, supported)
                XCTAssertEqual(active.focusKey, focus)
            }
            XCTAssertNil(LiveActivityProjection.seed(hostId: "host", facts: [fact(kind: excluded)], complete: true, now: 5_000))
        }
    }

    // Waiting sessions are not counted twice; requests and sessions are
    // separate counts even when all requests belong to one focus.
    func testPendingFocusHasPriorityAndWaitingDoesNotCountAsRunning() throws {
        let facts = [fact("running", startedAt: 500),
                     fact("waiting", phase: "waiting_local_interaction", pending: 2),
                     fact("pending-running", pending: 1, startedAt: 2_000)]
        let value = try XCTUnwrap(LiveActivityProjection.seed(hostId: "host", facts: facts, complete: true, now: 5_000))
        XCTAssertEqual(value.phase, "attention")
        XCTAssertEqual(value.runningCount, 1)
        XCTAssertEqual(value.pendingCount, 3)
        XCTAssertEqual(value.sessionCount, 3)
        XCTAssertEqual(value.focusKey, LiveActivityProjection.focusKey(hostId: "host", agentKind: "codex", sessionId: "pending-running"))
        let phaseOnly = try XCTUnwrap(LiveActivityProjection.seed(hostId: "host", facts: [fact(phase: "waiting_local_interaction")], complete: true, now: 5_000))
        XCTAssertEqual(phaseOnly.pendingCount, 1)
        XCTAssertEqual(phaseOnly.runningCount, 0)
    }

    func testFutureHostClockKeepsRunningWithoutInventingStartTime() throws {
        let state = try XCTUnwrap(LiveActivityProjection.seed(hostId: "host", facts: [fact(startedAt: 20_000)],
            complete: true, now: 10_000))
        XCTAssertTrue(state.isValid)
        XCTAssertEqual(state.phase, "running")
        XCTAssertNil(state.startedAt)
    }

    func testBackgroundAgentWorkKeepsActivityButCommandOnlyDoesNot() throws {
        let withAgent = try XCTUnwrap(LiveActivityProjection.seed(hostId: "host",
            facts: [fact(kind: "claude", phase: "idle", backgroundAgents: true)], complete: true, now: 5_000))
        XCTAssertEqual(withAgent.phase, "running")
        XCTAssertEqual(withAgent.runningCount, 1)
        XCTAssertNil(LiveActivityProjection.seed(hostId: "host",
            facts: [fact(kind: "claude", phase: "idle", backgroundAgents: false)], complete: true, now: 6_000))
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

    // The legacy seed is independent of incoming directory order.
    func testLegacySeedFocusDoesNotRotateWithDirectoryOrder() throws {
        let facts = [fact("b", startedAt: 1_000), fact("a", startedAt: 1_000), fact("c", startedAt: nil)]
        let initial = try XCTUnwrap(LiveActivityProjection.seed(hostId: "host", facts: facts, complete: true, now: 5_000))
        let later = try XCTUnwrap(LiveActivityProjection.seed(hostId: "host", facts: Array(facts.reversed()), complete: true, now: 7_000))
        XCTAssertEqual(initial.focusKey, LiveActivityProjection.focusKey(hostId: "host", agentKind: "codex", sessionId: "a"))
        XCTAssertEqual(later.focusKey, initial.focusKey)
    }

    // Checked against the Relay's Node digest fixture, and changing the
    // device or credential invalidates old push-start navigation.
    func testRemotePairingReferenceMatchesRelayAndCannotMixLinkFormats() throws {
        func reference(_ device: String, _ credential: String) -> String {
            OrbisLiveActivityAttributes.remotePairingRef(hostId: "host", deviceId: device, credential: credential)
        }
        let ref = reference("phone", "phone-secret")
        XCTAssertEqual(ref, "7938e25e8e6d1181e60968a0172e5dff1415163664f4d96c8826a084c84788a6")
        XCTAssertNotEqual(reference("another", "phone-secret"), ref)
        XCTAssertNotEqual(reference("phone", "another-secret"), ref)
        let attrs = OrbisLiveActivityAttributes(hostId: "host", pairingRef: ref)
        let url = try XCTUnwrap(attrs.url(focusKey: nil))
        XCTAssertEqual(LiveActivityOpenTarget(url: url)?.pairingRef, ref)
        XCTAssertNil(LiveActivityOpenTarget(url: try XCTUnwrap(URL(string: url.absoluteString + "&pairingKey=" + ref))))
        XCTAssertNil(LiveActivityOpenTarget(url: try XCTUnwrap(URL(string: url.absoluteString + "&focusKey"))))
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

final class LiveActivityOpenQueueTests: XCTestCase {
    private func target(host: String = "host", focus: Bool = true) throws -> LiveActivityOpenTarget {
        let query = "hostId=\(host)&pairingKey=\(String(repeating: "a", count: 64))" +
            (focus ? "&focusKey=\(String(repeating: "b", count: 64))" : "")
        return try XCTUnwrap(LiveActivityOpenTarget(url: XCTUnwrap(URL(string: "orbis://activity?" + query))))
    }

    // LA-I09: an unrelated unconfirmed background inventory cannot block a
    // positively identified runtime, but a stale route map cannot select it.
    func testCurrentMatchingRouteDoesNotRequireUnrelatedInventoryCompletion() throws {
        var queue = LiveActivityOpenQueue()
        let generation = queue.enqueue(try target(), now: 10)
        XCTAssertNil(queue.resolve(generation: generation, now: 10.1, routeIsCurrent: false,
            complete: true, runtimeId: "runtime"))
        XCTAssertEqual(queue.resolve(generation: generation, now: 10.2, routeIsCurrent: true,
            complete: false, runtimeId: "runtime"), .runtime("runtime"))
        XCTAssertNil(queue.target)
    }

    // LA-I09: continuous updates or an incomplete inventory get a bounded
    // wait, then one home fallback; later reconciliation cannot reopen a chat.
    func testIncompleteRoutesFallBackOnceAtDeadline() throws {
        var queue = LiveActivityOpenQueue()
        let generation = queue.enqueue(try target(), now: 10)
        XCTAssertNil(queue.resolve(generation: generation, now: 11.99, routeIsCurrent: false,
            complete: false, runtimeId: nil))
        XCTAssertEqual(queue.resolve(generation: generation, now: 12, routeIsCurrent: false,
            complete: false, runtimeId: nil), .home)
        XCTAssertNil(queue.resolve(generation: generation, now: 13, routeIsCurrent: true,
            complete: true, runtimeId: "runtime"))
    }

    // LA-I09: backgrounding and user navigation consume the intent before any
    // delayed timer or route publication can redirect the current page.
    func testCancelledOpenCannotRouteAfterReconciliationOrTimeout() throws {
        var queue = LiveActivityOpenQueue()
        let generation = queue.enqueue(try target(), now: 10)
        queue.cancel()
        XCTAssertNil(queue.resolve(generation: generation, now: 11, routeIsCurrent: true,
            complete: true, runtimeId: "runtime"))
        XCTAssertNil(queue.resolve(generation: generation, now: 12, routeIsCurrent: false,
            complete: false, runtimeId: nil))
    }

    // LA-I09: a second tap owns a fresh deadline; the first timer cannot fall
    // back the replacement even when both links point to the same Host.
    func testReplacementIgnoresOldTimerAndGetsItsOwnDeadline() throws {
        var queue = LiveActivityOpenQueue()
        let first = queue.enqueue(try target(), now: 10)
        let second = queue.enqueue(try target(), now: 11)
        XCTAssertNil(queue.resolve(generation: first, now: 12, routeIsCurrent: false,
            complete: false, runtimeId: nil))
        XCTAssertNil(queue.resolve(generation: second, now: 12, routeIsCurrent: false,
            complete: false, runtimeId: nil))
        XCTAssertEqual(queue.resolve(generation: second, now: 13, routeIsCurrent: false,
            complete: false, runtimeId: nil), .home)
    }

    // LA-I09: an authoritative missing focus and a link without focus retain
    // immediate host-home behavior rather than waiting for the timer.
    func testCompleteMissingFocusAndHostLinksReturnHomeImmediately() throws {
        var queue = LiveActivityOpenQueue()
        let missing = queue.enqueue(try target(), now: 10)
        XCTAssertEqual(queue.resolve(generation: missing, now: 10, routeIsCurrent: true,
            complete: true, runtimeId: nil), .home)
        let host = queue.enqueue(try target(focus: false), now: 20)
        XCTAssertEqual(queue.resolve(generation: host, now: 20, routeIsCurrent: false,
            complete: false, runtimeId: nil), .home)
    }
}
