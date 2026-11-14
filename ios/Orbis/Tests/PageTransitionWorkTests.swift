// Orbis 测试用途（场景与判定见本文件断言）：
// - PERF-10：整页弹入 / 弹出期间不让 Host 发布与整份快照序列化落在 UI 线程
import Foundation
import Combine
import Testing
@testable import OrbisCore

@Suite("Page transition main-thread work (PERF-10)") @MainActor
struct PageTransitionWorkTests {
    private final class Storage: SecureStorage {
        let hosts = [HostPairing(hostId: "host-1", hostName: "Test Host", hostPub: "test-public-key",
            pskRoot: Base64URL.encode(Data(repeating: 1, count: 32)),
            relay: RelayCredential(relayUrl: "wss://relay.example", deviceId: "test-device", credential: "test-only"), lan: [])]
        func deviceIdentity() throws -> DeviceIdentity { .generate() }
        func savePairings(_ pairings: [HostPairing]) throws {}
        func pairings() -> [HostPairing] { hosts }
    }

    @MainActor private final class Transport: OrbisTransport {
        func pair(qr: PairingQR, deviceName: String, identity: DeviceIdentity, completion: @escaping (Result<HostPairing, Error>) -> Void) {
            completion(.failure(PairingError.invalidQR))
        }
        func connect(pairing: HostPairing, identity: DeviceIdentity, receive: @escaping ([String: Any], String?) -> Void,
                     state: @escaping (ConnectionState, String?) -> Void) { state(.connecting, nil) }
        func disconnect() {}
        func send(_ object: [String: Any]) -> Bool { true }
    }

    private func store() async -> OrbisStore {
        let store = OrbisStore(secure: Storage(), deviceName: "test", autoConnect: false, preferences: nil,
            transferRoot: FileManager.default.temporaryDirectory.appendingPathComponent("orbis-transition-" + UUID().uuidString),
            transportFactory: { _ in Transport() })
        await store.waitForPendingEvents()
        return store
    }

    private func settle() async { for _ in 0..<50 { await Task.yield() } }

    // A Host change during a page transition must not re-render the screen between its frames;
    // the changes publish once, together, when the page rests.
    @Test func heldPublicationsWaitForThePageAndPublishOnce() async {
        let store = await store()
        var publications = 0
        let observation = store.objectWillChange.sink { publications += 1 }
        defer { observation.cancel() }
        store.holdScreenPublications(true)
        for _ in 0..<3 { store.activeConnection.objectWillChange.send(); await settle() }
        #expect(publications == 0)
        store.holdScreenPublications(false)
        await settle()
        #expect(publications == 1)
        store.activeConnection.objectWillChange.send()
        await settle()
        #expect(publications == 2)
    }

    // A transition whose end is never reported cannot freeze the screen.
    @Test func lostHoldEndIsReleasedByItsLimit() async throws {
        let store = await store()
        var publications = 0
        let observation = store.objectWillChange.sink { publications += 1 }
        defer { observation.cancel() }
        // Other suites share the main actor, so the limit leaves a wide margin before the check.
        store.holdScreenPublications(true, limit: .milliseconds(600))
        store.activeConnection.objectWillChange.send()
        for _ in 0..<3 { await Task.yield() }
        #expect(publications == 0)
        try await Task.sleep(for: .milliseconds(1500))
        await settle()
        #expect(publications == 1)
    }

    // A drag followed by its release animation reports twice; the release gets a full limit of
    // its own instead of inheriting what the drag left of the first.
    @Test func holdingAgainStartsANewLimit() async throws {
        let store = await store()
        var publications = 0
        let observation = store.objectWillChange.sink { publications += 1 }
        defer { observation.cancel() }
        store.holdScreenPublications(true, limit: .milliseconds(800))
        store.activeConnection.objectWillChange.send()
        try await Task.sleep(for: .milliseconds(500))
        store.holdScreenPublications(true, limit: .milliseconds(1500))
        try await Task.sleep(for: .milliseconds(700))
        #expect(publications == 0, "the first limit was replaced by the second")
        try await Task.sleep(for: .milliseconds(1500))
        await settle()
        #expect(publications == 1)
    }

    // The duplicate-receipt fingerprint and byte budget of a snapshot are prepared by the
    // content worker, identical to the canonical fingerprint; other events carry none.
    @Test func snapshotFingerprintIsPreparedOffTheUIActor() async throws {
        let event: [String: Any] = ["type": "session.snapshot", "syncId": "sync-1", "sessionId": "session-1",
            "entries": [["entryId": "e1", "text": "/repo/a"]], "source": ["epoch": "e", "seq": 1, "ready": true]]
        let envelope: [String: Any] = ["type": "runtime.event", "runtimeId": "a", "sequence": 1, "event": event]
        let worker = SharedSessionContentWorker(beforeWork: { #expect(!Thread.isMainThread) })
        let prepared = try await worker.expand(envelope, payload: nil, epoch: nil, seq: nil)
        let expected = try #require(sessionSnapshotFingerprint(event))
        #expect(prepared.snapshotFingerprint == expected)
        #expect(prepared.snapshotWireBytes == (try JSONSerialization.data(withJSONObject: envelope, options: [.withoutEscapingSlashes])).count)
        let wire = Data(repeating: 0x20, count: 77)
        #expect(try await worker.expand(envelope, payload: wire, epoch: nil, seq: nil).snapshotWireBytes == 77)
        let patch = try await worker.expand(["type": "runtime.event", "runtimeId": "a", "event": ["type": "session.patch"]],
                                            payload: nil, epoch: nil, seq: nil)
        #expect(patch.snapshotFingerprint == nil && patch.snapshotWireBytes == nil)
    }
}
