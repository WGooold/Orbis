import Foundation
import Testing
@testable import OrbisCore

@Suite("Transport priority and bounded delivery")
struct InboundTransportTests {
    private func frame(_ text: String, _ channel: String?, binary: Bool = false) -> InboundFrameLanes.Frame {
        .init(payload: Data(text.utf8), channel: channel, binary: binary)
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
