import Foundation
import Combine

/// IOS-CHAT-02: immutable display inputs, captured after all mutations in one source event.
/// The existing HostConnection and serial transcript worker remain the only business owners.
@MainActor
struct ChatScreenSnapshot {
    let owner: HostConnection
    let host: HostPairing?
    let runtime: RuntimeSummary?
    let kind: String?
    let canSend: Bool
    let connection: ConnectionState
    let syncing: Bool
    let cached: Bool
    let launch: HostConnection.LaunchState?
    let isLaunchPage: Bool
    let transcript: ChatTranscript
    let hasMessages: Bool
    let streaming: Set<String>
    let pending: PendingSendOutbox
    let pendingActions: Set<String>
    let uploads: [FileTransfer]
    let attached: [FileTransfer]
    let preparing: Bool
    let commands: [SlashCommand]
    let workingBranch: WorkingBranch?
    let draftRevision: Int
    let draft: String
    let cachedSession: SessionSummary?
    let activatingSessionId: String?
    let historyRevision: Int
    let historyPageRevision: Int
    let historyLoading: Bool
    let historyError: String?
    let hasOlder: Bool
    let actionFeedback: String?
    let notice: RuntimeNoticeProjection?
    let requests: [InteractionRequest]
    let responding: Set<String>
    let interactionText: String?
    let interactionPending: Bool
    let queue: [QueuedMessage]
    let queueCancellations: Set<String>
    let modelReady: Bool
    let executionReady: Bool
    let contextReady: Bool
    let modelSaveState: Int
    let modelSaveFailed: Bool
    let displayName: String
    let rewind: [String: RuntimeOption]

    init(store: OrbisStore) {
        let source = store.activeConnection, runtime = source.selectedRuntime
        let id = runtime?.runtimeId ?? "", session = runtime?.sessionId
        owner = source; host = store.selectedHost; self.runtime = runtime
        kind = runtime.flatMap(source.agentKind)
        canSend = source.canSend; connection = source.connection; syncing = source.isSyncing
        cached = source.isViewingCachedSession; launch = source.launching; isLaunchPage = source.isLaunchPage
        transcript = source.chatTranscript; hasMessages = !source.messages.isEmpty
        streaming = source.streamingMessageIds
        var currentPending = PendingSendOutbox()
        for item in source.pendingSends.items where item.sessionId == session { currentPending.add(item) }
        pending = currentPending; pendingActions = source.pendingActionIds
        let tasks = source.transfers.currentTasks
        let uploadIds = Set(source.pendingSends.items.filter { $0.sessionId == session }.flatMap(\.uploadIds))
        uploads = tasks.filter { uploadIds.contains($0.id) }
        attached = tasks.filter { $0.direction == "upload" && $0.runtimeId == id && $0.sessionId == session && $0.attached }
        preparing = source.transfers.preparing
        commands = source.commands[id] ?? []; workingBranch = source.workingBranches[id]
        draftRevision = source.draftRevision; draft = runtime.map(source.draft) ?? ""
        cachedSession = source.isViewingCachedSession ? source.sessions.first { $0.sessionId == session } : nil
        activatingSessionId = source.activatingSessionId
        historyRevision = source.historyRevision; historyPageRevision = source.historyPageRevision
        historyLoading = source.historyLoading.contains(id); historyError = source.historyErrors[id]
        hasOlder = source.hasOlderHistory[id] == true; actionFeedback = source.actionFeedback
        notice = source.notifications.visibleProjection(id)
        requests = source.interactions[id] ?? []; responding = source.respondingRequestIds(id)
        let status = source.interactionStatus(id)
        interactionText = status?.text; interactionPending = status?.pending ?? false
        queue = source.queuePanelItems(id); queueCancellations = source.unconfirmedQueueCancellations(id)
        let agent = source.agentState.snapshots[id]
        func ready(_ domain: String) -> Bool {
            agent?.missing[domain] == nil && (agent?.domains[domain]?.availability ?? "ready") == "ready"
        }
        modelReady = ready("model"); executionReady = ready("execution"); contextReady = ready("context")
        let config = OperationKinds.configSettings.compactMap { source.configStatus(id, setting: $0) }
        modelSaveState = config.contains { L10n.matches($0.mark, source: "未确认") } ? 2 : (config.isEmpty ? 0 : 1)
        modelSaveFailed = source.sessionConfigFailure(id) != nil
        displayName = runtime.map(source.displayName) ?? ""
        rewind = runtime.map(source.userMessageRewindOptions) ?? [:]
    }

