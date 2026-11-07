import Foundation
import Combine

func connectionProtocolText(_ relayKind: RelayTransportKind?, path: String?, connected: Bool) -> String {
    guard connected else { return L10n.tr("暂不可用") }
    // LAN uses its own WebSocket even when the standby Relay uses QUIC.
    if path == "lan" { return "WS" }
    return relayKind?.rawValue.uppercased() ?? L10n.tr("暂不可用")
}

func relayTransportModeDescription(_ mode: RelayTransportMode) -> String {
    switch mode {
    case .auto: return L10n.tr("自动模式使用 WS")
    case .ws: return L10n.tr("强制使用 WS")
    case .quic: return L10n.tr("强制使用 QUIC；准备失败时保留当前连接并报告错误")
    }
}

func connectionLatencyText(_ rttMs: Double?, connected: Bool) -> String {
    guard connected, let rttMs, rttMs.isFinite, rttMs >= 0 else { return L10n.tr("暂不可用") }
    return String(format: "%.0f ms", locale: Locale(identifier: "en_US_POSIX"), rttMs.rounded())
}

/// A promoted or removed reading anchor keeps the pixel offset instead of dragging the reader.
func catalogAnchorMoved(previous: [String], current: [String], anchor: String, updated: Set<String>? = nil) -> Bool {
    guard let old = previous.firstIndex(of: anchor), let next = current.firstIndex(of: anchor) else { return true }
    if let updated { return old != next && updated.contains(anchor) }
    let positions = Dictionary(uniqueKeysWithValues: current.enumerated().map { ($0.element, $0.offset) })
    return previous[..<old].contains { (positions[$0] ?? -1) > next }
}
import Combine

struct SessionProviderOption: Identifiable {
    let key: String
    let label: String
    var id: String { key }
}

func sessionProviderOptions(_ sessions: [SessionSummary], kind: String, current: String?, knownProviders: [String] = [], hasUnknown: Bool = false) -> [SessionProviderOption] {
    let rows = sessions.filter { $0.agentKind == kind }
    var result = [SessionProviderOption(key: "current", label: current.map { L10n.tr("{0}（当前使用）", $0) } ?? L10n.tr("当前 provider（尚未获取）")),
                  SessionProviderOption(key: "all", label: L10n.tr("全部 provider"))]
    let providers = Set((rows.compactMap(\.modelProvider) + knownProviders).filter { !$0.isEmpty }).sorted()
    result += providers.filter { $0 != current }.map { SessionProviderOption(key: "provider:" + $0, label: $0) }
    if hasUnknown || rows.contains(where: { $0.modelProvider == nil || $0.modelProvider?.isEmpty == true }) {
        result.append(SessionProviderOption(key: "unknown", label: L10n.tr("未知 provider")))
    }
    return result
}

func matchesSessionProvider(_ session: SessionSummary, filter: String, current: String?) -> Bool {
    let provider = session.modelProvider.flatMap { $0.isEmpty ? nil : $0 }
    switch filter {
    case "all": return true
    case "current": return current != nil && provider == current
    case "unknown": return provider == nil
    default: return filter.hasPrefix("provider:") && provider == String(filter.dropFirst("provider:".count))
    }
}

/// Session list time in the app's own language: 今天 / 昨天 with a clock time, then a date.
func sessionTimeTitle(_ milliseconds: Int64, now: Date = Date(), calendar: Calendar = .current) -> String {
    let date = Date(timeIntervalSince1970: Double(milliseconds) / 1000)
    let formatter = DateFormatter()
    formatter.locale = L10n.locale; formatter.calendar = calendar; formatter.timeZone = calendar.timeZone
    if calendar.isDate(date, inSameDayAs: now) { formatter.dateFormat = L10n.tr("今天 HH:mm") }
    else if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) { formatter.dateFormat = L10n.tr("昨天 HH:mm") }
    else if calendar.isDate(date, equalTo: now, toGranularity: .year) { formatter.dateFormat = L10n.tr("M月d日") }
    else { formatter.dateFormat = L10n.tr("yyyy年M月d日") }
    return formatter.string(from: date)
}

/// A Codex session owned by a provider other than the current one; nil when it matches or is unknown.
func sessionOtherProvider(_ session: SessionSummary, current: String?) -> String? {
    guard session.agentKind == "codex" || session.agentKind == "codexDesktop",
          let provider = session.modelProvider, !provider.isEmpty, let current, provider != current else { return nil }
    return provider
}

/// Label for a slash command's source; nil for the agent's own built-ins (same words as Android).
func slashSourceTitle(_ source: String?) -> String? {
    switch source {
    case nil, "builtin": return nil
    case "extension": return L10n.tr("扩展")
    case "prompt": return L10n.tr("模板")
    case "skill": return "Skill"
    default: return source
    }
}

/// How a message sent during a running turn is delivered; the same words on Android.
func deliveryTitle(_ delivery: String) -> String { delivery == "steer" ? L10n.tr("插入当前任务") : L10n.tr("完成后发送") }

func runtimeStatusTitle(_ status: String) -> String {
    switch status {
    case "running": return L10n.tr("运行中")
    case "compacting": return L10n.tr("压缩中")
    case "background": return L10n.tr("子任务运行中")
    case "tasks_unknown": return L10n.tr("子任务状态待核对")
    case "waiting", "waiting_interaction", "waiting_local_interaction": return L10n.tr("等待确认")
    case "error": return L10n.tr("异常")
    case "idle": return L10n.tr("空闲")
    case "unknown": return L10n.tr("状态待核对")
    case "starting": return L10n.tr("启动中")
    case "launch_unconfirmed": return L10n.tr("启动未确认")
    default: return status
    }
}

func sessionMessagePreview(_ raw: String?) -> String? {
    guard let raw else { return nil }
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }
    var sentence = ""
    for character in trimmed {
        if character == "\n" || character == "\r" { break }
        sentence.append(character)
        if "。！？.!?".contains(character) { break }
    }
    sentence = sentence.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    return sentence.count > 40 ? String(sentence.prefix(39)).trimmingCharacters(in: .whitespaces) + "…" : sentence
}

func sessionTitle(runtime: RuntimeSummary?, session: SessionSummary?, messages: [ChatMessage] = []) -> String {
    for candidate in [runtime?.sessionName, session?.name] {
        if let title = candidate?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty { return title }
    }
    if let preview = sessionMessagePreview(session?.firstMessage) { return preview }
    for message in messages where message.role == "user" {
        if let preview = sessionMessagePreview(message.content.filter { $0.type == "text" }.compactMap(\.text).joined(separator: "\n")) { return preview }
    }
    return session?.sessionId ?? runtime?.sessionId ?? runtime?.runtimeId ?? L10n.tr("Session 已离线")
}

func directoryTitle(_ path: String) -> String {
    path.replacingOccurrences(of: "\\", with: "/").split(separator: "/").last.map(String.init) ?? path
}

