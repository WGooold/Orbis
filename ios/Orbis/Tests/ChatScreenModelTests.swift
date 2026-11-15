import Foundation
import Observation
import Testing
@testable import OrbisCore

private final class ChatModelTestStorage: SecureStorage {
    let hosts = [HostPairing(hostId: "chat-model-host", hostName: "Chat model", hostPub: "test-public-key",
        pskRoot: Base64URL.encode(Data(repeating: 1, count: 32)),
        relay: RelayCredential(relayUrl: "wss://relay.example", deviceId: "test-device", credential: "test-only"), lan: [])]
    func deviceIdentity() throws -> DeviceIdentity { .generate() }
    func pairings() -> [HostPairing] { hosts }
    func savePairings(_ pairings: [HostPairing]) throws {}
}

@MainActor private final class ChatModelTestTransport: OrbisTransport {
    var receive: (([String: Any], String?) -> Void)?
    var drain: (() async -> Void)?
    func pair(qr: PairingQR, deviceName: String, identity: DeviceIdentity, completion: @escaping (Result<HostPairing, Error>) -> Void) {
        completion(.failure(PairingError.invalidQR))
    }
    func connect(pairing: HostPairing, identity: DeviceIdentity, receive: @escaping ([String: Any], String?) -> Void,
                 state: @escaping (ConnectionState, String?) -> Void) {
        self.receive = receive
        state(.connecting, nil)
    }
    func disconnect() {}
    func send(_ object: [String: Any]) -> Bool { true }
    func ready(session: String) async {
        receive?(["type": "device.ready", "protocolVersion": orbisProtocolVersion,
            "runtimes": [["runtimeId": "same-runtime", "name": "Agent", "cwd": "/repo",
                          "status": "idle", "sessionId": session]]], "ctl")
        await drain?()
    }
}

private final class ChatObservationCount: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    var value: Int { lock.lock(); defer { lock.unlock() }; return count }
    func changed() { lock.lock(); count += 1; lock.unlock() }
}

@MainActor @Observable private final class ChatObservationPrototype {
    var value = 0
}

@Suite("Chat page state and scheduling (ADR-0082)") @MainActor
struct ChatScreenModelTests {
    // IOS-CHAT-07-R1 / PERF-12: an unpublished keystroke must not leak into
    // composer equality when any other source (including streaming) commits.
    @Test func typedDraftDoesNotInvalidateComposerOnUnrelatedCommits() async throws {
        let (store, transport, root) = setup()
        defer { store.activeConnection.shutdown(); try? FileManager.default.removeItem(at: root) }
        await transport.ready(session: "session"); await settle(store)
        let model = store.chatScreens, count = ChatObservationCount(), readCount = ChatObservationCount()
        let revision = model.composer.draftRevision
        withObservationTracking { _ = model.composer } onChange: { count.changed() }
        withObservationTracking { _ = model.canReadTranscript } onChange: { readCount.changed() }
        for text in ["t", "ty", "typ", "typed"] {
            model.actions.editDraft(text)
            store.activeConnection.objectWillChange.send()
            await settle(store)
            #expect(model.actions.draft == text)
            #expect(model.composer.draftRevision == revision)
            #expect(count.value == 0)
            #expect(readCount.value == 0)
        }
        model.actions.saveDraft("restored")
        await settle(store)
        #expect(model.composer.draftRevision != revision)
        #expect(model.actions.draft == "restored")
        #expect(count.value == 1)
    }