    var identity: String { runtime.map { localSessionKey(host: host, runtime: $0) } ?? "" }
    // Localized labels are derived from committed facts, so a locale change needs no network event.
    var modelPresentation: SessionModelPresentation? {
        runtime.map { .make(runtime: $0, connected: connection == .secured, modelReady: modelReady,
            executionReady: executionReady,
            progress: modelSaveState == 0 ? [] : [(label: "", mark: L10n.tr(modelSaveState == 2 ? "未确认" : "保存中"))],
            failed: modelSaveFailed) }
    }
    var shellKey: [String?] { [identity, kind, cached ? "cached" : "live"] }
    var headerKey: [String?] {
        [displayName, kind, connection.rawValue, syncing.description, runtime?.presentationStatus,
         runtime?.presentationTitle, modelPresentation?.model, modelPresentation?.thinking, modelPresentation?.indicator]
    }
    var composerRuntime: ChatComposerRuntimeFacts {
        ChatComposerRuntimeFacts(status: runtime?.status, cwd: runtime?.cwd, kind: kind,
            context: runtime?.contextUsage, permissions: runtime?.permissionManagement, tasks: runtime?.backgroundTasks)
    }
    var workingBranchKey: [String?] {
        [workingBranch?.sessionId, workingBranch?.cwd,
         workingBranch?.branch, workingBranch?.commit, workingBranch?.loaded.description]
    }
    func sameTranscript(as old: Self) -> Bool {
        identity == old.identity && transcript.contentRevision == old.transcript.contentRevision &&
        streaming == old.streaming && hasMessages == old.hasMessages && canSend == old.canSend &&
        syncing == old.syncing && cached == old.cached && connection == old.connection &&
        runtime?.status == old.runtime?.status && pending == old.pending && pendingActions == old.pendingActions &&
        uploads == old.uploads && historyRevision == old.historyRevision && historyPageRevision == old.historyPageRevision &&
        historyLoading == old.historyLoading && historyError == old.historyError && hasOlder == old.hasOlder &&
        actionFeedback == old.actionFeedback && rewind == old.rewind
    }
    func sameComposer(as old: Self) -> Bool {
        identity == old.identity && composerRuntime == old.composerRuntime && canSend == old.canSend &&
        draftRevision == old.draftRevision && commands == old.commands && pendingActions == old.pendingActions &&
        attached == old.attached && preparing == old.preparing && workingBranchKey == old.workingBranchKey &&
        contextReady == old.contextReady && cached == old.cached && connection == old.connection &&
        cachedSession == old.cachedSession && activatingSessionId == old.activatingSessionId
    }
    func sameWorkspace(as old: Self) -> Bool {
        identity == old.identity && requests == old.requests && responding == old.responding &&
        interactionText == old.interactionText && interactionPending == old.interactionPending &&
        queue == old.queue && queueCancellations == old.queueCancellations && canSend == old.canSend
    }
}

struct ChatComposerRuntimeFacts: Equatable {
    let status: String?
    let cwd: String?
    let kind: String?
    let context: RuntimeContextUsage?
    let permissions: PermissionManagement?
    let tasks: BackgroundTaskInventory?
}

/// The immutable target captured when a page is constructed. Reusing the publication
/// controller across pages must never authorize a late editor or picker callback.
struct ChatActionContext: Equatable {
    let owner: HostConnection
    let identity: String
    let runtimeId: String?
    let sessionId: String?

    static func == (lhs: Self, rhs: Self) -> Bool { lhs.owner === rhs.owner && lhs.identity == rhs.identity }
    @MainActor static func capture(_ store: OrbisStore) -> Self {
        let runtime = store.selectedRuntime
        return Self(owner: store.activeConnection,
            identity: runtime.map { localSessionKey(host: store.selectedHost, runtime: $0) } ?? "",
            runtimeId: runtime?.runtimeId, sessionId: runtime?.sessionId)
    }
    @MainActor func matches(_ store: OrbisStore) -> Bool {
        guard store.activeConnection === owner else { return false }
        return identity == (store.selectedRuntime.map { localSessionKey(host: store.selectedHost, runtime: $0) } ?? "")
    }
    /// Cleanup may run after switching Hosts. It still belongs to the original source,
    /// but a reused runtime ID must not cancel a read already owned by a replacement session.
    @MainActor var ownsRuntime: Bool {
        guard let runtimeId else { return false }
        if let current = owner.selectedRuntime, current.runtimeId == runtimeId { return current.sessionId == sessionId }
        return owner.runtimes.contains { $0.runtimeId == runtimeId && $0.sessionId == sessionId }
    }
}

struct NavigationScreenSnapshot: Equatable {
    let source: HostConnection
    let runtime: RuntimeSummary?
    let selectedHost: HostPairing?
    let owner: ObjectIdentifier
    let pairings: [HostPairing]
    let selectedHostId: String?
    let runtimeIdentity: String?
    let selectedRuntimeId: String?
    let activationRevision: Int
    let pairing: Bool
    let error: String?
    var actionContext: ChatActionContext {
        ChatActionContext(owner: source, identity: runtimeIdentity ?? "", runtimeId: runtime?.runtimeId, sessionId: runtime?.sessionId)
    }
    @MainActor init(store: OrbisStore) {
        source = store.activeConnection; runtime = source.selectedRuntime; selectedHost = store.selectedHost
        owner = ObjectIdentifier(store.activeConnection); pairings = store.pairings
        selectedHostId = store.selectedHostId; selectedRuntimeId = store.selectedRuntimeId
        runtimeIdentity = store.selectedRuntime.map { localSessionKey(host: store.selectedHost, runtime: $0) }
        activationRevision = store.activationRevision; pairing = store.isPairing; error = store.errorMessage
    }
    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.owner == rhs.owner && lhs.pairings == rhs.pairings && lhs.selectedHostId == rhs.selectedHostId &&
        lhs.runtimeIdentity == rhs.runtimeIdentity && lhs.selectedRuntimeId == rhs.selectedRuntimeId &&
        lhs.activationRevision == rhs.activationRevision && lhs.pairing == rhs.pairing && lhs.error == rhs.error
    }
}

