import Foundation

let orbisProtocolVersion = 19

/// SC91：连接层按 requestId 自管的请求（目录与历史窗口能力探测、目录查询、历史兴趣订阅）带这个前缀，Android 相同。
/// 在途请求的回包与协议错误由所属读取器先消费；之后到达的只剩重发、替换或重复之后的旧回包。
let connectionOwnedRequestPrefix = "conn:"
func connectionRequestId() -> String { connectionOwnedRequestPrefix + UUID().uuidString }
/// 整条连接不可用的协议错误码；Host 会回传触发请求的 requestId，这类错误不按迟到回包丢弃。
let connectionFatalProtocolCodes: Set<String> = ["unauthorized", "invalid_message", "protocol_version_mismatch", "runtime_mismatch"]
func isStaleConnectionError(_ message: [String: Any]) -> Bool {
    (message["requestId"] as? String)?.hasPrefix(connectionOwnedRequestPrefix) == true &&
        !connectionFatalProtocolCodes.contains(message["code"] as? String ?? "")
}

struct SessionConfigurationValues: Codable, Hashable {
    var model: String? = nil
    var thinking: String? = nil
    var permissions: [String: String]? = nil
    var payload: [String: Any] {
        var value: [String: Any] = ["permissions": permissions ?? [:]]
        if let model { value["model"] = model }; if let thinking { value["thinking"] = thinking }
        return value
    }
}
struct SessionConfigurationModel: Codable, Equatable, Identifiable {
    let value: String
    let label: String
    let thinking: [RuntimeOption]
    var defaultThinking: String? = nil
    var id: String { value }
}
struct SessionConfigurationCatalog: Codable, Equatable {
    let binding: String
    let defaults: SessionConfigurationValues
    let models: [SessionConfigurationModel]
    let permissions: [PermissionManagement.Setting]
    var notice: String? = nil
}
struct SessionConfigurationSnapshot: Codable, Equatable {
    let agentKind: String
    let cwd: String
    let binding: String
    let revision: Int
    let values: SessionConfigurationValues
    let catalog: SessionConfigurationCatalog
}

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
        case .invalidQR: return L10n.tr("二维码格式无效或缺少端到端加密材料。")
        case .expired: return L10n.tr("二维码已过期，请在电脑端重新生成。")
        case .relay(let message): return message
        case .handshake(let message): return message
        case .unsupported: return L10n.tr("当前系统不支持这项加密能力。")
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
    var currentTurnConfiguration: RuntimeTurnConfiguration? = nil
    var currentTurnConfigurationSupported: Bool? = nil
    var modelSelection: SessionConfigurationValues? = nil
    var executionTurnId: String? = nil
    var permissionManagement: PermissionManagement? = nil
    var steerSupported: Bool? = nil
    var sessionGraphSync: Bool? = nil
    var sessionLeafId: String? = nil
    /// Host execution activity; kept separate from the phase used by send/stop logic.
    var compactionPhase: String? = nil
    var backgroundTasks: BackgroundTaskInventory? = nil
    var codexCatalogId: String? = nil
    var directorySessionId: String? { codexCatalogId ?? sessionId }
    var id: String { runtimeId }
    var presentationStatus: String {
        if compactionPhase == "running" && ["idle", "running"].contains(status) { return "compacting" }
        if status == "idle", let tasks = backgroundTasks, tasks.visible {
            // S60 / SC108: only agents mean Claude is still working; a running command alone leaves it idle.
            if tasks.truncated && tasks.activeAgentCount > 0 { return "background" }
            if tasks.truncated && tasks.activeCommandCount > 0 { return "background_commands" }
            if !tasks.confirmed { return "tasks_unknown" }
            if tasks.activeAgentCount > 0 { return "background" }
            if tasks.activeCommandCount > 0 { return "background_commands" }
        }
        return status
    }
    var presentationTitle: String {
        guard ["idle", "running"].contains(status), let tasks = backgroundTasks, let summary = tasks.activityTitle else {
            return runtimeStatusTitle(presentationStatus)
        }
        if presentationStatus == "compacting" { return L10n.tr("压缩中，{0}", summary) }
        if status == "running" && tasks.truncated { return L10n.tr("运行中，{0}", summary) }
        if status == "running" { return tasks.confirmed ? L10n.tr("运行中，{0}", tasks.activeCountTitle) : L10n.tr("运行中，后台任务待核对") }
        if presentationStatus == "background_commands" { return L10n.tr("空闲 · {0}", summary) }
        return summary
    }
    func allowsRemoteClose(_ commands: [SlashCommand]) -> Bool {
        remoteCloseBlockReason(commands) == nil
    }
    func remoteCloseBlockReason(_ commands: [SlashCommand]) -> RuntimeCloseBlockReason? {
        if let tasks = backgroundTasks, tasks.visible, !tasks.allowsQuit {
            if tasks.truncated { return .incompleteTasks }
            if !tasks.confirmed { return .unconfirmedTasks }
            return .activeTasks
        }
        return commands.contains { $0.name == "quit" && $0.argument?.required != true } ? nil : .unavailableCommand
    }
}

