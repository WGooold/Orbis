import Foundation
import Network
import Security

enum RelayTransportMode: String, Codable, CaseIterable { case ws, quic, auto }
enum RelayTransportKind: String { case ws, quic }
enum RelayLane: String, CaseIterable, Sendable { case ctl, msg, bulk, history, catchup
    static let priority: [RelayLane] = [.ctl, .msg, .history, .catchup, .bulk]
    init(channel: String?) {
        switch channel {
        case "msg": self = .msg
        case "bulk": self = .bulk
        case "history": self = .history
        case "catchup": self = .catchup
        default: self = .ctl
        }
    }
}

enum RelayMessage: Sendable {
    case string(String), data(Data)

    init?(_ message: URLSessionWebSocketTask.Message) {
        switch message {
        case .string(let text): self = .string(text)
        case .data(let data): self = .data(data)
        @unknown default: return nil
        }
    }

    fileprivate var webSocketMessage: URLSessionWebSocketTask.Message {
        switch self {
        case .string(let text): return .string(text)
        case .data(let data): return .data(data)
        }
    }
}

/// One pre-auth attempt. Its identity is the local generation; start sends no credentials.
/// A successful send only accepts bytes locally, never acknowledges a Host operation.
@MainActor protocol RelaySocketConnection: AnyObject {
    var supportsHistoryStreams: Bool { get }
    var kind: RelayTransportKind? { get }
    func start()
    @discardableResult func send(_ message: RelayMessage, lane: RelayLane, completionHandler: @escaping @Sendable (Error?) -> Void) -> Bool
    func receive(completionHandler: @escaping @Sendable (Result<RelayMessage, Error>) -> Void)
    func cancel()
    func cancelAndWait() async
    func setBusinessReady(_ ready: Bool)
}

extension RelaySocketConnection {
    var supportsHistoryStreams: Bool { false }
    func cancelAndWait() async { cancel() }
    func setBusinessReady(_ ready: Bool) {}
    @discardableResult func send(_ message: RelayMessage, completionHandler: @escaping @Sendable (Error?) -> Void) -> Bool {
        send(message, lane: .ctl, completionHandler: completionHandler)
    }
}

enum RelayConnectionError: LocalizedError {
    case quicUnavailable
    var errorDescription: String? { "QUIC transport unavailable" }
}

/// SDK-specific WS lifecycle stays inside the adapter, including close acknowledgement.
@MainActor protocol RelayWebSocket: AnyObject {
    func start()
    func send(_ message: RelayMessage, completionHandler: @escaping @Sendable (Error?) -> Void)
    func receive(completionHandler: @escaping @Sendable (Result<RelayMessage, Error>) -> Void)
    func cancel()
    func cancelAndWait() async
}

extension RelayWebSocket { func cancelAndWait() async { cancel() } }

@MainActor private final class SystemRelayWebSocket: NSObject, RelayWebSocket, URLSessionWebSocketDelegate {
    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private let onOpen: () -> Void
    private let onClose: (Error?) -> Void
    private var invalidated = false
    private var closeWaiters: [CheckedContinuation<Void, Never>] = []
    init(url: URL, configuration: URLSessionConfiguration, onOpen: @escaping () -> Void, onClose: @escaping (Error?) -> Void) {
        self.onOpen = onOpen; self.onClose = onClose
        super.init()
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        self.session = session
        let task = session.webSocketTask(with: url)
        task.maximumMessageSize = RelayQUICContract.maxFrame
        self.task = task
    }
    func start() { task?.resume() }
    func cancel() {
        let old = task; task = nil
        old?.cancel(with: .goingAway, reason: nil)
        session?.invalidateAndCancel(); session = nil
    }
    func cancelAndWait() async {
        cancel()
        if !invalidated { await withCheckedContinuation { closeWaiters.append($0) } }
    }
    nonisolated func urlSession(_ session: URLSession, didBecomeInvalidWithError error: Error?) {
        Task { @MainActor in
            self.invalidated = true
            let waiters = self.closeWaiters; self.closeWaiters = []
            waiters.forEach { $0.resume() }
        }
    }
    func send(_ message: RelayMessage, completionHandler: @escaping @Sendable (Error?) -> Void) {
        guard let task else { completionHandler(URLError(.notConnectedToInternet)); return }
        task.send(message.webSocketMessage, completionHandler: completionHandler)
    }
    func receive(completionHandler: @escaping @Sendable (Result<RelayMessage, Error>) -> Void) {
        guard let task else { completionHandler(.failure(URLError(.notConnectedToInternet))); return }
        task.receive { result in
            completionHandler(result.flatMap { message in
                guard let value = RelayMessage(message) else { return .failure(URLError(.cannotParseResponse)) }
                return .success(value)
            })
        }
    }
    nonisolated func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        Task { @MainActor in if self.task === webSocketTask { self.onOpen() } }
    }
    nonisolated func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        Task { @MainActor in if self.task === webSocketTask { self.onClose(nil) } }
    }
    nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        Task { @MainActor in if self.task === task { self.onClose(error) } }
    }
}

