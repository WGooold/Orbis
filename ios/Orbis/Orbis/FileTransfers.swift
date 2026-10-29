import Foundation
import Combine
import CryptoKit

struct ArtifactChunk: Equatable {
    let runtimeId: String
    let transferId: String
    let offset: Int64
    let bytes: Data

    func encoded() throws -> Data {
        let runtime = Data(runtimeId.utf8), transfer = Data(transferId.utf8)
        guard !runtime.isEmpty, runtime.count <= 256, !transfer.isEmpty, transfer.count <= 256,
              offset >= 0, offset <= 9_007_199_254_740_991, !bytes.isEmpty, bytes.count <= 1_048_576 else { throw transferError("文件分片无效") }
        var data = Data([0x50, 0x49, 0x52, 0x33, UInt8(orbisProtocolVersion), 1])
        func append(_ value: UInt64, count: Int) { for shift in stride(from: (count - 1) * 8, through: 0, by: -8) { data.append(UInt8((value >> UInt64(shift)) & 255)) } }
        append(UInt64(runtime.count), count: 2); append(UInt64(transfer.count), count: 2); append(0, count: 2)
        append(UInt64(offset), count: 8); append(UInt64(bytes.count), count: 4)
        data.append(runtime); data.append(transfer); data.append(bytes)
        return data
    }
    static func decode(_ data: Data) throws -> ArtifactChunk {
        let data = Array(data)
        guard data.count >= 24, Array(data[0..<6]) == [0x50, 0x49, 0x52, 0x33, UInt8(orbisProtocolVersion), 1], data[10] == 0, data[11] == 0 else { throw transferError("文件分片格式无效") }
        func read(_ offset: Int, _ length: Int) -> UInt64 { data[offset..<(offset + length)].reduce(0) { ($0 << 8) | UInt64($1) } }
        let r = Int(read(6, 2)), t = Int(read(8, 2)), count = Int(read(20, 4)), offset = read(12, 8)
        guard (1...256).contains(r), (1...256).contains(t), (1...1_048_576).contains(count),
              data.count == 24 + r + t + count, offset <= 9_007_199_254_740_991,
              let runtime = String(bytes: data[24..<(24 + r)], encoding: .utf8), !runtime.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let transfer = String(bytes: data[(24 + r)..<(24 + r + t)], encoding: .utf8), !transfer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw transferError("文件分片长度无效") }
        return ArtifactChunk(runtimeId: runtime, transferId: transfer, offset: Int64(offset), bytes: Data(data[(24 + r + t)...]))
    }
}

/// Receiver-owned range scheduling mirrors Android: bounded in-flight bytes,
/// durable-prefix progress, and one oldest-hole retry with exponential backoff.
@MainActor
final class PullScheduler {
    static let chunkBytes = 1_048_576
    static let initialWindow: Int64 = 4 * 1_048_576
    static let maximumWindow: Int64 = 8 * 1_048_576
    private struct Outstanding { var requestId: String; let length: Int; var sentAt: Int64; var retransmitted = false }
    private let size: Int64
    private let send: (String, Int64, Int) -> Bool
    private let now: () -> Int64
    private var outstanding: [Int64: Outstanding] = [:]
    private var highestIssued: Int64
    private var retryStarted: Int64 = 0
    private var retryBackoff: Int64 = 0
    private var srtt: Int64 = 0
    private var rttvar: Int64 = 0
    private var bandwidth: Double = 0
    private var delivered = 0
    private var sampledAt: Int64 = 0
    private(set) var durableOffset: Int64
    private(set) var window = initialWindow
    var interactive = false
    var paused = false
    var complete: Bool { durableOffset >= size }
    var inFlight: Int { outstanding.count }