func remoteBrowsePath(parent: String?, name: String) -> String {
    guard let parent, !parent.isEmpty else { return name }
    if parent.hasSuffix("/") || parent.hasSuffix("\\") { return parent + name }
    let separator = parent.hasPrefix("/") || (parent.contains("/") && !parent.contains("\\")) ? "/" : "\\"
    return parent + separator + name
}

/// Include the pairing namespace and session identity: a different computer,
/// re-pairing, or a runtime moving to another session must never inherit a draft.
func localSessionKey(host: HostPairing?, runtime: RuntimeSummary) -> String {
    let components = [host?.relay.relayUrl ?? "", host?.relay.deviceId ?? "", host?.hostId ?? "", runtime.runtimeId, runtime.sessionId ?? ""]
    return components.map { "\($0.utf8.count):\($0)" }.joined()
}

func offlineSessionKey(host: HostPairing?, sessionId: String) -> String {
    [host?.relay.relayUrl ?? "", host?.relay.deviceId ?? "", host?.hostId ?? ""].map { "\($0.utf8.count):\($0)" }.joined() + "session:\(sessionId.utf8.count):\(sessionId)"
}

/// 一台已配对电脑在本机偏好里的键前缀；草稿与会话目录缓存都以它开头。
func hostKeyPrefix(_ host: HostPairing) -> String {
    [host.relay.relayUrl, host.relay.deviceId, host.hostId].map { "\($0.utf8.count):\($0)" }.joined()
}

struct SessionDirectory: Identifiable {
    let path: String
    let sessions: [SessionSummary]
    var id: String { path }
    /// 目录的「最近使用」时间 = 其中最新会话的修改时间（与 Android `CachedDirectoryGroup.modifiedAt` 一致）。
    var modifiedAt: Int64 { sessions.map(\.modifiedAt).max() ?? 0 }
}

/// 展开的目录默认只列出最近的几条会话，其余由「再显示 N 个会话」展开（与 Android 侧栏一致）。
let directorySessionPreviewLimit = 5

/// 目录按最近使用排序：最新会话越新越靠前，同一时间再按路径；目录内会话按修改时间倒序。
func sessionDirectories(_ sessions: [SessionSummary], query: String, kind: String?, archived: Bool,
                        title: (SessionSummary) -> String) -> [SessionDirectory] {
    let term = query.trimmingCharacters(in: .whitespacesAndNewlines)
    let visible = sessions.filter { session in
        (session.archived == true) == archived && (kind == nil || session.agentKind == kind) &&
        (term.isEmpty || session.cwd.localizedCaseInsensitiveContains(term) || title(session).localizedCaseInsensitiveContains(term))
    }
    return Dictionary(grouping: visible, by: \.cwd).map { path, sessions in
        SessionDirectory(path: path, sessions: sessions.sorted { lhs, rhs in
            lhs.modifiedAt != rhs.modifiedAt ? lhs.modifiedAt > rhs.modifiedAt : lhs.sessionId < rhs.sessionId
        })
    }.sorted { lhs, rhs in
        let left = lhs.modifiedAt, right = rhs.modifiedAt
        return left != right ? left > right : lhs.path.localizedStandardCompare(rhs.path) == .orderedAscending
    }
}

/// 侧栏一次只展开一个目录：优先当前会话所在目录，否则展开最近使用的目录。
func defaultExpandedDirectory(_ directories: [SessionDirectory], preferred: String?) -> String? {
    if let preferred, directories.contains(where: { $0.path == preferred }) { return preferred }
    return directories.first?.path
}

/// Host 的 runtime 元数据（`RuntimeMetadata`）不携带 agentKind，缺省会被当成 Pi。
/// 展示时先用会话目录里同一 sessionId 的 agentKind（Host 扫描出的事实），
/// 再退回 Host 的 runtimeId 约定：`codex` / `codex:<thread>`、`codex-desktop` / `codex-desktop:<thread>`、`dsh:<id>`、`claude:<session>`。
/// Pi 的 runtimeId 是随机 UUID，不会命中这些前缀。
/// `catalogKind` 是目录里同一 sessionId 的 agentKind，调用方用索引查好再传入。
func resolvedAgentKind(runtimeId: String, declared: String?, catalogKind: String?) -> String? {
    if let declared, !declared.isEmpty { return declared }
    if let catalogKind, !catalogKind.isEmpty { return catalogKind }
    return runtimeAgentKind(runtimeId)
}

func runtimeAgentKind(_ runtimeId: String) -> String? {
    func owned(by prefix: String) -> Bool { runtimeId == prefix || runtimeId.hasPrefix(prefix + ":") }
    if owned(by: "codex-desktop") { return "codexDesktop" }
    if owned(by: "codex") { return "codex" }
    if runtimeId.hasPrefix("dsh:") { return "dsh" }
    if runtimeId.hasPrefix("claude:") { return "claude" }
    return nil
}

struct MarkdownBlock: Identifiable, Equatable {
    enum Kind: Equatable { case text, code(String) }
    let id: Int
    let kind: Kind
    let text: String
}

struct ChatRow: Identifiable {
    var messages: [ChatMessage]
    /// Optional explicit copy scope; ordinary visual cards copy their own content.
    var copyMessages: [ChatMessage]? = nil
    var copyText: String? = nil
    /// Compared by the UI without walking a whole long turn. Reused by the transcript worker.
    var contentRevision = UUID()
    var cardId: String? = nil
    var completedMessageIds: Set<String>? = nil
    var id: String { cardId ?? messages[0].messageId }
    var isUser: Bool { messages[0].role == "user" }
    var completedIds: Set<String> { completedMessageIds ?? Set(messages.map(\.messageId)) }
}

/// A pointer into the existing transcript, never a new message or an inferred turn identity.
struct ChatQuestion: Equatable {
    let messageId: String
    let text: String

    init?(_ message: ChatMessage) {
        guard message.role == "user", message.isError != true else { return nil }
        let text = message.content.compactMap { block -> String? in
            if block.type == "text", let text = block.text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return text }
            if block.type == "artifact", let file = block.artifact { return L10n.tr("附件：{0}", file.fileName) }
            return nil
        }.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        self.messageId = message.messageId
        self.text = text
    }
}

// Message packing is a transport detail. Prose has a shared block budget; tools page locally.
let chatCardProseLimit = 4
let chatToolPageSize = 8
func chatViewportRows(_ rows: [ChatRow], previous: [ChatRow] = []) -> [ChatRow] { rows }

struct ChatPresentation {
    let messages: [ChatMessage]
    let toolResults: [String: ChatMessage]
}

