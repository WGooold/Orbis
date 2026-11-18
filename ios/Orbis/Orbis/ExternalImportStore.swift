import Darwin
import Foundation

struct ExternalImportedFile: Codable, Equatable, Sendable {
    let name: String
    let bytes: Int64
}

/// A local draft can only be used by this exact paired computer and Session.
struct ExternalImportTarget: Codable, Hashable, Sendable {
    let hostId: String
    let pairingKey: String
    let sessionId: String
    let cwd: String
}

/// Display labels are a snapshot, never used as routing identity.
struct ExternalImportDestination: Codable, Equatable, Identifiable, Sendable {
    let target: ExternalImportTarget
    let hostName: String
    let sessionName: String
    var id: ExternalImportTarget { target }
}

struct ExternalImportBatch: Codable, Equatable, Identifiable, Sendable {
    let id: UUID
    let createdAt: Date
    let text: String?
    let files: [ExternalImportedFile]
    var destination: ExternalImportDestination? = nil
}

enum ExternalImportProblem: Error, Equatable {
    case empty, unsupported, limit, full, busy, unreadable, targetUnavailable, alreadyAssigned
}

/// Retains ownership across asynchronous provider callbacks and across process death.
final class ExternalImportStage: Sendable {
    let id: UUID
    private let fd: Int32

    fileprivate init(id: UUID, fd: Int32) { self.id = id; self.fd = fd }
    deinit { close(fd) }
}

/// Shared with the extension. Disk work must run off Main; no network or origin bookmarks.
struct ExternalImportStore: Sendable {
    static let fileCount = 10
    static let textBytes = 256 * 1024
    private static let batchCount = 16
    let root: URL
    var batchBytes: Int64 = 100 * 1024 * 1024
    var inboxBytes: Int64 = 256 * 1024 * 1024

    #if os(iOS)
    static func applicationInbox(bundle: Bundle = .main) throws -> Self {
        guard let group = bundle.object(forInfoDictionaryKey: "OrbisImportAppGroup") as? String,
              let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else {
            throw ExternalImportProblem.unreadable
        }
        // Not in Documents: file sharing must not expose the import staging area.
        return Self(root: container.appendingPathComponent("Library/Application Support/ExternalImports", isDirectory: true))
    }
    #endif

    func list() throws -> [ExternalImportBatch] {
        try withLock { try listLocked() }
    }

    func begin() throws -> ExternalImportStage {
        try withLock {
            let manager = FileManager.default
            var currentStages = 0
            for entry in try entries() where entry.lastPathComponent.hasPrefix("stage-") {
                let fd = try stageLock(entry)
                defer { close(fd) }
                if flock(fd, LOCK_EX | LOCK_NB) == 0 { try manager.removeItem(at: entry) }
                else if errno == EWOULDBLOCK { currentStages += 1 }
                else { throw ExternalImportProblem.unreadable }
            }
            guard currentStages < 2 else { throw ExternalImportProblem.busy }
            let id = UUID(), directory = staging(id)
            try manager.createDirectory(at: directory, withIntermediateDirectories: false)
            do {
                let fd = try stageLock(directory)
                guard flock(fd, LOCK_EX | LOCK_NB) == 0 else { close(fd); throw ExternalImportProblem.unreadable }
                return ExternalImportStage(id: id, fd: fd)
            } catch {
                try? manager.removeItem(at: directory)
                throw error
            }
        }
    }

    func discard(_ stage: ExternalImportStage) {
        try? withLock {
            let directory = staging(stage.id)
            if FileManager.default.fileExists(atPath: directory.path) { try FileManager.default.removeItem(at: directory) }
        }
    }

