import Foundation
import Combine
import Observation

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
    let inputError: String?
    let menuErrors: [String: String]
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
        let availableCommands = source.commands[id] ?? []
        let menu = availableCommands.filter { $0.name != SlashCommand.closeCapability && $0.name != SlashCommand.viewCloseCapability }
        commands = availableCommands.contains { $0.name == SlashCommand.closeCapability || $0.name == SlashCommand.viewCloseCapability } && !menu.contains { $0.name == "quit" }
            ? menu + [SlashCommand(name: "quit", description: nil, source: "builtin")] : menu
        workingBranch = source.workingBranches[id]
        draftRevision = source.draftRevision; draft = runtime.map(source.draft) ?? ""
        inputError = source.composerError(id) ?? source.objectError(id, includeCardOnly: false) ?? runtime.flatMap(source.transfers.uploadError)
        menuErrors = Dictionary(uniqueKeysWithValues: source.menuErrors.compactMap { key, value in let prefix = id + "\u{0}"; return key.hasPrefix(prefix) ? (String(key.dropFirst(prefix.count)), value) : nil })
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
}

extension ChatTranscript: Equatable {
    static func == (lhs: Self, rhs: Self) -> Bool { lhs.contentRevision == rhs.contentRevision }
}
struct ChatComposerRuntimeFacts: Equatable {
    let runtimeId: String
    let sessionId: String?
    let status: String
    let cwd: String
    let contextUsage: RuntimeContextUsage?
    let permissionManagement: PermissionManagement?
    let backgroundTasks: BackgroundTaskInventory?
    let steerSupported: Bool?
    init(_ r: RuntimeSummary) {
        runtimeId = r.runtimeId; sessionId = r.sessionId; status = r.status; cwd = r.cwd
        contextUsage = r.contextUsage; permissionManagement = r.permissionManagement; backgroundTasks = r.backgroundTasks
        steerSupported = r.steerSupported
    }
}
struct ChatWorkingBranch: Equatable {
    let sessionId: String?
    let cwd: String
    let branch: String?
    let commit: String?
    let loaded: Bool
    init(_ b: WorkingBranch) {
        sessionId = b.sessionId; cwd = b.cwd; branch = b.branch; commit = b.commit; loaded = b.loaded
    }
}
struct ChatShellState: Equatable {
    let target: ChatActionContext
    let kind: String?
    let cached: Bool
    var identity: String { target.identity }
}
/// Header rendering excludes editor context, permissions, session tree and directory
/// metadata. Equality is synthesized over the facts consumed by the existing presenters.
struct ChatHeaderRuntimeFacts: Equatable {
    let runtimeId: String
    let status: String
    let agentKind: String?
    let model: RuntimeModelInfo?
    let thinkingLevel: String?
    let currentTurnConfiguration: RuntimeTurnConfiguration?
    let currentTurnConfigurationSupported: Bool?
    let executionTurnId: String?
    let compactionPhase: String?
    let backgroundTasks: BackgroundTaskInventory?

    init(_ runtime: RuntimeSummary) {
        runtimeId = runtime.runtimeId; status = runtime.status; agentKind = runtime.agentKind
        model = runtime.model; thinkingLevel = runtime.thinkingLevel
        currentTurnConfiguration = runtime.currentTurnConfiguration
        currentTurnConfigurationSupported = runtime.currentTurnConfigurationSupported
        executionTurnId = runtime.executionTurnId; compactionPhase = runtime.compactionPhase
        backgroundTasks = runtime.backgroundTasks
    }

    /// Reuse the shared localized status/model derivation, without retaining the
    /// complete mutable runtime as a region's observation/equality dependency.
    var runtime: RuntimeSummary {
        RuntimeSummary(runtimeId: runtimeId, name: "", cwd: "", status: status,
            agentKind: agentKind, model: model, thinkingLevel: thinkingLevel,
            currentTurnConfiguration: currentTurnConfiguration,
            currentTurnConfigurationSupported: currentTurnConfigurationSupported,
            executionTurnId: executionTurnId, compactionPhase: compactionPhase,
            backgroundTasks: backgroundTasks)
    }
}

