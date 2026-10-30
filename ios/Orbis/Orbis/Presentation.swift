import Foundation
import Combine

struct SessionProviderOption: Identifiable {
    let key: String
    let label: String
    var id: String { key }
}

func sessionProviderOptions(_ sessions: [SessionSummary], kind: String, current: String?) -> [SessionProviderOption] {
    let rows = sessions.filter { $0.agentKind == kind }
    var result = [SessionProviderOption(key: "current", label: current.map { "\($0)（当前使用）" } ?? "当前 provider（尚未获取）"),
                  SessionProviderOption(key: "all", label: "全部 provider")]
    let providers = Set(rows.compactMap(\.modelProvider).filter { !$0.isEmpty }).sorted()
    result += providers.filter { $0 != current }.map { SessionProviderOption(key: "provider:" + $0, label: $0) }
    if rows.contains(where: { $0.modelProvider == nil || $0.modelProvider?.isEmpty == true }) {
        result.append(SessionProviderOption(key: "unknown", label: "未知 provider"))
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
    formatter.locale = Locale(identifier: "zh_CN"); formatter.calendar = calendar; formatter.timeZone = calendar.timeZone
    if calendar.isDate(date, inSameDayAs: now) { formatter.dateFormat = "今天 HH:mm" }
    else if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) { formatter.dateFormat = "昨天 HH:mm" }
    else if calendar.isDate(date, equalTo: now, toGranularity: .year) { formatter.dateFormat = "M月d日" }
    else { formatter.dateFormat = "yyyy年M月d日" }
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
    case "extension": return "扩展"
    case "prompt": return "模板"
    case "skill": return "Skill"
    default: return source
    }
}

/// How a message sent during a running turn is delivered; the same words on Android.
func deliveryTitle(_ delivery: String) -> String { delivery == "steer" ? "插入当前任务" : "完成后发送" }

func runtimeStatusTitle(_ status: String) -> String {
    switch status {
    case "running": return "运行中"
    case "waiting", "waiting_interaction", "waiting_local_interaction": return "等待确认"
    case "error": return "异常"
    case "idle": return "空闲"
    case "unknown": return "状态待核对"
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
    return session?.sessionId ?? runtime?.sessionId ?? runtime?.runtimeId ?? "Session 已离线"
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
    /// A long turn is virtualized in small rows; its copy action still owns the complete turn.
    var copyMessages: [ChatMessage]? = nil
    var id: String { messages[0].messageId }
    var isUser: Bool { messages[0].role == "user" }
}

func chatViewportRows(_ rows: [ChatRow], previous: [ChatRow] = []) -> [ChatRow] {
    let starts = Set(previous.filter { !$0.isUser }.map(\.id))
    return rows.flatMap { row in
        guard !row.isUser, row.messages.count > 4 else { return [row] }
        var result: [ChatRow] = [], start = 0
        while start < row.messages.count {
            let limit = min(start + 4, row.messages.count)
            let end = ((start + 1)..<limit).first { starts.contains(row.messages[$0].messageId) } ?? limit
            result.append(ChatRow(messages: Array(row.messages[start..<end]), copyMessages: row.messages))
            start = end
        }
        return result
    }
}

struct ChatPresentation {
    let messages: [ChatMessage]
    let toolResults: [String: ChatMessage]
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
            return "[工具] " + (content.toolName ?? message.toolName ?? "工具") + "\n" + (toolArgumentsText(content) ?? "")
        }
        return content.text
    }.joined(separator: "\n\n")
}

func desktopAttachTitle(_ state: String?) -> String {
    ["attached": "已接入", "closed": "未接入", "notInstalled": "未安装", "unsupported": "不可用", "error": "接入失败"][state ?? ""] ?? "未知"
}

