#if os(iOS) && canImport(ActivityKit)
import ActivityKit
import Combine
import Foundation

/// LA-I04: native activity creation is foreground-only. Background changes are
/// delivered by ActivityKit APNs, independently of the app's WebSocket lifetime.
@MainActor
final class LiveActivityCoordinator: ObservableObject {
    static let shared = LiveActivityCoordinator()
    struct Navigation { let hostId: String; let runtimeId: String? }
    let navigation = CurrentValueSubject<Navigation?, Never>(nil)
    private weak var store: OrbisStore?
    private var foreground = false
    private var observations: [String: AnyCancellable] = [:]
    private var observedConnections: [String: ObjectIdentifier] = [:]
    private var revisions: [String: UInt64] = [:]
    private var activities: [String: Activity<OrbisLiveActivityAttributes>] = [:]
    private var tokenTasks: [String: Task<Void, Never>] = [:]
    private var stateTasks: [String: Task<Void, Never>] = [:]
    private var lastStates: [String: OrbisLiveActivityState] = [:]
    private var lifecycle = UserDefaults.standard.data(forKey: "orbis.liveActivityLifecycle")
        .flatMap { try? JSONDecoder().decode(LiveActivityLifecycle.self, from: $0) } ?? LiveActivityLifecycle()
    private var lifecycleSave: Task<Void, Never>?
    private var savedLifecycle: LiveActivityLifecycle?
    private var routes: [String: [String: (runtime: String, session: String)]] = [:]
    // A route map is usable only after it was built from the same connection
    // revision that is currently visible. Keeping the revision with the map
    // prevents a click during a streaming update from being treated as a
    // confirmed "focus not found" result.
    private var routeRevisions: [String: UInt64] = [:]
    private var routeComplete: [String: Bool] = [:]
    private var openQueue = LiveActivityOpenQueue()
    private var openTimeout: Task<Void, Never>?
    private var queuedHostId: String?
    private var dirty = false
    private var reconcile: Task<Void, Never>?
    private var renewal: Task<Void, Never>?
    private let registration = LiveActivityRegistrationCoordinator(environment: PushRegistrationEnvironment.load(),
        loadKnown: { try await Task.detached { try SecureStore.shared.liveActivityRegistrations() }.value },
        saveKnown: { targets in try await Task.detached { try SecureStore.shared.saveLiveActivityRegistrations(targets) }.value })

    func bind(_ store: OrbisStore, foreground: Bool) {
        self.store = store
        registration.updatePairings(store.pairings)
        let ids = Set(store.pairings.map(\.hostId))
        for id in Array(observations.keys) where !ids.contains(id) {
            observations[id] = nil; observedConnections[id] = nil
        }
        for host in store.hosts where observedConnections[host.hostId] != ObjectIdentifier(host.connection) {
            observedConnections[host.hostId] = ObjectIdentifier(host.connection)
            observations[host.hostId] = host.connection.objectWillChange.sink { [weak self] _ in
                self?.revisions[host.hostId, default: 0] &+= 1
                self?.schedule()
            }
        }
        // Recover system-owned activities, obtaining the current token from
        // ActivityKit instead of replaying a token stored by an earlier process.
        // A suspended process may miss both the state update and the dismissal
        // callback, so reconcile the local registry against ActivityKit first.
        let systemActivities = Activity<OrbisLiveActivityAttributes>.activities
        let systemByID = Dictionary(uniqueKeysWithValues: systemActivities.map { ($0.id, $0) })
        for activity in Array(activities.values) where systemByID[activity.id] == nil {
            retire(activity, state: .dismissed)
        }
        for activity in systemActivities where activity.activityState == .ended || activity.activityState == .dismissed {
            retire(activity, state: activity.activityState)
        }
        lifecycle.restore(systemActiveIds: Set(systemActivities.filter { $0.activityState == .active || $0.activityState == .stale }.map(\.id)))
        persistLifecycle()
        for activity in systemActivities.sorted(by: { $0.content.state.updatedAt > $1.content.state.updatedAt }) where tokenTasks[activity.id] == nil {
            watch(activity)
        }
        setForeground(foreground)
    }

