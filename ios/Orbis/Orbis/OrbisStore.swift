import Foundation
import Combine
#if canImport(UIKit)
import UIKit
#endif

@MainActor
final class HostConnection: ObservableObject {
    let transfers: FileTransfers
    let toolContent = ToolContentReader()
    let toolInventories = ToolInventories()
    let hostState = HostState()
    let agentState = AgentState()
    let notifications = RuntimeNotifications()
    @Published private(set) var pairings: [HostPairing] = []
    @Published private(set) var selectedHostId: String?
    @Published private(set) var runtimes: [RuntimeSummary] = []
    @Published private(set) var sessions: [SessionSummary] = [] {
        didSet { sessionIndex = Dictionary(sessions.map { ($0.sessionId, $0) }, uniquingKeysWith: { first, _ in first }) }
    }
    /// sessionId → 目录条目。聊天页每条消息、每次流式更新都会查询，不能线性扫描整个目录。
    private var sessionIndex: [String: SessionSummary] = [:]
    @Published private(set) var messages: [ChatMessage] = [] { didSet { transcriptCache = nil } }
    @Published private(set) var selectedRuntimeId: String?
    @Published private(set) var connection: ConnectionState = .offline
    @Published private(set) var activePath: String?
    @Published var errorMessage: String?
    @Published private(set) var isPairing = false
    @Published private(set) var isSyncing = false
    @Published private(set) var activatingSessionId: String?
    @Published private(set) var browse: DirectoryBrowse?
    @Published private(set) var commands: [String: [SlashCommand]] = [:]
    @Published private(set) var supportedAgents: [String]?
    @Published private(set) var launchableAgents: [String]?
    @Published private(set) var codexDesktop: CodexDesktopAttach?
    @Published private(set) var drafts: [String: String] = [:]
    @Published private(set) var aliases: [String: String] = [:]
    @Published private(set) var pathRTT: Double?
    @Published private(set) var activationRevision = 0
    @Published private(set) var pendingActionIds: Set<String> = []
    @Published private(set) var actionFeedback: String?
    @Published private(set) var workingBranches: [String: WorkingBranch] = [:]
    @Published private(set) var entryPreview: EntryPreview?
    @Published private(set) var historyRevision = 0
    @Published private(set) var interactions: [String: [InteractionRequest]] = [:]
    @Published private(set) var submittingInteractions: Set<String> = []
    @Published private(set) var queuedMessages: [String: [QueuedMessage]] = [:]
    @Published private(set) var pendingQueueCancellations: Set<String> = []
    @Published private(set) var hasOlderHistory: [String: Bool] = [:]
    @Published private(set) var historyLoading: Set<String> = []
    @Published private(set) var historyErrors: [String: String] = [:]
    @Published private(set) var historyPageRevision = 0
    @Published private(set) var pathPreference = defaultPathPreference
    @Published private(set) var currentProviders: [String: String] = [:]
    /// 仅供「原始事件」页查看；每收到一帧都会追加，不发布变更，免得每帧都让整棵视图树重绘。
    private(set) var connectionEvents: [String] = []

    private let secure: SecureStorage
    private let transport: OrbisTransport
    private let deviceName: String
    private let preferences: UserDefaults?
    let historyWorker: SessionHistoryWorker
    @Published private(set) var cachedSessionIds: Set<String> = []
    @Published private(set) var selectedOfflineSession: SessionSummary?
    @Published private(set) var cachedHistoryOptions: [RuntimeOption] = []
    @Published private(set) var turnTimings: [String: SessionTurnTiming] = [:] { didSet { transcriptCache = nil } }
    private var transcriptCache: ChatTranscript?
    /// Rows of the selected conversation, rebuilt only after its messages or timings change.
    var chatTranscript: ChatTranscript {
        if let transcriptCache { return transcriptCache }
        let built = ChatTranscript(messages: messages, turnTimings: turnTimings)
        transcriptCache = built
        return built
    }
    private var timingsBySession: [String: [String: SessionTurnTiming]] = [:]
    private var cachedIndexLoaded = false
    private var pendingEvents: [(message: [String: Any], channel: String?, bytes: Int)] = []
    private var pendingEventBytes = 0
    private var eventTask: Task<Void, Never>?
    private var backgroundTasks: [UUID: Task<Void, Never>] = [:]
    private var cacheLoading: [String: String] = [:]
    private(set) var sessionReads = SessionReadOperations()
    private var syncReads: [String: String] = [:]
    private var pendingReadPages: [String: SessionHistoryPage] = [:]
    private var pendingCatchups: [String: SessionCatchupGap] = [:]
    private var branchGenerations: [String: Int] = [:]
    private var historyWriteLeases: [String: SessionHistoryWriteLease] = [:]
    private var cleanupTask: Task<Void, Never>?
    private var graphs: [String: CachedSessionGraph] = [:]
    private var excludedDisplayEntries: [String: Set<String>] = [:]
    private var appliedBaselines: [String: SessionAppliedBaseline] = [:]
    private var retiredEpochs: [String: Set<String>] = [:]
    private var syncDemands: Set<String> = []
    private var lastOverflowRecovery: Date?
    private var browseTimeout: Task<Void, Never>?
    private var activationTimeout: Task<Void, Never>?
    private var activationRequestId: String?
    private var runtimeActions: [String: (runtimeId: String, name: String)] = [:]
    private var actionTimeouts: [String: Task<Void, Never>] = [:]
    private var feedbackTimeout: Task<Void, Never>?
    private var previewTimeout: Task<Void, Never>?
    private var branchEditorNode: String?
    private var interactionCommands: [String: String] = [:]
    private var queueCommands: [String: (runtimeId: String, queueId: String)] = [:]
    private var pendingBranchDrafts: [String: String] = [:]
    private var toolAcknowledgements: [String: (runtimeId: String, reference: ToolReference)] = [:]
    private var pendingAppliedBaselines: [String: SessionAppliedBaseline] = [:]
    private var pendingLiveBaselines: [String: (reference: ToolReference, baseline: SessionAppliedBaseline)] = [:]
    private var identity: DeviceIdentity?
    private var pairingTransport: RelayTransport?
    private var connectionGeneration = UUID()
    private var historyGeneration = UUID()
    private var historyConnected = false
    private var conversations: [String: [ChatMessage]] = [:]
    private var liveMessageIds: [String: Set<String>] = [:]
    // 宿主会从 live.messages 里去掉只含工具调用的消息，改由工具清单承载；这里记录还原它们所需的顺序和清单版本。
    private var liveOrders: [String: [String: Int64]] = [:]
    private var liveToolReferences: [String: ToolReference] = [:]
    private var liveTools: [String: [ToolSummary]] = [:]
    private var displayMessageIds: [String: [String: String]] = [:]
    // 运行时临时 id → 持久化 entry id（turn.finished.persistedMessages / live.persistedEntryId）。
    // Codex 用 App 的 clientId、Pi 用流式 id 上屏，落盘后 entry 才是权威行；靠这张映射退掉临时行，绝不按文本猜。
    private var messageAliases: [String: [String: String]] = [:]
    private var runtimeEventSequences: [String: Int64] = [:]
    private var pendingSyncs: [String: SessionSyncTransaction] = [:]
    private var oldestEntries: [String: String] = [:]
    private var sessionLeaves: [String: String] = [:]
    private var syncTimeouts: [String: Task<Void, Never>] = [:]
    private var syncedSessions: Set<String> = []
    private var pendingActivation: String?
    private var sourcePositions: [String: (epoch: String, seq: Int64)] = [:]
    private var sessionListRequest: String?
    private var snapshotCandidates: [String: SessionSnapshotReceipt] = [:]
    private var snapshotReceipts: [String: SessionSnapshotReceipt] = [:]
    private var authenticatedModelEpoch: String?
    var didUpdatePairing: ((HostPairing) -> Void)?
    private var modelCatalogReceived = false

    init(secure: SecureStorage = SecureStore.shared, transport: OrbisTransport? = nil, deviceName: String? = nil, autoConnect: Bool = true, preferences: UserDefaults? = .standard, transferRoot: URL? = nil, initialPairing: HostPairing? = nil, isolated: Bool = false, historyWorker: SessionHistoryWorker? = nil) {
        self.secure = secure
        self.transport = transport ?? RelayTransport()
        self.preferences = preferences
        let root = transferRoot ?? (preferences == nil ? FileManager.default.temporaryDirectory.appendingPathComponent("orbis-preview-" + UUID().uuidString) :
            FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("Orbis"))
        transfers = FileTransfers(root: root, pairing: initialPairing)
        self.historyWorker = historyWorker ?? SessionHistoryWorker(root: root.appendingPathComponent("SessionHistory", isDirectory: true))
        aliases = preferences?.dictionary(forKey: "orbis.sessionAliases") as? [String: String] ?? [:]
        drafts = preferences?.dictionary(forKey: "orbis.sessionDrafts") as? [String: String] ?? [:]
        pathPreference = normalizedPathPreference(preferences?.stringArray(forKey: "orbis.pathPreference") ?? [])
        #if canImport(UIKit)
        self.deviceName = deviceName ?? UIDevice.current.name
        #else
        self.deviceName = deviceName ?? "Orbis"
        #endif
        pairings = isolated ? initialPairing.map { [$0] } ?? [] : secure.pairings()
        selectedHostId = pairings.first?.hostId
        do { identity = try secure.deviceIdentity() }
        catch { errorMessage = error.localizedDescription }
        transfers.send = { [weak self] in self?.transport.send($0) ?? false }
        hostState.send = { [weak self] in self?.transport.send($0) ?? false }
        agentState.send = { [weak self] in self?.transport.send($0) ?? false }
        notifications.send = { [weak self] in self?.transport.send($0) ?? false }
        agentState.didProject = { [weak self] runtimeId, sessionId, domains in
            guard let self, let index = self.runtimes.firstIndex(where: { $0.runtimeId == runtimeId && $0.sessionId == sessionId }),
                  let hostId = self.selectedHostId,
                  let projection = AgentProjection.make(runtime: self.runtimes[index], hostId: hostId, domains: domains,
                    commands: self.commands[runtimeId] ?? [], interactions: self.interactions[runtimeId] ?? [], queuedMessages: self.queuedMessages[runtimeId] ?? []) else { return false }
            self.runtimes[index] = projection.runtime
            self.commands[runtimeId] = projection.commands
            self.interactions[runtimeId] = projection.interactions
            self.queuedMessages[runtimeId] = projection.queuedMessages
            let active = Set(self.interactions.values.joined().map(\.requestId))
            self.submittingInteractions.formIntersection(active)
            self.interactionCommands = self.interactionCommands.filter { active.contains($0.value) }
            self.updateSyncing()
            return true
        }
        hostState.didProject = { [weak self] domains in
            guard let self else { return }
            if let backends = domains["backends"], backends.availability == "ready" {
                // A missing list means unknown (no restriction), the same as Android; never "nothing can start".
                self.supportedAgents = backends.value["agents"].isArray ? backends.value["agents"].array.compactMap(\.string) : nil
                self.launchableAgents = backends.value["launchableAgents"].isArray ? backends.value["launchableAgents"].array.compactMap(\.string) : nil
                self.codexDesktop = backends.value["codexDesktop"].decoded(CodexDesktopAttach.self).flatMap { $0.valid ? $0 : nil }
            }
        }
        hostState.didChangeCatalog = { [weak self] incoming, completeKinds in
            guard let self else { return }
            self.modelCatalogReceived = true
            let online = Set(self.runtimes.compactMap(\.sessionId))
            var merged = Dictionary(self.sessions.filter { item in
                !completeKinds.contains(item.agentKind ?? "") || online.contains(item.sessionId) || self.graphs[item.sessionId] != nil ||
                !self.cachedIndexLoaded || self.cachedSessionIds.contains(item.sessionId)
            }.map { ($0.sessionId, $0) }, uniquingKeysWith: { _, last in last })
            for item in incoming { merged[item.sessionId] = item }
            self.sessions = merged.values.sorted { $0.modifiedAt > $1.modifiedAt }
            self.persistSessions()
        }
        hostState.didChangeProviders = { [weak self] in self?.refreshSessions() }
        transfers.sendBinary = { [weak self] in self?.transport.sendBinary($0) ?? false }
        toolContent.send = { [weak self] runtime, command in self?.sendCommand(runtimeId: runtime, command: command) ?? false }
        toolInventories.send = { [weak self] runtime, command in self?.sendCommand(runtimeId: runtime, command: command) ?? false }
        toolInventories.didCover = { [weak self] runtime, _ in
            guard let self else { return }
            if let pending = self.pendingLiveBaselines[runtime], self.toolInventories.covers(pending.reference, runtime: runtime),
               self.sourcePositions[runtime]?.epoch == pending.baseline.epoch, self.sourcePositions[runtime]?.seq == pending.baseline.seq {
                self.appliedBaselines[runtime] = pending.baseline; self.pendingLiveBaselines[runtime] = nil
            }
            let ids = self.toolAcknowledgements.filter { $0.value.runtimeId == runtime && self.toolInventories.covers($0.value.reference, runtime: runtime) }.map(\.key)
            for id in ids {
                self.toolAcknowledgements[id] = nil
                if let baseline = self.pendingAppliedBaselines.removeValue(forKey: id), self.sourcePositions[runtime]?.epoch == baseline.epoch, self.sourcePositions[runtime]?.seq == baseline.seq { self.appliedBaselines[runtime] = baseline }
                if let page = self.pendingReadPages.removeValue(forKey: id), let summary = self.runtimes.first(where: { $0.runtimeId == runtime }) {
                    self.completeRemoteRead(id, runtime: summary, page: page, sourceConfirmed: self.appliedBaselines[runtime] != nil)
                    self.beginCatchup(summary)
                }
                self.acknowledge(runtimeId: runtime, syncId: id, result: "applied")
            }
            if !self.toolInventories.loading.contains(runtime) {
                let uncovered = self.toolAcknowledgements.filter { $0.value.runtimeId == runtime }.map(\.key)
                for id in uncovered {
                    self.toolAcknowledgements[id] = nil; self.pendingAppliedBaselines[id] = nil; self.pendingReadPages[id] = nil
                    if let read = self.syncReads.removeValue(forKey: id) { self.sessionReads.finish(read, phase: .failed, error: "工具清单已更新，请重新同步。") }
                    self.acknowledge(runtimeId: runtime, syncId: id, result: "rejected")
                }
            }
            self.updateSyncing(); self.dispatchSyncDemands()
            if runtime == self.selectedRuntimeId { self.publishMessages() }
        }
        toolInventories.didFail = { [weak self] runtime, _, message in
            guard let self else { return }
            self.pendingLiveBaselines[runtime] = nil
            let ids = self.toolAcknowledgements.filter { $0.value.runtimeId == runtime }.map(\.key)
            for id in ids {
                self.toolAcknowledgements[id] = nil; self.pendingAppliedBaselines[id] = nil; self.pendingReadPages[id] = nil
                if let read = self.syncReads.removeValue(forKey: id) { self.sessionReads.finish(read, phase: .failed, error: message) }
                self.acknowledge(runtimeId: runtime, syncId: id, result: "rejected")
            }
            if !ids.isEmpty { self.errorMessage = message; self.updateSyncing(); self.dispatchSyncDemands() }
        }
        if autoConnect, let selectedHostId { connect(hostId: selectedHostId) }
    }

