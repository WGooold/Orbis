#if os(iOS) && canImport(ActivityKit)
import ActivityKit
import Combine
import Foundation

/// LIVE-ACTIVITY-02: the App owns creation, local presentation facts, and
/// token handoff. A displayed activity's business state comes only from Host APNs.
@MainActor
final class LiveActivityCoordinator: ObservableObject {
    static let shared = LiveActivityCoordinator()
    private typealias SystemActivity = Activity<OrbisLiveActivityAttributes>
    struct Navigation { let hostId: String; let runtimeId: String? }
    let navigation = CurrentValueSubject<Navigation?, Never>(nil)
    private weak var store: OrbisStore?
    private var foreground = false
    private var pairings: [String: HostPairing]?
    private var displayInputs: [LiveActivityDisplayCache.Input] = []
    private var observations: [String: AnyCancellable] = [:]
    private var runtimeObservations: [String: AnyCancellable] = [:]
    private var observedConnections: [String: ObjectIdentifier] = [:]
    private var revisions: [String: UInt64] = [:]
    private var activities: [String: SystemActivity] = [:]
    private var targets: [String: LiveActivityRegistrationTarget] = [:]
    private var tokenTasks: [String: Task<Void, Never>] = [:]
    private var stateTasks: [String: Task<Void, Never>] = [:]
    private var ending: Set<String> = []
    private var retiredSystemIDs: Set<String> = []
    private var lifecycle = UserDefaults.standard.data(forKey: "orbis.liveActivityLifecycle")
        .flatMap { try? JSONDecoder().decode(LiveActivityLifecycle.self, from: $0) } ?? LiveActivityLifecycle()
    private var lifecycleSave: Task<Void, Never>?
    private var savedLifecycle: LiveActivityLifecycle?
    private var routes: [String: [String: (runtime: String, session: String)]] = [:]
    private var routeRevisions: [String: UInt64] = [:]
    private var routeComplete: [String: Bool] = [:]
    private var openQueue = LiveActivityOpenQueue()
    private var openTimeout: Task<Void, Never>?
    private var queuedHostId: String?
    private var dirty = false
    private var reconcile: Task<Void, Never>?
    private var bootstrap: Task<Void, Never>?
    private var pairingLoadGeneration = UUID()
    private var activityUpdates: Task<Void, Never>?
    private var pushToStartUpdates: Task<Void, Never>?
    private var authorizationUpdates: Task<Void, Never>?
    private var startToken: String?
    private var claimTasks: [String: Task<Void, Never>] = [:]
    private var nextClaimAt: [String: TimeInterval] = [:]
    private var legacyRelays: Set<PushRegistrationTarget> = []
    private var deniedClaims: Set<PushRegistrationTarget> = []
    private let cache = DisplayWriter()
    private let environment = PushRegistrationEnvironment.load()
    private lazy var registration: LiveActivityRegistrationCoordinator = {
        let result = LiveActivityRegistrationCoordinator(environment: environment,
            loadKnown: { try await Task.detached { try SecureStore.shared.liveActivityRegistrations() }.value },
            saveKnown: { targets in try await Task.detached { try SecureStore.shared.saveLiveActivityRegistrations(targets) }.value })
        result.invalidated = { [weak self] target in
            guard let self, let activity = self.activities[target.endpoint.hostId], activity.id == target.activityId,
                  activity.activityState == .active || activity.activityState == .stale else { return }
            self.finish(activity, unregister: false)
        }
        return result
    }()