/// Everything the chat list derives from messages and turn timings. It is built once per change
/// of those inputs, never per view update (Android remembers the same projection by its inputs);
/// rebuilding it on every scroll frame kept the main thread busy on long sessions.
struct ChatTranscript {
    let rows: [ChatRow]
    let firstMessageId: String?
    /// Only the tool results and timings that belong to each row, so an unchanged row compares equal.
    let toolResultsByRow: [String: [String: ChatMessage]]
    let timingsByRow: [String: [SessionTurnTiming]]

    static let empty = ChatTranscript(messages: [], turnTimings: [:])

    init(messages: [ChatMessage], turnTimings: [String: SessionTurnTiming], previousRows: [ChatRow] = []) {
        let presentation = chatPresentation(messages)
        let timings = turnTimings.values.sorted { ($0.startedAt, $0.turnId) < ($1.startedAt, $1.turnId) }
        let turnIds = Dictionary(timings.compactMap { timing in timing.messageId.map { ($0, timing.turnId) } }, uniquingKeysWith: { _, last in last })
        let timingsByMessage = Dictionary(grouping: timings.filter { $0.messageId != nil }, by: { $0.messageId! })
        rows = chatViewportRows(chatRows(presentation.messages, turnIdsByMessageId: turnIds), previous: previousRows)
        firstMessageId = presentation.messages.first?.messageId
        var results: [String: [String: ChatMessage]] = [:], rowTimings: [String: [SessionTurnTiming]] = [:]
        for row in rows {
            let calls = row.messages.flatMap { message in
                message.content.flatMap { [$0.toolCallId, $0.summary?.tool?.toolCallId].compactMap { $0 } } + [message.toolCallId].compactMap { $0 }
            }
            let owned = Dictionary(calls.compactMap { id in presentation.toolResults[id].map { (id, $0) } }, uniquingKeysWith: { first, _ in first })
            if !owned.isEmpty { results[row.id] = owned }
            let rowTiming = row.messages.flatMap { timingsByMessage[$0.messageId] ?? [] }
            if !rowTiming.isEmpty { rowTimings[row.id] = rowTiming }
        }
        toolResultsByRow = results; timingsByRow = rowTimings
    }
}

func chatRows(_ messages: [ChatMessage], turnIdsByMessageId: [String: String] = [:]) -> [ChatRow] {
    var rows: [ChatRow] = [], boundaryPending = false
    for message in messages {
        if message.role == "user" { rows.append(ChatRow(messages: [message])); boundaryPending = false; continue }
        if boundaryPending && message.role != "tool" { rows.append(ChatRow(messages: [message])); boundaryPending = false }
        else if let last = rows.indices.last, !rows[last].isUser { rows[last].messages.append(message) }
        else { rows.append(ChatRow(messages: [message])) }
        if turnIdsByMessageId[message.messageId] != nil { boundaryPending = true }
    }
    return rows
}

/// 宿主在运行中的回合里不会下发只含工具调用的 live 消息，而是放进工具清单（与 Android materializeToolPayload 一致）。
/// 这里把还没出现在消息里的工具还原成助手消息，并和 live 消息按 order 排序，使工具卡片落在对应的回复气泡里。
func materializeLiveTools(_ messages: [ChatMessage], tools: [ToolSummary], liveOrders: [String: Int64]) -> [ChatMessage] {
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
    ["accepted": "已排队", "queued": "排队中", "submitting": "提交中", "sending": "正在发送", "delivered": "已送达", "applied": "已应用", "cancelled": "已撤回", "rejected": "已拒绝", "not_cancelable": "无法撤回", "failed": "发送失败", "expired": "已过期"][state] ?? state
}

func interactionDraftKey(host: HostPairing?, sessionId: String?, request: InteractionRequest) -> String {
    [host?.relay.relayUrl ?? "", host?.relay.deviceId ?? "", host?.hostId ?? "", request.runtimeId, sessionId ?? "", request.extensionId, request.requestId]
        .map { "\($0.utf8.count):\($0)" }.joined()
}
