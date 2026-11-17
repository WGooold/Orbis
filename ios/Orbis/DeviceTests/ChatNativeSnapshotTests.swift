import SwiftUI
import UIKit
import XCTest
@testable import Orbis

/// PERF-14: pause the real metadata worker while the UIKit coordinator receives
/// newer publications, changes owner, or stops. No network fixture is involved.
@MainActor final class ChatNativeSnapshotTests: XCTestCase {
    private func until(_ label: String, _ predicate: () -> Bool) async throws {
        for _ in 0..<250 {
            if predicate() { return }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTFail("Timed out: \(label)")
        throw URLError(.timedOut)
    }

    private func input(_ ids: [String], revision: UInt64, owner: UUID,
                       viewport: ChatViewportController,
                       onDistance: @escaping (CGFloat) -> Void = { _ in },
                       onInteraction: @escaping (Bool) -> Void = { _ in },
                       onViewport: @escaping ([String: CGRect], CGFloat) -> Void = { _, _ in }) -> ChatNativeTranscriptView {
        let snapshot = ChatNativeTranscriptView.Snapshot(items: ids.map {
            .init(id: $0, revision: UUID(), content: AnyView(Text($0).frame(height: 44)))
        }, revision: revision)
        return ChatNativeTranscriptView(snapshot: { snapshot }, viewport: viewport,
            tailID: ids.last ?? "tail", mountToken: owner, requestIsCurrent: { viewport.owns($0) },
            onDistance: onDistance, onInteraction: onInteraction, onViewport: onViewport)
    }

    private func drainResolutionQueue() async {
        for _ in 0..<3 {
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                DispatchQueue.main.async { continuation.resume() }
            }
        }
    }

    private func bottomOffset(_ collection: UICollectionView) -> CGFloat {
        max(-collection.adjustedContentInset.top,
            collection.contentSize.height - collection.bounds.height + collection.adjustedContentInset.bottom)
    }

    private func show(_ collection: UICollectionView) -> UIWindow {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        let root = UIViewController()
        window.rootViewController = root
        root.view.addSubview(collection)
        collection.frame = window.bounds
        collection.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        window.isHidden = false
        root.view.layoutIfNeeded()
        collection.layoutIfNeeded()
        return window
    }

    // PERF-14: opening a long transcript at latest should measure its actual tail
    // window first, rather than build/fit unrelated top rows before jumping down.
    // The probe records native-hosted content fitting, not a predicted/cached height.
    func testInitialLongTranscriptFitsTheTailBeforeUnrelatedTopRows() async throws {
        let viewport = ChatViewportController()
        let ids = (0..<80).map { "message-\($0)" }
        var measuredIDs: [String] = []
        var viewportReports = 0
        var items: [ChatNativeTranscriptView.Item] = ids.map { id in
            .init(id: id, revision: UUID(), content: AnyView(
                NativeInitialRowFittingProbe(id: id) { measuredIDs.append($0) }
            ), kind: .message)
        }
        items.append(.init(id: "tail", revision: UUID(), content: AnyView(Color.clear.frame(height: 4))))
        let snapshot = ChatNativeTranscriptView.Snapshot(items: items, revision: 1)
        let initial = ChatNativeTranscriptView(snapshot: { snapshot }, viewport: viewport,
            tailID: "tail", mountToken: UUID(), requestIsCurrent: { viewport.owns($0) },
            onDistance: { _ in }, onInteraction: { _ in }, onViewport: { _, _ in viewportReports += 1 })
        let coordinator = ChatNativeTranscriptView.Coordinator(initial)
        defer { coordinator.stop() }
        let collection = coordinator.makeCollection()
        let window = show(collection)
        defer { window.isHidden = true }
        try await until("initial long transcript's real tail placement") {
            let bottom = max(-collection.adjustedContentInset.top,
                collection.contentSize.height - collection.bounds.height + collection.adjustedContentInset.bottom)
            return viewportReports > 0 && collection.contentSize.height > collection.bounds.height * 2 &&
                abs(bottom - collection.contentOffset.y) <= 1
        }
        var seen = Set<String>()
        let unique = measuredIDs.filter { seen.insert($0).inserted }
        let diagnostic: [String: Any] = ["sequence": Array(measuredIDs.prefix(120)),
                                         "unique": unique, "total": measuredIDs.count]
        let encoded = try XCTUnwrap(String(data: JSONSerialization.data(withJSONObject: diagnostic, options: [.sortedKeys]),
                                          encoding: .utf8))
        print("FIRST_MOUNT_MEASURED_IDS " + encoded)
        let attachment = XCTAttachment(string: encoded)
        attachment.name = "FIRST_MOUNT_MEASURED_IDS"
        attachment.lifetime = .keepAlways
        add(attachment)
        let first = try XCTUnwrap(measuredIDs.first, "The real hosted content must have been fitted")
        let firstIndex = try XCTUnwrap(ids.firstIndex(of: first))
        XCTAssertGreaterThanOrEqual(firstIndex, 60, "First fitting must be in the tail window: " + encoded)
        XCTAssertFalse(unique.contains("message-0"), "Latest placement must not fit the unrelated first row: " + encoded)
        XCTAssertTrue(collection.visibleCells.compactMap { ($0 as? NativeTranscriptCell)?.representedID }
            .contains("message-79"), "The newest actual message must finish in the viewport")
    }

