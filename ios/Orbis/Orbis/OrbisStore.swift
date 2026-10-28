import Foundation
import Combine
#if canImport(UIKit)
import UIKit
#endif

@MainActor
final class OrbisStore: ObservableObject {
    let transfers: FileTransfers
    let toolContent = ToolContentReader()
    let toolInventories = ToolInventories()
    let hostState = HostState()
    @Published private(set) var pairings: [HostPairing] = []
    @Published private(set) var selectedHostId: String?
    @Published private(set) var runtimes: [RuntimeSummary] = []
    @Published private(set) var sessions: [SessionSummary] = [] {
        didSet { sessionIndex = Dictionary(sessions.map { ($0.sessionId, $0) }, uniquingKeysWith: { first, _ in first }) }
    }
    /// sessionId → 目录条目。聊天页每条消息、每次流式更新都会查询，不能线性扫描整个目录。
    private var sessionIndex: [String: SessionSummary] = [:]
    @Published private(set) var messages: [ChatMessage] = []
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
    private var browseTimeout: Task<Void, Never>?
    private var activationTimeout: Task<Void, Never>?
    private var activationRequestId: String?
    private var runtimeActions: [String: (runtimeId: String, name: String)] = [:]
    private var actionTimeouts: [String: Task<Void, Never>] = [:]
    private var previewTimeout: Task<Void, Never>?
    private var branchEditorNode: String?
    private var interactionCommands: [String: String] = [:]
    private var pendingBranchDrafts: [String: String] = [:]
    private var toolAcknowledgements: [String: (runtimeId: String, reference: ToolReference)] = [:]
    private var identity: DeviceIdentity?
    private var pairingTransport: RelayTransport?
    private var connectionGeneration = UUID()
    private var conversations: [String: [ChatMessage]] = [:]
    private var liveMessageIds: [String: Set<String>] = [:]
    // 宿主会从 live.messages 里去掉只含工具调用的消息，改由工具清单承载；这里记录还原它们所需的顺序和清单版本。
    private var liveOrders: [String: [String: Int64]] = [:]
    private var liveToolReferences: [String: ToolReference] = [:]
    private var liveTools: [String: [ToolSummary]] = [:]
    private var displayMessageIds: [String: [String: String]] = [:]
    private var runtimeEventSequences: [String: Int64] = [:]
    private var pendingSyncs: [String: (runtimeId: String, sessionId: String, commandId: String, range: String, boundary: String?, leaf: String?)] = [:]
    private var oldestEntries: [String: String] = [:]
    private var sessionLeaves: [String: String] = [:]
    private var syncTimeouts: [String: Task<Void, Never>] = [:]
    private var syncedSessions: Set<String> = []
    private var pendingActivation: String?
    private var sourcePositions: [String: (epoch: String, seq: Int64)] = [:]
    private var sessionListRequest: String?

    init(secure: SecureStorage = SecureStore.shared, transport: OrbisTransport? = nil, deviceName: String? = nil, autoConnect: Bool = true, preferences: UserDefaults? = .standard, transferRoot: URL? = nil) {
        self.secure = secure
        self.transport = transport ?? RelayTransport()
        self.preferences = preferences
        let root = transferRoot ?? (preferences == nil ? FileManager.default.temporaryDirectory.appendingPathComponent("orbis-preview-" + UUID().uuidString) :
            FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("Orbis"))
        transfers = FileTransfers(root: root)
        aliases = preferences?.dictionary(forKey: "orbis.sessionAliases") as? [String: String] ?? [:]
        drafts = preferences?.dictionary(forKey: "orbis.sessionDrafts") as? [String: String] ?? [:]
        pathPreference = normalizedPathPreference(preferences?.stringArray(forKey: "orbis.pathPreference") ?? [])
        #if canImport(UIKit)
        self.deviceName = deviceName ?? UIDevice.current.name
        #else
        self.deviceName = deviceName ?? "Orbis"
        #endif
        pairings = secure.pairings()
        selectedHostId = pairings.first?.hostId
        do { identity = try secure.deviceIdentity() }
        catch { errorMessage = error.localizedDescription }
        transfers.send = { [weak self] in self?.transport.send($0) ?? false }
        hostState.send = { [weak self] in self?.transport.send($0) ?? false }
        hostState.didChangeProviders = { [weak self] in self?.refreshSessions() }
        transfers.sendBinary = { [weak self] in self?.transport.sendBinary($0) ?? false }
        toolContent.send = { [weak self] runtime, command in self?.sendCommand(runtimeId: runtime, command: command) ?? false }
        toolInventories.send = { [weak self] runtime, command in self?.sendCommand(runtimeId: runtime, command: command) ?? false }
        toolInventories.didCover = { [weak self] runtime, reference in
            guard let self else { return }
            let ids = self.toolAcknowledgements.filter { $0.value.runtimeId == runtime && $0.value.reference == reference }.map(\.key)
            for id in ids { self.toolAcknowledgements[id] = nil; self.acknowledge(runtimeId: runtime, syncId: id, result: "applied") }
            if runtime == self.selectedRuntimeId { self.publishMessages() }
        }
        if autoConnect, let selectedHostId { connect(hostId: selectedHostId) }
    }

