import Foundation

@MainActor
protocol OrbisTransport: AnyObject {
    func pair(qr: PairingQR, deviceName: String, identity: DeviceIdentity, completion: @escaping (Result<HostPairing, Error>) -> Void)
    func connect(pairing: HostPairing, identity: DeviceIdentity, receive: @escaping ([String: Any], String?) -> Void, state: @escaping (ConnectionState, String?) -> Void)
    func disconnect()
    @discardableResult func send(_ object: [String: Any]) -> Bool
    @discardableResult func sendBinary(_ data: Data) -> Bool
}

extension OrbisTransport {
    @discardableResult func sendBinary(_ data: Data) -> Bool { false }
}

/// All connection state is confined to the main actor. URLSession callbacks
/// hop here before touching keys, continuations, queues or connection identity.
@MainActor
final class RelayTransport: NSObject, OrbisTransport, URLSessionWebSocketDelegate {
    private var session: URLSession?
    private var socket: URLSessionWebSocketTask?
    private var credential: RelayCredential?
    private var pairing: HostPairing?
    private var identity: DeviceIdentity?
    private var pairingSession: DevicePairingSession?
    private var handshake: DeviceHandshake?
    private var channel: E2EChannel?
    private let pieces = EnvelopeReassembler()
    private var receiveHandler: (([String: Any], String?) -> Void)?
    private var stateHandler: ((ConnectionState, String?) -> Void)?
    private var fromId = ""
    private var hostId = ""
    private var reconnect = false
    private var reconnectTask: Task<Void, Never>?
    private var timeoutTask: Task<Void, Never>?
    private var pairingContinuation: CheckedContinuation<Void, Error>?
    private var outbound: [(String, ((Error?) -> Void)?)] = []
    private var isSending = false
    private var outboundBytes = 0
    private let maxOutboundBytes = 4 * 1024 * 1024

    private func urlSession() -> URLSession {
        if let session { return session }
        let configuration = URLSessionConfiguration.default
        configuration.waitsForConnectivity = true
        configuration.timeoutIntervalForRequest = 20
        let value = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        session = value
        return value
    }

