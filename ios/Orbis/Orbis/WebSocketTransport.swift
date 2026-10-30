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
    private var pairingGeneration = UUID()
    private var outbound: [(text: String, channel: String?, completion: ((Error?) -> Void)?)] = []
    private var p2p: P2PTransport?
    var p2pFactory: (([String]) throws -> P2PPeer?) = { try P2PTransport.makeNativePeer(stunServers: $0) }
    private var hasDirectPath: Bool { lan?.isReady == true || p2p?.isReady == true }
    private var lan: LANTransport?
    private var lanEndpoints: [LANEndpoint] = []
    private var activePath: String?
    private let inbound = InboundFrameLanes()
    private var deliveryTask: Task<Void, Never>?
    private var deliveryGeneration = UUID()
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
        disconnect()
        pairing = nil; receiveHandler = nil; stateHandler = nil
        let generation = pairingGeneration
        Task {
            do {
                guard self.pairingGeneration == generation else { throw CancellationError() }
                guard let url = RelayURL.endpoint(qr.relayUrl, path: "v1/pairings", webSocket: false) else { throw PairingError.invalidQR }
                var request = URLRequest(url: url)
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.httpBody = try JSONSerialization.data(withJSONObject: ["code": qr.code, "deviceName": deviceName])
                let (data, response) = try await urlSession().data(for: request)
                guard self.pairingGeneration == generation else { throw CancellationError() }
                guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                    throw PairingError.relay("中继配对失败，请在电脑端重新生成二维码。")
                }
                let body = try E2ECrypto.jsonObject(data)
                guard let deviceId = body["deviceId"] as? String, !deviceId.isEmpty,
                      let secret = body["credential"] as? String, !secret.isEmpty else { throw PairingError.relay("中继返回缺少设备凭据") }
                let pair = try DevicePairingSession.create(qr: qr, deviceId: deviceId, identity: identity)
                let relay = RelayCredential(relayUrl: qr.relayUrl, deviceId: deviceId, credential: secret)
                try await connectPairing(qr: qr, relay: relay, pairingSession: pair)
                guard self.pairingGeneration == generation else { throw CancellationError() }
                completion(.success(HostPairing(hostId: qr.hostId, hostName: qr.hostName, hostPub: qr.hostPub,
                    pskRoot: Base64URL.encode(pair.pskRoot), relay: relay, lan: qr.lan)))
            } catch {
                // An old HTTP/handshake failure cannot close a replacement connection.
                if self.pairingGeneration == generation { disconnect() }
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
        updateLANEndpoints(pairing.lan)
        openSocket()
    }

    func disconnect() {
        pairingGeneration = UUID()
        closeConnection()
    }

    private func closeConnection() {
        reconnect = false
        deliveryGeneration = UUID()
        deliveryTask?.cancel(); deliveryTask = nil
        inbound.clear()
        let oldP2P = p2p; p2p = nil; oldP2P?.close()
        let oldLAN = lan
        lan = nil; lanEndpoints = []; activePath = nil
        oldLAN?.close()
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
        if activePath == "lan", let lan, lan.isReady { return lan.send(object) }
        if activePath == "p2p", let p2p, p2p.isReady { return p2p.send(object) }
        return sendRelay(object)
    }

    private func sendRelay(_ object: [String: Any]) -> Bool {
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
        if !hasDirectPath { stateHandler?(.connecting, nil) }
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
        if !hasDirectPath { stateHandler?(.online, nil) }
        do {
            try enqueueRaw(["type": "device.authenticate", "protocolVersion": orbisProtocolVersion, "credential": credential.credential])
            if let pairingSession { try sendPlain(kind: "pair", body: pairingSession.request) }
            else { try beginHandshake() }
            receive(from: task)
        } catch { socketClosed(task, error: error) }
    }

    @discardableResult
    func sendBinary(_ data: Data) -> Bool {
        if activePath == "lan", let lan, lan.isReady { return lan.sendBinary(data) }
        if activePath == "p2p", let p2p, p2p.isReady { return p2p.sendBinary(data) }
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
        if !hasDirectPath { stateHandler?(.connecting, nil) }
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
            try enqueueText(String(decoding: data, as: UTF8.self), channel: envelope.hdr.ch, completion: index == fragments.count - 1 ? completion : nil)
        }
    }

    private func enqueueRaw(_ body: [String: Any]) throws {
        try enqueueText(String(decoding: E2ECrypto.jsonData(body), as: UTF8.self))
    }

    private func enqueueText(_ text: String, channel: String? = nil, completion: ((Error?) -> Void)? = nil) throws {
        guard socket != nil else { throw PairingError.relay("连接已关闭") }
        guard outboundBytes + text.utf8.count <= maxOutboundBytes else { throw PairingError.relay("发送队列已满，请稍后重试。") }
        outbound.append((text, channel, completion))
        outboundBytes += text.utf8.count
        drainQueue()
    }

    private func drainQueue() {
        guard !isSending, let task = socket, !outbound.isEmpty else { return }
        // Per-channel sequence order stays FIFO. Control frames can pass bulk
        // pieces because each authenticated channel has its own nonce sequence.
        let index = outbound.firstIndex { $0.channel != "bulk" } ?? 0
        let (text, _, completion) = outbound.remove(at: index)
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
            stateHandler?(hasDirectPath ? .secured : .offline, nil)
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
                closeConnection()
            } else if envelope.hdr.k == "hs" {
                guard envelope.hdr.n == 0, let handshake else { return }
                let reply = try handshake.accept(E2ECrypto.jsonObject(Base64URL.decode(envelope.ct, label: "hs.ct")))
                guard let keys = handshake.keys else { throw PairingError.handshake("会话密钥未建立") }
                channel = E2EChannel(keys: keys)
                let establishedChannel = channel
                self.handshake = nil
                // HS3 is queued before the channel becomes available to business sends.
                try sendPlain(kind: "hs", body: reply) { [weak self] error in
                    if let self, error == nil, self.channel === establishedChannel {
                        self.stateHandler?(.secured, nil)
                        // Endpoint refresh is authenticated by the Host; relay
                        // lifecycle plaintext never controls direct dialing.
                        _ = self.sendRelay(["type": "host.lan.request", "protocolVersion": orbisProtocolVersion])
                        self.startP2PIfPossible()
                    }
                }
                timeoutTask?.cancel(); timeoutTask = nil
            } else if let channel, let plain = try channel.open(envelope) {
                switch envelope.hdr.k {
                case "ping":
                    try enqueue(channel.seal(kind: "ping", room: hostId, from: fromId, to: hostId, channel: "ctl", payload: plain))
                case "data":
                    if envelope.hdr.ch == "ctl" {
                        if !handlePathControl(try E2ECrypto.jsonObject(plain)) { deliver(plain, channel: envelope.hdr.ch) }
                    } else { deliver(plain, channel: envelope.hdr.ch) }
                case "bin": deliver(plain, channel: envelope.hdr.ch, binary: true)
                default: break
                }
            }
        } catch {
            if let socket { socketClosed(socket, error: error) }
        }
    }


    private func startP2PIfPossible() {
        guard p2p == nil, let pairing, channel != nil,
              let stun = RelaySTUN.server(pairing.relay.relayUrl),
              let root = try? Base64URL.decodeFixed(pairing.pskRoot, bytes: 32, label: "pskRoot") else { return }
        do {
            guard let peer = try p2pFactory([stun]) else { return }
            let direct = P2PTransport(peer: peer, hostId: hostId, deviceId: fromId, root: root)
            direct.signal = { [weak self, weak direct] message in
                guard let self, let direct, self.p2p === direct else { return false }
                return self.sendRelay(message) // SDP never travels over the Path it is building.
            }
            direct.receive = { [weak self, weak direct] bytes, channel, binary in
                guard let self, let direct, self.p2p === direct else { return }
                if binary { self.deliver(bytes, channel: channel, binary: true) }
                else if channel != "ctl" { self.deliver(bytes, channel: channel) }
                else if let message = try? E2ECrypto.jsonObject(bytes), !self.handlePathControl(message) { self.deliver(bytes, channel: channel) }
            }
            direct.state = { [weak self, weak direct] ready, _ in
                guard let self, let direct, self.p2p === direct else { return }
                if !ready {
                    self.p2p = nil
                    if self.activePath == "p2p" { self.activePath = nil }
                }
                self.stateHandler?(self.hasDirectPath || self.channel != nil ? .secured : .offline, nil)
            }
            p2p = direct; direct.start()
            if !sendRelay(["type": "p2p.request", "protocolVersion": orbisProtocolVersion]) { p2p = nil; direct.close() }
        } catch { /* Native initialization failure is isolated to this optional Path. */ }
    }

    private func updateLANEndpoints(_ endpoints: [LANEndpoint]) {
        guard let pairing, let root = try? Base64URL.decodeFixed(pairing.pskRoot, bytes: 32, label: "pskRoot") else { return }
        var seen = Set<LANEndpoint>()
        let valid = Array(endpoints.filter { LANTransport.url($0) != nil && seen.insert($0).inserted }.prefix(16))
        guard valid != lanEndpoints else { return }
        lanEndpoints = valid
        let old = lan
        lan = nil
        old?.close()
        if activePath == "lan" { activePath = nil }
        guard !valid.isEmpty else { return }
        let direct = LANTransport(endpoints: valid, hostId: hostId, deviceId: fromId, root: root)
        direct.receive = { [weak self, weak direct] data, channel, binary in
            guard let self, let direct, self.lan === direct else { return }
            if binary { self.deliver(data, channel: channel, binary: true) }
            else if channel != "ctl" { self.deliver(data, channel: channel) }
            else if let message = try? E2ECrypto.jsonObject(data), !self.handlePathControl(message) { self.deliver(data, channel: channel) }
        }
        direct.state = { [weak self, weak direct] ready in
            guard let self, let direct, self.lan === direct else { return }
            if !ready, self.activePath == "lan" { self.activePath = nil }
            self.stateHandler?(ready || self.channel != nil || self.p2p?.isReady == true ? .secured : .offline, nil)
        }
        lan = direct
        direct.start()
    }

    /// Only called with plaintext that passed E2E authentication on a Path.
    private func handlePathControl(_ message: [String: Any]) -> Bool {
        switch message["type"] as? String {
        case "host.lan":
            guard message["protocolVersion"] as? Int == orbisProtocolVersion,
                  let rows = message["endpoints"] as? [[String: Any]],
                  let data = try? JSONSerialization.data(withJSONObject: rows),
                  let endpoints = try? JSONDecoder().decode([LANEndpoint].self, from: data) else { return true }
            updateLANEndpoints(endpoints)
            receiveHandler?(["type": "_transport.lan", "endpoints": lanEndpoints], "ctl")
            return true
        case "device.path":
            guard let path = message["path"] as? String, ["lan", "p2p", "relay"].contains(path) else { return true }
            activePath = path
            if path == "p2p", p2p == nil { startP2PIfPossible() }
            receiveHandler?(message, "ctl")
            return true
        case "p2p.offer":
            if message["protocolVersion"] as? Int == orbisProtocolVersion, let sdp = message["sdp"] as? String { p2p?.acceptOffer(sdp) }
            return true
        case "protocol.error":
            if let code = message["code"] as? String, ["p2p_unavailable", "p2p_cooling_down"].contains(code) {
                let old = p2p; p2p = nil; old?.close()
                if activePath == "p2p" { activePath = nil }
                return true // Optional Path failures never tear down Relay/LAN.
            }
            return false
        default: return false
        }
    }

    private func deliver(_ payload: Data, channel: String?, binary: Bool = false) {
        inbound.offer(.init(payload: payload, channel: channel, binary: binary))
        guard deliveryTask == nil else { return }
        let generation = deliveryGeneration
        deliveryTask = Task { [weak self] in
            // Let receiving continue independently from history projection and
            // disk writes; each iteration rechecks control before session/bulk.
            await Task.yield()
            while let self, self.deliveryGeneration == generation, !Task.isCancelled {
                let overflow = self.inbound.drainOverflow()
                if overflow.control > 0 || overflow.session > 0 {
                    self.receiveHandler?(["type": "_transport.overflow", "controlFrames": overflow.control, "sessionFrames": overflow.session], "ctl")
                }
                guard let frame = self.inbound.take() else { self.deliveryTask = nil; return }
                if frame.binary { self.receiveHandler?(["type": "_artifact.chunk", "data": frame.payload], frame.channel) }
                else if let message = try? E2ECrypto.jsonObject(frame.payload) { self.receiveHandler?(message, frame.channel) }
                await Task.yield()
            }
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
        stateHandler?(hasDirectPath ? .secured : .offline, hasDirectPath ? nil : error?.localizedDescription)
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

/// Decrypted frames have already passed replay protection. Dropped session and
/// control frames request source repair; bulk is repaired by range retransmits.
/// Main actor confinement makes admission/accounting atomic with consumption.
final class InboundFrameLanes {
    struct Limits { let frames: Int; let payload: Int }
    struct Frame: Equatable { let payload: Data; let channel: String?; var binary = false }
    private struct Lane {
        var frames: [Frame] = []
        var bytes = 0
        let limits: Limits
        mutating func offer(_ frame: Frame) -> Int {
            var dropped = 0
            while !frames.isEmpty && (frames.count >= limits.frames || bytes + frame.payload.count > limits.payload) {
                bytes -= frames.removeFirst().payload.count
                dropped += 1
            }
            // A single authenticated snapshot can exceed the nominal lane
            // budget. Keep it alone (bounded by envelope reassembly), as Android
            // does, so a legal large snapshot cannot fail every recovery attempt.
            frames.append(frame); bytes += frame.payload.count
            return dropped
        }
        mutating func take() -> Frame? {
            guard !frames.isEmpty else { return nil }
            let frame = frames.removeFirst(); bytes -= frame.payload.count
            return frame
        }
    }
    private var control: Lane
    private var session: Lane
    private var bulk: Lane
    private var droppedControl = 0
    private var droppedSession = 0
    init(control: Limits = .init(frames: 4096, payload: 4 * 1024 * 1024),
         session: Limits = .init(frames: 256, payload: 4 * 1024 * 1024),
         bulk: Limits = .init(frames: 64, payload: 16 * 1024 * 1024)) {
        precondition([control, session, bulk].allSatisfy { $0.frames > 0 && $0.payload > 0 })
        self.control = Lane(limits: control); self.session = Lane(limits: session); self.bulk = Lane(limits: bulk)
    }
    func offer(_ frame: Frame) {
        if frame.binary || frame.channel == "bulk" { _ = bulk.offer(frame) }
        else if frame.channel == "msg" { droppedSession += session.offer(frame) }
        else { droppedControl += control.offer(frame) }
    }
    func take() -> Frame? { control.take() ?? session.take() ?? bulk.take() }
    func drainOverflow() -> (control: Int, session: Int) {
        defer { droppedControl = 0; droppedSession = 0 }
        return (droppedControl, droppedSession)
    }
    func clear() {
        control.frames = []; control.bytes = 0
        session.frames = []; session.bytes = 0
        bulk.frames = []; bulk.bytes = 0
        droppedControl = 0; droppedSession = 0
    }
}

/// One direct Path has independent session keys, sequences and reassembly. The
/// only plaintext it sends is HS1/HS3; Relay credentials never reach a LAN URL.
@MainActor
final class LANTransport: NSObject, URLSessionWebSocketDelegate {
    var receive: ((Data, String?, Bool) -> Void)?
    var state: ((Bool) -> Void)?
    var isReady: Bool { channel != nil }
    private let urls: [URL]
    private let hostId: String
    private let deviceId: String
    private let root: Data
    private var session: URLSession?
    private var socket: URLSessionWebSocketTask?
    private var channel: E2EChannel?
    private var handshake: DeviceHandshake?
    private let pieces = EnvelopeReassembler()
    private var retry: Task<Void, Never>?
    private var timeout: Task<Void, Never>?
    private var heartbeat: Task<Void, Never>?
    private var closed = false
    private var endpointIndex = 0
    private var queue: [(String, String?)] = []
    private var queuedBytes = 0
    private var sending = false
    private let maxQueuedBytes = 4 * 1024 * 1024

    init(endpoints: [LANEndpoint], hostId: String, deviceId: String, root: Data) {
        urls = endpoints.compactMap(Self.url)
        self.hostId = hostId; self.deviceId = deviceId; self.root = root
    }

    static func url(_ endpoint: LANEndpoint) -> URL? {
        let host = endpoint.host
        guard !host.isEmpty, host == host.trimmingCharacters(in: .whitespacesAndNewlines),
              !host.contains(where: { $0.isWhitespace || "/?#@%\\".contains($0) }),
              (1...65535).contains(endpoint.port) else { return nil }
        var components = URLComponents()
        components.scheme = "ws"; components.host = host.contains(":") && !host.hasPrefix("[") ? "[\(host)]" : host; components.port = endpoint.port
        components.path = "/v1/lan"
        guard let url = components.url, url.host != nil else { return nil }
        return url
    }

    func start() { guard !closed, socket == nil, !urls.isEmpty else { return }; open() }
    func close() {
        closed = true
        retry?.cancel(); retry = nil
        timeout?.cancel(); timeout = nil
        heartbeat?.cancel(); heartbeat = nil
        let old = socket; socket = nil
        channel = nil; handshake = nil; queue = []; queuedBytes = 0; sending = false; pieces.clear()
        old?.cancel(with: .goingAway, reason: nil)
        session?.invalidateAndCancel(); session = nil
    }
    @discardableResult func send(_ object: [String: Any]) -> Bool {
        guard let payload = try? E2ECrypto.jsonData(object) else { return false }
        return send(kind: "data", payload: payload, lane: "ctl")
    }
    @discardableResult func sendBinary(_ data: Data) -> Bool { send(kind: "bin", payload: data, lane: "bulk") }
    private func send(kind: String, payload: Data, lane: String) -> Bool {
        guard let channel, queuedBytes + payload.count * 2 + 4096 <= maxQueuedBytes else { return false }
        do { try enqueue(channel.seal(kind: kind, room: hostId, from: deviceId, to: hostId, channel: lane, payload: payload)); return true }
        catch { if let socket { fail(socket) }; return false }
    }
    private func open() {
        guard !closed, !urls.isEmpty else { return }
        if session == nil {
            let config = URLSessionConfiguration.default
            config.timeoutIntervalForRequest = 4
            session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        }
        // Host serves WS; the direct path authenticates and encrypts via E2E.
        // Info.plist permits literal IPs, including public campus addresses.
        let task = session!.webSocketTask(with: urls[endpointIndex])
        task.maximumMessageSize = 2 * 1024 * 1024
        socket = task; handshake = DeviceHandshake(pskRoot: root)
        task.resume()
        timeout = Task { [weak self, weak task] in
            do { try await Task.sleep(nanoseconds: 4_000_000_000) } catch { return }
            guard let self, let task, self.socket === task else { return }
            self.fail(task)
        }
    }
    nonisolated func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        Task { @MainActor [weak self] in
            guard let self, self.socket === webSocketTask, let handshake = self.handshake else { return }
            do { try self.sendHandshake(handshake.hs1()); self.read(webSocketTask) }
            catch { self.fail(webSocketTask) }
        }
    }
    nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let task = task as? URLSessionWebSocketTask else { return }
        Task { @MainActor [weak self] in self?.fail(task) }
    }
    nonisolated func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        Task { @MainActor [weak self] in self?.fail(webSocketTask) }
    }
    private func sendHandshake(_ body: [String: Any]) throws {
        try enqueue(Envelope(v: 2, hdr: RoutingHeader(k: "hs", room: hostId, from: deviceId, to: hostId, n: 0, ch: nil), ct: Base64URL.encode(E2ECrypto.jsonData(body))))
    }
    private func enqueue(_ envelope: Envelope) throws {
        guard socket != nil else { throw PairingError.relay("局域网连接已关闭") }
        let frames = try EnvelopePieces.fragment(envelope).map { piece in
            String(decoding: try JSONEncoder().encode(V2Frame(type: "v2.frame", protocolVersion: orbisProtocolVersion, envelope: piece)), as: UTF8.self)
        }
        let cost = frames.reduce(0) { $0 + $1.utf8.count }
        guard queuedBytes + cost <= maxQueuedBytes else { throw PairingError.relay("局域网发送队列已满") }
        queue.append(contentsOf: frames.map { ($0, envelope.hdr.ch) }); queuedBytes += cost
        drain()
    }
    private func drain() {
        guard !sending, let task = socket, !queue.isEmpty else { return }
        let index = queue.firstIndex { $0.1 != "bulk" } ?? 0
        let (text, _) = queue.remove(at: index); queuedBytes -= text.utf8.count; sending = true
        task.send(.string(text)) { [weak self, weak task] error in
            Task { @MainActor in
                guard let self, let task, self.socket === task else { return }
                self.sending = false
                if error != nil { self.fail(task) } else { self.drain() }
            }
        }
    }
    private func read(_ task: URLSessionWebSocketTask) {
        task.receive { [weak self, weak task] result in
            Task { @MainActor in
                guard let self, let task, self.socket === task else { return }
                do {
                    let message = try result.get()
                    let data: Data
                    switch message {
                    case .string(let text): data = Data(text.utf8)
                    case .data(let bytes): data = bytes
                    @unknown default: self.read(task); return
                    }
                    let frame = try JSONDecoder().decode(V2Frame.self, from: data)
                    guard frame.type == "v2.frame", frame.protocolVersion == orbisProtocolVersion,
                          frame.envelope.v == 2, frame.envelope.hdr.room == self.hostId,
                          frame.envelope.hdr.from == self.hostId, frame.envelope.hdr.to == self.deviceId else { throw PairingError.invalidQR }
                    if let envelope = self.pieces.accept(frame.envelope) { try self.handle(envelope) }
                    if self.socket === task { self.read(task) }
                } catch { self.fail(task) }
            }
        }
    }
    private func handle(_ envelope: Envelope) throws {
        if envelope.hdr.k == "hs" {
            guard envelope.hdr.n == 0, channel == nil, let handshake else { throw PairingError.handshake("局域网握手状态无效") }
            let reply = try handshake.accept(E2ECrypto.jsonObject(Base64URL.decode(envelope.ct)))
            guard let keys = handshake.keys else { throw PairingError.handshake("局域网密钥未建立") }
            try sendHandshake(reply)
            channel = E2EChannel(keys: keys); self.handshake = nil
            timeout?.cancel(); timeout = nil
            endpointIndex = 0
            state?(true)
            armHeartbeat()
        } else {
            guard let channel else { throw PairingError.handshake("局域网握手尚未完成") }
            guard let bytes = try channel.open(envelope) else { return }
            switch envelope.hdr.k {
            case "ping": try enqueue(channel.seal(kind: "ping", room: hostId, from: deviceId, to: hostId, channel: "ctl", payload: bytes))
            case "data": receive?(bytes, envelope.hdr.ch, false)
            case "bin": receive?(bytes, envelope.hdr.ch, true)
            default: break
            }
        }
    }
    private func armHeartbeat() {
        heartbeat?.cancel()
        heartbeat = Task { [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(nanoseconds: 10_000_000_000) } catch { return }
                guard let self, let socket = self.socket else { return }
                socket.sendPing { [weak self, weak socket] error in
                    Task { @MainActor in if let self, let socket, error != nil { self.fail(socket) } }
                }
            }
        }
    }
    private func fail(_ task: URLSessionWebSocketTask) {
        guard socket === task, !closed else { return }
        let wasReady = isReady
        socket = nil; channel = nil; handshake = nil; pieces.clear()
        queue = []; queuedBytes = 0; sending = false
        timeout?.cancel(); timeout = nil
        heartbeat?.cancel(); heartbeat = nil
        task.cancel(with: .goingAway, reason: nil)
        if wasReady { state?(false) }
        endpointIndex = wasReady ? 0 : (endpointIndex + 1) % urls.count
        let delay: UInt64 = endpointIndex == 0 ? 5_000_000_000 : 0
        retry?.cancel()
        retry = Task { [weak self] in
            do { if delay > 0 { try await Task.sleep(nanoseconds: delay) } } catch { return }
            guard let self, !self.closed, self.socket == nil else { return }
            self.open()
        }
    }
}
