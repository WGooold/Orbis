import Compression
import CryptoKit
import Foundation
import Testing
@testable import OrbisCore

@Suite("FILE-PREVIEW-03") @MainActor
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
        func key(_ name: String = "report.html", block: String = "message:block:0", session: String = "session") -> ChatFilePreview.Key {
            .init(session: session, block: block, source: .reference(reference), name: name)
        }
        func open(_ name: String = "report.html", block: String = "message:block:0", session: String = "session") {
            preview.open(key(name, block: block, session: session))
        }
        func authenticate(web: Bool = true, native: Bool = true) { preview.authenticated(host: "host", supportsWeb: web, supportsNative: native) }
        var commands: [[String: Any]] { sent.filter { $0["type"] as? String == "runtime.command" } }
        var lastCommand: [String: Any] { commands.last?["command"] as? [String: Any] ?? [:] }
        var commandID: String { commands.last?["commandId"] as? String ?? "missing" }
        var web: [String: Any] { lastCommand["web"] as? [String: Any] ?? [:] }
        var reads: [[String: Any]] { sent.filter { $0["type"] as? String == "artifact.read" } }
        var cancels: [String] { commands.compactMap { ($0["command"] as? [String: Any]).flatMap { $0["type"] as? String == "artifact.cancel" ? $0["transferId"] as? String : nil } } }
        func started(_ command: String, transfer: String, body: Data, sent wire: Data? = nil, resource: String = "report.html",
                     mime: String = "text/html; charset=utf-8", notModified: Bool = false, hash: String? = nil) -> [String: Any] {
            var reply: [String: Any] = ["type": "file.preview.started", "protocolVersion": orbisProtocolVersion, "runtimeId": "host",
                "commandId": command, "transferId": transfer, "referenceId": reference, "artifactId": UUID().uuidString, "format": "web",
                "size": (wire ?? body).count, "contentSize": body.count, "encoding": wire == nil ? "identity" : "deflate-raw",
                "mimeType": mime, "resource": resource, "sha256": hash ?? digest(body)]
            if notModified { reply["notModified"] = true }
            return reply
        }
        func chunk(_ transfer: String, _ offset: Int, _ bytes: Data) -> ArtifactChunk {
            .init(runtimeId: "host", transferId: transfer, offset: Int64(offset), bytes: bytes)
        }
    }
    private static func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    private func digest(_ data: Data) -> String { Self.digest(data) }
    private func deflate(_ data: Data) -> Data {
        var output = Data(count: data.count + 1024)
        let count = output.withUnsafeMutableBytes { destination in
            data.withUnsafeBytes { source in
                compression_encode_buffer(destination.bindMemory(to: UInt8.self).baseAddress!, data.count + 1024,
                                          source.bindMemory(to: UInt8.self).baseAddress!, data.count, nil, COMPRESSION_ZLIB)
            }
        }
        output.count = count
        return output
    }
    private func settle(_ preview: ChatFilePreview) async throws {
        for _ in 0..<200 {
            if preview.current?.phase != .loading { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        Issue.record("preview verification did not settle")
    }
    private func page(_ count: Int) -> Data {
        var bytes = Data("<!doctype html><script>document.title='x'</script>".utf8)
        while bytes.count < count { bytes.append(contentsOf: (0..<64).map { _ in UInt8.random(in: 97...122) }) }
        return bytes.prefix(count)
    }

    @Test func markdownPreviewUsesTheExistingTextWireFormat() throws {
        let format = try #require(ChatFilePreview.Format(fileName: "Release-Notes.MD"))
        #expect(format == .markdown)
        #expect(format.wireValue == "text")
        #expect(ChatFilePreview.Source.reference("orbis-message-file:test").command(format: format)["previewFormat"] as? String == "text")
        #expect(format.budget == 256 * 1024)
        #expect(format.matchesBytes(Data("# Release notes\n".utf8)))
        #expect(!format.matchesBytes(Data([0x23, 0x00])))
    }

    // SC124 / SC126: the range sent with the reply may arrive first; the rest is pulled through a window
    // that narrows while the chat is busy, and the original page becomes the card's entry once verified.
    @Test func entryUsesThePushedRangeAndABoundedWindow() async throws {
        let peer = Peer(), preview = peer.preview
        peer.authenticate()
        #expect(peer.sent.isEmpty)
        peer.open()
        #expect(peer.lastCommand["maxBytes"] == nil && peer.lastCommand["previewFormat"] == nil)
        let transfer = try #require(peer.web["transferId"] as? String)
        #expect(peer.web["page"] is String && peer.web["resource"] == nil && peer.web["ifNoneMatch"] == nil)
        let body = page(ChatFilePreview.rangeBytes * 2 + 100)
        #expect(preview.consume(peer.chunk(transfer, 0, body.prefix(ChatFilePreview.rangeBytes))))
        preview.interactive = true
        #expect(preview.consume(peer.started(peer.commandID, transfer: transfer, body: body)))
        #expect(peer.reads.count == 1)
        #expect(peer.reads[0]["offset"] as? Int == ChatFilePreview.rangeBytes)
        #expect(preview.current?.progress == .init(received: ChatFilePreview.rangeBytes, total: body.count))
        preview.interactive = false
        #expect(preview.consume(peer.chunk(transfer, ChatFilePreview.rangeBytes, body.subdata(in: ChatFilePreview.rangeBytes..<2 * ChatFilePreview.rangeBytes))))
        #expect(peer.reads.count == 2 && peer.reads[1]["length"] as? Int == 100)
        #expect(preview.consume(peer.chunk(transfer, 2 * ChatFilePreview.rangeBytes, body.suffix(100))))
        try await settle(preview)
        let ready = try #require(preview.current)
        #expect(ready.phase == .ready && ready.entry?.body == body && ready.entry?.path == "report.html" && ready.document == nil)
        #expect(peer.sent.last?["type"] as? String == "artifact.done")
        #expect(preview.knownSize(.reference(peer.reference)) == body.count)
        let wire = peer.sent.count
        #expect(preview.setFullScreen(ready.id, true)); #expect(preview.setFullScreen(ready.id, false))
        #expect(preview.current?.entry?.body == body && peer.sent.count == wire)
    }

    // SC126: compressed bodies decode to exactly the declared length and digest; anything else is never shown.
    @Test func compressedBodiesAreCheckedAfterDecoding() async throws {
        let peer = Peer(), preview = peer.preview
        let body = Data(String(repeating: "<p>row</p>\n", count: 20_000).utf8)
        let wire = deflate(body)
        #expect(wire.count < body.count / 10)
        #expect(ChatFilePreview.inflate(wire, expected: body.count) == body)
        #expect(ChatFilePreview.inflate(wire, expected: body.count - 1) == nil)
        #expect(ChatFilePreview.inflate(wire, expected: body.count + 1) == nil)
        peer.authenticate(); peer.open()
        var transfer = try #require(peer.web["transferId"] as? String)
        #expect(preview.consume(peer.started(peer.commandID, transfer: transfer, body: body, sent: wire)))
        #expect(preview.consume(peer.chunk(transfer, 0, wire)))
        try await settle(preview)
        #expect(preview.current?.phase == .ready && preview.current?.entry?.body == body)
        peer.open(block: "other")
        transfer = try #require(peer.web["transferId"] as? String)
        #expect(preview.consume(peer.started(peer.commandID, transfer: transfer, body: body, sent: wire, hash: String(repeating: "0", count: 64))))
        #expect(preview.consume(peer.chunk(transfer, 0, wire)))
        try await settle(preview)
        #expect(preview.current?.phase == .failed(.unsupported) && preview.current?.entry == nil)
    }

    // SC125 / SC126: files are fetched only when the page asks, once per path, at most four at a time,
    // and reopening revalidates by digest instead of downloading again.
    @Test func pageFilesAreFetchedOnDemandAndRevalidated() async throws {
        let peer = Peer(), preview = peer.preview
        peer.authenticate(); peer.open()
        let entry = page(400), css = Data("p{color:red}".utf8)
        var transfer = try #require(peer.web["transferId"] as? String)
        #expect(preview.consume(peer.started(peer.commandID, transfer: transfer, body: entry)))
        #expect(preview.consume(peer.chunk(transfer, 0, entry)))
        try await settle(preview)
        let id = try #require(preview.current?.id)
        var results: [Result<ChatFilePreview.WebResource, ChatFilePreview.Failure>] = []
        preview.resource(id, path: "/report.html") { results.append($0) }
        #expect(try results.last?.get().body == entry)
        let before = peer.commands.count
        preview.resource(id, path: "/style.css") { results.append($0) }
        preview.resource(id, path: "style.css") { results.append($0) }
        #expect(peer.commands.count == before + 1 && peer.web["resource"] as? String == "style.css")
        transfer = try #require(peer.web["transferId"] as? String)
        #expect(preview.consume(peer.started(peer.commandID, transfer: transfer, body: css, resource: "style.css", mime: "text/css; charset=utf-8")))
        #expect(preview.consume(peer.chunk(transfer, 0, css)))
        for _ in 0..<200 where results.count < 3 { try await Task.sleep(for: .milliseconds(10)) }
        #expect(results.count == 3 && results.dropFirst().allSatisfy { (try? $0.get().body) == css })
        for index in 0..<6 { preview.resource(id, path: "image\(index).png") { results.append($0) } }
        #expect(peer.commands.count == before + 1 + ChatFilePreview.concurrentFetches)

        // Reopen: both the entry and the stylesheet are revalidated, not resent.
        peer.open()
        #expect(peer.web["ifNoneMatch"] as? String == digest(entry))
        transfer = try #require(peer.web["transferId"] as? String)
        let reads = peer.reads.count
        #expect(preview.consume(peer.started(peer.commandID, transfer: transfer, body: entry, notModified: true)))
        #expect(preview.current?.phase == .ready && preview.current?.entry?.body == entry && peer.reads.count == reads)
        let reopened = try #require(preview.current?.id)
        var cached: Data?
        preview.resource(reopened, path: "style.css") { cached = try? $0.get().body }
        #expect(peer.web["ifNoneMatch"] as? String == digest(css))
        #expect(preview.consume(peer.started(peer.commandID, transfer: try #require(peer.web["transferId"] as? String), body: css,
                                             resource: "style.css", mime: "text/css; charset=utf-8", notModified: true)))
        #expect(cached == css && peer.reads.count == reads)
    }

    // SC127: closing cancels every response the page owns, including ones the Host has not acknowledged;
    // late replies are cancelled again and late ranges never reach a card or a download.
    @Test func closingCancelsOwnedTransfersAndIgnoresLateData() throws {
        let peer = Peer(), preview = peer.preview
        peer.authenticate(); peer.open()
        let retired = peer.commandID
        let transfer = try #require(peer.web["transferId"] as? String)
        preview.close()
        #expect(peer.cancels == [transfer])
        peer.open(block: "message:block:1")
        let body = page(200)
        #expect(preview.consume(peer.started(retired, transfer: transfer, body: body)))
        #expect(peer.cancels == [transfer, transfer])
        #expect(preview.consume(peer.chunk(transfer, 0, body)))
        #expect(preview.current?.key.block == "message:block:1" && preview.current?.phase == .loading)
        #expect(!preview.consume(peer.chunk(UUID().uuidString, 0, body)))
    }

    // SC117: loading stops when the card leaves the viewport or the link drops; a verified page stays readable.
    @Test func loadingStopsButAVerifiedPageSurvivesReconnection() async throws {
        let peer = Peer(), preview = peer.preview
        peer.authenticate(); peer.open()
        let loading = try #require(preview.current)
        preview.fileHidden(loading.key, id: loading.id)
        #expect(preview.current?.phase == .failed(.interrupted) && peer.cancels.count == 1)
        peer.open()
        let transfer = try #require(peer.web["transferId"] as? String)
        let body = page(300)
        #expect(preview.consume(peer.started(peer.commandID, transfer: transfer, body: body)))
        #expect(preview.consume(peer.chunk(transfer, 0, body)))
        try await settle(preview)
        let ready = try #require(preview.current)
        var pending: ChatFilePreview.Failure?
        preview.resource(ready.id, path: "slow.css") { if case .failure(let reason) = $0 { pending = reason } }
        preview.fileHidden(ready.key, id: ready.id)
        preview.resetConnection()
        #expect(pending == .interrupted)
        #expect(preview.current?.phase == .ready && preview.current?.entry?.body == body)
        peer.open(block: "next")
        preview.resetConnection()
        #expect(preview.current?.phase == .failed(.interrupted))
    }

    // SC117: a mounted page can disappear after a new session selects its own preview.
    @Test func staleSessionTeardownCannotCloseTheCurrentPreview() throws {
        let peer = Peer(), preview = peer.preview
        peer.authenticate(); peer.open(session: "first")
        peer.open(session: "second")
        let current = try #require(preview.current)
        let sent = peer.sent.count
        preview.closeSession("first")
        #expect(preview.current == current && peer.sent.count == sent)
        preview.closeSession("second")
        #expect(preview.current == nil)
    }

    // SC120 / SC127: a Host without the path keeps the card a download; failures map to their reason;
    // a stalled range is retried a bounded number of times.
    @Test func capabilityFailureReasonsAndBoundedRetry() async throws {
        let peer = Peer(), preview = peer.preview
        peer.authenticate(web: false)
        #expect(!preview.offersPreview("report.html") && preview.offersPreview("notes.txt"))
        peer.open()
        #expect(peer.sent.isEmpty && preview.current?.phase == .failed(.unavailable))
        peer.authenticate()
        peer.open()
        #expect(preview.consume(["type": "file.preview.failed", "protocolVersion": orbisProtocolVersion, "runtimeId": "host",
                                 "commandId": peer.commandID, "reason": "too_large"]))
        #expect(preview.current?.phase == .failed(.tooLarge))
        peer.open()
        let transfer = try #require(peer.web["transferId"] as? String)
        let body = page(ChatFilePreview.rangeBytes + 10)
        #expect(preview.consume(peer.started(peer.commandID, transfer: transfer, body: body)))
        #expect(preview.consume(peer.chunk(transfer, 0, body.prefix(ChatFilePreview.rangeBytes))))
        #expect(peer.reads.count == 1)
        for seconds in [3, 9, 21, 45, 93] { peer.now = .seconds(seconds); preview.tick() }
        #expect(peer.reads.count == 4)
        #expect(preview.current?.phase == .failed(.interrupted))
        #expect(!peer.sent.contains { $0["type"] as? String == "artifact.done" })
    }

    // SC122 / SC120: native limits require their own capability and video opens only after verification.
    @Test func nativePreviewNeedsV2AndChecksContentBeforeOpeningVideo() async throws {
        let peer = Peer(), preview = peer.preview
        let key = peer.key("clip.MP4", block: "clip")
        peer.authenticate(native: false)
        preview.open(key)
        #expect(peer.sent.isEmpty && preview.current?.phase == .failed(.unavailable))
        peer.authenticate()
        preview.open(key)
        #expect(peer.lastCommand["previewFormat"] as? String == "mp4")
        #expect(peer.lastCommand["maxBytes"] as? Int == 16 * 1024 * 1024 && peer.lastCommand["web"] == nil)
        func ready(_ bytes: Data, transfer: String) -> [String: Any] {
            ["type": "file.preview.started", "protocolVersion": orbisProtocolVersion, "runtimeId": "host", "commandId": peer.commandID,
             "transferId": transfer, "referenceId": peer.reference, "format": "mp4", "size": bytes.count,
             "artifactId": UUID().uuidString, "sha256": digest(bytes)]
        }
        let fake = Data("fakeMp4Bytes".utf8), first = UUID().uuidString
        #expect(preview.consume(ready(fake, transfer: first)))
        #expect(peer.reads.count == 1 && peer.reads[0]["offset"] as? Int == 0)
        #expect(preview.consume(peer.chunk(first, 0, fake)))
        try await settle(preview)
        #expect(preview.current?.phase == .failed(.unsupported) && preview.current?.fullScreen == false)
        preview.open(key)
        let bytes = Data([0, 0, 0, 12] + Array("ftypisom".utf8)), second = UUID().uuidString
        #expect(preview.consume(ready(bytes, transfer: second)))
        #expect(preview.current?.fullScreen == false)
        #expect(preview.consume(peer.chunk(second, 0, bytes)))
        try await settle(preview)
        #expect(preview.current?.phase == .ready && preview.current?.fullScreen == true && preview.current?.document == bytes)
    }
}