/// A projection applies many replacements as one batch. Tombstones preserve the original
/// remove-then-append ordering without copying/scanning the complete transcript per row.
struct ChatMessageBatch {
    private var slots: [ChatMessage?]
    private var positions: [String: [Int]]
    init(_ messages: [ChatMessage]) {
        slots = messages.map(Optional.some)
        positions = [:]
        for (index, message) in messages.enumerated() { positions[message.messageId, default: []].append(index) }
    }
    mutating func upsert(_ message: ChatMessage) {
        if let index = positions[message.messageId]?.first {
            if slots[index] != message { slots[index] = message }
        } else {
            positions[message.messageId] = [slots.count]
            slots.append(message)
        }
    }
    mutating func remove(_ id: String) {
        for index in positions.removeValue(forKey: id) ?? [] { slots[index] = nil }
    }
    var messages: [ChatMessage] { slots.compactMap { $0 } }
}

/// Tool results belong to their call, and a persisted replacement keeps the
/// first message's position while replacing its content.
func chatPresentation(_ messages: [ChatMessage]) -> ChatPresentation {
    var order: [String] = [], byId: [String: ChatMessage] = [:]
    for message in messages {
        if byId[message.messageId] == nil { order.append(message.messageId) }
        byId[message.messageId] = message
    }
    let normalized = order.compactMap { byId[$0] }.filter { message in
        message.toolSummary != nil || message.content.contains { block in
            if block.type == "artifact" { return block.artifact != nil }
            if ["tool_call", "toolCall"].contains(block.type) { return block.toolCallId?.isEmpty == false || block.toolName?.isEmpty == false || block.arguments != nil || block.text?.isEmpty == false }
            return block.text?.isEmpty == false
        }
    }
    let results = Dictionary(normalized.compactMap { message -> (String, ChatMessage)? in
        guard message.role == "tool", let id = message.toolCallId else { return nil }
        return (id, message)
    }, uniquingKeysWith: { _, last in last })
    let represented = Set(normalized.flatMap(\.content).compactMap(\.toolCallId))
    let visible = normalized.compactMap { message -> ChatMessage? in
        guard message.role == "tool" else { return message }
        guard let summary = message.toolSummary, !represented.contains(message.toolCallId ?? "") else { return nil }
        return ChatMessage(messageId: message.messageId, role: "assistant", content: [
            ChatContent(type: "tool_call", text: nil, toolName: message.toolName ?? summary.toolName, artifact: nil,
                summary: summary, toolCallId: message.toolCallId ?? summary.tool?.toolCallId)
        ], timestamp: message.timestamp, isError: message.isError)
    }
    return ChatPresentation(messages: visible, toolResults: results)
}

func toolArgumentsText(_ content: ChatContent) -> String? {
    guard let arguments = content.arguments else { return content.text }
    let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    return (try? encoder.encode(arguments)).map { String(decoding: $0, as: UTF8.self) }
}

func fullMessageText(_ message: ChatMessage) -> String {
    message.content.compactMap { content in
        if ["tool_call", "toolCall"].contains(content.type) {
            return "[工具] " + (content.toolName ?? message.toolName ?? L10n.tr("工具")) + "\n" + (toolArgumentsText(content) ?? "")
        }
        return content.text
    }.joined(separator: "\n\n")
}

func desktopAttachTitle(_ state: String?) -> String {
    ["attached": L10n.tr("已接入"), "closed": L10n.tr("未接入"), "notInstalled": L10n.tr("未安装"), "unsupported": L10n.tr("不可用"), "error": L10n.tr("接入失败")][state ?? ""] ?? L10n.tr("未知")
}

/// Everything the chat list derives from messages and turn timings. It is built once per change
/// of those inputs, never per view update (Android remembers the same projection by its inputs);
/// rebuilding it on every scroll frame kept the main thread busy on long sessions.
struct ChatTranscript {
    let rows: [ChatRow]
    let firstMessageId: String?
    let questions: [ChatQuestion]
    /// Only the tool results and timings that belong to each row, so an unchanged row compares equal.
    let toolResultsByRow: [String: [String: ChatMessage]]
    let timingsByRow: [String: [SessionTurnTiming]]
    let changeAnchorsByRow: [String: Set<String>]
    let contentRevision: UUID

    static let empty = ChatTranscript(messages: [], turnTimings: [:])

    func latestQuestion(excluding messageIds: Set<String>) -> ChatQuestion? {
        questions.last { !messageIds.contains($0.messageId) }
    }