enum RelayQUICContract {
    static let alpn = "orbis-relay-v2"
    static let maxFrame = 2 * 1024 * 1024

    static func port(from data: Data) -> UInt16? {
        guard data.count <= 4096,
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let version = root["version"] as? NSNumber,
              CFGetTypeID(version) != CFBooleanGetTypeID(), version.doubleValue == 1,
              let quic = root["quic"] as? [String: Any], quic["alpn"] as? String == alpn,
              let number = quic["port"] as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.rounded() == number.doubleValue,
              (1...65535).contains(number.intValue) else { return nil }
        return UInt16(number.intValue)
    }

    static func frame(_ text: String) throws -> Data {
        let data = Data(text.utf8)
        guard !data.isEmpty, data.count <= maxFrame,
              (try? JSONSerialization.jsonObject(with: data)) is [String: Any] else { throw URLError(.cannotParseResponse) }
        let n = UInt32(data.count)
        var frame = Data([UInt8(n >> 24), UInt8((n >> 16) & 255), UInt8((n >> 8) & 255), UInt8(n & 255)])
        frame.append(data)
        return frame
    }

    static func length(_ header: Data) -> Int? {
        guard header.count == 4 else { return nil }
        let size = header.reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
        return size > 0 && size <= maxFrame ? Int(size) : nil
    }

    static func ready(_ data: Data, lane: RelayLane, version: Int = 2) -> Bool {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any], root.count == 3,
              root["type"] as? String == "transport.ready",
              let v = root["version"] as? NSNumber, CFGetTypeID(v) != CFBooleanGetTypeID(), v.doubleValue == Double(version), root["lane"] as? String == lane.rawValue else { return false }
        return true
    }
}

@MainActor private final class RelayCancellationLatch {
    private var ended = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    func finish() {
        ended = true
        let pending = waiters; waiters = []
        pending.forEach { $0.resume() }
    }
    func wait() async {
        if !ended { await withCheckedContinuation { waiters.append($0) } }
    }
}

