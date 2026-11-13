import Foundation
import Testing
@testable import OrbisCore

final class MainThreadWorkGate: @unchecked Sendable {
    let entered = DispatchSemaphore(value: 0)
    let release = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private var armed = false
    func arm() { lock.lock(); armed = true; lock.unlock() }
    func work() {
        #expect(!Thread.isMainThread)
        lock.lock(); let wait = armed; armed = false; lock.unlock()
        if wait { entered.signal(); #expect(release.wait(timeout: .now() + 5) == .success) }
    }
    func waitEntered() async -> Bool {
        await withCheckedContinuation { continuation in
            DispatchQueue.global().async {
                continuation.resume(returning: self.entered.wait(timeout: .now() + 5) == .success)
            }
        }
    }
}

@Suite("Home background work") @MainActor
struct MainThreadWorkTests {
    private func url() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("orbis-background-" + UUID().uuidString)
    }
    private func pairing(_ id: String) -> HostPairing {
        HostPairing(hostId: id, hostName: id, hostPub: "test", pskRoot: "test",
            relay: RelayCredential(relayUrl: "wss://example.invalid", deviceId: id, credential: "test"), lan: [])
    }

    // PERF-08: a disk-owning worker can be blocked without holding the UI actor;
    // first launch admission waits for hydration and duplicate launches stay fenced.
    @Test func coldJournalReadLeavesUIAvailable() async {
        let root = url(), gate = MainThreadWorkGate(); gate.arm()
        let journal = ConfiguredLaunchJournal(url: root.appendingPathComponent("launch.json"), io: HostLocalIO(beforeIO: { gate.work() }))
        #expect(await gate.waitEntered())
        #expect(!journal.loaded)
        #expect(journal.update(expectedId: nil, value: ["launchId": "too-early"]) == nil)
        gate.release.signal()
        await journal.waitLoaded()
        #expect(journal.loaded && journal.snapshot == nil)
    }

    // Accepted mutations update memory immediately, while durable completions
    // preserve create/update/delete order and stale cleanup cannot remove a new ID.
    @Test func journalWritesKeepOrderWithoutBlockingMemory() async throws {
        let root = url(), file = root.appendingPathComponent("launch.json"), gate = MainThreadWorkGate()
        defer { try? FileManager.default.removeItem(at: root) }
        let journal = ConfiguredLaunchJournal(url: file, io: HostLocalIO(beforeIO: { gate.work() }))
        await journal.waitLoaded(); gate.arm()
        let first = try #require(journal.update(expectedId: nil, value: ["launchId": "one"]))
        #expect(await gate.waitEntered())
        #expect(journal.launchId == "one")
        #expect(journal.update(expectedId: nil, value: ["launchId": "duplicate"]) == nil)
        let second = try #require(journal.update(expectedId: "one", value: ["launchId": "one", "following": false]))
        #expect(journal.snapshot?["following"] as? Bool == false)
        gate.release.signal()
        #expect(await first.value); #expect(await second.value)
        let clear = try #require(journal.update(expectedId: "one", value: nil))
        let next = try #require(journal.update(expectedId: nil, value: ["launchId": "two"]))
        #expect(journal.update(expectedId: "one", value: nil) == nil)
        #expect(await clear.value); #expect(await next.value)
        let restored = ConfiguredLaunchJournal(url: file)
        await restored.waitLoaded()
        #expect(restored.launchId == "two")
    }

    // A failed durable write retains its identity for retry instead of authorizing
    // a second launch. The same record survives a subsequent successful retry.
    @Test func failedJournalWriteRetainsIdentityForRetry() async throws {
        let root = url(), file = root.appendingPathComponent("launch.json")
        defer { try? FileManager.default.removeItem(at: root) }
        try Data().write(to: root) // A file deliberately blocks creation of its child directory.
        let journal = ConfiguredLaunchJournal(url: file)
        await journal.waitLoaded()
        let first = try #require(journal.update(expectedId: nil, value: ["launchId": "one"]))
        #expect(await !first.value)
        #expect(journal.launchId == "one")
        #expect(journal.update(expectedId: nil, value: ["launchId": "duplicate"]) == nil)
        try FileManager.default.removeItem(at: root)
        let retry = try #require(journal.update(expectedId: "one", value: journal.snapshot))
        #expect(await retry.value)
        let restored = ConfiguredLaunchJournal(url: file)
        await restored.waitLoaded(); #expect(restored.launchId == "one")
    }

    // Decode work suspended on an old Host cannot publish into a replacement
    // subscription. This exercises the production async consume boundary.
    @Test func modelPreparationRejectsOldConnectionResults() async throws {
        let gate = MainThreadWorkGate(); gate.arm()
        let state = HostState(modelWorker: HostModelPreparationWorker(beforeWork: { gate.work() }))
        var sent: [[String: Any]] = []
        state.send = { sent.append($0); return true }
        state.setConnection(pairing("old"), connected: true)
        let request = try #require(sent.last)
        let domain: [String: Any] = ["domain": "identity", "modelEpoch": "old", "revision": 1,
            "availability": "ready", "completeness": "complete", "checkedAt": 1, "value": ["name": "Old"],
            "source": ["producer": "host", "sourceId": "old", "sourceEpoch": "old", "sourceRevision": 1]]
        let work = Task { await state.consume(["type": "agent.state.snapshot", "scope": "host",
            "requestId": request["requestId"]!, "stateFormat": request["stateFormat"]!, "modelEpoch": "old",
            "domains": [domain], "missing": [], "truncated": false]) }
        #expect(await gate.waitEntered())
        state.setConnection(pairing("new"), connected: true)
        gate.release.signal(); #expect(await work.value)
        #expect(state.domains.isEmpty && state.modelError == nil)
        state.setConnection(nil, connected: false)
    }