/// SC82: selection and swipe feedback stay available; only submission uses close admission.
enum RuntimeCloseBlockReason: Equatable {
    case incompleteTasks, unconfirmedTasks, activeTasks, unavailableCommand

    var message: String {
        switch self {
        case .incompleteTasks: L10n.tr("后台任务清单不完整，暂不能关闭会话。")
        case .unconfirmedTasks: L10n.tr("后台任务状态待核对，暂不能关闭会话。")
        case .activeTasks: L10n.tr("后台任务尚未结束，暂不能关闭会话。")
        case .unavailableCommand: L10n.tr("部分会话暂不支持远程关闭，或可用命令尚未就绪，请稍后重试。")
        }
    }
}

struct BackgroundTask: Codable, Hashable, Identifiable {
    var id: String
    var parentId: String? = nil
    var title: String
    var kind: String
    var status: String
    var statusTitle: String {
        ["pending": L10n.tr("启动中"), "running": L10n.tr("工作中"), "waiting": L10n.tr("等待"), "idle": L10n.tr("空闲"), "completed": L10n.tr("完成"),
         "failed": L10n.tr("失败"), "killed": L10n.tr("已停止"), "unknown": L10n.tr("未知")][status] ?? L10n.tr("未知")
    }
    var isActive: Bool { ["pending", "running", "waiting"].contains(status) }
    /// S60 / SC108: Claude's background shells and Monitors; every other kind is an agent.
    var isCommand: Bool { kind == "shell" || kind == "monitor" }
    var kindTitle: String { kind == "shell" ? L10n.tr("命令") : kind == "monitor" ? L10n.tr("监听") : kind }
    var displayTitle: String { title.isEmpty ? kindTitle : title }
    /// The kind line never repeats what the title already says.
    var showsKind: Bool { !title.isEmpty && !kindTitle.isEmpty && kindTitle != title }
}

/// S60 / SC108: agents first, each followed by the commands it started; then the session's own commands.
struct BackgroundTaskGroups: Equatable {
    struct Row: Equatable, Identifiable {
        let task: BackgroundTask
        let nested: Bool
        var id: String { task.id }
    }
    var agents: [Row]
    var commands: [Row]
}