struct ChatHeaderState: Equatable {
    let target: ChatActionContext
    let kind: String?
    let displayName: String
    let connection: ConnectionState
    let syncing: Bool
    let modelReady: Bool
    let executionReady: Bool
    let modelSaveState: Int
    let modelSaveFailed: Bool
    let runtimeFacts: ChatHeaderRuntimeFacts?
    var runtime: RuntimeSummary? { runtimeFacts?.runtime }
    var identity: String { target.identity }
    var modelPresentation: SessionModelPresentation? {
        runtime.map { .make(runtime: $0, connected: connection == .secured, modelReady: modelReady,
            executionReady: executionReady,
            progress: modelSaveState == 0 ? [] : [(label: "", mark: L10n.tr(modelSaveState == 2 ? "未确认" : "保存中"))],
            failed: modelSaveFailed) }
    }
}
struct ChatTranscriptState: Equatable {
    let target: ChatActionContext
    let kind: String?
    let transcript: ChatTranscript
    let hasMessages: Bool
    let canSend: Bool
    let syncing: Bool
    let cached: Bool
    let connection: ConnectionState
    let streaming: Set<String>
    let pending: PendingSendOutbox
    let pendingActions: Set<String>
    let uploads: [FileTransfer]
    let historyRevision: Int
    let historyPageRevision: Int
    let historyLoading: Bool
    let historyError: String?
    let hasOlder: Bool
    let actionFeedback: String?
    let rewind: [String: RuntimeOption]
    let status: String?
    var identity: String { target.identity }
}
struct ChatComposerState: Equatable {
    let target: ChatActionContext
    let kind: String?
    let canSend: Bool
    let cached: Bool
    let connection: ConnectionState
    let draftRevision: Int
    let commands: [SlashCommand]
    let pendingActions: Set<String>
    let attached: [FileTransfer]
    let preparing: Bool
    let contextReady: Bool
    let cachedSession: SessionSummary?
    let activatingSessionId: String?
    let runtime: ChatComposerRuntimeFacts?
    let workingBranch: ChatWorkingBranch?
    let inputError: String?
    let menuErrors: [String: String]
    var identity: String { target.identity }
}
struct ChatNoticesState: Equatable {
    let target: ChatActionContext
    let notice: RuntimeNoticeProjection?
    let connection: ConnectionState
    let launch: HostConnection.LaunchState?
    let isLaunchPage: Bool
    let supported: Bool
    var identity: String { target.identity }
}
struct ChatWorkspaceState: Equatable {
    let target: ChatActionContext
    let host: HostPairing?
    let requests: [InteractionRequest]
    let responding: Set<String>
    let interactionText: String?
    let interactionPending: Bool
    let queue: [QueuedMessage]
    let queueCancellations: Set<String>
    let canSend: Bool
    var identity: String { target.identity }
}

/// A replacement connection starts a new page lifetime even when its Host and
/// runtime/session keys are unchanged. Normal publications keep this identity.
struct ChatPageIdentity: Hashable {
    let owner: ObjectIdentifier
    let sessionIdentity: String
}

/// The immutable target captured when a page is constructed. Reusing the publication
/// controller across pages must never authorize a late editor or picker callback.
struct ChatActionContext: Equatable {
    let owner: HostConnection
    let identity: String
    let runtimeId: String?
    let sessionId: String?

    var pageIdentity: ChatPageIdentity { .init(owner: ObjectIdentifier(owner), sessionIdentity: identity) }
    static func == (lhs: Self, rhs: Self) -> Bool { lhs.owner === rhs.owner && lhs.identity == rhs.identity }
    @MainActor static func capture(_ store: OrbisStore) -> Self {
        let runtime = store.selectedRuntime
        return Self(owner: store.activeConnection, identity: selectedIdentity(store),
            runtimeId: runtime?.runtimeId, sessionId: runtime?.sessionId)
    }
    /// The local session key of the current selection; empty when nothing is selected.
    @MainActor static func selectedIdentity(_ store: OrbisStore) -> String {
        store.selectedRuntime.map { localSessionKey(host: store.selectedHost, runtime: $0) } ?? ""
    }
    /// Cheap admission for hot callbacks: no action surface or fallback runtime lookup.
    @MainActor func isCurrent(in store: OrbisStore) -> Bool {
        store.activeConnection === owner && identity == Self.selectedIdentity(store)
    }
}

