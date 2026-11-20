import Combine
import CryptoKit
import Foundation

/// FILE-PREVIEW-01. A preview is a transient receiver, not a FileTransfer or a history event.
@MainActor
final class ChatFilePreview {
    nonisolated static let feature = "file.preview-v1"
    nonisolated static let maxBytes = 2 * 1024 * 1024
    private static let documentBytes = 1024 * 1024
    nonisolated static let rangeBytes = 128 * 1024

    enum Format: String, Equatable, Sendable {
        case html, svg
        init?(fileName: String) {
            switch (fileName as NSString).pathExtension.lowercased() {
            case "html", "htm": self = .html
            case "svg": self = .svg
            default: return nil
            }
        }
    }
    enum Source: Hashable {
        case reference(String), artifact(String)
        func command() -> [String: Any] {
            switch self {
            case .reference(let path): ["type": "file.download", "path": path, "maxBytes": maxBytes]
            case .artifact(let id): ["type": "artifact.download", "artifactId": id, "maxBytes": maxBytes]
            }
        }
        func matches(_ reply: [String: Any]) -> Bool {
            switch self {
            case .reference(let id): reply["referenceId"] as? String == id && (reply["artifactId"] as? String).flatMap(UUID.init(uuidString:)) != nil
            case .artifact(let id): reply["artifactId"] as? String == id && reply["referenceId"] == nil
            }
        }
    }
    struct Key: Hashable { let session: String; let block: String; let source: Source; let name: String }
    enum Failure: Equatable { case unavailable, unsupported, tooLarge, interrupted }
    enum Phase: Equatable { case loading, ready, failed(Failure) }
    struct Selection: Equatable {
        let key: Key
        let id: UUID
        var phase: Phase = .loading
        var document: Data?
        var fullScreen = false
        static func == (left: Self, right: Self) -> Bool {
            left.id == right.id && left.phase == right.phase && left.fullScreen == right.fullScreen
        }
    }
    private struct Range {
        let id: String
        let length: Int
        let sentAt: Duration
        let retries: Int
    }
    private final class Request {
        let id: UUID
        let host: String
        let source: Source
        let format: Format
        let started: Duration
        var transfer: String?
        var range: Range?
        var total = 0
        var offset = 0
        var parts: [Data] = []
        var hash = ""
        var verifying = false
        var deferReadUntil: Duration = .zero
        var commandID: String { "preview:" + id.uuidString }
        init(id: UUID, host: String, source: Source, format: Format, now: Duration) {
            self.id = id; self.host = host; self.source = source; self.format = format; started = now
        }
    }
    private let selection = CurrentValueSubject<Selection?, Never>(nil)
    private var request: Request?
    private var retired: [String: Duration] = [:]
    private let elapsed: () -> Duration
    private let automaticTick: Bool
    private var timer: Task<Void, Never>?
    private var verifier: Task<Data?, Never>?
    private var host: String?
    private var supported = false
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

