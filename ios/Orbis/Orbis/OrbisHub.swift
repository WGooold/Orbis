import Foundation
import Combine
#if canImport(UIKit)
import UIKit
#endif

@MainActor
struct HostSnapshot: Identifiable {
    let pairing: HostPairing
    let connection: HostConnection
    nonisolated var id: String { pairing.hostId }
    var hostId: String { pairing.hostId }
    var name: String { pairing.hostName }
    var runtimes: [RuntimeSummary] { connection.runtimes }
    var sessions: [SessionSummary] { connection.sessions }
    var connectionState: ConnectionState { connection.connection }
}

/// Each pairing retains its own authenticated paths, mirror, history reads and transfers.
/// Selecting a Host changes only the recipient of interactive operations (ADR-0030).
@MainActor
final class OrbisStore: ObservableObject {
    @Published private(set) var pairings: [HostPairing] = []
    @Published private(set) var selectedHostId: String?
    @Published private(set) var isPairing = false
    @Published private var pairingError: String?
    private let secure: SecureStorage
    private let preferences: UserDefaults?
    private let deviceName: String
    private let root: URL
    private let historyWorker: SessionHistoryWorker
    private let factory: (HostPairing) -> OrbisTransport
    private var connections: [String: HostConnection] = [:]
    private var observations: [String: AnyCancellable] = [:]
    private var started: Set<String> = []
    private let emptyConnection: HostConnection
    private var pairingTransport: OrbisTransport?
    private var publicationScheduled = false
    private var cleanupTasks: [UUID: Task<Void, Never>] = [:]

    init(secure: SecureStorage = SecureStore.shared, transport: OrbisTransport? = nil, deviceName: String? = nil,
         autoConnect: Bool = true, preferences: UserDefaults? = .standard, transferRoot: URL? = nil,
         transportFactory: ((HostPairing) -> OrbisTransport)? = nil) {
        self.secure = secure; self.preferences = preferences
        #if canImport(UIKit)
        self.deviceName = deviceName ?? UIDevice.current.name
        #else
        self.deviceName = deviceName ?? "Orbis"
        #endif
        root = transferRoot ?? (preferences == nil ? FileManager.default.temporaryDirectory.appendingPathComponent("orbis-preview-" + UUID().uuidString) :
            FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("Orbis"))
        historyWorker = SessionHistoryWorker(root: root.appendingPathComponent("SessionHistory", isDirectory: true))
        var supplied = transport
        factory = transportFactory ?? { _ in
            if let value = supplied { supplied = nil; return value }
            return RelayTransport()
        }
        emptyConnection = HostConnection(secure: secure, autoConnect: false, preferences: nil,
            transferRoot: root.appendingPathComponent("Unpaired"), isolated: true)
        for pairing in secure.pairings() {
            if let index = pairings.firstIndex(where: { $0.hostId == pairing.hostId }) { pairings[index] = pairing }
            else { pairings.append(pairing) }
        }
        for pairing in pairings { install(pairing, connect: autoConnect) }
        let saved = preferences?.string(forKey: "orbis.selectedHostId")
        selectedHostId = saved.flatMap { connections[$0] == nil ? nil : $0 } ?? pairings.first?.hostId
    }

    var hosts: [HostSnapshot] { pairings.compactMap { host in connections[host.hostId].map { HostSnapshot(pairing: host, connection: $0) } } }
    var activeConnection: HostConnection { selectedHostId.flatMap { connections[$0] } ?? emptyConnection }
    func connection(for hostId: String) -> HostConnection? { connections[hostId] }

    private func install(_ pairing: HostPairing, connect: Bool) {
        observations.removeValue(forKey: pairing.hostId)?.cancel()
        connections.removeValue(forKey: pairing.hostId)?.shutdown(); started.remove(pairing.hostId)
        let connection = HostConnection(secure: secure, transport: factory(pairing), deviceName: deviceName,
            autoConnect: false, preferences: preferences, transferRoot: root, initialPairing: pairing, isolated: true, historyWorker: historyWorker)
        connection.didUpdatePairing = { [weak self] updated in self?.updatePairing(updated) }
        connections[pairing.hostId] = connection
        observations[pairing.hostId] = connection.objectWillChange.sink { [weak self] _ in self?.publishChanges() }
        if connect { started.insert(pairing.hostId); connection.connect(hostId: pairing.hostId) }
    }

    private func publishChanges() {
        guard !publicationScheduled else { return }
        publicationScheduled = true
        Task { [weak self] in
            await Task.yield()
            guard let self else { return }
            self.publicationScheduled = false; self.objectWillChange.send()
        }
    }

    private func updatePairing(_ updated: HostPairing) {
        guard let index = pairings.firstIndex(where: { $0.hostId == updated.hostId }),
              pairings[index].pskRoot == updated.pskRoot, pairings[index].hostPub == updated.hostPub else { return }
        var next = pairings; next[index] = updated
        do { try secure.savePairings(next); pairings = next }
        catch { pairingError = error.localizedDescription }
    }

