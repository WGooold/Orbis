import Foundation
import CoreGraphics
import Testing
@testable import OrbisCore

struct VisualActivityGeometryTests {
    // IOS-CHAT-05: retained hidden views can render the current value once, but
    // their paused periodic schedule must not keep generating future ticks.
    @Test func pausedPeriodicEntriesEmitOneCurrentDateAndThenStop() {
        let now = Date(timeIntervalSinceReferenceDate: 1_000)
        var entries = OrbisPeriodicEntries(start: now, interval: 1, paused: true).makeIterator()
        let first = entries.next(), second = entries.next(), third = entries.next()
        #expect(first == now)
        #expect(second == nil && third == nil)
    }

    // The adapter passes the present absolute date on resume. New entries start
    // there, without enumerating the time spent covered or in the background.
    @Test func resumedPeriodicEntriesStartAtTheNewAbsoluteTime() {
        let before = Date(timeIntervalSinceReferenceDate: 100)
        let resumed = before.addingTimeInterval(3_600)
        let entries = Array(OrbisPeriodicEntries(start: resumed, interval: 1, paused: false).prefix(3))
        #expect(entries == [resumed, resumed.addingTimeInterval(1), resumed.addingTimeInterval(2)])
        for interval in [TimeInterval(0), -1, .infinity, .nan] {
            let dates = Array(OrbisPeriodicEntries(start: resumed, interval: interval, paused: false).prefix(2))
            #expect(dates == [resumed, resumed.addingTimeInterval(1)])
        }
    }

    // Flight launch, frame rendezvous and animation completions all retain a
    // generation. Re-showing the page cannot revive callbacks captured before hide.
    @Test func hiddenAndReshownWorkCannotRegainAnOlderGeneration() {
        var gate = OrbisVisualWorkGate()
        let first = gate.generation
        #expect(gate.permits(first))
        gate.setActive(true)
        #expect(gate.generation == first)
        gate.setActive(false)
        let hidden = gate.generation
        #expect(!gate.permits(first) && !gate.permits(hidden))
        gate.setActive(false)
        #expect(gate.generation == hidden)
        gate.setActive(true)
        let resumed = gate.generation
        #expect(!gate.permits(first) && !gate.permits(hidden))
        #expect(gate.permits(resumed))
        gate.invalidate()
        #expect(gate.active && !gate.permits(resumed) && gate.permits(gate.generation))
    }

    // A reply resumes from the newest measured content. Its catch-up is a snap;
    // subsequent visible live appends retain the existing continuous-growth policy.
    @Test func replyCatchUpSnapsToLatestThenAllowsNewVisibleGrowth() {
        var growth = ReplyCardGrowth()
        let parts = [ReplyCardPart(id: "reply", text: "already published while hidden")]
        let caughtUp = growth.update(size: CGSize(width: 300, height: 400), parts: parts,
                                     live: true, reduced: true, entering: false)
        #expect(!caughtUp)
        let unchanged = growth.update(size: CGSize(width: 300, height: 400), parts: parts,
                                      live: true, reduced: false, entering: false)
        #expect(!unchanged)
        let appended = growth.update(size: CGSize(width: 300, height: 420),
            parts: [ReplyCardPart(id: "reply", text: parts[0].text + " and a new visible token")],
            live: true, reduced: false, entering: false)
        #expect(appended)
    }
}
