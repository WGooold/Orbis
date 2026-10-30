import Foundation
import Testing
@testable import OrbisCore

@Suite("Android presentation parity")
struct PresentationTests {
    @Test func providerFilterUsesNativeIdentityAndKeepsUnknownSeparate() {
        var first = session("a"), other = session("b"), unknown = session("c")
        first.modelProvider = "native-a"; other.modelProvider = "native-b"; unknown.modelProvider = nil
        let options = sessionProviderOptions([first, other, unknown], kind: "codex", current: "native-a")
        #expect(options.map(\.key) == ["current", "all", "provider:native-b", "unknown"])
        #expect(matchesSessionProvider(first, filter: "current", current: "native-a"))
        #expect(!matchesSessionProvider(first, filter: "current", current: nil))
        #expect(!matchesSessionProvider(unknown, filter: "current", current: nil))
        #expect(matchesSessionProvider(other, filter: "provider:native-b", current: "native-a"))
        #expect(matchesSessionProvider(unknown, filter: "unknown", current: "native-a"))
        #expect(matchesSessionProvider(unknown, filter: "all", current: nil))
    }
    private func session(_ id: String, cwd: String = "/project", kind: String = "codex", name: String? = nil, archived: Bool = false) -> SessionSummary {
        SessionSummary(sessionId: id, name: name, cwd: cwd, firstMessage: "第一句。第二句", createdAt: 0, modifiedAt: 1, messageCount: 1, agentKind: kind, archived: archived)
    }
    @Test func titlePrecedenceMatchesAndroidAndUsesOnlyUserContent() {
        let runtime = RuntimeSummary(runtimeId: "runtime", name: "Agent", cwd: "/repo", status: "idle", sessionId: "session", sessionName: "电脑标题")
        #expect(sessionTitle(runtime: runtime, session: session("session", name: "目录标题")) == "电脑标题")
        #expect(sessionTitle(runtime: nil, session: session("session", name: "目录标题")) == "目录标题")
        #expect(sessionTitle(runtime: nil, session: session("session")) == "第一句。")
        let assistant = ChatMessage(messageId: "a", role: "assistant", content: [ChatContent(type: "text", text: "不要用助手开场命名", toolName: nil, artifact: nil)], timestamp: 0, isError: nil)
        #expect(sessionTitle(runtime: runtimeWithoutTitle, session: nil, messages: [assistant]) == "session")
    }
    @Test func liveToolsAreMaterializedIntoTheAssistantTurnByOrder() {
        func tool(_ id: String, order: Int64) -> ToolSummary {
            ToolSummary(tool: ToolIdentity(agent: ToolAgent(hostId: "h", agentKind: "codex", sessionId: "s"), toolCallId: id), order: order,
                        toolName: "shell", phase: "finished", isError: nil, inputSummary: nil, resultSummary: nil, errorSummary: nil)
        }
        func text(_ id: String, _ role: String = "assistant") -> ChatMessage {
            ChatMessage(messageId: id, role: role, content: [ChatContent(type: "text", text: id, toolName: nil, artifact: nil)], timestamp: 0, isError: nil)
        }
        let persisted = ChatMessage(messageId: "old", role: "assistant", content: [
            ChatContent(type: "tool_call", text: nil, toolName: "shell", artifact: nil, toolCallId: "inline"),
        ], timestamp: 0, isError: nil)
        let messages = [text("history", "user"), persisted, text("prompt", "user"), text("answer")]
        let result = materializeLiveTools(messages, tools: [tool("second", order: 2), tool("inline", order: 0), tool("first", order: 1)],
                                          liveOrders: ["prompt": 0, "answer": 3])
        #expect(result.map(\.messageId) == ["history", "old", "prompt", "tool-live:first", "tool-live:second", "answer"])
        #expect(result[3].content.first?.summary?.tool?.toolCallId == "first")
        let rows = chatRows(result)
        #expect(rows.count == 4 && rows[3].messages.map(\.messageId) == ["tool-live:first", "tool-live:second", "answer"])
        #expect(materializeLiveTools(messages, tools: [], liveOrders: ["answer": 3]) == messages)
    }

