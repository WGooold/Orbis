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

}