struct BackgroundTaskInventory: Codable, Hashable {
    var availability: String
    var items: [BackgroundTask]
    var truncated: Bool
    var valid: Bool {
        ["ready", "unknown", "unavailable"].contains(availability) && items.count <= 256 &&
        Set(items.map(\.id)).count == items.count && !(availability == "ready" && truncated) && items.allSatisfy {
            !$0.id.isEmpty && $0.id.utf16.count <= 256 && $0.title.utf16.count <= 256 && $0.kind.utf16.count <= 128 &&
            ($0.parentId == nil || (!$0.parentId!.isEmpty && $0.parentId!.utf16.count <= 256)) &&
            ["pending", "running", "waiting", "idle", "completed", "failed", "killed", "unknown"].contains($0.status)
        }
    }
    var confirmed: Bool { availability == "ready" && !truncated && !items.contains { $0.status == "unknown" } }
    var activeCount: Int { items.filter(\.isActive).count }
    var activeAgentCount: Int { items.filter { $0.isActive && !$0.isCommand }.count }
    var activeCommandCount: Int { items.filter { $0.isActive && $0.isCommand }.count }
    var allowsQuit: Bool { confirmed && activeCount == 0 }
    var visible: Bool { !items.isEmpty || truncated }
    var panelTitle: String {
        let agents = items.filter { !$0.isCommand }.count, commands = items.count - agents
        let base = commands == 0 ? L10n.tr("子代理 {0} 项", agents) : agents == 0 ? L10n.tr("后台命令 {0} 项", commands)
            : "\(L10n.tr("子代理 {0}", agents)) · \(L10n.tr("后台命令 {0}", commands))"
        if truncated { return L10n.tr("{0}，清单不完整", base) }
        if !confirmed { return L10n.tr("{0}，状态待核对", base) }
        return base
    }
    /// Active work by category, as the session summary counts it.
    var activeCountTitle: String {
        [activeAgentCount > 0 ? L10n.tr("{0} 个子代理", activeAgentCount) : nil,
         activeCommandCount > 0 ? L10n.tr("{0} 个后台命令", activeCommandCount) : nil].compactMap { $0 }.joined(separator: " · ")
    }
    var groups: BackgroundTaskGroups {
        let agents = items.filter { !$0.isCommand }
        let agentIDs = Set(agents.map(\.id))
        let started = Dictionary(grouping: items.filter { $0.isCommand && agentIDs.contains($0.parentId ?? "") }) { $0.parentId ?? "" }
        return BackgroundTaskGroups(
            agents: agents.flatMap { [.init(task: $0, nested: false)] + (started[$0.id] ?? []).map { .init(task: $0, nested: true) } },
            commands: items.filter { $0.isCommand && !agentIDs.contains($0.parentId ?? "") }.map { .init(task: $0, nested: false) })
    }
    var inventoryNotice: String? {
        if truncated { return L10n.tr("清单不完整，显示已知任务") }
        if !confirmed { return L10n.tr("状态待核对，显示最后已知信息") }
        return nil
    }
    /// Partial inventories update known IDs but cannot remove unseen rows or prove closure.
    func reconciled(previous: BackgroundTaskInventory?) -> BackgroundTaskInventory {
        guard availability != "ready", let previous else { return self }
        var result = self
        guard truncated else { result.items = previous.items; return result }
        let incoming = Dictionary(uniqueKeysWithValues: items.map { ($0.id, $0) })
        let previousIDs = Set(previous.items.map(\.id))
        let merged = previous.items.map { incoming[$0.id] ?? $0 } + items.filter { !previousIDs.contains($0.id) }
        result.items = merged.count <= 256 ? merged :
            items + Array(previous.items.filter { incoming[$0.id] == nil }.prefix(256 - items.count))
        return result
    }
    var activityTitle: String? {
        guard visible else { return nil }
        let separator = AppLocalization.shared.language == .english ? ", " : "，"
        func summary(_ states: [(String, String)]) -> String {
            let agents = states.compactMap { state, title -> String? in
                let count = items.filter { $0.status == state && !$0.isCommand }.count
                return count > 0 ? L10n.tr("{0} 个子代理{1}", count, title) : nil
            }.joined(separator: separator)
            return [agents.isEmpty ? nil : agents, activeCommandCount > 0 ? L10n.tr("{0} 个后台命令", activeCommandCount) : nil]
                .compactMap { $0 }.joined(separator: " · ")
        }
        if truncated {
            let known = summary([("running", L10n.tr("工作中")), ("pending", L10n.tr("启动中")), ("waiting", L10n.tr("等待"))])
            return known.isEmpty ? panelTitle : L10n.tr("{0}，清单不完整", known)
        }
        guard confirmed else { return L10n.tr("后台任务状态待核对") }
        let labels = summary([("running", L10n.tr("运行中")), ("pending", L10n.tr("启动中")), ("waiting", L10n.tr("等待中"))])
        return labels.isEmpty ? nil : labels
    }
}

