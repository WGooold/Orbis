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
    var error: String? = nil
    var id: String { runtime.runtimeId }
}

/// IOS-CHAT-05: a detail presentation owns one request on its original source.
/// A delayed dismissal or retry cannot replace a newer presentation on that source.
struct EntryPreviewHandle: Equatable {
    let owner: HostConnection
    let requestId: String
    let runtimeId: String
    let sessionId: String
    let entryId: String
    static func == (lhs: Self, rhs: Self) -> Bool { lhs.owner === rhs.owner && lhs.requestId == rhs.requestId }
}

enum HomePresentation: Equatable {
    case preparing
    case ready([HomeRuntimeCard])
}

/// Legacy Hosts have no enablement directory; only filter the dial when their backend roster is known.
func legacyAgentDialKinds(supported: [String]?, launchable: [String]?) -> [String]? {
    guard supported != nil || launchable != nil else { return nil }
    let announced = Set((supported ?? []) + (launchable ?? []))
    return ["codex", "claude", "dsh", "pi", "agy"].filter(announced.contains)
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
    private let replyCompletions: ReplyCompletionTracker
    @Published private(set) var pairings: [HostPairing] = []
    struct AgentEnablementRow: Identifiable, Equatable {
        let id: String
        let label: String
        let enabled: Bool
    }
    private static let agentEnablementFeature = "agent.enablement.v1"
    @Published private(set) var agentEnablementRows: [AgentEnablementRow] = [] {
        didSet { if oldValue != agentEnablementRows { directoryViewRevision &+= 1 } }
    }
    /// Nil is the legacy/unknown view; an empty set means the Host disabled every source.
    var enabledAgentKinds: Set<String>? {
        agentEnablementRevision.map { _ in Set(agentEnablementRows.filter(\.enabled).map(\.id)) }
    }
    struct AgentDialReview: Decodable, Equatable, Hashable {
        let kind: String
        let revision: Int
        let sessions: [String]
        let total: Int?
        let token: String?
    }
    struct AgentDialChoice: Equatable {
        let kind: String
        let target: Bool
        let previous: Bool
        let review: AgentDialReview?
        let expectedRevision: Int?
    }
    struct AgentDialNotice: Equatable {
        let kind: String?
        let status: String
        let id: String
        var revision: Int? = nil
    }
    private struct AgentDialRequest {
        let id: String
        let choice: AgentDialChoice?
        let revision: Int?
    }
    @Published private(set) var agentEnablementAvailable = false
    private(set) var agentEnablementRevision: Int?
    @Published private(set) var agentDialCached: [AgentEnablementRow]?
    @Published private(set) var agentDialSynchronized = false
    @Published private(set) var agentDialReview: AgentDialReview?
    @Published private(set) var agentDialNotice: AgentDialNotice?
    @Published private(set) var agentDialLastSync: Date?
    @Published private(set) var agentDialQueue: [AgentDialChoice] = []
    @Published private var agentDialRequest: AgentDialRequest?
    var agentEnablementPending: String? { agentDialRequest?.id }
    private var agentDialScoped = false
    var agentDialCanEdit: Bool { agentEnablementAvailable && agentDialSynchronized && connection == .secured }
    func agentDialChoice(_ kind: String) -> AgentDialChoice? {
        if let current = agentDialRequest?.choice, current.kind == kind { return current }
        return agentDialQueue.first { $0.kind == kind }
    }
    func agentDialVisualEnabled(_ kind: String, committed: Bool) -> Bool { agentDialChoice(kind)?.previous ?? committed }
    func agentDialQueued(_ kind: String) -> Bool { agentDialQueue.contains { $0.kind == kind } }

    private func resetAgentEnablement(keepDialCache: Bool = true) {
        if let request = agentDialRequest, let change = request.choice {
            agentDialNotice = AgentDialNotice(kind: change.kind, status: "interrupted", id: request.id)
        } else if agentDialNotice?.status != "interrupted" { agentDialNotice = nil }
        agentEnablementAvailable = false; agentDialSynchronized = false; agentDialScoped = false
        agentDialRequest = nil; agentDialReview = nil; agentDialQueue = []
        agentEnablementRevision = nil; agentEnablementRows = []
        if !keepDialCache { agentDialCached = nil; agentDialLastSync = nil; agentDialNotice = nil }
    }

    func dismissAgentDialReview(_ review: AgentDialReview) {
        if agentDialReview == review { agentDialReview = nil; pumpAgentDial() }
    }
    func cancelQueuedAgentDial() {
        if !agentDialQueue.isEmpty { agentDialQueue = [] }
        if agentDialReview != nil { agentDialReview = nil }
    }

    func setAgentEnabled(_ kind: String, enabled: Bool, expectedRevision: Int? = nil, review: AgentDialReview? = nil) {
        guard agentDialCanEdit, let revision = agentEnablementRevision, expectedRevision == nil || expectedRevision == revision,
              agentDialRequest?.choice?.kind != kind, agentDialReview == nil || agentDialReview == review else { return }
        if let index = agentDialQueue.firstIndex(where: { $0.kind == kind }) {
            if agentDialQueue[index].previous == enabled { agentDialQueue.remove(at: index) }
            return
        }
        guard let row = agentEnablementRows.first(where: { $0.id == kind && $0.enabled != enabled }),
              review == nil || (!enabled && review == agentDialReview && review?.revision == revision && review?.kind == kind) else { return }
        let choice = AgentDialChoice(kind: kind, target: enabled, previous: row.enabled, review: review, expectedRevision: expectedRevision ?? review?.revision)
        if review != nil { agentDialQueue.insert(choice, at: 0) } else { agentDialQueue.append(choice) }
        if agentDialReview?.kind == kind { agentDialReview = nil }
        agentDialNotice = nil
        pumpAgentDial()
    }

    func refreshAgentEnablement() {
        // Authenticated device.ready may precede the transport's .secured callback.
        guard agentEnablementAvailable, agentDialRequest == nil, agentDialQueue.isEmpty else { return }
        agentDialSynchronized = false
        requestAgentDial(nil, revision: nil)
    }

    private func pumpAgentDial() {
        guard agentDialCanEdit, agentDialRequest == nil, agentDialReview == nil, let revision = agentEnablementRevision else { return }
        while !agentDialQueue.isEmpty {
            let next = agentDialQueue.removeFirst()
            guard agentEnablementRows.contains(where: { $0.id == next.kind && $0.enabled == next.previous }),
                  next.expectedRevision == nil || next.expectedRevision == revision else {
                agentDialNotice = .init(kind: next.kind, status: "conflict", id: UUID().uuidString)
                continue
            }
            requestAgentDial(next, revision: revision); return
        }
    }

    private func requestAgentDial(_ choice: AgentDialChoice?, revision: Int?) {
        let id = "agent-enablement:" + UUID().uuidString
        agentDialRequest = AgentDialRequest(id: id, choice: choice, revision: revision)
        var request: [String: Any] = ["type": choice == nil ? "agent.enablement.read" : "agent.enablement.write", "requestId": id, "protocolVersion": orbisProtocolVersion]
        if let choice, let revision {
            request["kind"] = choice.kind; request["enabled"] = choice.target; request["expectedRevision"] = revision
            if let review = choice.review {
                if let token = review.token { request["review"] = token } else { request["confirmDisable"] = true }
            }
        }
        guard transport.send(request) else { failAgentDial(id); return }
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(10))
            self?.failAgentDial(id)
        }
    }

    private func failAgentDial(_ id: String) {
        guard let request = agentDialRequest, request.id == id else { return }
        agentDialRequest = nil; agentDialSynchronized = false; agentDialQueue = []; agentDialReview = nil
        agentDialNotice = .init(kind: request.choice?.kind, status: request.choice == nil ? "readFailed" : "interrupted", id: id)
        if request.choice != nil { refreshAgentEnablement() }
    }

    private func receiveAgentEnablement(_ message: [String: Any]) {
        guard agentEnablementAvailable, let snapshot = message["snapshot"] as? [String: Any],
              let revision = snapshot["revision"] as? Int, (0...9_007_199_254_740_991).contains(revision),
              let raw = snapshot["agents"] as? [[String: Any]], raw.count <= 128 else { return }
        let rows = raw.compactMap { row -> AgentEnablementRow? in
            guard let id = row["kind"] as? String, (1...64).contains(id.count),
                  let label = row["label"] as? String, (1...128).contains(label.count), let enabled = row["enabled"] as? Bool else { return nil }
            return AgentEnablementRow(id: id, label: label, enabled: enabled)
        }
        guard rows.count == raw.count, Set(rows.map(\.id)).count == rows.count else { return }
        let isResult = message["type"] as? String == "agent.enablement.result"
        let status = message["status"] as? String
        guard !isResult || ["applied", "conflict", "unchanged"].contains(status ?? "") else { return }
        let owned = agentDialRequest.flatMap { $0.id == message["requestId"] as? String && ($0.choice != nil) == isResult ? $0 : nil }
        guard (message["requestId"] == nil || owned != nil), (!isResult || owned?.choice != nil) else { return }
        let expectedResultRevision = owned?.revision.map { $0 + 1 }
        let staleResult = owned?.choice != nil && (revision < (agentEnablementRevision ?? -1) ||
            status == "applied" && expectedResultRevision != revision)
        var other: AgentEnablementRow?
        if revision > (agentEnablementRevision ?? -1) {
            other = rows.first { row in agentDialChoice(row.id) == nil && (agentDialCached ?? []).contains { $0.id == row.id && $0.enabled != row.enabled } }
            agentEnablementRevision = revision
            if rows != agentEnablementRows { agentEnablementRows = rows }
            if rows != agentDialCached { agentDialCached = rows }
            agentDialLastSync = Date()
            if agentDialReview?.revision != revision { agentDialReview = nil }
        }
        if let owned {
            agentDialRequest = nil
            if let change = owned.choice {
                if status == "conflict" || staleResult { agentDialNotice = .init(kind: change.kind, status: "conflict", id: owned.id) }
                else if !change.target, status == "applied", agentEnablementRows.contains(where: { $0.id == change.kind && !$0.enabled }) {
                    agentDialNotice = .init(kind: change.kind, status: "disabled", id: owned.id, revision: agentEnablementRevision)
                } else if status == "applied" { agentDialNotice = nil }
            } else {
                if agentDialNotice?.status == "readFailed" { agentDialNotice = nil }
                agentDialSynchronized = true
            }
        }
        if owned?.choice == nil, let other { agentDialNotice = .init(kind: other.id, status: other.enabled ? "externalOn" : "externalOff", id: "snapshot:\(revision)") }
        pumpAgentDial()
    }

    private func rejectAgentDial(_ message: [String: Any]) {
        guard let request = agentDialRequest, request.id == message["requestId"] as? String else { return }
        agentDialRequest = nil
        if let change = request.choice, !change.target, let revision = agentEnablementRevision, revision == request.revision {
            if agentDialScoped, let raw = message["review"] as? [String: Any], let review: AgentDialReview = jsonDecode(raw), review.kind == change.kind,
               review.revision == revision, let total = review.total, total >= max(1, review.sessions.count), review.sessions.count <= 24,
               review.sessions.allSatisfy({ (1...256).contains($0.count) }),
               let token = review.token, token.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil {
                agentDialReview = review; pumpAgentDial(); return
            }
            if !agentDialScoped, message["code"] as? String == "agent_disable_confirmation_required" {
                agentDialReview = .init(kind: change.kind, revision: revision, sessions: [], total: nil, token: nil)
                pumpAgentDial(); return
            }
        }
        let status = request.choice == nil ? "readFailed" : agentEnablementRevision == request.revision ? "failed" : "conflict"
        agentDialNotice = .init(kind: request.choice?.kind, status: status, id: request.id)
        pumpAgentDial()
    }

    @Published private(set) var selectedHostId: String?
    @Published private(set) var runtimes: [RuntimeSummary] = [] { didSet { runtimeIndex = Dictionary(runtimes.map { ($0.runtimeId, $0) }, uniquingKeysWith: { _, last in last }); markHomeMetadataChanged(); directoryInputRevision &+= 1; directoryMetadataRevision &+= 1; directoryViewRevision &+= 1 } }
    @Published private(set) var sessions: [SessionSummary] = [] {
        didSet { markHomeMetadataChanged(); directoryInputRevision &+= 1; directoryMetadataRevision &+= 1; directoryViewRevision &+= 1 }
    }
    /// sessionId → 目录条目。聊天页每条消息、每次流式更新都会查询，不能线性扫描整个目录。
    private var sessionIndex: [String: SessionSummary] = [:]
    private let sessionCatalogWorker = SessionCatalogPreparationWorker()
    private var sessionCatalogTask: Task<Void, Never>?
    private var sessionCatalogTaskID = UUID()
    private var runtimeIndex: [String: RuntimeSummary] = [:]
    @Published private(set) var messages: [ChatMessage] = [] { didSet { scheduleTranscript() } }
    @Published private(set) var selectedRuntimeId: String? { didSet { directoryViewRevision &+= 1; notificationCleanupChanged.send() } }
    @Published private(set) var connection: ConnectionState = .offline { didSet { markHomeMetadataChanged(); directoryViewRevision &+= 1; notificationCleanupChanged.send() } }
    @Published private(set) var activePath: String? { didSet { homeViewRevision &+= 1 } }
    @Published private(set) var feedback = FeedbackState()
    /// Read-only compatibility projection; every writer declares F3/F4 at the call site.
    var errorMessage: String? { feedback.banner?.text }
    var feedbackDownloadsVisible = false
    var feedbackChatVisible = false
    private var failedTransferRounds: [String: Int] = [:]
    private var toastTimeout: Task<Void, Never>?
    struct ObjectFeedback: Equatable {
        let sessionId: String?
        let message: String
        var cardOnly = false
    }
    @Published private(set) var objectErrors: [String: ObjectFeedback] = [:] { didSet { homeViewRevision &+= 1 } }
    @Published private(set) var composerErrors: [String: ObjectFeedback] = [:]
    @Published private(set) var sessionOperationErrors: [String: String] = [:] { didSet { directoryViewRevision &+= 1 } }
    @Published private(set) var queueErrors: [String: String] = [:]
    // Local response feedback: runtime → request → message. Never sent to the Host.
    @Published private(set) var interactionErrors: [String: [String: String]] = [:]
    @Published private(set) var menuErrors: [String: String] = [:]
    func objectError(_ runtimeId: String, includeCardOnly: Bool = true) -> String? {
        guard let error = objectErrors[runtimeId], includeCardOnly || !error.cardOnly,
              let runtime = runtimeIndex[runtimeId], error.sessionId == runtime.sessionId else { return nil }
        return error.message
    }
    func clearObjectError(_ runtimeId: String) {
        if objectErrors[runtimeId] != nil { objectErrors[runtimeId] = nil }
    }
    func composerError(_ runtimeId: String) -> String? {
        let runtime = runtimeIndex[runtimeId] ?? (selectedRuntime?.runtimeId == runtimeId ? selectedRuntime : nil)
        guard let error = composerErrors[runtimeId], let runtime, error.sessionId == runtime.sessionId else { return nil }
        return error.message
    }
    private func composerFeedback(_ message: String, newSession: Bool = false) {
        if !newSession, let runtime = selectedRuntime {
            composerErrors[runtime.runtimeId] = ObjectFeedback(sessionId: runtime.sessionId, message: FeedbackText.reason(message))
        } else {
            sessionLaunchError = FeedbackText.reason(message)
            sessionLaunchErrorIsValidation = true
        }
    }
    func clearSessionLaunchValidationError() {
        if sessionLaunchErrorIsValidation { sessionLaunchError = nil }
    }
    private func inlineFeedback(_ message: String, runtimeId: String? = nil, cardOnly: Bool = false) {
        if let id = runtimeId ?? selectedRuntimeId, let runtime = runtimeIndex[id] {
            objectErrors[id] = ObjectFeedback(sessionId: runtime.sessionId, message: FeedbackText.reason(message), cardOnly: cardOnly)
        } else if let launch = launching, runtimeId == nil || runtimeId == launch.placeholder {
            launching?.failure = FeedbackText.reason(message)
        } else if runtimeId == nil { sessionLaunchError = FeedbackText.reason(message) }
        else { recordConnectionEvent("feedback.dropped: owner_removed") }
    }
    func presentFeedback(_ level: FeedbackLevel, _ message: String, condition: FeedbackCondition? = nil, key: String? = nil, action: FeedbackAction? = nil) {
        let previous = feedback.toast?.id
        feedback.present(level, text: message, condition: condition, key: key, action: action)
        guard level == .toast, feedback.toast?.id != previous else { return }
        toastTimeout?.cancel(); toastTimeout = nil
        guard let toast = feedback.toast, toast.action == nil else { return }
        toastTimeout = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(FeedbackTiming.holdToast)) } catch { return }
            self?.feedback.dismissToast(toast.id)
        }
    }
    func dismissFeedbackBanner() { feedback.dismissBanner() }
    func dismissFeedbackToast() { toastTimeout?.cancel(); toastTimeout = nil; feedback.dismissToast() }
    func setFeedbackForeground(_ active: Bool) {
        feedback.setForeground(active)
        if !active { transfers.browserPreview.close(); toastTimeout?.cancel(); toastTimeout = nil }
    }
    func clearFeedbackScope(preservingConnectionConditions: Bool = false) {
        toastTimeout?.cancel(); toastTimeout = nil
        if preservingConnectionConditions { feedback.clearTransientPresentation() } else { feedback.clear() }
        objectErrors = [:]; composerErrors = [:]; sessionOperationErrors = [:]; menuErrors = [:]; historyErrors = [:]; queueErrors = [:]; interactionErrors = [:]
        if openClawConfigurationCwd != nil {
            configurationTimeout?.cancel(); sessionConfigurationRequest = nil; openClawConfigurationCwd = nil
        }
        sessionConfigurationError = nil; sessionLaunchError = nil; configFailures = [:]; transfers.error = nil; transfers.clearUploadErrors()
        dismissBrowse(); toolContent.close(); menuOptions.cancel(); menuOptionsTimeout?.cancel()
    }
    private func connectionFeedback(_ condition: FeedbackCondition) {
        switch condition {
        case .pairing: presentFeedback(.banner, L10n.tr("这台手机的配对已失效"), condition: .pairing, action: .pair)
        case .version: presentFeedback(.banner, L10n.tr("版本不兼容，请更新手机和电脑端 Orbis"), condition: .version, action: .update)
        case .computerClosed: presentFeedback(.banner, L10n.tr("电脑端 Orbis 未打开，打开后会自动连接"), condition: .computerClosed, action: .reconnect)
        case .other: presentFeedback(.banner, L10n.tr("连接无法继续，请重新连接"), condition: .other, action: .reconnect)
        }
    }
    @Published private(set) var isPairing = false
    @Published private(set) var isSyncing = false
    @Published private(set) var activatingSessionId: String? { didSet { directoryViewRevision &+= 1 } }
    @Published private(set) var browse: DirectoryBrowse?
    @Published private(set) var commands: [String: [SlashCommand]] = [:] { didSet { homeViewRevision &+= 1; chatRewindRevision &+= 1 } }
    @Published private(set) var supportedAgents: [String]?
    @Published private(set) var launchableAgents: [String]?
    @Published private(set) var openCodeAvailability: OpenCodeAvailability?
    @Published private var openClawBackendAdvice: String?
    var canLaunchOpenClaw: Bool {
        (launchableAgents ?? supportedAgents)?.contains("openclaw") == true &&
            openClawNegotiated && enabledAgentKinds?.contains("openclaw") != false
    }
    func openClawDraftDiagnostic(language: AppLanguage = AppLocalization.shared.language) -> String? {
        guard connection == .secured, openClawNegotiated, enabledAgentKinds?.contains("openclaw") != false, !canLaunchOpenClaw,
              let openClawBackendAdvice else { return nil }
        return L10n.format(openClawBackendAdvice, language: language)
    }
    @Published private(set) var sessionConfigurationSupported = false
    @Published private(set) var kimiCodeSupported = false {
        didSet { if oldValue != kimiCodeSupported { directoryInputRevision &+= 1; directoryMetadataRevision &+= 1; directoryViewRevision &+= 1 } }
    }
    @Published private(set) var kimiCodeDesktopSupported = false {
        didSet { if oldValue != kimiCodeDesktopSupported { directoryInputRevision &+= 1; directoryMetadataRevision &+= 1; directoryViewRevision &+= 1 } }
    }
    @Published private(set) var openClawNegotiated = false
    @Published private(set) var agyNegotiated = false
    // ADR-0090: only an authenticated Host that advertises `session.spawn.auto` changes the legacy default.
    private var defaultSessionSpawnMode = "tui"
    @Published private(set) var sessionConfiguration: SessionConfigurationSnapshot?
    @Published private(set) var proposedSessionConfiguration: SessionConfigurationValues?
    @Published private(set) var sessionConfigurationRequest: String?
    @Published private(set) var sessionConfigurationError: String?
    private(set) var openClawConfigurationCwd: String?
    @Published private(set) var sessionLaunchError: String? {
        didSet {
            sessionLaunchErrorIsValidation = false; sessionLaunchErrorAwaitsConnection = false
        }
    }
    private var sessionLaunchErrorIsValidation = false
    private var previousLaunchToReview: String? {
        launchJournal.pending.lazy.compactMap { $0["launchId"] as? String }
            .first { id in self.launch(id)?.following != true }
    }
    var canReviewPreviousLaunch: Bool { previousLaunchToReview != nil }
    /// SC102: an activation that never reached the computer is resolved by the
    /// next ready connection or successful activation write.
    private var sessionLaunchErrorAwaitsConnection = false
    private var configurationTimeout: Task<Void, Never>?
    private let launchJournalRoot: URL
    private var launchJournalURL: URL { launchJournalRoot.appendingPathComponent((selectedHostId ?? "unpaired").addingPercentEncoding(withAllowedCharacters: .alphanumerics)! + ".json") }
    private let localStores: HostLocalStores
    private var launchJournal: ConfiguredLaunchJournal { localStores.journal(at: launchJournalURL) }
    var recoveredLaunchDraft: ConfiguredLaunchJournal.RecoveredDraft? { launchJournal.recoveredDraft }
    private var draftReturnLaunchId: String?
    func takeReturnedLaunchDraft() -> ConfiguredLaunchJournal.RecoveredDraft? {
        guard let id = draftReturnLaunchId else { return nil }
        draftReturnLaunchId = nil
        return launchJournal.recoveredDraft(for: id)
    }
    private func writeLaunchJournal(_ value: [String: Any], creating: Bool = false) -> Task<Bool, Never>? {
        let journal = launchJournal
        guard let id = value["launchId"] as? String,
              let task = creating ? journal.reserve(value) : journal.update(id, value: value) else { return nil }
        runAsyncTransaction { [weak self] in
            if await !task.value, self?.launchJournal === journal, journal.acceptsResult(for: id) {
                self?.markConfiguredLaunchUnconfirmed(id, reason: L10n.tr("无法保存启动恢复记录，请重试"))
            }
        }
        return task
    }
    private func startConfigurationTimeout(_ id: String) {
        configurationTimeout?.cancel()
        configurationTimeout = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 20_000_000_000) } catch { return }
            guard let self, self.sessionConfigurationRequest == id else { return }
            self.sessionConfigurationRequest = nil
            self.sessionConfigurationError = self.openClawConfigurationCwd == nil ? L10n.tr("配置未确认，请刷新核对")
                : L10n.tr("未收到电脑回复，请检查连接后重试")
        }
    }
    var sessionConfigurationValues: SessionConfigurationValues { proposedSessionConfiguration ?? sessionConfiguration?.values ?? SessionConfigurationValues() }

    func supportsSessionConfiguration(for agent: String) -> Bool {
        enabledAgentKinds?.contains(agent) != false && sessionConfigurationSupported && (agent != "openclaw" || openClawNegotiated) && (agent != "agy" || agyNegotiated) &&
            supportsKimiCode(kind: agent, web: kimiCodeSupported, desktop: kimiCodeDesktopSupported)
    }

    func loadSessionConfiguration(agent: String, cwd: String) {
        guard supportsSessionConfiguration(for: agent), connection == .secured, !cwd.isEmpty else { return }
        let id = UUID().uuidString
        openClawConfigurationCwd = agent == "openclaw" ? cwd : nil
        sessionConfigurationRequest = id; sessionConfiguration = nil; proposedSessionConfiguration = nil; sessionConfigurationError = nil
        if transport.send(["type": "session.configuration.read", "protocolVersion": orbisProtocolVersion, "requestId": id, "agentKind": agent, "cwd": cwd]) {
            startConfigurationTimeout(id)
        } else {
            configurationTimeout?.cancel(); sessionConfigurationRequest = nil
            sessionConfigurationError = agent == "openclaw" ? L10n.tr("配置请求未发送，请检查连接后重试") : L10n.tr("配置未发送，请检查连接")
        }
    }

    func saveSessionConfiguration(_ values: SessionConfigurationValues) {
        guard connection == .secured, let config = sessionConfiguration, config.agentKind != "openclaw" else { return }
        let id = UUID().uuidString; startConfigurationTimeout(id); sessionConfigurationRequest = id; proposedSessionConfiguration = values; sessionConfigurationError = nil
        if !transport.send(["type": "session.configuration.save", "protocolVersion": orbisProtocolVersion, "requestId": id,
                            "agentKind": config.agentKind, "cwd": config.cwd, "binding": config.binding, "revision": config.revision, "values": values.payload]) {
            sessionConfigurationRequest = nil; sessionConfigurationError = L10n.tr("配置未确认，请检查连接")
        }
    }

    private func canReadConfiguredLaunch(_ agent: String) -> Bool {
        sessionConfigurationSupported && connection == .secured && supportsKimiCode(kind: agent, web: kimiCodeSupported, desktop: kimiCodeDesktopSupported)
    }

    private func recoverConfiguredLaunch(_ targetId: String? = nil) {
        let journal = launchJournal, generation = connectionGeneration
        runAsyncTransaction { [weak self] in
            await journal.waitLoaded()
            guard let self else { return }
            let ids = journal.pending.compactMap { $0["launchId"] as? String }
            for (index, id) in ids.enumerated() {
                guard !Task.isCancelled, generation == self.connectionGeneration else { return }
                // A ready receipt may have advanced this record while another ID was being saved.
                guard targetId == nil || targetId == id, journal.acceptsResult(for: id),
                      let saved = journal.snapshot(id), let agent = saved["agentKind"] as? String,
                      self.canReadConfiguredLaunch(agent) else { continue }
                self.restoreConfiguredLaunch(saved, id: id, show: false,
                    mayRestoreSelection: targetId == nil && index == 0 && self.allowAutomaticLaunchSelection &&
                        self.launching == nil && self.selectedOfflineSession == nil)
                guard let persisted = self.writeLaunchJournal(saved), await persisted.value,
                      !Task.isCancelled, generation == self.connectionGeneration, journal.acceptsResult(for: id),
                      self.canReadConfiguredLaunch(agent) else { continue }
                _ = self.transport.send(["type": "session.launch.read", "protocolVersion": orbisProtocolVersion, "requestId": id, "launchId": id])
            }
        }
    }
    private func restoreConfiguredLaunch(_ saved: [String: Any], id: String, show: Bool, mayRestoreSelection: Bool = false) {
        guard let agent = saved["agentKind"] as? String, let cwd = saved["cwd"] as? String else { return }
        if launch(id) == nil {
            let placeholder = "launch:" + id
            _ = ledger.create(opId: id, kind: OperationKinds.launch, target: placeholder, policy: OperationKinds.launchPolicy,
                              basis: ledgerBasis(OperationKinds.runtimesDomain), payload: .launch(requestId: id, placeholder: placeholder), written: true, now: Date())
            let following = mayRestoreSelection && saved["following"] as? Bool != false
            let restored = LaunchState(requestId: id, placeholder: placeholder, target: ["type": "new", "agentKind": agent, "cwd": cwd],
                title: L10n.tr("新会话"), cwd: cwd, agentKind: agent, resumed: nil, sessionId: nil, unconfirmed: true, configured: true,
                following: following, codexLaunchMode: (saved["codexLaunchMode"] as? String).flatMap(CodexLaunchMode.init(rawValue:)))
            if following { allowAutomaticLaunchSelection = false; launching = restored; selectedRuntimeId = placeholder }
            else { backgroundLaunches[id] = restored }
            if let text = saved["firstMessage"] as? String, !text.isEmpty, let messageId = saved["firstMessageId"] as? String,
               pendingSends.item(messageId) == nil {
                pendingSendHostId = selectedHostId
                var send = PendingSend(messageId: messageId, commandId: saved["firstCommandId"] as? String ?? messageId,
                    sessionId: placeholder, runtimeId: placeholder, text: text, attachments: [], delivery: nil, createdAt: Date(), anchorMessageId: nil)
                send.state = .unconfirmed; send.needsDeliveryEvidence = true
                pendingSends.add(send); publishMessages()
            }
        }
        if show, var restored = launch(id) {
            if launching?.requestId != id { parkForegroundLaunch() }
            allowAutomaticLaunchSelection = false
            backgroundLaunches[id] = nil
            restored.following = true; launching = restored
            selectedOfflineSession = nil; selectedRuntimeId = restored.placeholder
            activationRevision += 1
        }
    }

    private func createConfiguredSession(agent: String, cwd: String, firstMessage: String) -> Bool {
        guard enabledAgentKinds?.contains(agent) != false, connection == .secured, let config = sessionConfiguration,
              config.agentKind == agent, config.cwd == cwd, sessionConfigurationError == nil, supportsKimiCode(kind: agent, web: kimiCodeSupported, desktop: kimiCodeDesktopSupported) else { return false }
        let id = UUID().uuidString, placeholder = "launch:" + id
        let creation = ledger.create(opId: id, kind: OperationKinds.launch, target: placeholder, policy: OperationKinds.launchPolicy,
            basis: ledgerBasis(OperationKinds.runtimesDomain), payload: .launch(requestId: id, placeholder: placeholder), written: false, now: Date())
        guard creation == .created else { return false }
        var payload: [String: Any] = ["type": "session.launch", "protocolVersion": orbisProtocolVersion, "requestId": id, "launchId": id,
            "agentKind": agent, "cwd": cwd, "binding": config.binding, "revision": config.revision, "values": agent == "openclaw" ? SessionConfigurationValues().payload : sessionConfigurationValues.payload,
            "spawnMode": agent == "openclaw" || agent == "agy" ? "headless" : kimiSpawnMode(agent, otherwise: defaultSessionSpawnMode)]
        if unifiedCodexHistory, ["codex", "codexDesktop"].contains(agent) {
            payload["codexLaunchMode"] = agent == "codexDesktop" ? "desktop" : "terminal"
        }
        let firstId = UUID().uuidString, firstCommand = UUID().uuidString
        guard let persisted = writeLaunchJournal(payload.merging(["firstMessage": firstMessage, "firstMessageId": firstId, "firstCommandId": firstCommand]) { _, new in new }, creating: true) else {
            ledger.remove(id); return false
        }
        parkForegroundLaunch()
        sessionLaunchError = nil
        activationRequestId = id; pendingActivation = "new"; activatingSessionId = "new"
        launching = LaunchState(requestId: id, placeholder: placeholder, target: ["type": "new", "agentKind": agent, "cwd": cwd],
                                title: firstMessage.isEmpty ? (cwd.split(separator: "/").last.map(String.init) ?? L10n.tr("新会话")) : String(firstMessage.prefix(22)),
                                cwd: cwd, agentKind: agent, resumed: nil, sessionId: nil, configured: true,
                                codexLaunchMode: (payload["codexLaunchMode"] as? String).flatMap(CodexLaunchMode.init(rawValue:)))
        toolContent.close(); turnFileChanges.clear(); dismissPreview(); selectedOfflineSession = nil; selectedRuntimeId = placeholder; messages = []
        activationRevision += 1
        if !firstMessage.isEmpty, let runtime = selectedRuntime, let operation = ledger.operation(id) {
            guard sendWhenReady(firstMessage, delivery: nil, uploads: [], runtime: runtime, configs: [operation], id: firstId, commandId: firstCommand) else { return false }
        }
        let generation = connectionGeneration
        runAsyncTransaction { [weak self] in
            guard await persisted.value, let self, !Task.isCancelled, generation == self.connectionGeneration,
                  self.launchJournal.acceptsResult(for: id), self.connection == .secured, supportsKimiCode(kind: agent, web: self.kimiCodeSupported, desktop: self.kimiCodeDesktopSupported) else { return }
            if self.transport.send(payload) { self.handleLedger(self.ledger.written(id, now: Date())) }
            else { self.markConfiguredLaunchUnconfirmed(id) }
        }
        return true
    }
    @Published private(set) var codexDesktop: CodexDesktopAttach?
    @Published private(set) var unifiedCodexHistory = false {
        didSet {
            if oldValue != unifiedCodexHistory { directoryInputRevision &+= 1; directoryMetadataRevision &+= 1; directoryViewRevision &+= 1 }
        }
    }
    var directoryEnabledAgentKinds: Set<String>? {
        guard unifiedCodexHistory, var kinds = enabledAgentKinds else { return enabledAgentKinds }
        if kinds.remove("codexDesktop") != nil { kinds.insert("codex") }
        return kinds
    }
    /// PERF-12 (Android parity): the composer owns the text it is editing; a keystroke is stored and
    /// persisted here without publishing. Writes that originate in the store advance `draftRevision`
    /// so a visible composer reloads them.
    private(set) var drafts: [String: String] = [:]
    @Published private(set) var draftRevision = 0
    @Published private(set) var pathRTT: Double?
    @Published private(set) var activationRevision = 0
    @Published private(set) var pendingActionIds: Set<String> = []
    @Published private(set) var actionFeedback: String?
    @Published private(set) var workingBranches: [String: WorkingBranch] = [:]
    @Published private(set) var entryPreview: EntryPreview?
    @Published private(set) var historyRevision = 0
    @Published private(set) var interactions: [String: [InteractionRequest]] = [:] { didSet { homeInputRevision &+= 1 } }
    /// 回答结算后在原位短暂显示的结果（约 2.5 秒，V16）：runtimeId → 结果。
    @Published private(set) var interactionOutcomes: [String: InteractionOutcome] = [:]
    struct InteractionOutcome: Equatable { let id: UUID; let requestId: String; let text: String }
    @Published private(set) var queuedMessages: [String: [QueuedMessage]] = [:]
    /// ADR-0049：本机已发出、尚未在源端落地的消息。按 Session 归属，只属于 `pendingSendHostId`。
    @Published private(set) var pendingSends = PendingSendOutbox()
    private var pendingSendHostId: String?
    /// 每个 Session 应用权威状态（快照或完整 patch）的次数，用于兜底核对。
    private var sessionRevisions: [String: Int] = [:]
    private var pendingSendCheck: Task<Void, Never>?
    /// ADR-0049 §7：本连接的操作账本。乐观操作的阶段、断线、期限、作用域和冲突只在账本里处理；
    /// 界面 = 权威状态叠加账本，种类定义见 `OperationKinds`。只在当前进程内存中（L11）。
    @Published private(set) var ledger = AppLedger() {
        didSet {
            if OperationKinds.hiddenRuntimeIds(oldValue) != OperationKinds.hiddenRuntimeIds(ledger) { markHomeMetadataChanged() }
            if OperationKinds.archiveOverrides(oldValue) != OperationKinds.archiveOverrides(ledger) {
                directoryInputRevision &+= 1; directoryMetadataRevision &+= 1; directoryViewRevision &+= 1
            }
        }
    }
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
        var configured = false
        var rejected = false
        var endingWait = false
        var canEndConfiguredLaunch: Bool { configured && (unconfirmed || failure != nil) }
        /// 用户仍停在这个启动页：成功后切到真实会话；离开后不再把用户拉回，会话照常出现在首页。
        var following = true
        var spawnModeOverride: String? = nil
        var codexLaunchMode: CodexLaunchMode? = nil
    }
    @Published private(set) var launching: LaunchState?
    @Published private var backgroundLaunches: [String: LaunchState] = [:]
    /// Cold recovery can restore a launch page only until the user chooses where to go.
    private var allowAutomaticLaunchSelection = true
    private var trackedLaunches: [LaunchState] { [launching].compactMap { $0 } + backgroundLaunches.values }
    private func launch(_ id: String) -> LaunchState? { launching?.requestId == id ? launching : backgroundLaunches[id] }
    private func updateLaunch(_ value: LaunchState) {
        if launching?.requestId == value.requestId { launching = value }
        else { backgroundLaunches[value.requestId] = value }
    }
    private func parkForegroundLaunch() {
        stopFollowingLaunch()
        guard let previous = launching else { return }
        if previous.rejected {
            retireConfiguredLaunch(previous.requestId, firstId: launchJournal.snapshot(previous.requestId)?["firstMessageId"] as? String)
            return
        }
        backgroundLaunches[previous.requestId] = previous
        launching = nil; launchComposerFocused = false
        if activationRequestId == previous.requestId || (activationRequestId == nil && pendingActivation == previous.sessionId) { clearActivation() }
    }
    /// 启动期间消息的占位 Session → 确认后的 Session。
    private var launchSessions: [String: String] = [:]
    /// 启动页输入框是否有焦点；会话上线切到真实会话页时把焦点交给新页面，正在输入不被打断（ADR-0049 §6.8）。
    private var launchComposerFocused = false
    private var composerFocusHandoff: String?
    /// 首页正在关闭的会话（含结果不明）：卡片保持隐藏。
    var closingRuntimeIds: Set<String> { OperationKinds.hiddenRuntimeIds(ledger) }
    /// 首页只发布完整快照：冷启动准备一次，后续重连/刷新在后台组装下一版。
    /// 此快照只在当前配对的内存中保留，不把磁盘目录缓存当成本次在线会话。
    @Published private(set) var homePresentation: HomePresentation = .preparing { didSet { homeViewRevision &+= 1 } }
    private var homeDirectoryReceived = false { didSet { markHomeMetadataChanged() } }
    // SC121: keep destructive notification reads separate from the cached home UI.
    let notificationCleanupChanged = PassthroughSubject<Void, Never>()
    private var notificationConnectionStartedAt = Date()
    private var notificationDirectoryConfirmedAt: Date?
    private var notificationDirectoryUpdates = 0
    private var notificationOfflineRuntimes: Set<String> = []
    private var replyNotificationCompletions: Set<ReplyNotificationCleanup.Turn> = []
    private var homeInputRevision = 0
    private var homeMetadataRevision = 0
    private var preparedSyncRevision = -1
    private var cachedHomeSync: HomeSyncStatus = .syncing
    private var preparedSyncLanguage: AppLanguage?
    var preparedHomeSync: HomeSyncStatus { prepareHomeSync(); return cachedHomeSync }
    private(set) var homeViewRevision = 0
    private(set) var directoryViewRevision = 0
    private var directoryInputRevision = 0
    private var directoryMetadataRevision = 0
    private var scheduledDirectoryRevision = -1
    private let directoryWorker = SessionDirectoryCatalogWorker()
    private var directoryTask: Task<Void, Never>?
    private var directoryTaskID = UUID()
    @Published private(set) var directoryCatalog = SessionDirectoryCatalog()

    private func markHomeMetadataChanged() {
        homeInputRevision &+= 1; homeMetadataRevision &+= 1; homeViewRevision &+= 1
    }
    /// Called after willChange has completed, with whole event/model facts available.
    private func prepareHomeSync() {
        if preparedSyncRevision != homeMetadataRevision || preparedSyncLanguage != AppLocalization.shared.language {
            preparedSyncRevision = homeMetadataRevision; preparedSyncLanguage = AppLocalization.shared.language
            cachedHomeSync = homeSyncStatus
        }
    }
    func prepareScreenPublications() {
        prepareHomeSync()
        guard scheduledDirectoryRevision != directoryInputRevision else { return }
        guard directoryTask == nil else { return }
        let taskID = UUID(); directoryTaskID = taskID
        directoryTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                let revision = self.directoryInputRevision, metadata = self.directoryMetadataRevision
                let catalog = await self.directoryWorker.resolve(sessions: self.sessions, runtimes: self.runtimes,
                    messages: self.conversations, archived: OperationKinds.archiveOverrides(self.ledger), kimiCodeSupported: self.kimiCodeSupported,
                    kimiCodeDesktopSupported: self.kimiCodeDesktopSupported,
                    unifiedCodex: self.unifiedCodexHistory)
                guard !Task.isCancelled else { break }
                // Transcript chunks may arrive continuously. A serial, older result may advance
                // the same catalog; newer metadata/archives must fence it out.
                guard metadata == self.directoryMetadataRevision else { continue }
                self.scheduledDirectoryRevision = revision
                if self.directoryCatalog !== catalog { self.directoryCatalog = catalog; self.directoryViewRevision &+= 1 }
                if revision == self.directoryInputRevision { break }
            }
            if self.directoryTaskID == taskID { self.directoryTask = nil }
        }
    }
    func waitForScreenPublications() async { prepareScreenPublications(); await directoryTask?.value }

    private var scheduledHomeRevision = -1
    private var homeFallbackRuntimes: Set<String> = []
    private let homeWorker = HomeCardWorker()
    private var homeTask: Task<Void, Never>?
    private var homeTaskID = UUID()
    private static let homeDomains = ["identity", "execution", "interactions"]
    var homeRuntimesLoading: Bool { if case .preparing = homePresentation { return true }; return false }
    /// 独立于已展示列表的同步进度，只用于首页的小状态行。
    var homeRuntimesUpdating: Bool {
        connection != .secured || !homeDirectoryReceived || !runtimes.allSatisfy(homeFactsComplete)
    }
    func liveActivityInventoryComplete(_ eligibleRuntimes: [RuntimeSummary]) -> Bool {
        connection == .secured && homeDirectoryReceived && eligibleRuntimes.allSatisfy(homeFactsComplete)
    }

    func replyNotificationFacts() -> ReplyNotificationCleanup.HostFacts? {
        guard connection == .secured, homeDirectoryReceived, filteredReady == nil, notificationDirectoryUpdates == 0,
              let directoryConfirmedAt = notificationDirectoryConfirmedAt else { return nil }
        var facts = ReplyNotificationCleanup.HostFacts(generation: historyGeneration, approvals: notificationOfflineRuntimes.isEmpty ? [:] : nil,
            approvalsConfirmedThrough: runtimes.isEmpty ? directoryConfirmedAt : nil)
        let completionReady = !homeRuntimesUpdating
        if completionReady {
            facts.knownCompletions = replyNotificationCompletions
            facts.localTurnStarts = replyCompletions.completedTurnStarts
        }
        for runtime in runtimes {
            let id = runtime.runtimeId
            let snapshot = agentState.snapshots[id]
            if let session = runtime.sessionId, let snapshot, snapshot.sessionId == session, snapshot.error == nil, !snapshot.truncated {
                if completionReady, !snapshot.pending.contains("execution"), snapshot.missing["execution"] == nil,
                   let execution = snapshot.domains["execution"], execution.availability == "ready", execution.completeness == "complete",
                   let turn = ReplyNotificationCleanup.Turn(runtime: id, session: session, value: execution.value["turn"]) {
                    facts.latestTurns.append(turn)
                }
                if !snapshot.pending.contains("interactions"), snapshot.missing["interactions"] == nil,
                   let approvals = snapshot.approvalInventory, let checked = approvals.confirmedAt {
                    facts.approvals?[id] = approvals.pending
                    facts.settledApprovals[id] = approvals.removed
                    facts.approvalsConfirmedThrough = min(facts.approvalsConfirmedThrough ?? checked, checked)
                    continue
                }
            }
            // One unreconciled runtime is sufficient to withhold Host-wide absence.
            facts.approvals = nil
        }
        if completionReady, historyWindowVisible, !isLaunchPage, let selected = selectedRuntime, let session = selected.sessionId,
           !session.isEmpty, runtimes.filter({ $0.sessionId == session }).count <= 1 {
            facts.viewedSessions.insert(session)
            // An offline Codex selection can carry the catalog ID rather than the
            // wire ID. Use the committed catalog alias only when it is unique.
            if selectedOfflineSession != nil {
                let live = runtimes.filter { $0.directorySessionId == session }
                if live.count == 1, let wireSession = live[0].sessionId,
                   runtimes.filter({ $0.sessionId == wireSession }).count == 1 { facts.viewedSessions.insert(wireSession) }
            }
        }
        return facts
    }

    func recheckReplyNotificationApprovals() {
        guard connection == .secured, homeDirectoryReceived, notificationDirectoryUpdates == 0 else { return }
        for runtime in runtimes { agentState.subscribe(runtime: runtime, recheck: true) }
    }

    private func rememberReplyNotificationCompletions(_ turns: [ReplyNotificationCleanup.Turn]) {
        let count = replyNotificationCompletions.count
        replyNotificationCompletions.formUnion(turns)
        guard replyNotificationCompletions.count != count else { return }
        if replyNotificationCompletions.count > 512 {
            replyNotificationCompletions = Set(replyNotificationCompletions.sorted { $0.startedAt > $1.startedAt }.prefix(512))
        }
        notificationCleanupChanged.send()
    }
    var homeCards: [HomeRuntimeCard] {
        guard case .ready(let cards) = homePresentation else { return [] }
        let closing = closingRuntimeIds
        return cards.filter { !closing.contains($0.id) }.map { card in var copy = card; copy.error = runtimeIndex[card.id]?.sessionId == card.runtime.sessionId ? objectError(card.id) : nil; return copy }
    }
    var homeRuntimes: [RuntimeSummary] { homeCards.map(\.runtime) }
    /// IMPORT-06: read the live catalog, not the selected chat or cached history.
    func externalImportRuntime(_ target: ExternalImportTarget) -> RuntimeSummary? {
        guard let host = selectedHost, target.hostId == host.hostId,
              target.pairingKey == PushNotificationIdentity.pairingKey(host) else { return nil }
        return externalImportRuntimes().first { $0.sessionId == target.sessionId && $0.cwd == target.cwd }
    }

    func externalImportDestinations() -> [ExternalImportDestination] { externalImportChoices().map(\.destination) }

    /// `current` marks this connection's open chat; the caller decides whether this Host is the foreground one.
    func externalImportChoices() -> [ExternalImportChoice] {
        guard let host = selectedHost else { return [] }
        let pairingKey = PushNotificationIdentity.pairingKey(host)
        return externalImportRuntimes().compactMap { runtime in
            guard let sessionId = runtime.sessionId else { return nil }
            return ExternalImportChoice(destination: ExternalImportDestination(target: .init(hostId: host.hostId, pairingKey: pairingKey,
                sessionId: sessionId, cwd: runtime.cwd), hostName: host.hostName,
                sessionName: directoryCatalog.titles[sessionId] ?? sessionTitle(runtime: runtime, session: sessionIndex[sessionId])),
                agentKind: agentKind(runtime), running: runtime.status == "running", current: runtime.runtimeId == selectedRuntimeId)
        }
    }

    /// True while this pairing may still publish sessions, so an empty picker is not yet final.
    var externalImportConnecting: Bool {
        connection == .connecting || connection == .online || (connection == .secured && !homeDirectoryReceived)
    }

    private func externalImportRuntimes() -> [RuntimeSummary] {
        guard connection == .secured, homeDirectoryReceived else { return [] }
        let counts = Dictionary(grouping: runtimes.compactMap(\.sessionId), by: { $0 }).mapValues(\.count)
        let closing = closingRuntimeIds, archiving = OperationKinds.archiveOverrides(ledger), enabled = enabledAgentKinds
        return runtimes.filter { runtime in
            guard enabled?.contains(agentKind(runtime) ?? "pi") != false, let id = runtime.sessionId, !id.isEmpty, counts[id] == 1, !runtime.cwd.isEmpty,
                  ["idle", "running"].contains(runtime.status), !closing.contains(runtime.runtimeId),
                  archiving[id] == nil else { return false }
            guard let session = sessionIndex[id] else { return true }
            return session.archived != true && providerMismatch(session) == nil
        }
    }
    // IMPORT-06: sending a draft must not resolve through the currently selected chat or Host.
    private var importReady = false
    private var importDeliveryActive = false
    private var importWait: (attempt: ExternalImportAttempt, target: ExternalImportTarget, query: Bool,
                             continuation: CheckedContinuation<ExternalImportReceipt, Never>, timeout: Task<Void, Never>)?

    private func importConnection(_ target: ExternalImportTarget) -> Bool {
        guard let host = selectedHost, host.hostId == target.hostId,
              PushNotificationIdentity.pairingKey(host) == target.pairingKey else { return false }
        return connection == .secured && homeDirectoryReceived && importReady && transport.allowsExternalImports
    }

    var canLaunchExternalImport: Bool {
        connection == .secured && homeDirectoryReceived && importReady && transport.allowsExternalImports && sessionConfigurationSupported
    }

    private enum ImportLaunchResult: Equatable { case ready(String), failed, unconfirmed }
    private var importLaunchWait: (launch: ExternalImportLaunch, requestId: String, query: Bool,
                                   continuation: CheckedContinuation<ImportLaunchResult, Never>, timeout: Task<Void, Never>)?

    private func matchesImportLaunch(_ launch: ExternalImportLaunch) -> Bool {
        guard let host = selectedHost else { return false }
        return host.hostId == launch.hostId && PushNotificationIdentity.pairingKey(host) == launch.pairingKey && canLaunchExternalImport
    }

    func launchExternalImport(_ batch: ExternalImportBatch, from inbox: ExternalImportStore,
                              agent: String, cwd: String, instruction: String,
                              phase: @escaping @MainActor (ExternalImportPhase) -> Void = { _ in }) async throws {
        guard !importDeliveryActive else { throw ExternalImportProblem.busy }
        guard canLaunchExternalImport, let host = selectedHost else { throw ExternalImportProblem.hostUpgrade }
        guard enabledAgentKinds?.contains(agent) != false, let config = sessionConfiguration, config.agentKind == agent, config.cwd == cwd,
              sessionConfigurationRequest == nil, sessionConfigurationError == nil,
              (launchableAgents ?? supportedAgents ?? []).contains(agent), !cwd.isEmpty else { throw ExternalImportProblem.launchConfiguration }
        importDeliveryActive = true; defer { importDeliveryActive = false }
        let launch = ExternalImportLaunch(id: "import-launch:" + UUID().uuidString, hostId: host.hostId,
            pairingKey: PushNotificationIdentity.pairingKey(host), hostName: host.hostName, agent: agent, cwd: cwd, instruction: instruction)
        let generation = connectionGeneration, history = historyGeneration, epoch = admittedModelEpoch
        let fallback = L10n.tr("请查看附件。"), prefix = L10n.tr("导入的内容：")
        try await Task.detached {
            _ = try ExternalImportStore.messageBody(text: batch.text, instruction: instruction, attachmentFallback: fallback, quotedPrefix: prefix)
            try inbox.reserveLaunch(batch.id, launch: launch)
        }.value
        guard matchesImportLaunch(launch), generation == connectionGeneration, history == historyGeneration, epoch == admittedModelEpoch,
              enabledAgentKinds?.contains(agent) != false, config == sessionConfiguration,
              sessionConfigurationRequest == nil, sessionConfigurationError == nil else {
            try await Task.detached { try inbox.failLaunch(batch.id, launchId: launch.id) }.value
            throw ExternalImportProblem.launchConfiguration
        }
        let result = await waitForExternalLaunch(launch, configuration: config)
        try await continueExternalLaunch(batch, launch: launch, result: result, inbox: inbox, phase: phase)
    }

    /// Recovery reads the original Host launch. It never sends another create, even if Host reports absence.
    func recoverExternalLaunch(_ batch: ExternalImportBatch, in inbox: ExternalImportStore,
                               phase: @escaping @MainActor (ExternalImportPhase) -> Void = { _ in }) async throws {
        guard !importDeliveryActive else { throw ExternalImportProblem.busy }
        guard batch.attempt == nil, let launch = batch.launch, !launch.failed, matchesImportLaunch(launch) else { throw ExternalImportProblem.targetUnavailable }
        importDeliveryActive = true; defer { importDeliveryActive = false }
        let result = await waitForExternalLaunch(launch, configuration: nil)
        try await continueExternalLaunch(batch, launch: launch, result: result, inbox: inbox, phase: phase)
    }

    private func continueExternalLaunch(_ batch: ExternalImportBatch, launch: ExternalImportLaunch, result: ImportLaunchResult,
                                        inbox: ExternalImportStore, phase: @escaping @MainActor (ExternalImportPhase) -> Void) async throws {
        if result == .failed { try await Task.detached { try inbox.failLaunch(batch.id, launchId: launch.id) }.value; return }
        guard case .ready(let sessionId) = result, matchesImportLaunch(launch) else { return }
        let target = ExternalImportTarget(hostId: launch.hostId, pairingKey: launch.pairingKey, sessionId: sessionId, cwd: launch.cwd)
        let bound = try await Task.detached {
            try inbox.bindLaunch(batch.id, launch: launch, destination: .init(target: target, hostName: launch.hostName,
                sessionName: directoryTitle(launch.cwd)))
        }.value
        // Ready confirms configuration separately from the live runtime directory.
        for _ in 0..<50 {
            guard matchesImportLaunch(launch) else { return }
            if let runtime = externalImportRuntime(target), agentKind(runtime) == launch.agent {
                try await deliverExternalBatch(bound, from: inbox, instruction: launch.instruction, phase: phase)
                return
            }
            try await Task.sleep(for: .milliseconds(100))
        }
        throw ExternalImportProblem.targetUnavailable
    }

    private func waitForExternalLaunch(_ launch: ExternalImportLaunch, configuration: SessionConfigurationSnapshot?) async -> ImportLaunchResult {
        await withCheckedContinuation { continuation in
            let query = configuration == nil, requestId = "import-launch:" + UUID().uuidString
            let timeout = Task { [weak self] in
                do { try await Task.sleep(for: .seconds(query ? 20 : 90)) } catch { return }
                guard self?.importLaunchWait?.requestId == requestId else { return }
                self?.finishExternalLaunch(.unconfirmed)
            }
            importLaunchWait = (launch, requestId, query, continuation, timeout)
            var wire: [String: Any] = ["type": query ? "session.launch.read" : "session.launch", "protocolVersion": orbisProtocolVersion,
                                       "requestId": requestId, "launchId": launch.id]
            if let configuration {
                wire["agentKind"] = launch.agent; wire["cwd"] = launch.cwd; wire["binding"] = configuration.binding
                wire["revision"] = configuration.revision; wire["values"] = configuration.values.payload; wire["spawnMode"] = defaultSessionSpawnMode
            }
            if !transport.send(wire) { finishExternalLaunch(.unconfirmed) }
        }
    }

    private func finishExternalLaunch(_ result: ImportLaunchResult) {
        guard let wait = importLaunchWait else { return }
        importLaunchWait = nil; wait.timeout.cancel(); wait.continuation.resume(returning: result)
    }

    private func consumeExternalLaunch(_ message: [String: Any], type: String) -> Bool {
        guard type == "session.launch.result" || type == "protocol.error",
              let request = message["requestId"] as? String, request.hasPrefix("import-launch:") else { return false }
        guard let wait = importLaunchWait, wait.requestId == request else { return true }
        if type == "protocol.error" { finishExternalLaunch(.unconfirmed); return true }
        guard message["launchId"] as? String == wait.launch.id else { return true }
        switch message["phase"] as? String {
        case "ready":
            if message["agentKind"] as? String == wait.launch.agent, message["cwd"] as? String == wait.launch.cwd,
               let sessionId = message["sessionId"] as? String, !sessionId.isEmpty {
                finishExternalLaunch(.ready(sessionId))
            } else { finishExternalLaunch(.unconfirmed) }
        case "failed": finishExternalLaunch(message["sessionId"] == nil ? .failed : .unconfirmed)
        case "unknown", "absent": finishExternalLaunch(.unconfirmed)
        default: if wait.query { finishExternalLaunch(.unconfirmed) }
        }
        return true
    }

    func sendExternalImport(_ batch: ExternalImportBatch, from inbox: ExternalImportStore, instruction: String,
                            phase: @escaping @MainActor (ExternalImportPhase) -> Void = { _ in }) async throws {
        guard !importDeliveryActive else { throw ExternalImportProblem.busy }
        importDeliveryActive = true; defer { importDeliveryActive = false }
        try await deliverExternalBatch(batch, from: inbox, instruction: instruction, phase: phase)
    }

    private func deliverExternalBatch(_ batch: ExternalImportBatch, from inbox: ExternalImportStore, instruction: String,
                                      phase: @escaping @MainActor (ExternalImportPhase) -> Void) async throws {
        guard let target = batch.destination?.target, let runtime = externalImportRuntime(target) else { throw ExternalImportProblem.targetUnavailable }
        guard importConnection(target) else { throw ExternalImportProblem.hostUpgrade }
        let generation = connectionGeneration, history = historyGeneration, epoch = admittedModelEpoch
        let runtimeId = runtime.runtimeId, ownership = runtimeOwnership[runtimeId]
        func current() -> Bool {
            !Task.isCancelled && connectionGeneration == generation && historyGeneration == history && admittedModelEpoch == epoch &&
                runtimeOwnership[runtimeId] == ownership && importConnection(target) && externalImportRuntime(target)?.runtimeId == runtimeId
        }
        let sources = try await Task.detached { try inbox.uploadSources(batch.id, target: target) }.value
        let fallback = L10n.tr("请查看附件。"), prefix = L10n.tr("导入的内容：")
        let body = try await Task.detached {
            try ExternalImportStore.messageBody(text: batch.text, instruction: instruction, attachmentFallback: fallback, quotedPrefix: prefix)
        }.value
        var paths: [String] = []
        for (index, (source, file)) in sources.enumerated() {
            phase(.uploading(index + 1, sources.count))
            paths.append(try await transfers.uploadImport(source, file: file, target: target, runtimeId: runtimeId, ifReady: current))
        }
        phase(.sending)
        guard current() else { throw ExternalImportProblem.targetUnavailable }
        let attempt = ExternalImportAttempt(id: UUID(), runtimeId: runtimeId, receipt: .pending, instruction: instruction)
        try await Task.detached { try inbox.beginDelivery(batch.id, target: target, attempt: attempt) }.value
        let receipt: ExternalImportReceipt
        if current(), let runtime = externalImportRuntime(target) {
            let id = attempt.id.uuidString
            var command: [String: Any] = ["type": "user_message", "text": body, "messageId": id]
            if runtime.status == "running" { command["delivery"] = "followUp" }
            if !paths.isEmpty { command["attachments"] = paths }
            receipt = await waitForImport(attempt, target: target, query: false, command: command)
        } else { receipt = .failed }
        try await Task.detached { try inbox.recordDelivery(batch.id, attempt: attempt.id, receipt: receipt) }.value
    }

    func checkExternalImport(_ batch: ExternalImportBatch, in inbox: ExternalImportStore) async throws {
        guard !importDeliveryActive else { throw ExternalImportProblem.busy }
        guard let target = batch.destination?.target, let attempt = batch.attempt,
              attempt.receipt != .accepted, attempt.receipt != .failed else { return }
        guard importConnection(target) else { throw ExternalImportProblem.targetUnavailable }
        importDeliveryActive = true; defer { importDeliveryActive = false }
        let receipt = await waitForImport(attempt, target: target, query: true)
        try await Task.detached { try inbox.recordDelivery(batch.id, attempt: attempt.id, receipt: receipt) }.value
    }

    private func waitForImport(_ attempt: ExternalImportAttempt, target: ExternalImportTarget, query: Bool,
                               command: [String: Any]? = nil) async -> ExternalImportReceipt {
        guard importConnection(target) else { return query ? .unconfirmed : .failed }
        return await withCheckedContinuation { completion in
            let id = attempt.id.uuidString
            let timeout = Task { [weak self] in
                do { try await Task.sleep(for: .seconds(query ? 10 : 65)) } catch { return }
                guard self?.importWait?.attempt.id == attempt.id else { return }
                self?.finishExternalImport(.unconfirmed)
            }
            importWait = (attempt, target, query, completion, timeout)
            var wire: [String: Any] = ["type": query ? "external-import.result.read" : "runtime.command",
                "protocolVersion": orbisProtocolVersion, "runtimeId": attempt.runtimeId, "commandId": id,
                "importTarget": ["sessionId": target.sessionId, "cwd": target.cwd]]
            if let command { wire["command"] = command }
            if !transport.send(wire) { finishExternalImport(query ? .unconfirmed : .failed) }
        }
    }

    private func finishExternalImport(_ result: ExternalImportReceipt) {
        guard let wait = importWait else { return }
        importWait = nil; wait.timeout.cancel(); wait.continuation.resume(returning: result)
    }

    private func consumeExternalImport(_ message: [String: Any], type: String) -> Bool {
        if type == "external-import.result" {
            if let wait = importWait, wait.query, message["commandId"] as? String == wait.attempt.id.uuidString,
               message["runtimeId"] as? String == wait.attempt.runtimeId, let target = message["importTarget"] as? [String: String],
               target["sessionId"] == wait.target.sessionId, target["cwd"] == wait.target.cwd,
               let status = (message["status"] as? String).flatMap(ExternalImportReceipt.init(rawValue:)) {
                finishExternalImport(status)
            }
            return true
        }
        guard let wait = importWait else { return false }
        if type == "protocol.error", message["commandId"] as? String == wait.attempt.id.uuidString {
            let definite = ["import_target_changed", "import_attachments_unverified", "runtime_offline", "unsupported_command", "provider_switching", "host_busy", "invalid_command"]
            finishExternalImport(!wait.query && definite.contains(message["code"] as? String ?? "") ? .failed : .unconfirmed)
            return true
        }
        if type == "runtime.event", !wait.query, message["runtimeId"] as? String == wait.attempt.runtimeId,
           let event = message["event"] as? [String: Any], event["commandId"] as? String == wait.attempt.id.uuidString {
            switch event["type"] as? String {
            case "command.result":
                switch event["status"] as? String {
                case "pending": break
                case "failure": finishExternalImport(.failed)
                case "success", nil: finishExternalImport(event["ok"] as? Bool == true ? .accepted : .failed)
                default: finishExternalImport(.unconfirmed)
                }
                return true
            case "runtime.error": finishExternalImport(.unconfirmed); return true
            default: break
            }
        }
        return false
    }

    private var homeActionsRevision = -1
    private var selectableHomeIds: Set<String> = []
    private var closableHomeIds: Set<String> = []
    var homeSelectableRuntimeIds: Set<String> { prepareHomeActions(); return selectableHomeIds }
    var homeClosableRuntimeIds: Set<String> { prepareHomeActions(); return closableHomeIds }
    private func prepareHomeActions() {
        guard homeActionsRevision != homeViewRevision else { return }
        homeActionsRevision = homeViewRevision
        let cards = homeCards
        selectableHomeIds = Set(cards.filter(homeCardIsCurrent).map(\.id))
        closableHomeIds = Set(cards.filter { canCloseRuntime($0.id) }.map(\.id))
    }


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
        guard scheduledHomeRevision != homeInputRevision else { return }
        scheduledHomeRevision = homeInputRevision
        guard homeTask == nil else { return }
        let taskID = UUID(); homeTaskID = taskID
        homeTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                self.prepareHomeSync()
                guard self.preparedHomeSync == .idle else { break }
                let revision = self.homeInputRevision, host = self.selectedHostId
                let next = await self.homeWorker.resolve(runtimes: self.runtimes, sessions: self.sessionIndex,
                    messages: self.conversations, pending: self.interactions)
                guard !Task.isCancelled, host == self.selectedHostId, self.connection == .secured else { break }
                guard revision == self.homeInputRevision else { continue }
                self.homeFallbackRuntimes = next.fallback
                let presentation = HomePresentation.ready(next.cards)
                if self.homePresentation != presentation { self.homePresentation = presentation }
                break
            }
            if self.homeTaskID == taskID { self.homeTask = nil }
        }
    }

    func homeCardIsCurrent(_ card: HomeRuntimeCard) -> Bool {
        guard connection == .secured, card.runtime.sessionId != nil, let current = runtimeIndex[card.id] else { return false }
        return current.sessionId == card.runtime.sessionId && current.agentKind == card.runtime.agentKind
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
    @Published private(set) var currentProviders: [String: String] = [:] { didSet { directoryViewRevision &+= 1 } }
    /// 仅供「原始事件」页查看；每收到一帧都会追加，不发布变更，免得每帧都让整棵视图树重绘。
    private(set) var connectionEvents: [String] = []

    private var agentStateObservation: AnyCancellable?
    private let secure: SecureStorage
    private let transport: OrbisTransport
    var relayTransportKind: RelayTransportKind? { transport.relayTransportKind }
    var relayTransportMode: RelayTransportMode { transport.relayTransportMode }
    func setRelayTransportMode(_ mode: RelayTransportMode) {
        transport.setRelayTransportMode(mode)
        objectWillChange.send()
    }
    private let deviceName: String
    private let preferences: UserDefaults?
    private let downloadBrowserPaths: DownloadBrowserPathStore
    let historyWorker: SessionHistoryWorker
    @Published private(set) var cachedSessionIds: Set<String> = []
    @Published private(set) var selectedOfflineSession: SessionSummary? { didSet { notificationCleanupChanged.send() } }
    @Published private(set) var cachedHistoryOptions: [RuntimeOption] = []
    @Published private(set) var turnTimings: [String: SessionTurnTiming] = [:] { didSet { scheduleTranscript() } }
    @Published private(set) var chatTranscript = ChatTranscript.empty
    private let transcriptWorker = ChatTranscriptWorker()
    private var transcriptTask: Task<Void, Never>?
    private var transcriptTaskID = UUID()
    private var transcriptRevision = 0
    private var transcriptIdentity: String?
    private var renderedTranscriptIdentity: String?
    private var transcriptInput: ChatPublicationInput?
    private var committingTranscript = false
    private var visibleMessageIds: Set<String> = []
    private var cachedPublications: [String: ChatPublication] = [:]
    private var renderedMessageToken: UUID?

    private var currentTranscriptIdentity: String {
        "\(selectedHostId ?? "")|\(selectedRuntimeId ?? "")|\(selectedRuntime?.sessionId ?? "")|\(selectedRuntimeId.flatMap { branchGenerations[$0] } ?? 0)"
    }

    private func scheduleTranscript(_ input: ChatPublicationInput? = nil) {
        guard !committingTranscript else { return }
        transcriptInput = input ?? ChatPublicationInput(messages: messages, timings: turnTimings)
        transcriptRevision += 1
        let identity = currentTranscriptIdentity
        transcriptIdentity = identity
        if renderedTranscriptIdentity != identity || messages.isEmpty { chatTranscript = .empty }
        guard transcriptTask == nil else { return }
        let taskID = UUID(); transcriptTaskID = taskID
        transcriptTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                let revision = self.transcriptRevision
                let owner = self.transcriptIdentity ?? ""
                guard let input = self.transcriptInput else { break }
                let next = await self.transcriptWorker.publish(identity: owner, input: input)
                guard !Task.isCancelled else { break }
                let pendingIds = self.pendingSends.chatRows(sessionId: self.selectedRuntime?.sessionId, runtimeId: self.selectedRuntime?.runtimeId).map(\.messageId)
                if owner == self.transcriptIdentity && (!input.requiresPendingMatch || input.pending.map(\.messageId) == pendingIds) {
                    let trace = ChatSchedulingTrace.transcriptCommitBegan()
                    defer { ChatSchedulingTrace.transcriptCommitEnded(trace) }
                    self.committingTranscript = true
                    if self.renderedMessageToken != next.messageToken { self.messages = next.messages }
                    self.renderedMessageToken = next.messageToken
                    if self.streamingMessageIds != next.streaming { self.streamingMessageIds = next.streaming }
                    if self.chatTranscript.contentRevision != next.transcript.contentRevision { self.chatTranscript = next.transcript }
                    self.visibleMessageIds = next.messageIds
                    self.cachedPublications[owner] = next
                    while self.cachedPublications.count > 4, let old = self.cachedPublications.keys.first(where: { $0 != owner }) {
                        self.cachedPublications[old] = nil
                    }
                    self.committingTranscript = false
                    self.renderedTranscriptIdentity = owner
                    if self.connection == .secured, let runtime = self.selectedRuntime, let session = runtime.sessionId,
                       let host = self.selectedHost, let kind = self.agentKind(runtime), !isKimiCode(kind: kind, id: runtime.runtimeId) {
                        self.turnFileChanges.observe(runtimeId: runtime.runtimeId,
                            agent: ToolAgent(hostId: host.hostId, agentKind: kind, sessionId: session),
                            entryIds: next.changeEntries, turnIds: next.changeTurns)
                    }
                }
                // A rejected snapshot cannot become valid by rebuilding the same input.
                // Drain only when a new request arrived while the worker was suspended.
                if revision == self.transcriptRevision { break }
            }
            if self.transcriptTaskID == taskID { self.transcriptTask = nil }
        }
    }
    private var timingsBySession: [String: [String: SessionTurnTiming]] = [:] { didSet { projectionInputRevision &+= 1 } }
    private var cachedIndexLoaded = false
    private var pendingEvents: [(message: [String: Any], channel: String?, bytes: Int, payload: Data?, ownership: UUID?)] = []
    private var pendingEventBytes = 0
    private var eventTask: Task<Void, Never>?
    private var backgroundTasks: [UUID: Task<Void, Never>] = [:]
    private var cacheLoading: [String: String] = [:]
    private(set) var sessionReads = SessionReadOperations()
    private var syncReads: [String: String] = [:]
    private var automaticHistoryProgress: [String: SessionHistoryPrefetch] = [:]
    private var historyWindowRequestId: String?
    private var historyWindowSupported = false
    private var historyWindowVisible = false
    private var historyInterest = HistoryWindowInterest()
    private var historyReconcileSchedules: [String: ReadReconcileSchedule] = [:]
    private var pendingReadPages: [String: SessionHistoryPage] = [:]
    private var pendingCatchups: [String: SessionCatchupGap] = [:]
    private var branchGenerations: [String: Int] = [:]
    private var historyWriteLeases: [String: SessionHistoryWriteLease] = [:]
    private var cleanupTask: Task<Void, Never>?
    private var graphs: [String: CachedSessionGraph] = [:] { didSet { projectionInputRevision &+= 1 } }
    private var excludedDisplayEntries: [String: Set<String>] = [:]
    private var appliedBaselines: [String: SessionAppliedBaseline] = [:]
    private var retiredEpochs: [String: Set<String>] = [:]
    private var syncDemands: Set<String> = []
    private var lastOverflowRecovery: Date?
    private var browseTimeout: Task<Void, Never>?
    private var activationTimeout: Task<Void, Never>?
    private var activationRequestId: String?
    private var runtimeActions: [String: (runtimeId: String, name: String, sessionId: String?)] = [:]
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
    private var runtimeCloseNegotiated = false { didSet { if oldValue != runtimeCloseNegotiated { homeViewRevision &+= 1 } } }
    private var historyGeneration = UUID()
    private var historyConnected = false
    private var projectionInputRevision = 0
    private let sessionProjectionWorker = SessionChatProjectionWorker()
    private var conversations: [String: [ChatMessage]] = [:] {
        didSet {
            projectionInputRevision &+= 1
            directoryInputRevision &+= 1
            if !homeFallbackRuntimes.isEmpty { homeInputRevision &+= 1 }
        }
    }
    private var liveMessageIds: [String: Set<String>] = [:]
    private var unfinishedLiveMessageIds: [String: Set<String>] = [:]
    @Published private(set) var streamingMessageIds: Set<String> = []
    // 宿主会从 live.messages 里去掉只含工具调用的消息，改由工具清单承载；这里记录还原它们所需的顺序和清单版本。
    private var liveOrders: [String: [String: Int64]] = [:]
    private var liveToolReferences: [String: ToolReference] = [:]
    private var liveTools: [String: [ToolSummary]] = [:]
    private var displayMessageIds: [String: [String: String]] = [:] {
        didSet {
            projectionInputRevision &+= 1
            chatRewindRevision &+= 1
        }
    }
    // 运行时临时 id → 持久化 entry id（turn.finished.persistedMessages / live.persistedEntryId）。
    // Codex 用 App 的 clientId、Pi 用流式 id 上屏，落盘后 entry 才是权威行；靠这张映射退掉临时行，绝不按文本猜。
    private var messageAliases: [String: [String: String]] = [:] { didSet { projectionInputRevision &+= 1 } }
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
    private var menuOptions = MenuOptionsLoader()
    private var sharedSessionContent = SharedSessionContentWorker()
    private var menuOptionsTimeout: Task<Void, Never>?

    func loadMenuOptions(runtimeId: String, name: String) {
        guard let command = commands[runtimeId]?.first(where: { $0.name == name }) else { return }
        if let request = menuOptions.start(runtimeId: runtimeId, command: command) { menuErrors[runtimeId + "\u{0}" + name] = nil; sendMenuOptionRequest(request) }
    }

    func cancelMenuOptions(runtimeId: String, name: String) { menuOptions.cancel(runtimeId: runtimeId, name: name) }

    private func sendMenuOptionRequest(_ request: [String: Any]) {
        guard let id = request["requestId"] as? String else { return }
        menuOptionsTimeout?.cancel()
        guard transport.send(request) else {
            if let failed = menuOptions.fail(id) { menuErrors[failed.runtimeId + "\u{0}" + failed.name] = L10n.tr("命令选项读取失败，请重新打开菜单") }; return
        }
        menuOptionsTimeout = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 12_000_000_000) } catch { return }
            if let self, let failed = self.menuOptions.fail(id) { self.menuErrors[failed.runtimeId + "\u{0}" + failed.name] = L10n.tr("命令选项读取失败，请重新打开菜单") }
        }
    }
    var didUpdatePairing: ((HostPairing) -> Void)?
    private var modelCatalogReceived = false
    /// ADR-0076: the filtered `device.ready` this App answered with `device.features`; the full one replaces it.
    private var filteredReady: (id: UUID, message: [String: Any], channel: String?)?
    private var expectedMessageDisplayVersion: Int?

    init(secure: SecureStorage = SecureStore.shared, transport: OrbisTransport? = nil, deviceName: String? = nil, autoConnect: Bool = true, preferences: UserDefaults? = .standard, transferRoot: URL? = nil, initialPairing: HostPairing? = nil, isolated: Bool = false, historyWorker: SessionHistoryWorker? = nil, localStores: HostLocalStores? = nil) {
        self.secure = secure
        self.localStores = localStores ?? HostLocalStores()
        self.transport = transport ?? RelayTransport()
        self.preferences = preferences
        downloadBrowserPaths = DownloadBrowserPathStore(preferences: preferences)
        replyCompletions = ReplyCompletionTracker(preferences: preferences, owner: initialPairing.map(FileTransfers.pairingKey) ?? "unpaired")
        let root = transferRoot ?? (preferences == nil ? FileManager.default.temporaryDirectory.appendingPathComponent("orbis-preview-" + UUID().uuidString) :
            FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("Orbis"))
        launchJournalRoot = root.appendingPathComponent("ConfiguredLaunches", isDirectory: true)
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
        catch { recordConnectionEvent(String(describing: error)); connectionFeedback(.pairing) }
        transfers.send = { [weak self] in self?.transport.send($0) ?? false }
        transfers.browserPreview.send = { [weak self] in self?.transport.sendFilePreviewControl($0) ?? false }
        transfers.canUploadImport = { [weak self] target, runtimeId in
            guard let self else { return false }
            return self.importConnection(target) && self.externalImportRuntime(target)?.runtimeId == runtimeId
        }
        hostState.send = { [weak self] in self?.transport.send($0) ?? false }
        agentState.send = { [weak self] in self?.transport.send($0) ?? false }
        agentStateObservation = agentState.objectWillChange.sink { [weak self] _ in
            self?.markHomeMetadataChanged()
            self?.notificationCleanupChanged.send()
            self?.objectWillChange.send()
        }
        notifications.send = { [weak self] in self?.transport.send($0) ?? false }
        agentState.didProject = { [weak self] runtimeId, sessionId, domains in
            guard let self, let index = self.runtimes.firstIndex(where: { $0.runtimeId == runtimeId && $0.sessionId == sessionId }),
                  let hostId = self.selectedHostId,
                  let projection = AgentProjection.make(runtime: self.runtimes[index], hostId: hostId, domains: domains,
                    commands: self.commands[runtimeId] ?? [], interactions: self.interactions[runtimeId] ?? [], queuedMessages: self.queuedMessages[runtimeId] ?? []) else { return false }
            self.runtimes[index] = projection.runtime
            if let execution = domains["execution"], execution.availability == "ready", execution.completeness == "complete",
               execution.value["turn"]["outcome"].string == "completed",
               let turn = ReplyNotificationCleanup.Turn(runtime: runtimeId, session: sessionId, value: execution.value["turn"]) {
                self.rememberReplyNotificationCompletions([turn])
            }
            if domains["identity"]?.availability == "ready" { self.persistIdentity(projection.runtime) }
            self.commands[runtimeId] = projection.commands
            self.replaceInteractions(runtimeId, with: projection.interactions)
            self.queuedMessages[runtimeId] = projection.queuedMessages
            if domains["delivery"] != nil { self.ledgerAuthority(OperationKinds.queueDomain(runtimeId), read: nil, complete: true) }
            if domains["interactions"] != nil { self.ledgerAuthority(OperationKinds.interactionsDomain(runtimeId), read: nil, complete: true) }
            if domains["model"] != nil { self.ledgerAuthority(OperationKinds.modelDomain(runtimeId), read: nil, complete: true) }
            self.updateSyncing()
            return true
        }
        agentState.didCommitIdentity = { [weak self] runtimeId in
            self?.reconcileIdentityLaunch(runtimeId: runtimeId)
        }
        hostState.didProject = { [weak self] domains, missing in
            guard let self else { return }
            if domains["providers"] != nil { self.directoryViewRevision &+= 1; self.objectWillChange.send() }
            if let backends = domains["backends"] {
                self.openClawBackendAdvice = backends.availability == "ready" ? FeedbackText.openClawBackendAdvice(backends.value["backends"]) : nil
            } else if missing.contains("backends") {
                self.openClawBackendAdvice = nil
            }
            if let backends = domains["backends"], backends.availability == "ready" {
                // A missing list means unknown (no restriction), the same as Android; never "nothing can start".
                self.supportedAgents = backends.value["agents"].isArray ? backends.value["agents"].array.compactMap(\.string) : nil
                self.launchableAgents = backends.value["launchableAgents"].isArray ? backends.value["launchableAgents"].array.compactMap(\.string) : nil
                self.openCodeAvailability = OpenCodeAvailability(backends: backends.value["backends"])
                self.codexDesktop = backends.value["codexDesktop"].decoded(CodexDesktopAttach.self).flatMap { $0.valid ? $0 : nil }
            }
        }
        hostState.didChangeCatalog = { [weak self] incoming, completeKinds in
            guard let self else { return }
            self.modelCatalogReceived = true
            let generation = self.connectionGeneration
            await self.queueSessionCatalog(incoming, completeKinds: completeKinds).value
            guard !Task.isCancelled, generation == self.connectionGeneration else { return }
            // ADR-0049 §7.5：完整目录是归档的权威状态。
            self.ledgerAuthority(OperationKinds.catalogDomain, read: nil, complete: true)
        }
        hostState.didChangeCatalogQuery = { [weak self] in
            self?.directoryViewRevision &+= 1; self?.objectWillChange.send()
        }
        hostState.didChangeProviders = { [weak self] in self?.refreshSessions() }
        transfers.sendBinary = { [weak self] in self?.transport.sendBinary($0) ?? false }
        transfers.didFailTask = { [weak self] task in
            guard let self else { return }
            let visible = task.direction == "download" ? self.feedbackDownloadsVisible :
                self.feedbackChatVisible && task.runtimeId == self.selectedRuntimeId && task.sessionId == self.selectedRuntime?.sessionId
            guard !visible else { return }
            let round = self.failedTransferRounds[task.id, default: 0] + 1
            self.failedTransferRounds[task.id] = round
            self.presentFeedback(.toast, L10n.tr(task.direction == "download" ? "下载未完成，请在下载中重试" : "上传未完成，附件已保留"), key: "transfer:" + task.id + ":" + String(round))
        }
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
                    self.startAutomaticHistoryPrefetch(summary)
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
            if !ids.isEmpty { self.recordConnectionEvent("history.failed: " + message); self.historyErrors[runtime] = FeedbackText.reason(message); self.updateSyncing(); self.dispatchSyncDemands() }
        }
        // Bind the source before a cached/offline page can acquire its lease.
        // A later first connection then preserves that mounted page's ownership.
        agentState.setConnection(selectedHost, connected: false)
        if autoConnect, let selectedHostId { connect(hostId: selectedHostId) }
    }

    var selectedHost: HostPairing? { pairings.first { $0.hostId == selectedHostId } }
    var selectedRuntime: RuntimeSummary? {
        if let launch = launching, selectedRuntimeId == launch.placeholder || launch.resumed != nil && selectedOfflineSession?.sessionId == launch.resumed {
            let session = selectedOfflineSession
            return RuntimeSummary(runtimeId: session.map { "cached:" + $0.sessionId } ?? launch.placeholder, name: session?.name ?? launch.title,
                cwd: session?.cwd ?? launch.cwd, status: launch.unconfirmed ? "launch_unconfirmed" : launch.failure != nil ? "error" : "starting",
                // 标题用启动目标的名称；sessionName 为空时 sessionTitle 会退回到占位 id。
                sessionId: session?.sessionId ?? launch.resumed ?? launch.placeholder, sessionName: session?.name ?? launch.title,
                hostname: session?.hostname, agentKind: session?.agentKind ?? launch.agentKind,
                codexCatalogId: session?.sessionId.hasPrefix("codex-history:") == true ? session?.sessionId : nil)
        }
        if let session = selectedOfflineSession {
            return RuntimeSummary(runtimeId: "cached:" + session.sessionId, name: session.name ?? session.sessionId,
                cwd: session.cwd, status: "offline", sessionId: session.sessionId, sessionName: session.name,
                hostname: session.hostname, agentKind: session.agentKind,
                codexCatalogId: session.sessionId.hasPrefix("codex-history:") ? session.sessionId : nil)
        }
        return runtimes.first { $0.runtimeId == selectedRuntimeId }
    }
    var canSend: Bool {
        // ADR-0049 §6.8：启动中可以输入草稿和发送，消息等会话上线后再提交。
        connection == .secured && selectedRuntime != nil && (selectedOfflineSession == nil || isLaunchPage)
            && (!isLaunchPage || (launching?.failure == nil && launching?.endingWait != true))
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
        sessionTitle(runtime: runtime, session: runtime.directorySessionId.flatMap { sessionIndex[$0] },
                     messages: conversations[runtime.runtimeId] ?? [])
    }

    func displayName(_ session: SessionSummary) -> String {
        if let runtime = runtimes.first(where: { $0.directorySessionId == session.sessionId }) { return displayName(runtime) }
        return sessionTitle(runtime: nil, session: session)
    }
    func draft(for runtime: RuntimeSummary) -> String { drafts[localSessionKey(host: selectedHost, runtime: runtime)] ?? "" }
    /// A keystroke the composer already shows. Marked IME text stays in memory until
    /// the editor reports a committed value, avoiding a UserDefaults write for every
    /// composition update.
    func editDraft(_ text: String, for runtime: RuntimeSummary, persist: Bool = true) {
        if composerErrors[runtime.runtimeId] != nil { composerErrors[runtime.runtimeId] = nil }
        if objectError(runtime.runtimeId, includeCardOnly: false) != nil { objectErrors[runtime.runtimeId] = nil }
        transfers.clearUploadError(for: runtime)
        let key = localSessionKey(host: selectedHost, runtime: runtime)
        updateDrafts(reload: false, persist: persist) { $0[key] = text.isEmpty ? nil : text }
    }
    /// A draft the visible composer has not seen yet.
    func saveDraft(_ text: String, for runtime: RuntimeSummary) {
        let key = localSessionKey(host: selectedHost, runtime: runtime)
        updateDrafts(reload: true) { $0[key] = text.isEmpty ? nil : text }
    }
    /// Every Host connection shares one preferences entry, so a write merges into what is stored now.
    private func updateDrafts(reload: Bool, persist: Bool = true, _ change: (inout [String: String]) -> Void) {
        var next = persist
            ? (preferences?.dictionary(forKey: "orbis.sessionDrafts") as? [String: String] ?? drafts)
            : drafts
        change(&next)
        let changed = next != drafts
        drafts = next
        if persist, changed { preferences?.set(next, forKey: "orbis.sessionDrafts") }
        if reload { draftRevision &+= 1 }
    }

    func purgeLocalData() {
        guard let hostId = selectedHostId else { return }
        if let host = pairings.first(where: { $0.hostId == hostId }) {
            transfers.removeAll(for: host)
            let prefix = hostKeyPrefix(host)
            if let data = preferences?.data(forKey: "orbis.interactionDrafts.v1"),
               let stored = try? JSONDecoder().decode([String: InteractionDraftValue].self, from: data),
               let filtered = try? JSONEncoder().encode(stored.filter { !$0.key.hasPrefix(prefix) }) {
                preferences?.set(filtered, forKey: "orbis.interactionDrafts.v1")
            }
            localStores.saveCatalog(nil, key: sessionCacheKey(host), preferences: preferences)
            preferences?.removeObject(forKey: lastSessionKey(host))
            downloadBrowserPaths.remove(hostId: hostId)
            historyWorker.invalidate(host: host)
            cleanupTask = Task { [historyWorker] in try? await historyWorker.remove(host: host) }
            updateDrafts(reload: true) { drafts in drafts = drafts.filter { !$0.key.hasPrefix(prefix) } }
        }
        pairings = []
        guard selectedHostId == hostId else { return }
        importReady = false; finishExternalImport(.unconfirmed); finishExternalLaunch(.unconfirmed)
        connectionGeneration = UUID(); runtimeCloseNegotiated = false; filteredReady = nil; resetAgentEnablement()
        inboundTask?.cancel(); inboundTask = nil; incomingMessages = []; incomingBytes = 0
        admittedRuntimeSessions = [:]; admittedModelEpoch = nil; runtimeOwnership = [:]
        cancelPendingWork()
        if let host = selectedHost { historyWorker.invalidate(host: host) }
        transport.disconnect()
        clearSyncs(); dismissBrowse(); clearActivation()
        conversations = [:]; messages = []; runtimes = []; sessions = []; sessionIndex = [:]; commands = [:]
        loadedSessionCacheKey = nil
        homeDirectoryReceived = false; homePresentation = .preparing
        selectedRuntimeId = nil; selectedHostId = nil; activePath = nil; pathRTT = nil; connection = .offline
        currentProviders = [:]; sessionListRequest = nil; modelCatalogReceived = false; authenticatedModelEpoch = nil; connectionEvents = []
        transfers.setConnection(nil, connected: false)
        hostState.setConnection(nil, connected: false)
        agentState.setConnection(nil, connected: false)
        notifications.setConnection(nil, connected: false)
        toolContent.close(); turnFileChanges.clear(); toolInventories.clear(); toolAcknowledgements = [:]; pendingAppliedBaselines = [:]
        interactions = [:]; interactionErrors = [:]; queuedMessages = [:]; interactionOutcomes = [:]; workingBranches = [:]; dismissPreview()
        pendingSends.removeAll(); pendingSendHostId = nil; sessionRevisions = [:]
    }

    func shutdown() {
        clearFeedbackScope()
        importReady = false; finishExternalImport(.unconfirmed); finishExternalLaunch(.unconfirmed)
        connectionGeneration = UUID(); runtimeCloseNegotiated = false; filteredReady = nil; resetAgentEnablement()
        inboundTask?.cancel(); inboundTask = nil; incomingMessages = []; incomingBytes = 0
        admittedRuntimeSessions = [:]; admittedModelEpoch = nil; runtimeOwnership = [:]
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
        notificationConnectionStartedAt = Date(); notificationDirectoryConfirmedAt = nil
        notificationDirectoryUpdates = 0; notificationOfflineRuntimes = []
        defaultSessionSpawnMode = "tui"
        importReady = false; finishExternalImport(.unconfirmed); finishExternalLaunch(.unconfirmed)
        connectionGeneration = UUID(); runtimeCloseNegotiated = false; filteredReady = nil; resetAgentEnablement()
        inboundTask?.cancel(); inboundTask = nil; incomingMessages = []; incomingBytes = 0
        admittedRuntimeSessions = [:]; admittedModelEpoch = nil; runtimeOwnership = [:]
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
            launching = nil; backgroundLaunches = [:]; draftReturnLaunchId = nil
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
        runtimes = []; messages = []; selectedRuntimeId = nil; selectedOfflineSession = nil
        // Reconnect keeps the already prepared catalog visible. Cold hydration is
        // queued ahead of remote updates and never performs disk work on MainActor.
        if loadedSessionCacheKey != sessionCacheKey(pairing) {
            sessions = []; sessionIndex = [:]
            _ = queueSessionCatalog([], loadKey: sessionCacheKey(pairing))
        }
        cachedSessionIds = []; cachedIndexLoaded = false; cachedHistoryOptions = []; turnTimings = [:]; timingsBySession = [:]
        loadCachedIndex(pairing)
        conversations = [:]; liveMessageIds = [:]; unfinishedLiveMessageIds = [:]; streamingMessageIds = []; displayMessageIds = [:]; messageAliases = [:]; excludedDisplayEntries = [:]
        liveOrders = [:]; liveToolReferences = [:]; liveTools = [:]
        oldestEntries = [:]; sessionLeaves = [:]; hasOlderHistory = [:]; historyErrors = [:]; historyLoading = []
        sharedSessionContent = SharedSessionContentWorker()
        sourcePositions = [:]; appliedBaselines = [:]; retiredEpochs = [:]; graphs = [:]; runtimeEventSequences = [:]
        pendingActivation = nil; activePath = nil
        interactions = [:]; interactionErrors = [:]; queuedMessages = [:]; interactionOutcomes = [:]
        workingBranches = [:]; dismissPreview()
        actionTimeouts.values.forEach { $0.cancel() }; actionTimeouts = [:]; runtimeActions = [:]; composerActionDrafts = [:]; pendingActionIds = []; setActionFeedback(nil)
        pathRTT = nil; commands = [:]; supportedAgents = nil; launchableAgents = nil; codexDesktop = nil; kimiCodeSupported = false; kimiCodeDesktopSupported = false; openCodeAvailability = nil; openClawBackendAdvice = nil
        dismissBrowse(); clearActivation()
        clearSyncs()
        transport.connect(pairing: pairing, identity: identity, receive: { [weak self] message, channel in
            guard let self, self.connectionGeneration == generation else { return }
            self.enqueueIncoming(message, channel: channel, payload: self.transport.receivedPayload)
        }, state: { [weak self] state, error in
            guard let self, self.connectionGeneration == generation else { return }
            self.setHistoryConnection(state == .secured)
            // 断线时已写入的操作结果未知，列表类保持叠加（L4）；新连接的首个 device.ready 再核对。
            if state != .secured {
                if self.connection == .secured { self.notificationConnectionStartedAt = Date() }
                self.pendingSends.connectionLost(); self.ledgerCloseConnection(); self.replyCompletions.resetActive()
            }
            else { self.ledgerOpenConnection() }
            self.connection = state
            if state == .secured, self.agentEnablementAvailable, !self.agentDialSynchronized { self.refreshAgentEnablement() }
            if state != .secured, self.browse?.forDownload == true, self.browse?.loading == true { self.dismissDownloadBrowser() }
            if state != .secured { self.pathRTT = nil }
            if state != .secured { self.homeDirectoryReceived = false; self.defaultSessionSpawnMode = "tui"; self.filteredReady = nil; self.resetAgentEnablement(); self.importReady = false; self.finishExternalImport(.unconfirmed); self.finishExternalLaunch(.unconfirmed) }
            self.recordConnectionEvent(L10n.tr("连接：{0}", state.rawValue))
            self.transfers.setConnection(self.selectedHost, connected: state == .secured)
            if state != .secured {
                self.openClawNegotiated = false; self.openClawBackendAdvice = nil; self.agyNegotiated = false
                self.kimiCodeSupported = false; self.kimiCodeDesktopSupported = false
                self.hostState.setConnection(self.selectedHost, connected: false); self.agentState.setConnection(self.selectedHost, connected: false); self.notifications.setConnection(self.selectedHost, connected: false)
            }
            if state == .offline || state == .connecting {
                self.toolContent.close(); self.turnFileChanges.disconnected()
                self.activePath = nil
                self.runtimeEventSequences = [:]
                self.sourcePositions = [:]
                self.appliedBaselines = [:]
                self.clearSyncs()
            }
            // Transient reconnect errors stay in the connection indicator.
            if let error { self.recordConnectionEvent(error) }
            if state == .secured { for condition in FeedbackCondition.allCases { self.feedback.resolve(condition) } }
            else if state == .error, let issue = self.transport.feedbackCondition { self.connectionFeedback(issue) }
            else if state == .offline, error == nil { self.feedback.resolve(.computerClosed) }
        })
    }

    func selectRuntime(_ runtimeId: String) {
        guard runtimes.contains(where: { $0.runtimeId == runtimeId }) else { return }
        stopFollowingLaunch()
        if selectedRuntimeId != runtimeId { transfers.browserPreview.close(); toolContent.close(); turnFileChanges.closeViewer() }
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

    func acquireChatInterest(runtimeId: String, sessionId: String?) -> AgentInterestLease? {
        let current = runtimeIndex[runtimeId] ?? selectedRuntime.flatMap { $0.runtimeId == runtimeId ? $0 : nil }
        guard let current, current.sessionId == sessionId else { return nil }
        return agentState.retainInterest(runtime: current, domains: AgentState.chatDomains)
    }

    func releaseChatInterest(_ lease: AgentInterestLease) {
        agentState.releaseInterest(lease, currentRuntime: runtimeIndex[lease.runtimeId])
    }

    @discardableResult
    func previewEntry(_ entryId: String) -> EntryPreviewHandle? {
        guard let runtime = selectedRuntime, let sessionId = runtime.sessionId else { return nil }
        let entryId = displayMessageIds[runtime.runtimeId]?.first(where: { $0.value == entryId })?.key ?? entryId
        if selectedOfflineSession != nil || connection != .secured {
            guard let host = selectedHost else { return nil }
            let id = UUID().uuidString, generation = connectionGeneration
            entryPreview = EntryPreview(requestId: id, runtimeId: runtime.runtimeId, sessionId: sessionId, entryId: entryId)
            runAsyncTransaction { [weak self] in
                guard let self else { return }
                let page = try? await self.historyWorker.page(host: host, sessionId: sessionId, cacheId: runtime.codexCatalogId,
                    leafId: entryId, limit: 1)
                guard generation == self.connectionGeneration, self.entryPreview?.requestId == id else { return }
                self.entryPreview?.message = page?.messages.last
                self.entryPreview?.loading = false
                if self.entryPreview?.message == nil { self.entryPreview?.error = L10n.tr("此节点没有可显示的缓存内容。") }
            }
            return currentEntryPreviewHandle
        }
        guard canSend else { return nil }
        previewTimeout?.cancel()
        let id = UUID().uuidString
        entryPreview = EntryPreview(requestId: id, runtimeId: runtime.runtimeId, sessionId: sessionId, entryId: entryId)
        guard sendCommand(runtimeId: runtime.runtimeId, commandId: id, command: ["type": "session.entry.request", "requestId": id,
                     "sessionId": sessionId, "entryId": entryId]) else {
            entryPreview?.loading = false; entryPreview?.error = L10n.tr("预览请求未送达。"); return currentEntryPreviewHandle
        }
        previewTimeout = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 20_000_000_000) } catch { return }
            guard let self, self.entryPreview?.requestId == id else { return }
            self.entryPreview?.loading = false; self.entryPreview?.error = L10n.tr("预览读取超时，请重试。")
        }
        return currentEntryPreviewHandle
    }

    func dismissPreview() { previewTimeout?.cancel(); entryPreview = nil }
    var currentEntryPreviewHandle: EntryPreviewHandle? {
        entryPreview.map { EntryPreviewHandle(owner: self, requestId: $0.requestId,
            runtimeId: $0.runtimeId, sessionId: $0.sessionId, entryId: $0.entryId) }
    }
    func ownsEntryPreview(_ expected: EntryPreviewHandle) -> Bool {
        expected.owner === self && entryPreview?.requestId == expected.requestId
    }
    func dismissPreview(expected: EntryPreviewHandle) { if ownsEntryPreview(expected) { dismissPreview() } }
    @discardableResult
    func retryPreview(expected: EntryPreviewHandle) -> EntryPreviewHandle? {
        guard ownsEntryPreview(expected), selectedRuntime?.runtimeId == expected.runtimeId,
              selectedRuntime?.sessionId == expected.sessionId else { return nil }
        return previewEntry(expected.entryId)
    }

    private var chatRewindRevision = 0
    private(set) var rewindPreparationCount = 0
    private var cachedRewindOptions: (key: String, revision: Int, options: [String: RuntimeOption])?
    func userMessageRewindOptions(for runtime: RuntimeSummary) -> [String: RuntimeOption] {
        let key = localSessionKey(host: selectedHost, runtime: runtime)
        if !isViewingCachedSession, let cached = cachedRewindOptions,
           cached.key == key, cached.revision == chatRewindRevision { return cached.options }
        guard !isViewingCachedSession,
              let argument = commands[runtime.runtimeId]?.first(where: { $0.name == "tree" })?.argument,
              argument.kind == "tree" else { return [:] }
        var options: [String: RuntimeOption] = [:]
        rewindPreparationCount &+= 1
        for option in argument.options ?? [] where option.tree?.role == "user" && option.tree?.isOnActivePath == true {
            let messageId = displayMessageIds[runtime.runtimeId]?[option.value] ?? option.value
            options[messageId] = option
        }
        cachedRewindOptions = (key, chatRewindRevision, options)
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
        setInteractionResponseError(nil, runtimeId: request.runtimeId, requestId: request.requestId)
        guard sendCommand(runtimeId: request.runtimeId, commandId: id, command: ["type": "interaction.respond", "requestId": request.requestId,
                        "extensionId": request.extensionId, "response": response]) else {
            ledger.remove(id); handleLedger([])
            setInteractionResponseError(L10n.tr("回答未发送，请检查连接后重试"), runtimeId: request.runtimeId, requestId: request.requestId)
            return false
        }
        handleLedger(ledger.written(id, now: Date()))
        return true
    }

    private func setInteractionResponseError(_ message: String?, runtimeId: String, requestId: String) {
        if message != nil, interactions[runtimeId]?.contains(where: { $0.requestId == requestId && $0.submitted != true }) != true { return }
        var errors = interactionErrors[runtimeId] ?? [:]
        guard errors[requestId] != message else { return }
        errors[requestId] = message
        interactionErrors[runtimeId] = errors.isEmpty ? nil : errors
    }

    private func replaceInteractions(_ runtimeId: String, with requests: [InteractionRequest]) {
        interactions[runtimeId] = requests
        if let errors = interactionErrors[runtimeId] {
            let answerable = Set(requests.lazy.filter { $0.submitted != true }.map(\.requestId))
            let remaining = errors.filter { answerable.contains($0.key) }
            if remaining != errors { interactionErrors[runtimeId] = remaining.isEmpty ? nil : remaining }
        }
    }

    /// 正在回答、尚未结算的请求：面板收起，草稿保留。
    func respondingRequestIds(_ runtimeId: String) -> Set<String> { OperationKinds.respondingRequestIds(ledger, runtimeId: runtimeId) }

    func chatNoticeProjection(_ runtimeId: String, sessionId: String?, now: Date = Date()) -> RuntimeNoticeProjection? {
        guard let projection = notifications.visibleProjection(runtimeId), projection.sessionId == sessionId else { return nil }
        guard projection.items.contains(where: \.isResponseOutcome) else { return projection }
        let responding = respondingRequestIds(runtimeId)
        let displayed = (interactions[runtimeId] ?? []).filter { !responding.contains($0.requestId) }
        let nowMs = Int64(now.timeIntervalSince1970 * 1000)
        var owners = Set(displayed.lazy.filter { $0.submitted != true && $0.expiresAt > nowMs && $0.validForModel &&
            self.interactionErrors[runtimeId]?[$0.requestId] != nil }.map(\.requestId))
        let terminal = notifications.projections[runtimeId]?.interactionResultRequestIds ?? []
        if displayed.isEmpty, let status = interactionStatus(runtimeId) { owners.insert(status.requestId) }
        return projection.hidingResponseOutcomes(ownedBy: owners, terminal: terminal)
    }

    /// 原位短状态：明确的 Host 终态优先于同一请求的短状态。
    func interactionStatus(_ runtimeId: String) -> (text: String, pending: Bool, requestId: String)? {
        let projection = notifications.projections[runtimeId]
        let terminal = projection?.sessionId == runtimeIndex[runtimeId]?.sessionId ? projection?.interactionResultRequestIds ?? [] : []
        return OperationKinds.respondStatus(ledger, runtimeId: runtimeId, excluding: terminal)
            ?? interactionOutcomes[runtimeId].flatMap { terminal.contains($0.requestId) ? nil : ($0.text, false, $0.requestId) }
    }

    /// 回答已结算：在原位短暂显示结果，约 2.5 秒后消失（V16）。成功回执显示摘要；只因请求已不在而结算的显示“已处理”，不声称是本机回答生效。
    private func showInteractionOutcome(_ op: AppLedger.Operation) {
        guard case .respond(let runtimeId, let requestId, let summary) = op.payload else { return }
        let outcome = InteractionOutcome(id: UUID(), requestId: requestId, text: op.succeeded ? summary : L10n.tr("已处理"))
        interactionOutcomes[runtimeId] = outcome
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 2_500_000_000)
            if self?.interactionOutcomes[runtimeId]?.id == outcome.id { self?.interactionOutcomes[runtimeId] = nil }
        }
    }

    func refresh() {
        if connection == .secured {
            refreshSessions()
            for runtime in runtimes { agentState.subscribe(runtime: runtime, force: true) }
            if let selectedRuntime { syncSession(selectedRuntime, force: true) }
        } else { reconnectSelectedHost() }
    }

    func reconcileCatalog() { if connection == .secured { hostState.reconcile() } }

    func reconcileHistoryWindow(now: Date = Date()) {
        guard historyWindowVisible, connection == .secured, let runtime = selectedRuntime,
              let session = runtime.sessionId else { return }
        let key = runtime.runtimeId + "\u{0}" + session
        sendHistoryInterest(now: now)
        if historyReconcileSchedules[key, default: ReadReconcileSchedule()].claim(now) {
            syncSession(runtime, force: true)
        }
    }

    func resumeForeground() {
        guard connection == .secured else { reconnectSelectedHost(); return }
        hostState.reconcile()
        for runtime in runtimes { agentState.subscribe(runtime: runtime) }
        if let selectedRuntime {
            if appliedBaselines[selectedRuntime.runtimeId] == nil { syncSession(selectedRuntime, force: true) }
            else { reconcileHistoryWindow() }
        }
    }

    private func syncSession(_ runtime: RuntimeSummary, force: Bool = false) {
        // Selecting a runtime without a Session still closes the previous interest.
        sendHistoryInterest()
        guard connection == .secured, runtime.runtimeId == selectedRuntimeId, let sessionId = runtime.sessionId,
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
            // The recovered transaction retains its original demand generation. Its
            // late response cannot fulfill a refresh requested after it exhausted.
            if force { syncDemands.insert(runtime.runtimeId) }
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
        let loadedProjection = graphs[runtime.directorySessionId ?? sessionId]?.displayVersion
        let known = loadedProjection == nil || expectedMessageDisplayVersion == nil || loadedProjection == expectedMessageDisplayVersion
            ? appliedBaselines[runtime.runtimeId] : nil
        if let known { command["knownState"] = known.wire }
        guard let owner = readOwner(runtime), let operation = sessionReads.begin(kind: .source, owner: owner, targetLeafId: nil).operationId else { return }
        startSync(syncId, runtime: runtime, commandId: commandId, range: "preview", boundary: nil, leaf: nil, command: command, known: known, readId: operation)
    }

    private func startSync(_ syncId: String, runtime: RuntimeSummary, commandId: String, range: String, boundary: String?, leaf: String?, command: [String: Any], known: SessionAppliedBaseline?, readId: String, historyPrefetch: SessionHistoryPrefetch? = nil) {
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
            historyPrefetch: historyPrefetch,
            firstSentAt: now, sentAt: now, deadline: now.addingTimeInterval(150))
        syncDemands.remove(runtime.runtimeId)
        armSyncTimeout(syncId, seconds: 30)
        updateSyncing()
    }

    @discardableResult
    func loadOlderHistory() -> Bool {
        guard let runtime = selectedRuntime else { return false }
        cancelAutomaticHistoryReads(runtimeId: runtime.runtimeId)
        return loadOlderHistory(prefetch: nil)
    }

    private func loadOlderHistory(prefetch: SessionHistoryPrefetch?) -> Bool {
        if let prefetch, !prefetch.canContinue || !historyWindowVisible || !historyWindowSupported || connection != .secured { return false }
        guard let runtime = selectedRuntime, let sessionId = runtime.sessionId, let owner = readOwner(runtime),
              (prefetch != nil || !historyLoading.contains(runtime.runtimeId)), let boundary = prefetch?.beforeEntryId ?? oldestEntries[runtime.runtimeId],
              hasOlderHistory[runtime.runtimeId] == true,
              !pendingSyncs.values.contains(where: { $0.runtimeId == runtime.runtimeId && $0.range != "catchup" && !$0.exhausted }) else { return false }
        if let prefetch, automaticHistoryScope(runtime) != prefetch.scopeId { return false }
        // Continuation pages share the same priority gate as the first reserve.
        if prefetch != nil, syncDemands.contains(runtime.runtimeId) || sessionReads.demands[runtime.runtimeId] != nil { return false }
        if prefetch != nil, sessionReads.operations.values.contains(where: {
            $0.owner.historyKey == runtime.runtimeId && $0.kind == .history && $0.phase.active
        }) { return false }
        if prefetch == nil, let (id, value) = pendingSyncs.first(where: { $0.value.runtimeId == runtime.runtimeId && $0.value.sessionId == sessionId && $0.value.range == "history" && $0.value.boundary == boundary && $0.value.leaf == sessionLeaves[runtime.runtimeId] && $0.value.exhausted }), recoverRead(id, runtime: runtime) {
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
        guard let host = selectedHost, let operation = sessionReads.begin(kind: prefetch == nil ? .history : .prefetch, owner: owner,
            targetLeafId: prefetch?.targetLeafId ?? sessionLeaves[runtime.runtimeId], beforeEntryId: boundary,
            historyPrefetch: prefetch).operationId else { return false }
        if let prefetch { automaticHistoryProgress[prefetch.scopeId] = prefetch }
        if prefetch == nil { historyLoading.insert(runtime.runtimeId); historyErrors[runtime.runtimeId] = nil }
        runAsyncTransaction { [weak self] in
            guard let self else { return }
            do {
                let page = try await self.historyWorker.page(host: host, sessionId: sessionId, cacheId: runtime.codexCatalogId,
                    leafId: self.sessionReads.operations[operation]?.targetLeafId, beforeEntryId: boundary,
                    limit: prefetch?.nextMaxEntries ?? 30)
                guard let current = self.readOwner(runtime), self.sessionReads.owns(operation, current: current) else { return }
                let effect = self.sessionReads.localResult(operation, page: page, current: current)
                if case .apply = effect, prefetch != nil {
                    self.sessionReads.recordPrefetchCachePage(operation, entries: page.entries.count)
                    if let updated = self.sessionReads.operations[operation]?.historyPrefetch {
                        self.automaticHistoryProgress[updated.scopeId] = updated
                    }
                }
                self.applyReadEffect(effect, operation: operation, runtime: runtime)
            } catch { self.failRead(operation, runtime: runtime, message: L10n.tr("本地历史读取失败，请重试。")) }
        }
        return true
    }

    private func automaticHistoryScope(_ runtime: RuntimeSummary) -> String? {
        guard let host = selectedHost, let session = runtime.sessionId else { return nil }
        let storage = runtime.directorySessionId ?? session
        return [hostKeyPrefix(host), host.relay.deviceId, runtime.runtimeId, storage,
            String(branchGenerations[runtime.runtimeId] ?? 0), graphs[storage]?.epoch ?? "",
            oldestEntries[runtime.runtimeId] ?? ""].joined(separator: "\u{0}")
    }

    private func startAutomaticHistoryPrefetch(_ runtime: RuntimeSummary) {
        guard historyWindowVisible, historyWindowSupported, connection == .secured, selectedOfflineSession == nil, selectedRuntimeId == runtime.runtimeId,
              historyInterest.confirmedTarget == runtime.sessionId.map({ runtime.runtimeId + "\u{0}" + $0 }),
              !syncDemands.contains(runtime.runtimeId),
              hasOlderHistory[runtime.runtimeId] == true, oldestEntries[runtime.runtimeId] != nil,
              let scopeId = automaticHistoryScope(runtime),
              !sessionReads.operations.values.contains(where: {
                  $0.owner.historyKey == runtime.runtimeId && $0.kind == .prefetch && $0.phase.active
              }) else { return }
        let progress = automaticHistoryProgress[scopeId] ?? SessionHistoryPrefetch(scopeId: scopeId,
            targetLeafId: sessionLeaves[runtime.runtimeId] ?? runtime.sessionLeafId, beforeEntryId: oldestEntries[runtime.runtimeId])
        guard progress.canContinue else { return }
        _ = loadOlderHistory(prefetch: progress)
    }

    func setHistoryWindowVisible(_ visible: Bool) {
        let changed = visible != historyWindowVisible
        historyWindowVisible = visible
        if changed { notificationCleanupChanged.send() }
        sendHistoryInterest()
        if !visible {
            for runtime in runtimes { cancelAutomaticHistoryReads(runtimeId: runtime.runtimeId) }
        }
    }

    private func sendHistoryInterest(now: Date = Date()) {
        guard historyWindowSupported, connection == .secured else { return }
        let runtime = historyWindowVisible && selectedOfflineSession == nil ? selectedRuntime.flatMap { $0.sessionId == nil ? nil : $0 } : nil
        let target = runtime.flatMap { value in value.sessionId.map { value.runtimeId + "\u{0}" + $0 } } ?? "closed"
        historyInterest.publish(target, now: now) { requestId in
            transport.send(["type": "session.history.interest", "protocolVersion": orbisProtocolVersion,
                "requestId": requestId, "runtimeId": runtime?.runtimeId as Any? ?? NSNull(),
                "sessionId": runtime?.sessionId as Any? ?? NSNull()])
        }
    }

    private func cancelAutomaticHistoryReads(runtimeId: String) {
        let ids = Set(sessionReads.operations.values.filter {
            $0.owner.historyKey == runtimeId && $0.kind == .prefetch && $0.phase.active
        }.map(\.id))
        for syncId in syncReads.filter({ ids.contains($0.value) }).map(\.key) { finishSync(syncId, readPhase: .cancelled) }
        for id in ids {
            if let budget = sessionReads.operations[id]?.historyPrefetch, automaticHistoryProgress[budget.scopeId]?.paused != true {
                automaticHistoryProgress[budget.scopeId] = budget.spendingFailedAttempts(0)
            }
            sessionReads.finish(id, phase: .cancelled)
        }
    }

    private func requestOlderHistory(_ runtime: RuntimeSummary, sessionId: String, boundary: String, operation: String) {
        let sync = UUID().uuidString, command = "session-sync:" + UUID().uuidString
        let leaf = sessionReads.operations[operation]?.targetLeafId
        let prefetch = sessionReads.operations[operation]?.historyPrefetch
        // Local disk IO yields the actor; a source demand may have arrived since
        // this reservation began. Keep its allowance and resume after that read.
        if let prefetch, syncDemands.contains(runtime.runtimeId) || sessionReads.demands[runtime.runtimeId] != nil {
            automaticHistoryProgress[prefetch.scopeId] = prefetch
            sessionReads.finish(operation, phase: .cancelled)
            return
        }
        var body: [String: Any] = ["type": "session.sync", "sessionId": sessionId, "syncId": sync,
                                  "range": "history", "beforeEntryId": boundary, "maxEntries": prefetch?.nextMaxEntries ?? 30]
        if let leaf { body["targetLeafId"] = leaf }
        if let prefetch { body["historyWindow"] = ["format": "v1", "maxBytes": prefetch.nextMaxBytes,
            "maxDeliveries": prefetch.maxAttempts] }
        startSync(sync, runtime: runtime, commandId: command, range: "history", boundary: boundary,
                  leaf: leaf, command: body, known: nil, readId: operation, historyPrefetch: prefetch)
        guard pendingSyncs[sync] != nil else {
            if prefetch == nil { historyLoading.remove(runtime.runtimeId); historyErrors[runtime.runtimeId] = L10n.tr("历史读取请求未送达。") }
            return
        }
        if prefetch == nil { historyErrors[runtime.runtimeId] = nil; historyLoading.insert(runtime.runtimeId) }
    }

    private func readOwner(_ runtime: RuntimeSummary) -> SessionReadOwner? {
        guard let host = selectedHost, let session = runtime.sessionId,
              runtimes.contains(where: { $0.runtimeId == runtime.runtimeId && $0.sessionId == session }) ||
              (selectedOfflineSession?.sessionId == session && selectedRuntimeId == runtime.runtimeId) else { return nil }
        return SessionReadOwner(hostKey: hostKeyPrefix(host), deviceId: host.relay.deviceId,
            historyKey: runtime.runtimeId, sessionId: session, branchGeneration: branchGenerations[runtime.runtimeId] ?? 0,
            cacheEpoch: graphs[runtime.directorySessionId ?? session]?.epoch, connectionGeneration: historyGeneration, selected: selectedRuntimeId == runtime.runtimeId)
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
        let operation = sessionReads.operations[id]
        let kind = operation?.kind
        if let progress = operation?.historyPrefetch {
            let attempts = syncReads.first(where: { $0.value == id }).flatMap { pendingSyncs[$0.key]?.attempts } ?? 0
            let spent = progress.spendingFailedAttempts(attempts)
            automaticHistoryProgress[spent.scopeId] = spent
            sessionReads.finish(id, phase: .cancelled)
        } else {
            sessionReads.finish(id, phase: .failed, error: message)
        }
        if kind == .history { historyLoading.remove(runtime.runtimeId); historyErrors[runtime.runtimeId] = FeedbackText.reason(message) }
        else if kind == .prefetch { return }
        else if kind != .catchup { historyErrors[runtime.runtimeId] = FeedbackText.reason(message) }
    }

    private func completeRemoteRead(_ syncId: String, runtime: RuntimeSummary, page: SessionHistoryPage, sourceConfirmed: Bool = false) {
        guard let id = syncReads[syncId], let owner = readOwner(runtime),
              let command = sessionReads.operations[id]?.commandId else { return }
        let effect = sessionReads.committedRemoteResult(id, commandId: command, page: page, current: owner, sourceConfirmed: sourceConfirmed)
        if sourceConfirmed, let session = runtime.sessionId {
            historyReconcileSchedules[runtime.runtimeId + "\u{0}" + session, default: ReadReconcileSchedule()].confirmed(Date())
        }
        syncReads[syncId] = nil
        applyReadEffect(effect, operation: id, runtime: runtime)
    }

    private func applyReadEffect(_ effect: SessionReadEffect, operation: String, runtime: RuntimeSummary) {
        guard let session = runtime.sessionId else { return }
        let kind = sessionReads.operations[operation]?.kind
        switch effect {
        case .apply(let page):
            if kind == .prefetch {
                guard var progress = sessionReads.operations[operation]?.historyPrefetch else { return }
                if let boundary = page.entries.first?.entryId, boundary != progress.beforeEntryId {
                    progress.beforeEntryId = boundary
                } else { progress.paused = true }
                if !page.hasOlder { progress.paused = true }
                automaticHistoryProgress[progress.scopeId] = progress
                if page.hasOlder && progress.canContinue && automaticHistoryScope(runtime) == progress.scopeId {
                    _ = loadOlderHistory(prefetch: progress)
                }
            } else if kind == .history || kind == .firstPage {
                let generation = historyGeneration, branch = branchGenerations[runtime.runtimeId] ?? 0
                let storageId = runtime.directorySessionId ?? session
                let sourceRevision = sessionRevisions[storageId] ?? 0
                runAsyncTransaction { [weak self] in
                    guard let self else { return }
                    defer {
                        if kind == .history, generation == self.historyGeneration,
                           branch == self.branchGenerations[runtime.runtimeId] ?? 0 {
                            self.historyLoading.remove(runtime.runtimeId)
                        }
                    }
                    guard generation == self.historyGeneration,
                          branch == self.branchGenerations[runtime.runtimeId] ?? 0,
                          kind != .firstPage || sourceRevision == self.sessionRevisions[storageId] ?? 0,
                          await self.installCachedPage(page, runtimeId: runtime.runtimeId, sessionId: session,
                        replacing: kind == .firstPage) else { return }
                    if self.selectedOfflineSession?.sessionId == session { self.updateCachedOptions(page.graph) }
                    if page.hasOlder {
                        self.startAutomaticHistoryPrefetch(runtime)
                    }
                }
                if kind == .history { return } // Do not release admission before projection/install finishes.
            }
        case .requestHistory(let before, _):
            if canSend { requestOlderHistory(runtime, sessionId: session, boundary: before, operation: operation) }
            else { failRead(operation, runtime: runtime, message: L10n.tr("更早的历史尚未缓存，连接原会话后可继续同步。")) }
        case .requestSource:
            if kind == .firstPage { sessionReads.finish(operation, phase: .succeeded) }
            if selectedOfflineSession == nil, connection == .secured,
               !pendingSyncs.values.contains(where: { $0.runtimeId == runtime.runtimeId && $0.range == "preview" && !$0.exhausted }) { syncSession(runtime, force: true) }
            else if selectedOfflineSession != nil { historyErrors[runtime.runtimeId] = L10n.tr("这份会话还没有完整的本地历史缓存。") }
        case .requestCatchup(let gap): requestCatchup(runtime, operation: operation, gap: gap)
        case .none:
            if let read = sessionReads.operations[operation], read.phase == .failed {
                if read.kind == .history, let error = read.error {
                    historyErrors[runtime.runtimeId] = FeedbackText.reason(error)
                } else if let budget = read.historyPrefetch {
                    automaticHistoryProgress[budget.scopeId] = budget.spendingFailedAttempts(1)
                }
            }
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

    var isViewingCachedSession: Bool { selectedOfflineSession != nil }

    @discardableResult
    func openCachedSession(_ session: SessionSummary) -> Bool {
        guard let host = selectedHost else { return false }
        allowAutomaticLaunchSelection = false
        if launching?.resumed != session.sessionId { stopFollowingLaunch() }
        toolContent.close(); turnFileChanges.clear(); dismissPreview()
        selectedOfflineSession = session; selectedRuntimeId = "cached:" + session.sessionId
        cancelForegroundReads(except: selectedRuntimeId)
        branchGenerations[selectedRuntimeId!, default: 0] += 1
        messages = []; cachedHistoryOptions = []; activationRevision += 1
        let generation = connectionGeneration
        guard let runtime = selectedRuntime, let owner = readOwner(runtime),
              let operation = sessionReads.begin(kind: .firstPage, owner: owner, targetLeafId: nil).operationId else { return false }
        runAsyncTransaction { [weak self] in
            guard let self else { return }
            do {
                let cacheId = session.sessionId.hasPrefix("codex-history:") ? session.sessionId : nil
                let page = try await self.historyWorker.page(host: host, sessionId: session.sessionId, cacheId: cacheId, limit: 30)
                guard generation == self.connectionGeneration, self.selectedOfflineSession?.sessionId == session.sessionId,
                      let current = self.readOwner(runtime) else { return }
                let effect = self.sessionReads.localResult(operation, page: page, current: current)
                self.applyReadEffect(effect, operation: operation, runtime: runtime)
                let branches = try await self.historyWorker.branches(host: host, sessionId: session.sessionId,
                    cacheId: session.sessionId.hasPrefix("codex-history:") ? session.sessionId : nil)
                guard generation == self.connectionGeneration, self.selectedOfflineSession?.sessionId == session.sessionId else { return }
                for branch in branches where !self.cachedHistoryOptions.contains(where: { $0.value == branch.leafId }) {
                    self.cachedHistoryOptions.append(RuntimeOption(value: branch.leafId, label: branch.message?.text ?? branch.leafId,
                        description: branch.timestamp, tree: .init(parentId: nil, entryType: "message", role: branch.message?.role,
                            label: nil, defaultHidden: false, isCurrent: false, isOnActivePath: false)))
                }
            } catch { if generation == self.connectionGeneration { self.historyErrors[runtime.runtimeId] = L10n.tr("历史读取失败，请重试。") } }
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
        runAsyncTransaction { [weak self] in
            let cacheId = session.sessionId.hasPrefix("codex-history:") ? session.sessionId : nil
            guard let self, let page = try? await self.historyWorker.page(host: host, sessionId: session.sessionId,
                    cacheId: cacheId, leafId: leafId, limit: 30),
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
        runAsyncTransaction { [weak self] in
            guard let self else { return }
            defer { if self.cacheLoading[runtime.runtimeId] == operation { self.cacheLoading[runtime.runtimeId] = nil } }
            guard let page = try? await self.historyWorker.page(host: host, sessionId: sessionId, cacheId: runtime.codexCatalogId, limit: 30),
                  generation == self.connectionGeneration, self.selectedRuntimeId == runtime.runtimeId,
                  let current = self.readOwner(runtime) else { return }
            guard self.conversations[runtime.runtimeId] == nil else { self.sessionReads.finish(operation, phase: .superseded); return }
            let effect = self.sessionReads.localResult(operation, page: page, current: current)
            self.applyReadEffect(effect, operation: operation, runtime: runtime)
        }
    }

    private func installCachedPage(_ page: SessionHistoryPage, runtimeId: String, sessionId: String, replacing: Bool) async -> Bool {
        let generation = historyGeneration, branch = branchGenerations[runtimeId] ?? 0
        let runtime = runtimeIndex[runtimeId] ?? selectedRuntime.flatMap { $0.runtimeId == runtimeId ? $0 : nil }
        let storageId = runtime?.sessionId == sessionId ? (runtime?.directorySessionId ?? sessionId) : sessionId
        let sourceRevision = sessionRevisions[storageId] ?? 0
        while !Task.isCancelled {
            if !replacing, let graph = graphs[storageId],
               graph.epoch != page.graph.epoch || graph.displayVersion != page.graph.displayVersion { return false }
            let revision = projectionInputRevision
            let next = await sessionProjectionWorker.install(page: page, previousGraph: graphs[storageId],
                messages: conversations[runtimeId] ?? [], displayIds: displayMessageIds[runtimeId] ?? [:],
                timings: timingsBySession[storageId] ?? [:], replacing: replacing)
            guard generation == historyGeneration, branch == branchGenerations[runtimeId] ?? 0,
                  runtimes.contains(where: { $0.runtimeId == runtimeId && $0.sessionId == sessionId }) ||
                    selectedOfflineSession?.sessionId == sessionId && selectedRuntimeId == runtimeId else { return false }
            if replacing, sourceRevision != sessionRevisions[storageId] ?? 0 { return false }
            // A live source commit may arrive during a local read. Rebase the page on its
            // newer input, retaining newer messages rather than overwriting their array.
            if revision != projectionInputRevision { continue }
            graphs[storageId] = next.graph; conversations[runtimeId] = next.messages
            displayMessageIds[runtimeId] = next.displayIds; timingsBySession[storageId] = next.timings
            oldestEntries[runtimeId] = page.entries.first?.entryId ?? oldestEntries[runtimeId]
            if replacing || sessionLeaves[runtimeId] == nil { sessionLeaves[runtimeId] = page.graph.leafId }
            hasOlderHistory[runtimeId] = page.hasOlder
            historyPageRevision += 1; publishMessages()
            return true
        }
        return false
    }

    private func loadCachedIndex(_ host: HostPairing) {
        let generation = connectionGeneration
        runAsyncTransaction { [weak self] in
            guard let self, let rows = try? await self.historyWorker.listCachedSessions(host: host), generation == self.connectionGeneration else { return }
            self.cachedSessionIds = Set(rows.map(\.sessionId)); self.cachedIndexLoaded = true
        }
    }

    /// Owns asynchronous UI transactions. CPU and storage work is explicitly delegated to actors.
    /// Keeps UI state mutation on MainActor; CPU projections and SQLite operations must use workers/actors.
    private func runAsyncTransaction(_ work: @escaping @MainActor () async -> Void) {
        let id = UUID()
        backgroundTasks[id] = Task { [weak self] in await work(); self?.backgroundTasks[id] = nil }
    }

    private func cancelPendingWork() {
        eventTask?.cancel(); eventTask = nil; pendingEvents = []; pendingEventBytes = 0
        transcriptTask?.cancel(); transcriptTask = nil; transcriptInput = nil; transcriptTaskID = UUID()
        directoryTask?.cancel(); directoryTask = nil; directoryTaskID = UUID(); scheduledDirectoryRevision = -1
        homeTask?.cancel(); homeTask = nil; scheduledHomeRevision = -1; homeTaskID = UUID()
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
        while inboundTask != nil || sessionCatalogTask != nil || eventTask != nil || !backgroundTasks.isEmpty || transcriptTask != nil || homeTask != nil {
            if let task = sessionCatalogTask { await task.value }
            if let task = inboundTask { await task.value }
            if let task = eventTask { await task.value }
            for task in Array(backgroundTasks.values) { await task.value }
            if let task = transcriptTask { await task.value }
            if let task = homeTask { await task.value }
        }
        await cleanupTask?.value
        await transfers.waitForPendingIO()
        await localStores.flush()
    }

    private var incomingMessages: [(message: [String: Any], channel: String?, payload: Data?, ownership: UUID?, directoryUpdate: Bool)] = []
    private var incomingBytes = 0
    private var inboundTask: Task<Void, Never>?
    private var admittedRuntimeSessions: [String: String] = [:]
    private var admittedModelEpoch: String?
    private var runtimeOwnership: [String: UUID] = [:]

    /// A lifecycle message may arrive while the serial inbox is awaiting a
    /// catalog or disk operation. Fence old work immediately, before it can commit.
    /// Only cheap identity fields are inspected here; payload validation stays in receive.
    private func fenceIncomingOwnership(_ message: [String: Any], channel: String?) {
        guard channel != nil,
              (message["protocolVersion"] as? Int).map({ $0 == orbisProtocolVersion }) ?? true else { return }
        func invalidate(_ id: String) {
            runtimeOwnership[id] = UUID()
            historyWriteLeases.removeValue(forKey: id)?.invalidate()
            branchGenerations[id, default: 0] += 1
        }
        switch message["type"] as? String {
        case "runtime.offline":
            if let id = message["runtimeId"] as? String {
                invalidate(id); admittedRuntimeSessions[id] = nil
            }
        case "runtime.online":
            if let raw = message["runtime"] as? [String: Any], let id = raw["runtimeId"] as? String {
                let session = raw["sessionId"] as? String ?? ""
                if admittedRuntimeSessions[id] != session { invalidate(id) }
                admittedRuntimeSessions[id] = session
            }
        case "device.ready":
            guard let rows = message["runtimes"] as? [[String: Any]] else { return }
            var next: [String: String] = [:]
            for row in rows {
                guard let id = row["runtimeId"] as? String, next[id] == nil else { return }
                next[id] = row["sessionId"] as? String ?? ""
            }
            let epoch = message["modelEpoch"] as? String
            let restarted = epoch != nil && admittedModelEpoch != nil && epoch != admittedModelEpoch
            for id in Set(admittedRuntimeSessions.keys).union(next.keys)
                where restarted || admittedRuntimeSessions[id] != next[id] { invalidate(id) }
            admittedRuntimeSessions = next
            if let epoch { admittedModelEpoch = epoch }
        default: break
        }
    }

    private func enqueueIncoming(_ message: [String: Any], channel: String?, payload: Data?) {
        let bytes = payload?.count ?? 4096
        // Control receipts cannot be silently discarded. Reconnect recovers their authority.
        guard incomingMessages.count < 256, incomingBytes + bytes <= 8 * 1024 * 1024 else {
            reconnectSelectedHost(); return
        }
        fenceIncomingOwnership(message, channel: channel)
        let ownership = (message["runtimeId"] as? String).flatMap { runtimeOwnership[$0] }
        let directoryUpdate: Bool
        switch message["type"] as? String {
        case "device.ready", "runtime.online", "runtime.offline": directoryUpdate = channel != nil
        default: directoryUpdate = false
        }
        if directoryUpdate { notificationDirectoryUpdates += 1; notificationCleanupChanged.send() }
        incomingMessages.append((message, channel, payload, ownership, directoryUpdate)); incomingBytes += bytes
        guard inboundTask == nil else { return }
        let generation = connectionGeneration
        inboundTask = Task { [weak self] in
            guard let self else { return }
            await self.launchJournal.waitLoaded()
            while !Task.isCancelled, generation == self.connectionGeneration, !self.incomingMessages.isEmpty {
                let item = self.incomingMessages.removeFirst()
                self.incomingBytes -= item.payload?.count ?? 4096
                await self.receive(item.message, channel: item.channel, payload: item.payload, ownership: item.ownership)
                if item.directoryUpdate, generation == self.connectionGeneration {
                    self.notificationDirectoryUpdates -= 1; self.notificationCleanupChanged.send()
                }
                await Task.yield()
            }
            if generation == self.connectionGeneration { self.inboundTask = nil }
        }
    }

    private func enqueueRuntimeEvent(_ message: [String: Any], channel: String?, payload: Data?, ownership: UUID?) {
        guard let id = message["runtimeId"] as? String, runtimeOwnership[id] == ownership else { return }
        let cost = payload?.count ?? 4096
        var dropped = false
        while !pendingEvents.isEmpty && (pendingEvents.count >= 256 || pendingEventBytes + cost > 4 * 1024 * 1024) {
            let index = pendingEvents.firstIndex { $0.channel != "ctl" } ?? 0
            let old = pendingEvents.remove(at: index); pendingEventBytes -= old.bytes; dropped = true
            if let event = old.message["event"] as? [String: Any], let syncId = event["syncId"] as? String,
               let runtimeId = old.message["runtimeId"] as? String { rejectSnapshot(syncId, runtimeId: runtimeId, message: L10n.tr("历史读取队列繁忙，正在重新同步。")) }
        }
        if dropped, let selectedRuntime { syncSession(selectedRuntime, force: true) }
        pendingEvents.append((message, channel, cost, payload, ownership)); pendingEventBytes += cost
        guard eventTask == nil else { return }
        let generation = historyGeneration
        eventTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled, generation == self.historyGeneration, !self.pendingEvents.isEmpty {
                let index = self.pendingEvents.firstIndex { $0.channel == "ctl" }
                    ?? self.pendingEvents.firstIndex { $0.channel == "msg" }
                    ?? self.pendingEvents.firstIndex { $0.channel == "history" }
                    ?? self.pendingEvents.firstIndex { $0.channel == "catchup" } ?? 0
                let event = self.pendingEvents.remove(at: index); self.pendingEventBytes -= event.bytes
                if let id = event.message["runtimeId"] as? String, self.runtimeOwnership[id] == event.ownership {
                    await self.consumeEvent(event.message, channel: event.channel, rawEnvelope: event.payload)
                }
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

    func activate(_ session: SessionSummary, codexLaunchMode: CodexLaunchMode? = nil) {
        let unified = session.sessionId.hasPrefix("codex-history:")
        guard !unified || unifiedCodexHistory else { return }
        let kimi = resolvedKimiCodeKind(kind: session.agentKind, id: session.sessionId)
        guard supportsKimiCode(kind: kimi, id: session.sessionId, web: kimiCodeSupported, desktop: kimiCodeDesktopSupported) else { return }
        if session.agentKind == "openclaw", !openClawNegotiated { return }
        if session.sessionId.hasPrefix("agy:"), !agyNegotiated { return }
        if let mismatch = providerMismatch(session) { sessionOperationErrors[session.sessionId] = mismatch; return }
        if codexLaunchMode == nil, let runtime = runtimes.first(where: { (unified ? $0.codexCatalogId : $0.sessionId) == session.sessionId }) {
            selectRuntime(runtime.runtimeId)
            return
        }
        var target: [String: Any] = ["type": "resume", "sessionId": session.sessionId]
        let kind = kimi ?? session.agentKind
        if let kind { target["agentKind"] = kind }
        let modes = codexResumeModes(session)
        let mode = codexLaunchMode ?? (modes.count == 1 ? modes.first : nil)
        if unified && (mode == nil || !modes.contains(mode!)) { return }
        activateTarget(target, sessionId: session.sessionId, spawnMode: kimi != nil ? "headless" : nil, codexLaunchMode: mode)
    }

    func codexResumeModes(_ session: SessionSummary) -> [CodexLaunchMode] {
        guard unifiedCodexHistory, session.sessionId.hasPrefix("codex-history:"), session.archived != true else { return [] }
        return (session.codexLaunchModes ?? []).filter { mode in
            enabledAgentKinds?.contains(mode.agentKind) != false && (supportedAgents ?? []).contains(mode.agentKind)
        }
    }

    func createSession(agentKind: String, cwd: String) {
        _ = createSession(agentKind: agentKind, cwd: cwd, firstMessage: "")
    }
    /// S49 / SC70: an empty draft only launches; a first sentence also queues a send.
    func createSession(agentKind: String, cwd: String, firstMessage: String) -> Bool {
        reconcilePendingSends()
        guard !cwd.isEmpty, connection == .secured else { return false }
        if ["openclaw", "agy", kimiCodeKind, kimiCodeDesktopKind].contains(agentKind) {
            guard supportsSessionConfiguration(for: agentKind), (launchableAgents ?? supportedAgents ?? []).contains(agentKind) else { return false }
            if firstMessage.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("/") {
                composerFeedback(L10n.tr("请从命令菜单选择斜杠命令。"), newSession: true); return false
            }
        }
        if supportsSessionConfiguration(for: agentKind) {
            let text = firstMessage.trimmingCharacters(in: .whitespacesAndNewlines)
            guard text.isEmpty || validatedMessageBody(text, newSession: true) != nil else { return false }
            guard ledger.operations.filter({ !$0.phase.isSettled }).count + (text.isEmpty ? 1 : 2) <= ledger.capacity else { return false }
            return createConfiguredSession(agent: agentKind, cwd: cwd, firstMessage: text)
        }
        guard !isLaunchPage || launching?.following != true else { return false }
        if firstMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            activateTarget(["type": "new", "agentKind": agentKind, "cwd": cwd], sessionId: "new")
            return activationRequestId != nil
        }
        guard let text = validatedMessageBody(firstMessage, newSession: true) else { return false }
        // A first sentence needs one launch operation and one waiting send. Reject
        // capacity exhaustion before writing session.activate to the computer.
        guard ledger.operations.filter({ !$0.phase.isSettled }).count + 2 <= ledger.capacity else {
            composerFeedback(L10n.tr("待发送的消息过多，请稍后重试。"), newSession: true); return false
        }
        activateTarget(["type": "new", "agentKind": agentKind, "cwd": cwd], sessionId: "new", displayTitle: String(text.prefix(22)))
        guard let launch = launching, selectedRuntimeId == launch.placeholder else { return false }
        return sendMessage(text)
    }
    #if DEBUG
    func createCaptureSession(agentKind: String, cwd: String) {
        guard !cwd.isEmpty else { return }
        if [kimiCodeKind, kimiCodeDesktopKind].contains(agentKind) { createSession(agentKind: agentKind, cwd: cwd); return }
        activateTarget(["type": "new", "agentKind": agentKind, "cwd": cwd], sessionId: "new", spawnMode: "headless")
    }
    #endif

    private func activateTarget(_ target: [String: Any], sessionId: String, spawnMode: String? = nil, displayTitle: String? = nil, codexLaunchMode: CodexLaunchMode? = nil) {
        guard connection == .secured, activationRequestId == nil || launching != nil,
              (codexLaunchMode?.agentKind ?? target["agentKind"] as? String).map({ enabledAgentKinds?.contains($0) != false }) != false,
              !sessionId.hasPrefix("codex-history:") || unifiedCodexHistory else { return }
        let requestId = UUID().uuidString
        let placeholder = "launch:" + requestId
        let creation = ledger.create(opId: requestId, kind: OperationKinds.launch, target: placeholder, policy: OperationKinds.launchPolicy,
                                     basis: ledgerBasis(OperationKinds.runtimesDomain),
                                     payload: .launch(requestId: requestId, placeholder: placeholder), written: false, now: Date())
        guard creation == .created else { return }
        var payload: [String: Any] = ["type": "session.activate", "protocolVersion": orbisProtocolVersion,
                                      "requestId": requestId, "target": target, "spawnMode": spawnMode ?? (sessionId.hasPrefix("codex-history:") ? "auto" : defaultSessionSpawnMode)]
        if let codexLaunchMode { payload["codexLaunchMode"] = codexLaunchMode.rawValue }
        guard transport.send(payload) else {
            ledger.remove(requestId); handleLedger([])
            sessionLaunchError = L10n.tr("未连接到电脑，连接恢复后可重试。"); sessionLaunchErrorAwaitsConnection = true; return
        }
        parkForegroundLaunch()
        if target["type"] as? String == "new" || sessionLaunchErrorAwaitsConnection { sessionLaunchError = nil }
        activationRequestId = requestId; pendingActivation = sessionId; activatingSessionId = sessionId
        handleLedger(ledger.written(requestId, now: Date()))
        // ADR-0049 §6.8：立即进入该会话的聊天页并显示“启动中”；恢复已有会话时先显示缓存历史（V13）。
        let resumed = target["type"] as? String == "resume" ? sessionId : nil
        let cwd = target["cwd"] as? String ?? resumed.flatMap { sessionIndex[$0]?.cwd } ?? ""
        let title = displayTitle ?? resumed.flatMap { id in sessionIndex[id].map { displayName($0) } }
            ?? (cwd.split(separator: "/").last.map(String.init) ?? L10n.tr("新会话"))
        launching = LaunchState(requestId: requestId, placeholder: placeholder,
                                target: target.compactMapValues { $0 as? String }, title: title, cwd: cwd,
                                agentKind: target["agentKind"] as? String, resumed: resumed, sessionId: resumed, spawnModeOverride: spawnMode,
                                codexLaunchMode: codexLaunchMode)
        if let resumed, let session = sessionIndex[resumed], openCachedSession(session) { return }
        toolContent.close(); turnFileChanges.clear(); dismissPreview()
        selectedOfflineSession = nil; selectedRuntimeId = placeholder; messages = []; cachedHistoryOptions = []
        activationRevision += 1
    }

    private func markConfiguredLaunchUnconfirmed(_ id: String?, reason: String? = nil) {
        guard let id, var value = launch(id), value.configured else { return }
        value.unconfirmed = true
        if let reason { value.failure = reason }
        updateLaunch(value)
        if activationRequestId == id || (activationRequestId == nil && launching?.requestId == id && pendingActivation == value.sessionId) { clearActivation() }
    }

    private func retireConfiguredLaunch(_ id: String, firstId: String?) {
        let placeholder = "launch:" + id
        // Remove local sends for this placeholder only. No native cancellation or resubmission.
        var messages = Set(pendingSends.items.filter { $0.sessionId == placeholder || $0.runtimeId == placeholder }.map(\.messageId))
        if let firstId { messages.insert(firstId) }
        for op in ledger.operations {
            if case .send(_, let sessionId, let messageId) = op.payload, sessionId == placeholder || op.prerequisites.contains(id) {
                messages.insert(messageId); ledger.remove(op.opId)
            }
        }
        for messageId in messages {
            pendingSends.remove(messageId); removeWaitingCopy(messageId)
        }
        ledger.remove(id)
        let session = launchSessions.removeValue(forKey: placeholder)
        if activationRequestId == id || (activationRequestId == nil && launching?.requestId == id && session.map({ pendingActivation == $0 }) == true) {
            clearActivation()
        }
        backgroundLaunches[id] = nil
        if launching?.requestId == id { launching = nil; launchComposerFocused = false }
        if selectedRuntimeId == placeholder { selectedRuntimeId = nil }
        publishMessages()
        scheduleLedgerClock()
    }

    /// A confirmed local write survives leaving the page. The return value only grants
    /// navigation if that page still owns the selection when the write completes.
    func endConfiguredLaunch(_ id: String, mayReturnToDraft: () -> Bool = { true }) async -> Bool {
        let journal = launchJournal, host = selectedHostId, generation = connectionGeneration
        guard let launch = launching, launch.requestId == id, launch.placeholder == selectedRuntimeId,
              launch.canEndConfiguredLaunch, !launch.endingWait, let saved = journal.snapshot(id), let write = journal.abandon(id) else { return false }
        launching?.endingWait = true
        let persisted = await write.value
        guard selectedHostId == host, launchJournal === journal, journal.snapshot(id) != nil else { return false }
        guard persisted else {
            let error = L10n.tr("无法保存启动恢复记录，请重试")
            if var current = self.launch(id) { current.endingWait = false; current.failure = error; updateLaunch(current) }
            return false
        }
        let navigate = !Task.isCancelled && generation == connectionGeneration && launching?.requestId == id &&
            launching?.following == true && selectedRuntimeId == launch.placeholder && mayReturnToDraft()
        retireConfiguredLaunch(id, firstId: saved["firstMessageId"] as? String)
        if navigate { draftReturnLaunchId = id }
        return navigate
    }

    /// 启动失败后在聊天页原位重试：同一目标、新的请求（L6）。
    func retryLaunch() {
        guard let launch = launching, launch.failure != nil || launch.unconfirmed else { return }
        if launch.configured {
            if launchJournal.acceptsResult(for: launch.requestId) { recoverConfiguredLaunch(launch.requestId) }
            return
        }
        let kind = resolvedKimiCodeKind(kind: launch.agentKind, id: launch.resumed) ?? launch.agentKind
        guard supportsKimiCode(kind: kind, id: launch.resumed, web: kimiCodeSupported, desktop: kimiCodeDesktopSupported),
              ![kimiCodeKind, kimiCodeDesktopKind].contains(kind) || launch.resumed != nil else { return }
        var target: [String: Any] = launch.target
        if let kind { target["agentKind"] = kind }
        launching = nil
        activateTarget(target, sessionId: launch.resumed ?? "new", spawnMode: [kimiCodeKind, kimiCodeDesktopKind].contains(kind ?? "") ? "headless" : launch.spawnModeOverride,
                       displayTitle: launch.title, codexLaunchMode: launch.codexLaunchMode)
    }

    func reviewPreviousLaunch() {
        guard let id = previousLaunchToReview, launchJournal.acceptsResult(for: id), let saved = launchJournal.snapshot(id) else { return }
        restoreConfiguredLaunch(saved, id: id, show: true)
        recoverConfiguredLaunch(id)
    }

    /// 用户离开了启动页：启动继续，成功后不把用户拉回，会话照常出现在首页。
    func stopFollowingLaunch() {
        allowAutomaticLaunchSelection = false
        guard let launch = launching, launch.following else { return }
        if launchJournal.acceptsResult(for: launch.requestId), var saved = launchJournal.snapshot(launch.requestId) {
            saved["following"] = false; _ = writeLaunchJournal(saved)
        }
        launching?.following = false
    }

    /// Handoff, including cleanup and recovered input, belongs to this request alone.
    private func launchLanded(_ launch: LaunchState, runtime: RuntimeSummary) {
        let foreground = launching?.requestId == launch.requestId
        let following = foreground && launch.following && isLaunchPage
        let placeholderRuntime = RuntimeSummary(runtimeId: launch.placeholder, name: launch.title, cwd: launch.cwd, status: "starting",
                                                sessionId: launch.resumed ?? launch.placeholder, agentKind: launch.agentKind)
        let cachedRuntime = foreground ? launch.resumed.flatMap { id in selectedOfflineSession?.sessionId == id ? selectedRuntime : nil } : nil
        for source in [placeholderRuntime, cachedRuntime].compactMap({ $0 }) {
            if localSessionKey(host: selectedHost, runtime: source) == localSessionKey(host: selectedHost, runtime: runtime) { continue }
            let text = draft(for: source)
            if !text.isEmpty, draft(for: runtime).isEmpty { saveDraft(text, for: runtime); saveDraft("", for: source) }
        }
        if foreground {
            if activationRequestId == launch.requestId || (activationRequestId == nil && pendingActivation == runtime.sessionId) { clearActivation() }
            if following && launchComposerFocused { composerFocusHandoff = runtime.runtimeId }
            launchComposerFocused = false; launching = nil
        } else { backgroundLaunches[launch.requestId] = nil }
        if launch.configured, let saved = launchJournal.snapshot(launch.requestId), saved["sessionId"] as? String == runtime.sessionId {
            var recovery = ConfiguredFirstMessage(saved, runtime: runtime,
                now: pendingSends.item(saved["firstMessageId"] as? String)?.createdAt ?? Date())
            if let message = recovery, isMaterialized(message.messageId, on: runtime.runtimeId) { recovery = nil }
            launchJournal.handoff(launch.requestId, firstMessage: recovery)
        }
        if following { selectedOfflineSession = nil; selectedRuntimeId = runtime.runtimeId; activationRevision += 1 }
        else if selectedRuntimeId == launch.placeholder { selectedRuntimeId = nil }
    }

    /// `runtime.online` omits `agentKind`; Codex launch-mode matching completes once the committed
    /// `identity` domain confirms the Runtime's kind and catalog route.
    private func reconcileIdentityLaunch(runtimeId: String) {
        let previousSelection = selectedRuntimeId
        let landed = reconcileRuntimeLaunches(complete: false)
        if !landed, launching == nil, let runtime = runtimes.first(where: { $0.runtimeId == runtimeId }),
           pendingActivation == runtime.sessionId, pendingActivation != nil {
            if let session = runtime.sessionId, let text = pendingBranchDrafts.removeValue(forKey: offlineSessionKey(host: selectedHost, sessionId: session)) {
                saveDraft(text, for: runtime)
            }
            clearActivation(); selectedRuntimeId = runtime.runtimeId; activationRevision += 1
        }
        if landed || selectedRuntimeId != previousSelection {
            publishMessages()
            if let runtime = selectedRuntime, runtime.runtimeId != previousSelection {
                syncSession(runtime)
            }
        }
    }

    /// A full readiness inventory and an online event can supply the last piece of
    /// any launch. Bind each exact route before the ledger releases dependent sends.
    @discardableResult
    private func reconcileRuntimeLaunches(complete: Bool) -> Bool {
        let ready = trackedLaunches.compactMap { launch -> (LaunchState, RuntimeSummary)? in
            guard let sessionId = launch.sessionId, let runtime = launchRuntime(launch, sessionId: sessionId) else { return nil }
            return (launch, runtime)
        }
        for (launch, runtime) in ready { bindLaunchPendingSends(launch, to: runtime) }
        ledgerAuthority(OperationKinds.runtimesDomain, read: nil, complete: complete)
        for (launch, runtime) in ready where self.launch(launch.requestId) != nil {
            if let session = runtime.sessionId, let text = pendingBranchDrafts.removeValue(forKey: offlineSessionKey(host: selectedHost, sessionId: session)) {
                saveDraft(text, for: runtime)
            }
            launchLanded(launch, runtime: runtime)
        }
        return !ready.isEmpty
    }

    /// A launch acknowledgement alone does not own a Runtime. Bind only after the exact Runtime
    /// is present, and do so before runtime-list evidence can release dependent sends.
    private func launchRuntime(_ launch: LaunchState, sessionId: String) -> RuntimeSummary? {
        guard !launch.configured || launchJournal.acceptsResult(for: launch.requestId) else { return nil }
        let catalogId = launch.resumed?.hasPrefix("codex-history:") == true ? launch.resumed : nil
        let candidates = runtimes.filter {
            runtimeMatchesLaunch($0, sessionId: sessionId, codexCatalogId: catalogId,
                                 launchMode: launch.codexLaunchMode,
                                 agentKind: launch.codexLaunchMode?.agentKind ?? launch.agentKind)
        }
        return candidates.count == 1 ? candidates.first : nil
    }

    private func bindLaunchPendingSends(_ launch: LaunchState, to runtime: RuntimeSummary) {
        guard let sessionId = launch.sessionId, sessionId == runtime.sessionId,
              launchRuntime(launch, sessionId: sessionId)?.runtimeId == runtime.runtimeId else { return }
        launchSessions[launch.placeholder] = sessionId
        if let resumed = launch.resumed { launchSessions[resumed] = sessionId }

        // A resumed catalog item can have been addressed as either the launch placeholder or the
        // cached directory row. Both source pairs are exact; raw thread IDs are never used alone.
        let sessionIds = Set([launch.resumed ?? launch.placeholder, sessionId])
        var sourcePairs = sessionIds.map { (launch.placeholder, $0) }
        if let resumed = launch.resumed { sourcePairs.append(contentsOf: sessionIds.map { ("cached:" + resumed, $0) }) }
        for send in pendingSends.items {
            guard let sourceRuntimeId = send.runtimeId,
                  sourcePairs.contains(where: { $0.0 == sourceRuntimeId && $0.1 == send.sessionId }) else { continue }
            let targetGroup = OperationKinds.sendGroup(runtime.directorySessionId ?? sessionId)
            if let operation = ledger.operation(send.commandId),
               case .send(let operationRuntimeId, let operationSessionId, let operationMessageId) = operation.payload,
               operationRuntimeId == sourceRuntimeId, operationSessionId == send.sessionId,
               operationMessageId == send.messageId {
                _ = ledger.rebindWaiting(send.commandId,
                    expectedPayload: operation.payload, expectedGroup: operation.group,
                    payload: .send(runtimeId: runtime.runtimeId, sessionId: sessionId, messageId: send.messageId),
                    group: targetGroup)
            }
            if pendingSends.rebind(messageId: send.messageId, fromRuntimeId: sourceRuntimeId, fromSessionId: send.sessionId,
                                   toRuntimeId: runtime.runtimeId, toSessionId: sessionId) {
                moveWaitingCopy(send.messageId, to: runtime)
            }
        }
    }

    /// `session.activated` establishes the wire Session but not yet its Runtime owner. Rebind only
    /// that half now; the exact Runtime and canonical ordering group are bound before list evidence.
    private func bindLaunchSession(_ launch: LaunchState, sessionId: String) {
        launchSessions[launch.placeholder] = sessionId
        if let resumed = launch.resumed { launchSessions[resumed] = sessionId }
        let sourceIds = Set([launch.resumed ?? launch.placeholder, sessionId])
        var sourcePairs = sourceIds.map { (launch.placeholder, $0) }
        if let resumed = launch.resumed { sourcePairs.append(contentsOf: sourceIds.map { ("cached:" + resumed, $0) }) }
        for send in pendingSends.items {
            guard let runtimeId = send.runtimeId,
                  sourcePairs.contains(where: { $0.0 == runtimeId && $0.1 == send.sessionId }) else { continue }
            if let operation = ledger.operation(send.commandId),
               case .send(let operationRuntimeId, let operationSessionId, let messageId) = operation.payload,
               operationRuntimeId == runtimeId, operationSessionId == send.sessionId, messageId == send.messageId {
                _ = ledger.rebindWaiting(send.commandId, expectedPayload: operation.payload, expectedGroup: operation.group,
                    payload: .send(runtimeId: runtimeId, sessionId: sessionId, messageId: send.messageId), group: operation.group)
            }
            _ = pendingSends.rebind(messageId: send.messageId, fromRuntimeId: runtimeId, fromSessionId: send.sessionId,
                                    toRuntimeId: runtimeId, toSessionId: sessionId)
        }
    }

    private func moveWaitingCopy(_ messageId: String, to runtime: RuntimeSummary) {
        guard var copies = preferences?.dictionary(forKey: Self.waitingCopiesKey) as? [String: [String: String]] else { return }
        var text: String?
        for key in Array(copies.keys) {
            if text == nil { text = copies[key]?.removeValue(forKey: messageId) }
            else { copies[key]?.removeValue(forKey: messageId) }
            if copies[key]?.isEmpty == true { copies[key] = nil }
        }
        if let text { copies[localSessionKey(host: selectedHost, runtime: runtime), default: [:]][messageId] = text }
        preferences?.set(copies, forKey: Self.waitingCopiesKey)
    }

    private func clearActivation() {
        activationTimeout?.cancel(); activationTimeout = nil
        activationRequestId = nil; pendingActivation = nil; activatingSessionId = nil
    }

    /// ADR-0049 §6.4 `archive`：卡片立即移到目标列表；回执、断线、期限与核对全部交给账本。
    func archive(_ session: SessionSummary, archived: Bool) {
        guard session.agentKind != "agy", !session.sessionId.hasPrefix("agy:") else { return }
        guard !session.sessionId.hasPrefix("codex-history:") || unifiedCodexHistory else { return }
        if session.agentKind == "openclaw", !openClawNegotiated { return }
        guard connection == .secured, let kind = session.agentKind, supportsKimiCode(kind: kind, id: session.sessionId, web: kimiCodeSupported, desktop: kimiCodeDesktopSupported) else { return }
        let requestId = UUID().uuidString
        let creation = ledger.create(opId: requestId, kind: OperationKinds.archive,
                                     target: OperationKinds.archiveTarget(agentKind: kind, sessionId: session.sessionId),
                                     policy: OperationKinds.archivePolicy, basis: ledgerBasis(OperationKinds.catalogDomain),
                                     payload: .archive(sessionId: session.sessionId, agentKind: kind, archived: archived), written: false, now: Date())
        guard creation == .created else { return }
        guard transport.send(["type": "session.archive", "protocolVersion": orbisProtocolVersion, "requestId": requestId,
                              "sessionId": session.sessionId, "agentKind": kind, "archived": archived]) else {
            ledger.remove(requestId); handleLedger([])
            sessionOperationErrors[session.sessionId] = L10n.tr("操作未送达，请连接后重试。"); return
        }
        sessionOperationErrors[session.sessionId] = nil
        handleLedger(ledger.written(requestId, now: Date()))
    }

    /// 目录叠加未结算的归档操作：卡片立即出现在目标列表（ADR-0049 §6.4）。
    var visibleSessions: [SessionSummary] {
        let visible = sessions.filter { supportsKimiCode(kind: $0.agentKind, id: $0.sessionId, web: kimiCodeSupported, desktop: kimiCodeDesktopSupported) }
        let overrides = OperationKinds.archiveOverrides(ledger)
        guard !overrides.isEmpty else { return visible }
        return visible.map { session in
            guard let archived = overrides[session.sessionId] else { return session }
            var copy = session; copy.archived = archived; return copy
        }
    }

    /// 正在归档 / 恢复、尚未结算的会话：冲突入口在结算前禁用（L9）。
    func isArchiving(_ sessionId: String) -> Bool { OperationKinds.archiveOverrides(ledger)[sessionId] != nil }

    func openDownloadBrowser() {
        browseDownloadDirectory(selectedHostId.flatMap { downloadBrowserPaths.path(hostId: $0) })
    }

    func browseDownloadDirectory(_ path: String?, rememberPath: Bool = true) {
        browseDirectory(path, forDownload: true, rememberPath: rememberPath)
    }

    func browseDirectory(_ path: String? = nil) {
        browseDirectory(path, forDownload: false, rememberPath: false)
    }

    var workDirectoryBrowse: DirectoryBrowse? { browse?.forDownload == false ? browse : nil }

    private func browseDirectory(_ path: String?, forDownload: Bool, rememberPath: Bool) {
        browseTimeout?.cancel()
        guard connection == .secured else {
            browse = DirectoryBrowse(requestId: "", path: path, loading: false, error: L10n.tr("未连接到电脑，连接恢复后可重试。"), forDownload: forDownload, rememberPath: rememberPath)
            return
        }
        let requestId = UUID().uuidString
        browse = DirectoryBrowse(requestId: requestId, path: path, forDownload: forDownload, rememberPath: rememberPath)
        var request: [String: Any] = ["type": "session.browse", "protocolVersion": orbisProtocolVersion, "requestId": requestId]
        if let path { request["path"] = path }
        guard transport.send(request) else { browse?.loading = false; browse?.error = L10n.tr("目录读取请求未送达。"); return }
        browseTimeout = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 20_000_000_000) } catch { return }
            guard let self, self.browse?.requestId == requestId, self.browse?.loading == true else { return }
            self.browse?.loading = false; self.browse?.error = L10n.tr("目录读取超时，请重试。")
        }
    }

    func dismissBrowse() { browseTimeout?.cancel(); browseTimeout = nil; browse = nil }
    func dismissDownloadBrowser() { if browse?.forDownload == true { dismissBrowse() } }
    func dismissWorkDirectoryBrowser() { if browse?.forDownload == false { dismissBrowse() } }

    @discardableResult
    func executeSlash(_ name: String, args: String = "", composerDraft: String? = nil) -> Bool {
        if name == "quit", args.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, let runtime = selectedRuntime {
            return closeRuntimes([runtime.runtimeId], cardOnly: false).contains(runtime.runtimeId)
        }
        guard name != SlashCommand.closeCapability, name != SlashCommand.viewCloseCapability else { return false }
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
            inlineFeedback(L10n.tr("命令未送达，请连接后重试。")); return false
        }
        if objectError(runtime.runtimeId, includeCardOnly: false) != nil { objectErrors[runtime.runtimeId] = nil }
        composerErrors[runtime.runtimeId] = nil
        transfers.clearUploadError(for: runtime)
        if pendingSendHostId != selectedHostId { pendingSends.removeAll(); pendingSendHostId = selectedHostId }
        let anchor = runtime.runtimeId == selectedRuntimeId ? messages.last(where: { pendingSends.item($0.messageId) == nil })?.messageId : nil
        var send = PendingSend(messageId: id, commandId: commandId, sessionId: sessionId, runtimeId: runtime.runtimeId, text: text, attachments: [],
                               delivery: nil, createdAt: Date(), anchorMessageId: anchor)
        send.slashName = name; send.slashArgs = args
        pendingSends.add(send)
        publishMessages()
        return true
    }

    // MARK: - ADR-0049 §6.7 模型与思考级别（条件乐观）

    /// 切换中再次选择：只记下最新一次，前一次结束后只在它与确认值不同时再提交。
    private var configSelections: [String: (value: String, label: String)] = [:]
    private var configFailures: [String: SessionConfigFailure] = [:]
    private var configOperationSessions: [String: String] = [:]

    func sessionConfigFailure(_ runtimeId: String) -> SessionConfigFailure? {
        guard let runtime = runtimes.first(where: { $0.runtimeId == runtimeId }),
              let failure = configFailures[runtimeId], failure.sessionId == runtime.sessionId else { return nil }
        return failure
    }

    private func submitConfig(_ runtime: RuntimeSummary, setting: String, value: String, label: String) -> Bool {
        configFailures.removeValue(forKey: runtime.runtimeId)
        objectWillChange.send()
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
        configOperationSessions[id] = runtime.sessionId ?? ""
        guard sendCommand(runtimeId: runtime.runtimeId, commandId: id, command: ["type": "slash.execute", "name": setting, "args": value]) else {
            configOperationSessions.removeValue(forKey: id)
            ledger.remove(id); handleLedger([])
            configFailures[runtime.runtimeId] = SessionConfigFailure(setting: setting, value: value,
                message: L10n.tr("操作未送达，请连接后重试。"), sessionId: runtime.sessionId)
            return false
        }
        handleLedger(ledger.written(id, now: Date()))
        return true
    }

    /// 前一次切换结束：最新一次选择与确认值不同就再提交。
    private func configSettled(_ op: AppLedger.Operation) {
        guard case .config(let runtimeId, let setting, let value, _) = op.payload else { return }
        let session = configOperationSessions.removeValue(forKey: op.opId)
        guard let current = runtimes.first(where: { $0.runtimeId == runtimeId }), session == (current.sessionId ?? "") else { return }
        if case .rejected(let rejection) = op.phase {
            configFailures[runtimeId] = SessionConfigFailure(setting: setting, value: value,
                message: rejection.reason.isEmpty ? L10n.tr("请重试") : FeedbackText.reason(rejection.reason),
                sessionId: runtimes.first { $0.runtimeId == runtimeId }?.sessionId)
        } else { configFailures.removeValue(forKey: runtimeId) }
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
        runtimeIndex[id]?.allowsRemoteClose(commands[id] ?? [], negotiated: runtimeCloseNegotiated) == true
    }

    func closeImpact(_ id: String) -> RuntimeCloseImpact? {
        guard let runtime = runtimeIndex[id] else { return nil }
        let waiting = interactions[id]?.isEmpty == false
        let hostQueued = queuedMessages[id]?.filter { ["accepted", "not_cancelable", "unconfirmed"].contains($0.state) }.map(\.queueId) ?? []
        let localQueued = pendingSends.items.filter { item in
            guard item.sessionId == runtime.sessionId, item.runtimeId == nil || item.runtimeId == id, !item.submissionConfirmed else { return false }
            if case .failed = item.state { return false }
            return true
        }.map(\.messageId)
        let queued = Set(hostQueued + localQueued).count
        return RuntimeCloseImpact(runtime, negotiated: runtimeCloseNegotiated, waiting: waiting, queued: queued,
            retrying: agentState.snapshots[id]?.domains["execution"]?.value["retry"]["phase"].string == "running")
    }

    private func closeTarget(_ runtime: RuntimeSummary) -> RuntimeClosePlan.Target? {
        guard let session = runtime.sessionId, !session.isEmpty,
              let command = runtime.remoteCloseCommand(commands[runtime.runtimeId] ?? [], negotiated: runtimeCloseNegotiated) else { return nil }
        return .init(runtimeId: runtime.runtimeId, sessionId: session, agentKind: runtime.agentKind, closeGeneration: command.closeGeneration)
    }

    func closePlan(_ ids: Set<String>) -> RuntimeClosePlan {
        RuntimeClosePlan(connectionGeneration: connectionGeneration, connection: ledger.connection, modelEpoch: authenticatedModelEpoch, negotiated: runtimeCloseNegotiated,
            entries: runtimes.compactMap { runtime in
                guard ids.contains(runtime.runtimeId), canCloseRuntime(runtime.runtimeId),
                      let target = closeTarget(runtime), let impact = closeImpact(runtime.runtimeId) else { return nil }
                return .init(target: target, title: displayName(runtime), impact: impact)
            })
    }

    func closeRuntimes(_ runtimeIds: Set<String>, plan: RuntimeClosePlan? = nil, confirmed: Bool = false, cardOnly: Bool = true) -> Set<String> {
        guard connection == .secured else {
            for id in runtimeIds { inlineFeedback(L10n.tr("关闭会话未发送：请先连接电脑。"), runtimeId: id, cardOnly: cardOnly) }; return []
        }
        var submitted: Set<String> = []
        for runtime in runtimes where runtimeIds.contains(runtime.runtimeId) {
            let id = runtime.runtimeId
            if let reason = runtime.remoteCloseBlockReason(commands[id] ?? [], negotiated: runtimeCloseNegotiated) {
                agentState.subscribe(runtime: runtime, force: true)
                inlineFeedback(reason.message, runtimeId: id, cardOnly: cardOnly)
                continue
            }
            guard let target = closeTarget(runtime) else { continue }
            let entry = plan?.entries.first(where: { $0.target == target })
            if let plan {
                guard plan.connectionGeneration == connectionGeneration, plan.connection == ledger.connection, plan.modelEpoch == authenticatedModelEpoch,
                      plan.negotiated == runtimeCloseNegotiated, entry != nil else {
                    inlineFeedback(L10n.tr("会话已变化，请重新确认关闭。"), runtimeId: id, cardOnly: cardOnly); continue
                }
            }
            let consent = confirmed && entry?.impact.needsConfirmation == true
            if closeImpact(id)?.needsConfirmation == true, !consent {
                inlineFeedback(L10n.tr("会话活动已变化，请重新确认关闭。"), runtimeId: id, cardOnly: cardOnly); continue
            }
            if submitQuit(target, confirmed: consent) { submitted.insert(id) }
        }
        return submitted
    }

    /// ADR-0049 §7.5 `quit`：先记入账本、再写入通道，卡片随账本叠加立即隐藏。
    private func submitQuit(_ target: RuntimeClosePlan.Target, confirmed: Bool) -> Bool {
        let runtimeId = target.runtimeId
        let commandId = UUID().uuidString
        let creation = ledger.create(opId: commandId, kind: OperationKinds.quit, target: OperationKinds.quitTarget(runtimeId),
                                     policy: OperationKinds.quitPolicy, basis: ledgerBasis(OperationKinds.runtimesDomain),
                                     payload: .quit(runtimeId: runtimeId), written: false, now: Date())
        switch creation {
        case .created: break
        case .conflict: return true // 同一会话的关闭尚未结算，卡片已隐藏（L9）。
        case .duplicate, .full:
            inlineFeedback(L10n.tr("关闭会话未发送：待确认的操作过多，请稍后重试。"), runtimeId: runtimeId, cardOnly: true); return false
        }
        var command: [String: Any] = ["type": "slash.execute", "name": "quit", "args": ""]
        if runtimeCloseNegotiated {
            command = ["type": "session.close", "sessionId": target.sessionId, "confirmed": confirmed]
            command["closeGeneration"] = target.closeGeneration
        }
        guard sendCommand(runtimeId: runtimeId, commandId: commandId, command: command) else {
            ledger.remove(commandId)
            inlineFeedback(L10n.tr("关闭会话未发送：请连接电脑后重试。"), runtimeId: runtimeId, cardOnly: true); return false
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
        runtimeCloseNegotiated = false
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
            let launches = Dictionary(uniqueKeysWithValues: trackedLaunches.map { ($0.requestId, $0) })
            return { op in
                // `launch`：Host 给出的 Session 的 Runtime 已上线即落地。
                if case .launch(let requestId, _) = op.payload {
                    guard let launch = launches[requestId], let session = launch.sessionId,
                          self.launchRuntime(launch, sessionId: session) != nil else { return .none }
                    return .landed
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
                if case .launch(let id, _) = op.payload, var current = launch(id), case .rejected(let rejection) = op.phase {
                    current.failure = rejection.reason.isEmpty ? L10n.tr("启动失败") : FeedbackText.reason(rejection.reason)
                    updateLaunch(current)
                    if activationRequestId == id { clearActivation() }
                }
                // 批量归档同时被拒绝时写明数量（ADR-0049 §6.4）。
                if let text = OperationKinds.message(for: op) { if case .archive(let sessionId, _, _) = op.payload { sessionOperationErrors[sessionId] = text }
                    else if case .quit(let runtimeId) = op.payload { inlineFeedback(text, runtimeId: runtimeId) }
                    else if case .queueCancel(let runtimeId, let queueId) = op.payload { queueErrors[runtimeId + "\u{0}" + queueId] = text; if queuedMessages[runtimeId]?.contains(where: { $0.queueId == queueId }) != true { inlineFeedback(text, runtimeId: runtimeId) } }
                    else if case .respond(let runtimeId, let requestId, _) = op.payload { setInteractionResponseError(text, runtimeId: runtimeId, requestId: requestId) } }
                if OperationKinds.removesOnRejection(op) { ledger.remove(op.opId) }
            case .verify: verify = true
            case .landed(let op): showInteractionOutcome(op); configSettled(op)
            case .ready: readySends = true
            case .unconfirmed(let op):
                if case .launch(let id, _) = op.payload, var current = launch(id) {
                    if current.configured { markConfiguredLaunchUnconfirmed(id) }
                    else { current.unconfirmed = true; updateLaunch(current) }
                }
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

    func canUpdatePermission(settingId: String, value: String) -> Bool {
        guard canSend, let runtime = selectedRuntime, pendingActionIds.isEmpty,
              let setting = runtime.permissionManagement?.settings.first(where: { $0.id == settingId }),
              setting.disabledReason == nil, setting.options.contains(where: { $0.value == value }) else { return false }
        return true
    }

    @discardableResult func updatePermission(settingId: String, value: String) -> Bool {
        guard canUpdatePermission(settingId: settingId, value: value), let runtime = selectedRuntime else { return false }
        return performAction(runtimeId: runtime.runtimeId, name: L10n.tr("权限"), command: ["type": "permissions.update", "settingId": settingId, "value": value])
    }

    private func performAction(runtimeId: String, name: String, command: [String: Any]) -> Bool {
        performActionId(runtimeId: runtimeId, name: name, command: command) != nil
    }

    private func performActionId(runtimeId: String, name: String, command: [String: Any]) -> String? {
        let id = UUID().uuidString
        objectErrors[runtimeId] = nil
        guard sendCommand(runtimeId: runtimeId, commandId: id, command: command) else {
            inlineFeedback(L10n.tr("操作未送达，请连接后重试。"), runtimeId: runtimeId); return nil
        }
        runtimeActions[id] = (runtimeId, name, runtimeIndex[runtimeId]?.sessionId); pendingActionIds.insert(id); setActionFeedback(nil); updateSyncing()
        actionTimeouts[id] = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 60_000_000_000) } catch { return }
            guard let self, self.runtimeActions[id] != nil else { return }
            self.finishAction(id, succeeded: false, message: L10n.tr("操作尚未确认，请刷新查看电脑端状态。"))
        }
        return id
    }

    /// 操作完成提示只是短暂确认，不能长期停在聊天页上；新操作开始或断开时立即清掉。
    private func setActionFeedback(_ text: String?, key: String? = nil) {
        feedbackTimeout?.cancel(); feedbackTimeout = nil; actionFeedback = nil
        if let text { presentFeedback(.toast, text, key: key) }
    }

    private func finishAction(_ id: String, succeeded: Bool, message: String? = nil, result: [String: Any]? = nil) {
        guard let action = runtimeActions.removeValue(forKey: id) else { return }
        if let submitted = composerActionDrafts.removeValue(forKey: id), succeeded {
            updateDrafts(reload: true) { if $0[submitted.key] == submitted.text { $0[submitted.key] = nil } }
        }
        defer { if action.name == "tree" { branchEditorNode = nil; branchEditorText = nil } }
        pendingActionIds.remove(id); actionTimeouts.removeValue(forKey: id)?.cancel(); updateSyncing()
        guard let current = runtimeIndex[action.runtimeId], current.sessionId == action.sessionId else {
            recordConnectionEvent("action.result_dropped: owner_replaced"); return
        }
        if succeeded {
            setActionFeedback(L10n.tr("{0} 已完成", action.name), key: "action:" + id)
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
        } else {
            let text = FeedbackText.reason(message ?? L10n.tr("{0} 未完成，请重试。", action.name))
            inlineFeedback(text, runtimeId: action.runtimeId)
            if selectedRuntimeId != action.runtimeId { presentFeedback(.toast, text, key: "action:" + id) }
        }
    }

    /// Validate before either a normal send or first-sentence activation, so a
    /// rejected slash command/oversized message never starts an empty session.
    private func validatedMessageBody(_ text: String, attachmentCount: Int = 0, newSession: Bool = false) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let body = trimmed.isEmpty && attachmentCount > 0 ? L10n.tr("已发送 {0} 个附件", attachmentCount) : trimmed
        guard !body.isEmpty else { return nil }
        guard body.utf16.count <= 100_000 else { composerFeedback(L10n.tr("消息不能超过 100,000 个字符。"), newSession: newSession); return nil }
        guard !trimmed.hasPrefix("/") else {
            composerFeedback(L10n.tr("请从命令菜单选择斜杠命令。"), newSession: newSession); return nil
        }
        return body
    }

    @discardableResult
    func sendMessage(_ text: String, delivery: String? = nil, attachmentIds: Set<String> = []) -> Bool {
        guard canSend, let runtime = selectedRuntime, delivery == nil || ["followUp", "steer"].contains(delivery!) else { return false }
        if isKimiCode(kind: agentKind(runtime), id: runtime.runtimeId) {
            guard supportsKimiCode(kind: agentKind(runtime), id: runtime.runtimeId, web: kimiCodeSupported, desktop: kimiCodeDesktopSupported), runtime.status != "running", delivery == nil, attachmentIds.isEmpty else { return false }
        }
        if agentKind(runtime) == "openclaw", !openClawNegotiated || delivery != nil || !attachmentIds.isEmpty || runtime.status == "running" { return false }
        guard let body = validatedMessageBody(text, attachmentCount: attachmentIds.count) else { return false }
        let attachments = transfers.currentTasks.filter { attachmentIds.contains($0.id) && $0.runtimeId == runtime.runtimeId && $0.sessionId == runtime.sessionId && $0.direction == "upload" }
        guard attachments.count == attachmentIds.count, attachments.allSatisfy({ !["failed", "cancelled"].contains($0.status) }) else { return false }
        // ADR-0049 §6.2：附件没传完或同会话还有等待中的前一条，就先在本机创建、排在后面，轮到时再写入通道。
        let uploaded = attachments.allSatisfy { $0.status == "completed" && $0.remotePath != nil }
        var configs = OperationKinds.activeConfigOps(ledger, runtimeId: runtime.runtimeId)
        // 启动中发送的消息等“会话启动”（ADR-0049 §6.8）。
        if isLaunchPage, let launch = launching, let op = ledger.operation(launch.requestId) { configs.append(op) }
        if !uploaded || !configs.isEmpty || runtime.sessionId.map({ ledger.blocks(group: OperationKinds.sendGroup(runtime.directorySessionId ?? $0)) }) == true {
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
            inlineFeedback(L10n.tr("消息未送达，请连接后重试。"), runtimeId: runtime.runtimeId); return false
        }
        if objectError(runtime.runtimeId, includeCardOnly: false) != nil { objectErrors[runtime.runtimeId] = nil }
        composerErrors[runtime.runtimeId] = nil
        transfers.clearUploadError(for: runtime)
        if pendingSendHostId != selectedHostId { pendingSends.removeAll(); pendingSendHostId = selectedHostId }
        let anchor = runtime.runtimeId == selectedRuntimeId ? messages.last(where: { pendingSends.item($0.messageId) == nil })?.messageId : nil
        pendingSends.add(PendingSend(messageId: id, commandId: commandId, sessionId: sessionId, runtimeId: runtime.runtimeId, text: body, attachments: attachments,
                                     delivery: delivery, createdAt: Date(), anchorMessageId: anchor))
        publishMessages()
        return true
    }

    // MARK: - ADR-0049 §6.2 等待前置操作的消息

    private static let waitingCopiesKey = "orbis.waitingSendCopies"

    /// 气泡立即出现、输入框清空；附件上传完成且同会话前一条已写入后，按创建顺序写入通道，再交给 outbox 结算。
    private func sendWhenReady(_ body: String, delivery: String?, uploads: [FileTransfer], runtime: RuntimeSummary,
                               configs: [AppLedger.Operation] = [], id: String = UUID().uuidString, commandId: String = UUID().uuidString) -> Bool {
        guard let sessionId = runtime.sessionId else { return false }
        let pending = uploads.filter { $0.status != "completed" || $0.remotePath == nil }
        let creation = ledger.create(opId: commandId, kind: OperationKinds.send, target: "message:" + id, group: OperationKinds.sendGroup(runtime.directorySessionId ?? sessionId),
                                     conflicts: false, policy: OperationKinds.sendPolicy, basis: [:],
                                     prerequisites: Set(pending.map { OperationKinds.uploadPrerequisite($0.id) } + configs.map(\.opId)),
                                     payload: .send(runtimeId: runtime.runtimeId, sessionId: sessionId, messageId: id), written: false, now: Date())
        guard creation == .created else { composerFeedback(L10n.tr("待发送的消息过多，请稍后重试。")); return false }
        if objectError(runtime.runtimeId, includeCardOnly: false) != nil { objectErrors[runtime.runtimeId] = nil }
        composerErrors[runtime.runtimeId] = nil
        transfers.clearUploadError(for: runtime)
        if pendingSendHostId != selectedHostId { pendingSends.removeAll(); pendingSendHostId = selectedHostId }
        let anchor = runtime.runtimeId == selectedRuntimeId ? messages.last(where: { pendingSends.item($0.messageId) == nil })?.messageId : nil
        var send = PendingSend(messageId: id, commandId: commandId, sessionId: sessionId, runtimeId: runtime.runtimeId, text: body, attachments: [],
                               delivery: delivery, createdAt: Date(), anchorMessageId: anchor)
        let config: String? = configs.first.flatMap { if case .config(_, let setting, _, _) = $0.payload { return OperationKinds.configTitle(setting) }; return nil }
        let launch = configs.contains { if case .launch = $0.payload { return true }; return false }
        send.state = .waiting(!pending.isEmpty ? L10n.tr("上传中：") + pending.map(\.name).joined(separator: L10n.tr("、"))
                              : launch ? L10n.tr("等待会话启动") : config.map { L10n.tr("等待{0}切换", $0) } ?? L10n.tr("等待前一条发送"))
        send.uploadIds = uploads.map(\.id)
        pendingSends.add(send)
        if launchJournal.launchId(forFirstMessage: id) == nil { saveWaitingCopy(id, text: body, runtime: runtime) }
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
                guard let send = pendingSends.item(messageId), send.sessionId == sessionId,
                      let runtimeId = send.runtimeId,
                      runtimes.contains(where: { $0.runtimeId == runtimeId && $0.sessionId == sessionId }) else { continue }
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
        var kept: [String: [String: String]] = [:]
        updateDrafts(reload: true) { drafts in
            for (key, entries) in copies {
                let live = entries.filter { pendingSends.item($0.key) != nil }
                if !live.isEmpty { kept[key] = live }
                let restored = entries.filter { pendingSends.item($0.key) == nil }.values.sorted()
                guard !restored.isEmpty else { continue }
                drafts[key] = ([drafts[key]].compactMap { $0 } + restored).joined(separator: "\n\n")
            }
        }
        preferences?.set(kept, forKey: Self.waitingCopiesKey)
    }

    /// 失败行重新发送：用新的 messageId，空闲直发不会被各后端当成同一条消息去重。
    @discardableResult
    func resendPendingSend(_ messageId: String) -> Bool {
        guard canSend, let runtime = selectedRuntime, let send = pendingSends.item(messageId), send.runtimeId == runtime.runtimeId,
              send.sessionId == runtime.sessionId,
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
        // Match runtime capabilities on resend: Claude supports steer only when steerSupported == true.
        let delivery: String? = runtime.status == "idle" ? nil
            : send.delivery == "steer" && (agentKind(runtime) != "claude" || runtime.steerSupported == true) ? "steer" : "followUp"
        // Keep the old row until the replacement send has been admitted.
        guard sendUserMessage(send.text, delivery: delivery, attachments: send.attachments, runtime: runtime) else { return false }
        pendingSends.remove(messageId)
        clearConfiguredFirstMessage(messageId)
        publishMessages()
        return true
    }

    /// 放回输入框：删除本地行并交回正文；附件路径已在电脑上，只能随正文说明。
    func restorePendingSend(_ messageId: String) -> String? {
        guard let send = pendingSends.item(messageId) else { return nil }
        switch send.state { case .failed, .unconfirmed: break; default: return nil }
        pendingSends.remove(messageId); removeWaitingCopy(messageId)
        clearConfiguredFirstMessage(messageId, restoring: true)
        publishMessages()
        // 附件没传成：正文和附件都回到输入框（ADR-0049 §6.1）。
        if !send.uploadIds.isEmpty, send.attachments.isEmpty { transfers.reattach(Set(send.uploadIds)); return send.text }
        return send.attachments.isEmpty ? send.text : send.text + "\n\n附件路径：\n" + send.attachments.joined(separator: "\n")
    }

    func discardPendingSend(_ messageId: String) {
        guard let send = pendingSends.item(messageId) else { return }
        switch send.state { case .failed, .unconfirmed: break; default: return }
        pendingSends.remove(messageId); removeWaitingCopy(messageId)
        clearConfiguredFirstMessage(messageId)
        publishMessages()
    }

    private func clearConfiguredFirstMessage(_ messageId: String, restoring: Bool = false) {
        let journal = launchJournal
        journal.forgetFirstMessages([messageId])
        guard !restoring, let id = journal.launchId(forFirstMessage: messageId), var saved = journal.snapshot(id) else { return }
        for key in ["firstMessage", "firstMessageId", "firstCommandId"] { saved.removeValue(forKey: key) }
        _ = writeLaunchJournal(saved)
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
        let local = pendingSends.queueRows(sessionId: sessionId, runtimeId: runtimeId).filter { send in !host.contains { $0.queueId == send.messageId } }
            .map { QueuedMessage(queueId: $0.messageId, text: $0.text, delivery: $0.delivery ?? "followUp", state: "submitting", error: nil) }
        return (host + local).map { row in QueuedMessage(queueId: row.queueId, text: row.text, delivery: row.delivery, state: row.state, error: queueErrors[runtimeId + "\u{0}" + row.queueId] ?? row.error) }
    }

    private func isMaterialized(_ messageId: String, on runtimeId: String) -> Bool {
        conversations[runtimeId]?.contains { $0.materializesClientMessage(messageId) } == true ||
            messageAliases[runtimeId]?[messageId].map { displayMessageIds[runtimeId]?[$0] != nil } == true
    }

    private func reconcileConfiguredFirstMessages() {
        let journal = launchJournal
        guard !journal.firstMessages.isEmpty else { return }
        var materialized: Set<String> = []
        for message in journal.firstMessages {
            let candidates = runtimes.filter(message.matches)
            guard candidates.count == 1, let runtime = candidates.first else { continue }
            if isMaterialized(message.messageId, on: runtime.runtimeId) {
                materialized.insert(message.messageId)
                pendingSends.remove(message.messageId)
            } else if let send = pendingSends.item(message.messageId) {
                if send.sessionId == message.sessionId && send.runtimeId == message.runtimeId && send.runtimeId != runtime.runtimeId {
                    pendingSends.rebind(messageId: message.messageId, fromRuntimeId: message.runtimeId, fromSessionId: message.sessionId,
                                        toRuntimeId: runtime.runtimeId, toSessionId: message.sessionId)
                }
            } else {
                pendingSendHostId = selectedHostId
                pendingSends.add(message.pending(on: runtime))
            }
        }
        journal.forgetFirstMessages(materialized)
    }

    private func reconcilePendingSends() {
        reconcileConfiguredFirstMessages()
        guard !pendingSends.isEmpty else { return }
        let connected = connection == .secured
        let journal = launchJournal
        let retainedFirstMessages = Set(journal.firstMessages.map(\.messageId) + journal.pending.compactMap { $0["firstMessageId"] as? String })
        var recheck = false
        for scope in pendingSends.scopes {
            let sessionId = scope.sessionId
            let runtimeId = scope.runtimeId
            let runtime = runtimeId.flatMap { id in runtimes.first { $0.runtimeId == id && $0.sessionId == sessionId } }
            let needsSync = pendingSends.reconcile(runtimeId: runtimeId, sessionId: sessionId, status: runtime?.status,
                queue: runtimeId.flatMap { queuedMessages[$0] } ?? [], revision: runtime.map { sessionRevisions[$0.directorySessionId ?? sessionId] ?? 0 } ?? 0,
                connected: connected, retainUntilMaterialized: { retainedFirstMessages.contains($0) }) { id in
                    runtime != nil && runtimeId.map { isMaterialized(id, on: $0) } == true
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
        guard let runtime = runtimes.first(where: { $0.runtimeId == runtimeId }), let sessionId = runtime.sessionId else { return }
        sessionRevisions[runtime.directorySessionId ?? sessionId, default: 0] += 1
    }

    /// ADR-0049 §6.3 `queueCancel`：队列项立即退场；回执、断线、期限与核对全部交给账本。
    @discardableResult
    func cancelQueuedMessage(_ queueId: String) -> Bool {
        guard canSend, let runtime = selectedRuntime,
              !isKimiCode(kind: agentKind(runtime), id: runtime.runtimeId),
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
            inlineFeedback(L10n.tr("操作未送达，请连接后重试。"), runtimeId: runtime.runtimeId); return false
        }
        return true
    }

    private func sendCommand(runtimeId: String, commandId: String = UUID().uuidString, command: [String: Any]) -> Bool {
        var projected = command
        if command["type"] as? String == "slash.execute", let name = command["name"] as? String,
           let catalog = commands[runtimeId]?.first(where: { $0.name == name })?.argument?.optionCatalog {
            projected["optionCatalogId"] = catalog.id
        }
        return transport.send(["type": "runtime.command", "protocolVersion": orbisProtocolVersion, "runtimeId": runtimeId, "commandId": commandId, "command": projected])
    }

    /// 上次从这台电脑收到的会话目录。连接或切换电脑时先显示它，等 session.list 回来再整体替换，
    /// 抽屉不必每次都从空白等待加载。provider 归属依赖实时状态，不缓存。
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
        _ = queueSessionCatalog([], identity: runtime)
    }

    /// Catalog and identity updates retain invocation order. Only the immutable
    /// result is installed here; merges, sorting, equality and index construction
    /// belong to the worker. Local cache hydration enters this same queue first.
    private var loadedSessionCacheKey: String?
    private func queueSessionCatalog(_ incoming: [SessionSummary], completeKinds: Set<String> = [],
                                     identity: RuntimeSummary? = nil, loadKey: String? = nil,
                                     replacing: Bool = false) -> Task<Void, Never> {
        let prior = sessionCatalogTask, id = UUID(), generation = connectionGeneration
        sessionCatalogTaskID = id
        let task = Task { [weak self] in
            await prior?.value
            guard let self else { return }
            defer { if self.sessionCatalogTaskID == id { self.sessionCatalogTask = nil } }
            guard !Task.isCancelled, generation == self.connectionGeneration else { return }
            var rows = incoming
            if let loadKey { rows = await self.localStores.loadCatalog(key: loadKey, preferences: self.preferences) }
            guard !Task.isCancelled, generation == self.connectionGeneration else { return }
            let retained = Set(self.runtimes.flatMap { [$0.sessionId, $0.codexCatalogId].compactMap { $0 } })
                .union(self.graphs.keys).union(self.cachedSessionIds)
            let prepared = await self.sessionCatalogWorker.merge(current: self.sessions, incoming: rows,
                completeKinds: completeKinds, retained: retained, cacheLoaded: self.cachedIndexLoaded,
                identity: identity, replacing: replacing || loadKey != nil,
                unifiedCodex: self.unifiedCodexHistory, keepOtherCodexView: loadKey == nil)
            guard !Task.isCancelled, generation == self.connectionGeneration else { return }
            if let loadKey { self.loadedSessionCacheKey = loadKey }
            if prepared.changed {
                self.sessionIndex = prepared.index
                self.sessions = prepared.sessions
                if loadKey == nil { self.persistSessions() }
            }
        }
        sessionCatalogTask = task
        return task
    }
    private func persistSessions() {
        guard let host = selectedHost else { return }
        localStores.saveCatalog(sessions, key: sessionCacheKey(host), preferences: preferences)
    }

    private func refreshSessions() {
        hostState.refresh(["catalog", "providers", "backends"])
        guard !modelCatalogReceived else { return }
        let id = UUID().uuidString
        sessionListRequest = id
        if !transport.send(["type": "session.list", "protocolVersion": orbisProtocolVersion, "requestId": id]) { sessionListRequest = nil }
    }

    func currentProvider(for kind: String) -> String? {
        if kind == "codex", unifiedCodexHistory {
            if let rows = hostState.domains["catalog"]?.value["currentProviders"].array,
               let match = rows.first(where: { $0["agentKind"].string == kind }) { return match["provider"].string }
            let providers = Set([hostState.currentProviders["codex"], hostState.currentProviders["codexDesktop"],
                                 currentProviders["codex"], currentProviders["codexDesktop"]].compactMap { $0 })
            return providers.count == 1 ? providers.first : nil
        }
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

    /// Both fatal and ordinary errors settle every correlated owner. A failed
    /// reconciliation read is not a rejection receipt for unrelated writes.
    @discardableResult
    private func rejectCorrelatedProtocolOperation(_ message: [String: Any]) -> Bool {
        let commandId = message["commandId"] as? String
        let requestId = message["requestId"] as? String
        // Without a reason, each owner keeps its own copy; only the ledger
        // receipt needs the generic sentence.
        let detail = message["message"] as? String
        let reason = detail ?? L10n.tr("电脑端无法完成操作。")
        if let requestId, let read = ledgerReads.removeValue(forKey: requestId) {
            consumeLedgerRead(message, type: "protocol.error", read: read)
            return true
        }
        // A verification reply keeps its read ownership after completion. A
        // duplicate cannot reinterpret its echoed commandId as a write receipt.
        if requestId?.hasPrefix(OperationKinds.verifyRequestPrefix) == true { return true }
        var owned = hostState.rejectQuotaRequest(requestId, detail: detail)
        // SC99: command and request identities can refer to different owners.
        // Consume each once, without making a reader rejection a write receipt.
        let ledgerOwnsCommand = commandId.flatMap { ledger.operation($0) } != nil
        var seen = Set<String>()
        for opId in [commandId, requestId].compactMap({ $0 }) where seen.insert(opId).inserted && ledger.operation(opId) != nil {
            handleLedger(ledger.receipt(opId, connection: ledger.connection,
                .failed(.init(message["code"] as? String ?? "failure", reason)), now: Date()))
            owned = true
        }
        if let commandId, !ledgerOwnsCommand, pendingSends.owns(commandId: commandId) {
            pendingSends.commandResult(commandId, ok: false, status: message["code"] as? String, error: detail)
            publishMessages()
            owned = true
        }
        if let commandId {
            var historyRead = false
            if let syncId = pendingSyncs.first(where: { $0.value.commandId == commandId })?.key {
                let pending = pendingSyncs[syncId]
                finishSync(syncId, readPhase: .failed)
                historyRead = pending?.range == "history"
                if let pending, historyRead, pending.historyPrefetch == nil {
                    historyErrors[pending.runtimeId] = FeedbackText.reason(detail ?? L10n.tr("历史读取失败，请重试。"))
                }
                owned = true
            }
            if !historyRead, runtimeActions[commandId] != nil {
                finishAction(commandId, succeeded: false, message: detail)
                owned = true
            }
        }
        if let requestId, requestId == sessionConfigurationRequest {
            configurationTimeout?.cancel()
            sessionConfigurationRequest = nil
            if openClawConfigurationCwd != nil {
                sessionConfigurationError = FeedbackText.openClawConfigurationRejection(detail, code: message["code"] as? String)
            } else {
                sessionConfigurationError = FeedbackText.reason(detail ?? L10n.tr("配置未确认"))
            }
            owned = true
        }
        if let requestId, requestId == activationRequestId { clearActivation(); owned = true }
        if let requestId, requestId == sessionListRequest {
            sessionListRequest = nil; owned = true
        }
        if let requestId, requestId == browse?.requestId {
            if browse?.loading == true {
                browseTimeout?.cancel(); browse?.loading = false; browse?.error = FeedbackText.reason(detail ?? L10n.tr("目录不可读"))
            }
            owned = true
        }
        return owned
    }

    private func receive(_ message: [String: Any], channel: String?, payload: Data? = nil, ownership: UUID? = nil) async {
        guard let type = message["type"] as? String else { return }
        guard channel != nil else {
            if type == "protocol.error" { recordConnectionEvent(String(describing: message)); if let condition = FeedbackText.protocolCondition(message["code"] as? String) { connectionFeedback(condition) }; connection = .error }
            return
        }
        defer { commitHomePresentation() }
        if let version = message["protocolVersion"] as? Int, version != orbisProtocolVersion {
            connectionFeedback(.version)
            return
        }
        if consumeExternalImport(message, type: type) || consumeExternalLaunch(message, type: type) { return }
        if channel == "ctl", transfers.browserPreview.consume(message) { return }
        if type == "protocol.error", connectionFatalProtocolCodes.contains(message["code"] as? String ?? "") {
            recordConnectionEvent("protocol.error.fatal: " + String(describing: message))
            connectionFeedback(FeedbackText.protocolCondition(message["code"] as? String) ?? .version)
            rejectCorrelatedProtocolOperation(message)
            return
        }
        if type == "protocol.error" {
            recordConnectionEvent("protocol.error: " + (message["code"] as? String ?? "") + " " + (message["message"] as? String ?? ""))
        }
        transfers.consume(message, allowPreviewChunk: channel == "bulk")
        if FileTransfers.ownedReplyTypes.contains(type) { return }
        recordConnectionEvent("\(channel ?? "—") · \(type)")
        if let requestId = message["requestId"] as? String,
           historyInterest.consume(requestId, accepted: type == "session.history.interest.result" && message["accepted"] as? Bool == true) {
            // FT-G12-RESUME-01: the Host suppressed the hidden window's events. An
            // accepted current subscription must reconcile after it resumes, even
            // inside the periodic cooldown and while an older preview is in flight.
            if historyWindowVisible, historyWindowSupported, selectedOfflineSession == nil,
               connection == .secured, let runtime = selectedRuntime, let session = runtime.sessionId,
               historyInterest.confirmedTarget == runtime.runtimeId + "\u{0}" + session {
                historyReconcileSchedules[runtime.runtimeId + "\u{0}" + session, default: ReadReconcileSchedule()].started(Date())
                cancelAutomaticHistoryReads(runtimeId: runtime.runtimeId)
                syncSession(runtime, force: true)
            }
            return
        }
        if channel != nil, let requestId = historyWindowRequestId, message["requestId"] as? String == requestId {
            historyWindowSupported = type == "session.history.capabilities" && message["format"] as? String == "v1" &&
                integer(message["maxPageBytes"]) == 65536
            historyWindowRequestId = nil
            sendHistoryInterest()
            return
        }
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
        if type == "agent.menu.options.page" {
            if let result = menuOptions.consume(message) {
                if let next = result.next { sendMenuOptionRequest(next) }
                if result.error != nil { menuErrors[result.runtimeId + "\u{0}" + result.name] = L10n.tr("命令选项读取失败，请重新打开菜单") }
                if let options = result.options {
                    commands[result.runtimeId] = commands[result.runtimeId]?.map { command in
                        var value = command
                        if value.name == result.name, value.argument?.optionCatalog?.id == result.catalogId { value.argument?.options = options }
                        return value
                    }
                }
            }
            return
        }
        if channel != nil, await hostState.consume(message) { return }
        if agentState.consume(message) { return }
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
        case "agent.enablement.snapshot", "agent.enablement.result":
            if channel != nil { receiveAgentEnablement(message) }
        case "agent.enablement.review":
            if channel != nil { rejectAgentDial(message) }
        case "device.ready":
            guard channel != nil, let values = message["runtimes"] as? [[String: Any]] else { return }
            // OpenClaw's echo is independent of Gateway readiness. The old Host
            // continues to signal Desktop acceptance with the presence of its status key.
            let features = Set(message["hostFeatures"] as? [String] ?? [])
            if channel == "ctl", let host = selectedHost, message["deviceId"] as? String == host.relay.deviceId {
                transfers.browserPreview.authenticated(host: host.hostId, supportsWeb: features.contains(ChatFilePreview.webFeature),
                    supportsNative: features.contains(ChatFilePreview.nativeFeature))
            }
            let supportsRender = features.contains(messageRenderFeature)
            let admittedOpenClaw = features.contains("agent.openclaw") && (message["deviceFeatures"] as? [String])?.contains("agent.openclaw") == true
            let admittedCodex = readyAdmitsCodexHistory(message)
            let admittedClose = readyAdmitsRuntimeClose(message)
            let filtered = features.contains("device.features") && (message["dshDesktop"] == nil || features.contains("agent.openclaw") && !admittedOpenClaw ||
               features.contains(Self.agentEnablementFeature) && !readyAdmitsAgentEnablement(message) ||
               features.contains(agentDialReviewFeature) && !readyAdmitsAgentDialReview(message) ||
               features.contains(agyFeature) && !readyAdmitsAgy(message) ||
               features.contains("agent.kimiCode") && !(message["deviceFeatures"] as? [String] ?? []).contains("agent.kimiCode") ||
               features.contains("agent.kimiCodeDesktop") && !(message["deviceFeatures"] as? [String] ?? []).contains("agent.kimiCodeDesktop") ||
               features.contains(codexUnifiedHistoryFeature) && !admittedCodex || features.contains(runtimeCloseFeature) && !admittedClose ||
               features.contains(runtimeViewCloseFeature) && !(message["deviceFeatures"] as? [String] ?? []).contains(runtimeViewCloseFeature))
            if filtered, message["_orbisFilteredFallback"] == nil {
                if filteredReady != nil { return }
                let requested = deviceAgentFeatures(message)
                if transport.send(["type": "device.features", "protocolVersion": orbisProtocolVersion, "features": requested]) {
                    let id = UUID()
                    filteredReady = (id, message, channel)
                    Task { [weak self] in
                        do { try await Task.sleep(for: .seconds(5)) } catch { return }
                        guard let self, let pending = self.filteredReady, pending.id == id else { return }
                        var fallback = pending.message; fallback["_orbisFilteredFallback"] = true
                        await self.receive(fallback, channel: pending.channel)
                    }
                    return
                }
            }
            filteredReady = nil
            let management = readyAdmitsAgentEnablement(message)
            if management {
                if !agentEnablementAvailable { agentEnablementAvailable = true }
                agentDialScoped = readyAdmitsAgentDialReview(message)
                if !agentDialSynchronized && agentDialNotice?.status != "readFailed" { refreshAgentEnablement() }
            } else if agentEnablementAvailable || agentDialCached != nil { resetAgentEnablement(keepDialCache: false) }
            let previousDisplayVersion = expectedMessageDisplayVersion
            // The Host advertises the rich projection on its ready message; older Hosts keep the
            // released display version, and the filtered (non-`dshDesktop`) view never carries it.
            expectedMessageDisplayVersion = !supportsRender ? legacyDisplayProjectionVersion :
                (message["dshDesktop"] == nil ? nil : messageDisplayProjectionVersion)
            let displayVersionChanged = previousDisplayVersion != expectedMessageDisplayVersion
            let admittedAgy = readyAdmitsAgy(message)
            let projectionChanged = agyNegotiated != admittedAgy || openClawNegotiated != admittedOpenClaw || unifiedCodexHistory != admittedCodex
            openClawNegotiated = admittedOpenClaw
            agyNegotiated = admittedAgy
            unifiedCodexHistory = admittedCodex
            if projectionChanged { openClawBackendAdvice = nil; hostState.invalidateBackendProjection() }
            let catalogWasConnected = hostState.connected
            historyWindowSupported = false
            historyInterest = HistoryWindowInterest()
            let capabilityRequest = connectionRequestId()
            historyWindowRequestId = capabilityRequest
            _ = transport.send(["type": "session.history.capabilities.request", "protocolVersion": orbisProtocolVersion,
                "requestId": capabilityRequest])
            let next: [RuntimeSummary] = values.compactMap(jsonDecode)
            guard next.count == values.count, Set(next.map(\.runtimeId)).count == next.count else {
                recordConnectionEvent("catalog.decode_failed"); hostState.refresh(["catalog"]); return
            }
            hostState.setConnection(selectedHost, connected: true)
            if catalogWasConnected {
                hostState.negotiateCatalogReadFormat()
                if projectionChanged { hostState.refresh(force: true) }
            }
            agentState.setConnection(selectedHost, connected: true)
            notifications.setConnection(selectedHost, connected: true)
            guard hostState.beginEpoch(message["modelEpoch"] as? String), agentState.beginEpoch(message["modelEpoch"] as? String) else { return }
            let modelEpoch = message["modelEpoch"] as? String
            runtimeCloseNegotiated = admittedClose
            let hostRestarted = modelEpoch != nil && authenticatedModelEpoch != nil && modelEpoch != authenticatedModelEpoch
            if let modelEpoch { authenticatedModelEpoch = modelEpoch }
            importReady = (message["hostFeatures"] as? [String])?.contains("external-import.target-v1") == true
            homeDirectoryReceived = true
            // Older empty directories cannot retire an APNs alert that arrived
            // during the handshake; the next ready/inventory can reconcile it.
            notificationDirectoryConfirmedAt = filtered ? nil : notificationConnectionStartedAt
            notificationOfflineRuntimes = []
            let selectedLeafChanged = next.first(where: { $0.runtimeId == selectedRuntimeId }).map { next in
                runtimes.first(where: { $0.runtimeId == next.runtimeId })?.sessionLeafId != next.sessionLeafId
            } ?? false
            if hostRestarted {
                openClawBackendAdvice = nil
                setHistoryConnection(false); clearSyncs(); sourcePositions = [:]; appliedBaselines = [:]
            }
            for runtime in next {
                let previous = runtimes.first { $0.runtimeId == runtime.runtimeId }
                if previous?.sessionId != runtime.sessionId || previous?.codexCatalogId != runtime.codexCatalogId {
                    invalidateConversation(runtime.runtimeId)
                }
            }
            runtimes = next.map(reprojectRuntime)
            // 新连接的首个 device.ready 是因果晚于旧连接上所有操作的完整在线列表（L2、L5）。
            ledgerOpenConnection()
            reconcileRuntimeLaunches(complete: true)
            conversations = conversations.filter { id, _ in next.contains { $0.runtimeId == id } }
            runtimeEventSequences = [:]
            if selectedRuntime == nil { selectedRuntimeId = restoredRuntimeId() ?? runtimes.first?.runtimeId }
            if let selectedRuntime { saveLastSession(selectedRuntime) }
            setHistoryConnection(true)
            connection = .secured
            for condition in FeedbackCondition.allCases { feedback.resolve(condition) }
            if sessionLaunchErrorAwaitsConnection { sessionLaunchError = nil }
            if browse?.error == L10n.tr("未连接到电脑，连接恢复后可重试。") { browse = nil }
            hostState.setConnection(selectedHost, connected: true)
            agentState.setConnection(selectedHost, connected: true)
            notifications.setConnection(selectedHost, connected: true)
            transfers.setConnection(selectedHost, connected: true)
            supportedAgents = message["agents"] as? [String]
            launchableAgents = message["launchableAgents"] as? [String]
            sessionConfigurationSupported = message["sessionConfiguration"] as? Int == 1
            kimiCodeSupported = hasNegotiatedKimiCode(message)
            kimiCodeDesktopSupported = hasNegotiatedKimiCodeDesktop(message)
            defaultSessionSpawnMode = features.contains("session.spawn.auto") ? "auto" : "tui"
            recoverConfiguredLaunch()
            flushReadySends()
            codexDesktop = (message["codexDesktop"] as? [String: Any]).flatMap(jsonDecode).flatMap { $0.valid ? $0 : nil }
            notifications.ready(epoch: message["notificationEpoch"] as? String, runtimes: runtimes)
            let noticeEpoch = notifications.hostEpoch
            handleLedger(ledger.expire { op in
                if case .dismiss(_, let epoch, _) = op.payload { return epoch != noticeEpoch }
                return false
            })
            for runtime in runtimes { agentState.subscribe(runtime: runtime) }
            publishMessages()
            if let selectedRuntime { seedCachedHistory(selectedRuntime); publishMessages(); agentState.subscribe(runtime: selectedRuntime); syncSession(selectedRuntime, force: hostRestarted || selectedLeafChanged || displayVersionChanged) }
            refreshSessions()
        case "runtime.online":
            if let object = message["runtime"] as? [String: Any], let incoming: RuntimeSummary = jsonDecode(object) {
                notificationOfflineRuntimes.remove(incoming.runtimeId)
                let runtime = reprojectRuntime(incoming)
                if let index = runtimes.firstIndex(where: { $0.runtimeId == runtime.runtimeId }) {
                    if runtimes[index].sessionId != runtime.sessionId { invalidateConversation(runtime.runtimeId) }
                    runtimes[index] = runtime
                } else { runtimes.append(runtime) }
                let landed = reconcileRuntimeLaunches(complete: false)
                if !landed && launching == nil && pendingActivation == runtime.sessionId && pendingActivation != nil {
                    if let session = runtime.sessionId, let text = pendingBranchDrafts.removeValue(forKey: offlineSessionKey(host: selectedHost, sessionId: session)) { saveDraft(text, for: runtime) }
                    clearActivation(); selectedRuntimeId = runtime.runtimeId; activationRevision += 1
                } else if !landed && selectedRuntimeId == nil { selectedRuntimeId = runtime.runtimeId }
                publishMessages()
                agentState.subscribe(runtime: runtime); notifications.online(runtime)
                if runtime.runtimeId == selectedRuntimeId { syncSession(runtime) }
            }
        case "runtime.offline":
            if let id = message["runtimeId"] as? String {
                // Adapter loss is not proof that an outstanding request ended.
                if runtimeIndex[id] != nil { notificationOfflineRuntimes.insert(id) }
                pendingSends.runtimeLost(runtimeId: id, sessionId: runtimes.first { $0.runtimeId == id }?.sessionId)
                runtimes.removeAll { $0.runtimeId == id }
                ledgerAuthority(OperationKinds.runtimesDomain, read: nil, complete: false)
                notifications.offline(runtimeId: id)
                invalidateConversation(id)
                if selectedRuntimeId == id { selectedRuntimeId = runtimes.first?.runtimeId }
                sendHistoryInterest()
                publishMessages()
                if let selectedRuntime { agentState.subscribe(runtime: selectedRuntime); syncSession(selectedRuntime) }
            }
        case "runtime.event": enqueueRuntimeEvent(message, channel: channel, payload: payload, ownership: ownership)
        case "session.list.result":
            guard !modelCatalogReceived else { return }
            guard let request = sessionListRequest, message["requestId"] as? String == request else { return }
            sessionListRequest = nil
            if let values = message["sessions"] as? [[String: Any]] {
                let generation = connectionGeneration
                let decoded = await sessionCatalogWorker.decode(values)
                guard !Task.isCancelled, generation == connectionGeneration else { return }
                await queueSessionCatalog(decoded, replacing: true).value
                guard !Task.isCancelled, generation == connectionGeneration else { return }
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
            guard var current = browse, current.loading, message["requestId"] as? String == current.requestId,
                  let path = message["path"] as? String, let rows = message["entries"] as? [[String: Any]] else { return }
            let entries: [BrowseEntry] = rows.compactMap(jsonDecode)
            guard entries.count == rows.count else { return }
            browseTimeout?.cancel()
            // FILE-BROWSER-02: only the connection that accepts this download listing can save it.
            if current.forDownload && current.rememberPath, let hostId = selectedHostId { downloadBrowserPaths.remember(path, hostId: hostId) }
            current.path = path
            current.parent = message["parent"] as? String
            current.entries = entries
            current.loading = false
            browse = current
        case "session.configuration.result":
            guard let request = sessionConfigurationRequest, message["requestId"] as? String == request,
                  let snapshot: SessionConfigurationSnapshot = jsonDecode(message) else { return }
            if let cwd = openClawConfigurationCwd, snapshot.agentKind != "openclaw" || snapshot.cwd != cwd { return }
            configurationTimeout?.cancel(); openClawConfigurationCwd = nil
            sessionConfiguration = snapshot; proposedSessionConfiguration = nil; sessionConfigurationRequest = nil; sessionConfigurationError = nil
        case "session.launch.result":
            let journal = launchJournal
            guard let id = message["launchId"] as? String, journal.acceptsResult(for: id), let record = journal.snapshot(id),
                  supportsKimiCode(kind: record["agentKind"] as? String, id: record["sessionId"] as? String, web: kimiCodeSupported, desktop: kimiCodeDesktopSupported) else { return }
            if launch(id) == nil { restoreConfiguredLaunch(record, id: id, show: false) }
            switch message["phase"] as? String {
            case "ready":
                guard let sessionId = message["sessionId"] as? String, !sessionId.isEmpty,
                      record["sessionId"] == nil || record["sessionId"] as? String == sessionId else { return }
                var saved = record; saved["sessionId"] = sessionId
                let generation = connectionGeneration
                guard let persisted = writeLaunchJournal(saved), await persisted.value,
                      !Task.isCancelled, generation == connectionGeneration, journal.acceptsResult(for: id),
                      var acknowledged = launch(id) else { return }
                acknowledged.sessionId = sessionId
                acknowledged.unconfirmed = false; acknowledged.failure = nil
                updateLaunch(acknowledged)
                bindLaunchSession(acknowledged, sessionId: sessionId)
                handleLedger(ledger.written(id, now: Date()))
                handleLedger(ledger.receipt(id, connection: ledger.connection, .succeeded, now: Date()))
                reconcileRuntimeLaunches(complete: false)
                publishMessages()
                if let runtime = selectedRuntime, runtime.sessionId == sessionId, runtime.runtimeId != acknowledged.placeholder { syncSession(runtime) }
            case "absent":
                guard record["sessionId"] == nil else { markConfiguredLaunchUnconfirmed(id); return }
                let wireKeys: Set<String> = ["type", "protocolVersion", "requestId", "launchId", "agentKind", "cwd", "binding", "revision", "values", "spawnMode", "codexLaunchMode"]
                let generation = connectionGeneration
                guard let persisted = writeLaunchJournal(record), await persisted.value,
                      !Task.isCancelled, generation == connectionGeneration, journal.acceptsResult(for: id),
                      journal.snapshot(id)?["sessionId"] == nil else { return }
                if supportsKimiCode(kind: record["agentKind"] as? String, id: record["sessionId"] as? String, web: kimiCodeSupported, desktop: kimiCodeDesktopSupported) { _ = transport.send(record.filter { wireKeys.contains($0.key) }) }
            case "failed":
                let error = message["error"] as? String ?? L10n.tr("配置未确认")
                guard let write = journal.reject(id, error: error) else { return }
                let persisted = await write.value
                guard launchJournal === journal, journal.snapshot(id) != nil else { return }
                guard persisted else { markConfiguredLaunchUnconfirmed(id, reason: L10n.tr("无法保存启动恢复记录，请重试")); return }
                if var rejected = launch(id) {
                    rejected.rejected = true; rejected.unconfirmed = false; rejected.failure = error
                    updateLaunch(rejected)
                }
                handleLedger(ledger.written(id, now: Date()))
                handleLedger(ledger.receipt(id, connection: ledger.connection, .failed(AppLedger.Rejection("configuration_rejected", error)), now: Date()))
                if activationRequestId == id { clearActivation() }
            case "unknown": markConfiguredLaunchUnconfirmed(id, reason: message["error"] as? String)
            default: break
            }
        case "session.activated":
            if let id = message["requestId"] as? String, let sessionId = message["sessionId"] as? String {
                if var acknowledged = launch(id) {
                    guard !acknowledged.configured else { return }
                    if let expected = acknowledged.resumed, expected.hasPrefix("codex-history:"), message["codexCatalogId"] as? String != expected { return }
                    if launching?.requestId == id { pendingActivation = sessionId; activatingSessionId = sessionId }
                    acknowledged.sessionId = sessionId
                    updateLaunch(acknowledged)
                    bindLaunchSession(acknowledged, sessionId: sessionId)
                    handleLedger(ledger.receipt(id, connection: ledger.connection, .succeeded, now: Date()))
                    reconcileRuntimeLaunches(complete: false)
                    publishMessages()
                    if let runtime = selectedRuntime, runtime.sessionId == sessionId, runtime.runtimeId != acknowledged.placeholder { syncSession(runtime) }
                } else if id == activationRequestId, launchJournal.snapshot(id) == nil {
                    pendingActivation = sessionId; activatingSessionId = sessionId
                    if let runtime = runtimes.first(where: {
                        runtimeMatchesLaunch($0, sessionId: sessionId, codexCatalogId: message["codexCatalogId"] as? String,
                                             launchMode: nil, agentKind: message["agentKind"] as? String)
                    }) {
                        clearActivation(); selectRuntime(runtime.runtimeId); activationRevision += 1
                    }
                }
            }
        case "session.archive.changed":
            // 同一 requestId 的变更通知即这次归档的成功回执（ADR-0049 §7.5）。
            if let requestId = message["requestId"] as? String, ledger.operation(requestId) != nil {
                handleLedger(ledger.receipt(requestId, connection: ledger.connection, .succeeded, now: Date()))
            }
            refreshSessions()
        case "protocol.error":
            if let id = message["requestId"] as? String, id.hasPrefix("agent-enablement:") {
                if channel != nil { rejectAgentDial(message) }
                return
            }
            if let result = menuOptions.consume(message) {
                menuOptionsTimeout?.cancel()
                menuErrors[result.runtimeId + "\u{0}" + result.name] = L10n.tr("命令选项读取失败，请重新打开菜单")
                return
            }
            let commandId = message["commandId"] as? String
            if commandId?.hasPrefix("session-sync-ack:") == true { return }
            // SC91：例如旧 Host 对已被替换的能力探测迟到回应 invalid_request（设计规范 F0 静默）。
            if isStaleConnectionError(message) { return }
            if message["code"] as? String == "session_sync_device_rejected", let commandId,
               handledSyncRejections.contains(commandId) { return }
            if rejectCorrelatedProtocolOperation(message) { return }
            recordConnectionEvent("protocol.error.unowned: " + String(describing: message))
        default:
            // A known reader may decline a late, disconnected or out-of-scope
            // reply. Its missing owner does not make the wire type unknown.
            if ["session.catalog.capabilities", "session.history.capabilities", "session.history.interest.result", "session.catalog.page", "agent.menu.options.page",
                "agent.state.snapshot", "agent.state.range.page", "provider.subscription.result", "provider.result", "provider.changed", "diagnostics.page"].contains(type) {
                recordConnectionEvent("reply.unowned: " + type)
            } else {
                recordConnectionEvent("unknown_message: " + type); connectionFeedback(.version)
            }
        }
    }

    private func consumeEvent(_ wireEnvelope: [String: Any], channel: String?, rawEnvelope wirePayload: Data?) async {
        guard let runtimeId = wireEnvelope["runtimeId"] as? String, runtimes.contains(where: { $0.runtimeId == runtimeId }) else { return }
        let generation = historyGeneration, worker = sharedSessionContent
        let source = sourcePositions[runtimeId], branch = branchGenerations[runtimeId] ?? 0
        let prepared: PreparedSessionEnvelope
        do { prepared = try await worker.expand(wireEnvelope, payload: wirePayload, epoch: source?.epoch, seq: source?.seq) }
        catch {
            guard !Task.isCancelled, generation == historyGeneration, branch == branchGenerations[runtimeId] ?? 0 else { return }
            if let syncId = (wireEnvelope["event"] as? [String: Any])?["syncId"] as? String {
                rejectSnapshot(syncId, runtimeId: runtimeId, message: L10n.tr("历史内容基准已失效，正在重新同步。"))
            }
            if let runtime = runtimes.first(where: { $0.runtimeId == runtimeId }) { syncSession(runtime, force: true) }
            return
        }
        guard !Task.isCancelled, generation == historyGeneration, branch == branchGenerations[runtimeId] ?? 0 else { return }
        let envelope = prepared.message, rawEnvelope: Data? = prepared.payload
        guard let event = envelope["event"] as? [String: Any], let type = event["type"] as? String else { return }
        let changesHome = ["runtime.metadata", "runtime.status", "interaction.requested", "interaction.snapshot",
                           "interaction.resolved", "interaction.cancelled"].contains(type)
        defer { if changesHome { commitHomePresentation() } }
        if let sequence = integer(envelope["sequence"]) {
            let key = "\(runtimeId)\u{0000}\(channel ?? "ctl")"
            if sequence <= (runtimeEventSequences[key] ?? -1) { return }
            runtimeEventSequences[key] = sequence
        }
        await turnFileChanges.consume(event, runtimeId: runtimeId)
        guard !Task.isCancelled, generation == historyGeneration, branch == branchGenerations[runtimeId] ?? 0 else { return }
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
        if type == "interaction.requested", let raw = event["request"] as? [String: Any], let request = decodeInteraction(raw), request.runtimeId == runtimeId {
            var current = interactions[runtimeId] ?? []
            current.removeAll { $0.requestId == request.requestId }; current.append(request)
            replaceInteractions(runtimeId, with: current)
            ledgerAuthority(OperationKinds.interactionsDomain(runtimeId), read: nil, complete: false); return
        }
        if type == "interaction.snapshot" {
            let requests = (event["requests"] as? [[String: Any]] ?? []).compactMap(decodeInteraction)
            replaceInteractions(runtimeId, with: requests.filter { $0.runtimeId == runtimeId })
            ledgerAuthority(OperationKinds.interactionsDomain(runtimeId), read: nil, complete: true)
            return
        }
        if type == "interaction.resolved" || type == "interaction.cancelled", let requestId = event["requestId"] as? String {
            interactions[runtimeId]?.removeAll { $0.requestId == requestId }
            setInteractionResponseError(nil, runtimeId: runtimeId, requestId: requestId)
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
                let owned: String? = ["status": "execution", "model": "model", "thinkingLevel": "model",
                    "currentTurnConfiguration": "model", "currentTurnConfigurationSupported": "model", "modelSelection": "model",
                    "contextUsage": "context", "permissionManagement": "permissions"][key]
                return owned.map { !agentState.owns($0, runtimeId: runtimeId) } ?? true
            }
            let next = reprojectRuntime(mergeRuntime(previous, metadata: fields))
            runtimes[index] = next
            if fields["model"] != nil || fields["thinkingLevel"] != nil { ledgerAuthority(OperationKinds.modelDomain(runtimeId), read: nil, complete: true) }
            if previous.sessionId != next.sessionId || previous.codexCatalogId != next.codexCatalogId {
                invalidateConversation(runtimeId)
                let previousSelection = selectedRuntimeId
                let landed = reconcileRuntimeLaunches(complete: false)
                notifications.online(next)
                agentState.subscribe(runtime: next)
                if runtimeId == selectedRuntimeId || (landed && selectedRuntimeId != previousSelection) {
                    if let runtime = selectedRuntime { syncSession(runtime) }
                }
                publishMessages()
            } else if previous.sessionLeafId != next.sessionLeafId, runtimeId == selectedRuntimeId {
                syncSession(next, force: true)
            }
            return
        }
        if type == "runtime.error" || (type == "command.result" && event["ok"] as? Bool == false) {
            recordConnectionEvent(type + ": " + (event["error"] as? String ?? event["message"] as? String ?? ""))
            if let commandId = event["commandId"] as? String, let syncId = pendingSyncs.first(where: { $0.value.commandId == commandId && $0.value.runtimeId == runtimeId })?.key {
                let pending = pendingSyncs[syncId]; finishSync(syncId, readPhase: .failed)
                if pending?.range == "history" {
                    if pending?.historyPrefetch == nil { historyErrors[runtimeId] = FeedbackText.reason(event["error"] as? String ?? event["message"] as? String ?? L10n.tr("历史读取失败，请重试。")) }
                    return
                }
            }
            recordConnectionEvent("runtime.error.unowned: " + String(describing: event))
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
            await applySnapshot(event, runtimeId: runtimeId, rawEnvelope: rawEnvelope,
                fingerprint: prepared.snapshotFingerprint, responseBytes: prepared.snapshotWireBytes ?? 65536)
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
                guard await applyProjection(event, runtimeId: runtimeId) else { return }
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

    /// `fingerprint` is `sessionSnapshotFingerprint(event)`, prepared off the UI actor (PERF-10).
    private func applySnapshot(_ event: [String: Any], runtimeId: String, rawEnvelope: Data?, fingerprint: String?, responseBytes: Int) async {
        let generation = historyGeneration
        guard let syncId = event["syncId"] as? String else { return }
        let pending = pendingSyncs[syncId]
        if pending == nil, let receipt = snapshotReceipts[syncId], receipt.runtimeId == runtimeId,
           receipt.sessionId == event["sessionId"] as? String,
           runtimes.first(where: { $0.runtimeId == runtimeId })?.sessionId == receipt.sessionId,
           fingerprint == receipt.fingerprint {
            acknowledge(runtimeId: runtimeId, syncId: syncId, result: "applied"); return
        }
        if pending == nil, toolAcknowledgements[syncId]?.runtimeId == runtimeId,
           let candidate = snapshotCandidates[syncId], candidate.runtimeId == runtimeId,
           candidate.sessionId == event["sessionId"] as? String,
           runtimes.first(where: { $0.runtimeId == runtimeId })?.sessionId == candidate.sessionId,
           fingerprint == candidate.fingerprint { return }
        guard pending?.runtimeId == runtimeId, pending?.sessionId == event["sessionId"] as? String,
              let runtime = runtimes.first(where: { $0.runtimeId == runtimeId }), runtime.sessionId == pending?.sessionId else {
            acknowledge(runtimeId: runtimeId, syncId: syncId, result: "rejected")
            return
        }
        guard let pending else { return }
        if let budget = pending.historyPrefetch, responseBytes > budget.nextMaxBytes {
            rejectSnapshot(syncId, runtimeId: runtimeId, message: "history_window_byte_limit"); return
        }
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
        if let fingerprint {
            snapshotCandidates[syncId] = SessionSnapshotReceipt(runtimeId: runtimeId, sessionId: pending.sessionId, fingerprint: fingerprint)
        }
        if event["selection"] as? String == "unchanged" {
            guard let known = pending.known, let applied = appliedBaselines[runtimeId], applied.epoch == known.epoch,
                  applied.seq >= known.seq, applied.seq > known.seq || applied.leaf == known.leaf else {
                rejectSnapshot(syncId, runtimeId: runtimeId, message: L10n.tr("会话已应用状态发生变化，请重试。"))
                return
            }
            if let host = selectedHost, let page = try? await historyWorker.page(host: host, sessionId: pending.sessionId, cacheId: runtime.codexCatalogId, limit: 30), generation == historyGeneration {
                finishSync(syncId, readPhase: nil)
                completeRemoteRead(syncId, runtime: runtime, page: page, sourceConfirmed: true)
                acknowledge(runtimeId: runtimeId, syncId: syncId, result: "applied")
                if pending.range == "preview" { startAutomaticHistoryPrefetch(runtime) }
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
                historyErrors[runtimeId] = L10n.tr("会话工具清单的归属或版本无效，请刷新重试。"); return
            }
            dependency = reference
        }
        if let status = event["rangeStatus"] as? String, !["complete", "older_available", "limit_reached"].contains(status) {
            if pending.historyPrefetch == nil { historyErrors[runtimeId] = L10n.tr("历史范围不可用，请刷新会话后重试。") }
            finishSync(syncId, readPhase: .failed); acknowledge(runtimeId: runtimeId, syncId: syncId, result: "rejected"); return
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
                  let persistedBoundary = try? await historyWorker.entry(host: host, sessionId: pending.sessionId,
                    cacheId: runtime.codexCatalogId, entryId: boundary),
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
                  let page = try? await historyWorker.page(host: host, sessionId: pending.sessionId, cacheId: runtime.codexCatalogId,
                    leafId: pending.leaf, beforeEntryId: pending.boundary, limit: max(1, entries.count)),
                  generation == historyGeneration else { return }
            guard page.displayComplete, [.complete, .olderAvailable].contains(page.status) else {
                rejectSnapshot(syncId, runtimeId: runtimeId, message: L10n.tr("历史范围或显示结果不完整，请重试。")); return
            }
            if pending.historyPrefetch != nil, let operation = syncReads[syncId] {
                sessionReads.recordPrefetchResponse(operation, entries: page.entries.count,
                    jsonBytes: responseBytes, attempts: pending.attempts)
                if let updated = sessionReads.operations[operation]?.historyPrefetch {
                    automaticHistoryProgress[updated.scopeId] = updated
                }
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
                  let page = try? await historyWorker.page(host: host, sessionId: pending.sessionId, cacheId: runtime.codexCatalogId, leafId: target, limit: 1),
                  generation == historyGeneration else { return }
            finishSync(syncId, readPhase: nil)
            acknowledge(runtimeId: runtimeId, syncId: syncId, result: "applied")
            completeRemoteRead(syncId, runtime: runtime, page: page)
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
        if !committed.displayChanged, let source = event["source"] as? [String: Any], source["epoch"] as? String == sourcePositions[runtimeId]?.epoch,
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
        guard await applyProjection(event, runtimeId: runtimeId) else { return }
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
                if pending.range == "preview" { startAutomaticHistoryPrefetch(runtime) }
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
            if pending.range == "preview" { startAutomaticHistoryPrefetch(runtime) }
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
        if range == "history" {
            if pending.historyPrefetch == nil { historyErrors[runtimeId] = FeedbackText.reason(message) }
        } else { historyErrors[runtimeId] = FeedbackText.reason(message) }
    }

    private func commitHistory(_ event: [String: Any], runtime: RuntimeSummary, activate: Bool, rawEnvelope: Data?) async -> SessionHistoryCommit? {
        guard let host = selectedHost, let sessionId = runtime.sessionId,
              let data = rawEnvelope ?? (try? JSONSerialization.data(withJSONObject: event)) else { return nil }
        let generation = historyGeneration
        let branchGeneration = branchGenerations[runtime.runtimeId] ?? 0
        let lease = historyWriteLeases[runtime.runtimeId] ?? SessionHistoryWriteLease()
        historyWriteLeases[runtime.runtimeId] = lease
        do {
            let committed = try await historyWorker.ingest(host: host, sessionId: sessionId, cacheId: runtime.codexCatalogId, event: data, wrapped: rawEnvelope != nil,
                activate: activate, generation: generation, lease: lease, expectedEpoch: activate ? nil : sourcePositions[runtime.runtimeId]?.epoch, limit: 256)
            let incomingIds = ((event["display"] as? [String: Any])?["entries"] as? [[String: Any]] ?? []).compactMap { $0["entryId"] as? String }
            let displayedIds = Array(displayMessageIds[runtime.runtimeId]?.keys ?? Dictionary<String, String>().keys)
            let excluded = try await historyWorker.excludedDisplayEntries(host: host, sessionId: runtime.codexCatalogId ?? sessionId, entryIds: displayedIds + incomingIds)
            guard generation == historyGeneration, branchGeneration == branchGenerations[runtime.runtimeId] ?? 0,
                  historyConnected, runtimes.contains(where: { $0.runtimeId == runtime.runtimeId && $0.sessionId == sessionId && $0.codexCatalogId == runtime.codexCatalogId }) else { return nil }
            let storageId = runtime.directorySessionId ?? sessionId
            excludedDisplayEntries[storageId] = excluded
            let hiddenMessages = Set(excluded.compactMap { displayMessageIds[runtime.runtimeId]?[$0] })
            conversations[runtime.runtimeId]?.removeAll { hiddenMessages.contains($0.messageId) }
            graphs[storageId] = committed.graph
            cachedSessionIds.insert(storageId)
            if committed.epochChanged { timingsBySession[storageId] = [:] }
            for timing in committed.turnTimings { timingsBySession[storageId, default: [:]][timing.turnId] = timing }
            rememberReplyNotificationCompletions(committed.turnTimings.compactMap { timing in
                guard timing.durationMs != nil else { return nil }
                return ReplyNotificationCleanup.Turn(runtime: runtime.runtimeId, session: sessionId, id: timing.turnId, startedAt: timing.startedAt)
            })
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
              let runtime = runtimes.first(where: { $0.runtimeId == runtimeId }),
              let sessionId = runtime.sessionId,
              (head["leafId"] as? String).map({ graphs[runtime.directorySessionId ?? sessionId]?.entries[$0] != nil }) ?? true else { return nil }
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

    private func applyProjection(_ event: [String: Any], runtimeId: String) async -> Bool {
        let generation = historyGeneration, contentWorker = sharedSessionContent
        let branch = branchGenerations[runtimeId] ?? 0
        guard let runtime = runtimes.first(where: { $0.runtimeId == runtimeId }), let session = runtime.sessionId else { return false }
        let storageId = runtime.directorySessionId ?? session
        // Local history hydration can finish while a source projection is being prepared. Rebase
        // on that newer immutable input; never publish an array captured before the cache page.
        while !Task.isCancelled {
            let revision = projectionInputRevision
            let input = SessionChatProjectionInput(event: event, graph: graphs[storageId],
                excludedEntries: excludedDisplayEntries[storageId] ?? [], messages: conversations[runtimeId] ?? [],
                displayIds: displayMessageIds[runtimeId] ?? [:], aliases: messageAliases[runtimeId] ?? [:],
                liveIds: liveMessageIds[runtimeId] ?? [], unfinishedIds: unfinishedLiveMessageIds[runtimeId] ?? [],
                orders: liveOrders[runtimeId] ?? [:])
            let prepared = await sessionProjectionWorker.resolve(input)
            guard generation == historyGeneration, branch == branchGenerations[runtimeId] ?? 0,
                  runtimes.contains(where: { $0.runtimeId == runtimeId && $0.sessionId == session }) else { return false }
            if revision != projectionInputRevision { continue }
            let next = prepared.state
            conversations[runtimeId] = next.messages
            // The existing worker compares the mapping off MainActor. Ordinary text chunks
            // retain it, so they neither compare every Host map here nor rebuild rewind options.
            if prepared.displayIdsChanged { displayMessageIds[runtimeId] = next.displayIds }
            messageAliases[runtimeId] = next.aliases
            liveMessageIds[runtimeId] = next.liveIds
            unfinishedLiveMessageIds[runtimeId] = next.unfinishedIds
            liveOrders[runtimeId] = next.orders
            if let reference = prepared.toolReference, reference.agent.hostId == selectedHostId,
               reference.agent.sessionId == session {
                toolInventories.require(reference, runtime: runtimeId)
                if liveToolReferences[runtimeId] != reference { liveToolReferences[runtimeId] = reference }
            } else if prepared.hasLive { liveToolReferences[runtimeId] = nil; liveTools[runtimeId] = nil }
            await contentWorker.remember(event, runtime: runtimeId)
            guard !Task.isCancelled, generation == historyGeneration,
                  branch == branchGenerations[runtimeId] ?? 0 else { return false }
            let turn = ((event["live"] as? [String: Any])?["turn"] as? [String: Any])
            if let turnId = turn?["turnId"] as? String, !turnId.isEmpty, turnId.utf16.count <= 256,
               let startedAt = integer(turn?["startedAt"]), turn?["outcome"] as? String == "completed",
               (event["source"] as? [String: Any])?["ready"] as? Bool == true,
               (event["live"] as? [String: Any])?["complete"] as? Bool == true {
                rememberReplyNotificationCompletions([.init(runtime: runtimeId, session: session, id: turnId, startedAt: startedAt)])
            }
            if replyCompletions.consume(event, sessionId: session) {
                notificationCleanupChanged.send()
                #if canImport(UIKit) && canImport(UserNotifications)
                if preferences != nil, !(historyWindowVisible && selectedRuntimeId == runtimeId),
                   let hostId = selectedHostId, let pairing = pairings.first(where: { $0.hostId == hostId }),
                   let turnId = turn?["turnId"] as? String,
                   let epoch = (event["source"] as? [String: Any])?["epoch"] as? String,
                   let runtime = runtimes.first(where: { $0.runtimeId == runtimeId }) {
                    ReplyCompletionNotifications.shared.post(hostId: hostId, pairingKey: PushNotificationIdentity.pairingKey(pairing),
                        sessionId: session, epoch: epoch, turnId: turnId, title: displayName(runtime))
                }
                #endif
            }
            return true
        }
        return false
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
        let trace = ChatSchedulingTrace.deltaBegan()
        defer { ChatSchedulingTrace.deltaEnded(trace) }
        while content.count <= index { content.append(ChatContent(type: kind, text: "", toolName: nil, artifact: nil)) }
        let item = content[index]
        content[index] = ChatContent(type: item.type, text: (item.text ?? "") + delta, toolName: item.toolName, artifact: item.artifact, summary: item.summary, toolCallId: item.toolCallId,
            truncated: item.truncated, originalBytes: item.originalBytes, arguments: item.arguments, renderKind: item.renderKind, file: item.file)
        upsert(ChatMessage(messageId: id, role: previous?.role ?? "assistant", content: content,
            timestamp: previous?.timestamp ?? Int64(Date().timeIntervalSince1970 * 1000), isError: previous?.isError,
            toolSummary: previous?.toolSummary, toolCallId: previous?.toolCallId, toolName: previous?.toolName), runtimeId: runtimeId)
    }

    private func publishMessages() {
        reconcilePendingSends()
        guard let runtimeId = selectedRuntimeId else { messages = []; streamingMessageIds = []; updateSyncing(); return }
        let visibleTimings = selectedRuntime?.directorySessionId.flatMap { timingsBySession[$0] } ?? [:]
        if visibleTimings != turnTimings { turnTimings = visibleTimings }
        // 清单尚未追上本次投影时沿用上一次已确认的工具，避免卡片闪烁或用旧清单造出重复卡片。
        if let reference = liveToolReferences[runtimeId], toolInventories.covers(reference, runtime: runtimeId) {
            liveTools[runtimeId] = toolInventories.visible[runtimeId] ?? []
        }
        let identity = currentTranscriptIdentity
        let pending = pendingSends.chatRows(sessionId: selectedRuntime?.sessionId, runtimeId: selectedRuntime?.runtimeId)
        committingTranscript = true
        if renderedTranscriptIdentity != identity {
            let cached = cachedPublications[identity]
            // A canonical array is already immutable. Switching to a conversation without
            // local overlays/tools can publish that array in O(1), including newer background
            // messages; prepared row/layout data follows from the worker.
            messages = (liveTools[runtimeId]?.isEmpty ?? true) && pending.isEmpty
                ? (conversations[runtimeId] ?? []) : (cached?.messages ?? [])
            chatTranscript = cached?.transcript ?? .empty
            streamingMessageIds = cached?.streaming ?? []
            visibleMessageIds = cached?.messageIds ?? []
            renderedTranscriptIdentity = identity
            renderedMessageToken = nil
        }
        let added = pending.filter { !visibleMessageIds.contains($0.messageId) }
        if !added.isEmpty {
            // ADR-0049: accepted local input appears immediately. Only these new local rows
            // are inserted here; full tool/history derivation remains on the serial worker.
            messages = PendingSendOutbox.merge(messages, pending: added)
            visibleMessageIds.formUnion(added.map(\.messageId))
            renderedMessageToken = nil
        }
        committingTranscript = false
        // Publishing an identical transcript would re-render the whole chat for nothing; the
        // comparison is O(1) when the array storage is unchanged.
        scheduleTranscript(ChatPublicationInput(messages: conversations[runtimeId] ?? [], timings: turnTimings,
            tools: liveTools[runtimeId] ?? [], orders: liveOrders[runtimeId] ?? [:],
            pending: pending,
            unfinished: unfinishedLiveMessageIds[runtimeId] ?? [], displayIds: displayMessageIds[runtimeId] ?? [:],
            aliases: messageAliases[runtimeId] ?? [:], requiresPendingMatch: true))
        commitHomePresentation()
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
        if selectedRuntimeId == runtimeId { transfers.browserPreview.close() }
        configFailures.removeValue(forKey: runtimeId)
        for setting in OperationKinds.configSettings { configSelections.removeValue(forKey: OperationKinds.configTarget(runtimeId: runtimeId, setting: setting)) }
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
        interactions[runtimeId] = nil; interactionErrors[runtimeId] = nil; interactionOutcomes[runtimeId] = nil
        commands[runtimeId] = nil; workingBranches[runtimeId] = nil
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
        let pending = pendingSyncs[syncId]
        let wasCatchup = pending?.range == "catchup"
        var phase = readPhase
        if let auto = pending?.historyPrefetch, phase != nil {
            let spent = auto.spendingFailedAttempts(pending?.attempts ?? 0)
            automaticHistoryProgress[spent.scopeId] = spent
            phase = .cancelled
        }
        if let phase, let read = syncReads.removeValue(forKey: syncId) { sessionReads.finish(read, phase: phase) }
        if pending?.range == "history", pending?.historyPrefetch == nil { historyLoading.remove(pending?.runtimeId ?? "") }
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
                if let read = syncReads[id] {
                    if let progress = task.historyPrefetch {
                        let spent = progress.spendingFailedAttempts(task.attempts)
                        automaticHistoryProgress[spent.scopeId] = spent
                        sessionReads.finish(read, phase: .cancelled)
                    } else { sessionReads.finish(read, phase: .failed, error: L10n.tr("同步暂未完成，请重试。")) }
                }
                if task.historyPrefetch == nil { historyLoading.remove(task.runtimeId) }
                if task.range == "history" {
                    if task.historyPrefetch == nil { historyErrors[task.runtimeId] = L10n.tr("历史读取暂未完成，请重试。") }
                } else if task.historyPrefetch == nil { historyErrors[task.runtimeId] = L10n.tr("会话同步暂未完成，请重试。") }
                armSyncTimeout(id, seconds: 150); continue
            }
            let delay: Double = task.attempts < 3 ? 30 : 60
            let attemptLimit = task.historyPrefetch?.maxAttempts ?? 4
            if task.attempts < attemptLimit, now.timeIntervalSince(task.sentAt) >= delay {
                _ = sendCommand(runtimeId: task.runtimeId, commandId: task.commandId, command: task.command)
                task.attempts += 1; task.sentAt = now; pendingSyncs[id] = task
            }
            armSyncTimeout(id, seconds: min(max(0.1, task.deadline.timeIntervalSince(now)), task.attempts < 3 ? 30 : 60))
        }
        updateSyncing()
    }

    private func integer(_ value: Any?) -> Int64? { sessionInteger(value) }

    private func decodeInteraction(_ value: [String: Any]) -> InteractionRequest? {
        guard let kind = value["kind"] as? String, !kind.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              kind.utf8.count <= 128 else { return nil }
        let supported = InteractionRequest.supportsKind(kind)
        let fields = supported ? value : value.filter { InteractionRequest.readOnlyFields.contains($0.key) }
        guard let request: InteractionRequest = jsonDecode(fields), request.hasDisplayIdentity,
              !supported || request.validForModel else { return nil }
        return request
    }

    private func jsonDecode<T: Decodable>(_ value: [String: Any]) -> T? {
        guard let data = try? JSONSerialization.data(withJSONObject: value) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }

    /// Directory announcements are transport metadata, not a replacement for committed model
    /// domains. A duplicate ready/online/metadata must not erase facts while the existing
    /// subscription is still active. Session replacement and Host epochs clear these baselines.
    private func reprojectRuntime(_ incoming: RuntimeSummary) -> RuntimeSummary {
        var runtime = incoming
        if runtime.agentKind == nil, runtime.runtimeId.hasPrefix("openclaw:") { runtime.agentKind = "openclaw" }
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
