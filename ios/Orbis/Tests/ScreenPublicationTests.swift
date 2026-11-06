import Foundation
import Testing
@testable import OrbisCore

private final class EmptyScreenSecureStore: SecureStorage {
    func deviceIdentity() throws -> DeviceIdentity { .generate() }
    func pairings() -> [HostPairing] { [] }
    func savePairings(_ pairings: [HostPairing]) throws {}
}

private final class PreparationCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    func increment() { lock.lock(); count += 1; lock.unlock() }
    var value: Int { lock.lock(); defer { lock.unlock() }; return count }
}

@Suite("Scoped screen publications")
struct ScreenPublicationTests {
    private func message(_ id: String, role: String, text: String) -> ChatMessage {
        ChatMessage(messageId: id, role: role, content: [ChatContent(type: "text", text: text, toolName: nil, artifact: nil)], timestamp: 1, isError: nil)
    }

    // Cached readiness must not pin a generated failure label to the previous app language.
    @Test @MainActor func cachedHomeSyncFollowsLanguageWithoutAnotherNetworkEvent() {
        let localization = AppLocalization.shared, previous = AppLocalization.shared.preference
        defer { localization.select(previous) }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("orbis-screen-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let connection = HostConnection(secure: EmptyScreenSecureStore(), autoConnect: false, preferences: nil, transferRoot: root)
        defer { connection.shutdown() }
        localization.select(.chinese)
        let chinese = connection.preparedHomeSync
        localization.select(.english)
        let english = connection.preparedHomeSync
        #expect(english == connection.homeSyncStatus)
        #expect(chinese != english)
    }

    // A fallback title still accepts the first question/correction, while ordinary chunks skip sorting.
    @Test func streamedFallbackTitlesDoNotResortHomeCards() async {
        let counter = PreparationCounter()
        let worker = HomeCardWorker(beforeSort: { counter.increment() })
        let runtime = RuntimeSummary(runtimeId: "r", name: "Agent", cwd: "/repo", status: "running", sessionId: "s")
        let user = message("u", role: "user", text: "Question")
        for index in 0..<60 {
            let next = await worker.resolve(runtimes: [runtime], sessions: [:], messages: ["r": [user, message("a", role: "assistant", text: "Chunk \(index)")]], pending: [:])
            #expect(next.cards.first?.title == "Question")
        }
        #expect(counter.value == 1)
        let corrected = await worker.resolve(runtimes: [runtime], sessions: [:], messages: ["r": [message("u", role: "user", text: "Corrected")]], pending: [:])
        #expect(corrected.cards.first?.title == "Corrected")
        #expect(counter.value == 2)
    }

    // Assistant chunks must skip catalog row preparation; title corrections and archive overlays stay authoritative.
    @Test @MainActor func stableChunksReuseCatalogAndBackgroundFiltersLeaveMainActorAvailable() async throws {
        let counter = PreparationCounter(), gate = DispatchSemaphore(value: 0)
        let worker = SessionDirectoryCatalogWorker(beforeRows: { counter.increment() })
        let runtime = RuntimeSummary(runtimeId: "r", name: "Agent", cwd: "/repo", status: "running", sessionId: "s")
        let session = SessionSummary(sessionId: "s", cwd: "/repo", createdAt: 1, modifiedAt: 10, messageCount: 2, agentKind: "codex", modelProvider: "one")
        let user = message("u", role: "user", text: "Question")
        let first = await worker.resolve(sessions: [session], runtimes: [runtime], messages: ["r": [user, message("a", role: "assistant", text: "First")]], archived: [:])
        for index in 0..<60 {
            let next = await worker.resolve(sessions: [session], runtimes: [runtime], messages: ["r": [user, message("a", role: "assistant", text: "Chunk \(index)")]], archived: [:])
            #expect(next === first)
        }
        #expect(counter.value == 1)
        let changed = await worker.resolve(sessions: [session], runtimes: [runtime], messages: ["r": [message("u", role: "user", text: "Corrected")]], archived: [:])
        #expect(changed.titles["s"] == "Corrected")
        #expect(changed !== first)
        let archived = await worker.resolve(sessions: [session], runtimes: [runtime], messages: ["r": [user]], archived: ["s": true])
        #expect(archived.sessions.first?.archived == true)
        let filterWorker = SessionDirectoryWorker(beforeResolve: {
            #expect(!Thread.isMainThread)
            Task { @MainActor in gate.signal() }
            #expect(gate.wait(timeout: .now() + 3) == .success)
        })
        func filter(_ catalog: SessionDirectoryCatalog, host: String = "h", archived: Bool = false, provider: String = "current", query: String = "") -> SessionDirectoryFilter {
            SessionDirectoryFilter(hostId: host, catalogRevision: catalog.revision, query: query, kind: "codex", archived: archived,
                                   provider: provider, currentProvider: "one", language: "zh-Hans")
        }
        let initial = await filterWorker.resolve(catalog: first, filter: filter(first))
        #expect(initial.directories.first?.sessions.map(\.sessionId) == ["s"])
        #expect(initial.keys == ["directory:/repo", "session:s"])
        #expect(initial === (await filterWorker.resolve(catalog: first, filter: filter(first))))
        #expect((await filterWorker.resolve(catalog: first, filter: filter(first, query: "missing"))).sessions.isEmpty)
        #expect((await filterWorker.resolve(catalog: first, filter: filter(first, provider: "unknown"))).provider == "current")
        #expect((await filterWorker.resolve(catalog: archived, filter: filter(archived, archived: true))).sessions.count == 1)
        #expect((await filterWorker.resolve(catalog: first, filter: filter(first, host: "other"))).filter.hostId == "other")
    }
}
