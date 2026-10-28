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
    private var pairing: HostPairing?
    private var connected = false
    private var timeouts: [String: Task<Void, Never>] = [:]
    private var preparingGeneration = UUID()

    init(root: URL) {
        self.root = root
        if let data = try? Data(contentsOf: root.appendingPathComponent("transfers.json")), let stored = try? JSONDecoder().decode([FileTransfer].self, from: data) {
            tasks = stored.map { item in
                var item = item
                if ["queued", "downloading", "uploading", "verifying"].contains(item.status) { item.status = "paused"; item.transferId = nil; item.commandId = nil; item.requestId = nil }
                return item
            }
        }
    }
    var currentTasks: [FileTransfer] { tasks.filter { $0.hostKey == hostKey } }
    var activeCount: Int { currentTasks.filter { ["queued", "downloading", "uploading", "verifying"].contains($0.status) }.count }
    var hostKey: String { pairing.map(Self.pairingKey) ?? "" }
    static func pairingKey(_ host: HostPairing) -> String {
        let text = [host.hostId, host.relay.relayUrl, host.relay.deviceId].joined(separator: "\n")
        return SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
    }
    func setConnection(_ host: HostPairing?, connected: Bool) {
        let changed = pairing?.hostId != host?.hostId || pairing?.relay.deviceId != host?.relay.deviceId
        if !connected || changed {
            for index in tasks.indices where ["queued", "downloading", "uploading"].contains(tasks[index].status) {
                tasks[index].status = "paused"; tasks[index].transferId = nil; tasks[index].commandId = nil; tasks[index].requestId = nil
            }
            timeouts.values.forEach { $0.cancel() }; timeouts = [:]
            preparingGeneration = UUID(); preparing = false
            save()
        }
        pairing = host; self.connected = connected
    }
    func download(path: String? = nil, artifact: RemoteArtifact? = nil, runtimeId: String? = nil, sessionId: String? = nil) {
        guard let pairing, connected, path?.isEmpty == false || artifact != nil else { error = "连接电脑后可下载文件。"; return }
        var task = FileTransfer(id: UUID().uuidString, hostKey: hostKey, hostId: pairing.hostId, runtimeId: runtimeId ?? pairing.hostId,
            sessionId: sessionId, direction: "download", name: artifact?.fileName ?? directoryTitle(path ?? "文件"), sourcePath: path, artifactId: artifact?.artifactId)
        task.size = artifact?.size ?? 0; task.sha256 = artifact?.sha256
        tasks.insert(task, at: 0); restart(task.id)
    }
    func restart(_ id: String) {
        guard let index = tasks.firstIndex(where: { $0.id == id && $0.hostKey == hostKey }), connected,
              !["downloading", "uploading", "verifying", "completed"].contains(tasks[index].status) else { return }
        var task = tasks[index]
        task.status = "queued"; task.error = nil; task.transferId = nil; task.requestId = nil
        let command = UUID().uuidString; task.commandId = command
        if task.direction == "download" {
            let part = root.appendingPathComponent(task.id + ".part")
            task.received = ((try? FileManager.default.attributesOfItem(atPath: part.path)[.size]) as? NSNumber)?.int64Value ?? 0
            var body: [String: Any] = ["type": task.sourcePath == nil ? "artifact.download" : "file.download", "offset": task.received]
            if let path = task.sourcePath { body["path"] = path } else { body["artifactId"] = task.artifactId }
            tasks[index] = task
            if !send(["type": "runtime.command", "protocolVersion": orbisProtocolVersion, "runtimeId": task.hostId, "commandId": command, "command": body]) { fail(id, "下载请求未送达。") }
            else { arm(id) }
        } else {
            guard task.localPath != nil, let hash = task.sha256, let directory = task.remotePath else { fail(id, "上传源文件不可用。请重新选择。"); return }
            task.requestId = command; tasks[index] = task
            let request: [String: Any] = ["type": "file.upload.init", "protocolVersion": orbisProtocolVersion, "requestId": command,
                "runtimeId": task.runtimeId, "directory": directory, "fileName": task.name, "size": task.size, "sha256": hash]
            if !send(request) { fail(id, "上传请求未送达。") } else { arm(id) }
        }
        save()
    }
    func upload(urls: [URL], runtime: RuntimeSummary) {
        guard connected, let pairing, !preparing else { return }
        let key = hostKey, generation = UUID(), destination = root
        preparing = true; preparingGeneration = generation
        Task {
            do {
                let prepared = try await Task.detached(priority: .userInitiated) { () -> [FileTransfer] in
                    try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
                    var copied: [URL] = []
                    do {
                        return try urls.prefix(10).map { url in
                            let access = url.startAccessingSecurityScopedResource()
                            defer { if access { url.stopAccessingSecurityScopedResource() } }
                            let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
                            guard attributes[.type] as? FileAttributeType == .typeRegular,
                                  let size = (attributes[.size] as? NSNumber)?.int64Value, size <= 100 * 1024 * 1024 else { throw transferError("单个附件不能超过 100 MiB。") }
                            let id = UUID().uuidString, local = destination.appendingPathComponent(id + ".upload")
                            try FileManager.default.copyItem(at: url, to: local)
                            copied.append(local)
                            let hash = try Self.fileHash(local)
                            let directory = remoteBrowsePath(parent: remoteBrowsePath(parent: runtime.cwd, name: ".orbis-uploads"), name: hash)
                            return FileTransfer(id: id, hostKey: key, hostId: pairing.hostId, runtimeId: runtime.runtimeId, sessionId: runtime.sessionId,
                                direction: "upload", name: url.lastPathComponent, size: size, sha256: hash, localPath: local.path, remotePath: directory)
                        }
                    } catch {
                        for file in copied { try? FileManager.default.removeItem(at: file) }
                        throw error
                    }
                }.value
                guard preparingGeneration == generation, key == hostKey else {
                    for task in prepared { if let path = task.localPath { try? FileManager.default.removeItem(atPath: path) } }; return
                }
                tasks.insert(contentsOf: prepared, at: 0); preparing = false
                for task in prepared { restart(task.id) }
            } catch { if preparingGeneration == generation { preparing = false; self.error = error.localizedDescription } }
        }
    }
    func cancel(_ id: String) {
        guard let index = tasks.firstIndex(where: { $0.id == id }) else { return }
        let task = tasks[index]
        if task.hostKey == hostKey, connected, let transferId = task.transferId {
            if task.direction == "upload" { _ = send(["type": "file.upload.cancel", "protocolVersion": orbisProtocolVersion, "uploadId": transferId]) }
            else { _ = send(["type": "runtime.command", "protocolVersion": orbisProtocolVersion, "runtimeId": task.hostId, "commandId": UUID().uuidString,
                             "command": ["type": "artifact.cancel", "transferId": transferId]]) }
        }
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
        for task in tasks where ids.contains(task.id) {
            cancel(task.id)
            try? FileManager.default.removeItem(at: root.appendingPathComponent(task.id + ".part"))
            if let path = task.localPath, URL(fileURLWithPath: path).deletingLastPathComponent().path == root.path { try? FileManager.default.removeItem(atPath: path) }
        }
        tasks.removeAll { ids.contains($0.id) }; save()
    }
    func consume(_ object: [String: Any]) {
        let type = object["type"] as? String ?? ""
        if type == "_artifact.chunk", let data = object["data"] as? Data { receiveChunk(data); return }
        if type == "runtime.event", let event = object["event"] as? [String: Any] { consume(event); return }
        if type == "artifact.started", let commandId = object["commandId"] as? String,
           let index = tasks.firstIndex(where: { $0.commandId == commandId && $0.hostKey == hostKey && $0.status == "queued" }),
           let artifact = object["artifact"] as? [String: Any], let hash = artifact["sha256"] as? String,
           let size = (artifact["size"] as? NSNumber)?.int64Value, size >= 0, let transfer = object["transferId"] as? String {
            if let oldHash = tasks[index].sha256, oldHash != hash { fail(tasks[index].id, "文件内容已更改，请删除任务后重新下载。"); return }
            tasks[index].transferId = transfer; tasks[index].sha256 = hash; tasks[index].size = size; tasks[index].status = "downloading"
            if tasks[index].received > size { fail(tasks[index].id, "本地进度与文件长度不一致。"); return }
            requestChunk(tasks[index].id); return
        }
        if type == "artifact.failed" || type == "artifact.read.failed" {
            if let index = tasks.firstIndex(where: { $0.transferId != nil && $0.transferId == object["transferId"] as? String && $0.hostKey == hostKey }) { fail(tasks[index].id, object["error"] as? String ?? object["reason"] as? String ?? "下载失败。") }; return
        }
        if type == "file.upload.ready", let request = object["requestId"] as? String,
           let index = tasks.firstIndex(where: { $0.requestId == request && $0.hostKey == hostKey && $0.status == "queued" }), let upload = object["uploadId"] as? String {
            tasks[index].transferId = upload; tasks[index].status = "uploading"; tasks[index].received = (object["receivedBytes"] as? NSNumber)?.int64Value ?? 0
            arm(tasks[index].id); save(); return
        }
        if type.hasPrefix("file.upload."), let upload = object["uploadId"] as? String,
           let index = tasks.firstIndex(where: { $0.transferId == upload && $0.hostKey == hostKey && $0.status == "uploading" }) {
            let task = tasks[index]
            if type == "file.upload.read", let offset = (object["offset"] as? NSNumber)?.int64Value,
               let length = (object["length"] as? NSNumber)?.intValue, offset >= 0, (1...1_048_576).contains(length), offset + Int64(length) <= task.size,
               let path = task.localPath {
                do {
                    let handle = try FileHandle(forReadingFrom: URL(fileURLWithPath: path)); defer { try? handle.close() }
                    try handle.seek(toOffset: UInt64(offset))
                    let data = try handle.read(upToCount: length) ?? Data()
                    guard data.count == length, sendBinary(try ArtifactChunk(runtimeId: task.runtimeId, transferId: upload, offset: offset, bytes: data).encoded()) else { throw transferError("上传分片未送达。") }
                    arm(task.id)
                } catch { fail(task.id, error.localizedDescription) }
            } else if type == "file.upload.progress" {
                let count = (object["receivedBytes"] as? NSNumber)?.int64Value ?? task.received
                tasks[index].received = min(task.size, max(task.received, count)); arm(task.id); save()
            } else if type == "file.upload.finished" {
                guard object["sha256"] as? String == task.sha256, (object["size"] as? NSNumber)?.int64Value == task.size, let path = object["path"] as? String else { fail(task.id, "上传结果校验失败。"); return }
                tasks[index].remotePath = path; tasks[index].received = task.size; tasks[index].status = "completed"
                timeouts.removeValue(forKey: task.id)?.cancel(); save()
            }
        }
        if type == "file.upload.failed" || type == "protocol.error" {
            if let index = tasks.firstIndex(where: { task in
                task.hostKey == hostKey && ((task.commandId != nil && task.commandId == object["commandId"] as? String) ||
                    (task.requestId != nil && task.requestId == object["requestId"] as? String) || (task.transferId != nil && task.transferId == object["uploadId"] as? String))
            }) { fail(tasks[index].id, object["message"] as? String ?? "文件传输失败。") }
        }
    }
    private func requestChunk(_ id: String) {
        guard let index = tasks.firstIndex(where: { $0.id == id }), let transfer = tasks[index].transferId else { return }
        let task = tasks[index]
        if task.received == task.size { completeDownload(id); return }
        let request = UUID().uuidString; tasks[index].requestId = request
        if !send(["type": "artifact.read", "protocolVersion": orbisProtocolVersion, "transferId": transfer, "requestId": request,
                  "offset": task.received, "length": min(262144, task.size - task.received)]) { fail(id, "文件读取请求未送达。") }
        else { arm(id) }
    }
    private func receiveChunk(_ data: Data) {
        guard let chunk = try? ArtifactChunk.decode(data), let index = tasks.firstIndex(where: {
            $0.transferId == chunk.transferId && $0.hostKey == hostKey && $0.status == "downloading" && chunk.runtimeId == $0.hostId
        }) else { return }
        let task = tasks[index]
        guard chunk.offset == task.received, chunk.bytes.count == min(262144, task.size - task.received) else { return }
        do {
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            let file = root.appendingPathComponent(task.id + ".part")
            if !FileManager.default.fileExists(atPath: file.path) { guard FileManager.default.createFile(atPath: file.path, contents: nil) else { throw transferError("无法创建下载文件。") } }
            let handle = try FileHandle(forWritingTo: file); defer { try? handle.close() }
            try handle.seek(toOffset: UInt64(task.received)); try handle.write(contentsOf: chunk.bytes); try handle.synchronize()
            tasks[index].received += Int64(chunk.bytes.count); save(); requestChunk(task.id)
        } catch { fail(task.id, error.localizedDescription) }
    }
    private func completeDownload(_ id: String) {
        guard let task = tasks.first(where: { $0.id == id }), let expected = task.sha256 else { return }
        timeouts.removeValue(forKey: id)?.cancel()
        if let index = tasks.firstIndex(where: { $0.id == id }) { tasks[index].status = "verifying" }
        let part = root.appendingPathComponent(id + ".part")
        Task {
            do {
                try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
                if task.size == 0 && !FileManager.default.fileExists(atPath: part.path) { try Data().write(to: part) }
                let hash = try await Task.detached(priority: .utility) { try Self.fileHash(part) }.value
                guard hash == expected else { throw transferError("文件完整性校验失败，请删除任务后重试。") }
                guard let index = tasks.firstIndex(where: { $0.id == id && $0.status == "verifying" }) else { return }
                let safeName = task.name.replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "\\", with: "_")
                let destination = root.appendingPathComponent(id + "-" + String(safeName.prefix(180)))
                try FileManager.default.moveItem(at: part, to: destination)
                tasks[index].localPath = destination.path; tasks[index].status = "completed"
                if task.hostKey == hostKey, let transfer = task.transferId { _ = send(["type": "artifact.done", "protocolVersion": orbisProtocolVersion, "transferId": transfer]) }
                save()
            } catch { fail(id, error.localizedDescription) }
        }
    }
    private func fail(_ id: String, _ message: String) {
        guard let index = tasks.firstIndex(where: { $0.id == id }) else { return }
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
        guard !tasks.isEmpty || FileManager.default.fileExists(atPath: root.path) else { return }
        do { try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true); try JSONEncoder().encode(tasks).write(to: root.appendingPathComponent("transfers.json"), options: .atomic) }
        catch { self.error = "无法保存传输进度：\(error.localizedDescription)" }
    }
    nonisolated private static func fileHash(_ url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url); defer { try? handle.close() }
        var hash = SHA256()
        while let data = try handle.read(upToCount: 1_048_576), !data.isEmpty { hash.update(data: data) }
        return hash.finalize().map { String(format: "%02x", $0) }.joined()
    }
}
