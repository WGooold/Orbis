import Foundation

let orbisProtocolVersion = 15

struct PairingQR: Codable, Hashable {
    let v: Int
    let relayUrl: String
    let code: String
    let hostId: String
    let hostName: String
    let hostPub: String
    let psk: String
    let exp: Int64
    let lan: [LANEndpoint]

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        v = try c.decode(Int.self, forKey: .v); relayUrl = try c.decode(String.self, forKey: .relayUrl); code = try c.decode(String.self, forKey: .code)
        hostId = try c.decode(String.self, forKey: .hostId); hostName = try c.decode(String.self, forKey: .hostName); hostPub = try c.decode(String.self, forKey: .hostPub); psk = try c.decode(String.self, forKey: .psk); exp = try c.decode(Int64.self, forKey: .exp); lan = try c.decodeIfPresent([LANEndpoint].self, forKey: .lan) ?? []
    }

    enum CodingKeys: String, CodingKey { case v, relayUrl, code, hostId, hostName, hostPub, psk, exp, lan }

    init(v: Int, relayUrl: String, code: String, hostId: String, hostName: String, hostPub: String, psk: String, exp: Int64, lan: [LANEndpoint] = []) {
        self.v = v; self.relayUrl = relayUrl; self.code = code; self.hostId = hostId; self.hostName = hostName; self.hostPub = hostPub; self.psk = psk; self.exp = exp; self.lan = lan
    }

    static func parse(_ raw: String) throws -> PairingQR {
        guard let data = raw.data(using: .utf8) else { throw PairingError.invalidQR }
        let decoder = JSONDecoder()
        let value = try decoder.decode(PairingQR.self, from: data)
        guard value.v == 2, RelayURL.isSupported(value.relayUrl), !value.hostId.isEmpty,
              !value.hostName.isEmpty, value.code.range(of: "^[A-Z0-9_-]{4,128}$", options: .regularExpression) != nil else {
            throw PairingError.invalidQR
        }
        guard value.exp > Int64(Date().timeIntervalSince1970) else { throw PairingError.expired }
        _ = try Base64URL.decodeFixed(value.hostPub, bytes: 32, label: "hostPub")
        _ = try Base64URL.decodeFixed(value.psk, bytes: 32, label: "psk")
        return value
    }
}

struct LANEndpoint: Codable, Hashable, Identifiable {
    let host: String
    let port: Int
    var id: String { "\(host):\(port)" }
}

struct RelayCredential: Codable, Hashable {
    let relayUrl: String
    let deviceId: String
    let credential: String
}

struct HostPairing: Codable, Hashable, Identifiable {
    let hostId: String
    var hostName: String
    let hostPub: String
    let pskRoot: String
    var relay: RelayCredential
    var lan: [LANEndpoint]
    var id: String { hostId }
}

enum ConnectionState: String { case offline, connecting, online, secured, error }

enum PairingError: LocalizedError {
    case invalidQR
    case expired
    case relay(String)
    case handshake(String)
    case unsupported
    var errorDescription: String? {
        switch self {
        case .invalidQR: return "二维码格式无效或缺少端到端加密材料。"
        case .expired: return "二维码已过期，请在电脑端重新生成。"
        case .relay(let message): return message
        case .handshake(let message): return message
        case .unsupported: return "当前系统不支持这项加密能力。"
        }
    }
}

struct RuntimeSummary: Codable, Hashable, Identifiable {
    let runtimeId: String
    var name: String
    var cwd: String
    var status: String
    var sessionId: String?
    var sessionName: String?
    var hostname: String?
    var agentKind: String?
    var model: RuntimeModelInfo?
    var contextUsage: RuntimeContextUsage?
    var thinkingLevel: String? = nil
    var permissionManagement: PermissionManagement? = nil
    var id: String { runtimeId }
}

struct RuntimeModelInfo: Codable, Hashable {
    let provider: String
    let id: String
    let name: String?
}

struct RuntimeContextUsage: Codable, Hashable {
    let tokens: Int64?
    let contextWindow: Int64?
    let percent: Double?
}

struct SessionSummary: Codable, Hashable, Identifiable {
    let sessionId: String
    var name: String?
    var cwd: String
    var firstMessage: String?
    var createdAt: Int64
    var modifiedAt: Int64
    var messageCount: Int
    var agentKind: String?
    var archived: Bool?
    var modelProvider: String? = nil
    var id: String { sessionId }
}

struct ChatContent: Codable, Hashable {
    let type: String
    let text: String?
    let toolName: String?
    let artifact: RemoteArtifact?
    var summary: ToolSummary? = nil
    var toolCallId: String? = nil
}

struct ToolSummary: Codable, Hashable {
    var projectionVersion: Int = 1
    var tool: ToolIdentity? = nil
    var contents: [ToolPart] = []
    var order: Int64 = 0
    var turnId: String? = nil
    var messageId: String? = nil
    var entryId: String? = nil
    var exitCode: Int? = nil
    var durationMs: Int64? = nil
    let toolName: String
    let phase: String
    let isError: Bool?
    let inputSummary: SummaryText?
    let resultSummary: SummaryText?
    let errorSummary: SummaryText?
    struct SummaryText: Codable, Hashable {
        let text: String
        let omitted: Bool
        let originalBytes: Int64
    }
}

struct PermissionManagement: Codable, Hashable {
    let summary: String
    let details: String
    let tone: String
    let settings: [Setting]
    struct Setting: Codable, Hashable, Identifiable {
        let id: String
        let label: String
        let currentValue: String?
        let disabledReason: String?
        let options: [RuntimeOption]
    }
}