struct ChatRuntimeTarget: Equatable {
    let runtimeId: String
    let sessionId: String?
    init(_ runtime: RuntimeSummary) {
        runtimeId = runtime.runtimeId; sessionId = runtime.sessionId
    }
}

/// Navigation renders selection identity and Hub metadata, never runtime contents.
struct NavigationScreenSnapshot: Equatable {
    let target: ChatActionContext
    let runtime: ChatRuntimeTarget?
    let selectedHost: HostPairing?
    let pairings: [HostPairing]
    let selectedHostId: String?
    let runtimeIdentity: String?
    let selectedRuntimeId: String?
    let activationRevision: Int
    let pairing: Bool
    let error: String?
    let feedback: FeedbackState
    var source: HostConnection { target.owner }
    var actionContext: ChatActionContext { target }
    @MainActor init(store: OrbisStore) {
        target = .capture(store)
        runtime = store.selectedRuntime.map(ChatRuntimeTarget.init)
        selectedHost = store.selectedHost; pairings = store.pairings
        selectedHostId = store.selectedHostId; selectedRuntimeId = store.selectedRuntimeId
        runtimeIdentity = store.selectedRuntime == nil ? nil : target.identity
        activationRevision = store.activationRevision; pairing = store.isPairing; error = store.errorMessage; feedback = store.feedback
    }
}

/// IOS-CHAT-07: reading an immutable region value establishes its observation.
@MainActor @Observable
final class ChatScreenModel {
    @ObservationIgnored let visualActivity = ChatVisualActivity()
    @ObservationIgnored let viewport = ChatViewportController()
    @ObservationIgnored private var mountedToken: UUID?
    @ObservationIgnored private var moving = false
    @ObservationIgnored private var visible = true
    @ObservationIgnored private var foreground = true
    private(set) var shell: ChatShellState
    private(set) var header: ChatHeaderState
    private(set) var transcript: ChatTranscriptState
    @ObservationIgnored private(set) var transcriptInputRevision: UInt64 = 0
    private(set) var composer: ChatComposerState
    private(set) var notices: ChatNoticesState
    private(set) var workspace: ChatWorkspaceState
    private(set) var navigation: NavigationScreenSnapshot
    private(set) var canReadTranscript: Bool
    @ObservationIgnored private var actionTarget: ChatActionContext
    var actions: ChatSessionActions {
        guard let store else { preconditionFailure("A mounted chat model requires its store") }
        return ChatSessionActions(store: store, target: actionTarget, preservingRuntime: snapshot.runtime)
    }
    @ObservationIgnored private(set) var snapshot: ChatScreenSnapshot
    @ObservationIgnored private(set) var captureRevision = 0
    @ObservationIgnored private weak var store: OrbisStore?
    @ObservationIgnored private var sourceOwner: ObjectIdentifier
    @ObservationIgnored private var pageIdentity: String
    @ObservationIgnored private var observations: [AnyCancellable] = []
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var token = UUID()
    @ObservationIgnored private var held = false
    @ObservationIgnored private var dirty = false
    @ObservationIgnored private var rebindPending = false
    @ObservationIgnored private var navigationPending = false

