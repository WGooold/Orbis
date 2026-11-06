import Foundation

struct OutboundJSONObject: @unchecked Sendable {
    let value: [String: Any]
    /// Count JSON bytes without constructing JSON on the UI actor. Escapes are charged where
    /// they occur, so ordinary long messages retain the existing payload admission budget.
    var reservation: Int {
        let limit = 4 * 1024 * 1024
        func size(_ value: Any) -> Int {
            if let text = value as? String {
                var count = 2
                for scalar in text.unicodeScalars {
                    switch scalar.value {
                    case 8, 9, 10, 12, 13, 34, 47, 92: count += 2
                    case 0..<32, 0x2028, 0x2029: count += 6
                    case 0..<0x80: count += 1
                    case 0..<0x800: count += 2
                    case 0..<0x10000: count += 3
                    default: count += 4
                    }
                    if count >= limit { return limit }
                }
                return count
            }
            if let object = value as? [String: Any] {
                var count = 2
                for (key, value) in object {
                    count += size(key) + size(value) + 2
                    if count >= limit { return limit }
                }
                return count
            }
            if let array = value as? [Any] {
                var count = 2
                for value in array {
                    count += size(value) + 1
                    if count >= limit { return limit }
                }
                return count
            }
            return 64
        }
        return size(value) * 2 + 4096
    }
}

/// Owns the mutable E2E send sequence and all JSON / AEAD / frame encoding off MainActor.
actor OutboundFrameEncoder {
    private var generation: UUID?
    private var channel: E2EChannel?
    private let beforeEncode: (@Sendable () -> Void)?

    init(beforeEncode: (@Sendable () -> Void)? = nil) { self.beforeEncode = beforeEncode }

    func encode(object: OutboundJSONObject? = nil, bytes: Data? = nil, kind: String = "data", lane: String,
                room: String, from: String, to: String, keys: SessionKeys, generation: UUID) throws -> [String] {
        if self.generation != generation {
            self.generation = generation
            channel = E2EChannel(keys: keys)
        }
        beforeEncode?()
        guard let channel else { throw PairingError.handshake(L10n.tr("会话密钥未建立")) }
        let payload: Data
        if let object { payload = try E2ECrypto.jsonData(object.value) }
        else if let bytes { payload = bytes }
        else { throw PairingError.relay(L10n.tr("发送内容为空")) }
        let envelope = try channel.seal(kind: kind, room: room, from: from, to: to, channel: lane, payload: payload)
        return try EnvelopePieces.fragment(envelope).map { piece in
            let frame = V2Frame(type: "v2.frame", protocolVersion: orbisProtocolVersion, envelope: piece)
            return String(decoding: try JSONEncoder().encode(frame), as: UTF8.self)
        }
    }
}

/// Preserves invocation order while encoding on a worker. Reset generations invalidate queued
/// work after reconnect/path replacement, and admission stays bounded by item count.
@MainActor
private final class OutboundEncodingQueue {
    private let encoder = OutboundFrameEncoder()
    private var tail: Task<Void, Never>?
    private var tailID: UUID?
    private var pending = 0
    private var reservedBytes = 0
    private let limit = 64

    func submit(object: OutboundJSONObject? = nil, bytes: Data? = nil, kind: String = "data", lane: String,
                room: String, from: String, to: String, keys: SessionKeys, generation: UUID,
                availableBytes: Int,
                isCurrent: @escaping @MainActor () -> Bool,
                completion: @escaping @MainActor (Result<[String], Error>) -> Void) -> Bool {
        let reservation = object?.reservation ?? ((bytes?.count ?? 0) * 2 + 4096)
        guard pending < limit, reservation <= availableBytes - reservedBytes else { return false }
        pending += 1
        reservedBytes += reservation
        let prior = tail
        let id = UUID()
        let encoder = self.encoder
        let task = Task { @MainActor [weak self] in
            await prior?.value
            if Task.isCancelled || !isCurrent() {
                self?.pending -= 1
            } else {
                do {
                    let frames = try await encoder.encode(object: object, bytes: bytes, kind: kind, lane: lane,
                        room: room, from: from, to: to, keys: keys, generation: generation)
                    if isCurrent() { completion(.success(frames)) }
                } catch {
                    if isCurrent() { completion(.failure(error)) }
                }
                self?.pending -= 1
            }
            self?.reservedBytes -= reservation
            if self?.tailID == id { self?.tail = nil; self?.tailID = nil }
        }
        tail = task
        tailID = id
        return true
    }
}