    func resetConnection() {
        if request != nil { fail(.interrupted) }
        else if current?.phase == .ready { close() }
        host = nil; supported = false; retired = [:]
    }
    func authenticated(host: String, supportsPreview: Bool) {
        if self.host != host { resetConnection() }
        self.host = host; supported = supportsPreview
        if !supported, current?.phase == .loading || current?.phase == .ready { fail(.unavailable) }
    }
    func open(_ key: Key) {
        close()
        guard let format = Format(fileName: key.name) else { return }
        let id = UUID()
        guard supported, let host else {
            selection.send(.init(key: key, id: id, phase: .failed(.unavailable))); return
        }
        let active = Request(id: id, host: host, source: key.source, format: format, now: now)
        request = active
        selection.send(.init(key: key, id: id))
        // The command is registered before sending; a rejected send is a local failure.
        if !sendCommand(host, id: active.commandID, body: key.source.command()) { fail(.interrupted); return }
        guard automaticTick, request === active else { return }
        timer = Task { [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(for: .milliseconds(100)) } catch { return }
                guard let self else { return }
                self.tick()
            }
        }
    }
    func close(key: Key? = nil) {
        guard key == nil || current?.key == key else { return }
        stop()
        if current != nil { selection.send(nil) }
    }
    func fileHidden(_ key: Key, id: UUID) {
        if let current, current.key == key, current.id == id, current.phase == .loading { fail(.interrupted) }
    }
    func setFullScreen(_ id: UUID, _ open: Bool) -> Bool {
        guard var current, current.id == id, current.phase == .ready else { return false }
        if current.fullScreen != open { current.fullScreen = open; selection.send(current) }
        return true
    }
    func renderFailed(_ id: UUID) {
        guard current?.id == id, current?.phase == .ready else { return }
        fail(.unsupported)
    }
    private func fail(_ reason: Failure) {
        stop()
        guard var current else { return }
        current.phase = .failed(reason); current.document = nil; current.fullScreen = false
        selection.send(current)
    }
    private func stop() {
        timer?.cancel(); timer = nil
        verifier?.cancel(); verifier = nil
        guard let active = request else { return }
        request = nil // Revoke ownership before sending the best-effort cancellation.
        retired = retired.filter { $0.value > now }
        if retired.count >= 16, let oldest = retired.min(by: { $0.value < $1.value }) { retired[oldest.key] = nil }
        retired[active.commandID] = now + .seconds(40)
        if let transfer = active.transfer { cancel(host: active.host, transfer: transfer) }
    }
    private func sendCommand(_ host: String, id: String, body: [String: Any]) -> Bool {
        send(["type": "runtime.command", "protocolVersion": orbisProtocolVersion, "runtimeId": host, "commandId": id, "command": body])
    }
    private func cancel(host: String, transfer: String) {
        _ = sendCommand(host, id: "preview-cancel:" + UUID().uuidString, body: ["type": "artifact.cancel", "transferId": transfer])
    }
    func tick() {
        guard let active = request else { return }
        let time = now
        if time - active.started >= .seconds(30) || active.transfer == nil && time - active.started >= .seconds(7) {
            fail(.interrupted); return
        }
        guard let transfer = active.transfer, !active.verifying else { return }
        let last = active.range
        if let last {
            guard time - last.sentAt >= .milliseconds(1_500 * (last.retries + 1)) else { return }
            if last.retries >= 2 { fail(.interrupted); return }
        } else if interactive, time < active.deferReadUntil { return }
        let range = Range(id: UUID().uuidString, length: min(Self.rangeBytes, active.total - active.offset),
                          sentAt: time, retries: last.map { $0.retries + 1 } ?? 0)
        active.range = range
        if !send(["type": "artifact.read", "protocolVersion": orbisProtocolVersion, "transferId": transfer,
                  "requestId": range.id, "offset": active.offset, "length": range.length]) { fail(.interrupted) }
    }

    @discardableResult
    func consume(_ reply: [String: Any]) -> Bool {
        let type = reply["type"] as? String
        if type == "artifact.read.failed", let active = request, let transfer = active.transfer,
           reply["transferId"] as? String == transfer {
            if let range = active.range, reply["requestId"] as? String == range.id { fail(.interrupted) }
            return true
        }
        if type == "protocol.error", let id = reply["commandId"] as? String, id.hasPrefix("preview:") || id.hasPrefix("preview-cancel:") {
            if id == request?.commandID { fail(.unavailable) }
            return true
        }
        guard type == "file.preview.started" || type == "file.preview.failed" else { return false }
        guard sessionInteger(reply["protocolVersion"]) == Int64(orbisProtocolVersion), let host,
              reply["runtimeId"] as? String == host, let command = reply["commandId"] as? String else { return true }
        guard let active = request, active.commandID == command else {
            if type == "file.preview.started", let expiry = retired[command], expiry > now,
               let transfer = reply["transferId"] as? String, UUID(uuidString: transfer) != nil {
                cancel(host: host, transfer: transfer)
            }
            return true
        }
        if type == "file.preview.failed" {
            switch reply["reason"] as? String {
            case "too_large": fail(.tooLarge)
            case "unsupported": fail(.unsupported)
            case "unavailable", "invalid_request": fail(.unavailable)
            default: fail(.interrupted)
            }
            return true
        }
        guard let transfer = reply["transferId"] as? String, UUID(uuidString: transfer) != nil else { fail(.unsupported); return true }
        guard active.transfer == nil else {
            if active.transfer != transfer { cancel(host: host, transfer: transfer) }
            return true
        }
        active.transfer = transfer
        guard active.source.matches(reply), reply["format"] as? String == active.format.rawValue,
              let size = sessionInteger(reply["size"]), (1...Int64(Self.documentBytes)).contains(size),
              let hash = reply["sha256"] as? String, hash.utf8.count == 64, hash.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else {
            fail(.unsupported); return true
        }
        active.total = Int(size); active.hash = hash; active.deferReadUntil = now + .milliseconds(350)
        return true
    }

    func consume(_ chunk: ArtifactChunk) -> Bool {
        guard let active = request, active.transfer == chunk.transferId else { return false }
        guard !active.verifying, chunk.runtimeId == active.host, let range = active.range,
              chunk.offset == Int64(active.offset), chunk.bytes.count == range.length else { return true }
        active.parts.append(chunk.bytes); active.offset += range.length; active.range = nil
        active.deferReadUntil = now + .milliseconds(350)
        if active.offset == active.total { verify(active) }
        return true
    }
    private func verify(_ active: Request) {
        active.verifying = true
        let parts = active.parts, total = active.total, expected = active.hash
        active.parts = []
        let worker = Task.detached(priority: .utility) { () -> Data? in
            var output = Data(capacity: total), hash = SHA256()
            for part in parts {
                guard !Task.isCancelled else { return nil }
                output.append(part); hash.update(data: part)
            }
            guard hash.finalize().map({ String(format: "%02x", $0) }).joined() == expected,
                  String(data: output, encoding: .utf8) != nil else { return nil }
            return output
        }
        verifier = worker
        Task { [weak self, weak active] in
            let result = await worker.value
            guard let self, let active, self.request === active, var current = self.current else { return }
            guard let result, let transfer = active.transfer else { self.fail(.unsupported); return }
            self.timer?.cancel(); self.timer = nil; self.verifier = nil; self.request = nil
            current.document = result; current.phase = .ready
            self.selection.send(current)
            _ = self.send(["type": "artifact.done", "protocolVersion": orbisProtocolVersion, "transferId": transfer])
        }
    }
}