    init(store: OrbisStore) {
        self.store = store
        let initial = ChatScreenSnapshot(store: store), nav = NavigationScreenSnapshot(store: store)
        snapshot = initial; navigation = nav
        actionTarget = nav.target
        canReadTranscript = initial.canSend
        let regions = Regions(snapshot: initial, target: nav.target)
        shell = regions.shell
        header = regions.header
        transcript = regions.transcript
        composer = regions.composer
        notices = regions.notices
        workspace = regions.workspace
        sourceOwner = ObjectIdentifier(store.activeConnection)
        pageIdentity = snapshot.identity
        viewport.commit(transcript)
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
        let identity = ChatActionContext.selectedIdentity(store)
        if owner != sourceOwner || identity != pageIdentity {
            token = UUID(); task?.cancel(); task = nil
            sourceOwner = owner; pageIdentity = identity; observe(store.activeConnection)
            rebindPending = true
            // Selection/opening already finished publishing the new source before calling
            // refresh(). Commit the rebind in this same turn so the first native mount sees
            // the new transcript. Waiting for schedule() would let the old transcript mount,
            // then reset the viewport during the entrance animation and reconfigure every row.
            commit(force: true)
            return
        }
        schedule()
    }
    /// A covered retained page keeps its viewport. A newly mounted native scroll
    /// view starts a fresh context even when it selects the same runtime/session.
    /// Prepare it before the native collection installs rows: resetting from the
    /// later appearance callback would reconfigure every freshly mounted cell.
    func prepareMount(target: ChatActionContext, token: UUID) {
        guard actionTarget == target, mountedToken != token else { return }
        mountedToken = token
        viewport.resetForMount()
        viewport.commit(transcript)
    }
    func mount(target: ChatActionContext, token: UUID, visible: Bool, foreground: Bool) {
        guard actionTarget == target else { return }
        prepareMount(target: target, token: token)
        visibilityChanged(target: target, visible: visible, foreground: foreground)
    }
    /// The unique mount token proves ownership. A selection change can replace the
    /// action target before the departing page disappears; it must still unmount.
    func unmount(target: ChatActionContext, token: UUID) {
        guard mountedToken == token else { return }
        mountedToken = nil
        visible = false
        reconcilePhase()
    }
    func motionChanged(_ active: Bool) {
        moving = active
        reconcilePhase()
        if !active && navigationPending { schedule() }
    }
    /// Runs on every native scroll callback; it builds no action surface.
    func ownsMount(target: ChatActionContext, token: UUID) -> Bool {
        guard mountedToken == token, actionTarget == target, let store else { return false }
        return target.isCurrent(in: store)
    }
    func visibilityChanged(target: ChatActionContext, token: UUID, visible: Bool, foreground: Bool) {
        guard ownsMount(target: target, token: token) else { return }
        visibilityChanged(target: target, visible: visible, foreground: foreground)
    }
    func visibilityChanged(target: ChatActionContext, visible: Bool, foreground: Bool) {
        guard actionTarget == target else { return }
        self.visible = visible; self.foreground = foreground
        reconcilePhase()
    }
    private func reconcilePhase() {
        let phase: ChatPagePhase = !foreground ? .background : (!visible ? .covered : (moving ? .moving : .active))
        visualActivity.set(phase)
        viewport.setVisualActive(phase.visualActive)
        // Navigation publications still need the hold after popping chat. A retained
        // covered chat keeps committing, while an unmounted page has no visible work.
        // OrbisHub owns the one bounded timer for both publication pipelines. Navigation
        // itself waits for motion to end even when chat is covered (see commit).
        hold(moving && (mountedToken == nil || (foreground && visible)))
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
            let identity = ChatActionContext.selectedIdentity(store)
            if ObjectIdentifier(store.activeConnection) != self.sourceOwner || identity != self.pageIdentity { self.refresh(); return }
            // A new page context replaces every regional snapshot together, even during
            // a transition; same-page streaming continues to respect the publication hold.
            guard !self.held || self.rebindPending else { return }
            self.commit(force: self.rebindPending)
        }
    }
    private func commit(force: Bool) {
        guard let store else { return }
        let interval = ChatSchedulingTrace.screenCommitBegan()
        var invalidated = 0
        defer { ChatSchedulingTrace.screenCommitEnded(interval, invalidatedRegions: invalidated) }
        captureRevision &+= 1
        dirty = false
        rebindPending = false
        let next = ChatScreenSnapshot(store: store), nav = NavigationScreenSnapshot(store: store)
        let regions = Regions(snapshot: next, target: nav.target)
        actionTarget = nav.target
        snapshot = next
        if canReadTranscript != next.canSend { canReadTranscript = next.canSend }
        // Explicit equality keeps this contract independent of the macro/toolchain.
        // PERF-10 / ADR-0082 R5: the root re-renders every mounted page. While pages move
        // above a covered chat, Hub facts wait for the motion to end. A new selection
        // commits at once, so the page identity never lags the action target.
        if force || navigation != nav {
            if !force && moving && nav.target == navigation.target && nav.runtime == navigation.runtime {
                navigationPending = true
            } else {
                invalidated |= ChatSchedulingTrace.RegionMask.navigation; navigation = nav
                navigationPending = false
            }
        } else { navigationPending = false }
        if force || shell != regions.shell { invalidated |= ChatSchedulingTrace.RegionMask.shell; shell = regions.shell }
        if force || header != regions.header { invalidated |= ChatSchedulingTrace.RegionMask.header; header = regions.header }
        if force || transcript != regions.transcript {
            invalidated |= ChatSchedulingTrace.RegionMask.transcript
            viewport.commit(regions.transcript)
            transcriptInputRevision &+= 1
            transcript = regions.transcript
        } else {
            // A fast completion can coalesce with the start without changing the transcript (e.g. retry returns the same error).
            viewport.reconcileHistoryLoading(regions.transcript.historyLoading)
        }
        if force || composer != regions.composer { invalidated |= ChatSchedulingTrace.RegionMask.composer; composer = regions.composer }
        if force || notices != regions.notices { invalidated |= ChatSchedulingTrace.RegionMask.notices; notices = regions.notices }
        if force || workspace != regions.workspace { invalidated |= ChatSchedulingTrace.RegionMask.workspace; workspace = regions.workspace }
    }
    private struct Regions {
        let shell: ChatShellState
        let header: ChatHeaderState
        let transcript: ChatTranscriptState
        let composer: ChatComposerState
        let notices: ChatNoticesState
        let workspace: ChatWorkspaceState
        init(snapshot s: ChatScreenSnapshot, target: ChatActionContext) {
            shell = .init(target: target, kind: s.kind, cached: s.cached)
            header = .init(target: target, kind: s.kind, displayName: s.displayName, connection: s.connection, syncing: s.syncing, modelReady: s.modelReady, executionReady: s.executionReady, modelSaveState: s.modelSaveState, modelSaveFailed: s.modelSaveFailed, runtimeFacts: s.runtime.map(ChatHeaderRuntimeFacts.init))
            transcript = .init(target: target, kind: s.kind, transcript: s.transcript, hasMessages: s.hasMessages, canSend: s.canSend, syncing: s.syncing, cached: s.cached, connection: s.connection, streaming: s.streaming, pending: s.pending, pendingActions: s.pendingActions, uploads: s.uploads, historyRevision: s.historyRevision, historyPageRevision: s.historyPageRevision, historyLoading: s.historyLoading, historyError: s.historyError, hasOlder: s.hasOlder, actionFeedback: s.actionFeedback, rewind: s.rewind, status: s.runtime?.status)
            composer = .init(target: target, kind: s.kind, canSend: s.canSend, cached: s.cached, connection: s.connection, draftRevision: s.draftRevision, commands: s.commands, pendingActions: s.pendingActions, attached: s.attached, preparing: s.preparing, contextReady: s.contextReady, cachedSession: s.cachedSession, activatingSessionId: s.activatingSessionId, runtime: s.runtime.map(ChatComposerRuntimeFacts.init), workingBranch: s.workingBranch.map(ChatWorkingBranch.init), inputError: s.inputError, menuErrors: s.menuErrors)
            notices = .init(target: target, notice: s.notice, connection: s.connection, launch: s.launch, isLaunchPage: s.isLaunchPage, supported: ["codex", "codexDesktop"].contains(s.runtime?.agentKind ?? ""))
            workspace = .init(target: target, host: s.host, requests: s.requests, responding: s.responding, interactionText: s.interactionText, interactionPending: s.interactionPending, queue: s.queue, queueCancellations: s.queueCancellations, canSend: s.canSend)
        }
    }
    func waitForPending() async { while let pending = task { await pending.value } }
}
