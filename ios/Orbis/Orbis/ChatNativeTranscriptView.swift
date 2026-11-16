import SwiftUI
import UIKit

/// A cell-owned coordinate channel for explicit UIView readers in hosted row content.
/// Registration uses weak views, and every delivered rectangle belongs to that view's window.
@MainActor
final class ChatNativeCellGeometry {
    private final class Registration {
        weak var view: UIView?
        var onFrame: (CGRect?) -> Void
        var lastFrame: CGRect?
        var hasReported = false

        init(view: UIView, onFrame: @escaping (CGRect?) -> Void) {
            self.view = view
            self.onFrame = onFrame
        }
    }

    private var registrations: [UUID: Registration] = [:]
    private var generation: UInt64 = 0
    private var scheduled = false
    private var contentSize: CGSize?
    fileprivate var onContentSizeChange: (() -> Void)?

    func register(id: UUID, view: UIView, onFrame: @escaping (CGRect?) -> Void) {
        if let registration = registrations[id], registration.view === view {
            registration.onFrame = onFrame
        } else {
            registrations[id] = Registration(view: view, onFrame: onFrame)
        }
        refresh()
    }

    func unregister(id: UUID) {
        guard let registration = registrations.removeValue(forKey: id) else { return }
        DispatchQueue.main.async { [weak self] in
            guard self?.registrations[id] == nil else { return }
            registration.onFrame(nil)
        }
    }

    /// Collection scrolling and layout call this without changing SwiftUI observation
    /// during updateUIView or inside native layout.
    func refresh() {
        guard !scheduled else { return }
        scheduled = true
        let owner = generation
        DispatchQueue.main.async { [weak self] in
            guard let self, self.generation == owner else { return }
            self.scheduled = false
            for registration in self.registrations.values {
                let frame: CGRect?
                if let view = registration.view, view.window != nil,
                   view.bounds.width > 0, view.bounds.height > 0 {
                    let converted = view.convert(view.bounds, to: nil)
                    frame = converted.isNull || converted.isInfinite ? nil : converted
                } else {
                    frame = nil
                }
                if !registration.hasReported || registration.lastFrame != frame {
                    registration.hasReported = true
                    registration.lastFrame = frame
                    registration.onFrame(frame)
                }
            }
        }
    }

    fileprivate func contentSizeChanged(_ size: CGSize) {
        guard size.width.isFinite, size.height.isFinite, size != contentSize else { return }
        contentSize = size
        // Sizing must not wait behind the independent window-coordinate callbacks.
        // Invalidate only: UIKit/coordinator perform the next layout outside this
        // SwiftUI geometry callback, without recursively laying out the hosting root.
        onContentSizeChange?()
        refresh()
    }

    #if DEBUG
    // Diagnostic only: the hosted-disclosure fixture has one full bubble reader.
    // This largest-reader sample never participates in product layout or offsets.
    var currentLargestReaderFrame: CGRect? {
        registrations.values.compactMap { registration -> CGRect? in
            guard let view = registration.view, view.window != nil,
                  view.bounds.width > 0, view.bounds.height > 0 else { return nil }
            return view.convert(view.bounds, to: nil)
        }.max { $0.height < $1.height }
    }
    #endif

    fileprivate func reset() {
        generation &+= 1
        scheduled = false
        contentSize = nil
        let previous = registrations
        registrations = [:]
        DispatchQueue.main.async { [weak self] in
            for (id, registration) in previous where self?.registrations[id] == nil {
                registration.onFrame(nil)
            }
        }
    }
}

private struct ChatNativeCellGeometryKey: EnvironmentKey {
    static let defaultValue: ChatNativeCellGeometry? = nil
}

extension EnvironmentValues {
    var chatNativeCellGeometry: ChatNativeCellGeometry? {
        get { self[ChatNativeCellGeometryKey.self] }
        set { self[ChatNativeCellGeometryKey.self] = newValue }
    }
}

/// The IOS-CHAT-13 native transcript owns offsets while rendering the supplied, real rows.
/// Diffable identity and SwiftUI identity both follow the row, never its render revision.
@MainActor
struct ChatNativeTranscriptView: UIViewRepresentable {
    struct Item {
        enum Kind { case message, auxiliary }

        let id: String
        let revision: UUID
        let content: AnyView
        var kind: Kind

        init(id: String, revision: UUID, content: AnyView, kind: Kind = .message) {
            self.id = id
            self.revision = revision
            self.content = content
            self.kind = kind
        }
    }

    struct Snapshot { let items: [Item]; let revision: UInt64 }
    /// Prepared by the native lifecycle, outside SwiftUI body evaluation.
    var snapshot: () -> Snapshot
    /// Establish viewport ownership before the initial snapshot and subscription.
    var prepareMount: () -> Void = {}
    var viewport: ChatViewportController
    var tailID: String
    var mountToken: UUID
    var requestIsCurrent: (ChatViewportPolicy.Request) -> Bool
    var onDistance: (CGFloat) -> Void
    var onInteraction: (Bool) -> Void
    var onViewport: ([String: CGRect], CGFloat) -> Void
    var onDirection: (Bool) -> Void = { _ in }
    var horizontalInset: CGFloat = 16
    var topInset: CGFloat = 4
    var spacing: CGFloat = 16
    var estimatedRowHeight: CGFloat = 120
    var reduceMotion = false

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> UICollectionView {
        context.coordinator.makeCollection()
    }

    func updateUIView(_ uiView: UICollectionView, context: Context) {
        context.coordinator.update(self, snapshot: snapshot())
    }

    static func dismantleUIView(_ uiView: UICollectionView, coordinator: Coordinator) {
        coordinator.stop()
    }

