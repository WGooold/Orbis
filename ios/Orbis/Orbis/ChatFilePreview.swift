import Combine
import Compression
import CoreGraphics
import CryptoKit
import Foundation

/// FILE-PREVIEW-01/02/03. A preview is a transient receiver, not a FileTransfer or a history event.
///
/// Web pages (FILE-PREVIEW-03) render the original files in an offline WebView: the entry is fetched when the
/// user opens the card, and each other file only when that WebView asks for it. Every response is one bounded
/// transfer whose first range arrives with the Host's reply; the rest is pulled through a small shared window.
@MainActor
final class ChatFilePreview {
    nonisolated static let webFeature = "file.preview-web-v1"
    nonisolated static let nativeFeature = "file.preview-v2"
    nonisolated static let rangeBytes = 128 * 1024
    /// Requested but undelivered bytes for the open preview; the chat's own sync traffic narrows it.
    nonisolated static let windowBytes = 4 * rangeBytes
    nonisolated static let interactiveWindowBytes = rangeBytes
    nonisolated static let concurrentFetches = 4
    /// Per opened page: encoded bytes fetched and files requested. Beyond these the WebView receives 404s.
    nonisolated static let pageBytes = 32 * 1024 * 1024
    nonisolated static let pageResources = 256
    /// Verified web bodies kept for revalidation by digest while the connection object lives.
    nonisolated static let cacheBytes = 24 * 1024 * 1024
    nonisolated static let webEntryBytes = 4 * 1024 * 1024
    nonisolated static let webResourceBytes = 8 * 1024 * 1024

    enum Format: String, Equatable, Sendable {
        case html, svg, jpeg, png, pdf, text, mp4
        init?(fileName: String) {
            switch (fileName as NSString).pathExtension.lowercased() {
            case "html", "htm": self = .html
            case "svg": self = .svg
            case "jpg", "jpeg": self = .jpeg
            case "png": self = .png
            case "pdf": self = .pdf
            case "txt", "md", "log", "json", "csv": self = .text
            case "mp4": self = .mp4
            default: return nil
            }
        }
        var isWeb: Bool { self == .html || self == .svg }
        var budget: Int {
            switch self {
            case .html, .svg: ChatFilePreview.webEntryBytes
            case .jpeg, .png: 8 * 1024 * 1024
            case .pdf: 12 * 1024 * 1024
            case .text: 256 * 1024
            case .mp4: 16 * 1024 * 1024
            }
        }
        func matchesBytes(_ bytes: Data) -> Bool {
            switch self {
            case .html, .svg: !bytes.isEmpty
            case .text: !bytes.contains(0) && String(data: bytes, encoding: .utf8) != nil
            case .jpeg: bytes.starts(with: [0xff, 0xd8, 0xff])
            case .png: bytes.starts(with: [137, 80, 78, 71, 13, 10, 26, 10])
            case .pdf: bytes.starts(with: "%PDF-".utf8)
            case .mp4: bytes.count >= 12 && bytes.dropFirst(4).starts(with: "ftyp".utf8)
            }
        }
    }
    enum Source: Hashable {
        case reference(String), artifact(String)
        var identity: String {
            switch self { case .reference(let id): "r:" + id; case .artifact(let id): "a:" + id }
        }
        func command(format: Format) -> [String: Any] {
            var body: [String: Any] = [:]
            switch self {
            case .reference(let path): body["type"] = "file.download"; body["path"] = path
            case .artifact(let id): body["type"] = "artifact.download"; body["artifactId"] = id
            }
            if !format.isWeb { body["maxBytes"] = format.budget; body["previewFormat"] = format.rawValue }
            return body
        }
        func matches(_ reply: [String: Any]) -> Bool {
            switch self {
            case .reference(let id): reply["referenceId"] as? String == id && (reply["artifactId"] as? String).flatMap(UUID.init(uuidString:)) != nil
            case .artifact(let id): reply["artifactId"] as? String == id && reply["referenceId"] == nil
            }
        }
    }
    struct Key: Hashable { let session: String; let block: String; let source: Source; let name: String }
    enum Failure: Error, Equatable { case unavailable, unsupported, tooLarge, interrupted }
    enum Phase: Equatable { case loading, ready, failed(Failure) }
    struct Progress: Equatable { var received: Int; var total: Int }
    /// A verified, decoded body. `path` is relative to the page's site root.
    struct WebResource: Sendable, Equatable { let path: String; let mimeType: String; let body: Data; let sha256: String }
    /// Optimistic until a Host answers, so cards do not change shape while the connection starts.
    struct Availability: Equatable { var web = true; var native = true }
    struct Selection: Equatable {
        let key: Key
        let id: UUID
        var phase: Phase = .loading
        var progress: Progress?
        /// Native formats: the verified file. Web pages keep their entry in `entry`.
        var document: Data?
        var entry: WebResource?
        var fullScreen = false
        /// The inline card shows this still image of the rendered page instead of a live WebView.
        var snapshot: CGImage?
        static func == (left: Self, right: Self) -> Bool {
            left.id == right.id && left.phase == right.phase && left.fullScreen == right.fullScreen &&
                left.progress == right.progress && left.snapshot === right.snapshot
        }
    }