@MainActor
protocol OrbisTransport: AnyObject {
    /// Valid only during receive; the authenticated wire bytes avoid re-encoding large events.
    var receivedPayload: Data? { get }
    func pair(qr: PairingQR, deviceName: String, identity: DeviceIdentity, completion: @escaping (Result<HostPairing, Error>) -> Void)
    func connect(pairing: HostPairing, identity: DeviceIdentity, receive: @escaping ([String: Any], String?) -> Void, state: @escaping (ConnectionState, String?) -> Void)
    func disconnect()
    @discardableResult func send(_ object: [String: Any]) -> Bool
    @discardableResult func sendBinary(_ data: Data) -> Bool
    func setRelayTransportMode(_ mode: RelayTransportMode)
}

extension OrbisTransport {
    var receivedPayload: Data? { nil }
    @discardableResult func sendBinary(_ data: Data) -> Bool { false }
    func setRelayTransportMode(_ mode: RelayTransportMode) {}
}

/// One instance per path/handshake generation. No mutable cipher or reassembly state crosses
/// actors; the outbound encoder retains its own send sequence. JSONSerialization's
/// immutable containers are transferred once and never mutated by this worker after return.
actor InboundFrameDecoder {
    enum Decoded: @unchecked Sendable {
        case control([String: Any])
        case handshake(Envelope)
        case authenticated(RoutingHeader, Data, [String: Any]?)
    }
    private let pieces = EnvelopeReassembler()
    private var channel: E2EChannel?
    private var authenticatedLanes = Set<String>()
    private var rejectedBytes: [String: Int] = [:]
    private let beforeDecode: (@Sendable () -> Void)?
    init(beforeDecode: (@Sendable () -> Void)? = nil) { self.beforeDecode = beforeDecode }

    func decode(_ message: RelayMessage, hostId: String, deviceId: String,
                keys: SessionKeys?, relay: Bool, allowPriorSession: Bool = false) throws -> Decoded? {
        beforeDecode?()
        let data: Data
        switch message {
        case .string(let text): data = Data(text.utf8)
        case .data(let bytes): data = bytes
        }
        guard let frame = try? JSONDecoder().decode(V2Frame.self, from: data) else {
            if relay {
                guard let object = try? E2ECrypto.jsonObject(data), object["type"] as? String != "v2.frame" else { return nil }
                return .control(object)
            }
            throw PairingError.invalidQR
        }
        guard frame.type == "v2.frame", frame.protocolVersion == orbisProtocolVersion, frame.envelope.v == 2,
              frame.envelope.hdr.room == hostId, frame.envelope.hdr.from == hostId, frame.envelope.hdr.to == deviceId else {
            if relay { return nil }
            throw PairingError.invalidQR
        }
        guard let envelope = pieces.accept(frame.envelope) else { return nil }
        if ["pair", "hs"].contains(envelope.hdr.k) { return .handshake(envelope) }
        if channel == nil, let keys { channel = E2EChannel(keys: keys) }
        guard let channel else {
            if relay { return nil }
            throw PairingError.handshake(L10n.tr("局域网握手尚未完成"))
        }
        let payload: Data
        do {
            guard let opened = try channel.open(envelope) else { return nil }
            payload = opened
            if let lane = envelope.hdr.ch { authenticatedLanes.insert(lane) }
        } catch let error as E2ECryptoError {
            // Independent streams may still contain ciphertext accepted before
            // HS2. Only AEAD rejection before the first valid frame of this lane
            // is eligible. Authentication failure never advances the high-water mark.
            let lane = envelope.hdr.ch ?? ""
            let limit = ["ctl": 8, "msg": 40, "bulk": 72, "history": 40, "catchup": 40][lane, default: 0] * 1024 * 1024
            let total = rejectedBytes[lane, default: 0] + envelope.ct.utf8.count
            guard relay, allowPriorSession, error.authenticationFailure,
                  !authenticatedLanes.contains(lane), total <= limit else { throw error }
            rejectedBytes[lane] = total
            return nil
        }
        var object: [String: Any]?
        if envelope.hdr.k == "data" {
            if relay && envelope.hdr.ch == "ctl" { object = try E2ECrypto.jsonObject(payload) }
            else { object = try? E2ECrypto.jsonObject(payload) }
        }
        return .authenticated(envelope.hdr, payload, object)
    }
}

