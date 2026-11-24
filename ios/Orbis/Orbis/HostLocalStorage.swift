import Foundation

/// Disk ownership is independent of a connection's lifetime. Accepted writes drain
/// in order, including when reconnect cancels the task waiting for their result.
actor HostLocalIO {
    private let beforeIO: (@Sendable () -> Void)?
    init(beforeIO: (@Sendable () -> Void)? = nil) { self.beforeIO = beforeIO }

    func readJournal(_ url: URL) -> [String: Any]? {
        beforeIO?()
        guard let data = try? Data(contentsOf: url) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }
    func writeJournal(_ value: [String: Any]?, to url: URL, skipIfAbsent: Bool = false) -> Bool {
        if skipIfAbsent && value == nil && !FileManager.default.fileExists(atPath: url.path) { return true }
        beforeIO?()
        do {
            if let value {
                try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
                try JSONSerialization.data(withJSONObject: value).write(to: url, options: .atomic)
            } else if FileManager.default.fileExists(atPath: url.path) {
                try FileManager.default.removeItem(at: url)
            }
            return true
        } catch { return false }
    }
    func loadCatalog(key: String, preferences: UserDefaults?) -> [SessionSummary] {
        beforeIO?()
        guard let data = preferences?.data(forKey: key) else { return [] }
        return (try? JSONDecoder().decode([SessionSummary].self, from: data)) ?? []
    }
    func saveCatalog(_ sessions: [SessionSummary]?, key: String, preferences: UserDefaults?) {
        beforeIO?()
        guard let preferences else { return }
        if let sessions {
            if let data = try? JSONEncoder().encode(sessions) { preferences.set(data, forKey: key) }
        } else { preferences.removeObject(forKey: key) }
    }
}

/// The first send belongs to the landed session, not to the next launch slot.
/// This copy is for history reconciliation and recovery, never for re-submission.
struct ConfiguredFirstMessage {
    let messageId: String
    let commandId: String
    let text: String
    let sessionId: String
    let runtimeId: String
    let agentKind: String
    let codexCatalogId: String?
    let createdAt: Date

    init?(_ launch: [String: Any], runtime: RuntimeSummary, now: Date = Date()) {
        guard let messageId = launch["firstMessageId"] as? String, let text = launch["firstMessage"] as? String,
              !text.isEmpty, let sessionId = runtime.sessionId, let agentKind = launch["agentKind"] as? String else { return nil }
        self.messageId = messageId; self.text = text; self.sessionId = sessionId; self.agentKind = agentKind
        commandId = launch["firstCommandId"] as? String ?? messageId
        runtimeId = runtime.runtimeId; codexCatalogId = runtime.codexCatalogId; createdAt = now
    }

    init?(_ fields: [String: Any]) {
        guard let messageId = fields["messageId"] as? String, let commandId = fields["commandId"] as? String,
              let text = fields["text"] as? String, let sessionId = fields["sessionId"] as? String,
              let runtimeId = fields["runtimeId"] as? String, let agentKind = fields["agentKind"] as? String,
              let time = fields["createdAt"] as? Double else { return nil }
        self.messageId = messageId; self.commandId = commandId; self.text = text; self.sessionId = sessionId
        self.runtimeId = runtimeId; self.agentKind = agentKind; self.codexCatalogId = fields["codexCatalogId"] as? String
        self.createdAt = Date(timeIntervalSinceReferenceDate: time)
    }

    var fields: [String: Any] {
        var fields: [String: Any] = ["messageId": messageId, "commandId": commandId, "text": text,
            "sessionId": sessionId, "runtimeId": runtimeId, "agentKind": agentKind,
            "createdAt": createdAt.timeIntervalSinceReferenceDate]
        fields["codexCatalogId"] = codexCatalogId
        return fields
    }

    func matches(_ runtime: RuntimeSummary) -> Bool {
        guard runtimeMatchesLaunch(runtime, sessionId: sessionId, codexCatalogId: codexCatalogId, launchMode: nil, agentKind: agentKind) else { return false }
        // A Codex catalog ID plus agent mode is a stable route. Without it, do
        // not guess across Codex runtimes with equal native IDs.
        if ["codex", "codexDesktop"].contains(agentKind) {
            return runtime.runtimeId == runtimeId || (codexCatalogId != nil && runtime.agentKind == agentKind)
        }
        return runtime.agentKind == agentKind || runtime.runtimeId == runtimeId
    }

