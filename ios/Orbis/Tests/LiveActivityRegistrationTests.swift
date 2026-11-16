import Foundation
import XCTest
@testable import OrbisCore

@MainActor
final class LiveActivityRegistrationTests: XCTestCase {
    private let firstToken = String(repeating: "a", count: 64)
    private let nextToken = String(repeating: "b", count: 64)

    private func pairing(_ host: String = "host", relay: String = "wss://relay.example", credential: String = "credential") -> HostPairing {
        HostPairing(hostId: host, hostName: host, hostPub: "pub", pskRoot: "root",
            relay: RelayCredential(relayUrl: relay, deviceId: "device-" + host, credential: credential), lan: [])
    }
    private func target(_ activity: String = "activity", pairing: HostPairing? = nil) -> LiveActivityRegistrationTarget {
        LiveActivityRegistrationTarget(endpoint: PushRegistrationTarget(pairing ?? self.pairing()), activityId: activity)
    }
    private func body(_ request: URLRequest) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any])
    }
    private func until(_ description: String, _ predicate: () -> Bool) async throws {
        for _ in 0..<500 {
            if predicate() { return }
            try await Task.sleep(nanoseconds: 2_000_000)
        }
        XCTFail("Timed out: " + description)
        throw URLError(.timedOut)
    }

    @MainActor private final class Transport {
        var requests: [URLRequest] = []
        var gates: [Int: CheckedContinuation<Int, Never>] = [:]
        func send(_ request: URLRequest) async -> Int {
            let index = requests.count
            requests.append(request)
            return await withCheckedContinuation { gates[index] = $0 }
        }
        func finish(_ index: Int, _ status: Int = 204) { gates.removeValue(forKey: index)?.resume(returning: status) }
        func close() {
            let values = Array(gates.values); gates = [:]
            for value in values { value.resume(returning: 503) }
        }
    }

    // LA-I01: ActivityKit has its own endpoint and token lifecycle. Cleanup must
    // remain possible when signing metadata is absent, without sending credentials
    // through a redirect or using the ordinary alert-token registration path.
    func testTargetUsesDedicatedEndpointAndCleanupNeedsNoEnvironment() throws {
        let value = target()
        let request = try XCTUnwrap(value.request(token: firstToken, environment: "sandbox"))
        XCTAssertEqual(request.url?.absoluteString, "https://relay.example/v1/live-activities/register")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer credential")
        XCTAssertEqual(try body(request)["activityId"] as? String, "activity")
        XCTAssertEqual(try body(request)["version"] as? Int, 1)
        XCTAssertEqual(try body(request)["environment"] as? String, "sandbox")
        XCTAssertEqual(try body(request)["token"] as? String, firstToken)
        XCTAssertNil(value.request(token: firstToken, environment: nil))
        let remove = try XCTUnwrap(value.request(token: nil, environment: nil))
        XCTAssertTrue(try body(remove)["token"] is NSNull)
        XCTAssertNil(target(pairing: pairing(relay: "ws://relay.example")).request(token: firstToken, environment: "sandbox"))
    }

    // LA-I04: an older in-flight response cannot acknowledge a newly rotated
    // token; both intent and persistence are serialized before the newer write.
    func testTokenRotationWaitsForOldRequestAndNeverAcknowledgesTheNewTokenEarly() async throws {
        let transport = Transport()
        var persisted: [LiveActivityRegistrationTarget] = []
        let destination = target()
        let state = LiveActivityRegistrationCoordinator(environment: "sandbox", retryDelays: [],
            saveKnown: { persisted = $0 }, send: { await transport.send($0) })
        defer { state.shutdown(); transport.close() }
        state.updatePairings([pairing()])
        state.register(destination, token: firstToken)
        try await until("old token request") { transport.gates[0] != nil }
        XCTAssertTrue(persisted.contains(destination), "An orphan-cleanup record must exist before the network write")
        state.register(destination, token: nextToken)
        await Task.yield()
        XCTAssertEqual(transport.requests.count, 1)
        transport.finish(0)
        try await until("new token request") { transport.gates[1] != nil }
        XCTAssertEqual(try body(transport.requests[0])["token"] as? String, firstToken)
        XCTAssertEqual(try body(transport.requests[1])["token"] as? String, nextToken)
        XCTAssertEqual(try body(transport.requests[1])["activityId"] as? String, destination.activityId)
        transport.finish(1)
        await Task.yield()
        state.register(destination, token: nextToken)
        for _ in 0..<5 { await Task.yield() }
        XCTAssertEqual(transport.requests.count, 2)
    }

    // LA-I05: a replacement activity must not race the previous activity's
    // removal, including when replacement is requested during registration.
    func testOldActivityCleanupFinishesBeforeReplacementRegistration() async throws {
        let transport = Transport()
        let state = LiveActivityRegistrationCoordinator(environment: "sandbox", retryDelays: [], send: { await transport.send($0) })
        defer { state.shutdown(); transport.close() }
        let old = target("old"), next = target("new")
        state.updatePairings([pairing()])
        state.register(old, token: firstToken)
        try await until("old registration") { transport.gates[0] != nil }
        state.register(next, token: nextToken)
        transport.finish(0)
        try await until("old cleanup") { transport.gates[1] != nil }
        XCTAssertEqual(try body(transport.requests[1])["activityId"] as? String, "old")
        XCTAssertTrue(try body(transport.requests[1])["token"] is NSNull)
        for _ in 0..<5 { await Task.yield() }
        XCTAssertEqual(transport.requests.count, 2)
        transport.finish(1)
        try await until("replacement registration") { transport.gates[2] != nil }
        XCTAssertEqual(try body(transport.requests[2])["activityId"] as? String, "new")
        XCTAssertEqual(try body(transport.requests[2])["token"] as? String, nextToken)
        transport.finish(2)
    }

    // LA-I06: after unpairing, a failed removal stays persisted across relaunch.
    // A later process removes it with the old endpoint/credential, without ever
    // storing or replaying the previous APNs token.
    func testUnpairedOrphanCleanupSurvivesFailureAndRelaunch() async throws {
        let orphan = target()
        var disk = [orphan]
        var firstRequests: [URLRequest] = []
        let first = LiveActivityRegistrationCoordinator(environment: nil, retryDelays: [], loadKnown: { disk },
            saveKnown: { disk = $0 }, send: { firstRequests.append($0); return 503 })
        first.updatePairings([])
        try await until("failed orphan removal") { firstRequests.count == 1 }
        XCTAssertTrue(try body(firstRequests[0])["token"] is NSNull)
        XCTAssertEqual(disk, [orphan])
        first.shutdown()

        var nextRequests: [URLRequest] = []
        let next = LiveActivityRegistrationCoordinator(environment: nil, retryDelays: [], loadKnown: { disk },
            saveKnown: { disk = $0 }, send: { nextRequests.append($0); return 204 })
        defer { next.shutdown() }
        next.updatePairings([])
        try await until("relaunch cleanup persisted") { nextRequests.count == 1 && disk.isEmpty }
        XCTAssertTrue(try body(nextRequests[0])["token"] is NSNull)
        XCTAssertEqual(nextRequests[0].value(forHTTPHeaderField: "Authorization"), "Bearer credential")
    }

    // LA-I07: unsupported Relays are silent until explicit foreground/network
    // reconciliation. They must not be retried by the exponential-backoff loop.
    func testOldRelay404DoesNotEnterAutomaticRetryLoop() async throws {
        var requests: [URLRequest] = []
        let state = LiveActivityRegistrationCoordinator(environment: "production", retryDelays: [1_000_000],
            send: { requests.append($0); return 404 })
        defer { state.shutdown() }
        state.updatePairings([pairing()])
        state.register(target(), token: firstToken)
        try await until("unsupported relay response") { requests.count == 1 }
        try await Task.sleep(nanoseconds: 25_000_000)
        XCTAssertEqual(requests.count, 1)
        state.refresh()
        try await until("explicit reconciliation") { requests.count == 2 }
        try await Task.sleep(nanoseconds: 25_000_000)
        XCTAssertEqual(requests.count, 2)
    }

    // LA-I09: a temporary Keychain write failure must delay registration until
    // the cleanup record is durable, and a later retry must attempt persistence
    // again rather than permanently awaiting the same failed Task.
    func testTemporaryPersistenceFailureRecoversBeforeSendingToken() async throws {
        var saveAttempts = 0
        var disk: [LiveActivityRegistrationTarget] = []
        var requests: [URLRequest] = []
        let destination = target()
        let state = LiveActivityRegistrationCoordinator(environment: "sandbox", retryDelays: [1_000_000],
            saveKnown: { values in
                if !values.isEmpty {
                    saveAttempts += 1
                    if saveAttempts == 1 { throw URLError(.cannotWriteToFile) }
                }
                disk = values
            }, send: { request in
                XCTAssertTrue(disk.contains(destination))
                requests.append(request)
                return 204
            })
        defer { state.shutdown() }
        state.updatePairings([pairing()])
        state.register(destination, token: firstToken)
        try await until("persistence recovered before token write") { requests.count == 1 }
        XCTAssertGreaterThanOrEqual(saveAttempts, 2)
        XCTAssertTrue(disk.contains(destination))
    }

    // LA-I08: removing a pairing while a token write is in flight cannot leave
    // the completed write registered or migrate it to a replacement pairing.
    func testUnpairDuringRegistrationCleansUpInsteadOfAcknowledgingOldIntent() async throws {
        let transport = Transport()
        let state = LiveActivityRegistrationCoordinator(environment: "sandbox", retryDelays: [], send: { await transport.send($0) })
        defer { state.shutdown(); transport.close() }
        state.updatePairings([pairing()])
        state.register(target(), token: firstToken)
        try await until("in-flight registration") { transport.gates[0] != nil }
        state.updatePairings([])
        transport.finish(0)
        try await until("unpaired cleanup") { transport.gates[1] != nil }
        XCTAssertTrue(try body(transport.requests[1])["token"] is NSNull)
        transport.finish(1)
        state.register(target(), token: nextToken)
        for _ in 0..<5 { await Task.yield() }
        XCTAssertEqual(transport.requests.count, 2)
    }
}
