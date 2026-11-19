import Foundation
import Observation
import CoreGraphics

/// A viewport-only resize must not scan all row inputs. The caller supplies the
/// model publication revision, host environment and any size-dependent empty row.
@MainActor
final class ChatTranscriptSnapshotCache<Key: Equatable, Snapshot> {
    private var entry: (key: Key, snapshot: Snapshot)?

    func snapshot(key: Key, make: () -> Snapshot) -> Snapshot {
        if let entry, entry.key == key { return entry.snapshot }
        let snapshot = make()
        entry = (key, snapshot)
        return snapshot
    }

    func removeAll() { entry = nil }
}

/// Retain native row content until its semantic inputs change. The builder runs only
/// on a miss; order and membership have their own revision for the native adapter.
@MainActor
final class ChatTranscriptItemCache<Inputs: Equatable, Item> {
    private struct Entry { let inputs: Inputs; let item: Item }
    private var entries: [String: Entry] = [:]
    private var order: [String] = []
    private(set) var revision: UInt64 = 0

    func item(id: String, inputs: Inputs, make: () -> Item) -> Item {
        if let entry = entries[id], entry.inputs == inputs { return entry.item }
        let item = make()
        entries[id] = Entry(inputs: inputs, item: item)
        revision &+= 1
        return item
    }

    func retain(ids: [String]) {
        guard order != ids else { return }
        let retained = Set(ids)
        entries = entries.filter { retained.contains($0.key) }
        order = ids
        revision &+= 1
    }

    func removeAll() {
        guard !entries.isEmpty else { return }
        entries.removeAll(); order = []; revision &+= 1
    }
}

/// Diffable snapshots require unique identifiers. A malformed source keeps each ID's
/// first row, so later transcript updates still apply instead of being rejected.
func chatUniqueItems<Item>(_ items: [Item], id: (Item) -> String) -> [Item] {
    var seen = Set<String>()
    return items.filter { seen.insert(id($0)).inserted }
}

/// PERF-14: only immutable row identity/version metadata crosses the worker boundary.
/// Hosted content and native layout remain owned by the main-actor coordinator.
struct ChatNativeSnapshotRow: Equatable, Sendable {
    let id: String
    let revision: UUID
}

struct ChatNativeSnapshotPlan: Sendable {
    let ids: [String]
    let reconfigured: [String]
    let reconfiguredIDs: Set<String>

    init(ids: [String], reconfigured: [String]) {
        self.ids = ids; self.reconfigured = reconfigured
        reconfiguredIDs = Set(reconfigured)
    }
}

/// Prepares changes relative to the last applied snapshot. The coordinator supplies
/// unique IDs and validates the source/owner generations before committing a plan.
actor ChatNativeSnapshotWorker {
    private let beforeWork: @Sendable () -> Void

    init(beforeWork: @escaping @Sendable () -> Void = {}) {
        self.beforeWork = beforeWork
    }

    func prepare(previous: [ChatNativeSnapshotRow], next: [ChatNativeSnapshotRow],
                 reconfigureRetained: Bool) -> ChatNativeSnapshotPlan {
        beforeWork()
        let revisions = Dictionary(uniqueKeysWithValues: previous.map { ($0.id, $0.revision) })
        var ids: [String] = []
        var reconfigured: [String] = []
        ids.reserveCapacity(next.count)
        reconfigured.reserveCapacity(min(previous.count, next.count))
        for row in next {
            ids.append(row.id)
            if let previousRevision = revisions[row.id],
               reconfigureRetained || previousRevision != row.revision {
                reconfigured.append(row.id)
            }
        }
        return ChatNativeSnapshotPlan(ids: ids, reconfigured: reconfigured)
    }
}

enum ChatPagePhase: Equatable {
    case active, moving, covered, background
    var visualActive: Bool { self == .active || self == .moving }
}

/// IOS-CHAT-10: a stable reference in the environment. Only visual clock owners
/// read its phase; static rows do not acquire a visibility dependency.
@MainActor @Observable
final class ChatVisualActivity {
    private(set) var phase: ChatPagePhase = .active
    private(set) var active = true
    func set(_ phase: ChatPagePhase) {
        if self.phase != phase { self.phase = phase }
        if active != phase.visualActive { active = phase.visualActive }
    }
}

/// IOS-CHAT-11: the transcript builder never reads policy. Each consumer observes
/// only its discrete projection; native pixel geometry remains in this reference.
@MainActor @Observable
final class ChatViewportController {
    struct NativeState: Equatable {
        let following: Bool
        let request: ChatViewportPolicy.Request?
        let contextGeneration: Int
    }
    // UIKit subscribes directly, so a native scroll intent never invalidates the
    // SwiftUI row builder. This projection reads only the unobserved policy.
    var nativeState: NativeState {
        .init(following: policy.following, request: policy.request, contextGeneration: policy.contextGeneration)
    }
    @ObservationIgnored private var nativeObservers: [UUID: () -> Void] = [:]
    @ObservationIgnored let readingSurface = ChatReadingSurface()
    func observeNativeState(_ change: @escaping () -> Void) -> UUID {
        let token = UUID(); nativeObservers[token] = change; return token
    }
    func removeNativeStateObserver(_ token: UUID) { nativeObservers[token] = nil }

    private(set) var following = true
    private(set) var showJump = false
    private(set) var showQuestionReminder = false
    private(set) var request: ChatViewportPolicy.Request?
    private(set) var contextGeneration = 0
    private(set) var readingQuestion: ChatQuestion?
    private(set) var retryingHistory = false
    @ObservationIgnored private(set) var policy = ChatViewportPolicy()
    @ObservationIgnored let arrivals = ReplyCardArrivals()
    @ObservationIgnored var bottomDistance: CGFloat = 0
    @ObservationIgnored private(set) var readingRowID: String?
    @ObservationIgnored private var current: ChatTranscriptState?
    @ObservationIgnored private var visible = true
    @ObservationIgnored private var sourceReady = false

