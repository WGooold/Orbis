// PERF-14: native list metadata preparation must leave the UI actor available,
// and distinguish retained content changes from insertions, removals and moves.
import Foundation
import Testing
@testable import OrbisCore

struct ChatNativeSnapshotWorkerTests {
    @Test @MainActor func preparationLeavesMainActorAvailable() async {
        let uiAvailable = DispatchSemaphore(value: 0)
        let worker = ChatNativeSnapshotWorker(beforeWork: {
            #expect(!Thread.isMainThread)
            Task { @MainActor in uiAvailable.signal() }
            #expect(uiAvailable.wait(timeout: .now() + 3) == .success)
        })
        let row = ChatNativeSnapshotRow(id: "answer", revision: UUID())
        let plan = await worker.prepare(previous: [row], next: [row], reconfigureRetained: false)
        #expect(plan.ids == ["answer"])
        #expect(plan.reconfigured.isEmpty)
    }

    // A mixed update may reorder changed rows, retain an untouched row, delete an
    // old row and insert a different ID with the same version as the deleted row.
    @Test func onlyChangedRetainedRowsReconfigureInTheirNewOrder() async {
        let first = ChatNativeSnapshotRow(id: "first", revision: UUID())
        let stable = ChatNativeSnapshotRow(id: "stable", revision: UUID())
        let removed = ChatNativeSnapshotRow(id: "removed", revision: UUID())
        let last = ChatNativeSnapshotRow(id: "last", revision: UUID())
        let plan = await ChatNativeSnapshotWorker().prepare(
            previous: [first, stable, removed, last],
            next: [ChatNativeSnapshotRow(id: "last", revision: UUID()),
                   ChatNativeSnapshotRow(id: "inserted", revision: removed.revision),
                   ChatNativeSnapshotRow(id: "first", revision: UUID()), stable],
            reconfigureRetained: false)
        #expect(plan.ids == ["last", "inserted", "first", "stable"])
        #expect(plan.reconfigured == ["last", "first"])
    }

    // Switching owners refreshes all shared IDs even when their versions match;
    // an insertion must still avoid diffable's retained-item reconfiguration list.
    @Test func ownerChangeReconfiguresEveryRetainedRowButNoInsertion() async {
        let first = ChatNativeSnapshotRow(id: "first", revision: UUID())
        let last = ChatNativeSnapshotRow(id: "last", revision: UUID())
        let plan = await ChatNativeSnapshotWorker().prepare(
            previous: [first, ChatNativeSnapshotRow(id: "removed", revision: UUID()), last],
            next: [last, ChatNativeSnapshotRow(id: "inserted", revision: UUID()), first],
            reconfigureRetained: true)
        #expect(plan.ids == ["last", "inserted", "first"])
        #expect(plan.reconfigured == ["last", "first"])
    }

    // Initial loading and clearing have no shared cells to reconfigure, including
    // an owner transition to an empty conversation.
    @Test func emptyBaselinesAndClearingNeverReconfigureMissingRows() async {
        let worker = ChatNativeSnapshotWorker()
        let row = ChatNativeSnapshotRow(id: "answer", revision: UUID())
        let initial = await worker.prepare(previous: [], next: [row], reconfigureRetained: true)
        #expect(initial.ids == ["answer"])
        #expect(initial.reconfigured.isEmpty)
        let cleared = await worker.prepare(previous: [row], next: [], reconfigureRetained: true)
        #expect(cleared.ids.isEmpty)
        #expect(cleared.reconfigured.isEmpty)
    }
}