struct RuntimeModelInfo: Codable, Hashable {
    let provider: String
    let id: String
    let name: String?
}

struct RuntimeTurnConfiguration: Codable, Hashable {
    let turnId: String
    var model: RuntimeModelInfo? = nil
    var thinkingLevel: String? = nil
    var thinkingKnown: Bool = false
    init(turnId: String, model: RuntimeModelInfo? = nil, thinkingLevel: String? = nil, thinkingKnown: Bool = false) {
        self.turnId = turnId; self.model = model; self.thinkingLevel = thinkingLevel; self.thinkingKnown = thinkingKnown
    }
    private enum CodingKeys: String, CodingKey { case turnId, model, thinkingLevel }
    init(from decoder: Decoder) throws {
        let value = try decoder.container(keyedBy: CodingKeys.self)
        turnId = try value.decode(String.self, forKey: .turnId)
        model = try value.decodeIfPresent(RuntimeModelInfo.self, forKey: .model)
        thinkingLevel = try value.decodeIfPresent(String.self, forKey: .thinkingLevel)
        thinkingKnown = value.contains(.thinkingLevel)
    }
    func encode(to encoder: Encoder) throws {
        var value = encoder.container(keyedBy: CodingKeys.self)
        try value.encode(turnId, forKey: .turnId); try value.encodeIfPresent(model, forKey: .model)
        if thinkingKnown { try value.encode(thinkingLevel, forKey: .thinkingLevel) }
    }
}

struct SessionConfigFailure: Equatable {
    let setting: String
    let value: String
    let message: String
    let sessionId: String?
}

/// SC84: match Android's current-turn facts, selected next configuration and save
/// progress independently. A selected value never becomes evidence for an active turn.
struct SessionModelPresentation {
    let model: String?
    let thinking: String?
    let indicator: String?
    let current: RuntimeTurnConfiguration?
    let active: Bool
    let showsCurrent: Bool
    let selectionTitle: String?

    static func make(runtime: RuntimeSummary, connected: Bool, modelReady: Bool = true, executionReady: Bool = true,
                     progress: [(label: String, mark: String)] = [], failed: Bool = false) -> Self {
        let codex = runtime.agentKind == "codex" || runtime.runtimeId.hasPrefix("codex")
        let active = ["running", "waiting_local_interaction"].contains(runtime.status)
        let supported = runtime.currentTurnConfigurationSupported ?? (codex || runtime.currentTurnConfiguration != nil)
        let current = supported && connected && active && modelReady && executionReady &&
            runtime.currentTurnConfiguration?.turnId == runtime.executionTurnId ? runtime.currentTurnConfiguration : nil
        let different: Bool
        if let actual = current?.model, let selected = runtime.model {
            different = actual.id != selected.id || actual.provider != selected.provider ||
                (current?.thinkingKnown == true && current?.thinkingLevel != nil && current?.thinkingLevel != runtime.thinkingLevel)
        } else { different = false }
        let showsCurrent = active && supported && (codex || current?.model != nil)
        // SC86: a running turn alone is not a pending change. Hide duplicate
        // selections only when both native identity and depth are confirmed equal.
        let same = current?.model != nil && runtime.model != nil && !different &&
            current?.thinkingKnown == true && current?.thinkingLevel == runtime.thinkingLevel
        let selectionTitle: String? = showsCurrent && same ? nil :
            L10n.tr(different ? (codex || runtime.agentKind == "claude" ? "下轮使用" : "后续选择") : "当前所选")
        let indicator: String?
        if progress.contains(where: { L10n.matches($0.mark, source: "未确认") }) { indicator = L10n.tr("未确认") }
        else if !progress.isEmpty { indicator = L10n.tr("保存中") }
        else if failed { indicator = L10n.tr("修改失败") }
        else if different { indicator = L10n.tr(codex || runtime.agentKind == "claude" ? "下轮已设" : "后续已设") }
        else { indicator = nil }
        let showTurn = runtime.status != "idle" && supported && (codex || current?.model != nil)
        let selected = runtime.model.map { $0.name ?? $0.id }
        // Pi/Claude request facts can omit the catalog label. Reuse it only for
        // the exact same provider/id; a next selection cannot rename this request.
        let currentLabel = current?.model.map { actual in
            actual.name ?? (actual.provider == runtime.model?.provider && actual.id == runtime.model?.id
                ? runtime.model?.name : nil) ?? actual.id
        }
        return Self(model: showTurn ? currentLabel ?? L10n.tr("模型未确认") :
                        (active ? selected.map { L10n.tr("所选：{0}", $0) } : selected),
                    thinking: showTurn ? current?.thinkingLevel : runtime.thinkingLevel, indicator: indicator, current: current,
                    active: active, showsCurrent: showsCurrent, selectionTitle: selectionTitle)
    }
}