    func setForeground(_ value: Bool) {
        let changed = foreground != value
        foreground = value
        renewal?.cancel(); renewal = nil
        if !value {
            reconcile?.cancel(); reconcile = nil
            return
        }
        guard changed else {
            if value { routeOpen(); schedule() }
            return
        }
        if value {
            routeOpen(); registration.refresh(); schedule()
            renewal = Task { [weak self] in
                while !Task.isCancelled {
                    do { try await Task.sleep(nanoseconds: 240_000_000_000) } catch { return }
                    self?.schedule()
                }
            }
        }
    }

    func receive(_ url: URL) {
        guard let target = LiveActivityOpenTarget(url: url) else { return }
        cancelQueuedOpen()
        let generation = openQueue.enqueue(target, now: ProcessInfo.processInfo.systemUptime)
        openTimeout = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: UInt64(LiveActivityOpenQueue.timeout * 1_000_000_000)) } catch { return }
            guard let self, self.openQueue.generation == generation else { return }
            self.routeOpen()
        }
        routeOpen()
    }

    func cancelQueuedOpen() {
        openQueue.cancel(); queuedHostId = nil
        openTimeout?.cancel(); openTimeout = nil
    }

    /// Host selection publications may follow the deep link's own connect call.
    /// Runtime restoration on device.ready is automatic, so explicit user
    /// navigation actions cancel separately rather than treating it as navigation.
    func navigationSelectionChanged() {
        guard let queuedHostId, let store else { return }
        if queuedHostId != store.selectedHostId { cancelQueuedOpen() }
    }

    private func routeOpen() {
        guard foreground, let target = openQueue.target, let store else { return }
        navigationSelectionChanged()
        guard openQueue.target != nil else { return }
        guard let pairing = store.pairings.first(where: { $0.hostId == target.hostId }),
              FileTransfers.pairingKey(pairing) == target.pairingKey else { cancelQueuedOpen(); return }
        // Selecting even the same Host publishes feedback state. Do it once per
        // tap so retries do not invalidate the route revision they need to read.
        if queuedHostId == nil {
            store.connect(hostId: target.hostId)
            queuedHostId = store.selectedHostId
        }
        let connection = store.connection(for: target.hostId)
        let route = target.focusKey.flatMap { routes[target.hostId]?[$0] }
        let runtime = route.flatMap { route in
            connection?.runtimes.first { $0.runtimeId == route.runtime && $0.sessionId == route.session }
        }
        let current = routeRevisions[target.hostId] == revisions[target.hostId, default: 0]
        // A matching runtime in a current map is sufficient even when an
        // unrelated runtime still awaits background-task reconciliation.
        guard let destination = openQueue.resolve(generation: openQueue.generation,
            now: ProcessInfo.processInfo.systemUptime, routeIsCurrent: current,
            complete: routeComplete[target.hostId] == true && connection?.homeRuntimesUpdating == false,
            runtimeId: runtime?.runtimeId) else { return }
        cancelQueuedOpen()
        switch destination {
        case .runtime(let runtimeId):
            store.selectRuntime(hostId: target.hostId, runtimeId: runtimeId)
            navigation.send(Navigation(hostId: target.hostId, runtimeId: runtimeId))
        case .home:
            navigation.send(Navigation(hostId: target.hostId, runtimeId: nil))
        }
    }

    private func schedule() {
        guard foreground, store != nil else { return }
        dirty = true
        guard reconcile == nil else { return }
        reconcile = Task { [weak self] in
            guard let self else { return }
            defer { self.reconcile = nil }
            while self.foreground && self.dirty && !Task.isCancelled {
                self.dirty = false
                // A bounded coalescer still runs during continuous streaming;
                // it cannot be postponed forever by the next token publication.
                do { try await Task.sleep(nanoseconds: 250_000_000) } catch { return }
                guard self.foreground else { return }
                await self.refresh()
            }
        }
    }

    private func refresh() async {
        guard let store else { return }
        let hosts = store.hosts
        for (id, activity) in activities {
            let valid = hosts.contains { $0.hostId == id && FileTransfers.pairingKey($0.pairing) == activity.attributes.pairingKey }
            if !valid { await finish(activity, state: nil, immediate: true) }
        }
        let pairedKeys = Set(hosts.map { FileTransfers.pairingKey($0.pairing) })
        for key in Set(lifecycle.created.keys).union(lifecycle.suppressed.keys) where !pairedKeys.contains(key) {
            lifecycle.forgetPairing(key)
        }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            for activity in Array(activities.values) { await finish(activity, state: nil, immediate: true) }
            return
        }
        for host in hosts {
            let hostId = host.hostId
            let connection = host.connection
            let revision = revisions[hostId, default: 0]
            let complete = !connection.homeRuntimesUpdating && !connection.runtimes.contains { runtime in
                runtime.status == "idle" && runtime.backgroundTasks.map { !$0.confirmed } == true
            }
            let facts = connection.runtimes.compactMap { runtime -> LiveActivityRuntimeFact? in
                guard let session = runtime.sessionId, let kind = runtime.agentKind else { return nil }
                let execution = connection.agentState.snapshots[runtime.runtimeId]?.domains["execution"]
                let tasks = runtime.backgroundTasks
                return LiveActivityRuntimeFact(sessionId: session, agentKind: kind, phase: runtime.status,
                    pendingCount: min(64, connection.interactions[runtime.runtimeId]?.count ?? 0),
                    startedAt: execution?.value["turn"]["startedAt"].integer,
                    backgroundAgents: LiveActivityProjection.hasBackgroundAgents(tasks),
                    title: runtime.sessionName ?? runtime.name, turnId: runtime.executionTurnId, runtimeId: runtime.runtimeId)
            }
            let previous = activities[host.hostId]?.content.state ?? lastStates[host.hostId]
            let now = Int64(Date().timeIntervalSince1970 * 1000)
            let projection = await Task.detached(priority: .utility) {
                let keyed = facts.map { fact in (fact, LiveActivityProjection.focusKey(hostId: hostId, agentKind: fact.agentKind, sessionId: fact.sessionId)) }
                return (LiveActivityProjection.make(hostId: hostId, facts: facts, complete: complete, previous: previous, now: now), keyed)
            }.value
            guard foreground, store.pairings.contains(host.pairing), store.connection(for: hostId) === connection,
                  revisions[hostId, default: 0] == revision,
                  activities[hostId]?.content.state == previous || activities[hostId] == nil else { continue }
            let pairingKey = FileTransfers.pairingKey(host.pairing)
            let runs = projection.1.filter { fact, _ in fact.pendingCount > 0 || fact.phase != "idle" || fact.backgroundAgents }
                .map { fact, key in LiveActivityLifecycle.Run(focusKey: key, turnId: fact.turnId) }
            let runKeys = lifecycle.runKeys(pairingKey: pairingKey, runs: runs, complete: complete)
            let mayStart = lifecycle.mayStart(pairingKey: pairingKey, currentRuns: runKeys, complete: complete)
            routes[hostId] = Dictionary(projection.1.compactMap { fact, key in
                fact.runtimeId.map { (key, (runtime: $0, session: fact.sessionId)) }
            }, uniquingKeysWith: { _, latest in latest })
            routeRevisions[hostId] = revision
            routeComplete[hostId] = complete
            guard let state = projection.0, state.isValid else { persistLifecycle(); continue }
            if let activity = activities[host.hostId] {
                if complete { lifecycle.noteCreated(pairingKey: pairingKey, activityId: activity.id, runKeys: runKeys) }
                if state.phase == "ended" { await finish(activity, state: state, immediate: false) }
                else if !LiveActivityProjection.sameMeaning(activity.content.state, state) || now - activity.content.state.updatedAt >= 240_000 {
                    await activity.update(content(state))
                }
            } else if mayStart && ["running", "attention"].contains(state.phase) {
                let localTitle = projection.1.first { _, key in key == state.focusKey }?.0.title
                let attributes = OrbisLiveActivityAttributes(hostId: host.hostId, language: AppLocalization.shared.language.rawValue,
                    pairingKey: FileTransfers.pairingKey(host.pairing), initialFocusKey: state.focusKey,
                    initialTitle: localTitle.map { String($0.prefix(120)) })
                do {
                    let activity = try Activity.request(attributes: attributes, content: content(state), pushType: .token)
                    lifecycle.noteCreated(pairingKey: pairingKey, activityId: activity.id, runKeys: runKeys)
                    watch(activity)
                } catch {
                    // Authorization, concurrent-activity limits or signing may prevent
                    // creation. The app and ordinary notifications remain usable.
                }
            }
            lastStates[host.hostId] = state
            persistLifecycle()
        }
        routeOpen()
    }

    private func content(_ state: OrbisLiveActivityState) -> ActivityContent<OrbisLiveActivityState> {
        ActivityContent(state: state, staleDate: state.phase == "stale" ? Date() : Date().addingTimeInterval(600))
    }

    private func watch(_ activity: Activity<OrbisLiveActivityAttributes>) {
        guard activity.activityState == .active || activity.activityState == .stale else { release(activity); return }
        let host = activity.attributes.hostId
        if let existing = activities[host], existing.id != activity.id {
            Task { await finish(activity, state: nil, immediate: true) }
            return
        }
        activities[host] = activity; lastStates[host] = activity.content.state
        tokenTasks[activity.id] = Task { [weak self] in
            if let token = activity.pushToken { self?.register(activity, token: token) }
            for await token in activity.pushTokenUpdates {
                guard !Task.isCancelled else { return }
                self?.register(activity, token: token)
            }
        }
        stateTasks[activity.id] = Task { [weak self] in
            for await state in activity.activityStateUpdates {
                guard let self, !Task.isCancelled else { return }
                if state == .dismissed || state == .ended {
                    self.retire(activity, state: state)
                    return
                }
            }
        }
    }

    private func register(_ activity: Activity<OrbisLiveActivityAttributes>, token: Data) {
        guard let host = store?.pairings.first(where: { $0.hostId == activity.attributes.hostId }),
              FileTransfers.pairingKey(host) == activity.attributes.pairingKey,
              activity.activityState == .active || activity.activityState == .stale else { return }
        registration.register(LiveActivityRegistrationTarget(endpoint: PushRegistrationTarget(host), activityId: activity.id),
            token: token.map { String(format: "%02x", $0) }.joined())
    }

    private func finish(_ activity: Activity<OrbisLiveActivityAttributes>, state: OrbisLiveActivityState?, immediate: Bool) async {
        lifecycle.complete(pairingKey: activity.attributes.pairingKey, activityId: activity.id)
        persistLifecycle()
        await activity.end(state.map(content), dismissalPolicy: immediate ? .immediate : .after(Date().addingTimeInterval(120)))
        release(activity)
    }

    /// Reconcile an ActivityKit terminal state that may have arrived while the
    /// app was suspended. An APNs end update is often observed later as
    /// `.dismissed`; its content phase still proves normal completion and must
    /// not be recorded as a user dismissal that suppresses the next turn.
    private func retire(_ activity: Activity<OrbisLiveActivityAttributes>, state: ActivityState?) {
        if activity.content.state.phase == "ended" || state == .ended {
            lifecycle.complete(pairingKey: activity.attributes.pairingKey, activityId: activity.id)
        } else {
            lifecycle.dismiss(pairingKey: activity.attributes.pairingKey, activityId: activity.id)
        }
        persistLifecycle()
        release(activity)
    }

    private func persistLifecycle() {
        guard savedLifecycle != lifecycle else { return }
        savedLifecycle = lifecycle
        let previous = lifecycleSave, snapshot = lifecycle
        lifecycleSave = Task.detached(priority: .utility) {
            await previous?.value
            if let data = try? JSONEncoder().encode(snapshot) { UserDefaults.standard.set(data, forKey: "orbis.liveActivityLifecycle") }
        }
    }

    private func release(_ activity: Activity<OrbisLiveActivityAttributes>) {
        tokenTasks.removeValue(forKey: activity.id)?.cancel()
        stateTasks.removeValue(forKey: activity.id)?.cancel()
        if activities[activity.attributes.hostId]?.id == activity.id { activities[activity.attributes.hostId] = nil }
        // The persisted destination retains the old credential for cleanup after
        // unpairing; it is never silently rebound to a new pairing of the same Host.
        if let host = store?.pairings.first(where: { $0.hostId == activity.attributes.hostId }),
           FileTransfers.pairingKey(host) == activity.attributes.pairingKey {
            registration.remove(LiveActivityRegistrationTarget(endpoint: PushRegistrationTarget(host), activityId: activity.id))
        }
    }
}
#endif