    func pair(qr: PairingQR, deviceName: String, identity: DeviceIdentity, completion: @escaping (Result<HostPairing, Error>) -> Void) {
        Task {
            do {
                guard let url = RelayURL.endpoint(qr.relayUrl, path: "v1/pairings", webSocket: false) else { throw PairingError.invalidQR }
                var request = URLRequest(url: url)
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.httpBody = try JSONSerialization.data(withJSONObject: ["code": qr.code, "deviceName": deviceName])
                let (data, response) = try await urlSession().data(for: request)
                guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                    throw PairingError.relay("中继配对失败，请在电脑端重新生成二维码。")
                }
                let body = try E2ECrypto.jsonObject(data)
                guard let deviceId = body["deviceId"] as? String, !deviceId.isEmpty,
                      let secret = body["credential"] as? String, !secret.isEmpty else { throw PairingError.relay("中继返回缺少设备凭据") }
                let pair = try DevicePairingSession.create(qr: qr, deviceId: deviceId, identity: identity)
                let relay = RelayCredential(relayUrl: qr.relayUrl, deviceId: deviceId, credential: secret)
                try await connectPairing(qr: qr, relay: relay, pairingSession: pair)
                completion(.success(HostPairing(hostId: qr.hostId, hostName: qr.hostName, hostPub: qr.hostPub,
                    pskRoot: Base64URL.encode(pair.pskRoot), relay: relay, lan: qr.lan)))
            } catch {
                disconnect()
                completion(.failure(error))
            }
        }
    }

    func connect(pairing: HostPairing, identity: DeviceIdentity, receive: @escaping ([String: Any], String?) -> Void, state: @escaping (ConnectionState, String?) -> Void) {
        disconnect()
        self.pairing = pairing
        credential = pairing.relay
        self.identity = identity
        receiveHandler = receive
        stateHandler = state
        hostId = pairing.hostId
        fromId = pairing.relay.deviceId
        reconnect = true
        openSocket()
    }

    func disconnect() {
        reconnect = false
        reconnectTask?.cancel(); reconnectTask = nil
        timeoutTask?.cancel(); timeoutTask = nil
        let pending = pairingContinuation
        pairingContinuation = nil
        pending?.resume(throwing: PairingError.relay("配对连接已关闭"))
        let oldSocket = socket
        socket = nil
        oldSocket?.cancel(with: .goingAway, reason: nil)
        session?.invalidateAndCancel(); session = nil
        resetChannel()
        pairingSession = nil
    }

    private func resetChannel() {
        channel = nil
        handshake = nil
        pieces.clear()
        outbound.removeAll()
        outboundBytes = 0
        // An in-flight send finishes before the new handshake queue is drained.
        // Keep isSending true until that callback returns on the same socket.
        if socket == nil { isSending = false }
    }

    @discardableResult
    func send(_ object: [String: Any]) -> Bool {
        guard socket != nil, let channel else { return false }
        do {
            let payload = try E2ECrypto.jsonData(object)
            guard outboundBytes + payload.count * 2 + 4096 <= maxOutboundBytes else {
                throw PairingError.relay("发送队列已满，请稍后重试。")
            }
            let envelope = try channel.seal(room: hostId, from: fromId, to: hostId, channel: "ctl", payload: payload)
            try enqueue(envelope)
            return true
        } catch {
            stateHandler?(.error, error.localizedDescription)
            return false
        }
    }

    private func openSocket() {
        guard let credential, let url = RelayURL.endpoint(credential.relayUrl, path: "v1/device", webSocket: true) else {
            stateHandler?(.error, "中继地址无效，请重新配对。")
            return
        }
        stateHandler?(.connecting, nil)
        let task = urlSession().webSocketTask(with: URLRequest(url: url))
        task.maximumMessageSize = 2 * 1024 * 1024
        socket = task
        task.resume()
    }

    private func connectPairing(qr: PairingQR, relay: RelayCredential, pairingSession: DevicePairingSession) async throws {
        hostId = qr.hostId
        fromId = relay.deviceId
        credential = relay
        self.pairingSession = pairingSession
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            self.pairingContinuation = continuation
            self.armTimeout(message: "配对等待超时，请重新扫描二维码。")
            self.openSocket()
        }
    }

    nonisolated func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        Task { @MainActor [weak self] in self?.socketOpened(webSocketTask) }
    }

    nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let task = task as? URLSessionWebSocketTask else { return }
        Task { @MainActor [weak self] in self?.socketClosed(task, error: error) }
    }

    nonisolated func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        Task { @MainActor [weak self] in self?.socketClosed(webSocketTask, error: nil) }
    }

    private func socketOpened(_ task: URLSessionWebSocketTask) {
        guard socket === task, let credential else { return }
        stateHandler?(.online, nil)
        do {
            try enqueueRaw(["type": "device.authenticate", "protocolVersion": orbisProtocolVersion, "credential": credential.credential])
            if let pairingSession { try sendPlain(kind: "pair", body: pairingSession.request) }
            else { try beginHandshake() }
            receive(from: task)
        } catch { socketClosed(task, error: error) }
    }

    @discardableResult
    func sendBinary(_ data: Data) -> Bool {
        guard socket != nil, let channel else { return false }
        do {
            guard outboundBytes + data.count * 2 + 4096 <= maxOutboundBytes else { return false }
            try enqueue(channel.seal(kind: "bin", room: hostId, from: fromId, to: hostId, channel: "bulk", payload: data))
            return true
        } catch { return false }
    }

    private func beginHandshake() throws {
        guard let pairing else { return }
        resetChannel()
        let root = try Base64URL.decodeFixed(pairing.pskRoot, bytes: 32, label: "pskRoot")
        let value = DeviceHandshake(pskRoot: root)
        handshake = value
        stateHandler?(.connecting, nil)
        try sendPlain(kind: "hs", body: value.hs1())
        armTimeout(message: "电脑端安全握手未响应，正在重新连接。")
    }

    private func sendPlain(kind: String, body: [String: Any], completion: ((Error?) -> Void)? = nil) throws {
        let header = RoutingHeader(k: kind, room: hostId, from: fromId, to: hostId, n: 0, ch: nil)
        try enqueue(Envelope(v: 2, hdr: header, ct: Base64URL.encode(try E2ECrypto.jsonData(body))), completion: completion)
    }

    private func enqueue(_ envelope: Envelope, completion: ((Error?) -> Void)? = nil) throws {
        let fragments = EnvelopePieces.fragment(envelope)
        for (index, fragment) in fragments.enumerated() {
            let frame = V2Frame(type: "v2.frame", protocolVersion: orbisProtocolVersion, envelope: fragment)
            let data = try JSONEncoder().encode(frame)
            try enqueueText(String(decoding: data, as: UTF8.self), completion: index == fragments.count - 1 ? completion : nil)
        }
    }

    private func enqueueRaw(_ body: [String: Any]) throws {
        try enqueueText(String(decoding: E2ECrypto.jsonData(body), as: UTF8.self))
    }

    private func enqueueText(_ text: String, completion: ((Error?) -> Void)? = nil) throws {
        guard socket != nil else { throw PairingError.relay("连接已关闭") }
        guard outboundBytes + text.utf8.count <= maxOutboundBytes else { throw PairingError.relay("发送队列已满，请稍后重试。") }
        outbound.append((text, completion))
        outboundBytes += text.utf8.count
        drainQueue()
    }

    private func drainQueue() {
        guard !isSending, let task = socket, !outbound.isEmpty else { return }
        let (text, completion) = outbound.removeFirst()
        outboundBytes -= text.utf8.count
        isSending = true
        task.send(.string(text)) { [weak self, weak task] error in
            Task { @MainActor in
                guard let self, let task, self.socket === task else { return }
                self.isSending = false
                completion?(error)
                if let error { self.socketClosed(task, error: error) }
                else { self.drainQueue() }
            }
        }
    }

    private func receive(from task: URLSessionWebSocketTask) {
        task.receive { [weak self, weak task] result in
            Task { @MainActor in
                guard let self, let task, self.socket === task else { return }
                switch result {
                case .failure(let error): self.socketClosed(task, error: error)
                case .success(let message):
                    switch message {
                    case .string(let text): self.handle(text)
                    case .data(let data): if let text = String(data: data, encoding: .utf8) { self.handle(text) }
                    @unknown default: break
                    }
                    if self.socket === task { self.receive(from: task) }
                }
            }
        }
    }

    private func handle(_ text: String) {
        guard let data = text.data(using: .utf8), let outer = try? E2ECrypto.jsonObject(data), let type = outer["type"] as? String else { return }
        if type == "host.online", outer["hostId"] as? String == hostId, pairing != nil {
            do { try beginHandshake() } catch { if let socket { socketClosed(socket, error: error) } }
            return
        }
        if type == "host.offline", outer["hostId"] as? String == hostId {
            timeoutTask?.cancel(); timeoutTask = nil
            resetChannel()
            stateHandler?(.offline, nil)
            return
        }
        if type == "protocol.error" {
            receiveHandler?(outer, nil)
            if let pending = pairingContinuation {
                pairingContinuation = nil
                pending.resume(throwing: PairingError.relay(outer["message"] as? String ?? "配对认证失败"))
                disconnect()
            }
            return
        }
        // Relay's plaintext device.ready is an authentication receipt, not Host state.
        guard type == "v2.frame", let frame = try? JSONDecoder().decode(V2Frame.self, from: data),
              frame.protocolVersion == orbisProtocolVersion, frame.envelope.v == 2,
              frame.envelope.hdr.room == hostId, frame.envelope.hdr.from == hostId, frame.envelope.hdr.to == fromId,
              let envelope = pieces.accept(frame.envelope) else { return }
        do {
            if envelope.hdr.k == "pair" {
                guard envelope.hdr.n == 0, let pairingSession else { return }
                try pairingSession.verifyAccept(E2ECrypto.jsonObject(Base64URL.decode(envelope.ct, label: "pair.ct")), expectedHostId: hostId)
                let pending = pairingContinuation
                pairingContinuation = nil
                pending?.resume()
                disconnect()
            } else if envelope.hdr.k == "hs" {
                guard envelope.hdr.n == 0, let handshake else { return }
                let reply = try handshake.accept(E2ECrypto.jsonObject(Base64URL.decode(envelope.ct, label: "hs.ct")))
                guard let keys = handshake.keys else { throw PairingError.handshake("会话密钥未建立") }
                channel = E2EChannel(keys: keys)
                let establishedChannel = channel
                self.handshake = nil
                // HS3 is queued before the channel becomes available to business sends.
                try sendPlain(kind: "hs", body: reply) { [weak self] error in
                    if let self, error == nil, self.channel === establishedChannel { self.stateHandler?(.secured, nil) }
                }
                timeoutTask?.cancel(); timeoutTask = nil
            } else if let channel, let plain = try channel.open(envelope) {
                switch envelope.hdr.k {
                case "ping":
                    try enqueue(channel.seal(kind: "ping", room: hostId, from: fromId, to: hostId, channel: "ctl", payload: plain))
                case "data": receiveHandler?(try E2ECrypto.jsonObject(plain), envelope.hdr.ch)
                case "bin": receiveHandler?(["type": "_artifact.chunk", "data": plain], envelope.hdr.ch)
                default: break
                }
            }
        } catch {
            if let socket { socketClosed(socket, error: error) }
        }
    }

    private func armTimeout(message: String) {
        timeoutTask?.cancel()
        timeoutTask = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 20_000_000_000) } catch { return }
            guard let self, let socket = self.socket else { return }
            self.socketClosed(socket, error: PairingError.relay(message))
        }
    }

    private func socketClosed(_ task: URLSessionWebSocketTask, error: Error?) {
        guard socket === task else { return }
        socket = nil
        task.cancel(with: .goingAway, reason: nil)
        timeoutTask?.cancel(); timeoutTask = nil
        resetChannel()
        let pending = pairingContinuation
        pairingContinuation = nil
        pending?.resume(throwing: error ?? PairingError.relay("配对连接已关闭"))
        stateHandler?(.offline, error?.localizedDescription)
        guard reconnect, pairing != nil else { return }
        reconnectTask?.cancel()
        reconnectTask = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 2_000_000_000) } catch { return }
            guard let self, self.reconnect, self.socket == nil else { return }
            self.openSocket()
        }
    }
}