/// One owner for discovery, the pre-auth QUIC candidate and the winning socket.
/// No business bytes enter either transport before onOpen selects its owner.
@MainActor
final class RelaySocket: NSObject, RelaySocketConnection, URLSessionDataDelegate {
    typealias WebSocketFactory = (URL, URLSessionConfiguration, @escaping () -> Void, @escaping (Error?) -> Void) -> any RelayWebSocket
    private let url: URL
    private let onOpen: (any RelaySocketConnection) -> Void
    private let onClose: (any RelaySocketConnection, Error?) -> Void
    private let mode: RelayTransportMode
    private var session: URLSession?
    private var discovery: URLSessionDataTask?
    private var discoveryData = Data()
    private let configuration: URLSessionConfiguration
    private let makeQUIC: ((String, UInt16) -> NWConnectionGroup)?
    private let makeWebSocket: WebSocketFactory
    private var timer: Task<Void, Never>?
    private var ws: (any RelayWebSocket)?
    private var quicClosed: RelayCancellationLatch?
    private var streamClosed: [RelayLane: RelayCancellationLatch] = [:]
    private var quic: NWConnectionGroup?
    private var streams: [RelayLane: NWConnection] = [:]
    private var readyLanes = Set<RelayLane>()
    private var incoming: [RelayLane: Data] = [:]
    private var receiver: (@Sendable (Result<RelayMessage, Error>) -> Void)?
    private var businessReady = false
    private var reading = Set<RelayLane>()
    private var closingTasks: [Task<Void, Never>] = []
    private var discoveryInvalidated = false
    private var closeWaiters: [CheckedContinuation<Void, Never>] = []
    var streamIdentifiers: [UInt64] {
        streams.values.compactMap { ($0.metadata(definition: NWProtocolQUIC.definition) as? NWProtocolQUIC.Metadata)?.streamIdentifier }.sorted()
    }
    private var stopped = false
    private var opened = false
    private var discovering = true
    private var setupStarted = false
    private var transportVersion = 2
    var supportsHistoryStreams: Bool { kind == .quic && transportVersion == 3 }
    private var activeLanes: [RelayLane] { transportVersion == 3 ? RelayLane.allCases : [.ctl, .msg, .bulk] }
    private let queue = DispatchQueue(label: "orbis.relay.quic")
    var kind: RelayTransportKind? {
        guard opened, !stopped else { return nil }
        return ws == nil ? .quic : .ws
    }

    init(url: URL, mode: RelayTransportMode = .auto, configuration: URLSessionConfiguration = .default,
         makeQUIC: ((String, UInt16) -> NWConnectionGroup)? = nil,
         makeWebSocket: WebSocketFactory? = nil,
         onOpen: @escaping (any RelaySocketConnection) -> Void, onClose: @escaping (any RelaySocketConnection, Error?) -> Void) {
        self.url = url; self.onOpen = onOpen; self.onClose = onClose
        self.mode = mode
        self.configuration = configuration; self.makeQUIC = makeQUIC
        self.makeWebSocket = makeWebSocket ?? { SystemRelayWebSocket(url: $0, configuration: $1, onOpen: $2, onClose: $3) }
    }

