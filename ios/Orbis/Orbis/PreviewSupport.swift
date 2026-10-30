#if DEBUG
import Foundation
import SwiftUI

@MainActor
enum PreviewViewportUpdates {
    static var schedule: (() -> Void)?
}

// Explicit launch arguments opt into isolated, in-memory fixtures for UI review.
// They never read Keychain, connect to a real Host, or persist preview content.
@MainActor
func makePreviewStore(screen: String) -> OrbisStore {
    let transport = PreviewTransport(screen: screen)
    PreviewViewportUpdates.schedule = screen == "viewport" && ProcessInfo.processInfo.arguments.contains("--preview-viewport-drag")
        ? { [weak transport] in transport?.scheduleViewportBatch() } : nil
    // `--preview-hosts=2` pairs a second computer, to review how several computers are switched.
    let twoHosts = ProcessInfo.processInfo.arguments.contains("--preview-hosts=2")
    let store = OrbisStore(secure: PreviewStorage(empty: screen == "pairing", twoHosts: twoHosts), preferences: nil,
                           transportFactory: { pairing in pairing.hostId == "preview-host" ? transport : PreviewTransport(screen: screen, variant: 1) })
    if screen == "slash" || screen == "approval" || screen == "interactions" {
        Task { @MainActor in
            for _ in 0..<10 where store.selectedRuntime == nil { await Task.yield() }
            if screen == "slash", let runtime = store.selectedRuntime { store.saveDraft("/", for: runtime) }
            if screen == "interactions" {
                for (id, title, kind) in [("draft-one", "填写验证说明", "input"), ("draft-two", "确认下一步", "confirm")] {
                    transport.event(["type": "interaction.requested", "request": ["runtimeId": "preview-codex", "requestId": id, "extensionId": "preview", "kind": kind, "title": title, "placeholder": "输入验证说明", "expiresAt": Int64(Date().timeIntervalSince1970 * 1000) + 300000]])
                }
            }
            if screen == "approval" {
                transport.event(["type": "interaction.requested", "request": ["runtimeId": "preview-codex", "requestId": "preview-approval", "extensionId": "preview", "kind": "confirm", "title": "允许执行验证命令？", "description": "Agent 请求运行项目的测试，以检查本次修改。", "argumentSummary": "swift test --package-path ios/Orbis", "expiresAt": Int64(Date().timeIntervalSince1970 * 1000) + 300000]])
            }
        }
    }
    return store
}

private final class PreviewStorage: SecureStorage {
    var hosts: [HostPairing]
    init(empty: Bool, twoHosts: Bool = false) {
        hosts = empty ? [] : [HostPairing(hostId: "preview-host", hostName: "工作电脑", hostPub: Base64URL.encode(Data(repeating: 2, count: 32)),
            pskRoot: Base64URL.encode(Data(repeating: 1, count: 32)), relay: RelayCredential(relayUrl: "wss://relay.example", deviceId: "preview-device", credential: "preview-only"), lan: [])]
        if twoHosts && !empty {
            hosts.append(HostPairing(hostId: "preview-host-2", hostName: "家里的电脑", hostPub: Base64URL.encode(Data(repeating: 4, count: 32)),
                pskRoot: Base64URL.encode(Data(repeating: 3, count: 32)), relay: RelayCredential(relayUrl: "wss://relay.example", deviceId: "preview-device-2", credential: "preview-only"), lan: []))
        }
    }
    func deviceIdentity() throws -> DeviceIdentity { .generate() }
    func savePairings(_ pairings: [HostPairing]) throws { hosts = pairings }
    func pairings() -> [HostPairing] { hosts }
}