    func commit(_ state: ChatTranscriptState, now: TimeInterval = ProcessInfo.processInfo.systemUptime) {
        if let current, current.target != state.target || current.historyRevision != state.historyRevision {
            bottomDistance = 0; readingRowID = nil; retryingHistory = false
            update { $0.resetContext() }
        }
        if let current, !state.historyLoading,
           current.historyPageRevision != state.historyPageRevision || current.historyLoading {
            update { $0.olderPageFinished() }
            retryingHistory = false
        }
        self.current = state
        updateReadingQuestion()
        sourceReady = state.connection == .secured && !state.syncing && !state.cached
        // Register before assigning the observed region: lazy row initialization can
        // synchronously claim the ticket as soon as SwiftUI sees the new transcript.
        arrivals.observe(rows: state.transcript.rows.map { ($0.id, $0.messages.map(\.messageId)) },
            ready: visible && policy.hasPositioned && sourceReady, following: policy.following, now: now)
    }
    func resetForMount() {
        bottomDistance = 0; readingRowID = nil; current = nil
        readingQuestion = nil; retryingHistory = false
        update { $0.resetContext() }
    }
    func setVisualActive(_ active: Bool) {
        visible = active
        if !active { readingSurface.cancel() }
        arrivals.setReadiness(active && policy.hasPositioned && sourceReady, following: policy.following)
    }
    @discardableResult func update<Result>(_ change: (inout ChatViewportPolicy) -> Result) -> Result {
        let before = nativeState
        let result = change(&policy)
        if before.contextGeneration != policy.contextGeneration { readingSurface.cancel() }
        if following != policy.following { following = policy.following }
        if showJump != policy.showJump { showJump = policy.showJump }
        if showQuestionReminder != policy.showQuestionReminder { showQuestionReminder = policy.showQuestionReminder }
        if request != policy.request { request = policy.request }
        if contextGeneration != policy.contextGeneration { contextGeneration = policy.contextGeneration }
        arrivals.setReadiness(visible && policy.hasPositioned && sourceReady, following: policy.following)
        if before != nativeState { for observer in Array(nativeObservers.values) { observer() } }
        return result
    }
    func distanceChanged(_ distance: CGFloat) {
        bottomDistance = distance
        update { $0.distanceChanged(distance, hasMessages: current?.hasMessages ?? false) }
    }
    func interactionChanged(_ active: Bool) { update { $0.interactionChanged(active, bottomDistance: bottomDistance) } }
    func disclosureBegan() {
        readingSurface.cancel()
        update { $0.disclosureBegan(bottomDistance: bottomDistance) }
    }
    func readingRowChanged(_ id: String?) {
        guard readingRowID != id else { return }
        readingRowID = id
        updateReadingQuestion()
    }
    private func updateReadingQuestion() {
        let row = readingRowID
        let question = row.flatMap { current?.transcript.question(at: $0) }
        let candidate = question?.messageId == row ? nil : question
        if readingQuestion != candidate { readingQuestion = candidate }
        if policy.questionOutsideViewport != (candidate != nil) { update { $0.questionChanged(outside: candidate != nil) } }
    }
    func canLoadHistory(retrying: Bool = false) -> Bool {
        guard let current, visible, policy.hasPositioned, current.hasOlder, !current.syncing,
              !current.historyLoading, !policy.awaitingOlderPage, current.canSend || current.cached else { return false }
        return retrying ? current.historyError != nil : current.historyError == nil
    }
    func acceptedHistory(retrying: Bool) {
        if retrying { retryingHistory = true }
        update { $0.olderPageAccepted(bottomDistance: bottomDistance) }
    }
    func owns(_ candidate: ChatViewportPolicy.Request) -> Bool { policy.owns(candidate) }
}

/// FOLD-05: a native, unobserved channel from the lower grip surface to the one
/// transcript offset owner. Late callbacks cannot cross a gesture or mount handoff.
@MainActor
final class ChatReadingSurface {
    enum Event: Equatable { case began, moved(CGFloat), released, ended }
    private var receiver: (id: UUID, handle: (Event) -> Bool)?
    private var gesture: (id: UUID, cancel: () -> Void)?

    func attach(_ handle: @escaping (Event) -> Bool) -> UUID {
        cancel()
        let id = UUID()
        receiver = (id, handle)
        return id
    }

    func detach(_ id: UUID) {
        guard receiver?.id == id else { return }
        cancel()
        receiver = nil
    }

    func begin(onCancel: @escaping () -> Void) -> UUID? {
        cancel()
        guard let receiver else { return nil }
        let id = UUID()
        gesture = (id, onCancel)
        guard receiver.handle(.began), gesture?.id == id else { cancel(id); return nil }
        return id
    }

    func move(_ id: UUID, by delta: CGFloat) {
        guard gesture?.id == id, delta.isFinite, delta != 0 else { return }
        if receiver?.handle(.moved(delta)) != true { cancel(id) }
    }

    func release(_ id: UUID) {
        guard gesture?.id == id else { return }
        if receiver?.handle(.released) != true { cancel(id) }
    }

    func end(_ id: UUID) {
        guard gesture?.id == id else { return }
        gesture = nil
        _ = receiver?.handle(.ended)
    }

    func cancel(_ id: UUID? = nil) {
        guard let active = gesture, id == nil || active.id == id else { return }
        gesture = nil
        _ = receiver?.handle(.ended)
        active.cancel()
    }
}
