import Foundation

/// LA-I01: ActivityKit tokens belong to one activity and one complete pairing.
/// They never replace the ordinary notification token.
struct LiveActivityRegistrationTarget: Codable, Hashable {
    let endpoint: PushRegistrationTarget
    let activityId: String
    var launchId: String? = nil
    // Optional for migration of the existing Keychain records. Start tokens
    // and per-activity tokens have separate workers and can never alias.
    var startInputPushToken: Bool? = nil

    func request(token: String?, environment: String?) -> URLRequest? {
        guard token == nil || ["sandbox", "production"].contains(environment ?? "") else { return nil }
        var body: [String: Any] = ["version": 1, "token": token as Any? ?? NSNull()]
        let path: String
        if let startInputPushToken {
            path = "register-start"
            if token != nil { body["inputPushToken"] = startInputPushToken; body["environment"] = environment }
        } else {
            guard !activityId.isEmpty, activityId.utf8.count <= 128 else { return nil }
            path = "register"
            body["activityId"] = activityId; body["launchId"] = launchId; body["environment"] = environment
        }
        return LiveActivityHTTP.request(endpoint, path: path, body: body)
    }
}

struct LiveActivityClaim: Decodable {
    let version: Int
    let launchId: UUID
    let contentState: OrbisLiveActivityState
}

enum LiveActivityHTTP {
    enum ClaimResult {
        case admitted(LiveActivityClaim), legacyRelay, denied, retry
    }
    static func request(_ target: PushRegistrationTarget, path: String, body: [String: Any]) -> URLRequest? {
        guard var components = URLComponents(string: target.relay.relayUrl), components.scheme == "wss",
              components.host?.isEmpty == false, components.user == nil, components.password == nil else { return nil }
        components.scheme = "https"; components.path = "/v1/live-activities/" + path
        components.query = nil; components.fragment = nil
        guard let url = components.url else { return nil }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10)
        request.httpMethod = "POST"
        request.setValue("Bearer \(target.relay.credential)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        return request
    }

    static func claim(_ target: PushRegistrationTarget, environment: String, using session: URLSession = PushRegistrationHTTP.session) async -> ClaimResult {
        guard let request = request(target, path: "claim", body: ["version": 1, "environment": environment]) else { return .denied }
        do {
            let (data, response) = try await session.data(for: request)
            switch (response as? HTTPURLResponse)?.statusCode ?? 0 {
            case 200:
                guard let claim = try? JSONDecoder().decode(LiveActivityClaim.self, from: data), claim.version == 1,
                      claim.contentState.isValid, claim.contentState.isActive else { return .denied }
                return .admitted(claim)
            case 404: return .legacyRelay
            case 0, 204, 408, 429, 500...599: return .retry
            default: return .denied
            }
        } catch { return .retry }
    }

    static func cancel(_ claim: UUID, at target: PushRegistrationTarget) async {
        guard let request = request(target, path: "claim/cancel", body: ["version": 1, "launchId": claim.uuidString.lowercased()]) else { return }
        _ = try? await PushRegistrationHTTP.send(request)
    }

    static func legacyUpdatesAvailable(_ target: PushRegistrationTarget, environment: String, using session: URLSession = PushRegistrationHTTP.session) async -> Bool {
        guard var probe = request(target, path: "config", body: [:]), let url = probe.url,
              var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return false }
        components.queryItems = [URLQueryItem(name: "environment", value: environment), URLQueryItem(name: "launch", value: "1")]
        probe.url = components.url; probe.httpMethod = "GET"; probe.httpBody = nil
        guard let (data, response) = try? await session.data(for: probe), (response as? HTTPURLResponse)?.statusCode == 200,
              let config = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
        return config["version"] as? Int == 1 && config["environment"] as? String == environment && config["launch"] == nil
    }
}