    @MainActor
    final class Coordinator: NSObject, UICollectionViewDelegate {
        private struct Ownership: Equatable {
            let mountToken: UUID
            let contextGeneration: Int
        }

        private struct Anchor {
            let id: String
            var top: CGFloat
            let height: CGFloat
            let interaction: UInt64
            var panY: CGFloat
            var offsetY: CGFloat
        }

        private struct Alignment {
            let request: ChatViewportPolicy.Request
            var attemptedAnimation = false
        }

        private var input: ChatNativeTranscriptView
        private var ownership: Ownership
        private weak var collection: NativeTranscriptCollection?
        private var dataSource: UICollectionViewDiffableDataSource<Int, String>?
        private var desired: [Item] = []
        private var rendered: [String: Item] = [:]
        private var appliedRows: [ChatNativeSnapshotRow] = []
        private let snapshotWorker: ChatNativeSnapshotWorker
        private var snapshotPreparation: Task<Void, Never>?
        private var sourceGeneration: UInt64 = 0
        private var receivedItemsRevision: UInt64?
        private var appliedGeneration: UInt64?
        private var appliedOwnershipGeneration: UInt64?
        private var ownershipGeneration: UInt64 = 0
        private var interactionGeneration: UInt64 = 0
        private var applyingSnapshot = false
        private var snapshotMutationDepth = 0
        private var scheduled = false
        private var resolving = false
        private var nativeLayoutDepth = 0
        private var compensatingLayout = false
        private var stopped = false
        private var placement = ChatNativeViewportPlacement()
        private var initialPositionSeeded = false
        private var userInteracting = false
        private var pendingInteractionEnd = false
        private var previousPanY: CGFloat = 0
        private var pendingDirection: Bool?
        private var anchors: [Anchor] = []
        private var alignment: Alignment?
        private var handledRequest: ChatViewportPolicy.Request?
        private(set) var animatingOffset = false
        private var lastDistance: CGFloat?
        private var lastViewport: [String: CGRect]?
        private var lastViewportHeight: CGFloat?
        private weak var observedViewport: ChatViewportController?
        private var viewportObserver: UUID?
        private var viewportUpdateScheduled = false

        init(_ input: ChatNativeTranscriptView, snapshotWorker: ChatNativeSnapshotWorker = .init()) {
            self.input = input
            self.snapshotWorker = snapshotWorker
            ownership = Ownership(mountToken: input.mountToken,
                                  contextGeneration: input.viewport.nativeState.contextGeneration)
            super.init()
        }

        func makeCollection() -> UICollectionView {
            input.prepareMount()
            let view = NativeTranscriptCollection(frame: .zero, collectionViewLayout: makeLayout())
            view.backgroundColor = .clear
            view.alwaysBounceVertical = true
            view.keyboardDismissMode = .interactive
            view.contentInsetAdjustmentBehavior = .never
            view.selfSizingInvalidation = .enabledIncludingConstraints
            view.accessibilityIdentifier = "chat-transcript-native"
            view.delegate = self
            view.register(NativeTranscriptCell.self, forCellWithReuseIdentifier: "row")
            view.prepareInitialPlacement = { [weak self] in self?.seedInitialPosition() }
            view.willLayout = { [weak self] in self?.nativeLayoutWillBegin() }
            view.didLayout = { [weak self] in self?.nativeLayoutDidEnd() }
            collection = view
            observeViewport(input.viewport)
            ChatDebugProbes.bindNativeTranscript(view, animationIsRunning: { [weak self] in
                self?.animatingOffset == true && self?.stopped == false
            })
            dataSource = UICollectionViewDiffableDataSource<Int, String>(collectionView: view) {
                [weak self] collection, indexPath, id in
                guard let self, let item = self.rendered[id],
                      let cell = collection.dequeueReusableCell(withReuseIdentifier: "row",
                                                               for: indexPath) as? NativeTranscriptCell
                else { return nil }
                cell.represent(id: id, revision: item.revision, owner: self.ownershipGeneration)
                cell.willMeasure = { [weak self] in self?.captureReadingAnchorBeforeSizing() }
                cell.didMeasure = { [weak self] in self?.scheduleResolution() }
                cell.backgroundColor = .clear
                cell.backgroundConfiguration = UIBackgroundConfiguration.clear()
                let geometry = cell.geometry
                cell.contentConfiguration = UIHostingConfiguration {
                    item.content.id(item.id)
                        .fixedSize(horizontal: false, vertical: true)
                        .onGeometryChange(for: CGSize.self) { $0.size } action: { [weak geometry] size in
                            geometry?.contentSizeChanged(size)
                        }
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                        .environment(\.chatNativeCellGeometry, geometry)
                }.margins(.all, 0)
                return cell
            }
            update(input, snapshot: input.snapshot())
            return view
        }

        private func makeLayout() -> UICollectionViewLayout {
            let size = NSCollectionLayoutSize(widthDimension: .fractionalWidth(1),
                                              heightDimension: .estimated(max(1, input.estimatedRowHeight)))
            let item = NSCollectionLayoutItem(layoutSize: size)
            let group = NSCollectionLayoutGroup.vertical(layoutSize: size, subitems: [item])
            let section = NSCollectionLayoutSection(group: group)
            section.interGroupSpacing = input.spacing
            section.contentInsets = NSDirectionalEdgeInsets(top: input.topInset,
                leading: input.horizontalInset, bottom: 0, trailing: input.horizontalInset)
            let layout = NativeTranscriptLayout(section: section)
            layout.readingTarget = { [weak self] proposed, layout in
                self?.readingTarget(proposed, layout: layout) ?? proposed
            }
            return layout
        }