    // IOS-CHAT-10-R2: root navigation must defer captures both before first
    // opening chat and after popping it; covered mounted pages keep their contract.
    @Test func navigationHoldDoesNotDependOnWhetherChatWasPreviouslyMounted() async {
        for previouslyMounted in [false, true] {
            let (store, transport, root) = setup()
            defer { store.activeConnection.shutdown(); try? FileManager.default.removeItem(at: root) }
            await transport.ready(session: "session"); await settle(store)
            let model = store.chatScreens, token = UUID(), target = model.actions.target
            if previouslyMounted {
                model.mount(target: target, token: token, visible: true, foreground: true)
                model.unmount(target: target, token: token)
            }
            let before = model.captureRevision
            store.holdScreenPublications(true, limit: .seconds(30))
            store.activeConnection.objectWillChange.send()
            await model.waitForPending()
            #expect(model.captureRevision == before)
            store.holdScreenPublications(false)
            await model.waitForPending()
            #expect(model.captureRevision == before + 1)
        }
    }

    // IOS-CHAT-10-R2: the Hub's sole timeout releases both publication paths.
    @Test func sharedMotionTimeoutReleasesAnUnmountedChatCapture() async throws {
        let (store, transport, root) = setup()
        defer { store.activeConnection.shutdown(); try? FileManager.default.removeItem(at: root) }
        await transport.ready(session: "session"); await settle(store)
        let model = store.chatScreens, token = UUID(), target = model.actions.target
        model.mount(target: target, token: token, visible: true, foreground: true)
        model.unmount(target: target, token: token)
        let before = model.captureRevision
        store.holdScreenPublications(true, limit: .milliseconds(40))
        store.activeConnection.objectWillChange.send()
        await model.waitForPending()
        #expect(model.captureRevision == before)
        try await Task.sleep(for: .milliseconds(100))
        await settle(store)
        #expect(model.captureRevision == before + 1)
    }

    // IOS-CHAT-11-R1: revisions cache real content; removal retires its content
    // and reordering changes native membership without rebuilding retained rows.
    @Test func nativeItemCacheBuildsOnlyChangedRowsAndRetiresRemovedRows() {
        let cache = ChatTranscriptItemCache<Int, UUID>()
        var builds = 0
        func item(_ id: String, _ revision: Int) -> UUID {
            cache.item(id: id, inputs: revision) { builds += 1; return UUID() }
        }
        let a = item("a", 1), b = item("b", 1)
        cache.retain(ids: ["a", "b"])
        let initial = cache.revision
        for _ in 0..<10 {
            #expect(item("a", 1) == a); #expect(item("b", 1) == b)
            cache.retain(ids: ["a", "b"])
        }
        #expect(builds == 2); #expect(cache.revision == initial)
        #expect(item("b", 2) != b); #expect(item("a", 1) == a)
        #expect(builds == 3)
        let updated = cache.revision
        cache.retain(ids: ["b", "a"])
        #expect(cache.revision != updated); #expect(builds == 3)
        cache.retain(ids: ["b"])
        #expect(item("a", 1) != a); #expect(builds == 4)
    }

    // IOS-CHAT-11-R1: native intent delivery is independent of SwiftUI
    // observation, and detaching a Coordinator retires its subscription.
    @Test func nativeViewportDeliveryDoesNotCreateARowBuilderObservation() {
        let viewport = ChatViewportController(), view = ChatObservationCount(), native = ChatObservationCount()
        withObservationTracking { _ = viewport.nativeState } onChange: { view.changed() }
        let token = viewport.observeNativeState { native.changed() }
        viewport.update { $0.locateQuestion("question", bottomDistance: 120) }
        #expect(native.value == 1); #expect(view.value == 0)
        viewport.update { $0.jumpToLatest() }
        #expect(native.value == 2); #expect(view.value == 0)
        viewport.removeNativeStateObserver(token)
        viewport.resetForMount()
        #expect(native.value == 2); #expect(view.value == 0)
    }

    private func setup() -> (OrbisStore, ChatModelTestTransport, URL) {
        let transport = ChatModelTestTransport()
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("orbis-chat-model-" + UUID().uuidString)
        let store = OrbisStore(secure: ChatModelTestStorage(), transport: transport, deviceName: "test",
                               preferences: nil, transferRoot: root)
        transport.drain = { [weak store] in await store?.waitForPendingEvents() }
        return (store, transport, root)
    }

