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
                       onReadingRow: @escaping (String?) -> Void = { _ in }) -> ChatNativeTranscriptView {
        let snapshot = ChatNativeTranscriptView.Snapshot(items: ids.map {
            .init(id: $0, revision: UUID(), content: AnyView(Text($0).frame(height: 44)))
        }, revision: revision)
        return ChatNativeTranscriptView(snapshot: { snapshot }, viewport: viewport,
            tailID: ids.last ?? "tail", mountToken: owner, requestIsCurrent: { viewport.owns($0) },
            onDistance: onDistance, onInteraction: onInteraction, onReadingRow: onReadingRow)
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

    private func show(_ collection: UICollectionView, size: CGSize = CGSize(width: 390, height: 844)) -> UIWindow {
        let window = UIWindow(frame: CGRect(origin: .zero, size: size))
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
            onDistance: { _ in }, onInteraction: { _ in }, onReadingRow: { _ in viewportReports += 1 })
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

    // IOS-CHAT-17: a shared system sidebar can renegotiate the viewport after a
    // page mounts. UIKit's proposed offset preserves the old top, which exposes
    // a wrong frame before the queued bottom correction. Exercise the real layout
    // at narrow, unfolded and reading-pane sizes, without yielding after a resize.
    func testNativeRelayoutTargetsLatestBeforeDeferredResolution() async throws {
        for size in [CGSize(width: 390, height: 700), CGSize(width: 669, height: 840),
                     CGSize(width: 669, height: 408)] {
            let viewport = ChatViewportController()
            var reports = 0
            var items: [ChatNativeTranscriptView.Item] = (0..<40).map { index in
                .init(id: "message-\(index)", revision: UUID(), content: AnyView(
                    Text(String(repeating: "Message \(index) wraps as the shared sidebar changes the viewport. ",
                                count: index % 4 + 1))
                        .frame(maxWidth: .infinity, alignment: .leading)
                ))
            }
            items.append(.init(id: "tail", revision: UUID(), content: AnyView(Color.clear.frame(height: 4)), kind: .auxiliary))
            let snapshot = ChatNativeTranscriptView.Snapshot(items: items, revision: 1)
            let input = ChatNativeTranscriptView(snapshot: { snapshot }, viewport: viewport,
                tailID: "tail", mountToken: UUID(), requestIsCurrent: { viewport.owns($0) },
                onDistance: { viewport.distanceChanged($0) },
                onInteraction: { viewport.interactionChanged($0) }, onReadingRow: { _ in reports += 1 })
            let coordinator = ChatNativeTranscriptView.Coordinator(input)
            defer { coordinator.stop() }
            let collection = coordinator.makeCollection()
            let window = show(collection, size: size)
            defer { window.isHidden = true }
            collection.autoresizingMask = []
            try await until("initial sidebar fixture measured") {
                reports > 0 && abs(self.bottomOffset(collection) - collection.contentOffset.y) <= 1
            }

            for nextSize in [CGSize(width: size.width - 72, height: size.height - 24), size] {
                collection.frame.size = nextSize
                collection.setNeedsLayout()
                collection.layoutIfNeeded()
                let proposed = CGPoint(x: 0, y: max(0, bottomOffset(collection) - 180))
                let layout = collection.collectionViewLayout
                let target = layout.targetContentOffset(forProposedContentOffset: proposed)
                let expected = max(-collection.adjustedContentInset.top,
                    layout.collectionViewContentSize.height - collection.bounds.height + collection.adjustedContentInset.bottom)
                XCTAssertEqual(target.y, expected, accuracy: 1,
                    "Latest must be the native layout target before the main queue runs: \(size) -> \(nextSize)")
                XCTAssertEqual(collection.contentOffset.y, bottomOffset(collection), accuracy: 1,
                    "A synchronous resize must not expose a frame away from latest")
            }

            // A pending question request has not yet reached the coordinator's
            // async observer. It already owns positioning and must defeat follow.
            viewport.update { $0.locateQuestion("message-12", bottomDistance: 300) }
            let proposed = CGPoint(x: 0, y: bottomOffset(collection) - 180)
            let target = collection.collectionViewLayout.targetContentOffset(forProposedContentOffset: proposed)
            XCTAssertLessThan(target.y, bottomOffset(collection) - 1,
                "Native layout must not override an explicit request waiting on the main queue")
        }
    }

    // IOS-CHAT-18 negative control: restore the old UIKit default in this fixture
    // only. The same allocated viewport must then lose width to the safe area,
    // proving that the regression fixture reaches the original inset mechanism.
    func testLegacySafeAreaReferenceReproducesMessageWidthChange() async throws {
        let viewport = ChatViewportController()
        let initial = input((0..<30).map { "message-\($0)" }, revision: 1,
                            owner: UUID(), viewport: viewport)
        let coordinator = ChatNativeTranscriptView.Coordinator(initial)
        defer { coordinator.stop() }
        let collection = coordinator.makeCollection()
        let layout = try XCTUnwrap(collection.collectionViewLayout as? UICollectionViewCompositionalLayout)
        let configuration = layout.configuration
        configuration.contentInsetsReference = .safeArea
        layout.configuration = configuration
        let window = show(collection)
        defer { window.isHidden = true }
        let root = try XCTUnwrap(window.rootViewController)
        let path = IndexPath(item: 29, section: 0)
        try await until("legacy safe area fixture initially measured") {
            collection.cellForItem(at: path) != nil &&
                abs(self.bottomOffset(collection) - collection.contentOffset.y) <= 1
        }
        let before = try XCTUnwrap(collection.layoutAttributesForItem(at: path)).frame.width
        let allocatedWidth = collection.bounds.width
        root.additionalSafeAreaInsets.left = 72
        root.view.setNeedsLayout()
        root.view.layoutIfNeeded()
        collection.layoutIfNeeded()
        try await until("legacy layout deducted system bar safe area") {
            (collection.layoutAttributesForItem(at: path)?.frame.width ?? before) < before - 1
        }
        let after = try XCTUnwrap(collection.layoutAttributesForItem(at: path)).frame.width
        XCTAssertEqual(collection.bounds.width, allocatedWidth)
        XCTAssertEqual(collection.adjustedContentInset, .zero)
        XCTAssertEqual(before - after, 72, accuracy: 0.5)
        let attachment = XCTAttachment(string: "allocated=\(allocatedWidth), before=\(before), after=\(after), safeArea=\(collection.safeAreaInsets), adjusted=\(collection.adjustedContentInset)")
        attachment.name = "LEGACY_SYSTEM_BAR_SAFE_AREA"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    // IOS-CHAT-18: replay a system bar's changing safe area while the SwiftUI
    // viewport keeps its allocated size. Disabling adjustedContentInset alone
    // leaves compositional layout shrinking/reflowing cells on every such update.
    // Sample native row frames after each transition; do not wait for stability
    // before asserting or a later correction would hide the original defect.
    func testChangingSystemBarSafeAreaKeepsMessageWidthHeightAndPosition() async throws {
        for size in [CGSize(width: 390, height: 700), CGSize(width: 669, height: 840),
                     CGSize(width: 669, height: 408)] {
            let viewport = ChatViewportController()
            let text = String(repeating: "A completed message must keep its line wrapping while the page slides past the system sidebar. ", count: 5)
            var items: [ChatNativeTranscriptView.Item] = (0..<30).map { index in
                .init(id: "message-\(index)", revision: UUID(), content: AnyView(
                    Text(text).font(.system(size: 15)).frame(maxWidth: .infinity, alignment: .leading)
                ))
            }
            items.append(.init(id: "tail", revision: UUID(), content: AnyView(Color.clear.frame(height: 4)), kind: .auxiliary))
            let snapshot = ChatNativeTranscriptView.Snapshot(items: items, revision: 1)
            var reports = 0
            let input = ChatNativeTranscriptView(snapshot: { snapshot }, viewport: viewport,
                tailID: "tail", mountToken: UUID(), requestIsCurrent: { viewport.owns($0) },
                onDistance: { viewport.distanceChanged($0) }, onInteraction: { viewport.interactionChanged($0) },
                onReadingRow: { _ in reports += 1 })
            let coordinator = ChatNativeTranscriptView.Coordinator(input)
            defer { coordinator.stop() }
            let collection = coordinator.makeCollection()
            let window = show(collection, size: size)
            defer { window.isHidden = true }
            let root = try XCTUnwrap(window.rootViewController)
            let path = IndexPath(item: 29, section: 0)
            try await until("safe area fixture initially measured") {
                reports > 0 && abs(self.bottomOffset(collection) - collection.contentOffset.y) <= 1 &&
                    collection.cellForItem(at: path) != nil
            }
            let baseline = try XCTUnwrap(collection.layoutAttributesForItem(at: path)).frame
            let baselineTop = baseline.minY - collection.contentOffset.y
            let baselineBounds = collection.bounds.size
            var samples: [[String: CGFloat]] = []
            defer {
                let data = try? JSONSerialization.data(withJSONObject: samples, options: [.sortedKeys])
                let attachment = XCTAttachment(data: data ?? Data(), uniformTypeIdentifier: "public.json")
                attachment.name = "SYSTEM_BAR_SAFE_AREA_\(Int(size.width))x\(Int(size.height))"
                attachment.lifetime = .keepAlways
                add(attachment)
            }
            for insets in [UIEdgeInsets(top: 0, left: 72, bottom: 0, right: 0),
                           UIEdgeInsets(top: 0, left: 36, bottom: 0, right: 0),
                           .zero, UIEdgeInsets(top: 0, left: 0, bottom: 0, right: 72), .zero] {
                root.additionalSafeAreaInsets = insets
                root.view.setNeedsLayout()
                root.view.layoutIfNeeded()
                collection.setNeedsLayout()
                collection.layoutIfNeeded()
                if insets.left > 0 { XCTAssertGreaterThanOrEqual(collection.safeAreaInsets.left, insets.left) }
                if insets.right > 0 { XCTAssertGreaterThanOrEqual(collection.safeAreaInsets.right, insets.right) }
                for _ in 0..<3 {
                    let frame = try XCTUnwrap(collection.layoutAttributesForItem(at: path)).frame
                    let top = frame.minY - collection.contentOffset.y
                    let cell = try XCTUnwrap(collection.cellForItem(at: path))
                    samples.append(["width": frame.width, "height": frame.height, "top": top,
                                    "left": collection.safeAreaInsets.left, "right": collection.safeAreaInsets.right,
                                    "cellSafeLeft": cell.safeAreaInsets.left, "cellSafeRight": cell.safeAreaInsets.right,
                                    "contentWidth": cell.contentView.bounds.width,
                                    "contentMarginLeft": cell.contentView.layoutMargins.left,
                                    "hostingWidth": cell.contentView.subviews.first?.bounds.width ?? -1])
                    XCTAssertEqual(collection.bounds.size, baselineBounds)
                    XCTAssertEqual(collection.adjustedContentInset, .zero)
                    XCTAssertEqual(frame.width, baseline.width, accuracy: 0.5, "System bar must not deduct the safe area twice")
                    XCTAssertEqual(frame.height, baseline.height, accuracy: 0.5, "A completed message must not rewrap during entry")
                    XCTAssertEqual(top, baselineTop, accuracy: 1, "The same message must stay at the same viewport Y")
                    try await Task.sleep(nanoseconds: 16_000_000)
                }
            }
        }
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
        // Each viewport report names the reading row it measured (none is an empty report).
        let latest = input(latestIDs, revision: 4, owner: UUID(), viewport: ChatViewportController()) { row in
            latestViewportIDs.append(row.map { [$0] } ?? [])
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

    // This fixture covers absolute targets; relative page intents have separate
    // fold-reading coverage and cannot supply its fixed destination oracle.
    private enum AbsoluteTarget { case latest, question(String) }

    private func assertExplicitRequestTakesOverSyntheticInteraction(target: AbsoluteTarget) async throws {
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
                }, onReadingRow: { _ in viewportReports += 1 })
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
        let initial = input(ids, revision: 1, owner: owner, viewport: viewport) { _ in
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

    // Hosted disclosures drive their own frame-by-frame clip height. Collection
    // self-sizing layout must apply each change without starting a UIKit bounds/center
    // animation that lags behind SwiftUI and shifts the cell content upward.
    func testHostedDisclosureResizesCellWithoutSelfSizingAnimation() async throws {
        let state = ChatTranscriptInteractionState.Disclosure()
        let disclosureProbe = HostedDisclosureHeightProbe()
        let viewport = ChatViewportController()
        let snapshot = ChatNativeTranscriptView.Snapshot(items: [
            .init(id: "above", revision: UUID(), content: AnyView(Text("Above").frame(height: 60)), kind: .message),
            .init(id: "tool", revision: UUID(), content: AnyView(HostedDisclosureCellFixture(state: state, probe: disclosureProbe)), kind: .message),
            .init(id: "tail", revision: UUID(), content: AnyView(Color.clear.frame(height: 4)))
        ], revision: 1)
        let view = ChatNativeTranscriptView(snapshot: { snapshot }, viewport: viewport,
            tailID: "tail", mountToken: UUID(), requestIsCurrent: { viewport.owns($0) },
            onDistance: { _ in }, onInteraction: { _ in }, onReadingRow: { _ in })
        let coordinator = ChatNativeTranscriptView.Coordinator(view)
        defer { coordinator.stop() }
        let collection = coordinator.makeCollection()
        let window = show(collection)
        defer { window.isHidden = true }

        func toolCell() -> NativeTranscriptCell? {
            collection.visibleCells.compactMap { $0 as? NativeTranscriptCell }.first { $0.representedID == "tool" }
        }
        try await until("initial hosted disclosure cell measured") {
            guard let cell = toolCell() else { return false }
            return cell.hasMeasured(id: "tool", height: cell.frame.height) && cell.frame.height > 30 && cell.frame.height < 80
        }
        let initialCell = try XCTUnwrap(toolCell())
        let initialFrame = initialCell.frame

        print("HOSTED_DISCLOSURE_ENV reduceMotion=\(UIAccessibility.isReduceMotionEnabled) animationsEnabled=\(UIView.areAnimationsEnabled)")

        state.expanded = true
        var observedHeights: [(time: TimeInterval, height: CGFloat)] = []
        let deadline = Date().addingTimeInterval(1.0)
        while Date() < deadline {
            CATransaction.flush()
            let cell = try XCTUnwrap(toolCell())
            XCTAssertTrue((cell.layer.animationKeys() ?? []).isEmpty,
                          "Cell must not attach implicit self-sizing animations: \(cell.layer.animationKeys() ?? [])")
            XCTAssertTrue((cell.contentView.layer.animationKeys() ?? []).isEmpty,
                          "Cell contentView must not attach implicit self-sizing animations")
            let windowLayer = window.layer.presentation() ?? window.layer
            let cellRect = (cell.layer.presentation() ?? cell.layer).convert(cell.bounds, to: windowLayer)
            let expectedRect = collection.convert(cell.frame, to: window)
            XCTAssertEqual(cellRect.minY, expectedRect.minY, accuracy: 1)
            XCTAssertEqual(cellRect.height, expectedRect.height, accuracy: 1)
            if let hosting = cell.contentView.subviews.first(where: { $0.bounds.width > 1 && $0.bounds.height > 1 }) {
                XCTAssertTrue((hosting.layer.animationKeys() ?? []).isEmpty,
                              "Hosted root view must not inherit UIKit self-sizing animations")
                let hostingRect = (hosting.layer.presentation() ?? hosting.layer).convert(hosting.bounds, to: windowLayer)
                XCTAssertEqual(hostingRect.minY, expectedRect.minY, accuracy: 1)
            }
            observedHeights.append((ProcessInfo.processInfo.systemUptime, cell.frame.height))
            if cell.frame.height > 250 && observedHeights.suffix(4).allSatisfy({ abs($0.height - cell.frame.height) <= 0.5 }) {
                break
            }
            try await Task.sleep(nanoseconds: 16_000_000)
        }
        let finalCell = try XCTUnwrap(toolCell())
        let attachment = XCTAttachment(string: "reduceMotion=\(UIAccessibility.isReduceMotionEnabled); initial=\(initialFrame.height); final=\(finalCell.frame.height); cell=\(observedHeights); disclosure=\(disclosureProbe.samples)")
        attachment.name = "HOSTED_DISCLOSURE_HEIGHTS"
        attachment.lifetime = .keepAlways
        add(attachment)
        XCTAssertEqual(finalCell.frame.minY, initialFrame.minY, accuracy: 1)
        XCTAssertGreaterThan(finalCell.frame.height, 250)
        XCTAssertGreaterThan(observedHeights.filter { $0.height > initialFrame.height + 5 && $0.height < finalCell.frame.height - 5 }.count, 1)
    }
}

@MainActor
private final class HostedDisclosureHeightProbe {
    var samples: [(time: TimeInterval, height: CGFloat)] = []
    func record(_ height: CGFloat) { samples.append((ProcessInfo.processInfo.systemUptime, height)) }
}

private struct HostedDisclosureCellFixture: View {
    let state: ChatTranscriptInteractionState.Disclosure
    let probe: HostedDisclosureHeightProbe
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Tool header").frame(height: 44)
            OrbisCollapse(expanded: state.expanded) {
                Text((1...16).map { "Line \($0)" }.joined(separator: "\n"))
                    .frame(maxWidth: .infinity, alignment: .leading)
            }.onGeometryChange(for: CGFloat.self) { $0.size.height } action: { probe.record($0) }
        }
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
