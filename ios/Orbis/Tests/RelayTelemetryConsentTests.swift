import Foundation
import Testing
@testable import OrbisCore

@Suite("Relay telemetry consent endpoint")
struct RelayTelemetryConsentTests {
    @Test func mapsSecureRelayAndPreservesReverseProxyPrefix() {
        let endpoint = RelayURL.endpoint("wss://relay.example/relay/", path: "v1/device/telemetry-consent", webSocket: false)
        #expect(endpoint?.absoluteString == "https://relay.example/relay/v1/device/telemetry-consent")
    }

    @Test func localWebSocketRelayUsesLocalHttpEndpoint() {
        let endpoint = RelayURL.endpoint("ws://127.0.0.1:8787", path: "v1/device/telemetry-consent", webSocket: false)
        #expect(endpoint?.absoluteString == "http://127.0.0.1:8787/v1/device/telemetry-consent")
    }

    @Test func rejectsInsecureRemoteRelayUrls() {
        #expect(RelayURL.endpoint("ws://relay.example", path: "v1/device/telemetry-consent", webSocket: false) == nil)
    }
}
