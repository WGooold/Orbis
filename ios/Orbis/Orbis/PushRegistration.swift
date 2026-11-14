import Foundation
import Combine

/// APNS-L11: retain a notification opened before SwiftUI subscribes at cold start.
@MainActor final class PushNotificationOpenQueue {
    private let pending = CurrentValueSubject<String?, Never>(nil)
    var hostId: String? { pending.value }
    var publisher: AnyPublisher<String?, Never> { pending.eraseToAnyPublisher() }
    func receive(_ userInfo: [AnyHashable: Any]) {
        guard let payload = userInfo["orbis"] as? [String: Any], payload["v"] as? Int == 1,
              let host = payload["hostId"] as? String, !host.isEmpty, host.utf8.count <= 128,
              ["task-completed", "approval-requested"].contains(payload["category"] as? String ?? "") else { return }
        pending.send(host)
    }
    func consume() { pending.send(nil) }
}

private final class PushHTTPDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

enum PushRegistrationHTTP {
    static let session = URLSession(configuration: .ephemeral, delegate: PushHTTPDelegate(), delegateQueue: nil)
    static func send(_ request: URLRequest, using session: URLSession = session) async throws -> Int {
        // APNS-L12: a new App only registers with a Relay that advertises its
        // environment; older Relays cannot safely distinguish sandbox tokens.
        let body = request.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        if body?["token"] is String {
            var capability = request
            capability.url = request.url?.deletingLastPathComponent().appendingPathComponent("config")
            capability.httpMethod = "GET"; capability.httpBody = nil
            let (data, response) = try await session.data(for: capability)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            // A successful capability response is not a successful registration.
            guard status == 200 else { return status == 0 ? 503 : (200..<400).contains(status) ? 409 : status }
            guard let config = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  config["version"] as? Int == 1, let environment = config["environment"] as? String,
                  environment == body?["environment"] as? String else { return 409 }
        }
        let (_, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        return (300..<400).contains(status) ? 409 : status
    }
}

/// APNS-L03: scope registration by the complete pairing endpoint, not Host ID.
/// Persist only pending removals in Keychain; always obtain a fresh token from iOS.
struct PushRegistrationTarget: Hashable, Codable {
    let hostId: String
    let relay: RelayCredential
    init(_ pairing: HostPairing) { hostId = pairing.hostId; relay = pairing.relay }

    func request(token: String?, environment: String) -> URLRequest? {
        guard var url = URLComponents(string: relay.relayUrl), url.scheme == "wss",
              url.host?.isEmpty == false, url.user == nil, url.password == nil else { return nil }
        url.scheme = "https"; url.path = "/v1/push/register"; url.query = nil; url.fragment = nil
        guard let endpoint = url.url else { return nil }
        var request = URLRequest(url: endpoint, timeoutInterval: 10)
        request.httpMethod = "POST"
        request.setValue("Bearer \(relay.credential)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["token": token as Any? ?? NSNull(), "environment": environment])
        return request
    }
}

@MainActor
final class PushRegistrationCoordinator {
    private struct Desired: Equatable { let revision: UUID; let token: String? }
    private struct Acknowledged { let token: String? }
    private var targets: Set<PushRegistrationTarget> = []
    private var retired: Set<PushRegistrationTarget> = []
    private var token: String?
    private var allowed: Bool?
    private var desired: [PushRegistrationTarget: Desired] = [:]
    private var acknowledged: [PushRegistrationTarget: Acknowledged] = [:]
    private var workers: [PushRegistrationTarget: Task<Void, Never>] = [:]
    private var sleeps: [PushRegistrationTarget: Task<Void, Error>] = [:]
    private var restoreTask: Task<Void, Never>?
    private var persistence: Task<Void, Error>?
    private var loaded = false
    private var stopped = false
    private let environment: String
    private let retryDelays: [UInt64]
    private let send: (URLRequest) async throws -> Int
    private let saveRetired: ([PushRegistrationTarget]) async throws -> Void