    init(messages: [ChatMessage], turnTimings: [String: SessionTurnTiming], previousRows: [ChatRow] = [],
         displayIds: [String: String] = [:], aliases: [String: String] = [:], contentRevision: UUID = UUID()) {
        let presentation = chatPresentation(messages)
        let timings = turnTimings.values.sorted { ($0.startedAt, $0.turnId) < ($1.startedAt, $1.turnId) }
        let turnIds = Dictionary(timings.compactMap { timing in timing.messageId.map { ($0, timing.turnId) } }, uniquingKeysWith: { _, last in last })
        let timingsByMessage = Dictionary(grouping: timings.filter { $0.messageId != nil }, by: { $0.messageId! })
        let previousByID = Dictionary(previousRows.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
        rows = chatRows(presentation.messages, turnIdsByMessageId: turnIds, previous: previousRows).map { row in
            guard let old = previousByID[row.id], old.messages == row.messages,
                  old.copyMessages == row.copyMessages, old.copyText == row.copyText,
                  old.completedIds == row.completedIds else { return row }
            return old
        }
        firstMessageId = presentation.messages.first?.messageId
        questions = presentation.messages.compactMap(ChatQuestion.init)
        var results: [String: [String: ChatMessage]] = [:], rowTimings: [String: [SessionTurnTiming]] = [:]
        var anchorsByMessage: [String: Set<String>] = [:], rowAnchors: [String: Set<String>] = [:]
        for (entry, message) in displayIds { anchorsByMessage[message, default: []].insert(entry) }
        for (message, entry) in aliases { anchorsByMessage[message, default: []].insert(entry) }
        for row in rows {
            let calls = row.messages.flatMap { message in
                message.content.flatMap { [$0.toolCallId, $0.summary?.tool?.toolCallId].compactMap { $0 } } + [message.toolCallId].compactMap { $0 }
            }
            let owned = Dictionary(calls.compactMap { id in presentation.toolResults[id].map { (id, $0) } }, uniquingKeysWith: { first, _ in first })
            if !owned.isEmpty { results[row.id] = owned }
            let rowTiming = row.messages.filter { row.completedIds.contains($0.messageId) }.flatMap { timingsByMessage[$0.messageId] ?? [] }
            if !rowTiming.isEmpty { rowTimings[row.id] = rowTiming }
            let turn = row.copyMessages ?? row.messages
            if !row.isUser, row.messages.last?.messageId == turn.last?.messageId {
                var anchors = row.completedIds
                for message in turn where row.completedIds.contains(message.messageId) { anchors.formUnion(anchorsByMessage[message.messageId] ?? []) }
                rowAnchors[row.id] = anchors
            }
        }
        toolResultsByRow = results; timingsByRow = rowTimings
        changeAnchorsByRow = rowAnchors
        self.contentRevision = contentRevision
    }
}

/// S31: use visible reasoning/text/tool steps, independently of native turn and message packing.
func chatRows(_ messages: [ChatMessage], turnIdsByMessageId: [String: String] = [:], previous: [ChatRow] = []) -> [ChatRow] {
    var rows: [ChatRow] = [], pending: [ChatMessage] = [], completed = Set<String>()
    var cardId: String?, hasTools = false, hasText = false, proseCount = 0
    let starts = Set(previous.filter { !$0.isUser }.map(\.id))
    func flush() {
        if !pending.isEmpty {
            var row = ChatRow(messages: pending)
            row.cardId = cardId; row.completedMessageIds = completed
            row.copyText = pending.map(\.text).joined(separator: "\n\n")
            rows.append(row)
        }
        pending = []; completed = []; cardId = nil; hasTools = false; hasText = false; proseCount = 0
    }
    func partId(_ message: ChatMessage, _ index: Int) -> String {
        if message.content.indices.contains(index), let tool = message.content[index].toolCallId { return "tool-card:\(tool)" }
        return index == 0 ? message.messageId : "\(message.messageId):card:\(index)"
    }
    func append(_ message: ChatMessage, _ start: Int, _ end: Int) {
        if start == end && !message.content.isEmpty { return }
        if cardId == nil { cardId = partId(message, start) }
        if start == 0 && end == message.content.count { pending.append(message) }
        else {
            var fragment = ChatMessage(messageId: message.messageId, role: message.role, content: Array(message.content[start..<end]),
                                       timestamp: message.timestamp, isError: message.isError)
            fragment.toolSummary = message.toolSummary; fragment.toolCallId = message.toolCallId
            fragment.toolName = message.toolName; fragment.clientMessageId = message.clientMessageId
            pending.append(fragment)
        }
        if end == message.content.count { completed.insert(message.messageId) }
    }
    for message in messages {
        if message.role == "user" { flush(); rows.append(ChatRow(messages: [message])); continue }
        if !["assistant", "tool"].contains(message.role) || message.isError == true {
            flush(); append(message, 0, message.content.count); flush(); continue
        }
        var start = 0
        for (index, block) in message.content.enumerated() {
            let tool = message.role == "tool" || ["tool_call", "toolCall"].contains(block.type)
            if !tool && block.artifact == nil && (block.text?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true) { continue }
            let knownStart = starts.contains(partId(message, index)) && (!pending.isEmpty || start < index)
            if knownStart || !tool && (hasTools || block.type == "thinking" && hasText || proseCount >= chatCardProseLimit) {
                if start < index { append(message, start, index) }
                flush(); start = index
            }
            if tool { hasTools = true } else { proseCount += 1 }
            if block.type == "text" && !tool && block.text?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false { hasText = true }
        }
        append(message, start, message.content.count)
    }
    flush()
    return rows
}

struct ChatCardTool: Identifiable {
    let message: ChatMessage
    let block: ChatContent
    let index: Int
    var id: String { block.toolCallId ?? "\(message.messageId):tool:\(index)" }
    var displayMessage: ChatMessage {
        ChatMessage(messageId: id, role: "assistant", content: [block], timestamp: message.timestamp, isError: message.isError)
    }
}

func assistantCardContent(_ messages: [ChatMessage]) -> (prose: [ChatMessage], tools: [ChatCardTool]) {
    var prose: [ChatMessage] = [], tools: [ChatCardTool] = []
    for message in messages {
        let content = message.content.enumerated().compactMap { index, block -> ChatContent? in
            if ["tool_call", "toolCall"].contains(block.type) { tools.append(ChatCardTool(message: message, block: block, index: index)); return nil }
            return block
        }
        if content.isEmpty { continue }
        if content.count == message.content.count { prose.append(message) }
        else {
            prose.append(ChatMessage(messageId: message.messageId, role: message.role, content: content, timestamp: message.timestamp, isError: message.isError))
        }
    }
    return (prose, tools)
}

/// 宿主在运行中的回合里不会下发只含工具调用的 live 消息，而是放进工具清单（与 Android materializeToolPayload 一致）。
/// 这里把还没出现在消息里的工具还原成助手消息，并和 live 消息按 order 排序，使工具卡片落在对应的回复气泡里。
func materializeLiveTools(_ messages: [ChatMessage], tools: [ToolSummary], liveOrders: [String: Int64]) -> [ChatMessage] {
    guard !tools.isEmpty else { return messages }
    let represented = Set(messages.flatMap { message in
        message.content.flatMap { [$0.toolCallId, $0.summary?.tool?.toolCallId].compactMap { $0 } } + [message.toolSummary?.tool?.toolCallId].compactMap { $0 }
    })
    let synthetic = tools.compactMap { tool -> (order: Int64, message: ChatMessage)? in
        guard let id = tool.tool?.toolCallId, !represented.contains(id) else { return nil }
        let content = ChatContent(type: "tool_call", text: nil, toolName: tool.toolName, artifact: nil, summary: tool, toolCallId: id)
        return (tool.order, ChatMessage(messageId: "tool-live:\(id)", role: "assistant", content: [content], timestamp: 0, isError: nil))
    }
    guard !synthetic.isEmpty else { return messages }
    let settled = messages.filter { liveOrders[$0.messageId] == nil }
    let live = messages.compactMap { message in liveOrders[message.messageId].map { (order: $0, message: message) } }
    return settled + (live + synthetic).enumerated()
        .sorted { ($0.element.order, $0.offset) < ($1.element.order, $1.offset) }
        .map(\.element.message)
}

// Fenced blocks are kept verbatim, including unfinished streamed blocks. Inline
// formatting is rendered by AttributedString; code has its own scroll/copy UI.
func markdownBlocks(_ text: String) -> [MarkdownBlock] {
    var result: [MarkdownBlock] = []
    var lines: [String] = []
    var fence: String?
    var language = ""
    func flush() {
        guard !lines.isEmpty else { return }
        result.append(MarkdownBlock(id: result.count, kind: fence == nil ? .text : .code(language), text: lines.joined(separator: "\n")))
        lines = []
    }
    for line in text.components(separatedBy: "\n") {
        let candidate = line.trimmingCharacters(in: .whitespaces)
        if let current = fence {
            if candidate.hasPrefix(current), candidate.dropFirst(current.count).allSatisfy({ $0 == current.first! }) {
                flush(); fence = nil; language = ""
            } else { lines.append(line) }
        } else if candidate.hasPrefix("```") || candidate.hasPrefix("~~~") {
            flush()
            let marker = candidate.first!
            let prefix = candidate.prefix(while: { $0 == marker })
            fence = String(prefix)
            language = String(candidate.dropFirst(prefix.count)).trimmingCharacters(in: .whitespaces)
        } else { lines.append(line) }
    }
    flush()
    return result
}

struct MarkdownTextSection: Identifiable, Equatable {
    enum Kind: Equatable { case paragraph, line, table }
    let id: Int
    let kind: Kind
    let text: String
    var rows: [[String]] = []
    var inlineRows: [[AttributedString]] = []
}

func markdownTextSections(_ text: String) -> [MarkdownTextSection] {
    let lines = text.components(separatedBy: "\n")
    var sections: [MarkdownTextSection] = [], paragraph: [String] = []
    func flush() {
        if !paragraph.isEmpty {
            sections.append(MarkdownTextSection(id: sections.count, kind: .paragraph, text: paragraph.joined(separator: "\n")))
            paragraph = []
        }
    }
    func cells(_ line: String) -> [String] {
        var values: [String] = [], current = "", escaped = false, code = false
        for c in line.trimmingCharacters(in: .whitespaces) {
            if escaped { current.append(c); escaped = false }
            else if c == "\\" { current.append(c); escaped = true }
            else if c == "`" { code.toggle(); current.append(c) }
            else if c == "|" && !code { values.append(current.trimmingCharacters(in: .whitespaces)); current = "" }
            else { current.append(c) }
        }
        values.append(current.trimmingCharacters(in: .whitespaces))
        if values.first == "" { values.removeFirst() }; if values.last == "" { values.removeLast() }
        return values
    }
    var index = 0
    while index < lines.count {
        let line = lines[index], trimmed = line.trimmingCharacters(in: .whitespaces)
        if index + 1 < lines.count && line.contains("|") {
            let separators = cells(lines[index + 1])
            if !separators.isEmpty && separators.allSatisfy({ $0.range(of: "^:?-{3,}:?$", options: .regularExpression) != nil }) {
                flush()
                var rows = [cells(line)]; index += 2
                while index < lines.count, lines[index].contains("|"), !lines[index].trimmingCharacters(in: .whitespaces).isEmpty { rows.append(cells(lines[index])); index += 1 }
                sections.append(MarkdownTextSection(id: sections.count, kind: .table, text: separators.joined(separator: "|"), rows: rows))
                continue
            }
        }
        if trimmed.isEmpty { flush() }
        else if index + 1 < lines.count, lines[index + 1].trimmingCharacters(in: .whitespaces).range(of: "^(={3,}|-{3,})$", options: .regularExpression) != nil {
            flush(); sections.append(MarkdownTextSection(id: sections.count, kind: .line, text: (lines[index + 1].contains("=") ? "# " : "## ") + line)); index += 1
        } else if trimmed.hasPrefix("#") || trimmed.hasPrefix("> ") || trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") || trimmed.hasPrefix("![") || ["---", "***", "___"].contains(trimmed) || trimmed.range(of: "^\\d+[.)] ", options: .regularExpression) != nil {
            flush(); sections.append(MarkdownTextSection(id: sections.count, kind: .line, text: line))
        } else { paragraph.append(line) }
        index += 1
    }
    flush()
    return sections
}