    private struct Range { let id: String; let length: Int; var sentAt: Duration; var retries: Int }
    private final class Fetch {
        let command = "preview:" + UUID().uuidString
        /// Chosen here for web responses so the range pushed with the reply has an owner.
        var transfer: String?
        /// `nil`: the opened file itself.
        let resource: String?
        let known: WebResource?
        let issued: Duration
        var accepted = false
        var verifying = false
        var size = 0, contentSize = 0
        var hash = "", encoding = "identity", mimeType = "", path = ""
        var parts: [Int: Data] = [:]
        var next = 0, delivered = 0
        var outstanding: [Int: Range] = [:]
        init(transfer: String?, resource: String?, known: WebResource?, now: Duration) {
            self.transfer = transfer; self.resource = resource; self.known = known; issued = now
        }
    }
    private final class Active {
        let id: UUID
        let host: String
        let key: Key
        let format: Format
        let page = UUID().uuidString.lowercased()
        var fetches: [Fetch] = []
        var queued: [String] = []
        var waiting: [String: [(Result<WebResource, Failure>) -> Void]] = [:]
        var resources: [String: WebResource] = [:]
        var fetchedBytes = 0
        var requested = 0
        var lastChunk: Duration
        init(id: UUID, host: String, key: Key, format: Format, now: Duration) {
            self.id = id; self.host = host; self.key = key; self.format = format; lastChunk = now
        }
    }

    private let selection = CurrentValueSubject<Selection?, Never>(nil)
    private let availabilitySubject = CurrentValueSubject<Availability, Never>(.init())
    private var active: Active?
    private var retired: [String: Duration] = [:]
    private var retiredTransfers: [String: Duration] = [:]
    private var cache: [String: WebResource] = [:]
    private var cacheOrder: [String] = []
    private var sizes: [String: Int] = [:]
    private let elapsed: () -> Duration
    private let automaticTick: Bool
    private var timer: Task<Void, Never>?
    private var host: String?
    var interactive = false
    var send: ([String: Any]) -> Bool = { _ in false }
    private var now: Duration { elapsed() }

    init(automaticTick: Bool = true, elapsed: (() -> Duration)? = nil) {
        let origin = ContinuousClock.now
        self.elapsed = elapsed ?? { origin.duration(to: ContinuousClock.now) }
        self.automaticTick = automaticTick
    }

    var current: Selection? { selection.value }
    var changes: AnyPublisher<Selection?, Never> { selection.eraseToAnyPublisher() }
    /// The last authenticated Host's capabilities. Cards without a supported path only offer the download.
    var availability: AnyPublisher<Availability, Never> { availabilitySubject.removeDuplicates().eraseToAnyPublisher() }
    func offersPreview(_ name: String) -> Bool {
        guard let format = Format(fileName: name) else { return false }
        return format.isWeb ? availabilitySubject.value.web : availabilitySubject.value.native
    }
    /// Decoded size from an earlier response for this file, shown on the collapsed card.
    func knownSize(_ source: Source) -> Int? { sizes[source.identity] }