        /// UIKit asks before it replaces the visible range during a snapshot. Giving
        /// the retained row its target here preserves the actual hosting cell; fixing
        /// the offset after layout would first recycle it for a newly prepended row.
        private func readingTarget(_ proposed: CGPoint, layout: UICollectionViewLayout) -> CGPoint {
            guard initialPlacementReady, alignment == nil, !animatingOffset,
                  !following || nativeMotionActive, let collection, let dataSource else { return proposed }
            for anchor in anchors where anchor.interaction == interactionGeneration {
                guard anchor.top < collection.bounds.height, anchor.top + anchor.height > 0,
                      let path = dataSource.indexPath(for: anchor.id),
                      let attributes = layout.layoutAttributesForItem(at: path) else { continue }
                return CGPoint(x: proposed.x, y: max(minimumOffset, attributes.frame.minY - anchor.top))
            }
            return proposed
        }

        func update(_ value: ChatNativeTranscriptView, snapshot: Snapshot? = nil) {
            guard !stopped else { return }
            let nextOwnership = Ownership(mountToken: value.mountToken,
                                          contextGeneration: value.viewport.nativeState.contextGeneration)
            let ownerChanged = nextOwnership != ownership
            let sourceChanged = ownerChanged || snapshot.map { receivedItemsRevision != $0.revision } == true
            let layoutChanged = input.horizontalInset != value.horizontalInset ||
                input.topInset != value.topInset || input.spacing != value.spacing ||
                input.estimatedRowHeight != value.estimatedRowHeight
            if !ownerChanged, initialPlacementReady, !following || nativeMotionActive {
                captureAnchorsIfNeeded()
            }
            input = value
            if observedViewport !== value.viewport { observeViewport(value.viewport) }
            if ownerChanged {
                if let collection {
                    // Cancel the old owner's native animator even when its current
                    // offset already equals the new owner's first requested offset.
                    writeOffset(collection.contentOffset.y, animated: false, force: true)
                    for case let cell as NativeTranscriptCell in collection.visibleCells {
                        cell.geometry.reset()
                    }
                }
                ownership = nextOwnership
                ownershipGeneration &+= 1
                interactionGeneration &+= 1
                placement = ChatNativeViewportPlacement()
                initialPositionSeeded = false
                anchors = []
                alignment = nil
                handledRequest = nil
                pendingInteractionEnd = false
                userInteracting = false
                animatingOffset = false
                lastDistance = nil
                lastViewport = nil
                lastViewportHeight = nil
            }
            if following { anchors = [] }
            if !ownerChanged, initialPlacementReady, !following || nativeMotionActive {
                captureAnchorsIfNeeded()
            }

            if sourceChanged {
                let proposed = snapshot?.items ?? desired
                let next = chatUniqueItems(proposed, id: \.id)
                if next.count != proposed.count {
                    assertionFailure("Native transcript requires unique row IDs")
                }
                desired = next
                if let snapshot { receivedItemsRevision = snapshot.revision }
                sourceGeneration &+= 1
                applyDesiredSnapshot()
            }
            if layoutChanged { collection?.setCollectionViewLayout(makeLayout(), animated: false) }
            scheduleResolution()
        }

        private func observeViewport(_ viewport: ChatViewportController) {
            if let viewportObserver { observedViewport?.removeNativeStateObserver(viewportObserver) }
            observedViewport = viewport
            viewportObserver = viewport.observeNativeState { [weak self] in
                guard let self, !self.stopped, !self.viewportUpdateScheduled else { return }
                self.viewportUpdateScheduled = true
                DispatchQueue.main.async { [weak self] in
                    guard let self, !self.stopped else { return }
                    self.viewportUpdateScheduled = false
                    self.update(self.input)
                }
            }
        }

        private var following: Bool { input.viewport.nativeState.following }
        private var initialPlacementReady: Bool { placement.isReady }

        private var nativeMotionActive: Bool {
            userInteracting || collection?.isTracking == true || collection?.isDragging == true ||
                collection?.isDecelerating == true
        }

        private func applyDesiredSnapshot() {
            guard !stopped, !applyingSnapshot, snapshotPreparation == nil, dataSource != nil,
                  appliedGeneration != sourceGeneration else { return }
            let generation = sourceGeneration
            let owner = ownershipGeneration
            let baseline = appliedGeneration
            let next = desired
            let rows = next.map { ChatNativeSnapshotRow(id: $0.id, revision: $0.revision) }
            // PERF-14: the first mount has no old rows to compare. Install its IDs
            // immediately so the page's appearance cannot start a slide over empty content.
            guard baseline != nil else {
                commitSnapshot(.init(ids: rows.map(\.id), reconfigured: []), items: next,
                               rows: rows, generation: generation, owner: owner)
                return
            }
            let previous = appliedRows
            let reconfigureRetained = appliedOwnershipGeneration != owner
            let worker = snapshotWorker
            // Only immutable ID/revision metadata crosses the actor boundary. UIKit,
            // hosted content and reading anchors stay with this coordinator.
            snapshotPreparation = Task { [weak self] in
                let plan = await worker.prepare(previous: previous, next: rows,
                                                reconfigureRetained: reconfigureRetained)
                guard let self, !self.stopped, !Task.isCancelled else { return }
                self.snapshotPreparation = nil
                guard generation == self.sourceGeneration, owner == self.ownershipGeneration,
                      baseline == self.appliedGeneration else {
                    // Publications arriving during preparation coalesce to the latest
                    // source. A previous session's plan never reaches the collection.
                    self.applyDesiredSnapshot()
                    return
                }
                self.commitSnapshot(plan, items: next, rows: rows, generation: generation, owner: owner)
            }
        }

