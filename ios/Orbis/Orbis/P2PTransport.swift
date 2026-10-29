import Foundation
#if canImport(WebRTC)
import WebRTC
#endif

enum RelaySTUN {
    /// The official HTTPS hostname is proxied; UDP uses the same origin as Android.
    static func server(_ relayURL: String) -> String? {
        guard let url = URLComponents(string: relayURL.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = url.scheme?.lowercased(), ["ws", "wss"].contains(scheme),
              let raw = url.host, !raw.isEmpty else { return nil }
        let host = raw.lowercased() == "orbising.com" ? "45.58.185.226" : raw
        let address = host.contains(":") && !host.hasPrefix("[") ? "[\(host)]" : host
        return "stun:\(address):3478"
    }
}

enum P2PPeerEvent {
    case gatheringComplete, dataChannelOpen, dataChannelClosed, connected, disconnected, bufferedAmountChanged
    case received(Data, binary: Bool)
    case failed(String)
}

/// The native driver has no pairing secrets or business state. Its callbacks
/// always hop to the main actor before entering the encrypted Path state machine.
@MainActor
protocol P2PPeer: AnyObject {
    var event: ((P2PPeerEvent) -> Void)? { get set }
    var bufferedAmount: UInt64 { get }
    var isDataChannelOpen: Bool { get }
    var isGatheringComplete: Bool { get }
    var localDescription: String? { get }
    func acceptOffer(_ sdp: String) async throws
    func send(_ data: Data) -> Bool
    func close()
}

@MainActor
final class P2PTransport {
    var signal: (([String: Any]) -> Bool)?
    var receive: ((Data, String?, Bool) -> Void)?
    var state: ((Bool, String?) -> Void)?
    var isReady: Bool { !closed && channel != nil }
    private let peer: P2PPeer
    private let hostId: String
    private let deviceId: String
    private let root: Data
    private let disconnectGrace: UInt64
    private let attemptTimeout: UInt64
    private var channel: E2EChannel?
    private var handshake: DeviceHandshake?
    private let pieces = EnvelopeReassembler()
    private var closed = false
    private var started = false
    private var acceptingOffer = false
    private var hasOffer = false
    private var localReady = false
    private var answerSent = false
    private var negotiation: Task<Void, Never>?
    private var attempt: Task<Void, Never>?
    private var disconnect: Task<Void, Never>?
    private var pump: Task<Void, Never>?
    private var queue: [(data: Data, channel: String?)] = []
    private var queuedBytes = 0
    private let maxQueuedBytes = 4 * 1024 * 1024
    private let bulkHighWater: UInt64 = 64 * 1024

    init(peer: P2PPeer, hostId: String, deviceId: String, root: Data,
         disconnectGraceNanoseconds: UInt64 = 5_000_000_000, attemptTimeoutNanoseconds: UInt64 = 15_000_000_000) {
        self.peer = peer; self.hostId = hostId; self.deviceId = deviceId; self.root = root
        disconnectGrace = disconnectGraceNanoseconds; attemptTimeout = attemptTimeoutNanoseconds
        peer.event = { [weak self] in self?.handle($0) }
    }

    static func makeNativePeer(stunServers: [String]) throws -> P2PPeer? {
        #if canImport(WebRTC)
        return try NativeP2PPeer(stunServers: stunServers)
        #else
        return nil // Core tests run without downloading an iOS binary dependency.
        #endif
    }

    func start() {
        guard !closed, !started else { return }
        started = true
        attempt = Task { [weak self] in
            guard let duration = self?.attemptTimeout else { return }
            do { try await Task.sleep(nanoseconds: duration) } catch { return }
            self?.fail("p2p.attempt_timeout")
        }
    }

    /// Host is always offerer. SDP already contains its complete ICE candidates.
    func acceptOffer(_ sdp: String) {
        guard !closed, !acceptingOffer, !hasOffer, !sdp.isEmpty, sdp.utf8.count <= 16_384 else { return }
        acceptingOffer = true; hasOffer = true
        negotiation = Task { [weak self] in
            guard let self else { return }
            do {
                try await self.peer.acceptOffer(sdp)
                guard !self.closed, !Task.isCancelled else { return }
                self.acceptingOffer = false; self.localReady = true
                self.sendAnswerIfComplete()
            } catch { if !self.closed { self.fail("p2p.sdp_failed") } }
        }
    }

    @discardableResult func send(_ object: [String: Any]) -> Bool {
        guard let payload = try? E2ECrypto.jsonData(object) else { return false }
        return send(kind: "data", payload: payload, lane: "ctl")
    }
    @discardableResult func sendBinary(_ bytes: Data) -> Bool { send(kind: "bin", payload: bytes, lane: "bulk") }

    private func send(kind: String, payload: Data, lane: String) -> Bool {
        guard isReady, let channel, queuedBytes + payload.count * 2 + 4096 <= maxQueuedBytes else { return false }
        do {
            try enqueue(channel.seal(kind: kind, room: hostId, from: deviceId, to: hostId, channel: lane, payload: payload))
            return !closed
        } catch { fail("p2p.send_failed"); return false }
    }

