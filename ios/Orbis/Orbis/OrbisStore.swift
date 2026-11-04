import Foundation
import Combine
#if canImport(UIKit)
import UIKit
#endif

struct HomeRuntimeCard: Equatable, Identifiable {
    let runtime: RuntimeSummary
    let title: String
    let agentKind: String
    let hasPendingInteraction: Bool
    var id: String { runtime.runtimeId }
}

enum HomePresentation: Equatable {
    case preparing
    case ready([HomeRuntimeCard])
}

/// 首页同步进度。首版快照发布前由列表区域显示，发布后由连接胶囊显示，不再占用单独一行。
enum HomeSyncStatus: Equatable {
    case idle
    case syncing
    case failed(String)
}

@MainActor
final class HostConnection: ObservableObject {
    let transfers: FileTransfers
    let toolContent = ToolContentReader()
    let turnFileChanges = TurnFileChanges()
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
    @Published private(set) var pathRTT: Double?
    @Published private(set) var activationRevision = 0
    @Published private(set) var pendingActionIds: Set<String> = []
    @Published private(set) var actionFeedback: String?
    @Published private(set) var workingBranches: [String: WorkingBranch] = [:]
    @Published private(set) var entryPreview: EntryPreview?
    @Published private(set) var historyRevision = 0
    @Published private(set) var interactions: [String: [InteractionRequest]] = [:]
    /// 回答结算后在原位短暂显示的结果（约 2.5 秒，V16）：runtimeId → 结果。
    @Published private(set) var interactionOutcomes: [String: InteractionOutcome] = [:]
    struct InteractionOutcome: Equatable { let id: UUID; let text: String }
    @Published private(set) var queuedMessages: [String: [QueuedMessage]] = [:]
    /// ADR-0049：本机已发出、尚未在源端落地的消息。按 Session 归属，只属于 `pendingSendHostId`。
    @Published private(set) var pendingSends = PendingSendOutbox()
    private var pendingSendHostId: String?
    /// 每个 Session 应用权威状态（快照或完整 patch）的次数，用于兜底核对。
    private var sessionRevisions: [String: Int] = [:]
    private var pendingSendCheck: Task<Void, Never>?
    /// ADR-0049 §7：本连接的操作账本。乐观操作的阶段、断线、期限、作用域和冲突只在账本里处理；
    /// 界面 = 权威状态叠加账本，种类定义见 `OperationKinds`。只在当前进程内存中（L11）。
    @Published private(set) var ledger = AppLedger()
    /// 账本属于哪台电脑：换电脑时全部失效（L7）。
    private var ledgerHostId: String?
    /// 当前加密连接是否已计入账本的连接代次。
    private var ledgerConnectionOpen = false
    /// 各领域已应用权威状态的次数，作为账本的领域序号（basis）。
    private var authoritySeq: [String: Int] = [:]
    /// 本连接上已收到过权威状态的领域：核对读取只为它们作证，避免用上一条连接留下的旧状态下结论。
    private var ledgerFresh: Set<String> = []
    /// 账本发起、尚未回复的核对读取：requestId → 读取序号（L5）。
    private var ledgerReads: [String: Int] = [:]
    private var ledgerClock: Task<Void, Never>?
    private var flushingSends = false

    /// ADR-0049 §6.8：正在启动的会话。启动期间聊天页用占位身份显示，草稿与消息先归属它，Session ID 确认后迁移。
    struct LaunchState: Equatable {
        let requestId: String
        let placeholder: String
        let target: [String: String]
        let title: String
        let cwd: String
        let agentKind: String?
        /// 恢复的已有会话；新建时为 nil。启动期间聊天页、草稿与消息都用它（或占位身份）归属，保持稳定。
        let resumed: String?
        /// Host 在 `session.activated` 中给出的 Session。
        var sessionId: String?
        var failure: String?
        var unconfirmed = false
        /// 用户仍停在这个启动页：成功后切到真实会话；离开后不再把用户拉回，会话照常出现在首页。
        var following = true
    }
    @Published private(set) var launching: LaunchState?
    /// 启动期间消息的占位 Session → 确认后的 Session。
    private var launchSessions: [String: String] = [:]
    /// 启动页输入框是否有焦点；会话上线切到真实会话页时把焦点交给新页面，正在输入不被打断（ADR-0049 §6.8）。
    private var launchComposerFocused = false
    private var composerFocusHandoff: String?
    /// 首页正在关闭的会话（含结果不明）：卡片保持隐藏。
    var closingRuntimeIds: Set<String> { OperationKinds.hiddenRuntimeIds(ledger) }
    /// 首页只发布完整快照：冷启动准备一次，后续重连/刷新在后台组装下一版。
    /// 此快照只在当前配对的内存中保留，不把磁盘目录缓存当成本次在线会话。
    @Published private(set) var homePresentation: HomePresentation = .preparing
    private var homeDirectoryReceived = false
    private static let homeDomains = ["identity", "execution", "interactions"]
    var homeRuntimesLoading: Bool { if case .preparing = homePresentation { return true }; return false }
    /// 独立于已展示列表的同步进度，只用于首页的小状态行。
    var homeRuntimesUpdating: Bool {
        connection != .secured || !homeDirectoryReceived || !runtimes.allSatisfy(homeFactsComplete)
    }
    var homeCards: [HomeRuntimeCard] {
        guard case .ready(let cards) = homePresentation else { return [] }
        let closing = closingRuntimeIds
        return cards.filter { !closing.contains($0.id) }
    }
    var homeRuntimes: [RuntimeSummary] { homeCards.map(\.runtime) }

    private func homeFactsComplete(_ runtime: RuntimeSummary) -> Bool {
        guard let session = runtime.sessionId, !session.isEmpty,
              let snapshot = agentState.snapshots[runtime.runtimeId], snapshot.sessionId == session,
              snapshot.error == nil,
              !(runtime.agentKind ?? sessionIndex[session]?.agentKind ?? "").isEmpty,
              !runtime.cwd.isEmpty else { return false }
        return Self.homeDomains.allSatisfy { name in
            guard !snapshot.pending.contains(name), snapshot.missing[name] == nil,
                  let domain = snapshot.domains[name] else { return false }
            return domain.availability == "ready" && (domain.completeness == "complete" || domain.projectionComplete == true)
        }
    }

    /// 在完整消息应用后提交，不能在各 @Published 字段的 willChange 中拼出半张卡片。
    private func commitHomePresentation() {
        guard homeDirectoryReceived, connection == .secured, runtimes.allSatisfy(homeFactsComplete) else { return }
        let cards = runtimes.map { runtime in
            HomeRuntimeCard(runtime: runtime, title: displayName(runtime),
                agentKind: runtime.agentKind ?? sessionIndex[runtime.sessionId ?? ""]?.agentKind ?? "",
                hasPendingInteraction: !(interactions[runtime.runtimeId] ?? []).isEmpty)
        }.sorted { lhs, rhs in
            let left = lhs.runtime.sessionId.flatMap { sessionIndex[$0]?.modifiedAt } ?? 0
            let right = rhs.runtime.sessionId.flatMap { sessionIndex[$0]?.modifiedAt } ?? 0
            if left != right { return left > right }
            let order = lhs.title.localizedStandardCompare(rhs.title)
            return order == .orderedSame ? lhs.id < rhs.id : order == .orderedAscending
        }
        let next = HomePresentation.ready(cards)
        if homePresentation != next { homePresentation = next }
    }

    func homeCardIsCurrent(_ card: HomeRuntimeCard) -> Bool {
        connection == .secured && card.runtime.sessionId != nil && runtimes.contains {
            $0.runtimeId == card.id && $0.sessionId == card.runtime.sessionId && $0.agentKind == card.runtime.agentKind
        }
    }
    var homeRuntimesError: String? {
        guard homeRuntimesUpdating else { return nil }
        if connection == .offline || connection == .error { return L10n.tr("电脑未连接，请重新连接") }
        let closing = closingRuntimeIds
        for runtime in runtimes where !closing.contains(runtime.runtimeId) {
            guard let session = runtime.sessionId, !session.isEmpty else {
                return L10n.tr("会话身份尚未就绪，请重新加载")
            }
            guard let snapshot = agentState.snapshots[runtime.runtimeId], snapshot.sessionId == runtime.sessionId else { continue }
            if let error = snapshot.error { return error }
            if Self.homeDomains.contains(where: { snapshot.missing[$0] != nil }) {
                return L10n.tr("会话信息未能完整读取，请重新加载")
            }
            if Self.homeDomains.allSatisfy({ !snapshot.pending.contains($0) }) && !homeFactsComplete(runtime) {
                return L10n.tr("会话信息未能完整读取，请重新加载")
            }
        }
        return nil
    }
    var homeSyncStatus: HomeSyncStatus {
        guard homeRuntimesUpdating else { return .idle }
        return homeRuntimesError.map(HomeSyncStatus.failed) ?? .syncing
    }
    @Published private(set) var hasOlderHistory: [String: Bool] = [:]
    @Published private(set) var historyLoading: Set<String> = []
    @Published private(set) var historyErrors: [String: String] = [:]
    @Published private(set) var historyPageRevision = 0
    @Published private(set) var currentProviders: [String: String] = [:]
    /// 仅供「原始事件」页查看；每收到一帧都会追加，不发布变更，免得每帧都让整棵视图树重绘。
    private(set) var connectionEvents: [String] = []