/// Persist registered destinations before writing them, so relaunch/unpair can
/// remove an orphan without persisting the APNs token itself. A worker is scoped
/// to the endpoint, serializing old activity removal and replacement registration.
@MainActor
final class LiveActivityRegistrationCoordinator {
    private struct Lane: Hashable {
        let endpoint: PushRegistrationTarget
        let start: Bool
        init(_ target: LiveActivityRegistrationTarget) { endpoint = target.endpoint; start = target.startInputPushToken != nil }
    }
    private struct Desired: Equatable { let target: LiveActivityRegistrationTarget; let token: String }
    private var pairings: Set<PushRegistrationTarget> = []
    private var inventoryConfirmed = false
    private var retained: [Lane: LiveActivityRegistrationTarget] = [:]
    private var startAllowed: Bool?
    private var startToken: String?
    private var inputPushToken = false
    private var desired: [Lane: Desired] = [:]
    private var acknowledged: [Lane: Desired] = [:]
    private var known: Set<LiveActivityRegistrationTarget> = []
    private var workers: [Lane: Task<Void, Never>] = [:]
    private var sleepers: [Lane: Task<Void, Error>] = [:]
    private var persistence: Task<Void, Error>?
    private var restore: Task<Void, Never>?
    private var loaded = false
    private var stopped = false
    private let environment: String?
    private let retryDelays: [UInt64]
    private let saveKnown: ([LiveActivityRegistrationTarget]) async throws -> Void
    private let send: (URLRequest) async throws -> Int
    private let legacyUpdatesAvailable: (PushRegistrationTarget, String) async -> Bool
    var invalidated: ((LiveActivityRegistrationTarget) -> Void)?