    func close() {
        guard !closed else { return }
        closed = true
        negotiation?.cancel(); negotiation = nil
        attempt?.cancel(); attempt = nil
        disconnect?.cancel(); disconnect = nil
        pump?.cancel(); pump = nil
        peer.event = nil; peer.close()
        channel = nil; handshake = nil; pieces.clear(); queue = []; queuedBytes = 0
    }

    private func fail(_ reason: String) {
        guard !closed else { return }
        close(); state?(false, reason)
    }

    private func sendAnswerIfComplete() {
        guard !closed, !answerSent, localReady, peer.isGatheringComplete,
              let sdp = peer.localDescription, !sdp.isEmpty, sdp.utf8.count <= 16_384 else { return }
        answerSent = true
        guard signal?(["type": "p2p.answer", "protocolVersion": orbisProtocolVersion, "sdp": sdp]) == true else {
            fail("p2p.signaling_unavailable"); return
        }
    }

    private func handle(_ event: P2PPeerEvent) {
        guard !closed else { return }
        switch event {
        case .gatheringComplete: sendAnswerIfComplete()
        case .connected:
            disconnect?.cancel(); disconnect = nil
        case .disconnected:
            guard disconnect == nil else { return }
            disconnect = Task { [weak self] in
                guard let duration = self?.disconnectGrace else { return }
                do { try await Task.sleep(nanoseconds: duration) } catch { return }
                self?.fail("p2p.disconnected")
            }
        case .dataChannelOpen:
            guard peer.isDataChannelOpen, handshake == nil, channel == nil else { return }
            handshake = DeviceHandshake(pskRoot: root); pieces.clear()
            do { try sendPlain(handshake!.hs1()) } catch { fail("p2p.handshake_send_failed") }
        case .dataChannelClosed: fail("p2p.channel_closed")
        case .bufferedAmountChanged: drain()
        case .failed(let reason): fail(reason)
        case .received(let bytes, let binary):
            guard !binary else { return } // Bare DataChannel bytes never bypass Envelope E2E.
            do {
                guard bytes.count <= 2 * 1024 * 1024 else { throw PairingError.handshake("P2P frame too large") }
                let frame = try JSONDecoder().decode(V2Frame.self, from: bytes)
                guard frame.type == "v2.frame", frame.protocolVersion == orbisProtocolVersion, frame.envelope.v == 2,
                      frame.envelope.hdr.room == hostId, frame.envelope.hdr.from == hostId, frame.envelope.hdr.to == deviceId else {
                    throw PairingError.handshake("P2P routing mismatch")
                }
                if let envelope = pieces.accept(frame.envelope) { try open(envelope) }
            } catch { fail("p2p.invalid_frame") }
        }
    }

    private func sendPlain(_ body: [String: Any]) throws {
        try enqueue(Envelope(v: 2, hdr: RoutingHeader(k: "hs", room: hostId, from: deviceId, to: hostId, n: 0, ch: nil),
                             ct: Base64URL.encode(E2ECrypto.jsonData(body))))
    }

    private func open(_ envelope: Envelope) throws {
        if envelope.hdr.k == "hs" {
            guard envelope.hdr.n == 0, envelope.hdr.ch == nil, channel == nil, let handshake else {
                throw PairingError.handshake("P2P handshake state mismatch")
            }
            let reply = try handshake.accept(E2ECrypto.jsonObject(Base64URL.decode(envelope.ct)))
            guard let keys = handshake.keys else { throw PairingError.handshake("P2P missing session keys") }
            try sendPlain(reply)
            guard !closed else { return }
            channel = E2EChannel(keys: keys); self.handshake = nil
            attempt?.cancel(); attempt = nil
            state?(true, nil)
        } else {
            guard let channel else { throw PairingError.handshake("P2P handshake incomplete") }
            guard let bytes = try channel.open(envelope) else { return }
            switch envelope.hdr.k {
            case "ping": try enqueue(channel.seal(kind: "ping", room: hostId, from: deviceId, to: hostId, channel: "ctl", payload: bytes))
            case "data": receive?(bytes, envelope.hdr.ch, false)
            case "bin": receive?(bytes, envelope.hdr.ch, true)
            default: break
            }
        }
    }

    private func enqueue(_ envelope: Envelope) throws {
        guard !closed, peer.isDataChannelOpen else { throw PairingError.handshake("P2P DataChannel not open") }
        let frames = try EnvelopePieces.fragment(envelope).map {
            try JSONEncoder().encode(V2Frame(type: "v2.frame", protocolVersion: orbisProtocolVersion, envelope: $0))
        }
        let cost = frames.reduce(0) { $0 + $1.count }
        guard queuedBytes + cost <= maxQueuedBytes else { throw PairingError.handshake("P2P outbound budget exceeded") }
        queue.append(contentsOf: frames.map { ($0, envelope.hdr.ch) }); queuedBytes += cost
        drain()
    }