    func selectHost(_ hostId: String) {
        guard connections[hostId] != nil else { return }
        if selectedHostId != hostId { activeConnection.toolContent.close() }
        selectedHostId = hostId; pairingError = nil
        preferences?.set(hostId, forKey: "orbis.selectedHostId")
    }
    func connect(hostId: String) {
        selectHost(hostId)
        guard let connection = connections[hostId], !started.contains(hostId) else { return }
        started.insert(hostId); connection.connect(hostId: hostId)
    }
    func selectRuntime(hostId: String, runtimeId: String) { selectHost(hostId); connections[hostId]?.selectRuntime(runtimeId) }
    func selectRuntime(_ runtimeId: String) { activeConnection.selectRuntime(runtimeId) }
    func reconnectSelectedHost() {
        guard let selectedHostId else { return }
        started.insert(selectedHostId); activeConnection.reconnectSelectedHost()
    }
    func unpair(hostId: String) {
        guard let connection = connections[hostId] else { return }
        let next = pairings.filter { $0.hostId != hostId }
        do { try secure.savePairings(next) } catch { pairingError = error.localizedDescription; return }
        observations.removeValue(forKey: hostId)?.cancel(); started.remove(hostId)
        connection.purgeLocalData(); connections[hostId] = nil; pairings = next
        let cleanupId = UUID()
        cleanupTasks[cleanupId] = Task { [weak self] in
            await connection.waitForPendingEvents()
            self?.cleanupTasks[cleanupId] = nil
        }
        if selectedHostId == hostId { selectedHostId = next.first?.hostId }
        if let selectedHostId { preferences?.set(selectedHostId, forKey: "orbis.selectedHostId") }
        else { preferences?.removeObject(forKey: "orbis.selectedHostId") }
    }
    func pair(from rawQR: String) {
        guard !isPairing else { return }
        pairingError = nil
        do {
            let qr = try PairingQR.parse(rawQR.trimmingCharacters(in: .whitespacesAndNewlines))
            let identity = try secure.deviceIdentity(), transport = RelayTransport()
            isPairing = true; pairingTransport = transport
            transport.pair(qr: qr, deviceName: deviceName, identity: identity) { [weak self] result in
                guard let self else { return }
                self.isPairing = false; self.pairingTransport = nil
                switch result {
                case .success(let pairing):
                    var next = self.pairings
                    if let index = next.firstIndex(where: { $0.hostId == pairing.hostId }) { next[index] = pairing } else { next.append(pairing) }
                    do {
                        try self.secure.savePairings(next); self.pairings = next
                        self.install(pairing, connect: true); self.selectHost(pairing.hostId)
                    } catch { self.pairingError = error.localizedDescription }
                case .failure(let error): self.pairingError = error.localizedDescription
                }
            }
        } catch { pairingError = error.localizedDescription }
    }

