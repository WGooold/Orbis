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
        #expect(data.prefix(24) == Data([0x50,0x49,0x52,0x33,17,1,0,1,0,1,0,0,0,0,0,0,0,0,1,2,0,0,0,2]))
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
        await store.waitForPendingIO()
        let body = Data(repeating: 67, count: 1_300_000)
        store.download(path: "/repo/report.txt")
        await store.waitForPendingIO()
        #expect(store.tasks.first?.sessionId == nil)
        let task = try #require(store.tasks.first)
        #expect(sent.first?["runtimeId"] as? String == "host")
        #expect((sent.first?["command"] as? [String: Any])?["mode"] == nil)
        store.consume(["type": "artifact.started", "commandId": try #require(task.commandId), "transferId": "transfer-1",
                       "artifact": ["fileName": "report.txt", "size": body.count, "sha256": hash(body)]])
        await store.waitForPendingIO()
        #expect(sent.first(where: { $0["type"] as? String == "artifact.read" })?["offset"] as? Int64 == 0)
        #expect(sent.last?["length"] as? Int == 251_424)
        let wrongHost = try ArtifactChunk(runtimeId: "other", transferId: "transfer-1", offset: 0, bytes: body.prefix(1_048_576)).encoded()
        store.consume(["type": "_artifact.chunk", "data": wrongHost])
        await store.waitForPendingIO()
        #expect(store.tasks.first?.received == 0)
        let first = try ArtifactChunk(runtimeId: "host", transferId: "transfer-1", offset: 0, bytes: body.prefix(1_048_576)).encoded()
        store.consume(["type": "_artifact.chunk", "data": first])
        await store.waitForPendingIO()
        store.consume(["type": "_artifact.chunk", "data": first])
        await store.waitForPendingIO()
        #expect(store.tasks.first?.received == 1_048_576)
        let last = try ArtifactChunk(runtimeId: "host", transferId: "transfer-1", offset: 1_048_576, bytes: body.dropFirst(1_048_576)).encoded()
        store.consume(["type": "_artifact.chunk", "data": last])
        await store.waitForPendingIO()
        #expect(store.tasks.first?.status == "completed")
        let final = try #require(store.tasks.first?.localPath)
        #expect(try Data(contentsOf: URL(fileURLWithPath: final)) == body)
        #expect(sent.last?["type"] as? String == "artifact.done")
    }

    @Test func persistedDownloadResumesAndRejectsChangedSource() async throws {
        let path = root(); defer { try? FileManager.default.removeItem(at: path) }
        let store = FileTransfers(root: path); store.send = { _ in true }; store.setConnection(host(), connected: true)
        await store.waitForPendingIO()
        let body = Data(repeating: 2, count: 1_300_000)
        store.download(path: "/repo/log.txt")
        await store.waitForPendingIO()
        let task = try #require(store.tasks.first)
        store.consume(["type": "artifact.started", "commandId": task.commandId!, "transferId": "t", "artifact": ["size": body.count, "sha256": hash(body)]])
        await store.waitForPendingIO()
        store.consume(["type": "_artifact.chunk", "data": try ArtifactChunk(runtimeId: "host", transferId: "t", offset: 0, bytes: body.prefix(1_048_576)).encoded()])
        await store.waitForPendingIO()
        store.setConnection(host(), connected: false)
        await store.waitForPendingIO()
        let restored = FileTransfers(root: path)
        var request: [String: Any] = [:]
        restored.send = { request = $0; return true }; restored.setConnection(host(), connected: true)
        await restored.waitForPendingIO()
        restored.restart(task.id)
        await restored.waitForPendingIO()
        #expect((request["command"] as? [String: Any])?["offset"] as? Int64 == 1_048_576)
        restored.consume(["type": "artifact.started", "commandId": restored.tasks.first!.commandId!, "transferId": "new", "artifact": ["size": body.count, "sha256": hash(Data([5]))]])
        await restored.waitForPendingIO()
        #expect(restored.tasks.first?.status == "failed")
        #expect(restored.tasks.first?.received == 1_048_576)
    }

    @Test func hostSwitchCannotResumeAnotherComputersFiles() async throws {
        let path = root(); defer { try? FileManager.default.removeItem(at: path) }
        let store = FileTransfers(root: path); var sends = 0
        store.send = { _ in sends += 1; return true }; store.setConnection(host(), connected: true)
        await store.waitForPendingIO()
        store.download(path: "/repo/file.txt")
        await store.waitForPendingIO()
        let id = try #require(store.tasks.first?.id)
        store.setConnection(host("other"), connected: true)
        await store.waitForPendingIO()
        #expect(store.currentTasks.isEmpty)
        store.restart(id)
        await store.waitForPendingIO()
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
        await store.waitForPendingIO()
        let runtime = RuntimeSummary(runtimeId: "agent", name: "Agent", cwd: "D:\\repo", status: "idle", sessionId: "s")
        store.upload(urls: [file], runtime: runtime)
        await store.waitForPendingIO()
        let task = try #require(store.tasks.first)
        #expect(sent.first?["type"] as? String == "file.upload.init")
        #expect((sent.first?["directory"] as? String)?.hasPrefix("D:\\repo\\.orbis-uploads\\") == true)
        store.consume(["type": "file.upload.ready", "requestId": task.requestId!, "uploadId": "upload", "receivedBytes": 0])
        await store.waitForPendingIO()
        store.consume(["type": "file.upload.read", "uploadId": "upload", "offset": 0, "length": body.count])
        await store.waitForPendingIO()
        #expect(try ArtifactChunk.decode(try #require(chunks.first)).bytes == body)
        #expect(store.tasks.first?.status == "uploading")
        store.consume(["type": "file.upload.finished", "uploadId": "upload", "path": "D:\\repo\\file.txt", "size": body.count, "sha256": hash(body)])
        await store.waitForPendingIO()
        #expect(store.tasks.first?.status == "completed")
        #expect(store.tasks.first?.remotePath == "D:\\repo\\file.txt")
        store.consume(["type": "file.upload.failed", "uploadId": "upload", "message": "late failure"])
        await store.waitForPendingIO()
        #expect(store.tasks.first?.status == "completed")
        store.detach([task.id]); #expect(store.tasks.first?.attached == false)
        await store.waitForPendingIO()
    }
    @Test func downloadBuffersOutOfOrderChunksUntilTheDurablePrefixIsComplete() async throws {
        let path = root(); defer { try? FileManager.default.removeItem(at: path) }
        let store = FileTransfers(root: path); var sent: [[String: Any]] = []
        store.send = { sent.append($0); return true }; store.setConnection(host(), connected: true)
        await store.waitForPendingIO()
        let body = Data(repeating: 7, count: 2 * PullScheduler.chunkBytes)
        store.download(path: "/repo/two.bin")
        await store.waitForPendingIO()
        let command = try #require(store.tasks.first?.commandId)
        store.consume(["type": "artifact.started", "commandId": command, "transferId": "ordered",
                       "artifact": ["size": body.count, "sha256": hash(body)]])
        await store.waitForPendingIO()
        #expect(sent.filter { $0["type"] as? String == "artifact.read" }.count == 2)
        let second = try ArtifactChunk(runtimeId: "host", transferId: "ordered", offset: Int64(PullScheduler.chunkBytes), bytes: body.suffix(PullScheduler.chunkBytes)).encoded()
        store.consume(["type": "_artifact.chunk", "data": second])
        await store.waitForPendingIO()
        #expect(store.tasks.first?.received == 0)
        store.consume(["type": "_artifact.chunk", "data": second])
        await store.waitForPendingIO()
        store.consume(["type": "_artifact.chunk", "data": try ArtifactChunk(runtimeId: "host", transferId: "ordered", offset: 0, bytes: body.prefix(PullScheduler.chunkBytes)).encoded()])
        await store.waitForPendingIO()
        #expect(store.tasks.first?.received == Int64(body.count))
        await store.waitForPendingIO()
        #expect(store.tasks.first?.status == "completed")
        store.consume(["type": "artifact.failed", "transferId": "ordered", "error": "late failure"])
        await store.waitForPendingIO()
        #expect(store.tasks.first?.status == "completed")
    }

    @Test func pullSchedulerBoundsTheWindowAndRetriesOnlyTheOldestHoleWithBackoff() {
        let mib: Int64 = 1_048_576
        var now: Int64 = 0, sent: [(String, Int64, Int)] = []
        let scheduler = PullScheduler(size: 8 * mib, startOffset: 0, send: { sent.append(($0, $1, $2)); return true }, now: { now })
        scheduler.tick()
        #expect(sent.map { $0.1 } == [0, mib, 2 * mib, 3 * mib])
        scheduler.onChunk(offset: mib, length: Int(mib), durableOffsetAfterWrite: 0)
        scheduler.onChunk(offset: 2 * mib, length: Int(mib), durableOffsetAfterWrite: 0)
        scheduler.onChunk(offset: 3 * mib, length: Int(mib), durableOffsetAfterWrite: 0)
        now = 5_001; scheduler.tick()
        #expect(sent.count == 5); #expect(sent.last?.1 == 0); #expect(scheduler.window == 2 * mib)
        now += 5_001; scheduler.tick(); #expect(sent.count == 5)
        now += 5_001; scheduler.tick(); #expect(sent.count == 6)
        scheduler.onChunk(offset: 0, length: Int(mib), durableOffsetAfterWrite: 4 * mib)
        scheduler.interactive = true; scheduler.tick()
        let ranges = sent.dropFirst(6)
        #expect(ranges.reduce(0) { $0 + $1.2 } == Int(mib))
        #expect(ranges.allSatisfy { $0.2 == 131_072 })
        scheduler.paused = true; now += 60_001; scheduler.tick(); #expect(sent.count == 14)
    }

    @Test func progressingSlowDownloadsDoNotBuildDuplicateRangeQueues() {
        let mib: Int64 = 1_048_576
        var now: Int64 = 0, sent: [(Int64, Int)] = []
        let scheduler = PullScheduler(size: 12 * mib, startOffset: 0, send: { _, offset, length in sent.append((offset, length)); return true }, now: { now })
        scheduler.tick()
        for index in 0..<12 {
            now += 4_000
            let response = sent[index]
            scheduler.onChunk(offset: response.0, length: response.1, durableOffsetAfterWrite: Int64(index + 1) * mib)
            scheduler.tick()
        }
        #expect(scheduler.complete); #expect(sent.count == 12); #expect(scheduler.inFlight == 0)
    }

    @Test func failedDownloadCommandsSurfaceImmediatelyAndMismatchedResumeOffsetsAreRejected() async throws {
        let path = root(); defer { try? FileManager.default.removeItem(at: path) }
        let store = FileTransfers(root: path); store.send = { _ in true }; store.setConnection(host(), connected: true)
        await store.waitForPendingIO()
        store.download(path: "/missing.txt")
        await store.waitForPendingIO()
        let task = try #require(store.tasks.first)
        store.consume(["type": "command.result", "commandId": task.commandId!, "ok": false, "error": "file_not_found"])
        await store.waitForPendingIO()
        #expect(store.tasks.first?.status == "failed"); #expect(store.tasks.first?.error == "file_not_found")
        store.restart(task.id)
        await store.waitForPendingIO()
        store.consume(["type": "artifact.started", "commandId": store.tasks.first!.commandId!, "transferId": "wrong-offset", "offset": 1,
                       "artifact": ["size": 2, "sha256": hash(Data([1, 2]))]])
        await store.waitForPendingIO()
        #expect(store.tasks.first?.status == "failed")
    }

    @Test func emptyDownloadsVerifyAndFinishOnceWithoutRangeRequests() async throws {
        let path = root(); defer { try? FileManager.default.removeItem(at: path) }
        let store = FileTransfers(root: path); var sent: [[String: Any]] = []
        store.send = { sent.append($0); return true }; store.setConnection(host(), connected: true)
        await store.waitForPendingIO()
        store.download(path: "/repo/empty.txt")
        await store.waitForPendingIO()
        let task = try #require(store.tasks.first)
        store.restart(task.id)
        await store.waitForPendingIO()
        #expect(sent.count == 1)
        let event: [String: Any] = ["type": "artifact.started", "commandId": task.commandId!, "transferId": "empty", "offset": 0,
                                   "artifact": ["size": 0, "sha256": hash(Data())]]
        store.consume(event); store.consume(event)
        await store.waitForPendingIO()
        #expect(store.tasks.first?.status == "completed")
        #expect(sent.filter { $0["type"] as? String == "artifact.read" }.isEmpty)
        #expect(sent.filter { $0["type"] as? String == "artifact.done" }.count == 1)
    }

    @Test func cancellingAnEnqueuedWriteCannotPoisonTheRestartedTransfer() async throws {
        let path = root(); defer { try? FileManager.default.removeItem(at: path) }
        let store = FileTransfers(root: path); var sent: [[String: Any]] = []
        store.send = { sent.append($0); return true }; store.setConnection(host(), connected: true)
        await store.waitForPendingIO()
        let body = Data([1, 2, 3, 4])
        store.download(path: "/repo/race.bin"); await store.waitForPendingIO()
        let initial = try #require(store.tasks.first)
        store.consume(["type": "artifact.started", "commandId": initial.commandId!, "transferId": "old", "artifact": ["size": body.count, "sha256": hash(body)]])
        await store.waitForPendingIO()
        let oldChunk = try ArtifactChunk(runtimeId: "host", transferId: "old", offset: 0, bytes: body).encoded()
        store.consume(["type": "_artifact.chunk", "data": oldChunk])
        // No actor turn occurs between enqueue, cancellation and explicit restart.
        store.cancel(initial.id); store.restart(initial.id)
        await store.waitForPendingIO()
        #expect(store.tasks.first?.status == "queued")
        #expect(store.tasks.first?.received == 0)
        let current = try #require(store.tasks.first?.commandId)
        #expect(current != initial.commandId)
        store.consume(["type": "artifact.started", "commandId": current, "transferId": "new", "artifact": ["size": body.count, "sha256": hash(body)]])
        await store.waitForPendingIO()
        store.consume(["type": "_artifact.chunk", "data": oldChunk])
        #expect(store.tasks.first?.received == 0)
        store.consume(["type": "_artifact.chunk", "data": try ArtifactChunk(runtimeId: "host", transferId: "new", offset: 0, bytes: body).encoded()])
        await store.waitForPendingIO()
        #expect(store.tasks.first?.status == "completed")
        let destination = try #require(store.tasks.first?.localPath)
        #expect(try Data(contentsOf: URL(fileURLWithPath: destination)) == body)
        #expect(sent.filter { $0["type"] as? String == "artifact.done" }.count == 1)
    }

    @Test func pairedManifestMigrationAndRemovalPreserveOtherHosts() async throws {
        let path = root(); defer { try? FileManager.default.removeItem(at: path) }
        try FileManager.default.createDirectory(at: path, withIntermediateDirectories: true)
        let one = host(), two = host("other")
        let records = [one, two].enumerated().map { index, pairing in
            FileTransfer(id: "task-\(index)", hostKey: FileTransfers.pairingKey(pairing), hostId: pairing.hostId,
                runtimeId: pairing.hostId, sessionId: nil, direction: "download", name: "file.bin", sourcePath: "/file.bin")
        }
        try JSONEncoder().encode(records).write(to: path.appendingPathComponent("transfers.json"))
        let first = FileTransfers(root: path, pairing: one), second = FileTransfers(root: path, pairing: two)
        first.setConnection(one, connected: false); second.setConnection(two, connected: false)
        await first.waitForPendingIO(); await second.waitForPendingIO()
        #expect(first.tasks.map(\.id) == ["task-0"])
        #expect(second.tasks.map(\.id) == ["task-1"])
        first.remove(["task-0"]); await first.waitForPendingIO()
        let restoredFirst = FileTransfers(root: path, pairing: one), restoredSecond = FileTransfers(root: path, pairing: two)
        await restoredFirst.waitForPendingIO(); await restoredSecond.waitForPendingIO()
        #expect(restoredFirst.tasks.isEmpty)
        #expect(restoredSecond.tasks.map(\.id) == ["task-1"])
    }

    @Test func diskGenerationFencesAndMetadataRevisionsRejectStaleWork() async throws {
        let path = root(); defer { try? FileManager.default.removeItem(at: path) }
        let file = path.appendingPathComponent("test.part"), disk = TransferDiskWorker(file: path.appendingPathComponent("test.part"))
        let first = UUID(); disk.setGeneration(first)
        _ = try await disk.resume(generation: first, expectedSize: 6)
        _ = try await disk.append(offset: 0, bytes: Data("abc".utf8), generation: first)
        let second = UUID(); disk.setGeneration(second)
        let resumed = try await disk.resume(generation: second, expectedSize: 6)
        #expect(resumed.durableOffset == 3)
        try await disk.pause(generation: first)
        let completed = try await disk.append(offset: 3, bytes: Data("def".utf8), generation: second)
        #expect(completed.durableOffset == 6)
        await #expect(throws: (any Error).self) { try await disk.append(offset: 0, bytes: Data("old".utf8), generation: first) }
        #expect(try Data(contentsOf: file) == Data("abcdef".utf8))
        let metadata = TransferMetadataWorker(file: path.appendingPathComponent("manifest.json"))
        let accepted = try await metadata.save(Data("new".utf8), revision: 2)
        let rejected = try await metadata.save(Data("old".utf8), revision: 1)
        #expect(accepted); #expect(!rejected)
        #expect(try await metadata.load() == Data("new".utf8))
        try await disk.pause(generation: second)
    }

    @Test func unpairBeforeBootstrapRemovesPersistedFilesWithoutRestoringTheHost() async throws {
        let path = root(); defer { try? FileManager.default.removeItem(at: path) }
        try FileManager.default.createDirectory(at: path, withIntermediateDirectories: true)
        let one = host(), two = host("other")
        let records = try [one, two].enumerated().map { index, pairing in
            let local = path.appendingPathComponent("download-\(index).bin")
            try Data([UInt8(index)]).write(to: local)
            try Data([UInt8(index)]).write(to: path.appendingPathComponent("task-\(index).part"))
            var task = FileTransfer(id: "task-\(index)", hostKey: FileTransfers.pairingKey(pairing), hostId: pairing.hostId,
                runtimeId: pairing.hostId, sessionId: nil, direction: "download", name: "file.bin", sourcePath: "/file.bin")
            task.status = "completed"; task.localPath = local.path
            return task
        }
        try JSONEncoder().encode(records).write(to: path.appendingPathComponent("transfers.json"))
        let first = FileTransfers(root: path, pairing: one)
        // MainActor has not yielded, so its manifest has not been loaded yet.
        first.removeAll(for: one)
        await first.waitForPendingIO()
        #expect(first.tasks.isEmpty)
        #expect(!FileManager.default.fileExists(atPath: path.appendingPathComponent("download-0.bin").path))
        #expect(!FileManager.default.fileExists(atPath: path.appendingPathComponent("task-0.part").path))
        #expect(FileManager.default.fileExists(atPath: path.appendingPathComponent("download-1.bin").path))
        #expect(FileManager.default.fileExists(atPath: path.appendingPathComponent("task-1.part").path))
        let restored = FileTransfers(root: path, pairing: one), untouched = FileTransfers(root: path, pairing: two)
        await restored.waitForPendingIO(); await untouched.waitForPendingIO()
        #expect(restored.tasks.isEmpty)
        #expect(untouched.tasks.map(\.id) == ["task-1"])
    }

}
