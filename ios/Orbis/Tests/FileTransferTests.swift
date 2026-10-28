import Foundation
import CryptoKit
import Testing
@testable import OrbisCore

@Suite("Native file transfers") @MainActor
struct FileTransferTests {
    private func host(_ id: String = "host") -> HostPairing {
        HostPairing(hostId: id, hostName: "电脑", hostPub: "test-pub", pskRoot: "test-root", relay: RelayCredential(relayUrl: "wss://relay.example", deviceId: "test-device", credential: "test-only"), lan: [])
    }
    private func hash(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    private func root() -> URL { FileManager.default.temporaryDirectory.appendingPathComponent("orbis-transfer-test-" + UUID().uuidString) }

    @Test func binaryHeaderMatchesNodeAndRejectsMalformedFrames() throws {
        let frame = ArtifactChunk(runtimeId: "h", transferId: "t", offset: 258, bytes: Data([9, 8]))
        let data = try frame.encoded()
        #expect(data.prefix(24) == Data([0x50,0x49,0x52,0x33,15,1,0,1,0,1,0,0,0,0,0,0,0,0,1,2,0,0,0,2]))
        #expect(try ArtifactChunk.decode(data) == frame)
        var bad = data; bad[11] = 1
        #expect(throws: (any Error).self) { try ArtifactChunk.decode(bad) }
        #expect(throws: (any Error).self) { try ArtifactChunk.decode(data.dropLast()) }
        #expect(throws: (any Error).self) { try ArtifactChunk(runtimeId: "h", transferId: "t", offset: -1, bytes: Data([1])).encoded() }
    }

    @Test func downloadUsesHostRoutingExactOffsetsAndVerifiesFile() async throws {
        let path = root(); defer { try? FileManager.default.removeItem(at: path) }
        let store = FileTransfers(root: path)
        var sent: [[String: Any]] = []
        store.send = { sent.append($0); return true }
        store.setConnection(host(), connected: true)
        let body = Data(repeating: 67, count: 300_000)
        store.download(path: "/repo/report.txt")
        #expect(store.tasks.first?.sessionId == nil)
        let task = try #require(store.tasks.first)
        #expect(sent.first?["runtimeId"] as? String == "host")
        store.consume(["type": "artifact.started", "commandId": try #require(task.commandId), "transferId": "transfer-1",
                       "artifact": ["fileName": "report.txt", "size": body.count, "sha256": hash(body)]])
        #expect(sent.last?["offset"] as? Int64 == 0)
        #expect(sent.last?["length"] as? Int64 == 262144)
        let wrongHost = try ArtifactChunk(runtimeId: "other", transferId: "transfer-1", offset: 0, bytes: body.prefix(262144)).encoded()
        store.consume(["type": "_artifact.chunk", "data": wrongHost])
        #expect(store.tasks.first?.received == 0)
        let first = try ArtifactChunk(runtimeId: "host", transferId: "transfer-1", offset: 0, bytes: body.prefix(262144)).encoded()
        store.consume(["type": "_artifact.chunk", "data": first])
        store.consume(["type": "_artifact.chunk", "data": first])
        #expect(store.tasks.first?.received == 262144)
        let last = try ArtifactChunk(runtimeId: "host", transferId: "transfer-1", offset: 262144, bytes: body.dropFirst(262144)).encoded()
        store.consume(["type": "_artifact.chunk", "data": last])
        for _ in 0..<100 where store.tasks.first?.status == "verifying" { try await Task.sleep(nanoseconds: 5_000_000) }
        #expect(store.tasks.first?.status == "completed")
        let final = try #require(store.tasks.first?.localPath)
        #expect(try Data(contentsOf: URL(fileURLWithPath: final)) == body)
        #expect(sent.last?["type"] as? String == "artifact.done")
    }

    @Test func persistedDownloadResumesAndRejectsChangedSource() throws {
        let path = root(); defer { try? FileManager.default.removeItem(at: path) }
        let store = FileTransfers(root: path); store.send = { _ in true }; store.setConnection(host(), connected: true)
        let body = Data(repeating: 2, count: 300_000)
        store.download(path: "/repo/log.txt")
        let task = try #require(store.tasks.first)
        store.consume(["type": "artifact.started", "commandId": task.commandId!, "transferId": "t", "artifact": ["size": body.count, "sha256": hash(body)]])
        store.consume(["type": "_artifact.chunk", "data": try ArtifactChunk(runtimeId: "host", transferId: "t", offset: 0, bytes: body.prefix(262144)).encoded()])
        store.setConnection(host(), connected: false)
        let restored = FileTransfers(root: path)
        var request: [String: Any] = [:]
        restored.send = { request = $0; return true }; restored.setConnection(host(), connected: true)
        restored.restart(task.id)
        #expect((request["command"] as? [String: Any])?["offset"] as? Int64 == 262144)
        restored.consume(["type": "artifact.started", "commandId": restored.tasks.first!.commandId!, "transferId": "new", "artifact": ["size": body.count, "sha256": hash(Data([5]))]])
        #expect(restored.tasks.first?.status == "failed")
        #expect(restored.tasks.first?.received == 262144)
    }

    @Test func hostSwitchCannotResumeAnotherComputersFiles() throws {
        let path = root(); defer { try? FileManager.default.removeItem(at: path) }
        let store = FileTransfers(root: path); var sends = 0
        store.send = { _ in sends += 1; return true }; store.setConnection(host(), connected: true)
        store.download(path: "/repo/file.txt")
        let id = try #require(store.tasks.first?.id)
        store.setConnection(host("other"), connected: true)
        #expect(store.currentTasks.isEmpty)
        store.restart(id)
        #expect(sends == 1)
        #expect(store.tasks.first?.status == "paused")
    }

    @Test func uploadsOnlyServeHostRequestedBytesAndWaitForVerifiedFinish() async throws {
        let path = root(), source = root()
        defer { try? FileManager.default.removeItem(at: path); try? FileManager.default.removeItem(at: source) }
        try FileManager.default.createDirectory(at: source, withIntermediateDirectories: true)
        let file = source.appendingPathComponent("hello.txt"), body = Data("hello world".utf8)
        try body.write(to: file)
        let store = FileTransfers(root: path); var sent: [[String: Any]] = [], chunks: [Data] = []
        store.send = { sent.append($0); return true }; store.sendBinary = { chunks.append($0); return true }; store.setConnection(host(), connected: true)
        let runtime = RuntimeSummary(runtimeId: "agent", name: "Agent", cwd: "D:\\repo", status: "idle", sessionId: "s")
        store.upload(urls: [file], runtime: runtime)
        for _ in 0..<100 where store.preparing { try await Task.sleep(nanoseconds: 5_000_000) }
        let task = try #require(store.tasks.first)
        #expect(sent.first?["type"] as? String == "file.upload.init")
        #expect((sent.first?["directory"] as? String)?.hasPrefix("D:\\repo\\.orbis-uploads\\") == true)
        store.consume(["type": "file.upload.ready", "requestId": task.requestId!, "uploadId": "upload", "receivedBytes": 0])
        store.consume(["type": "file.upload.read", "uploadId": "upload", "offset": 0, "length": body.count])
        #expect(try ArtifactChunk.decode(try #require(chunks.first)).bytes == body)
        #expect(store.tasks.first?.status == "uploading")
        store.consume(["type": "file.upload.finished", "uploadId": "upload", "path": "D:\\repo\\file.txt", "size": body.count, "sha256": hash(body)])
        #expect(store.tasks.first?.status == "completed")
        #expect(store.tasks.first?.remotePath == "D:\\repo\\file.txt")
        store.detach([task.id]); #expect(store.tasks.first?.attached == false)
    }
}