    // Read-only selected-Host projection keeps single-Host screens and command semantics intact.
    var transfers: FileTransfers { activeConnection.transfers }
    var toolContent: ToolContentReader { activeConnection.toolContent }
    var toolInventories: ToolInventories { activeConnection.toolInventories }
    var hostState: HostState { activeConnection.hostState }
    var agentState: AgentState { activeConnection.agentState }
    var notifications: RuntimeNotifications { activeConnection.notifications }
    var isViewingCachedSession: Bool { activeConnection.isViewingCachedSession }
    var cachedHistoryOptions: [RuntimeOption] { activeConnection.cachedHistoryOptions }
    var cachedSessionIds: Set<String> { activeConnection.cachedSessionIds }
    var turnTimings: [SessionTurnTiming] { activeConnection.turnTimings.values.sorted { $0.startedAt < $1.startedAt } }
    var runtimes: [RuntimeSummary] { activeConnection.runtimes }
    var sessions: [SessionSummary] { activeConnection.sessions }
    var messages: [ChatMessage] { activeConnection.messages }
    var chatTranscript: ChatTranscript { activeConnection.chatTranscript }
    var selectedRuntimeId: String? { activeConnection.selectedRuntimeId }
    var connection: ConnectionState { activeConnection.connection }
    var activePath: String? { activeConnection.activePath }
    var errorMessage: String? {
        get { pairingError ?? activeConnection.errorMessage }
        set { pairingError = nil; activeConnection.errorMessage = newValue }
    }
    var isSyncing: Bool { activeConnection.isSyncing }
    var activatingSessionId: String? { activeConnection.activatingSessionId }
    var browse: DirectoryBrowse? { activeConnection.browse }
    var commands: [String: [SlashCommand]] { activeConnection.commands }
    var supportedAgents: [String]? { activeConnection.supportedAgents }
    var launchableAgents: [String]? { activeConnection.launchableAgents }
    var codexDesktop: CodexDesktopAttach? { activeConnection.codexDesktop }
    var drafts: [String: String] { activeConnection.drafts }
    var aliases: [String: String] { activeConnection.aliases }
    var pathRTT: Double? { activeConnection.pathRTT }
    var activationRevision: Int { activeConnection.activationRevision }
    var pendingActionIds: Set<String> { activeConnection.pendingActionIds }
    var actionFeedback: String? { activeConnection.actionFeedback }
    var workingBranches: [String: WorkingBranch] { activeConnection.workingBranches }
    var entryPreview: EntryPreview? { activeConnection.entryPreview }
    var historyRevision: Int { activeConnection.historyRevision }
    var interactions: [String: [InteractionRequest]] { activeConnection.interactions }
    var submittingInteractions: Set<String> { activeConnection.submittingInteractions }
    var queuedMessages: [String: [QueuedMessage]] { activeConnection.queuedMessages }
    var pendingQueueCancellations: Set<String> { activeConnection.pendingQueueCancellations }
    var hasOlderHistory: [String: Bool] { activeConnection.hasOlderHistory }
    var historyLoading: Set<String> { activeConnection.historyLoading }
    var historyErrors: [String: String] { activeConnection.historyErrors }
    var historyPageRevision: Int { activeConnection.historyPageRevision }
    var pathPreference: [String] { activeConnection.pathPreference }
    var currentProviders: [String: String] { activeConnection.currentProviders }
    var connectionEvents: [String] { activeConnection.connectionEvents }
    var selectedHost: HostPairing? { pairings.first { $0.hostId == selectedHostId } }
    var selectedRuntime: RuntimeSummary? { activeConnection.selectedRuntime }
    var canSend: Bool { activeConnection.canSend }
    func displayName(_ runtime: RuntimeSummary) -> String { activeConnection.displayName(runtime) }
    func displayName(_ session: SessionSummary) -> String { activeConnection.displayName(session) }
    func alias(for runtime: RuntimeSummary) -> String { activeConnection.alias(for: runtime) }
    func setAlias(_ alias: String, for runtime: RuntimeSummary) { activeConnection.setAlias(alias, for: runtime) }
    func draft(for runtime: RuntimeSummary) -> String { activeConnection.draft(for: runtime) }
    func saveDraft(_ text: String, for runtime: RuntimeSummary) { activeConnection.saveDraft(text, for: runtime) }
    func refreshWorkingBranch() { activeConnection.refreshWorkingBranch() }
    func previewEntry(_ entryId: String) { activeConnection.previewEntry(entryId) }
    @discardableResult func openCachedSession(_ session: SessionSummary) -> Bool { activeConnection.openCachedSession(session) }
    func selectCachedBranch(_ leafId: String) { activeConnection.selectCachedBranch(leafId) }
    func dismissPreview() { activeConnection.dismissPreview() }
    func userMessageRewindOptions(for runtime: RuntimeSummary) -> [String: RuntimeOption] { activeConnection.userMessageRewindOptions(for: runtime) }
    func moveHistory(to option: RuntimeOption, fallbackText: String? = nil) -> Bool { activeConnection.moveHistory(to: option, fallbackText: fallbackText) }
    func respond(_ request: InteractionRequest, response: [String: Any]) -> Bool { activeConnection.respond(request, response: response) }
    func refresh() { activeConnection.refresh() }
    func loadOlderHistory() -> Bool { activeConnection.loadOlderHistory() }
    func activate(_ session: SessionSummary) { activeConnection.activate(session) }
    func createSession(agentKind: String, cwd: String) { activeConnection.createSession(agentKind: agentKind, cwd: cwd) }
    func archive(_ session: SessionSummary, archived: Bool) { activeConnection.archive(session, archived: archived) }
    func browseDirectory(_ path: String? = nil) { activeConnection.browseDirectory(path) }
    func dismissBrowse() { activeConnection.dismissBrowse() }
    func executeSlash(_ name: String, args: String = "") -> Bool { activeConnection.executeSlash(name, args: args) }
    func closeRuntimes(hostId: String, runtimeIds: Set<String>) -> Set<String> {
        connections[hostId]?.closeRuntimes(runtimeIds) ?? []
    }
    func updatePermission(settingId: String, value: String) { activeConnection.updatePermission(settingId: settingId, value: value) }
    func sendMessage(_ text: String, delivery: String? = nil, attachmentIds: Set<String> = []) -> Bool { activeConnection.sendMessage(text, delivery: delivery, attachmentIds: attachmentIds) }
    func cancelQueuedMessage(_ queueId: String) -> Bool { activeConnection.cancelQueuedMessage(queueId) }
    @discardableResult func stopRuntime() -> Bool { activeConnection.stopRuntime() }
    func setPathPreference(_ order: [String]) {
        preferences?.set(normalizedPathPreference(order), forKey: "orbis.pathPreference")
        emptyConnection.setPathPreference(order)
        for connection in connections.values { connection.setPathPreference(order) }
    }
    func currentProvider(for kind: String) -> String? { activeConnection.currentProvider(for: kind) }
    func agentKind(_ runtime: RuntimeSummary) -> String? { activeConnection.agentKind(runtime) }
    func providerMismatch(_ session: SessionSummary) -> String? { activeConnection.providerMismatch(session) }
    func advanceSessionSyncs(now: Date = Date()) { activeConnection.advanceSessionSyncs(now: now) }
    func waitForPendingEvents() async {
        for connection in Array(connections.values) { await connection.waitForPendingEvents() }
        while !cleanupTasks.isEmpty { for task in Array(cleanupTasks.values) { await task.value } }
    }
}