/// Publishers have no business state. Four independent sources are coalesced after willSet,
/// then every snapshot is installed before the first scoped invalidation is delivered.
@MainActor
final class ChatScreenPublications {
    let navigation = ScreenPublication()
    let shell = ScreenPublication()
    let header = ScreenPublication()
    let transcript = ScreenPublication()
    let composer = ScreenPublication()
    let notices = ScreenPublication()
    let workspace = ScreenPublication()
    private(set) var snapshot: ChatScreenSnapshot
    private(set) var navigationSnapshot: NavigationScreenSnapshot
    private(set) var captureRevision = 0
    private weak var store: OrbisStore?
    private var sourceOwner: ObjectIdentifier
    private var pageIdentity: String
    private var observations: [AnyCancellable] = []
    private var task: Task<Void, Never>?
    private var token = UUID()
    private var held = false
    private var dirty = false
    private var rebindPending = false

    init(store: OrbisStore) {
        self.store = store; snapshot = ChatScreenSnapshot(store: store)
        navigationSnapshot = NavigationScreenSnapshot(store: store)
        sourceOwner = ObjectIdentifier(store.activeConnection)
        pageIdentity = snapshot.identity
        observe(store.activeConnection)
    }
    private func observe(_ source: HostConnection) {
        observations.removeAll()
        let owner = ObjectIdentifier(source), generation = token
        let receive: () -> Void = { [weak self] in
            guard let self, self.sourceOwner == owner, self.token == generation else { return }
            self.schedule()
        }
        observations = [source.objectWillChange.sink { _ in receive() },
                        source.agentState.objectWillChange.sink { _ in receive() },
                        source.transfers.objectWillChange.sink { _ in receive() },
                        source.notifications.objectWillChange.sink { _ in receive() }]
    }
    func refresh() {
        guard let store else { return }
        let owner = ObjectIdentifier(store.activeConnection)
        let identity = store.selectedRuntime.map { localSessionKey(host: store.selectedHost, runtime: $0) } ?? ""
        if owner != sourceOwner || identity != pageIdentity {
            token = UUID(); task?.cancel(); task = nil
            sourceOwner = owner; pageIdentity = identity; observe(store.activeConnection)
            rebindPending = true
        }
        schedule()
    }
    func hold(_ hold: Bool) {
        held = hold
        if !hold && dirty { schedule() }
    }
    private func schedule() {
        dirty = true
        guard task == nil else { return }
        let generation = token
        task = Task { [weak self] in
            await Task.yield()
            guard let self, self.token == generation, !Task.isCancelled else { return }
            self.task = nil
            guard let store = self.store else { return }
            let identity = store.selectedRuntime.map { localSessionKey(host: store.selectedHost, runtime: $0) } ?? ""
            if ObjectIdentifier(store.activeConnection) != self.sourceOwner || identity != self.pageIdentity { self.refresh(); return }
            // A new page context replaces every regional snapshot together, even during
            // a transition; same-page streaming continues to respect the publication hold.
            guard !self.held || self.rebindPending else { return }
            self.commit(force: self.rebindPending)
        }
    }
    private func commit(force: Bool) {
        guard let store else { return }
        captureRevision &+= 1
        dirty = false
        rebindPending = false
        let next = ChatScreenSnapshot(store: store), nav = NavigationScreenSnapshot(store: store)
        let old = snapshot
        let shellChanged = force || next.shellKey != old.shellKey
        let headerChanged = force || next.headerKey != old.headerKey
        let transcriptChanged = force || !next.sameTranscript(as: old)
        let composerChanged = force || !next.sameComposer(as: old)
        let noticeChanged = force || next.identity != old.identity || next.notice != old.notice || next.connection != old.connection || next.launch != old.launch
        let workspaceChanged = force || !next.sameWorkspace(as: old)
        let navChanged = force || nav != navigationSnapshot
        snapshot = next; navigationSnapshot = nav
        if navChanged { navigation.invalidate() }
        if shellChanged { shell.invalidate() }
        if headerChanged { header.invalidate() }
        if transcriptChanged { transcript.invalidate() }
        if composerChanged { composer.invalidate() }
        if noticeChanged { notices.invalidate() }
        if workspaceChanged { workspace.invalidate() }
    }
    func waitForPending() async { while let pending = task { await pending.value } }
}