    /// Loading stops; a verified page stays readable from memory, and only its pending files end.
    func resetConnection() {
        if current?.phase == .loading { fail(.interrupted) }
        else if let opened = active { for fetch in opened.fetches { finish(fetch, .failure(.interrupted), in: opened) } }
        host = nil; retired = [:]; retiredTransfers = [:]
    }
    func authenticated(host: String, supportsWeb: Bool, supportsNative: Bool = false) {
        if self.host != host { resetConnection() }
        self.host = host
        availabilitySubject.send(.init(web: supportsWeb, native: supportsNative))
        if let current, let format = Format(fileName: current.key.name), !(format.isWeb ? supportsWeb : supportsNative),
           current.phase == .loading || current.phase == .ready { fail(.unavailable) }
    }

    func open(_ key: Key) {
        close()
        guard let format = Format(fileName: key.name) else { return }
        let id = UUID()
        guard offersPreview(key.name), let host else {
            selection.send(.init(key: key, id: id, phase: .failed(host == nil ? .interrupted : .unavailable))); return
        }
        let opened = Active(id: id, host: host, key: key, format: format, now: now)
        active = opened
        selection.send(.init(key: key, id: id))
        let fetch = Fetch(transfer: format.isWeb ? UUID().uuidString.lowercased() : nil, resource: nil,
                          known: format.isWeb ? cache[cacheKey(opened, nil)] : nil, now: now)
        guard issue(fetch, in: opened) else { fail(.interrupted); return }
        guard automaticTick, active === opened else { return }
        timer = Task { [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(for: .milliseconds(100)) } catch { return }
                self?.tick()
            }
        }
    }
    func close(key: Key? = nil) {
        guard key == nil || current?.key == key else { return }
        stop()
        if current != nil { selection.send(nil) }
    }
    func closeSession(_ session: String) {
        guard current?.key.session == session else { return }
        close()
    }
    /// Loading stops when the card leaves the viewport; a verified page stays until it is collapsed.
    func fileHidden(_ key: Key, id: UUID) {
        if let current, current.key == key, current.id == id, current.phase == .loading { fail(.interrupted) }
    }
    func setFullScreen(_ id: UUID, _ open: Bool) -> Bool {
        guard var current, current.id == id, current.phase == .ready else { return false }
        if current.fullScreen != open { current.fullScreen = open; selection.send(current) }
        return true
    }
    func setSnapshot(_ id: UUID, _ image: CGImage) {
        guard var current, current.id == id, current.phase == .ready else { return }
        current.snapshot = image; selection.send(current)
    }
    func renderFailed(_ id: UUID) {
        guard current?.id == id, current?.phase == .ready else { return }
        fail(.unsupported)
    }

    /// FILE-PREVIEW-03. One file the opened page asked for, by decoded path below its site root.
    /// Completion runs on the main actor, once, possibly synchronously.
    func resource(_ id: UUID, path: String, completion: @escaping (Result<WebResource, Failure>) -> Void) {
        let path = normalized(path)
        guard let current, current.id == id, let entry = current.entry else { completion(.failure(.unavailable)); return }
        if path == entry.path { completion(.success(entry)); return }
        guard let opened = active, opened.id == id else { completion(.failure(.unavailable)); return }
        if let hit = opened.resources[path] { completion(.success(hit)); return }
        if opened.waiting[path] != nil { opened.waiting[path]!.append(completion); return }
        guard !path.isEmpty, path.utf8.count <= 1024, opened.requested < Self.pageResources, opened.fetchedBytes < Self.pageBytes else {
            completion(.failure(.tooLarge)); return
        }
        opened.requested += 1
        opened.waiting[path] = [completion]
        opened.queued.append(path)
        pump(opened)
    }

    private func normalized(_ path: String) -> String {
        var value = Substring(path)
        while value.hasPrefix("/") { value = value.dropFirst() }
        return String(value)
    }
    private func cacheKey(_ opened: Active, _ path: String?) -> String {
        opened.host + "\n" + opened.key.source.identity + "\n" + (path ?? "")
    }
    private func remember(_ resource: WebResource, key: String) {
        if cache.updateValue(resource, forKey: key) != nil { cacheOrder.removeAll { $0 == key } }
        cacheOrder.append(key)
        var total = cache.values.reduce(0) { $0 + $1.body.count }
        while total > Self.cacheBytes, let oldest = cacheOrder.first {
            cacheOrder.removeFirst()
            total -= cache.removeValue(forKey: oldest)?.body.count ?? 0
        }
    }

    private func pump(_ opened: Active) {
        while active === opened, opened.fetches.count < Self.concurrentFetches, !opened.queued.isEmpty {
            let path = opened.queued.removeFirst()
            let fetch = Fetch(transfer: UUID().uuidString.lowercased(), resource: path, known: cache[cacheKey(opened, path)], now: now)
            if !issue(fetch, in: opened) { finish(fetch, .failure(.interrupted), in: opened) }
        }
    }
    private func issue(_ fetch: Fetch, in opened: Active) -> Bool {
        opened.fetches.append(fetch)
        var body = opened.key.source.command(format: opened.format)
        if opened.format.isWeb, let transfer = fetch.transfer {
            var web: [String: Any] = ["page": opened.page, "transferId": transfer]
            if let resource = fetch.resource { web["resource"] = resource }
            if let known = fetch.known { web["ifNoneMatch"] = known.sha256 }
            body["web"] = web
        }
        return sendCommand(opened.host, id: fetch.command, body: body)
    }

    private func fail(_ reason: Failure) {
        stop()
        guard var current else { return }
        current.phase = .failed(reason); current.document = nil; current.entry = nil; current.snapshot = nil
        current.fullScreen = false; current.progress = nil
        selection.send(current)
    }
    private func stop() {
        timer?.cancel(); timer = nil
        guard let opened = active else { return }
        active = nil // Revoke ownership before sending best-effort cancellations.
        let time = now
        retired = retired.filter { $0.value > time }
        retiredTransfers = retiredTransfers.filter { $0.value > time }
        for fetch in opened.fetches {
            retired[fetch.command] = time + .seconds(30)
            if let transfer = fetch.transfer {
                retiredTransfers[transfer.lowercased()] = time + .seconds(30)
                if fetch.accepted || opened.format.isWeb { cancel(host: opened.host, transfer: transfer) }
            }
        }
        while retired.count > 64, let oldest = retired.min(by: { $0.value < $1.value }) { retired[oldest.key] = nil }
        while retiredTransfers.count > 64, let oldest = retiredTransfers.min(by: { $0.value < $1.value }) { retiredTransfers[oldest.key] = nil }
        let waiting = opened.waiting
        opened.waiting = [:]; opened.queued = []; opened.fetches = []
        for completions in waiting.values { for completion in completions { completion(.failure(.interrupted)) } }
    }
    private func sendCommand(_ host: String, id: String, body: [String: Any]) -> Bool {
        send(["type": "runtime.command", "protocolVersion": orbisProtocolVersion, "runtimeId": host, "commandId": id, "command": body])
    }
    private func cancel(host: String, transfer: String) {
        _ = sendCommand(host, id: "preview-cancel:" + UUID().uuidString, body: ["type": "artifact.cancel", "transferId": transfer])
    }
    private func sendRead(_ fetch: Fetch, offset: Int, range: Range) -> Bool {
        guard let transfer = fetch.transfer else { return false }
        return send(["type": "artifact.read", "protocolVersion": orbisProtocolVersion, "transferId": transfer,
                     "requestId": range.id, "offset": offset, "length": range.length])
    }

    /// Fill the shared window, oldest response first, so the page's earliest request finishes first.
    private func schedule(_ opened: Active) {
        let window = interactive ? Self.interactiveWindowBytes : Self.windowBytes
        var inFlight = opened.fetches.reduce(0) { total, fetch in total + fetch.outstanding.values.reduce(0) { $0 + $1.length } }
        for fetch in opened.fetches where fetch.accepted && !fetch.verifying {
            while active === opened, fetch.next < fetch.size, inFlight < window {
                let length = min(Self.rangeBytes, fetch.size - fetch.next)
                let range = Range(id: UUID().uuidString, length: length, sentAt: now, retries: 0)
                fetch.outstanding[fetch.next] = range
                if !sendRead(fetch, offset: fetch.next, range: range) { finish(fetch, .failure(.interrupted), in: opened); return }
                fetch.next += length; inFlight += length
            }
        }
    }

    func tick() {
        guard let opened = active else { return }
        let time = now
        for fetch in opened.fetches where !fetch.verifying {
            guard active === opened else { return }
            if !fetch.accepted {
                if time - fetch.issued >= .seconds(15) { finish(fetch, .failure(.interrupted), in: opened) }
                continue
            }
            // Retransmit only the oldest range, and only when the whole page has stalled.
            guard let offset = fetch.outstanding.keys.min(), var range = fetch.outstanding[offset] else { continue }
            let quiet = time - max(range.sentAt, opened.lastChunk)
            guard quiet >= .milliseconds(3_000 << min(range.retries, 3)) else { continue }
            if range.retries >= 3 { finish(fetch, .failure(.interrupted), in: opened); continue }
            range = Range(id: UUID().uuidString, length: range.length, sentAt: time, retries: range.retries + 1)
            fetch.outstanding[offset] = range
            if !sendRead(fetch, offset: offset, range: range) { finish(fetch, .failure(.interrupted), in: opened) }
        }
        if active === opened { schedule(opened) }
    }

    @discardableResult
    func consume(_ reply: [String: Any]) -> Bool {
        let type = reply["type"] as? String
        if type == "artifact.read.failed", let transfer = (reply["transferId"] as? String)?.lowercased() {
            if retiredTransfers[transfer] != nil { return true }
            guard let opened = active, let fetch = opened.fetches.first(where: { $0.transfer?.lowercased() == transfer }) else { return false }
            if fetch.outstanding.values.contains(where: { $0.id == reply["requestId"] as? String }) { finish(fetch, .failure(.interrupted), in: opened) }
            return true
        }
        if type == "protocol.error", let id = reply["commandId"] as? String, id.hasPrefix("preview:") || id.hasPrefix("preview-cancel:") {
            if let opened = active, let fetch = opened.fetches.first(where: { $0.command == id }) { finish(fetch, .failure(.unavailable), in: opened) }
            return true
        }
        guard type == "file.preview.started" || type == "file.preview.failed" else { return false }
        guard sessionInteger(reply["protocolVersion"]) == Int64(orbisProtocolVersion), let host,
              reply["runtimeId"] as? String == host, let command = reply["commandId"] as? String else { return true }
        guard let opened = active, let fetch = opened.fetches.first(where: { $0.command == command }) else {
            if type == "file.preview.started", let expiry = retired[command], expiry > now,
               reply["notModified"] as? Bool != true, let transfer = reply["transferId"] as? String, UUID(uuidString: transfer) != nil {
                cancel(host: host, transfer: transfer)
            }
            return true
        }
        if type == "file.preview.failed" {
            let reason: Failure = switch reply["reason"] as? String {
            case "too_large": .tooLarge
            case "unsupported": .unsupported
            case "unavailable", "invalid_request": .unavailable
            default: .interrupted
            }
            finish(fetch, .failure(reason), in: opened)
            return true
        }
        accept(fetch, reply, in: opened)
        return true
    }

    private func accept(_ fetch: Fetch, _ reply: [String: Any], in opened: Active) {
        guard let transfer = reply["transferId"] as? String, UUID(uuidString: transfer) != nil,
              fetch.transfer == nil || fetch.transfer?.lowercased() == transfer.lowercased() else {
            finish(fetch, .failure(.unsupported), in: opened); return
        }
        guard !fetch.accepted else { return }
        let web = opened.format.isWeb
        let limit = !web ? opened.format.budget : fetch.resource == nil ? Self.webEntryBytes : Self.webResourceBytes
        guard opened.key.source.matches(reply), reply["format"] as? String == (web ? "web" : opened.format.rawValue),
              let size = sessionInteger(reply["size"]), (1...Int64(limit)).contains(size),
              let hash = reply["sha256"] as? String, hash.utf8.count == 64,
              hash.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else {
            finish(fetch, .failure(.unsupported), in: opened); return
        }
        fetch.transfer = transfer; fetch.accepted = true; fetch.size = Int(size); fetch.hash = hash
        fetch.contentSize = Int(size)
        if web {
            guard let content = sessionInteger(reply["contentSize"]), (Int64(size)...Int64(limit)).contains(content),
                  let encoding = reply["encoding"] as? String, encoding == "identity" || encoding == "deflate-raw",
                  encoding == "deflate-raw" || content == size,
                  let mime = reply["mimeType"] as? String, (1...128).contains(mime.utf8.count),
                  let path = reply["resource"] as? String, !path.isEmpty, fetch.resource == nil || fetch.resource == path else {
                finish(fetch, .failure(.unsupported), in: opened); return
            }
            fetch.contentSize = Int(content); fetch.encoding = encoding; fetch.mimeType = mime; fetch.path = path
            if reply["notModified"] as? Bool == true {
                guard let known = fetch.known, known.sha256 == hash else { finish(fetch, .failure(.unsupported), in: opened); return }
                fetch.size = 0
                finish(fetch, .success(WebResource(path: path, mimeType: mime, body: known.body, sha256: hash)), in: opened)
                return
            }
        }
        if fetch.resource == nil { sizes[opened.key.source.identity] = fetch.contentSize }
        let first = min(Self.rangeBytes, fetch.size)
        if web, let pushed = fetch.parts[0], pushed.count == first {
            // The range sent with the reply arrived first.
            fetch.delivered = first; opened.fetchedBytes += first
        } else if web {
            // It is on its way; account for it as requested rather than asking again.
            fetch.parts = [:]
            fetch.outstanding[0] = Range(id: "pushed", length: first, sentAt: now, retries: 0)
        }
        fetch.next = web ? first : 0
        reportProgress(fetch, in: opened)
        if fetch.delivered == fetch.size { verify(fetch, in: opened) } else { schedule(opened) }
    }

    func consume(_ chunk: ArtifactChunk) -> Bool {
        let transfer = chunk.transferId.lowercased()
        if retiredTransfers[transfer] != nil { return true }
        guard let opened = active, let fetch = opened.fetches.first(where: { $0.transfer?.lowercased() == transfer }) else { return false }
        guard chunk.runtimeId == opened.host, !fetch.verifying else { return true }
        let offset = Int(chunk.offset)
        if !fetch.accepted {
            // Only the range sent with a web reply can precede that reply.
            if offset == 0, opened.format.isWeb, (1...Self.rangeBytes).contains(chunk.bytes.count), fetch.parts[0] == nil {
                fetch.parts[0] = chunk.bytes; opened.lastChunk = now
            }
            return true
        }
        guard let range = fetch.outstanding[offset], range.length == chunk.bytes.count else { return true }
        fetch.outstanding[offset] = nil
        fetch.parts[offset] = chunk.bytes
        while let part = fetch.parts[fetch.delivered] { fetch.delivered += part.count }
        opened.lastChunk = now
        opened.fetchedBytes += chunk.bytes.count
        reportProgress(fetch, in: opened)
        if fetch.delivered == fetch.size { verify(fetch, in: opened) }
        schedule(opened)
        return true
    }

    private func reportProgress(_ fetch: Fetch, in opened: Active) {
        guard fetch.resource == nil, var current, current.id == opened.id, current.phase == .loading else { return }
        current.progress = .init(received: fetch.delivered, total: fetch.size)
        selection.send(current)
    }

    private func verify(_ fetch: Fetch, in opened: Active) {
        fetch.verifying = true
        let parts = fetch.parts.sorted { $0.key < $1.key }.map(\.value)
        fetch.parts = [:]
        let size = fetch.size, contentSize = fetch.contentSize, expected = fetch.hash, deflated = fetch.encoding == "deflate-raw"
        let format = opened.format, checksBytes = fetch.resource == nil
        let worker = Task.detached(priority: .utility) { () -> Data? in
            var received = Data(capacity: size)
            for part in parts {
                guard !Task.isCancelled else { return nil }
                received.append(part)
            }
            guard received.count == size, let body = deflated ? Self.inflate(received, expected: contentSize) : received,
                  body.count == contentSize,
                  SHA256.hash(data: body).map({ String(format: "%02x", $0) }).joined() == expected,
                  !checksBytes || format.matchesBytes(body) else { return nil }
            return body
        }
        Task { [weak self, weak opened] in
            let body = await worker.value
            guard let self, let opened, self.active === opened, opened.fetches.contains(where: { $0 === fetch }) else { return }
            guard let body else { self.finish(fetch, .failure(.unsupported), in: opened); return }
            if let transfer = fetch.transfer {
                _ = self.send(["type": "artifact.done", "protocolVersion": orbisProtocolVersion, "transferId": transfer])
            }
            self.finish(fetch, .success(WebResource(path: fetch.path, mimeType: fetch.mimeType, body: body, sha256: fetch.hash)), in: opened)
        }
    }

    /// Raw DEFLATE with an exact decoded length; anything longer or shorter is rejected.
    nonisolated static func inflate(_ data: Data, expected: Int) -> Data? {
        guard expected > 0, !data.isEmpty else { return nil }
        var output = Data(count: expected + 1)
        let written = output.withUnsafeMutableBytes { destination in
            data.withUnsafeBytes { source in
                compression_decode_buffer(destination.bindMemory(to: UInt8.self).baseAddress!, expected + 1,
                                          source.bindMemory(to: UInt8.self).baseAddress!, data.count, nil, COMPRESSION_ZLIB)
            }
        }
        guard written == expected else { return nil }
        output.count = expected
        return output
    }

    private func finish(_ fetch: Fetch, _ result: Result<WebResource, Failure>, in opened: Active) {
        guard active === opened, let index = opened.fetches.firstIndex(where: { $0 === fetch }) else { return }
        opened.fetches.remove(at: index)
        if case .failure = result, let transfer = fetch.transfer, fetch.accepted || opened.format.isWeb {
            retiredTransfers[transfer.lowercased()] = now + .seconds(30)
            cancel(host: opened.host, transfer: transfer)
        }
        if case .success(let resource) = result, opened.format.isWeb { remember(resource, key: cacheKey(opened, fetch.resource)) }
        guard let path = fetch.resource else {
            // The opened file itself decides the card's state.
            switch result {
            case .failure(let reason): fail(reason)
            case .success(let resource):
                guard var current, current.id == opened.id else { return }
                timer?.cancel(); timer = nil
                if opened.format.isWeb { current.entry = resource; opened.resources[resource.path] = resource }
                else { current.document = resource.body; active = nil }
                current.phase = .ready; current.progress = nil; current.fullScreen = opened.format == .mp4
                if opened.format.isWeb, automaticTick { restartTimer(opened) }
                selection.send(current)
            }
            return
        }
        if case .success(let resource) = result { opened.resources[path] = resource }
        for completion in opened.waiting.removeValue(forKey: path) ?? [] { completion(result) }
        pump(opened)
        schedule(opened)
    }

    /// A ready page keeps a timer only for the files its WebView is still loading.
    private func restartTimer(_ opened: Active) {
        timer = Task { [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
                guard let self, self.active === opened else { return }
                self.tick()
            }
        }
    }
}