struct RuntimeOption: Codable, Hashable, Identifiable {
    let value: String
    let label: String
    let description: String?
    var tree: TreePosition? = nil
    var id: String { value }
    struct TreePosition: Codable, Hashable {
        let parentId: String?
        let entryType: String
        let role: String?
        let label: String?
        let defaultHidden: Bool
        let isCurrent: Bool
        let isOnActivePath: Bool
    }
}

struct SlashCommand: Codable, Hashable, Identifiable {
    let name: String
    let description: String?
    let source: String
    let argument: Argument?
    var id: String { name }
    struct Argument: Codable, Hashable {
        let kind: String
        let required: Bool
        let hint: String?
        let options: [RuntimeOption]?
    }
}

struct BrowseEntry: Codable, Hashable, Identifiable {
    let name: String
    let isDir: Bool
    let hasSessions: Bool
    var id: String { name }
}

struct DirectoryBrowse {
    let requestId: String
    var path: String?
    var parent: String?
    var entries: [BrowseEntry] = []
    var loading = true
    var error: String?
}

struct WorkingBranch {
    let requestId: String
    let sessionId: String?
    let cwd: String
    var branch: String?
    var commit: String?
    var loaded = false
}

struct EntryPreview {
    let requestId: String
    let runtimeId: String
    let sessionId: String
    let entryId: String
    var message: ChatMessage?
    var loading = true
    var error: String?
}

struct RemoteArtifact: Codable, Hashable {
    let artifactId: String
    let fileName: String
    let mimeType: String
    let size: Int64
    let sha256: String?
    let path: String?
}

struct ChatMessage: Codable, Hashable, Identifiable {
    let messageId: String
    let role: String
    let content: [ChatContent]
    let timestamp: Int64
    let isError: Bool?
    var toolSummary: ToolSummary? = nil
    var id: String { messageId }
    var text: String {
        content.compactMap { item -> String? in
            if let text = item.text, !text.isEmpty { return text }
            if item.type == "tool_call" { return "使用工具：\(item.toolName ?? "工具")" }
            if item.type == "artifact", let file = item.artifact?.fileName { return "附件：\(file)" }
            return nil
        }.joined(separator: "\n")
    }
}

struct RoutingHeader: Codable, Hashable {
    let k: String
    let room: String
    let from: String
    let to: String
    let n: UInt64
    let ch: String?
    let ik: String?
    let mid: String?
    let idx: Int?
    let last: Bool?

    enum CodingKeys: String, CodingKey { case k, room, from, to, n, ch, ik, mid, idx, last }
    init(k: String, room: String, from: String, to: String, n: UInt64, ch: String?, ik: String? = nil, mid: String? = nil, idx: Int? = nil, last: Bool? = nil) {
        self.k = k; self.room = room; self.from = from; self.to = to; self.n = n; self.ch = ch
        self.ik = ik; self.mid = mid; self.idx = idx; self.last = last
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        k = try c.decode(String.self, forKey: .k); room = try c.decode(String.self, forKey: .room); from = try c.decode(String.self, forKey: .from); to = try c.decode(String.self, forKey: .to); n = try c.decode(UInt64.self, forKey: .n); ch = try c.decodeIfPresent(String.self, forKey: .ch)
        ik = try c.decodeIfPresent(String.self, forKey: .ik); mid = try c.decodeIfPresent(String.self, forKey: .mid)
        idx = try c.decodeIfPresent(Int.self, forKey: .idx); last = try c.decodeIfPresent(Bool.self, forKey: .last)
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(k, forKey: .k); try c.encode(room, forKey: .room); try c.encode(from, forKey: .from); try c.encode(to, forKey: .to); try c.encode(n, forKey: .n)
        if let ch { try c.encode(ch, forKey: .ch) }
        try c.encodeIfPresent(ik, forKey: .ik); try c.encodeIfPresent(mid, forKey: .mid)
        try c.encodeIfPresent(idx, forKey: .idx); try c.encodeIfPresent(last, forKey: .last)
    }
    func aad() -> Data {
        let channelValue = ch ?? "undefined"
        return Data("k=\(k)\nroom=\(room)\nfrom=\(from)\nto=\(to)\nch=\(channelValue)\nn=\(n)".utf8)
    }
}

struct Envelope: Codable, Hashable {
    let v: Int
    let hdr: RoutingHeader
    let ct: String
}

struct V2Frame: Codable {
    let type: String
    let protocolVersion: Int
    let envelope: Envelope
}

struct InteractionRequest: Codable, Hashable, Identifiable {
    let runtimeId: String
    let requestId: String
    let extensionId: String
    let kind: String
    let title: String
    let description: String?
    let expiresAt: Int64
    let options: [RuntimeOption]?
    let placeholder: String?
    let initialValue: String?
    let minLength: Int?
    let maxLength: Int?
    let minSelections: Int?
    let maxSelections: Int?
    let secret: Bool?
    let confirmLabel: String?
    let cancelLabel: String?
    let argumentSummary: String?
    let externalUrl: String?
    let questions: [Question]?
    var submitted: Bool? = nil
    var id: String { requestId }
    struct Question: Codable, Hashable, Identifiable {
        let id: String
        let header: String?
        let question: String
        let options: [RuntimeOption]
        let multiSelect: Bool?
        let allowOther: Bool?
        let allowNotes: Bool?
        let secret: Bool?
    }
}