    func pending(on runtime: RuntimeSummary) -> PendingSend {
        var send = PendingSend(messageId: messageId, commandId: commandId, sessionId: sessionId, runtimeId: runtime.runtimeId,
                               text: text, attachments: [], delivery: nil, createdAt: createdAt, anchorMessageId: nil)
        send.state = .unconfirmed; send.needsDeliveryEvidence = true
        return send
    }
}

/// Launch records are keyed by request identity. Only repository IO is ordered;
/// readiness, navigation, abandonment and send recovery are independent per ID.
@MainActor
final class ConfiguredLaunchJournal {
    struct RecoveredDraft {
        let agentKind: String
        let cwd: String
        let text: String
    }
    private static let recordsKey = "records"
    private var records: [String: [String: Any]] = [:]
    // The ordered writer applies one mutation at a time to this baseline, so
    // newer writes cannot accidentally commit a different launch's failed abandonment.
    private var writeBaseline: [String: [String: Any]] = [:]
    private(set) var loaded = false
    private var loadTask: Task<Void, Never>?
    private var tail: Task<Bool, Never>?
    private let io: HostLocalIO
    private let url: URL
    private let legacyURL: URL
    private var retiring: Set<String> = []

    var pending: [[String: Any]] { ordered.filter { record in
        (record["launchId"] as? String).map(acceptsResult(for:)) == true
    } }
    var firstMessages: [ConfiguredFirstMessage] { records.values.compactMap { record in
        (record["landedFirstMessage"] as? [String: Any]).flatMap(ConfiguredFirstMessage.init)
    } }
    func snapshot(_ id: String) -> [String: Any]? { records[id] }
    func acceptsResult(for id: String) -> Bool {
        guard let record = records[id], !retiring.contains(id) else { return false }
        return !Self.isDraft(record) && record["landedFirstMessage"] == nil
    }
    func launchId(forFirstMessage id: String) -> String? {
        records.first { $0.value["firstMessageId"] as? String == id }?.key
    }
    private var ordered: [[String: Any]] {
        records.values.sorted { ($0["recordedAt"] as? Double ?? 0) > ($1["recordedAt"] as? Double ?? 0) }
    }
    private static func isDraft(_ record: [String: Any]) -> Bool {
        record["rejected"] as? Bool == true || record["abandoned"] as? Bool == true
    }
    func recoveredDraft(for id: String) -> RecoveredDraft? {
        guard let record = records[id], Self.isDraft(record), let agent = record["agentKind"] as? String,
              let cwd = record["cwd"] as? String else { return nil }
        return RecoveredDraft(agentKind: agent, cwd: cwd, text: record["firstMessage"] as? String ?? "")
    }
    var recoveredDraft: RecoveredDraft? {
        ordered.lazy.compactMap { ($0["launchId"] as? String).flatMap(self.recoveredDraft(for:)) }.first
    }

    init(url: URL, io: HostLocalIO = HostLocalIO()) {
        self.legacyURL = url; self.url = url.appendingPathExtension("v2"); self.io = io
        let path = self.url
        loadTask = Task { [weak self, io] in
            let current = await io.readJournal(path)
            let legacy = await io.readJournal(url)
            guard let self else { return }
            var source = current?[Self.recordsKey] as? [String: [String: Any]] ?? [:]
            if let legacy, let id = legacy["launchId"] as? String, source[id] == nil { source[id] = legacy }
            self.records = source; self.writeBaseline = source; self.loaded = true
        }
    }
    func waitLoaded() async { await loadTask?.value }
    func flush() async { await waitLoaded(); _ = await tail?.value }

    func reserve(_ value: [String: Any]) -> Task<Bool, Never>? {
        guard loaded, let id = value["launchId"] as? String, records[id] == nil else { return nil }
        var record = value; record["recordedAt"] = Date().timeIntervalSince1970
        return enqueue(id, record)
    }