    /// Copy before a provider's callback returns. Every byte is counted, even when its reported size was valid.
    func copy(_ source: URL, name: String? = nil, into stage: ExternalImportStage, index: Int, used: Int64) throws -> ExternalImportedFile {
        guard source.isFileURL else { throw ExternalImportProblem.unsupported }
        guard index >= 0, index < Self.fileCount, used >= 0, used < batchBytes else { throw ExternalImportProblem.limit }
        let fd = open(source.path, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw ExternalImportProblem.unreadable }
        let input = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        defer { try? input.close() }
        var stat = stat()
        guard fstat(fd, &stat) == 0, stat.st_mode & S_IFMT == S_IFREG, stat.st_size > 0 else {
            throw ExternalImportProblem.unreadable
        }
        guard stat.st_size <= batchBytes - used else { throw ExternalImportProblem.limit }
        let target = payload(staging(stage.id), index)
        let targetFD = open(target.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, S_IRUSR | S_IWUSR)
        guard targetFD >= 0 else { throw ExternalImportProblem.unreadable }
        let output = FileHandle(fileDescriptor: targetFD, closeOnDealloc: true)
        defer { try? output.close() }
        do {
            var count: Int64 = 0
            while let piece = try input.read(upToCount: 64 * 1024), !piece.isEmpty {
                count += Int64(piece.count)
                guard count <= batchBytes - used else { throw ExternalImportProblem.limit }
                guard count <= stat.st_size else { throw ExternalImportProblem.unreadable }
                try output.write(contentsOf: piece)
            }
            guard count == stat.st_size else { throw ExternalImportProblem.unreadable }
            try output.close()
            return ExternalImportedFile(name: Self.displayName(name ?? source.lastPathComponent), bytes: count)
        } catch {
            try? FileManager.default.removeItem(at: target)
            throw error
        }
    }

    func publish(_ stage: ExternalImportStage, text: String?, files: [ExternalImportedFile]) throws -> ExternalImportBatch {
        let text = try Self.checkedText(text)
        guard text != nil || !files.isEmpty else { throw ExternalImportProblem.empty }
        guard files.count <= Self.fileCount else { throw ExternalImportProblem.limit }
        return try withLock {
            let manager = FileManager.default
            let id = stage.id, directory = staging(stage.id)
            let stagedFiles = try manager.contentsOfDirectory(atPath: directory.path)
            guard Set(stagedFiles) == Set(files.indices.map { "file-\($0)" } + [".owner"]) else { throw ExternalImportProblem.unreadable }
            var bytes: Int64 = 0
            for (index, file) in files.enumerated() {
                let attributes = try manager.attributesOfItem(atPath: payload(directory, index).path)
                guard attributes[.type] as? FileAttributeType == .typeRegular,
                      let size = (attributes[.size] as? NSNumber)?.int64Value, size > 0, size == file.bytes else {
                    throw ExternalImportProblem.unreadable
                }
                guard size <= batchBytes - bytes else { throw ExternalImportProblem.limit }
                bytes += size
            }
            let existing = try listLocked()
            let used = existing.reduce(Int64(0)) { total, batch in
                total + batch.files.reduce(0) { $0 + $1.bytes } + Int64(batch.text?.utf8.count ?? 0)
            }
            guard existing.count < Self.batchCount, used + bytes + Int64(text?.utf8.count ?? 0) <= inboxBytes else {
                throw ExternalImportProblem.full
            }
            let batch = ExternalImportBatch(id: id, createdAt: Date(), text: text, files: files)
            let manifest = directory.appendingPathComponent("batch.json")
            try JSONEncoder().encode(batch).write(to: manifest, options: .atomic)
            do { try move(directory, to: ready(id)) }
            catch { try? manager.removeItem(at: manifest); throw error }
            return batch
        }
    }

    /// Replaces only the manifest. The original payload and batch identity never move or duplicate.
    func assign(_ id: UUID, to destination: ExternalImportDestination) throws -> ExternalImportBatch {
        try update(id) { batch in
            if let assigned = batch.destination {
                guard assigned.target == destination.target else { throw ExternalImportProblem.alreadyAssigned }
            } else {
                batch.destination = destination
            }
        }
    }

    func unassign(_ id: UUID, from target: ExternalImportTarget) throws -> ExternalImportBatch {
        try update(id) { batch in
            guard batch.destination?.target == target else { throw ExternalImportProblem.targetUnavailable }
            batch.destination = nil
        }
    }

    private func update(_ id: UUID, _ change: (inout ExternalImportBatch) throws -> Void) throws -> ExternalImportBatch {
        try withLock {
            let directory = ready(id)
            var batch = try readBatch(directory, id: id)
            let before = batch
            try change(&batch)
            if batch != before {
                try JSONEncoder().encode(batch).write(to: directory.appendingPathComponent("batch.json"), options: .atomic)
            }
            return batch
        }
    }

    func delete(_ id: UUID) throws {
        try withLock {
            let source = ready(id)
            guard FileManager.default.fileExists(atPath: source.path) else { return }
            // Unpublish before unlinking; a killed process cannot expose a partly deleted batch.
            let directory = staging(UUID())
            try move(source, to: directory)
            try FileManager.default.removeItem(at: directory)
        }
    }

