import Foundation

/// LA-I01: ActivityKit tokens belong to one activity and one complete pairing.
/// They never replace the ordinary notification token.
struct LiveActivityRegistrationTarget: Codable, Hashable {
    let endpoint: PushRegistrationTarget
    let activityId: String

    func request(token: String?, environment: String?) -> URLRequest? {
        guard !activityId.isEmpty, activityId.utf8.count <= 128,
              token == nil || ["sandbox", "production"].contains(environment ?? "") else { return nil }
        guard var components = URLComponents(string: endpoint.relay.relayUrl), components.scheme == "wss",
              components.host?.isEmpty == false, components.user == nil, components.password == nil else { return nil }
        components.scheme = "https"; components.path = "/v1/live-activities/register"
        components.query = nil; components.fragment = nil
        guard let url = components.url else { return nil }
        var request = URLRequest(url: url, timeoutInterval: 10)
        request.httpMethod = "POST"
        request.setValue("Bearer \(endpoint.relay.credential)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: Any] = ["version": 1, "activityId": activityId, "token": token as Any? ?? NSNull()]
        if let environment { body["environment"] = environment }
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        return request
    }
}

/// Persist registered destinations before writing them, so relaunch/unpair can
/// remove an orphan without persisting the APNs token itself. A worker is scoped
/// to the endpoint, serializing old activity removal and replacement registration.
@MainActor
final class LiveActivityRegistrationCoordinator {
    private struct Desired: Equatable { let target: LiveActivityRegistrationTarget; let token: String }
    private var pairings: Set<PushRegistrationTarget> = []
    private var desired: [PushRegistrationTarget: Desired] = [:]
    private var acknowledged: [PushRegistrationTarget: Desired] = [:]
    private var known: Set<LiveActivityRegistrationTarget> = []
    private var workers: [PushRegistrationTarget: Task<Void, Never>] = [:]
    private var sleepers: [PushRegistrationTarget: Task<Void, Error>] = [:]
    private var persistence: Task<Void, Error>?
    private var restore: Task<Void, Never>?
    private var loaded = false
    private var stopped = false
    private let environment: String?
    private let retryDelays: [UInt64]
    private let saveKnown: ([LiveActivityRegistrationTarget]) async throws -> Void
    private let send: (URLRequest) async throws -> Int

    init(environment: String?, retryDelays: [UInt64] = [1_000_000_000, 4_000_000_000, 15_000_000_000, 60_000_000_000],
         loadKnown: @escaping () async throws -> [LiveActivityRegistrationTarget] = { [] },
         saveKnown: @escaping ([LiveActivityRegistrationTarget]) async throws -> Void = { _ in },
         send: @escaping (URLRequest) async throws -> Int = { try await PushRegistrationHTTP.send($0) }) {
        self.environment = environment; self.retryDelays = retryDelays; self.saveKnown = saveKnown; self.send = send
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
        for endpoint in Array(desired.keys) where !pairings.contains(endpoint) {
            desired[endpoint] = nil; acknowledged[endpoint] = nil
        }
        startAll()
    }

    func register(_ target: LiveActivityRegistrationTarget, token: String) {
        guard pairings.contains(target.endpoint), token.range(of: "^[a-fA-F0-9]{64,1024}$", options: .regularExpression) != nil else { return }
        let value = Desired(target: target, token: token)
        guard desired[target.endpoint] != value else { start(target.endpoint); return }
        desired[target.endpoint] = value
        sleepers[target.endpoint]?.cancel(); start(target.endpoint)
    }

    func remove(_ target: LiveActivityRegistrationTarget) {
        if desired[target.endpoint]?.target == target { desired[target.endpoint] = nil; acknowledged[target.endpoint] = nil }
        known.insert(target)
        if loaded { persist() }
        sleepers[target.endpoint]?.cancel(); start(target.endpoint)
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
        for endpoint in Set(known.map(\.endpoint)).union(desired.keys) { start(endpoint) }
    }

    private func start(_ endpoint: PushRegistrationTarget) {
        guard loaded, !stopped, workers[endpoint] == nil else { return }
        workers[endpoint] = Task { [weak self] in await self?.drain(endpoint) }
    }

    private func drain(_ endpoint: PushRegistrationTarget) async {
        defer { workers[endpoint] = nil; sleepers[endpoint] = nil }
        var attempt = 0
        while !Task.isCancelled && !stopped {
            let obsolete = known.first { $0.endpoint == endpoint && $0 != desired[endpoint]?.target }
            let current = desired[endpoint]
            guard let target = obsolete ?? current?.target else { return }
            let removing = obsolete != nil
            if !removing && acknowledged[endpoint] == current { return }
            if known.insert(target).inserted { persist() }
            guard let request = target.request(token: removing ? nil : current?.token, environment: environment) else { return }
            var status = 0
            do { try await persistence?.value; status = try await send(request) }
            catch { persist() }
            guard !Task.isCancelled && !stopped else { return }
            if removing && ((200..<300).contains(status) || [401, 403, 404].contains(status)) {
                known.remove(target); persist(); attempt = 0; continue
            }
            if !removing && desired[endpoint] != current { attempt = 0; continue }
            if !removing && (200..<300).contains(status) {
                acknowledged[endpoint] = current; return
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