struct InteractionDraftValue: Codable, Equatable {
    var input = ""
    var choices: Set<String> = []
    var answers: [String: Set<String>] = [:]
    var other: [String: String] = [:]
    var notes: [String: String] = [:]
    func response(for request: InteractionRequest) -> [String: Any] {
        var result: [String: Any] = ["kind": request.kind]
        switch request.kind {
        case "confirm": result["value"] = true
        case "select": result["value"] = choices.first ?? ""
        case "multi-select": result["values"] = (request.options ?? []).map(\.value).filter { choices.contains($0) }
        case "input": result["value"] = input
        case "questionnaire":
            result["answers"] = (request.questions ?? []).map { question -> [String: Any] in
                var answer: [String: Any] = ["id": question.id, "values": question.options.map(\.value).filter { answers[question.id]?.contains($0) == true }]
                if question.allowOther == true, let value = other[question.id], !value.isEmpty { answer["other"] = value }
                if question.allowNotes == true, let value = notes[question.id], !value.isEmpty { answer["notes"] = value }
                return answer
            }
        default: break
        }
        return result
    }
    func savable(for request: InteractionRequest) -> InteractionDraftValue {
        var copy = self
        if request.secret == true { copy.input = "" }
        let secrets = Set((request.questions ?? []).filter { $0.secret == true }.map(\.id))
        copy.answers = copy.answers.filter { !secrets.contains($0.key) }
        copy.other = copy.other.filter { !secrets.contains($0.key) }
        copy.notes = copy.notes.filter { !secrets.contains($0.key) }
        return copy
    }
}

@MainActor
final class InteractionDraftCache: ObservableObject {
    @Published private(set) var values: [String: InteractionDraftValue] = [:]
    private let preferences: UserDefaults?
    private let storageKey = "orbis.interactionDrafts.v1"
    init(preferences: UserDefaults? = .standard) {
        self.preferences = preferences
        if let data = preferences?.data(forKey: storageKey), let stored = try? JSONDecoder().decode([String: InteractionDraftValue].self, from: data) { values = stored }
    }
    func value(for key: String, request: InteractionRequest) -> InteractionDraftValue {
        values[key] ?? InteractionDraftValue(input: request.initialValue ?? "")
    }
    func save(_ value: InteractionDraftValue, for key: String, request: InteractionRequest) {
        if values[key] == nil, values.count >= 128, let oldest = values.keys.sorted().first { values[oldest] = nil }
        values[key] = value
        // Secret values remain in this cache's memory and never enter UserDefaults.
        var stored = preferences?.data(forKey: storageKey).flatMap { try? JSONDecoder().decode([String: InteractionDraftValue].self, from: $0) } ?? [:]
        stored[key] = value.savable(for: request)
        while stored.count > 128, let oldest = stored.keys.filter({ $0 != key }).sorted().first { stored[oldest] = nil }
        if let data = try? JSONEncoder().encode(stored) { preferences?.set(data, forKey: storageKey) }
    }
}

func contextUsagePercent(_ usage: RuntimeContextUsage?) -> Double? {
    guard let usage, let window = usage.contextWindow, window > 0 else { return nil }
    if let percent = usage.percent, percent.isFinite { return min(100, max(0, percent)) }
    return usage.tokens.map { min(100, max(0, Double($0) / Double(window) * 100)) }
}

func queueStateTitle(_ state: String) -> String {
    ["unconfirmed": L10n.tr("未确认"), "accepted": L10n.tr("已排队"), "queued": L10n.tr("排队中"), "submitting": L10n.tr("提交中"), "sending": L10n.tr("正在发送"), "delivered": L10n.tr("已送达"), "applied": L10n.tr("已应用"), "cancelled": L10n.tr("已撤回"), "rejected": L10n.tr("已拒绝"), "not_cancelable": L10n.tr("无法撤回"), "failed": L10n.tr("发送失败"), "expired": L10n.tr("已过期")][state] ?? state
}