    private func drain() {
        guard !closed, peer.isDataChannelOpen else { return }
        while !queue.isEmpty {
            let index = queue.firstIndex { $0.channel != "bulk" } ?? 0
            let frame = queue[index]
            if frame.channel == "bulk", peer.bufferedAmount >= bulkHighWater { schedulePump(); return }
            guard peer.send(frame.data) else { fail("p2p.write_failed"); return }
            queue.remove(at: index); queuedBytes -= frame.data.count
        }
        pump?.cancel(); pump = nil
    }

    private func schedulePump() {
        guard pump == nil else { return }
        pump = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 10_000_000) } catch { return }
            guard let self, !self.closed else { return }
            self.pump = nil; self.drain()
        }
    }
}

#if canImport(WebRTC)
@MainActor
private final class NativeP2PPeer: NSObject, P2PPeer, RTCPeerConnectionDelegate, RTCDataChannelDelegate {
    var event: ((P2PPeerEvent) -> Void)?
    private var connection: RTCPeerConnection?
    private var dataChannel: RTCDataChannel?
    private static let factory: RTCPeerConnectionFactory = {
        RTCInitializeSSL()
        return RTCPeerConnectionFactory()
    }()
    var bufferedAmount: UInt64 { dataChannel?.bufferedAmount ?? 0 }
    var isDataChannelOpen: Bool { dataChannel?.readyState == .open }
    var isGatheringComplete: Bool { connection?.iceGatheringState == .complete }
    var localDescription: String? { connection?.localDescription?.sdp }

    init(stunServers: [String]) throws {
        super.init()
        let config = RTCConfiguration()
        config.iceServers = stunServers.map { RTCIceServer(urlStrings: [$0]) }
        config.sdpSemantics = .unifiedPlan
        connection = Self.factory.peerConnection(with: config, constraints: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil), delegate: self)
        guard connection != nil else { throw PairingError.handshake("无法创建 WebRTC PeerConnection") }
    }

    func acceptOffer(_ sdp: String) async throws {
        guard let connection else { throw PairingError.handshake("P2P peer closed") }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            connection.setRemoteDescription(RTCSessionDescription(type: .offer, sdp: sdp)) { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            }
        }
        guard self.connection === connection else { throw CancellationError() }
        let answer: RTCSessionDescription = try await withCheckedThrowingContinuation { continuation in
            connection.answer(for: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)) { description, error in
                if let error { continuation.resume(throwing: error) }
                else if let description { continuation.resume(returning: description) }
                else { continuation.resume(throwing: PairingError.handshake("WebRTC answer missing")) }
            }
        }
        guard self.connection === connection else { throw CancellationError() }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            connection.setLocalDescription(answer) { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            }
        }
    }
    func send(_ data: Data) -> Bool {
        guard let dataChannel, dataChannel.readyState == .open else { return false }
        return dataChannel.sendData(RTCDataBuffer(data: data, isBinary: false))
    }
    func close() {
        dataChannel?.delegate = nil; dataChannel?.close(); dataChannel = nil
        connection?.delegate = nil; connection?.close(); connection = nil
    }
    private func report(_ peer: RTCPeerConnection, _ event: P2PPeerEvent) {
        guard connection === peer else { return }; self.event?(event)
    }
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    nonisolated func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {} // Non-trickle.
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {
        guard newState == .complete else { return }
        Task { @MainActor [weak self] in self?.report(peerConnection, .gatheringComplete) }
    }
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
        let event: P2PPeerEvent?
        switch newState {
        case .connected, .completed: event = .connected
        case .disconnected: event = .disconnected
        case .failed, .closed: event = .failed("p2p.ice_\(newState.rawValue)")
        default: event = nil
        }
        if let event { Task { @MainActor [weak self] in self?.report(peerConnection, event) } }
    }
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCPeerConnectionState) {
        guard newState == .failed else { return }
        Task { @MainActor [weak self] in self?.report(peerConnection, .failed("p2p.peer_failed")) }
    }
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {
        Task { @MainActor [weak self] in
            guard let self, self.connection === peerConnection else { dataChannel.close(); return }
            guard dataChannel.label == "orbis", self.dataChannel == nil else { dataChannel.close(); return }
            self.dataChannel = dataChannel; dataChannel.delegate = self
            if dataChannel.readyState == .open { self.event?(.dataChannelOpen) }
        }
    }
    nonisolated func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {
        Task { @MainActor [weak self] in
            guard let self, self.dataChannel === dataChannel else { return }
            if dataChannel.readyState == .open { self.event?(.dataChannelOpen) }
            else if dataChannel.readyState == .closed { self.event?(.dataChannelClosed) }
        }
    }
    nonisolated func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
        let bytes = Data(buffer.data), binary = buffer.isBinary
        Task { @MainActor [weak self] in
            guard let self, self.dataChannel === dataChannel else { return }
            self.event?(.received(bytes, binary: binary))
        }
    }
    nonisolated func dataChannel(_ dataChannel: RTCDataChannel, didChangeBufferedAmount amount: UInt64) {
        Task { @MainActor [weak self] in
            guard let self, self.dataChannel === dataChannel else { return }; self.event?(.bufferedAmountChanged)
        }
    }
}
#endif