/// All connection state is confined to the main actor. URLSession callbacks
/// hop here before touching keys, continuations, queues or connection identity.
@MainActor
final class RelayTransport: NSObject, OrbisTransport {
    typealias SocketFactory = (URL, RelayTransportMode, @escaping (any RelaySocketConnection) -> Void, @escaping (any RelaySocketConnection, Error?) -> Void) -> any RelaySocketConnection
    private var session: URLSession?
    private var socket: (any RelaySocketConnection)?
    private var candidate: (any RelaySocketConnection)?
    private var switchTask: Task<Void, Never>?
    private var retirement: Task<Void, Never>?
    private var retirementID = UUID()
    private var retirementPending = false
    private var switchAttempt = UUID()
    private let initialMode: RelayTransportMode?
    private let preferences: UserDefaults?
    private let makeSocket: SocketFactory
    private(set) var desiredRelayMode: RelayTransportMode = .ws
    private(set) var relaySwitchPhase = "idle"
    private(set) var relaySwitchError: String?
    var relayTransportKind: RelayTransportKind? { socket?.kind }
    private var bootstrapReady = false
    private var credential: RelayCredential?
    private var pairing: HostPairing?
    private var identity: DeviceIdentity?
    private var pairingSession: DevicePairingSession?
    private var handshake: DeviceHandshake?
    private var channel: E2EChannel?
    private var decoder = InboundFrameDecoder()
    private(set) var receivedPayload: Data?
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
    private var hasDirectPath: Bool { lan?.isReady == true }
    private var lan: LANTransport?
    private var lanEndpoints: [LANEndpoint] = []
    private var activePath: String?
    private let inbound = InboundFrameLanes()
    private var deliveryTask: Task<Void, Never>?
    private var deliveryGeneration = UUID()
    private var sendingLanes = Set<RelayLane>()
    private var outboundGeneration = UUID()
    private let outboundEncoding = OutboundEncodingQueue()
    private var outboundBytes = 0
    private let maxOutboundBytes = 4 * 1024 * 1024

    init(relayMode: RelayTransportMode? = nil, preferences: UserDefaults? = .standard, makeSocket: SocketFactory? = nil) {
        self.initialMode = relayMode
        self.preferences = preferences
        self.makeSocket = makeSocket ?? { url, mode, opened, closed in RelaySocket(url: url, mode: mode, onOpen: opened, onClose: closed) }
        super.init()
    }

