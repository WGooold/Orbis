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
    func observeNativeState(_ change: @escaping () -> Void) -> UUID {
        let token = UUID(); nativeObservers[token] = change; return token
    }
    func removeNativeStateObserver(_ token: UUID) { nativeObservers[token] = nil }

    private(set) var following = true
    private(set) var showJump = false
    private(set) var showQuestionReminder = false
    private(set) var request: ChatViewportPolicy.Request?
    private(set) var contextGeneration = 0
    private(set) var latestQuestion: ChatQuestion?
    @ObservationIgnored private(set) var policy = ChatViewportPolicy()
    @ObservationIgnored let arrivals = ReplyCardArrivals()
    @ObservationIgnored var bottomDistance: CGFloat = 0
    @ObservationIgnored var viewport = ChatViewportFacts()
    @ObservationIgnored private var current: ChatTranscriptState?
    @ObservationIgnored private var visible = true
    @ObservationIgnored private var sourceReady = false

    func commit(_ state: ChatTranscriptState, now: TimeInterval = ProcessInfo.processInfo.systemUptime) {
        if let current, current.target != state.target || current.historyRevision != state.historyRevision {
            bottomDistance = 0; viewport = ChatViewportFacts()
            update { $0.resetContext() }
        }
        if let current, current.historyPageRevision != state.historyPageRevision ||
            (current.historyLoading && !state.historyLoading && state.historyError != nil) {
            update { $0.olderPageFinished() }
        }
        self.current = state
        let question = state.transcript.latestQuestion(excluding: Set(state.pending.items.map(\.messageId)))
        if latestQuestion != question { latestQuestion = question }
        update { $0.questionChanged(outside: viewport.questionOutsideViewport(question?.messageId)) }
        sourceReady = state.connection == .secured && !state.syncing && !state.cached
        // Register before assigning the observed region: lazy row initialization can
        // synchronously claim the ticket as soon as SwiftUI sees the new transcript.
        arrivals.observe(rows: state.transcript.rows.map { ($0.id, $0.messages.map(\.messageId)) },
            ready: visible && policy.hasPositioned && sourceReady, following: policy.following, now: now)
    }
    func resetForMount() {
        bottomDistance = 0; viewport = ChatViewportFacts(); current = nil
        update { $0.resetContext() }
    }
    func setVisualActive(_ active: Bool) {
        visible = active
        arrivals.setReadiness(active && policy.hasPositioned && sourceReady, following: policy.following)
    }
    @discardableResult func update<Result>(_ change: (inout ChatViewportPolicy) -> Result) -> Result {
        let before = nativeState
        let result = change(&policy)
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
        update { $0.distanceChanged(distance, hasMessages: current?.hasMessages ?? false, firstRowNearTop: viewport.firstRowNearTop) }
    }
    func interactionChanged(_ active: Bool) { update { $0.interactionChanged(active, bottomDistance: bottomDistance) } }
    func disclosureBegan() { update { $0.disclosureBegan(bottomDistance: bottomDistance) } }
    func viewportChanged(_ facts: ChatViewportFacts) -> Bool {
        viewport = facts
        return update { $0.viewportChanged(facts, questionID: latestQuestion?.messageId,
            canPage: current.map { !$0.syncing && !$0.historyLoading && $0.historyError == nil } ?? false) }
    }
    func owns(_ candidate: ChatViewportPolicy.Request) -> Bool { policy.owns(candidate) }
}
