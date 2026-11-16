import Foundation
import XCTest
@testable import OrbisCore

final class LiveActivityLifecycleTests: XCTestCase {
    private let pairing = String(repeating: "a", count: 64)
    private let otherPairing = String(repeating: "b", count: 64)
    private let focusA = String(repeating: "c", count: 64)
    private let focusB = String(repeating: "d", count: 64)

    // LA-I10: process relaunch must infer a dismissal when the system no longer
    // has a locally recorded activity, including a swipe while the app was killed.
    func testMissingSystemActivitySuppressesCoveredRunsAcrossRelaunch() throws {
        var before = LiveActivityLifecycle()
        let runs = before.runKeys(pairingKey: pairing, runs: [.init(focusKey: focusA, turnId: "turn-a")], complete: true)
        before.noteCreated(pairingKey: pairing, activityId: "activity", runKeys: runs)
        var after = try JSONDecoder().decode(LiveActivityLifecycle.self, from: JSONEncoder().encode(before))
        after.restore(systemActiveIds: [])
        XCTAssertNil(after.created[pairing])
        XCTAssertEqual(after.suppressed[pairing], runs)
        XCTAssertFalse(after.mayStart(pairingKey: pairing, currentRuns: runs, complete: true))
        XCTAssertFalse(after.mayStart(pairingKey: pairing, currentRuns: runs, complete: false))
    }

    // LA-I10: a recovered active/stale activity is retained, not interpreted as
    // dismissed; observing a normal terminal end clears its record explicitly.
    func testSystemActiveAndAppObservedEndDoNotCreateSuppression() {
        var state = LiveActivityLifecycle()
        state.noteCreated(pairingKey: pairing, activityId: "active", runKeys: ["run"])
        state.restore(systemActiveIds: ["active"])
        XCTAssertEqual(state.created[pairing]?.activityId, "active")
        XCTAssertNil(state.suppressed[pairing])
        state.complete(pairingKey: pairing, activityId: "active")
        state.restore(systemActiveIds: [])
        XCTAssertNil(state.created[pairing])
        XCTAssertNil(state.suppressed[pairing])
        XCTAssertTrue(state.mayStart(pairingKey: pairing, currentRuns: ["new-run"], complete: true))
    }

    // LA-I11: focus selection, a new pending request, and a newly started peer
    // task cannot resurrect an aggregate that still includes a dismissed run.
    func testAggregateFocusChangesDoNotUnsuppressRemainingOldRuns() {
        var state = LiveActivityLifecycle()
        state.noteCreated(pairingKey: pairing, activityId: "activity", runKeys: ["old-a", "old-b"])
        state.dismiss(pairingKey: pairing, activityId: "activity")
        XCTAssertFalse(state.mayStart(pairingKey: pairing, currentRuns: ["old-a", "old-b", "new"], complete: true))
        XCTAssertFalse(state.mayStart(pairingKey: pairing, currentRuns: ["old-b", "new"], complete: true))
        XCTAssertEqual(state.suppressed[pairing], ["old-b"])
        XCTAssertFalse(state.mayStart(pairingKey: pairing, currentRuns: ["new"], complete: false))
        XCTAssertTrue(state.mayStart(pairingKey: pairing, currentRuns: ["new"], complete: true))
        XCTAssertNil(state.suppressed[pairing])
    }

    // LA-I12: a turn learned after the first snapshot is still the same running
    // generation. Missing/recovered timestamps never participate in these keys.
    func testFallbackSurvivesTurnIdBackfillAndLaterNewTurnCanStart() {
        var state = LiveActivityLifecycle()
        let initial = state.runKeys(pairingKey: pairing, runs: [.init(focusKey: focusA)], complete: true)
        state.noteCreated(pairingKey: pairing, activityId: "activity", runKeys: initial)
        state.restore(systemActiveIds: [])
        let backfilled = state.runKeys(pairingKey: pairing, runs: [.init(focusKey: focusA, turnId: "turn-a")], complete: true)
        XCTAssertEqual(backfilled, initial)
        XCTAssertFalse(state.mayStart(pairingKey: pairing, currentRuns: backfilled, complete: true))
        let temporarilyMissing = state.runKeys(pairingKey: pairing, runs: [.init(focusKey: focusA)], complete: false)
        XCTAssertEqual(temporarilyMissing, initial)
        let nextTurn = state.runKeys(pairingKey: pairing, runs: [.init(focusKey: focusA, turnId: "turn-b")], complete: true)
        XCTAssertNotEqual(nextTurn, initial)
        XCTAssertTrue(state.mayStart(pairingKey: pairing, currentRuns: nextTurn, complete: true))
    }