    init(size: Int64, startOffset: Int64, send: @escaping (String, Int64, Int) -> Bool,
         now: @escaping () -> Int64 = { Int64(ProcessInfo.processInfo.systemUptime * 1000) }) {
        self.size = size; durableOffset = startOffset; highestIssued = startOffset; self.send = send; self.now = now
    }
    func accepts(offset: Int64, length: Int) -> Bool { outstanding[offset]?.length == length }
    func contains(requestId: String) -> Bool { outstanding.values.contains { $0.requestId == requestId } }
    func tick() {
        guard !paused else { return }
        let instant = now()
        if let offset = outstanding.keys.min(), var entry = outstanding[offset] {
            let rto = max(srtt == 0 ? 5000 : min(60_000, max(1000, srtt + 4 * rttvar)), retryBackoff)
            if instant - retryStarted > rto {
                window = max(window / 2, Int64(Self.chunkBytes))
                entry.requestId = UUID().uuidString; entry.sentAt = instant; entry.retransmitted = true
                outstanding[offset] = entry; retryStarted = instant; retryBackoff = min(60_000, rto * 2)
                guard send(entry.requestId, offset, entry.length) else { paused = true; return }
            }
        }
        let effective = interactive ? min(window, Int64(Self.chunkBytes)) : window
        while highestIssued < size && highestIssued - durableOffset < effective {
            let length = Int(min(Int64(interactive ? 131_072 : Self.chunkBytes), size - highestIssued, effective - (highestIssued - durableOffset)))
            let offset = highestIssued, id = UUID().uuidString
            if outstanding.isEmpty { retryStarted = instant }
            outstanding[offset] = Outstanding(requestId: id, length: length, sentAt: instant)
            highestIssued += Int64(length)
            guard send(id, offset, length) else { paused = true; return }
        }
    }
    func onChunk(offset: Int64, length: Int, durableOffsetAfterWrite: Int64) {
        guard let entry = outstanding[offset], entry.length == length else { return }
        outstanding[offset] = nil
        let instant = now(), sample = instant - entry.sentAt
        if !entry.retransmitted && sample > 0 {
            if srtt == 0 { srtt = sample; rttvar = sample / 2 }
            else { rttvar = (3 * rttvar + abs(srtt - sample)) / 4; srtt = (7 * srtt + sample) / 8 }
        }
        let contiguous = offset == durableOffset
        durableOffset = max(durableOffset, durableOffsetAfterWrite); retryStarted = instant; retryBackoff = 0
        delivered += length
        if sampledAt == 0 { sampledAt = instant }
        else if instant - sampledAt >= 500 {
            let sample = Double(delivered) / Double(instant - sampledAt)
            bandwidth = bandwidth == 0 ? sample : bandwidth * 0.75 + sample * 0.25
            sampledAt = instant; delivered = 0
        }
        if contiguous && !complete {
            let ceiling = bandwidth > 0 ? max(Int64(Self.chunkBytes), min(Self.maximumWindow, Int64(bandwidth * Double(srtt) * 1.5))) : Self.maximumWindow
            window = min(window + Int64(Self.chunkBytes), max(ceiling, window), Self.maximumWindow)
        }
    }
}

