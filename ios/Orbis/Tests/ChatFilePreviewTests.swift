import CryptoKit
import Foundation
import Testing
@testable import OrbisCore

@Suite("FILE-PREVIEW-01") @MainActor
struct ChatFilePreviewTests {
    @MainActor private final class Peer {
        var sent: [[String: Any]] = []
        var now: Duration = .zero
        let preview: ChatFilePreview
        init() {
            var readClock: () -> Duration = { .zero }
            preview = ChatFilePreview(automaticTick: false, elapsed: { readClock() })
            readClock = { [weak self] in self?.now ?? .zero }
            preview.send = { [weak self] message in self?.sent.append(message); return true }
        }
        let reference = "orbis-message-file:test"
        func open(_ block: String = "message:block:0") {
            preview.open(.init(session: "session", block: block, source: .reference(reference), name: "report.html"))
        }
        func ready(_ command: String, transfer: String = UUID().uuidString, bytes: Data, hash: String? = nil,
                   reference override: String? = nil, size: Int? = nil) -> [String: Any] {
            ["type": "file.preview.started", "protocolVersion": orbisProtocolVersion, "runtimeId": "host", "commandId": command,
             "transferId": transfer, "referenceId": override ?? reference, "format": "html", "size": size ?? bytes.count,
             "artifactId": UUID().uuidString, "sha256": hash ?? SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()]
        }
        func authenticate(_ supported: Bool = true) { preview.authenticated(host: "host", supportsPreview: supported) }
        var command: String { sent.last?["commandId"] as? String ?? "missing" }
        var reads: [[String: Any]] { sent.filter { $0["type"] as? String == "artifact.read" } }
    }
    private func settle(_ preview: ChatFilePreview) async throws {
        for _ in 0..<100 {
            if preview.current?.phase != .loading { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        Issue.record("preview verification did not settle")
    }

    // SC116 / SC118: no prefetch, one bounded range, verify once, and reuse on page expansion.
    @Test func rangeAndFullScreenReuse() async throws {
        let peer = Peer(), preview = peer.preview
        peer.authenticate()
        #expect(peer.sent.isEmpty)
        peer.open()
        #expect((peer.sent.last?["command"] as? [String: Any])?["maxBytes"] as? Int == ChatFilePreview.maxBytes)
        let transfer = UUID().uuidString, bytes = Data(repeating: 65, count: ChatFilePreview.rangeBytes + 11)
        #expect(preview.consume(peer.ready(peer.command, transfer: transfer, bytes: bytes)))
        preview.interactive = true
        preview.tick()
        #expect(peer.reads.isEmpty)
        peer.now = .milliseconds(400)
        preview.tick(); preview.tick()
        #expect(peer.reads.count == 1)
        #expect(peer.reads[0]["length"] as? Int == ChatFilePreview.rangeBytes)
        #expect(preview.consume(.init(runtimeId: "host", transferId: transfer, offset: 0, bytes: bytes.prefix(8))))
        preview.tick()
        #expect(peer.reads.count == 1)
        #expect(preview.consume(.init(runtimeId: "host", transferId: transfer, offset: 0, bytes: bytes.prefix(ChatFilePreview.rangeBytes))))
        peer.now = .milliseconds(800)
        preview.tick()
        #expect(peer.reads.last?["offset"] as? Int == ChatFilePreview.rangeBytes)
        #expect(peer.reads.last?["length"] as? Int == 11)
        #expect(preview.consume(.init(runtimeId: "host", transferId: transfer, offset: Int64(ChatFilePreview.rangeBytes), bytes: bytes.suffix(11))))
        try await settle(preview)
        let ready = try #require(preview.current)
        #expect(ready.phase == .ready && ready.document == bytes)
        #expect(peer.sent.last?["type"] as? String == "artifact.done")
        let wireCount = peer.sent.count
        #expect(preview.setFullScreen(ready.id, true)); #expect(preview.setFullScreen(ready.id, false))
        preview.tick()
        #expect(peer.sent.count == wireCount)
    }

    // SC117 / SC120: late admission is cancelled, and a non-negotiated connection never receives maxBytes.
    @Test func cancelBeforeReadyAndDoNotFallBack() throws {
        let peer = Peer(), preview = peer.preview
        peer.authenticate(false); peer.open()
        #expect(peer.sent.isEmpty && preview.current?.phase == .failed(.unavailable))
        peer.authenticate(); peer.open()
        let retired = peer.command
        preview.close()
        peer.open("message:block:1")
        let active = peer.command
        let bytes = Data("<p>Preview</p>".utf8), transfer = UUID().uuidString
        #expect(preview.consume(peer.ready(retired, transfer: transfer, bytes: bytes)))
        #expect((peer.sent.last?["command"] as? [String: Any])?["transferId"] as? String == transfer)
        #expect(!preview.consume(.init(runtimeId: "host", transferId: transfer, offset: 0, bytes: bytes)))
        #expect(preview.current?.key.block == "message:block:1")
        preview.resetConnection(); peer.authenticate()
        let sent = peer.sent.count
        #expect(preview.consume(peer.ready(active, bytes: bytes)))
        preview.tick()
        #expect(peer.sent.count == sent && peer.reads.isEmpty && preview.current?.phase == .failed(.interrupted))
    }

    // SC118 / SC119: cancelled or invalid work cannot publish unverified bytes.
    @Test func rejectsMismatchedIdentityDigestAndRetryExhaustion() async throws {
        let peer = Peer(), preview = peer.preview
        let bytes = Data("<p>Preview</p>".utf8)
        peer.authenticate(); peer.open()
        #expect(preview.consume(peer.ready(peer.command, bytes: bytes, reference: "orbis-message-file:wrong")))
        #expect(preview.current?.phase == .failed(.unsupported) && peer.reads.isEmpty)
        peer.open()
        let bad = UUID().uuidString
        #expect(preview.consume(peer.ready(peer.command, transfer: bad, bytes: bytes, hash: String(repeating: "0", count: 64))))
        preview.tick()
        #expect(preview.consume(.init(runtimeId: "host", transferId: bad, offset: 0, bytes: bytes)))
        try await settle(preview)
        #expect(preview.current?.phase == .failed(.unsupported) && preview.current?.document == nil)
        peer.open()
        #expect(preview.consume(peer.ready(peer.command, bytes: bytes)))
        for ms in [0, 1500, 4500, 9000] { peer.now = .milliseconds(ms); preview.tick() }
        #expect(peer.reads.dropFirst().count == 3)
        #expect(preview.current?.phase == .failed(.interrupted))
        #expect(!peer.sent.contains { $0["type"] as? String == "artifact.done" })
    }
}