    var selectedHost: HostPairing? { pairings.first { $0.hostId == selectedHostId } }
    var selectedRuntime: RuntimeSummary? {
        if let session = selectedOfflineSession {
            return RuntimeSummary(runtimeId: "cached:" + session.sessionId, name: session.name ?? session.sessionId,
                cwd: session.cwd, status: "offline", sessionId: session.sessionId, sessionName: session.name,
                hostname: session.hostname, agentKind: session.agentKind)
        }
        return runtimes.first { $0.runtimeId == selectedRuntimeId }
    }
    var canSend: Bool { connection == .secured && selectedOfflineSession == nil && selectedRuntime != nil }

    func displayName(_ runtime: RuntimeSummary) -> String {
        sessionTitle(alias: aliases[localSessionKey(host: selectedHost, runtime: runtime)], runtime: runtime,
                     session: runtime.sessionId.flatMap { sessionIndex[$0] }, messages: conversations[runtime.runtimeId] ?? [])
    }

    func displayName(_ session: SessionSummary) -> String {
        if let runtime = runtimes.first(where: { $0.sessionId == session.sessionId }) { return displayName(runtime) }
        return sessionTitle(alias: aliases[offlineAliasKey(host: selectedHost, sessionId: session.sessionId)], runtime: nil, session: session)
    }

    func alias(for runtime: RuntimeSummary) -> String { aliases[localSessionKey(host: selectedHost, runtime: runtime)] ?? "" }
    func setAlias(_ alias: String, for runtime: RuntimeSummary) {
        aliases = preferences?.dictionary(forKey: "orbis.sessionAliases") as? [String: String] ?? aliases
        aliases[localSessionKey(host: selectedHost, runtime: runtime)] = normalizedAlias(alias)
        if let session = runtime.sessionId { aliases[offlineAliasKey(host: selectedHost, sessionId: session)] = normalizedAlias(alias) }
        preferences?.set(aliases, forKey: "orbis.sessionAliases")
    }
    func draft(for runtime: RuntimeSummary) -> String { drafts[localSessionKey(host: selectedHost, runtime: runtime)] ?? "" }
    func saveDraft(_ text: String, for runtime: RuntimeSummary) {
        let key = localSessionKey(host: selectedHost, runtime: runtime)
        drafts = preferences?.dictionary(forKey: "orbis.sessionDrafts") as? [String: String] ?? drafts
        drafts[key] = text.isEmpty ? nil : text
        preferences?.set(drafts, forKey: "orbis.sessionDrafts")
    }

    func purgeLocalData() {
        guard let hostId = selectedHostId else { return }
        drafts = preferences?.dictionary(forKey: "orbis.sessionDrafts") as? [String: String] ?? drafts
        aliases = preferences?.dictionary(forKey: "orbis.sessionAliases") as? [String: String] ?? aliases
        if let host = pairings.first(where: { $0.hostId == hostId }) {
            transfers.removeAll(for: host)
            let prefix = hostKeyPrefix(host)
            if let data = preferences?.data(forKey: "orbis.interactionDrafts.v1"),
               let stored = try? JSONDecoder().decode([String: InteractionDraftValue].self, from: data),
               let filtered = try? JSONEncoder().encode(stored.filter { !$0.key.hasPrefix(prefix) }) {
                preferences?.set(filtered, forKey: "orbis.interactionDrafts.v1")
            }
            preferences?.removeObject(forKey: sessionCacheKey(host))
            preferences?.removeObject(forKey: lastSessionKey(host))
            historyWorker.invalidate(host: host)
            cleanupTask = Task { [historyWorker] in try? await historyWorker.remove(host: host) }
            drafts = drafts.filter { !$0.key.hasPrefix(prefix) }
            preferences?.set(drafts, forKey: "orbis.sessionDrafts")
            aliases = aliases.filter { !$0.key.hasPrefix(prefix) }
            preferences?.set(aliases, forKey: "orbis.sessionAliases")
        }
        pairings = []
        guard selectedHostId == hostId else { return }
        connectionGeneration = UUID()
        cancelPendingWork()
        if let host = selectedHost { historyWorker.invalidate(host: host) }
        transport.disconnect()
        clearSyncs(); dismissBrowse(); clearActivation()
        conversations = [:]; messages = []; runtimes = []; sessions = []; commands = [:]
        selectedRuntimeId = nil; selectedHostId = nil; activePath = nil; pathRTT = nil; connection = .offline
        currentProviders = [:]; sessionListRequest = nil; modelCatalogReceived = false; authenticatedModelEpoch = nil; connectionEvents = []
        transfers.setConnection(nil, connected: false)
        hostState.setConnection(nil, connected: false)
        agentState.setConnection(nil, connected: false)
        notifications.setConnection(nil, connected: false)
        toolContent.close(); toolInventories.clear(); toolAcknowledgements = [:]; pendingAppliedBaselines = [:]
        interactions = [:]; queuedMessages = [:]; queueCommands = [:]; pendingQueueCancellations = []; submittingInteractions = []; interactionCommands = [:]; workingBranches = [:]; dismissPreview()
    }

    func shutdown() {
        connectionGeneration = UUID()
        cancelPendingWork()
        if let host = selectedHost { historyWorker.invalidate(host: host) }
        transport.disconnect()
        clearSyncs(); dismissBrowse(); clearActivation(); dismissPreview()
        actionTimeouts.values.forEach { $0.cancel() }; actionTimeouts = [:]
        transfers.setConnection(selectedHost, connected: false)
        hostState.setConnection(selectedHost, connected: false)
        agentState.setConnection(selectedHost, connected: false)
        notifications.setConnection(selectedHost, connected: false)
        toolContent.close(); toolInventories.clear()
        connection = .offline
    }

    func connect(hostId: String) {
        guard let pairing = pairings.first(where: { $0.hostId == hostId }), let identity else { return }
        connect(pairing: pairing, identity: identity)
    }

    func reconnectSelectedHost() {
        if let selectedHostId { connect(hostId: selectedHostId) }
    }

    private func connect(pairing: HostPairing, identity: DeviceIdentity) {
        connectionGeneration = UUID()
        cancelPendingWork()
        historyGeneration = UUID(); historyConnected = false
        historyWorker.setGeneration(historyGeneration, host: pairing)
        let generation = connectionGeneration
        selectedHostId = pairing.hostId
        connection = .connecting
        hostState.setConnection(pairing, connected: false)
        agentState.setConnection(pairing, connected: false)
        notifications.setConnection(pairing, connected: false)
        currentProviders = [:]; sessionListRequest = nil; modelCatalogReceived = false; authenticatedModelEpoch = nil; connectionEvents = []
        transfers.setConnection(pairing, connected: false)
        toolContent.close(); toolInventories.clear(); toolAcknowledgements = [:]; pendingAppliedBaselines = [:]
        runtimes = []; sessions = cachedSessions(pairing); messages = []; selectedRuntimeId = nil; selectedOfflineSession = nil
        cachedSessionIds = []; cachedIndexLoaded = false; cachedHistoryOptions = []; turnTimings = [:]; timingsBySession = [:]
        loadCachedIndex(pairing)
        conversations = [:]; liveMessageIds = [:]; displayMessageIds = [:]; messageAliases = [:]; excludedDisplayEntries = [:]
        liveOrders = [:]; liveToolReferences = [:]; liveTools = [:]
        oldestEntries = [:]; sessionLeaves = [:]; hasOlderHistory = [:]; historyErrors = [:]; historyLoading = []
        sourcePositions = [:]; appliedBaselines = [:]; retiredEpochs = [:]; graphs = [:]; runtimeEventSequences = [:]
        pendingActivation = nil; activePath = nil
        interactions = [:]; queuedMessages = [:]; queueCommands = [:]; pendingQueueCancellations = []; interactionCommands = [:]; submittingInteractions = []
        workingBranches = [:]; dismissPreview()
        actionTimeouts.values.forEach { $0.cancel() }; actionTimeouts = [:]; runtimeActions = [:]; pendingActionIds = []; setActionFeedback(nil)
        pathRTT = nil; commands = [:]; supportedAgents = nil; launchableAgents = nil; codexDesktop = nil
        dismissBrowse(); clearActivation()
        clearSyncs()
        transport.connect(pairing: pairing, identity: identity, receive: { [weak self] message, channel in
            guard let self, self.connectionGeneration == generation else { return }
            self.receive(message, channel: channel)
        }, state: { [weak self] state, error in
            guard let self, self.connectionGeneration == generation else { return }
            self.setHistoryConnection(state == .secured)
            self.connection = state
            self.recordConnectionEvent("连接：\(state.rawValue)")
            self.transfers.setConnection(self.selectedHost, connected: state == .secured)
            if state != .secured { self.hostState.setConnection(self.selectedHost, connected: false); self.agentState.setConnection(self.selectedHost, connected: false); self.notifications.setConnection(self.selectedHost, connected: false) }
            if state == .offline || state == .connecting {
                self.toolContent.close()
                self.activePath = nil
                self.runtimeEventSequences = [:]
                self.sourcePositions = [:]
                self.appliedBaselines = [:]
                self.clearSyncs()
            }
            // Transient reconnect errors stay in the connection indicator.
            if state == .error, let error { self.errorMessage = error }
        })
    }

    func selectRuntime(_ runtimeId: String) {
        guard runtimes.contains(where: { $0.runtimeId == runtimeId }) else { return }
        if selectedRuntimeId != runtimeId { toolContent.close() }
        selectedRuntimeId = runtimeId; selectedOfflineSession = nil; cachedHistoryOptions = []
        cancelForegroundReads(except: runtimeId)
        if let runtime = selectedRuntime { seedCachedHistory(runtime) }
        publishMessages()
        if let runtime = selectedRuntime { saveLastSession(runtime); agentState.subscribe(runtime: runtime); syncSession(runtime, force: true) }
        refreshWorkingBranch()
    }

    func refreshWorkingBranch() {
        guard canSend, let runtime = selectedRuntime else { return }
        let id = UUID().uuidString
        let branch = workingBranches[runtime.runtimeId].flatMap { $0.cwd == runtime.cwd && $0.sessionId == runtime.sessionId ? $0 : nil }
        let next = WorkingBranch(requestId: id, sessionId: runtime.sessionId, cwd: runtime.cwd,
                                 branch: branch?.branch, commit: branch?.commit, loaded: branch?.loaded ?? false)
        workingBranches[runtime.runtimeId] = next
        _ = transport.send(["type": "runtime.git.request", "protocolVersion": orbisProtocolVersion, "runtimeId": runtime.runtimeId, "requestId": id])
    }