    private var runtimeWithoutTitle: RuntimeSummary { RuntimeSummary(runtimeId: "runtime", name: "Agent", cwd: "/repo", status: "idle", sessionId: "session") }

    @Test func previewsHaveAndroidLengthWhitespaceAndSentenceRules() {
        #expect(sessionMessagePreview("\n第一行\n第二行") == "第一行")
        #expect(sessionMessagePreview(" What   happened? More text") == "What happened?")
        #expect(sessionMessagePreview(String(repeating: "字", count: 60)) == String(repeating: "字", count: 39) + "…")
    }

    @Test func directorySearchFilterAndArchiveComposeWithoutLosingPaths() {
        let values = [session("1", cwd: "D:\\Work\\Orbis", name: "聊天布局"), session("2", cwd: "/Projects/site", kind: "pi", name: "Home"), session("3", archived: true)]
        #expect(sessionDirectories(values, query: "orbis", kind: nil, archived: false, title: { $0.name ?? "" }).first?.sessions.map(\.sessionId) == ["1"])
        #expect(sessionDirectories(values, query: "home", kind: "codex", archived: false, title: { $0.name ?? "" }).isEmpty)
        #expect(sessionDirectories(values, query: "", kind: nil, archived: true, title: { $0.name ?? "" }).first?.sessions.map(\.sessionId) == ["3"])
        #expect(directoryTitle("D:\\Work\\Orbis") == "Orbis")
    }

    @Test func directoriesSortByMostRecentSessionAndExpandOneAtATime() {
        func at(_ id: String, _ cwd: String, _ modified: Int64) -> SessionSummary {
            var value = session(id, cwd: cwd); value.modifiedAt = modified; return value
        }
        let values = [at("old", "/a", 10), at("new", "/b", 30), at("mid", "/a", 20), at("tie", "/c", 30)]
        let directories = sessionDirectories(values, query: "", kind: nil, archived: false, title: { $0.name ?? "" })
        #expect(directories.map(\.path) == ["/b", "/c", "/a"])
        #expect(directories.last?.sessions.map(\.sessionId) == ["mid", "old"])
        #expect(directories.last?.modifiedAt == 20)
        #expect(defaultExpandedDirectory(directories, preferred: "/a") == "/a")
        #expect(defaultExpandedDirectory(directories, preferred: "/gone") == "/b")
        #expect(defaultExpandedDirectory(directories, preferred: nil) == "/b")
        #expect(defaultExpandedDirectory([], preferred: "/a") == nil)
        #expect(directorySessionPreviewLimit == 5)
    }

    /// Host 的 runtime 元数据不带 agentKind：Codex 不能因为缺字段被显示成 Pi。
    @Test func runtimeAgentKindComesFromCatalogThenHostRuntimeIds() {
        #expect(resolvedAgentKind(runtimeId: "codex:thread-1", declared: nil, catalogKind: nil) == "codex")
        #expect(resolvedAgentKind(runtimeId: "codex", declared: nil, catalogKind: nil) == "codex")
        #expect(resolvedAgentKind(runtimeId: "codex-desktop:t", declared: nil, catalogKind: nil) == "codexDesktop")
        #expect(resolvedAgentKind(runtimeId: "dsh:abc", declared: nil, catalogKind: nil) == "dsh")
        #expect(resolvedAgentKind(runtimeId: "claude:9f3c-session", declared: nil, catalogKind: nil) == "claude")
        #expect(resolvedAgentKind(runtimeId: "7d0c4f1e-uuid", declared: nil, catalogKind: "pi") == "pi")
        #expect(resolvedAgentKind(runtimeId: "7d0c4f1e-uuid", declared: nil, catalogKind: "codex") == "codex")
        #expect(resolvedAgentKind(runtimeId: "7d0c4f1e-uuid", declared: nil, catalogKind: nil) == nil)
        #expect(resolvedAgentKind(runtimeId: "7d0c4f1e-uuid", declared: nil, catalogKind: "") == nil)
        #expect(resolvedAgentKind(runtimeId: "codex:x", declared: "dsh", catalogKind: "pi") == "dsh")
        #expect(runtimeAgentKind("codexDesktop") == nil)
        #expect(runtimeAgentKind("codex-desktopish") == nil)
        #expect(runtimeAgentKind("dsh") == nil)
        #expect(runtimeAgentKind("claude") == nil)
    }