struct RuntimeContextUsage: Codable, Hashable {
    let tokens: Int64?
    let contextWindow: Int64?
    let percent: Double?
}

/// Host-owned attachment facts; an installed desktop app may still be closed or unable to attach.
struct CodexDesktopAttach: Codable, Hashable {
    let state: String
    let reason: String
    var valid: Bool {
        ["unsupported", "notInstalled", "closed", "attached", "error"].contains(state) &&
            !reason.isEmpty && reason.utf16.count <= 256
    }
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
    var hostname: String? = nil
    var codexLaunchModes: [CodexLaunchMode]? = nil
    var id: String { sessionId }
}

enum CodexLaunchMode: String, Codable, CaseIterable {
    case desktop, terminal
    var agentKind: String { self == .desktop ? "codexDesktop" : "codex" }
    var title: String { L10n.tr(self == .desktop ? "桌面启动" : "终端启动") }
}

/// A launch acknowledgement is matched against the selected native history store, not just a
/// thread ID: two CODEX_HOME stores can contain the same native ID.
func runtimeMatchesLaunch(_ runtime: RuntimeSummary, sessionId: String, codexCatalogId: String?,
                          launchMode: CodexLaunchMode?, agentKind: String?) -> Bool {
    guard runtime.sessionId == sessionId else { return false }
    if let codexCatalogId, runtime.codexCatalogId != codexCatalogId { return false }
    if let launchMode, runtime.agentKind != launchMode.agentKind { return false }
    if let agentKind, let runtimeKind = runtime.agentKind, runtimeKind != agentKind { return false }
    return true
}

struct MessageFileReference: Codable, Hashable {
    let fileName: String
    let referenceId: String?
    let line: Int64?
    let endLine: Int64?
}

