import Foundation

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

func runtimeStatusTitle(_ status: String) -> String {
    switch status {
    case "running": return "运行中"
    case "waiting", "waiting_interaction", "waiting_local_interaction": return "等待确认"
    case "error": return "异常"
    case "idle": return "空闲"
    default: return status
    }
}

func normalizedAlias(_ raw: String) -> String? {
    let clean = raw.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) || CharacterSet.whitespacesAndNewlines.contains($0) }
    let value = String(String.UnicodeScalarView(clean)).split(whereSeparator: \.isWhitespace).joined(separator: " ")
    return value.isEmpty ? nil : String(value.prefix(40))
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

func sessionTitle(alias: String?, runtime: RuntimeSummary?, session: SessionSummary?, messages: [ChatMessage] = []) -> String {
    for candidate in [alias, runtime?.sessionName, session?.name] {
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

func offlineAliasKey(host: HostPairing?, sessionId: String) -> String {
    [host?.relay.relayUrl ?? "", host?.relay.deviceId ?? "", host?.hostId ?? ""].map { "\($0.utf8.count):\($0)" }.joined() + "session:\(sessionId.utf8.count):\(sessionId)"
}

struct SessionDirectory: Identifiable {
    let path: String
    let sessions: [SessionSummary]
    var id: String { path }
}

func sessionDirectories(_ sessions: [SessionSummary], query: String, kind: String?, archived: Bool,
                        title: (SessionSummary) -> String) -> [SessionDirectory] {
    let term = query.trimmingCharacters(in: .whitespacesAndNewlines)
    let visible = sessions.filter { session in
        (session.archived == true) == archived && (kind == nil || session.agentKind == kind) &&
        (term.isEmpty || session.cwd.localizedCaseInsensitiveContains(term) || title(session).localizedCaseInsensitiveContains(term))
    }
    return Dictionary(grouping: visible, by: \.cwd).map { path, sessions in
        SessionDirectory(path: path, sessions: sessions.sorted { $0.modifiedAt > $1.modifiedAt })
    }.sorted { $0.path.localizedStandardCompare($1.path) == .orderedAscending }
}

struct MarkdownBlock: Identifiable, Equatable {
    enum Kind: Equatable { case text, code(String) }
    let id: Int
    let kind: Kind
    let text: String
}

struct ChatRow: Identifiable {
    var messages: [ChatMessage]
    var id: String { messages[0].messageId }
    var isUser: Bool { messages[0].role == "user" }
}

func chatRows(_ messages: [ChatMessage]) -> [ChatRow] {
    var rows: [ChatRow] = []
    for message in messages {
        if message.role != "user", let last = rows.indices.last, !rows[last].isUser {
            rows[last].messages.append(message)
        } else { rows.append(ChatRow(messages: [message])) }
    }
    return rows
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
