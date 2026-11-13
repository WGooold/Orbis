#if DEBUG
import Foundation
import SwiftUI
import UIKit

/// MATH-01: offline production renderer fixture for both themes, tables and streamed completion.
struct MathRenderingPreview: View {
    @EnvironmentObject private var store: OrbisStore
    @Environment(\.colorScheme) private var scheme
    @State private var completed = false
    private var source: String {
        #"""
        **相邻变化** \(\Delta S=S_B-S_A\) 与参考值。

        \[
        \begin{aligned}\text{相邻变化：}\quad &\hat d_t=g_\theta(X_t)-g_\theta(X_{t-1})\\
        \text{相对基线：}\quad &\hat R_t=g_\theta(X_t)-g_\theta(X_0)\end{aligned}
        \]

        | 方式 | 公式 |
        |---|---|
        | 加权分 | \(\sum w_i R_i/15+|x|\) |

        \[\begin{pmatrix}1&2\\3&4\end{pmatrix}\]

        """# + (completed ? #"完整 \(\frac{a}{b}\)，回退 \(\unknownCommand{x}\)"# : #"未完成 \(\frac{a}"#)
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Button("Complete") { completed = true }.accessibilityIdentifier("math-complete")
                MarkdownMessage(text: source, streaming: !completed).environmentObject(store.transfers)
            }.padding(20)
        }.background(OrbisPalette(scheme).base).foregroundStyle(OrbisPalette(scheme).text)
    }
}

/// Uses production buttons with no network or navigation, for cancellation and frame review.
struct ActionFeedbackPreview: View {
    @Environment(\.colorScheme) private var scheme
    @State private var count = 0
    @State private var enabled = true
    private let symbols = ["gearshape", "clock.arrow.circlepath", "arrow.clockwise", "arrow.down.to.line"]
    private let labels = ["设置", "历史", "刷新", "下载"]
    var body: some View {
        VStack(spacing: 32) {
            Text("\(count)").accessibilityIdentifier("feedback-count")
            HStack(spacing: 12) {
                ForEach(symbols.indices, id: \.self) { index in
                    OrbisIconButton(symbol: symbols[index], label: labels[index]) { count += 1 }
                        .disabled(!enabled)
                }
            }
            Button(enabled ? "禁用按钮" : "启用按钮") { enabled.toggle() }
            Spacer().frame(height: 160)
        }.padding(24).frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(OrbisPalette(scheme).base)
    }
}

private struct PreviewRevealTimeKey: EnvironmentKey {
    static let defaultValue: TimeInterval? = nil
}

extension EnvironmentValues {
    var previewRevealTime: TimeInterval? {
        get { self[PreviewRevealTimeKey.self] }
        set { self[PreviewRevealTimeKey.self] = newValue }
    }
}

/// Drives the production renderer at exact instants, including across newly mounted blocks.
struct StreamingRevealPreview: View {
    @EnvironmentObject private var store: OrbisStore
    @State private var stage = 0
    private var text: String {
        "BASE" + (stage >= 1 ? String(repeating: "A", count: 70) : "") +
            (stage >= 2 ? "\n\nSECOND\n\n- THIRD\n\n```text\nFOURTH\n```" : "")
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            Button("下一帧 \(stage)") { stage = min(5, stage + 1) }
                .accessibilityIdentifier("reveal-next-frame")
            MarkdownMessage(text: text, streaming: stage < 4)
                .environmentObject(store.transfers)
                .environment(\.previewRevealTime, [0, 1, 1.05, 1.08, 1.2, 2][stage])
            Spacer()
        }.padding(24).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(Color.white).foregroundStyle(Color.black)
    }
}

/// Production reply surface in an isolated fixture, with explicit append / rewrite / remount.
struct ReplyCardMotionPreview: View {
    @EnvironmentObject private var store: OrbisStore
    @Environment(\.colorScheme) private var scheme
    @State private var text = "FIRST"
    @State private var showNew = false
    @State private var arrivals = ReplyCardArrivals()
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack {
                Button("Append") { text += "\nSECOND\nTHIRD\nFOURTH" }.accessibilityIdentifier("reply-append")
                Button("Rewrite") { text = "REWRITTEN" }.accessibilityIdentifier("reply-rewrite")
                Button("New") {
                    let now = ProcessInfo.processInfo.systemUptime
                    arrivals.observe(rows: [], ready: true, following: true, now: now)
                    arrivals.observe(rows: [("new", ["new"])], ready: true, following: true, now: now)
                    showNew = true
                }.accessibilityIdentifier("reply-new")
            }
            VStack(alignment: .leading, spacing: 12) {
                Text("ANCHOR").accessibilityIdentifier("reply-anchor")
                MarkdownMessage(text: text, streaming: true)
            }.frame(maxWidth: .infinity, alignment: .leading)
                .modifier(OrbisReplyCard(id: "old", parts: [.init(id: "text", text: text)], live: true, arrivals: nil))
                .accessibilityElement(children: .contain).accessibilityIdentifier("reply-card")
            if showNew {
                VStack(alignment: .leading) { Text("NEW FIRST\nNEW SECOND\nNEW THIRD") }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .modifier(OrbisReplyCard(id: "new", parts: [.init(id: "new", text: "new")], live: true, arrivals: arrivals))
                    .accessibilityElement(children: .contain).accessibilityIdentifier("reply-new-card")
            }
            Spacer()
        }.padding(24).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(OrbisPalette(scheme).base)
            .environmentObject(store.transfers)
    }
}

@MainActor
enum PreviewViewportUpdates {
    static var schedule: (() -> Void)?
    static var advance: (() -> Void)?
    static var changeList: ((String) -> Void)?
}

@MainActor
final class PreviewHomeRefreshProbe: ObservableObject {
    static let shared = PreviewHomeRefreshProbe()
    @Published var reads = 0
}

struct PreviewHomeRefreshReport: View {
    @ObservedObject private var probe = PreviewHomeRefreshProbe.shared
    var body: some View {
        Text(String(probe.reads)).font(.system(size: 1)).foregroundStyle(.clear)
            .accessibilityIdentifier("preview-home-model-reads")
            .allowsHitTesting(false)
    }
}

// Explicit launch arguments opt into isolated, in-memory fixtures for UI review.
// They never read Keychain, connect to a real Host, or persist preview content.
@MainActor
func makePreviewStore(screen: String) -> OrbisStore {
    PreviewHomeRefreshProbe.shared.reads = 0
    let transport = PreviewTransport(screen: screen)
    PreviewViewportUpdates.schedule = screen == "viewport" && ProcessInfo.processInfo.arguments.contains("--preview-viewport-drag")
        ? { [weak transport] in transport?.scheduleViewportBatch() } : nil
    PreviewViewportUpdates.advance = screen == "viewport" ? { [weak transport] in transport?.advanceViewport() } : nil
    // `--preview-hosts=2` pairs a second computer, to review how several computers are switched.
    let twoHosts = ProcessInfo.processInfo.arguments.contains("--preview-hosts=2")
    let store = OrbisStore(secure: PreviewStorage(empty: screen == "pairing", twoHosts: twoHosts), preferences: nil,
                           transportFactory: { pairing in pairing.hostId == "preview-host" ? transport : PreviewTransport(screen: screen, variant: 1) })
    PreviewViewportUpdates.changeList = { [weak store, weak transport] operation in
        transport?.changeList(operation)
        store?.refresh()
    }
    if screen == "slash" {
        Task { @MainActor in
            for _ in 0..<10 where store.selectedRuntime == nil { await Task.yield() }
            if let runtime = store.selectedRuntime { store.saveDraft("/", for: runtime) }
        }
    }
    transport.launchGate = { [weak store] in
        store?.pendingSends.items.contains { if case .waiting = $0.state { return true }; return false } == true
    }
    if screen == "chat", let mode = ProcessInfo.processInfo.arguments.first(where: { $0.hasPrefix("--preview-upload-waiting") }) {
        // 夹具（ADR-0049 §6.1–§6.2）：输入框挂一个正在上传的图片；带着它发出消息后推进进度，
        // 再完成上传（`--preview-upload-waiting`）或失败（`--preview-upload-waiting=fail`）。
        Task { @MainActor in await previewUploadWhileWaiting(store, failing: mode.hasSuffix("=fail")) }
    }
    if screen == "chat", ProcessInfo.processInfo.arguments.contains("--preview-model-switch") {
        // 夹具：聊天页稳定后切换模型；电脑端只回执、不改模型领域，选择保持“切换中”（ADR-0049 §6.7）。
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            store.executeSlash("model", args: "model-a")
        }
    }
    return store
}

@MainActor
private func previewUploadWhileWaiting(_ store: OrbisStore, failing: Bool) async {
    for _ in 0..<100 where store.selectedRuntime?.sessionId == nil { try? await Task.sleep(nanoseconds: 50_000_000) }
    guard let runtime = store.selectedRuntime, let hostId = store.selectedHostId else { return }
    let url = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("orbis-preview-upload.png")
    let image = UIGraphicsImageRenderer(size: CGSize(width: 120, height: 120)).pngData { context in
        UIColor(red: 0.36, green: 0.55, blue: 0.95, alpha: 1).setFill(); context.fill(CGRect(x: 0, y: 0, width: 120, height: 120))
        UIColor(red: 0.98, green: 0.78, blue: 0.32, alpha: 1).setFill(); context.cgContext.fillEllipse(in: CGRect(x: 30, y: 30, width: 60, height: 60))
    }
    try? image.write(to: url)
    let id = "preview-upload-1", size: Int64 = 4_200_000
    store.transfers.previewBeginUpload(FileTransfer(id: id, hostKey: store.transfers.hostKey, hostId: hostId, runtimeId: runtime.runtimeId,
        sessionId: runtime.sessionId, direction: "upload", name: "截图.png", size: size, received: size / 10, sha256: String(repeating: "a", count: 64),
        localPath: url.path, remotePath: "/Projects/orbis/.orbis-uploads/aaaa", status: "uploading"))
    // 等用户带着它发出消息，再推进；没有发出则一直停在上传中。
    while !store.pendingSends.items.contains(where: { $0.uploadIds.contains(id) }) { try? await Task.sleep(nanoseconds: 200_000_000) }
    for step in 1...3 {
        try? await Task.sleep(nanoseconds: 1_000_000_000)
        store.transfers.previewProgress(id, received: size * Int64(step * 3) / 10)
    }
    // 失败路径要演示“后一条不越过前一条”：等用户再发一条纯文本（最多 60 秒）再让上传失败。
    for _ in 0..<300 where failing && !store.pendingSends.items.contains(where: { $0.uploadIds.isEmpty }) {
        try? await Task.sleep(nanoseconds: 200_000_000)
    }
    // 留足时间让审阅 / 自动化看到后一条排在前一条之后。
    try? await Task.sleep(nanoseconds: failing ? 4_000_000_000 : 1_500_000_000)
    if failing { store.transfers.previewFailUpload(id, message: "网络中断") }
    else { store.transfers.previewFinishUpload(id, remotePath: "/Projects/orbis/.orbis-uploads/aaaa/截图.png") }
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
    var relayTransportKind: RelayTransportKind? {
        ProcessInfo.processInfo.arguments.contains("--preview-relay-quic") ? .quic : .ws
    }
    var relayTransportMode: RelayTransportMode = .auto
    let screen: String
    /// 0 is the main fixture computer; 1 is a second computer with its own sessions.
    let variant: Int
    init(screen: String, variant: Int = 0) { self.screen = screen; self.variant = variant }
    var receive: (([String: Any], String?) -> Void)?
    func setRelayTransportMode(_ mode: RelayTransportMode) { relayTransportMode = mode }
    var sequence = 0
    private var archivedSessionIds: Set<String> = []
    private var providerRevision = 1
    private var viewportTail = 0
    private var viewportSeeded = false
    private var viewportUpdates: Task<Void, Never>?
    private var viewportRows: Bool { ProcessInfo.processInfo.arguments.contains("--preview-viewport-rows") }
    private var keyboardStream: Bool { ProcessInfo.processInfo.arguments.contains("--preview-keyboard-stream") }
    private var keyboardLive: [[String: Any]] {
        guard keyboardStream else { return [] }
        let text = (1...80).map { "生成中正文 \($0)" } + (0..<viewportTail).map { "生成尾部 \($0 + 1)" }
        return [["message": message("keyboard-live", role: "assistant", text: text.joined(separator: "\n\n")),
                 "finished": false, "contentComplete": true]]
    }
    private var sourceSequence = 1
    private var homeReplayScheduled = false
    private var homeReadFailed = false
    private var listMutation = ""
    private var claudeIdentityStage = 0
    private var claudeIdentity: Bool { ProcessInfo.processInfo.arguments.contains("--preview-claude-identity") }

    func changeList(_ operation: String) {
        listMutation = operation
        if operation == "insert" && screen != "drawer" {
            receive?(["type": "runtime.online", "runtime": ["runtimeId": "preview-new", "sessionId": "session-new",
                "sessionName": "新插入的会话", "name": "Codex", "cwd": "/Projects/orbis", "status": "idle", "agentKind": "codex"]], "ctl")
        } else if operation == "remove" && screen != "drawer" {
            receive?(["type": "runtime.offline", "runtimeId": "preview-codex"], "ctl")
        }
    }
    /// Messages sent from the composer in this preview; source checkpoints keep them after a re-sync.
    private var sentMessages: [[String: Any]] = []
    /// `--preview-launch-slow` 启动成功后上线的 Runtime → Session。
    private var launchedSessions: [String: String] = [:]
    /// `--preview-launch-slow`：启动页上已有等待中的消息时为 true。
    var launchGate: (() -> Bool)?
    /// `--preview-close=drop`：模拟断线与重连（同一配对、同一连接代次的回调）。
    private var dropConnection: (() -> Void)?
    private var reconnect: (() -> Void)?
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
        reconnect = { [weak self] in self?.connect(pairing: pairing, identity: identity, receive: receive, state: state) }
        dropConnection = { state(.connecting, nil) }
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
            if self.claudeIdentity {
                runtimes[0]["agentKind"] = "claude"
                runtimes[0]["name"] = "Claude Code"
            }
            if ProcessInfo.processInfo.arguments.contains("--preview-home-long-list") {
                runtimes += (4...15).map { index in
                    ["runtimeId": "preview-scroll-\(index)", "sessionId": "session-\(index)",
                     "sessionName": "滚动测试会话 \(index)", "name": "Codex", "cwd": "/Projects/orbis",
                     "status": "idle", "agentKind": "codex"]
                }
            }
            if ProcessInfo.processInfo.arguments.contains("--preview-background-tasks") { runtimes[0]["agentKind"] = "claude"; runtimes[0]["name"] = "Claude Code" }
            let launchableDshOnly = ProcessInfo.processInfo.arguments.contains("--preview-launchable-dsh")
            receive(["type": "device.ready", "protocolVersion": orbisProtocolVersion, "modelEpoch": "preview-model", "notificationEpoch": "preview-notices", "runtimes": runtimes,
                     "sessionConfiguration": ProcessInfo.processInfo.arguments.contains("--preview-permission-options") ? 1 : 0,
                     "agents": launchableDshOnly ? ["pi"] : ["pi", "codex", "dsh"],
                     "launchableAgents": launchableDshOnly ? ["pi", "dsh"] : ProcessInfo.processInfo.arguments.contains("--preview-draft-desktop-only") ? ["codexDesktop"] : ProcessInfo.processInfo.arguments.contains("--preview-draft-desktop") ? ["pi", "codex", "codexDesktop", "dsh"] : ["pi", "codex", "dsh"]], "ctl")
            var path: [String: Any] = ["type": "device.path", "path": "relay"]
            if !ProcessInfo.processInfo.arguments.contains("--preview-no-rtt") { path["rttMs"] = 42 }
            receive(path, "ctl")
            // V21: the top session goes away while the reader is scrolled further down the list.
            if ProcessInfo.processInfo.arguments.contains("--preview-home-remove-later") {
                Task { @MainActor [weak self] in
                    try? await Task.sleep(nanoseconds: 7_000_000_000)
                    self?.receive?(["type": "runtime.offline", "runtimeId": "preview-codex"], "ctl")
                }
            }
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
    /// Replay the Host's complete inventories at controlled UI-test boundaries.
    private func replyClaudeIdentity(_ command: [String: Any], runtime: String) {
        let stage = min(claudeIdentityStage, 2)
        claudeIdentityStage += 1
        let user = message("identity-user", role: "user", text: "检查 Claude 消息交接")
        let answer = message("identity-answer", role: "assistant", text: "CLAUDE_IDENTITY_REPLY")
        let next = message("identity-next", role: "assistant", text: "CLAUDE_IDENTITY_NEXT")
        let canonical = [user] + (stage > 0 ? [answer] : []) + (stage > 1 ? [next] : [])
        let entries: [[String: Any]] = canonical.enumerated().map { index, item in
            ["entryId": item["messageId"]!, "parentId": index == 0 ? NSNull() : canonical[index - 1]["messageId"]!,
             "type": "message", "timestamp": "2026-10-31T00:00:00.000Z", "data": ["message": item]]
        }
        let display = canonical.map { ["displayId": $0["messageId"]!, "entryId": $0["messageId"]!, "kind": "message", "message": $0] as [String: Any] }
        var streamed = stage == 0 ? answer : next
        streamed["messageId"] = stage == 0 ? "native-turn:0" : "next-turn:0"
        let live: [[String: Any]] = stage < 2 ? [["message": streamed, "finished": false, "contentComplete": true]] : []
        let seq = claudeIdentityStage
        event(["type": "session.snapshot", "sessionId": command["sessionId"]!, "syncId": command["syncId"]!,
               "range": "preview", "mode": "replace", "selection": "snapshot", "cursor": ["leafId": canonical.last!["messageId"]!],
               "entries": entries, "display": ["projectionVersion": 3, "entries": display],
               "source": ["epoch": "claude-identity", "seq": seq, "ready": true],
               "checkpoint": ["checkpointId": "identity-\(seq)", "head": ["leafId": canonical.last!["messageId"]!], "headCompleteness": "complete", "inventoryComplete": true],
               "live": ["complete": true, "messages": live, "tools": []], "hasOlder": false, "complete": true, "rangeStatus": "complete"], runtimeId: runtime)
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
               "live": ["complete": true, "messages": keyboardLive, "tools": []]])
    }
    func advanceViewport() {
        appendViewportContent()
        if keyboardStream { scheduleViewportBatch() }
    }
    func scheduleViewportBatch() {
        viewportUpdates?.cancel()
        viewportUpdates = Task { @MainActor [weak self] in
            do {
                let keyboard = ProcessInfo.processInfo.arguments.contains("--preview-keyboard-stream")
                try await Task.sleep(nanoseconds: keyboard ? 100_000_000 : 2_000_000_000)
                for _ in 0..<(keyboard ? 120 : 6) {
                    guard let self else { return }
                    self.appendViewportContent()
                    try await Task.sleep(nanoseconds: 100_000_000)
                }
            } catch { }
        }
    }
    // S54 / SC78: isolated native draft flow, including a real save acknowledgement.
    private var configurationValues: [String: Any] = ["model": "gpt-5.4", "thinking": "high",
        "permissions": ["sandbox": "workspaceWrite", "network": "restricted", "approvals": "on-request", "approval-reviewer": "user"]]
    private var permissionOptions: [[String: Any]] { [
        ["id": "sandbox", "label": "文件访问范围", "currentValue": "workspaceWrite", "options": [
            ["value": "readOnly", "label": "只读", "description": "允许读取文件；写入需要额外授权。"],
            ["value": "workspaceWrite", "label": "工作区可写"], ["value": "dangerFullAccess", "label": "完全访问"]]],
        ["id": "network", "label": "网络访问", "currentValue": "restricted", "options": [
            ["value": "restricted", "label": "限制联网"], ["value": "enabled", "label": "允许联网"]]],
        ["id": "approvals", "label": "何时申请审批", "currentValue": "on-request", "options": [
            ["value": "on-request", "label": "按需询问"], ["value": "never", "label": "不申请审批"]]],
        ["id": "approval-reviewer", "label": "谁来处理审批", "currentValue": "user", "options": [
            ["value": "user", "label": "由我处理"], ["value": "guardian_subagent", "label": "自动审查"]]]
    ] }

    func send(_ object: [String: Any]) -> Bool {
        if ProcessInfo.processInfo.arguments.contains("--preview-home-refresh-probe"),
           object["type"] as? String == "agent.state.request", object["scope"] as? String == "agent",
           object["runtimeId"] as? String == "preview-codex" {
            PreviewHomeRefreshProbe.shared.reads += 1
        }
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
        if ProcessInfo.processInfo.arguments.contains("--preview-permission-options"),
           ["session.configuration.read", "session.configuration.save"].contains(object["type"] as? String ?? "") {
            if let values = object["values"] as? [String: Any] { configurationValues = values }
            receive?(["type": "session.configuration.result", "requestId": object["requestId"]!,
                "agentKind": object["agentKind"] ?? "codex", "cwd": object["cwd"] ?? "/Projects/orbis", "binding": "quiet-ui", "revision": 1,
                "values": configurationValues, "catalog": ["binding": "quiet-ui", "defaults": configurationValues,
                    "models": [["value": "gpt-5.4", "label": "GPT-5.4", "thinking": [["value": "high", "label": "高"]]]],
                    "permissions": permissionOptions]], "ctl")
            return
        }
        if object["type"] as? String == "session.list" {
            let names = ["对齐移动端的使用体验", "梳理项目中的页面结构", "检查服务端连接状态", "优化聊天滚动与输入体验", "整理测试结果", "添加扫码配对", "检查深色模式"]
            let longDirectory = ProcessInfo.processInfo.arguments.contains("--preview-long-directory") || ProcessInfo.processInfo.arguments.contains("--preview-home-long-list")
            let drawerLayout = ProcessInfo.processInfo.arguments.contains("--preview-drawer-layout")
            let manyDirectories = ProcessInfo.processInfo.arguments.contains("--preview-many-directories")
            var sessions: [[String: Any]] = (1...(longDirectory ? 25 : 7)).map { index -> [String: Any] in
                let agent = index == 2 ? "pi" : index == 3 ? "dsh" : "codex"
                let layoutTitle = index == 4 ? "这是一个需要换行并且超过两行后显示省略号的很长会话标题，用来检查侧边栏卡片是否始终等高" : "短标题"
                let layoutRow = drawerLayout && (index == 4 || index == 5)
                return ["sessionId": "session-\(index)", "name": layoutRow ? layoutTitle : index <= names.count ? names[index - 1] : "较早会话 \(index)",
                 "cwd": manyDirectories ? "/Projects/test-\(index)" : index == 2 ? "/Projects/website" : "/Projects/orbis", "createdAt": 1793145600000, "modifiedAt": 1793232000000 - index * 100000 + (layoutRow ? 1000000 : 0) + (listMutation == "promote" && index == 15 ? 10000000 : 0),
                 "messageCount": 12, "agentKind": agent, "archived": archivedSessionIds.contains("session-\(index)"), "modelProvider": index == 4 ? "team" : "openai"]
            }
            if listMutation == "insert" {
                sessions.insert(["sessionId": "session-new", "name": "新插入的会话", "cwd": manyDirectories ? "/Projects/new" : "/Projects/orbis",
                    "createdAt": 1793232000001, "modifiedAt": 1793232000001, "messageCount": 0, "agentKind": "codex"], at: 0)
            } else if listMutation == "remove" { sessions.removeAll { $0["sessionId"] as? String == "session-1" } }
            receive?(["type": "session.list.result", "requestId": object["requestId"]!, "sessions": sessions,
                      "currentProviders": [["agentKind": "codex", "provider": "openai"], ["agentKind": "codexDesktop", "provider": "openai"]]], "ctl")
        } else if object["type"] as? String == "session.archive", let id = object["sessionId"] as? String,
                  let archived = object["archived"] as? Bool {
            if archived { archivedSessionIds.insert(id) } else { archivedSessionIds.remove(id) }
            receive?(["type": "session.archive.changed", "requestId": object["requestId"]!,
                      "sessionId": id, "agentKind": object["agentKind"]!, "archived": archived], "ctl")
        } else if object["type"] as? String == "session.activate", ProcessInfo.processInfo.arguments.contains("--preview-launch-fail") {
            // 夹具：Host 明确拒绝启动（ADR-0049 §6.8 的失败原位路径）。默认不回复，停在“启动中”。
            let requestId = object["requestId"]!
            Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                self?.receive?(["type": "protocol.error", "requestId": requestId, "code": "agent_unavailable", "message": "对应的 agent 后端未就绪"], "ctl")
            }
        } else if object["type"] as? String == "session.activate", ProcessInfo.processInfo.arguments.contains("--preview-launch-slow") {
            // 夹具：启动约 3 秒后成功（ADR-0049 §6.8 的成功路径）：Runtime 先上线，再回复同一 requestId 的 session.activated。
            let requestId = object["requestId"]!
            let target = object["target"] as? [String: Any] ?? [:]
            let session = target["type"] as? String == "resume" ? target["sessionId"] as? String ?? "session-launched" : "session-launched"
            let cwd = target["cwd"] as? String ?? "/Projects/orbis"
            Task { @MainActor [weak self] in
                // 等启动页上有一条等待会话启动的消息（最多 60 秒），再过 3 秒上线，演示启动中发送与输入焦点交接。
                for _ in 0..<300 where self?.launchGate?() == false { try? await Task.sleep(nanoseconds: 200_000_000) }
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                guard let self else { return }
                self.launchedSessions["preview-launched"] = session
                self.receive?(["type": "runtime.online", "runtime": ["runtimeId": "preview-launched", "sessionId": session,
                    "sessionName": "刚启动的会话", "name": "Pi", "cwd": cwd, "status": "idle", "agentKind": "pi"]], "ctl")
                self.receive?(["type": "session.activated", "requestId": requestId, "sessionId": session], "ctl")
            }
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
            // 交互由 agent.state 的 interactions 领域持有（持有后旧的 interaction.requested 事件被忽略），夹具请求须放在这里。
            func previewInteractions(_ runtime: String) -> [String: Any] {
                guard runtime == "preview-codex" else { return [:] }
                let expires = Int64(Date().timeIntervalSince1970 * 1000) + 300000
                var rows: [[String: Any]] = []
                if screen == "approval" {
                    rows.append(["runtimeId": runtime, "requestId": "preview-approval", "extensionId": "preview", "kind": "confirm", "title": "允许执行验证命令？", "description": "Agent 请求运行项目的测试，以检查本次修改。", "argumentSummary": "swift test --package-path ios/Orbis", "expiresAt": expires])
                }
                if screen == "interactions" {
                    for (id, title, kind) in [("draft-one", "填写验证说明", "input"), ("draft-two", "确认下一步", "confirm")] {
                        rows.append(["runtimeId": runtime, "requestId": id, "extensionId": "preview", "kind": kind, "title": title, "placeholder": "输入验证说明", "expiresAt": expires])
                    }
                }
                return Dictionary(uniqueKeysWithValues: rows.map { ($0["requestId"] as! String, $0) })
            }
            let epoch = variant == 1 ? "preview-model-2" : "preview-model"
            let kind = object["agentKind"] as? String ?? "codex"
            let titles = ["preview-codex": "对齐移动端的使用体验", "preview-pi": "梳理项目中的页面结构",
                          "preview-dsh": "检查服务端连接状态", "home-pi": "整理家庭照片脚本"]
            let cwd = variant == 1 ? "/Users/home/scripts" : runtime == "preview-pi" ? "/Projects/website" : "/Projects/orbis"
            let supported = ["identity", "interactions", "execution", "model", "context"]
            let requested = object["domains"] as? [String] ?? supported
            let domains = supported.filter { requested.contains($0) }.map { name -> [String: Any] in
                var value: [String: Any] = name == "identity" ? ["runtimeId": runtime, "sessionId": session,
                    "name": agentTitle(kind), "sessionName": session == "replacement" ? "已完整切换的会话" : titles[runtime] ?? "滚动测试会话 \(session)", "cwd": cwd, "agentKind": kind] :
                    name == "interactions" ? previewInteractions(runtime) : name == "execution" ? ["phase": "idle", "waitingFor": [], "retry": "unavailable", "compaction": compacting && runtime == "preview-codex" ? ["phase": "running"] : "unavailable", "turn": ["turnId": "preview-turn", "startedAt": 1793232000000, "durationMs": 3240]] : name == "model" ? ["provider": "openai", "id": "gpt-5.4", "name": modelName, "thinkingLevel": "high"] : ["tokens": 24000, "contextWindow": 128000, "percent": 18.75]
                if name == "execution", keyboardStream, runtime == "preview-codex" { value["phase"] = "running" }
                if ProcessInfo.processInfo.arguments.contains("--preview-current-turn"), runtime == "preview-codex" {
                    if name == "execution" { value["phase"] = "running" }
                    if name == "model", !ProcessInfo.processInfo.arguments.contains("--preview-old-turn-host") {
                        value["currentTurnSupported"] = true
                        value["currentTurn"] = ["turnId": "preview-turn", "model": ["provider": "openai", "id": "gpt-5.3", "name": "GPT-5.3"], "thinkingLevel": "medium"]
                    }
                }
                if name == "execution", runtime == "preview-codex", ProcessInfo.processInfo.arguments.contains("--preview-background-tasks") {
                    let partial = ProcessInfo.processInfo.arguments.contains("--preview-background-incomplete")
                    value["tasks"] = ["availability": partial ? "unknown" : "ready", "truncated": partial, "items": [
                        ["id": "review", "title": "检查代码", "kind": "Explore", "status": partial ? "completed" : "running"],
                        ["id": "tests", "title": "运行测试", "kind": "general-purpose", "status": partial ? "completed" : "running", "parentId": "review"]
                    ]]
                }
                return ["domain": name, "modelEpoch": epoch, "revision": 1, "availability": "ready", "completeness": "complete", "projectionComplete": true,
                        "source": ["producer": "host", "sourceId": "preview-host", "sourceEpoch": "preview-source", "sourceRevision": 1], "checkedAt": 1793232000000, "value": value]
            }
            // SC54–59 fixtures obey the same bounded domain/format contract as a Host.
            var snapshot: [String: Any] = ["type": "agent.state.snapshot", "requestId": object["requestId"]!, "scope": "agent", "runtimeId": runtime, "sessionId": session, "agentKind": kind, "modelEpoch": epoch, "domains": domains, "missing": requested.filter { !supported.contains($0) }.map { ["domain": $0, "reason": "no_state"] }, "truncated": false]
            if let format = object["stateFormat"] { snapshot["stateFormat"] = format }
            receive?(snapshot, "ctl")
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
        } else if object["type"] as? String == "agent.state.request", object["scope"] as? String == "device" {
            let names = object["domains"] as? [String] ?? []
            receive?(["type": "agent.state.snapshot", "requestId": object["requestId"]!, "scope": "device", "modelEpoch": "preview-model", "domains": [], "missing": names.map { ["domain": $0, "reason": "no_state"] }, "truncated": false], "ctl")
        } else if object["type"] as? String == "agent.state.request" {
            let requested = object["domains"] as? [String] ?? HostState.domainNames
            let domains = requested.map { name -> [String: Any] in
                ["domain": name, "modelEpoch": "preview-model", "revision": name == "providers" ? providerRevision : 1,
                 "availability": "ready", "completeness": "complete", "projectionComplete": true,
                 "source": ["producer": "host", "sourceId": "preview-host", "sourceEpoch": "preview-source", "sourceRevision": 1],
                 "checkedAt": 1793232000000, "value": domainValue(name)]
            }
            var snapshot: [String: Any] = ["type": "agent.state.snapshot", "requestId": object["requestId"]!, "scope": "host", "modelEpoch": "preview-model", "domains": domains, "missing": [], "truncated": false]
            if let format = object["stateFormat"] { snapshot["stateFormat"] = format }
            receive?(snapshot, "ctl")
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
            // The regular Git poll only reports Git facts. A single initial seed and the
            // explicit preview control own source updates, independently of test duration.
            if screen == "viewport", !viewportSeeded {
                viewportSeeded = true
                advanceViewport()
            }
        } else if let command = object["command"] as? [String: Any], let type = command["type"] as? String {
            let runtime = object["runtimeId"] as? String ?? "preview-codex"
            if type == "session.sync" {
                if claudeIdentity {
                    replyClaudeIdentity(command, runtime: runtime)
                    return
                }
                let messages = self.messages + sentMessages
                let entries: [[String: Any]] = messages.enumerated().map { index, message in
                    ["entryId": "node-\(index + 1)", "parentId": index == 0 ? NSNull() : "node-\(index)" as Any, "type": "message", "timestamp": "2026-10-29T00:00:00.000Z", "data": ["message": message]]
                }
                let display: [[String: Any]] = messages.enumerated().map { ["displayId": "node-\($0.offset + 1)", "entryId": "node-\($0.offset + 1)", "kind": "message", "message": $0.element] }
                event(["type": "session.snapshot", "sessionId": command["sessionId"]!, "syncId": command["syncId"]!, "range": "preview", "mode": "replace", "selection": "snapshot", "cursor": ["leafId": "node-\(messages.count)"], "entries": entries,
                       "source": ["epoch": "preview-source", "seq": sourceSequence, "ready": true], "checkpoint": ["checkpointId": "preview-checkpoint", "head": ["leafId": "node-\(messages.count)"], "headCompleteness": "complete", "inventoryComplete": true],
                       "live": ["complete": true, "messages": keyboardLive, "tools": []], "hasOlder": false, "complete": true, "rangeStatus": "complete", "display": ["projectionVersion": 3, "entries": display]], runtimeId: runtime)
                if screen == "queue" { event(["type": "message.queued", "queueId": "preview-queue", "text": "接着检查 iOS 的历史同步和文件传输。", "delivery": "followUp", "state": "accepted"], runtimeId: runtime) }
            } else if type == "session.changes.list" {
                let rows = screen == "changes" ? [changeSummary] : []
                event(["type": "session.changes.summaries", "requestId": command["requestId"]!, "runtimeId": runtime,
                       "agent": command["agent"]!, "summaries": rows, "nextCursor": NSNull()], runtimeId: runtime)
            } else if type == "session.changes.read", screen == "changes" {
                event(["type": "session.changes.page", "requestId": command["requestId"]!, "runtimeId": runtime,
                       "agent": command["agent"]!, "changeSetId": "preview-change-set", "manifestVersion": 1,
                       "files": changeFiles, "totalCount": changeFiles.count, "nextCursor": NSNull()], runtimeId: runtime)
            } else if type == "session.change.detail.read", screen == "changes" {
                let file = command["fileId"] as? String ?? ""
                TurnChangesPreviewProbe.shared.record(file)
                let next = command["cursor"] as? String == "next"
                // The first range is taller than the viewer, so pulls past the diff's top are exercised.
                let body = (3...72).map { " context line \($0)\n" }.joined()
                let content = file == "change-1" ? (next ? "+CHANGE_FIRST_MORE\n" : "--- a/src/Feature.d.ts\n+++ b/src/Feature.d.ts\n@@ -1,72 +1,72 @@\n-old value\n+CHANGE_FIRST\n context\n" + body) :
                    "--- /dev/null\n+++ b/README.md\n@@ -0,0 +1 @@\n+CHANGE_SECOND\n"
                event(["type": "session.change.detail.page", "requestId": command["requestId"]!, "runtimeId": runtime,
                    "agent": command["agent"]!, "changeSetId": command["changeSetId"]!, "manifestVersion": command["manifestVersion"]!,
                    "fileId": file, "contentVersion": command["contentVersion"]!, "viewerId": command["viewerId"]!,
                    "readId": "preview-read-" + file, "text": content, "nextCursor": file == "change-1" && !next ? "next" as Any : NSNull(),
                    "eof": file != "change-1" || next], runtimeId: runtime)
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
                let full = screen == "truncated" ? message("truncated-message", role: "assistant", text: "完整返回内容：这条消息已按需从电脑取回。") : ProcessInfo.processInfo.arguments.contains("--preview-history-artifact") ? messages.last! : messages[index]
                event(["type": "session.entry.result", "requestId": command["requestId"]!, "entryId": command["entryId"]!, "entry": ["data": ["message": full]]], runtimeId: runtime)
            } else if type == "interaction.respond", ProcessInfo.processInfo.arguments.contains("--preview-respond-reject") {
                // 夹具：Host 明确拒绝回答（ADR-0049 §6.5 的恢复路径）。默认不回复，停在处理中。
                let commandId = object["commandId"]!
                Task { @MainActor in
                    // 3 秒：留出足够时间观察处理中的原位摘要（XCUITest 约 1 秒轮询一次）。
                    try? await Task.sleep(nanoseconds: 3_000_000_000)
                    self.event(["type": "command.result", "commandId": commandId, "ok": false, "status": "failure", "error": "请求已被电脑端处理"], runtimeId: runtime)
                }
            } else if type == "user_message.cancel" {
                event(["type": "message.queued", "queueId": command["messageId"]!, "text": "接着检查 iOS 的历史同步和文件传输。", "delivery": "followUp", "state": "cancelled"], runtimeId: runtime)
                event(["type": "command.result", "commandId": object["commandId"]!, "ok": true], runtimeId: runtime)
            } else if type == "user_message", let sentText = command["text"] as? String, let clientId = command["messageId"] as? String {
                let commandId = object["commandId"]!
                // 与各后端一样把附件路径写进用户消息，审阅时能看出正文与附件一起提交（ADR-0055 §5）。
                let attachments = command["attachments"] as? [String] ?? []
                let text = attachments.isEmpty ? sentText : sentText + "\n\n" + attachments.map { "附件：" + $0 }.joined(separator: "\n")
                let mode = sendMode
                Task { @MainActor in
                    try? await Task.sleep(nanoseconds: mode == "codex" ? 0 : 400_000_000)
                    if mode == "queue" {
                        self.event(["type": "message.queued", "queueId": clientId, "text": text, "delivery": "followUp", "state": "accepted"], runtimeId: runtime)
                        self.event(["type": "command.result", "commandId": commandId, "ok": true, "status": "success"], runtimeId: runtime)
                        return
                    }
                    if mode == "unknown" {
                        self.event(["type": "command.result", "commandId": commandId, "ok": false, "status": "unconfirmed", "error": "原生提交结果待核对"], runtimeId: runtime)
                        return
                    }
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
                if close == "drop" {
                    // 夹具（V11 r27）：关闭命令写入后断线、没有回执；3 秒后重连，新连接的权威在线列表里会话仍在。
                    Task { @MainActor [weak self] in
                        try? await Task.sleep(nanoseconds: 1_000_000_000)
                        self?.dropConnection?()
                        try? await Task.sleep(nanoseconds: 3_000_000_000)
                        self?.reconnect?()
                    }
                    return
                }
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
                                 "agents": ["pi", "codex", "dsh"], "launchableAgents": ProcessInfo.processInfo.arguments.contains("--preview-draft-desktop-only") ? ["codexDesktop"] : ProcessInfo.processInfo.arguments.contains("--preview-draft-desktop") ? ["pi", "codex", "codexDesktop", "dsh"] : ["pi", "codex", "dsh"],
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
        event(["type": "session.patch", "sessionId": launchedSessions[runtime] ?? "session-1", "baseSeq": base, "seq": sourceSequence,
               "source": ["epoch": "preview-source", "seq": sourceSequence, "ready": true],
               "head": ["leafId": entryId], "headCompleteness": "complete",
               "entries": [["entryId": entryId, "parentId": parent, "type": "message", "timestamp": "2026-10-29T00:00:00.000Z", "data": ["message": sent]]],
               "display": ["projectionVersion": 3, "entries": [["displayId": entryId, "entryId": entryId, "kind": "message", "message": sent]]],
               "live": ["complete": true, "messages": [], "tools": []]], runtimeId: runtime)
    }
    private func message(_ id: String, role: String, text: String) -> [String: Any] {
        ["messageId": id, "role": role, "timestamp": 1793232000000, "content": [["type": "text", "text": text]]]
    }
    private var changeFiles: [[String: Any]] {
        [
            ["fileId": "change-1", "path": "src/VeryLongUnicode模块👩🏽‍💻FileNameWithManySectionsAndPreservedCompoundExtension.d.ts", "changeKind": "modified", "fileKind": "text", "additions": 2, "deletions": 1, "beforeBytes": 20, "afterBytes": 36, "contentVersion": "version-1", "detail": "available"],
            ["fileId": "change-2", "path": "README.md", "changeKind": "added", "fileKind": "text", "additions": 1, "deletions": 0, "beforeBytes": NSNull(), "afterBytes": 16, "contentVersion": "version-2", "detail": "available"],
            ["fileId": "change-3", "path": "assets/logo.png", "changeKind": "deleted", "fileKind": "binary", "additions": NSNull(), "deletions": NSNull(), "beforeBytes": 4096, "afterBytes": NSNull(), "contentVersion": "version-3", "detail": "binary"]
        ]
    }
    private var changeSummary: [String: Any] {
        let native = ProcessInfo.processInfo.arguments.contains("--preview-native-file-changes")
        return ["projectionVersion": 1, "agent": ["hostId": "preview-host", "agentKind": "codex", "sessionId": "session-1"],
         "reviewTurnId": "preview-review", "sourceTurnIds": ["preview-native-turn"], "changeSetId": "preview-change-set", "manifestVersion": 1, "revision": 1,
         "anchorEntryId": "node-2", "startedAt": 1793232000000, "finishedAt": 1793232001000, "state": "ready", "outcome": "completed",
         "coverage": "partial", "scope": native ? "native-file-tools" : "git-visible-files", "attribution": native ? "native-tool" : "workspace-window", "reasons": native ? ["native-file-tools-only"] : ["external-writes-possible"], "fileCount": 3,
         "addedFiles": 1, "modifiedFiles": 1, "deletedFiles": 1, "additions": NSNull(), "deletions": NSNull(), "preview": changeFiles]
    }
    private var messages: [[String: Any]] {
        if screen == "changes" {
            // Five steps make two virtual rows; the summary is anchored on the first step (node-2)
            // and must still follow the turn's last row.
            return [message("m1", role: "user", text: "查看这轮的文件变化"), message("m2", role: "assistant", text: "先检查改动范围。"),
                    message("m3", role: "assistant", text: "正在更新组件。"), message("m4", role: "assistant", text: "正在运行测试。"),
                    message("m5", role: "assistant", text: "测试通过。"), message("m6", role: "assistant", text: "已完成本轮文件修改。")]
        }
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
            let question = ProcessInfo.processInfo.arguments.contains("--preview-question-reminder")
                ? "帮我比较这两种实现的阅读体验，保留滚动位置、消息身份和现有动效。\n也请考虑长问题、附件、连续追问和 👩🏽‍💻 的显示。"
                : "检查长回复滚动"
            let tail = (0..<viewportTail).map { "新增尾部 \($0 + 1)" }
            let appended: [[String: Any]] = viewportRows ? (0..<viewportTail).flatMap { index in
                [message("viewport-user-\(index)", role: "user", text: "新增消息 \(index)"),
                 ["messageId": "viewport-tool-\(index)", "role": "assistant", "timestamp": 1793232000001,
                  "content": [["type": "tool_call", "toolCallId": "viewport-call-\(index)", "toolName": "ViewportTool",
                               "arguments": ["command": "echo viewport"]]]]]
            } : []
            return [message("viewport-user", role: "user", text: question),
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
            // M16: a file the reply produced, to download from the chat.
            + (ProcessInfo.processInfo.arguments.contains("--preview-chat-artifact") ? [["messageId": "m5", "role": "assistant", "timestamp": 1793232000002,
                "content": [["type": "artifact", "artifact": ["artifactId": "3f2504e0-4f89-11d3-9a0c-0305e82c3301", "fileName": "report.pdf",
                                                              "mimeType": "application/pdf", "size": 1024, "sha256": String(repeating: "a", count: 64)]]]]] : [])
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

/// Records inside the app: XCTest waits for idle before its next input, which
/// otherwise hides the unresponsive interval after a swipe has visually ended.
@MainActor
final class PageReturnProbe: ObservableObject {
    static let shared = PageReturnProbe()
    static let enabled = ProcessInfo.processInfo.arguments.contains("--measure-page-return")
    @Published private(set) var report = "idle"
    private var start: TimeInterval?
    private var count = 0
    func begin() {
        guard Self.enabled else { return }
        start = ProcessInfo.processInfo.systemUptime
    }
    func committed() {
        guard Self.enabled, let start else { return }
        self.start = nil; count += 1
        report = String(format: "count=%d;commitMs=%.1f", count,
                        (ProcessInfo.processInfo.systemUptime - start) * 1000)
        NSLog("OrbisPageReturn %@", report)
    }
}

struct PageReturnReport: View {
    @ObservedObject private var probe = PageReturnProbe.shared
    var body: some View {
        Text(probe.report).font(.system(size: 10))
            .accessibilityIdentifier("page-return-metrics").allowsHitTesting(false)
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

/// M14: what assistive technologies can reach. XCUITest's snapshot also lists subtrees SwiftUI
/// hides from accessibility (inactive root tabs, pages covered by another page), so UI tests read
/// this walk of the key window's accessibility containers instead. Each line is
/// `identifier|label` of one reachable element.
enum AccessibilityReachProbe {
    static let enabled = ProcessInfo.processInfo.arguments.contains("--probe-accessibility-reach")

    @MainActor static func reachable() -> [String] {
        guard let window = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene })
            .flatMap(\.windows).first(where: \.isKeyWindow) else { return [] }
        var lines: [String] = []
        var budget = 4_000
        walk(window, into: &lines, budget: &budget)
        return lines
    }

    @MainActor private static func walk(_ item: Any, into lines: inout [String], budget: inout Int) {
        guard budget > 0, let object = item as? NSObject else { return }
        budget -= 1
        if object.accessibilityElementsHidden { return }
        if let view = object as? UIView, view.isHidden || view.alpha < 0.01 { return }
        if object.isAccessibilityElement {
            // SwiftUI's accessibility nodes answer the selector without declaring the protocol.
            let selector = NSSelectorFromString("accessibilityIdentifier")
            let identifier = object.responds(to: selector)
                ? (object.perform(selector)?.takeUnretainedValue() as? String ?? "") : ""
            if identifier != "accessibility-reach" { lines.append(identifier + "|" + (object.accessibilityLabel ?? "")) }
            return
        }
        if let elements = object.accessibilityElements {
            for element in elements { walk(element, into: &lines, budget: &budget) }
            return
        }
        let count = object.accessibilityElementCount()
        if count > 0 && count != NSNotFound {
            for index in 0..<count {
                if let element = object.accessibilityElement(at: index) { walk(element, into: &lines, budget: &budget) }
            }
            return
        }
        if let view = object as? UIView {
            for subview in view.subviews { walk(subview, into: &lines, budget: &budget) }
        }
    }
}

struct AccessibilityReachReport: View {
    @State private var report = ""
    var body: some View {
        Text(" ").font(.system(size: 1)).frame(width: 1, height: 1)
            .accessibilityIdentifier("accessibility-reach").accessibilityValue(report)
            .allowsHitTesting(false)
            .task {
                while !Task.isCancelled {
                    report = AccessibilityReachProbe.reachable().joined(separator: "\n")
                    try? await Task.sleep(nanoseconds: 250_000_000)
                }
            }
    }
}
#endif

#if DEBUG
@MainActor
final class TurnChangesPreviewProbe: ObservableObject {
    static let shared = TurnChangesPreviewProbe()
    @Published private(set) var counts: [String: Int] = [:]
    func record(_ file: String) { counts[file, default: 0] += 1 }
}
struct TurnChangesRequestProbeView: View {
    @ObservedObject private var probe = TurnChangesPreviewProbe.shared
    var body: some View {
        Text("reads=" + (1...3).map { String(probe.counts["change-\($0)"] ?? 0) }.joined(separator: ","))
            .font(.orbisCaption(mono: true)).accessibilityIdentifier("change-detail-requests").allowsHitTesting(false)
    }
}
#endif