        private func commitSnapshot(_ plan: ChatNativeSnapshotPlan, items next: [Item],
                                    rows: [ChatNativeSnapshotRow], generation: UInt64, owner: UInt64) {
            guard !stopped, let dataSource else { return }
            // A user may have scrolled while the worker compared revisions. Capture
            // the current reading position immediately before the actual UI mutation.
            if initialPlacementReady, !following || nativeMotionActive {
                captureAnchorsIfNeeded()
            }
            // Keep the old snapshot's cell provider unchanged while metadata is
            // preparing. New content becomes visible in the actual UI transaction.
            for item in next { rendered[item.id] = item }
            ChatDebugProbes.nativeReconfigured(count: plan.reconfigured.count)
            var snapshot = NSDiffableDataSourceSnapshot<Int, String>()
            snapshot.appendSections([0])
            snapshot.appendItems(plan.ids, toSection: 0)
            snapshot.reconfigureItems(plan.reconfigured)
            ChatDebugProbes.nativeSnapshotApplied()
            applyingSnapshot = true
            snapshotMutationDepth += 1
            UIView.performWithoutAnimation {
                dataSource.apply(snapshot, animatingDifferences: false) { [weak self] in
                    guard let self, !self.stopped else { return }
                    self.applyingSnapshot = false
                    self.appliedRows = rows
                    self.appliedGeneration = generation
                    self.appliedOwnershipGeneration = owner
                    if owner == self.ownershipGeneration, generation == self.sourceGeneration {
                        self.rendered = Dictionary(uniqueKeysWithValues: self.desired.map { ($0.id, $0) })
                        self.scheduleResolution()
                    }
                    self.applyDesiredSnapshot()
                }
                // Complete the snapshot's native layout before this transaction can
                // be displayed when a reader anchor or an explicit scroll target is
                // active. A following, idle transcript has no retained anchor to
                // protect; its scheduled resolution can perform the same layout after
                // UIKit has committed the snapshot, avoiding a duplicate hosted-cell
                // fitting pass on long chats.
                if !canDeferSnapshotLayout {
                    collection?.layoutIfNeeded()
                }
            }
            snapshotMutationDepth -= 1
        }

        private var canDeferSnapshotLayout: Bool {
            following && alignment == nil && !nativeMotionActive && anchors.isEmpty
        }

        private func scheduleResolution() {
            guard !stopped, !scheduled, !resolving else { return }
            scheduled = true
            let owner = ownershipGeneration, source = sourceGeneration
            DispatchQueue.main.async { [weak self] in
                guard let self, !self.stopped else { return }
                self.scheduled = false
                guard owner == self.ownershipGeneration, source == self.sourceGeneration else {
                    self.scheduleResolution()
                    return
                }
                self.resolveLayout()
            }
        }

        private func nativeLayoutWillBegin() {
            if nativeLayoutDepth == 0, let collection {
                advanceAnchorsForUserMotion(collection)
            }
            nativeLayoutDepth += 1
            guard nativeLayoutDepth == 1, !resolving, !compensatingLayout,
                  initialPlacementReady, alignment == nil, !animatingOffset,
                  !following || nativeMotionActive else { return }
            // Capture cell frames before UICollectionView places them at newly measured
            // origins. A fresh baseline is taken for each layout, rather than retaining
            // the screen Y from the beginning of the user's gesture.
            captureAnchorsIfNeeded()
        }

        /// PERF-14: seed the initial visible range before UICollectionView creates
        /// hosting cells. The layout supplies its own estimated content size; final
        /// positioning still requires real visible measurements in resolveLayout.
        private func seedInitialPosition() {
            guard !stopped, !initialPositionSeeded, !initialPlacementReady,
                  alignment == nil, !animatingOffset, !nativeMotionActive,
                  input.viewport.nativeState.request == nil, snapshotPreparation == nil,
                  appliedGeneration == sourceGeneration, appliedOwnershipGeneration == ownershipGeneration,
                  let collection, collection.bounds.width > 0, collection.bounds.height > 0 else { return }
            initialPositionSeeded = true
            let layout = collection.collectionViewLayout
            layout.prepare()
            let height = layout.collectionViewContentSize.height
            guard height.isFinite, height > 0 else {
                initialPositionSeeded = false
                return
            }
            let bottom = max(-collection.adjustedContentInset.top,
                height - collection.bounds.height + collection.adjustedContentInset.bottom)
            // Do not force layout here: the surrounding native layout will create
            // and measure the chosen window once this callback returns.
            collection.setContentOffset(CGPoint(x: collection.contentOffset.x, y: bottom), animated: false)
        }

        private func captureReadingAnchorBeforeSizing() {
            guard !stopped, initialPlacementReady, alignment == nil, !animatingOffset,
                  !following || nativeMotionActive else { return }
            captureAnchorsIfNeeded()
        }

        private func nativeLayoutDidEnd() {
            nativeLayoutDepth = max(0, nativeLayoutDepth - 1)
            if nativeLayoutDepth == 0, let collection {
                for index in anchors.indices {
                    // Offsets changed within this synchronous layout are native size
                    // reconciliation, rather than a new pan/deceleration sample.
                    anchors[index].offsetY = collection.contentOffset.y
                }
            }
            // Finish native-only reading compensation in this layout transaction.
            // Metrics still publish asynchronously, outside SwiftUI/UIKit layout.
            if nativeLayoutDepth == 0, !resolving, !compensatingLayout,
               initialPlacementReady, alignment == nil, !animatingOffset, !following || nativeMotionActive {
                resolving = true
                _ = restoreAnchor()
                resolving = false
            }
            refreshCellGeometry()
            scheduleResolution()
        }

