import Foundation
import Testing
@testable import OrbisCore

@Suite("Transport priority and bounded delivery")
struct InboundTransportTests {
    // Moving encoding must keep legal long text admissible and reserve escaped JSON safely.
    @Test func outboundBudgetKeepsLongTextAndAccountsForJSONEscapes() throws {
        for text in [String(repeating: "a", count: 1024 * 1024), "\"\\/\n\t\u{0}\u{1F}\u{2028}\u{2029}中文🙂"] {
            let object: [String: Any] = ["type": "test", "text": text, "values": [true, NSNull(), 12]]
            let budget = OutboundJSONObject(value: object).reservation
            let original = try E2ECrypto.jsonData(object).count * 2 + 4096
            #expect(budget >= original)
            #expect(budget < original + 512)
            #expect(budget < 4 * 1024 * 1024)
        }
    }

    // A blocked encoder must leave MainActor responsive and retain per-lane FIFO nonce order.
    @Test @MainActor func outboundEncodingLeavesMainActorAvailableAndPreservesSequence() async throws {
        let gate = DispatchSemaphore(value: 0)
        let encoder = OutboundFrameEncoder(beforeEncode: {
            #expect(!Thread.isMainThread)
            Task { @MainActor in gate.signal() }
            #expect(gate.wait(timeout: .now() + 3) == .success)
        })
        let keys = SessionKeys(hostToDevice: Data(repeating: 1, count: 32), deviceToHost: Data(repeating: 2, count: 32))
        let generation = UUID()
        let receiver = E2EChannel(keys: SessionKeys(hostToDevice: keys.deviceToHost, deviceToHost: keys.hostToDevice))
        for expected in 1...2 {
            let encoded = try await encoder.encode(object: OutboundJSONObject(value: ["type": "test", "index": expected]),
                lane: "ctl", room: "h", from: "d", to: "h", keys: keys, generation: generation)
            #expect(encoded.count == 1)
            let frame = try JSONDecoder().decode(V2Frame.self, from: Data(try #require(encoded.first).utf8))
            #expect(frame.envelope.hdr.n == UInt64(expected))
            let payload = try #require(try receiver.open(frame.envelope))
            #expect(try E2ECrypto.jsonObject(payload)["index"] as? Int == expected)
        }
    }

    @Test @MainActor func decoderDoesNotOccupyMainActorAndRetainsAuthenticatedBytes() async throws {
        let gate = DispatchSemaphore(value: 0)
        let decoder = InboundFrameDecoder(beforeDecode: {
            #expect(!Thread.isMainThread)
            Task { @MainActor in gate.signal() }
            #expect(gate.wait(timeout: .now() + 3) == .success)
        })
        let keys = SessionKeys(hostToDevice: Data(repeating: 1, count: 32), deviceToHost: Data(repeating: 2, count: 32))
        let host = E2EChannel(keys: SessionKeys(hostToDevice: keys.deviceToHost, deviceToHost: keys.hostToDevice))
        let payload = try JSONSerialization.data(withJSONObject: ["type": "runtime.event", "text": String(repeating: "长历史", count: 30_000)])
        let envelope = try host.seal(room: "h", from: "h", to: "d", channel: "msg", payload: payload)
        var result: InboundFrameDecoder.Decoded?
        for piece in EnvelopePieces.fragment(envelope) {
            let data = try JSONEncoder().encode(V2Frame(type: "v2.frame", protocolVersion: orbisProtocolVersion, envelope: piece))
            result = try await decoder.decode(.data(data), hostId: "h", deviceId: "d", keys: keys, relay: true)
        }
        guard case .authenticated(let header, let bytes, let message) = result else { Issue.record("Missing decoded frame"); return }
        #expect(header.ch == "msg" && bytes == payload && message?["type"] as? String == "runtime.event")
        let repeated = try JSONEncoder().encode(V2Frame(type: "v2.frame", protocolVersion: orbisProtocolVersion, envelope: envelope))
        #expect(try await decoder.decode(.data(repeated), hostId: "h", deviceId: "d", keys: keys, relay: true) == nil)
        // Each replacement decoder starts a new receive high-water mark; old work cannot poison it.
        let replacement = InboundFrameDecoder()
        #expect(try await replacement.decode(.data(repeated), hostId: "h", deviceId: "other", keys: keys, relay: true) == nil)
        #expect(try await replacement.decode(.data(repeated), hostId: "h", deviceId: "d", keys: keys, relay: true) != nil)
    }
    @Test func priorQUICSessionCiphertextCannotPoisonNewLaneHighWatermark() async throws {
        let keys = SessionKeys(hostToDevice: Data(repeating: 1, count: 32), deviceToHost: Data(repeating: 2, count: 32))
        let oldKeys = SessionKeys(hostToDevice: Data(repeating: 3, count: 32), deviceToHost: Data(repeating: 4, count: 32))
        for lane in ["ctl", "msg", "bulk"] {
            let decoder = InboundFrameDecoder()
            let old = E2EChannel(keys: oldKeys)
            var stale: Envelope!
            for _ in 0..<3 { stale = try old.seal(room: "h", from: "h", to: "d", channel: lane, payload: Data("{}".utf8)) }
            let invalid = try JSONEncoder().encode(V2Frame(type: "v2.frame", protocolVersion: orbisProtocolVersion, envelope: stale))
            // Baseline strict decoder reproduces the cross-stream old-key failure.
            await #expect(throws: E2ECryptoError.self) {
                try await InboundFrameDecoder().decode(.data(invalid), hostId: "h", deviceId: "d", keys: keys, relay: true)
            }
            #expect(try await decoder.decode(.data(invalid), hostId: "h", deviceId: "d", keys: keys, relay: true, allowPriorSession: true) == nil)
            let host = E2EChannel(keys: SessionKeys(hostToDevice: keys.deviceToHost, deviceToHost: keys.hostToDevice))
            let fresh = try host.seal(room: "h", from: "h", to: "d", channel: lane, payload: Data("{}".utf8))
            let valid = try JSONEncoder().encode(V2Frame(type: "v2.frame", protocolVersion: orbisProtocolVersion, envelope: fresh))
            #expect(try await decoder.decode(.data(valid), hostId: "h", deviceId: "d", keys: keys, relay: true, allowPriorSession: true) != nil)
            // First authenticated frame closes the exception for this lane.
            await #expect(throws: E2ECryptoError.self) {
                try await decoder.decode(.data(invalid), hostId: "h", deviceId: "d", keys: keys, relay: true, allowPriorSession: true)
            }
        }
    }