    @Test func remotePathsUseComputerSeparatorsAndRootEntriesVerbatim() {
        #expect(remoteBrowsePath(parent: nil, name: "D:\\") == "D:\\")
        #expect(remoteBrowsePath(parent: "D:\\Work", name: "Orbis") == "D:\\Work\\Orbis")
        #expect(remoteBrowsePath(parent: "/Users/me", name: "Orbis") == "/Users/me/Orbis")
        #expect(remoteBrowsePath(parent: "C:\\", name: "Work") == "C:\\Work")
        #expect(remoteBrowsePath(parent: "/", name: "tmp") == "/tmp")
    }

    @Test func sessionKeysIsolateHostsPairingsAndSessionTransitions() {
        func host(_ id: String, device: String = "d") -> HostPairing { HostPairing(hostId: id, hostName: "电脑", hostPub: "pub", pskRoot: "root", relay: RelayCredential(relayUrl: "wss://relay.example", deviceId: device, credential: "local-test"), lan: []) }
        var runtime = runtimeWithoutTitle
        let key = localSessionKey(host: host("a"), runtime: runtime)
        #expect(key != localSessionKey(host: host("b"), runtime: runtime))
        #expect(key != localSessionKey(host: host("a", device: "new"), runtime: runtime))
        runtime.sessionId = "next"
        #expect(key != localSessionKey(host: host("a"), runtime: runtime))
    }

    @Test func fencedCodeStaysVerbatimEvenWhileStreaming() {
        let blocks = markdownBlocks("正文\n```swift\nlet value = \"**literal**\"\n\n  indent\n```\n结尾")
        #expect(blocks.count == 3)
        #expect(blocks[1].kind == .code("swift"))
        #expect(blocks[1].text == "let value = \"**literal**\"\n\n  indent")
        let unfinished = markdownBlocks("~~~sh\necho 'hello'\n")
        #expect(unfinished.first?.kind == .code("sh"))
        #expect(unfinished.first?.text == "echo 'hello'\n")
    }
    @Test func markdownTablesKeepEscapedPipesAndSoftParagraphs() {
        let sections = markdownTextSections("第一行\n软换行\n\n| 名称 | 状态 |\n| :--- | ---: |\n| a\\|b | **完成** |\n\n小标题\n===")
        #expect(sections.count == 3)
        #expect(sections[0].kind == .paragraph)
        #expect(sections[0].text == "第一行\n软换行")
        #expect(sections[1].kind == .table)
        #expect(sections[1].rows.count == 2)
        #expect(sections[1].rows[1][0] == "a\\|b")
        #expect(sections[2].text == "# 小标题")
    }

    @Test func contextRailRequiresKnownWindowAndFallsBackToTokens() {
        #expect(contextUsagePercent(nil) == nil)
        #expect(contextUsagePercent(RuntimeContextUsage(tokens: 30, contextWindow: nil, percent: 50)) == nil)
        #expect(contextUsagePercent(RuntimeContextUsage(tokens: 30, contextWindow: 120, percent: nil)) == 25)
        #expect(contextUsagePercent(RuntimeContextUsage(tokens: 300, contextWindow: 120, percent: nil)) == 100)
        #expect(runtimeStatusTitle("unknown") == "状态待核对")
        #expect(queueStateTitle("accepted") == "已排队")
        #expect(queueStateTitle("not_cancelable") == "无法撤回")
    }