private let messageFileTarget = try! NSRegularExpression(pattern: #"\Aorbis-message-file:[a-f0-9]{64}\z"#)
private let messageFileLink = try! NSRegularExpression(pattern: #"\[((?:\\.|[^\\\[\]\r\n])+)\]\(<orbis-message-file:[a-f0-9]{64}>\)"#)
private let escapedMessageLabel = try! NSRegularExpression(pattern: #"\\([\\`*_{}\[\]<>!~|&$])"#)

/// The App handles an Orbis action target; provider markup stays on the Host.
func messageFileReferenceId(_ target: String?) -> String? {
    guard let target, messageFileTarget.firstMatch(in: target, range: NSRange(target.startIndex..., in: target)) != nil else { return nil }
    return target
}

func copyableMessageText(_ text: String) -> String {
    guard text.contains("orbis-message-file:") else { return text }
    var result = text
    for match in messageFileLink.matches(in: text, range: NSRange(text.startIndex..., in: text)).reversed() {
        let label = (text as NSString).substring(with: match.range(at: 1))
        let unescaped = escapedMessageLabel.stringByReplacingMatches(in: label, range: NSRange(label.startIndex..., in: label), withTemplate: "$1")
        if let range = Range(match.range, in: result) { result.replaceSubrange(range, with: unescaped) }
    }
    return result
}

struct ChatContent: Codable, Hashable {
    let type: String
    let text: String?
    let toolName: String?
    let artifact: RemoteArtifact?
    var summary: ToolSummary? = nil
    var toolCallId: String? = nil
    var truncated: Bool? = nil
    var originalBytes: Int64? = nil
    var arguments: RemoteJSONValue? = nil
    var renderKind: String? = nil
    var file: MessageFileReference? = nil

    var renderLabel: String {
        guard let text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return L10n.tr("内容暂不可显示") }
        return renderKind == "file_reference" ? text : L10n.tr(text)
    }
    var fileAction: String? { type == "render" && renderKind == "file_reference" ? messageFileReferenceId(file?.referenceId) : nil }
    var visibleText: String? { type == "render" ? renderLabel : text.map(copyableMessageText) }

    enum CodingKeys: String, CodingKey {
        case type, text, toolName, artifact, summary, toolCallId, truncated, originalBytes, arguments, renderKind, file
    }
}

extension ChatContent {
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        type = try values.decode(String.self, forKey: .type)
        text = try values.decodeIfPresent(String.self, forKey: .text)
        toolName = try values.decodeIfPresent(String.self, forKey: .toolName)
        artifact = try values.decodeIfPresent(RemoteArtifact.self, forKey: .artifact)
        renderKind = try values.decodeIfPresent(String.self, forKey: .renderKind)
        file = renderKind == "file_reference" ? (try? values.decodeIfPresent(MessageFileReference.self, forKey: .file)) : nil
        summary = try values.decodeIfPresent(ToolSummary.self, forKey: .summary)
        toolCallId = try values.decodeIfPresent(String.self, forKey: .toolCallId)
        truncated = try values.decodeIfPresent(Bool.self, forKey: .truncated)
        originalBytes = try values.decodeIfPresent(Int64.self, forKey: .originalBytes)
        // An explicit null argument is a JSON value, distinct from an absent arguments field.
        arguments = values.contains(.arguments) ? try values.decode(RemoteJSONValue.self, forKey: .arguments) : nil
    }
}

/// Preserve native tool arguments across wire decoding, history persistence and exports.
/// Integer cases avoid rounding IDs and other large integral arguments through Double.
indirect enum RemoteJSONValue: Codable, Hashable {
    case object([String: RemoteJSONValue]), array([RemoteJSONValue]), string(String)
    case integer(Int64), unsigned(UInt64), number(Double), bool(Bool), null

    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() { self = .null }
        else if let bool = try? value.decode(Bool.self) { self = .bool(bool) }
        else if let integer = try? value.decode(Int64.self) { self = .integer(integer) }
        else if let unsigned = try? value.decode(UInt64.self) { self = .unsigned(unsigned) }
        else if let number = try? value.decode(Double.self) { self = .number(number) }
        else if let string = try? value.decode(String.self) { self = .string(string) }
        else if let array = try? value.decode([RemoteJSONValue].self) { self = .array(array) }
        else { self = .object(try value.decode([String: RemoteJSONValue].self)) }
    }

    func encode(to encoder: Encoder) throws {
        var value = encoder.singleValueContainer()
        switch self {
        case .object(let object): try value.encode(object)
        case .array(let array): try value.encode(array)
        case .string(let string): try value.encode(string)
        case .integer(let integer): try value.encode(integer)
        case .unsigned(let unsigned): try value.encode(unsigned)
        case .number(let number): try value.encode(number)
        case .bool(let bool): try value.encode(bool)
        case .null: try value.encodeNil()
        }
    }
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
    var argument: Argument?
    var id: String { name }
    struct Argument: Codable, Hashable {
        let kind: String
        let required: Bool
        let hint: String?
        var options: [RuntimeOption]?
        var optionCatalog: MenuOptionCatalog? = nil
    }
}

