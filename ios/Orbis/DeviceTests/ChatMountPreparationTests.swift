import SwiftUI
import UIKit
import XCTest
@testable import Orbis

/// PERF-14: the real page model must establish a fresh viewport context before
/// UIKit installs its initial rows. Appearance then retains that same context.
@MainActor final class ChatMountPreparationTests: XCTestCase {
    private func drainMainQueue() async {
        for _ in 0..<3 {
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                DispatchQueue.main.async { continuation.resume() }
            }
        }
    }

    private func until(_ label: String, _ predicate: () -> Bool) async throws {
        for _ in 0..<250 {
            if predicate() { return }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTFail("Timed out: \(label)")
        throw URLError(.timedOut)
    }

    // Reproduce the production ordering: native makeCollection first, then the
    // ChatView.onAppear model.mount callback, with no transcript source change.
    // A second metadata preparation here means first-mount cells will all be
    // reconfigured solely because appearance changed the viewport's owner context.
    func testAppearanceRetainsTheContextAlreadyUsedByTheNativeTranscript() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("orbis-native-mount-" + UUID().uuidString)
        let store = OrbisStore(secure: NativeMountStorage(), deviceName: "native-mount-test",
            autoConnect: false, preferences: nil, transferRoot: root,
            transportFactory: { _ in NativeMountTransport() })
        defer {
            store.activeConnection.shutdown()
            try? FileManager.default.removeItem(at: root)
        }
        await store.waitForPendingEvents()
        let model = store.chatScreens, token = UUID(), target = model.actions.target
        let viewport = model.viewport
        let previousContext = viewport.nativeState.contextGeneration
        let gate = NativeMountPreparationGate()
        defer { gate.release() }
        let worker = ChatNativeSnapshotWorker(beforeWork: { gate.wait() })
        let ids = ["mount-0", "mount-1", "mount-2", "mount-3"]
        let snapshot = ChatNativeTranscriptView.Snapshot(items: ids.map {
            .init(id: $0, revision: UUID(), content: AnyView(Text($0).frame(height: 44)))
        }, revision: 1)
        let view = ChatNativeTranscriptView(snapshot: { snapshot },
            prepareMount: { model.prepareMount(target: target, token: token) }, viewport: viewport,
            tailID: ids.last!, mountToken: token, requestIsCurrent: { viewport.owns($0) },
            onDistance: { _ in }, onInteraction: { _ in }, onReadingRow: { _ in })
        let coordinator = ChatNativeTranscriptView.Coordinator(view, snapshotWorker: worker)
        defer { coordinator.stop() }
        let collection = coordinator.makeCollection()
        XCTAssertEqual(collection.numberOfItems(inSection: 0), ids.count)
        XCTAssertEqual(gate.preparations, 0, "The initial IDs are installed synchronously")
        let nativeContext = viewport.nativeState.contextGeneration
        let nativeProbe = ChatUpdateProbe.shared.report

        model.mount(target: target, token: token, visible: true, foreground: true)
        defer { model.unmount(target: target, token: token) }
        await drainMainQueue()
        if viewport.nativeState.contextGeneration != nativeContext {
            // On the unfixed implementation, hold the resulting comparison so
            // its submission cannot race these context/count assertions.
            try await until("appearance's redundant metadata preparation") { gate.preparations > 0 }
        }
        XCTAssertGreaterThan(nativeContext, previousContext,
            "A new viewport context must be prepared before the initial native snapshot")
        XCTAssertEqual(viewport.nativeState.contextGeneration, nativeContext,
            "Appearance must not invalidate the context already used by the native transcript")
        XCTAssertEqual(gate.preparations, 0,
            "An unchanged initial source must not prepare/reconfigure every retained row again on appearance")
        XCTAssertEqual(collection.numberOfItems(inSection: 0), ids.count)

        let hadRedundantPreparation = gate.preparations > 0
        if hadRedundantPreparation {
            gate.release()
            // An actor barrier ensures the already-running comparison completed;
            // the gate only blocks its first entry and all waits have deadlines.
            _ = await worker.prepare(previous: [], next: [], reconfigureRetained: false)
            await drainMainQueue()
        }
        let diagnostic = "probeEnabled=\(ChatUpdateProbe.enabled)\n" +
            "sourceRevision=\(snapshot.revision);rows=\(ids.count);hadRedundantPreparation=\(hadRedundantPreparation)\n" +
            "previousContext=\(previousContext);nativeContext=\(nativeContext);appearanceContext=\(viewport.nativeState.contextGeneration)\n" +
            "afterNative: \(nativeProbe)\nafterAppearance: \(ChatUpdateProbe.shared.report)"
        print("NATIVE_MOUNT_CONTEXT " + diagnostic)
        let attachment = XCTAttachment(string: diagnostic)
        attachment.name = "NATIVE_MOUNT_CONTEXT"
        attachment.lifetime = .keepAlways
        add(attachment)
        XCTAssertFalse(gate.timedOut)
        XCTAssertFalse(gate.ranOnMainThread)
    }
}

private final class NativeMountStorage: SecureStorage {
    func deviceIdentity() throws -> DeviceIdentity { .generate() }
    func pairings() -> [HostPairing] { [] }
    func savePairings(_ pairings: [HostPairing]) throws {}
}

@MainActor private final class NativeMountTransport: OrbisTransport {
    func pair(qr: PairingQR, deviceName: String, identity: DeviceIdentity,
              completion: @escaping (Result<HostPairing, Error>) -> Void) {
        completion(.failure(PairingError.invalidQR))
    }
    func connect(pairing: HostPairing, identity: DeviceIdentity,
                 receive: @escaping ([String: Any], String?) -> Void,
                 state: @escaping (ConnectionState, String?) -> Void) {}
    func disconnect() {}
    func send(_ object: [String: Any]) -> Bool { true }
}

private final class NativeMountPreparationGate: @unchecked Sendable {
    private let lock = NSLock()
    private let semaphore = DispatchSemaphore(value: 0)
    private var count = 0
    private var didTimeOut = false
    private var didRunOnMainThread = false

    var preparations: Int { locked { count } }
    var timedOut: Bool { locked { didTimeOut } }
    var ranOnMainThread: Bool { locked { didRunOnMainThread } }

    func wait() {
        let isFirst = locked {
            didRunOnMainThread = didRunOnMainThread || Thread.isMainThread
            count += 1
            return count == 1
        }
        if isFirst, semaphore.wait(timeout: .now() + 10) == .timedOut {
            locked { didTimeOut = true }
        }
    }

    func release() { semaphore.signal() }

    private func locked<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }
}