    init(environment: String?, retryDelays: [UInt64] = [1_000_000_000, 4_000_000_000, 15_000_000_000, 60_000_000_000],
         loadKnown: @escaping () async throws -> [LiveActivityRegistrationTarget] = { [] },
         saveKnown: @escaping ([LiveActivityRegistrationTarget]) async throws -> Void = { _ in },
         legacyUpdatesAvailable: @escaping (PushRegistrationTarget, String) async -> Bool = { await LiveActivityHTTP.legacyUpdatesAvailable($0, environment: $1) },
         send: @escaping (URLRequest) async throws -> Int = { try await PushRegistrationHTTP.send($0) }) {
        self.environment = environment; self.retryDelays = retryDelays; self.saveKnown = saveKnown; self.send = send
        self.legacyUpdatesAvailable = legacyUpdatesAvailable
        restore = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled && !self.stopped {
                do {
                    let saved = try await loadKnown()
                    self.known.formUnion(saved)
                    self.loaded = true
                    self.persist()
                    self.startAll()
                    return
                } catch {
                    do { try await Task.sleep(nanoseconds: 5_000_000_000) } catch { return }
                }
            }
        }
    }

    func updatePairings(_ values: [HostPairing]) {
        pairings = Set(values.map(PushRegistrationTarget.init))
        inventoryConfirmed = true
        for lane in Set(desired.keys).union(retained.keys) where !pairings.contains(lane.endpoint) {
            desired[lane] = nil; acknowledged[lane] = nil; retained[lane] = nil
        }
        updateStartRegistrations()
        startAll()
    }

    // While waiting for a token after a background launch, a known system
    // activity keeps its existing Relay registration until it really exits.
    func retain(_ target: LiveActivityRegistrationTarget) {
        let lane = Lane(target)
        if retained[lane] != target {
            retained[lane] = target
            desired[lane] = nil; acknowledged[lane] = nil
            sleepers[lane]?.cancel()
        }
        if target.launchId != nil && known.insert(target).inserted && loaded { persist() }
    }

    func register(_ target: LiveActivityRegistrationTarget, token: String) {
        guard pairings.contains(target.endpoint), token.range(of: "^[a-fA-F0-9]{64,1024}$", options: .regularExpression) != nil else { return }
        retain(target)
        let lane = Lane(target)
        let value = Desired(target: target, token: token)
        guard desired[lane] != value else { start(lane); return }
        desired[lane] = value
        sleepers[lane]?.cancel(); start(lane)
    }

    func setStart(allowed: Bool, token: String?, inputPushToken: Bool) {
        guard startAllowed != allowed || startToken != token || self.inputPushToken != inputPushToken else { return }
        startAllowed = allowed; startToken = token; self.inputPushToken = inputPushToken
        updateStartRegistrations()
        startAll()
    }

    private func updateStartRegistrations() {
        for endpoint in pairings {
            let target = LiveActivityRegistrationTarget(endpoint: endpoint, activityId: "", startInputPushToken: inputPushToken)
            if startAllowed == true, let startToken { register(target, token: startToken) }
            else if startAllowed == false {
                let lane = Lane(target)
                retained[lane] = nil; desired[lane] = nil; acknowledged[lane] = nil
                sleepers[lane]?.cancel()
            }
        }
    }

    func remove(_ target: LiveActivityRegistrationTarget) {
        let lane = Lane(target)
        if retained[lane] == target {
            retained[lane] = nil; desired[lane] = nil; acknowledged[lane] = nil
        }
        known.insert(target)
        if loaded { persist() }
        sleepers[lane]?.cancel(); start(lane)
    }

    func refresh() {
        acknowledged = [:]
        for endpoint in sleepers.keys { sleepers[endpoint]?.cancel() }
        startAll()
    }

    func shutdown() {
        stopped = true; restore?.cancel()
        workers.values.forEach { $0.cancel() }; sleepers.values.forEach { $0.cancel() }
    }

    private func persist() {
        let previous = persistence, snapshot = Array(known), save = saveKnown
        persistence = Task { _ = try? await previous?.value; try await save(snapshot) }
    }

    private func startAll() {
        for lane in Set(known.map(Lane.init)).union(desired.keys) { start(lane) }
    }

    private func start(_ endpoint: Lane) {
        guard loaded, inventoryConfirmed, !stopped, workers[endpoint] == nil else { return }
        workers[endpoint] = Task { [weak self] in await self?.drain(endpoint) }
    }

    private func drain(_ endpoint: Lane) async {
        defer { workers[endpoint] = nil; sleepers[endpoint] = nil }
        var attempt = 0
        while !Task.isCancelled && !stopped {
            let obsolete = known.first { target in
                guard Lane(target) == endpoint else { return false }
                if endpoint.start {
                    // Until ActivityKit reports authorization and a token, keep
                    // the previous opt-in, including on a background cold start.
                    return !pairings.contains(endpoint.endpoint) || startAllowed == false
                }
                return target != retained[endpoint]
            }
            let current = desired[endpoint]
            guard let target = obsolete ?? current?.target else { return }
            let removing = obsolete != nil
            if !removing && acknowledged[endpoint] == current { return }
            if known.insert(target).inserted { persist() }
            guard let request = target.request(token: removing ? nil : current?.token, environment: environment) else { return }
            var status = 0
            do {
                try await persistence?.value
                status = try await send(request)
                // Released Relay rejects the additional binding field. Strip it
                // only after the released config shape confirms a rollback.
                if status == 400, target.launchId != nil, let environment,
                   await legacyUpdatesAvailable(target.endpoint, environment),
                   removing || desired[endpoint] == current {
                    var unbound = target; unbound.launchId = nil
                    if let request = unbound.request(token: removing ? nil : current?.token, environment: environment) {
                        status = try await send(request)
                    }
                }
            }
            catch { persist() }
            guard !Task.isCancelled && !stopped else { return }
            if removing && ((200..<300).contains(status) || [401, 403, 404].contains(status)) {
                known.remove(target); persist(); attempt = 0; continue
            }
            if !removing && desired[endpoint] != current { attempt = 0; continue }
            if !removing && target.launchId != nil && status == 410 {
                desired[endpoint] = nil; retained[endpoint] = nil; acknowledged[endpoint] = nil
                known.remove(target); persist(); invalidated?(target)
                return
            }
            if !removing && (200..<300).contains(status) {
                acknowledged[endpoint] = current
                if endpoint.start {
                    let obsolete = known.filter { Lane($0) == endpoint && $0 != target }
                    if !obsolete.isEmpty { known.subtract(obsolete); persist() }
                }
                return
            }
            // Old Relay, revoked pairing or unsupported signing waits for foreground
            // reconciliation; a failed cleanup stays in the Keychain meanwhile.
            if (400..<500).contains(status) && ![408, 429].contains(status) { return }
            guard !retryDelays.isEmpty else { return }
            let sleeper = Task { try await Task.sleep(nanoseconds: retryDelays[min(attempt, retryDelays.count - 1)]) }
            sleepers[endpoint] = sleeper; attempt += 1
            _ = try? await sleeper.value
        }
    }
}