    // The initial IDs must be installed before makeCollection returns. A stale
    // comparison must never reach UIKit, even briefly before the newest comparison.
    func testPendingComparisonCoalescesSourcesAndRejectsThePreviousOwner() async throws {
        let gate = NativeSnapshotPreparationGate(count: 2)
        defer { gate.releaseAll() }
        let worker = ChatNativeSnapshotWorker(beforeWork: { gate.wait() })
        let owner = UUID(), viewport = ChatViewportController()
        let initial = input(["initial-0", "initial-1"], revision: 1, owner: owner, viewport: viewport)
        let coordinator = ChatNativeTranscriptView.Coordinator(initial, snapshotWorker: worker)
        defer { coordinator.stop() }
        let collection = coordinator.makeCollection()
        XCTAssertEqual(collection.numberOfItems(inSection: 0), 2, "The initial mount must not wait for the worker")
        XCTAssertEqual(gate.enteredCount, 0)
        let window = show(collection)
        defer { window.isHidden = true }
        try await until("initial native cells") { !collection.visibleCells.isEmpty }

        let first = input(["first-0", "first-1", "first-2"], revision: 2, owner: owner, viewport: viewport)
        coordinator.update(first, snapshot: first.snapshot())
        try await until("first comparison blocked") { gate.enteredCount == 1 }
        let superseded = input((0..<4).map { "superseded-\($0)" }, revision: 3, owner: owner, viewport: viewport)
        coordinator.update(superseded, snapshot: superseded.snapshot())
        var latestViewportIDs: [[String]] = []
        let latestIDs = (0..<5).map { "latest-\($0)" }
        let latest = input(latestIDs, revision: 4, owner: UUID(), viewport: ChatViewportController()) { frames, _ in
            latestViewportIDs.append(Array(frames.keys))
        }
        coordinator.update(latest, snapshot: latest.snapshot())

        gate.release(0)
        try await until("latest comparison blocked after discarding the first") { gate.enteredCount == 2 }
        XCTAssertEqual(collection.numberOfItems(inSection: 0), 2, "Discarded plans must not transiently replace the initial IDs")
        XCTAssertTrue(latestViewportIDs.isEmpty, "Old cells must not position or publish metrics for the new owner while preparation is pending")
        gate.release(1)
        try await until("latest IDs installed") { collection.numberOfItems(inSection: 0) == latestIDs.count }
        try await until("latest viewport measured") { !latestViewportIDs.isEmpty }
        XCTAssertTrue(latestViewportIDs.flatMap { $0 }.allSatisfy { latestIDs.contains($0) })
        XCTAssertEqual(gate.enteredCount, 2, "Intermediate publications must coalesce into the newest comparison")
        XCTAssertFalse(gate.timedOut)
        XCTAssertFalse(gate.ranOnMainThread)
    }