        private func refreshCellGeometry() {
            for case let cell as NativeTranscriptCell in collection?.visibleCells ?? [] {
                cell.geometry.refresh()
            }
        }

        private func resolveLayout() {
            // New user intent cancels the old animator immediately, including while
            // a worker is preparing content. Resolving the new target still waits
            // until the current snapshot has been applied and measured.
            if !nativeMotionActive { reconcileAlignmentIntent() }
            guard !applyingSnapshot, snapshotPreparation == nil, appliedGeneration == sourceGeneration,
                  let collection, collection.bounds.height > 0,
                  collection.bounds.width > 0 else { return }
            resolving = true
            collection.layoutIfNeeded()
            var wroteOffset = false
            if !nativeMotionActive {
                if !animatingOffset {
                    if alignment != nil {
                        wroteOffset = resolveAlignment()
                    } else if !initialPlacementReady || following {
                        wroteOffset = writeOffset(bottomOffset, animated: false)
                    } else {
                        wroteOffset = restoreAnchor()
                    }
                }
            } else {
                wroteOffset = restoreAnchor()
            }
            collection.layoutIfNeeded()
            let measuredVisibleContent = hasMeasuredVisibleContent
            placement.measured(visibleContent: measuredVisibleContent,
                bottomDistance: bottomOffset - collection.contentOffset.y)
            if placement.isReady && measuredVisibleContent { emitMetrics() }
            if pendingInteractionEnd {
                pendingInteractionEnd = false
                input.onInteraction(false)
            }
            resolving = false
            let needsBottomCorrection = !nativeMotionActive && !animatingOffset && alignment == nil &&
                (!initialPlacementReady || following) &&
                abs(collection.contentOffset.y - bottomOffset) > 0.5
            if wroteOffset || needsBottomCorrection { scheduleResolution() }
        }

        private func reconcileAlignmentIntent() {
            if let request = input.viewport.nativeState.request, request != handledRequest,
               request.contextGeneration == input.viewport.nativeState.contextGeneration,
               input.requestIsCurrent(request) {
                if animatingOffset, let collection {
                    writeOffset(collection.contentOffset.y, animated: false, force: true)
                    animatingOffset = false
                }
                handledRequest = request
                alignment = Alignment(request: request)
                anchors = []
            }
            if let active = alignment,
               !input.requestIsCurrent(active.request) ||
                active.request.contextGeneration != input.viewport.nativeState.contextGeneration {
                if animatingOffset, let collection {
                    writeOffset(collection.contentOffset.y, animated: false, force: true)
                }
                alignment = nil
                animatingOffset = false
            }
        }

        private func resolveAlignment() -> Bool {
            guard let collection, var active = alignment else { return false }
            let target: CGFloat
            let targetID: String
            switch active.request.target {
            case .latest:
                targetID = input.tailID
                target = bottomOffset
            case .question(let id):
                targetID = id
                guard rendered[id] != nil else {
                    alignment = nil
                    return false
                }
                guard let path = dataSource?.indexPath(for: id),
                      let attributes = collection.layoutAttributesForItem(at: path) else { return false }
                target = attributes.frame.minY - collection.adjustedContentInset.top
            }
            let animate = !input.reduceMotion && initialPlacementReady && !active.attemptedAnimation
            active.attemptedAnimation = true
            alignment = active
            let wrote = writeOffset(target, animated: animate)
            if animate, wrote {
                animatingOffset = true
                #if DEBUG
                if PreviewChatScrollProbe.enabled, case .question = active.request.target {
                    PreviewChatScrollProbe.shared.nativeQuestionAnimationStarted?(active.request)
                }
                #endif
            } else if isMeasured(targetID), abs(collection.contentOffset.y - clamped(target)) <= 1 {
                alignment = nil
                if !following { captureAnchorsIfNeeded() }
            }
            return wrote
        }

        private var minimumOffset: CGFloat { -(collection?.adjustedContentInset.top ?? 0) }

        private var bottomOffset: CGFloat {
            guard let collection else { return 0 }
            return max(minimumOffset, collection.contentSize.height - collection.bounds.height +
                       collection.adjustedContentInset.bottom)
        }

        private func clamped(_ y: CGFloat) -> CGFloat { min(bottomOffset, max(minimumOffset, y)) }

        /// After the first-layout seed, explicit application offset writes pass this method.
        /// Native gesture and self-sizing adjustments remain UIKit's responsibility.
        @discardableResult
        private func writeOffset(_ y: CGFloat, animated: Bool, force: Bool = false,
                                 preservingInteraction: Bool = false) -> Bool {
            guard let collection, y.isFinite else { return false }
            let offset = preservingInteraction ? y : clamped(y)
            guard force || abs(collection.contentOffset.y - offset) > 0.5 else { return false }
            if preservingInteraction {
                // Let the native layout apply only a geometry delta. A nonanimated
                // setContentOffset here would cancel an in-flight deceleration.
                let layout = collection.collectionViewLayout
                let context = layout.invalidationContext(forBoundsChange: collection.bounds)
                var adjustment = context.contentOffsetAdjustment
                adjustment.y += offset - collection.contentOffset.y
                context.contentOffsetAdjustment = adjustment
                compensatingLayout = true
                layout.invalidateLayout(with: context)
                collection.layoutIfNeeded()
                compensatingLayout = false
            } else {
                if animated {
                    collection.setContentOffset(CGPoint(x: collection.contentOffset.x, y: offset), animated: true)
                } else {
                    UIView.performWithoutAnimation {
                        collection.setContentOffset(CGPoint(x: collection.contentOffset.x, y: offset), animated: false)
                        collection.layoutIfNeeded()
                    }
                }
            }
            return true
        }