    init(environment: String, retryDelays: [UInt64] = [1_000_000_000, 4_000_000_000, 15_000_000_000, 60_000_000_000],
         loadRetired: @escaping () async throws -> [PushRegistrationTarget] = { [] },
         saveRetired: @escaping ([PushRegistrationTarget]) async throws -> Void = { _ in },
         send: @escaping (URLRequest) async throws -> Int = { try await PushRegistrationHTTP.send($0) }) {
        self.environment = environment; self.retryDelays = retryDelays
        self.saveRetired = saveRetired; self.send = send
        restoreTask = Task { [weak self] in
            guard let self else { return }
            // Keychain may be temporarily unavailable before first unlock. Retry
            // without losing pending removals or blocking the main run loop.
            while !Task.isCancelled && !self.stopped {
                do {
                    let saved = try await loadRetired()
                    for target in saved where !self.targets.contains(target) {
                        self.retired.insert(target)
                        self.desired[target] = Desired(revision: UUID(), token: nil)
                    }
                    self.loaded = true; self.persistRetired()
                    for target in self.desired.keys { self.start(target) }
                    return
                } catch {
                    do { try await Task.sleep(nanoseconds: 5_000_000_000) } catch { return }
                }
            }
        }
    }

    func updatePairings(_ pairings: [HostPairing]) {
        let next = Set(pairings.map(PushRegistrationTarget.init))
        for target in targets.subtracting(next) {
            retired.insert(target); enqueue(target, token: nil)
        }
        targets = next
        for target in next {
            retired.remove(target)
            if allowed == false { enqueue(target, token: nil) }
            else if allowed == true, let token { enqueue(target, token: token) }
        }
        if loaded { persistRetired() }
    }

    func setAuthorizationAllowed(_ value: Bool) {
        allowed = value
        if !value {
            token = nil
            for target in targets { enqueue(target, token: nil) }
        }
    }

    func receiveToken(_ value: String) {
        guard allowed == true, !value.isEmpty else { return }
        token = value
        for target in targets { enqueue(target, token: value) }
    }

    /// Reconcile after launch/foreground/connectivity recovery, including a Relay
    /// restart that lost state. Do not replay an on-disk APNs token.
    func refresh() {
        acknowledged = [:]
        for target in targets {
            if allowed == false { enqueue(target, token: nil) }
            else if allowed == true, let token { enqueue(target, token: token) }
        }
        for target in desired.keys { sleeps[target]?.cancel(); start(target) }
    }

    func shutdown() {
        stopped = true; restoreTask?.cancel()
        workers.values.forEach { $0.cancel() }; sleeps.values.forEach { $0.cancel() }
    }

    private func enqueue(_ target: PushRegistrationTarget, token: String?) {
        if let pending = desired[target], pending.token == token { start(target); return }
        if desired[target] == nil, let last = acknowledged[target], last.token == token { return }
        desired[target] = Desired(revision: UUID(), token: token)
        sleeps[target]?.cancel(); start(target)
    }

    private func persistRetired() {
        let previous = persistence, snapshot = Array(retired), save = saveRetired
        persistence = Task {
            _ = try? await previous?.value
            try await save(snapshot)
        }
    }

    private func start(_ target: PushRegistrationTarget) {
        guard loaded, !stopped, desired[target] != nil, workers[target] == nil else { return }
        workers[target] = Task { [weak self] in await self?.drain(target) }
    }

    private func drain(_ target: PushRegistrationTarget) async {
        defer { workers[target] = nil; sleeps[target] = nil }
        var attempt = 0
        while !Task.isCancelled && !stopped, let current = desired[target] {
            guard let request = target.request(token: current.token, environment: environment) else { return }
            var status = 0
            do {
                if retired.contains(target) { try await persistence?.value }
                status = try await send(request)
            } catch { }
            guard !Task.isCancelled && !stopped else { return }
            // Only one request per target is ever in flight. Finish it before
            // sending the newer intent, so a slow old retry cannot win last.
            if desired[target] != current { attempt = 0; continue }
            if (200..<300).contains(status) || current.token == nil && [401, 403].contains(status) {
                desired[target] = nil
                acknowledged[target] = Acknowledged(token: current.token)
                if retired.remove(target) != nil { persistRetired() }
                return
            }
            // Unsupported/invalid credentials and environment mismatches wait
            // for the next reconciliation instead of continuously retrying.
            if (400..<500).contains(status) && status != 408 && status != 429 { return }
            guard !retryDelays.isEmpty else { return }
            let delay = retryDelays[min(attempt, retryDelays.count - 1)]; attempt += 1
            let sleeper = Task { try await Task.sleep(nanoseconds: delay) }
            sleeps[target] = sleeper
            _ = try? await sleeper.value
            if retired.contains(target) { persistRetired() }
        }
    }
}
