import CryptoKit
import Foundation
import Testing
@testable import OrbisCore

/// ADR-0049 §6.1–§6.2 `waiting`：附件上传中发送。Android `WaitingSendTest.kt` 与本文件用例一一对应。
@Suite("Messages waiting for attachments (ADR-0049 §6.2)") @MainActor
struct WaitingSendTests {
    private final class Storage: SecureStorage {
        var hosts = [HostPairing(hostId: "host-1", hostName: "Test Host", hostPub: "test-public-key",
            pskRoot: Base64URL.encode(Data(repeating: 1, count: 32)),
            relay: RelayCredential(relayUrl: "wss://relay.example", deviceId: "test-device", credential: "test-only"), lan: [])]
        func deviceIdentity() throws -> DeviceIdentity { .generate() }
        func savePairings(_ pairings: [HostPairing]) throws { hosts = pairings }
        func pairings() -> [HostPairing] { hosts }
    }

    @MainActor private final class Transport: OrbisTransport {
        var sent: [[String: Any]] = []
        var drain: (() async -> Void)?
        var receive: (([String: Any], String?) -> Void)?
        var state: ((ConnectionState, String?) -> Void)?
        func pair(qr: PairingQR, deviceName: String, identity: DeviceIdentity, completion: @escaping (Result<HostPairing, Error>) -> Void) {
            completion(.failure(PairingError.invalidQR))
        }
        func connect(pairing: HostPairing, identity: DeviceIdentity, receive: @escaping ([String: Any], String?) -> Void, state: @escaping (ConnectionState, String?) -> Void) {
            self.receive = receive; self.state = state; state(.connecting, nil)
        }
        func disconnect() {}
        func send(_ object: [String: Any]) -> Bool { sent.append(object); return true }
        func sendBinary(_ data: Data) -> Bool { true }
        func emit(_ object: [String: Any]) async { receive?(object, "ctl"); await drain?() }
        func ready() async {
            await emit(["type": "device.ready", "modelEpoch": "epoch", "runtimes": [
                ["runtimeId": "a", "sessionId": "session-a", "name": "Agent", "cwd": "/repo", "status": "idle"]
            ]])
        }
        var userMessages: [[String: Any]] {
            sent.compactMap { $0["command"] as? [String: Any] }.filter { $0["type"] as? String == "user_message" }
        }
    }

    @MainActor private final class Fixture {
        let transport = Transport()
        let store: OrbisStore
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("orbis-waiting-" + UUID().uuidString)
        var host: HostConnection { store.activeConnection }
        init(preferences: UserDefaults? = nil) {
            store = OrbisStore(secure: Storage(), transport: transport, preferences: preferences, transferRoot: root)
            transport.drain = { [weak store] in await store?.waitForPendingEvents() }
        }
        deinit { try? FileManager.default.removeItem(at: root) }

