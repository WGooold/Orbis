import Foundation
import XCTest
import Combine
#if canImport(OrbisCore)
@testable import OrbisCore
#else
@testable import Orbis
#endif

// APNS-L03–L08: run the same lifecycle assertions on macOS and in the iOS app
// test host. Synthetic transport controls completion order; no real APNs is used.
@MainActor final class PushRegistrationTests: XCTestCase {
    private func pairing(_ host: String = "host", credential: String = "credential", relay: String = "wss://relay.example") -> HostPairing {
        HostPairing(hostId: host, hostName: host, hostPub: "pub", pskRoot: "root",
            relay: RelayCredential(relayUrl: relay, deviceId: "device-" + host, credential: credential), lan: [])
    }
    private func until(_ label: String, _ condition: () -> Bool) async throws {
        for _ in 0..<500 {
            if condition() { return }
            try await Task.sleep(nanoseconds: 2_000_000)
        }
        XCTFail("Timed out: " + label); throw URLError(.timedOut)
    }
    private func token(_ request: URLRequest) -> String? {
        (try? JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: Any])?["token"] as? String
    }

    func testFreshInstallAndRelaunchWaitForAPNsInsteadOfReusingStoredToken() async throws {
        var requests: [URLRequest] = []
        let state = PushRegistrationCoordinator(environment: "production", send: { requests.append($0); return 204 })
        defer { state.shutdown() }
        state.updatePairings([pairing()]); state.setAuthorizationAllowed(true)
        state.refresh(); await Task.yield()
        XCTAssertTrue(requests.isEmpty)
        state.receiveToken("fresh-after-reinstall")
        try await until("fresh token registration") { requests.count == 1 }
        XCTAssertEqual(token(requests[0]), "fresh-after-reinstall")
    }

    func testAddingRemovingAndReplacingPairingsWhileOneRemains() async throws {
        var requests: [URLRequest] = []
        let state = PushRegistrationCoordinator(environment: "production", send: { requests.append($0); return 204 })
        defer { state.shutdown() }
        state.updatePairings([pairing()]); state.setAuthorizationAllowed(true); state.receiveToken("token")
        try await until("first pairing") { requests.count == 1 }
        state.updatePairings([pairing(), pairing("second")])
        try await until("second pairing without empty transition") { requests.count == 2 }
        state.updatePairings([pairing("second")])
        try await until("first pairing removed") { requests.count == 3 }
        XCTAssertNil(token(requests[2]))
        state.updatePairings([pairing("second", credential: "new-credential", relay: "wss://new.example")])
        try await until("same Host new relay") { requests.count == 5 }
        XCTAssertEqual(Set(requests.suffix(2).map { $0.url!.host! }), ["relay.example", "new.example"])
        XCTAssertEqual(token(requests.first { $0.url!.host! == "new.example" }!), "token")
    }

    func testRevokingPermissionRemovesTokensAndIgnoresLateAPNsCallback() async throws {
        var requests: [URLRequest] = []
        let state = PushRegistrationCoordinator(environment: "production", send: { requests.append($0); return 204 })
        defer { state.shutdown() }
        state.updatePairings([pairing()]); state.setAuthorizationAllowed(true); state.receiveToken("old")
        try await until("initial") { requests.count == 1 }
        state.setAuthorizationAllowed(false); state.receiveToken("late")
        try await until("permission removal") { requests.count == 2 }
        XCTAssertNil(token(requests[1]))
        state.setAuthorizationAllowed(true)
        await Task.yield(); XCTAssertEqual(requests.count, 2)
        state.receiveToken("new")
        try await until("permission restored") { requests.count == 3 }
        XCTAssertEqual(token(requests[2]), "new")
    }

    func testDeniedPermissionOnRelaunchUnregistersEvenWithoutAnAPNsToken() async throws {
        var requests: [URLRequest] = []
        let state = PushRegistrationCoordinator(environment: "production", send: { requests.append($0); return 204 })
        defer { state.shutdown() }
        state.updatePairings([pairing()]); state.setAuthorizationAllowed(false)
        try await until("remove previous install token") { requests.count == 1 }
        XCTAssertNil(token(requests[0]))
    }

    func testSlowOldRegistrationCannotWinAfterRotationAndUnpair() async throws {
        var requests: [URLRequest] = [], completion: CheckedContinuation<Int, Never>?
        let state = PushRegistrationCoordinator(environment: "production", send: { request in
            requests.append(request)
            if requests.count == 1 { return await withCheckedContinuation { completion = $0 } }
            return 204
        })
        defer { state.shutdown() }
        state.updatePairings([pairing()]); state.setAuthorizationAllowed(true); state.receiveToken("old")
        try await until("old request in flight") { completion != nil }
        state.receiveToken("new"); state.updatePairings([])
        await Task.yield(); XCTAssertEqual(requests.count, 1)
        completion?.resume(returning: 503)
        try await until("unregister follows old completion") { requests.count == 2 }
        XCTAssertNil(token(requests[1]))
    }

    func testOfflineRemovalSurvivesProcessRestartWithoutPersistingToken() async throws {
        var retired: [PushRegistrationTarget] = []
        var firstRequests = 0
        let first = PushRegistrationCoordinator(environment: "production", retryDelays: [],
            saveRetired: { retired = $0 }, send: { _ in firstRequests += 1; return 503 })
        first.updatePairings([pairing()]); first.updatePairings([])
        try await until("durable offline removal") { firstRequests == 1 && retired.count == 1 }
        first.shutdown()
        var requests: [URLRequest] = []
        let second = PushRegistrationCoordinator(environment: "production", loadRetired: { retired },
            saveRetired: { retired = $0 }, send: { requests.append($0); return 204 })
        defer { second.shutdown() }
        try await until("recovered removal acknowledged") { requests.count == 1 && retired.isEmpty }
        XCTAssertNil(token(requests[0]))
    }

    func testReaddingPairingWhileRemovalIsInFlightRegistersLast() async throws {
        var requests: [URLRequest] = [], completion: CheckedContinuation<Int, Never>?
        let state = PushRegistrationCoordinator(environment: "production", send: { request in
            requests.append(request)
            if requests.count == 2 { return await withCheckedContinuation { completion = $0 } }
            return 204
        })
        defer { state.shutdown() }
        state.updatePairings([pairing()]); state.setAuthorizationAllowed(true); state.receiveToken("token")
        try await until("initial") { requests.count == 1 }
        state.updatePairings([])
        try await until("removal in flight") { completion != nil }
        state.updatePairings([pairing()]); completion?.resume(returning: 204)
        try await until("re-added pairing") { requests.count == 3 }
        XCTAssertEqual(token(requests[2]), "token")
    }

    func testTransientFailureRetriesAndForegroundRepairsRelayStateLoss() async throws {
        var requests: [URLRequest] = []
        let state = PushRegistrationCoordinator(environment: "production", retryDelays: [1_000_000], send: {
            requests.append($0); return requests.count == 1 ? 503 : 204
        })
        defer { state.shutdown() }
        state.updatePairings([pairing()]); state.setAuthorizationAllowed(true); state.receiveToken("token")
        try await until("retry") { requests.count == 2 }
        state.refresh()
        try await until("foreground reconciliation") { requests.count == 3 }
        XCTAssertEqual(requests.compactMap(token), ["token", "token", "token"])
    }

    func testUnsupportedOldRelayAndEnvironmentMismatchDoNotBusyRetry() async throws {
        for status in [404, 409] {
            var count = 0
            let state = PushRegistrationCoordinator(environment: "sandbox", retryDelays: [1_000_000], send: { _ in count += 1; return status })
            state.updatePairings([pairing()]); state.setAuthorizationAllowed(true); state.receiveToken("token")
            try await until("unsupported response") { count == 1 }
            try await Task.sleep(nanoseconds: 10_000_000)
            XCTAssertEqual(count, 1)
            state.refresh(); try await until("explicit recovery") { count == 2 }
            state.shutdown()
        }
    }

    func testHTTPSOnlyAndCorrectEnvironmentWithoutURLSecrets() throws {
        XCTAssertNil(PushRegistrationTarget(pairing(relay: "ws://relay.example")).request(token: "token", environment: "sandbox"))
        XCTAssertNil(PushRegistrationTarget(pairing(relay: "wss://user:pass@relay.example")).request(token: "token", environment: "sandbox"))
        let request = try XCTUnwrap(PushRegistrationTarget(pairing(relay: "wss://relay.example?query=private#fragment"))
            .request(token: "token", environment: "sandbox"))
        XCTAssertEqual(request.url!.absoluteString, "https://relay.example/v1/push/register")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer credential")
        let body = try JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as! [String: String]
        XCTAssertEqual(body["environment"], "sandbox")
    }

    // APNS-L11: delivery before subscription survives, and consuming inside the
    // subscriber does not leave a stale Host for the next view subscription.
    func testColdOpenValidationAndSynchronousConsumption() {
        let queue = PushNotificationOpenQueue()
        queue.receive(["orbis": ["v": 1, "hostId": "host", "category": "task-completed"]])
        var opened: [String] = []
        let subscription = queue.publisher.sink { host in
            if let host { opened.append(host); queue.consume() }
        }
        XCTAssertEqual(opened, ["host"])
        XCTAssertNil(queue.hostId)
        queue.receive(["orbis": ["v": 2, "hostId": "wrong", "category": "task-completed"]])
        queue.receive(["orbis": ["v": 1, "hostId": "wrong", "category": "unknown"]])
        XCTAssertEqual(opened, ["host"])
        subscription.cancel()
    }

    // APNS-L12: test the actual capability gate and request sequence, including
    // unexpected success statuses that must not masquerade as registration.
    func testCapabilityMustMatchBeforeTokenUpload() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [PushHTTPFixture.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let request = try XCTUnwrap(PushRegistrationTarget(pairing()).request(token: "token", environment: "production"))
        for (status, config, expected, count) in [
            (200, "{\"version\":1,\"environment\":\"production\"}", 204, 2),
            (200, "{\"version\":1,\"environment\":\"sandbox\"}", 409, 1),
            (200, "{\"version\":2,\"environment\":\"production\"}", 409, 1),
            (200, "invalid-json", 409, 1), (201, "", 409, 1), (204, "", 409, 1),
            (404, "", 404, 1), (503, "", 503, 1)
        ] {
            PushHTTPFixture.configure(status: status, data: config)
            let result = try await PushRegistrationHTTP.send(request, using: session)
            XCTAssertEqual(result, expected)
            let requests = PushHTTPFixture.requests
            XCTAssertEqual(requests.count, count)
            XCTAssertEqual(requests.first?.url?.path, "/v1/push/config")
            XCTAssertEqual(requests.first?.httpMethod, "GET")
            XCTAssertEqual(requests.first?.value(forHTTPHeaderField: "Authorization"), "Bearer credential")
            if count == 2 {
                XCTAssertEqual(requests.last?.url?.path, "/v1/push/register")
                XCTAssertEqual(requests.last?.httpMethod, "POST")
            }
        }
    }

    func testRemovalBypassesUnavailableCapabilityAndRedirectIsRefused() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [PushHTTPFixture.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        PushHTTPFixture.configure(status: 503, data: "")
        let request = try XCTUnwrap(PushRegistrationTarget(pairing()).request(token: nil, environment: "production"))
        let status = try await PushRegistrationHTTP.send(request, using: session)
        XCTAssertEqual(status, 204)
        XCTAssertEqual(PushHTTPFixture.requests.map { $0.url!.path }, ["/v1/push/register"])
        let production = PushRegistrationHTTP.session
        let delegate = try XCTUnwrap(production.delegate as? URLSessionTaskDelegate)
        let response = try XCTUnwrap(HTTPURLResponse(url: request.url!, statusCode: 307, httpVersion: nil, headerFields: nil))
        var followed = true
        let task = production.dataTask(with: request)
        delegate.urlSession?(production, task: task, willPerformHTTPRedirection: response,
            newRequest: URLRequest(url: URL(string: "https://other.example")!), completionHandler: { followed = $0 != nil })
        XCTAssertFalse(followed)
        task.cancel()
    }

    // APNS-L14: the isolated compatibility runner starts the actual v0.1.19
    // and candidate Relay sources and passes loopback URLs to this real client.
    func testRealPreviousReleaseRelayCompatibilityWhenFixtureProvided() async throws {
        guard let old = ProcessInfo.processInfo.environment["ORBIS_PUSH_COMPAT_OLD"],
              let candidate = ProcessInfo.processInfo.environment["ORBIS_PUSH_COMPAT_NEW"] else {
            throw XCTSkip("Run via apns-lifecycle compatibility fixture")
        }
        let token = String(repeating: "c", count: 64)
        var request = try XCTUnwrap(PushRegistrationTarget(pairing(credential: "compat-phone-secret"))
            .request(token: token, environment: "production"))
        request.url = URL(string: old + "/v1/push/register")
        var status = try await PushRegistrationHTTP.send(request)
        XCTAssertEqual(status, 404)
        request.url = URL(string: candidate + "/v1/push/register")
        status = try await PushRegistrationHTTP.send(request)
        XCTAssertEqual(status, 204)
        request.httpBody = try JSONSerialization.data(withJSONObject: ["token": token, "environment": "sandbox"])
        status = try await PushRegistrationHTTP.send(request)
        XCTAssertEqual(status, 409)
        // Reconnecting after an upgrade/revert renegotiates every time.
        request.url = URL(string: old + "/v1/push/register")
        status = try await PushRegistrationHTTP.send(request)
        XCTAssertEqual(status, 404)
    }
}

private final class PushHTTPFixture: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    private static var status = 200
    private static var data = Data()
    private static var recorded: [URLRequest] = []
    static var requests: [URLRequest] { lock.lock(); defer { lock.unlock() }; return recorded }
    static func configure(status: Int, data: String) {
        lock.lock(); defer { lock.unlock() }
        self.status = status; self.data = Data(data.utf8); recorded = []
    }
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "relay.example" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock()
        Self.recorded.append(request)
        let capability = request.url?.path == "/v1/push/config"
        let status = capability ? Self.status : 204, data = capability ? Self.data : Data()
        Self.lock.unlock()
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() { }
}