        private func visibleRows() -> [(String, CGRect, Bool)] {
            guard let collection, let dataSource else { return [] }
            return collection.indexPathsForVisibleItems.compactMap { path in
                guard let id = dataSource.itemIdentifier(for: path),
                      let cell = collection.cellForItem(at: path) as? NativeTranscriptCell,
                      cell.frame.intersects(collection.bounds) else { return nil }
                return (id, cell.frame, cell.hasMeasured(id: id, height: cell.frame.height))
            }.sorted { $0.1.minY < $1.1.minY }
        }

        private var hasMeasuredVisibleContent: Bool {
            let rows = visibleRows()
            let hasMessages = desired.contains { $0.kind == .message }
            return rows.contains { id, _, measured in
                measured && (!hasMessages || rendered[id]?.kind == .message)
            }
        }

        private func isMeasured(_ id: String) -> Bool {
            guard let collection, let path = dataSource?.indexPath(for: id),
                  let cell = collection.cellForItem(at: path) as? NativeTranscriptCell else { return false }
            return cell.hasMeasured(id: id, height: cell.frame.height)
        }

        private func captureAnchorsIfNeeded() {
            guard anchors.isEmpty, let collection else { return }
            anchors = visibleRows().compactMap { id, frame, measured in
                guard measured, rendered[id]?.kind == .message, id != input.tailID else { return nil }
                return Anchor(id: id, top: frame.minY - collection.bounds.minY, height: frame.height,
                    interaction: interactionGeneration,
                    panY: collection.panGestureRecognizer.translation(in: collection).y,
                    offsetY: collection.contentOffset.y)
            }.sorted { ChatViewportAnchorPriority.precedes($0.top, $1.top) }
        }

        private func restoreAnchor() -> Bool {
            guard let collection, let dataSource else { return false }
            for anchor in anchors where anchor.interaction == interactionGeneration {
                // The gesture can move the original first row out of the viewport
                // while a snapshot is pending. Use its next still-visible candidate.
                guard anchor.top < collection.bounds.height, anchor.top + anchor.height > 0 else { continue }
                guard let path = dataSource.indexPath(for: anchor.id) else { continue }
                guard let attributes = collection.layoutAttributesForItem(at: path) else { continue }
                if !isMeasured(anchor.id) {
                    // A source insertion may itself place the expected visible row
                    // offscreen. Bring that ID back through native layout, then wait
                    // for its genuine fitting result before committing the anchor.
                    guard collection.cellForItem(at: path) == nil else { return false }
                    return writeOffset(attributes.frame.minY - anchor.top, animated: false,
                                       preservingInteraction: nativeMotionActive)
                }
                let wrote = writeOffset(attributes.frame.minY - anchor.top, animated: false,
                                        preservingInteraction: nativeMotionActive)
                // Following geometry changes will take their own current baseline.
                // Keeping this top indefinitely would freeze a moving reader in place.
                if !applyingSnapshot { anchors = [] }
                return wrote
            }
            anchors = []
            return false
        }

        private func emitMetrics() {
            guard let collection else { return }
            if let direction = pendingDirection {
                pendingDirection = nil
                input.onDirection(direction)
            }
            let distance = max(0, bottomOffset - collection.contentOffset.y)
            if lastDistance == nil || abs((lastDistance ?? 0) - distance) > 0.25 {
                lastDistance = distance
                input.onDistance(distance)
            }
            var frames: [String: CGRect] = [:]
            for (id, frame, measured) in visibleRows()
                where measured && rendered[id]?.kind == .message && id != input.tailID {
                frames[id] = frame.offsetBy(dx: -collection.bounds.minX, dy: -collection.bounds.minY)
            }
            let height = collection.bounds.height
            if frames != lastViewport || height != lastViewportHeight {
                lastViewport = frames
                lastViewportHeight = height
                input.onViewport(frames, height)
            }
        }

        func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
            input.onInteraction(true)
            userInteracting = true
            pendingInteractionEnd = false
            interactionGeneration &+= 1
            anchors = []
            alignment = nil
            handledRequest = input.viewport.nativeState.request
            animatingOffset = false
            previousPanY = scrollView.panGestureRecognizer.translation(in: scrollView).y
            captureAnchorsIfNeeded()
        }

        func scrollViewDidScroll(_ scrollView: UIScrollView) {
            let panY = scrollView.panGestureRecognizer.translation(in: scrollView).y
            advanceAnchorsForUserMotion(scrollView)
            if scrollView.isDragging {
                if abs(panY - previousPanY) > 0.5 {
                    pendingDirection = panY > previousPanY
                    previousPanY = panY
                }
            }
            refreshCellGeometry()
            scheduleResolution()
        }

        private func advanceAnchorsForUserMotion(_ scrollView: UIScrollView) {
            guard userInteracting else { return }
            let panY = scrollView.panGestureRecognizer.translation(in: scrollView).y
            for index in anchors.indices {
                let changedPan = abs(panY - anchors[index].panY) > 0.001
                let nativeDeceleration = scrollView.isDecelerating && nativeLayoutDepth == 0 &&
                    snapshotMutationDepth == 0
                if !compensatingLayout, (scrollView.isDragging && changedPan) || nativeDeceleration {
                    // Use actual native movement, including rubber-banding, rather
                    // than treating raw finger translation as an equal pixel delta.
                    anchors[index].top -= scrollView.contentOffset.y - anchors[index].offsetY
                }
                anchors[index].panY = panY
                anchors[index].offsetY = scrollView.contentOffset.y
            }
        }