    private func urlSession() -> URLSession {
        if let session { return session }
        let configuration = URLSessionConfiguration.default
        configuration.waitsForConnectivity = true
        configuration.timeoutIntervalForRequest = 20
        let value = URLSession(configuration: configuration)
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
                    throw PairingError.relay(L10n.tr("中继配对失败，请在电脑端重新生成二维码。"))
                }
                let body = try E2ECrypto.jsonObject(data)
                guard let deviceId = body["deviceId"] as? String, !deviceId.isEmpty,
                      let secret = body["credential"] as? String, !secret.isEmpty else { throw PairingError.relay(L10n.tr("中继返回缺少设备凭据")) }
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
        desiredRelayMode = initialMode ?? preferences?.string(forKey: modeKey).flatMap(RelayTransportMode.init(rawValue:)) ?? .ws
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
        switchAttempt = UUID()
        candidate?.cancel(); candidate = nil
        switchTask?.cancel(); switchTask = nil
        relaySwitchPhase = "idle"
        deliveryGeneration = UUID()
        deliveryTask?.cancel(); deliveryTask = nil
        inbound.clear()
        let oldLAN = lan
        lan = nil; lanEndpoints = []; activePath = nil
        oldLAN?.close()
        reconnectTask?.cancel(); reconnectTask = nil
        timeoutTask?.cancel(); timeoutTask = nil
        let pending = pairingContinuation
        pairingContinuation = nil
        pending?.resume(throwing: PairingError.relay(L10n.tr("配对连接已关闭")))
        let oldSocket = socket
        socket = nil
        _ = retire(oldSocket)
        session?.invalidateAndCancel(); session = nil
        resetChannel()
        pairingSession = nil
    }

    private func resetChannel() {
        bootstrapReady = false
        socket?.setBusinessReady(false)
        outboundGeneration = UUID()
        channel = nil
        handshake = nil
        decoder = InboundFrameDecoder()
        outbound.removeAll()
        outboundBytes = 0
        // An in-flight send finishes before the new handshake queue is drained.
        // Keep busy lane slots until callbacks return on the same socket.
        if socket == nil { sendingLanes.removeAll() }
    }

    @discardableResult
    func send(_ object: [String: Any]) -> Bool {
        if activePath == "lan", let lan, lan.isReady { return lan.send(object) }
        return sendRelay(object)
    }

    private func sendRelay(_ object: [String: Any]) -> Bool {
        guard socket != nil, bootstrapReady, let channel else { return false }
        return queueEncrypted(object, keys: channel.keys)
    }

    private func queueEncrypted(_ object: [String: Any], keys: SessionKeys? = nil) -> Bool {
        guard let keys = keys ?? channel?.keys, socket != nil else { return false }
        let generation = outboundGeneration
        return outboundEncoding.submit(object: OutboundJSONObject(value: object), lane: "ctl", room: hostId,
            from: fromId, to: hostId, keys: keys, generation: generation,
            availableBytes: maxOutboundBytes - outboundBytes,
            isCurrent: { [weak self] in self?.socket != nil && self?.outboundGeneration == generation },
            completion: { [weak self] result in
                guard let self, self.outboundGeneration == generation else { return }
                switch result {
                case .success(let frames):
                    self.enqueueEncoded(frames, lane: "ctl")
                case .failure(let error):
                    self.failOutbound(error)
                }
            })
    }

    private func queueEncrypted(_ data: Data, kind: String, lane: String) -> Bool {
        guard let channel, socket != nil, data.count * 2 + 4096 <= maxOutboundBytes else { return false }
        let generation = outboundGeneration
        return outboundEncoding.submit(bytes: data, kind: kind, lane: lane, room: hostId,
            from: fromId, to: hostId, keys: channel.keys, generation: generation,
            availableBytes: maxOutboundBytes - outboundBytes,
            isCurrent: { [weak self] in self?.socket != nil && self?.outboundGeneration == generation },
            completion: { [weak self] result in
                guard let self, self.outboundGeneration == generation else { return }
                switch result {
                case .success(let frames): self.enqueueEncoded(frames, lane: lane)
                case .failure(let error): self.failOutbound(error)
                }
            })
    }

    private func enqueueEncoded(_ frames: [String], lane: String) {
        let bytes = frames.reduce(0) { $0 + $1.utf8.count }
        guard outboundBytes + bytes <= maxOutboundBytes else {
            failOutbound(PairingError.relay(L10n.tr("发送队列已满，请稍后重试。")))
            return
        }
        for frame in frames {
            outbound.append((frame, lane, nil))
            outboundBytes += frame.utf8.count
        }
        drainQueue()
    }

    private func failOutbound(_ error: Error) {
        // Admission is asynchronous now. Reconnect so an accepted operation that could not
        // be encoded/enqueued is reconciled by its existing owner instead of waiting forever.
        if let socket { socketClosed(socket, error: error) }
    }

    private func retire(_ old: (any RelaySocketConnection)?) -> Task<Void, Never> {
        guard let old else { return retirement ?? Task {} }
        old.cancel()
        let previous = retirement, id = UUID()
        retirementID = id; retirementPending = true
        let task = Task { @MainActor in
            await previous?.value
            await old.cancelAndWait()
            if self.retirementID == id { self.retirementPending = false }
        }
        retirement = task
        return task
    }

    private func openSocket() {
        if retirementPending {
            let generation = pairingGeneration, retired = retirement
            reconnectTask = Task { @MainActor [weak self] in
                await retired?.value
                guard let self, !Task.isCancelled, self.pairingGeneration == generation,
                      self.socket == nil, self.candidate == nil else { return }
                self.openSocket()
            }
            return
        }
        guard let credential, let url = RelayURL.endpoint(credential.relayUrl, path: "v1/device", webSocket: true) else {
            stateHandler?(.error, L10n.tr("中继地址无效，请重新配对。"))
            return
        }
        if !hasDirectPath { stateHandler?(.connecting, nil) }
        let task = makeSocket(url, desiredRelayMode, { [weak self] in self?.socketOpened($0) },
            { [weak self] in self?.socketClosed($0, error: $1) })
        socket = task
        relaySwitchPhase = "preparing"
        task.start()
    }

    private var modeKey: String { "orbis.relay.mode." + Data(hostId.utf8).base64EncodedString() }

    /// Changes only this Host's Relay. LAN, outboxes, caches and UI identity stay owned above.
    func setRelayTransportMode(_ mode: RelayTransportMode) {
        if desiredRelayMode == mode, candidate != nil { return }
        desiredRelayMode = mode
        if !hostId.isEmpty { preferences?.set(mode.rawValue, forKey: modeKey) }
        relaySwitchError = nil
        switchAttempt = UUID()
        let attempt = switchAttempt
        candidate?.cancel(); candidate = nil
        switchTask?.cancel(); switchTask = nil
        guard pairing != nil else { return }
        if let socket, socket.kind != nil, mode == .auto || socket.kind?.rawValue == mode.rawValue {
            relaySwitchPhase = bootstrapReady ? "active" : "handshaking"; return
        }
        guard let credential, let url = RelayURL.endpoint(credential.relayUrl, path: "v1/device", webSocket: true) else { return }
        relaySwitchPhase = "preparing"
        let task = makeSocket(url, mode, { [weak self] candidate in
            guard let self, self.switchAttempt == attempt, self.candidate === candidate else { candidate.cancel(); return }
            self.reconnectTask?.cancel(); self.reconnectTask = nil
            self.relaySwitchPhase = "retiring"
            let old = self.socket; self.socket = nil
            self.timeoutTask?.cancel(); self.timeoutTask = nil
            self.resetChannel()
            let retired = self.retire(old)
            self.switchTask = Task { @MainActor [weak self, weak candidate] in
                await retired.value
                guard let self, let candidate, !Task.isCancelled, self.switchAttempt == attempt, self.candidate === candidate else { return }
                self.candidate = nil; self.socket = candidate
                self.socketOpened(candidate)
            }
        }, { [weak self] candidate, error in
            guard let self else { return }
            if self.socket === candidate { self.socketClosed(candidate, error: error); return }
            guard self.switchAttempt == attempt, self.candidate === candidate else { return }
            self.candidate = nil; candidate.cancel()
            self.relaySwitchError = error?.localizedDescription ?? "Relay transport preparation failed"
            self.relaySwitchPhase = self.socket == nil ? "offline" : "active"
            if self.socket == nil, self.reconnect { self.scheduleReconnect() }
        })
        candidate = task
        task.start()
    }

    private func connectPairing(qr: PairingQR, relay: RelayCredential, pairingSession: DevicePairingSession) async throws {
        hostId = qr.hostId
        fromId = relay.deviceId
        credential = relay
        desiredRelayMode = initialMode ?? .ws
        self.pairingSession = pairingSession
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            self.pairingContinuation = continuation
            self.armTimeout(message: L10n.tr("配对等待超时，请重新扫描二维码。"))
            self.openSocket()
        }
    }

    private func socketOpened(_ task: any RelaySocketConnection) {
        guard socket === task, let credential else { return }
        relaySwitchPhase = "handshaking"
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
        guard socket != nil, bootstrapReady else { return false }
        return queueEncrypted(data, kind: "bin", lane: "bulk")
    }

    private func beginHandshake() throws {
        guard let pairing else { return }
        resetChannel()
        let root = try Base64URL.decodeFixed(pairing.pskRoot, bytes: 32, label: "pskRoot")
        let value = DeviceHandshake(pskRoot: root, supportsHistoryStreams: socket?.supportsHistoryStreams == true)
        handshake = value
        if !hasDirectPath { stateHandler?(.connecting, nil) }
        try sendPlain(kind: "hs", body: value.hs1())
        armTimeout(message: L10n.tr("电脑端安全握手未响应，正在重新连接。"))
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
        guard socket != nil else { throw PairingError.relay(L10n.tr("连接已关闭")) }
        guard outboundBytes + text.utf8.count <= maxOutboundBytes else { throw PairingError.relay(L10n.tr("发送队列已满，请稍后重试。")) }
        outbound.append((text, channel, completion))
        outboundBytes += text.utf8.count
        drainQueue()
    }

    private func drainQueue() {
        guard let task = socket, !outbound.isEmpty else { return }
        // Per-channel sequence order stays FIFO. Control frames can pass bulk
        // pieces because each authenticated channel has its own nonce sequence.
        let available = outbound.indices.filter { !sendingLanes.contains(task.kind == .quic ? RelayLane(channel: outbound[$0].channel) : .ctl) }
        guard let index = available.first(where: { outbound[$0].channel != "bulk" }) ?? available.first else { return }
        let (text, channel, completion) = outbound.remove(at: index)
        outboundBytes -= text.utf8.count
        let lane = RelayLane(channel: channel), writeLane: RelayLane = task.kind == .quic ? lane : .ctl
        let generation = outboundGeneration
        sendingLanes.insert(writeLane)
        task.send(.string(text), lane: lane) { [weak self, weak task] error in
            Task { @MainActor in
                guard let self, let task, self.socket === task else { return }
                self.sendingLanes.remove(writeLane)
                if self.outboundGeneration == generation { completion?(error) }
                if let error { self.socketClosed(task, error: error) }
                else { self.drainQueue() }
            }
        }
        drainQueue()
    }

    private func receive(from task: any RelaySocketConnection) {
        task.receive { [weak self, weak task] result in
            Task { @MainActor in
                guard let self, let task, self.socket === task else { return }
                let decoder = self.decoder
                do {
                    let message = try result.get()
                    let decoded = try await decoder.decode(message, hostId: self.hostId, deviceId: self.fromId,
                        keys: self.channel?.keys, relay: true, allowPriorSession: task.kind == .quic)
                    // A timeout, disconnect or a replacement handshake can win while decoding.
                    guard self.socket === task, self.decoder === decoder else { return }
                    if let decoded { try self.handle(decoded) }
                    if self.socket === task { self.receive(from: task) }
                } catch {
                    if self.socket === task, self.decoder === decoder { self.socketClosed(task, error: error) }
                }
            }
        }
    }

    private func handle(_ decoded: InboundFrameDecoder.Decoded) throws {
        switch decoded {
        case .control(let outer):
            guard let type = outer["type"] as? String else { return }
            if type == "host.online", outer["hostId"] as? String == hostId, pairing != nil {
                try beginHandshake()
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
                    pending.resume(throwing: PairingError.relay(outer["message"] as? String ?? L10n.tr("配对认证失败")))
                    disconnect()
                }
                return
            }
        case .handshake(let envelope):
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
                guard let keys = handshake.keys else { throw PairingError.handshake(L10n.tr("会话密钥未建立")) }
                channel = E2EChannel(keys: keys)
                self.handshake = nil
                if socket?.kind == .ws {
                    // Preserve the original WS readiness callback after HS3 write completion.
                    let establishedChannel = channel
                    try sendPlain(kind: "hs", body: reply) { [weak self] error in
                        if let self, error == nil, self.channel === establishedChannel { self.activateRelay() }
                    }
                    timeoutTask?.cancel(); timeoutTask = nil
                } else {
                    // Only authenticated Host bootstrap enables other QUIC streams/sends.
                    try sendPlain(kind: "hs", body: reply)
                    // ADR-0064 binds the business format before Host publishes ready.
                    // Both HS3 and this read-only bootstrap stay FIFO on ctl.
                    _ = queueEncrypted(["type": "host.lan.request", "protocolVersion": orbisProtocolVersion], keys: keys)
                }
            }
        case .authenticated(let header, let payload, let message):
            guard channel != nil else { return }
            if socket?.kind == .quic, !bootstrapReady, header.k == "data", header.ch == "ctl", message?["type"] as? String == "device.ready" {
                activateRelay()
            }
            switch header.k {
            case "ping":
                guard queueEncrypted(payload, kind: "ping", lane: "ctl") else {
                    throw PairingError.relay(L10n.tr("加密心跳回应未能排队"))
                }
            case "data":
                guard let message else { return }
                if header.ch != "ctl" || !handlePathControl(message) { deliver(payload, channel: header.ch, message: message) }
            case "bin": deliver(payload, channel: header.ch, binary: true)
            default: break
            }
        }
    }


    private func activateRelay() {
        bootstrapReady = true; socket?.setBusinessReady(true)
        relaySwitchPhase = "active"; relaySwitchError = nil
        timeoutTask?.cancel(); timeoutTask = nil
        stateHandler?(.secured, nil)
        _ = sendRelay(["type": "host.lan.request", "protocolVersion": orbisProtocolVersion])
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
        direct.receive = { [weak self, weak direct] data, channel, binary, message in
            guard let self, let direct, self.lan === direct else { return }
            if binary { self.deliver(data, channel: channel, binary: true) }
            else if let message, channel != "ctl" || !self.handlePathControl(message) { self.deliver(data, channel: channel, message: message) }
        }
        direct.state = { [weak self, weak direct] ready in
            guard let self, let direct, self.lan === direct else { return }
            if !ready, self.activePath == "lan" { self.activePath = nil }
            self.stateHandler?(ready || self.channel != nil ? .secured : .offline, nil)
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
            guard message["protocolVersion"] as? Int == orbisProtocolVersion,
                  let path = message["path"] as? String, ["lan", "relay"].contains(path) else { return true }
            activePath = path
            receiveHandler?(message, "ctl")
            return true
        default: return false
        }
    }

    private func deliver(_ payload: Data, channel: String?, binary: Bool = false, message: [String: Any]? = nil) {
        inbound.offer(.init(payload: payload, channel: channel, binary: binary, message: message))
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
                self.receivedPayload = frame.payload
                if frame.binary { self.receiveHandler?(["type": "_artifact.chunk", "data": frame.payload], frame.channel) }
                else if let message = frame.message { self.receiveHandler?(message, frame.channel) }
                self.receivedPayload = nil
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

    private func socketClosed(_ task: any RelaySocketConnection, error: Error?) {
        guard socket === task else { return }
        socket = nil
        _ = retire(task)
        timeoutTask?.cancel(); timeoutTask = nil
        resetChannel()
        relaySwitchPhase = "offline"
        let pending = pairingContinuation
        pairingContinuation = nil
        pending?.resume(throwing: error ?? PairingError.relay(L10n.tr("配对连接已关闭")))
        stateHandler?(hasDirectPath ? .secured : .offline, hasDirectPath ? nil : error?.localizedDescription)
        guard reconnect, pairing != nil else { return }
        scheduleReconnect()
    }

    private func scheduleReconnect() {
        reconnectTask?.cancel()
        reconnectTask = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 2_000_000_000) } catch { return }
            guard let self else { return }
            await self.retirement?.value
            guard !Task.isCancelled, self.reconnect, self.socket == nil, self.candidate == nil else { return }
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
    struct Frame: Equatable {
        let payload: Data
        let channel: String?
        var binary = false
        var message: [String: Any]? = nil
        static func == (lhs: Self, rhs: Self) -> Bool {
            lhs.payload == rhs.payload && lhs.channel == rhs.channel && lhs.binary == rhs.binary
        }
    }
    private struct Lane {
        var frames: [Frame] = []
        var bytes = 0
        let limits: Limits
        mutating func offer(_ frame: Frame) -> (total: Int, data: Int) {
            var dropped = 0
            var droppedData = 0
            while !frames.isEmpty && (frames.count >= limits.frames || bytes + frame.payload.count > limits.payload) {
                let removed = frames.removeFirst()
                bytes -= removed.payload.count
                if !removed.binary { droppedData += 1 }
                dropped += 1
            }
            // A single authenticated snapshot can exceed the nominal lane
            // budget. Keep it alone (bounded by envelope reassembly), as Android
            // does, so a legal large snapshot cannot fail every recovery attempt.
            frames.append(frame); bytes += frame.payload.count
            return (dropped, droppedData)
        }
        mutating func take(prioritized: Bool = false) -> Frame? {
            guard !frames.isEmpty else { return nil }
            let index = prioritized ? (["msg", "history", "catchup"].compactMap { channel in frames.firstIndex { $0.channel == channel } }.first ?? 0) : 0
            let frame = frames.remove(at: index); bytes -= frame.payload.count
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
        // JSON history/detail pages require source repair, unlike offset-based binary chunks.
        if frame.binary || frame.channel == "bulk" { droppedSession += bulk.offer(frame).data }
        else if ["msg", "history", "catchup"].contains(frame.channel ?? "") { droppedSession += session.offer(frame).total }
        else { droppedControl += control.offer(frame).total }
    }
    func take() -> Frame? { control.take() ?? session.take(prioritized: true) ?? bulk.take() }
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
    var receive: ((Data, String?, Bool, [String: Any]?) -> Void)?
    var state: ((Bool) -> Void)?
    var isReady: Bool { channel != nil }
    private let urls: [URL]
    private let hostId: String
    private let deviceId: String
    private let root: Data
    private var session: URLSession?
    private var socket: URLSessionWebSocketTask?
    private var channel: E2EChannel?
    private let outboundEncoding = OutboundEncodingQueue()
    private var outboundGeneration = UUID()
    private var handshake: DeviceHandshake?
    private var decoder = InboundFrameDecoder()
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
        outboundGeneration = UUID()
        retry?.cancel(); retry = nil
        timeout?.cancel(); timeout = nil
        heartbeat?.cancel(); heartbeat = nil
        let old = socket; socket = nil
        channel = nil; handshake = nil; queue = []; queuedBytes = 0; sending = false; decoder = InboundFrameDecoder()
        old?.cancel(with: .goingAway, reason: nil)
        session?.invalidateAndCancel(); session = nil
    }
    @discardableResult func send(_ object: [String: Any]) -> Bool {
        guard let channel else { return false }
        return queueEncrypted(object: object, kind: "data", lane: "ctl", keys: channel.keys)
    }
    @discardableResult func sendBinary(_ data: Data) -> Bool {
        guard let channel, data.count * 2 + 4096 <= maxQueuedBytes else { return false }
        return queueEncrypted(data: data, kind: "bin", lane: "bulk", keys: channel.keys)
    }
    private func queueEncrypted(object: [String: Any]? = nil, data: Data? = nil, kind: String, lane: String,
                                keys: SessionKeys) -> Bool {
        guard socket != nil else { return false }
        let generation = outboundGeneration
        return outboundEncoding.submit(object: object.map(OutboundJSONObject.init(value:)), bytes: data, kind: kind,
            lane: lane, room: hostId, from: deviceId, to: hostId, keys: keys, generation: generation,
            availableBytes: maxQueuedBytes - queuedBytes,
            isCurrent: { [weak self] in self?.socket != nil && self?.outboundGeneration == generation },
            completion: { [weak self] result in
                guard let self, self.outboundGeneration == generation else { return }
                switch result {
                case .success(let frames): self.enqueueEncoded(frames, lane: lane)
                case .failure:
                    if let socket = self.socket { self.fail(socket) }
                }
            })
    }
    private func queueEncrypted(data: Data, kind: String, lane: String, keys: SessionKeys) -> Bool {
        queueEncrypted(object: nil, data: data, kind: kind, lane: lane, keys: keys)
    }
    private func open() {
        guard !closed, !urls.isEmpty else { return }
        outboundGeneration = UUID()
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
        guard socket != nil else { throw PairingError.relay(L10n.tr("局域网连接已关闭")) }
        let frames = try EnvelopePieces.fragment(envelope).map { piece in
            String(decoding: try JSONEncoder().encode(V2Frame(type: "v2.frame", protocolVersion: orbisProtocolVersion, envelope: piece)), as: UTF8.self)
        }
        let cost = frames.reduce(0) { $0 + $1.utf8.count }
        guard queuedBytes + cost <= maxQueuedBytes else { throw PairingError.relay(L10n.tr("局域网发送队列已满")) }
        queue.append(contentsOf: frames.map { ($0, envelope.hdr.ch) }); queuedBytes += cost
        drain()
    }
    private func enqueueEncoded(_ frames: [String], lane: String) {
        let cost = frames.reduce(0) { $0 + $1.utf8.count }
        guard queuedBytes + cost <= maxQueuedBytes else {
            if let socket { fail(socket) }
            return
        }
        queue.append(contentsOf: frames.map { ($0, lane) })
        queuedBytes += cost
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
                let decoder = self.decoder
                do {
                    guard let message = RelayMessage(try result.get()) else { self.read(task); return }
                    let decoded = try await decoder.decode(message, hostId: self.hostId, deviceId: self.deviceId,
                        keys: self.channel?.keys, relay: false)
                    guard self.socket === task, self.decoder === decoder else { return }
                    if let decoded { try self.handle(decoded) }
                    if self.socket === task { self.read(task) }
                } catch {
                    if self.socket === task, self.decoder === decoder { self.fail(task) }
                }
            }
        }
    }
    private func handle(_ decoded: InboundFrameDecoder.Decoded) throws {
        switch decoded {
        case .handshake(let envelope):
            guard envelope.hdr.k == "hs", envelope.hdr.n == 0, channel == nil, let handshake else { throw PairingError.handshake(L10n.tr("局域网握手状态无效")) }
            let reply = try handshake.accept(E2ECrypto.jsonObject(Base64URL.decode(envelope.ct)))
            guard let keys = handshake.keys else { throw PairingError.handshake(L10n.tr("局域网密钥未建立")) }
            try sendHandshake(reply)
            channel = E2EChannel(keys: keys); self.handshake = nil
            timeout?.cancel(); timeout = nil
            endpointIndex = 0
            state?(true)
            armHeartbeat()
        case .authenticated(let header, let bytes, let message):
            guard let channel else { throw PairingError.handshake(L10n.tr("局域网握手尚未完成")) }
            switch header.k {
            case "ping":
                guard queueEncrypted(data: bytes, kind: "ping", lane: "ctl", keys: channel.keys) else {
                    throw PairingError.relay(L10n.tr("加密心跳回应未能排队"))
                }
            case "data": receive?(bytes, header.ch, false, message)
            case "bin": receive?(bytes, header.ch, true, nil)
            default: break
            }
        case .control: throw PairingError.invalidQR
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
        outboundGeneration = UUID()
        socket = nil; channel = nil; handshake = nil; decoder = InboundFrameDecoder()
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