func interactionDraftKey(host: HostPairing?, sessionId: String?, request: InteractionRequest) -> String {
    let components: [String] = [
        host?.relay.relayUrl ?? "",
        host?.relay.deviceId ?? "",
        host?.hostId ?? "",
        request.runtimeId,
        sessionId ?? "",
        request.extensionId,
        request.requestId,
    ]
    return components.map { "\($0.utf8.count):\($0)" }.joined()
}

/// One reveal timeline for a streamed message (ADR-0051 M04, ADR-0046 §4). Characters start
/// fading in strictly in rendered order: a new batch queues behind the tail that has not started
/// yet, so the end of one batch and the start of the next never animate at once. When the queue
/// would trail the stream by more than `maxDelay`, the spacing compresses (several adjacent
/// characters may start in the same frame) but the order never changes. Each character fades
/// from blur(6) to sharp over `duration`. Offsets are UTF-16 positions in the rendered text.
struct RevealClock: Equatable {
    struct Segment: Equatable {
        let start: Int
        let end: Int
        let time: TimeInterval
        let interval: TimeInterval
        func startTime(_ offset: Int) -> TimeInterval { time + Double(offset - start) * interval }
        var lastStart: TimeInterval { startTime(end - 1) }
    }
    static let duration: TimeInterval = 0.12
    static let stagger: TimeInterval = 0.03
    /// Everything known must have started revealing within this long of its arrival.
    static let maxDelay: TimeInterval = 0.45
    static let blur: CGFloat = 6

    private(set) var known: Int
    private(set) var segments: [Segment] = []
    /// Everything before this offset has settled.
    private(set) var settledBelow: Int

    init(known: Int) {
        self.known = known
        settledBelow = known
    }

    var end: TimeInterval { segments.last.map { $0.lastStart + Self.duration } ?? 0 }

    func isAnimating(at now: TimeInterval) -> Bool { !segments.isEmpty && now < end }

    mutating func observe(length: Int, at now: TimeInterval) {
        while let first = segments.first, first.lastStart + Self.duration <= now {
            settledBelow = first.end
            segments.removeFirst()
        }
        // Rewritten or shortened text settles at once; it never replays.
        if length < known { self = RevealClock(known: length); return }
        guard length > known else { return }
        let count = length - known
        let deadline = now + Self.maxDelay
        let next = segments.last.map { $0.lastStart + $0.interval } ?? now
        let first = min(max(next, now), deadline)
        let interval = count == 1 ? Self.stagger : min(Self.stagger, max(0, (deadline - first) / Double(count - 1)))
        segments.append(Segment(start: known, end: length, time: first, interval: interval))
        known = length
    }

    /// 0 = not shown yet, 1 = settled. Characters past `known` stay hidden until observed.
    func progress(_ offset: Int, at now: TimeInterval) -> Double {
        if offset < settledBelow { return 1 }
        if offset >= known { return 0 }
        guard let segment = segments.last(where: { $0.start <= offset }) else { return 1 }
        return min(max((now - segment.startTime(offset)) / Self.duration, 0), 1)
    }
}

/// One rendered Markdown row and where its text starts within the whole message.
struct MarkdownRow: Identifiable {
    enum Kind {
        case spacer, divider
        case text(AttributedString)
        case heading(Int, AttributedString)
        case quote(AttributedString)
        case task(Bool, AttributedString)
        case bullet(Int, AttributedString)
        case image(String, URL)
        case table(MarkdownTextSection)
        case code(String, String)
    }
    let id: String
    let kind: Kind
    let base: Int
    let length: Int
}

private func preparedMarkdownImage(_ value: String) -> (String, URL)? {
    guard let close = value.range(of: "]("), value.hasSuffix(")") else { return nil }
    let alt = String(value[value.index(value.startIndex, offsetBy: 2)..<close.lowerBound])
    let target = String(value[close.upperBound..<value.index(before: value.endIndex)]).trimmingCharacters(in: CharacterSet(charactersIn: "<> "))
    guard let url = URL(string: target), ["http", "https"].contains(url.scheme?.lowercased() ?? "") else { return nil }
    return (alt, url)
}


/// Parsed once on a worker. Rendering reads immutable spans, including table cells.
final class PreparedMarkdownDocument: @unchecked Sendable {
    let rows: [MarkdownRow]
    let length: Int
    init(_ text: String) {
        func inline(_ text: String) -> AttributedString {
            (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text)
        }
        var rows: [MarkdownRow] = []
        var offset = 0
        func add(_ id: String, _ kind: MarkdownRow.Kind, _ length: Int) {
            rows.append(MarkdownRow(id: id, kind: kind, base: offset, length: length))
            offset += length
        }
        func count(_ value: AttributedString) -> Int { String(value.characters).utf16.count }
        for block in markdownBlocks(text) {
            if case .code(let language) = block.kind {
                add("code-\(block.id)", .code(language, block.text), block.text.utf16.count)
                continue
            }
            for section in markdownTextSections(block.text) {
                let id = "text-\(block.id)-\(section.id)"
                if section.kind == .table {
                    var table = section
                    table.inlineRows = section.rows.map { $0.map(inline) }
                    add(id, .table(table), 0); continue
                }
                let line = section.text.trimmingCharacters(in: .whitespaces)
                let indent = section.text.prefix(while: { $0 == " " || $0 == "\t" }).count
                let hashes = line.prefix(while: { $0 == "#" }).count
                if line.isEmpty { add(id, .spacer, 0) }
                else if ["---", "***", "___"].contains(line) { add(id, .divider, 0) }
                else if line.hasPrefix("!["), let image = preparedMarkdownImage(line) { add(id, .image(image.0, image.1), 0) }
                else if line.hasPrefix("> ") {
                    let value = inline(String(line.dropFirst(2))); add(id, .quote(value), count(value))
                } else if (1...6).contains(hashes), line.dropFirst(hashes).hasPrefix(" ") {
                    let value = inline(String(line.dropFirst(hashes + 1))); add(id, .heading(hashes, value), count(value))
                } else if line.hasPrefix("- [ ] ") || line.hasPrefix("- [x] ") || line.hasPrefix("- [X] ") {
                    let value = inline(String(line.dropFirst(6))); add(id, .task(!line.hasPrefix("- [ ] "), value), count(value))
                } else if line.hasPrefix("- ") || line.hasPrefix("* ") {
                    let value = inline(String(line.dropFirst(2))); add(id, .bullet(indent, value), count(value) + 1)
                } else {
                    let value = inline(line); add(id, .text(value), count(value))
                }
            }
        }
        self.rows = rows
        self.length = offset
    }
}