    // IOS-CHAT-16: explicit intent replaces a released user's movement rather than
    // waiting for an end-deceleration notification that may never arrive after takeover.
    // These delegate calls create a synthetic interaction lifecycle, not real UIKit
    // deceleration. The target, native layout, worker and policy callbacks remain real.
    func testLatestRequestTakesOverAnUnfinishedSyntheticInteraction() async throws {
        try await assertExplicitRequestTakesOverSyntheticInteraction(target: .latest)
    }

    func testQuestionRequestTakesOverAnUnfinishedSyntheticInteraction() async throws {
        try await assertExplicitRequestTakesOverSyntheticInteraction(target: .question("message-12"))
    }

    private func assertExplicitRequestTakesOverSyntheticInteraction(target: ChatViewportPolicy.Target) async throws {
        let owner = UUID(), viewport = ChatViewportController()
        let ids = (0..<80).map { "message-\($0)" }
        var viewportReports = 0
        var interactions: [Bool] = []
        func publication(_ ids: [String], revision: UInt64) -> ChatNativeTranscriptView {
            input(ids, revision: revision, owner: owner, viewport: viewport,
                onDistance: { viewport.distanceChanged($0) },
                onInteraction: { active in
                    interactions.append(active)
                    viewport.interactionChanged(active)
                }, onViewport: { _, _ in viewportReports += 1 })
        }
        let coordinator = ChatNativeTranscriptView.Coordinator(publication(ids, revision: 1))
        defer { coordinator.stop() }
        let collection = coordinator.makeCollection()
        let window = show(collection)
        defer { window.isHidden = true }
        try await until("synthetic interaction fixture initially positioned") {
            viewportReports > 0 && collection.contentSize.height > collection.bounds.height * 2 &&
                abs(self.bottomOffset(collection) - collection.contentOffset.y) <= 1
        }

        coordinator.scrollViewWillBeginDragging(collection)
        collection.setContentOffset(CGPoint(x: 0, y: bottomOffset(collection) - 800), animated: false)
        coordinator.scrollViewDidEndDragging(collection, willDecelerate: true)
        XCTAssertEqual(interactions, [true])
        XCTAssertEqual(viewport.policy.mode, .interacting)

        switch target {
        case .latest: viewport.update { $0.jumpToLatest() }
        case .question(let id): viewport.update { $0.locateQuestion(id, bottomDistance: viewport.bottomDistance) }
        }
        let request = try XCTUnwrap(viewport.request)
        func targetOffset() -> CGFloat? {
            switch target {
            case .latest: return bottomOffset(collection)
            case .question(let id):
                guard let index = ids.firstIndex(of: id),
                      let attributes = collection.collectionViewLayout.layoutAttributesForItem(
                        at: IndexPath(item: index, section: 0)) else { return nil }
                return max(-collection.adjustedContentInset.top,
                    min(bottomOffset(collection), attributes.frame.minY - collection.adjustedContentInset.top))
            }
        }
        // No scrollViewDidEndDecelerating is delivered before this assertion. The
        // old implementation cannot reach either target with userInteracting retained.
        try await until("explicit target reached before synthetic deceleration ends") {
            guard let expected = targetOffset() else { return false }
            return interactions == [true, false] && !coordinator.animatingOffset &&
                abs(expected - collection.contentOffset.y) <= 1
        }
        XCTAssertTrue(viewport.owns(request), "Ending the replaced interaction must preserve the accepted request")
        switch target {
        case .latest: XCTAssertTrue(viewport.following)
        case .question: XCTAssertFalse(viewport.following)
        }

        coordinator.scrollViewDidEndDecelerating(collection)
        await drainResolutionQueue()
        XCTAssertEqual(interactions, [true, false], "A late native end callback must not finish the same interaction twice")
        XCTAssertTrue(viewport.owns(request))

        let preservedOffset = collection.contentOffset.y
        let nextIDs = ids + ["appended-0", "appended-1", "appended-2"]
        let next = publication(nextIDs, revision: 2)
        coordinator.update(next, snapshot: next.snapshot())
        try await until("new publication preserves the explicit target's policy") {
            guard collection.numberOfItems(inSection: 0) == nextIDs.count,
                  !coordinator.animatingOffset else { return false }
            switch target {
            case .latest: return abs(self.bottomOffset(collection) - collection.contentOffset.y) <= 1
            case .question: return abs(preservedOffset - collection.contentOffset.y) <= 1
            }
        }
        XCTAssertEqual(interactions, [true, false])

        coordinator.scrollViewWillBeginDragging(collection)
        XCTAssertNil(viewport.request, "A subsequent user gesture must cancel the old explicit request")
        XCTAssertFalse(viewport.owns(request))
        XCTAssertFalse(coordinator.animatingOffset)
        collection.setContentOffset(CGPoint(x: 0, y: bottomOffset(collection) - 400), animated: false)
        coordinator.scrollViewDidEndDragging(collection, willDecelerate: false)
        try await until("subsequent synthetic gesture finishes in reading mode") {
            interactions == [true, false, true, false] && viewport.policy.mode == .reading
        }
        XCTAssertFalse(viewport.following)
    }

