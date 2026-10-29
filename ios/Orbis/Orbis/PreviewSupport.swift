#if DEBUG
import Foundation

// Explicit launch arguments opt into isolated, in-memory fixtures for UI review.
// They never read Keychain, connect to a real Host, or persist preview content.
@MainActor
func makePreviewStore(screen: String) -> OrbisStore {
    let transport = PreviewTransport(screen: screen)
    let store = OrbisStore(secure: PreviewStorage(empty: screen == "pairing"), transport: transport, preferences: nil)
    if screen == "slash" || screen == "approval" {
        Task { @MainActor in
            for _ in 0..<10 where store.selectedRuntime == nil { await Task.yield() }
            if screen == "slash", let runtime = store.selectedRuntime { store.saveDraft("/", for: runtime) }
            if screen == "approval" {
                transport.event(["type": "interaction.requested", "request": ["runtimeId": "preview-codex", "requestId": "preview-approval", "extensionId": "preview", "kind": "confirm", "title": "允许执行验证命令？", "description": "Agent 请求运行项目的测试，以检查本次修改。", "argumentSummary": "swift test --package-path ios/Orbis", "expiresAt": Int64(Date().timeIntervalSince1970 * 1000) + 300000]])
            }
        }
    }
    return store
}

private final class PreviewStorage: SecureStorage {
    var hosts: [HostPairing]
    init(empty: Bool) {
        hosts = empty ? [] : [HostPairing(hostId: "preview-host", hostName: "工作电脑", hostPub: Base64URL.encode(Data(repeating: 2, count: 32)),
            pskRoot: Base64URL.encode(Data(repeating: 1, count: 32)), relay: RelayCredential(relayUrl: "wss://relay.example", deviceId: "preview-device", credential: "preview-only"), lan: [])]
    }
    func deviceIdentity() throws -> DeviceIdentity { .generate() }
    func savePairings(_ pairings: [HostPairing]) throws { hosts = pairings }
    func pairings() -> [HostPairing] { hosts }
}