/// NSCache admission/lookup never holds a lock while parsing; its cost is bounded by source size.
final class MarkdownDocumentCache: @unchecked Sendable {
    private let store = NSCache<NSString, PreparedMarkdownDocument>()
    init() { store.countLimit = 256; store.totalCostLimit = 4 * 1024 * 1024 }
    func cached(_ text: String) -> PreparedMarkdownDocument? { store.object(forKey: text as NSString) }
    func insert(_ value: PreparedMarkdownDocument, text: String) { store.setObject(value, forKey: text as NSString, cost: text.utf16.count) }
}

actor MarkdownParsingWorker {
    private let cache: MarkdownDocumentCache
    private let parse: @Sendable (String) -> PreparedMarkdownDocument
    init(cache: MarkdownDocumentCache, parse: @escaping @Sendable (String) -> PreparedMarkdownDocument = { PreparedMarkdownDocument($0) }) {
        self.cache = cache; self.parse = parse
    }
    func resolve(_ text: String) -> PreparedMarkdownDocument {
        if let found = cache.cached(text) { return found }
        let value = parse(text)
        cache.insert(value, text: text)
        return value
    }
}

enum MarkdownDocuments {
    static let cache = MarkdownDocumentCache()
    static let worker = MarkdownParsingWorker(cache: cache)
    static func cached(_ text: String) -> PreparedMarkdownDocument? { cache.cached(text) }
    static func resolve(_ text: String) async -> PreparedMarkdownDocument { await worker.resolve(text) }
}

struct PreparedMarkdownState {
    let text: String
    let document: PreparedMarkdownDocument
}

/// A stream has one parsing job and one latest input. Continuous updates cannot restart a
/// debounce forever or queue every intermediate document behind a slow parser.
@MainActor
final class MarkdownPreparation: ObservableObject {
    @Published private(set) var prepared: PreparedMarkdownState?
    private var pending: String?
    private var streaming = false
    private var task: Task<Void, Never>?
    private let resolve: @Sendable (String) async -> PreparedMarkdownDocument
    private let interval: UInt64

    init(text: String, interval: UInt64 = 60_000_000,
         resolve: @escaping @Sendable (String) async -> PreparedMarkdownDocument = { await MarkdownDocuments.resolve($0) }) {
        self.resolve = resolve; self.interval = interval
        prepared = MarkdownDocuments.cached(text).map { PreparedMarkdownState(text: text, document: $0) }
    }

    func update(_ text: String, streaming: Bool) {
        self.streaming = streaming
        pending = text
        guard task == nil else { return }
        guard prepared?.text != text else { pending = nil; return }
        task = Task { [weak self] in
            while let self, let input = self.pending {
                self.pending = nil
                let document = await self.resolve(input)
                guard !Task.isCancelled else { return }
                self.prepared = PreparedMarkdownState(text: input, document: document)
                if self.pending == input { self.pending = nil }
                if self.streaming {
                    do { try await Task.sleep(nanoseconds: self.interval) } catch { return }
                }
            }
            self?.task = nil
        }
    }

    func cancel() { task?.cancel(); task = nil; pending = nil }
    func waitForPending() async { await task?.value }
}

/// The UI submits immutable snapshots; one owner coalesces snapshots without dropping events.
actor ChatTranscriptWorker {
    private var identity: String?
    private var previousRows: [ChatRow] = []
    private var changeEntries: [String] = []
    private var changeTurns: [String] = []
    private var publishedMessages: [ChatMessage] = []
    private var messageToken = UUID()
    private var previousInput: ChatPublicationInput?
    private var previousTranscript: ChatTranscript?
    func resolve(identity: String, messages: [ChatMessage], timings: [String: SessionTurnTiming]) -> ChatTranscript {
        previousInput = nil; previousTranscript = nil
        let next = ChatTranscript(messages: messages, turnTimings: timings, previousRows: self.identity == identity ? previousRows : [])
        self.identity = identity; previousRows = next.rows
        return next
    }

    func publish(identity: String, input: ChatPublicationInput) -> ChatPublication {
        let messages = PendingSendOutbox.merge(materializeLiveTools(input.messages, tools: input.tools, liveOrders: input.orders), pending: input.pending)
        let changed = self.identity != identity || publishedMessages != messages
        if changed {
            publishedMessages = messages; messageToken = UUID()
        }
        let transcript: ChatTranscript
        if !changed, let old = previousInput, let cached = previousTranscript,
           old.timings == input.timings, old.displayIds == input.displayIds, old.aliases == input.aliases {
            transcript = cached
        } else {
            transcript = ChatTranscript(messages: publishedMessages, turnTimings: input.timings,
                previousRows: self.identity == identity ? previousRows : [], displayIds: input.displayIds, aliases: input.aliases)
        }
        previousInput = input; previousTranscript = transcript
        let messageIds = Set(publishedMessages.map(\.messageId))
        var anchors = messageIds
        for (entry, message) in input.displayIds where messageIds.contains(message) { anchors.insert(entry) }
        for (message, entry) in input.aliases where messageIds.contains(message) { anchors.insert(entry) }
        self.identity = identity; previousRows = transcript.rows
        let entries = anchors.sorted(), turns = input.timings.keys.sorted()
        if changeEntries != entries { changeEntries = entries }
        if changeTurns != turns { changeTurns = turns }
        return ChatPublication(messages: publishedMessages, messageToken: messageToken, messageIds: messageIds, transcript: transcript,
            streaming: input.unfinished.intersection(publishedMessages.lazy.filter { $0.role == "assistant" }.map(\.messageId)),
            changeEntries: changeEntries, changeTurns: changeTurns)
    }
}

struct ChatPublicationInput {
    let messages: [ChatMessage]
    let timings: [String: SessionTurnTiming]
    var tools: [ToolSummary] = []
    var orders: [String: Int64] = [:]
    var pending: [PendingSend] = []
    var unfinished: Set<String> = []
    var displayIds: [String: String] = [:]
    var aliases: [String: String] = [:]
    var requiresPendingMatch = false
}

struct ChatPublication {
    let messages: [ChatMessage]
    let messageToken: UUID
    let messageIds: Set<String>
    let transcript: ChatTranscript
    let streaming: Set<String>
    let changeEntries: [String]
    let changeTurns: [String]
}