    // Retained facts from a previous connection must not suppress a new epoch
    // merely because its revision counter restarted below the old one.
    @Test func newModelEpochCanRestartItsRevisionAfterReconnect() async throws {
        let state = HostState(), host = pairing("host")
        var sent: [[String: Any]] = []
        state.send = { sent.append($0); return true }
        func receive(epoch: String, revision: Int) async throws {
            let request = try #require(sent.last)
            let domain: [String: Any] = ["domain": "identity", "modelEpoch": epoch, "revision": revision,
                "availability": "ready", "completeness": "complete", "checkedAt": revision, "value": ["name": epoch],
                "source": ["producer": "host", "sourceId": "host", "sourceEpoch": epoch, "sourceRevision": revision]]
            await state.consume(["type": "agent.state.snapshot", "scope": "host", "requestId": request["requestId"]!,
                "stateFormat": request["stateFormat"]!, "modelEpoch": epoch, "domains": [domain], "missing": [], "truncated": false])
        }
        state.setConnection(host, connected: true)
        try await receive(epoch: "old", revision: 100)
        state.setConnection(host, connected: false)
        state.setConnection(host, connected: true)
        try await receive(epoch: "new", revision: 1)
        #expect(state.domains["identity"]?.value["name"].string == "new")
        #expect(state.domains["identity"]?.revision == 1)
        state.setConnection(nil, connected: false)
    }

    // The catalog worker owns equality, sorting and index construction. Identity
    // projection preserves catalog counts/dates; partial catalogs retain old rows.
    @Test func catalogPreparationLeavesMainActorAvailableAndPreservesFacts() async {
        let gate = DispatchSemaphore(value: 0)
        let worker = SessionCatalogPreparationWorker(beforeWork: {
            #expect(!Thread.isMainThread)
            Task { @MainActor in gate.signal() }
            #expect(gate.wait(timeout: .now() + 3) == .success)
        })
        let old = SessionSummary(sessionId: "s", cwd: "/repo", createdAt: 1, modifiedAt: 2, messageCount: 3, agentKind: "codex")
        let runtime = RuntimeSummary(runtimeId: "r", name: "Agent", cwd: "/new", status: "idle", sessionId: "s", sessionName: "New", agentKind: "codex")
        let updated = await worker.merge(current: [old], incoming: [], completeKinds: [], retained: [], cacheLoaded: true, identity: runtime)
        #expect(updated.index["s"]?.name == "New")
        #expect(updated.index["s"]?.messageCount == 3 && updated.index["s"]?.modifiedAt == 2)
        let second = SessionSummary(sessionId: "second", cwd: "/repo", createdAt: 1, modifiedAt: 2, messageCount: 0, agentKind: "codex")
        let ordered = await worker.merge(current: [second, old], incoming: [], completeKinds: [], retained: [], cacheLoaded: true, identity: runtime)
        #expect(ordered.sessions.map(\.sessionId) == ["second", "s"], "Identity-only changes preserve the visible order")
        let retained = await worker.merge(current: updated.sessions, incoming: [], completeKinds: ["codex"], retained: ["s"], cacheLoaded: true)
        #expect(!retained.changed)
        let removed = await worker.merge(current: updated.sessions, incoming: [], completeKinds: ["codex"], retained: [], cacheLoaded: true)
        #expect(removed.changed && removed.index.isEmpty)
    }

    // A replacement connection owns a distinct live baseline even if the old
    // worker completes a late remember. Both expansion and cache encoding are off UI.
    @Test func sharedContentWorkersAreBackgroundAndGenerationLocal() async throws {
        let fixtureURL = try #require(Bundle.module.url(forResource: "field-transport-session", withExtension: "json", subdirectory: "Fixtures"))
        let fixture = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: fixtureURL)) as? [String: Any])
        let wire = try #require(fixture["wireInitial"] as? [String: Any]), patch = try #require(fixture["wirePatch"] as? [String: Any])
        let gate = DispatchSemaphore(value: 0)
        let old = SharedSessionContentWorker(beforeWork: {
            #expect(!Thread.isMainThread)
            Task { @MainActor in gate.signal() }
            #expect(gate.wait(timeout: .now() + 3) == .success)
        })
        let initial = try await old.expand(wire, payload: nil, epoch: nil, seq: nil)
        let next = SharedSessionContentWorker()
        await old.remember(try #require(initial.message["event"] as? [String: Any]), runtime: "runtime")
        _ = try await old.expand(patch, payload: nil, epoch: "source", seq: 1)
        do {
            _ = try await next.expand(patch, payload: nil, epoch: "source", seq: 1)
            Issue.record("Replacement connection reused an old live baseline")
        } catch { #expect(error is StateDeltas.Failure) }
    }
}