    func previewEntry(_ entryId: String) {
        guard let runtime = selectedRuntime, let sessionId = runtime.sessionId else { return }
        let entryId = displayMessageIds[runtime.runtimeId]?.first(where: { $0.value == entryId })?.key ?? entryId
        if selectedOfflineSession != nil || connection != .secured {
            guard let host = selectedHost else { return }
            let id = UUID().uuidString, generation = connectionGeneration
            entryPreview = EntryPreview(requestId: id, runtimeId: runtime.runtimeId, sessionId: sessionId, entryId: entryId)
            runBackground { [weak self] in
                guard let self else { return }
                let page = try? await self.historyWorker.page(host: host, sessionId: sessionId, leafId: entryId, limit: 1)
                guard generation == self.connectionGeneration, self.entryPreview?.requestId == id else { return }
                self.entryPreview?.message = page?.messages.last
                self.entryPreview?.loading = false
                if self.entryPreview?.message == nil { self.entryPreview?.error = "此节点没有可显示的缓存内容。" }
            }
            return
        }
        guard canSend else { return }
        previewTimeout?.cancel()
        let id = UUID().uuidString
        entryPreview = EntryPreview(requestId: id, runtimeId: runtime.runtimeId, sessionId: sessionId, entryId: entryId)
        guard sendCommand(runtimeId: runtime.runtimeId, commandId: id, command: ["type": "session.entry.request", "requestId": id,
                     "sessionId": sessionId, "entryId": entryId]) else {
            entryPreview?.loading = false; entryPreview?.error = "预览请求未送达。"; return
        }
        previewTimeout = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 20_000_000_000) } catch { return }
            guard let self, self.entryPreview?.requestId == id else { return }
            self.entryPreview?.loading = false; self.entryPreview?.error = "预览读取超时，请重试。"
        }
    }

    func dismissPreview() { previewTimeout?.cancel(); entryPreview = nil }

    func moveHistory(to option: RuntimeOption) -> Bool {
        guard runtimeActions.isEmpty else { return false }
        branchEditorNode = option.tree?.role == "user" ? option.value : nil
        return executeSlash("tree", args: option.value)
    }

    @discardableResult
    func respond(_ request: InteractionRequest, response: [String: Any]) -> Bool {
        guard connection == .secured, request.expiresAt > Int64(Date().timeIntervalSince1970 * 1000),
              !submittingInteractions.contains(request.requestId), request.acceptsResponse(response),
              interactions[request.runtimeId]?.contains(where: { $0 == request && $0.submitted != true }) == true else { return false }
        let id = UUID().uuidString
        guard sendCommand(runtimeId: request.runtimeId, commandId: id, command: ["type": "interaction.respond", "requestId": request.requestId,
                        "extensionId": request.extensionId, "response": response]) else {
            errorMessage = "交互响应未送达，请连接后重试。"; return false
        }
        interactionCommands[id] = request.requestId; submittingInteractions.insert(request.requestId)
        return true
    }

    func refresh() {
        if connection == .secured {
            hostState.refresh()
            refreshSessions()
            if let selectedRuntime { agentState.subscribe(runtime: selectedRuntime, force: true); syncSession(selectedRuntime, force: true) }
        } else { reconnectSelectedHost() }
    }

    private func syncSession(_ runtime: RuntimeSummary, force: Bool = false) {
        guard connection == .secured, let sessionId = runtime.sessionId,
              runtimes.contains(where: { $0.runtimeId == runtime.runtimeId && $0.sessionId == sessionId }) else { return }
        let key = "\(runtime.runtimeId)|\(sessionId)"
        if force { sessionReads.requestSource(historyKey: runtime.runtimeId) }
        if toolAcknowledgements.values.contains(where: { $0.runtimeId == runtime.runtimeId }) {
            if force { syncDemands.insert(runtime.runtimeId) }; return
        }
        if pendingSyncs.values.contains(where: { $0.runtimeId == runtime.runtimeId && $0.range != "catchup" && !$0.exhausted }) {
            if force { syncDemands.insert(runtime.runtimeId) }
            return
        }
        guard force || !syncedSessions.contains(key) else { return }
        if let (id, value) = pendingSyncs.first(where: { $0.value.runtimeId == runtime.runtimeId && $0.value.sessionId == sessionId && $0.value.range == "preview" && $0.value.exhausted }) {
            guard recoverRead(id, runtime: runtime) else { finishSync(id); syncSession(runtime, force: true); return }
            var task = value
            let now = Date()
            task.exhausted = false; task.attempts = 1; task.firstSentAt = now; task.sentAt = now; task.deadline = now.addingTimeInterval(150)
            pendingSyncs[id] = task
            _ = sendCommand(runtimeId: task.runtimeId, commandId: task.commandId, command: task.command)
            armSyncTimeout(id, seconds: 30); updateSyncing(); return
        }
        seedCachedHistory(runtime)
        let syncId = UUID().uuidString, commandId = "session-sync:" + UUID().uuidString
        var command: [String: Any] = ["type": "session.sync", "sessionId": sessionId, "syncId": syncId, "range": "preview", "maxEntries": 30]
        let known = appliedBaselines[runtime.runtimeId]
        if let known { command["knownState"] = known.wire }
        guard let owner = readOwner(runtime), let operation = sessionReads.begin(kind: .source, owner: owner, targetLeafId: nil).operationId else { return }
        startSync(syncId, runtime: runtime, commandId: commandId, range: "preview", boundary: nil, leaf: nil, command: command, known: known, readId: operation)
    }

    private func startSync(_ syncId: String, runtime: RuntimeSummary, commandId: String, range: String, boundary: String?, leaf: String?, command: [String: Any], known: SessionAppliedBaseline?, readId: String) {
        if pendingSyncs.count >= 32, let oldest = pendingSyncs.filter({ $0.value.exhausted }).min(by: { $0.value.firstSentAt < $1.value.firstSentAt })?.key { finishSync(oldest) }
        guard let sessionId = runtime.sessionId, let owner = readOwner(runtime), pendingSyncs.count < 32,
              sessionReads.bindRemote(readId, commandId: commandId, current: owner),
              sendCommand(runtimeId: runtime.runtimeId, commandId: commandId, command: command) else {
            sessionReads.finish(readId, phase: .failed, error: "读取请求未送达。"); return
        }
        syncReads[syncId] = readId
        let now = Date()
        pendingSyncs[syncId] = SessionSyncTransaction(runtimeId: runtime.runtimeId, sessionId: sessionId,
            commandId: commandId, range: range, boundary: boundary, leaf: leaf, command: command, known: known,
            firstSentAt: now, sentAt: now, deadline: now.addingTimeInterval(150))
        syncDemands.remove(runtime.runtimeId)
        armSyncTimeout(syncId, seconds: 30)
        updateSyncing()
    }

    @discardableResult
    func loadOlderHistory() -> Bool {
        guard let runtime = selectedRuntime, let sessionId = runtime.sessionId, let owner = readOwner(runtime),
              !historyLoading.contains(runtime.runtimeId), let boundary = oldestEntries[runtime.runtimeId],
              hasOlderHistory[runtime.runtimeId] == true,
              !pendingSyncs.values.contains(where: { $0.runtimeId == runtime.runtimeId && $0.range != "catchup" && !$0.exhausted }) else { return false }
        if let (id, value) = pendingSyncs.first(where: { $0.value.runtimeId == runtime.runtimeId && $0.value.sessionId == sessionId && $0.value.range == "history" && $0.value.boundary == boundary && $0.value.leaf == sessionLeaves[runtime.runtimeId] && $0.value.exhausted }), recoverRead(id, runtime: runtime) {
            var task = value
            let now = Date()
            task.exhausted = false; task.attempts = 1; task.firstSentAt = now; task.sentAt = now; task.deadline = now.addingTimeInterval(150)
            pendingSyncs[id] = task
            guard sendCommand(runtimeId: task.runtimeId, commandId: task.commandId, command: task.command) else {
                finishSync(id); historyErrors[runtime.runtimeId] = "历史读取请求未送达。"; return false
            }
            historyLoading.insert(runtime.runtimeId); historyErrors[runtime.runtimeId] = nil
            armSyncTimeout(id, seconds: 30); updateSyncing(); return true
        }
        guard let host = selectedHost, let operation = sessionReads.begin(kind: .history, owner: owner,
            targetLeafId: sessionLeaves[runtime.runtimeId], beforeEntryId: boundary).operationId else { return false }
        historyLoading.insert(runtime.runtimeId); historyErrors[runtime.runtimeId] = nil
        runBackground { [weak self] in
            guard let self else { return }
            do {
                let page = try await self.historyWorker.page(host: host, sessionId: sessionId,
                    leafId: self.sessionReads.operations[operation]?.targetLeafId, beforeEntryId: boundary, limit: 30)
                guard let current = self.readOwner(runtime), self.sessionReads.owns(operation, current: current) else { return }
                let effect = self.sessionReads.localResult(operation, page: page, current: current)
                self.applyReadEffect(effect, operation: operation, runtime: runtime)
            } catch { self.failRead(operation, runtime: runtime, message: "本地历史读取失败，请重试。") }
        }
        return true
    }

    private func requestOlderHistory(_ runtime: RuntimeSummary, sessionId: String, boundary: String, operation: String) {
        let sync = UUID().uuidString, command = "session-sync:" + UUID().uuidString
        let leaf = sessionReads.operations[operation]?.targetLeafId
        var body: [String: Any] = ["type": "session.sync", "sessionId": sessionId, "syncId": sync,
                                  "range": "history", "beforeEntryId": boundary, "maxEntries": 30]
        if let leaf { body["targetLeafId"] = leaf }
        startSync(sync, runtime: runtime, commandId: command, range: "history", boundary: boundary,
                  leaf: leaf, command: body, known: nil, readId: operation)
        guard pendingSyncs[sync] != nil else {
            historyLoading.remove(runtime.runtimeId); historyErrors[runtime.runtimeId] = "历史读取请求未送达。"; return
        }
        historyErrors[runtime.runtimeId] = nil; historyLoading.insert(runtime.runtimeId)
    }

    private func readOwner(_ runtime: RuntimeSummary) -> SessionReadOwner? {
        guard let host = selectedHost, let session = runtime.sessionId,
              runtimes.contains(where: { $0.runtimeId == runtime.runtimeId && $0.sessionId == session }) ||
              (selectedOfflineSession?.sessionId == session && selectedRuntimeId == runtime.runtimeId) else { return nil }
        return SessionReadOwner(hostKey: hostKeyPrefix(host), deviceId: host.relay.deviceId,
            historyKey: runtime.runtimeId, sessionId: session, branchGeneration: branchGenerations[runtime.runtimeId] ?? 0,
            cacheEpoch: graphs[session]?.epoch, connectionGeneration: historyGeneration, selected: selectedRuntimeId == runtime.runtimeId)
    }

    private func cancelForegroundReads(except key: String?) {
        sessionReads.cancelForeground(except: key)
        let obsolete = syncReads.filter { sessionReads.operations[$0.value]?.phase == .cancelled }.map(\.key)
        for id in obsolete { finishSync(id) }
        historyLoading = historyLoading.filter { $0 == key }
    }

    private func recoverRead(_ syncId: String, runtime: RuntimeSummary) -> Bool {
        guard let id = syncReads[syncId], let task = pendingSyncs[syncId], let owner = readOwner(runtime) else { return false }
        if sessionReads.owns(id, current: owner) { return true }
        guard let recovered = sessionReads.recoverLate(id, commandId: task.commandId, current: owner) else { return false }
        syncReads[syncId] = recovered; return true
    }

    private func failRead(_ id: String, runtime: RuntimeSummary, message: String) {
        guard let owner = readOwner(runtime), sessionReads.owns(id, current: owner) else { return }
        let kind = sessionReads.operations[id]?.kind
        sessionReads.finish(id, phase: .failed, error: message)
        if kind == .history { historyLoading.remove(runtime.runtimeId); historyErrors[runtime.runtimeId] = message }
        else if kind != .catchup { errorMessage = message }
    }

    private func completeRemoteRead(_ syncId: String, runtime: RuntimeSummary, page: SessionHistoryPage, sourceConfirmed: Bool = false) {
        guard let id = syncReads[syncId], let owner = readOwner(runtime),
              let command = sessionReads.operations[id]?.commandId else { return }
        let effect = sessionReads.committedRemoteResult(id, commandId: command, page: page, current: owner, sourceConfirmed: sourceConfirmed)
        syncReads[syncId] = nil
        applyReadEffect(effect, operation: id, runtime: runtime)
    }

    private func applyReadEffect(_ effect: SessionReadEffect, operation: String, runtime: RuntimeSummary) {
        guard let session = runtime.sessionId else { return }
        let kind = sessionReads.operations[operation]?.kind
        switch effect {
        case .apply(let page):
            if kind == .history || kind == .firstPage {
                installCachedPage(page, runtimeId: runtime.runtimeId, sessionId: session, replacing: kind == .firstPage)
                if selectedOfflineSession != nil { updateCachedOptions(page.graph) }
            }
        case .requestHistory(let before, _):
            if canSend { requestOlderHistory(runtime, sessionId: session, boundary: before, operation: operation) }
            else { failRead(operation, runtime: runtime, message: "更早的历史尚未缓存，连接原会话后可继续同步。") }
        case .requestSource:
            if kind == .firstPage { sessionReads.finish(operation, phase: .succeeded) }
            if selectedOfflineSession == nil, connection == .secured,
               !pendingSyncs.values.contains(where: { $0.runtimeId == runtime.runtimeId && $0.range == "preview" && !$0.exhausted }) { syncSession(runtime, force: true) }
            else if selectedOfflineSession != nil { errorMessage = "这份会话还没有完整的本地历史缓存。" }
        case .requestCatchup(let gap): requestCatchup(runtime, operation: operation, gap: gap)
        case .none: break
        }
        if sessionReads.operations[operation]?.phase.active == false, kind == .history { historyLoading.remove(runtime.runtimeId) }
        updateSyncing()
    }

    private func requestCatchup(_ runtime: RuntimeSummary, operation: String, gap: SessionCatchupGap) {
        pendingCatchups[operation] = gap
        pumpCatchups()
    }

    private func pumpCatchups() {
        for id in Array(pendingCatchups.keys) {
            guard let read = sessionReads.operations[id], read.phase.active,
                  let runtime = runtimes.first(where: { $0.runtimeId == read.owner.historyKey && $0.sessionId == read.owner.sessionId }),
                  let owner = readOwner(runtime), sessionReads.owns(id, current: owner) else {
                sessionReads.finish(id, phase: .superseded); pendingCatchups[id] = nil; continue
            }
        }
        guard connection == .secured,
              !pendingSyncs.values.contains(where: { $0.range == "catchup" && !$0.exhausted }) else { return }
        guard let (operation, gap) = pendingCatchups.min(by: { (sessionReads.operations[$0.key]?.startedAt ?? .distantFuture) < (sessionReads.operations[$1.key]?.startedAt ?? .distantFuture) }),
              let read = sessionReads.operations[operation], let runtime = runtimes.first(where: { $0.runtimeId == read.owner.historyKey && $0.sessionId == read.owner.sessionId }),
              let session = runtime.sessionId else { return }
        pendingCatchups[operation] = nil
        let sync = UUID().uuidString, command = "session-sync:" + UUID().uuidString
        var body: [String: Any] = ["type": "session.sync", "sessionId": session, "syncId": sync,
            "range": "catchup", "targetLeafId": gap.targetLeafId, "maxEntries": 128]
        if let known = gap.knownLeafId { body["knownLeafId"] = known }
        startSync(sync, runtime: runtime, commandId: command, range: "catchup", boundary: nil,
            leaf: gap.targetLeafId, command: body, known: nil, readId: operation)
    }

    private func beginCatchup(_ runtime: RuntimeSummary) {
        guard let host = selectedHost, let session = runtime.sessionId, let target = sessionLeaves[runtime.runtimeId],
              let owner = readOwner(runtime) else { return }
        let acceptance = sessionReads.begin(kind: .catchup, owner: owner, targetLeafId: target)
        guard let operation = acceptance.operationId, !acceptance.merged else { return }
        runBackground { [weak self] in
            guard let self else { return }
            do {
                let page = try await self.historyWorker.page(host: host, sessionId: session, leafId: target, limit: 1)
                guard let current = self.readOwner(runtime), self.sessionReads.owns(operation, current: current) else { return }
                if page.targetCovered { self.sessionReads.finish(operation, phase: .succeeded) }
                else if let gap = page.coverageGap { self.requestCatchup(runtime, operation: operation, gap: gap) }
                else { self.failRead(operation, runtime: runtime, message: "历史补齐范围无法确认。") }
            } catch { self.failRead(operation, runtime: runtime, message: "历史补齐读取失败。") }
        }
    }

    var isViewingCachedSession: Bool { selectedOfflineSession != nil }

    @discardableResult
    func openCachedSession(_ session: SessionSummary) -> Bool {
        guard let host = selectedHost else { return false }
        toolContent.close(); dismissPreview()
        selectedOfflineSession = session; selectedRuntimeId = "cached:" + session.sessionId
        cancelForegroundReads(except: selectedRuntimeId)
        branchGenerations[selectedRuntimeId!, default: 0] += 1
        messages = []; cachedHistoryOptions = []; activationRevision += 1
        let generation = connectionGeneration
        guard let runtime = selectedRuntime, let owner = readOwner(runtime),
              let operation = sessionReads.begin(kind: .firstPage, owner: owner, targetLeafId: nil).operationId else { return false }
        runBackground { [weak self] in
            guard let self else { return }
            do {
                let page = try await self.historyWorker.page(host: host, sessionId: session.sessionId, limit: 30)
                guard generation == self.connectionGeneration, self.selectedOfflineSession?.sessionId == session.sessionId,
                      let current = self.readOwner(runtime) else { return }
                let effect = self.sessionReads.localResult(operation, page: page, current: current)
                self.applyReadEffect(effect, operation: operation, runtime: runtime)
                let branches = try await self.historyWorker.branches(host: host, sessionId: session.sessionId)
                guard generation == self.connectionGeneration, self.selectedOfflineSession?.sessionId == session.sessionId else { return }
                for branch in branches where !self.cachedHistoryOptions.contains(where: { $0.value == branch.leafId }) {
                    self.cachedHistoryOptions.append(RuntimeOption(value: branch.leafId, label: branch.message?.text ?? branch.leafId,
                        description: branch.timestamp, tree: .init(parentId: nil, entryType: "message", role: branch.message?.role,
                            label: nil, defaultHidden: false, isCurrent: false, isOnActivePath: false)))
                }
            } catch { if generation == self.connectionGeneration { self.errorMessage = error.localizedDescription } }
        }
        return true
    }

    func selectCachedBranch(_ leafId: String) {
        guard let session = selectedOfflineSession, let host = selectedHost, let runtimeId = selectedRuntimeId else { return }
        branchGenerations[runtimeId, default: 0] += 1
        historyLoading.remove(runtimeId)
        guard let runtime = selectedRuntime, let owner = readOwner(runtime),
              let operation = sessionReads.begin(kind: .firstPage, owner: owner, targetLeafId: leafId).operationId else { return }
        let generation = connectionGeneration
        runBackground { [weak self] in
            guard let self, let page = try? await self.historyWorker.page(host: host, sessionId: session.sessionId, leafId: leafId, limit: 30),
                  generation == self.connectionGeneration, self.selectedOfflineSession?.sessionId == session.sessionId,
                  let current = self.readOwner(runtime) else { return }
            let effect = self.sessionReads.localResult(operation, page: page, current: current)
            self.applyReadEffect(effect, operation: operation, runtime: runtime)
        }
    }

    private func updateCachedOptions(_ graph: CachedSessionGraph) {
        let path = graph.path(to: graph.leafId).map { entry in
            let message = graph.display[entry.entryId]?.message
            return RuntimeOption(value: entry.entryId, label: message?.text ?? entry.entryId, description: nil,
                tree: .init(parentId: entry.parentId, entryType: entry.value["type"].string ?? "message", role: message?.role,
                    label: nil, defaultHidden: message == nil, isCurrent: entry.entryId == graph.leafId, isOnActivePath: true))
        }
        let ids = Set(path.map(\.value))
        cachedHistoryOptions = path + cachedHistoryOptions.filter { !ids.contains($0.value) }.map { option in
            var copy = option
            if let tree = option.tree {
                copy.tree = .init(parentId: tree.parentId, entryType: tree.entryType, role: tree.role,
                    label: tree.label, defaultHidden: tree.defaultHidden, isCurrent: copy.value == graph.leafId, isOnActivePath: false)
            }
            return copy
        }
    }

    private func seedCachedHistory(_ runtime: RuntimeSummary) {
        guard conversations[runtime.runtimeId] == nil, let host = selectedHost, let sessionId = runtime.sessionId,
              cacheLoading[runtime.runtimeId] == nil else { return }
        let generation = connectionGeneration
        guard let owner = readOwner(runtime), let operation = sessionReads.begin(kind: .firstPage, owner: owner, targetLeafId: nil).operationId else { return }
        cacheLoading[runtime.runtimeId] = operation
        runBackground { [weak self] in
            guard let self else { return }
            defer { if self.cacheLoading[runtime.runtimeId] == operation { self.cacheLoading[runtime.runtimeId] = nil } }
            guard let page = try? await self.historyWorker.page(host: host, sessionId: sessionId, limit: 30),
                  generation == self.connectionGeneration, self.selectedRuntimeId == runtime.runtimeId,
                  let current = self.readOwner(runtime) else { return }
            guard self.conversations[runtime.runtimeId] == nil else { self.sessionReads.finish(operation, phase: .superseded); return }
            let effect = self.sessionReads.localResult(operation, page: page, current: current)
            self.applyReadEffect(effect, operation: operation, runtime: runtime)
        }
    }

    private func installCachedPage(_ page: SessionHistoryPage, runtimeId: String, sessionId: String, replacing: Bool) {
        if !replacing, var graph = graphs[sessionId], graph.epoch == page.graph.epoch {
            let retained = Set(graph.path(to: graph.leafId).suffix(256).map(\.entryId)).union(page.entries.map(\.entryId))
            for entry in page.entries { graph.entries[entry.entryId] = entry }
            for (id, row) in page.display { graph.display[id] = row }
            graph.entries = graph.entries.filter { retained.contains($0.key) }
            graph.display = graph.display.filter { $0.value.entryId.map(retained.contains) ?? true }
            graph.entryVersions = graph.entryVersions.filter { retained.contains($0.key) }
            graph.displayVersions = graph.displayVersions.filter { retained.contains($0.key) }
            graphs[sessionId] = graph
        } else { graphs[sessionId] = page.graph }
        if replacing { conversations[runtimeId] = page.messages } else { prependHistory(page.messages, runtimeId: runtimeId) }
        for entry in page.entries { displayMessageIds[runtimeId, default: [:]][entry.entryId] = page.display[entry.entryId]?.message?.messageId }
        oldestEntries[runtimeId] = page.entries.first?.entryId ?? oldestEntries[runtimeId]
        if replacing || sessionLeaves[runtimeId] == nil { sessionLeaves[runtimeId] = page.graph.leafId }
        hasOlderHistory[runtimeId] = page.hasOlder
        for timing in page.turnTimings { timingsBySession[sessionId, default: [:]][timing.turnId] = timing }
        historyPageRevision += 1; publishMessages()
    }

    private func loadCachedIndex(_ host: HostPairing) {
        let generation = connectionGeneration
        runBackground { [weak self] in
            guard let self, let rows = try? await self.historyWorker.listCachedSessions(host: host), generation == self.connectionGeneration else { return }
            self.cachedSessionIds = Set(rows.map(\.sessionId)); self.cachedIndexLoaded = true
        }
    }

    private func runBackground(_ work: @escaping @MainActor () async -> Void) {
        let id = UUID()
        backgroundTasks[id] = Task { [weak self] in await work(); self?.backgroundTasks[id] = nil }
    }

    private func cancelPendingWork() {
        eventTask?.cancel(); eventTask = nil; pendingEvents = []; pendingEventBytes = 0
        backgroundTasks.values.forEach { $0.cancel() }; backgroundTasks = [:]; cacheLoading = [:]
        for operation in sessionReads.operations.values where operation.phase.active { sessionReads.finish(operation.id, phase: .superseded) }
    }

    private func setHistoryConnection(_ connected: Bool) {
        guard connected != historyConnected else { return }
        historyConnected = connected; historyGeneration = UUID()
        cancelPendingWork()
        if !connected { clearSyncs(); sourcePositions = [:]; appliedBaselines = [:] }
        if let host = selectedHost {
            if connected { historyWorker.setGeneration(historyGeneration, host: host); loadCachedIndex(host) }
            else { historyWorker.invalidate(host: host) }
        }
    }

    func waitForPendingEvents() async {
        while eventTask != nil || !backgroundTasks.isEmpty {
            if let task = eventTask { await task.value }
            for task in Array(backgroundTasks.values) { await task.value }
        }
        await cleanupTask?.value
        await transfers.waitForPendingIO()
    }

    private func enqueueRuntimeEvent(_ message: [String: Any], channel: String?) {
        let cost = (try? JSONSerialization.data(withJSONObject: message).count) ?? 0
        var dropped = false
        while !pendingEvents.isEmpty && (pendingEvents.count >= 256 || pendingEventBytes + cost > 4 * 1024 * 1024) {
            let index = pendingEvents.firstIndex { $0.channel != "ctl" } ?? 0
            let old = pendingEvents.remove(at: index); pendingEventBytes -= old.bytes; dropped = true
            if let event = old.message["event"] as? [String: Any], let syncId = event["syncId"] as? String,
               let runtimeId = old.message["runtimeId"] as? String { rejectSnapshot(syncId, runtimeId: runtimeId, message: "历史读取队列繁忙，正在重新同步。") }
        }
        if dropped, let selectedRuntime { syncSession(selectedRuntime, force: true) }
        pendingEvents.append((message, channel, cost)); pendingEventBytes += cost
        guard eventTask == nil else { return }
        let generation = historyGeneration
        eventTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled, generation == self.historyGeneration, !self.pendingEvents.isEmpty {
                let index = self.pendingEvents.firstIndex { $0.channel == "ctl" } ?? 0
                let event = self.pendingEvents.remove(at: index); self.pendingEventBytes -= event.bytes
                await self.consumeEvent(event.message, channel: event.channel)
                guard generation == self.historyGeneration else { break }
                self.dispatchSyncDemands()
            }
            if generation == self.historyGeneration { self.eventTask = nil }
        }
    }

    private func prependHistory(_ older: [ChatMessage], runtimeId: String) {
        let ids = Set(older.map(\.messageId))
        conversations[runtimeId] = older + (conversations[runtimeId] ?? []).filter { !ids.contains($0.messageId) }
    }

    func activate(_ session: SessionSummary) {
        if let mismatch = providerMismatch(session) { errorMessage = mismatch; return }
        if let runtime = runtimes.first(where: { $0.sessionId == session.sessionId }) {
            selectRuntime(runtime.runtimeId)
            return
        }
        var target: [String: Any] = ["type": "resume", "sessionId": session.sessionId]
        if let agentKind = session.agentKind { target["agentKind"] = agentKind }
        activateTarget(target, sessionId: session.sessionId)
    }

    func createSession(agentKind: String, cwd: String) {
        guard !cwd.isEmpty else { return }
        activateTarget(["type": "new", "agentKind": agentKind, "cwd": cwd], sessionId: "new")
    }

    private func activateTarget(_ target: [String: Any], sessionId: String) {
        guard connection == .secured, activationRequestId == nil else { return }
        let requestId = UUID().uuidString
        guard transport.send(["type": "session.activate", "protocolVersion": orbisProtocolVersion,
                              "requestId": requestId, "target": target, "spawnMode": "tui"]) else {
            errorMessage = "端到端加密连接尚未就绪，请连接成功后重试。"; return
        }
        activationRequestId = requestId; pendingActivation = sessionId; activatingSessionId = sessionId
        activationTimeout = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 60_000_000_000) } catch { return }
            guard let self, self.activationRequestId == requestId else { return }
            self.clearActivation(); self.errorMessage = "会话尚未上线，请检查电脑端后刷新重试。"
        }
    }

    private func clearActivation() {
        activationTimeout?.cancel(); activationTimeout = nil
        activationRequestId = nil; pendingActivation = nil; activatingSessionId = nil
    }

    func archive(_ session: SessionSummary, archived: Bool) {
        guard connection == .secured, let kind = session.agentKind else { return }
        if !transport.send(["type": "session.archive", "protocolVersion": orbisProtocolVersion, "requestId": UUID().uuidString,
                            "sessionId": session.sessionId, "agentKind": kind, "archived": archived]) {
            errorMessage = "操作未送达，请连接后重试。"
        }
    }

    func browseDirectory(_ path: String? = nil) {
        guard connection == .secured else {
            browse = DirectoryBrowse(requestId: "", path: path, loading: false, error: "未连接到电脑，连接恢复后可重试。")
            return
        }
        browseTimeout?.cancel()
        let requestId = UUID().uuidString
        browse = DirectoryBrowse(requestId: requestId, path: path)
        var request: [String: Any] = ["type": "session.browse", "protocolVersion": orbisProtocolVersion, "requestId": requestId]
        if let path { request["path"] = path }
        guard transport.send(request) else { browse?.loading = false; browse?.error = "目录读取请求未送达。"; return }
        browseTimeout = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 20_000_000_000) } catch { return }
            guard let self, self.browse?.requestId == requestId else { return }
            self.browse?.loading = false; self.browse?.error = "目录读取超时，请重试。"
        }
    }

    func dismissBrowse() { browseTimeout?.cancel(); browseTimeout = nil; browse = nil }

    @discardableResult
    func executeSlash(_ name: String, args: String = "") -> Bool {
        guard canSend, let runtime = selectedRuntime,
              let command = commands[runtime.runtimeId]?.first(where: { $0.name == name }),
              command.argument?.required != true || !args.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        return performAction(runtimeId: runtime.runtimeId, name: name, command: ["type": "slash.execute", "name": name, "args": args])
    }

    func updatePermission(settingId: String, value: String) {
        guard canSend, let runtime = selectedRuntime, runtime.status == "idle", (interactions[runtime.runtimeId] ?? []).isEmpty, pendingActionIds.isEmpty,
              let setting = runtime.permissionManagement?.settings.first(where: { $0.id == settingId }),
              setting.disabledReason == nil, setting.options.contains(where: { $0.value == value }) else { return }
        _ = performAction(runtimeId: runtime.runtimeId, name: "权限", command: ["type": "permissions.update", "settingId": settingId, "value": value])
    }

    private func performAction(runtimeId: String, name: String, command: [String: Any]) -> Bool {
        let id = UUID().uuidString
        guard sendCommand(runtimeId: runtimeId, commandId: id, command: command) else {
            errorMessage = "操作未送达，请连接后重试。"; return false
        }
        runtimeActions[id] = (runtimeId, name); pendingActionIds.insert(id); setActionFeedback(nil); updateSyncing()
        actionTimeouts[id] = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 60_000_000_000) } catch { return }
            guard let self, self.runtimeActions[id] != nil else { return }
            self.finishAction(id, succeeded: false, message: "操作尚未确认，请刷新查看电脑端状态。")
        }
        return true
    }

    /// 操作完成提示只是短暂确认，不能长期停在聊天页上；新操作开始或断开时立即清掉。
    private func setActionFeedback(_ text: String?) {
        feedbackTimeout?.cancel(); feedbackTimeout = nil
        actionFeedback = text
        guard text != nil else { return }
        feedbackTimeout = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 2_500_000_000) } catch { return }
            self?.actionFeedback = nil; self?.feedbackTimeout = nil
        }
    }

    private func finishAction(_ id: String, succeeded: Bool, message: String? = nil, result: [String: Any]? = nil) {
        guard let action = runtimeActions.removeValue(forKey: id) else { return }
        pendingActionIds.remove(id); actionTimeouts.removeValue(forKey: id)?.cancel(); updateSyncing()
        if succeeded {
            setActionFeedback("\(action.name) 已完成")
            if action.name == "tree", let runtime = runtimes.first(where: { $0.runtimeId == action.runtimeId }) {
                let editorText = branchEditorNode == nil ? nil : (result?["editorText"] as? String ?? (branchEditorNode == entryPreview?.entryId ? entryPreview?.message?.text : nil))
                if let sessionId = result?["sessionId"] as? String, sessionId != runtime.sessionId {
                    if let editorText { pendingBranchDrafts[offlineAliasKey(host: selectedHost, sessionId: sessionId)] = editorText }
                    var target: [String: Any] = ["type": "resume", "sessionId": sessionId]
                    if let kind = runtime.agentKind { target["agentKind"] = kind }
                    activateTarget(target, sessionId: sessionId)
                } else {
                    invalidateConversation(runtime.runtimeId); syncSession(runtime, force: true)
                    if let editorText { saveDraft(editorText, for: runtime) }
                }
                historyRevision += 1; branchEditorNode = nil
            }
        } else { errorMessage = message ?? "\(action.name) 未完成，请重试。" }
    }

    @discardableResult
    func sendMessage(_ text: String, delivery: String? = nil, attachmentIds: Set<String> = []) -> Bool {
        guard canSend, let runtime = selectedRuntime, delivery == nil || ["followUp", "steer"].contains(delivery!) else { return false }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let body = trimmed.isEmpty && !attachmentIds.isEmpty ? "已发送 \(attachmentIds.count) 个附件" : trimmed
        guard !body.isEmpty else { return false }
        guard body.utf16.count <= 100_000 else { errorMessage = "消息不能超过 100,000 个字符。"; return false }
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("/") else {
            errorMessage = "请从命令菜单选择斜杠命令。"
            return false
        }
        let id = UUID().uuidString
        var command: [String: Any] = ["type": "user_message", "text": body, "messageId": id]
        let attachments = transfers.currentTasks.filter { attachmentIds.contains($0.id) && $0.runtimeId == runtime.runtimeId && $0.sessionId == runtime.sessionId && $0.direction == "upload" }
        guard attachments.count == attachmentIds.count, attachments.allSatisfy({ $0.status == "completed" && $0.remotePath != nil }) else { return false }
        if !attachments.isEmpty { command["attachments"] = attachments.compactMap(\.remotePath) }
        if let delivery, ["followUp", "steer"].contains(delivery) { command["delivery"] = delivery }
        guard performAction(runtimeId: runtime.runtimeId, name: "消息", command: command) else { return false }
        // Host message events are authoritative. Pi and DSH may assign a different streaming or
        // persisted ID than the client's command ID, so a local row here would become a duplicate.
        return true
    }

    @discardableResult
    func cancelQueuedMessage(_ queueId: String) -> Bool {
        guard canSend, let runtime = selectedRuntime, !pendingQueueCancellations.contains(queueId),
              queuedMessages[runtime.runtimeId]?.contains(where: { $0.queueId == queueId && $0.state == "accepted" }) == true else { return false }
        let id = UUID().uuidString
        guard sendCommand(runtimeId: runtime.runtimeId, commandId: id, command: ["type": "user_message.cancel", "messageId": queueId]) else { return false }
        queueCommands[id] = (runtime.runtimeId, queueId); pendingQueueCancellations.insert(queueId)
        actionTimeouts[id] = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 60_000_000_000) } catch { return }
            guard let self, let pending = self.queueCommands.removeValue(forKey: id) else { return }
            self.pendingQueueCancellations.remove(pending.queueId)
            self.errorMessage = "队列撤回尚未确认，请刷新查看电脑端状态。"
        }
        return true
    }

    func stopRuntime() {
        guard let runtime = selectedRuntime else { return }
        if !sendCommand(runtimeId: runtime.runtimeId, command: ["type": "stop"]) { errorMessage = "端到端加密连接尚未就绪。" }
    }

    private func sendCommand(runtimeId: String, commandId: String = UUID().uuidString, command: [String: Any]) -> Bool {
        transport.send(["type": "runtime.command", "protocolVersion": orbisProtocolVersion, "runtimeId": runtimeId, "commandId": commandId, "command": command])
    }

    /// 上次从这台电脑收到的会话目录。连接或切换电脑时先显示它，等 session.list 回来再整体替换，
    /// 抽屉不必每次都从空白等待加载。provider 归属依赖实时状态，不缓存。
    private func cachedSessions(_ host: HostPairing) -> [SessionSummary] {
        guard let data = preferences?.data(forKey: sessionCacheKey(host)) else { return [] }
        return (try? JSONDecoder().decode([SessionSummary].self, from: data)) ?? []
    }

    private func lastSessionKey(_ host: HostPairing) -> String { "orbis.lastSession." + hostKeyPrefix(host) }
    private func saveLastSession(_ runtime: RuntimeSummary) {
        guard let host = selectedHost, let session = runtime.sessionId else { return }
        preferences?.set(["runtimeId": runtime.runtimeId, "sessionId": session], forKey: lastSessionKey(host))
    }
    private func restoredRuntimeId() -> String? {
        guard let host = selectedHost, let saved = preferences?.dictionary(forKey: lastSessionKey(host)) as? [String: String],
              let session = saved["sessionId"] else { return nil }
        return runtimes.first(where: { $0.runtimeId == saved["runtimeId"] && $0.sessionId == session })?.runtimeId
            ?? runtimes.first(where: { $0.sessionId == session })?.runtimeId
    }

    private func sessionCacheKey(_ host: HostPairing) -> String { "orbis.sessionDirectory." + hostKeyPrefix(host) }

    private func persistSessions() {
        if let host = selectedHost, let data = try? JSONEncoder().encode(sessions) { preferences?.set(data, forKey: sessionCacheKey(host)) }
    }

    private func refreshSessions() {
        hostState.refresh(["catalog", "providers", "backends"])
        guard !modelCatalogReceived else { return }
        let id = UUID().uuidString
        sessionListRequest = id
        if !transport.send(["type": "session.list", "protocolVersion": orbisProtocolVersion, "requestId": id]) { sessionListRequest = nil }
    }

    func setPathPreference(_ order: [String]) {
        pathPreference = normalizedPathPreference(order)
        preferences?.set(pathPreference, forKey: "orbis.pathPreference")
        sendPathPreference()
    }

    private func sendPathPreference() {
        guard connection == .secured else { return }
        _ = transport.send(["type": "device.pathPreference", "protocolVersion": orbisProtocolVersion, "preference": pathPreference])
    }

    func currentProvider(for kind: String) -> String? {
        if hostState.domains["providers"]?.availability == "ready" { return hostState.currentProviders[kind] }
        return currentProviders[kind]
    }

    /// 展示用的 Agent 类别：runtime 元数据不带 agentKind，见 `resolvedAgentKind`。
    func agentKind(_ runtime: RuntimeSummary) -> String? {
        resolvedAgentKind(runtimeId: runtime.runtimeId, declared: runtime.agentKind,
                          catalogKind: runtime.sessionId.flatMap { sessionIndex[$0]?.agentKind })
    }

    func providerMismatch(_ session: SessionSummary) -> String? {
        guard session.agentKind == "codex", let provider = session.modelProvider, !provider.isEmpty,
              let current = currentProvider(for: "codex"), current != provider else { return nil }
        return "此会话属于 \(provider)，当前使用 \(current)。请在设置的供应商页面切换到 \(provider)，再打开会话。"
    }

    private func recordConnectionEvent(_ event: String) {
        let time = Date().formatted(date: .omitted, time: .standard)
        connectionEvents.append("\(time)  \(event.prefix(160))")
        if connectionEvents.count > 80 { connectionEvents.removeFirst(connectionEvents.count - 80) }
    }

    private func receive(_ message: [String: Any], channel: String?) {
        guard let type = message["type"] as? String else { return }
        guard channel != nil else {
            if type == "protocol.error" { errorMessage = message["message"] as? String ?? "中继认证失败，请重新连接。"; connection = .error }
            return
        }
        if let version = message["protocolVersion"] as? Int, version != orbisProtocolVersion {
            errorMessage = "Orbis 协议版本不兼容，请同时更新手机 App 和电脑 Host。"
            return
        }
        transfers.consume(message)
        recordConnectionEvent("\(channel ?? "—") · \(type)")
        if hostState.consume(message) || agentState.consume(message) || notifications.consume(message) { return }
        switch type {
        case "_transport.lan":
            guard let endpoints = message["endpoints"] as? [LANEndpoint], let index = pairings.firstIndex(where: { $0.hostId == selectedHostId }) else { return }
            pairings[index].lan = endpoints
            didUpdatePairing?(pairings[index])
        case "_transport.overflow":
            let now = Date()
            guard lastOverflowRecovery.map({ now.timeIntervalSince($0) >= 3 }) ?? true else { return }
            lastOverflowRecovery = now
            if let selectedRuntime { syncSession(selectedRuntime, force: true) }
        case "device.ready":
            guard channel != nil, let values = message["runtimes"] as? [[String: Any]] else { return }
            hostState.setConnection(selectedHost, connected: true)
            agentState.setConnection(selectedHost, connected: true)
            notifications.setConnection(selectedHost, connected: true)
            guard hostState.beginEpoch(message["modelEpoch"] as? String), agentState.beginEpoch(message["modelEpoch"] as? String) else { return }
            let modelEpoch = message["modelEpoch"] as? String
            let hostRestarted = modelEpoch != nil && authenticatedModelEpoch != nil && modelEpoch != authenticatedModelEpoch
            if let modelEpoch { authenticatedModelEpoch = modelEpoch }
            let next: [RuntimeSummary] = values.compactMap(jsonDecode)
            let selectedLeafChanged = next.first(where: { $0.runtimeId == selectedRuntimeId }).map { next in
                runtimes.first(where: { $0.runtimeId == next.runtimeId })?.sessionLeafId != next.sessionLeafId
            } ?? false
            if hostRestarted { setHistoryConnection(false); clearSyncs(); sourcePositions = [:]; appliedBaselines = [:] }
            for runtime in next where runtimes.first(where: { $0.runtimeId == runtime.runtimeId })?.sessionId != runtime.sessionId {
                invalidateConversation(runtime.runtimeId)
            }
            runtimes = next
            conversations = conversations.filter { id, _ in next.contains { $0.runtimeId == id } }
            runtimeEventSequences = [:]
            if selectedRuntime == nil { selectedRuntimeId = restoredRuntimeId() ?? runtimes.first?.runtimeId }
            if let selectedRuntime { saveLastSession(selectedRuntime) }
            setHistoryConnection(true)
            connection = .secured
            hostState.setConnection(selectedHost, connected: true)
            agentState.setConnection(selectedHost, connected: true)
            notifications.setConnection(selectedHost, connected: true)
            sendPathPreference()
            transfers.setConnection(selectedHost, connected: true)
            supportedAgents = message["agents"] as? [String]
            launchableAgents = message["launchableAgents"] as? [String]
            codexDesktop = (message["codexDesktop"] as? [String: Any]).flatMap(jsonDecode).flatMap { $0.valid ? $0 : nil }
            notifications.ready(epoch: message["notificationEpoch"] as? String, runtimes: runtimes)
            for runtime in runtimes { agentState.subscribe(runtime: runtime) }
            publishMessages()
            if let selectedRuntime { seedCachedHistory(selectedRuntime); publishMessages(); agentState.subscribe(runtime: selectedRuntime); syncSession(selectedRuntime, force: hostRestarted || selectedLeafChanged) }
            refreshSessions()
        case "runtime.online":
            if let object = message["runtime"] as? [String: Any], let runtime: RuntimeSummary = jsonDecode(object) {
                if let index = runtimes.firstIndex(where: { $0.runtimeId == runtime.runtimeId }) {
                    if runtimes[index].sessionId != runtime.sessionId { invalidateConversation(runtime.runtimeId) }
                    runtimes[index] = runtime
                } else { runtimes.append(runtime) }
                if pendingActivation == runtime.sessionId {
                    if let session = runtime.sessionId, let text = pendingBranchDrafts.removeValue(forKey: offlineAliasKey(host: selectedHost, sessionId: session)) { saveDraft(text, for: runtime) }
                    clearActivation()
                    selectedRuntimeId = runtime.runtimeId
                    activationRevision += 1
                } else if selectedRuntimeId == nil { selectedRuntimeId = runtime.runtimeId }
                publishMessages()
                agentState.subscribe(runtime: runtime); notifications.online(runtime)
                if runtime.runtimeId == selectedRuntimeId { syncSession(runtime) }
            }
        case "runtime.offline":
            if let id = message["runtimeId"] as? String {
                runtimes.removeAll { $0.runtimeId == id }
                notifications.offline(runtimeId: id)
                invalidateConversation(id)
                if selectedRuntimeId == id { selectedRuntimeId = runtimes.first?.runtimeId }
                publishMessages()
                if let selectedRuntime { agentState.subscribe(runtime: selectedRuntime); syncSession(selectedRuntime) }
            }
        case "runtime.event": enqueueRuntimeEvent(message, channel: channel)
        case "session.list.result":
            guard !modelCatalogReceived else { return }
            guard let request = sessionListRequest, message["requestId"] as? String == request else { return }
            sessionListRequest = nil
            if let values = message["sessions"] as? [[String: Any]] {
                let decoded: [SessionSummary] = values.compactMap(jsonDecode)
                sessions = decoded.sorted { $0.modifiedAt > $1.modifiedAt }
                persistSessions()
            }
            if let providers = message["currentProviders"] as? [[String: Any]] {
                currentProviders = [:]
                for row in providers {
                    if let kind = row["agentKind"] as? String, let provider = row["provider"] as? String, !provider.isEmpty { currentProviders[kind] = provider }
                }
            }
        case "device.path":
            activePath = message["path"] as? String
            pathRTT = (message["rttMs"] as? NSNumber)?.doubleValue
        case "runtime.git":
            guard let id = message["runtimeId"] as? String, let runtime = runtimes.first(where: { $0.runtimeId == id }),
                  let pending = workingBranches[id], pending.requestId == message["requestId"] as? String,
                  pending.sessionId == runtime.sessionId, pending.cwd == runtime.cwd,
                  message["cwd"] as? String == runtime.cwd, message["sessionId"] as? String == runtime.sessionId else { return }
            workingBranches[id]?.branch = message["branch"] as? String
            workingBranches[id]?.commit = message["commit"] as? String
            workingBranches[id]?.loaded = true
        case "session.browse.result":
            guard message["requestId"] as? String == browse?.requestId else { return }
            browseTimeout?.cancel()
            browse?.path = message["path"] as? String
            browse?.parent = message["parent"] as? String
            browse?.entries = (message["entries"] as? [[String: Any]] ?? []).compactMap(jsonDecode)
            browse?.loading = false
        case "session.activated":
            if message["requestId"] as? String == activationRequestId, let sessionId = message["sessionId"] as? String {
                pendingActivation = sessionId; activatingSessionId = sessionId
                if let runtime = runtimes.first(where: { $0.sessionId == sessionId }) {
                    clearActivation(); selectRuntime(runtime.runtimeId); activationRevision += 1
                }
            }
            refreshSessions()
        case "session.archive.changed": refreshSessions()
        case "protocol.error":
            let commandId = message["commandId"] as? String
            if commandId?.hasPrefix("session-sync-ack:") == true { return }
            if let syncId = pendingSyncs.first(where: { $0.value.commandId == commandId })?.key {
                let pending = pendingSyncs[syncId]
                finishSync(syncId)
                if let pending, pending.range == "history" { historyErrors[pending.runtimeId] = message["message"] as? String ?? "历史读取失败，请重试。"; return }
            }
            if let commandId { finishAction(commandId, succeeded: false, message: message["message"] as? String) }
            if let commandId, let request = interactionCommands.removeValue(forKey: commandId) { submittingInteractions.remove(request) }
            if let requestId = message["requestId"] as? String, requestId == activationRequestId { clearActivation() }
            if let requestId = message["requestId"] as? String, requestId == browse?.requestId {
                browseTimeout?.cancel(); browse?.loading = false; browse?.error = message["message"] as? String
                return
            }
            if commandId == nil && message["requestId"] == nil { connection = .error }
            errorMessage = message["message"] as? String ?? "电脑端无法完成操作。"
        default: break
        }
    }

    private func consumeEvent(_ envelope: [String: Any], channel: String?) async {
        guard let runtimeId = envelope["runtimeId"] as? String, runtimes.contains(where: { $0.runtimeId == runtimeId }),
              let event = envelope["event"] as? [String: Any], let type = event["type"] as? String else { return }
        if let sequence = integer(envelope["sequence"]) {
            let key = "\(runtimeId)\u{0000}\(channel ?? "ctl")"
            if sequence <= (runtimeEventSequences[key] ?? -1) { return }
            runtimeEventSequences[key] = sequence
        }
        toolContent.consume(event, runtimeId: runtimeId)
        toolInventories.consume(event, runtime: runtimeId)
        let modelOwnedDomain: String? = ["runtime.status": "execution", "runtime.capabilities": "capabilities", "interaction.requested": "interactions", "interaction.snapshot": "interactions", "interaction.resolved": "interactions", "interaction.cancelled": "interactions", "queue.snapshot": "delivery", "queue.updated": "delivery", "message.queued": "delivery", "delivery.snapshot": "delivery"][type]
        if let domain = modelOwnedDomain, agentState.owns(domain, runtimeId: runtimeId) { return }
        if type == "message.queued", let item: QueuedMessage = jsonDecode(event) {
            var rows = queuedMessages[runtimeId] ?? []
            rows.removeAll { $0.queueId == item.queueId }
            if item.state != "delivered" { rows.append(item) }
            queuedMessages[runtimeId] = rows; return
        }
        if type == "delivery.snapshot", let rows = event["items"] as? [[String: Any]] {
            let items: [QueuedMessage] = rows.compactMap(jsonDecode)
            guard items.count == rows.count, Set(items.map(\.queueId)).count == items.count else { return }
            var merged = event["complete"] as? Bool == false ? (queuedMessages[runtimeId] ?? []) : []
            let ids = Set(items.map(\.queueId)); merged.removeAll { ids.contains($0.queueId) }
            queuedMessages[runtimeId] = (merged + items).filter { $0.state != "delivered" }; return
        }
        if type == "runtime.status", let status = event["status"] as? String,
           let index = runtimes.firstIndex(where: { $0.runtimeId == runtimeId }) { runtimes[index].status = status; updateSyncing(); return }
        if type == "runtime.capabilities", let capabilities = event["capabilities"] as? [String: Any] {
            commands[runtimeId] = (capabilities["commands"] as? [[String: Any]] ?? []).compactMap(jsonDecode)
            return
        }
        if type == "command.result", let commandId = event["commandId"] as? String, event["status"] as? String != "pending" {
            if let pending = queueCommands[commandId], pending.runtimeId == runtimeId {
                queueCommands[commandId] = nil; pendingQueueCancellations.remove(pending.queueId)
                actionTimeouts.removeValue(forKey: commandId)?.cancel()
                if event["ok"] as? Bool == false { errorMessage = event["error"] as? String ?? "消息撤回失败。" }
                updateSyncing()
            }
            if runtimeActions[commandId]?.runtimeId == runtimeId { finishAction(commandId, succeeded: event["ok"] as? Bool == true, message: event["error"] as? String, result: event["result"] as? [String: Any]) }
            if let request = interactionCommands[commandId], interactions[runtimeId]?.contains(where: { $0.requestId == request }) == true {
                interactionCommands[commandId] = nil
                if event["ok"] as? Bool != true { submittingInteractions.remove(request) }
            }
        }
        if type == "interaction.requested", let raw = event["request"] as? [String: Any], let request: InteractionRequest = jsonDecode(raw), request.runtimeId == runtimeId {
            var current = interactions[runtimeId] ?? []
            current.removeAll { $0.requestId == request.requestId }; current.append(request)
            interactions[runtimeId] = current; return
        }
        if type == "interaction.snapshot" {
            let requests: [InteractionRequest] = (event["requests"] as? [[String: Any]] ?? []).compactMap(jsonDecode)
            interactions[runtimeId] = requests.filter { $0.runtimeId == runtimeId }
            let active = Set(interactions.values.joined().map(\.requestId))
            submittingInteractions = submittingInteractions.intersection(active)
            return
        }
        if type == "interaction.resolved" || type == "interaction.cancelled", let requestId = event["requestId"] as? String {
            interactions[runtimeId]?.removeAll { $0.requestId == requestId }
            submittingInteractions.remove(requestId)
            interactionCommands = interactionCommands.filter { $0.value != requestId }
            return
        }
        if type == "session.entry.result", event["requestId"] as? String == entryPreview?.requestId,
           event["entryId"] as? String == entryPreview?.entryId, runtimeId == entryPreview?.runtimeId,
           selectedRuntime?.sessionId == entryPreview?.sessionId {
            previewTimeout?.cancel(); entryPreview?.loading = false
            entryPreview?.error = event["error"] as? String
            if let entry = event["entry"] as? [String: Any], let data = entry["data"] as? [String: Any], let message = data["message"] as? [String: Any] {
                entryPreview?.message = jsonDecode(message)
            }
            return
        }
        if type == "runtime.metadata", let metadata = event["metadata"] as? [String: Any],
           let index = runtimes.firstIndex(where: { $0.runtimeId == runtimeId }) {
            let previous = runtimes[index]
            let fields = metadata.filter { key, _ in
                let owned: String? = ["status": "execution", "model": "model", "thinkingLevel": "model", "contextUsage": "context", "permissionManagement": "permissions"][key]
                return owned.map { !agentState.owns($0, runtimeId: runtimeId) } ?? true
            }
            let next = mergeRuntime(previous, metadata: fields)
            runtimes[index] = next
            if previous.sessionId != next.sessionId {
                invalidateConversation(runtimeId)
                notifications.online(next)
                agentState.subscribe(runtime: next)
                if runtimeId == selectedRuntimeId { syncSession(next) }
                publishMessages()
            } else if previous.sessionLeafId != next.sessionLeafId, runtimeId == selectedRuntimeId {
                syncSession(next, force: true)
            }
            return
        }
        if type == "runtime.error" || (type == "command.result" && event["ok"] as? Bool == false) {
            if let commandId = event["commandId"] as? String, let syncId = pendingSyncs.first(where: { $0.value.commandId == commandId && $0.value.runtimeId == runtimeId })?.key {
                let pending = pendingSyncs[syncId]; finishSync(syncId, readPhase: .failed)
                if pending?.range == "history" { historyErrors[runtimeId] = event["error"] as? String ?? event["message"] as? String ?? "历史读取失败，请重试。"; return }
            }
            errorMessage = event["message"] as? String ?? event["error"] as? String ?? "电脑端无法完成操作。"
            return
        }
        if type == "session.sync.pending", let syncId = event["syncId"] as? String, var task = pendingSyncs[syncId], task.runtimeId == runtimeId {
            guard event["commandId"] == nil || event["commandId"] as? String == task.commandId else { return }
            task.pendingNotices += 1
            let lease = min(600, max(0, Double(integer(event["leaseMs"]) ?? 120_000) / 1000))
            let now = Date()
            if task.pendingNotices <= 10 {
                task.firstSentAt = now
                task.deadline = max(task.deadline, now.addingTimeInterval(lease + 30))
            }
            task.sentAt = now.addingTimeInterval(lease)
            task.exhausted = false
            pendingSyncs[syncId] = task
            armSyncTimeout(syncId, seconds: lease + 30)
            return
        }
        if type == "session.snapshot" {
            await applySnapshot(event, runtimeId: runtimeId)
        } else if type == "session.patch" {
            // A complete contiguous source transaction commits before its projection is visible.
            if let source = event["source"] as? [String: Any], let epoch = source["epoch"] as? String,
               let seq = integer(source["seq"]), let base = integer(event["baseSeq"]),
               source["ready"] as? Bool == true, seq > base, integer(event["seq"]) == seq,
               event["headCompleteness"] as? String == "complete", (event["live"] as? [String: Any])?["complete"] as? Bool == true,
               let current = sourcePositions[runtimeId], current.epoch == epoch, current.seq == base,
               event["sessionId"] as? String == runtimes.first(where: { $0.runtimeId == runtimeId })?.sessionId {
                guard let runtime = runtimes.first(where: { $0.runtimeId == runtimeId }), validToolDependency(event, runtime: runtime), await commitHistory(event, runtime: runtime, activate: true) != nil else {
                    if let runtime = runtimes.first(where: { $0.runtimeId == runtimeId }) { syncSession(runtime, force: true) }
                    return
                }
                applyProjection(event, runtimeId: runtimeId)
                if let leaf = (event["head"] as? [String: Any])?["leafId"] as? String { sessionLeaves[runtimeId] = leaf }
                sourcePositions[runtimeId] = (epoch, seq)
                if event["headCompleteness"] as? String == "complete", (event["live"] as? [String: Any])?["complete"] as? Bool == true,
                   let head = event["head"] as? [String: Any], liveToolReferences[runtimeId].map({ toolInventories.covers($0, runtime: runtimeId) }) ?? true {
                    appliedBaselines[runtimeId] = SessionAppliedBaseline(epoch: epoch, seq: seq, leaf: head["leafId"] as? String)
                    pendingLiveBaselines[runtimeId] = nil
                } else {
                    appliedBaselines[runtimeId] = nil
                    if let reference = liveToolReferences[runtimeId], let head = event["head"] as? [String: Any], toolInventories.loading.contains(runtimeId) {
                        pendingLiveBaselines[runtimeId] = (reference, SessionAppliedBaseline(epoch: epoch, seq: seq, leaf: head["leafId"] as? String))
                    } else { pendingLiveBaselines[runtimeId] = nil }
                }
            } else if let runtime = runtimes.first(where: { $0.runtimeId == runtimeId }), runtimeId == selectedRuntimeId {
                syncSession(runtime, force: true)
            }
        } else if sourcePositions[runtimeId] != nil && ["message.started", "message.finished", "message.delta", "turn.started", "turn.finished", "tool.started", "tool.updated", "tool.finished"].contains(type) {
            return
        } else if type == "message.started" || type == "message.finished" {
            // 生命周期事件只是 live 叠加层：记进 liveMessageIds，live 清单完整时没有成为权威行的就会被退掉。
            if let object = event["message"] as? [String: Any], let message: ChatMessage = jsonDecode(object),
               !isRetiredAlias(message.messageId, runtimeId: runtimeId) {
                liveMessageIds[runtimeId, default: []].insert(message.messageId)
                upsert(message, runtimeId: runtimeId)
            }
        } else if type == "message.delta" { applyDelta(event, runtimeId: runtimeId) }
        else if type == "turn.finished" {
            for row in event["persistedMessages"] as? [[String: Any]] ?? [] {
                if let liveId = row["messageId"] as? String, let entryId = row["entryId"] as? String { addAlias(liveId, entryId: entryId, runtimeId: runtimeId) }
            }
            if let liveId = event["messageId"] as? String, let entryId = event["persistedMessageId"] as? String { addAlias(liveId, entryId: entryId, runtimeId: runtimeId) }
            retireAliases(runtimeId)
        }
        publishMessages()
    }

    private func applySnapshot(_ event: [String: Any], runtimeId: String) async {
        let generation = historyGeneration
        guard let syncId = event["syncId"] as? String else { return }
        let pending = pendingSyncs[syncId]
        if pending == nil, let receipt = snapshotReceipts[syncId], receipt.runtimeId == runtimeId,
           receipt.sessionId == event["sessionId"] as? String,
           runtimes.first(where: { $0.runtimeId == runtimeId })?.sessionId == receipt.sessionId,
           sessionSnapshotFingerprint(event) == receipt.fingerprint {
            acknowledge(runtimeId: runtimeId, syncId: syncId, result: "applied"); return
        }
        if pending == nil, toolAcknowledgements[syncId]?.runtimeId == runtimeId,
           let candidate = snapshotCandidates[syncId], candidate.runtimeId == runtimeId,
           candidate.sessionId == event["sessionId"] as? String,
           runtimes.first(where: { $0.runtimeId == runtimeId })?.sessionId == candidate.sessionId,
           sessionSnapshotFingerprint(event) == candidate.fingerprint { return }
        guard pending?.runtimeId == runtimeId, pending?.sessionId == event["sessionId"] as? String,
              let runtime = runtimes.first(where: { $0.runtimeId == runtimeId }), runtime.sessionId == pending?.sessionId else {
            acknowledge(runtimeId: runtimeId, syncId: syncId, result: "rejected")
            return
        }
        guard let pending else { return }
        guard recoverRead(syncId, runtime: runtime) else {
            rejectSnapshot(syncId, runtimeId: runtimeId, message: "会话读取归属已经改变，请重试。"); return
        }
        guard event["range"] == nil || event["range"] as? String == pending.range,
              event["beforeEntryId"] as? String == pending.boundary,
              validSnapshotSelection(event, pending: pending, runtimeId: runtimeId) else {
            rejectSnapshot(syncId, runtimeId: runtimeId, message: "会话同步范围或检查点无效，请重试。")
            return
        }
        guard let source = event["source"] as? [String: Any], let epoch = source["epoch"] as? String, !epoch.isEmpty,
              epoch.utf16.count <= 256, integer(source["seq"]) != nil, source["ready"] as? Bool == true else {
            rejectSnapshot(syncId, runtimeId: runtimeId, message: "会话来源版本无效，请重试。")
            return
        }
        if let source = event["source"] as? [String: Any], let epoch = source["epoch"] as? String,
           retiredEpochs[runtimeId]?.contains(epoch) == true {
            rejectSnapshot(syncId, runtimeId: runtimeId, message: "会话同步来自已替换的来源。")
            return
        }
        if pending.range == "history", let source = event["source"] as? [String: Any],
           let current = sourcePositions[runtimeId], source["epoch"] as? String != current.epoch {
            rejectSnapshot(syncId, runtimeId: runtimeId, message: "历史来源已经改变，请刷新会话。")
            return
        }
        if let fingerprint = sessionSnapshotFingerprint(event) {
            snapshotCandidates[syncId] = SessionSnapshotReceipt(runtimeId: runtimeId, sessionId: pending.sessionId, fingerprint: fingerprint)
        }
        if event["selection"] as? String == "unchanged" {
            guard let known = pending.known, let applied = appliedBaselines[runtimeId], applied.epoch == known.epoch,
                  applied.seq >= known.seq, applied.seq > known.seq || applied.leaf == known.leaf else {
                rejectSnapshot(syncId, runtimeId: runtimeId, message: "会话已应用状态发生变化，请重试。")
                return
            }
            if let host = selectedHost, let page = try? await historyWorker.page(host: host, sessionId: pending.sessionId, limit: 30), generation == historyGeneration {
                finishSync(syncId, readPhase: nil)
                completeRemoteRead(syncId, runtime: runtime, page: page, sourceConfirmed: true)
                acknowledge(runtimeId: runtimeId, syncId: syncId, result: "applied")
                beginCatchup(runtime)
            }
            return
        }
        if let source = event["source"] as? [String: Any], source["ready"] as? Bool == false {
            finishSync(syncId)
            acknowledge(runtimeId: runtimeId, syncId: syncId, result: "rejected")
            return
        }
        guard validToolDependency(event, runtime: runtime) else {
            rejectSnapshot(syncId, runtimeId: runtimeId, message: "会话工具清单的归属或版本无效，请刷新重试。")
            return
        }
        var dependency: ToolReference?
        if let raw = (event["live"] as? [String: Any])?["toolInventory"], !(raw is NSNull) {
            guard let object = raw as? [String: Any], let reference: ToolReference = jsonDecode(object),
                  reference.agent.hostId == selectedHostId, reference.agent.sessionId == runtime.sessionId,
                  reference.agent.agentKind == runtime.agentKind || runtime.agentKind == nil,
                  reference.projectionVersion == 1, (0...4096).contains(reference.totalCount), (0...8_388_608).contains(reference.summaryBytes) else {
                finishSync(syncId); acknowledge(runtimeId: runtimeId, syncId: syncId, result: "rejected")
                errorMessage = "会话工具清单的归属或版本无效，请刷新重试。"; return
            }
            dependency = reference
        }
        if let status = event["rangeStatus"] as? String, !["complete", "older_available", "limit_reached"].contains(status) {
            historyErrors[runtimeId] = "历史范围不可用，请刷新会话后重试。"
            finishSync(syncId); acknowledge(runtimeId: runtimeId, syncId: syncId, result: "rejected"); return
        }
        if pending.range == "preview", let source = event["source"] as? [String: Any],
           let epoch = source["epoch"] as? String, let seq = integer(source["seq"]),
           let current = sourcePositions[runtimeId], current.epoch == epoch, seq < current.seq {
            finishSync(syncId); acknowledge(runtimeId: runtimeId, syncId: syncId, result: "rejected"); return
        }
        if pending.range == "history" {
            guard event["range"] as? String == "history", event["mode"] as? String == "prepend",
                  event["beforeEntryId"] as? String == pending.boundary,
                  pending.leaf == nil || event["targetLeafId"] as? String == pending.leaf else {
                finishSync(syncId); acknowledge(runtimeId: runtimeId, syncId: syncId, result: "rejected"); return
            }
            guard !(event["hasOlder"] as? Bool == false && event["complete"] as? Bool == false) else {
                rejectSnapshot(syncId, runtimeId: runtimeId, message: "历史范围尚未完整，请重试。")
                return
            }
            let entries = event["entries"] as? [[String: Any]] ?? []
            let first = entries.first?["entryId"] as? String
            guard event["hasOlder"] as? Bool != true || (first != nil && first != pending.boundary),
                  !(entries.isEmpty && event["hasOlder"] as? Bool == true),
                  entries.last?["entryId"] as? String != pending.boundary else {
                rejectSnapshot(syncId, runtimeId: runtimeId, message: "历史范围未推进，请重试。")
                return
            }
            var parent: String?
            var connected = true
            for (index, row) in entries.enumerated() {
                if index > 0, row["parentId"] as? String != parent { connected = false }
                parent = row["entryId"] as? String
            }
            guard let host = selectedHost, let boundary = pending.boundary,
                  let persistedBoundary = try? await historyWorker.entry(host: host, sessionId: pending.sessionId, entryId: boundary),
                  generation == historyGeneration, recoverRead(syncId, runtime: runtime) else {
                rejectSnapshot(syncId, runtimeId: runtimeId, message: "历史请求边界已经失效，请重试。"); return
            }
            if parent != persistedBoundary.parentId { connected = false }
            guard connected else {
                rejectSnapshot(syncId, runtimeId: runtimeId, message: "历史条目与请求边界不连续，请重试。")
                return
            }
            guard await commitHistory(event, runtime: runtime, activate: false) != nil else {
                rejectSnapshot(syncId, runtimeId: runtimeId, message: "历史记录无法保存，请重试。")
                return
            }
            guard generation == historyGeneration, let host = selectedHost,
                  let page = try? await historyWorker.page(host: host, sessionId: pending.sessionId,
                    leafId: pending.leaf, beforeEntryId: pending.boundary, limit: max(1, entries.count)),
                  generation == historyGeneration else { return }
            guard page.displayComplete, [.complete, .olderAvailable].contains(page.status) else {
                rejectSnapshot(syncId, runtimeId: runtimeId, message: "历史范围或显示结果不完整，请重试。"); return
            }
            finishSync(syncId, readPhase: nil)
            completeRemoteRead(syncId, runtime: runtime, page: page)
            acknowledge(runtimeId: runtimeId, syncId: syncId, result: "applied")
            retireAliases(runtimeId); publishMessages(); return
        }
        if pending.range == "catchup" {
            guard event["range"] as? String == "catchup", ["replace", "append"].contains(event["mode"] as? String ?? ""),
                  event["targetLeafId"] as? String == pending.leaf,
                  event["checkpoint"] == nil, event["live"] == nil,
                  (event["source"] as? [String: Any])?["epoch"] as? String == sourcePositions[runtimeId]?.epoch,
                  let operation = syncReads[syncId], let target = sessionReads.operations[operation]?.targetLeafId else {
                rejectSnapshot(syncId, runtimeId: runtimeId, message: "历史补齐范围已经失效。"); return
            }
            guard await commitHistory(event, runtime: runtime, activate: false) != nil else {
                rejectSnapshot(syncId, runtimeId: runtimeId, message: "补齐历史无法保存，请重试。"); return
            }
            guard generation == historyGeneration, let host = selectedHost,
                  let page = try? await historyWorker.page(host: host, sessionId: pending.sessionId, leafId: target, limit: 1),
                  generation == historyGeneration else { return }
            finishSync(syncId, readPhase: nil)
            acknowledge(runtimeId: runtimeId, syncId: syncId, result: "applied")
            completeRemoteRead(syncId, runtime: runtime, page: page)
            if sessionReads.operations[operation]?.phase == .succeeded { beginCatchup(runtime) }
            return
        }
        guard let committed = await commitHistory(event, runtime: runtime, activate: true) else {
            rejectSnapshot(syncId, runtimeId: runtimeId, message: "会话历史无法保存，请重试。")
            return
        }
        guard generation == historyGeneration, pendingSyncs[syncId]?.commandId == pending.commandId,
              recoverRead(syncId, runtime: runtime) else { return }
        if let oldEpoch = sourcePositions[runtimeId]?.epoch, let source = event["source"] as? [String: Any],
           let epoch = source["epoch"] as? String, oldEpoch != epoch {
            retiredEpochs[runtimeId, default: []].insert(oldEpoch)
            appliedBaselines[runtimeId] = nil
        }
        var prefix: [ChatMessage] = []
        if let source = event["source"] as? [String: Any], source["epoch"] as? String == sourcePositions[runtimeId]?.epoch,
           let display = event["display"] as? [String: Any], let rows = display["entries"] as? [[String: Any]],
           let firstRaw = rows.first(where: { $0["message"] is [String: Any] })?["message"] as? [String: Any],
           let firstId = firstRaw["messageId"] as? String,
           let existing = conversations[runtimeId], let overlap = existing.firstIndex(where: { $0.messageId == firstId }),
           let firstEntry = rows.first?["entryId"] as? String, displayMessageIds[runtimeId]?[firstEntry] != nil {
            prefix = Array(existing.prefix(overlap)).filter { !(liveMessageIds[runtimeId] ?? []).contains($0.messageId) }
        }
        if event["mode"] as? String == "replace" {
            conversations[runtimeId] = prefix
            liveMessageIds[runtimeId] = []; liveOrders[runtimeId] = [:]
            if prefix.isEmpty { displayMessageIds[runtimeId] = [:] }
        }
        applyProjection(event, runtimeId: runtimeId)
        if let cursor = event["cursor"] as? [String: Any] { sessionLeaves[runtimeId] = cursor["leafId"] as? String }
        if prefix.isEmpty { oldestEntries[runtimeId] = (event["entries"] as? [[String: Any]])?.first?["entryId"] as? String }
        if prefix.isEmpty { hasOlderHistory[runtimeId] = event["hasOlder"] as? Bool ?? false }
        if let source = event["source"] as? [String: Any], let epoch = source["epoch"] as? String, let seq = integer(source["seq"]) {
            sourcePositions[runtimeId] = (epoch, seq)
        }
        syncedSessions.insert("\(runtimeId)|\(pending.sessionId)")
        finishSync(syncId, readPhase: nil)
        let baseline = baselineForCompleteCheckpoint(event, runtimeId: runtimeId)
        appliedBaselines[runtimeId] = nil
        if let reference = dependency {
            if toolInventories.covers(reference, runtime: runtimeId) {
                if let baseline { appliedBaselines[runtimeId] = baseline }
                completeRemoteRead(syncId, runtime: runtime, page: committed.page, sourceConfirmed: baseline != nil)
                beginCatchup(runtime)
                acknowledge(runtimeId: runtimeId, syncId: syncId, result: "applied")
            }
            else if toolAcknowledgements.count < 8, toolInventories.loading.contains(runtimeId) { toolAcknowledgements[syncId] = (runtimeId, reference); pendingAppliedBaselines[syncId] = baseline; pendingReadPages[syncId] = committed.page }
            else {
                if let read = syncReads.removeValue(forKey: syncId) { sessionReads.finish(read, phase: .failed, error: "工具清单等待任务已满。") }
                acknowledge(runtimeId: runtimeId, syncId: syncId, result: "rejected")
            }
        } else {
            if let baseline { appliedBaselines[runtimeId] = baseline }
            completeRemoteRead(syncId, runtime: runtime, page: committed.page, sourceConfirmed: baseline != nil)
            beginCatchup(runtime)
            acknowledge(runtimeId: runtimeId, syncId: syncId, result: "applied")
        }
    }

    private func rejectSnapshot(_ syncId: String, runtimeId: String, message: String) {
        guard let pending = pendingSyncs[syncId], pending.runtimeId == runtimeId else { return }
        let range = pending.range
        finishSync(syncId, readPhase: .failed); acknowledge(runtimeId: runtimeId, syncId: syncId, result: "rejected")
        if range == "history" { historyErrors[runtimeId] = message } else { errorMessage = message }
    }

    private func commitHistory(_ event: [String: Any], runtime: RuntimeSummary, activate: Bool) async -> SessionHistoryCommit? {
        guard let host = selectedHost, let sessionId = runtime.sessionId,
              let data = try? JSONSerialization.data(withJSONObject: event) else { return nil }
        let generation = historyGeneration
        let branchGeneration = branchGenerations[runtime.runtimeId] ?? 0
        let lease = historyWriteLeases[runtime.runtimeId] ?? SessionHistoryWriteLease()
        historyWriteLeases[runtime.runtimeId] = lease
        do {
            let committed = try await historyWorker.ingest(host: host, sessionId: sessionId, event: data,
                activate: activate, generation: generation, lease: lease, expectedEpoch: activate ? nil : sourcePositions[runtime.runtimeId]?.epoch, limit: 256)
            let incomingIds = ((event["display"] as? [String: Any])?["entries"] as? [[String: Any]] ?? []).compactMap { $0["entryId"] as? String }
            let displayedIds = Array(displayMessageIds[runtime.runtimeId]?.keys ?? Dictionary<String, String>().keys)
            let excluded = try await historyWorker.excludedDisplayEntries(host: host, sessionId: sessionId, entryIds: displayedIds + incomingIds)
            guard generation == historyGeneration, branchGeneration == branchGenerations[runtime.runtimeId] ?? 0,
                  historyConnected, runtimes.contains(where: { $0.runtimeId == runtime.runtimeId && $0.sessionId == sessionId }) else { return nil }
            excludedDisplayEntries[sessionId] = excluded
            let hiddenMessages = Set(excluded.compactMap { displayMessageIds[runtime.runtimeId]?[$0] })
            conversations[runtime.runtimeId]?.removeAll { hiddenMessages.contains($0.messageId) }
            graphs[sessionId] = committed.graph
            cachedSessionIds.insert(sessionId)
            if committed.epochChanged { timingsBySession[sessionId] = [:] }
            for timing in committed.turnTimings { timingsBySession[sessionId, default: [:]][timing.turnId] = timing }
            return committed
        } catch { return nil }
    }

    private func validToolDependency(_ event: [String: Any], runtime: RuntimeSummary) -> Bool {
        guard let raw = (event["live"] as? [String: Any])?["toolInventory"], !(raw is NSNull) else { return true }
        guard let object = raw as? [String: Any], let reference: ToolReference = jsonDecode(object),
              reference.agent.hostId == selectedHostId, reference.agent.sessionId == runtime.sessionId,
              reference.agent.agentKind == agentKind(runtime) || agentKind(runtime) == nil,
              reference.projectionVersion == 1, reference.version.revision > 0,
              !reference.version.epoch.isEmpty, !reference.source.epoch.isEmpty,
              (0...4096).contains(reference.totalCount), (0...8_388_608).contains(reference.summaryBytes),
              let source = event["source"] as? [String: Any], reference.source.epoch == source["epoch"] as? String,
              let seq = integer(source["seq"]), reference.source.seq >= 0, reference.source.seq <= seq else { return false }
        return true
    }

    private func baselineForCompleteCheckpoint(_ event: [String: Any], runtimeId: String) -> SessionAppliedBaseline? {
        guard let source = event["source"] as? [String: Any], let epoch = source["epoch"] as? String, !epoch.isEmpty,
              source["ready"] as? Bool == true, let seq = integer(source["seq"]),
              let checkpoint = event["checkpoint"] as? [String: Any], checkpoint["headCompleteness"] as? String == "complete",
              checkpoint["inventoryComplete"] as? Bool == true, let head = checkpoint["head"] as? [String: Any],
              (event["live"] as? [String: Any])?["complete"] as? Bool == true,
              head["leafId"] as? String == (event["cursor"] as? [String: Any])?["leafId"] as? String,
              let sessionId = runtimes.first(where: { $0.runtimeId == runtimeId })?.sessionId,
              (head["leafId"] as? String).map({ graphs[sessionId]?.entries[$0] != nil }) ?? true else { return nil }
        return SessionAppliedBaseline(epoch: epoch, seq: seq, leaf: head["leafId"] as? String)
    }

    private func validSnapshotSelection(_ event: [String: Any], pending: SessionSyncTransaction, runtimeId: String) -> Bool {
        let mode = event["mode"] as? String
        let selection = event["selection"] as? String ?? "snapshot"
        let source = event["source"] as? [String: Any]
        let cursor = event["cursor"] as? [String: Any]
        let target = event["targetLeafId"] as? String
        if let target, let cursor, target != cursor["leafId"] as? String { return false }
        if pending.range == "history" { return event["selection"] == nil && mode == "prepend" }
        if pending.range == "catchup" { return event["selection"] == nil && ["replace", "append"].contains(mode ?? "") }
        if selection == "snapshot" {
            guard mode == "replace", let source, let epoch = source["epoch"] as? String, !epoch.isEmpty,
                  source["ready"] as? Bool == true, integer(source["seq"]) != nil,
                  let checkpoint = event["checkpoint"] as? [String: Any], !(checkpoint["checkpointId"] as? String ?? "").isEmpty,
                  checkpoint["headCompleteness"] as? String == "complete", checkpoint["inventoryComplete"] as? Bool == true,
                  let head = checkpoint["head"] as? [String: Any], let cursor,
                  head["leafId"] as? String == cursor["leafId"] as? String,
                  (event["live"] as? [String: Any])?["complete"] as? Bool == true else { return false }
            return true
        }
        guard ["state", "delta", "unchanged"].contains(selection), let known = pending.known,
              mode == "append", source?["ready"] as? Bool == true, source?["epoch"] as? String == known.epoch,
              let seq = integer(source?["seq"]), let checkpoint = event["checkpoint"] as? [String: Any],
              checkpoint["headCompleteness"] as? String == "complete", checkpoint["inventoryComplete"] as? Bool == true,
              let head = checkpoint["head"] as? [String: Any], head["leafId"] as? String == cursor?["leafId"] as? String,
              event["complete"] as? Bool == true, event["rangeStatus"] as? String == "complete" else { return false }
        let entries = event["entries"] as? [[String: Any]] ?? []
        if selection == "unchanged" {
            return seq == known.seq && head["leafId"] as? String == known.leaf && entries.isEmpty &&
                (event["turnTimings"] as? [Any] ?? []).isEmpty && (event["live"] == nil || event["live"] is NSNull)
        }
        guard seq > known.seq, (event["live"] as? [String: Any])?["complete"] as? Bool == true,
              sourcePositions[runtimeId]?.epoch == known.epoch else { return false }
        if selection == "state" { return head["leafId"] as? String == known.leaf && entries.isEmpty && (event["turnTimings"] as? [Any] ?? []).isEmpty }
        var parent = known.leaf
        guard !entries.isEmpty else { return false }
        for entry in entries {
            guard entry["parentId"] as? String == parent, let id = entry["entryId"] as? String else { return false }
            parent = id
        }
        return parent == head["leafId"] as? String
    }

    private func applyProjection(_ event: [String: Any], runtimeId: String) {
        let live = event["live"] as? [String: Any]
        if let raw = live?["toolInventory"] as? [String: Any], let reference: ToolReference = jsonDecode(raw),
           reference.agent.hostId == selectedHostId,
           reference.agent.sessionId == runtimes.first(where: { $0.runtimeId == runtimeId })?.sessionId {
            toolInventories.require(reference, runtime: runtimeId)
            if liveToolReferences[runtimeId] != reference { liveToolReferences[runtimeId] = reference }
        } else if live != nil { liveToolReferences[runtimeId] = nil; liveTools[runtimeId] = nil }
        // 每一版 live.messages 都是源端完整的 live 清单（Host 也整份替换）：Pi/DSH 在提交 entry 的同一版里
        // 去掉对应的流式行，这里只等 complete 的话，整轮运行期间流式行会和落盘行并排出现。
        if let rows = live?["messages"] as? [[String: Any]] {
            let previousLive = liveMessageIds[runtimeId] ?? []
            let canonical = Set((displayMessageIds[runtimeId] ?? [:]).values)
            let next = Set(rows.compactMap { ($0["message"] as? [String: Any])?["messageId"] as? String })
            conversations[runtimeId]?.removeAll { previousLive.contains($0.messageId) && !canonical.contains($0.messageId) && !next.contains($0.messageId) }
            liveMessageIds[runtimeId] = []; liveOrders[runtimeId] = [:]
        }
        if let display = event["display"] as? [String: Any], let entries = display["entries"] as? [[String: Any]] {
            for row in entries {
                let entryId = row["entryId"] as? String
                let sessionId = runtimes.first(where: { $0.runtimeId == runtimeId })?.sessionId
                if let entryId, row["anchor"] as? String != "head", sessionId.flatMap({ excludedDisplayEntries[$0] })?.contains(entryId) == true { continue }
                let committed = sessionId.flatMap { session in (entryId ?? row["displayId"] as? String).flatMap { graphs[session]?.display[$0] } }
                let message: ChatMessage?
                if let committed { message = committed.message }
                else if let object = row["message"] as? [String: Any] { message = jsonDecode(object) }
                else { message = nil }
                if let entryId {
                    if let old = displayMessageIds[runtimeId]?[entryId], old != message?.messageId { conversations[runtimeId]?.removeAll { $0.messageId == old } }
                    displayMessageIds[runtimeId, default: [:]][entryId] = message?.messageId
                }
                if let message { upsert(message, runtimeId: runtimeId) }
            }
            if let boundary = display["windowStart"] as? String, let boundaryMessage = displayMessageIds[runtimeId]?[boundary],
               let index = conversations[runtimeId]?.firstIndex(where: { $0.messageId == boundaryMessage }), index > 0 {
                conversations[runtimeId]?.removeFirst(index)
            }
            let headIds = Set(entries.filter { $0["anchor"] as? String == "head" }.compactMap { ($0["message"] as? [String: Any])?["messageId"] as? String })
            if !headIds.isEmpty, let messages = conversations[runtimeId] {
                conversations[runtimeId] = messages.filter { headIds.contains($0.messageId) } + messages.filter { !headIds.contains($0.messageId) }
            }
        }
        if let live, let entries = live["messages"] as? [[String: Any]] {
            for row in entries {
                if let object = row["message"] as? [String: Any], let message: ChatMessage = jsonDecode(object) {
                    if let entryId = row["persistedEntryId"] as? String { addAlias(message.messageId, entryId: entryId, runtimeId: runtimeId) }
                    if isRetiredAlias(message.messageId, runtimeId: runtimeId) {
                        conversations[runtimeId]?.removeAll { $0.messageId == message.messageId }
                        continue
                    }
                    liveMessageIds[runtimeId, default: []].insert(message.messageId)
                    if let order = integer(row["order"]) { liveOrders[runtimeId, default: [:]][message.messageId] = order }
                    upsert(message, runtimeId: runtimeId)
                }
            }
        }
        if let sessionId = runtimes.first(where: { $0.runtimeId == runtimeId })?.sessionId,
           let graph = graphs[sessionId], let boundary = graph.windowStart {
            let excluded = Set(graph.path(to: boundary).dropLast().compactMap { displayMessageIds[runtimeId]?[$0.entryId] })
            conversations[runtimeId]?.removeAll { excluded.contains($0.messageId) }
        }
        retireAliases(runtimeId)
    }

    private func addAlias(_ liveId: String, entryId: String, runtimeId: String) {
        guard liveId != entryId else { return }
        var aliases = messageAliases[runtimeId] ?? [:]
        if aliases.count >= 1024 { aliases.removeAll() }
        aliases[liveId] = entryId
        messageAliases[runtimeId] = aliases
    }

    /// 临时 id 对应的 entry 已经作为权威行上屏，且权威行用的是另一个 id。
    private func isRetiredAlias(_ id: String, runtimeId: String) -> Bool {
        guard let entryId = messageAliases[runtimeId]?[id], let canonical = displayMessageIds[runtimeId]?[entryId] else { return false }
        return canonical != id
    }

    /// 权威行到达后退掉它的临时行；映射保留，迟到的同 id 生命周期事件不会再把临时行带回来。
    private func retireAliases(_ runtimeId: String) {
        guard let aliases = messageAliases[runtimeId], !aliases.isEmpty else { return }
        let retired = Set(aliases.keys.filter { isRetiredAlias($0, runtimeId: runtimeId) })
        guard !retired.isEmpty else { return }
        conversations[runtimeId]?.removeAll { retired.contains($0.messageId) }
        liveMessageIds[runtimeId]?.subtract(retired)
    }

    private func acknowledge(runtimeId: String, syncId: String, result: String) {
        if let receipt = snapshotCandidates.removeValue(forKey: syncId), result == "applied" {
            if snapshotReceipts.count >= 32, let first = snapshotReceipts.keys.first { snapshotReceipts[first] = nil }
            snapshotReceipts[syncId] = receipt
        }
        _ = sendCommand(runtimeId: runtimeId, commandId: "session-sync-ack:\(UUID().uuidString)",
            command: ["type": "session.snapshot.ack", "syncId": syncId, "result": result])
    }

    private func upsert(_ message: ChatMessage, runtimeId: String) {
        var values = conversations[runtimeId] ?? []
        if let index = values.firstIndex(where: { $0.messageId == message.messageId }) { values[index] = message }
        else { values.append(message) }
        conversations[runtimeId] = values
    }

    private func applyDelta(_ event: [String: Any], runtimeId: String) {
        guard let id = event["messageId"] as? String, let delta = event["delta"] as? String,
              !isRetiredAlias(id, runtimeId: runtimeId) else { return }
        let kind = event["contentType"] as? String ?? "text"
        let previous = conversations[runtimeId]?.first { $0.messageId == id }
        var content = previous?.content ?? []
        let index = integer(event["contentIndex"]).map(Int.init) ?? (content.last?.type == kind ? max(0, content.count - 1) : content.count)
        guard (0...1024).contains(index) else { return }
        while content.count <= index { content.append(ChatContent(type: kind, text: "", toolName: nil, artifact: nil)) }
        let item = content[index]
        content[index] = ChatContent(type: item.type, text: (item.text ?? "") + delta, toolName: item.toolName, artifact: item.artifact, summary: item.summary, toolCallId: item.toolCallId,
            truncated: item.truncated, originalBytes: item.originalBytes, arguments: item.arguments)
        upsert(ChatMessage(messageId: id, role: previous?.role ?? "assistant", content: content,
            timestamp: previous?.timestamp ?? Int64(Date().timeIntervalSince1970 * 1000), isError: previous?.isError,
            toolSummary: previous?.toolSummary, toolCallId: previous?.toolCallId, toolName: previous?.toolName), runtimeId: runtimeId)
    }

    private func publishMessages() {
        guard let runtimeId = selectedRuntimeId else { messages = []; updateSyncing(); return }
        let visibleTimings = selectedRuntime?.sessionId.flatMap { timingsBySession[$0] } ?? [:]
        if visibleTimings != turnTimings { turnTimings = visibleTimings }
        // 清单尚未追上本次投影时沿用上一次已确认的工具，避免卡片闪烁或用旧清单造出重复卡片。
        if let reference = liveToolReferences[runtimeId], toolInventories.covers(reference, runtime: runtimeId) {
            liveTools[runtimeId] = toolInventories.visible[runtimeId] ?? []
        }
        // Publishing an identical transcript would re-render the whole chat for nothing; the
        // comparison is O(1) when the array storage is unchanged.
        let next = materializeLiveTools(conversations[runtimeId] ?? [], tools: liveTools[runtimeId] ?? [], liveOrders: liveOrders[runtimeId] ?? [:])
        if next != messages { messages = next }
        updateSyncing()
        dispatchSyncDemands()
    }

    private func dispatchSyncDemands() {
        let ready = syncDemands.filter { id in
            !pendingSyncs.values.contains { $0.runtimeId == id && $0.range != "catchup" && !$0.exhausted } &&
            !toolAcknowledgements.values.contains { $0.runtimeId == id }
        }
        for id in ready {
            guard let runtime = runtimes.first(where: { $0.runtimeId == id }) else { syncDemands.remove(id); continue }
            syncDemands.remove(id); syncSession(runtime, force: true)
        }
    }

    private func invalidateConversation(_ runtimeId: String) {
        historyWriteLeases.removeValue(forKey: runtimeId)?.invalidate()
        branchGenerations[runtimeId, default: 0] += 1
        for read in sessionReads.operations.values where read.owner.historyKey == runtimeId && read.phase.active {
            sessionReads.finish(read.id, phase: .superseded); pendingCatchups[read.id] = nil
        }
        oldestEntries[runtimeId] = nil; sessionLeaves[runtimeId] = nil; hasOlderHistory[runtimeId] = nil; historyErrors[runtimeId] = nil; historyLoading.remove(runtimeId)
        toolInventories.clear(runtimeId)
        agentState.remove(runtimeId: runtimeId); queuedMessages[runtimeId] = nil
        for (id, pending) in queueCommands where pending.runtimeId == runtimeId {
            queueCommands[id] = nil; pendingQueueCancellations.remove(pending.queueId); actionTimeouts.removeValue(forKey: id)?.cancel()
        }
        let toolAcks = toolAcknowledgements.filter { $0.value.runtimeId == runtimeId }.map(\.key)
        for id in toolAcks {
            toolAcknowledgements[id] = nil; pendingReadPages[id] = nil; pendingAppliedBaselines[id] = nil
            if let read = syncReads.removeValue(forKey: id) { sessionReads.finish(read, phase: .superseded) }
            acknowledge(runtimeId: runtimeId, syncId: id, result: "rejected")
        }
        interactions[runtimeId] = nil; commands[runtimeId] = nil; workingBranches[runtimeId] = nil
        if entryPreview?.runtimeId == runtimeId { dismissPreview() }
        let actions = runtimeActions.filter { $0.value.runtimeId == runtimeId }.map(\.key)
        for id in actions { runtimeActions[id] = nil; pendingActionIds.remove(id); actionTimeouts.removeValue(forKey: id)?.cancel() }
        conversations[runtimeId] = nil
        liveMessageIds[runtimeId] = nil; liveOrders[runtimeId] = nil; liveToolReferences[runtimeId] = nil; liveTools[runtimeId] = nil
        displayMessageIds[runtimeId] = nil; messageAliases[runtimeId] = nil
        sourcePositions[runtimeId] = nil; appliedBaselines[runtimeId] = nil; retiredEpochs[runtimeId] = nil; syncDemands.remove(runtimeId)
        pendingLiveBaselines[runtimeId] = nil
        syncedSessions = syncedSessions.filter { !$0.hasPrefix(runtimeId + "|") }
        let ids = pendingSyncs.filter { $0.value.runtimeId == runtimeId }.map(\.key)
        ids.forEach { finishSync($0) }
        runtimeEventSequences = runtimeEventSequences.filter { !$0.key.hasPrefix(runtimeId + "\u{0000}") }
    }

    private func clearSyncs() {
        syncTimeouts.values.forEach { $0.cancel() }
        for id in syncReads.values { sessionReads.finish(id, phase: .superseded) }
        syncReads = [:]; pendingReadPages = [:]; pendingCatchups = [:]; pendingLiveBaselines = [:]
        toolAcknowledgements = [:]; pendingAppliedBaselines = [:]; toolInventories.clear()
        syncTimeouts = [:]; pendingSyncs = [:]; syncedSessions = []; syncDemands = []; snapshotCandidates = [:]; snapshotReceipts = [:]
        historyLoading = []
        updateSyncing()
    }

    private func finishSync(_ syncId: String, readPhase: SessionReadPhase? = .cancelled) {
        let wasCatchup = pendingSyncs[syncId]?.range == "catchup"
        if let phase = readPhase, let read = syncReads.removeValue(forKey: syncId) { sessionReads.finish(read, phase: phase) }
        if let pending = pendingSyncs[syncId], pending.range == "history" { historyLoading.remove(pending.runtimeId) }
        pendingSyncs[syncId] = nil
        syncTimeouts.removeValue(forKey: syncId)?.cancel()
        updateSyncing()
        if wasCatchup { pumpCatchups() }
    }

    private func updateSyncing() {
        isSyncing = sessionReads.operations.values.contains { $0.owner.historyKey == selectedRuntimeId && $0.kind == .source && $0.phase.active }
        transfers.setInteractive(pendingSyncs.values.contains { !$0.exhausted } || !syncDemands.isEmpty ||
            !runtimeActions.isEmpty || !queueCommands.isEmpty || runtimes.contains { $0.status == "running" })
    }

    private func armSyncTimeout(_ syncId: String, seconds: Double) {
        syncTimeouts[syncId]?.cancel()
        syncTimeouts[syncId] = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: UInt64(max(0.1, seconds) * 1_000_000_000)) } catch { return }
            guard let self else { return }
            self.advanceSessionSyncs()
        }
    }

    /// One immutable transaction is retried with the same identifiers. Local exhaustion releases
    /// the spinner, while bounded correlation still permits an authenticated late result.
    func advanceSessionSyncs(now: Date = Date()) {
        for (id, value) in pendingSyncs {
            var task = value
            if task.exhausted {
                if now.timeIntervalSince(task.firstSentAt) >= 300 { finishSync(id) }
                continue
            }
            if now >= task.deadline {
                task.exhausted = true; pendingSyncs[id] = task
                if let read = syncReads[id] { sessionReads.finish(read, phase: .failed, error: "同步暂未完成，请重试。") }
                historyLoading.remove(task.runtimeId)
                if task.range == "history" { historyErrors[task.runtimeId] = "历史读取暂未完成，请重试。" }
                else { errorMessage = "会话同步暂未完成，请重试。" }
                armSyncTimeout(id, seconds: 150); continue
            }
            let delay: Double = task.attempts < 3 ? 30 : 60
            if task.attempts < 4, now.timeIntervalSince(task.sentAt) >= delay {
                _ = sendCommand(runtimeId: task.runtimeId, commandId: task.commandId, command: task.command)
                task.attempts += 1; task.sentAt = now; pendingSyncs[id] = task
            }
            armSyncTimeout(id, seconds: min(max(0.1, task.deadline.timeIntervalSince(now)), task.attempts < 3 ? 30 : 60))
        }
        updateSyncing()
    }

    private func integer(_ value: Any?) -> Int64? { sessionInteger(value) }
    private func jsonDecode<T: Decodable>(_ value: [String: Any]) -> T? {
        guard let data = try? JSONSerialization.data(withJSONObject: value) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }

    private func mergeRuntime(_ current: RuntimeSummary, metadata: [String: Any]) -> RuntimeSummary {
        guard let data = try? JSONEncoder().encode(current), var merged = try? E2ECrypto.jsonObject(data) else { return current }
        for (key, value) in metadata { merged[key] = value }
        return jsonDecode(merged) ?? current
    }
}