enum RelayURL {
    static func isSupported(_ value: String) -> Bool {
        guard let url = URLComponents(string: value), let hostValue = url.host?.lowercased(),
              !hostValue.isEmpty,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              let scheme = url.scheme?.lowercased(), ["ws", "wss"].contains(scheme),
              url.port.map({ (1...65535).contains($0) }) ?? true else { return false }
        let host = hostValue.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        if scheme == "wss" { return true }
        if host == "localhost" || host == "::1" || host.hasSuffix(".local") { return true }
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return false }
        let octets = parts.compactMap { Int($0) }
        guard octets.count == 4, octets.allSatisfy({ (0...255).contains($0) }) else { return false }
        return octets[0] == 10 || octets[0] == 127 || (octets[0] == 192 && octets[1] == 168) ||
            (octets[0] == 172 && (16...31).contains(octets[1])) || (octets[0] == 169 && octets[1] == 254)
    }

    static func endpoint(_ base: String, path: String, webSocket: Bool) -> URL? {
        guard isSupported(base), var parts = URLComponents(string: base) else { return nil }
        let secure = parts.scheme?.lowercased() == "wss"
        parts.scheme = webSocket ? (secure ? "wss" : "ws") : (secure ? "https" : "http")
        // Reverse-proxy deployments mount Relay under a prefix such as /relay.
        // Keep that prefix (including encoded path separators) on every request.
        let prefix = parts.percentEncodedPath.replacingOccurrences(of: "/+$", with: "", options: .regularExpression)
        parts.percentEncodedPath = prefix + "/" + path
        return parts.url
    }
}