private func transferError(_ message: String) -> NSError { NSError(domain: "OrbisTransfer", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }

struct FileTransfer: Codable, Identifiable, Equatable {
    let id: String
    let hostKey: String
    let hostId: String
    let runtimeId: String
    let sessionId: String?
    let direction: String
    var name: String
    var sourcePath: String?
    var artifactId: String?
    var size: Int64 = 0
    var received: Int64 = 0
    var sha256: String?
    var localPath: String?
    var remotePath: String?
    var status = "queued"
    var error: String?
    var transferId: String?
    var commandId: String?
    var requestId: String?
    var attached = true
}

@MainActor
final class FileTransfers: ObservableObject {
    @Published private(set) var tasks: [FileTransfer] = []
    @Published private(set) var preparing = false
    @Published var error: String?
    var send: ([String: Any]) -> Bool = { _ in false }
    var sendBinary: (Data) -> Bool = { _ in false }
    private let root: URL
    private let manifest: URL
    private let metadataWorker: TransferMetadataWorker
    private var metadataRevision: UInt64 = 0
    private var bootstrap: Task<Void, Never>?
    private var removedIds: Set<String> = []
    private var purgedHostKeys: Set<String> = []
    private var ioTasks: [UUID: Task<Void, Never>] = [:]
    private var diskWorkers: [String: TransferDiskWorker] = [:]
    private var diskGenerations: [String: UUID] = [:]
    private var pairing: HostPairing?
    private var connected = false
    private var timeouts: [String: Task<Void, Never>] = [:]
    private var preparingGeneration = UUID()
    private final class Download {
        let scheduler: PullScheduler
        var pending: [Int64: Data] = [:]
        var pendingBytes = 0
        var writing = false
        init(_ scheduler: PullScheduler) { self.scheduler = scheduler }
    }
    private var downloads: [String: Download] = [:]
    private var pullTimer: Task<Void, Never>?
    private var interactive = false

    /// Match Android's reduced receive window while the user is interacting.
    func setInteractive(_ value: Bool) {
        interactive = value
        for download in downloads.values { download.scheduler.interactive = value }
    }


    init(root: URL, pairing: HostPairing? = nil) {
        self.root = root
        manifest = root.appendingPathComponent(pairing.map { "transfers-" + Self.pairingKey($0) + ".json" } ?? "transfers.json")
        metadataWorker = TransferMetadataWorker(file: manifest)
        let worker = metadataWorker, fallback = root.appendingPathComponent("transfers.json"), expectedKey = pairing.map(Self.pairingKey)
        bootstrap = Task { [weak self] in
            do {
                guard let data = try await worker.load(fallback: fallback) else { return }
                let stored = try await Task.detached { try JSONDecoder().decode([FileTransfer].self, from: data) }.value
                guard let self else { return }
                let discarded = stored.filter { self.removedIds.contains($0.id) || self.purgedHostKeys.contains($0.hostKey) }
                for item in discarded { self.removeFiles(item) }
                let currentIds = Set(self.tasks.map(\.id))
                self.tasks += stored.filter { !self.removedIds.contains($0.id) && !self.purgedHostKeys.contains($0.hostKey) && !currentIds.contains($0.id) && (expectedKey == nil || $0.hostKey == expectedKey) }.map { item in
                    var item = item
                    if ["queued", "downloading", "uploading", "verifying"].contains(item.status) { item.status = "paused"; item.transferId = nil; item.commandId = nil; item.requestId = nil }
                    return item
                }
                if !discarded.isEmpty { self.save() }
            } catch { self?.error = "无法读取传输记录：\(error.localizedDescription)" }
        }
    }

    /// Tests and lifecycle callers can await real disk completion without sleeping or observing
    /// a spinner. Timers and pending remote responses are intentionally outside this barrier.
    func waitForPendingIO() async {
        await bootstrap?.value
        while !ioTasks.isEmpty {
            let running = Array(ioTasks.values)
            for task in running { await task.value }
        }
    }
    private func enqueueIO(_ operation: @escaping @MainActor () async -> Void) {
        let id = UUID()
        ioTasks[id] = Task { [weak self] in
            await operation()
            self?.ioTasks[id] = nil
        }
    }
    private func worker(_ id: String, path: String? = nil) -> TransferDiskWorker {
        if let worker = diskWorkers[id] { return worker }
        let worker = TransferDiskWorker(file: path.map(URL.init(fileURLWithPath:)) ?? root.appendingPathComponent(id + ".part"))
        diskWorkers[id] = worker; return worker
    }
    private func renewGeneration(_ id: String, path: String? = nil) -> (TransferDiskWorker, UUID) {
        let worker = worker(id, path: path), generation = UUID()
        worker.setGeneration(generation); diskGenerations[id] = generation
        return (worker, generation)
    }
    private func current(_ id: String, generation: UUID, status: String? = nil) -> Int? {
        guard diskGenerations[id] == generation else { return nil }
        return tasks.firstIndex { $0.id == id && $0.hostKey == hostKey && (status == nil || $0.status == status) }
    }
    private func invalidateDisk(_ id: String) {
        let previous = diskGenerations[id]
        diskWorkers[id]?.invalidate(); diskGenerations[id] = nil
        if let worker = diskWorkers[id], let previous { enqueueIO { try? await worker.pause(generation: previous) } }
    }
    var currentTasks: [FileTransfer] { tasks.filter { $0.hostKey == hostKey } }
    var activeCount: Int { currentTasks.filter { ["queued", "downloading", "uploading", "verifying"].contains($0.status) }.count }
    var hostKey: String { pairing.map(Self.pairingKey) ?? "" }
    static func pairingKey(_ host: HostPairing) -> String {
        let text = [host.hostId, host.relay.relayUrl, host.relay.deviceId].joined(separator: "\n")
        return SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
    }
    func setConnection(_ host: HostPairing?, connected: Bool) {
        let changed = pairing.map(Self.pairingKey) != host.map(Self.pairingKey)
        if !connected || changed {
            for id in diskWorkers.keys { invalidateDisk(id) }
            for index in tasks.indices where ["queued", "downloading", "uploading", "verifying"].contains(tasks[index].status) {
                tasks[index].status = "paused"; tasks[index].transferId = nil; tasks[index].commandId = nil; tasks[index].requestId = nil
            }
            timeouts.values.forEach { $0.cancel() }; timeouts = [:]
            downloads = [:]; pullTimer?.cancel(); pullTimer = nil
            preparingGeneration = UUID(); preparing = false
            save()
        }
        pairing = host; self.connected = connected
    }
    /// Downloads belong to the Host, never to a session: the task records no session identity.
    func download(path: String? = nil, artifact: RemoteArtifact? = nil) {
        guard let pairing, connected, path?.isEmpty == false || artifact != nil else { error = "连接电脑后可下载文件。"; return }
        var task = FileTransfer(id: UUID().uuidString, hostKey: hostKey, hostId: pairing.hostId, runtimeId: pairing.hostId,
            sessionId: nil, direction: "download", name: artifact?.fileName ?? directoryTitle(path ?? "文件"), sourcePath: path, artifactId: artifact?.artifactId)
        task.size = artifact?.size ?? 0; task.sha256 = artifact?.sha256
        tasks.insert(task, at: 0); restart(task.id)
    }
    func restart(_ id: String) {
        guard let index = tasks.firstIndex(where: { $0.id == id && $0.hostKey == hostKey }), connected,
              !["downloading", "uploading", "verifying", "completed"].contains(tasks[index].status),
              tasks[index].status != "queued" || tasks[index].commandId == nil else { return }
        var task = tasks[index]
        task.status = "queued"; task.error = nil; task.transferId = nil; task.requestId = nil
        let command = UUID().uuidString; task.commandId = command
        if task.direction == "download" {
            let (disk, generation) = renewGeneration(id)
            tasks[index] = task
            enqueueIO { [weak self] in
                do {
                    let snapshot = try await disk.resume(generation: generation)
                    guard let self, let index = self.current(id, generation: generation, status: "queued"), self.connected else { return }
                    self.tasks[index].received = snapshot.durableOffset
                    var body: [String: Any] = ["type": task.sourcePath == nil ? "artifact.download" : "file.download", "offset": snapshot.durableOffset]
                    if let path = task.sourcePath { body["path"] = path } else { body["artifactId"] = task.artifactId }
                    if !self.send(["type": "runtime.command", "protocolVersion": orbisProtocolVersion, "runtimeId": task.hostId, "commandId": command, "command": body]) { self.fail(id, "下载请求未送达。") }
                    else { self.arm(id) }
                    self.save()
                } catch { if let self, self.current(id, generation: generation) != nil { self.fail(id, error.localizedDescription) } }
            }
        } else {
            guard task.localPath != nil, let hash = task.sha256, let directory = task.remotePath else { fail(id, "上传源文件不可用。请重新选择。"); return }
            _ = renewGeneration(id, path: task.localPath)
            task.requestId = command; tasks[index] = task
            let request: [String: Any] = ["type": "file.upload.init", "protocolVersion": orbisProtocolVersion, "requestId": command,
                "runtimeId": task.runtimeId, "directory": directory, "fileName": task.name, "size": task.size, "sha256": hash]
            if !send(request) { fail(id, "上传请求未送达。") } else { arm(id) }
        }
        save()
    }
    func upload(urls: [URL], runtime: RuntimeSummary) {
        guard connected, let pairing, !preparing else { return }
        let key = hostKey, generation = UUID()
        preparing = true; preparingGeneration = generation
        var staged: [(String, TransferDiskWorker, UUID)] = []
        for _ in urls.prefix(10) {
            let id = UUID().uuidString, local = root.appendingPathComponent(id + ".upload")
            let (disk, token) = renewGeneration(id, path: local.path)
            staged.append((id, disk, token))
        }
        enqueueIO { [weak self] in
            guard let self else { return }
            var prepared: [FileTransfer] = []
            do {
                for (url, item) in zip(urls.prefix(10), staged) {
                    let info = try await item.1.prepareUpload(source: url, generation: item.2, maximumBytes: 100 * 1024 * 1024)
                    guard self.preparingGeneration == generation, self.hostKey == key, self.connected else { throw transferError("上传准备已经取消") }
                    let directory = remoteBrowsePath(parent: remoteBrowsePath(parent: runtime.cwd, name: ".orbis-uploads"), name: info.sha256)
                    prepared.append(FileTransfer(id: item.0, hostKey: key, hostId: pairing.hostId, runtimeId: runtime.runtimeId, sessionId: runtime.sessionId,
                        direction: "upload", name: url.lastPathComponent, size: info.size, sha256: info.sha256, localPath: info.path, remotePath: directory))
                }
                self.tasks.insert(contentsOf: prepared, at: 0); self.preparing = false
                for task in prepared { self.restart(task.id) }
            } catch {
                for (id, disk, _) in staged {
                    let cleanup = UUID(); disk.setGeneration(cleanup); try? await disk.remove(generation: cleanup)
                    self.diskWorkers[id] = nil; self.diskGenerations[id] = nil
                }
                if self.preparingGeneration == generation { self.preparing = false; self.error = error.localizedDescription }
            }
        }
    }
    func cancel(_ id: String) {
        guard let index = tasks.firstIndex(where: { $0.id == id }) else { return }
        let task = tasks[index]
        invalidateDisk(id)
        if task.hostKey == hostKey, connected, let transferId = task.transferId {
            if task.direction == "upload" { _ = send(["type": "file.upload.cancel", "protocolVersion": orbisProtocolVersion, "uploadId": transferId]) }
            else { _ = send(["type": "runtime.command", "protocolVersion": orbisProtocolVersion, "runtimeId": task.hostId, "commandId": UUID().uuidString,
                             "command": ["type": "artifact.cancel", "transferId": transferId]]) }
        }
        downloads[id] = nil
        timeouts.removeValue(forKey: id)?.cancel(); tasks[index].status = "cancelled"; tasks[index].transferId = nil; tasks[index].requestId = nil; tasks[index].commandId = nil
        save()
    }
    func detach(_ ids: Set<String>) {
        for id in ids {
            if let task = tasks.first(where: { $0.id == id }), task.status != "completed" { cancel(id) }
            if let index = tasks.firstIndex(where: { $0.id == id }) { tasks[index].attached = false }
        }
        save()
    }
    func remove(_ ids: Set<String>) {
        removedIds.formUnion(ids)
        for task in tasks where ids.contains(task.id) {
            cancel(task.id)
            removeFiles(task)
        }
        tasks.removeAll { ids.contains($0.id) }; save()
    }
    /// Unpairing may race manifest bootstrap. Keep its host tombstone until bootstrap has
    /// reconciled every persisted task, including files not yet visible in the published list.
    func removeAll(for host: HostPairing) {
        let key = Self.pairingKey(host)
        purgedHostKeys.insert(key)
        remove(Set(tasks.filter { $0.hostKey == key }.map(\.id)))
    }
    private func removeFiles(_ task: FileTransfer) {
        let ownedLocalPath = task.localPath.flatMap { path in
            URL(fileURLWithPath: path).deletingLastPathComponent().standardizedFileURL == root.standardizedFileURL ? path : nil
        }
        let (disk, generation) = renewGeneration(task.id, path: task.direction == "upload" ? ownedLocalPath : nil)
        enqueueIO { [weak self] in
            try? await disk.remove(generation: generation)
            if let path = ownedLocalPath {
                let local = TransferDiskWorker(file: URL(fileURLWithPath: path)), token = UUID()
                local.setGeneration(token); try? await local.remove(generation: token)
            }
            if self?.diskGenerations[task.id] == generation { self?.diskWorkers[task.id] = nil; self?.diskGenerations[task.id] = nil }
        }
    }
    func consume(_ object: [String: Any]) {
        let type = object["type"] as? String ?? ""
        if type == "_artifact.chunk", let data = object["data"] as? Data { receiveChunk(data); return }
        if type == "runtime.event", let event = object["event"] as? [String: Any] { consume(event); return }
        if type == "artifact.started", let commandId = object["commandId"] as? String,
           let index = tasks.firstIndex(where: { $0.commandId == commandId && $0.hostKey == hostKey && $0.status == "queued" }),
           let artifact = object["artifact"] as? [String: Any], let hash = artifact["sha256"] as? String,
           let size = sessionInteger(artifact["size"]), size >= 0, let transfer = object["transferId"] as? String {
            guard hash.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil, size <= 9_007_199_254_740_991,
                  !transfer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, transfer.utf8.count <= 256,
                  object["offset"] == nil || sessionInteger(object["offset"]) == tasks[index].received else { fail(tasks[index].id, "文件下载参数无效，请更新电脑端。"); return }
            if let oldHash = tasks[index].sha256, oldHash != hash { fail(tasks[index].id, "文件内容已更改，请删除任务后重新下载。"); return }
            tasks[index].transferId = transfer; tasks[index].sha256 = hash; tasks[index].size = size; tasks[index].status = "downloading"
            if tasks[index].received > size { fail(tasks[index].id, "本地进度与文件长度不一致。"); return }
            if let name = artifact["fileName"] as? String, !name.isEmpty { tasks[index].name = name }
            beginDownload(tasks[index].id); return
        }
        if type == "command.result", object["ok"] as? Bool == false, let command = object["commandId"] as? String,
           let task = tasks.first(where: { $0.hostKey == hostKey && $0.commandId == command && $0.status == "queued" }) {
            fail(task.id, object["error"] as? String ?? "文件请求被电脑端拒绝。"); return
        }
        if type == "artifact.failed" || type == "artifact.read.failed" {
            if let index = tasks.firstIndex(where: { $0.transferId != nil && $0.transferId == object["transferId"] as? String && $0.hostKey == hostKey && $0.status == "downloading" }) {
                let id = tasks[index].id
                if type == "artifact.read.failed", let request = object["requestId"] as? String,
                   downloads[id]?.scheduler.contains(requestId: request) != true { return }
                fail(id, object["error"] as? String ?? object["reason"] as? String ?? "下载失败。")
            }; return
        }
        if type == "file.upload.ready", let request = object["requestId"] as? String,
           let index = tasks.firstIndex(where: { $0.requestId == request && $0.hostKey == hostKey && $0.status == "queued" }), let upload = object["uploadId"] as? String {
            guard let received = sessionInteger(object["receivedBytes"]), received >= 0, received <= tasks[index].size,
                  !upload.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, upload.utf8.count <= 256 else { fail(tasks[index].id, "上传续传位置无效。"); return }
            tasks[index].transferId = upload; tasks[index].status = "uploading"; tasks[index].received = received
            arm(tasks[index].id); save(); return
        }
        if type.hasPrefix("file.upload."), let upload = object["uploadId"] as? String,
           let index = tasks.firstIndex(where: { $0.transferId == upload && $0.hostKey == hostKey && $0.status == "uploading" }) {
            let task = tasks[index]
            if type == "file.upload.read", let offset = sessionInteger(object["offset"]),
               let length = sessionInteger(object["length"]).map(Int.init), offset >= 0, (1...1_048_576).contains(length), Int64(length) <= task.size - offset,
               let path = task.localPath {
                guard let generation = diskGenerations[task.id] else { return }
                let disk = worker(task.id, path: path)
                enqueueIO { [weak self] in
                    do {
                        let data = try await disk.read(offset: offset, length: length, generation: generation)
                        guard let self, self.current(task.id, generation: generation, status: "uploading") != nil else { return }
                        guard data.count == length, self.sendBinary(try ArtifactChunk(runtimeId: task.runtimeId, transferId: upload, offset: offset, bytes: data).encoded()) else { throw transferError("上传分片未送达。") }
                        self.arm(task.id)
                    } catch { if let self, self.current(task.id, generation: generation) != nil { self.fail(task.id, error.localizedDescription) } }
                }
            } else if type == "file.upload.progress" {
                let count = sessionInteger(object["receivedBytes"]) ?? task.received
                guard count >= 0, count <= task.size else { fail(task.id, "上传进度超出文件范围。"); return }
                tasks[index].received = max(task.received, count); arm(task.id); save()
            } else if type == "file.upload.finished" {
                guard object["sha256"] as? String == task.sha256, sessionInteger(object["size"]) == task.size, let path = object["path"] as? String else { fail(task.id, "上传结果校验失败。"); return }
                tasks[index].remotePath = path; tasks[index].received = task.size; tasks[index].status = "completed"
                timeouts.removeValue(forKey: task.id)?.cancel(); save()
            }
        }
        if type == "file.upload.failed" || type == "protocol.error" {
            if let index = tasks.firstIndex(where: { task in
                task.hostKey == hostKey && ["queued", "downloading", "uploading"].contains(task.status) && ((task.commandId != nil && task.commandId == object["commandId"] as? String) ||
                    (task.requestId != nil && task.requestId == object["requestId"] as? String) || (task.transferId != nil && task.transferId == object["uploadId"] as? String))
            }) { fail(tasks[index].id, object["message"] as? String ?? "文件传输失败。") }
        }
    }
    private func beginDownload(_ id: String) {
        guard let task = tasks.first(where: { $0.id == id }), let generation = diskGenerations[id] else { return }
        let disk = worker(id)
        enqueueIO { [weak self] in
            do {
                let snapshot = try await disk.resume(generation: generation, expectedSize: task.size)
                guard let self, self.current(id, generation: generation, status: "downloading") != nil else { return }
                guard snapshot.durableOffset == task.received else { self.fail(id, "下载续传位置已改变，请重试。"); return }
                self.startScheduler(id)
            } catch { if let self, self.current(id, generation: generation) != nil { self.fail(id, error.localizedDescription) } }
        }
    }
    private func startScheduler(_ id: String) {
        guard let task = tasks.first(where: { $0.id == id }), let transfer = task.transferId else { return }
        timeouts.removeValue(forKey: id)?.cancel()
        let scheduler = PullScheduler(size: task.size, startOffset: task.received) { [weak self] request, offset, length in
            guard let self, self.connected, self.tasks.contains(where: { $0.id == id && $0.status == "downloading" && $0.transferId == transfer && $0.hostKey == self.hostKey }) else { return false }
            guard self.send(["type": "artifact.read", "protocolVersion": orbisProtocolVersion, "transferId": transfer,
                             "requestId": request, "offset": offset, "length": length]) else { self.fail(id, "文件读取请求未送达。"); return false }
            return true
        }
        scheduler.interactive = interactive
        downloads[id] = Download(scheduler)
        save(); tickDownloads()
        if pullTimer == nil, !downloads.isEmpty {
            pullTimer = Task { [weak self] in
                while !Task.isCancelled {
                    do { try await Task.sleep(nanoseconds: 250_000_000) } catch { return }
                    guard let self else { return }
                    self.tickDownloads()
                    if self.downloads.isEmpty { self.pullTimer = nil; return }
                }
            }
        }
    }
    private func tickDownloads() {
        for (id, download) in downloads {
            download.scheduler.tick()
            if download.scheduler.complete { downloads[id] = nil; completeDownload(id) }
        }
    }
    private func receiveChunk(_ data: Data) {
        guard let chunk = try? ArtifactChunk.decode(data), let index = tasks.firstIndex(where: {
            $0.transferId == chunk.transferId && $0.hostKey == hostKey && $0.status == "downloading" && chunk.runtimeId == $0.hostId
        }), let download = downloads[tasks[index].id], download.scheduler.accepts(offset: chunk.offset, length: chunk.bytes.count) else { return }
        let task = tasks[index]
        guard chunk.offset >= task.received, Int64(chunk.bytes.count) <= task.size - chunk.offset,
              download.pending[chunk.offset] == nil, download.pendingBytes + chunk.bytes.count <= PullScheduler.maximumWindow else { return }
        download.pending[chunk.offset] = chunk.bytes; download.pendingBytes += chunk.bytes.count
        if chunk.offset != task.received { download.scheduler.onChunk(offset: chunk.offset, length: chunk.bytes.count, durableOffsetAfterWrite: task.received) }
        flushDownload(task.id)
    }
    private func flushDownload(_ id: String) {
        guard let task = tasks.first(where: { $0.id == id && $0.status == "downloading" }), let download = downloads[id], !download.writing,
              let generation = diskGenerations[id], download.pending[task.received] != nil else { return }
        var chunks: [(Int64, Data)] = [], next = task.received
        while let bytes = download.pending.removeValue(forKey: next) {
            chunks.append((next, bytes)); next += Int64(bytes.count); download.pendingBytes -= bytes.count
        }
        download.writing = true
        let disk = worker(id)
        enqueueIO { [weak self] in
            do {
                var durable = task.received
                for (offset, bytes) in chunks { durable = try await disk.append(offset: offset, bytes: bytes, generation: generation).durableOffset }
                guard let self, let index = self.current(id, generation: generation, status: "downloading"), self.downloads[id] === download else { return }
                self.tasks[index].received = durable; download.writing = false
                for (offset, bytes) in chunks { download.scheduler.onChunk(offset: offset, length: bytes.count, durableOffsetAfterWrite: durable) }
                self.save(); self.tickDownloads(); self.flushDownload(id)
            } catch { if let self, self.current(id, generation: generation) != nil { download.writing = false; self.fail(id, error.localizedDescription) } }
        }
    }
    private func completeDownload(_ id: String) {
        guard let task = tasks.first(where: { $0.id == id }), let expected = task.sha256, let generation = diskGenerations[id] else { return }
        timeouts.removeValue(forKey: id)?.cancel()
        if let index = tasks.firstIndex(where: { $0.id == id }) { tasks[index].status = "verifying" }
        let safeName = task.name.replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "\\", with: "_")
        let destination = root.appendingPathComponent(id + "-" + String(generation.uuidString.prefix(8)) + "-" + String(safeName.prefix(180)))
        let disk = worker(id)
        enqueueIO { [weak self] in
            do {
                let snapshot = try await disk.finalize(size: task.size, sha256: expected, destination: destination, generation: generation)
                guard let self, let index = self.current(id, generation: generation, status: "verifying") else {
                    let cleanup = TransferDiskWorker(file: destination), token = UUID(); cleanup.setGeneration(token); try? await cleanup.remove(generation: token); return
                }
                self.tasks[index].localPath = snapshot.path; self.tasks[index].status = "completed"
                if task.hostKey == self.hostKey, let transfer = task.transferId { _ = self.send(["type": "artifact.done", "protocolVersion": orbisProtocolVersion, "transferId": transfer]) }
                self.save()
            } catch { if let self, self.current(id, generation: generation) != nil { self.fail(id, error.localizedDescription) } }
        }
    }
    private func fail(_ id: String, _ message: String) {
        guard let index = tasks.firstIndex(where: { $0.id == id }) else { return }
        guard !["completed", "cancelled", "paused"].contains(tasks[index].status) else { return }
        invalidateDisk(id)
        downloads[id] = nil
        timeouts.removeValue(forKey: id)?.cancel(); tasks[index].status = "failed"; tasks[index].error = message; tasks[index].commandId = nil; tasks[index].requestId = nil
        save()
    }
    private func arm(_ id: String) {
        timeouts[id]?.cancel()
        timeouts[id] = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 30_000_000_000) } catch { return }
            self?.fail(id, "传输超时，点击重试可继续传输。")
        }
    }
    private func save() {
        metadataRevision += 1
        let revision = metadataRevision, metadata = metadataWorker
        enqueueIO { [self] in
            await self.bootstrap?.value
            do { _ = try await metadata.save(JSONEncoder().encode(self.tasks), revision: revision) }
            catch { self.error = "无法保存传输进度：\(error.localizedDescription)" }
        }
    }
}
