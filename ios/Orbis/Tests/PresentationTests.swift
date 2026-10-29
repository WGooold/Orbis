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
        #expect(normalizedPathPreference(["relay", "invalid", "relay", "lan"]) == ["relay", "lan", "p2p"])
    }
    private func session(_ id: String, cwd: String = "/project", kind: String = "codex", name: String? = nil, archived: Bool = false) -> SessionSummary {
        SessionSummary(sessionId: id, name: name, cwd: cwd, firstMessage: "第一句。第二句", createdAt: 0, modifiedAt: 1, messageCount: 1, agentKind: kind, archived: archived)
    }
    @Test func titlePrecedenceMatchesAndroidAndUsesOnlyUserContent() {
        let runtime = RuntimeSummary(runtimeId: "runtime", name: "Agent", cwd: "/repo", status: "idle", sessionId: "session", sessionName: "电脑标题")
        #expect(sessionTitle(alias: "手机别名", runtime: runtime, session: session("session", name: "目录标题")) == "手机别名")
        #expect(sessionTitle(alias: "  ", runtime: runtime, session: session("session", name: "目录标题")) == "电脑标题")
        #expect(sessionTitle(alias: nil, runtime: nil, session: session("session", name: "目录标题")) == "目录标题")
        #expect(sessionTitle(alias: nil, runtime: nil, session: session("session")) == "第一句。")
        let assistant = ChatMessage(messageId: "a", role: "assistant", content: [ChatContent(type: "text", text: "不要用助手开场命名", toolName: nil, artifact: nil)], timestamp: 0, isError: nil)
        #expect(sessionTitle(alias: nil, runtime: runtimeWithoutTitle, session: nil, messages: [assistant]) == "session")
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

    @Test func aliasesAndPreviewsHaveAndroidLengthWhitespaceAndSentenceRules() {
        #expect(normalizedAlias("  会话\n 名称\t\u{0000} ") == "会话 名称")
        #expect(normalizedAlias(" \t\n") == nil)
        #expect(normalizedAlias(String(repeating: "中", count: 60))?.count == 40)
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

}