    func importDocument(_ source: URL) throws -> ExternalImportBatch {
        let stage = try begin()
        defer { discard(stage) }
        let file = try copyOpenedDocument(source, into: stage, index: 0, used: 0)
        return try publish(stage, text: nil, files: [file])
    }

    func copyOpenedDocument(_ source: URL, name: String? = nil, into stage: ExternalImportStage,
                            index: Int, used: Int64) throws -> ExternalImportedFile {
        guard source.isFileURL else { throw ExternalImportProblem.unsupported }
        let scoped = source.startAccessingSecurityScopedResource()
        defer { if scoped { source.stopAccessingSecurityScopedResource() } }
        var coordinatedError: NSError?
        var file: Result<ExternalImportedFile, Error>?
        NSFileCoordinator().coordinate(readingItemAt: source, options: [], error: &coordinatedError) { readable in
            file = Result { try copy(readable, name: name ?? source.lastPathComponent, into: stage, index: index, used: used) }
        }
        if let coordinatedError { throw coordinatedError }
        guard let file else { throw ExternalImportProblem.unreadable }
        return try file.get()
    }

    static func checkedText(_ text: String?) throws -> String? {
        guard let text else { return nil }
        guard text.utf8.count <= textBytes else { throw ExternalImportProblem.limit }
        return text.allSatisfy(\.isWhitespace) ? nil : text
    }

    static func displayName(_ raw: String) -> String {
        let component = raw.replacingOccurrences(of: "\\", with: "/").components(separatedBy: "/").last ?? ""
        let safe = String(component.unicodeScalars.filter {
            !CharacterSet.controlCharacters.contains($0) && !(0x202a...0x202e).contains($0.value) && !(0x2066...0x2069).contains($0.value)
        }).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !safe.isEmpty, safe != ".", safe != ".." else { return "file" }
        guard safe.count > 240 else { return safe }
        let ext = (safe as NSString).pathExtension
        let suffix = (1...24).contains(ext.count) ? "." + ext : ""
        return String(safe.prefix(240 - suffix.count)) + suffix
    }

    private func withLock<T>(_ action: () throws -> T) throws -> T {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        var directory = root
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try directory.setResourceValues(values)
        let fd = open(root.appendingPathComponent(".lock").path, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, S_IRUSR | S_IWUSR)
        guard fd >= 0 else { throw ExternalImportProblem.unreadable }
        defer { close(fd) }
        while flock(fd, LOCK_EX) != 0 { if errno != EINTR { throw ExternalImportProblem.unreadable } }
        return try action()
    }

    private func stageLock(_ directory: URL) throws -> Int32 {
        let fd = open(directory.appendingPathComponent(".owner").path, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, S_IRUSR | S_IWUSR)
        guard fd >= 0 else { throw ExternalImportProblem.unreadable }
        return fd
    }

    private func entries() throws -> [URL] {
        try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
    }

    private func listLocked() throws -> [ExternalImportBatch] {
        try entries().compactMap { directory in
            let name = directory.lastPathComponent
            guard name.hasPrefix("ready-"), let id = UUID(uuidString: String(name.dropFirst(6))) else { return nil }
            return try readBatch(directory, id: id)
        }.sorted { $0.createdAt > $1.createdAt }
    }

    private func readBatch(_ directory: URL, id: UUID) throws -> ExternalImportBatch {
        let batch = try JSONDecoder().decode(ExternalImportBatch.self, from: Data(contentsOf: directory.appendingPathComponent("batch.json")))
        guard batch.id == id else { throw ExternalImportProblem.unreadable }
        return batch
    }

    private func move(_ source: URL, to destination: URL) throws {
        guard !FileManager.default.fileExists(atPath: destination.path), rename(source.path, destination.path) == 0 else {
            throw ExternalImportProblem.unreadable
        }
    }
    private func staging(_ id: UUID) -> URL { root.appendingPathComponent("stage-" + id.uuidString, isDirectory: true) }
    private func ready(_ id: UUID) -> URL { root.appendingPathComponent("ready-" + id.uuidString, isDirectory: true) }
    private func payload(_ directory: URL, _ index: Int) -> URL { directory.appendingPathComponent("file-\(index)") }
}