    // PERF-14: metadata preparation may defer layout, but must not defer a newer
    // explicit scroll intent's cancellation of the previous UIKit animator.
    func testLatestRequestInterruptsQuestionAnimationWhilePreparationIsBlocked() async throws {
        let gate = NativeSnapshotPreparationGate(count: 1)
        defer { gate.releaseAll() }
        let worker = ChatNativeSnapshotWorker(beforeWork: { gate.wait() })
        let owner = UUID(), viewport = ChatViewportController()
        let ids = (0..<80).map { "message-\($0)" }
        var viewportReports = 0
        let initial = input(ids, revision: 1, owner: owner, viewport: viewport) { _, _ in
            viewportReports += 1
        }
        let coordinator = ChatNativeTranscriptView.Coordinator(initial, snapshotWorker: worker)
        defer { coordinator.stop() }
        let collection = coordinator.makeCollection()
        let window = show(collection)
        defer { window.isHidden = true }
        func bottomDistance() -> CGFloat {
            let bottom = max(-collection.adjustedContentInset.top,
                collection.contentSize.height - collection.bounds.height + collection.adjustedContentInset.bottom)
            return bottom - collection.contentOffset.y
        }
        try await until("long transcript initially positioned at latest") {
            viewportReports > 0 && collection.contentSize.height > collection.bounds.height * 2 &&
                abs(bottomDistance()) <= 1
        }
        viewport.update { $0.locateQuestion(ids[0], bottomDistance: bottomDistance()) }
        try await until("question native animator running") { coordinator.animatingOffset }

        let newestIDs = ids + ["new-message-0", "new-message-1"]
        let next = input(newestIDs, revision: 2, owner: owner, viewport: viewport)
        coordinator.update(next, snapshot: next.snapshot())
        try await until("metadata preparation blocked during question animation") { gate.enteredCount == 1 }
        XCTAssertTrue(coordinator.animatingOffset, "The new request must preempt an animation that is still running")
        viewport.update { $0.jumpToLatest() }
        // Drain the observer/update/resolution queue rather than waiting for the
        // old animation's natural end, which could otherwise make this test pass.
        await drainResolutionQueue()
        XCTAssertFalse(coordinator.animatingOffset, "A pending comparison must not retain the superseded question animator")
        XCTAssertEqual(gate.enteredCount, 1)
        XCTAssertFalse(gate.timedOut)
        XCTAssertEqual(collection.numberOfItems(inSection: 0), ids.count, "The comparison must still be pending when cancellation is observed")

        gate.release(0)
        try await until("new snapshot installed and latest reached") {
            collection.numberOfItems(inSection: 0) == newestIDs.count &&
                !coordinator.animatingOffset && abs(bottomDistance()) <= 1
        }
        XCTAssertTrue(viewport.following)
        XCTAssertFalse(gate.timedOut)
        XCTAssertFalse(gate.ranOnMainThread)
    }