@MainActor
private final class PreviewTransport: OrbisTransport {
    let screen: String
    init(screen: String) { self.screen = screen }
    var receive: (([String: Any], String?) -> Void)?
    var sequence = 0
    private var providerRevision = 1
    private var viewportTail = 0
    private var enabledProviders: [String: Set<String>] = ["codex": ["official"], "pi": ["official"], "dsh": ["official"]]
    func pair(qr: PairingQR, deviceName: String, identity: DeviceIdentity, completion: @escaping (Result<HostPairing, Error>) -> Void) { completion(.failure(PairingError.invalidQR)) }
    func disconnect() {}
    func connect(pairing: HostPairing, identity: DeviceIdentity, receive: @escaping ([String: Any], String?) -> Void, state: @escaping (ConnectionState, String?) -> Void) {
        self.receive = receive
        state(.secured, nil)
        Task { @MainActor in
            receive(["type": "device.ready", "runtimes": [
                ["runtimeId": "preview-codex", "sessionId": "session-1", "sessionName": "对齐移动端的使用体验", "name": "Codex", "cwd": "/Projects/orbis", "status": "idle", "agentKind": "codex",
                 "model": ["provider": "openai", "id": "gpt-5.4", "name": "GPT-5.4"], "contextUsage": ["tokens": 24000, "contextWindow": 128000, "percent": 18.75],
                 "permissionManagement": ["summary": "工作区写入", "details": "允许在工作区中编辑文件，需要时请求确认。", "tone": "restricted", "settings": []]],
                ["runtimeId": "preview-pi", "sessionId": "session-2", "sessionName": "梳理项目中的页面结构", "name": "Pi", "cwd": "/Projects/website", "status": "running", "agentKind": "pi"],
                ["runtimeId": "preview-dsh", "sessionId": "session-3", "sessionName": "检查服务端连接状态", "name": "DeepSeek", "cwd": "/Projects/orbis", "status": "idle", "agentKind": "dsh"]
            ], "agents": ["pi", "codex", "dsh"], "launchableAgents": ["pi", "codex", "dsh"]], "ctl")
            receive(["type": "device.path", "path": "relay", "rttMs": 42], "ctl")
            self.event(["type": "runtime.capabilities", "capabilities": ["commands": [
                ["name": "model", "source": "builtin", "description": "切换当前模型", "argument": ["kind": "select", "required": true, "options": [["value": "model-a", "label": "默认模型"]]]],
                ["name": "compact", "source": "builtin", "description": "压缩会话上下文"],
                ["name": "tree", "source": "builtin", "description": "历史与分支", "argument": ["kind": "tree", "required": true, "options": self.treeOptions]]
            ]]])
        }
    }
    func event(_ event: [String: Any], runtimeId: String = "preview-codex") {
        sequence += 1
        receive?(["type": "runtime.event", "runtimeId": runtimeId, "sequence": sequence, "event": event], "msg")
    }
    func send(_ object: [String: Any]) -> Bool {
        Task { @MainActor in self.reply(object) }
        return true
    }
    private func reply(_ object: [String: Any]) {
        if object["type"] as? String == "session.list" {
            let names = ["对齐移动端的使用体验", "梳理项目中的页面结构", "检查服务端连接状态", "优化聊天滚动与输入体验", "整理测试结果", "添加扫码配对", "检查深色模式"]
            let sessions: [[String: Any]] = (1...7).map { index -> [String: Any] in
                let agent = index == 2 ? "pi" : index == 3 ? "dsh" : "codex"
                return ["sessionId": "session-\(index)", "name": names[index - 1],
                 "cwd": index == 2 ? "/Projects/website" : "/Projects/orbis", "createdAt": 1793145600000, "modifiedAt": 1793232000000 - index * 100000,
                 "messageCount": 12, "agentKind": agent, "archived": false, "modelProvider": index == 4 ? "team" : "openai"]
            }
            receive?(["type": "session.list.result", "requestId": object["requestId"]!, "sessions": sessions,
                      "currentProviders": [["agentKind": "codex", "provider": "openai"], ["agentKind": "codexDesktop", "provider": "openai"]]], "ctl")
        } else if object["type"] as? String == "agent.state.request" {
            let requested = object["domains"] as? [String] ?? HostState.domainNames
            let domains = requested.map { name -> [String: Any] in
                ["domain": name, "modelEpoch": "preview-model", "revision": name == "providers" ? providerRevision : 1,
                 "availability": "ready", "completeness": "complete", "projectionComplete": true,
                 "source": ["producer": "host", "sourceId": "preview-host", "sourceEpoch": "preview-source", "sourceRevision": 1],
                 "checkedAt": 1793232000000, "value": domainValue(name)]
            }
            receive?(["type": "agent.state.snapshot", "requestId": object["requestId"]!, "scope": "host", "modelEpoch": "preview-model",
                      "domains": domains, "missing": [], "truncated": false], "ctl")
        } else if object["type"] as? String == "provider.switch", let kind = object["kind"] as? String, let id = object["id"] as? String {
            if kind == "pi" {
                if object["enabled"] as? Bool == true { enabledProviders[kind, default: []].insert(id) }
                else { enabledProviders[kind, default: []].remove(id) }
            } else { enabledProviders[kind] = [id] }
            providerRevision += 1
            receive?(["type": "provider.result", "requestId": object["requestId"]!, "kind": kind,
                      "notice": kind == "pi" ? "显式供应商已更新；已有 Pi 请重新打开，再用 /model 选择模型。" : "供应商已切换；请重新打开会话。独立终端也需重启。"], "ctl")
        } else if object["type"] as? String == "diagnostics.request" {
            let next = object["cursor"] == nil
            let records: [[String: Any]] = next ? [
                ["recordId": "preview-log-1", "hostId": "preview-host", "category": "连接", "severity": "info", "message": "安全通道已建立", "at": 1793232000000],
                ["recordId": "preview-log-2", "hostId": "preview-host", "category": "会话目录", "severity": "info", "message": "已核对三个后端的会话目录", "at": 1793232000100]
            ] : [["recordId": "preview-log-3", "hostId": "preview-host", "category": "供应商", "severity": "info", "message": "供应商配置读取完成", "at": 1793232000200]]
            receive?(["type": "diagnostics.page", "requestId": object["requestId"]!,
                      "page": ["records": records, "nextCursor": next ? "preview-next" as Any : NSNull(), "truncated": false]], "ctl")
        } else if object["type"] as? String == "session.browse" {
            receive?(["type": "session.browse.result", "requestId": object["requestId"]!, "path": object["path"] as? String ?? "/Projects", "parent": "/",
                      "entries": [["name": "orbis", "isDir": true, "hasSessions": true], ["name": "website", "isDir": true, "hasSessions": true], ["name": "experiments", "isDir": true, "hasSessions": false]]], "ctl")
        } else if object["type"] as? String == "runtime.git.request" {
            receive?(["type": "runtime.git", "requestId": object["requestId"]!, "runtimeId": object["runtimeId"]!, "sessionId": "session-1", "cwd": "/Projects/orbis", "branch": "main"], "ctl")
            if screen == "viewport" {
                viewportTail += 1
                event(["type": "message.finished", "message": messages[1]])
            }
        } else if let command = object["command"] as? [String: Any], let type = command["type"] as? String {
            let runtime = object["runtimeId"] as? String ?? "preview-codex"
            if type == "session.sync" {
                event(["type": "session.snapshot", "sessionId": command["sessionId"]!, "syncId": command["syncId"]!, "mode": "replace",
                       "display": ["entries": messages.map { ["message": $0] }]], runtimeId: runtime)
            } else if type == "session.tool.content.read" {
                let text = "Reading project files...\nSources checked: 18\nNo errors found.\nValidation completed successfully.\n"
                let offset = (command["offset"] as? NSNumber)?.intValue ?? 0
                let end = min(text.utf8.count, offset + 48)
                let content = String(decoding: Array(text.utf8)[offset..<end], as: UTF8.self)
                let page: [String: Any] = ["type": "session.tool.content.page", "requestId": command["requestId"]!, "runtimeId": runtime,
                    "locator": command["locator"]!, "read": ["readId": "preview-read", "contentEpoch": "preview-content", "throughOffset": text.utf8.count],
                    "format": "text", "representation": "utf8-fragment", "fromOffset": offset, "throughOffset": end,
                    "availableFromOffset": 0, "availableThroughOffset": text.utf8.count, "observedThroughOffset": text.utf8.count, "contentFinal": true,
                    "text": content, "nextCursor": end < text.utf8.count ? end as Any : NSNull(), "gaps": []]
                event(page, runtimeId: runtime)
            } else if type == "session.entry.request" {
                let index = command["entryId"] as? String == "node-1" ? 0 : 1
                event(["type": "session.entry.result", "requestId": command["requestId"]!, "entryId": command["entryId"]!, "entry": ["data": ["message": messages[index]]]], runtimeId: runtime)
            } else if type == "user_message", let text = command["text"] as? String {
                event(["type": "message.finished", "message": message(command["messageId"] as? String ?? UUID().uuidString, role: "user", text: text)], runtimeId: runtime)
            } else if type == "slash.execute" {
                event(["type": "command.result", "commandId": object["commandId"]!, "ok": true], runtimeId: runtime)
            }
        }
    }
    private func domainValue(_ name: String) -> [String: Any] {
        switch name {
        case "identity": return ["hostId": "preview-host", "hostName": "工作电脑", "protocolVersion": orbisProtocolVersion]
        case "providers":
            let rows: [[String: Any]] = ["pi", "codex", "dsh"].map { kind in
                let profiles: [[String: Any]] = [("official", "官方服务"), ("team", "团队供应商")].map { id, title in
                    ["id": id, "name": title, "enabled": enabledProviders[kind]?.contains(id) == true,
                     "globalDefault": kind == "pi" && id == "official", "mode": kind == "pi" ? "additive" : "exclusive"]
                }
                return ["agentKind": kind, "availability": "ready", "current": enabledProviders[kind]?.sorted().first as Any,
                        "modelProvider": "openai", "profiles": profiles, "profilesTruncated": false,
                        "authenticated": true, "switching": false, "usage": ["availability": "unknown", "detail": NSNull()],
                        "authentication": ["availability": "ready", "method": "api_key", "credentialPresent": true, "bindingReady": true, "verified": NSNull()],
                        "health": ["availability": "unknown", "circuits": []]]
            }
            return ["providers": rows, "checkedAt": 1793232000000]
        case "diagnostics": return ["records": 3, "dropped": 0, "persistFailures": 0, "checkedAt": 1793232000000]
        case "catalog": return ["totalSessions": 7, "truncated": false, "nextCursor": NSNull(),
                                "backends": ["pi", "codex", "dsh"].map { ["kind": $0, "ready": true, "complete": true] }]
        case "backends": return ["backends": ["pi", "codex", "dsh"].map { ["kind": $0, "ready": true] },
                                 "codexDesktop": ["state": "closed", "reason": "Codex 桌面版未打开"]]
        case "management": return ["lifecycle": "running", "platform": "darwin", "nodeVersion": "v24"]
        default: return [:]
        }
    }
    private func message(_ id: String, role: String, text: String) -> [String: Any] {
        ["messageId": id, "role": role, "timestamp": 1793232000000, "content": [["type": "text", "text": text]]]
    }
    private var messages: [[String: Any]] {
        if screen == "viewport" {
            let paragraphs = (1...80).map { "阅读锚点 \($0)" }
            let tail = (0..<viewportTail).map { "新增尾部 \($0 + 1)" }
            return [message("viewport-user", role: "user", text: "检查长回复滚动"),
                    message("viewport-assistant", role: "assistant", text: (paragraphs + tail).joined(separator: "\n\n"))]
        }
        if screen == "tool" {
            let summary: [String: Any] = ["projectionVersion": 1, "tool": ["agent": ["hostId": "preview-host", "agentKind": "codex", "sessionId": "session-1"], "toolCallId": "preview-tool"],
                "toolName": "read", "phase": "finished", "order": 1, "contents": [["part": "output", "format": "text", "availability": "readable", "readCapability": "range"]],
                "resultSummary": ["text": "已检查 18 个源文件", "omitted": false, "originalBytes": "已检查 18 个源文件".utf8.count]]
            return [message("m1", role: "user", text: "检查项目中的源文件。"), ["messageId": "m2", "role": "assistant", "timestamp": 1793232000001,
                "content": [["type": "tool_call", "toolName": "read", "summary": summary], ["type": "text", "text": "源文件检查完成。展开工具可查看摘要和按需读取完整输出。"]]]]
        }
        return [message("m1", role: "user", text: "把 iOS 的 UI 和交互体验对齐到 Android，一个页面一个页面做。"),
         ["messageId": "m2", "role": "assistant", "timestamp": 1793232000001, "content": [
            ["type": "thinking", "text": "先确认两端已有的页面和交互，再逐页对齐视觉、导航和状态反馈。"],
            ["type": "text", "text": "已经梳理了两端的页面结构。接下来按顺序处理：\n\n- 配对与扫码\n- 会话主页和目录\n- 聊天、历史与分支\n\n统一浅色、深色配色和控件的按压反馈。"]]],
         message("m3", role: "user", text: "聊天输入和滚动也要保持一致。"),
         message("m4", role: "assistant", text: "阅读旧消息时会保留当前位置，点击右下角按钮可以跳回最新消息。\n\n```swift\nlet followsLatest = isNearBottom\nif followsLatest {\n    scrollToLatest()\n}\n```\n\n**草稿按电脑和会话隔离**，返回目录后仍会保留。")]
    }
    private var treeOptions: [[String: Any]] {
        let labels = ["对齐 iOS 与 Android 的体验", "梳理页面和交互", "输入和滚动也要一致", "保留阅读位置与会话草稿"]
        return (1...4).map { index -> [String: Any] in
            let parent: Any = index > 1 ? "node-\(index - 1)" : NSNull()
            let tree: [String: Any] = ["parentId": parent, "entryType": "message", "role": index % 2 == 1 ? "user" : "assistant", "defaultHidden": false, "isCurrent": index == 4, "isOnActivePath": true]
            return ["value": "node-\(index)", "label": labels[index - 1], "tree": tree]
        }
    }
}
#endif
