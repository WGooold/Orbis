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
    func writeJournal(_ value: [String: Any]?, to url: URL) -> Bool {
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

/// UI reads only this snapshot. The tail includes the durable completion of every
/// accepted write; identity checks prevent late cleanup from erasing a new launch.
@MainActor
final class ConfiguredLaunchJournal {
    struct RecoveredDraft {
        let agentKind: String
        let cwd: String
        let text: String
    }
    private(set) var snapshot: [String: Any]?
    private(set) var loaded = false
    private var loadTask: Task<Void, Never>?
    private var tail: Task<Bool, Never>?
    private let io: HostLocalIO
    private let url: URL
    private(set) var retiringId: String?
    var launchId: String? { snapshot?["launchId"] as? String }
    var pendingId: String? { isDraft ? nil : launchId }
    var blocksNewLaunch: Bool { !loaded || retiringId != nil || (snapshot != nil && !isDraft) }
    func acceptsResult(for id: String) -> Bool { pendingId == id && retiringId == nil }
    private var isDraft: Bool { snapshot?["rejected"] as? Bool == true || snapshot?["abandoned"] as? Bool == true }
    var recoveredDraft: RecoveredDraft? {
        guard isDraft, let agent = snapshot?["agentKind"] as? String, let cwd = snapshot?["cwd"] as? String else { return nil }
        return RecoveredDraft(agentKind: agent, cwd: cwd, text: snapshot?["firstMessage"] as? String ?? "")
    }

    init(url: URL, io: HostLocalIO = HostLocalIO()) {
        self.url = url; self.io = io
        loadTask = Task { [weak self, io] in
            let value = await io.readJournal(url)
            guard let self else { return }
            self.snapshot = value; self.loaded = true
        }
    }
    func waitLoaded() async { await loadTask?.value }
    func flush() async { await waitLoaded(); _ = await tail?.value }

    /// A failed or explicitly abandoned record remains recoverable as a draft, but can be replaced by a new launch.
    func reserve(_ value: [String: Any]) -> Task<Bool, Never>? {
        guard !blocksNewLaunch else { return nil }
        return update(expectedId: launchId, value: value)
    }

    /// Freeze recovery immediately, but do not release the old launch or publish a draft
    /// until the replacement is durable. A failed write leaves the original snapshot intact.
    func abandon(_ id: String) -> Task<Bool, Never>? {
        guard loaded, launchId == id, retiringId == nil else { return nil }
        if isDraft { return Task { true } }
        return retire(id, adding: ["abandoned": true])
    }

    func reject(_ id: String, error: String) -> Task<Bool, Never>? {
        guard acceptsResult(for: id), snapshot?["sessionId"] == nil else { return nil }
        return retire(id, adding: ["rejected": true, "error": error])
    }

    private func retire(_ id: String, adding fields: [String: Any]) -> Task<Bool, Never>? {
        guard loaded, launchId == id, retiringId == nil, let saved = snapshot else { return nil }
        let draft = saved.merging(fields) { _, new in new }
        retiringId = id
        let prior = tail, io = io, url = url
        let task = Task { [weak self] in
            _ = await prior?.value
            let saved = await io.writeJournal(draft, to: url)
            if saved { self?.snapshot = draft }
            self?.retiringId = nil
            return saved
        }
        tail = task
        return task
    }

    @discardableResult
    func update(expectedId: String?, value: [String: Any]?) -> Task<Bool, Never>? {
        guard loaded, launchId == expectedId, retiringId == nil else { return nil }
        snapshot = value
        let prior = tail, io = io, url = url
        let task = Task {
            _ = await prior?.value
            return await io.writeJournal(value, to: url)
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