    func start() {
        guard session == nil, !stopped else { return }
        let config = configuration
        config.waitsForConnectivity = true
        config.timeoutIntervalForRequest = 20
        session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        if mode == .ws { discovering = false; openWS(); return }
        guard url.scheme == "wss", let base = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let endpoint = RelayURL.endpoint(baseForDiscovery(base), path: "v1/transports", webSocket: false) else {
            finishDiscovery(nil); return
        }
        var request = URLRequest(url: endpoint)
        request.timeoutInterval = 1
        discovery = session?.dataTask(with: request)
        discovery?.resume()
        timer = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 1_000_000_000) } catch { return }
            self?.finishDiscovery(nil)
        }
    }

    private func baseForDiscovery(_ endpoint: URLComponents) -> String {
        var base = endpoint
        if base.path.hasSuffix("/v1/device") { base.path.removeLast("/v1/device".count) }
        return base.string ?? ""
    }

    private func finishDiscovery(_ port: UInt16?) {
        guard !stopped, discovering else { return }
        discovering = false
        discovery?.cancel(); discovery = nil
        timer?.cancel(); timer = nil
        guard let port, let host = url.host else { fallback(); return }
        let connection = makeQUIC?(host, port) ?? Self.makeConnection(host: host, port: port, version: transportVersion)
        quic = connection
        let closed = RelayCancellationLatch(); quicClosed = closed
        timer = Task { [weak self, weak connection] in
            do { try await Task.sleep(nanoseconds: 1_500_000_000) } catch { return }
            guard let self, let connection, self.quic === connection, !self.opened else { return }
            self.fallback()
        }
        connection.stateUpdateHandler = { [weak self, weak connection] state in
            Task { @MainActor in
                if case .cancelled = state { closed.finish() }
                guard let self, let connection, self.quic === connection, !self.stopped else { return }
                switch state {
                case .ready:
                    guard !self.setupStarted else { return }
                    self.setupStarted = true
                    for lane in self.activeLanes {
                        let options = NWProtocolQUIC.Options()
                        options.direction = .bidirectional
                        guard let stream = NWConnection(from: connection, using: options) else { self.fallback(); return }
                        self.streams[lane] = stream
                        self.startStream(stream, lane: lane)
                    }
                case .failed(let error):
                    if self.opened { self.fail(error) } else { self.fallback() }
                case .cancelled:
                    if self.opened { self.fail(URLError(.networkConnectionLost)) }
                default: break
                }
            }
        }
        connection.newConnectionHandler = { [weak self] extra in
            extra.cancel()
            Task { @MainActor in self?.fail(URLError(.cannotParseResponse)) }
        }
        connection.start(queue: queue)
    }

    private func startStream(_ stream: NWConnection, lane: RelayLane) {
        let closed = RelayCancellationLatch(); streamClosed[lane] = closed
        stream.stateUpdateHandler = { [weak self, weak stream] state in
            Task { @MainActor in
                if case .cancelled = state { closed.finish() }
                guard let self, let stream, self.streams[lane] === stream, !self.stopped else { return }
                switch state {
                case .ready:
                    let text = "{\"type\":\"transport.open\",\"version\":\(self.transportVersion),\"lane\":\"\(lane.rawValue)\"}"
                    do {
                        stream.send(content: try RelayQUICContract.frame(text), completion: .contentProcessed { [weak self, weak stream] error in
                            Task { @MainActor in
                                guard let self, let stream, self.streams[lane] === stream, !self.stopped else { return }
                                guard error == nil else { self.fallback(); return }
                                self.readFrame(stream) { [weak self, weak stream] result in
                                    guard let self, let stream, self.streams[lane] === stream else { return }
                                    guard case .success(let data) = result, RelayQUICContract.ready(data, lane: lane, version: self.transportVersion) else { self.fallback(); return }
                                    self.readyLanes.insert(lane)
                                    if self.readyLanes.count == self.activeLanes.count && !self.opened {
                                        self.timer?.cancel(); self.timer = nil; self.opened = true
                                        self.onOpen(self)
                                        for role in self.activeLanes { self.readNext(role) }
                                    }
                                }
                            }
                        })
                    } catch { self.fallback() }
                case .failed(let error):
                    if self.opened { self.fail(error) } else { self.fallback() }
                case .cancelled:
                    if self.opened { self.fail(URLError(.networkConnectionLost)) }
                default: break
                }
            }
        }
        stream.start(queue: queue)
    }

    nonisolated static func makeConnection(host: String, port: UInt16) -> NWConnectionGroup { makeConnection(host: host, port: port, version: 2) }
    nonisolated private static func makeConnection(host: String, port: UInt16, version: Int) -> NWConnectionGroup {
        let options = NWProtocolQUIC.Options(alpn: [version == 3 ? "orbis-relay-v3" : RelayQUICContract.alpn])
        // A multiplex group must not reserve an implicit stream 0. This option
        // selects the group's datagram personality; all business uses the three
        // explicitly extracted reliable streams. No DATAGRAM is sent or accepted.
        options.isDatagram = true
        options.direction = .bidirectional
        options.idleTimeout = 30_000
        options.initialMaxData = 12 * 1024 * 1024
        // Network.framework exposes initial credit; later window growth is system-managed.
        options.initialMaxStreamDataBidirectionalLocal = 2 * 1024 * 1024
        options.initialMaxStreamsBidirectional = 0
        options.initialMaxStreamsUnidirectional = 0
        sec_protocol_options_set_tls_server_name(options.securityProtocolOptions, host)
        let parameters = NWParameters(quic: options)
        parameters.allowFastOpen = false
        let endpoint = NWEndpoint.hostPort(host: NWEndpoint.Host(host), port: NWEndpoint.Port(rawValue: port)!)
        return NWConnectionGroup(with: NWMultiplexGroup(to: endpoint), using: parameters)
    }

    private func clearQUIC() {
        let oldStreams = streams; streams = [:]
        for (lane, stream) in oldStreams {
            let closed = streamClosed[lane]
            stream.cancel()
            closingTasks.append(Task { await closed?.wait(); withExtendedLifetime(stream) {} })
        }
        streamClosed = [:]
        let old = quic; quic = nil
        let closed = quicClosed; quicClosed = nil
        if let old {
            // NWConnectionGroup's state handler must be installed before start.
            // The original handler owns the cancellation latch; never replace it.
            old.cancel()
            closingTasks.append(Task { await closed?.wait(); withExtendedLifetime(old) {} })
        }
        readyLanes.removeAll(); incoming.removeAll(); reading.removeAll(); receiver = nil
    }

    private func fallback() {
        guard !stopped, !opened, ws == nil else { return }
        timer?.cancel(); timer = nil
        clearQUIC()
        if mode == .quic { fail(RelayConnectionError.quicUnavailable); return }
        openWS()
    }

    private func openWS() {
        guard !stopped, ws == nil else { return }
        let task = makeWebSocket(url, configuration, { [weak self] in
            guard let self, !self.stopped, !self.opened else { return }
            self.opened = true; self.onOpen(self)
        }, { [weak self] in self?.fail($0) })
        ws = task
        task.start()
    }

    func cancel() {
        guard !stopped else { return }
        stopped = true
        timer?.cancel(); timer = nil
        discovery?.cancel(); discovery = nil
        clearQUIC()
        if let ws { closingTasks.append(Task { await ws.cancelAndWait() }); ws.cancel() }; ws = nil
        if let session { session.invalidateAndCancel() } else { discoveryInvalidated = true }
        session = nil
    }

    func cancelAndWait() async {
        cancel()
        for task in closingTasks { await task.value }
        closingTasks = []
        if !discoveryInvalidated { await withCheckedContinuation { closeWaiters.append($0) } }
    }

    func setBusinessReady(_ ready: Bool) {
        businessReady = ready
        if ready { for lane in self.activeLanes { readNext(lane) }; drainIncoming() }
    }

    private func fail(_ error: Error?) {
        guard !stopped else { return }
        cancel()
        onClose(self, error)
    }

    @discardableResult func send(_ message: RelayMessage, lane: RelayLane, completionHandler: @escaping @Sendable (Error?) -> Void) -> Bool {
        guard !stopped, opened else { completionHandler(URLError(.notConnectedToInternet)); return false }
        if let ws { ws.send(message, completionHandler: completionHandler); return true }
        guard let connection = streams[lane], case .string(let text) = message else { completionHandler(URLError(.cannotParseResponse)); return false }
        queue.async {
            // Preserve off-main framing / validation for large ciphertext envelopes.
            // Acceptance here is local; asynchronous encoding/write failure is still a failure.
            do {
                connection.send(content: try RelayQUICContract.frame(text), completion: .contentProcessed { error in completionHandler(error) })
            } catch { completionHandler(error) }
        }
        return true
    }

    func receive(completionHandler: @escaping @Sendable (Result<RelayMessage, Error>) -> Void) {
        guard !stopped, opened else { completionHandler(.failure(URLError(.notConnectedToInternet))); return }
        if let ws { ws.receive(completionHandler: completionHandler); return }
        guard receiver == nil else { completionHandler(.failure(URLError(.cannotParseResponse))); return }
        receiver = completionHandler
        drainIncoming()
    }

    private func readNext(_ lane: RelayLane) {
        guard !stopped, (lane == .ctl || businessReady), !reading.contains(lane), incoming[lane] == nil, let stream = streams[lane] else { return }
        reading.insert(lane)
        readFrame(stream) { [weak self] result in
            guard let self, !self.stopped else { return }
            self.reading.remove(lane)
            switch result {
            case .failure(let error):
                let callback = self.receiver; self.receiver = nil
                callback?(.failure(error)); self.fail(error)
            case .success(let data):
                self.incoming[lane] = data
                self.drainIncoming()
            }
        }
    }

    private func drainIncoming() {
        guard let callback = receiver,
              let lane = RelayLane.priority.first(where: { ($0 == .ctl || businessReady) && incoming[$0] != nil }),
              let data = incoming.removeValue(forKey: lane) else { return }
        receiver = nil
        // At most one full frame per lane plus one read in flight, independently.
        readNext(lane)
        queue.async {
            guard let text = String(data: data, encoding: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                callback(.failure(URLError(.cannotParseResponse))); return
            }
            let header = (object["envelope"] as? [String: Any])?["hdr"] as? [String: Any]
            let kind = header?["k"] as? String
            let channel = header?["ch"] as? String
            let role: RelayLane? = object["type"] as? String != "v2.frame" || kind == "hs" || kind == "pair" ? .ctl : channel.flatMap(RelayLane.init(rawValue:))
            guard role == lane else { callback(.failure(URLError(.cannotParseResponse))); return }
            callback(.success(.string(text)))
        }
    }

    private func readFrame(_ connection: NWConnection, completion: @escaping (Result<Data, Error>) -> Void) {
        readExact(connection, count: 4) { [weak self, weak connection] result in
            guard let self, let connection, self.streams.values.contains(where: { $0 === connection }), !self.stopped else { return }
            switch result {
            case .failure(let error): completion(.failure(error))
            case .success(let header):
                guard let length = RelayQUICContract.length(header) else { completion(.failure(URLError(.cannotParseResponse))); return }
                self.readExact(connection, count: length, completion: completion)
            }
        }
    }

    private func readExact(_ connection: NWConnection, count: Int, prefix: Data = Data(), completion: @escaping (Result<Data, Error>) -> Void) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: count - prefix.count) { [weak self, weak connection] data, _, complete, error in
            Task { @MainActor in
                guard let self, let connection, self.streams.values.contains(where: { $0 === connection }), !self.stopped else { return }
                var bytes = prefix
                if let data { bytes.append(data) }
                if bytes.count == count { completion(.success(bytes)) }
                else if let error { completion(.failure(error)) }
                else if complete || data?.isEmpty != false { completion(.failure(URLError(.networkConnectionLost))) }
                else { self.readExact(connection, count: count, prefix: bytes, completion: completion) }
            }
        }
    }

    nonisolated func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                                completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        Task { @MainActor in
            guard self.discovery === dataTask, !self.stopped,
                  let http = response as? HTTPURLResponse, http.statusCode == 200,
                  http.url?.host == self.url.host, http.url?.scheme == "https",
                  response.expectedContentLength <= 4096 else {
                completionHandler(.cancel); self.finishDiscovery(nil); return
            }
            completionHandler(.allow)
        }
    }
    nonisolated func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        Task { @MainActor in
            guard self.discovery === dataTask, !self.stopped else { return }
            guard self.discoveryData.count + data.count <= 4096 else { self.finishDiscovery(nil); return }
            self.discoveryData.append(data)
        }
    }
    nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                                newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
    nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        Task { @MainActor in
            if self.discovery === task {
                if error == nil, let root = try? JSONSerialization.jsonObject(with: self.discoveryData) as? [String: Any],
                   let quic = root["quic"] as? [String: Any], quic["historyAlpn"] as? String == "orbis-relay-v3" { self.transportVersion = 3 }
                self.finishDiscovery(error == nil ? RelayQUICContract.port(from: self.discoveryData) : nil)
            }
        }
    }
    nonisolated func urlSession(_ session: URLSession, didBecomeInvalidWithError error: Error?) {
        Task { @MainActor in
            self.discoveryInvalidated = true
            let waiters = self.closeWaiters; self.closeWaiters = []
            waiters.forEach { $0.resume() }
        }
    }
}