    private func settle(_ store: OrbisStore) async {
        await store.waitForPendingEvents()
        await store.chatScreens.waitForPending()
        for _ in 0..<5 { await Task.yield() }
    }

    // IOS-CHAT-07 prototype: pin the installed Observation macro's Equatable setter
    // behavior separately from the model's explicit equality guard.
    @Test func equatableObservableSetterSkipsEqualAssignmentsOnThisToolchain() {
        let prototype = ChatObservationPrototype(), count = ChatObservationCount()
        withObservationTracking { _ = prototype.value } onChange: { count.changed() }
        prototype.value = 0
        #expect(count.value == 0)
        prototype.value = 1
        #expect(count.value == 1)
    }

    // IOS-CHAT-07/08: mount-cached callbacks belong to one connection owner,
    // while ordinary publications must preserve that owner's mounted page.
    @Test func pageIdentitySeparatesOwnersAndStaysStableAcrossRegionPublications() async throws {
        let (store, transport, root) = setup()
        let (other, otherTransport, otherRoot) = setup()
        defer {
            store.activeConnection.shutdown(); other.activeConnection.shutdown()
            try? FileManager.default.removeItem(at: root)
            try? FileManager.default.removeItem(at: otherRoot)
        }
        await transport.ready(session: "same-session"); await settle(store)
        await otherTransport.ready(session: "same-session"); await settle(other)
        let target = store.chatScreens.navigation.target
        let otherTarget = other.chatScreens.navigation.target
        #expect(target.identity == otherTarget.identity)
        #expect(target.pageIdentity != otherTarget.pageIdentity)

        store.saveDraft("same mounted target", for: try #require(store.selectedRuntime))
        await settle(store)
        #expect(store.chatScreens.snapshot.draft == "same mounted target")
        #expect(store.chatScreens.navigation.target.pageIdentity == target.pageIdentity)
    }

    // IOS-CHAT-07/08: reusing a runtime ID with a new session must hand off every
    // region, while a retained old editor cannot alter the replacement draft.
    @Test func replacementSessionInvalidatesEveryRegionAndRejectsTheOldEditor() async throws {
        let (store, transport, root) = setup()
        defer { store.activeConnection.shutdown(); try? FileManager.default.removeItem(at: root) }
        await transport.ready(session: "first"); await settle(store)
        let model = store.chatScreens, old = model.actions
        let originalRuntime = try #require(store.selectedRuntime)
        let paths: [PartialKeyPath<ChatScreenModel>] = [\.navigation, \.shell, \.header, \.transcript, \.composer, \.notices, \.workspace]
        let counts = paths.map { path in
            let count = ChatObservationCount()
            withObservationTracking { _ = model[keyPath: path] } onChange: { count.changed() }
            return count
        }
        #expect(old.isCurrent)
        await transport.ready(session: "replacement"); await settle(store)
        #expect(model === store.chatScreens)
        #expect(model.actions.sessionId == "replacement")
        #expect(model.navigation.target.pageIdentity != old.target.pageIdentity)
        #expect(counts.map(\.value) == [1, 1, 1, 1, 1, 1, 1])
        #expect(!old.isCurrent)
        #expect(!old.ownsRuntime)
        // Recreating an old panel cannot adopt the replacement runtime as fallback.
        let reconstructed = ChatSessionActions(store: store, target: old.target, preservingRuntime: originalRuntime)
        #expect(reconstructed.runtime?.sessionId == "first")
        #expect(ChatSessionActions(store: store, target: old.target).runtime?.sessionId != "replacement")
        let runtime = try #require(store.selectedRuntime)
        let before = store.draft(for: runtime)
        old.editDraft("late keystroke")
        old.saveDraft("late restore")
        #expect(store.draft(for: runtime) == before)
    }

    // IOS-CHAT-10: only a visible moving page defers data. Covered/background
    // pages retain fresh state, so exposing the page cannot replay a backlog.
    @Test func coveredAndBackgroundPagesCommitWhileVisibleMotionDefers() async throws {
        let (store, transport, root) = setup()
        defer { store.activeConnection.shutdown(); try? FileManager.default.removeItem(at: root) }
        await transport.ready(session: "session"); await settle(store)
        let model = store.chatScreens, target = model.actions.target
        let token = UUID()
        model.mount(target: target, token: token, visible: true, foreground: true)
        defer { model.unmount(target: target, token: token) }
        let runtime = try #require(store.selectedRuntime), initial = model.snapshot.draft
        model.motionChanged(true)
        defer { model.motionChanged(false) }
        store.saveDraft("during motion", for: runtime)
        await model.waitForPending()
        #expect(model.visualActivity.phase == .moving)
        #expect(model.snapshot.draft == initial)

        model.visibilityChanged(target: target, visible: false, foreground: true)
        await model.waitForPending()
        #expect(model.visualActivity.phase == .covered)
        #expect(model.snapshot.draft == "during motion")
        store.saveDraft("while covered", for: runtime)
        await model.waitForPending()
        #expect(model.snapshot.draft == "while covered")

        model.visibilityChanged(target: target, visible: false, foreground: false)
        store.saveDraft("while backgrounded", for: runtime)
        await model.waitForPending()
        #expect(model.visualActivity.phase == .background)
        #expect(model.snapshot.draft == "while backgrounded")
        model.motionChanged(false)
        model.visibilityChanged(target: target, visible: true, foreground: true)
        #expect(model.visualActivity.phase == .active)
        #expect(model.snapshot.draft == "while backgrounded")
    }

    // IOS-CHAT-10/11: navigation pop really unmounts a page. Reopening the
    // same selected session needs fresh native-scroll policy, whereas covering
    // or repeating the mounted page's onAppear must preserve its reading state.
    @Test func remountingTheSameTargetResetsViewportAndLateUnmountCannotStopItsSuccessor() async {
        let (store, transport, root) = setup()
        defer { store.activeConnection.shutdown(); try? FileManager.default.removeItem(at: root) }
        await transport.ready(session: "same-session"); await settle(store)
        let model = store.chatScreens, target = model.actions.target
        let first = UUID(), second = UUID()
        model.mount(target: target, token: first, visible: true, foreground: true)
        model.viewport.update { $0.locateQuestion("question", bottomDistance: 120) }
        let readingRequest = model.viewport.request, readingGeneration = model.viewport.contextGeneration
        #expect(readingRequest != nil)
        #expect(!model.viewport.following)

        model.visibilityChanged(target: target, visible: false, foreground: true)
        #expect(model.visualActivity.phase == .covered)
        #expect(model.viewport.contextGeneration == readingGeneration)
        #expect(model.viewport.request == readingRequest)
        model.mount(target: target, token: first, visible: true, foreground: true)
        #expect(model.viewport.contextGeneration == readingGeneration)
        #expect(model.viewport.request == readingRequest)
        #expect(!model.viewport.following)

        model.unmount(target: target, token: first)
        #expect(!model.visualActivity.active)
        model.mount(target: target, token: second, visible: true, foreground: true)
        #expect(model.visualActivity.phase == .active)
        #expect(model.viewport.contextGeneration > readingGeneration)
        #expect(model.viewport.following)
        #expect(model.viewport.request == nil)
        let reopenedGeneration = model.viewport.contextGeneration
        // The old view can disappear after the successor has already appeared.
        model.unmount(target: target, token: first)
        #expect(model.visualActivity.phase == .active)
        #expect(model.viewport.contextGeneration == reopenedGeneration)
        #expect(model.viewport.request == nil)
        model.unmount(target: target, token: second)
    }

    private func message(_ id: String, role: String) -> ChatMessage {
        ChatMessage(messageId: id, role: role,
            content: [ChatContent(type: "text", text: id, toolName: nil, artifact: nil)],
            timestamp: 1, isError: nil)
    }

    private func transcript(_ target: ChatActionContext, messages: [ChatMessage], syncing: Bool = false,
                            history: Int = 0) -> ChatTranscriptState {
        ChatTranscriptState(target: target, kind: "codex", transcript: ChatTranscript(messages: messages, turnTimings: [:]),
            hasMessages: !messages.isEmpty, canSend: true, syncing: syncing, cached: false, connection: .secured,
            streaming: [], pending: PendingSendOutbox(), pendingActions: [], uploads: [],
            historyRevision: history, historyPageRevision: 0, historyLoading: false, historyError: nil,
            hasOlder: false, actionFeedback: nil, rewind: [:], status: "idle")
    }

    // IOS-CHAT-11: the first lazy row may claim synchronously after commit;
    // no body pass is required to create the ticket, and a second claim cannot replay it.
    @Test func transcriptCommitRegistersAnArrivalBeforeTheLazyRowClaimsIt() throws {
        let (store, _, root) = setup()
        defer { store.activeConnection.shutdown(); try? FileManager.default.removeItem(at: root) }
        let target = store.chatScreens.actions.target, controller = ChatViewportController()
        let initial = [message("question", role: "user")]
        controller.commit(transcript(target, messages: initial), now: 0)
        controller.distanceChanged(0)
        let next = transcript(target, messages: initial + [message("reply", role: "assistant")])
        controller.commit(next, now: 1)
        let row = try #require(next.transcript.rows.last)
        #expect(controller.arrivals.claim(row.id, now: 1.01))
        #expect(!controller.arrivals.claim(row.id, now: 1.02))
    }

    // IOS-CHAT-11: a drag or a visibility change invalidates an unclaimed ticket
    // immediately, even without another transcript publication.
    @Test func leavingFollowingOrHidingInvalidatesUnclaimedArrivals() throws {
        let (store, _, root) = setup()
        defer { store.activeConnection.shutdown(); try? FileManager.default.removeItem(at: root) }
        for hidden in [false, true] {
            let target = store.chatScreens.actions.target, controller = ChatViewportController()
            let initial = [message("question", role: "user")]
            controller.commit(transcript(target, messages: initial), now: 0)
            controller.distanceChanged(0)
            let next = transcript(target, messages: initial + [message("reply", role: "assistant")])
            controller.commit(next, now: 1)
            if hidden { controller.setVisualActive(false) } else { controller.interactionChanged(true) }
            let row = try #require(next.transcript.rows.last)
            #expect(!controller.arrivals.claim(row.id, now: 1.01))
        }
    }

    // IOS-CHAT-11: the snapshot that first becomes ready is a baseline, rather
    // than an append animation; history replacement also resets without a scroll request.
    @Test func firstReadyCommitAndHistoryReplacementNeverReplayArrivals() throws {
        let (store, _, root) = setup()
        defer { store.activeConnection.shutdown(); try? FileManager.default.removeItem(at: root) }
        let target = store.chatScreens.actions.target, controller = ChatViewportController()
        let initial = [message("question", role: "user")]
        controller.commit(transcript(target, messages: initial, syncing: true), now: 0)
        controller.distanceChanged(0)
        let ready = transcript(target, messages: initial + [message("reply", role: "assistant")])
        controller.commit(ready, now: 1)
        let row = try #require(ready.transcript.rows.last)
        #expect(!controller.arrivals.claim(row.id, now: 1.01))
        controller.update { $0.jumpToLatest() }
        #expect(controller.request != nil)
        let revision = controller.contextGeneration
        controller.commit(transcript(target, messages: initial, history: 1), now: 2)
        #expect(controller.contextGeneration == revision + 1)
        #expect(controller.request == nil)
    }
}