        func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
            if !decelerate { finishInteraction() }
        }

        func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) { finishInteraction() }

        func scrollViewDidEndScrollingAnimation(_ scrollView: UIScrollView) {
            animatingOffset = false
            scheduleResolution()
        }

        private func finishInteraction() {
            guard userInteracting else {
                scheduleResolution()
                return
            }
            userInteracting = false
            anchors = []
            captureAnchorsIfNeeded()
            pendingInteractionEnd = true
            scheduleResolution()
        }

        func stop() {
            stopped = true
            snapshotPreparation?.cancel()
            snapshotPreparation = nil
            if let viewportObserver { observedViewport?.removeNativeStateObserver(viewportObserver) }
            viewportObserver = nil; observedViewport = nil
            ownershipGeneration &+= 1
            ChatDebugProbes.unbindNativeTranscript(collection)
            for case let cell as NativeTranscriptCell in collection?.visibleCells ?? [] {
                cell.geometry.reset()
            }
            collection?.willLayout = nil
            collection?.prepareInitialPlacement = nil
            collection?.didLayout = nil
            collection?.delegate = nil
            collection?.dataSource = nil
            dataSource = nil
            rendered = [:]
        }
    }
}

@MainActor
private final class NativeTranscriptLayout: UICollectionViewCompositionalLayout {
    var readingTarget: ((CGPoint, UICollectionViewLayout) -> CGPoint)?

    override func targetContentOffset(forProposedContentOffset proposedContentOffset: CGPoint) -> CGPoint {
        let proposed = super.targetContentOffset(forProposedContentOffset: proposedContentOffset)
        return readingTarget?(proposed, self) ?? proposed
    }
}

@MainActor
private final class NativeTranscriptCollection: UICollectionView {
    var prepareInitialPlacement: (() -> Void)?
    var willLayout: (() -> Void)?
    var didLayout: (() -> Void)?
    private var preparingInitialPlacement = false

    override func layoutSubviews() {
        if !preparingInitialPlacement {
            preparingInitialPlacement = true
            prepareInitialPlacement?()
            preparingInitialPlacement = false
        }
        willLayout?()
        super.layoutSubviews()
        didLayout?()
    }

    #if DEBUG
    // E2 compares AX rectangles exactly. Keep pixel normalization out of Release.
    override var accessibilityFrame: CGRect {
        get {
            let frame = super.accessibilityFrame
            let scale = window?.screen.scale ?? traitCollection.displayScale
            guard scale > 0 else { return frame }
            return CGRect(x: (frame.origin.x * scale).rounded() / scale,
                          y: (frame.origin.y * scale).rounded() / scale,
                          width: (frame.width * scale).rounded() / scale,
                          height: (frame.height * scale).rounded() / scale)
        }
        set { super.accessibilityFrame = newValue }
    }
    #endif
}

@MainActor
final class NativeTranscriptCell: UICollectionViewCell {
    let geometry = ChatNativeCellGeometry()
    var willMeasure: (() -> Void)?
    var didMeasure: (() -> Void)?
    private(set) var representedID: String?
    private var representedOwner: UInt64?
    private var representedRevision: UUID?
    private var measuredRevision: UUID?
    private var measuredHeight: CGFloat?

    func represent(id: String, revision: UUID, owner: UInt64) {
        if representedID != id || representedOwner != owner { geometry.reset() }
        if representedID != id || representedRevision != revision {
            representedID = id
            representedRevision = revision
            measuredRevision = nil
            measuredHeight = nil
        }
        representedOwner = owner
        geometry.onContentSizeChange = { [weak self] in
            guard let self else { return }
            // UIHostingConfiguration still provides its real fitting result. Explicit
            // intrinsic invalidation carries each reply-height animation frame through
            // UICollectionView's supported self-sizing path.
            self.contentView.invalidateIntrinsicContentSize()
            self.invalidateIntrinsicContentSize()
            self.setNeedsLayout()
            self.didMeasure?()
        }
    }

    override func prepareForReuse() {
        super.prepareForReuse()
        representedID = nil
        representedOwner = nil
        representedRevision = nil
        measuredRevision = nil
        measuredHeight = nil
        didMeasure = nil
        willMeasure = nil
        geometry.reset()
        geometry.onContentSizeChange = nil
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        geometry.refresh()
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        geometry.refresh()
    }

    override func preferredLayoutAttributesFitting(_ layoutAttributes: UICollectionViewLayoutAttributes)
        -> UICollectionViewLayoutAttributes {
        ChatDebugProbes.nativeMeasured()
        // Keep UIKit's actual UIHostingConfiguration self-sizing, including very tall
        // Text cells. This hook observes the result; it never substitutes a cell height.
        willMeasure?()
        let fitted = super.preferredLayoutAttributesFitting(layoutAttributes)
        if fitted.size.height.isFinite, fitted.size.height > 0 {
            let changed = measuredRevision != representedRevision || measuredHeight != fitted.size.height
            measuredRevision = representedRevision
            measuredHeight = fitted.size.height
            if changed { didMeasure?() }
        }
        return fitted
    }

    func hasMeasured(id: String, height: CGFloat) -> Bool {
        representedID == id && measuredRevision == representedRevision &&
            measuredHeight.map { abs($0 - height) <= 1 } == true
    }
}