/// Readiness is captured by the UI owner; title derivation and locale sorting own no UI state.
actor HomeCardWorker {
    private let beforeResolve: (@Sendable () -> Void)?
    private var previous: [HomeRuntimeCard] = []
    private var previousFacts: [HomeRuntimeCard] = []
    private var previousTimes: [Int64] = []
    private let beforeSort: (@Sendable () -> Void)?
    init(beforeResolve: (@Sendable () -> Void)? = nil, beforeSort: (@Sendable () -> Void)? = nil) {
        self.beforeResolve = beforeResolve; self.beforeSort = beforeSort
    }
    func resolve(runtimes: [RuntimeSummary], sessions: [String: SessionSummary],
                 messages: [String: [ChatMessage]], pending: [String: [InteractionRequest]]) -> (cards: [HomeRuntimeCard], fallback: Set<String>) {
        beforeResolve?()
        var fallback = Set<String>()
        let cards = runtimes.map { runtime in
            let session = runtime.sessionId.flatMap { sessions[$0] }
            if [runtime.sessionName, session?.name, session?.firstMessage].allSatisfy({ $0?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true }) {
                fallback.insert(runtime.runtimeId)
            }
            return HomeRuntimeCard(runtime: runtime,
                title: sessionTitle(runtime: runtime, session: session, messages: messages[runtime.runtimeId] ?? []),
                agentKind: runtime.agentKind ?? session?.agentKind ?? "",
                hasPendingInteraction: !(pending[runtime.runtimeId] ?? []).isEmpty)
        }
        let times = cards.map { $0.runtime.sessionId.flatMap { sessions[$0]?.modifiedAt } ?? 0 }
        if cards == previousFacts, times == previousTimes { return (previous, fallback) }
        previousFacts = cards; previousTimes = times
        beforeSort?()
        let sorted = cards.sorted { lhs, rhs in
            let left = lhs.runtime.sessionId.flatMap { sessions[$0]?.modifiedAt } ?? 0
            let right = rhs.runtime.sessionId.flatMap { sessions[$0]?.modifiedAt } ?? 0
            if left != right { return left > right }
            let order = lhs.title.localizedStandardCompare(rhs.title)
            return order == .orderedSame ? lhs.id < rhs.id : order == .orderedAscending
        }
        if previous != sorted { previous = sorted }
        return (previous, fallback)
    }
}


/// These publishers are scoped to a surface; message publications remain on OrbisStore.
@MainActor
final class ScreenPublication: ObservableObject {
    private(set) var revision = 0
    func invalidate() { revision &+= 1; objectWillChange.send() }
}

/// Immutable catalog facts, shared across filters and unchanged assistant chunks.
final class SessionDirectoryCatalog {
    let revision = UUID()
    let sessions: [SessionSummary]
    let titles: [String: String]
    let runtimeBySession: [String: RuntimeSummary]
    init(sessions: [SessionSummary] = [], titles: [String: String] = [:], runtimeBySession: [String: RuntimeSummary] = [:]) {
        self.sessions = sessions; self.titles = titles; self.runtimeBySession = runtimeBySession
    }
}

actor SessionDirectoryCatalogWorker {
    private let beforeRows: (@Sendable () -> Void)?
    private var previous: SessionDirectoryCatalog?
    private var source: [SessionSummary] = []
    private var overrides: [String: Bool] = [:]
    private var runtimeTitles: [String: String] = [:]
    private var sessionIndex: [String: SessionSummary] = [:]
    init(beforeRows: (@Sendable () -> Void)? = nil) { self.beforeRows = beforeRows }

    func resolve(sessions: [SessionSummary], runtimes: [RuntimeSummary], messages: [String: [ChatMessage]],
                 archived: [String: Bool]) -> SessionDirectoryCatalog {
        let bySession = Dictionary(runtimes.compactMap { runtime in runtime.sessionId.map { ($0, runtime) } },
                                   uniquingKeysWith: { first, _ in first })
        let sameSessions = source == sessions
        if !sameSessions { sessionIndex = Dictionary(sessions.map { ($0.sessionId, $0) }, uniquingKeysWith: { first, _ in first }) }
        let titles = bySession.mapValues { runtime in
            sessionTitle(runtime: runtime, session: runtime.sessionId.flatMap { sessionIndex[$0] }, messages: messages[runtime.runtimeId] ?? [])
        }
        if let previous, sameSessions, overrides == archived, runtimeTitles == titles,
           previous.runtimeBySession == bySession { return previous }
        beforeRows?()
        let visible = sessions.map { session -> SessionSummary in
            guard let value = archived[session.sessionId] else { return session }
            var copy = session; copy.archived = value; return copy
        }
        let allTitles = Dictionary(visible.map { ($0.sessionId, titles[$0.sessionId] ?? sessionTitle(runtime: nil, session: $0)) },
                                   uniquingKeysWith: { first, _ in first })
        source = sessions; overrides = archived; runtimeTitles = titles
        let result = SessionDirectoryCatalog(sessions: visible, titles: allTitles, runtimeBySession: bySession)
        previous = result; return result
    }
}

struct SessionDirectoryFilter: Hashable {
    let hostId: String?
    let catalogRevision: UUID
    let query: String
    let kind: String?
    let archived: Bool
    let provider: String
    let currentProvider: String?
    let language: String
    var queryRevision: UUID? = nil
    func sameView(as other: Self) -> Bool {
        hostId == other.hostId && query == other.query && kind == other.kind && archived == other.archived &&
            provider == other.provider && currentProvider == other.currentProvider && language == other.language
    }
}

final class SessionDirectoryProjection {
    let filter: SessionDirectoryFilter
    let directories: [SessionDirectory]
    let options: [SessionProviderOption]
    let provider: String
    let sessions: [SessionSummary]
    let keys: [String]
    let activity: [String: Int64]
    init(filter: SessionDirectoryFilter, directories: [SessionDirectory], options: [SessionProviderOption], provider: String) {
        self.filter = filter; self.directories = directories; self.options = options; self.provider = provider
        sessions = directories.flatMap(\.sessions)
        keys = directories.flatMap { ["directory:" + $0.path] + $0.sessions.map { "session:" + $0.sessionId } }
        var activity: [String: Int64] = [:]
        for directory in directories {
            activity["directory:" + directory.path] = directory.modifiedAt
            for session in directory.sessions { activity["session:" + session.sessionId] = session.modifiedAt }
        }
        self.activity = activity
    }
}

actor SessionDirectoryWorker {
    private let beforeResolve: (@Sendable () -> Void)?
    private var previous: SessionDirectoryProjection?
    init(beforeResolve: (@Sendable () -> Void)? = nil) { self.beforeResolve = beforeResolve }
    func resolve(catalog: SessionDirectoryCatalog, filter: SessionDirectoryFilter, knownProviders: [String] = [], hasUnknown: Bool = false) -> SessionDirectoryProjection {
        if let previous, previous.filter == filter { return previous }
        beforeResolve?()
        let options = sessionProviderOptions(catalog.sessions, kind: filter.kind ?? "codex", current: filter.currentProvider,
            knownProviders: knownProviders, hasUnknown: hasUnknown)
        let provider = options.contains { $0.key == filter.provider } ? filter.provider : "current"
        let visible = filter.kind == "codex" || filter.kind == "codexDesktop" ? catalog.sessions.filter {
            matchesSessionProvider($0, filter: provider, current: filter.currentProvider)
        } : catalog.sessions
        let directories = sessionDirectories(visible, query: filter.query, kind: filter.kind, archived: filter.archived,
                                             title: { catalog.titles[$0.sessionId] ?? $0.sessionId })
        let result = SessionDirectoryProjection(filter: filter, directories: directories, options: options, provider: provider)
        previous = result; return result
    }
}