    private var agentStateObservation: AnyCancellable?
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
    private var lastTranscriptRows: [ChatRow] = []
    /// Rows of the selected conversation, rebuilt only after its messages or timings change.
    var chatTranscript: ChatTranscript {
        if let transcriptCache { return transcriptCache }
        let built = ChatTranscript(messages: messages, turnTimings: turnTimings, previousRows: lastTranscriptRows)
        transcriptCache = built
        lastTranscriptRows = built.rows
        return built
    }
    private var timingsBySession: [String: [String: SessionTurnTiming]] = [:]
    private var cachedIndexLoaded = false
    private var pendingEvents: [(message: [String: Any], channel: String?, bytes: Int, payload: Data?)] = []
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
    private var composerActionDrafts: [String: (key: String, text: String)] = [:]
    private var actionTimeouts: [String: Task<Void, Never>] = [:]
    private var feedbackTimeout: Task<Void, Never>?
    private var previewTimeout: Task<Void, Never>?
    private var branchEditorNode: String?
    private var branchEditorText: String?
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
    private var unfinishedLiveMessageIds: [String: Set<String>] = [:]
    @Published private(set) var streamingMessageIds: Set<String> = []
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
    // The Host echoes a rejected ACK as protocol.error; the local read already owns its result.
    private var handledSyncRejections: [String] = []
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
        preferences?.removeObject(forKey: "orbis.sessionAliases")
        drafts = preferences?.dictionary(forKey: "orbis.sessionDrafts") as? [String: String] ?? [:]
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
        agentStateObservation = agentState.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }
        notifications.send = { [weak self] in self?.transport.send($0) ?? false }
        agentState.didProject = { [weak self] runtimeId, sessionId, domains in
            guard let self, let index = self.runtimes.firstIndex(where: { $0.runtimeId == runtimeId && $0.sessionId == sessionId }),
                  let hostId = self.selectedHostId,
                  let projection = AgentProjection.make(runtime: self.runtimes[index], hostId: hostId, domains: domains,
                    commands: self.commands[runtimeId] ?? [], interactions: self.interactions[runtimeId] ?? [], queuedMessages: self.queuedMessages[runtimeId] ?? []) else { return false }
            self.runtimes[index] = projection.runtime
            if domains["identity"]?.availability == "ready" { self.persistIdentity(projection.runtime) }
            self.commands[runtimeId] = projection.commands
            self.interactions[runtimeId] = projection.interactions
            self.queuedMessages[runtimeId] = projection.queuedMessages
            if domains["delivery"] != nil { self.ledgerAuthority(OperationKinds.queueDomain(runtimeId), read: nil, complete: true) }
            if domains["interactions"] != nil { self.ledgerAuthority(OperationKinds.interactionsDomain(runtimeId), read: nil, complete: true) }
            if domains["model"] != nil { self.ledgerAuthority(OperationKinds.modelDomain(runtimeId), read: nil, complete: true) }
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
            // ADR-0049 §7.5：完整目录是归档的权威状态。
            self.ledgerAuthority(OperationKinds.catalogDomain, read: nil, complete: true)
        }
        hostState.didChangeProviders = { [weak self] in self?.refreshSessions() }
        transfers.sendBinary = { [weak self] in self?.transport.sendBinary($0) ?? false }
        transfers.didSettleUpload = { [weak self] id, path, error in self?.uploadSettled(id, path: path, error: error) }
        turnFileChanges.send = { [weak self] runtime, command in self?.sendCommand(runtimeId: runtime, command: command) ?? false }
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
                    if let read = self.syncReads.removeValue(forKey: id) { self.sessionReads.finish(read, phase: .failed, error: L10n.tr("工具清单已更新，请重新同步。")) }
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
        if let launch = launching, selectedRuntimeId == launch.placeholder || launch.resumed != nil && selectedOfflineSession?.sessionId == launch.resumed {
            let session = selectedOfflineSession
            return RuntimeSummary(runtimeId: session.map { "cached:" + $0.sessionId } ?? launch.placeholder, name: session?.name ?? launch.title,
                cwd: session?.cwd ?? launch.cwd, status: launch.failure != nil ? "error" : launch.unconfirmed ? "launch_unconfirmed" : "starting",
                // 标题用启动目标的名称；sessionName 为空时 sessionTitle 会退回到占位 id。
                sessionId: session?.sessionId ?? launch.resumed ?? launch.placeholder, sessionName: session?.name ?? launch.title,
                hostname: session?.hostname, agentKind: session?.agentKind ?? launch.agentKind)
        }
        if let session = selectedOfflineSession {
            return RuntimeSummary(runtimeId: "cached:" + session.sessionId, name: session.name ?? session.sessionId,
                cwd: session.cwd, status: "offline", sessionId: session.sessionId, sessionName: session.name,
                hostname: session.hostname, agentKind: session.agentKind)
        }
        return runtimes.first { $0.runtimeId == selectedRuntimeId }
    }
    var canSend: Bool {
        // ADR-0049 §6.8：启动中可以输入草稿和发送，消息等会话上线后再提交。
        connection == .secured && selectedRuntime != nil && (selectedOfflineSession == nil || isLaunchPage) && launching?.failure == nil
    }
    /// 当前聊天页是启动中的会话（占位或缓存历史）。
    /// 启动页上输入框焦点的变化；只在启动页记录，供会话上线时交接。
    func noteComposerFocus(_ focused: Bool) { if isLaunchPage { launchComposerFocused = focused } }
    /// 新会话页出现时取一次交接来的焦点。
    func takeComposerFocus(_ runtimeId: String) -> Bool {
        guard composerFocusHandoff == runtimeId else { return false }
        composerFocusHandoff = nil
        return true
    }
    var isLaunchPage: Bool {
        guard let launch = launching else { return false }
        return selectedRuntimeId == launch.placeholder || (launch.resumed != nil && selectedOfflineSession?.sessionId == launch.resumed)
    }

    func displayName(_ runtime: RuntimeSummary) -> String {
        sessionTitle(runtime: runtime, session: runtime.sessionId.flatMap { sessionIndex[$0] },
                     messages: conversations[runtime.runtimeId] ?? [])
    }

    func displayName(_ session: SessionSummary) -> String {
        if let runtime = runtimes.first(where: { $0.sessionId == session.sessionId }) { return displayName(runtime) }
        return sessionTitle(runtime: nil, session: session)
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
        }
        pairings = []
        guard selectedHostId == hostId else { return }
        connectionGeneration = UUID()
        cancelPendingWork()
        if let host = selectedHost { historyWorker.invalidate(host: host) }
        transport.disconnect()
        clearSyncs(); dismissBrowse(); clearActivation()
        conversations = [:]; messages = []; runtimes = []; sessions = []; commands = [:]
        homeDirectoryReceived = false; homePresentation = .preparing
        selectedRuntimeId = nil; selectedHostId = nil; activePath = nil; pathRTT = nil; connection = .offline
        currentProviders = [:]; sessionListRequest = nil; modelCatalogReceived = false; authenticatedModelEpoch = nil; connectionEvents = []
        transfers.setConnection(nil, connected: false)
        hostState.setConnection(nil, connected: false)
        agentState.setConnection(nil, connected: false)
        notifications.setConnection(nil, connected: false)
        toolContent.close(); turnFileChanges.clear(); toolInventories.clear(); toolAcknowledgements = [:]; pendingAppliedBaselines = [:]
        interactions = [:]; queuedMessages = [:]; interactionOutcomes = [:]; workingBranches = [:]; dismissPreview()
        pendingSends.removeAll(); pendingSendHostId = nil; sessionRevisions = [:]
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
        toolContent.close(); turnFileChanges.clear(); toolInventories.clear()
        // 账本只属于这一次运行中的连接（L7、L11）。
        ledgerConnectionOpen = false; ledgerReads = [:]
        handleLedger(ledger.expire { _ in true })
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
        homeDirectoryReceived = false
        connectionGeneration = UUID()
        cancelPendingWork()
        historyGeneration = UUID(); historyConnected = false
        historyWorker.setGeneration(historyGeneration, host: pairing)
        let generation = connectionGeneration
        selectedHostId = pairing.hostId
        if pendingSendHostId != pairing.hostId { pendingSends.removeAll(); pendingSendHostId = pairing.hostId; sessionRevisions = [:] }
        else { pendingSends.connectionLost() }
        restoreWaitingCopies()
        // 换电脑：旧电脑上的操作全部失效（L7）；同一台电脑重连：已写入的操作转结果不明（L4）。
        if ledgerHostId != pairing.hostId {
            ledgerConnectionOpen = false; ledgerReads = [:]
            handleLedger(ledger.expire { _ in true }); ledgerHostId = pairing.hostId
        } else { ledgerCloseConnection() }
        connection = .connecting
        hostState.setConnection(pairing, connected: false)
        agentState.setConnection(pairing, connected: false)
        notifications.setConnection(pairing, connected: false)
        currentProviders = [:]; sessionListRequest = nil; modelCatalogReceived = false; authenticatedModelEpoch = nil; connectionEvents = []
        transfers.setConnection(pairing, connected: false)
        toolContent.close(); turnFileChanges.clear(); toolInventories.clear(); toolAcknowledgements = [:]; pendingAppliedBaselines = [:]
        runtimes = []; sessions = cachedSessions(pairing); messages = []; selectedRuntimeId = nil; selectedOfflineSession = nil
        cachedSessionIds = []; cachedIndexLoaded = false; cachedHistoryOptions = []; turnTimings = [:]; timingsBySession = [:]
        loadCachedIndex(pairing)
        conversations = [:]; liveMessageIds = [:]; unfinishedLiveMessageIds = [:]; streamingMessageIds = []; displayMessageIds = [:]; messageAliases = [:]; excludedDisplayEntries = [:]
        liveOrders = [:]; liveToolReferences = [:]; liveTools = [:]
        oldestEntries = [:]; sessionLeaves = [:]; hasOlderHistory = [:]; historyErrors = [:]; historyLoading = []
        sourcePositions = [:]; appliedBaselines = [:]; retiredEpochs = [:]; graphs = [:]; runtimeEventSequences = [:]
        pendingActivation = nil; activePath = nil
        interactions = [:]; queuedMessages = [:]; interactionOutcomes = [:]
        workingBranches = [:]; dismissPreview()
        actionTimeouts.values.forEach { $0.cancel() }; actionTimeouts = [:]; runtimeActions = [:]; composerActionDrafts = [:]; pendingActionIds = []; setActionFeedback(nil)
        pathRTT = nil; commands = [:]; supportedAgents = nil; launchableAgents = nil; codexDesktop = nil
        dismissBrowse(); clearActivation()
        clearSyncs()
        transport.connect(pairing: pairing, identity: identity, receive: { [weak self] message, channel in
            guard let self, self.connectionGeneration == generation else { return }
            self.receive(message, channel: channel)
        }, state: { [weak self] state, error in
            guard let self, self.connectionGeneration == generation else { return }
            self.setHistoryConnection(state == .secured)
            // 断线时已写入的操作结果未知，列表类保持叠加（L4）；新连接的首个 device.ready 再核对。
            if state != .secured { self.pendingSends.connectionLost(); self.ledgerCloseConnection() }
            else { self.ledgerOpenConnection() }
            self.connection = state
            if state != .secured { self.pathRTT = nil }
            if state != .secured { self.homeDirectoryReceived = false }
            self.recordConnectionEvent(L10n.tr("连接：{0}", state.rawValue))
            self.transfers.setConnection(self.selectedHost, connected: state == .secured)
            if state != .secured { self.hostState.setConnection(self.selectedHost, connected: false); self.agentState.setConnection(self.selectedHost, connected: false); self.notifications.setConnection(self.selectedHost, connected: false) }
            if state == .offline || state == .connecting {
                self.toolContent.close(); self.turnFileChanges.disconnected()
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
        if selectedRuntimeId != runtimeId { toolContent.close(); turnFileChanges.closeViewer() }
        selectedRuntimeId = runtimeId; selectedOfflineSession = nil; cachedHistoryOptions = []
        cancelForegroundReads(except: runtimeId)
        if let runtime = selectedRuntime { seedCachedHistory(runtime) }
        publishMessages()
        if let runtime = selectedRuntime { saveLastSession(runtime); agentState.subscribe(runtime: runtime); syncSession(runtime, force: true) }
        // The visible ChatView owns the initial Git refresh and its polling lifetime.
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
                if self.entryPreview?.message == nil { self.entryPreview?.error = L10n.tr("此节点没有可显示的缓存内容。") }
            }
            return
        }
        guard canSend else { return }
        previewTimeout?.cancel()
        let id = UUID().uuidString
        entryPreview = EntryPreview(requestId: id, runtimeId: runtime.runtimeId, sessionId: sessionId, entryId: entryId)
        guard sendCommand(runtimeId: runtime.runtimeId, commandId: id, command: ["type": "session.entry.request", "requestId": id,
                     "sessionId": sessionId, "entryId": entryId]) else {
            entryPreview?.loading = false; entryPreview?.error = L10n.tr("预览请求未送达。"); return
        }
        previewTimeout = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 20_000_000_000) } catch { return }
            guard let self, self.entryPreview?.requestId == id else { return }
            self.entryPreview?.loading = false; self.entryPreview?.error = L10n.tr("预览读取超时，请重试。")
        }
    }

    func dismissPreview() { previewTimeout?.cancel(); entryPreview = nil }

    func userMessageRewindOptions(for runtime: RuntimeSummary) -> [String: RuntimeOption] {
        guard !isViewingCachedSession,
              let argument = commands[runtime.runtimeId]?.first(where: { $0.name == "tree" })?.argument,
              argument.kind == "tree" else { return [:] }
        var options: [String: RuntimeOption] = [:]
        for option in argument.options ?? [] where option.tree?.role == "user" && option.tree?.isOnActivePath == true {
            let messageId = displayMessageIds[runtime.runtimeId]?[option.value] ?? option.value
            options[messageId] = option
        }
        return options
    }

    func moveHistory(to option: RuntimeOption, fallbackText: String? = nil) -> Bool {
        guard runtimeActions.isEmpty, let runtime = selectedRuntime,
              commands[runtime.runtimeId]?.first(where: { $0.name == "tree" })?.argument?.options?.contains(option) == true else { return false }
        guard executeSlash("tree", args: option.value) else { return false }
        branchEditorNode = option.tree?.role == "user" ? option.value : nil
        branchEditorText = branchEditorNode == nil ? nil : fallbackText
        return true
    }

    /// ADR-0049 §6.5 `respond`：面板立即收起，原位显示回答摘要；回执、断线、期限与核对全部交给账本。
    @discardableResult
    func respond(_ request: InteractionRequest, response: [String: Any]) -> Bool {
        guard connection == .secured, request.expiresAt > Int64(Date().timeIntervalSince1970 * 1000), request.acceptsResponse(response),
              interactions[request.runtimeId]?.contains(where: { $0 == request && $0.submitted != true }) == true else { return false }
        let id = UUID().uuidString
        let creation = ledger.create(opId: id, kind: OperationKinds.respond,
                                     target: OperationKinds.respondTarget(runtimeId: request.runtimeId, requestId: request.requestId),
                                     policy: OperationKinds.respondPolicy, basis: ledgerBasis(OperationKinds.interactionsDomain(request.runtimeId)),
                                     payload: .respond(runtimeId: request.runtimeId, requestId: request.requestId,
                                                       summary: OperationKinds.respondSummary(request, response: response)),
                                     written: false, now: Date())
        guard creation == .created else { return false }
        guard sendCommand(runtimeId: request.runtimeId, commandId: id, command: ["type": "interaction.respond", "requestId": request.requestId,
                        "extensionId": request.extensionId, "response": response]) else {
            ledger.remove(id); handleLedger([])
            errorMessage = L10n.tr("交互响应未送达，请连接后重试。"); return false
        }
        handleLedger(ledger.written(id, now: Date()))
        return true
    }

    /// 正在回答、尚未结算的请求：面板收起，草稿保留。
    func respondingRequestIds(_ runtimeId: String) -> Set<String> { OperationKinds.respondingRequestIds(ledger, runtimeId: runtimeId) }
    /// 原位短状态：账本中未结算的回答，或刚结算的结果。
    func interactionStatus(_ runtimeId: String) -> (text: String, pending: Bool)? {
        OperationKinds.respondStatus(ledger, runtimeId: runtimeId) ?? interactionOutcomes[runtimeId].map { ($0.text, false) }
    }

    /// 回答已结算：在原位短暂显示结果，约 2.5 秒后消失（V16）。成功回执显示摘要；只因请求已不在而结算的显示“已处理”，不声称是本机回答生效。
    private func showInteractionOutcome(_ op: AppLedger.Operation) {
        guard case .respond(let runtimeId, _, let summary) = op.payload else { return }
        let outcome = InteractionOutcome(id: UUID(), text: op.succeeded ? summary : L10n.tr("已处理"))
        interactionOutcomes[runtimeId] = outcome
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 2_500_000_000)
            if self?.interactionOutcomes[runtimeId]?.id == outcome.id { self?.interactionOutcomes[runtimeId] = nil }
        }
    }

    func refresh() {
        if connection == .secured {
            hostState.refresh()
            refreshSessions()
            for runtime in runtimes { agentState.subscribe(runtime: runtime, force: true) }
            if let selectedRuntime { syncSession(selectedRuntime, force: true) }
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
            sessionReads.finish(readId, phase: .failed, error: L10n.tr("读取请求未送达。")); return
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
                finishSync(id); historyErrors[runtime.runtimeId] = L10n.tr("历史读取请求未送达。"); return false
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
            } catch { self.failRead(operation, runtime: runtime, message: L10n.tr("本地历史读取失败，请重试。")) }
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
            historyLoading.remove(runtime.runtimeId); historyErrors[runtime.runtimeId] = L10n.tr("历史读取请求未送达。"); return
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
            else { failRead(operation, runtime: runtime, message: L10n.tr("更早的历史尚未缓存，连接原会话后可继续同步。")) }
        case .requestSource:
            if kind == .firstPage { sessionReads.finish(operation, phase: .succeeded) }
            if selectedOfflineSession == nil, connection == .secured,
               !pendingSyncs.values.contains(where: { $0.runtimeId == runtime.runtimeId && $0.range == "preview" && !$0.exhausted }) { syncSession(runtime, force: true) }
            else if selectedOfflineSession != nil { errorMessage = L10n.tr("这份会话还没有完整的本地历史缓存。") }
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
                else { self.failRead(operation, runtime: runtime, message: L10n.tr("历史补齐范围无法确认。")) }
            } catch { self.failRead(operation, runtime: runtime, message: L10n.tr("历史补齐读取失败。")) }
        }
    }

    var isViewingCachedSession: Bool { selectedOfflineSession != nil }

    @discardableResult
    func openCachedSession(_ session: SessionSummary) -> Bool {
        guard let host = selectedHost else { return false }
        toolContent.close(); turnFileChanges.clear(); dismissPreview()
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
        let payload = transport.receivedPayload
        let cost = payload?.count ?? (try? JSONSerialization.data(withJSONObject: message).count) ?? 0
        var dropped = false
        while !pendingEvents.isEmpty && (pendingEvents.count >= 256 || pendingEventBytes + cost > 4 * 1024 * 1024) {
            let index = pendingEvents.firstIndex { $0.channel != "ctl" } ?? 0
            let old = pendingEvents.remove(at: index); pendingEventBytes -= old.bytes; dropped = true
            if let event = old.message["event"] as? [String: Any], let syncId = event["syncId"] as? String,
               let runtimeId = old.message["runtimeId"] as? String { rejectSnapshot(syncId, runtimeId: runtimeId, message: L10n.tr("历史读取队列繁忙，正在重新同步。")) }
        }
        if dropped, let selectedRuntime { syncSession(selectedRuntime, force: true) }
        pendingEvents.append((message, channel, cost, payload)); pendingEventBytes += cost
        guard eventTask == nil else { return }
        let generation = historyGeneration
        eventTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled, generation == self.historyGeneration, !self.pendingEvents.isEmpty {
                let index = self.pendingEvents.firstIndex { $0.channel == "ctl" } ?? 0
                let event = self.pendingEvents.remove(at: index); self.pendingEventBytes -= event.bytes
                await self.consumeEvent(event.message, channel: event.channel, rawEnvelope: event.payload)
                guard generation == self.historyGeneration else { break }
                self.dispatchSyncDemands()
                await Task.yield()
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
    #if DEBUG
    func createCaptureSession(agentKind: String, cwd: String) {
        guard !cwd.isEmpty else { return }
        activateTarget(["type": "new", "agentKind": agentKind, "cwd": cwd], sessionId: "new", spawnMode: "headless")
    }
    #endif

    private func activateTarget(_ target: [String: Any], sessionId: String, spawnMode: String = "tui") {
        guard connection == .secured, activationRequestId == nil else { return }
        let requestId = UUID().uuidString
        let placeholder = "launch:" + requestId
        let creation = ledger.create(opId: requestId, kind: OperationKinds.launch, target: placeholder, policy: OperationKinds.launchPolicy,
                                     basis: ledgerBasis(OperationKinds.runtimesDomain),
                                     payload: .launch(requestId: requestId, placeholder: placeholder), written: false, now: Date())
        guard creation == .created else { return }
        guard transport.send(["type": "session.activate", "protocolVersion": orbisProtocolVersion,
                              "requestId": requestId, "target": target, "spawnMode": spawnMode]) else {
            ledger.remove(requestId); handleLedger([])
            errorMessage = L10n.tr("端到端加密连接尚未就绪，请连接成功后重试。"); return
        }
        activationRequestId = requestId; pendingActivation = sessionId; activatingSessionId = sessionId
        handleLedger(ledger.written(requestId, now: Date()))
        // ADR-0049 §6.8：立即进入该会话的聊天页并显示“启动中”；恢复已有会话时先显示缓存历史（V13）。
        let resumed = target["type"] as? String == "resume" ? sessionId : nil
        let cwd = target["cwd"] as? String ?? resumed.flatMap { sessionIndex[$0]?.cwd } ?? ""
        let title = resumed.flatMap { id in sessionIndex[id].map { displayName($0) } }
            ?? (cwd.split(separator: "/").last.map(String.init) ?? L10n.tr("新会话"))
        launching = LaunchState(requestId: requestId, placeholder: placeholder,
                                target: target.compactMapValues { $0 as? String }, title: title, cwd: cwd,
                                agentKind: target["agentKind"] as? String, resumed: resumed, sessionId: resumed)
        if let resumed, let session = sessionIndex[resumed], openCachedSession(session) { return }
        toolContent.close(); turnFileChanges.clear(); dismissPreview()
        selectedOfflineSession = nil; selectedRuntimeId = placeholder; messages = []; cachedHistoryOptions = []
        activationRevision += 1
    }

    /// 启动失败后在聊天页原位重试：同一目标、新的请求（L6）。
    func retryLaunch() {
        guard let launch = launching, launch.failure != nil || launch.unconfirmed else { return }
        var target: [String: Any] = launch.target
        if let kind = launch.agentKind { target["agentKind"] = kind }
        launching = nil
        activateTarget(target, sessionId: launch.resumed ?? "new")
    }

    /// 用户离开了启动页：启动继续，成功后不把用户拉回，会话照常出现在首页。
    func stopFollowingLaunch() {
        guard launching?.following == true else { return }
        launching?.following = false
        if launching?.failure != nil || launching?.unconfirmed == true { launching = nil }
    }

    /// 启动成功：草稿迁到真实会话（V17），用户仍在启动页时切过去。
    private func launchLanded(_ runtime: RuntimeSummary) {
        guard let launch = launching else { return }
        let placeholderRuntime = RuntimeSummary(runtimeId: launch.placeholder, name: launch.title, cwd: launch.cwd, status: "starting",
                                                sessionId: launch.resumed ?? launch.placeholder, agentKind: launch.agentKind)
        let cachedRuntime = launch.resumed.flatMap { id in selectedOfflineSession?.sessionId == id ? selectedRuntime : nil }
        for source in [placeholderRuntime, cachedRuntime].compactMap({ $0 }) {
            let text = draft(for: source)
            if !text.isEmpty, draft(for: runtime).isEmpty { saveDraft(text, for: runtime) }
            saveDraft("", for: source)
        }
        let following = launch.following
        if following && launchComposerFocused { composerFocusHandoff = runtime.runtimeId }
        launchComposerFocused = false
        launching = nil
        if following { selectedOfflineSession = nil; selectedRuntimeId = runtime.runtimeId; activationRevision += 1 }
        else if selectedRuntimeId == launch.placeholder { selectedRuntimeId = nil }
    }

    private func clearActivation() {
        activationTimeout?.cancel(); activationTimeout = nil
        activationRequestId = nil; pendingActivation = nil; activatingSessionId = nil
    }

    /// ADR-0049 §6.4 `archive`：卡片立即移到目标列表；回执、断线、期限与核对全部交给账本。
    func archive(_ session: SessionSummary, archived: Bool) {
        guard connection == .secured, let kind = session.agentKind else { return }
        let requestId = UUID().uuidString
        let creation = ledger.create(opId: requestId, kind: OperationKinds.archive,
                                     target: OperationKinds.archiveTarget(agentKind: kind, sessionId: session.sessionId),
                                     policy: OperationKinds.archivePolicy, basis: ledgerBasis(OperationKinds.catalogDomain),
                                     payload: .archive(sessionId: session.sessionId, agentKind: kind, archived: archived), written: false, now: Date())
        guard creation == .created else { return }
        guard transport.send(["type": "session.archive", "protocolVersion": orbisProtocolVersion, "requestId": requestId,
                              "sessionId": session.sessionId, "agentKind": kind, "archived": archived]) else {
            ledger.remove(requestId); handleLedger([])
            errorMessage = L10n.tr("操作未送达，请连接后重试。"); return
        }
        handleLedger(ledger.written(requestId, now: Date()))
    }

    /// 目录叠加未结算的归档操作：卡片立即出现在目标列表（ADR-0049 §6.4）。
    var visibleSessions: [SessionSummary] {
        let overrides = OperationKinds.archiveOverrides(ledger)
        guard !overrides.isEmpty else { return sessions }
        return sessions.map { session in
            guard let archived = overrides[session.sessionId] else { return session }
            var copy = session; copy.archived = archived; return copy
        }
    }

    /// 正在归档 / 恢复、尚未结算的会话：冲突入口在结算前禁用（L9）。
    func isArchiving(_ sessionId: String) -> Bool { OperationKinds.archiveOverrides(ledger)[sessionId] != nil }

    func browseDirectory(_ path: String? = nil) {
        guard connection == .secured else {
            browse = DirectoryBrowse(requestId: "", path: path, loading: false, error: L10n.tr("未连接到电脑，连接恢复后可重试。"))
            return
        }
        browseTimeout?.cancel()
        let requestId = UUID().uuidString
        browse = DirectoryBrowse(requestId: requestId, path: path)
        var request: [String: Any] = ["type": "session.browse", "protocolVersion": orbisProtocolVersion, "requestId": requestId]
        if let path { request["path"] = path }
        guard transport.send(request) else { browse?.loading = false; browse?.error = L10n.tr("目录读取请求未送达。"); return }
        browseTimeout = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 20_000_000_000) } catch { return }
            guard let self, self.browse?.requestId == requestId else { return }
            self.browse?.loading = false; self.browse?.error = L10n.tr("目录读取超时，请重试。")
        }
    }

    func dismissBrowse() { browseTimeout?.cancel(); browseTimeout = nil; browse = nil }

    @discardableResult
    func executeSlash(_ name: String, args: String = "", composerDraft: String? = nil) -> Bool {
        guard canSend, let runtime = selectedRuntime,
              let command = commands[runtime.runtimeId]?.first(where: { $0.name == name }),
              command.argument?.required != true || !args.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        let value = args.trimmingCharacters(in: .whitespacesAndNewlines)
        // ADR-0049 §6.1：产生对话的 Slash（prompt / skill）在 idle 时按消息乐观显示；其他情况维持处理中（ADR-0055 §5）。
        if producesMessage(command, runtime: runtime) { return sendSlashMessage(runtime, name: name, args: value) }
        if OperationKinds.isConfigSetting(name), !value.isEmpty {
            let label = command.argument?.options?.first { $0.value == value }?.label ?? value
            return submitConfig(runtime, setting: name, value: value, label: label)
        }
        guard let id = performActionId(runtimeId: runtime.runtimeId, name: name, command: ["type": "slash.execute", "name": name, "args": args]) else { return false }
        if let composerDraft { composerActionDrafts[id] = (localSessionKey(host: selectedHost, runtime: runtime), composerDraft) }
        return true
    }

    // MARK: - ADR-0049 §6.1 产生对话的 Slash

    /// 来源为 prompt / skill、会产生一条用户消息的命令，且当前可以执行（idle）。
    func producesMessage(_ command: SlashCommand, runtime: RuntimeSummary) -> Bool {
        ["prompt", "skill"].contains(command.source) && runtime.status == "idle" && runtime.sessionId != nil
    }

    /// 立即显示本地用户气泡（正文为 `/name 参数`），`slash.execute` 携带 App id；后端声明 clientMessageId 后由权威行替换。
    private func sendSlashMessage(_ runtime: RuntimeSummary, name: String, args: String) -> Bool {
        guard let sessionId = runtime.sessionId else { return false }
        let id = UUID().uuidString, commandId = UUID().uuidString
        let text = args.isEmpty ? "/" + name : "/\(name) \(args)"
        guard sendCommand(runtimeId: runtime.runtimeId, commandId: commandId,
                          command: ["type": "slash.execute", "name": name, "args": args, "messageId": id]) else {
            errorMessage = L10n.tr("命令未送达，请连接后重试。"); return false
        }
        if pendingSendHostId != selectedHostId { pendingSends.removeAll(); pendingSendHostId = selectedHostId }
        let anchor = runtime.runtimeId == selectedRuntimeId ? messages.last(where: { pendingSends.item($0.messageId) == nil })?.messageId : nil
        var send = PendingSend(messageId: id, commandId: commandId, sessionId: sessionId, text: text, attachments: [],
                               delivery: nil, createdAt: Date(), anchorMessageId: anchor)
        send.slashName = name; send.slashArgs = args
        pendingSends.add(send)
        publishMessages()
        return true
    }

    // MARK: - ADR-0049 §6.7 模型与思考级别（条件乐观）

    /// 切换中再次选择：只记下最新一次，前一次结束后只在它与确认值不同时再提交。
    private var configSelections: [String: (value: String, label: String)] = [:]

    private func submitConfig(_ runtime: RuntimeSummary, setting: String, value: String, label: String) -> Bool {
        let target = OperationKinds.configTarget(runtimeId: runtime.runtimeId, setting: setting)
        if ledger.active(target: target) != nil {
            configSelections[target] = (value, label); objectWillChange.send(); return true
        }
        // 已经是确认值：不需要切换。
        if OperationKinds.confirmedValue(runtime, setting: setting) == value { return true }
        let id = UUID().uuidString
        let creation = ledger.create(opId: id, kind: OperationKinds.config, target: target, policy: OperationKinds.configPolicy,
                                     basis: ledgerBasis(OperationKinds.modelDomain(runtime.runtimeId)),
                                     payload: .config(runtimeId: runtime.runtimeId, setting: setting, value: value, label: label), written: false, now: Date())
        guard creation == .created else { return false }
        guard sendCommand(runtimeId: runtime.runtimeId, commandId: id, command: ["type": "slash.execute", "name": setting, "args": value]) else {
            ledger.remove(id); handleLedger([])
            errorMessage = L10n.tr("操作未送达，请连接后重试。"); return false
        }
        handleLedger(ledger.written(id, now: Date()))
        return true
    }

    /// 前一次切换结束：最新一次选择与确认值不同就再提交。
    private func configSettled(_ op: AppLedger.Operation) {
        guard case .config(let runtimeId, let setting, _, _) = op.payload else { return }
        let target = OperationKinds.configTarget(runtimeId: runtimeId, setting: setting)
        guard let next = configSelections.removeValue(forKey: target), let runtime = runtimes.first(where: { $0.runtimeId == runtimeId }),
              OperationKinds.confirmedValue(runtime, setting: setting) != next.value else { return }
        _ = submitConfig(runtime, setting: setting, value: next.value, label: next.label)
    }

    /// 顶栏与选择器显示的值：(名字, 标记)；没有进行中的切换时为 nil，显示确认值。
    func configStatus(_ runtimeId: String, setting: String) -> (label: String, mark: String)? {
        if let next = configSelections[OperationKinds.configTarget(runtimeId: runtimeId, setting: setting)] { return (next.label, L10n.tr("切换中")) }
        return OperationKinds.configStatus(ledger, runtimeId: runtimeId, setting: setting)
    }

    /// Close a home-list selection without changing the active conversation or its draft.
    func canCloseRuntime(_ id: String) -> Bool {
        runtimes.first { $0.runtimeId == id }?.allowsRemoteClose(commands[id] ?? []) == true
    }

    func closeRuntimes(_ runtimeIds: Set<String>) -> Set<String> {
        guard connection == .secured else {
            errorMessage = L10n.tr("关闭会话未发送：请先连接电脑。"); return []
        }
        var submitted: Set<String> = []
        for runtime in runtimes where runtimeIds.contains(runtime.runtimeId) {
            guard canCloseRuntime(runtime.runtimeId) else {
                agentState.subscribe(runtime: runtime, force: true)
                errorMessage = L10n.tr("部分会话暂不支持远程关闭，或可用命令尚未就绪，请稍后重试。")
                continue
            }
            if submitQuit(runtime.runtimeId) { submitted.insert(runtime.runtimeId) }
        }
        return submitted
    }

    /// ADR-0049 §7.5 `quit`：先记入账本、再写入通道，卡片随账本叠加立即隐藏。
    private func submitQuit(_ runtimeId: String) -> Bool {
        let commandId = UUID().uuidString
        let creation = ledger.create(opId: commandId, kind: OperationKinds.quit, target: OperationKinds.quitTarget(runtimeId),
                                     policy: OperationKinds.quitPolicy, basis: ledgerBasis(OperationKinds.runtimesDomain),
                                     payload: .quit(runtimeId: runtimeId), written: false, now: Date())
        switch creation {
        case .created: break
        case .conflict: return true // 同一会话的关闭尚未结算，卡片已隐藏（L9）。
        case .duplicate, .full:
            errorMessage = L10n.tr("关闭会话未发送：待确认的操作过多，请稍后重试。"); return false
        }
        guard sendCommand(runtimeId: runtimeId, commandId: commandId, command: ["type": "slash.execute", "name": "quit", "args": ""]) else {
            ledger.remove(commandId)
            errorMessage = L10n.tr("关闭会话未发送：请连接电脑后重试。"); return false
        }
        handleLedger(ledger.written(commandId, now: Date()))
        return true
    }

    // MARK: - ADR-0049 §7 操作账本的输入

    /// 加密连接已建立：账本进入新的连接代次，旧连接上仍未结算的操作重新核对（L4、L5）。
    private func ledgerOpenConnection() {
        guard !ledgerConnectionOpen else { return }
        ledgerConnectionOpen = true; ledgerFresh = []
        handleLedger(ledger.connected())
        ledgerVerify()
        flushReadySends()
    }

    /// 连接断开：已写入的操作统一转结果不明，旧连接上的核对读取作废（L4）。
    private func ledgerCloseConnection() {
        guard ledgerConnectionOpen else { return }
        ledgerConnectionOpen = false; ledgerReads = [:]; ledgerFresh = []
        handleLedger(ledger.connectionLost())
    }

    /// 某个领域的权威状态刚刚应用。`read` 是核对读取的序号；推送为 nil。
    private func ledgerAuthority(_ domain: String, read: Int?, complete: Bool) {
        if domain == OperationKinds.runtimesDomain {
            // Runtime 已不在：它的队列随之消失，撤回失效（L7）。
            let online = Set(runtimes.map(\.runtimeId))
            handleLedger(ledger.expire { op in
                if case .queueCancel(let owner, _) = op.payload { return !online.contains(owner) }
                return false
            })
        }
        let seq = (authoritySeq[domain] ?? 0) + 1
        authoritySeq[domain] = seq
        if read == nil { ledgerFresh.insert(domain) }
        guard ledger.operations.contains(where: { $0.basis[domain] != nil }) else { return }
        let stamp = AppLedger.Stamp(domain: domain, seq: seq, connection: ledger.connection, read: read, complete: complete)
        let evidence = ledgerEvidence(domain)
        handleLedger(ledger.authority(stamp, evidence: evidence))
    }

    /// 各领域的证据：只在连接层这里读当前权威状态，种类规则在 `OperationKinds`。
    private func ledgerEvidence(_ domain: String) -> (AppLedger.Operation) -> AppLedger.Evidence {
        if domain == OperationKinds.runtimesDomain {
            let ids = Set(runtimes.map(\.runtimeId))
            let sessions = Set(runtimes.compactMap(\.sessionId))
            let launch = launching
            return { op in
                // `launch`：Host 给出的 Session 的 Runtime 已上线即落地。
                if case .launch(let requestId, _) = op.payload {
                    guard launch?.requestId == requestId, let session = launch?.sessionId else { return .none }
                    return sessions.contains(session) ? .landed : .none
                }
                return OperationKinds.evidence(op, runtimeIds: ids)
            }
        }
        if domain == OperationKinds.catalogDomain {
            let index = sessionIndex
            return { OperationKinds.catalogEvidence($0, sessions: index) }
        }
        if domain.hasPrefix("model:") {
            let runtime = runtimes.first { $0.runtimeId == String(domain.dropFirst("model:".count)) }
            return { OperationKinds.configEvidence($0, runtime: runtime) }
        }
        if domain.hasPrefix("interactions:") {
            let runtimeId = String(domain.dropFirst("interactions:".count))
            let requests = interactions[runtimeId] ?? []
            return { op in
                guard case .respond(let owner, _, _) = op.payload, owner == runtimeId else { return .none }
                return OperationKinds.interactionEvidence(op, requests: requests)
            }
        }
        if domain.hasPrefix("queue:") {
            let runtimeId = String(domain.dropFirst("queue:".count))
            let queue = queuedMessages[runtimeId] ?? []
            return { op in
                guard case .queueCancel(let owner, _) = op.payload, owner == runtimeId else { return .none }
                return OperationKinds.queueEvidence(op, queue: queue)
            }
        }
        let projections = notifications.projections
        return { op in
            guard case .dismiss(let runtimeId, _, _) = op.payload, OperationKinds.noticesDomain(runtimeId) == domain else { return .none }
            return OperationKinds.noticeEvidence(op, projection: projections[runtimeId])
        }
    }

    /// 创建操作时记下它要读的领域已应用到哪里（L2 的 basis）。
    private func ledgerBasis(_ domain: String) -> [String: Int] { [domain: authoritySeq[domain] ?? 0] }

    /// 核对读取的回复：先交设备私有回执，再以同一时刻的权威状态核对（L5）。读取失败（例如旧 Host 不认识设备作用域）
    /// 也是这次读取之后的回复：回执按查不到处理，仍以权威状态核对，不让操作停在结果不明。只核对本连接上已刷新过的领域。
    private func consumeLedgerRead(_ message: [String: Any], type: String, read: Int) {
        var receipts: [String: AppLedger.Receipt] = [:]
        if type == "agent.state.snapshot", message["scope"] as? String == "device", message["error"] == nil {
            let domain = (message["domains"] as? [[String: Any]])?.first { $0["domain"] as? String == "operations" }
            receipts = OperationKinds.deviceReceipts(domain?["value"])
        }
        handleLedger(ledger.deviceReceipts(receipts, connection: ledger.connection, now: Date()))
        let domains = Set(ledger.operations.flatMap(\.basis.keys)).intersection(ledgerFresh)
        for domain in domains.sorted() {
            ledgerAuthority(domain, read: read, complete: ledgerDomainComplete(domain))
        }
    }

    /// 领域当前的权威状态是否完整：部分结果不能作为反向证据（L2）。
    private func ledgerDomainComplete(_ domain: String) -> Bool {
        if domain == OperationKinds.runtimesDomain || domain == OperationKinds.catalogDomain || domain.hasPrefix("queue:") || domain.hasPrefix("interactions:") || domain.hasPrefix("model:") { return true }
        if domain.hasPrefix("notifications:") {
            return notifications.projections[String(domain.dropFirst("notifications:".count))]?.complete == true
        }
        return false
    }

    /// 账本事件的呈现：列表类被拒绝时提示原因后删除，界面随叠加回到权威状态；结果不明的发起核对读取。
    private func handleLedger(_ events: [AppLedger.Event]) {
        var verify = false
        var readySends = false
        let archiveRejections = events.filter { if case .rejected(let op) = $0, case .archive = op.payload { return true }; return false }.count
        for event in events {
            switch event {
            case .rejected(let op):
                if case .send(_, _, let messageId) = op.payload, case .rejected(let rejection) = op.phase {
                    // 配置切换失败：等它的消息一起转失败（“模型切换未完成，消息未发送”），可按当前配置重新发送。
                    var reason = rejection.reason
                    if rejection.code == "prerequisite" {
                        // Use the failed operation identity, never the language of a stored status label.
                        for event in events {
                            guard case .rejected(let prerequisite) = event, op.prerequisites.contains(prerequisite.opId) else { continue }
                            switch prerequisite.payload {
                            case .config(_, let setting, _, _): reason = L10n.tr("{0}切换未完成，消息未发送", OperationKinds.configTitle(setting))
                            case .launch: reason = L10n.tr("会话启动未完成，消息未发送")
                            default: break
                            }
                            break
                        }
                    }
                    pendingSends.failWaiting(messageId, reason: reason); publishMessages()
                }
                configSettled(op)
                if case .launch(let requestId, _) = op.payload, launching?.requestId == requestId, case .rejected(let rejection) = op.phase {
                    // 启动失败：在聊天页原位显示原因及“重试”“返回”，草稿保留，不自动退回原页面。
                    launching?.failure = rejection.reason.isEmpty ? L10n.tr("启动失败") : rejection.reason
                    activationRequestId = nil; pendingActivation = nil; activatingSessionId = nil
                    if launching?.following == false { launching = nil }
                }
                // 批量归档同时被拒绝时写明数量（ADR-0049 §6.4）。
                if let text = OperationKinds.message(for: op) { errorMessage = archiveRejections > 1 ? L10n.tr("{0} 个会话", archiveRejections) + text : text }
                if OperationKinds.removesOnRejection(op) { ledger.remove(op.opId) }
            case .verify: verify = true
            case .landed(let op): showInteractionOutcome(op); configSettled(op)
            case .ready: readySends = true
            case .unconfirmed(let op):
                if case .launch(let requestId, _) = op.payload, launching?.requestId == requestId { launching?.unconfirmed = true }
            case .unknown, .expired: break
            }
        }
        notifications.setHidden(OperationKinds.hiddenNotificationKeys(ledger))
        if verify { ledgerVerify() }
        scheduleLedgerClock()
        if readySends { flushReadySends() }
    }

    /// 结果不明的操作主动读取一次设备私有回执（L5）；回复到达时连同权威状态一起核对。
    private func ledgerVerify() {
        guard ledger.operations.contains(where: { $0.phase == .unknown || $0.phase == .unconfirmed }) else { return }
        ledgerRead()
    }

    /// 发起一次读取。同一有序通道上，它的回复晚于此前写入的操作在 Host 上的处理结果（L2）。
    private func ledgerRead() {
        guard ledgerConnectionOpen else { return }
        let read = ledger.beginRead()
        let requestId = OperationKinds.verifyRequestPrefix + UUID().uuidString
        ledgerReads[requestId] = read
        if !transport.send(["type": "agent.state.request", "protocolVersion": orbisProtocolVersion, "requestId": requestId,
                            "scope": "device", "domains": ["operations"]]) { ledgerReads[requestId] = nil }
    }

    /// 账本自己不计时：到最近的期限时交给账本处理（L8）。
    private func scheduleLedgerClock() {
        ledgerClock?.cancel(); ledgerClock = nil
        guard let deadline = ledger.nextDeadline else { return }
        ledgerClock = Task { [weak self] in
            let delay = max(0, deadline.timeIntervalSinceNow) + 0.01
            do { try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000)) } catch { return }
            self?.advanceLedgerClock(to: Date())
        }
    }

    /// 到期处理的唯一入口；测试用它推进时钟。
    func advanceLedgerClock(to now: Date) {
        handleLedger(ledger.tick(now: now))
    }

    /// ADR-0049 §6.6 `dismiss`：横幅立即隐藏，只影响本设备；写入后立即读取一次，作为因果晚于关闭的核对点。
    func dismissNotification(runtimeId: String, notificationId: String) {
        guard let epoch = notifications.hostEpoch else { return }
        let opId = UUID().uuidString
        let domain = OperationKinds.noticesDomain(runtimeId)
        let creation = ledger.create(opId: opId, kind: OperationKinds.dismiss,
                                     target: OperationKinds.dismissTarget(runtimeId: runtimeId, hostEpoch: epoch, notificationId: notificationId),
                                     policy: OperationKinds.dismissPolicy, basis: ledgerBasis(domain),
                                     payload: .dismiss(runtimeId: runtimeId, hostEpoch: epoch, notificationId: notificationId), written: false, now: Date())
        guard creation == .created else { return }
        guard notifications.dismiss(runtimeId: runtimeId, notificationId: notificationId) == epoch else {
            ledger.remove(opId); handleLedger([]); return
        }
        handleLedger(ledger.written(opId, now: Date()))
        ledgerRead()
    }

    func updatePermission(settingId: String, value: String) {
        guard canSend, let runtime = selectedRuntime, runtime.status == "idle", (interactions[runtime.runtimeId] ?? []).isEmpty, pendingActionIds.isEmpty,
              let setting = runtime.permissionManagement?.settings.first(where: { $0.id == settingId }),
              setting.disabledReason == nil, setting.options.contains(where: { $0.value == value }) else { return }
        _ = performAction(runtimeId: runtime.runtimeId, name: L10n.tr("权限"), command: ["type": "permissions.update", "settingId": settingId, "value": value])
    }

    private func performAction(runtimeId: String, name: String, command: [String: Any]) -> Bool {
        performActionId(runtimeId: runtimeId, name: name, command: command) != nil
    }

    private func performActionId(runtimeId: String, name: String, command: [String: Any]) -> String? {
        let id = UUID().uuidString
        guard sendCommand(runtimeId: runtimeId, commandId: id, command: command) else {
            errorMessage = L10n.tr("操作未送达，请连接后重试。"); return nil
        }
        runtimeActions[id] = (runtimeId, name); pendingActionIds.insert(id); setActionFeedback(nil); updateSyncing()
        actionTimeouts[id] = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 60_000_000_000) } catch { return }
            guard let self, self.runtimeActions[id] != nil else { return }
            self.finishAction(id, succeeded: false, message: L10n.tr("操作尚未确认，请刷新查看电脑端状态。"))
        }
        return id
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
        if let submitted = composerActionDrafts.removeValue(forKey: id), succeeded {
            drafts = preferences?.dictionary(forKey: "orbis.sessionDrafts") as? [String: String] ?? drafts
            if drafts[submitted.key] == submitted.text {
                drafts[submitted.key] = nil
                preferences?.set(drafts, forKey: "orbis.sessionDrafts")
            }
        }
        defer { if action.name == "tree" { branchEditorNode = nil; branchEditorText = nil } }
        pendingActionIds.remove(id); actionTimeouts.removeValue(forKey: id)?.cancel(); updateSyncing()
        if succeeded {
            setActionFeedback(L10n.tr("{0} 已完成", action.name))
            if action.name == "tree", let runtime = runtimes.first(where: { $0.runtimeId == action.runtimeId }) {
                let editorText = branchEditorNode == nil ? nil : (result?["editorText"] as? String ?? branchEditorText ?? (branchEditorNode == entryPreview?.entryId ? entryPreview?.message?.text : nil))
                if let sessionId = result?["sessionId"] as? String, sessionId != runtime.sessionId {
                    if let editorText { pendingBranchDrafts[offlineSessionKey(host: selectedHost, sessionId: sessionId)] = editorText }
                    var target: [String: Any] = ["type": "resume", "sessionId": sessionId]
                    if let kind = runtime.agentKind { target["agentKind"] = kind }
                    activateTarget(target, sessionId: sessionId)
                } else {
                    invalidateConversation(runtime.runtimeId); syncSession(runtime, force: true)
                    if let editorText { saveDraft(editorText, for: runtime) }
                }
                historyRevision += 1; branchEditorNode = nil
            }
        } else { errorMessage = message ?? L10n.tr("{0} 未完成，请重试。", action.name) }
    }

    @discardableResult
    func sendMessage(_ text: String, delivery: String? = nil, attachmentIds: Set<String> = []) -> Bool {
        guard canSend, let runtime = selectedRuntime, delivery == nil || ["followUp", "steer"].contains(delivery!) else { return false }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let body = trimmed.isEmpty && !attachmentIds.isEmpty ? L10n.tr("已发送 {0} 个附件", attachmentIds.count) : trimmed
        guard !body.isEmpty else { return false }
        guard body.utf16.count <= 100_000 else { errorMessage = L10n.tr("消息不能超过 100,000 个字符。"); return false }
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("/") else {
            errorMessage = L10n.tr("请从命令菜单选择斜杠命令。")
            return false
        }
        let attachments = transfers.currentTasks.filter { attachmentIds.contains($0.id) && $0.runtimeId == runtime.runtimeId && $0.sessionId == runtime.sessionId && $0.direction == "upload" }
        guard attachments.count == attachmentIds.count, attachments.allSatisfy({ !["failed", "cancelled"].contains($0.status) }) else { return false }
        // ADR-0049 §6.2：附件没传完或同会话还有等待中的前一条，就先在本机创建、排在后面，轮到时再写入通道。
        let uploaded = attachments.allSatisfy { $0.status == "completed" && $0.remotePath != nil }
        var configs = OperationKinds.activeConfigOps(ledger, runtimeId: runtime.runtimeId)
        // 启动中发送的消息等“会话启动”（ADR-0049 §6.8）。
        if isLaunchPage, let launch = launching, let op = ledger.operation(launch.requestId) { configs.append(op) }
        if !uploaded || !configs.isEmpty || runtime.sessionId.map({ ledger.blocks(group: OperationKinds.sendGroup($0)) }) == true {
            return sendWhenReady(body, delivery: delivery, uploads: attachments, runtime: runtime, configs: configs)
        }
        return sendUserMessage(body, delivery: delivery, attachments: attachments.compactMap(\.remotePath), runtime: runtime)
    }

    /// ADR-0049：写入加密通道后立即显示本地行；源端带回同一身份时由权威行替换。
    /// 后端分配的 id 各不相同，对账只认 `messageId` / `clientMessageId` / Host alias，不按正文猜。
    private func sendUserMessage(_ body: String, delivery: String?, attachments: [String], runtime: RuntimeSummary) -> Bool {
        guard let sessionId = runtime.sessionId else { return false }
        let id = UUID().uuidString, commandId = UUID().uuidString
        var command: [String: Any] = ["type": "user_message", "text": body, "messageId": id]
        if !attachments.isEmpty { command["attachments"] = attachments }
        if let delivery { command["delivery"] = delivery }
        guard sendCommand(runtimeId: runtime.runtimeId, commandId: commandId, command: command) else {
            errorMessage = L10n.tr("消息未送达，请连接后重试。"); return false
        }
        if pendingSendHostId != selectedHostId { pendingSends.removeAll(); pendingSendHostId = selectedHostId }
        let anchor = runtime.runtimeId == selectedRuntimeId ? messages.last(where: { pendingSends.item($0.messageId) == nil })?.messageId : nil
        pendingSends.add(PendingSend(messageId: id, commandId: commandId, sessionId: sessionId, text: body, attachments: attachments,
                                     delivery: delivery, createdAt: Date(), anchorMessageId: anchor))
        publishMessages()
        return true
    }

    // MARK: - ADR-0049 §6.2 等待前置操作的消息

    private static let waitingCopiesKey = "orbis.waitingSendCopies"

    /// 气泡立即出现、输入框清空；附件上传完成且同会话前一条已写入后，按创建顺序写入通道，再交给 outbox 结算。
    private func sendWhenReady(_ body: String, delivery: String?, uploads: [FileTransfer], runtime: RuntimeSummary,
                               configs: [AppLedger.Operation] = []) -> Bool {
        guard let sessionId = runtime.sessionId else { return false }
        let id = UUID().uuidString, commandId = UUID().uuidString
        let pending = uploads.filter { $0.status != "completed" || $0.remotePath == nil }
        let creation = ledger.create(opId: commandId, kind: OperationKinds.send, target: "message:" + id, group: OperationKinds.sendGroup(sessionId),
                                     conflicts: false, policy: OperationKinds.sendPolicy, basis: [:],
                                     prerequisites: Set(pending.map { OperationKinds.uploadPrerequisite($0.id) } + configs.map(\.opId)),
                                     payload: .send(runtimeId: runtime.runtimeId, sessionId: sessionId, messageId: id), written: false, now: Date())
        guard creation == .created else { errorMessage = L10n.tr("待发送的消息过多，请稍后重试。"); return false }
        if pendingSendHostId != selectedHostId { pendingSends.removeAll(); pendingSendHostId = selectedHostId }
        let anchor = runtime.runtimeId == selectedRuntimeId ? messages.last(where: { pendingSends.item($0.messageId) == nil })?.messageId : nil
        var send = PendingSend(messageId: id, commandId: commandId, sessionId: sessionId, text: body, attachments: [],
                               delivery: delivery, createdAt: Date(), anchorMessageId: anchor)
        let config: String? = configs.first.flatMap { if case .config(_, let setting, _, _) = $0.payload { return OperationKinds.configTitle(setting) }; return nil }
        let launch = configs.contains { if case .launch = $0.payload { return true }; return false }
        send.state = .waiting(!pending.isEmpty ? L10n.tr("上传中：") + pending.map(\.name).joined(separator: L10n.tr("、"))
                              : launch ? L10n.tr("等待会话启动") : config.map { L10n.tr("等待{0}切换", $0) } ?? L10n.tr("等待前一条发送"))
        send.uploadIds = uploads.map(\.id)
        pendingSends.add(send)
        saveWaitingCopy(id, text: body, runtime: runtime)
        publishMessages()
        flushReadySends()
        return true
    }

    /// 轮到写入通道的等待消息（前置都已完成、同组没有更早的等待者）依次写入；写入后账本记录交给 outbox。
    private func flushReadySends() {
        guard !flushingSends, connection == .secured else { return }
        flushingSends = true; defer { flushingSends = false }
        var progressed = true
        while progressed {
            progressed = false
            for op in ledger.ready() {
                guard case .send(_, let provisional, let messageId) = op.payload else { continue }
                let sessionId = launchSessions[provisional] ?? provisional
                guard let runtimeId = runtimes.first(where: { $0.sessionId == sessionId })?.runtimeId,
                      let send = pendingSends.item(messageId) else { continue }
                let paths = send.uploadIds.compactMap { id in transfers.tasks.first { $0.id == id && $0.status == "completed" }?.remotePath }
                guard paths.count == send.uploadIds.count else { continue }
                var command: [String: Any] = ["type": "user_message", "text": send.text, "messageId": messageId]
                if !paths.isEmpty { command["attachments"] = paths }
                if let delivery = send.delivery { command["delivery"] = delivery }
                guard sendCommand(runtimeId: runtimeId, commandId: op.opId, command: command) else { continue }
                pendingSends.startWrite(messageId, attachments: paths)
                removeWaitingCopy(messageId)
                let events = ledger.written(op.opId, now: Date())
                ledger.remove(op.opId)
                handleLedger(events)
                progressed = true
                break
            }
        }
        publishMessages()
    }

    private func uploadSettled(_ id: String, path: String?, error: String?) {
        let name = transfers.tasks.first { $0.id == id }?.name ?? L10n.tr("附件")
        handleLedger(ledger.prerequisite(OperationKinds.uploadPrerequisite(id), succeeded: path != nil,
                                         reason: L10n.tr("附件上传失败：{0}", name) + (error.map { L10n.tr("（{0}）", $0) } ?? "")))
        flushReadySends()
    }

    /// V17：写入通道前另存一份正文；进程退出时仍在等待的消息，下次打开时回到该会话的输入框。
    private func saveWaitingCopy(_ messageId: String, text: String, runtime: RuntimeSummary) {
        var copies = preferences?.dictionary(forKey: Self.waitingCopiesKey) as? [String: [String: String]] ?? [:]
        copies[localSessionKey(host: selectedHost, runtime: runtime), default: [:]][messageId] = text
        preferences?.set(copies, forKey: Self.waitingCopiesKey)
    }

    private func removeWaitingCopy(_ messageId: String) {
        guard var copies = preferences?.dictionary(forKey: Self.waitingCopiesKey) as? [String: [String: String]] else { return }
        for key in copies.keys { copies[key]?[messageId] = nil; if copies[key]?.isEmpty == true { copies[key] = nil } }
        preferences?.set(copies, forKey: Self.waitingCopiesKey)
    }

    /// 上次进程退出时还在等待的消息回到输入框，已有草稿则接在其后。
    private func restoreWaitingCopies() {
        guard let copies = preferences?.dictionary(forKey: Self.waitingCopiesKey) as? [String: [String: String]], !copies.isEmpty else { return }
        drafts = preferences?.dictionary(forKey: "orbis.sessionDrafts") as? [String: String] ?? drafts
        var kept: [String: [String: String]] = [:]
        for (key, entries) in copies {
            let live = entries.filter { pendingSends.item($0.key) != nil }
            if !live.isEmpty { kept[key] = live }
            let restored = entries.filter { pendingSends.item($0.key) == nil }.values.sorted()
            guard !restored.isEmpty else { continue }
            drafts[key] = ([drafts[key]].compactMap { $0 } + restored).joined(separator: "\n\n")
        }
        preferences?.set(drafts, forKey: "orbis.sessionDrafts")
        preferences?.set(kept, forKey: Self.waitingCopiesKey)
    }

    /// 失败行重新发送：用新的 messageId，空闲直发不会被各后端当成同一条消息去重。
    @discardableResult
    func resendPendingSend(_ messageId: String) -> Bool {
        guard canSend, let runtime = selectedRuntime, let send = pendingSends.item(messageId), send.sessionId == runtime.sessionId,
              case .failed = send.state else { return false }
        // Slash 产生的消息：再次执行同一命令，新的身份（L6）。
        if let name = send.slashName {
            pendingSends.remove(messageId); publishMessages()
            guard executeSlash(name, args: send.slashArgs ?? "") else { pendingSends.add(send); publishMessages(); return false }
            return true
        }
        // 附件没传成的失败：重新上传，作为一条新的等待消息（L6：新操作、新身份）。
        if !send.uploadIds.isEmpty, send.attachments.isEmpty {
            let uploads = transfers.tasks.filter { send.uploadIds.contains($0.id) }
            guard uploads.count == send.uploadIds.count else { return false }
            for upload in uploads where ["failed", "cancelled"].contains(upload.status) { transfers.restart(upload.id) }
            pendingSends.remove(messageId); removeWaitingCopy(messageId)
            let restarted = transfers.tasks.filter { send.uploadIds.contains($0.id) }
            return sendWhenReady(send.text, delivery: send.delivery, uploads: restarted, runtime: runtime)
        }
        // 按当前状态选择投递方式：忙时直发会被拒绝，Claude 也不支持插入。
        let delivery: String? = runtime.status == "idle" ? nil
            : send.delivery == "steer" && agentKind(runtime) != "claude" ? "steer" : "followUp"
        pendingSends.remove(messageId)
        guard sendUserMessage(send.text, delivery: delivery, attachments: send.attachments, runtime: runtime) else {
            pendingSends.add(send); publishMessages(); return false
        }
        return true
    }

    /// 放回输入框：删除本地行并交回正文；附件路径已在电脑上，只能随正文说明。
    func restorePendingSend(_ messageId: String) -> String? {
        guard let send = pendingSends.item(messageId) else { return nil }
        switch send.state { case .failed, .unconfirmed: break; default: return nil }
        pendingSends.remove(messageId); removeWaitingCopy(messageId); publishMessages()
        // 附件没传成：正文和附件都回到输入框（ADR-0049 §6.1）。
        if !send.uploadIds.isEmpty, send.attachments.isEmpty { transfers.reattach(Set(send.uploadIds)); return send.text }
        return send.attachments.isEmpty ? send.text : send.text + "\n\n附件路径：\n" + send.attachments.joined(separator: "\n")
    }

    func discardPendingSend(_ messageId: String) {
        guard let send = pendingSends.item(messageId) else { return }
        switch send.state { case .failed, .unconfirmed: break; default: return }
        pendingSends.remove(messageId); removeWaitingCopy(messageId); publishMessages()
    }

    /// 队列面板：Host 队列项，加上带 `delivery` 且仍在提交中的本地行。
    func queuePanelItems(_ runtimeId: String) -> [QueuedMessage] {
        let sessionId = runtimes.first(where: { $0.runtimeId == runtimeId })?.sessionId
        // ADR-0049 §6.3：撤回已写入、等待回执的队列项先退场。
        let cancelling = OperationKinds.cancellingQueueIds(ledger, runtimeId: runtimeId)
        // `cancelled`：撤回已完成，不再显示（ADR-0049 §6.3）。
        let host = (queuedMessages[runtimeId] ?? []).filter {
            !pendingSends.hidesQueueItem($0.queueId) && !cancelling.contains($0.queueId) && $0.state != "cancelled"
        }
        let local = pendingSends.queueRows(sessionId: sessionId).filter { send in !host.contains { $0.queueId == send.messageId } }
            .map { QueuedMessage(queueId: $0.messageId, text: $0.text, delivery: $0.delivery ?? "followUp", state: "submitting", error: nil) }
        return host + local
    }

    private func reconcilePendingSends() {
        guard !pendingSends.isEmpty else { return }
        let connected = connection == .secured
        var recheck = false
        for sessionId in pendingSends.sessionIds {
            let runtime = runtimes.first { $0.sessionId == sessionId }
            let runtimeId = runtime?.runtimeId
            let conversation = runtimeId.flatMap { conversations[$0] } ?? []
            let aliases = runtimeId.flatMap { messageAliases[$0] } ?? [:]
            let display = runtimeId.flatMap { displayMessageIds[$0] } ?? [:]
            let needsSync = pendingSends.reconcile(sessionId: sessionId, status: runtime?.status,
                queue: runtimeId.flatMap { queuedMessages[$0] } ?? [], revision: sessionRevisions[sessionId] ?? 0,
                connected: connected) { id in
                    conversation.contains { $0.messageId == id || $0.clientMessageId == id } || aliases[id].map { display[$0] != nil } == true
                }
            if needsSync, let runtimeId { syncDemands.insert(runtimeId) }
            recheck = recheck || pendingSends.items.contains { $0.sessionId == sessionId && $0.state == .accepted && !$0.sawBusy }
        }
        // 接受后 Runtime 一直空闲时没有新事件，到期后需要自己再核对一次。
        if recheck, pendingSendCheck == nil {
            pendingSendCheck = Task { [weak self] in
                do { try await Task.sleep(nanoseconds: UInt64((PendingSendOutbox.acceptedIdleGrace + 0.5) * 1_000_000_000)) } catch { return }
                self?.pendingSendCheck = nil; self?.publishMessages()
            }
        }
    }

    private func markAuthoritative(_ runtimeId: String) {
        guard let sessionId = runtimes.first(where: { $0.runtimeId == runtimeId })?.sessionId else { return }
        sessionRevisions[sessionId, default: 0] += 1
    }

    /// ADR-0049 §6.3 `queueCancel`：队列项立即退场；回执、断线、期限与核对全部交给账本。
    @discardableResult
    func cancelQueuedMessage(_ queueId: String) -> Bool {
        guard canSend, let runtime = selectedRuntime,
              queuedMessages[runtime.runtimeId]?.contains(where: { $0.queueId == queueId && $0.state == "accepted" }) == true else { return false }
        let id = UUID().uuidString
        let creation = ledger.create(opId: id, kind: OperationKinds.queueCancel,
                                     target: OperationKinds.queueCancelTarget(runtimeId: runtime.runtimeId, queueId: queueId),
                                     policy: OperationKinds.queueCancelPolicy, basis: ledgerBasis(OperationKinds.queueDomain(runtime.runtimeId)),
                                     payload: .queueCancel(runtimeId: runtime.runtimeId, queueId: queueId), written: false, now: Date())
        guard creation == .created else { return false }
        guard sendCommand(runtimeId: runtime.runtimeId, commandId: id, command: ["type": "user_message.cancel", "messageId": queueId]) else {
            ledger.remove(id); handleLedger([]); return false
        }
        handleLedger(ledger.written(id, now: Date()))
        return true
    }

    /// 撤回结果不明、回到原位的队列项（标“撤回未确认”，核对前不能再撤回）。
    func unconfirmedQueueCancellations(_ runtimeId: String) -> Set<String> { OperationKinds.unconfirmedQueueIds(ledger, runtimeId: runtimeId) }

    /// Host 队列已应用：已投递的项若正在撤回，按 `already_delivered` 结算（Host 声明的同一身份），再作为权威状态交给账本。
    private func ledgerQueue(_ runtimeId: String, delivered: Set<String>, complete: Bool) {
        for op in ledger.operations where !op.phase.isSettled {
            guard case .queueCancel(let owner, let queueId) = op.payload, owner == runtimeId, delivered.contains(queueId) else { continue }
            handleLedger(ledger.receipt(op.opId, connection: ledger.connection, .failed(OperationKinds.queueAlreadyDelivered), now: Date()))
        }
        ledgerAuthority(OperationKinds.queueDomain(runtimeId), read: nil, complete: complete)
    }

    @discardableResult
    func stopRuntime() -> Bool {
        guard let runtime = selectedRuntime else { return false }
        guard sendCommand(runtimeId: runtime.runtimeId, command: ["type": "stop"]) else {
            errorMessage = L10n.tr("端到端加密连接尚未就绪。"); return false
        }
        return true
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

    /// 身份领域到达就落盘，不依赖目录扫描或打开聊天记录。
    private func persistIdentity(_ runtime: RuntimeSummary) {
        guard let id = runtime.sessionId, !id.isEmpty, let kind = runtime.agentKind, !kind.isEmpty else { return }
        var entry = sessionIndex[id] ?? SessionSummary(sessionId: id, cwd: runtime.cwd,
            createdAt: 0, modifiedAt: 0, messageCount: 0)
        entry.name = runtime.sessionName
        if !runtime.cwd.isEmpty { entry.cwd = runtime.cwd }
        entry.agentKind = kind
        entry.hostname = runtime.hostname ?? entry.hostname
        if entry == sessionIndex[id] { return }
        if let index = sessions.firstIndex(where: { $0.sessionId == id }) { sessions[index] = entry }
        else { sessions.append(entry) }
        persistSessions()
    }

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
        return L10n.tr("此会话属于 {0}，当前使用 {1}。请在设置页切换到 {2}，再打开会话。", provider, current, provider)
    }

    private func recordConnectionEvent(_ event: String) {
        let time = Date().formatted(date: .omitted, time: .standard)
        connectionEvents.append("\(time)  \(event.prefix(160))")
        if connectionEvents.count > 80 { connectionEvents.removeFirst(connectionEvents.count - 80) }
    }

    private func receive(_ message: [String: Any], channel: String?) {
        guard let type = message["type"] as? String else { return }
        guard channel != nil else {
            if type == "protocol.error" { errorMessage = message["message"] as? String ?? L10n.tr("中继认证失败，请重新连接。"); connection = .error }
            return
        }
        defer { commitHomePresentation() }
        if let version = message["protocolVersion"] as? Int, version != orbisProtocolVersion {
            errorMessage = L10n.tr("Orbis 协议版本不兼容，请同时更新手机 App 和电脑 Host。")
            return
        }
        transfers.consume(message)
        recordConnectionEvent("\(channel ?? "—") · \(type)")
        if let requestId = message["requestId"] as? String, let read = ledgerReads.removeValue(forKey: requestId) {
            consumeLedgerRead(message, type: type, read: read); return
        }
        let noticeRuntime = type == "notification.snapshot" ? message["runtimeId"] as? String : nil
        let noticeReceipts = noticeRuntime.flatMap { notifications.receipts[$0] }
        if notifications.consume(message) {
            // 只有被接受的快照才是权威状态（校验失败的快照不推进回执计数）。
            if let runtimeId = noticeRuntime, notifications.receipts[runtimeId] != noticeReceipts {
                ledgerAuthority(OperationKinds.noticesDomain(runtimeId), read: nil, complete: notifications.projections[runtimeId]?.complete == true)
            }
            return
        }
        if hostState.consume(message) || agentState.consume(message) { return }
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
            let next: [RuntimeSummary] = values.compactMap(jsonDecode)
            guard next.count == values.count, Set(next.map(\.runtimeId)).count == next.count else {
                errorMessage = L10n.tr("会话目录格式无法识别，请重新连接。"); return
            }
            hostState.setConnection(selectedHost, connected: true)
            agentState.setConnection(selectedHost, connected: true)
            notifications.setConnection(selectedHost, connected: true)
            guard hostState.beginEpoch(message["modelEpoch"] as? String), agentState.beginEpoch(message["modelEpoch"] as? String) else { return }
            let modelEpoch = message["modelEpoch"] as? String
            let hostRestarted = modelEpoch != nil && authenticatedModelEpoch != nil && modelEpoch != authenticatedModelEpoch
            if let modelEpoch { authenticatedModelEpoch = modelEpoch }
            homeDirectoryReceived = true
            let selectedLeafChanged = next.first(where: { $0.runtimeId == selectedRuntimeId }).map { next in
                runtimes.first(where: { $0.runtimeId == next.runtimeId })?.sessionLeafId != next.sessionLeafId
            } ?? false
            if hostRestarted { setHistoryConnection(false); clearSyncs(); sourcePositions = [:]; appliedBaselines = [:] }
            for runtime in next where runtimes.first(where: { $0.runtimeId == runtime.runtimeId })?.sessionId != runtime.sessionId {
                invalidateConversation(runtime.runtimeId)
            }
            runtimes = next.map(reprojectRuntime)
            // 新连接的首个 device.ready 是因果晚于旧连接上所有操作的完整在线列表（L2、L5）。
            ledgerOpenConnection()
            ledgerAuthority(OperationKinds.runtimesDomain, read: nil, complete: true)
            flushReadySends()
            conversations = conversations.filter { id, _ in next.contains { $0.runtimeId == id } }
            runtimeEventSequences = [:]
            if selectedRuntime == nil { selectedRuntimeId = restoredRuntimeId() ?? runtimes.first?.runtimeId }
            if let selectedRuntime { saveLastSession(selectedRuntime) }
            setHistoryConnection(true)
            connection = .secured
            hostState.setConnection(selectedHost, connected: true)
            agentState.setConnection(selectedHost, connected: true)
            notifications.setConnection(selectedHost, connected: true)
            transfers.setConnection(selectedHost, connected: true)
            supportedAgents = message["agents"] as? [String]
            launchableAgents = message["launchableAgents"] as? [String]
            codexDesktop = (message["codexDesktop"] as? [String: Any]).flatMap(jsonDecode).flatMap { $0.valid ? $0 : nil }
            notifications.ready(epoch: message["notificationEpoch"] as? String, runtimes: runtimes)
            let noticeEpoch = notifications.hostEpoch
            handleLedger(ledger.expire { op in
                if case .dismiss(_, let epoch, _) = op.payload { return epoch != noticeEpoch }
                return false
            })
            for runtime in runtimes { agentState.subscribe(runtime: runtime) }
            publishMessages()
            if let selectedRuntime { seedCachedHistory(selectedRuntime); publishMessages(); agentState.subscribe(runtime: selectedRuntime); syncSession(selectedRuntime, force: hostRestarted || selectedLeafChanged) }
            refreshSessions()
        case "runtime.online":
            if let object = message["runtime"] as? [String: Any], let incoming: RuntimeSummary = jsonDecode(object) {
                let runtime = reprojectRuntime(incoming)
                if let index = runtimes.firstIndex(where: { $0.runtimeId == runtime.runtimeId }) {
                    if runtimes[index].sessionId != runtime.sessionId { invalidateConversation(runtime.runtimeId) }
                    runtimes[index] = runtime
                } else { runtimes.append(runtime) }
                ledgerAuthority(OperationKinds.runtimesDomain, read: nil, complete: false)
                if pendingActivation == runtime.sessionId {
                    if let session = runtime.sessionId, let text = pendingBranchDrafts.removeValue(forKey: offlineSessionKey(host: selectedHost, sessionId: session)) { saveDraft(text, for: runtime) }
                    clearActivation()
                    if launching != nil { launchLanded(runtime) } else { selectedRuntimeId = runtime.runtimeId; activationRevision += 1 }
                } else if selectedRuntimeId == nil { selectedRuntimeId = runtime.runtimeId }
                publishMessages()
                agentState.subscribe(runtime: runtime); notifications.online(runtime)
                if runtime.runtimeId == selectedRuntimeId { syncSession(runtime) }
            }
        case "runtime.offline":
            if let id = message["runtimeId"] as? String {
                pendingSends.runtimeLost(sessionId: runtimes.first { $0.runtimeId == id }?.sessionId)
                runtimes.removeAll { $0.runtimeId == id }
                ledgerAuthority(OperationKinds.runtimesDomain, read: nil, complete: false)
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
                ledgerAuthority(OperationKinds.catalogDomain, read: nil, complete: true)
            }
            if let providers = message["currentProviders"] as? [[String: Any]] {
                currentProviders = [:]
                for row in providers {
                    if let kind = row["agentKind"] as? String, let provider = row["provider"] as? String, !provider.isEmpty { currentProviders[kind] = provider }
                }
            }
        case "device.path":
            guard let path = message["path"] as? String, ["lan", "relay"].contains(path) else { return }
            activePath = path
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
            if let requestId = message["requestId"] as? String, requestId == activationRequestId || requestId == launching?.requestId,
               let sessionId = message["sessionId"] as? String {
                pendingActivation = sessionId; activatingSessionId = sessionId
                // 同一 requestId 的 session.activated：Host 已给出 Session，等它的 Runtime 上线（ADR-0049 §7.5）。
                if let launch = launching, launch.requestId == requestId {
                    launching?.sessionId = sessionId
                    launchSessions[launch.placeholder] = sessionId
                    pendingSends.rebind(sessionId: launch.placeholder, to: sessionId)
                }
                handleLedger(ledger.receipt(requestId, connection: ledger.connection, .succeeded, now: Date()))
                if let runtime = runtimes.first(where: { $0.sessionId == sessionId }) {
                    clearActivation()
                    // Runtime 先于回复上线（真实 Host 的顺序）：先让账本按 `launching` 的 Session 判定启动落地，
                    // 放行等它的消息，再切到真实会话；顺序反过来时 `launching` 已清空，启动永远不落地。
                    ledgerAuthority(OperationKinds.runtimesDomain, read: nil, complete: false)
                    if launching != nil { launchLanded(runtime) } else { selectRuntime(runtime.runtimeId); activationRevision += 1 }
                }
            }
            refreshSessions()
        case "session.archive.changed":
            // 同一 requestId 的变更通知即这次归档的成功回执（ADR-0049 §7.5）。
            if let requestId = message["requestId"] as? String, ledger.operation(requestId) != nil {
                handleLedger(ledger.receipt(requestId, connection: ledger.connection, .succeeded, now: Date()))
            }
            refreshSessions()
        case "protocol.error":
            let commandId = message["commandId"] as? String
            if commandId?.hasPrefix("session-sync-ack:") == true { return }
            if message["code"] as? String == "session_sync_device_rejected", let commandId,
               handledSyncRejections.contains(commandId) { return }
            if let opId = commandId ?? message["requestId"] as? String, ledger.operation(opId) != nil {
                let rejection = AppLedger.Rejection(message["code"] as? String ?? "failure", message["message"] as? String ?? L10n.tr("电脑端无法完成操作。"))
                handleLedger(ledger.receipt(opId, connection: ledger.connection, .failed(rejection), now: Date())); return
            }
            if let syncId = pendingSyncs.first(where: { $0.value.commandId == commandId })?.key {
                let pending = pendingSyncs[syncId]
                finishSync(syncId)
                if let pending, pending.range == "history" { historyErrors[pending.runtimeId] = message["message"] as? String ?? L10n.tr("历史读取失败，请重试。"); return }
            }
            if let commandId { finishAction(commandId, succeeded: false, message: message["message"] as? String) }
            if let requestId = message["requestId"] as? String, requestId == activationRequestId { clearActivation() }
            if let requestId = message["requestId"] as? String, requestId == browse?.requestId {
                browseTimeout?.cancel(); browse?.loading = false; browse?.error = message["message"] as? String
                return
            }
            if commandId == nil && message["requestId"] == nil { connection = .error }
            errorMessage = message["message"] as? String ?? L10n.tr("电脑端无法完成操作。")
        default: break
        }
    }

    private func consumeEvent(_ envelope: [String: Any], channel: String?, rawEnvelope: Data?) async {
        guard let runtimeId = envelope["runtimeId"] as? String, runtimes.contains(where: { $0.runtimeId == runtimeId }),
              let event = envelope["event"] as? [String: Any], let type = event["type"] as? String else { return }
        let changesHome = ["runtime.metadata", "runtime.status", "interaction.requested", "interaction.snapshot",
                           "interaction.resolved", "interaction.cancelled"].contains(type)
        defer { if changesHome { commitHomePresentation() } }
        if let sequence = integer(envelope["sequence"]) {
            let key = "\(runtimeId)\u{0000}\(channel ?? "ctl")"
            if sequence <= (runtimeEventSequences[key] ?? -1) { return }
            runtimeEventSequences[key] = sequence
        }
        turnFileChanges.consume(event, runtimeId: runtimeId)
        if type.hasPrefix("session.changes.") || type.hasPrefix("session.change.detail.") { return }
        toolContent.consume(event, runtimeId: runtimeId)
        toolInventories.consume(event, runtime: runtimeId)
        let modelOwnedDomain: String? = ["runtime.status": "execution", "runtime.capabilities": "capabilities", "interaction.requested": "interactions", "interaction.snapshot": "interactions", "interaction.resolved": "interactions", "interaction.cancelled": "interactions", "queue.snapshot": "delivery", "queue.updated": "delivery", "message.queued": "delivery", "delivery.snapshot": "delivery"][type]
        if let domain = modelOwnedDomain, agentState.owns(domain, runtimeId: runtimeId) { return }
        if type == "message.queued", let item: QueuedMessage = jsonDecode(event) {
            var rows = queuedMessages[runtimeId] ?? []
            rows.removeAll { $0.queueId == item.queueId }
            if item.state != "delivered" { rows.append(item) }
            queuedMessages[runtimeId] = rows
            ledgerQueue(runtimeId, delivered: item.state == "delivered" ? [item.queueId] : [], complete: false); return
        }
        if type == "delivery.snapshot", let rows = event["items"] as? [[String: Any]] {
            let items: [QueuedMessage] = rows.compactMap(jsonDecode)
            guard items.count == rows.count, Set(items.map(\.queueId)).count == items.count else { return }
            var merged = event["complete"] as? Bool == false ? (queuedMessages[runtimeId] ?? []) : []
            let ids = Set(items.map(\.queueId)); merged.removeAll { ids.contains($0.queueId) }
            queuedMessages[runtimeId] = (merged + items).filter { $0.state != "delivered" }
            ledgerQueue(runtimeId, delivered: Set(items.filter { $0.state == "delivered" }.map(\.queueId)), complete: event["complete"] as? Bool != false); return
        }
        if type == "runtime.status", let status = event["status"] as? String,
           let index = runtimes.firstIndex(where: { $0.runtimeId == runtimeId }) { runtimes[index].status = status; updateSyncing(); return }
        if type == "runtime.capabilities", let capabilities = event["capabilities"] as? [String: Any] {
            commands[runtimeId] = (capabilities["commands"] as? [[String: Any]] ?? []).compactMap(jsonDecode)
            return
        }
        if type == "command.result", let commandId = event["commandId"] as? String, pendingSends.owns(commandId: commandId) {
            pendingSends.commandResult(commandId, ok: event["ok"] as? Bool == true, status: event["status"] as? String, error: event["error"] as? String)
            publishMessages(); return
        }
        // 账本里的操作只由账本结算，并由种类给出带上下文的提示，通用失败分支不再覆盖它（L1）。
        if type == "command.result" || type == "runtime.error", let commandId = event["commandId"] as? String, let op = ledger.operation(commandId),
           OperationKinds.runtimeId(of: op).map({ $0 == runtimeId }) ?? true {
            let receipt = type == "runtime.error"
                ? AppLedger.Receipt.failed(.init("runtime_error", event["message"] as? String ?? L10n.tr("电脑端无法完成操作。")))
                : OperationKinds.receipt(ok: event["ok"] as? Bool == true, status: event["status"] as? String, error: event["error"] as? String)
            handleLedger(ledger.receipt(commandId, connection: ledger.connection, receipt, now: Date())); return
        }
        if type == "command.result", let commandId = event["commandId"] as? String, event["status"] as? String != "pending" {
            if runtimeActions[commandId]?.runtimeId == runtimeId { finishAction(commandId, succeeded: event["ok"] as? Bool == true, message: event["error"] as? String, result: event["result"] as? [String: Any]) }
        }
        if type == "interaction.requested", let raw = event["request"] as? [String: Any], let request: InteractionRequest = jsonDecode(raw), request.runtimeId == runtimeId {
            var current = interactions[runtimeId] ?? []
            current.removeAll { $0.requestId == request.requestId }; current.append(request)
            interactions[runtimeId] = current
            ledgerAuthority(OperationKinds.interactionsDomain(runtimeId), read: nil, complete: false); return
        }
        if type == "interaction.snapshot" {
            let requests: [InteractionRequest] = (event["requests"] as? [[String: Any]] ?? []).compactMap(jsonDecode)
            interactions[runtimeId] = requests.filter { $0.runtimeId == runtimeId }
            ledgerAuthority(OperationKinds.interactionsDomain(runtimeId), read: nil, complete: true)
            return
        }
        if type == "interaction.resolved" || type == "interaction.cancelled", let requestId = event["requestId"] as? String {
            interactions[runtimeId]?.removeAll { $0.requestId == requestId }
            ledgerAuthority(OperationKinds.interactionsDomain(runtimeId), read: nil, complete: false)
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
            let next = reprojectRuntime(mergeRuntime(previous, metadata: fields))
            runtimes[index] = next
            if fields["model"] != nil || fields["thinkingLevel"] != nil { ledgerAuthority(OperationKinds.modelDomain(runtimeId), read: nil, complete: true) }
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
                if pending?.range == "history" { historyErrors[runtimeId] = event["error"] as? String ?? event["message"] as? String ?? L10n.tr("历史读取失败，请重试。"); return }
            }
            errorMessage = event["message"] as? String ?? event["error"] as? String ?? L10n.tr("电脑端无法完成操作。")
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
            await applySnapshot(event, runtimeId: runtimeId, rawEnvelope: rawEnvelope)
        } else if type == "session.patch" {
            // A complete contiguous source transaction commits before its projection is visible.
            if let source = event["source"] as? [String: Any], let epoch = source["epoch"] as? String,
               let seq = integer(source["seq"]), let base = integer(event["baseSeq"]),
               source["ready"] as? Bool == true, seq > base, integer(event["seq"]) == seq,
               event["headCompleteness"] as? String == "complete", (event["live"] as? [String: Any])?["complete"] as? Bool == true,
               let current = sourcePositions[runtimeId], current.epoch == epoch, current.seq == base,
               event["sessionId"] as? String == runtimes.first(where: { $0.runtimeId == runtimeId })?.sessionId {
                guard let runtime = runtimes.first(where: { $0.runtimeId == runtimeId }), validToolDependency(event, runtime: runtime), await commitHistory(event, runtime: runtime, activate: true, rawEnvelope: rawEnvelope) != nil else {
                    if let runtime = runtimes.first(where: { $0.runtimeId == runtimeId }) { syncSession(runtime, force: true) }
                    return
                }
                applyProjection(event, runtimeId: runtimeId)
                if let leaf = (event["head"] as? [String: Any])?["leafId"] as? String { sessionLeaves[runtimeId] = leaf }
                sourcePositions[runtimeId] = (epoch, seq)
                markAuthoritative(runtimeId)
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
                if type == "message.started" { unfinishedLiveMessageIds[runtimeId, default: []].insert(message.messageId) }
                else { unfinishedLiveMessageIds[runtimeId]?.remove(message.messageId) }
                upsert(message, runtimeId: runtimeId)
            }
        } else if type == "message.delta" { applyDelta(event, runtimeId: runtimeId) }
        else if type == "turn.finished" {
            unfinishedLiveMessageIds[runtimeId] = []
            for row in event["persistedMessages"] as? [[String: Any]] ?? [] {
                if let liveId = row["messageId"] as? String, let entryId = row["entryId"] as? String { addAlias(liveId, entryId: entryId, runtimeId: runtimeId) }
            }
            if let liveId = event["messageId"] as? String, let entryId = event["persistedMessageId"] as? String { addAlias(liveId, entryId: entryId, runtimeId: runtimeId) }
            retireAliases(runtimeId)
        }
        publishMessages()
    }

    private func applySnapshot(_ event: [String: Any], runtimeId: String, rawEnvelope: Data?) async {
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
            rejectSnapshot(syncId, runtimeId: runtimeId, message: L10n.tr("会话读取归属已经改变，请重试。")); return
        }
        guard event["range"] == nil || event["range"] as? String == pending.range,
              event["beforeEntryId"] as? String == pending.boundary,
              validSnapshotSelection(event, pending: pending, runtimeId: runtimeId) else {
            rejectSnapshot(syncId, runtimeId: runtimeId, message: L10n.tr("会话同步范围或检查点无效，请重试。"))
            return
        }
        guard let source = event["source"] as? [String: Any], let epoch = source["epoch"] as? String, !epoch.isEmpty,
              epoch.utf16.count <= 256, integer(source["seq"]) != nil, source["ready"] as? Bool == true else {
            rejectSnapshot(syncId, runtimeId: runtimeId, message: L10n.tr("会话来源版本无效，请重试。"))
            return
        }
        if let source = event["source"] as? [String: Any], let epoch = source["epoch"] as? String,
           retiredEpochs[runtimeId]?.contains(epoch) == true {
            rejectSnapshot(syncId, runtimeId: runtimeId, message: L10n.tr("会话同步来自已替换的来源。"))
            return
        }
        if pending.range == "history", let source = event["source"] as? [String: Any],
           let current = sourcePositions[runtimeId], source["epoch"] as? String != current.epoch {
            rejectSnapshot(syncId, runtimeId: runtimeId, message: L10n.tr("历史来源已经改变，请刷新会话。"))
            return
        }
        if let fingerprint = sessionSnapshotFingerprint(event) {
            snapshotCandidates[syncId] = SessionSnapshotReceipt(runtimeId: runtimeId, sessionId: pending.sessionId, fingerprint: fingerprint)
        }
        if event["selection"] as? String == "unchanged" {
            guard let known = pending.known, let applied = appliedBaselines[runtimeId], applied.epoch == known.epoch,
                  applied.seq >= known.seq, applied.seq > known.seq || applied.leaf == known.leaf else {
                rejectSnapshot(syncId, runtimeId: runtimeId, message: L10n.tr("会话已应用状态发生变化，请重试。"))
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
            rejectSnapshot(syncId, runtimeId: runtimeId, message: L10n.tr("会话工具清单的归属或版本无效，请刷新重试。"))
            return
        }
        var dependency: ToolReference?
        if let raw = (event["live"] as? [String: Any])?["toolInventory"], !(raw is NSNull) {
            guard let object = raw as? [String: Any], let reference: ToolReference = jsonDecode(object),
                  reference.agent.hostId == selectedHostId, reference.agent.sessionId == runtime.sessionId,
                  reference.agent.agentKind == runtime.agentKind || runtime.agentKind == nil,
                  reference.projectionVersion == 1, (0...4096).contains(reference.totalCount), (0...8_388_608).contains(reference.summaryBytes) else {
                finishSync(syncId); acknowledge(runtimeId: runtimeId, syncId: syncId, result: "rejected")
                errorMessage = L10n.tr("会话工具清单的归属或版本无效，请刷新重试。"); return
            }
            dependency = reference
        }
        if let status = event["rangeStatus"] as? String, !["complete", "older_available", "limit_reached"].contains(status) {
            historyErrors[runtimeId] = L10n.tr("历史范围不可用，请刷新会话后重试。")
            finishSync(syncId); acknowledge(runtimeId: runtimeId, syncId: syncId, result: "rejected"); return
        }
        if pending.range == "preview", let source = event["source"] as? [String: Any],
           let epoch = source["epoch"] as? String, let seq = integer(source["seq"]),
           let current = sourcePositions[runtimeId], current.epoch == epoch, seq < current.seq {
            // A late response must not replace a newer complete, committed source baseline.
            // Keep the committed head/live; this packet was not applied and still gets rejected.
            if let applied = appliedBaselines[runtimeId], applied.epoch == epoch, applied.seq == current.seq {
                handleSyncRejection(pending.commandId)
                finishSync(syncId, readPhase: .superseded)
                acknowledge(runtimeId: runtimeId, syncId: syncId, result: "rejected")
            } else {
                rejectSnapshot(syncId, runtimeId: runtimeId, message: L10n.tr("会话同步响应已落后于当前更新，请刷新重试。"))
            }
            return
        }
        if pending.range == "history" {
            guard event["range"] as? String == "history", event["mode"] as? String == "prepend",
                  event["beforeEntryId"] as? String == pending.boundary,
                  pending.leaf == nil || event["targetLeafId"] as? String == pending.leaf else {
                finishSync(syncId); acknowledge(runtimeId: runtimeId, syncId: syncId, result: "rejected"); return
            }
            guard !(event["hasOlder"] as? Bool == false && event["complete"] as? Bool == false) else {
                rejectSnapshot(syncId, runtimeId: runtimeId, message: L10n.tr("历史范围尚未完整，请重试。"))
                return
            }
            let entries = event["entries"] as? [[String: Any]] ?? []
            let first = entries.first?["entryId"] as? String
            guard event["hasOlder"] as? Bool != true || (first != nil && first != pending.boundary),
                  !(entries.isEmpty && event["hasOlder"] as? Bool == true),
                  entries.last?["entryId"] as? String != pending.boundary else {
                rejectSnapshot(syncId, runtimeId: runtimeId, message: L10n.tr("历史范围未推进，请重试。"))
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
                rejectSnapshot(syncId, runtimeId: runtimeId, message: L10n.tr("历史请求边界已经失效，请重试。")); return
            }
            if parent != persistedBoundary.parentId { connected = false }
            guard connected else {
                rejectSnapshot(syncId, runtimeId: runtimeId, message: L10n.tr("历史条目与请求边界不连续，请重试。"))
                return
            }
            guard await commitHistory(event, runtime: runtime, activate: false, rawEnvelope: rawEnvelope) != nil else {
                rejectSnapshot(syncId, runtimeId: runtimeId, message: L10n.tr("历史记录无法保存，请重试。"))
                return
            }
            guard generation == historyGeneration, let host = selectedHost,
                  let page = try? await historyWorker.page(host: host, sessionId: pending.sessionId,
                    leafId: pending.leaf, beforeEntryId: pending.boundary, limit: max(1, entries.count)),
                  generation == historyGeneration else { return }
            guard page.displayComplete, [.complete, .olderAvailable].contains(page.status) else {
                rejectSnapshot(syncId, runtimeId: runtimeId, message: L10n.tr("历史范围或显示结果不完整，请重试。")); return
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
                rejectSnapshot(syncId, runtimeId: runtimeId, message: L10n.tr("历史补齐范围已经失效。")); return
            }
            guard await commitHistory(event, runtime: runtime, activate: false, rawEnvelope: rawEnvelope) != nil else {
                rejectSnapshot(syncId, runtimeId: runtimeId, message: L10n.tr("补齐历史无法保存，请重试。")); return
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
        guard let committed = await commitHistory(event, runtime: runtime, activate: true, rawEnvelope: rawEnvelope) else {
            rejectSnapshot(syncId, runtimeId: runtimeId, message: L10n.tr("会话历史无法保存，请重试。"))
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
            liveMessageIds[runtimeId] = []; unfinishedLiveMessageIds[runtimeId] = []; liveOrders[runtimeId] = [:]
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
        markAuthoritative(runtimeId)
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
                if let read = syncReads.removeValue(forKey: syncId) { sessionReads.finish(read, phase: .failed, error: L10n.tr("工具清单等待任务已满。")) }
                acknowledge(runtimeId: runtimeId, syncId: syncId, result: "rejected")
            }
        } else {
            if let baseline { appliedBaselines[runtimeId] = baseline }
            completeRemoteRead(syncId, runtime: runtime, page: committed.page, sourceConfirmed: baseline != nil)
            beginCatchup(runtime)
            acknowledge(runtimeId: runtimeId, syncId: syncId, result: "applied")
        }
    }

    private func handleSyncRejection(_ commandId: String) {
        handledSyncRejections.append(commandId)
        if handledSyncRejections.count > 128 { handledSyncRejections.removeFirst(handledSyncRejections.count - 128) }
    }

    private func rejectSnapshot(_ syncId: String, runtimeId: String, message: String) {
        guard let pending = pendingSyncs[syncId], pending.runtimeId == runtimeId else { return }
        handleSyncRejection(pending.commandId)
        let range = pending.range
        finishSync(syncId, readPhase: .failed); acknowledge(runtimeId: runtimeId, syncId: syncId, result: "rejected")
        if range == "history" { historyErrors[runtimeId] = message } else { errorMessage = message }
    }

    private func commitHistory(_ event: [String: Any], runtime: RuntimeSummary, activate: Bool, rawEnvelope: Data?) async -> SessionHistoryCommit? {
        guard let host = selectedHost, let sessionId = runtime.sessionId,
              let data = rawEnvelope ?? (try? JSONSerialization.data(withJSONObject: event)) else { return nil }
        let generation = historyGeneration
        let branchGeneration = branchGenerations[runtime.runtimeId] ?? 0
        let lease = historyWriteLeases[runtime.runtimeId] ?? SessionHistoryWriteLease()
        historyWriteLeases[runtime.runtimeId] = lease
        do {
            let committed = try await historyWorker.ingest(host: host, sessionId: sessionId, event: data, wrapped: rawEnvelope != nil,
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
            liveMessageIds[runtimeId] = []; unfinishedLiveMessageIds[runtimeId] = []; liveOrders[runtimeId] = [:]
        }
        if let display = event["display"] as? [String: Any], let entries = display["entries"] as? [[String: Any]] {
            var batch = ChatMessageBatch(conversations[runtimeId] ?? [])
            let sessionId = runtimes.first(where: { $0.runtimeId == runtimeId })?.sessionId
            for row in entries {
                let entryId = row["entryId"] as? String
                if let entryId, row["anchor"] as? String != "head", sessionId.flatMap({ excludedDisplayEntries[$0] })?.contains(entryId) == true { continue }
                let committed = sessionId.flatMap { session in (entryId ?? row["displayId"] as? String).flatMap { graphs[session]?.display[$0] } }
                let message: ChatMessage?
                if let committed { message = committed.message }
                else if let object = row["message"] as? [String: Any] { message = jsonDecode(object) }
                else { message = nil }
                if let entryId {
                    if let old = displayMessageIds[runtimeId]?[entryId], old != message?.messageId { batch.remove(old) }
                    displayMessageIds[runtimeId, default: [:]][entryId] = message?.messageId
                }
                if let message { batch.upsert(message) }
            }
            conversations[runtimeId] = batch.messages
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
            var batch = ChatMessageBatch(conversations[runtimeId] ?? [])
            for row in entries {
                if let object = row["message"] as? [String: Any], let message: ChatMessage = jsonDecode(object) {
                    if let entryId = row["persistedEntryId"] as? String { addAlias(message.messageId, entryId: entryId, runtimeId: runtimeId) }
                    if isRetiredAlias(message.messageId, runtimeId: runtimeId) {
                        batch.remove(message.messageId)
                        continue
                    }
                    liveMessageIds[runtimeId, default: []].insert(message.messageId)
                    if row["finished"] as? Bool == false { unfinishedLiveMessageIds[runtimeId, default: []].insert(message.messageId) }
                    if let order = integer(row["order"]) { liveOrders[runtimeId, default: [:]][message.messageId] = order }
                    batch.upsert(message)
                }
            }
            conversations[runtimeId] = batch.messages
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
        unfinishedLiveMessageIds[runtimeId]?.subtract(retired)
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
        if let index = conversations[runtimeId]?.firstIndex(where: { $0.messageId == message.messageId }) {
            if conversations[runtimeId]?[index] != message { conversations[runtimeId]?[index] = message }
        } else { conversations[runtimeId, default: []].append(message) }
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
        reconcilePendingSends()
        guard let runtimeId = selectedRuntimeId else { messages = []; streamingMessageIds = []; updateSyncing(); return }
        let visibleTimings = selectedRuntime?.sessionId.flatMap { timingsBySession[$0] } ?? [:]
        if visibleTimings != turnTimings { turnTimings = visibleTimings }
        // 清单尚未追上本次投影时沿用上一次已确认的工具，避免卡片闪烁或用旧清单造出重复卡片。
        if let reference = liveToolReferences[runtimeId], toolInventories.covers(reference, runtime: runtimeId) {
            liveTools[runtimeId] = toolInventories.visible[runtimeId] ?? []
        }
        // Publishing an identical transcript would re-render the whole chat for nothing; the
        // comparison is O(1) when the array storage is unchanged.
        let next = PendingSendOutbox.merge(materializeLiveTools(conversations[runtimeId] ?? [], tools: liveTools[runtimeId] ?? [], liveOrders: liveOrders[runtimeId] ?? [:]),
                                           pending: pendingSends.chatRows(sessionId: selectedRuntime?.sessionId))
        let streaming = (unfinishedLiveMessageIds[runtimeId] ?? []).intersection(next.filter { $0.role == "assistant" }.map(\.messageId))
        if streaming != streamingMessageIds { streamingMessageIds = streaming }
        if next != messages { messages = next }
        if connection == .secured, let runtime = selectedRuntime, let session = runtime.sessionId,
           let host = selectedHost, let kind = agentKind(runtime) {
            turnFileChanges.observe(runtimeId: runtimeId, agent: ToolAgent(hostId: host.hostId, agentKind: kind, sessionId: session),
                entryIds: Array(changeAnchors(for: Set(next.map(\.messageId)))), turnIds: Array(turnTimings.keys))
        }
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

    func changeAnchors(for messageIds: Set<String>) -> Set<String> {
        guard let runtimeId = selectedRuntimeId else { return messageIds }
        var ids = messageIds
        for (entry, display) in displayMessageIds[runtimeId] ?? [:] where messageIds.contains(display) { ids.insert(entry) }
        for (live, entry) in messageAliases[runtimeId] ?? [:] where messageIds.contains(live) { ids.insert(entry) }
        return ids
    }

    private func invalidateConversation(_ runtimeId: String) {
        if runtimeId == selectedRuntimeId { turnFileChanges.clear() }
        historyWriteLeases.removeValue(forKey: runtimeId)?.invalidate()
        branchGenerations[runtimeId, default: 0] += 1
        for read in sessionReads.operations.values where read.owner.historyKey == runtimeId && read.phase.active {
            sessionReads.finish(read.id, phase: .superseded); pendingCatchups[read.id] = nil
        }
        oldestEntries[runtimeId] = nil; sessionLeaves[runtimeId] = nil; hasOlderHistory[runtimeId] = nil; historyErrors[runtimeId] = nil; historyLoading.remove(runtimeId)
        toolInventories.clear(runtimeId)
        agentState.remove(runtimeId: runtimeId); queuedMessages[runtimeId] = nil

        let toolAcks = toolAcknowledgements.filter { $0.value.runtimeId == runtimeId }.map(\.key)
        for id in toolAcks {
            toolAcknowledgements[id] = nil; pendingReadPages[id] = nil; pendingAppliedBaselines[id] = nil
            if let read = syncReads.removeValue(forKey: id) { sessionReads.finish(read, phase: .superseded) }
            acknowledge(runtimeId: runtimeId, syncId: id, result: "rejected")
        }
        interactions[runtimeId] = nil; commands[runtimeId] = nil; workingBranches[runtimeId] = nil
        if entryPreview?.runtimeId == runtimeId { dismissPreview() }
        let actions = runtimeActions.filter { $0.value.runtimeId == runtimeId }.map(\.key)
        for id in actions { runtimeActions[id] = nil; composerActionDrafts[id] = nil; pendingActionIds.remove(id); actionTimeouts.removeValue(forKey: id)?.cancel() }
        conversations[runtimeId] = nil
        liveMessageIds[runtimeId] = nil; unfinishedLiveMessageIds[runtimeId] = nil; liveOrders[runtimeId] = nil; liveToolReferences[runtimeId] = nil; liveTools[runtimeId] = nil
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
        historyLoading = []; handledSyncRejections = []
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
        let syncing = sessionReads.operations.values.contains { $0.owner.historyKey == selectedRuntimeId && $0.kind == .source && $0.phase.active }
        if syncing != isSyncing { isSyncing = syncing }
        transfers.setInteractive(pendingSyncs.values.contains { !$0.exhausted } || !syncDemands.isEmpty ||
            !runtimeActions.isEmpty || ledger.operations.contains { $0.kind == OperationKinds.queueCancel } || runtimes.contains { $0.status == "running" })
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
                if let read = syncReads[id] { sessionReads.finish(read, phase: .failed, error: L10n.tr("同步暂未完成，请重试。")) }
                historyLoading.remove(task.runtimeId)
                if task.range == "history" { historyErrors[task.runtimeId] = L10n.tr("历史读取暂未完成，请重试。") }
                else { errorMessage = L10n.tr("会话同步暂未完成，请重试。") }
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

    /// Directory announcements are transport metadata, not a replacement for committed model
    /// domains. A duplicate ready/online/metadata must not erase facts while the existing
    /// subscription is still active. Session replacement and Host epochs clear these baselines.
    private func reprojectRuntime(_ runtime: RuntimeSummary) -> RuntimeSummary {
        guard let snapshot = agentState.snapshots[runtime.runtimeId], snapshot.sessionId == runtime.sessionId,
              let projection = AgentProjection.make(runtime: runtime, hostId: selectedHostId, domains: snapshot.domains,
                commands: commands[runtime.runtimeId] ?? [], interactions: interactions[runtime.runtimeId] ?? [],
                queuedMessages: queuedMessages[runtime.runtimeId] ?? []) else { return runtime }
        return projection.runtime
    }

    private func mergeRuntime(_ current: RuntimeSummary, metadata: [String: Any]) -> RuntimeSummary {
        guard let data = try? JSONEncoder().encode(current), var merged = try? E2ECrypto.jsonObject(data) else { return current }
        for (key, value) in metadata { merged[key] = value }
        return jsonDecode(merged) ?? current
    }
}