    /// ActivityKit can wake the App without ever activating a SwiftUI scene.
    /// Read the pairing vault off-main and adopt/hand off system activities then.
    func startMonitoring() {
        guard activityUpdates == nil else { return }
        activityUpdates = Task { [weak self] in
            for await activity in SystemActivity.activityUpdates { self?.adopt(activity) }
        }
        loadPairings()
        authorizationUpdates = Task { [weak self] in
            for await _ in ActivityAuthorizationInfo().activityEnablementUpdates {
                self?.refreshAuthorization()
            }
        }
        if #available(iOS 17.2, *) {
            startToken = SystemActivity.pushToStartToken.map(Self.tokenString)
            pushToStartUpdates = Task { [weak self] in
                for await token in SystemActivity.pushToStartTokenUpdates {
                    self?.startToken = Self.tokenString(token)
                    self?.refreshAuthorization()
                }
            }
        }
        refreshAuthorization()
    }

    func registrationNetworkAvailable() {
        guard activityUpdates != nil else { return }
        registration.refresh()
        if foreground { nextClaimAt = [:]; schedule() }
    }

    func bind(_ store: OrbisStore, foreground: Bool) {
        self.store = store
        startMonitoring()
        if pairings == nil || pairings.map({ Set($0.values) }) != Set(store.pairings) { loadPairings() }
        else { cache.setPairings(displayInputs, language: AppLocalization.shared.language.rawValue) }
        let ids = Set(store.pairings.map(\.hostId))
        for id in Array(observations.keys) where !ids.contains(id) {
            observations[id] = nil; runtimeObservations[id] = nil; observedConnections[id] = nil
            revisions[id] = nil; routes[id] = nil; routeRevisions[id] = nil; routeComplete[id] = nil
        }
        for host in store.hosts where observedConnections[host.hostId] != ObjectIdentifier(host.connection) {
            let id = host.hostId
            observedConnections[id] = ObjectIdentifier(host.connection)
            revisions[id, default: 0] &+= 1
            runtimeObservations[id] = host.connection.$runtimes.dropFirst().map { _ in () }
                .merge(with: host.connection.$connection.dropFirst().map { _ in () })
                .sink { [weak self] in self?.revisions[id, default: 0] &+= 1 }
            observations[id] = host.connection.objectWillChange.sink { [weak self] _ in self?.schedule() }
        }
        setForeground(foreground)
    }

    private func loadPairings() {
        bootstrap?.cancel()
        let generation = UUID()
        pairingLoadGeneration = generation
        bootstrap = Task { [weak self] in
            while !Task.isCancelled {
                let confirmed = await Task.detached(priority: .utility) { try? SecureStore.shared.liveActivityPairings() }.value
                guard let self, self.pairingLoadGeneration == generation, !Task.isCancelled else { return }
                if let confirmed { self.updatePairings(confirmed); self.schedule(); return }
                do { try await Task.sleep(for: .seconds(2)) } catch { return }
            }
        }
    }

    private static func pairingRef(_ pairing: HostPairing) -> String {
        OrbisLiveActivityAttributes.remotePairingRef(hostId: pairing.hostId, deviceId: pairing.relay.deviceId, credential: pairing.relay.credential)
    }

    private func updatePairings(_ values: [HostPairing]) {
        let next = Dictionary(values.map { ($0.hostId, $0) }, uniquingKeysWith: { _, newest in newest })
        if pairings != next {
            pairings = next
            displayInputs = values.map { .init(hostId: $0.hostId, name: $0.hostName,
                pairingKey: FileTransfers.pairingKey($0), pairingRef: Self.pairingRef($0)) }
            // Enqueue in pairing order, never let late refresh work bring back a
            // removed Host's titles. The serial worker is also the disk owner.
            cache.setPairings(displayInputs, language: AppLocalization.shared.language.rawValue)
            let pairedKeys = Set(displayInputs.map(\.pairingKey))
            for key in Set(lifecycle.created.keys).union(lifecycle.suppressed.keys) where !pairedKeys.contains(key) { lifecycle.forgetPairing(key) }
            deniedClaims = []; nextClaimAt = [:]
        } else {
            cache.setPairings(displayInputs, language: AppLocalization.shared.language.rawValue)
        }
        // Retain active destinations before starting Keychain orphan cleanup.
        restoreActivities()
        registration.updatePairings(values)
        for activity in activities.values {
            if let token = activity.pushToken { register(activity, token: token) }
        }
        refreshAuthorization()
    }

    func setForeground(_ value: Bool) {
        let changed = foreground != value
        foreground = value
        if !value {
            if changed { cancelQueuedOpen() }
            return
        }
        if changed {
            deniedClaims = []; nextClaimAt = [:]; legacyRelays = []
            restoreActivities(); registration.refresh(); refreshAuthorization()
        }
        routeOpen(); schedule()
    }

    private func refreshAuthorization() {
        let enabled = ActivityAuthorizationInfo().areActivitiesEnabled
        if #available(iOS 18, *) { registration.setStart(allowed: enabled, token: startToken, inputPushToken: true) }
        else if #available(iOS 17.2, *) { registration.setStart(allowed: enabled, token: startToken, inputPushToken: false) }
        else { registration.setStart(allowed: false, token: nil, inputPushToken: false) }
        if !enabled {
            for activity in Array(activities.values) { finish(activity) }
        } else { schedule() }
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
              target.pairingRef.map({ $0 == Self.pairingRef(pairing) }) ?? (target.pairingKey == FileTransfers.pairingKey(pairing)) else { cancelQueuedOpen(); return }
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
        let current = connection?.connection == .secured && routeRevisions[target.hostId] == revisions[target.hostId, default: 0]
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
                // Continuous streaming cannot delay processing indefinitely.
                do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
                guard self.foreground else { return }
                await self.refresh()
            }
        }
    }

    private func refresh() async {
        guard let store, let pairings, ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        for host in store.hosts {
            let hostId = host.hostId, connection = host.connection
            guard pairings[hostId] == host.pairing, connection.connection == .secured else { continue }
            let revision = revisions[hostId, default: 0]
            let supported = connection.runtimes.filter { runtime in
                connection.agentKind(runtime).map(LiveActivityProjection.supports) != false
            }
            let complete = connection.liveActivityInventoryComplete(supported) && !supported.contains { runtime in
                runtime.status == "idle" && runtime.backgroundTasks.map { !$0.confirmed } == true
            }
            let facts = supported.compactMap { runtime -> LiveActivityRuntimeFact? in
                guard let session = runtime.sessionId, !session.isEmpty, let kind = connection.agentKind(runtime),
                      LiveActivityProjection.supports(kind) else { return nil }
                let execution = connection.agentState.snapshots[runtime.runtimeId]?.domains["execution"]
                return LiveActivityRuntimeFact(sessionId: session, agentKind: kind, phase: runtime.status,
                    pendingCount: min(64, connection.interactions[runtime.runtimeId]?.count ?? 0),
                    startedAt: execution?.value["turn"]["startedAt"].integer,
                    backgroundAgents: LiveActivityProjection.hasBackgroundAgents(runtime.backgroundTasks),
                    title: runtime.sessionName ?? runtime.name, turnId: runtime.executionTurnId, runtimeId: runtime.runtimeId)
            }
            let hasActivity = activities[hostId] != nil
            let projected = await Task.detached(priority: .utility) {
                let keyed = facts.map { ($0, LiveActivityProjection.focusKey(hostId: hostId, agentKind: $0.agentKind, sessionId: $0.sessionId)) }
                let titles = keyed.sorted { lhs, rhs in
                    if lhs.0.isActive != rhs.0.isActive { return lhs.0.isActive }
                    return lhs.1 < rhs.1
                }.compactMap { fact, key in fact.title.map { LiveActivityDisplayCache.Title(focusKey: key, text: $0) } }
                let seed = hasActivity ? nil : LiveActivityProjection.seed(hostId: hostId, facts: facts, complete: complete,
                    now: Int64(Date().timeIntervalSince1970 * 1000))
                return (keyed, titles, seed)
            }.value
            guard foreground, self.pairings?[hostId] == host.pairing, store.connection(for: hostId) === connection,
                  connection.connection == .secured, revisions[hostId, default: 0] == revision else { continue }
            let pairingKey = FileTransfers.pairingKey(host.pairing)
            let runs = projected.0.filter { $0.0.isActive }.map { LiveActivityLifecycle.Run(focusKey: $0.1, turnId: $0.0.turnId) }
            let runKeys = lifecycle.runKeys(pairingKey: pairingKey, runs: runs, complete: complete)
            routes[hostId] = Dictionary(projected.0.compactMap { fact, key in
                fact.runtimeId.map { (key, (runtime: $0, session: fact.sessionId)) }
            }, uniquingKeysWith: { _, newest in newest })
            routeRevisions[hostId] = revision; routeComplete[hostId] = complete
            let display = cache.setTitles(projected.1, hostId: hostId, pairingRef: Self.pairingRef(host.pairing))
            if let activity = activities[hostId] {
                if complete && !runKeys.isEmpty { lifecycle.noteCreated(pairingKey: pairingKey, activityId: activity.id, runKeys: runKeys) }
            } else if lifecycle.mayStart(pairingKey: pairingKey, currentRuns: runKeys, complete: complete) {
                requestActivity(for: host.pairing, seed: projected.2, runKeys: runKeys, display: display)
            }
            persistLifecycle()
        }
        routeOpen()
    }

    private func requestActivity(for pairing: HostPairing, seed: OrbisLiveActivityState?, runKeys: Set<String>, display: Task<Void, Never>) {
        let id = pairing.hostId, target = PushRegistrationTarget(pairing)
        guard let environment, claimTasks[id] == nil, !deniedClaims.contains(target),
              ProcessInfo.processInfo.systemUptime >= nextClaimAt[id, default: 0] else { return }
        // One outstanding request per Host; do not let an unavailable Relay
        // delay the other Hosts or probe repeatedly during rapid token streaming.
        claimTasks[id] = Task { [weak self] in
            guard let self else { return }
            defer { self.claimTasks[id] = nil }
            let current = { self.foreground && self.pairings?[id] == pairing && self.activities[id] == nil && ActivityAuthorizationInfo().areActivitiesEnabled }
            guard current() else { return }
            let result: LiveActivityHTTP.ClaimResult
            if self.legacyRelays.contains(target) { result = .legacyRelay }
            else { result = await LiveActivityHTTP.claim(target, environment: environment) }
            let claim: LiveActivityClaim?
            let state: OrbisLiveActivityState
            switch result {
            case .admitted(let value): claim = value; state = value.contentState
            case .legacyRelay:
                self.legacyRelays.insert(target)
                guard let seed, seed.isValid, current(), self.store?.connection(for: id)?.connection == .secured,
                      await LiveActivityHTTP.legacyUpdatesAvailable(target, environment: environment) else { return }
                claim = nil; state = seed
            case .denied:
                self.deniedClaims.insert(target); return
            case .retry:
                self.nextClaimAt[id] = ProcessInfo.processInfo.systemUptime + 8
                // A new Host's first summary may arrive just after the query.
                // Keep one bounded foreground retry even if no new UI event arrives.
                try? await Task.sleep(for: .seconds(8)); self.schedule()
                return
            }
            await display.value
            // An ActivityKit delivery may have arrived while the HTTP request
            // was in flight. Reconcile the OS inventory before consuming a slot.
            self.restoreActivities()
            if current() {
                let attributes = OrbisLiveActivityAttributes(hostId: id, pairingRef: Self.pairingRef(pairing),
                    launchId: claim?.launchId.uuidString.lowercased())
                let expires = min(Date().addingTimeInterval(OrbisLiveActivityState.freshness),
                    Date(timeIntervalSince1970: Double(state.updatedAt) / 1000 + OrbisLiveActivityState.freshness))
                if expires > Date(), let activity = try? SystemActivity.request(attributes: attributes,
                    content: .init(state: state, staleDate: expires, relevanceScore: state.relevanceScore), pushType: .token) {
                    self.lifecycle.noteCreated(pairingKey: FileTransfers.pairingKey(pairing), activityId: activity.id, runKeys: runKeys)
                    self.persistLifecycle(); self.adopt(activity)
                    return
                }
            }
            if let claim { await LiveActivityHTTP.cancel(claim.launchId, at: target) }
            self.nextClaimAt[id] = ProcessInfo.processInfo.systemUptime + 8
        }
    }

    private func restoreActivities() {
        guard pairings != nil else { return }
        let system = SystemActivity.activities
        retiredSystemIDs.formIntersection(system.map(\.id))
        let live = Set(system.filter { $0.activityState == .active || $0.activityState == .stale }.map(\.id))
        for activity in Array(activities.values) where !live.contains(activity.id) {
            retire(activity, state: activity.activityState)
        }
        for activity in system where !live.contains(activity.id) { retire(activity, state: activity.activityState) }
        lifecycle.restore(systemActiveIds: live)
        for activity in system.sorted(by: { $0.content.state.updatedAt > $1.content.state.updatedAt }) where live.contains(activity.id) {
            adopt(activity)
        }
        persistLifecycle()
    }

    private static func tokenString(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }

    private func pairedHost(_ activity: SystemActivity) -> HostPairing? {
        let attributes = activity.attributes
        guard let pairing = pairings?[attributes.hostId],
              attributes.pairingRef.map({ $0 == Self.pairingRef(pairing) }) ?? (attributes.pairingKey == FileTransfers.pairingKey(pairing)) else { return nil }
        return pairing
    }

    private func adopt(_ activity: SystemActivity) {
        guard pairings != nil, activity.activityState == .active || activity.activityState == .stale,
              !ending.contains(activity.id) else { return }
        let attributes = activity.attributes, host = attributes.hostId
        guard let pairing = pairedHost(activity) else {
            finish(activity); return
        }
        if let existing = activities[host] {
            if existing.id == activity.id { return }
            // A stale legacy activity does not own the server-reserved slot.
            if attributes.launchId != nil && (existing.attributes.launchId == nil ||
                activity.content.state.updatedAt > existing.content.state.updatedAt) { finish(existing) }
            else { finish(activity, unregister: false); return }
        }
        let target = LiveActivityRegistrationTarget(endpoint: PushRegistrationTarget(pairing), activityId: activity.id, launchId: attributes.launchId)
        activities[host] = activity; targets[activity.id] = target
        registration.retain(target)
        let key = FileTransfers.pairingKey(pairing)
        if lifecycle.created[key]?.activityId != activity.id {
            lifecycle.noteCreated(pairingKey: key, activityId: activity.id, runKeys: [])
            persistLifecycle()
        }
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
                if state == .dismissed || state == .ended { self.retire(activity, state: state); return }
            }
        }
        schedule()
    }

    private func register(_ activity: SystemActivity, token: Data) {
        guard let target = targets[activity.id], let pairing = pairings?[target.endpoint.hostId],
              PushRegistrationTarget(pairing) == target.endpoint,
              activity.activityState == .active || activity.activityState == .stale else { return }
        registration.register(target, token: Self.tokenString(token))
    }

    // This is administrative removal (unpair, disabled, rejected/duplicate),
    // never a business outcome. Host end events alone set the five-minute card.
    private func finish(_ activity: SystemActivity, unregister: Bool = true) {
        guard ending.insert(activity.id).inserted else { return }
        retiredSystemIDs.insert(activity.id)
        if let key = lifecycleKey(activity) { lifecycle.complete(pairingKey: key, activityId: activity.id) }
        release(activity, unregister: unregister); persistLifecycle()
        Task { [weak self] in
            await activity.end(nil, dismissalPolicy: .immediate)
            self?.ending.remove(activity.id)
        }
    }

    private func lifecycleKey(_ activity: SystemActivity) -> String? {
        lifecycle.created.first { $0.value.activityId == activity.id }?.key ??
            pairings?[activity.attributes.hostId].map(FileTransfers.pairingKey)
    }

    /// iOS may omit the callback while suspended; an already delivered Host
    /// outcome still proves terminal completion, not a dismissal of this run.
    private func retire(_ activity: SystemActivity, state: ActivityState) {
        guard retiredSystemIDs.insert(activity.id).inserted else { return }
        if let key = lifecycleKey(activity) {
            if activity.content.state.phase == "ended" || state == .ended { lifecycle.complete(pairingKey: key, activityId: activity.id) }
            else { lifecycle.dismiss(pairingKey: key, activityId: activity.id) }
        }
        release(activity, unregister: true); persistLifecycle(); schedule()
    }

    private func release(_ activity: SystemActivity, unregister: Bool) {
        tokenTasks.removeValue(forKey: activity.id)?.cancel()
        stateTasks.removeValue(forKey: activity.id)?.cancel()
        if activities[activity.attributes.hostId]?.id == activity.id { activities[activity.attributes.hostId] = nil }
        let stored = targets.removeValue(forKey: activity.id)
        if unregister, let target = stored ?? pairedHost(activity).map({
            LiveActivityRegistrationTarget(endpoint: PushRegistrationTarget($0), activityId: activity.id, launchId: activity.attributes.launchId)
        }) { registration.remove(target) }
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

    /// Only the App writes the file, off the main thread. Tasks are ordered so
    /// a pairing removal wins over a header or title captured before it.
    private final class DisplayWriter: @unchecked Sendable {
        private let queue = DispatchQueue(label: "orbis.liveActivity.display", qos: .utility)
        private var url: URL?
        private lazy var snapshot = LiveActivityDisplayCache.read(from: url) ?? LiveActivityDisplayCache()
        private var saved: LiveActivityDisplayCache?
        private var inputs: [LiveActivityDisplayCache.Input]?
        func setPairings(_ inputs: [LiveActivityDisplayCache.Input], language: String) {
            queue.async {
                if self.url == nil { self.url = LiveActivityDisplayCache.sharedURL() }
                if self.inputs != inputs || self.snapshot.language != language {
                    self.snapshot.reconcile(inputs, language: language)
                    self.inputs = inputs
                }
                self.save(prioritizing: nil)
            }
        }
        func setTitles(_ titles: [LiveActivityDisplayCache.Title], hostId: String, pairingRef: String) -> Task<Void, Never> {
            // Queue the job before returning: a next pairing snapshot cannot
            // be reordered ahead of this write by Swift task scheduling.
            let done = AsyncStream<Void>.makeStream()
            queue.async {
                self.snapshot.merge(titles, hostId: hostId, pairingRef: pairingRef)
                self.save(prioritizing: hostId)
                done.continuation.finish()
            }
            return Task.detached { for await _ in done.stream {} }
        }
        private func save(prioritizing hostId: String?) {
            guard let url, snapshot != saved else { return }
            do { try snapshot.write(to: url, prioritizing: hostId); saved = snapshot }
            catch { /* Missing group/signing or pre-unlock: widget renders generic values. */ }
        }
    }
}
#endif