    // LA-I12: a partial disappearance cannot retire a fallback identity. Only
    // full idle facts allow a later no-turn-ID run in the same session to restart.
    func testFallbackRetiresOnlyAfterCompleteIdleAndSurvivesPersistence() throws {
        var state = LiveActivityLifecycle()
        let initial = state.runKeys(pairingKey: pairing, runs: [.init(focusKey: focusA)], complete: true)
        state.noteCreated(pairingKey: pairing, activityId: "activity", runKeys: initial)
        state.dismiss(pairingKey: pairing, activityId: "activity")
        _ = state.runKeys(pairingKey: pairing, runs: [], complete: false)
        var after = try JSONDecoder().decode(LiveActivityLifecycle.self, from: JSONEncoder().encode(state))
        let stillActive = after.runKeys(pairingKey: pairing, runs: [.init(focusKey: focusA, turnId: "learned")], complete: true)
        XCTAssertEqual(stillActive, initial)
        XCTAssertFalse(after.mayStart(pairingKey: pairing, currentRuns: stillActive, complete: true))
        let idle = after.runKeys(pairingKey: pairing, runs: [], complete: true)
        XCTAssertFalse(after.mayStart(pairingKey: pairing, currentRuns: idle, complete: true))
        XCTAssertNil(after.suppressed[pairing])
        let next = after.runKeys(pairingKey: pairing, runs: [.init(focusKey: focusA)], complete: true)
        XCTAssertTrue(after.mayStart(pairingKey: pairing, currentRuns: next, complete: true))
    }

    // LA-I13: endpoint identity, not host name/ID, owns dismissal. A re-pairing
    // with the same Host does not inherit the previous pairing's suppression.
    func testPairingIsolationAndLateOldActivityEvents() {
        var state = LiveActivityLifecycle()
        state.noteCreated(pairingKey: pairing, activityId: "old", runKeys: ["old-run"])
        state.dismiss(pairingKey: pairing, activityId: "old")
        XCTAssertTrue(state.mayStart(pairingKey: otherPairing, currentRuns: ["old-run"], complete: true))
        state.noteCreated(pairingKey: otherPairing, activityId: "new", runKeys: ["new-run"])
        state.dismiss(pairingKey: otherPairing, activityId: "old", runKeys: ["old-run"])
        state.complete(pairingKey: otherPairing, activityId: "old")
        XCTAssertEqual(state.created[otherPairing]?.activityId, "new")
        XCTAssertNil(state.suppressed[otherPairing])
        XCTAssertEqual(state.suppressed[pairing], ["old-run"])
        state.forgetPairing(pairing)
        XCTAssertNil(state.suppressed[pairing])
    }

    // LA-I11: persisted coverage follows all running sessions, rather than the
    // first focus chosen at activity creation or only the current foreground task.
    func testCreatedCoverageUpdatesForTheSameActivity() {
        var state = LiveActivityLifecycle()
        state.noteCreated(pairingKey: pairing, activityId: "activity", runKeys: ["a"])
        state.noteCreated(pairingKey: pairing, activityId: "activity", runKeys: ["a", "b"])
        state.restore(systemActiveIds: [])
        XCTAssertEqual(state.suppressed[pairing], ["a", "b"])
        XCTAssertFalse(state.mayStart(pairingKey: pairing, currentRuns: ["b"], complete: true))
        XCTAssertFalse(state.mayStart(pairingKey: pairing, currentRuns: [], complete: false))
        XCTAssertTrue(state.mayStart(pairingKey: pairing, currentRuns: ["c"], complete: true))
    }

    // LA-I12: turn keys are scoped by focus, with unambiguous delimiter handling.
    func testTurnKeysDifferAcrossSessionsAndDelimiterValues() {
        var state = LiveActivityLifecycle()
        let first = state.runKeys(pairingKey: pairing, runs: [.init(focusKey: focusA, turnId: "x:y")], complete: true)
        let other = state.runKeys(pairingKey: pairing, runs: [.init(focusKey: focusB, turnId: "x:y")], complete: true)
        XCTAssertNotEqual(first, other)
        XCTAssertEqual(state.runKeys(pairingKey: pairing, runs: [.init(focusKey: focusB, turnId: "x:y")], complete: true), other)
    }
}