    @Test @MainActor func ordinaryInteractionDraftsRestoreWhileSecretsStayInMemory() throws {
        let suite = "orbis-interaction-test-" + UUID().uuidString
        let preferences = try #require(UserDefaults(suiteName: suite))
        defer { preferences.removePersistentDomain(forName: suite) }
        let request = InteractionRequest(runtimeId: "r", requestId: "q", extensionId: "e", kind: "questionnaire", title: "问题", description: nil, expiresAt: 9_999_999_999_999, options: nil, placeholder: nil, initialValue: nil, minLength: nil, maxLength: nil, minSelections: nil, maxSelections: nil, secret: true, confirmLabel: nil, cancelLabel: nil, argumentSummary: nil, externalUrl: nil,
            questions: [.init(id: "public", header: nil, question: "普通回答", options: [], multiSelect: false, allowOther: true, allowNotes: true, secret: false), .init(id: "private", header: nil, question: "保密回答", options: [], multiSelect: false, allowOther: true, allowNotes: true, secret: true)])
        let cache = InteractionDraftCache(preferences: preferences)
        let draft = InteractionDraftValue(input: "secret-input", choices: ["one"], answers: ["public": ["normal"], "private": ["secret-choice"]], other: ["public": "普通文本", "private": "secret-other"], notes: ["private": "secret-note"])
        cache.save(draft, for: "host/session/request", request: request)
        #expect(cache.value(for: "host/session/request", request: request) == draft)
        let restored = InteractionDraftCache(preferences: preferences).value(for: "host/session/request", request: request)
        #expect(restored.input.isEmpty); #expect(restored.answers["public"] == ["normal"])
        #expect(restored.other["public"] == "普通文本"); #expect(restored.answers["private"] == nil)
        #expect(restored.other["private"] == nil); #expect(restored.notes["private"] == nil)
        let bytes = try #require(preferences.data(forKey: "orbis.interactionDrafts.v1"))
        #expect(!String(decoding: bytes, as: UTF8.self).contains("secret"))
        func host(_ id: String, device: String = "device") -> HostPairing {
            HostPairing(hostId: id, hostName: id, hostPub: "pub", pskRoot: "root", relay: RelayCredential(relayUrl: "wss://relay.test", deviceId: device, credential: "credential"), lan: [])
        }
        let first = interactionDraftKey(host: host("a"), sessionId: "s", request: request)
        let second = interactionDraftKey(host: host("b"), sessionId: "s", request: request)
        #expect(first != second)
        #expect(first != interactionDraftKey(host: host("a"), sessionId: "other", request: request))
        #expect(first != interactionDraftKey(host: host("a", device: "repaired"), sessionId: "s", request: request))
        cache.save(InteractionDraftValue(other: ["public": "电脑 A"]), for: first, request: request)
        cache.save(InteractionDraftValue(other: ["public": "电脑 B"]), for: second, request: request)
        let fresh = InteractionDraftCache(preferences: preferences)
        #expect(fresh.value(for: first, request: request).other["public"] == "电脑 A")
        #expect(fresh.value(for: second, request: request).other["public"] == "电脑 B")
    }

    @Test func assistantCardsRespectTurnBoundariesAndKeepFollowingToolResultsTogether() {
        func message(_ id: String, _ role: String) -> ChatMessage {
            ChatMessage(messageId: id, role: role, content: [ChatContent(type: "text", text: id, toolName: nil, artifact: nil)], timestamp: 0, isError: nil)
        }
        let messages = [message("user", "user"), message("first", "assistant"), message("tool", "tool"), message("next", "assistant"), message("last", "assistant")]
        #expect(chatRows(messages).map { $0.messages.map(\.messageId) } == [["user"], ["first", "tool", "next", "last"]])
        #expect(chatRows(messages, turnIdsByMessageId: ["first": "turn-a", "next": "turn-b"]).map { $0.messages.map(\.messageId) } == [["user"], ["first", "tool"], ["next"], ["last"]])
    }