    /// Freeze only this identity during the durable conversion to an editable draft.
    func abandon(_ id: String) -> Task<Bool, Never>? {
        guard let record = records[id], !retiring.contains(id), record["landedFirstMessage"] == nil else { return nil }
        if Self.isDraft(record) { return Task { true } }
        return retire(id, adding: ["abandoned": true])
    }
    func reject(_ id: String, error: String) -> Task<Bool, Never>? {
        guard acceptsResult(for: id), records[id]?["sessionId"] == nil else { return nil }
        return retire(id, adding: ["rejected": true, "error": error])
    }
    private func retire(_ id: String, adding fields: [String: Any]) -> Task<Bool, Never>? {
        guard let record = records[id] else { return nil }
        return enqueue(id, record.merging(fields) { _, new in new }, retiringRecord: true)
    }
    @discardableResult
    func update(_ id: String, value: [String: Any]?) -> Task<Bool, Never>? {
        guard loaded, records[id] != nil, !retiring.contains(id) else { return nil }
        return enqueue(id, value)
    }
    @discardableResult
    func handoff(_ id: String, firstMessage: ConfiguredFirstMessage?) -> Task<Bool, Never>? {
        guard acceptsResult(for: id) else { return nil }
        // Only keep the outbox copy, not the startup operation or the wire payload.
        return update(id, value: firstMessage.map { ["launchId": id, "landedFirstMessage": $0.fields] })
    }
    func forgetFirstMessages(_ ids: Set<String>) {
        for (id, record) in records {
            if let fields = record["landedFirstMessage"] as? [String: Any], let messageId = fields["messageId"] as? String,
               ids.contains(messageId) { update(id, value: nil) }
        }
    }
    private func enqueue(_ id: String, _ record: [String: Any]?, retiringRecord: Bool = false) -> Task<Bool, Never> {
        if retiringRecord { retiring.insert(id) }
        else { records[id] = record }
        let prior = tail
        let task = Task { [weak self] in
            _ = await prior?.value
            guard let self else { return false }
            var next = self.writeBaseline; next[id] = record
            let saved = await self.io.writeJournal([Self.recordsKey: next], to: self.url)
            if saved {
                _ = await self.io.writeJournal(nil, to: self.legacyURL, skipIfAbsent: true)
                self.writeBaseline = next
            } else if !retiringRecord {
                // Keep the accepted local mutation available for a retry or a
                // later successful write; a failed retire never becomes durable this way.
                self.writeBaseline = next
            }
            if retiringRecord {
                if saved { self.records[id] = record }
                self.retiring.remove(id)
            }
            return saved
        }
        tail = task
        return task
    }
}

/// Shared by the hub, so replacement connections cannot race old writes to the
/// same file. Catalog caches are replaceable; durable launch records are not.
@MainActor
final class HostLocalStores {
    private let io: HostLocalIO
    private var journals: [URL: ConfiguredLaunchJournal] = [:]
    private var pendingCatalogs: [String: ([SessionSummary]?, UserDefaults?)] = [:]
    private var catalogTask: Task<Void, Never>?
    init(io: HostLocalIO = HostLocalIO()) { self.io = io }
    func journal(at url: URL) -> ConfiguredLaunchJournal {
        if let existing = journals[url] { return existing }
        let journal = ConfiguredLaunchJournal(url: url, io: io)
        journals[url] = journal
        return journal
    }
    func loadCatalog(key: String, preferences: UserDefaults?) async -> [SessionSummary] {
        await catalogTask?.value
        return await io.loadCatalog(key: key, preferences: preferences)
    }
    func saveCatalog(_ sessions: [SessionSummary]?, key: String, preferences: UserDefaults?) {
        pendingCatalogs[key] = (sessions, preferences)
        guard catalogTask == nil else { return }
        catalogTask = Task { [self] in
            while let key = pendingCatalogs.keys.first, let value = pendingCatalogs.removeValue(forKey: key) {
                await io.saveCatalog(value.0, key: key, preferences: value.1)
            }
            catalogTask = nil
        }
    }
    func flush() async {
        await catalogTask?.value
        for journal in journals.values { await journal.flush() }
    }
}