        /// 开始一个上传，停在 Host 确认之前。
        func upload(_ name: String, body: Data = Data("hello world".utf8)) async throws -> FileTransfer {
            let source = root.appendingPathComponent("src-" + UUID().uuidString)
            try FileManager.default.createDirectory(at: source, withIntermediateDirectories: true)
            let file = source.appendingPathComponent(name); try body.write(to: file)
            let runtime = try #require(host.runtimes.first)
            host.transfers.upload(urls: [file], runtime: runtime)
            await host.transfers.waitForPendingIO()
            return try #require(host.transfers.tasks.last)
        }
        func finish(_ task: FileTransfer, path: String, body: Data = Data("hello world".utf8)) async throws {
            let uploadId = "upload-" + task.id
            await transport.emit(["type": "file.upload.ready", "requestId": try #require(task.requestId), "uploadId": uploadId, "receivedBytes": 0])
            await host.transfers.waitForPendingIO()
            await transport.emit(["type": "file.upload.finished", "uploadId": uploadId, "path": path, "size": body.count,
                                  "sha256": SHA256.hash(data: body).map { String(format: "%02x", $0) }.joined()])
            await host.transfers.waitForPendingIO()
            await transport.drain?()
        }
        func fail(_ task: FileTransfer) async throws {
            let uploadId = "upload-" + task.id
            await transport.emit(["type": "file.upload.ready", "requestId": try #require(task.requestId), "uploadId": uploadId, "receivedBytes": 0])
            await host.transfers.waitForPendingIO()
            await transport.emit(["type": "file.upload.failed", "uploadId": uploadId, "message": "磁盘已满"])
            await host.transfers.waitForPendingIO()
            await transport.drain?()
        }
    }

    private func setup(preferences: UserDefaults? = nil) async -> Fixture {
        let fixture = Fixture(preferences: preferences)
        await fixture.transport.ready()
        return fixture
    }

    private func state(_ host: HostConnection, _ text: String) -> PendingSend.State? { host.pendingSends.items.first { $0.text == text }?.state }

    @Test func theBubbleAppearsAtOnceAndIsWrittenAfterTheUpload() async throws {
        let fixture = await setup(); let host = fixture.host
        let task = try await fixture.upload("hello.txt")
        #expect(host.sendMessage("看看这个", attachmentIds: [task.id]))
        #expect(state(host, "看看这个") == .waiting("上传中：hello.txt"))
        #expect(fixture.transport.userMessages.isEmpty)
        try await fixture.finish(task, path: "/repo/hello.txt")
        let written = try #require(fixture.transport.userMessages.last)
        #expect(written["attachments"] as? [String] == ["/repo/hello.txt"])
        #expect(written["messageId"] as? String == host.pendingSends.items.first?.messageId)
        #expect(state(host, "看看这个") == .sending)
        #expect(host.ledger.operations.isEmpty)
    }

    @Test func aLaterMessageWaitsBehindTheEarlierOneAndKeepsTheOrder() async throws {
        let fixture = await setup(); let host = fixture.host
        let task = try await fixture.upload("hello.txt")
        _ = host.sendMessage("第一条", attachmentIds: [task.id])
        #expect(host.sendMessage("第二条"))
        #expect(state(host, "第二条") == .waiting("等待前一条发送"))
        #expect(fixture.transport.userMessages.isEmpty)
        try await fixture.finish(task, path: "/repo/hello.txt")
        #expect(fixture.transport.userMessages.compactMap { $0["text"] as? String } == ["第一条", "第二条"])
    }

    @Test func anUploadFailureFailsOnlyItsOwnMessage() async throws {
        let fixture = await setup(); let host = fixture.host
        let task = try await fixture.upload("hello.txt")
        _ = host.sendMessage("第一条", attachmentIds: [task.id])
        _ = host.sendMessage("第二条")
        try await fixture.fail(task)
        #expect(state(host, "第一条") == .failed("附件上传失败：hello.txt（磁盘已满）"))
        #expect(fixture.transport.userMessages.compactMap { $0["text"] as? String } == ["第二条"])
    }

    @Test func disconnectDoesNotChangeAWaitingMessage() async throws {
        let fixture = await setup(); let host = fixture.host
        let task = try await fixture.upload("hello.txt")
        _ = host.sendMessage("看看这个", attachmentIds: [task.id])
        fixture.transport.state?(.offline, nil)
        #expect(state(host, "看看这个") == .waiting("上传中：hello.txt"))
    }

    @Test func restoringAFailedUploadPutsTextAndAttachmentBack() async throws {
        let fixture = await setup(); let host = fixture.host
        let task = try await fixture.upload("hello.txt")
        _ = host.sendMessage("看看这个", attachmentIds: [task.id])
        fixture.host.transfers.release([task.id])
        try await fixture.fail(task)
        let id = try #require(host.pendingSends.items.first?.messageId)
        #expect(host.restorePendingSend(id) == "看看这个")
        #expect(host.transfers.tasks.first { $0.id == task.id }?.attached == true)
        #expect(host.pendingSends.items.isEmpty)
    }

    @Test func aWaitingMessageReturnsToTheComposerAfterTheProcessExits() async throws {
        let suite = "orbis-waiting-copy-" + UUID().uuidString
        let preferences = try #require(UserDefaults(suiteName: suite))
        defer { preferences.removePersistentDomain(forName: suite) }
        let first = await setup(preferences: preferences)
        let task = try await first.upload("hello.txt")
        _ = first.host.sendMessage("还没传完", attachmentIds: [task.id])
        // 新进程：内存里的 outbox 不在了，草稿副本回到该会话的输入框。
        let second = await setup(preferences: preferences)
        let runtime = try #require(second.host.runtimes.first)
        #expect(second.host.draft(for: runtime) == "还没传完")
    }
}