    @Test @MainActor func independentInteractionCachesMergeWithoutRemovingOtherRuntimesDrafts() throws {
        let suite = "orbis-interaction-merge-" + UUID().uuidString
        let preferences = try #require(UserDefaults(suiteName: suite))
        defer { preferences.removePersistentDomain(forName: suite) }
        let data = try JSONSerialization.data(withJSONObject: ["runtimeId": "r", "requestId": "q", "extensionId": "e", "kind": "input", "title": "Input", "expiresAt": 9_999_999_999_999])
        let request = try JSONDecoder().decode(InteractionRequest.self, from: data)
        let first = InteractionDraftCache(preferences: preferences), second = InteractionDraftCache(preferences: preferences)
        first.save(InteractionDraftValue(input: "First"), for: "runtime-a", request: request)
        second.save(InteractionDraftValue(input: "Second"), for: "runtime-b", request: request)
        first.save(InteractionDraftValue(input: "First revised"), for: "runtime-a", request: request)
        let restored = InteractionDraftCache(preferences: preferences)
        #expect(restored.value(for: "runtime-a", request: request).input == "First revised")
        #expect(restored.value(for: "runtime-b", request: request).input == "Second")
    }

    @Test func questionnaireSubmitUsesTheSameConstraintsAsTheCommandBoundary() throws {
        let data = try JSONSerialization.data(withJSONObject: ["runtimeId": "r", "requestId": "q", "extensionId": "e", "kind": "questionnaire", "title": "Question", "expiresAt": 9_999_999_999_999,
            "questions": [["id": "one", "question": "Choose", "options": [["value": "a", "label": "A"]], "multiSelect": false, "allowOther": true, "allowNotes": true]]])
        let request = try JSONDecoder().decode(InteractionRequest.self, from: data)
        var draft = InteractionDraftValue(answers: ["one": ["a"]], other: ["one": "custom"])
        #expect(!request.acceptsResponse(draft.response(for: request)))
        draft.answers = [:]
        #expect(request.acceptsResponse(draft.response(for: request)))
        draft.notes["one"] = String(repeating: "a", count: 4_001)
        #expect(!request.acceptsResponse(draft.response(for: request)))
        draft.notes["one"] = "valid"
        draft.other["one"] = "  "
        #expect(!request.acceptsResponse(draft.response(for: request)))
    }

    @Test func legacyToolArgumentsAndResultsStayAssociatedWithoutDuplicatingRows() {
        let block = ChatContent(type: "tool_call", text: nil, toolName: nil, artifact: nil, toolCallId: "tool", arguments: .object(["line": .integer(9_007_199_254_740_993)]))
        let call = ChatMessage(messageId: "call", role: "assistant", content: [block], timestamp: 0, isError: nil, toolName: "read")
        let result = ChatMessage(messageId: "result", role: "tool", content: [ChatContent(type: "text", text: "done", toolName: nil, artifact: nil)], timestamp: 1, isError: nil, toolCallId: "tool", toolName: "read")
        let presentation = chatPresentation([call, result, call])
        #expect(presentation.messages.map(\.messageId) == ["call"])
        #expect(presentation.toolResults["tool"] == result)
        #expect(toolArgumentsText(block)?.contains("9007199254740993") == true)
        #expect(fullMessageText(call).contains("[工具] read"))
        #expect(desktopAttachTitle(nil) == "未知")
        #expect(desktopAttachTitle("closed") == "未接入")
        #expect(desktopAttachTitle("unsupported") == "不可用")
    }

    @Test func sessionListTimeUsesChineseRelativeWordsAndOnlyTagsAForeignProvider() {
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = TimeZone(identifier: "Asia/Shanghai")!
        let now = calendar.date(from: DateComponents(year: 2026, month: 10, day: 29, hour: 18))!
        func ms(_ month: Int, _ day: Int, _ year: Int = 2026, hour: Int = 9) -> Int64 {
            Int64(calendar.date(from: DateComponents(year: year, month: month, day: day, hour: hour, minute: 5))!.timeIntervalSince1970 * 1000)
        }
        #expect(sessionTimeTitle(ms(10, 29), now: now, calendar: calendar) == "今天 09:05")
        #expect(sessionTimeTitle(ms(10, 28), now: now, calendar: calendar) == "昨天 09:05")
        #expect(sessionTimeTitle(ms(3, 2), now: now, calendar: calendar) == "3月2日")
        #expect(sessionTimeTitle(ms(12, 31, 2025), now: now, calendar: calendar) == "2025年12月31日")
        var codex = session("a"); codex.modelProvider = "team"
        #expect(sessionOtherProvider(codex, current: "openai") == "team")
        #expect(sessionOtherProvider(codex, current: "team") == nil)
        #expect(sessionOtherProvider(codex, current: nil) == nil)
        #expect(sessionOtherProvider(session("p", kind: "pi"), current: "openai") == nil)
        #expect(deliveryTitle("steer") == "插入当前任务" && deliveryTitle("followUp") == "完成后发送")
        #expect(slashSourceTitle("builtin") == nil && slashSourceTitle("extension") == "扩展")
    }