struct MenuOptionCatalog: Codable, Hashable {
    let id: String
    let count: Int
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
    var forDownload = false
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
    var toolCallId: String? = nil
    var toolName: String? = nil
    /// ADR-0049：由手机发送产生时，源端带回的原 messageId；只用于对账本地待确认发送。
    var clientMessageId: String? = nil
    var clientMessageIds: [String]? = nil
    func materializesClientMessage(_ id: String) -> Bool {
        messageId == id || clientMessageId == id || clientMessageIds?.contains(id) == true
    }
    var id: String { messageId }
    var text: String {
        content.compactMap { item -> String? in
            if let text = item.visibleText, !text.isEmpty { return text }
            if item.type == "tool_call" { return L10n.tr("使用工具：{0}", item.toolName ?? L10n.tr("工具")) }
            if item.type == "artifact", let file = item.artifact?.fileName { return L10n.tr("附件：{0}", file) }
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
    var toolName: String? = nil
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

/// SC92: only explicitly classified F3/F4 feedback enters the shared presentation queue.
enum FeedbackLevel { case toast, banner }
enum FeedbackCondition: Int, CaseIterable, Comparable {
    case pairing, version, computerClosed, other
    static func < (lhs: Self, rhs: Self) -> Bool { lhs.rawValue < rhs.rawValue }
}
enum FeedbackAction: Equatable { case pair, reconnect, settings, update, restoreDraft }
struct FeedbackNotice: Equatable, Identifiable {
    let id: UUID
    let key: String
    let text: String
    let action: FeedbackAction?
    init(key: String, text: String, action: FeedbackAction? = nil) { id = UUID(); self.key = key; self.text = text; self.action = action }
}
struct FeedbackState: Equatable {
    struct Condition: Equatable { let priority: FeedbackCondition; let notice: FeedbackNotice }
    private(set) var conditions: [String: Condition] = [:]
    private(set) var dismissed: Set<String> = []
    private var shownToastKeys: [String] = []
    private(set) var toast: FeedbackNotice?
    private(set) var foreground = true
    private var visibleCondition: String? {
        conditions.keys.filter { !dismissed.contains($0) }.sorted {
            let lhs = conditions[$0]!.priority, rhs = conditions[$1]!.priority
            return lhs == rhs ? $0 < $1 : lhs < rhs
        }.first
    }
    var banner: FeedbackNotice? { visibleCondition.flatMap { conditions[$0]?.notice } }
    mutating func present(_ level: FeedbackLevel, text: String, condition: FeedbackCondition? = nil, key: String? = nil, action: FeedbackAction? = nil) {
        switch level {
        case .toast:
            if let key {
                guard !shownToastKeys.contains(key) else { return }
                shownToastKeys.append(key)
                if shownToastKeys.count > 128 { shownToastKeys.removeFirst(shownToastKeys.count - 128) }
            }
            guard foreground else { return }
            let identity = key ?? text
            guard toast?.key != identity else { return }
            toast = FeedbackNotice(key: identity, text: text, action: action)
        case .banner:
            precondition(condition != nil && action != nil, "F4 requires a stable condition and a resolving action")
            guard let condition else { return }
            let key = key ?? String(condition.rawValue)
            guard conditions[key] == nil else { return }
            conditions[key] = Condition(priority: condition, notice: FeedbackNotice(key: key, text: text, action: action))
        }
    }
    mutating func resolve(_ condition: FeedbackCondition) {
        let keys = conditions.filter { $0.value.priority == condition }.map(\.key)
        for key in keys { resolve(key: key) }
    }
    mutating func resolve(key: String) { conditions[key] = nil; dismissed.remove(key) }
    mutating func dismissBanner() { if let key = visibleCondition { dismissed.insert(key) } }
    mutating func dismissToast(_ id: UUID? = nil) { if id == nil || toast?.id == id { toast = nil } }
    mutating func setForeground(_ value: Bool) { foreground = value; if !value { toast = nil } }
    mutating func clearTransientPresentation() { toast = nil }
    mutating func clear() { conditions = [:]; dismissed = []; shownToastKeys = []; clearTransientPresentation() }
}

/// Design token hold-toast, shared by all F3 lifecycles.
enum FeedbackTiming { static let holdToast: Double = 4 }

/// Only presentation text is normalized; wire codes and original details stay in diagnostics.
enum FeedbackText {
    static func protocolCondition(_ code: String?) -> FeedbackCondition? {
        switch code {
        case "unauthorized", "device_mismatch", "runtime_mismatch": .pairing
        case "protocol_version_mismatch", "invalid_message": .version
        case "host_disabled": .other
        default: nil
        }
    }
    static func reason(_ value: String) -> String {
        switch value {
        case "agent_unsupported", "对应的 agent 后端未就绪": return L10n.tr("所选助手尚未就绪，请在电脑端检查")
        case "invalid_request": return L10n.tr("操作未完成，请重试")
        default: break
        }
        if value.range(of: "^[a-z][a-z0-9_:-]*_[a-z0-9_:-]+$", options: .regularExpression) != nil {
            return L10n.tr("操作未完成，请重试")
        }
        // SC103: codes are lower-case snake tokens; upper-case names such as environment variables are user-facing.
        var display = value.replacingOccurrences(of: "[（(]\\s*[a-z][a-z0-9]*(?:_[a-z0-9]+)+\\s*[）)]", with: "", options: .regularExpression)
        // Strip protocol tokens while preserving normal filenames and user paths containing underscores.
        // SC101: a dot is part of a name only before an extension; sentence punctuation still ends the code.
        if display.range(of: "(?<![A-Za-z0-9/._-])[a-z][a-z0-9]*(?:_[a-z0-9]+)+(?![A-Za-z0-9/_-]|\\.[A-Za-z0-9])", options: .regularExpression) != nil {
            return L10n.tr("操作未完成，请重试")
        }
        for (term, replacement) in [("host", "Orbis"), ("runtime", L10n.tr("会话")), ("relay", L10n.tr("连接"))] {
            display = display.replacingOccurrences(of: "(?i)(?<![A-Za-z0-9/._\\\\-])" + term + "(?![A-Za-z0-9/._\\\\-])", with: replacement, options: .regularExpression)
        }
        display = display.trimmingCharacters(in: .whitespacesAndNewlines)
        return display.isEmpty ? L10n.tr("操作未完成，请重试") : display
    }
}

/// FILE-BROWSER-02: persists the last successfully opened downloads folder per paired Host.
struct DownloadBrowserPathStore {
    private static let preferenceKey = "orbis.downloadBrowserPaths.v1"
    private let preferences: UserDefaults?

    init(preferences: UserDefaults?) {
        self.preferences = preferences
    }

    func path(hostId: String) -> String? {
        values[hostId].flatMap { $0.isEmpty ? nil : $0 }
    }

    func remember(_ path: String, hostId: String) {
        var next = values
        guard next[hostId] != path else { return }
        next[hostId] = path
        preferences?.set(next, forKey: Self.preferenceKey)
    }

    func remove(hostId: String) {
        var next = values
        next.removeValue(forKey: hostId)
        preferences?.set(next, forKey: Self.preferenceKey)
    }

    private var values: [String: String] {
        preferences?.dictionary(forKey: Self.preferenceKey) as? [String: String] ?? [:]
    }
}