/// A hosted disclosure must lay out at its current height: UIKit otherwise measures
/// the implicit SwiftUI animation's final height and expands the cell before its row.
/// The original non-native OrbisCollapse keeps its implicit animation path.
struct ChatNativeCollapse<Content: View>: View {
    @Environment(\.orbisReduceMotion) private var reduceMotion
    @Environment(\.chatVisualActivity) private var activity
    private var visualActive: Bool { activity?.active ?? true }
    let expanded: Bool
    @ViewBuilder var content: () -> Content
    @State private var hasExpanded: Bool
    @State private var shown: Bool
    @State private var naturalHeight: CGFloat?
    @State private var presentationHeight: CGFloat?
    @State private var presentationOpacity: Double
    @State private var waitingForHeight = false
    @State private var motion: ChatNativeCollapseMotion?

    init(expanded: Bool, @ViewBuilder content: @escaping () -> Content) {
        self.expanded = expanded
        self.content = content
        _hasExpanded = State(initialValue: expanded)
        _shown = State(initialValue: expanded)
        _presentationOpacity = State(initialValue: expanded ? 1 : 0)
    }

    private var frameHeight: CGFloat? {
        if motion != nil || waitingForHeight { return presentationHeight ?? 0 }
        // An open resting disclosure keeps responding to its content's live height.
        return shown ? nil : 0
    }

    var body: some View {
        Group {
            if expanded || hasExpanded {
                content()
                    .fixedSize(horizontal: false, vertical: true)
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height in
                        guard height.isFinite, height >= 0, height != naturalHeight else { return }
                        naturalHeight = height
                        if expanded, waitingForHeight || motion != nil { retarget(expanded: true) }
                    }
                    .frame(height: frameHeight, alignment: .top)
                    .clipped()
                    .opacity(presentationOpacity)
                    .allowsHitTesting(shown)
                    .accessibilityHidden(!shown)
            }
        }
        .background {
            // Only the small native disclosure owns this clock. The content stays in
            // the same parent across start/stop, preserving its retained child state.
            if motion != nil, visualActive, !reduceMotion {
                TimelineView(.animation) { clock in
                    let now = max(clock.date.timeIntervalSinceReferenceDate,
                                  Date.timeIntervalSinceReferenceDate)
                    Color.clear.frame(width: 0, height: 0)
                        .onChange(of: now, initial: true) { _, value in advance(to: value) }
                }.allowsHitTesting(false).accessibilityHidden(true)
            }
        }
        .onChange(of: expanded) { _, value in
            if value { hasExpanded = true }
            if reduceMotion || !visualActive { settle(); return }
            if value, naturalHeight == nil {
                withoutAnimation {
                    waitingForHeight = true
                    presentationHeight = 0
                    presentationOpacity = 0
                }
            } else {
                retarget(expanded: value)
            }
        }
        .onChange(of: visualActive) { _, active in if !active { settle() } }
        .onChange(of: reduceMotion) { _, reduced in if reduced { settle() } }
        .onDisappear { settle() }
    }

    private func retarget(expanded: Bool) {
        guard !reduceMotion, visualActive else { settle(); return }
        guard let naturalHeight else {
            if !expanded { settle() }
            return
        }
        let now = Date.timeIntervalSinceReferenceDate
        let target = expanded ? naturalHeight : 0
        let current = motion?.height(at: now) ?? presentationHeight ?? (expanded ? 0 : naturalHeight)
        let opacity = motion?.opacity(at: now) ?? presentationOpacity
        let next = ChatNativeCollapseMotion(started: now, startHeight: current, targetHeight: target,
            heightVelocity: motion?.heightVelocity(at: now) ?? 0,
            startOpacity: opacity, targetOpacity: expanded ? 1 : 0,
            opacityVelocity: motion?.opacityVelocity(at: now) ?? 0)
        withoutAnimation {
            waitingForHeight = false
            shown = expanded
            presentationHeight = current
            presentationOpacity = opacity
            motion = next
        }
    }

    private func advance(to now: TimeInterval) {
        guard let motion else { return }
        withoutAnimation {
            if now - motion.started >= ChatNativeCollapseMotion.spring.settlingDuration {
                settle()
            } else {
                presentationHeight = max(0, motion.height(at: now))
                presentationOpacity = min(1, max(0, motion.opacity(at: now)))
            }
        }
    }

    private func settle() {
        withoutAnimation {
            if expanded { hasExpanded = true }
            shown = expanded
            waitingForHeight = false
            motion = nil
            presentationHeight = nil
            presentationOpacity = expanded ? 1 : 0
        }
    }

    private func withoutAnimation(_ action: () -> Void) {
        var transaction = Transaction(animation: nil)
        transaction.disablesAnimations = true
        withTransaction(transaction, action)
    }
}

private struct ChatNativeCollapseMotion {
    static var spring: Spring { OrbisCollapseMotion.spring }
    let started: TimeInterval
    let startHeight: CGFloat
    let targetHeight: CGFloat
    let heightVelocity: CGFloat
    let startOpacity: Double
    let targetOpacity: Double
    let opacityVelocity: Double

    func height(at time: TimeInterval) -> CGFloat {
        startHeight + Self.spring.value(target: targetHeight - startHeight,
            initialVelocity: heightVelocity, time: max(0, time - started))
    }

    func heightVelocity(at time: TimeInterval) -> CGFloat {
        Self.spring.velocity(target: targetHeight - startHeight,
            initialVelocity: heightVelocity, time: max(0, time - started))
    }

    func opacity(at time: TimeInterval) -> Double {
        startOpacity + Self.spring.value(target: targetOpacity - startOpacity,
            initialVelocity: opacityVelocity, time: max(0, time - started))
    }

    func opacityVelocity(at time: TimeInterval) -> Double {
        Self.spring.velocity(target: targetOpacity - startOpacity,
            initialVelocity: opacityVelocity, time: max(0, time - started))
    }
}