    @Test func transcriptGroupsRowsOnceAndKeepsEachRowsToolResultsAndTimings() {
        func text(_ id: String, _ role: String) -> ChatMessage {
            ChatMessage(messageId: id, role: role, content: [ChatContent(type: "text", text: id, toolName: nil, artifact: nil)], timestamp: 0, isError: nil)
        }
        let call = ChatMessage(messageId: "call", role: "assistant", content: [ChatContent(type: "tool_call", text: nil, toolName: "read", artifact: nil, toolCallId: "tool")], timestamp: 0, isError: nil)
        let result = ChatMessage(messageId: "result", role: "tool", content: [ChatContent(type: "text", text: "done", toolName: nil, artifact: nil)], timestamp: 1, isError: nil, toolCallId: "tool", toolName: "read")
        let timing = SessionTurnTiming(turnId: "turn", startedAt: 1, durationMs: 2, turnIndex: nil, messageId: "a2")
        let transcript = ChatTranscript(messages: [text("u1", "user"), call, result, text("a2", "assistant"), text("u2", "user")], turnTimings: ["turn": timing])
        #expect(transcript.rows.map(\.id) == ["u1", "call", "u2"])
        #expect(transcript.firstMessageId == "u1")
        #expect(transcript.toolResultsByRow["call"]?["tool"] == result)
        #expect(transcript.toolResultsByRow["u2"] == nil)
        #expect(transcript.timingsByRow["call"] == [timing])
        #expect(ChatTranscript.empty.rows.isEmpty)
    }

    @Test func longTurnsKeepFullCopyTimingAndStableRowsWhenHistoryIsPrepended() {
        func text(_ index: Int) -> ChatMessage {
            ChatMessage(messageId: "m\(index)", role: "assistant", content: [ChatContent(type: "text", text: "message \(index)", toolName: nil, artifact: nil)], timestamp: 0, isError: nil)
        }
        let messages = (0..<13).map(text)
        let timing = SessionTurnTiming(turnId: "turn", startedAt: 1, durationMs: 2, turnIndex: nil, messageId: "m12")
        let first = ChatTranscript(messages: messages, turnTimings: ["turn": timing])
        #expect(first.rows.map { $0.messages.count } == [4, 4, 4, 1])
        #expect(first.rows.flatMap(\.messages) == messages)
        #expect(first.rows.allSatisfy { $0.copyMessages == messages })
        #expect(first.timingsByRow == ["m12": [timing]])
        let prefixed = ChatTranscript(messages: [text(-2), text(-1)] + messages,
                                      turnTimings: ["turn": timing], previousRows: first.rows)
        #expect(prefixed.rows.map(\.id) == ["m-2"] + first.rows.map(\.id))
        #expect(prefixed.rows.flatMap(\.messages) == [text(-2), text(-1)] + messages)
    }

    @Test func base64URLDecodesBytewiseAndRejectsMalformedInput() throws {
        let data = Data((0..<255).map(UInt8.init))
        #expect(try Base64URL.decode(Base64URL.encode(data)) == data)
        #expect(try Base64URL.decode("-_8") == Data([0xFB, 0xFF]))
        for bad in ["", "abc=", "ab+c", "a", "abcde", "中文"] { #expect(throws: Base64URLError.self) { try Base64URL.decode(bad) } }
    }

}