    private func frame(_ text: String, _ channel: String?, binary: Bool = false) -> InboundFrameLanes.Frame {
        .init(payload: Data(text.utf8), channel: channel, binary: binary)
    }
    @Test func historyCatchupKeepPriorityAndShareExistingSessionBudget() {
        let lanes = InboundFrameLanes(session: .init(frames: 3, payload: 100))
        lanes.offer(frame("catchup-1", "catchup")); lanes.offer(frame("history-1", "history")); lanes.offer(frame("live", "msg"))
        #expect(lanes.take() == frame("live", "msg")); #expect(lanes.take() == frame("history-1", "history")); #expect(lanes.take() == frame("catchup-1", "catchup"))
        lanes.offer(frame("old", "catchup")); lanes.offer(frame("first", "history")); lanes.offer(frame("second", "history")); lanes.offer(frame("new", "msg"))
        #expect(lanes.drainOverflow().session == 1)
        #expect(lanes.take() == frame("new", "msg")); #expect(lanes.take() == frame("first", "history")); #expect(lanes.take() == frame("second", "history")); #expect(lanes.take() == nil)
    }

    @Test func headerChannelSetsPriorityAndBulkPreservesPayloadKind() {
        let lanes = InboundFrameLanes()
        lanes.offer(frame("binary", "bulk", binary: true))
        lanes.offer(frame("tool content", "bulk"))
        lanes.offer(frame("session patch", "msg"))
        lanes.offer(frame("command result", "ctl"))
        lanes.offer(frame("protocol error", nil))
        #expect(lanes.take() == frame("command result", "ctl"))
        #expect(lanes.take() == frame("protocol error", nil))
        #expect(lanes.take() == frame("session patch", "msg"))
        #expect(lanes.take() == frame("binary", "bulk", binary: true))
        #expect(lanes.take() == frame("tool content", "bulk"))
        #expect(lanes.take() == nil)
    }
    @Test func frameAndByteLimitsEvictOldestAndReportControlAndSessionLossOnce() {
        let lanes = InboundFrameLanes(control: .init(frames: 1, payload: 100), session: .init(frames: 10, payload: 8), bulk: .init(frames: 1, payload: 8))
        lanes.offer(frame("old result", "ctl")); lanes.offer(frame("new result", "ctl"))
        lanes.offer(frame("old-", "msg")); lanes.offer(frame("new-", "msg")); lanes.offer(frame("last", "msg"))
        lanes.offer(frame("old", "bulk", binary: true)); lanes.offer(frame("new", "bulk", binary: true))
        let loss = lanes.drainOverflow()
        #expect(loss.control == 1 && loss.session == 1)
        #expect(lanes.drainOverflow().control == 0 && lanes.drainOverflow().session == 0)
        #expect(lanes.take() == frame("new result", "ctl"))
        #expect(lanes.take() == frame("new-", "msg"))
        #expect(lanes.take() == frame("last", "msg"))
        #expect(lanes.take() == frame("new", "bulk", binary: true))
    }
    @Test func evictedBackgroundHistoryRequestsRepairButBinaryStillUsesOffsets() {
        let lanes = InboundFrameLanes(bulk: .init(frames: 1, payload: 100))
        lanes.offer(frame("history JSON", "bulk"))
        lanes.offer(frame("binary", "bulk", binary: true))
        #expect(lanes.drainOverflow().session == 1)
        lanes.offer(frame("next history", "bulk"))
        #expect(lanes.drainOverflow().session == 0)
        lanes.offer(frame("live", "msg"))
        #expect(lanes.take() == frame("live", "msg"))
        #expect(lanes.take() == frame("next history", "bulk"))
        lanes.clear()
        #expect(lanes.drainOverflow().session == 0)
    }
    @Test func consumptionAndDisconnectReturnBudgetsAndLargeSnapshotCanMakeProgress() {
        let lanes = InboundFrameLanes(session: .init(frames: 1, payload: 4))
        lanes.offer(frame("first", "msg"))
        #expect(lanes.take() == frame("first", "msg"))
        lanes.offer(frame("next", "msg"))
        #expect(lanes.drainOverflow().session == 0)
        lanes.offer(frame("large legal snapshot", "msg"))
        #expect(lanes.drainOverflow().session == 1)
        #expect(lanes.take() == frame("large legal snapshot", "msg"))
        lanes.offer(frame("one", "msg")); lanes.offer(frame("two", "msg"))
        lanes.clear()
        #expect(lanes.take() == nil)
        #expect(lanes.drainOverflow().session == 0)
    }
    @Test @MainActor func trustedLANEndpointsSupportPublicCampusAddressesAndIPv6WithoutRelayCredentials() {
        #expect(LANTransport.url(.init(host: "203.0.113.10", port: 8787))?.absoluteString == "ws://203.0.113.10:8787/v1/lan")
        #expect(LANTransport.url(.init(host: "orbis.local", port: 8787))?.absoluteString == "ws://orbis.local:8787/v1/lan")
        #expect(LANTransport.url(.init(host: "::1", port: 8787))?.absoluteString == "ws://[::1]:8787/v1/lan")
        for host in ["", " host.local", "host.local ", "host.local/route", "user@host", "host?credential=secret", "bad%20host"] {
            #expect(LANTransport.url(.init(host: host, port: 8787)) == nil)
        }
        #expect(LANTransport.url(.init(host: "127.0.0.1", port: 0)) == nil)
        #expect(LANTransport.url(.init(host: "127.0.0.1", port: 65536)) == nil)
    }
}