@MainActor
private final class PreviewTransport: OrbisTransport {
    let screen: String
    /// 0 is the main fixture computer; 1 is a second computer with its own sessions.
    let variant: Int
    init(screen: String, variant: Int = 0) { self.screen = screen; self.variant = variant }
    var receive: (([String: Any], String?) -> Void)?
    var sequence = 0
    private var archivedSessionIds: Set<String> = []
    private var providerRevision = 1
    private var viewportTail = 0
    private var viewportUpdates: Task<Void, Never>?
    private var viewportRows: Bool { ProcessInfo.processInfo.arguments.contains("--preview-viewport-rows") }
    private var sourceSequence = 1
    private var homeReplayScheduled = false
    private var homeReadFailed = false
    /// Messages sent from the composer in this preview; source checkpoints keep them after a re-sync.
    private var sentMessages: [[String: Any]] = []
    /// `--preview-send=pi` answers after a delay with a different id; `fail` rejects the send (ADR-0049).
    private var sendMode: String { ProcessInfo.processInfo.arguments.first { $0.hasPrefix("--preview-send=") }.map { String($0.dropFirst(15)) } ?? "codex" }
    private var slowSync: Bool { ProcessInfo.processInfo.arguments.contains("--preview-slow-sync") }
    private var compacting: Bool { ProcessInfo.processInfo.arguments.contains("--preview-compacting") }
    private var modelName: String { slowSync ? "A very long model name that needs truncation" : "GPT-5.4" }
    private var enabledProviders: [String: Set<String>] = ["codex": ["official"], "pi": ["official"], "claude": ["official"], "dsh": ["official"]]
    func pair(qr: PairingQR, deviceName: String, identity: DeviceIdentity, completion: @escaping (Result<HostPairing, Error>) -> Void) { completion(.failure(PairingError.invalidQR)) }
    func disconnect() { viewportUpdates?.cancel(); viewportUpdates = nil }
    func connect(pairing: HostPairing, identity: DeviceIdentity, receive: @escaping ([String: Any], String?) -> Void, state: @escaping (ConnectionState, String?) -> Void) {
        self.receive = receive
        state(.secured, nil)
        Task { @MainActor in
            if ProcessInfo.processInfo.arguments.contains("--preview-home-staged") {
                try? await Task.sleep(nanoseconds: 8_000_000_000)
            }
            if self.variant == 1 {
                receive(["type": "device.ready", "protocolVersion": orbisProtocolVersion, "modelEpoch": "preview-model-2", "notificationEpoch": "preview-notices-2", "runtimes": [
                    ["runtimeId": "home-pi", "sessionId": "home-session-1", "sessionName": "整理家庭照片脚本", "name": "Pi", "cwd": "/Users/home/scripts", "status": "idle", "agentKind": "pi"]
                ], "agents": ["pi"], "launchableAgents": ["pi"]], "ctl")
                receive(["type": "device.path", "path": "lan", "rttMs": 8], "ctl")
                return
            }
            var runtimes: [[String: Any]] = [
                ["runtimeId": "preview-codex", "sessionId": "session-1", "sessionName": "对齐移动端的使用体验", "name": "Codex", "cwd": "/Projects/orbis", "status": "idle", "agentKind": "codex",
                 "model": ["provider": "openai", "id": "gpt-5.4", "name": self.modelName], "thinkingLevel": "high", "contextUsage": ["tokens": 24000, "contextWindow": 128000, "percent": 18.75],
                 "permissionManagement": ["summary": "工作区写入", "details": "允许在工作区中编辑文件，需要时请求确认。", "tone": "restricted", "settings": []]],
                ["runtimeId": "preview-pi", "sessionId": "session-2", "sessionName": "梳理项目中的页面结构", "name": "Pi", "cwd": "/Projects/website", "status": "running", "agentKind": "pi"],
                ["runtimeId": "preview-dsh", "sessionId": "session-3", "sessionName": "检查服务端连接状态", "name": "DeepSeek", "cwd": "/Projects/orbis", "status": "idle", "agentKind": "dsh"]
            ]
            if ProcessInfo.processInfo.arguments.contains("--preview-home-long-list") {
                runtimes += (4...15).map { index in
                    ["runtimeId": "preview-scroll-\(index)", "sessionId": "session-\(index)",
                     "sessionName": "滚动测试会话 \(index)", "name": "Codex", "cwd": "/Projects/orbis",
                     "status": "idle", "agentKind": "codex"]
                }
            }
            receive(["type": "device.ready", "protocolVersion": orbisProtocolVersion, "modelEpoch": "preview-model", "notificationEpoch": "preview-notices", "runtimes": runtimes,
                     "agents": ["pi", "codex", "dsh"], "launchableAgents": ["pi", "codex", "dsh"]], "ctl")
            receive(["type": "device.path", "path": "relay", "rttMs": 42], "ctl")
            self.event(["type": "runtime.capabilities", "capabilities": ["commands": [
                ["name": "quit", "source": "builtin", "description": "关闭会话"],
                ["name": "model", "source": "builtin", "description": "切换当前模型", "argument": ["kind": "select", "required": true, "options": [["value": "model-a", "label": "默认模型"]]]],
                ["name": "compact", "source": "builtin", "description": "压缩会话上下文"],
                ["name": "tree", "source": "builtin", "description": "历史与分支", "argument": ["kind": "tree", "required": true, "options": self.treeOptions]]
            ]]])
            for runtime in runtimes.compactMap({ $0["runtimeId"] as? String }) where runtime != "preview-codex" {
                self.event(["type": "runtime.capabilities", "capabilities": ["commands": [
                    ["name": "quit", "source": "builtin", "description": "关闭会话"]
                ]]], runtimeId: runtime)
            }
        }
    }
    func event(_ event: [String: Any], runtimeId: String = "preview-codex") {
        sequence += 1
        receive?(["type": "runtime.event", "runtimeId": runtimeId, "sequence": sequence, "event": event], "msg")
    }
    private func appendViewportContent() {
        viewportTail += 1
        let base = sourceSequence
        sourceSequence += 1
        // Replace the growing long reply and append real user/tool rows with stable identities.
        let changed = Array(messages.enumerated().dropFirst())
        let entries: [[String: Any]] = changed.map { index, message in
            ["entryId": "node-\(index + 1)", "parentId": "node-\(index)", "type": "message",
             "timestamp": "2026-10-29T00:00:00.000Z", "data": ["message": message]]
        }
        let display: [[String: Any]] = changed.map { index, message in
            ["displayId": "node-\(index + 1)", "entryId": "node-\(index + 1)", "kind": "message", "message": message]
        }
        event(["type": "session.patch", "sessionId": "session-1", "baseSeq": base, "seq": sourceSequence,
               "source": ["epoch": "preview-source", "seq": sourceSequence, "ready": true],
               "head": ["leafId": "node-\(messages.count)"], "headCompleteness": "complete",
               "entries": entries, "display": ["projectionVersion": 3, "entries": display],
               "live": ["complete": true, "messages": [], "tools": []]])
    }
    func scheduleViewportBatch() {
        viewportUpdates?.cancel()
        viewportUpdates = Task { @MainActor [weak self] in
            do {
                try await Task.sleep(nanoseconds: 2_000_000_000)
                for _ in 0..<6 {
                    guard let self else { return }
                    self.appendViewportContent()
                    try await Task.sleep(nanoseconds: 100_000_000)
                }
            } catch { }
        }
    }
    func send(_ object: [String: Any]) -> Bool {
        if (object["command"] as? [String: Any])?["type"] as? String == "session.sync" {
            ChatEntryProbe.shared.sentSync()
        }
        Task { @MainActor in
            if ProcessInfo.processInfo.arguments.contains("--preview-home-staged"), object["type"] as? String == "agent.state.request", object["scope"] as? String == "agent" {
                let delay: UInt64 = object["sessionId"] as? String == "replacement" ? 6 : object["runtimeId"] as? String == "preview-dsh" ? 3 : 1
                try? await Task.sleep(nanoseconds: delay * 1_000_000_000)
            }
            if slowSync, (object["command"] as? [String: Any])?["type"] as? String == "session.sync" {
                try? await Task.sleep(nanoseconds: 5_000_000_000)
            }
            self.reply(object)
        }
        return true
    }
    private func reply(_ object: [String: Any]) {
        if variant == 1 {
            if object["type"] as? String == "session.list" {
                receive?(["type": "session.list.result", "requestId": object["requestId"]!, "sessions": [
                    ["sessionId": "home-session-1", "name": "整理家庭照片脚本", "cwd": "/Users/home/scripts", "createdAt": 1793145600000,
                     "modifiedAt": 1793232000000, "messageCount": 4, "agentKind": "pi", "archived": false]], "currentProviders": []], "ctl")
            }
            return
        }
        if object["type"] as? String == "session.list" {
            let names = ["对齐移动端的使用体验", "梳理项目中的页面结构", "检查服务端连接状态", "优化聊天滚动与输入体验", "整理测试结果", "添加扫码配对", "检查深色模式"]
            let longDirectory = ProcessInfo.processInfo.arguments.contains("--preview-long-directory")
            let drawerLayout = ProcessInfo.processInfo.arguments.contains("--preview-drawer-layout")
            let sessions: [[String: Any]] = (1...(longDirectory ? 25 : 7)).map { index -> [String: Any] in
                let agent = index == 2 ? "pi" : index == 3 ? "dsh" : "codex"
                let layoutTitle = index == 4 ? "这是一个需要换行并且超过两行后显示省略号的很长会话标题，用来检查侧边栏卡片是否始终等高" : "短标题"
                let layoutRow = drawerLayout && (index == 4 || index == 5)
                return ["sessionId": "session-\(index)", "name": layoutRow ? layoutTitle : index <= names.count ? names[index - 1] : "较早会话 \(index)",
                 "cwd": index == 2 ? "/Projects/website" : "/Projects/orbis", "createdAt": 1793145600000, "modifiedAt": 1793232000000 - index * 100000 + (layoutRow ? 1000000 : 0),
                 "messageCount": 12, "agentKind": agent, "archived": archivedSessionIds.contains("session-\(index)"), "modelProvider": index == 4 ? "team" : "openai"]
            }
            receive?(["type": "session.list.result", "requestId": object["requestId"]!, "sessions": sessions,
                      "currentProviders": [["agentKind": "codex", "provider": "openai"], ["agentKind": "codexDesktop", "provider": "openai"]]], "ctl")
        } else if object["type"] as? String == "session.archive", let id = object["sessionId"] as? String,
                  let archived = object["archived"] as? Bool {
            if archived { archivedSessionIds.insert(id) } else { archivedSessionIds.remove(id) }
            receive?(["type": "session.archive.changed", "requestId": object["requestId"]!,
                      "sessionId": id, "agentKind": object["agentKind"]!, "archived": archived], "ctl")
        } else if object["type"] as? String == "notification.sync", let runtime = object["runtimeId"] as? String {
            let notices: [[String: Any]] = screen == "queue" || screen == "notices" ? [["notificationId": "preview-notice", "producerEpoch": "preview-producer", "code": "test_ready", "occurrenceId": "preview-occurrence", "scope": [:], "severity": "warning", "message": "模型服务等待恢复，电脑端会继续核对。", "lifecycle": "condition", "createdAt": 1793232000000, "updatedAt": 1793232000000, "verification": "unknown"]] : []
            receive?(["type": "notification.snapshot", "protocolVersion": orbisProtocolVersion, "hostEpoch": "preview-notices", "runtimeId": runtime, "sessionId": runtime == "preview-codex" ? "session-1" : runtime == "preview-pi" ? "session-2" : "session-3", "revision": 1, "complete": true, "verification": notices.isEmpty ? "confirmed" : "unknown", "notifications": notices], "ctl")
        } else if object["type"] as? String == "notification.dismiss", let runtime = object["runtimeId"] as? String {
            receive?(["type": "notification.snapshot", "protocolVersion": orbisProtocolVersion, "hostEpoch": "preview-notices", "runtimeId": runtime, "sessionId": "session-1", "revision": 2, "complete": true, "verification": "confirmed", "notifications": []], "ctl")
        } else if object["type"] as? String == "agent.state.request", object["scope"] as? String == "agent" {
            let runtime = object["runtimeId"] as? String ?? "preview-codex", session = object["sessionId"] as? String ?? "session-1"
            if ProcessInfo.processInfo.arguments.contains("--preview-home-read-failure"), runtime == "preview-pi", !homeReadFailed {
                homeReadFailed = true
                receive?(["type": "protocol.error", "requestId": object["requestId"]!, "message": "会话状态读取失败，请重试"], "ctl")
                return
            }
            // Cards are already published; a replaced session then fails its first read in the background.
            if ProcessInfo.processInfo.arguments.contains("--preview-home-background-failure") {
                if session == "replacement-pi", !homeReadFailed {
                    homeReadFailed = true
                    receive?(["type": "protocol.error", "requestId": object["requestId"]!, "message": "会话状态读取失败，请重试"], "ctl")
                    return
                }
                if runtime == "preview-dsh", !homeReplayScheduled {
                    homeReplayScheduled = true
                    Task { @MainActor [weak self] in
                        try? await Task.sleep(nanoseconds: 2_000_000_000)
                        self?.receive?(["type": "runtime.online", "runtime": ["runtimeId": "preview-pi", "sessionId": "replacement-pi", "name": "Pi",
                                                                              "cwd": "/Projects/website", "status": "running", "agentKind": "pi"]], "ctl")
                    }
                }
            }
            let epoch = variant == 1 ? "preview-model-2" : "preview-model"
            let kind = object["agentKind"] as? String ?? "codex"
            let titles = ["preview-codex": "对齐移动端的使用体验", "preview-pi": "梳理项目中的页面结构",
                          "preview-dsh": "检查服务端连接状态", "home-pi": "整理家庭照片脚本"]
            let cwd = variant == 1 ? "/Users/home/scripts" : runtime == "preview-pi" ? "/Projects/website" : "/Projects/orbis"
            let domains = ["identity", "interactions", "execution", "model", "context"].map { name -> [String: Any] in
                let value: [String: Any] = name == "identity" ? ["runtimeId": runtime, "sessionId": session,
                    "name": agentTitle(kind), "sessionName": session == "replacement" ? "已完整切换的会话" : titles[runtime] ?? "滚动测试会话 \(session)", "cwd": cwd, "agentKind": kind] :
                    name == "interactions" ? [:] : name == "execution" ? ["phase": "idle", "waitingFor": [], "retry": "unavailable", "compaction": compacting && runtime == "preview-codex" ? ["phase": "running"] : "unavailable", "turn": ["turnId": "preview-turn", "startedAt": 1793232000000, "durationMs": 3240]] : name == "model" ? ["provider": "openai", "id": "gpt-5.4", "name": modelName, "thinkingLevel": "high"] : ["tokens": 24000, "contextWindow": 128000, "percent": 18.75]
                return ["domain": name, "modelEpoch": epoch, "revision": 1, "availability": "ready", "completeness": "complete", "projectionComplete": true,
                        "source": ["producer": "host", "sourceId": "preview-host", "sourceEpoch": "preview-source", "sourceRevision": 1], "checkedAt": 1793232000000, "value": value]
            }
            receive?(["type": "agent.state.snapshot", "requestId": object["requestId"]!, "scope": "agent", "runtimeId": runtime, "sessionId": session, "agentKind": kind, "modelEpoch": epoch, "domains": domains, "missing": [], "truncated": false], "ctl")
            if ProcessInfo.processInfo.arguments.contains("--preview-home-staged"), runtime == "preview-dsh", !homeReplayScheduled {
                homeReplayScheduled = true
                Task { @MainActor [weak self] in
                    try? await Task.sleep(nanoseconds: 3_000_000_000)
                    guard let self else { return }
                    self.receive?(["type": "runtime.online", "runtime": ["runtimeId": "preview-codex", "sessionId": "replacement", "name": "Agent", "cwd": "", "status": "unknown"]], "ctl")
                    self.receive?(["type": "device.path", "path": "lan", "rttMs": 8], "ctl")
                }
            }
            if ProcessInfo.processInfo.arguments.contains("--preview-home-replay"), !homeReplayScheduled {
                homeReplayScheduled = true
                Task { @MainActor [weak self] in
                    do { try await Task.sleep(nanoseconds: 2_000_000_000) } catch { return }
                    guard let self else { return }
                    let stubs: [[String: Any]] = [("preview-codex", "session-1"), ("preview-pi", "session-2"), ("preview-dsh", "session-3")].map { id, session in
                        ["runtimeId": id, "sessionId": session, "name": "Agent", "cwd": "", "status": "unknown"]
                    }
                    self.receive?(["type": "device.ready", "modelEpoch": "preview-model", "runtimes": stubs], "ctl")
                    self.receive?(["type": "runtime.online", "runtime": stubs[0]], "ctl")
                    self.event(["type": "runtime.metadata", "metadata": ["cwd": "", "name": "Agent", "status": "unknown"]])
                    self.receive?(["type": "device.path", "path": "lan", "rttMs": 8], "ctl")
                }
            }
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
        } else if object["type"] as? String == "provider.subscription", let kind = object["kind"] as? String {
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: .milliseconds(900))
                self?.receive?(["type": "provider.subscription.result", "requestId": object["requestId"]!, "kind": kind, "id": object["id"]!,
                    "quota": ["checkedAt": 1793232000000, "windows": [
                        ["name": "five_hour", "remainingPercent": kind == "codex" ? 82 : 64, "resetsAt": 1793242000000],
                        ["name": "seven_day", "remainingPercent": kind == "codex" ? 35 : 18, "resetsAt": 1793432000000]]]], "ctl")
            }
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
                appendViewportContent()
            }
        } else if let command = object["command"] as? [String: Any], let type = command["type"] as? String {
            let runtime = object["runtimeId"] as? String ?? "preview-codex"
            if type == "session.sync" {
                let messages = self.messages + sentMessages
                let entries: [[String: Any]] = messages.enumerated().map { index, message in
                    ["entryId": "node-\(index + 1)", "parentId": index == 0 ? NSNull() : "node-\(index)" as Any, "type": "message", "timestamp": "2026-10-29T00:00:00.000Z", "data": ["message": message]]
                }
                let display: [[String: Any]] = messages.enumerated().map { ["displayId": "node-\($0.offset + 1)", "entryId": "node-\($0.offset + 1)", "kind": "message", "message": $0.element] }
                event(["type": "session.snapshot", "sessionId": command["sessionId"]!, "syncId": command["syncId"]!, "range": "preview", "mode": "replace", "selection": "snapshot", "cursor": ["leafId": "node-\(messages.count)"], "entries": entries,
                       "source": ["epoch": "preview-source", "seq": sourceSequence, "ready": true], "checkpoint": ["checkpointId": "preview-checkpoint", "head": ["leafId": "node-\(messages.count)"], "headCompleteness": "complete", "inventoryComplete": true],
                       "live": ["complete": true, "messages": [], "tools": []], "hasOlder": false, "complete": true, "rangeStatus": "complete", "display": ["projectionVersion": 3, "entries": display]], runtimeId: runtime)
                if screen == "queue" { event(["type": "message.queued", "queueId": "preview-queue", "text": "接着检查 iOS 的历史同步和文件传输。", "delivery": "followUp", "state": "accepted"], runtimeId: runtime) }
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
                let full = screen == "truncated" ? message("truncated-message", role: "assistant", text: "完整返回内容：这条消息已按需从电脑取回。") : messages[index]
                event(["type": "session.entry.result", "requestId": command["requestId"]!, "entryId": command["entryId"]!, "entry": ["data": ["message": full]]], runtimeId: runtime)
            } else if type == "user_message.cancel" {
                event(["type": "message.queued", "queueId": command["messageId"]!, "text": "接着检查 iOS 的历史同步和文件传输。", "delivery": "followUp", "state": "cancelled"], runtimeId: runtime)
                event(["type": "command.result", "commandId": object["commandId"]!, "ok": true], runtimeId: runtime)
            } else if type == "user_message", let text = command["text"] as? String, let clientId = command["messageId"] as? String {
                let commandId = object["commandId"]!
                let mode = sendMode
                Task { @MainActor in
                    try? await Task.sleep(nanoseconds: mode == "codex" ? 0 : 400_000_000)
                    if mode == "fail" {
                        self.event(["type": "command.result", "commandId": commandId, "ok": false, "status": "failure", "error": "runtime_busy"], runtimeId: runtime)
                        return
                    }
                    self.event(["type": "command.result", "commandId": commandId, "ok": true, "status": "success"], runtimeId: runtime)
                    // Long enough for UI automation to observe the pending row before the Host commits it.
                    if mode == "pi" { try? await Task.sleep(nanoseconds: 4_000_000_000) }
                    self.commitSent(text: text, clientId: clientId, runtime: runtime)
                }
            } else if type == "slash.execute" {
                // `--preview-close=slow` confirms /quit after a delay; `fail` rejects it (ADR-0049 §5).
                let close = ProcessInfo.processInfo.arguments.first { $0.hasPrefix("--preview-close=") }.map { String($0.dropFirst(16)) }
                guard command["name"] as? String == "quit", let close else {
                    event(["type": "command.result", "commandId": object["commandId"]!, "ok": true], runtimeId: runtime)
                    if command["name"] as? String == "quit" { receive?(["type": "runtime.offline", "runtimeId": runtime], "ctl") }
                    return
                }
                let commandId = object["commandId"]!
                Task { @MainActor in
                    try? await Task.sleep(nanoseconds: 3_000_000_000)
                    if close == "fail" {
                        self.event(["type": "command.result", "commandId": commandId, "ok": false, "status": "failure", "error": "进程仍在运行"], runtimeId: runtime)
                        return
                    }
                    self.event(["type": "command.result", "commandId": commandId, "ok": true], runtimeId: runtime)
                    try? await Task.sleep(nanoseconds: 1_000_000_000)
                    self.receive?(["type": "runtime.offline", "runtimeId": runtime], "ctl")
                }
            }
        }
    }
    private func domainValue(_ name: String) -> [String: Any] {
        switch name {
        case "identity": return ["hostId": "preview-host", "hostName": "工作电脑", "protocolVersion": orbisProtocolVersion]
        case "providers":
            let rows: [[String: Any]] = ["pi", "codex", "claude", "dsh"].map { kind in
                let profiles: [[String: Any]] = [("official", "官方服务"), ("team", "团队供应商")].map { id, title in
                    ["id": id, "name": title, "enabled": enabledProviders[kind]?.contains(id) == true,
                     "globalDefault": kind == "pi" && id == "official", "mode": kind == "pi" ? "additive" : "exclusive",
                     "official": id == "official", "subscriptionSupported": id == "official" && ["codex", "claude"].contains(kind)]
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
                                 "agents": ["pi", "codex", "dsh"], "launchableAgents": ["pi", "codex", "dsh"],
                                 "codexDesktop": ["state": "closed", "reason": "Codex 桌面版未打开"]]
        case "management": return ["lifecycle": "running", "platform": "darwin", "nodeVersion": "v24"]
        default: return [:]
        }
    }
    /// The Host commits the prompt as a canonical entry whose id differs from the App id but declares it.
    private func commitSent(text: String, clientId: String, runtime: String) {
        let parent = "node-\(messages.count + sentMessages.count)"
        let entryId = "node-\(messages.count + sentMessages.count + 1)"
        var sent = message(entryId, role: "user", text: text); sent["clientMessageId"] = clientId
        sentMessages.append(sent)
        let base = sourceSequence
        sourceSequence += 1
        event(["type": "session.patch", "sessionId": "session-1", "baseSeq": base, "seq": sourceSequence,
               "source": ["epoch": "preview-source", "seq": sourceSequence, "ready": true],
               "head": ["leafId": entryId], "headCompleteness": "complete",
               "entries": [["entryId": entryId, "parentId": parent, "type": "message", "timestamp": "2026-10-29T00:00:00.000Z", "data": ["message": sent]]],
               "display": ["projectionVersion": 3, "entries": [["displayId": entryId, "entryId": entryId, "kind": "message", "message": sent]]],
               "live": ["complete": true, "messages": [], "tools": []]], runtimeId: runtime)
    }
    private func message(_ id: String, role: String, text: String) -> [String: Any] {
        ["messageId": id, "role": role, "timestamp": 1793232000000, "content": [["type": "text", "text": text]]]
    }
    private var messages: [[String: Any]] {
        if screen == "entry" {
            let longTurn = ProcessInfo.processInfo.arguments.contains("--preview-entry-long-turn")
            let history = (1...80).flatMap { index in
                [message("entry-user-\(index)", role: "user", text: "检查第 \(index) 个文件"),
                 message("entry-reply-\(index)", role: "assistant", text: String(repeating: "检查完成，缓存的历史不应阻塞再次进入。\n\n", count: 8))]
            }
            let turn = (1...(longTurn ? 80 : 1)).map { index in
                message("entry-step-\(index)", role: "assistant", text: "步骤 \(index)\n\n**验证**源文件、布局与工具执行状态。\n\n保持完整正文和原有阅读位置。")
            }
            return history + [message("entry-question", role: "user", text: "检查长轮次的进入性能")] + turn +
                [message("entry-latest", role: "assistant", text: "ENTRY_LATEST")]
        }
        if screen == "truncated" {
            return [["messageId": "truncated-message", "role": "assistant", "timestamp": 1793232000000,
                "content": [["type": "text", "text": "这条消息的线路投影只保留了前半部分。", "truncated": true, "originalBytes": 2048],
                    ["type": "tool_call", "toolCallId": "legacy-tool", "toolName": "read", "arguments": ["path": "/repo/source.swift", "limit": 40]]]],
                ["messageId": "legacy-result", "role": "tool", "toolCallId": "legacy-tool", "toolName": "read", "timestamp": 1793232000001,
                 "content": [["type": "text", "text": "已完成工具参数验证。"]]]]
        }
        if screen == "viewport" {
            let paragraphs = (1...80).map { "阅读锚点 \($0)" }
            let tail = (0..<viewportTail).map { "新增尾部 \($0 + 1)" }
            let appended: [[String: Any]] = viewportRows ? (0..<viewportTail).flatMap { index in
                [message("viewport-user-\(index)", role: "user", text: "新增消息 \(index)"),
                 ["messageId": "viewport-tool-\(index)", "role": "assistant", "timestamp": 1793232000001,
                  "content": [["type": "tool_call", "toolCallId": "viewport-call-\(index)", "toolName": "ViewportTool",
                               "arguments": ["command": "echo viewport"]]]]]
            } : []
            return [message("viewport-user", role: "user", text: "检查长回复滚动"),
                    message("viewport-assistant", role: "assistant", text: (paragraphs + tail).joined(separator: "\n\n"))] + appended
        }
        if screen == "tool" {
            let longTranscript = ProcessInfo.processInfo.arguments.contains("--preview-long-transcript")
            let result = longTranscript ? (1...32).map { "工具输出第 \($0) 行：检查源文件与布局，保留展开位置。" }.joined(separator: "\n") : "已检查 18 个源文件"
            let summary: [String: Any] = ["projectionVersion": 1, "tool": ["agent": ["hostId": "preview-host", "agentKind": "codex", "sessionId": "session-1"], "toolCallId": "preview-tool"],
                "toolName": "read", "phase": "finished", "order": 1, "contents": [["part": "output", "format": "text", "availability": "readable", "readCapability": "range"]],
                "resultSummary": ["text": result, "omitted": false, "originalBytes": result.utf8.count]]
            let history = longTranscript ? (1...40).flatMap { index in
                [message("tool-user-\(index)", role: "user", text: "检查第 \(index) 个源文件。"),
                 message("tool-assistant-\(index)", role: "assistant", text: "第 \(index) 个源文件检查完成。\n\n" + String(repeating: "历史消息用于验证懒加载后的首次定位。", count: 8))]
            } : []
            return history + [message("m1", role: "user", text: "检查项目中的源文件。"), ["messageId": "m2", "role": "assistant", "timestamp": 1793232000001,
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

/// Opt-in fixture diagnostics. The draw callback measures app rendering, not source-sync latency
/// or the display's physical presentation time. No message text or identity is recorded.
@MainActor
final class ChatEntryProbe: ObservableObject {
    static let shared = ChatEntryProbe()
    static let enabled = ProcessInfo.processInfo.arguments.contains("--measure-chat-entry")
    @Published private(set) var report = "idle"
    @Published private(set) var syncRequests = 0
    private var start: TimeInterval?
    private var selectionMs: Double = 0
    private var recorded = false
    private var generation = 0
    func sentSync() { if Self.enabled { syncRequests += 1 } }
    func begin() {
        guard Self.enabled else { return }
        generation += 1; recorded = false; selectionMs = 0
        start = ProcessInfo.processInfo.systemUptime
    }
    func selected() {
        guard Self.enabled, let start else { return }
        selectionMs = (ProcessInfo.processInfo.systemUptime - start) * 1000
    }
    func drew() {
        guard Self.enabled, let start, !recorded else { return }
        recorded = true
        let value = String(format: "entry=%d selectionMs=%.1f drawMs=%.1f", generation, selectionMs,
                           (ProcessInfo.processInfo.systemUptime - start) * 1000)
        DispatchQueue.main.async { self.report = value; NSLog("OrbisChatEntry %@", value) }
    }
}

struct ChatEntryDrawProbe: UIViewRepresentable {
    final class ProbeView: UIView {
        override func draw(_ rect: CGRect) { ChatEntryProbe.shared.drew() }
    }
    func makeUIView(context: Context) -> ProbeView {
        let view = ProbeView(); view.isOpaque = false; view.backgroundColor = .clear
        return view
    }
    func updateUIView(_ view: ProbeView, context: Context) {}
}

struct ChatEntryReport: View {
    @ObservedObject private var probe = ChatEntryProbe.shared
    var body: some View {
        VStack {
            Text(probe.report).accessibilityIdentifier("chat-entry-metrics")
            Text(String(probe.syncRequests)).accessibilityIdentifier("chat-entry-sync-count")
        }.font(.system(size: 12)).allowsHitTesting(false)
    }
}
#endif