    var selectedHost: HostPairing? { pairings.first { $0.hostId == selectedHostId } }
    var selectedRuntime: RuntimeSummary? { runtimes.first { $0.runtimeId == selectedRuntimeId } }
    var canSend: Bool { connection == .secured && selectedRuntime != nil }

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
        aliases[localSessionKey(host: selectedHost, runtime: runtime)] = normalizedAlias(alias)
        if let session = runtime.sessionId { aliases[offlineAliasKey(host: selectedHost, sessionId: session)] = normalizedAlias(alias) }
        preferences?.set(aliases, forKey: "orbis.sessionAliases")
    }
    func draft(for runtime: RuntimeSummary) -> String { drafts[localSessionKey(host: selectedHost, runtime: runtime)] ?? "" }
    func saveDraft(_ text: String, for runtime: RuntimeSummary) {
        let key = localSessionKey(host: selectedHost, runtime: runtime)
        drafts[key] = text.isEmpty ? nil : text
        preferences?.set(drafts, forKey: "orbis.sessionDrafts")
    }

    func unpair(hostId: String) {
        let next = pairings.filter { $0.hostId != hostId }
        do { try secure.savePairings(next) }
        catch { errorMessage = error.localizedDescription; return }
        if let host = pairings.first(where: { $0.hostId == hostId }) {
            transfers.remove(Set(transfers.tasks.filter { $0.hostKey == FileTransfers.pairingKey(host) }.map(\.id)))
            let prefix = hostKeyPrefix(host)
            preferences?.removeObject(forKey: sessionCacheKey(host))
            drafts = drafts.filter { !$0.key.hasPrefix(prefix) }
            preferences?.set(drafts, forKey: "orbis.sessionDrafts")
            aliases = aliases.filter { !$0.key.hasPrefix(prefix) }
            preferences?.set(aliases, forKey: "orbis.sessionAliases")
        }
        pairings = next
        guard selectedHostId == hostId else { return }
        connectionGeneration = UUID()
        transport.disconnect()
        clearSyncs(); dismissBrowse(); clearActivation()
        conversations = [:]; messages = []; runtimes = []; sessions = []; commands = [:]
        selectedRuntimeId = nil; selectedHostId = nil; activePath = nil; pathRTT = nil; connection = .offline
        currentProviders = [:]; sessionListRequest = nil; connectionEvents = []
        transfers.setConnection(nil, connected: false)
        hostState.setConnection(nil, connected: false)
        toolContent.close(); toolInventories.clear(); toolAcknowledgements = [:]
        interactions = [:]; submittingInteractions = []; interactionCommands = [:]; workingBranches = [:]; dismissPreview()
        if let first = next.first { connect(hostId: first.hostId) }
    }

    func pair(from rawQR: String) {
        guard !isPairing else { return }
        errorMessage = nil
        do {
            let qr = try PairingQR.parse(rawQR.trimmingCharacters(in: .whitespacesAndNewlines))
            guard let identity else { throw PairingError.relay("设备安全身份不可用，请解锁设备并重新启动 App。") }
            isPairing = true
            let pairingTransport = RelayTransport()
            self.pairingTransport = pairingTransport
            pairingTransport.pair(qr: qr, deviceName: deviceName, identity: identity) { [weak self] result in
                guard let self else { return }
                self.isPairing = false
                self.pairingTransport = nil
                switch result {
                case .success(let pairing):
                    do {
                        var next = self.pairings.filter { $0.hostId != pairing.hostId }
                        next.append(pairing)
                        // Do not report pairing success before the root is saved.
                        try self.secure.savePairings(next)
                        self.pairings = next
                        self.connect(pairing: pairing, identity: identity)
                    } catch { self.errorMessage = error.localizedDescription }
                case .failure(let error): self.errorMessage = error.localizedDescription
                }
            }
        } catch { errorMessage = error.localizedDescription }
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
        let generation = connectionGeneration
        selectedHostId = pairing.hostId
        connection = .connecting
        hostState.setConnection(pairing, connected: false)
        currentProviders = [:]; sessionListRequest = nil; connectionEvents = []
        transfers.setConnection(pairing, connected: false)
        toolContent.close(); toolInventories.clear(); toolAcknowledgements = [:]
        runtimes = []; sessions = cachedSessions(pairing); messages = []; selectedRuntimeId = nil
        conversations = [:]; liveMessageIds = [:]; displayMessageIds = [:]
        liveOrders = [:]; liveToolReferences = [:]; liveTools = [:]
        oldestEntries = [:]; sessionLeaves = [:]; hasOlderHistory = [:]; historyErrors = [:]; historyLoading = []
        sourcePositions = [:]; runtimeEventSequences = [:]
        pendingActivation = nil; activePath = nil
        interactions = [:]; interactionCommands = [:]; submittingInteractions = []
        workingBranches = [:]; dismissPreview()
        actionTimeouts.values.forEach { $0.cancel() }; actionTimeouts = [:]; runtimeActions = [:]; pendingActionIds = []; actionFeedback = nil
        pathRTT = nil; commands = [:]; supportedAgents = nil; launchableAgents = nil
        dismissBrowse(); clearActivation()
        clearSyncs()
        transport.connect(pairing: pairing, identity: identity, receive: { [weak self] message, channel in
            guard let self, self.connectionGeneration == generation else { return }
            self.receive(message, channel: channel)
        }, state: { [weak self] state, error in
            guard let self, self.connectionGeneration == generation else { return }
            self.connection = state
            self.recordConnectionEvent("连接：\(state.rawValue)")
            self.transfers.setConnection(self.selectedHost, connected: state == .secured)
            if state != .secured { self.hostState.setConnection(self.selectedHost, connected: false) }
            if state == .offline || state == .connecting {
                self.toolContent.close()
                self.activePath = nil
                self.runtimeEventSequences = [:]
                self.sourcePositions = [:]
                self.clearSyncs()
            }
            // Transient reconnect errors stay in the connection indicator.
            if state == .error, let error { self.errorMessage = error }
        })
    }

    func selectRuntime(_ runtimeId: String) {
        guard runtimes.contains(where: { $0.runtimeId == runtimeId }) else { return }
        if selectedRuntimeId != runtimeId { toolContent.close() }
        selectedRuntimeId = runtimeId
        publishMessages()
        if let runtime = selectedRuntime { syncSession(runtime, force: true) }
        refreshWorkingBranch()
    }

    func refreshWorkingBranch() {
        guard connection == .secured, let runtime = selectedRuntime else { return }
        let id = UUID().uuidString
        let branch = workingBranches[runtime.runtimeId].flatMap { $0.cwd == runtime.cwd && $0.sessionId == runtime.sessionId ? $0 : nil }
        let next = WorkingBranch(requestId: id, sessionId: runtime.sessionId, cwd: runtime.cwd,
                                 branch: branch?.branch, commit: branch?.commit, loaded: branch?.loaded ?? false)
        workingBranches[runtime.runtimeId] = next
        _ = transport.send(["type": "runtime.git.request", "protocolVersion": orbisProtocolVersion, "runtimeId": runtime.runtimeId, "requestId": id])
    }

    func previewEntry(_ entryId: String) {
        guard canSend, let runtime = selectedRuntime, let sessionId = runtime.sessionId else { return }
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
              !submittingInteractions.contains(request.requestId),
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
            if let selectedRuntime { syncSession(selectedRuntime, force: true) }
        } else { reconnectSelectedHost() }
    }

    private func syncSession(_ runtime: RuntimeSummary, force: Bool = false) {
        guard connection == .secured, let sessionId = runtime.sessionId else { return }
        let key = "\(runtime.runtimeId)|\(sessionId)"
        guard !pendingSyncs.values.contains(where: { $0.runtimeId == runtime.runtimeId }), force || !syncedSessions.contains(key) else { return }
        let syncId = UUID().uuidString
        let commandId = UUID().uuidString
        guard sendCommand(runtimeId: runtime.runtimeId, commandId: commandId, command: ["type": "session.sync", "sessionId": sessionId,
            "syncId": syncId, "range": "preview", "maxEntries": 30]) else { return }
        pendingSyncs[syncId] = (runtime.runtimeId, sessionId, commandId, "preview", nil, nil)
        armSyncTimeout(syncId, seconds: 60)
        updateSyncing()
    }

    @discardableResult
    func loadOlderHistory() -> Bool {
        guard canSend, let runtime = selectedRuntime, let sessionId = runtime.sessionId,
              let boundary = oldestEntries[runtime.runtimeId], hasOlderHistory[runtime.runtimeId] == true,
              !pendingSyncs.values.contains(where: { $0.runtimeId == runtime.runtimeId }) else { return false }
        let sync = UUID().uuidString, command = UUID().uuidString
        var body: [String: Any] = ["type": "session.sync", "sessionId": sessionId, "syncId": sync,
                                  "range": "history", "beforeEntryId": boundary, "maxEntries": 30]
        if let leaf = sessionLeaves[runtime.runtimeId] { body["targetLeafId"] = leaf }
        guard sendCommand(runtimeId: runtime.runtimeId, commandId: command, command: body) else {
            historyErrors[runtime.runtimeId] = "历史读取请求未送达。"; return false
        }
        pendingSyncs[sync] = (runtime.runtimeId, sessionId, command, "history", boundary, sessionLeaves[runtime.runtimeId])
        historyErrors[runtime.runtimeId] = nil; historyLoading.insert(runtime.runtimeId)
        armSyncTimeout(sync, seconds: 60); updateSyncing(); return true
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
        runtimeActions[id] = (runtimeId, name); pendingActionIds.insert(id); actionFeedback = nil
        actionTimeouts[id] = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 60_000_000_000) } catch { return }
            guard let self, self.runtimeActions[id] != nil else { return }
            self.finishAction(id, succeeded: false, message: "操作尚未确认，请刷新查看电脑端状态。")
        }
        return true
    }

    private func finishAction(_ id: String, succeeded: Bool, message: String? = nil, result: [String: Any]? = nil) {
        guard let action = runtimeActions.removeValue(forKey: id) else { return }
        pendingActionIds.remove(id); actionTimeouts.removeValue(forKey: id)?.cancel()
        if succeeded {
            actionFeedback = "\(action.name) 已完成"
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
        guard canSend, let runtime = selectedRuntime, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        guard text.count <= 100_000 else { errorMessage = "消息不能超过 100,000 个字符。"; return false }
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("/") else {
            errorMessage = "请从命令菜单选择斜杠命令。"
            return false
        }
        let id = UUID().uuidString
        var command: [String: Any] = ["type": "user_message", "text": text, "messageId": id]
        let attachments = transfers.currentTasks.filter { attachmentIds.contains($0.id) && $0.runtimeId == runtime.runtimeId && $0.sessionId == runtime.sessionId && $0.direction == "upload" }
        guard attachments.count == attachmentIds.count, attachments.allSatisfy({ $0.status == "completed" && $0.remotePath != nil }) else { return false }
        if !attachments.isEmpty { command["attachments"] = attachments.compactMap(\.remotePath) }
        if let delivery, ["followUp", "steer"].contains(delivery) { command["delivery"] = delivery }
        guard sendCommand(runtimeId: runtime.runtimeId, command: command) else {
            errorMessage = "端到端加密连接尚未就绪，请连接成功后重试。"
            return false
        }
        // Host message events are authoritative. Pi and DSH may assign a different streaming or
        // persisted ID than the client's command ID, so a local row here would become a duplicate.
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

    private func sessionCacheKey(_ host: HostPairing) -> String { "orbis.sessionDirectory." + hostKeyPrefix(host) }

    private func refreshSessions() {
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
        if hostState.consume(message) { return }
        switch type {
        case "device.ready":
            guard channel != nil, let values = message["runtimes"] as? [[String: Any]] else { return }
            let next: [RuntimeSummary] = values.compactMap(jsonDecode)
            for runtime in next where runtimes.first(where: { $0.runtimeId == runtime.runtimeId })?.sessionId != runtime.sessionId {
                invalidateConversation(runtime.runtimeId)
            }
            runtimes = next
            conversations = conversations.filter { id, _ in next.contains { $0.runtimeId == id } }
            runtimeEventSequences = [:]
            if selectedRuntime == nil { selectedRuntimeId = runtimes.first?.runtimeId }
            connection = .secured
            hostState.setConnection(selectedHost, connected: true)
            sendPathPreference()
            transfers.setConnection(selectedHost, connected: true)
            supportedAgents = message["agents"] as? [String]
            launchableAgents = message["launchableAgents"] as? [String]
            publishMessages()
            if let selectedRuntime { syncSession(selectedRuntime) }
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
                if runtime.runtimeId == selectedRuntimeId { syncSession(runtime) }
            }
        case "runtime.offline":
            if let id = message["runtimeId"] as? String {
                runtimes.removeAll { $0.runtimeId == id }
                invalidateConversation(id)
                if selectedRuntimeId == id { selectedRuntimeId = runtimes.first?.runtimeId }
                publishMessages()
                if let selectedRuntime { syncSession(selectedRuntime) }
            }
        case "runtime.event": consumeEvent(message, channel: channel)
        case "session.list.result":
            guard let request = sessionListRequest, message["requestId"] as? String == request else { return }
            sessionListRequest = nil
            if let values = message["sessions"] as? [[String: Any]] {
                let decoded: [SessionSummary] = values.compactMap(jsonDecode)
                sessions = decoded.sorted { $0.modifiedAt > $1.modifiedAt }
                if let host = selectedHost, let data = try? JSONEncoder().encode(sessions) { preferences?.set(data, forKey: sessionCacheKey(host)) }
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

    private func consumeEvent(_ envelope: [String: Any], channel: String?) {
        guard let runtimeId = envelope["runtimeId"] as? String, runtimes.contains(where: { $0.runtimeId == runtimeId }),
              let event = envelope["event"] as? [String: Any], let type = event["type"] as? String else { return }
        if let sequence = integer(envelope["sequence"]) {
            let key = "\(runtimeId)\u{0000}\(channel ?? "ctl")"
            if sequence <= (runtimeEventSequences[key] ?? -1) { return }
            runtimeEventSequences[key] = sequence
        }
        toolContent.consume(event, runtimeId: runtimeId)
        toolInventories.consume(event, runtime: runtimeId)
        if type == "runtime.status", let status = event["status"] as? String,
           let index = runtimes.firstIndex(where: { $0.runtimeId == runtimeId }) { runtimes[index].status = status; return }
        if type == "runtime.capabilities", let capabilities = event["capabilities"] as? [String: Any] {
            commands[runtimeId] = (capabilities["commands"] as? [[String: Any]] ?? []).compactMap(jsonDecode)
            return
        }
        if type == "command.result", let commandId = event["commandId"] as? String {
            finishAction(commandId, succeeded: event["ok"] as? Bool == true, message: event["error"] as? String, result: event["result"] as? [String: Any])
            if let request = interactionCommands.removeValue(forKey: commandId), event["ok"] as? Bool != true { submittingInteractions.remove(request) }
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
            let next = mergeRuntime(previous, metadata: metadata)
            runtimes[index] = next
            if previous.sessionId != next.sessionId {
                invalidateConversation(runtimeId)
                if runtimeId == selectedRuntimeId { syncSession(next) }
                publishMessages()
            }
            return
        }
        if type == "runtime.error" || (type == "command.result" && event["ok"] as? Bool == false) {
            if let commandId = event["commandId"] as? String, let syncId = pendingSyncs.first(where: { $0.value.commandId == commandId })?.key {
                let pending = pendingSyncs[syncId]; finishSync(syncId)
                if pending?.range == "history" { historyErrors[runtimeId] = event["error"] as? String ?? event["message"] as? String ?? "历史读取失败，请重试。"; return }
            }
            errorMessage = event["message"] as? String ?? event["error"] as? String ?? "电脑端无法完成操作。"
            return
        }
        if type == "session.sync.pending", let syncId = event["syncId"] as? String, pendingSyncs[syncId] != nil {
            armSyncTimeout(syncId, seconds: min(600, max(60, Double(integer(event["leaseMs"]) ?? 60_000) / 1000)))
            return
        }
        if type == "session.snapshot" {
            applySnapshot(event, runtimeId: runtimeId)
        } else if type == "session.patch" {
            // A preview is the recovery boundary in this first version. Never
            // apply a patch over a different source epoch or a missing base.
            if let source = event["source"] as? [String: Any], let epoch = source["epoch"] as? String,
               let seq = integer(source["seq"]), let base = integer(event["baseSeq"]),
               source["ready"] as? Bool == true, seq > base,
               let current = sourcePositions[runtimeId], current.epoch == epoch, current.seq == base,
               event["sessionId"] as? String == runtimes.first(where: { $0.runtimeId == runtimeId })?.sessionId {
                applyProjection(event, runtimeId: runtimeId)
                if let leaf = (event["head"] as? [String: Any])?["leafId"] as? String { sessionLeaves[runtimeId] = leaf }
                sourcePositions[runtimeId] = (epoch, seq)
            } else if let runtime = runtimes.first(where: { $0.runtimeId == runtimeId }), runtimeId == selectedRuntimeId {
                syncSession(runtime, force: true)
            }
        } else if type == "message.started" || type == "message.finished" {
            if let object = event["message"] as? [String: Any], let message: ChatMessage = jsonDecode(object) { upsert(message, runtimeId: runtimeId) }
        } else if type == "message.delta" { applyDelta(event, runtimeId: runtimeId) }
        publishMessages()
    }

    private func applySnapshot(_ event: [String: Any], runtimeId: String) {
        guard let syncId = event["syncId"] as? String else { return }
        let pending = pendingSyncs[syncId]
        guard pending?.runtimeId == runtimeId, pending?.sessionId == event["sessionId"] as? String,
              let runtime = runtimes.first(where: { $0.runtimeId == runtimeId }), runtime.sessionId == pending?.sessionId else {
            acknowledge(runtimeId: runtimeId, syncId: syncId, result: "rejected")
            return
        }
        if let source = event["source"] as? [String: Any], source["ready"] as? Bool == false {
            finishSync(syncId)
            acknowledge(runtimeId: runtimeId, syncId: syncId, result: "rejected")
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
        if pending?.range != "history", let source = event["source"] as? [String: Any],
           let epoch = source["epoch"] as? String, let seq = integer(source["seq"]),
           let current = sourcePositions[runtimeId], current.epoch == epoch, seq < current.seq {
            finishSync(syncId); acknowledge(runtimeId: runtimeId, syncId: syncId, result: "rejected"); return
        }
        if pending?.range == "history" {
            guard event["range"] as? String == "history", event["mode"] as? String == "prepend",
                  event["beforeEntryId"] as? String == pending?.boundary,
                  pending?.leaf == nil || (event["targetLeafId"] as? String == pending?.leaf && sessionLeaves[runtimeId] == pending?.leaf) else {
                finishSync(syncId); acknowledge(runtimeId: runtimeId, syncId: syncId, result: "rejected"); return
            }
            let rows = (event["display"] as? [String: Any])?["entries"] as? [[String: Any]] ?? []
            var older: [ChatMessage] = []
            for row in rows {
                if let raw = row["message"] as? [String: Any], let message: ChatMessage = jsonDecode(raw) {
                    older.append(message)
                    if let entryId = row["entryId"] as? String { displayMessageIds[runtimeId, default: [:]][entryId] = message.messageId }
                }
            }
            let ids = Set(older.map(\.messageId))
            conversations[runtimeId] = older + (conversations[runtimeId] ?? []).filter { !ids.contains($0.messageId) }
            if let first = (event["entries"] as? [[String: Any]])?.first?["entryId"] as? String { oldestEntries[runtimeId] = first }
            hasOlderHistory[runtimeId] = event["hasOlder"] as? Bool ?? false
            finishSync(syncId); acknowledge(runtimeId: runtimeId, syncId: syncId, result: "applied")
            historyPageRevision += 1; publishMessages(); return
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
        if let leaf = (event["cursor"] as? [String: Any])?["leafId"] as? String { sessionLeaves[runtimeId] = leaf }
        if prefix.isEmpty, let first = (event["entries"] as? [[String: Any]])?.first?["entryId"] as? String { oldestEntries[runtimeId] = first }
        if prefix.isEmpty { hasOlderHistory[runtimeId] = event["hasOlder"] as? Bool ?? false }
        if let source = event["source"] as? [String: Any], let epoch = source["epoch"] as? String, let seq = integer(source["seq"]) {
            sourcePositions[runtimeId] = (epoch, seq)
        }
        syncedSessions.insert("\(runtimeId)|\(pending!.sessionId)")
        finishSync(syncId)
        if let reference = dependency {
            if toolInventories.covers(reference, runtime: runtimeId) { acknowledge(runtimeId: runtimeId, syncId: syncId, result: "applied") }
            else if toolAcknowledgements.count < 8 { toolAcknowledgements[syncId] = (runtimeId, reference) }
            else { acknowledge(runtimeId: runtimeId, syncId: syncId, result: "rejected") }
        } else { acknowledge(runtimeId: runtimeId, syncId: syncId, result: "applied") }
    }

    private func applyProjection(_ event: [String: Any], runtimeId: String) {
        let live = event["live"] as? [String: Any]
        if let raw = live?["toolInventory"] as? [String: Any], let reference: ToolReference = jsonDecode(raw),
           reference.agent.hostId == selectedHostId,
           reference.agent.sessionId == runtimes.first(where: { $0.runtimeId == runtimeId })?.sessionId {
            toolInventories.require(reference, runtime: runtimeId)
            if liveToolReferences[runtimeId] != reference { liveToolReferences[runtimeId] = reference }
        } else if live != nil { liveToolReferences[runtimeId] = nil; liveTools[runtimeId] = nil }
        if live?["complete"] as? Bool == true {
            let previousLive = liveMessageIds[runtimeId] ?? []
            let canonical = Set((displayMessageIds[runtimeId] ?? [:]).values)
            conversations[runtimeId]?.removeAll { previousLive.contains($0.messageId) && !canonical.contains($0.messageId) }
            liveMessageIds[runtimeId] = []; liveOrders[runtimeId] = [:]
        }
        if let display = event["display"] as? [String: Any], let entries = display["entries"] as? [[String: Any]] {
            for row in entries {
                if let object = row["message"] as? [String: Any], let message: ChatMessage = jsonDecode(object) {
                    if let entryId = row["entryId"] as? String {
                        displayMessageIds[runtimeId, default: [:]][entryId] = message.messageId
                    }
                    upsert(message, runtimeId: runtimeId)
                }
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
                    if let entryId = row["persistedEntryId"] as? String, let canonicalId = displayMessageIds[runtimeId]?[entryId], canonicalId != message.messageId {
                        conversations[runtimeId]?.removeAll { $0.messageId == message.messageId }
                        continue
                    }
                    liveMessageIds[runtimeId, default: []].insert(message.messageId)
                    if let order = integer(row["order"]) { liveOrders[runtimeId, default: [:]][message.messageId] = order }
                    upsert(message, runtimeId: runtimeId)
                }
            }
        }
    }

    private func acknowledge(runtimeId: String, syncId: String, result: String) {
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
        guard let id = event["messageId"] as? String, let delta = event["delta"] as? String else { return }
        let kind = event["contentType"] as? String ?? "text"
        let previous = conversations[runtimeId]?.first { $0.messageId == id }
        var content = previous?.content ?? []
        let index = integer(event["contentIndex"]).map(Int.init) ?? (content.last?.type == kind ? max(0, content.count - 1) : content.count)
        guard (0...1024).contains(index) else { return }
        while content.count <= index { content.append(ChatContent(type: kind, text: "", toolName: nil, artifact: nil)) }
        let item = content[index]
        content[index] = ChatContent(type: item.type, text: (item.text ?? "") + delta, toolName: item.toolName, artifact: item.artifact, summary: item.summary, toolCallId: item.toolCallId)
        upsert(ChatMessage(messageId: id, role: previous?.role ?? "assistant", content: content,
            timestamp: previous?.timestamp ?? Int64(Date().timeIntervalSince1970 * 1000), isError: previous?.isError), runtimeId: runtimeId)
    }

    private func publishMessages() {
        guard let runtimeId = selectedRuntimeId else { messages = []; updateSyncing(); return }
        // 清单尚未追上本次投影时沿用上一次已确认的工具，避免卡片闪烁或用旧清单造出重复卡片。
        if let reference = liveToolReferences[runtimeId], toolInventories.covers(reference, runtime: runtimeId) {
            liveTools[runtimeId] = toolInventories.visible[runtimeId] ?? []
        }
        messages = materializeLiveTools(conversations[runtimeId] ?? [], tools: liveTools[runtimeId] ?? [], liveOrders: liveOrders[runtimeId] ?? [:])
        updateSyncing()
    }

    private func invalidateConversation(_ runtimeId: String) {
        oldestEntries[runtimeId] = nil; sessionLeaves[runtimeId] = nil; hasOlderHistory[runtimeId] = nil; historyErrors[runtimeId] = nil; historyLoading.remove(runtimeId)
        toolInventories.clear(runtimeId)
        let toolAcks = toolAcknowledgements.filter { $0.value.runtimeId == runtimeId }.map(\.key)
        for id in toolAcks { toolAcknowledgements[id] = nil; acknowledge(runtimeId: runtimeId, syncId: id, result: "rejected") }
        interactions[runtimeId] = nil; commands[runtimeId] = nil; workingBranches[runtimeId] = nil
        if entryPreview?.runtimeId == runtimeId { dismissPreview() }
        let actions = runtimeActions.filter { $0.value.runtimeId == runtimeId }.map(\.key)
        for id in actions { runtimeActions[id] = nil; pendingActionIds.remove(id); actionTimeouts.removeValue(forKey: id)?.cancel() }
        conversations[runtimeId] = nil
        liveMessageIds[runtimeId] = nil; liveOrders[runtimeId] = nil; liveToolReferences[runtimeId] = nil; liveTools[runtimeId] = nil
        displayMessageIds[runtimeId] = nil
        sourcePositions[runtimeId] = nil
        syncedSessions = syncedSessions.filter { !$0.hasPrefix(runtimeId + "|") }
        let ids = pendingSyncs.filter { $0.value.runtimeId == runtimeId }.map(\.key)
        ids.forEach(finishSync)
        runtimeEventSequences = runtimeEventSequences.filter { !$0.key.hasPrefix(runtimeId + "\u{0000}") }
    }

    private func clearSyncs() {
        syncTimeouts.values.forEach { $0.cancel() }
        syncTimeouts = [:]; pendingSyncs = [:]; syncedSessions = []
        historyLoading = []
        updateSyncing()
    }

    private func finishSync(_ syncId: String) {
        if let pending = pendingSyncs[syncId], pending.range == "history" { historyLoading.remove(pending.runtimeId) }
        pendingSyncs[syncId] = nil
        syncTimeouts.removeValue(forKey: syncId)?.cancel()
        updateSyncing()
    }

    private func updateSyncing() { isSyncing = pendingSyncs.values.contains { $0.runtimeId == selectedRuntimeId && $0.range != "history" } }

    private func armSyncTimeout(_ syncId: String, seconds: Double) {
        syncTimeouts[syncId]?.cancel()
        syncTimeouts[syncId] = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000)) } catch { return }
            guard let self, self.pendingSyncs[syncId] != nil else { return }
            if let pending = self.pendingSyncs[syncId], pending.range == "history" { self.historyErrors[pending.runtimeId] = "历史读取超时，请重试。" }
            self.finishSync(syncId)
            self.errorMessage = "会话同步超时，请点击刷新重试。"
        }
    }

    private func integer(_ value: Any?) -> Int64? { (value as? NSNumber)?.int64Value }
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