    // Retiring the coordinator cancels its result consumer. Releasing the already
    // running worker afterwards must not reconnect a data source or install its IDs.
    func testStoppedCoordinatorDoesNotCommitThePendingResult() async throws {
        let gate = NativeSnapshotPreparationGate(count: 1)
        defer { gate.releaseAll() }
        let worker = ChatNativeSnapshotWorker(beforeWork: { gate.wait() })
        let owner = UUID(), viewport = ChatViewportController()
        let initial = input(["initial-0", "initial-1"], revision: 1, owner: owner, viewport: viewport)
        let coordinator = ChatNativeTranscriptView.Coordinator(initial, snapshotWorker: worker)
        defer { coordinator.stop() }
        let collection = coordinator.makeCollection()
        let next = input((0..<3).map { "retired-\($0)" }, revision: 2, owner: owner, viewport: viewport)
        coordinator.update(next, snapshot: next.snapshot())
        try await until("retired comparison blocked") { gate.enteredCount == 1 }
        coordinator.stop()
        let stoppedItemCount = collection.numberOfItems(inSection: 0)
        gate.release(0)
        // The second actor call is a barrier behind the already running comparison.
        // Its gate index has no semaphore, so it never blocks.
        _ = await worker.prepare(previous: [], next: [], reconfigureRetained: false)
        for _ in 0..<10 { await Task.yield() }
        XCTAssertNil(collection.dataSource)
        XCTAssertEqual(collection.numberOfItems(inSection: 0), stoppedItemCount)
        XCTAssertNotEqual(collection.numberOfItems(inSection: 0), 3)
        XCTAssertFalse(gate.timedOut)
        XCTAssertFalse(gate.ranOnMainThread)
    }
}

/// A native row's fitting callback gives the first-mount test observable evidence
/// without adding product instrumentation or substituting collection cell heights.
private struct NativeInitialRowFittingProbe: UIViewRepresentable {
    let id: String
    let onFit: (String) -> Void

    func makeUIView(context: Context) -> UIView { UIView() }
    func updateUIView(_ uiView: UIView, context: Context) {}

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UIView, context: Context) -> CGSize? {
        if let width = proposal.width, width.isFinite, width > 0 {
            onFit(id)
        }
        return CGSize(width: proposal.width ?? 1, height: 44)
    }
}

/// Every background wait has a deadline; the test actor only polls asynchronously.
private final class NativeSnapshotPreparationGate: @unchecked Sendable {
    private let lock = NSLock()
    private let semaphores: [DispatchSemaphore]
    private var entered = 0
    private var didTimeOut = false
    private var didRunOnMainThread = false

    init(count: Int) { semaphores = (0..<count).map { _ in DispatchSemaphore(value: 0) } }

    var enteredCount: Int { locked { entered } }
    var timedOut: Bool { locked { didTimeOut } }
    var ranOnMainThread: Bool { locked { didRunOnMainThread } }

    func wait() {
        let index = locked {
            didRunOnMainThread = didRunOnMainThread || Thread.isMainThread
            let index = entered
            entered += 1
            return index
        }
        guard semaphores.indices.contains(index) else { return }
        if semaphores[index].wait(timeout: .now() + 10) == .timedOut {
            locked { didTimeOut = true }
        }
    }

    func release(_ index: Int) { semaphores[index].signal() }
    func releaseAll() { semaphores.forEach { $0.signal() } }

    private func locked<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }
}
